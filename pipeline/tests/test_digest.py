"""Tests for the new-enforcement alert: what gets emailed, and what never
gets emailed twice.

Run: python -m unittest discover -s pipeline/tests
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import digest  # noqa: E402

RUN, FIRST_PULL = "2026-10-12", "2026-07-12"


def ledger(surveys, enrichment):
    L = object.__new__(digest.Ledger)
    L.facilities = {
        "1": {"name": "WELLINGTON PLACE AT RIB MOUNTAIN", "city": "WAUSAU",
              "provider_type": "Community Based Residential Facility"},
        "2": {"name": "PINE MEADOWS 3", "city": "SCHOFIELD",
              "provider_type": "Community Based Residential Facility"},
    }
    L.surveys, L.enrichment, L.run, L.first_pull = surveys, enrichment, RUN, FIRST_PULL
    return L


def survey(license, exit_date, first_seen, documents, documents_first_seen=None):
    s = {"license": license, "exit_date": exit_date, "first_seen": first_seen,
         "last_seen": RUN, "survey_type": "COMPLAINT", "documents": documents,
         "expired_from_state": False}
    if documents_first_seen:
        s["documents_first_seen"] = documents_first_seen
    return s


SURVEYS = {
    # New this run, with a letter: alert.
    "1|2026-09-30|complaint": survey("1", "2026-09-30", RUN, {
        "enforcement": "archive/1/a_enforcement.pdf", "sod": "archive/1/a_sod.pdf"}),
    # Seen weeks ago; its letter arrived this run: alert, as late.
    "1|2026-08-25|complaint": survey("1", "2026-08-25", "2026-09-07", {
        "enforcement": "archive/1/b_enforcement.pdf", "sod": "archive/1/b_sod.pdf"},
        {"enforcement": RUN}),
    # The state swapped the columns: the letter sits in the "sod" slot.
    "2|2026-09-15|complaint": survey("2", "2026-09-15", RUN, {
        "enforcement": "archive/2/c_enforcement.pdf", "sod": "archive/2/c_sod.pdf"}),
    # New this run but no letter: never an alert.
    "2|2026-09-20|complaint": survey("2", "2026-09-20", RUN, {"sod": "archive/2/d_sod.pdf"}),
    # Old, letter long known: never an alert.
    "2|2026-05-01|complaint": survey("2", "2026-05-01", "2026-07-12", {
        "enforcement": "archive/2/e_enforcement.pdf"}),
}
ENRICHMENT = {
    "archive/1/a_enforcement.pdf": {"kind": "enforcement", "fine": 1700, "sanctions": []},
    "archive/1/a_sod.pdf": {"kind": "sod", "citations": [], "complaints_substantiated": 1},
    "archive/1/b_enforcement.pdf": {"kind": "enforcement", "fine": None, "sanctions": []},
    "archive/1/b_sod.pdf": {"kind": "sod", "citations": []},
    "archive/2/c_enforcement.pdf": {"kind": "sod", "citations": []},
    "archive/2/c_sod.pdf": {"kind": "enforcement", "fine": 650,
                            "sanctions": ["Admissions ban", "Accruing forfeiture"]},
    "archive/2/d_sod.pdf": {"kind": "sod", "citations": []},
    "archive/2/e_enforcement.pdf": {"kind": "enforcement", "fine": 400, "sanctions": []},
}


class Selection(unittest.TestCase):
    def test_new_late_and_swapped_letters_are_alerted_nothing_else(self):
        items = ledger(SURVEYS, ENRICHMENT).new_enforcement()
        got = {(sid, path, late) for sid, _, path, late in items}
        self.assertEqual(got, {
            ("1|2026-09-30|complaint", "archive/1/a_enforcement.pdf", False),
            ("1|2026-08-25|complaint", "archive/1/b_enforcement.pdf", True),
            ("2|2026-09-15|complaint", "archive/2/c_sod.pdf", False),
        })

    def test_initial_pull_never_alerts(self):
        L = ledger(SURVEYS, ENRICHMENT)
        L.first_pull = RUN
        late_only = [it for it in L.new_enforcement() if not it[3]]
        self.assertEqual(late_only, [])


class Message(unittest.TestCase):
    def test_subject_counts_facilities_and_body_flags_serious_orders(self):
        L = ledger(SURVEYS, ENRICHMENT)
        title, body = digest.compose(L, L.new_enforcement(), digest.ITEM_MARK, test=False)
        self.assertTrue(title.startswith("3 new enforcement actions at 2 facilities:"))
        self.assertIn("Order not to admit new residents", body)
        self.assertIn("$650 (accruing", body)
        self.assertIn("posted after the survey first appeared", body)
        self.assertIn("#lic=1", body)


class NoDuplicateEmail(unittest.TestCase):
    def test_already_alerted_actions_are_not_sent_again(self):
        L = ledger(SURVEYS, ENRICHMENT)
        sent_before = f"<!-- {digest.ITEM_MARK} 1|2026-09-30|complaint -->"
        created = []

        def fake_gh(*args, stdin=None):
            if args[:2] == ("issue", "create"):
                created.append((args, stdin))
            return sent_before if args[:2] == ("issue", "list") else "https://x/issues/9\n"

        with mock.patch.object(digest, "gh", side_effect=fake_gh):
            digest.alert(L)
        self.assertEqual(len(created), 1)
        args, body = created[0]
        self.assertIn("2 new enforcement actions", args[3])  # the --title value
        self.assertNotIn("1|2026-09-30|complaint", body)

    def test_nothing_new_means_no_issue(self):
        L = ledger(SURVEYS, ENRICHMENT)
        everything = "\n".join(f"<!-- {digest.ITEM_MARK} {sid} -->" for sid in SURVEYS)
        with mock.patch.object(digest, "gh", return_value=everything) as gh:
            digest.alert(L)
        self.assertFalse(any(c.args[:2] == ("issue", "create") for c in gh.call_args_list))


if __name__ == "__main__":
    unittest.main()
