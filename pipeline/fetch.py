"""The Care Ledger fetcher.

Scrapes the WI DHS Division of Quality Assurance (DQA) Provider Search for
every assisted living facility (AFH, CBRF, RCAC) in Marathon County and the
eight counties around it, archives statements of deficiency / enforcement /
plan-of-correction PDFs permanently, and maintains an append-only survey
ledger. DQA only shows the past three years; this ledger never forgets.

One correct path: ASP.NET WebForms postback replay with plain requests.
Fails loud on any structural surprise -- the state is replacing this tool
with the "Wisconsin Provider Finder" (announced for spring 2026), and when
that lands this script must die visibly, not degrade quietly.

Run: python pipeline/fetch.py
"""

import json
import re
import sys
import time
from datetime import date, datetime, timedelta
from io import BytesIO
from pathlib import Path

import openpyxl
import requests
from bs4 import BeautifulSoup

# ---------------------------------------------------------------- constants

# County as the roster export spells it -> value of its option in the search
# form's County dropdown. Marathon since 2026-07-12; its eight neighbors since
# 2026-10-06, each archive starting at the state's window that week. Never
# drop a county from this list: its facilities would read as off the roster
# and its records as aged off, when only the ledger stopped looking.
COUNTIES = {
    "MARATHON": "2744",
    "CLARK": "2717",
    "LANGLADE": "2741",
    "LINCOLN": "2742",
    "PORTAGE": "2757",
    "SHAWANO": "2766",
    "TAYLOR": "2768",
    "WAUPACA": "2776",
    "WOOD": "2779",
}

BASE = "https://www.forwardhealth.wi.gov/WIPortal/Subsystem/Public/"
SEARCH_URL = BASE + "DQAProviderSearch.aspx"
RESULTS_URL = BASE + "DqaProviderSearchResults.aspx"
EXPORT_URL = BASE + "DqaSearchResultsExport.aspx"
DETAIL_URL = BASE + "DqaProviderDetails.aspx"

P = "ctl00$MainContent$GenericPageCtrl1$"  # WebForms control name prefix

SEARCH_FIELDS = {
    P + "IndAdultFamilyHome": "on",
    P + "IndCommunityBased": "on",
    P + "IndResidentialCare": "on",
    P + "IndIncludeClosed": "on",  # closed facilities are part of the archive
    P + "RecordsToDisplay": "50",
    P + "ResultsSortOrder": "NAM_LEGAL",
}

SURVEY_HEADER = [
    "Survey Type", "Exit Date", "Enforcement", "Statement of Deficiency", "Plan of Correction",
]
DOC_COLUMNS = {2: "enforcement", 3: "sod", 4: "poc"}  # positions within SURVEY_HEADER

ROOT = Path(__file__).resolve().parent.parent
FACILITIES_PATH = ROOT / "data" / "facilities.json"
SURVEYS_PATH = ROOT / "data" / "surveys.json"
ARCHIVE_DIR = ROOT / "archive"

REQUEST_DELAY = 0.5  # seconds between requests; be a polite citizen
TIMEOUT = 30

# DQA shows three years of survey history. A record may only be treated as
# aged off if its exit date is at least this old; anything newer vanishing
# means the scrape or the state's data broke, and the run must fail rather
# than publish "no longer shown by the state". The slack absorbs the
# state's own window arithmetic and the weekly cadence.
WINDOW_SLACK = timedelta(days=30)

EXPORT_HEADER = (
    "License or Certification Number",
    "Certification Type",
    "Facility Name",
    "Provider Type",
    "Class",
    "Address",
    "City",
    "State",
    "Zip Code",
    "County",
    "Phone Number",
    "Fax Number",
    "Contact First Name",
    "Contact Last Name",
    "Corporate Name",
    "Licensee First Name",
    "Licensee Last Name",
    "Date Probationary (License/Certification) Issued",
    "Date Regular (License/Certification) Issued",
    "Date Closed",
    "Capacity",
    "Gender",
    "Client Group Served",
    "HCBS Compliance / Public Funding",
)


# ------------------------------------------------------------------ helpers

def hidden_fields(soup):
    return {
        i["name"]: i.get("value", "")
        for i in soup.select("input[type=hidden]")
        if i.get("name")
    }


def iso(value):
    """Normalize an export cell or MM/DD/YYYY string to ISO date, else ''."""
    if value in (None, ""):
        return ""
    if isinstance(value, datetime):
        return value.date().isoformat()
    value = str(value).strip()
    if not value:
        return ""
    return datetime.strptime(value, "%m/%d/%Y").date().isoformat()


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def check_portal(r):
    # The portal answers failures with a 302 to a 200 "Unexpected Error"
    # page, which raise_for_status() cannot see.
    r.raise_for_status()
    if "UnexpectedError" in r.url or "UnexpectedError" in r.headers.get("Location", ""):
        raise RuntimeError(f"Portal error page for {r.request.url}")
    return r


def get(session, url, **kw):
    time.sleep(REQUEST_DELAY)
    return check_portal(session.get(url, timeout=TIMEOUT, **kw))


def post(session, url, data, **kw):
    time.sleep(REQUEST_DELAY)
    return check_portal(session.post(url, data=data, timeout=TIMEOUT, **kw))


# ------------------------------------------------------------------- scrape

def run_search(session, county_code):
    """Perform one county's search. Returns the results page soup."""
    soup = BeautifulSoup(get(session, SEARCH_URL).text, "lxml")

    # County selection is a server-side postback (populates the city list).
    d = hidden_fields(soup)
    d[P + "County"] = county_code
    d["__EVENTTARGET"] = P + "County"
    soup = BeautifulSoup(post(session, SEARCH_URL, d).text, "lxml")

    d = hidden_fields(soup) | SEARCH_FIELDS
    d[P + "County"] = county_code
    d["__EVENTTARGET"] = P + "ButtonSearch"
    r = post(session, SEARCH_URL, d)
    if "DqaProviderSearchResults" not in r.url:
        raise RuntimeError(f"Search did not land on results page: {r.url}")
    soup = BeautifulSoup(r.text, "lxml")
    if not soup.find("a", href=re.compile(r"LinkSakDqa")):
        raise RuntimeError("Results page has no facility links -- structure changed?")
    return soup


def download_roster(session):
    """Download the Excel export of the current search and parse it."""
    r = get(session, EXPORT_URL)
    if "spreadsheetml" not in r.headers.get("Content-Type", ""):
        raise RuntimeError(f"Export is not xlsx: {r.headers.get('Content-Type')}")
    ws = openpyxl.load_workbook(BytesIO(r.content)).active
    rows = list(ws.iter_rows(values_only=True))
    if rows[0] != EXPORT_HEADER:
        raise RuntimeError(f"Export columns changed: {rows[0]}")

    roster = {}
    for row in rows[1:]:
        f = {
            "license": str(row[0]).strip(),
            "name": str(row[2]).strip(),
            "provider_type": str(row[3]).strip(),
            "class": str(row[4] or "").strip(),
            "address": str(row[5]).strip(),
            "city": str(row[6]).strip(),
            "zip": str(row[8]).strip(),
            "county": str(row[9]).strip(),
            "phone": str(row[10] or "").strip(),
            "corporate_name": str(row[14] or "").strip(),
            "licensee": " ".join(s for s in (str(row[16] or "").strip(), str(row[15] or "").strip()) if s),
            "date_probationary": iso(row[17]),
            "date_regular": iso(row[18]),
            "date_closed": iso(row[19]),
            "capacity": str(row[20] or "").strip(),
            "client_groups": str(row[22] or "").strip(),
            "hcbs_compliance": str(row[23] or "").strip(),
        }
        if not f["license"]:
            raise RuntimeError(f"Roster row missing license number: {row}")
        roster[f["license"]] = f
    return roster


def harvest_keys(session, results_soup):
    """Map license number -> DqaProviderDetails key, freshly, every run.

    Keys are NOT stable: DQA reloads its provider table on each weekly
    refresh and every facility gets a new key (15226164 on 2026-07-12 was
    15570764 by October). A stale key redirects to the portal error page.

    Each grid row's facility link is a WebForms postback that 302s to the
    detail URL with the key in the Location header. The results viewstate is
    reusable, so this is one lightweight POST per facility.
    """
    hf = hidden_fields(results_soup)
    keys = {}
    for anchor in results_soup.find_all("a", href=re.compile(r"\$LinkSakDqa")):
        ctl = re.search(r"GridViewResults\$(ctl\d+)\$LinkSakDqa", anchor["href"])
        row = anchor.find_parent("tr")
        lic_span = row.find("span", id=re.compile(r"LicenseCertNumber"))
        if not (ctl and lic_span):
            raise RuntimeError(f"Grid row structure changed near: {anchor.get_text(strip=True)}")
        license_no = lic_span.get_text(strip=True)

        d = dict(hf)
        d["__EVENTTARGET"] = f"{P}GridViewResults${ctl.group(1)}$LinkSakDqa"
        r = post(session, RESULTS_URL, d, allow_redirects=False)
        m = re.search(r"DqaProviderDetails\.aspx\?key=(\d+)", r.headers.get("Location", ""))
        if not m:
            raise RuntimeError(f"No detail key for {license_no}: {r.status_code} {r.headers.get('Location')}")
        keys[license_no] = m.group(1)
    return keys


def fetch_detail(session, key, license_no):
    """Parse a facility detail page: labeled fields + survey history rows.

    The page must prove it is this facility's record — its License Number
    field matches and its Survey History section holds either the survey
    table or the state's explicit "No survey information available." Any
    other page (error, redirect, redesign) raises; silently parsing it as an
    empty history is how every record once got marked expired."""
    soup = BeautifulSoup(get(session, DETAIL_URL, params={"key": key, "keyb": "-1"}).text, "lxml")

    fields = {}
    for row in soup.select("div.row.m-1"):
        divs = row.find_all("div", recursive=False)
        if len(divs) == 2:
            fields[divs[0].get_text(strip=True)] = divs[1].get_text(" ", strip=True)
    if fields.get("License Number") != license_no:
        raise RuntimeError(
            f"Detail page for key {key} is not license {license_no} "
            f"(License Number field: {fields.get('License Number')!r})"
        )
    if not fields.get("Licensure Status"):
        raise RuntimeError(f"Detail page for {license_no} has no Licensure Status field")

    surveys = []
    found_table = False
    for table in soup.find_all("table"):
        header = [th.get_text(strip=True) for th in table.find_all("th")]
        if header[:2] != ["Survey Type", "Exit Date"]:
            continue
        if header != SURVEY_HEADER:
            raise RuntimeError(f"Survey table columns changed for {license_no}: {header}")
        found_table = True
        for tr in table.find_all("tr")[1:]:
            cells = tr.find_all("td")
            if len(cells) != 5:
                raise RuntimeError(f"Survey row has {len(cells)} cells for key {key}")
            docs = {}
            for idx, kind in DOC_COLUMNS.items():
                a = cells[idx].find("a", href=True)
                if a:
                    docs[kind] = a["href"]
            surveys.append({
                "survey_type": cells[0].get_text(strip=True),
                "exit_date": iso(cells[1].get_text(strip=True)),
                "docs": docs,
            })
    if not found_table and "No survey information available" not in soup.get_text(" "):
        raise RuntimeError(f"Detail page for {license_no} has no recognizable Survey History section")
    return {
        "licensure_status": fields.get("Licensure Status", ""),
        "ownership_type": fields.get("Ownership Type", ""),
        "owner_name": fields.get("Owner Name", ""),
    }, surveys


def archive_pdf(session, url, license_no, exit_date, survey_type, kind):
    """Download a survey document into the permanent archive. Immutable:
    if the file already exists, it is never re-fetched."""
    name = f"{exit_date}_{slug(survey_type)}_{kind}.pdf"
    path = ARCHIVE_DIR / license_no / name
    # POSIX form on every OS: this string is a URL in the widget and the join
    # key into enrichment.json.
    rel = path.relative_to(ROOT).as_posix()
    if path.exists():
        return rel
    r = get(session, url)
    if not r.content.startswith(b"%PDF"):
        raise RuntimeError(f"Not a PDF at {url}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(r.content)
    print(f"  archived {rel} ({len(r.content):,} bytes)")
    return rel


# -------------------------------------------------------------------- merge

def vanished_in_window(surveys, facilities, today_date):
    """Records not seen today that the state should still be showing.

    A record of a facility still on the roster may only age off if it is
    older than the state's three-year window. Checked across every unseen
    row, including ones already flagged, so a past bad run gets caught too.
    """
    today = today_date.isoformat()
    try:
        window_start = today_date.replace(year=today_date.year - 3)
    except ValueError:  # Feb 29
        window_start = today_date.replace(year=today_date.year - 3, day=28)
    must_still_show = (window_start + WINDOW_SLACK).isoformat()
    return sorted(
        sid for sid, s in surveys.items()
        if s["last_seen"] != today
        and facilities[s["license"]]["last_seen"] == today
        and s["exit_date"] > must_still_show
    )


def load(path):
    return json.loads(path.read_text()) if path.exists() else {}


def save(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n")


def main():
    today_date = date.today()
    today = today_date.isoformat()
    facilities = load(FACILITIES_PATH)
    surveys = load(SURVEYS_PATH)

    new_surveys = 0
    reappeared = 0
    for county, code in COUNTIES.items():
        # A fresh session per county: the export and the grid's viewstate
        # belong to the session's latest search.
        session = requests.Session()
        session.headers["User-Agent"] = (
            "Mozilla/5.0 (compatible; WausauPilotCareLedger/1.0; "
            "+https://wausaupilotandreview.com)"
        )
        print(f"{county.title()} County: searching (AFH + CBRF + RCAC, incl. closed)")
        results_soup = run_search(session, code)
        roster = download_roster(session)
        wrong = {f["county"] for f in roster.values()} - {county}
        if wrong:
            raise RuntimeError(f"{county} search returned facilities from {wrong} -- county code changed?")
        keys = harvest_keys(session, results_soup)
        missing = set(keys) - set(roster)
        if missing:
            raise RuntimeError(f"Grid facilities absent from export: {missing}")
        print(f"  {len(roster)} facilities; fetching details, survey history, documents")
        n, r = fetch_county(session, roster, keys, facilities, surveys, today)
        new_surveys += n
        reappeared += r

    # Anything we've seen before that the state no longer shows.
    for lic, f in facilities.items():
        if f["last_seen"] != today:
            f["on_state_roster"] = False

    vanished = vanished_in_window(surveys, facilities, today_date)
    if vanished:
        raise RuntimeError(
            f"{len(vanished)} survey records inside the state's three-year window "
            f"vanished from facilities still on the roster — not a normal age-off. "
            f"Investigate (relabeled survey type? corrected date? deletion?) before "
            f"anything is marked as no longer shown: {vanished}"
        )

    expired = 0
    for sid, s in surveys.items():
        if s["last_seen"] != today and not s["expired_from_state"]:
            s["expired_from_state"] = True
            s["expired_on"] = today
            expired += 1

    save(FACILITIES_PATH, facilities)
    save(SURVEYS_PATH, surveys)

    docs = sum(len(s["documents"]) for s in surveys.values())
    print(
        f"\nDone. {len(facilities)} facilities in ledger "
        f"({sum(1 for f in facilities.values() if f['on_state_roster'])} on state roster), "
        f"{len(surveys)} survey records ({new_surveys} new, {expired} newly expired from state, "
        f"{reappeared} previously flagged expired seen again), "
        f"{docs} documents archived."
    )


def fetch_county(session, roster, keys, facilities, surveys, today):
    """Merge one county's roster, detail pages, and documents into the
    ledger. Returns (new survey rows, previously expired rows seen again)."""
    new_surveys = 0
    reappeared = 0
    for license_no, facility in sorted(roster.items()):
        key = keys.get(license_no)
        if not key:
            raise RuntimeError(f"{license_no} {facility['name']} has no detail key")
        detail, history = fetch_detail(session, key, license_no)

        record = facilities.get(license_no, {"first_seen": today})
        record.update(facility)
        record.update(detail)
        record["key"] = key
        record["last_seen"] = today
        record["on_state_roster"] = True
        facilities[license_no] = record

        for s in history:
            sid = f"{license_no}|{s['exit_date']}|{slug(s['survey_type'])}"
            entry = surveys.get(sid, {"first_seen": today})
            reappeared += entry.get("expired_from_state", False)
            entry.pop("expired_on", None)
            entry.update({
                "license": license_no,
                "survey_type": s["survey_type"],
                "exit_date": s["exit_date"],
                "last_seen": today,
                "expired_from_state": False,
            })
            archived = entry.get("documents", {})
            for kind, url in s["docs"].items():
                if kind not in archived:
                    archived[kind] = archive_pdf(
                        session, url, license_no, s["exit_date"], s["survey_type"], kind
                    )
                    # A Notice & Order often posts weeks after its SOD, onto
                    # a row that is no longer new; date each document too.
                    entry.setdefault("documents_first_seen", {})[kind] = today
            entry["documents"] = archived
            if sid not in surveys:
                new_surveys += 1
            surveys[sid] = entry
    return new_surveys, reappeared


if __name__ == "__main__":
    sys.exit(main())
