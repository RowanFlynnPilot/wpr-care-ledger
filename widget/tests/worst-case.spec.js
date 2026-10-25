// The real ledger plus one facility built to break the layout: the
// longest name, operator and address we can imagine, a seven-figure fine,
// every chip at once (enforcement, new, probationary, held, closed), long
// citation titles, no map location. New facilities arrive weekly; the
// first odd one shouldn't be what breaks a phone.
import { expect, test } from "@playwright/test";

const LIC = "9999999";
const NAME =
  "EXTRAORDINARILY-LONG-NAMED ASSISTED LIVING COMMUNITY AND MEMORY CARE RESIDENCE OF NORTH CENTRAL WISCONSIN (THE)";
const ENF = `archive/${LIC}/2026-10-01_complaint-self-report-vv_enforcement.pdf`;
const SOD = `archive/${LIC}/2026-10-01_complaint-self-report-vv_sod.pdf`;
const LONG_TITLE =
  "An extraordinarily long rule title that keeps going well past where any reasonable layout would wrap it twice over";

async function patch(page, file, edit) {
  await page.route(`**/data/${file}`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    edit(json);
    await route.fulfill({ response, json });
  });
}

test.beforeEach(async ({ page }) => {
  let updated = "";
  await patch(page, "surveys.json", (surveys) => {
    updated = Object.values(surveys).reduce((m, s) => (s.last_seen > m ? s.last_seen : m), "");
    const row = (exit, extra) => ({
      license: LIC, survey_type: "COMPLAINT/SELF REPORT/VV", exit_date: exit,
      documents: { enforcement: ENF, sod: SOD }, first_seen: updated, last_seen: updated,
      expired_from_state: false, ...extra,
    });
    surveys[`${LIC}|2026-10-01|complaint-self-report-vv`] = row("2026-10-01", {});
    surveys[`${LIC}|2023-08-01|complaint`] = row("2023-08-01", {
      survey_type: "COMPLAINT", first_seen: "2026-07-12", expired_from_state: true, expired_on: updated,
    });
  });
  await patch(page, "facilities.json", (facilities) => {
    facilities[LIC] = {
      address: "W12345 COUNTY HIGHWAY QQ NORTH FRONTAGE ROAD UNIT 1234567", capacity: "999",
      city: "WISCONSIN RAPIDS", class: "", client_groups: "ADVANCED AGED, IRREVERSIBLE DEMENTIA/ALZHEIMER'S, " .repeat(4),
      corporate_name: "THE INTERNATIONAL CONSORTIUM OF EXTRAORDINARILY LONG-NAMED SENIOR LIVING HOLDINGS LLC",
      county: "WOOD", date_closed: "2026-10-02", date_probationary: "2026-01-02", date_regular: "",
      first_seen: "2026-10-07", last_seen: "2026-10-19", key: "1", license: LIC,
      licensee: "A VERY LONG LICENSEE NAME WITH SEVERAL MIDDLE NAMES", licensure_status: "PROBATIONARY",
      name: NAME, on_state_roster: true, owner_name: "", ownership_type: "Corporation - Non profit",
      phone: "", provider_type: "Community Based Residential Facility", zip: "54494",
    };
  });
  await patch(page, "enrichment.json", (enrichment) => {
    enrichment[ENF] = {
      kind: "enforcement", fine: 1234567,
      sanctions: ["Revocation", "Summary suspension", "Nonrenewal", "Admissions ban", "Admissions ban extended",
        "Accruing forfeiture", "Forfeiture", "Special orders", "Order to comply"],
    };
    enrichment[SOD] = {
      kind: "sod", deficiencies: 99, complaints_substantiated: 12,
      citations: Array.from({ length: 12 }, (_, i) => ({
        tag: `N ${900 + i}`, code: `83.${i}(99)(a)2.c`, title: `${LONG_TITLE} ${i}`,
        category: "Records and administration",
      })),
    };
  });
});

test("a worst-case facility renders whole on a small phone", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setViewportSize({ width: 320, height: 800 });

  await page.goto(`./#lic=${LIC}`);
  const head = page.locator(`#head-${LIC}`);
  await expect(head).toHaveAttribute("aria-expanded", "true");
  const panel = page.locator(`#panel-${LIC}`);
  await expect(panel).toContainText("$1,234,567");
  await expect(panel).toContainText("12 complaints substantiated");
  await expect(panel).toContainText("Order not to admit new residents, extended");
  await expect(panel).toContainText("Held in the ledger");
  await expect(panel).toContainText("Probationary (first-year) license, not a penalty");
  await expect(panel).toContainText("County Highway QQ"); // a lettered county road stays in capitals

  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(over, "sideways scroll with the worst-case record open").toBeLessThanOrEqual(0);

  // No map location: it is named under the map instead of drawn.
  await page.goto("./#county=Wood&view=map");
  await expect(page.locator(".map-unplaced")).toContainText("Extraordinarily");
  const overMap = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overMap, "sideways scroll on the map").toBeLessThanOrEqual(0);

  expect(errors).toEqual([]);
});
