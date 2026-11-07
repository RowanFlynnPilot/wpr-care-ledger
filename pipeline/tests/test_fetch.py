"""Regression tests for fetch.py's structural guards.

The defining failure of this repo: for 12 weeks, stale detail keys
redirected to the portal's error page, fetch_detail parsed it as a facility
with no history, and every record was published as "no longer shown by the
state" while each run reported success. These tests pin the guards that
make that impossible. Fixtures are real pages saved from the state portal.

Run: python -m unittest discover -s pipeline/tests
"""

import contextlib
import io
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fetch  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def page(name):
    return SimpleNamespace(text=(FIXTURES / name).read_text(encoding="utf-8"))


class DetailPageIdentity(unittest.TestCase):
    def test_valid_page_with_history_parses(self):
        with mock.patch.object(fetch, "get", return_value=page("detail_with_history.html")):
            detail, surveys = fetch.fetch_detail(None, "k", "0013424")
        self.assertEqual(detail["licensure_status"], "REGULAR")
        self.assertGreater(len(surveys), 0)
        self.assertTrue(all(s["exit_date"] for s in surveys))

    def test_valid_page_without_history_parses_empty(self):
        with mock.patch.object(fetch, "get", return_value=page("detail_no_history.html")):
            detail, surveys = fetch.fetch_detail(None, "k", "0010042")
        self.assertEqual(detail["licensure_status"], "REGULAR")
        self.assertEqual(surveys, [])

    def test_page_for_another_facility_raises(self):
        with mock.patch.object(fetch, "get", return_value=page("detail_with_history.html")):
            with self.assertRaisesRegex(RuntimeError, "is not license"):
                fetch.fetch_detail(None, "k", "0010042")

    def test_error_page_body_raises(self):
        # Even if the redirect check were bypassed, the error page's body
        # must never parse as an empty history.
        with mock.patch.object(fetch, "get", return_value=page("portal_error.html")):
            with self.assertRaises(RuntimeError):
                fetch.fetch_detail(None, "k", "0013424")

    def test_redirect_to_error_page_raises(self):
        r = SimpleNamespace(
            url="https://www.forwardhealth.wi.gov/wiportal/UnexpectedError.aspx?aspxerrorpath=/x",
            headers={},
            request=SimpleNamespace(url="https://example/DqaProviderDetails.aspx?key=1"),
            raise_for_status=lambda: None,
        )
        with self.assertRaisesRegex(RuntimeError, "Portal error page"):
            fetch.check_portal(r)


class AgeOffGuard(unittest.TestCase):
    TODAY = date(2026, 10, 6)  # window starts 2023-10-06; guard cutoff 2023-11-05

    def ledger(self, exit_date, survey_seen, facility_seen):
        surveys = {"x": {"license": "1", "exit_date": exit_date, "last_seen": survey_seen}}
        facilities = {"1": {"last_seen": facility_seen}}
        return surveys, facilities

    def test_in_window_record_vanishing_is_caught(self):
        s, f = self.ledger("2026-03-12", "2026-07-12", "2026-10-06")
        self.assertEqual(fetch.vanished_in_window(s, f, self.TODAY), ["x"])

    def test_record_older_than_window_may_age_off(self):
        s, f = self.ledger("2023-09-25", "2026-07-12", "2026-10-06")
        self.assertEqual(fetch.vanished_in_window(s, f, self.TODAY), [])

    def test_record_inside_slack_may_age_off(self):
        s, f = self.ledger("2023-10-20", "2026-07-12", "2026-10-06")
        self.assertEqual(fetch.vanished_in_window(s, f, self.TODAY), [])

    def test_facility_off_roster_takes_its_records_with_it(self):
        s, f = self.ledger("2026-03-12", "2026-07-12", "2026-07-12")
        self.assertEqual(fetch.vanished_in_window(s, f, self.TODAY), [])

    def test_seen_record_is_never_flagged(self):
        s, f = self.ledger("2026-03-12", "2026-10-06", "2026-10-06")
        self.assertEqual(fetch.vanished_in_window(s, f, self.TODAY), [])


class ArchivePaths(unittest.TestCase):
    def test_paths_are_posix_on_every_os(self):
        with mock.patch.object(fetch.Path, "exists", return_value=True):
            rel, _ = fetch.archive_pdf(None, "u", "0013424", "2026-08-05", "COMPLAINT/VV", "sod")
        self.assertEqual(rel, "archive/0013424/2026-08-05_complaint-vv_sod.pdf")


class Revisions(unittest.TestCase):
    """The state replaced The Waterford at Colby's documents at the same
    addresses (2026-09-21). The original must stay; the new one joins it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / "archive" / "1").mkdir(parents=True)
        (root / "archive" / "1" / "2026-02-18_complaint_sod.pdf").write_bytes(b"%PDF original")
        self.patches = [mock.patch.object(fetch, "ROOT", root),
                        mock.patch.object(fetch, "ARCHIVE_DIR", root / "archive"),
                        mock.patch.object(fetch.time, "sleep")]
        for p in self.patches:
            p.start()
        self.root = root
        self.surveys = {"1|2026-02-18|complaint": {
            "license": "1", "exit_date": "2026-02-18", "survey_type": "COMPLAINT",
            "documents": {"sod": "archive/1/2026-02-18_complaint_sod.pdf"},
            "document_urls": {"sod": "https://www.forwardhealth.wi.gov/kw/dqa/UB3G11SODS.PDF"},
        }}

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def run_week(self, modified, body, status=200, answers=None):
        """One week's check. `answers` scripts the HEAD replies in order (a
        status, or an exception to raise); the GET always serves `body`."""
        answers = list(answers or [status])
        calls = []

        def request(method, url, timeout, allow_redirects):
            calls.append(method)
            if method == "GET":
                return SimpleNamespace(status_code=200, content=body, headers={}, url=url)
            a = answers.pop(0) if len(answers) > 1 else answers[0]
            if isinstance(a, Exception):
                raise a
            return SimpleNamespace(status_code=a, headers={"Last-Modified": modified}, url=url)

        # Quiet: a fake "REVISED" line in CI logs reads like a real one.
        with contextlib.redirect_stdout(io.StringIO()):
            out = fetch.check_revisions(SimpleNamespace(request=request), self.surveys, "2026-10-26")
        return out, calls.count("GET")

    def test_a_replaced_document_is_archived_beside_the_original(self):
        s = self.surveys["1|2026-02-18|complaint"]
        (revised, gone, _, _), downloads = self.run_week("Mon, 23 Mar 2026", b"%PDF original")
        self.assertEqual((revised, downloads), ([], 1))  # baseline: downloaded once, unchanged
        (revised, _, _, _), downloads = self.run_week("Mon, 23 Mar 2026", b"%PDF original")
        self.assertEqual(downloads, 0)  # same Last-Modified: no download at all
        (revised, _, _, _), _ = self.run_week("Mon, 21 Sep 2026", b"%PDF reissued")
        self.assertEqual(len(revised), 1)
        rev = "archive/1/2026-02-18_complaint_rev2_sod.pdf"
        self.assertEqual(s["revisions"]["sod"], [
            {"path": rev, "first_seen": "2026-10-26", "last_modified": "Mon, 21 Sep 2026"}])
        self.assertEqual((self.root / rev).read_bytes(), b"%PDF reissued")
        self.assertEqual((self.root / s["documents"]["sod"]).read_bytes(), b"%PDF original")
        self.assertEqual(fetch.current_path(s, "sod"), rev)
        # A new date on identical bytes is not a revision.
        (revised, _, _, _), _ = self.run_week("Tue, 22 Sep 2026", b"%PDF reissued")
        self.assertEqual(revised, [])
        self.assertEqual(len(s["revisions"]["sod"]), 1)

    def test_a_document_the_state_stops_serving_is_reported(self):
        (revised, gone, _, _), downloads = self.run_week(None, b"", status=404)
        self.assertEqual((revised, downloads, len(gone)), ([], 0, 1))

    # ~800 requests a week, before anything is saved: one blip used to cost
    # the whole week's records. And an outage is not the state removing a file.
    def test_a_passing_outage_is_retried(self):
        s = self.surveys["1|2026-02-18|complaint"]
        blip = fetch.requests.ConnectionError("reset")
        (_, gone, unchecked, _), downloads = self.run_week(
            "Mon, 23 Mar 2026", b"%PDF original", answers=[blip, 503, 200])
        self.assertEqual((gone, unchecked, downloads), ([], [], 1))
        self.assertEqual(s["documents_last_modified"], {"sod": "Mon, 23 Mar 2026"})

    def test_a_lasting_outage_is_unchecked_never_gone(self):
        s = self.surveys["1|2026-02-18|complaint"]
        for answer in (503, 403, fetch.requests.Timeout("slow")):
            with self.subTest(answer=answer):
                (_, gone, unchecked, _), _ = self.run_week(None, b"", answers=[answer])
                self.assertEqual((gone, len(unchecked)), ([], 1))
                self.assertNotIn("documents_gone", s)

    def test_a_one_off_404_is_asked_again_and_not_recorded(self):
        s = self.surveys["1|2026-02-18|complaint"]
        (_, gone, unchecked, refused), _ = self.run_week("Mon, 23 Mar 2026", b"%PDF original",
                                                         answers=[404, 200])
        self.assertEqual((gone, unchecked, refused), ([], [], []))
        self.assertNotIn("documents_gone", s)

    def many(self, n):
        for i in range(2, n + 1):
            self.surveys[f"{i}|2026-02-18|complaint"] = dict(self.surveys["1|2026-02-18|complaint"])

    # A misrouted server answers 404 for everything: that must not publish
    # 800 documents as removed by the state.
    def test_too_many_404s_to_believe_are_refused_and_none_recorded(self):
        self.many(fetch.GONE_LIMIT + 1)
        (_, gone, _, refused), _ = self.run_week(None, b"", status=404)
        self.assertEqual((gone, len(refused)), ([], fetch.GONE_LIMIT + 1))
        self.assertFalse(any("documents_gone" in s for s in self.surveys.values()))

    def test_a_server_that_stops_answering_ends_the_check(self):
        self.many(fetch.OUTAGE_STREAK + 5)
        (_, gone, unchecked, _), _ = self.run_week(None, b"", answers=[503])
        self.assertEqual(gone, [])
        self.assertEqual(len(unchecked), fetch.OUTAGE_STREAK + 1)  # ten tried, then the rest in one line
        self.assertIn("5 documents not asked", unchecked[-1])

    def test_a_non_pdf_answer_is_unchecked_not_a_failed_run(self):
        (revised, _, unchecked, _), _ = self.run_week("Mon, 21 Sep 2026", b"<html>Unexpected Error")
        self.assertEqual((revised, len(unchecked)), ([], 1))

    def test_the_day_it_stopped_is_recorded_and_cleared_if_it_returns(self):
        s = self.surveys["1|2026-02-18|complaint"]
        self.run_week(None, b"", status=404)
        self.assertEqual(s["documents_gone"], {"sod": "2026-10-26"})
        self.run_week(None, b"", status=404)  # still gone: the first date stands
        self.assertEqual(s["documents_gone"], {"sod": "2026-10-26"})
        self.run_week("Mon, 23 Mar 2026", b"%PDF original")
        self.assertNotIn("documents_gone", s)


class DocumentProvenance(unittest.TestCase):
    def test_the_state_url_is_recorded_and_first_seen_wins(self):
        first = "https://www.forwardhealth.wi.gov/kw/dqa/8F3914ENFS.PDF"
        history = [{"survey_type": "SURVEY/VV", "exit_date": "2026-03-12",
                    "docs": {"enforcement": first}}]
        detail = {"licensure_status": "REGULAR", "ownership_type": "", "owner_name": ""}
        roster = {"0013424": {"license": "0013424", "date_closed": ""}}
        facilities, surveys = {}, {}
        with mock.patch.object(fetch, "fetch_detail", return_value=(detail, history)), \
                mock.patch.object(fetch, "archive_pdf",
                                  return_value=("archive/0013424/x.pdf", "Thu, 12 Mar 2026")):
            fetch.fetch_county(None, roster, {"0013424": "k"}, facilities, surveys, "2026-10-07")
            history[0]["docs"]["enforcement"] = "https://www.forwardhealth.wi.gov/kw/dqa/OTHERENFS.PDF"
            fetch.fetch_county(None, roster, {"0013424": "k"}, facilities, surveys, "2026-10-14")
        s = surveys["0013424|2026-03-12|survey-vv"]
        self.assertEqual(s["document_urls"], {"enforcement": first})
        # Dated as archived: that week's revision check needn't download it.
        self.assertEqual(s["documents_last_modified"], {"enforcement": "Thu, 12 Mar 2026"})


class Roster(unittest.TestCase):
    DETAIL = {"licensure_status": "REGULAR", "ownership_type": "", "owner_name": ""}

    def merge(self, facilities, surveys, roster, today, history=()):
        with mock.patch.object(fetch, "fetch_detail", return_value=(self.DETAIL, list(history))):
            fetch.fetch_county(None, roster, {k: "k" for k in roster}, facilities, surveys, today)

    def test_a_closure_is_dated_by_the_run_that_first_saw_it(self):
        facilities = {}
        row = {"license": "1", "date_closed": ""}
        self.merge(facilities, {}, {"1": dict(row)}, "2026-10-07")
        self.merge(facilities, {}, {"1": row | {"date_closed": "2026-09-01"}}, "2026-11-09")
        self.merge(facilities, {}, {"1": row | {"date_closed": "2026-09-01"}}, "2026-11-16")
        self.assertEqual(facilities["1"]["closed_seen"], "2026-11-09")  # backdated: still news

    def test_closed_at_first_capture_is_not_a_closure(self):
        facilities = {}
        self.merge(facilities, {}, {"1": {"license": "1", "date_closed": "2024-10-31"}}, "2026-10-07")
        self.assertNotIn("closed_seen", facilities["1"])

    def test_two_rows_with_one_key_fail_the_run(self):
        row = {"survey_type": "COMPLAINT", "exit_date": "2026-03-12", "docs": {}}
        with self.assertRaises(RuntimeError):
            self.merge({}, {}, {"1": {"license": "1", "date_closed": ""}}, "2026-11-09", [row, row])

    def test_a_closed_facility_may_leave_the_search(self):
        f = {"1": {"name": "A", "county": "PORTAGE", "date_closed": "2024-10-31",
                   "last_seen": "2026-10-26", "on_state_roster": True}}
        self.assertEqual(len(fetch.unlist_vanished(f, "2026-11-02")), 1)
        self.assertEqual((f["1"]["on_state_roster"], f["1"]["unlisted_on"]), (False, "2026-11-02"))

    def test_a_recently_closed_facility_vanishing_fails_the_run(self):
        f = {"1": {"name": "A", "county": "WOOD", "date_closed": "2026-06-01",
                   "last_seen": "2026-10-26", "on_state_roster": True}}
        with self.assertRaises(RuntimeError):
            fetch.unlist_vanished(f, "2026-11-02")
        self.assertTrue(f["1"]["on_state_roster"])  # nothing marked

    # A search that quietly dropped closed facilities would unlist them all.
    def test_many_closed_facilities_at_once_fail_the_run(self):
        f = {str(i): {"name": "A", "county": "WOOD", "date_closed": "2023-01-01",
                      "last_seen": "2026-10-26", "on_state_roster": True}
             for i in range(fetch.UNLIST_LIMIT + 1)}
        with self.assertRaises(RuntimeError):
            fetch.unlist_vanished(f, "2026-11-02")
        self.assertFalse(any("unlisted_on" in x for x in f.values()))

    def test_an_open_facility_vanishing_fails_the_run(self):
        f = {"1": {"name": "A", "county": "WOOD", "date_closed": "",
                   "last_seen": "2026-10-26", "on_state_roster": True}}
        with self.assertRaises(RuntimeError):
            fetch.unlist_vanished(f, "2026-11-02")

    def test_a_blank_export_row_is_skipped_and_a_missing_license_fails(self):
        header = fetch.EXPORT_HEADER
        blank = (None,) * len(header)
        nameless = ("", None, "X HOME") + (None,) * (len(header) - 3)
        for rows, fails in (([header, blank], False), ([header, nameless], True)):
            ws = SimpleNamespace(iter_rows=lambda values_only, rows=rows: iter(rows))
            r = SimpleNamespace(headers={"Content-Type": "spreadsheetml"}, content=b"")
            with mock.patch.object(fetch, "get", return_value=r), \
                    mock.patch.object(fetch.openpyxl, "load_workbook",
                                      return_value=SimpleNamespace(active=ws)):
                if fails:
                    self.assertRaises(RuntimeError, fetch.download_roster, None)
                else:
                    self.assertEqual(fetch.download_roster(None), {})


if __name__ == "__main__":
    unittest.main()
