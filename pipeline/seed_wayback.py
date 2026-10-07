"""Independent copies at the Internet Archive.

The ledger is one newsroom's copy of the state's records. This puts a
second copy on file with an institution that has no stake in them: the
Wayback Machine's Save Page Now fetches each archived document and each
facility's page straight from the state's server and timestamps it, so
anyone can check what the state published without taking WPR's word for
it -- and the copies outlive the state's three-year window and its move to
the Wisconsin Provider Finder.

Documents: every PDF in the archive, once, from the address the state
published it at (surveys.json `document_urls`). The state serves them as
static files, so a faithful copy's digest equals the SHA-1 of the ledger's
file; every run checks that for every copy and reports any that differ.
A document the Wayback Machine already holds byte for byte is recorded,
not captured again.

Facility pages: each facility's detail page when the ledger first sees it,
and again whenever what it shows changes (license status, owner, a survey
row or document added or aged off). Keys rotate at the state's weekly
refresh, so this runs right after each fetch (.github/workflows/
wayback.yml), and first proves with fetch.py's own identity check that
the keys still open their facilities.

Records go to data/wayback.json: archive path -> Wayback URL for
documents; license -> captures (Wayback URL + fingerprint of what the page
showed) for pages. Idempotent; a failed capture is retried next run.

Save Page Now stopped taking anonymous captures (2026-10): it needs an
archive.org account's S3 keys (https://archive.org/account/s3.php) in
IA_ACCESS_KEY and IA_SECRET_KEY. At its limit of 7 captures a minute the
first run (~1,100 items) takes about three hours; a normal week, minutes.

Run: python pipeline/seed_wayback.py
"""

import base64
import hashlib
import os
import re
import sys
import time
from datetime import datetime, timedelta

import requests

import fetch

WAYBACK_PATH = fetch.ROOT / "data" / "wayback.json"

SAVE = "https://web.archive.org/save"
STATUS = "https://web.archive.org/save/status/"
CDX = "https://web.archive.org/cdx/search/cdx"
WEB = "https://web.archive.org/web/"
DOCUMENTS = "forwardhealth.wi.gov/kw/dqa/*"
PAGES = "forwardhealth.wi.gov/WIPortal/Subsystem/Public/DqaProviderDetails.aspx*"

USER_AGENT = "WausauPilotCareLedger-seed/1.0 (+https://wausaupilotandreview.com)"

# Save Page Now's documented limit for an account is 7 captures a minute;
# one submission per 10-second tick stays under it.
TICK = 10
MAX_JOBS = 6  # captures in flight at once
JOB_TIMEOUT = 600  # a capture still pending after 10 minutes is given up on
BUDGET = timedelta(minutes=240)  # then stop submitting; the workflow step allows 280
TIMEOUT = 60
RATE_LIMITED = {"error:too-many-requests", "error:user-session-limit"}

# PDFs need no browser (or the HEAD request that picks one); detail pages
# are server-rendered, so no time for scripted scrolling.
DOCUMENT_OPTIONS = {"force_get": "1", "skip_first_archive": "1"}
PAGE_OPTIONS = {"js_behavior_timeout": "0", "skip_first_archive": "1"}


def sha1_b32(path):
    """The Wayback Machine's payload digest: base32 of the SHA-1."""
    return base64.b32encode(hashlib.sha1(path.read_bytes()).digest()).decode()


def document_name(url):
    return url.rsplit("/", 1)[-1].upper()  # 8F3914ENFS.PDF


def page_key(url):
    m = re.search(r"[?&]key=(\d+)", url)
    return m.group(1) if m else None


def split_copy(copy):
    """Wayback URL -> (timestamp, original URL)."""
    timestamp, url = copy.removeprefix(WEB).split("/", 1)
    return timestamp, url


def ia(session, method, url, **kw):
    """One archive.org request. Timeouts, resets and 5xx are routine there,
    so three tries with backoff (fetch.py, by contrast, treats any surprise
    from the state as fatal)."""
    problem = None
    for pause in (0, 30, 90):
        time.sleep(pause)
        try:
            r = session.request(method, url, timeout=TIMEOUT, **kw)
        except (requests.Timeout, requests.ConnectionError) as e:
            problem = type(e).__name__
            continue
        if r.status_code < 500:
            return r
        problem = f"HTTP {r.status_code}"
    raise RuntimeError(f"archive.org keeps failing ({problem}): {method} {url}")


def cdx_index(session, pattern, key):
    """The Wayback Machine's 200 captures under a URL prefix:
    {key(original): [(timestamp, digest), ...]}."""
    r = ia(session, "GET", CDX, params={
        "url": pattern, "output": "json", "filter": "statuscode:200",
        "fl": "original,timestamp,digest",
    })
    r.raise_for_status()
    index = {}
    for original, timestamp, digest in (r.json() if r.text.strip() else [])[1:]:
        index.setdefault(key(original), []).append((timestamp, digest))
    return index


# --------------------------------------------------------------- what to copy

def plan_documents(surveys, wayback, index):
    """Ledger documents not yet recorded, split three ways: copies the
    Wayback Machine already holds byte for byte ({path: Wayback URL},
    recorded without capturing again), documents to capture
    ([(path, url)]), and documents missing their state URL."""
    found, todo, no_url = {}, [], []
    for s in surveys.values():
        for kind, path in sorted(s["documents"].items()):
            if path in wayback["documents"]:
                continue
            url = s.get("document_urls", {}).get(kind)
            if not url:
                no_url.append(path)
                continue
            digest = sha1_b32(fetch.ROOT / path)
            same = sorted(ts for ts, d in index.get(document_name(url), []) if d == digest)
            if same:
                found[path] = f"{WEB}{same[0]}/{url}"
            else:
                todo.append((path, url))
    return found, todo, no_url


def fingerprint(license_no, facility, surveys, run):
    """What the state's page for this facility shows this week: license
    status, owner, and each survey row with its documents."""
    rows = sorted(
        f"{s['exit_date']} {s['survey_type']} {' '.join(sorted(s['documents']))}"
        for s in surveys.values()
        if s["license"] == license_no and s["last_seen"] == run
    )
    shown = [facility["licensure_status"], facility["ownership_type"], facility["owner_name"], *rows]
    return hashlib.sha1("\n".join(shown).encode()).hexdigest()[:12]


def plan_pages(facilities, surveys, wayback, run):
    """Facilities whose page was never copied, or shows something new since
    its last copy: [(license, page URL, fingerprint)]. Only this run's
    roster has current keys."""
    todo = []
    for license_no, f in sorted(facilities.items()):
        if f["last_seen"] != run:
            continue
        fp = fingerprint(license_no, f, surveys, run)
        copies = wayback["pages"].get(license_no)
        if not copies or copies[-1]["fingerprint"] != fp:
            todo.append((license_no, f"{fetch.DETAIL_URL}?key={f['key']}&keyb=-1", fp))
    return todo


def keys_current(license_no, key):
    """Prove this week's keys still open their facilities -- fetch.py's own
    identity check, on one -- before sending the Wayback Machine to them
    all. After the state's weekly refresh, every key opens its error page."""
    state = requests.Session()  # never the archive.org session: it carries credentials
    state.headers["User-Agent"] = fetch.USER_AGENT
    try:
        fetch.fetch_detail(state, key, license_no)
    except RuntimeError as e:
        print(f"Facility pages wait for the next fetch -- detail keys are stale: {e}")
        return False
    return True


# ---------------------------------------------------------------- capturing

def submit(session, url, options):
    """Start one capture: (job id, None), or (None, reason) if Save Page Now
    refuses the URL. Rate limits are waited out; bad credentials raise."""
    for _ in range(10):
        r = ia(session, "POST", SAVE, data={"url": url, **options})
        if r.status_code == 401:
            raise RuntimeError(f"archive.org refused the credentials: {r.text[:200]}")
        try:
            body = r.json()
        except ValueError:
            body = {}
        if body.get("job_id"):
            return body["job_id"], None
        if r.status_code == 429 or body.get("status_ext") in RATE_LIMITED:
            time.sleep(60)
            continue
        return None, body.get("status_ext") or body.get("message") or f"HTTP {r.status_code}"
    return None, "rate limited for ten minutes"


def capture(session, items, deadline):
    """Run (url, options, tag) items through Save Page Now: one submission
    per tick, at most MAX_JOBS in flight. Yields (tag, url, status) as each
    capture finishes -- Save Page Now's job status, or a refusal."""
    queue, jobs = list(items), {}
    while queue or jobs:
        tick = time.monotonic()
        for job_id, (url, tag, started) in list(jobs.items()):
            r = ia(session, "GET", STATUS + job_id)
            try:
                status = r.json() if r.ok else {"status": "error", "status_ext": f"HTTP {r.status_code}"}
            except ValueError:
                status = {"status": "pending"}
            if status.get("status") == "pending" and time.monotonic() - started < JOB_TIMEOUT:
                continue
            del jobs[job_id]
            yield tag, url, status
        if queue and len(jobs) < MAX_JOBS:
            if datetime.now() >= deadline:
                print(f"  Time budget spent; {len(queue)} items wait for the next run.")
                queue = []
            else:
                url, options, tag = queue.pop(0)
                job_id, refused = submit(session, url, options)
                if job_id:
                    jobs[job_id] = (url, tag, time.monotonic())
                else:
                    yield tag, url, {"status": "error", "status_ext": refused}
        time.sleep(max(0, TICK - (time.monotonic() - tick)))


def rejected(tag, status):
    """Why a finished capture can't be recorded, or None if it can."""
    if status.get("status") != "success":
        return status.get("status_ext") or status.get("message") or status.get("status")
    if not status.get("timestamp"):
        return "success without a capture timestamp"
    if tag[0] == "page":
        # A stale key 302s to the portal's error page -- a 200 a capture
        # would happily keep. The failure that once emptied the ledger.
        fetched = [status.get("original_url") or "", *(status.get("resources") or [])]
        if any("UnexpectedError" in u for u in fetched):
            return "landed on the portal's error page"
    return None


# ------------------------------------------------------------------ checking

def audit(wayback, documents_index, pages_index):
    """Check every recorded copy against the Wayback Machine's index (a
    fresh capture can take a while to reach it). Returns document paths
    split (identical, differ, unindexed) and page copies (indexed,
    unindexed)."""
    identical, differ, unindexed = [], [], []
    for path, copy in sorted(wayback["documents"].items()):
        timestamp, url = split_copy(copy)
        captures = documents_index.get(document_name(url), [])
        if any(d == sha1_b32(fetch.ROOT / path) for _, d in captures):
            identical.append(path)
        elif any(ts == timestamp for ts, _ in captures):
            differ.append(path)
        else:
            unindexed.append(path)
    pages = [split_copy(c["copy"])[1] for copies in wayback["pages"].values() for c in copies]
    indexed = sum(1 for url in pages if page_key(url) in pages_index)
    return identical, differ, unindexed, indexed, len(pages) - indexed


def main():
    access, secret = os.environ.get("IA_ACCESS_KEY"), os.environ.get("IA_SECRET_KEY")
    if not (access and secret):
        raise RuntimeError(
            "IA_ACCESS_KEY and IA_SECRET_KEY are not set. Save Page Now needs an "
            "archive.org account's S3 keys (https://archive.org/account/s3.php), "
            "stored as repository secrets -- see README, Internet Archive copies."
        )
    facilities = fetch.load(fetch.FACILITIES_PATH)
    surveys = fetch.load(fetch.SURVEYS_PATH)
    wayback = fetch.load(WAYBACK_PATH) or {"documents": {}, "pages": {}}
    run = max(f["last_seen"] for f in facilities.values())

    session = requests.Session()
    session.headers.update({
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Authorization": f"LOW {access}:{secret}",
    })

    found, documents, no_url = plan_documents(
        surveys, wayback, cdx_index(session, DOCUMENTS, document_name))
    wayback["documents"].update(found)
    fetch.save(WAYBACK_PATH, wayback)
    pages = plan_pages(facilities, surveys, wayback, run)
    if pages and not keys_current(pages[0][0], facilities[pages[0][0]]["key"]):
        pages = []

    # Pages first: their keys expire at the state's next weekly refresh.
    items = [(url, PAGE_OPTIONS, ("page", lic, fp)) for lic, url, fp in pages]
    items += [(url, DOCUMENT_OPTIONS, ("document", path)) for path, url in documents]
    print(f"Ledger of {run}: copying {len(pages)} facility pages and {len(documents)} "
          f"documents to the Wayback Machine ({len(found)} more documents it already "
          f"holds byte for byte)")
    copied = {"page": 0, "document": 0}
    failed = []
    for n, (tag, url, status) in enumerate(capture(session, items, datetime.now() + BUDGET), 1):
        reason = rejected(tag, status)
        if reason:
            failed.append(f"{url} ({reason})")
            print(f"  [{n}/{len(items)}] FAILED {url}: {reason}")
            continue
        copy = f"{WEB}{status['timestamp']}/{url}"
        if tag[0] == "document":
            wayback["documents"][tag[1]] = copy
        else:
            wayback["pages"].setdefault(tag[1], []).append({"copy": copy, "fingerprint": tag[2]})
        copied[tag[0]] += 1
        fetch.save(WAYBACK_PATH, wayback)
        print(f"  [{n}/{len(items)}] {copy}")

    identical, differ, unindexed, pages_indexed, pages_unindexed = audit(
        wayback,
        cdx_index(session, DOCUMENTS, document_name),
        cdx_index(session, PAGES, page_key),
    )
    roster = [lic for lic, f in facilities.items() if f["last_seen"] == run]
    current = sum(
        1 for lic in roster
        if wayback["pages"].get(lic)
        and wayback["pages"][lic][-1]["fingerprint"] == fingerprint(lic, facilities[lic], surveys, run)
    )
    total = sum(len(s["documents"]) for s in surveys.values())
    lines = [
        "## Internet Archive copies",
        f"- Facility pages: {current} of {len(roster)} facilities on the state's roster have "
        f"their current page on file ({copied['page']} captured this run); "
        f"{pages_indexed} page copies confirmed in the Wayback index, {pages_unindexed} not yet indexed.",
        f"- Documents: {len(wayback['documents'])} of {total} have a copy ({copied['document']} "
        f"captured this run); {len(identical)} confirmed byte-identical to the ledger's file, "
        f"{len(unindexed)} not yet indexed.",
    ]
    if differ:
        lines.append(f"- **WARNING: {len(differ)} Wayback copies differ from the ledger's file** "
                     f"-- did the state replace the document? {', '.join(differ)}")
    if no_url:
        lines.append(f"- **{len(no_url)} documents have no state URL in surveys.json** and "
                     f"can't be copied: {', '.join(no_url)}")
    if failed:
        lines.append(f"- {len(failed)} captures failed; each is retried next run: "
                     + "; ".join(failed[:20]) + (" ..." if len(failed) > 20 else ""))
    report = "\n".join(lines)
    print("\n" + report)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fh:
            fh.write(report + "\n")
    if items and len(failed) == len(items):
        raise RuntimeError(f"Every capture failed, starting with {failed[0]} -- "
                           f"is Save Page Now down, or refusing this account?")


if __name__ == "__main__":
    sys.exit(main())
