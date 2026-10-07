"""Tests for the Internet Archive step: what gets captured, what gets
recorded, and the capture that must never be recorded.

Run: python -m unittest discover -s pipeline/tests
"""

import contextlib
import io
import json
import sys
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import seed_wayback as sw  # noqa: E402

RUN = "2026-10-07"
DQA = "https://www.forwardhealth.wi.gov/kw/dqa/"
PAGE_URL = ("https://www.forwardhealth.wi.gov/WIPortal/Subsystem/Public/"
            "DqaProviderDetails.aspx?key=15570764&keyb=-1")


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


def response(code, body):
    return SimpleNamespace(status_code=code, ok=code < 400, text=json.dumps(body),
                           json=lambda: body)


class Documents(unittest.TestCase):
    def test_a_copy_already_held_byte_for_byte_is_recorded_not_recaptured(self):
        surveys = {
            # The Wayback Machine holds this exact file: record its earliest copy.
            "a": survey("1", "2026-09-30", {"sod": "AAAA11SODS.PDF"}),
            # It holds a different file at that address: capture ours.
            "b": survey("1", "2026-08-25", {"sod": "BBBB11SODS.PDF"}),
            # Never captured.
            "c": survey("2", "2026-07-01", {"enforcement": "CCCC11ENFS.PDF"}),
            # Already recorded.
            "d": survey("2", "2026-06-01", {"sod": "DDDD11SODS.PDF"}),
        }
        wayback = {"documents": {"archive/2/2026-06-01_complaint_sod.pdf": "x"}, "pages": {}}
        index = {
            "AAAA11SODS.PDF": [("20250101000000", "OURS"), ("20240101000000", "OURS")],
            "BBBB11SODS.PDF": [("20240101000000", "THEIRS")],
        }
        with mock.patch.object(sw, "sha1_b32", return_value="OURS"):
            found, todo, no_url = sw.plan_documents(surveys, wayback, index)
        self.assertEqual(found, {"archive/1/2026-09-30_complaint_sod.pdf":
                                 sw.WEB + "20240101000000/" + DQA + "AAAA11SODS.PDF"})
        self.assertEqual(todo, [
            ("archive/1/2026-08-25_complaint_sod.pdf", DQA + "BBBB11SODS.PDF"),
            ("archive/2/2026-07-01_complaint_enforcement.pdf", DQA + "CCCC11ENFS.PDF"),
        ])
        self.assertEqual(no_url, [])

    def test_a_document_without_its_state_url_is_reported(self):
        s = survey("1", "2026-09-30", {"sod": "AAAA11SODS.PDF"})
        del s["document_urls"]
        found, todo, no_url = sw.plan_documents({"a": s}, {"documents": {}, "pages": {}}, {})
        self.assertEqual((found, todo, no_url), ({}, [], ["archive/1/2026-09-30_complaint_sod.pdf"]))


class Pages(unittest.TestCase):
    def setUp(self):
        self.facilities = {"1": facility(), "2": facility(last_seen="2026-07-12")}
        self.surveys = {"a": survey("1", "2026-09-30", {"sod": "AAAA11SODS.PDF"})}

    def plan(self, wayback):
        return sw.plan_pages(self.facilities, self.surveys, wayback, RUN)

    def test_first_sight_captures_and_a_facility_off_the_roster_has_no_page(self):
        todo = self.plan({"documents": {}, "pages": {}})
        self.assertEqual([(lic, url) for lic, url, _ in todo], [("1", PAGE_URL)])

    def test_recaptured_exactly_when_what_the_page_shows_changes(self):
        (_, _, fp), = self.plan({"documents": {}, "pages": {}})
        wayback = {"documents": {}, "pages": {"1": [{"copy": "x", "fingerprint": fp}]}}
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
        with mock.patch.object(sw, "ia", side_effect=replies), mock.patch.object(sw.time, "sleep"):
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

    def test_a_spent_budget_leaves_the_rest_for_the_next_run(self):
        with mock.patch.object(sw, "ia") as ia, mock.patch.object(sw.time, "sleep"), \
                contextlib.redirect_stdout(io.StringIO()):
            done = list(sw.capture(None, [("a", {}, ("document", "pa"))], datetime.min))
        self.assertEqual(done, [])
        ia.assert_not_called()


class Audit(unittest.TestCase):
    def test_every_copy_is_checked_byte_for_byte(self):
        wayback = {
            "documents": {
                "archive/1/a.pdf": sw.WEB + "20261007040000/" + DQA + "AAAA11SODS.PDF",
                "archive/1/b.pdf": sw.WEB + "20261007040100/" + DQA + "BBBB11SODS.PDF",
                "archive/1/c.pdf": sw.WEB + "20261007040200/" + DQA + "CCCC11SODS.PDF",
            },
            "pages": {"1": [{"copy": sw.WEB + "20261007040300/" + PAGE_URL, "fingerprint": "f"}]},
        }
        documents_index = {
            "AAAA11SODS.PDF": [("20261007040000", "OURS")],    # identical
            "BBBB11SODS.PDF": [("20261007040100", "THEIRS")],  # differs
        }                                                      # c: not indexed yet
        with mock.patch.object(sw, "sha1_b32", return_value="OURS"):
            identical, differ, unindexed, indexed, pages_unindexed = sw.audit(
                wayback, documents_index, {"15570764": [("20261007040300", "X")]})
        self.assertEqual((identical, differ, unindexed),
                         (["archive/1/a.pdf"], ["archive/1/b.pdf"], ["archive/1/c.pdf"]))
        self.assertEqual((indexed, pages_unindexed), (1, 0))


if __name__ == "__main__":
    unittest.main()
