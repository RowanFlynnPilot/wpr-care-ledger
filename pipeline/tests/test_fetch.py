"""Regression tests for fetch.py's structural guards.

The defining failure of this repo: for 12 weeks, stale detail keys
redirected to the portal's error page, fetch_detail parsed it as a facility
with no history, and every record was published as "no longer shown by the
state" while each run reported success. These tests pin the guards that
make that impossible. Fixtures are real pages saved from the state portal.

Run: python -m unittest discover -s pipeline/tests
"""

import sys
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


if __name__ == "__main__":
    unittest.main()
