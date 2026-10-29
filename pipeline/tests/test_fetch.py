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
            rel = fetch.archive_pdf(None, "u", "0013424", "2026-08-05", "COMPLAINT/VV", "sod")
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

    def run_week(self, modified, body, status=200):
        session = SimpleNamespace(head=lambda url, timeout: SimpleNamespace(
            status_code=status, headers={"Last-Modified": modified}))
        # Quiet: a fake "REVISED" line in CI logs reads like a real one.
        with mock.patch.object(fetch, "get", return_value=SimpleNamespace(content=body)) as get, \
                contextlib.redirect_stdout(io.StringIO()):
            out = fetch.check_revisions(session, self.surveys, "2026-10-26")
        return out, get.call_count

    def test_a_replaced_document_is_archived_beside_the_original(self):
        s = self.surveys["1|2026-02-18|complaint"]
        (revised, gone), downloads = self.run_week("Mon, 23 Mar 2026", b"%PDF original")
        self.assertEqual((revised, downloads), ([], 1))  # baseline: downloaded once, unchanged
        (revised, _), downloads = self.run_week("Mon, 23 Mar 2026", b"%PDF original")
        self.assertEqual(downloads, 0)  # same Last-Modified: no download at all
        (revised, _), _ = self.run_week("Mon, 21 Sep 2026", b"%PDF reissued")
        self.assertEqual(len(revised), 1)
        rev = "archive/1/2026-02-18_complaint_rev2_sod.pdf"
        self.assertEqual(s["revisions"]["sod"], [
            {"path": rev, "first_seen": "2026-10-26", "last_modified": "Mon, 21 Sep 2026"}])
        self.assertEqual((self.root / rev).read_bytes(), b"%PDF reissued")
        self.assertEqual((self.root / s["documents"]["sod"]).read_bytes(), b"%PDF original")
        self.assertEqual(fetch.current_path(s, "sod"), rev)
        # A new date on identical bytes is not a revision.
        (revised, _), _ = self.run_week("Tue, 22 Sep 2026", b"%PDF reissued")
        self.assertEqual(revised, [])
        self.assertEqual(len(s["revisions"]["sod"]), 1)

    def test_a_document_the_state_stops_serving_is_reported(self):
        (revised, gone), downloads = self.run_week(None, b"", status=404)
        self.assertEqual((revised, downloads, len(gone)), ([], 0, 1))

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
        roster = {"0013424": {"license": "0013424"}}
        facilities, surveys = {}, {}
        with mock.patch.object(fetch, "fetch_detail", return_value=(detail, history)), \
                mock.patch.object(fetch, "archive_pdf", return_value="archive/0013424/x.pdf"):
            fetch.fetch_county(None, roster, {"0013424": "k"}, facilities, surveys, "2026-10-07")
            history[0]["docs"]["enforcement"] = "https://www.forwardhealth.wi.gov/kw/dqa/OTHERENFS.PDF"
            fetch.fetch_county(None, roster, {"0013424": "k"}, facilities, surveys, "2026-10-14")
        self.assertEqual(surveys["0013424|2026-03-12|survey-vv"]["document_urls"],
                         {"enforcement": first})


if __name__ == "__main__":
    unittest.main()
