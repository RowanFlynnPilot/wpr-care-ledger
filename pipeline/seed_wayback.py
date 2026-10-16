"""Independent copies at the Internet Archive.

The ledger is one newsroom's copy of the state's records. This puts a
second copy on file with an institution that has no stake in them: the
Wayback Machine's Save Page Now fetches each archived document and each
facility's page straight from the state's server and timestamps it, so
anyone can check what the state published without taking WPR's word for
it -- and the copies outlive the state's three-year window and its move to
the Wisconsin Provider Finder.

Documents: every PDF in the archive, once, from the address the state
published it at (surveys.json `document_urls`).

Facility pages: each facility's detail page when the ledger first sees it,
and again whenever what it shows changes (license status, owner, a survey
row or document added or aged off). Keys rotate at the state's weekly
refresh, so this runs right after each fetch (.github/workflows/
wayback.yml), and first proves with fetch.py's own identity check that
the keys still open their facilities.

Nothing is listed until it is proven. Save Page Now's "success" is not:
in the first full run, 108 of 621 captures it reported done never opened
in the Wayback Machine. So a capture waits in `pending` until a run
downloads its raw bytes back: a document must match the ledger's file
byte for byte (the state serves PDFs as static files), a page must open
on the right license and not on the portal's error page. A capture still
missing after RETRY_AFTER is dropped and captured again.

Records go to data/wayback.json: `documents` (archive path -> Wayback URL)
and `pages` (license -> captures, each Wayback URL + fingerprint of what
the page showed) hold verified copies only -- what the widget links;
`pending` holds captures awaiting proof. Idempotent.

Save Page Now stopped taking anonymous captures (2026-10): it needs an
archive.org account's S3 keys (https://archive.org/account/s3.php) in
IA_ACCESS_KEY and IA_SECRET_KEY. It managed ~2.5 captures a minute on the
first full run, so a full copy takes two runs; a normal week, minutes.

Run: python pipeline/seed_wayback.py
"""

import hashlib
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import requests

import fetch

WAYBACK_PATH = fetch.ROOT / "data" / "wayback.json"

SAVE = "https://web.archive.org/save"
STATUS = "https://web.archive.org/save/status/"
WEB = "https://web.archive.org/web/"

USER_AGENT = "WausauPilotCareLedger-seed/1.0 (+https://wausaupilotandreview.com)"

# Save Page Now's documented limit for an account is 7 captures a minute;
# one submission per 10-second tick stays under it.
TICK = 10
MAX_JOBS = 6  # captures in flight at once
JOB_TIMEOUT = 600  # a capture still pending after 10 minutes is given up on
BUDGET = timedelta(minutes=240)  # then stop submitting; the workflow step allows 280
TIMEOUT = 60
RATE_LIMITED = {"error:too-many-requests", "error:user-session-limit"}
# A capture that still won't open this long after Save Page Now reported it
# is treated as lost and captured again.
RETRY_AFTER = timedelta(hours=48)

# PDFs need no browser (or the HEAD request that picks one); detail pages
# are server-rendered, so no time for scripted scrolling.
DOCUMENT_OPTIONS = {"force_get": "1", "skip_first_archive": "1"}
PAGE_OPTIONS = {"js_behavior_timeout": "0", "skip_first_archive": "1"}


def split_copy(copy):
    """Wayback URL -> (timestamp, original URL)."""
    timestamp, url = copy.removeprefix(WEB).split("/", 1)
    return timestamp, url


def captured_at(copy):
    return datetime.strptime(split_copy(copy)[0], "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)


def ia(session, method, url, timeout=TIMEOUT, **kw):
    """One archive.org request. Timeouts, resets and 5xx are routine there,
    so three tries with backoff (fetch.py, by contrast, treats any surprise
    from the state as fatal)."""
    problem = None
    for pause in (0, 30, 90):
        time.sleep(pause)
        try:
            r = session.request(method, url, timeout=timeout, **kw)
        except (requests.Timeout, requests.ConnectionError) as e:
            problem = type(e).__name__
            continue
        if r.status_code < 500:
            return r
        problem = f"HTTP {r.status_code}"
    raise RuntimeError(f"archive.org keeps failing ({problem}): {method} {url}")


def load_wayback():
    """data/wayback.json, moving records from before verification existed
    (2026-10-15) into `pending`, where they are proven like any capture."""
    wayback = fetch.load(WAYBACK_PATH) or {"documents": {}, "pages": {}}
    if "pending" not in wayback:
        wayback = {
            "documents": {},
            "pages": {},
            "pending": {
                "documents": wayback["documents"],
                "pages": {lic: copies[-1] for lic, copies in wayback["pages"].items()},
            },
        }
    return wayback


# --------------------------------------------------------------- what to copy

def plan_documents(surveys, wayback):
    """Documents with no copy, verified or pending: ([(path, url)] to
    capture, [paths missing their state URL])."""
    todo, no_url = [], []
    for s in surveys.values():
        for kind, path in sorted(s["documents"].items()):
            if path in wayback["documents"] or path in wayback["pending"]["documents"]:
                continue
            url = s.get("document_urls", {}).get(kind)
            if url:
                todo.append((path, url))
            else:
                no_url.append(path)
    return todo, no_url


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
    """Facilities whose page as it is now has no copy, verified or pending:
    [(license, page URL, fingerprint)]. Only this run's roster has current
    keys."""
    todo = []
    for license_no, f in sorted(facilities.items()):
        if f["last_seen"] != run:
            continue
        fp = fingerprint(license_no, f, surveys, run)
        verified = wayback["pages"].get(license_no)
        pending = wayback["pending"]["pages"].get(license_no)
        if (verified and verified[-1]["fingerprint"] == fp) or (pending and pending["fingerprint"] == fp):
            continue
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
        try:
            r = ia(session, "POST", SAVE, data={"url": url, **options})
        except RuntimeError as e:
            # One URL archive.org won't take right now; the next run retries
            # it. (The third full run died here, with four items left.)
            return None, str(e)
        if r.status_code == 401:
            raise RuntimeError(f"archive.org refused the credentials: {r.text[:200]}")
        try:
            body = r.json()
        except ValueError:
            body = {}
        if body.get("job_id"):
            return body["job_id"], None
        if r.status_code == 429 or body.get("status_ext") in RATE_LIMITED:
            print(f"  Save Page Now says wait ({body.get('status_ext') or 'HTTP 429'}); pausing a minute")
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
            try:
                r = ia(session, "GET", STATUS + job_id)
            except RuntimeError:
                r = SimpleNamespace(status_code=429)  # no answer yet: ask again next tick
            if r.status_code == 429:
                # The status check itself was rate limited -- says nothing
                # about the capture (the first full run counted 7 as failed).
                # Ask again next tick; JOB_TIMEOUT still bounds the wait.
                status = {"status": "pending"}
            else:
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
    """Why a finished capture can't even wait for proof, or None."""
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


# ------------------------------------------------------------------ proving

def proven(kind, ref, copy, body_of):
    """Does this capture open as what it claims? True, False (it opens as
    something else), or None (it doesn't open yet). body_of(copy) returns
    the raw archived bytes, or None if the Wayback Machine has nothing."""
    body = body_of(copy)
    if body is None:
        return None
    if kind == "document":
        return body == (fetch.ROOT / ref).read_bytes()
    text = body.decode("utf-8", "replace")
    return ref in text and "UnexpectedError" not in text


def verify(wayback, body_of, now):
    """Graduate pending captures that prove out; drop the ones that open as
    the wrong thing, or are still missing after RETRY_AFTER, so they are
    captured again. Returns {"verified": n, "differ": [...], "lost": n,
    "waiting": n}."""
    out = {"verified": 0, "differ": [], "lost": 0, "waiting": 0}
    pending = wayback["pending"]
    for kind, store in (("document", pending["documents"]), ("page", pending["pages"])):
        for ref in sorted(store):
            entry = store[ref]
            copy = entry if kind == "document" else entry["copy"]
            ok = proven(kind, ref, copy, body_of)
            if ok:
                if kind == "document":
                    wayback["documents"][ref] = copy
                else:
                    wayback["pages"].setdefault(ref, []).append(entry)
                del store[ref]
                out["verified"] += 1
            elif ok is False:
                out["differ"].append(f"{ref} ({copy})")
                del store[ref]
            elif now - captured_at(copy) > RETRY_AFTER:
                del store[ref]
                out["lost"] += 1
            else:
                out["waiting"] += 1
    return out


def archived_bytes(session):
    def body_of(copy):
        timestamp, url = split_copy(copy)
        r = ia(session, "GET", f"{WEB}{timestamp}id_/{url}")
        time.sleep(0.3)  # replay is archive.org's busiest service; be gentle
        return r.content if r.status_code == 200 else None
    return body_of


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
    wayback = load_wayback()
    run = max(f["last_seen"] for f in facilities.values())

    session = requests.Session()
    session.headers.update({
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Authorization": f"LOW {access}:{secret}",
    })
    replay = requests.Session()  # reading copies back needs no credentials
    replay.headers["User-Agent"] = USER_AGENT
    body_of = archived_bytes(replay)

    before = verify(wayback, body_of, datetime.now(timezone.utc))
    fetch.save(WAYBACK_PATH, wayback)
    print(f"Proved {before['verified']} waiting captures; {before['waiting']} still waiting, "
          f"{before['lost']} lost (captured again below), {len(before['differ'])} open as something else")

    documents, no_url = plan_documents(surveys, wayback)
    pages = plan_pages(facilities, surveys, wayback, run)
    if pages and not keys_current(pages[0][0], facilities[pages[0][0]]["key"]):
        pages = []

    # Pages first: their keys expire at the state's next weekly refresh.
    items = [(url, PAGE_OPTIONS, ("page", lic, fp)) for lic, url, fp in pages]
    items += [(url, DOCUMENT_OPTIONS, ("document", path)) for path, url in documents]
    print(f"Ledger of {run}: capturing {len(pages)} facility pages and {len(documents)} documents")
    captured, failed = 0, []
    for n, (tag, url, status) in enumerate(capture(session, items, datetime.now() + BUDGET), 1):
        reason = rejected(tag, status)
        if reason:
            failed.append(f"{url} ({reason})")
            print(f"  [{n}/{len(items)}] FAILED {url}: {reason}")
            continue
        copy = f"{WEB}{status['timestamp']}/{url}"
        if tag[0] == "document":
            wayback["pending"]["documents"][tag[1]] = copy
        else:
            wayback["pending"]["pages"][tag[1]] = {"copy": copy, "fingerprint": tag[2]}
        captured += 1
        fetch.save(WAYBACK_PATH, wayback)
        print(f"  [{n}/{len(items)}] {copy}")

    # Captures from early in the run have usually reached the Wayback
    # Machine by now; the rest are proven next run.
    after = verify(wayback, body_of, datetime.now(timezone.utc))
    fetch.save(WAYBACK_PATH, wayback)

    roster = [lic for lic, f in facilities.items() if f["last_seen"] == run]
    current = sum(
        1 for lic in roster
        if wayback["pages"].get(lic)
        and wayback["pages"][lic][-1]["fingerprint"] == fingerprint(lic, facilities[lic], surveys, run)
    )
    total = sum(len(s["documents"]) for s in surveys.values())
    differ = before["differ"] + after["differ"]
    lines = [
        "## Internet Archive copies",
        f"- Verified copies: {len(wayback['documents'])} of {total} documents (byte-identical to the "
        f"ledger's files) and the current page of {current} of {len(roster)} facilities on the state's roster.",
        f"- This run: {captured} captured, {before['verified'] + after['verified']} proven, "
        f"{after['waiting']} waiting to open in the Wayback Machine, "
        f"{before['lost'] + after['lost']} lost and captured again.",
    ]
    if differ:
        lines.append(f"- **WARNING: {len(differ)} copies opened as something else** -- for a document, "
                     f"did the state replace it? Each is captured again: " + "; ".join(differ[:20]))
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
