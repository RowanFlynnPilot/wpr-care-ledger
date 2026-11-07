// Accessibility, checked on every deploy: axe-core against WCAG 2.2 AA and
// its best practices, in every state a reader meets — at desktop and phone
// width (both projects). Was a one-time audit (2026-10-19); a regression
// now fails the deploy, and the last good build stays live.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

const STATES = [
  ["the list", "./", ".rows .row"],
  ["an open record", "./#lic=0015955", ".row.is-open .timeline"],
  ["report search results", "./#text=fall", ".report-hit"],
  ["the map", "./#view=map", ".map-dot"],
  ["the single-facility embed", "./?facility=15955", "h1"],
  ["a facility page", "./facility/the-waterford-at-colby-0015955/", "h1"],
  ["the methodology page", "./about/", "h1"],
];

for (const [name, path, ready] of STATES) {
  test(`no accessibility violations: ${name}`, async ({ page }) => {
    await page.goto(path);
    await page.locator(ready).first().waitFor();
    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    // Readable on failure: rule, impact, and the first few offending nodes.
    const found = violations.map(
      (v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`
    );
    expect(found, `${name} at ${path}`).toEqual([]);
  });
}
