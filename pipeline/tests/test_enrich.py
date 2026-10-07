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


# archive/0016344/2023-12-14_complaint-vv_sod.pdf and
# archive/0016894/2024-01-04_survey-complaint_sod.pdf: code suffixes, ALL-CAPS
# titles that wrap, and an ALL-CAPS rule subheading that must NOT be joined.
CAPS_SOD = """\
STATEMENT OF DEFICIENCIES
Two of 8 complaints were substantiated.
Three deficiencies were identified.
U 118 89.23(2)(a)2.c SERVICES
SUFFICIENT SERVICES.
Minimum required services.
M 235 88.04(2)(h) COMPLY WITH OSHA
The licensee and all service providers
M 346 88.05(4)(d)2.b FIRE EVACUATION ANNUAL
EVALUATION
Each resident shall be evaluated
Z 019 50.065(6)(am) Four Year Caregiver Background
Requirement
Every 4 years an entity shall require its caregivers
"""

# archive/0015628/2025-12-10 and archive/0018302/2026-08-25: Title Case wrap,
# the next column's tag glued to a title, and the newer layout's first-page
# index repeating each tag zero-padded and truncated.
LAYOUT_SOD = """\
STATEMENT OF DEFICIENCIES
Both complaints were substantiated.
One repeat deficiency was identifed.
N0283 83.26(1) Documentation Of Required
Employee Training
N0385 83.35(2) Temporary Service Plan
N 386 83.35(3)(a) Comprehensive Individualized
Service Plan
Comprehensive individual service plan.  Scope.
N 489 83.44(2)(a) Rooms clean and free from odors.  N 489
If continuation sheet  13 of 156899STATE FORM V2PA12
N 283 83.26(1) Documentation of required employee
training
"""

# archive/0009226/2026-02-17 and archive/0010689/2023-10-19 headers,
# including the state's own "REQUIRMENTS" typo.
SANCTIONS_LETTER = """\
NOTICE and ORDER
NOTICE OF VIOLATION
ORDER TO COMPLY WITH REQUIRMENTS
ORDER NOT TO ADMIT NEW OR ADDITIONAL RESIDENTS - EXTENDED
NOTICE OF ACCRUING FORFEITURE
NOTICE OF IMPOSED FORFEITURE
Total Forfeiture Due:  $500
"""


class CitationLayouts(unittest.TestCase):
    def citations(self, text):
        return {c["tag"]: (c["code"], c["title"]) for c in enrich.parse_sod(text)[0]["citations"]}

    def test_code_suffixes_and_caps_wrapping(self):
        c = self.citations(CAPS_SOD)
        self.assertEqual(c["U 118"], ("89.23(2)(a)2.c", "Services"))  # subheading not joined
        self.assertEqual(c["M 235"], ("88.04(2)(h)", "Comply with OSHA"))
        self.assertEqual(c["M 346"], ("88.05(4)(d)2.b", "Fire evacuation annual evaluation"))
        self.assertEqual(c["Z 019"], ("50.065(6)(am)", "Four Year Caregiver Background Requirement"))

    def test_title_case_wrap_glued_tag_and_index_duplicates(self):
        c = self.citations(LAYOUT_SOD)
        self.assertEqual(c["N 386"][1], "Comprehensive Individualized Service Plan")
        self.assertEqual(c["N 489"][1], "Rooms clean and free from odors.")
        self.assertEqual(c["N 385"][1], "Temporary Service Plan")
        self.assertEqual(c["N 283"], ("83.26(1)", "Documentation of required employee training"))
        self.assertEqual(sorted(c), ["N 283", "N 385", "N 386", "N 489"])  # index merged, not doubled

    def test_complaint_and_deficiency_counts(self):
        caps, _ = enrich.parse_sod(CAPS_SOD)
        self.assertEqual(caps["complaints_substantiated"], 2)  # "Two of 8", not 8
        self.assertEqual(caps["deficiencies"], 3)
        layout, _ = enrich.parse_sod(LAYOUT_SOD)
        self.assertEqual(layout["complaints_substantiated"], 2)  # "Both"
        self.assertEqual(layout["deficiencies"], 1)  # "One repeat … identifed"


class Sanctions(unittest.TestCase):
    def test_admissions_ban_accruing_forfeiture_and_typo(self):
        entry, warn = enrich.parse_enforcement(SANCTIONS_LETTER)
        self.assertEqual(
            entry["sanctions"],
            ["Admissions ban", "Accruing forfeiture", "Forfeiture", "Order to comply"],
        )
        self.assertEqual(entry["fine"], 500)
        self.assertIsNone(warn)


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
