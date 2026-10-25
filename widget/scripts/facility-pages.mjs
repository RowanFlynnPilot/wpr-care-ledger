// Static page per facility, for search engines and sharing: the widget is
// one script-built page, invisible to someone searching a facility's name.
// Runs after `vite build` (postbuild) and writes into dist/:
//   facility/<name>-<license>/index.html   one record, plain HTML
//   facility/index.html                    every facility, by county
//   sitemap.xml
// Labels, fines and document kinds come from src/ledger.js — the widget's
// own shape() — so a page can never disagree with the ledger.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOC_LABELS, SANCTION_LABELS, SUPPORT_URL, TYPE_FULL, revisionChanges, citeSummary, facilitySlug as slug, fmtDate, fmtNum, locatorSvg, nearbyOf, shape,
  smartTitle, surveyLabel, titleCase, waybackDate, windowStartOf, apNum, licensedOn, statusLabel,
} from "../src/ledger.js";

// The published address. Change here if the ledger moves to a custom domain.
const SITE = "https://rowanflynnpilot.github.io/wpr-care-ledger/";

const widget = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(widget, "dist");
const read = (name) => JSON.parse(readFileSync(join(widget, "..", "data", name), "utf8"));
const db = shape(read("facilities.json"), read("surveys.json"), read("enrichment.json"), read("wayback.json"), read("geocodes.json"));
const basemap = read("basemap.json");

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const plural = (n, one, many) => `${fmtNum(n)} ${n === 1 ? one : many}`;

// Self-hosted brand faces, as Vite emitted them (names are content-hashed).
const assets = readdirSync(join(dist, "assets"));
const font = (prefix) => assets.find((a) => a.startsWith(prefix) && a.endsWith(".woff2"));
const faces = [
  ["Oswald", font("oswald-latin-wght-normal"), "200 700"],
  ["Merriweather", font("merriweather-latin-400-normal"), "400"],
  ["Merriweather", font("merriweather-latin-700-normal"), "700"],
]
  .filter(([, file]) => file)
  .map(([family, file, weight]) =>
    `@font-face{font-family:"${family}";src:url(../../assets/${file}) format("woff2");font-weight:${weight};font-display:swap}`)
  .join("");

const css = `${faces}
:root{--ink:#111;--soft:#444;--muted:#6c6c6c;--teal:#2a655d;--red:#b32d2e;--sepia:#7d582f;--sepia-wash:#f1e8d8;--line:#e0e0e0}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font:15px/1.65 Merriweather,Georgia,serif}
main{max-width:860px;margin:0 auto;padding:20px 16px 40px}
a{color:var(--teal)}
.flag{display:flex;align-items:center;gap:12px;padding-bottom:10px}
.flag img.seal{width:44px;height:44px}.flag .wm{height:17px;width:auto;display:block}
.flag p{margin:4px 0 0;font:700 15px/1.2 Oswald,"Helvetica Neue",Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase}
.flag p a{color:inherit;text-decoration:none}
.flag a{display:inline-block;padding:4px 0}
.rule{border-top:4px solid var(--ink);border-bottom:1px solid var(--ink);height:3px;margin-bottom:18px}
h1{font:700 clamp(26px,5vw,38px)/1.08 Oswald,"Helvetica Neue",Arial,sans-serif;text-transform:uppercase;letter-spacing:.01em;margin:0 0 6px}
h2{font:700 12px/1.3 Oswald,"Helvetica Neue",Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;border-bottom:1px solid var(--ink);padding-bottom:6px;margin:28px 0 12px}
.meta,.mono{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12.5px;color:var(--muted)}
.lede{font-size:16px;margin:14px 0}
.open{display:inline-block;font:600 13px/1 Oswald,"Helvetica Neue",Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;background:var(--ink);color:#fff;padding:10px 14px;text-decoration:none}
dl.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px 24px;margin:0}
dl.facts dt{font:600 10.5px/1.4 Oswald,"Helvetica Neue",Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
dl.facts dd{margin:0}
ol.timeline{list-style:none;margin:0;padding:0}
ol.timeline li{display:grid;grid-template-columns:110px 1fr;gap:4px 16px;padding:12px 0;border-bottom:1px solid var(--line)}
ol.timeline li.held{border-left:3px solid var(--sepia);padding-left:10px;background:linear-gradient(90deg,var(--sepia-wash),transparent 70%)}
.type{font:600 15px/1.35 Oswald,"Helvetica Neue",Arial,sans-serif}
.fine,.sanction,.enf{color:var(--red);font-weight:700}
.held-note{color:var(--sepia);font-size:13px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.revised{font-size:13px;color:var(--soft);border-left:2px dashed var(--ink);padding-left:8px;margin:4px 0}
.cites{font-size:13px;color:var(--soft)}
ul.near{margin:0;padding-left:18px}ul.near li{margin:4px 0}
.locator{margin:18px 0 0}.locator svg{display:block;max-width:100%;height:auto}.locator figcaption{margin-top:4px}
.docs{font-size:13px}.docs a{display:inline-block;padding:4px 0;margin-right:12px}
footer{margin-top:32px;border-top:1px solid var(--ink);padding-top:12px;font-size:12.5px;color:var(--soft)}
footer a.support{font-weight:700}
@media (max-width:560px){ol.timeline li{grid-template-columns:1fr}}`;

// Atom feeds of enforcement actions: the ledger's and each county's, so a
// reader or a newsroom can follow new ones without email or a server.
const LEDGER_FEED = { path: "feed.xml", title: "The Care Ledger: new enforcement actions" };
const countyFeed = (county) => ({
  path: `feed/${county.toLowerCase()}.xml`,
  title: `The Care Ledger: new enforcement actions in ${titleCase(county)} County`,
});

function page({ title, description, path, body, feed }) {
  const url = SITE + path;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Wausau Pilot &amp; Review">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${SITE}og-card.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="../../brand/wpr-typewriter-32.png">
${feed ? `<link rel="alternate" type="application/atom+xml" title="${esc(feed.title)}" href="${esc(SITE + feed.path)}">` : ""}
<style>${css}</style>
</head>
<body>
<main>
<header class="flag">
  <img class="seal" src="../../brand/wpr-seal-88.webp" alt="" width="44" height="44">
  <div>
    <a href="https://wausaupilotandreview.com/"><img class="wm" src="../../brand/wpr-wordmark-266.webp" alt="Wausau Pilot &amp; Review" width="133" height="17"></a>
    <p><a href="${SITE}">The Care Ledger</a></p>
  </div>
</header>
<div class="rule"></div>
${body}
<footer>
  <p>Records from the Wisconsin Department of Health Services Division of Quality Assurance, which shows only three years of inspection history. The Care Ledger checks the state's records every Monday and keeps them after the state stops showing them. Updated ${esc(fmtDate(db.lastUpdated))}. Not affiliated with or endorsed by DHS. Questions or corrections: <a href="mailto:editor@wausaupilotandreview.com">editor@wausaupilotandreview.com</a>.</p>
  <p>The Care Ledger is free, with no paywall, because readers support Wausau Pilot &amp; Review's reporting. <a class="support" href="${esc(SUPPORT_URL)}">Support this work</a></p>
  <p><a href="https://wausaupilotandreview.com/">Wausau Pilot &amp; Review</a> · 715-301-5539</p>
</footer>
</main>
</body>
</html>
`;
}

function facilityPage(f) {
  const name = smartTitle(f.name);
  const city = titleCase(f.city);
  const county = titleCase(f.county);
  const type = TYPE_FULL[f.typeAbbr] || f.typeAbbr;
  // Dated from when the county's archive begins, not the first record:
  // "since" a facility's first inspection would imply nothing came before.
  const since = fmtDate(windowStartOf(db.countyStart[f.county]));
  const record = f.surveys.length
    ? `${plural(f.surveys.length, "state inspection", "state inspections")} and ` +
      (f.enforcementCount
        ? plural(f.enforcementCount, "enforcement action", "enforcement actions")
        : "no enforcement actions") +
      (f.fineTotal ? ` ($${fmtNum(f.fineTotal)} in fines assessed)` : "") +
      ` on record since ${since}`
    : `no state inspection records since ${since}` +
      (licensedOn(f) ? ` (licensed ${fmtDate(licensedOn(f))})` : "");
  const article = /^[aeiou]/i.test(type) ? "an" : "a";
  const description = `${name}, ${article} ${type.toLowerCase()} in ${city}, ${county} County, Wisconsin: ${record}. Every report and enforcement letter, kept by Wausau Pilot & Review.`;

  const surveys = f.surveys
    .map((s) => {
      const sanctions = s.enr.sanctions.filter((x) => SANCTION_LABELS[x]).map((x) => SANCTION_LABELS[x]);
      const docs = s.docs
        .map((d) =>
          `<a href="../../${esc(d.path)}">${esc(DOC_LABELS[d.kind])} (PDF)</a>` +
          (d.copy ? `<a class="mono" href="${esc(d.copy)}">archive.org copy<span class="sr"> of the ${esc(DOC_LABELS[d.kind].toLowerCase())}</span></a>` : ""))
        .join("");
      return `<li${s.expired_from_state ? ' class="held"' : ""}>
  <span class="mono">${esc(fmtDate(s.exit_date))}</span>
  <div>
    <div class="type">${esc(surveyLabel(s.survey_type))}${s.enr.fine ? ` <span class="fine">$${fmtNum(s.enr.fine)} forfeiture${s.enr.sanctions.includes("Accruing forfeiture") ? " (accruing)" : ""}</span>` : ""}</div>
    ${sanctions.length ? `<div class="sanction">${esc(sanctions.join(" · "))}</div>` : ""}
    ${s.enr.substantiated || s.enr.citations.length ? `<div class="cites">${s.enr.substantiated ? `<strong>${s.enr.substantiated === 1 ? "Complaint substantiated" : `${apNum(s.enr.substantiated)} complaints substantiated`}</strong>` : ""}${s.enr.substantiated && s.enr.citations.length ? " · " : ""}${s.enr.citations.length ? `Cited: ${esc(citeSummary(s.enr.citations))}` : ""}</div>` : ""}
    ${s.expired_from_state ? `<div class="held-note">Held in the ledger — no longer listed in the state's Provider Search; last listed ${esc(fmtDate(s.last_seen))}.</div>` : ""}
    ${s.revision ? `<div class="revised"><strong>Revised by the state</strong>: the state replaced ${s.docs.filter((d) => d.original).length > 1 ? "these documents" : "this document"} on its site on ${esc(fmtDate(s.revision.posted))}${revisionChanges(s.revision) ? `: ${esc(revisionChanges(s.revision))}` : ""}. Figures shown are from the current version. Originals, kept here: ${s.docs.filter((d) => d.original).map((d) => `<a href="../../${esc(d.original)}">original ${esc(DOC_LABELS[d.kind].toLowerCase())} (PDF)</a>`).join(" · ")}</div>` : ""}
    ${docs ? `<div class="docs">${docs}</div>` : ""}
  </div>
</li>`;
    })
    .join("\n");

  const facts = [
    ["Facility type", type],
    ["Address", `${titleCase(f.address)}, ${city} ${f.zip}`],
    ["County", county],
    ["License", f.license],
    ["Status", statusLabel(f.licensure_status)],
    ["Operator", f.corporate_name ? smartTitle(f.corporate_name) : "—"],
    ["Capacity", f.capacity ? `${f.capacity} beds` : "—"],
    ...(licensedOn(f) ? [["Licensed", fmtDate(licensedOn(f))]] : []),
    ...(f.date_closed ? [["Closed", fmtDate(f.date_closed)]] : []),
  ]
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
    .join("");

  return page({
    title: `${name} (${city}) inspection and enforcement records | The Care Ledger`,
    description,
    path: `facility/${slug(f)}/`,
    feed: countyFeed(f.county),
    body: `<article>
<h1>${esc(name)}</h1>
<p class="meta">${esc(f.typeAbbr)} · ${esc(city)}, ${esc(county)} County · license ${esc(f.license)}${f.closed ? " · closed" : ""}</p>
<p class="lede">${esc(name)} has ${esc(record)}${f.heldCount ? `, including ${plural(f.heldCount, "record", "records")} the state no longer lists` : ""}.</p>
<p><a class="open" href="${SITE}#lic=${esc(f.license)}">Open in the interactive Care Ledger</a></p>
<h2>Facility</h2>
<dl class="facts">${facts}</dl>
${f.point ? `<figure class="locator">${locatorSvg(basemap, f, 260)}<figcaption class="mono">${esc(county)} County, among the nine counties in the ledger. Location from the state roster's address, placed by the U.S. Census Bureau's geocoder.</figcaption></figure>` : ""}
${f.pageCopy ? `<p class="mono">State's page for this facility, <a href="${esc(f.pageCopy)}">as archived ${esc(fmtDate(waybackDate(f.pageCopy)))}</a> by the Internet Archive.</p>` : ""}
${nearbyList(f)}
<h2>Inspection history</h2>
${surveys ? `<ol class="timeline">\n${surveys}\n</ol>` : `<p>No inspection records since ${esc(since)}.</p>`}
<p class="mono"><a href="../">All ${db.facilities.length} facilities</a></p>
</article>`,
  });
}

// The nearest operating facilities, linked: for a family comparing
// options, and so every facility page leads to its neighbors.
function nearbyList(f) {
  const near = nearbyOf(db.facilities, f);
  if (!near.length) return "";
  const items = near
    .map(({ f: o, miles }) =>
      `<li><a href="../${slug(o)}/">${esc(smartTitle(o.name))}</a> <span class="meta">${esc(titleCase(o.city))} · ${miles.toFixed(1)} miles${o.enforcementCount ? ` · <span class="enf">${plural(o.enforcementCount, "enforcement action", "enforcement actions")}</span>` : ""}</span></li>`)
    .join("\n");
  return `<h2>Nearest operating facilities</h2>
<ul class="near">
${items}
</ul>
<p class="mono">Straight-line distance, within 15 miles.</p>`;
}

function indexPage() {
  const byCounty = {};
  for (const f of db.facilities) (byCounty[f.county] ||= []).push(f);
  const sections = Object.keys(byCounty)
    .sort()
    .map((c) => {
      const items = byCounty[c]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((f) =>
          `<li><a href="${slug(f)}/">${esc(smartTitle(f.name))}</a> <span class="meta">${esc(titleCase(f.city))}${f.enforcementCount ? ` · <span class="enf">${plural(f.enforcementCount, "enforcement action", "enforcement actions")}</span>` : ""}${f.closed ? " · closed" : ""}</span></li>`)
        .join("\n");
      return `<h2>${esc(titleCase(c))} County</h2>\n<ul>\n${items}\n</ul>`;
    })
    .join("\n");
  const html = page({
    title: "Assisted living facilities in central Wisconsin: inspection records | The Care Ledger",
    description: `State inspection and enforcement records for ${db.facilities.length} assisted living facilities in Marathon County and the eight counties around it, kept by Wausau Pilot & Review.`,
    path: "facility/",
    feed: LEDGER_FEED,
    body: `<h1>Every facility in The Care Ledger</h1>
<p class="lede">Every inspection report and enforcement letter since 2023 for the ${db.facilities.length} state-regulated assisted living facilities in ${apNum(db.counties.length)} central Wisconsin counties. <a href="${SITE}">Search them in the interactive ledger</a>.</p>
<p class="mono">Follow new enforcement actions by RSS: <a href="${SITE}${LEDGER_FEED.path}">all ${apNum(db.counties.length)} counties</a> · ${db.counties.map((c) => `<a href="${SITE}${countyFeed(c).path}">${esc(titleCase(c))}</a>`).join(" · ")}</p>
${sections}`,
  });
  // One level shallower than a facility page: fix the relative asset paths.
  return html.replaceAll("../../", "../");
}

let written = 0;
for (const f of db.facilities) {
  const dir = join(dist, "facility", slug(f));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), facilityPage(f));
  written++;
}
writeFileSync(join(dist, "facility", "index.html"), indexPage());

// The ledger described as a schema.org Dataset on its main page, for
// Google Dataset Search, where researchers and reporters look for public
// records data. Written at build time so dateModified is the data's own.
const earliest = db.counties.map((c) => windowStartOf(db.countyStart[c])).sort()[0];
const dataset = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "The Care Ledger: Wisconsin assisted living inspection and enforcement records",
  description:
    `Every state inspection report, enforcement letter and plan of correction for the ${db.facilities.length} ` +
    `state-regulated assisted living facilities in Marathon, Clark, Langlade, Lincoln, Portage, Shawano, Taylor, ` +
    `Waupaca and Wood counties, Wisconsin, archived weekly from the Wisconsin Department of Health Services ` +
    `Division of Quality Assurance and kept after the state's three-year Provider Search window drops them.`,
  url: SITE,
  sameAs: "https://github.com/RowanFlynnPilot/wpr-care-ledger",
  creator: { "@type": "NewsMediaOrganization", name: "Wausau Pilot & Review", url: "https://wausaupilotandreview.com/" },
  isAccessibleForFree: true,
  temporalCoverage: `${earliest}/..`,
  spatialCoverage: { "@type": "Place", name: "Marathon County and eight neighboring counties, Wisconsin, USA" },
  dateModified: db.lastUpdated,
  distribution: ["facilities", "surveys", "enrichment"].map((name) => ({
    "@type": "DataDownload",
    encodingFormat: "application/json",
    contentUrl: `${SITE}data/${name}.json`,
  })),
};
const indexPath = join(dist, "index.html");
writeFileSync(
  indexPath,
  readFileSync(indexPath, "utf8").replace(
    "</head>",
    `<link rel="canonical" href="${SITE}" />\n` +
      `<link rel="alternate" type="application/atom+xml" title="${LEDGER_FEED.title}" href="${SITE}${LEDGER_FEED.path}" />\n` +
      `<script type="application/ld+json">${JSON.stringify(dataset).replace(/</g, "\\u003c")}</script>\n</head>`
  )
);

// Every enforcement action, dated by when the ledger first saw its letter
// (a Notice and Order often posts weeks after its inspection's report), so
// each week's new ones lead the feed. A county's first capture brought in
// its history at once; those keep that date, newest inspections first.
const actions = db.facilities
  .flatMap((f) =>
    f.surveys
      .filter((s) => s.hasEnforcement)
      .map((s) => {
        const letter = s.docs.find((d) => d.kind === "enforcement");
        return { f, s, letter, found: s.documents_first_seen?.[letter.column] || s.first_seen };
      })
  )
  .sort((a, b) => b.found.localeCompare(a.found) || b.s.exit_date.localeCompare(a.s.exit_date));

function atom(feed, items) {
  const stamp = (d) => `${d}T12:00:00Z`;
  const entries = items.slice(0, 50).map(({ f, s, letter, found }) => {
    const name = smartTitle(f.name);
    const fine = s.enr.fine
      ? `$${fmtNum(s.enr.fine)} forfeiture${s.enr.sanctions.includes("Accruing forfeiture") ? " (accruing)" : ""}`
      : "";
    const sanctions = s.enr.sanctions.filter((x) => SANCTION_LABELS[x]).map((x) => SANCTION_LABELS[x]);
    const summary = [
      `${surveyLabel(s.survey_type)} ended ${fmtDate(s.exit_date)}, ${titleCase(f.city)}, ${titleCase(f.county)} County.`,
      fine && `Assessed: ${fine}.`,
      sanctions.length && `${sanctions.join("; ")}.`,
      s.enr.citations.length && `Cited: ${citeSummary(s.enr.citations)}.`,
      `Enforcement letter: ${SITE}${letter.path}`,
    ]
      .filter(Boolean)
      .join(" ");
    return `<entry>
  <title>${esc(`${name}: enforcement action${fine ? `, ${fine}` : ""}`)}</title>
  <link href="${esc(`${SITE}facility/${slug(f)}/`)}"/>
  <id>${esc(`tag:rowanflynnpilot.github.io,2026:care-ledger/${s.id.replaceAll("|", "/")}`)}</id>
  <published>${stamp(found)}</published>
  <updated>${stamp(found)}</updated>
  <summary type="text">${esc(summary)}</summary>
</entry>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>${esc(feed.title)}</title>
<subtitle>State enforcement actions against assisted living facilities, as Wausau Pilot &amp; Review's Care Ledger finds them each week.</subtitle>
<link rel="self" href="${esc(SITE + feed.path)}"/>
<link href="${esc(SITE)}"/>
<id>${esc(SITE + feed.path)}</id>
<updated>${stamp(items[0]?.found || db.lastUpdated)}</updated>
<author><name>Wausau Pilot &amp; Review</name><uri>https://wausaupilotandreview.com/</uri></author>
${entries.join("\n")}
</feed>
`;
}

writeFileSync(join(dist, LEDGER_FEED.path), atom(LEDGER_FEED, actions));
mkdirSync(join(dist, "feed"), { recursive: true });
for (const c of db.counties) {
  writeFileSync(join(dist, countyFeed(c).path), atom(countyFeed(c), actions.filter((a) => a.f.county === c)));
}

const urls = [SITE, `${SITE}facility/`, ...db.facilities.map((f) => `${SITE}facility/${slug(f)}/`)];
writeFileSync(
  join(dist, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${esc(u)}</loc><lastmod>${db.lastUpdated}</lastmod></url>`).join("\n") +
    "\n</urlset>\n"
);
console.log(`wrote ${written} facility pages, the facility index, and sitemap.xml (${urls.length} URLs)`);
