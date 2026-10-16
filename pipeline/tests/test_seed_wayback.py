"""Tests for the Internet Archive step: what gets captured, what gets
listed, and the copies that must never be listed.

Run: python -m unittest discover -s pipeline/tests
"""

import contextlib
import io
import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import seed_wayback as sw  # noqa: E402

RUN = "2026-10-07"
DQA = "https://www.forwardhealth.wi.gov/kw/dqa/"
PAGE_URL = ("https://www.forwardhealth.wi.gov/WIPortal/Subsystem/Public/"
            "DqaProviderDetails.aspx?key=15570764&keyb=-1")
# A real archived document, so a copy can be compared byte for byte.
DOC = "archive/0013424/2026-03-12_survey-vv_enforcement.pdf"
DOC_BYTES = (Path(__file__).resolve().parents[2] / DOC).read_bytes()
CAPTURED = datetime(2026, 10, 15, 3, 0, tzinfo=timezone.utc)


def copy_of(url, when=CAPTURED):
    return f"{sw.WEB}{when:%Y%m%d%H%M%S}/{url}"


def survey(license, exit_date, docs, last_seen=RUN):
    return {
        "license": license, "exit_date": exit_date, "survey_type": "COMPLAINT",
        "documents": {k: f"archive/{license}/{exit_date}_complaint_{k}.pdf" for k in docs},
        "document_urls": {k: DQA + name for k, name in docs.items()},
        "last_seen": last_seen,
    }


def facility(last_seen=RUN):
    return {"last_seen": last_seen, "key": "15570764", "licensure_status": "REGULAR",
            "ownership_type": "Corporation", "owner_name": "OUR HOUSE INC"}


def empty():
    return {"documents": {}, "pages": {}, "pending": {"documents": {}, "pages": {}}}


def response(code, body):
    return SimpleNamespace(status_code=code, ok=code < 400, text=json.dumps(body),
                           json=lambda: body)


class Documents(unittest.TestCase):
    def test_only_documents_with_no_copy_verified_or_pending_are_captured(self):
        surveys = {
            "a": survey("1", "2026-09-30", {"sod": "AAAA11SODS.PDF"}),   # verified
            "b": survey("1", "2026-08-25", {"sod": "BBBB11SODS.PDF"}),   # pending
            "c": survey("2", "2026-07-01", {"enforcement": "CCCC11ENFS.PDF"}),  # none
        }
        wayback = empty()
        wayback["documents"]["archive/1/2026-09-30_complaint_sod.pdf"] = "x"
        wayback["pending"]["documents"]["archive/1/2026-08-25_complaint_sod.pdf"] = "y"
        todo, no_url = sw.plan_documents(surveys, wayback)
        self.assertEqual(todo, [("archive/2/2026-07-01_complaint_enforcement.pdf", DQA + "CCCC11ENFS.PDF")])
        self.assertEqual(no_url, [])

    def test_a_document_without_its_state_url_is_reported(self):
        s = survey("1", "2026-09-30", {"sod": "AAAA11SODS.PDF"})
        del s["document_urls"]
        self.assertEqual(sw.plan_documents({"a": s}, empty()),
                         ([], ["archive/1/2026-09-30_complaint_sod.pdf"]))


class Pages(unittest.TestCase):
    def setUp(self):
        self.facilities = {"1": facility(), "2": facility(last_seen="2026-07-12")}
        self.surveys = {"a": survey("1", "2026-09-30", {"sod": "AAAA11SODS.PDF"})}

    def plan(self, wayback):
        return sw.plan_pages(self.facilities, self.surveys, wayback, RUN)

    def test_first_sight_captures_and_a_facility_off_the_roster_has_no_page(self):
        todo = self.plan(empty())
        self.assertEqual([(lic, url) for lic, url, _ in todo], [("1", PAGE_URL)])

    def test_a_pending_capture_of_the_same_page_is_not_repeated(self):
        (_, _, fp), = self.plan(empty())
        wayback = empty()
        wayback["pending"]["pages"]["1"] = {"copy": "x", "fingerprint": fp}
        self.assertEqual(self.plan(wayback), [])

    def test_recaptured_exactly_when_what_the_page_shows_changes(self):
        (_, _, fp), = self.plan(empty())
        wayback = empty()
        wayback["pages"]["1"] = [{"copy": "x", "fingerprint": fp}]
        self.assertEqual(self.plan(wayback), [])
        self.facilities["1"]["key"] = "15999999"  # next week's key, same page
        self.assertEqual(self.plan(wayback), [])

        changes = [
            # A letter posts onto an existing survey.
            lambda: self.surveys["a"]["documents"].update(enforcement="archive/1/x_enforcement.pdf"),
            # A new survey appears.
            lambda: self.surveys.update(b=survey("1", "2026-10-01", {})),
            # A record ages off.
            lambda: self.surveys["b"].update(last_seen="2026-09-30"),
            # The license closes.
            lambda: self.facilities["1"].update(licensure_status="CLOSED"),
        ]
        for change in changes:
            change()
            (_, _, new_fp), = self.plan(wayback)
            wayback["pages"]["1"].append({"copy": "x", "fingerprint": new_fp})
            self.assertEqual(self.plan(wayback), [])


class Proving(unittest.TestCase):
    """Save Page Now's "success" is not proof: in the first full run, 108
    of 621 reported captures never opened. Only proven copies are listed."""

    def verify(self, wayback, bodies, hours_later=1):
        now = CAPTURED + timedelta(hours=hours_later)
        return sw.verify(wayback, lambda copy: bodies.get(copy), now)

    def test_a_byte_identical_document_is_listed(self):
        wayback = empty()
        copy = copy_of(DQA + "8F3914ENFS.PDF")
        wayback["pending"]["documents"][DOC] = copy
        out = self.verify(wayback, {copy: DOC_BYTES})
        self.assertEqual(wayback["documents"], {DOC: copy})
        self.assertEqual(wayback["pending"]["documents"], {})
        self.assertEqual(out["verified"], 1)

    def test_a_copy_that_does_not_open_waits_then_is_dropped_for_recapture(self):
        wayback = empty()
        wayback["pending"]["documents"][DOC] = copy_of(DQA + "8F3914ENFS.PDF")
        self.assertEqual(self.verify(wayback, {}, hours_later=19)["waiting"], 1)
        self.assertIn(DOC, wayback["pending"]["documents"])
        self.assertEqual(self.verify(wayback, {}, hours_later=49)["lost"], 1)
        self.assertEqual(wayback["pending"]["documents"], {})
        self.assertEqual(wayback["documents"], {})
        self.assertEqual(sw.plan_documents(
            {"s": {"documents": {"enforcement": DOC},
                   "document_urls": {"enforcement": DQA + "8F3914ENFS.PDF"}}}, wayback)[0],
            [(DOC, DQA + "8F3914ENFS.PDF")])  # captured again

    def test_a_document_that_differs_is_never_listed(self):
        wayback = empty()
        copy = copy_of(DQA + "8F3914ENFS.PDF")
        wayback["pending"]["documents"][DOC] = copy
        out = self.verify(wayback, {copy: DOC_BYTES + b"changed"})
        self.assertEqual(wayback["documents"], {})
        self.assertEqual(len(out["differ"]), 1)

    def test_a_page_must_open_on_its_own_license_and_not_the_error_page(self):
        wayback = empty()
        right, wrong, error = (copy_of(PAGE_URL, CAPTURED + timedelta(minutes=m)) for m in (0, 1, 2))
        wayback["pending"]["pages"] = {
            "0013424": {"copy": right, "fingerprint": "f1"},
            "0015844": {"copy": wrong, "fingerprint": "f2"},
            "0016344": {"copy": error, "fingerprint": "f3"},
        }
        out = self.verify(wayback, {
            right: b"<span>License Number</span><div>0013424</div>",
            wrong: b"<div>0013424</div>",  # another facility's page
            error: b"0016344 ... UnexpectedError.aspx",
        })
        self.assertEqual(wayback["pages"], {"0013424": [{"copy": right, "fingerprint": "f1"}]})
        self.assertEqual(len(out["differ"]), 2)

    def test_records_from_before_proving_wait_to_be_proven(self):
        old = {"documents": {DOC: "d"}, "pages": {"1": [{"copy": "p", "fingerprint": "f"}]}}
        with mock.patch.object(sw.fetch, "load", return_value=old):
            wayback = sw.load_wayback()
        self.assertEqual(wayback, {
            "documents": {}, "pages": {},
            "pending": {"documents": {DOC: "d"}, "pages": {"1": {"copy": "p", "fingerprint": "f"}}},
        })


class Recording(unittest.TestCase):
    PAGE = ("page", "0013424", "fp")

    def test_a_page_capture_that_landed_on_the_portal_error_page_is_never_recorded(self):
        # A stale key: the capture "succeeds", on the state's error page.
        landed = {
            "status": "success", "timestamp": "20261007040000", "original_url": PAGE_URL,
            "resources": ["https://www.forwardhealth.wi.gov/wiportal/UnexpectedError.aspx"
                          "?aspxerrorpath=/WIPortal/Subsystem/Public/DqaProviderDetails.aspx"],
        }
        self.assertIn("error page", sw.rejected(self.PAGE, landed))
        good = dict(landed, resources=[PAGE_URL, "https://www.forwardhealth.wi.gov/WIPortal/css/DQA.css"])
        self.assertIsNone(sw.rejected(self.PAGE, good))

    def test_a_failed_capture_is_not_recorded(self):
        failed = {"status": "error", "status_ext": "error:not-found"}
        self.assertEqual(sw.rejected(("document", "p"), failed), "error:not-found")
        self.assertIsNotNone(sw.rejected(("document", "p"), {"status": "success"}))


class SavePageNow(unittest.TestCase):
    def test_bad_credentials_fail_loudly(self):
        refusal = response(401, {"message": "You need to be logged in to use Save Page Now."})
        with mock.patch.object(sw, "ia", return_value=refusal):
            with self.assertRaisesRegex(RuntimeError, "refused the credentials"):
                sw.submit(None, "u", {})

    def test_rate_limits_are_waited_out(self):
        replies = [
            response(429, {}),
            response(200, {"status": "error", "status_ext": "error:user-session-limit"}),
            response(200, {"url": "u", "job_id": "spn2-1"}),
        ]
        # Quiet: a fake "pausing" line in CI logs reads like a real one.
        with mock.patch.object(sw, "ia", side_effect=replies), mock.patch.object(sw.time, "sleep"), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(sw.submit(None, "u", {}), ("spn2-1", None))

    def test_each_capture_is_followed_to_its_end(self):
        polls = {}

        def ia(session, method, url, **kw):
            if method == "POST":
                if kw["data"]["url"] == "bad":
                    return response(200, {"status": "error", "status_ext": "error:invalid-url-syntax"})
                return response(200, {"url": kw["data"]["url"], "job_id": "spn2-a"})
            polls[url] = polls.get(url, 0) + 1
            return response(200, {"status": "pending"} if polls[url] < 2
                            else {"status": "success", "timestamp": "20261007040000"})

        items = [("a", {}, ("document", "pa")), ("bad", {}, ("document", "pb"))]
        with mock.patch.object(sw, "ia", side_effect=ia), mock.patch.object(sw.time, "sleep"):
            done = list(sw.capture(None, items, datetime.max))
        self.assertEqual([(tag[1], status["status"]) for tag, _, status in done],
                         [("pb", "error"), ("pa", "success")])

    def test_a_rate_limited_status_check_is_not_a_failed_capture(self):
        # The first full run counted 7 captures failed on a 429 from the
        # status endpoint, which says nothing about the capture itself.
        replies = iter([
            response(200, {"url": "a", "job_id": "spn2-a"}),       # submit
            response(429, {}),                                      # status: rate limited
            response(200, {"status": "success", "timestamp": "20261015040000"}),
        ])
        with mock.patch.object(sw, "ia", side_effect=lambda *a, **k: next(replies)), \
                mock.patch.object(sw.time, "sleep"):
            done = list(sw.capture(None, [("a", {}, ("document", "pa"))], datetime.max))
        self.assertEqual([status["status"] for _, _, status in done], ["success"])

    def test_archive_org_not_answering_fails_one_item_not_the_run(self):
        # The third full run died on a timeout submitting one capture.
        with mock.patch.object(sw, "ia", side_effect=RuntimeError("archive.org keeps failing")), \
                mock.patch.object(sw.time, "sleep"):
            done = list(sw.capture(None, [("a", {}, ("document", "pa"))], datetime.max))
        self.assertEqual([(tag[1], status["status"]) for tag, _, status in done], [("pa", "error")])

    def test_a_spent_budget_leaves_the_rest_for_the_next_run(self):
        with mock.patch.object(sw, "ia") as ia, mock.patch.object(sw.time, "sleep"), \
                contextlib.redirect_stdout(io.StringIO()):
            done = list(sw.capture(None, [("a", {}, ("document", "pa"))], datetime.min))
        self.assertEqual(done, [])
        ia.assert_not_called()


if __name__ == "__main__":
    unittest.main()
