// How state names print. pipeline/tests/test_digest.py pins the same
// cases for digest.py's smart_title(), which builds the tip sheet's text
// and links: the two must never drift apart (they had: digest.py lacked
// four of these capitals until 2026-10-28).
import { expect, test } from "@playwright/test";
import { smartTitle } from "../src/ledger.js";

export const CASES = [
  ["WATERFORD AT COLBY (THE)", "The Waterford at Colby"],
  ["COTTAGES MEMORY CARE THE", "The Cottages Memory Care"],
  ["KSMS OUR HOUSE LLC", "KSMS Our House LLC"],
  ["NCHC ADULT CRISIS STABILIZATION FACILITY", "NCHC Adult Crisis Stabilization Facility"],
  ["BEST PLACE TO BE INC WR2", "Best Place to Be Inc. WR2"],
  ["ST JOSEPH RESIDENCE INC", "St Joseph Residence Inc."],
  ["PAISERS OAKHAVEN S&C LLC BLDG II", "Paisers Oakhaven S&C LLC Bldg II"],
  ["TERRA OR DARRIN SCHNEIDER", "Terra or Darrin Schneider"],
  ["OSL SP Operating LLC", "OSL SP Operating LLC"],
  ["ALZHEIMER'S CARE CENTER OF MCKINLEY", "Alzheimer's Care Center of McKinley"],
];

test("state names print as the ledger means them", () => {
  for (const [raw, printed] of CASES) expect(smartTitle(raw), raw).toBe(printed);
});
