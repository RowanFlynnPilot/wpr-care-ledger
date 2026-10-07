"""Regression tests for enrich.py — published dollar figures and citations.

Excerpts are transcribed from real DQA documents in archive/, keeping the
traps the parser must step around: the $200 revisit fee, the statutory
"$10 to $1,000 per day" range, the 35%-reduced amount, and the lowercase
"notice of revocation" boilerplate in every letter's posting paragraph.

Run: python -m unittest discover -s pipeline/tests
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import enrich  # noqa: E402

# archive/0013424/2026-03-12_survey-vv_enforcement.pdf
FORFEITURE_LETTER = """\
NOTICE and ORDER
NOTICE OF VIOLATION
ORDER TO COMPLY WITH REQUIREMENTS
NOTICE OF SPECIAL ORDERS
NOTICE OF IMPOSED FORFEITURE
NOTICE OF RIGHT TO APPEAL
NOTICE OF REVISIT FEE
Re:  Our House Wausau Assisted Care, 0013424
department may impose a $200 inspection fee for an on-site inspection to review compliance of
any other person who violates the applicable statutory provisions or administrative rules
governing CBRFs.  If imposed, the forfeiture amount may not be less than $10 or more than
$1,000 per day for each violation.
Stat. 50.03(5g)(c), IT IS HEREBY ORDERED that a total FORFEITURE OF $400 IS
IMPOSED for the following violations described in SOD #8F3914.
TAG DHS Code Forfeiture Amount
 N 396 83.36(1)(a) $400
Total Forfeiture Due:  $400
At this time, the reduced forfeiture amount due to the Department within ten (10) days of receipt
of this NOTICE and ORDER is $260.
fee of $200 is being assessed.
immediately upon receipt post next to its CBRF license, and in a public area that is visually and
physically available, any citation/statement of deficiency, notice of revocation, notice of non-
renewal, and any other notice of enforcement action.
"""

# archive/0018760/2026-06-30_survey-complaint-vv_enforcement.pdf (orders only)
ORDERS_ONLY_LETTER = """\
NOTICE and ORDER
NOTICE OF VIOLATION
ORDER TO COMPLY WITH REQUIREMENTS
NOTICE OF RIGHT TO APPEAL
NOTICE OF REVISIT FEE
department may impose a $200 inspection fee for an on-site inspection to review compliance of
"""

# archive/0015844/2026-03-11_complaint-self-report_sod.pdf
SOD = """\
STATEMENT OF DEFICIENCIES
AND PLAN OF CORRECTION
 M 000INITIAL COMMENTS  M 000
On 03/10/2026, Surveyor conducted a complaint
and self-report (x3) investigation at A New Visions
AF LLC. Data collection continued through
03/11/2026.
The complaint was substantiated.
The self-reports were closed.
One deficiency was identified.
Census: 2

 M 43688.07(2)(a) SERVICES
The licensee shall provide or arrange
 M 436Continued From page 1 M 436
"""

# archive/0013424/2024-11-26_verification-visit_sod.pdf (repeat violation,
# brace-wrapped tag, wrapped title)
REPEAT_SOD = """\
STATEMENT OF DEFICIENCIES
Two complaints were unsubstantiated.
One deficiency was identified. This deficiency is a
repeat violation.

 {N 617} 83.55(6)(b) Bath and toilet areas: water
temperature
This Rule  is not met as evidenced by:
"""


class Forfeitures(unittest.TestCase):
    def test_total_forfeiture_not_fee_range_or_reduced_amount(self):
        entry, warn = enrich.parse_enforcement(FORFEITURE_LETTER)
        self.assertEqual(entry["fine"], 400)
        self.assertIsNone(warn)

    def test_orders_only_letter_has_no_fine(self):
        entry, warn = enrich.parse_enforcement(ORDERS_ONLY_LETTER)
        self.assertIsNone(entry["fine"])
        self.assertNotIn("Forfeiture", entry["sanctions"])

    def test_boilerplate_revocation_is_not_a_sanction(self):
        entry, _ = enrich.parse_enforcement(FORFEITURE_LETTER)
        self.assertNotIn("Revocation", entry["sanctions"])
        self.assertNotIn("Nonrenewal", entry["sanctions"])
        self.assertEqual(
            entry["sanctions"],
            ["Forfeiture", "Special orders", "Order to comply", "Revisit fee"],
        )


class StatementsOfDeficiency(unittest.TestCase):
    def test_summary_block_and_citation(self):
        entry, warn = enrich.parse_sod(SOD)
        self.assertEqual(entry["census"], 2)
        self.assertEqual(entry["deficiencies"], 1)
        self.assertEqual(entry["complaints_substantiated"], 1)
        self.assertEqual(
            entry["citations"], [{"tag": "M 436", "code": "88.07(2)(a)", "title": "Services"}]
        )
        self.assertIsNone(warn)

    def test_repeat_violation_with_wrapped_title(self):
        entry, warn = enrich.parse_sod(REPEAT_SOD)
        self.assertEqual(entry["complaints_unsubstantiated"], 2)
        self.assertEqual(
            entry["citations"],
            [{"tag": "N 617", "code": "83.55(6)(b)",
              "title": "Bath and toilet areas: water temperature"}],
        )


if __name__ == "__main__":
    unittest.main()
