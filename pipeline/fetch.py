"""The Care Ledger fetcher.

Scrapes the WI DHS Division of Quality Assurance (DQA) Provider Search for
every assisted living facility in Marathon County (AFH, CBRF, RCAC), archives
statements of deficiency / enforcement / plan-of-correction PDFs permanently,
and maintains an append-only survey ledger. DQA only shows the past three
years; this ledger never forgets.

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
from datetime import date, datetime
from io import BytesIO
from pathlib import Path

import openpyxl
import requests
from bs4 import BeautifulSoup

# ---------------------------------------------------------------- constants

COUNTY_NAME = "Marathon"
COUNTY_CODE = "2744"  # value of the Marathon option in the County dropdown

BASE = "https://www.forwardhealth.wi.gov/WIPortal/Subsystem/Public/"
SEARCH_URL = BASE + "DQAProviderSearch.aspx"
RESULTS_URL = BASE + "DqaProviderSearchResults.aspx"
EXPORT_URL = BASE + "DqaSearchResultsExport.aspx"
DETAIL_URL = BASE + "DqaProviderDetails.aspx"

P = "ctl00$MainContent$GenericPageCtrl1$"  # WebForms control name prefix

SEARCH_FIELDS = {
    P + "County": COUNTY_CODE,
    P + "IndAdultFamilyHome": "on",
    P + "IndCommunityBased": "on",
    P + "IndResidentialCare": "on",
    P + "IndIncludeClosed": "on",  # closed facilities are part of the archive
    P + "RecordsToDisplay": "50",
    P + "ResultsSortOrder": "NAM_LEGAL",
}

DOC_COLUMNS = {2: "enforcement", 3: "sod", 4: "poc"}  # survey table layout

ROOT = Path(__file__).resolve().parent.parent
FACILITIES_PATH = ROOT / "data" / "facilities.json"
SURVEYS_PATH = ROOT / "data" / "surveys.json"
ARCHIVE_DIR = ROOT / "archive"

REQUEST_DELAY = 0.5  # seconds between requests; be a polite citizen
TIMEOUT = 30

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


def get(session, url, **kw):
    time.sleep(REQUEST_DELAY)
    r = session.get(url, timeout=TIMEOUT, **kw)
    r.raise_for_status()
    return r


def post(session, url, data, **kw):
    time.sleep(REQUEST_DELAY)
    r = session.post(url, data=data, timeout=TIMEOUT, **kw)
    r.raise_for_status()
    return r


# ------------------------------------------------------------------- scrape

def run_search(session):
    """Perform the county search. Returns the results page soup."""
    soup = BeautifulSoup(get(session, SEARCH_URL).text, "lxml")

    # County selection is a server-side postback (populates the city list).
    d = hidden_fields(soup)
    d[P + "County"] = COUNTY_CODE
    d["__EVENTTARGET"] = P + "County"
    soup = BeautifulSoup(post(session, SEARCH_URL, d).text, "lxml")

    d = hidden_fields(soup) | SEARCH_FIELDS
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


def harvest_keys(session, results_soup, known_keys):
    """Map license number -> DqaProviderDetails key.

    Each grid row's facility link is a WebForms postback that 302s to the
    detail URL with the key in the Location header. The results viewstate is
    reusable, so this is one lightweight POST per unknown facility.
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

        if license_no in known_keys:
            keys[license_no] = known_keys[license_no]
            continue

        d = dict(hf)
        d["__EVENTTARGET"] = f"{P}GridViewResults${ctl.group(1)}$LinkSakDqa"
        r = post(session, RESULTS_URL, d, allow_redirects=False)
        m = re.search(r"DqaProviderDetails\.aspx\?key=(\d+)", r.headers.get("Location", ""))
        if not m:
            raise RuntimeError(f"No detail key for {license_no}: {r.status_code} {r.headers.get('Location')}")
        keys[license_no] = m.group(1)
        print(f"  key {m.group(1)} <- {license_no} {anchor.get_text(strip=True)}")
    return keys


def fetch_detail(session, key):
    """Parse a facility detail page: labeled fields + survey history rows."""
    soup = BeautifulSoup(get(session, DETAIL_URL, params={"key": key, "keyb": "-1"}).text, "lxml")

    fields = {}
    for row in soup.select("div.row.m-1"):
        divs = row.find_all("div", recursive=False)
        if len(divs) == 2:
            fields[divs[0].get_text(strip=True)] = divs[1].get_text(" ", strip=True)

    surveys = []
    for table in soup.find_all("table"):
        header = [th.get_text(strip=True) for th in table.find_all("th")]
        if header[:2] != ["Survey Type", "Exit Date"]:
            continue
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
    rel = str(path.relative_to(ROOT))
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

def load(path):
    return json.loads(path.read_text()) if path.exists() else {}


def save(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n")


def main():
    today = date.today().isoformat()
    facilities = load(FACILITIES_PATH)
    surveys = load(SURVEYS_PATH)
    known_keys = {lic: f["key"] for lic, f in facilities.items() if f.get("key")}

    session = requests.Session()
    session.headers["User-Agent"] = (
        "Mozilla/5.0 (compatible; WausauPilotCareLedger/1.0; "
        "+https://wausaupilotandreview.com)"
    )

    print(f"[1/4] Searching {COUNTY_NAME} County (AFH + CBRF + RCAC, incl. closed)")
    results_soup = run_search(session)

    print("[2/4] Downloading roster export")
    roster = download_roster(session)
    print(f"  {len(roster)} facilities on the state roster")

    print("[3/4] Harvesting detail keys")
    keys = harvest_keys(session, results_soup, known_keys)
    missing = set(keys) - set(roster)
    if missing:
        raise RuntimeError(f"Grid facilities absent from export: {missing}")

    print("[4/4] Fetching details, survey history, and documents")
    new_surveys = 0
    for license_no, facility in sorted(roster.items()):
        key = keys.get(license_no)
        if not key:
            raise RuntimeError(f"{license_no} {facility['name']} has no detail key")
        detail, history = fetch_detail(session, key)

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
            entry["documents"] = archived
            if sid not in surveys:
                new_surveys += 1
            surveys[sid] = entry

    # Anything we've seen before that the state no longer shows.
    for lic, f in facilities.items():
        if f["last_seen"] != today:
            f["on_state_roster"] = False
    expired = 0
    for sid, s in surveys.items():
        if s["last_seen"] != today and not s["expired_from_state"]:
            s["expired_from_state"] = True
            expired += 1

    save(FACILITIES_PATH, facilities)
    save(SURVEYS_PATH, surveys)

    docs = sum(len(s["documents"]) for s in surveys.values())
    print(
        f"\nDone. {len(facilities)} facilities in ledger "
        f"({sum(1 for f in facilities.values() if f['on_state_roster'])} on state roster), "
        f"{len(surveys)} survey records ({new_surveys} new, {expired} newly expired from state), "
        f"{docs} documents archived."
    )


if __name__ == "__main__":
    sys.exit(main())
