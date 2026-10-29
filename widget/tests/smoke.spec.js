// What a reader does, checked on every deploy: load, look a facility up,
// follow a story link, use the map, embed it. Runs against the real data,
// so assertions name records that are permanent (the Waterford at Colby's
// revised record) and use "at least" for counts that grow weekly.
import { expect, test } from "@playwright/test";

const WATERFORD = "0015955";

test("loads with no errors", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1, name: "The Care Ledger" })).toBeVisible();
  await expect(page.locator(".rows .row")).toHaveCount(20); // first page of the list
  await expect(page.locator(".stats")).toContainText("in fines assessed");
  await expect(page.getByRole("heading", { name: "The big picture" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("search finds a facility and opens its record", async ({ page }) => {
  await page.goto("./");
  await page.getByLabel("Search facilities").fill("waterford at colby");
  const head = page.locator(`#head-${WATERFORD}`);
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  const panel = page.locator(`#panel-${WATERFORD}`);
  await expect(panel).toContainText("Inspection history");
  await expect(panel).toContainText("Revised by the state");
  await expect(panel.locator(".fact-map svg")).toBeVisible();
  await expect(panel.locator(".nearby li").first()).toBeVisible();
});

// Each link as a reader meets it: a fresh page load from a story. (The
// ?from= query only forces the new document; the ledger ignores it.)
test("story links: #lic, #cat, #county + #view=map", async ({ page }) => {
  await page.goto(`./?from=lic#lic=${WATERFORD}`);
  await expect(page.locator(`#head-${WATERFORD}`)).toHaveAttribute("aria-expanded", "true");

  await page.goto("./?from=cat#cat=medications");
  await expect(page.locator(".result-count")).toContainText("cited for medications");

  await page.goto("./?from=county#county=Wood&view=map");
  await expect(page.getByLabel("County", { exact: true })).toHaveValue("WOOD");
  await expect.poll(() => page.locator(".map-dot").count()).toBeGreaterThan(30);
});

// A second link on a page already open (embed.js forwards a story link
// this way): the hash changes in place and the view must follow it.
test("a new link on an open page replaces the view", async ({ page }) => {
  await page.goto(`./#lic=${WATERFORD}`);
  await expect(page.locator(`#head-${WATERFORD}`)).toHaveAttribute("aria-expanded", "true");
  await page.evaluate(() => (location.hash = "cat=medications"));
  await expect(page.locator(".result-count")).toContainText("cited for medications");
  await expect(page).toHaveURL(/#cat=medications$/);
});

test("map: a dot opens its card, the card opens the record", async ({ page }) => {
  await page.goto("./#view=map");
  // Polled: a bare count() doesn't wait for the data to load (CI is fast).
  await expect.poll(() => page.locator(".map-dot").count()).toBeGreaterThan(200);
  // Dots don't take pointer events; the map finds what's under the click.
  // The map sits below the fold, and the mouse only reaches the viewport.
  await page.locator(".facility-map svg").scrollIntoViewIfNeeded();
  const box = await page.locator(".map-dot").first().boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const card = page.locator(".map-card.is-pinned");
  await expect(card).toBeVisible();
  await card.locator(".map-card-name").first().click();
  await expect(page).toHaveURL(/#lic=/);
  await expect(page.locator(".row.is-open")).toHaveCount(1);
});

test("a chart pick filters the list and returns to it", async ({ page }) => {
  await page.goto("./");
  await page.locator(".county-chart .cites-row").first().click();
  await expect(page.getByLabel("County", { exact: true })).not.toHaveValue("ALL");
  await expect(page.locator(".result-count")).toBeFocused();
});

test("single-facility embed", async ({ page }) => {
  await page.goto("./?facility=15955"); // leading zeros optional
  await expect(page.getByRole("heading", { level: 1 })).toContainText("The Waterford at Colby");
  await expect(page.locator(".row-caret")).toHaveCount(0);
});

test("WordPress embed: sized by embed.js, story link forwarded", async ({ page }) => {
  // A stand-in article page on another origin, as wausaupilotandreview.com
  // would serve it: an iframe and the site-wide script, nothing else.
  // 127.0.0.1 is a different origin from localhost, as the site is from
  // github.io.
  await page.route("http://127.0.0.1:4319/article/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Article</title><p>Story text.</p>
        <iframe class="care-ledger" src="http://localhost:4319/" style="width:100%;border:0" height="1200"></iframe>
        <script src="http://localhost:4319/embed.js" defer></script>`,
    })
  );
  await page.goto(`http://127.0.0.1:4319/article/care-ledger/#lic=${WATERFORD}`);
  const frame = page.frameLocator("iframe");
  await expect(frame.locator(`#head-${WATERFORD}`)).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("iframe")).toHaveAttribute("scrolling", "no"); // embed.js sized it
  const height = await page.locator("iframe").evaluate((f) => parseInt(f.style.height, 10));
  expect(height).toBeGreaterThan(1200);
});

test("no sideways scroll on a small phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  for (const hash of ["", "#view=map", `#lic=${WATERFORD}`]) {
    await page.goto(`./${hash}`);
    await expect(page.locator(".rows, .facility-map").first()).toBeVisible();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(over, `overflow at ${hash || "list"}`).toBeLessThanOrEqual(0);
  }
});

test("static facility page, index, feeds and sitemap", async ({ page, request }) => {
  await page.goto(`./facility/the-waterford-at-colby-${WATERFORD}/`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("The Waterford at Colby");
  await expect(page.locator(".locator svg")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Nearest operating facilities" })).toBeVisible();

  await page.goto("./about/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("How the Care Ledger works");
  await expect(page.getByRole("heading", { name: "Facilities CSV" })).toBeVisible();

  for (const path of ["facility/", "about/", "feed.xml", "feed/marathon.xml", "sitemap.xml"]) {
    const res = await request.get(`./${path}`);
    expect(res.status(), path).toBe(200);
  }
  expect(await (await request.get("./feed.xml")).text()).toContain("<entry>");
});
