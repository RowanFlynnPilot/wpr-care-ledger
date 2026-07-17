"""One-time Wayback Machine backfill for the Care Ledger.

The state shows three years of survey history; the Internet Archive crawled
some of what the state has since stopped showing. Two recovery vectors:

1. Archived DqaProviderDetails snapshots (a handful exist statewide) —
   parsed for their survey-history tables.
2. Archived survey PDFs under /kw/dqa/ (the larger haul) — every SOD (state
   2567 form) prints the facility license and survey-completed date in its
   header, and every NOTICE letter carries "Re: <name>, <license>" plus the
   concluded-survey sentence, so each document identifies itself.

Only documents belonging to facilities in data/facilities.json are kept.
Recovered survey rows merge into surveys.json with `expired_from_state:
true` and `source: "wayback:<timestamp>"`; recovered PDFs land in archive/
under the standard naming. If a row for that license+date already exists,
the document attaches to it instead of creating a duplicate. Idempotent —
safe to re-run; existing rows and files are never overwritten.

Run pipeline/enrich.py afterwards to mine the recovered documents.

Run: python pipeline/backfill_wayback.py
"""

import json
import re
import sys
import time
from datetime import date, datetime
from io import BytesIO
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parent.parent
FACILITIES_PATH = ROOT / "data" / "facilities.json"
SURVEYS_PATH = ROOT / "data" / "surveys.json"
ARCHIVE_DIR = ROOT / "archive"

CDX = "https://web.archive.org/cdx/search/cdx"
DETAILS_URL = "forwardhealth.wi.gov/WIPortal/Subsystem/Public/DqaProviderDetails.aspx*"
PDFS_URL = "forwardhealth.wi.gov/kw/dqa/*"

DELAY = 0.8  # archive.org is a fellow nonprofit; be gentle
TIMEOUT = 60

# Wayback PDF filename suffix -> document kind (S/F variants both occur).
KIND_BY_SUFFIX = {"SOD": "sod", "ENF": "enforcement", "POC": "poc"}

# Keyword -> state survey-type vocabulary, in the order the state composes
# them (e.g. "SURVEY/COMPLAINT", "COMPLAINT/SELF REPORT").
TYPE_KEYWORDS = [
    (r"standard (?:licensure )?survey", "SURVEY"),
    (r"complaint", "COMPLAINT"),
    (r"self[- ]report", "SELF REPORT"),
    (r"verification visit", "VV"),
    (r"desk review", "DESK REVIEW"),
]


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def get(session, url, **kw):
    """GET with retries — archive.org is best-effort infrastructure and
    read-timeouts are routine; three attempts with backoff before giving up.
    (Unlike fetch.py this guards a flaky network, not a changed page.)"""
    last = None
    for attempt, pause in enumerate((0, 10, 30)):
        time.sleep(pause or DELAY)
        try:
            r = session.get(url, timeout=TIMEOUT, **kw)
            r.raise_for_status()
            return r
        except (requests.Timeout, requests.ConnectionError) as e:
            last = e
            print(f"  retry {attempt + 1} after {type(e).__name__}: {url[:100]}")
    raise last


def cdx_rows(session, url_pattern):
    r = get(session, CDX, params={
        "url": url_pattern,
        "output": "json",
        "filter": "statuscode:200",
        "collapse": "urlkey",
    })
    rows = r.json()
    return [dict(zip(rows[0], row)) for row in rows[1:]] if rows else []


def raw_snapshot(session, timestamp, original):
    return get(session, f"https://web.archive.org/web/{timestamp}id_/{original}")


def infer_type(text):
    """Reconstruct the state's survey-type string from document prose."""
    found = []
    low = text.lower()
    for rx, label in TYPE_KEYWORDS:
        if re.search(rx, low) and label not in found:
            found.append(label)
    if found == ["VV"]:
        return "VERIFICATION VISIT"  # the state's standalone label
    return "/".join(found)


def parse_pdf_identity(content, licenses):
    """Read a recovered PDF's own header: license, exit date, kind, type."""
    reader = PdfReader(BytesIO(content))
    text = "\n".join(p.extract_text() or "" for p in reader.pages[:3])
    if sum(c.isalpha() for c in text) < 200:
        return None  # scanned/unmappable; nothing to attribute

    if "STATEMENT OF DEFICIENCIES" in text:
        kind = "sod"
        # Form header: "<license> <mm/dd/yyyy>" on adjacent lines/run.
        m = re.search(r"\b(\d{7})\s*\n?\s*(\d{2}/\d{2}/\d{4})", text)
        if not m or m.group(1) not in licenses:
            return None
        license_no, exit_mdY = m.group(1), m.group(2)
        scope = text[: text.find("deficienc") + 200] if "deficienc" in text else text
        survey_type = infer_type(scope)
    elif re.search(r"NOTICE", text):
        kind = "enforcement"
        # License follows the name after a comma (2026 letters) or in
        # parentheses (older letters: "Re: Apple Creek Place I (0017916)").
        m = re.search(r"Re:\s*.+?[,(]\s*(\d{7})\)?", text)
        if not m or m.group(1) not in licenses:
            return None
        license_no = m.group(1)
        m2 = re.search(
            r"On\s+([A-Z][a-z]+ \d{1,2},\s*\d{4}),?\s*(.{0,120}?)\s+(?:was|were)\s+concluded",
            text,
        )
        if not m2:
            return None
        exit_mdY = m2.group(1)
        survey_type = infer_type(m2.group(2))
    else:
        return None  # plan-of-correction or unknown; POCs ride along with SODs

    cleaned = re.sub(r"\s+", " ", exit_mdY.replace(",", " ")).strip()
    exit_date = None
    for fmt in ("%m/%d/%Y", "%B %d %Y"):
        try:
            exit_date = datetime.strptime(cleaned, fmt).date().isoformat()
            break
        except ValueError:
            continue
    if not exit_date:
        return None
    return {"license": license_no, "exit_date": exit_date,
            "kind": kind, "survey_type": survey_type}


def parse_detail_snapshot(html, facilities):
    """Extract (license, survey rows) from an archived detail page."""
    soup = BeautifulSoup(html, "lxml")
    text = soup.get_text(" ", strip=True)
    # Newer pages print the license number. Pre-2020 pages carry only name
    # and address, so identity requires BOTH to match exactly — substring
    # name matching alone once mis-attributed a Dane County facility.
    license_no = next((lic for lic in facilities if lic in text), None)
    if not license_no:
        norm = lambda s: re.sub(r"[^A-Z0-9]", "", s.upper())
        page_head = norm(text[:2500])
        license_no = next(
            (lic for lic, f in facilities.items()
             if norm(f["name"]) in page_head and norm(f["address"]) in page_head),
            None,
        )
    if not license_no:
        return None, []

    # The survey table's header row uses <th> on current pages but <td>
    # inside nested layout tables on 2017-2020 pages — accept either.
    rows = []
    for table in soup.find_all("table"):
        trs = table.find_all("tr")
        if not trs:
            continue
        header = [c.get_text(strip=True) for c in trs[0].find_all(["th", "td"])]
        if len(header) < 2 or not header[0].startswith("Survey Type"):
            continue
        kind_by_col = {}
        for idx, name in enumerate(header):
            for frag, kind in (("Enforcement", "enforcement"),
                               ("Deficiency", "sod"), ("Correction", "poc")):
                if frag in name:
                    kind_by_col[idx] = kind
        for tr in trs[1:]:
            cells = tr.find_all("td")
            if len(cells) < 2:
                continue
            try:
                exit_date = datetime.strptime(
                    cells[1].get_text(strip=True), "%m/%d/%Y").date().isoformat()
            except ValueError:
                continue
            docs = {}
            for idx, kind in kind_by_col.items():
                if idx < len(cells):
                    for a in cells[idx].find_all("a", href=True):
                        m = re.search(r"[^\"'()]*?/kw/dqa/[^\"'()?]+\.PDF",
                                      a["href"], re.I)
                        if m:
                            docs[kind] = m.group(0)
                            break
            rows.append({"survey_type": cells[0].get_text(strip=True),
                         "exit_date": exit_date, "docs": docs})
        if rows:
            break
    return license_no, rows


def save_doc(license_no, exit_date, survey_type, kind, content):
    name = f"{exit_date}_{slug(survey_type)}_{kind}.pdf"
    path = ARCHIVE_DIR / license_no / name
    rel = str(path.relative_to(ROOT)).replace("\\", "/")
    if path.exists():
        return rel, False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return rel, True


def merge_row(surveys, license_no, exit_date, survey_type, ts, today):
    """Find or create the survey row a recovered document belongs to."""
    same_day = [
        (sid, s) for sid, s in surveys.items()
        if s["license"] == license_no and s["exit_date"] == exit_date
    ]
    if same_day:
        # Prefer a same-day row sharing a type keyword; else the first.
        for sid, s in same_day:
            if survey_type and survey_type.split("/")[0] in s["survey_type"]:
                return sid, s, False
        return same_day[0][0], same_day[0][1], False

    stype = survey_type or "SURVEY"
    sid = f"{license_no}|{exit_date}|{slug(stype)}"
    row = {
        "license": license_no,
        "survey_type": stype,
        "exit_date": exit_date,
        "documents": {},
        "first_seen": today,
        "last_seen": f"{ts[:4]}-{ts[4:6]}-{ts[6:8]}",  # when Wayback last saw it
        "expired_from_state": True,
        "source": f"wayback:{ts}",
    }
    surveys[sid] = row
    return sid, row, True


def main():
    today = date.today().isoformat()
    facilities = json.loads(FACILITIES_PATH.read_text())
    surveys = json.loads(SURVEYS_PATH.read_text())
    licenses = set(facilities)

    session = requests.Session()
    session.headers["User-Agent"] = (
        "WausauPilotCareLedger-backfill/1.0 (+https://wausaupilotandreview.com)"
    )

    new_rows = new_docs = attached = skipped_foreign = unparsed = 0

    print("[1/2] Archived detail-page snapshots")
    for snap in cdx_rows(session, DETAILS_URL):
        if "key=" not in snap["original"]:
            continue
        html = raw_snapshot(session, snap["timestamp"], snap["original"]).text
        license_no, rows = parse_detail_snapshot(html, facilities)
        if not license_no:
            skipped_foreign += 1
            continue
        print(f"  {snap['timestamp'][:8]} -> {license_no} ({len(rows)} table rows)")
        for r in rows:
            sid, row, created = merge_row(
                surveys, license_no, r["exit_date"], r["survey_type"],
                snap["timestamp"], today)
            if created:
                new_rows += 1
                print(f"    recovered row {sid}")
            for kind, url in r["docs"].items():
                if kind in row["documents"]:
                    continue
                # Original file may still exist live; else take Wayback's copy.
                content = None
                for fetch_url in (url, None):
                    try:
                        if fetch_url:
                            resp = get(session, fetch_url)
                        else:
                            pdf_snaps = cdx_rows(session, url)
                            if not pdf_snaps:
                                break
                            resp = raw_snapshot(
                                session, pdf_snaps[0]["timestamp"], url)
                        if resp.content.startswith(b"%PDF"):
                            content = resp.content
                            break
                    except requests.RequestException:
                        continue
                if content:
                    rel, created_file = save_doc(
                        license_no, r["exit_date"], row["survey_type"], kind, content)
                    row["documents"][kind] = rel
                    new_docs += created_file
                    attached += 1

    print("[2/2] Archived survey PDFs under /kw/dqa/")
    for snap in cdx_rows(session, PDFS_URL):
        if not snap["original"].upper().endswith(".PDF"):
            continue
        stem = snap["original"].rsplit("/", 1)[-1].upper().removesuffix(".PDF")
        kind = KIND_BY_SUFFIX.get(stem[-4:-1])  # ...SODS/SODF/ENFS/ENFF/POCS
        try:
            content = raw_snapshot(session, snap["timestamp"], snap["original"]).content
        except requests.RequestException as e:
            print(f"  WARN {stem}: fetch failed ({type(e).__name__})")
            unparsed += 1
            continue
        if not content.startswith(b"%PDF"):
            unparsed += 1
            continue
        try:
            ident = parse_pdf_identity(content, licenses)
        except Exception as e:  # damaged historic PDF: report, keep going
            print(f"  WARN {stem}: {e}")
            unparsed += 1
            continue
        if not ident:
            skipped_foreign += 1
            continue
        kind = ident["kind"] if kind is None else kind
        sid, row, created = merge_row(
            surveys, ident["license"], ident["exit_date"], ident["survey_type"],
            snap["timestamp"], today)
        if created:
            new_rows += 1
            print(f"  recovered row {sid}  <- {stem}")
        if kind not in row["documents"]:
            rel, created_file = save_doc(
                ident["license"], ident["exit_date"], row["survey_type"],
                kind, content)
            row["documents"][kind] = rel
            new_docs += created_file
            attached += 1
            print(f"  saved {rel}")

    SURVEYS_PATH.write_text(json.dumps(surveys, indent=2, sort_keys=True) + "\n")
    print(
        f"\nDone. {new_rows} survey rows recovered, {new_docs} documents saved "
        f"({attached} attachments), {skipped_foreign} non-Marathon items skipped, "
        f"{unparsed} unparseable.\nRun pipeline/enrich.py to mine the recovered "
        f"documents."
    )


if __name__ == "__main__":
    sys.exit(main())
