/* The ledger's vocabulary, formatting and data shaping, shared by the
   widget (App.jsx) and the static facility pages (scripts/facility-pages.mjs)
   so a label, a fine or a document's kind can never differ between them.
   Plain JavaScript: no React, no browser APIs. */

export const SURVEY_PART_LABELS = {
  SURVEY: "Standard survey",
  COMPLAINT: "Complaint investigation",
  // The state writes the same return visit both ways.
  VV: "Follow-up visit",
  "VERIFICATION VISIT": "Follow-up visit",
  "SELF REPORT": "Self-report investigation",
  "DESK REVIEW": "Desk review",
  OTHER: "Other inspection",
  LICENSURE: "Licensure inspection",
};

export const DOC_LABELS = {
  enforcement: "Enforcement action",
  sod: "Statement of deficiency",
  poc: "Plan of correction",
};

export const TYPE_ABBR = {
  "Adult Family Home": "AFH",
  "Community Based Residential Facility": "CBRF",
  "Residential Care Apartment Complex": "RCAC",
};

export const TYPE_FULL = {
  AFH: "Adult family home",
  CBRF: "Community-based residential facility",
  RCAC: "Residential care apartment complex",
};

/* The ledger refreshes every Monday; past this many days the data is stale
   and readers are told so rather than left to assume it is current. */
export const STALE_AFTER_DAYS = 10;

/* Sanctions worth a reader's eye on the timeline (enrich.py's labels). */
export const SANCTION_LABELS = {
  Revocation: "License revocation",
  "Summary suspension": "Summary suspension",
  Nonrenewal: "License nonrenewal",
  "Admissions ban": "Order not to admit new residents",
  "Admissions ban extended": "Order not to admit new residents, extended",
};

export const DOC_ORDER = ["enforcement", "sod", "poc"];

/* Fixed locale: a German browser would otherwise print "$39.640". */
export function fmtNum(n) {
  return n.toLocaleString("en-US");
}

/* Street-suffix spellings differ between licenses at one address
   ("226446 HUMMINGBIRD RD" / "226446 Hummingbird Road"). */
export const STREET_ABBR = {
  ROAD: "RD", DRIVE: "DR", STREET: "ST", AVENUE: "AVE", LANE: "LN", COURT: "CT",
  BOULEVARD: "BLVD", PLACE: "PL", CIRCLE: "CIR", PARKWAY: "PKWY", HIGHWAY: "HWY",
  TRAIL: "TRL", TERRACE: "TER", NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W",
};

/* "SURVEY/COMPLAINT" -> "Standard survey and complaint investigation". */
export function surveyLabel(raw) {
  return raw
    .split("/")
    .map((p) => SURVEY_PART_LABELS[p.trim().toUpperCase()] || titleCase(p.trim()))
    .map((label, i) => (i ? label.charAt(0).toLowerCase() + label.slice(1) : label))
    .join(" and ");
}

/* AP numbers: one through nine spelled out, 10 and up as figures. */
const SMALL = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
export function apNum(n) {
  return n >= 0 && n < 10 ? SMALL[n] : fmtNum(n);
}

/* "Clark, Langlade and Wood" (AP: no serial comma). */
export function andList(items) {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/* The state's license statuses in words a family reads: a probationary
   license is Wisconsin's first-year license, never a penalty. */
export function statusLabel(status) {
  return (
    { REGULAR: "Regular license", PROBATIONARY: "Probationary (first-year) license, not a penalty", CLOSED: "Closed" }[
      status
    ] || titleCase(status || "")
  );
}

/* The roster's ownership types, tidied: "Corporation - Non profit" ->
   "Nonprofit corporation". */
export function ownershipLabel(type) {
  return (
    {
      "Corporation - Non profit": "Nonprofit corporation",
      "Corporation - Business": "Business corporation",
      "Limited Liability Company": "Limited liability company",
      "Government-County": "County government",
      "Government-State": "State government",
    }[type] ||
    type ||
    "—"
  );
}

/* When a facility was first licensed: the probationary (first-year)
   license comes first; the regular one follows about six months later. */
export function licensedOn(f) {
  return f.date_probationary || f.date_regular || "";
}

export function titleCase(s) {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/* Street addresses, title-cased, except a lettered county highway stays in
   capitals: "950 COUNTY RD QQ" -> "950 County Rd QQ", not "Qq". */
export function addressCase(s) {
  return titleCase(s || "").replace(
    /\b(Hwy|Highway|Rd|Road|Trunk)\s+(?!(?:Apt|Ste|Lot|Box)\b)([A-Za-z]{1,3})\b/g,
    (m, road, letters) => `${road} ${letters.toUpperCase()}`
  );
}

/* Facility and operator names arrive from the state in ALL CAPS. Title-case
   them for print, preserving corporate and licensing acronyms. */
export const KEEP_UPPER = new Set([
  "LLC", "LLP", "CO", "II", "III", "IV", "VI", "VII", "VIII", "AFH", "CBRF", "RCAC", "CSL", "LSS", "NSH",
  "AF", "ALF", "WI", "USA", "SLF", "HCBS", "OSL",
]);
export const KEEP_LOWER = new Set(["of", "and", "the", "at", "by", "for", "on", "in", "or", "to"]);
// Vowel-less abbreviations that are words in an address, not initials.
const STREET_WORDS = new Set(["ST", "RD", "DR", "LN", "CT", "PL", "MT", "FT", "BLDG", "BLVD", "PKWY", "CTR"]);

export function smartTitle(s) {
  if (!s) return s;
  // The roster files names by their main word: "WATERFORD AT COLBY (THE)"
  // (11 facilities) reads "The Waterford at Colby" in print.
  // Also a bare trailing "THE": "COTTAGES MEMORY CARE THE".
  const filed = s.trim().match(/^(.*?)\s*(?:\(THE\)|,\s*THE|\s+THE)$/i);
  if (filed) s = `The ${filed[1]}`;
  return s
    .trim()
    .split(/\s+/)
    .map((w, i) => {
      const bare = w.replace(/[^A-Za-z0-9]/g, "");
      const BARE = bare.toUpperCase();
      if (KEEP_UPPER.has(BARE)) return w.toUpperCase();
      // AP: "Inc.", not "INC".
      if (BARE === "INC") return w.replace(/inc\.?/i, "Inc.");
      // Initials: a short word with no vowels (KSMS, NCHC, TSMM, TC) that
      // isn't a street abbreviation (St, Rd, Bldg); and letters before a
      // number, an identifier (WR1, M311).
      if (/^[A-Z]{2,5}$/.test(BARE) && !/[AEIOUY]/.test(BARE) && !STREET_WORDS.has(BARE)) return w.toUpperCase();
      if (/^[A-Z]{1,3}\d+$/.test(BARE)) return w.toUpperCase();
      // Initials joined by "&" stay capitals: C&K, K&DS, S&C.
      if (/^[A-Za-z]{1,3}&[A-Za-z]{1,3}$/.test(w)) return w.toUpperCase();
      const lower = w.toLowerCase();
      if (i > 0 && KEEP_LOWER.has(bare.toLowerCase())) return lower;
      // Capitalize after hyphens, slashes, parens and "&" — but not
      // apostrophes (Alzheimer's, not Alzheimer'S) — and after Mc
      // (McKinley, McIntire).
      return lower
        .replace(/(^|[-/(&])([a-z])/g, (m, p, c) => p + c.toUpperCase())
        .replace(/^Mc([a-z])(?=[a-z]{2})/, (m, c) => `Mc${c.toUpperCase()}`);
    })
    .join(" ");
}

/* AP style, as the newsroom prints dates, everywhere: "Sept. 21, 2026",
   "March 27, 2026". */
const AP_MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];

export function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return `${AP_MONTHS[m - 1]} ${d}, ${y}`;
}

/* "https://web.archive.org/web/20261015004022/…" -> "2026-10-15" (UTC). */
export function waybackDate(copy) {
  const ts = copy.match(/\/web\/(\d{8})/)[1];
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
}

export function isoUTC(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function isoMinusDays(iso, days) {
  return new Date(isoUTC(iso) - days * 86400e3).toISOString().slice(0, 10);
}

/* Start of the state's three-year public window, as of a given date. */
export function windowStartOf(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const day = m === 2 && d === 29 ? 28 : d;
  return `${y - 3}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function addressKey(f) {
  return `${f.address} ${f.city}`
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .map((w) => STREET_ABBR[w] || w)
    .join("");
}

/* Different rules can share a title (DHS 89 has two "Services" rules), so
   repeats are grouped: "Services ×2 · Tenant rights". */
export function citeSummary(citations) {
  const counts = new Map();
  for (const c of citations) {
    const t = c.title.replace(/[.:]\s*$/, "");
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  const titles = [...counts].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t));
  return titles.slice(0, 3).join(" · ") + (titles.length > 3 ? ` · +${titles.length - 3} more` : "");
}

/* ----------------------------------------------------------------- shaping */

export function shape(facilitiesObj, surveysObj, enrichmentObj, waybackObj, geocodesObj) {
  // Join machine-read document facts onto each survey event. A survey's
  // documents map kind -> archive path; enrichment.json is keyed by that
  // same path. Kinds come from the parsed structure, not the state's grid
  // column (the state has served letters and SODs in swapped columns).
  //
  // A document the state replaced at its address (The Waterford at Colby,
  // 2026-09-21: 4 deficiencies -> 1, $1,000 -> $400) is read from its
  // latest version, so fines and citations match what the state says now;
  // the original stays linked, with what changed.
  const original = (s, column) => s.documents[column];
  const latest = (s, column) => s.revisions?.[column]?.at(-1)?.path || s.documents[column];
  const enrich = (s, pick = latest) => {
    let fine = null;
    let deficiencies = null;
    const sanctions = [];
    const citations = [];
    let substantiated = 0;
    const seen = new Set();
    for (const column of Object.keys(s.documents)) {
      const e = enrichmentObj[pick(s, column)];
      if (!e) continue;
      if (e.fine) fine = (fine || 0) + e.fine;
      if (e.deficiencies != null) deficiencies = (deficiencies || 0) + e.deficiencies;
      for (const label of e.sanctions || []) {
        if (!sanctions.includes(label)) sanctions.push(label);
      }
      substantiated += e.complaints_substantiated || 0;
      for (const c of e.citations || []) {
        const key = c.tag + c.code;
        if (!seen.has(key)) {
          seen.add(key);
          citations.push(c);
        }
      }
    }
    return { fine, deficiencies, sanctions, citations, substantiated };
  };

  // When the state replaced any of a survey's documents: the date its new
  // file carries, and the figures before and after.
  const revisionOf = (s, enr) => {
    const revs = Object.values(s.revisions || {}).map((list) => list.at(-1));
    if (revs.length === 0) return null;
    const was = enrich(s, original);
    const posted = revs
      .map((r) => (r.last_modified ? new Date(r.last_modified).toISOString().slice(0, 10) : r.first_seen))
      .sort()
      .at(-1);
    return {
      posted,
      firstSeen: revs.map((r) => r.first_seen).sort().at(-1),
      was: { fine: was.fine, deficiencies: was.deficiencies },
      now: { fine: enr.fine, deficiencies: enr.deficiencies },
    };
  };

  // Each document's kind comes from its parsed structure where the miner
  // read it; the state's column is only the fallback (plans of correction,
  // which aren't mined). One survey, 0019331, has its two links swapped.
  const docsOf = (s) =>
    Object.keys(s.documents)
      .map((column) => {
        const path = latest(s, column);
        const k = enrichmentObj[path]?.kind;
        return {
          kind: k === "enforcement" || k === "sod" ? k : column,
          // The state's grid column it came from: documents_first_seen and
          // revisions are keyed by it, and it can differ from the kind.
          column,
          path,
          // The Internet Archive's copy, fetched from the state's server.
          copy: waybackObj.documents[path],
          // The version the state replaced, kept here only.
          original: path !== original(s, column) ? original(s, column) : null,
          // The day the state's address stopped serving it (fetch.py), or null.
          gone: s.documents_gone?.[column] || null,
        };
      })
      .sort((a, b) => DOC_ORDER.indexOf(a.kind) - DOC_ORDER.indexOf(b.kind));

  const rawSurveys = Object.values(surveysObj);
  const lastUpdated = rawSurveys.reduce((m, s) => (s.last_seen > m ? s.last_seen : m), "");
  // Each county's first capture is its starting archive, not news (Marathon
  // began 2026-07-12, its eight neighbors 2026-10-07).
  const countyStart = {};
  for (const f of Object.values(facilitiesObj)) {
    const c = f.county;
    if (!countyStart[c] || f.first_seen < countyStart[c]) countyStart[c] = f.first_seen;
  }
  // "New this week": the record, or a document added to it later (a Notice
  // & Order often follows its SOD by weeks), was first seen after the
  // previous weekly run — strictly within 7 days of the latest refresh, so
  // last Monday's run doesn't count and a mid-week rerun doesn't erase the
  // marker. Never a county's first capture, and never while the ledger is
  // stale: then there is no "this week".
  const stale = lastUpdated && (Date.now() - isoUTC(lastUpdated)) / 86400e3 > STALE_AFTER_DAYS;
  const newSince = lastUpdated ? isoMinusDays(lastUpdated, 7) : "";
  // Why a record is new this week: "new" (the survey or a document posted
  // to it), "revised" (only a state revision of an existing document —
  // not a new inspection, and labeled so), or null.
  const newReason = (s) => {
    if (stale) return null;
    const start = countyStart[facilitiesObj[s.license].county];
    const recent = (d) => d && d > start && d > newSince;
    if (recent(s.first_seen) || Object.values(s.documents_first_seen || {}).some(recent)) return "new";
    if (Object.values(s.revisions || {}).some((list) => recent(list.at(-1).first_seen))) return "revised";
    return null;
  };

  const surveysByLicense = {};
  for (const [id, s] of Object.entries(surveysObj)) {
    const docs = docsOf(s);
    const enr = enrich(s);
    const row = {
      ...s,
      id,
      docs,
      hasEnforcement: docs.some((d) => d.kind === "enforcement"),
      enr,
      revision: revisionOf(s, enr),
      newReason: newReason(s),
    };
    row.isNew = Boolean(row.newReason);
    (surveysByLicense[s.license] ||= []).push(row);
  }
  for (const rows of Object.values(surveysByLicense)) {
    rows.sort((a, b) => b.exit_date.localeCompare(a.exit_date));
  }

  const addressGroups = {};
  for (const [lic, f] of Object.entries(facilitiesObj)) {
    (addressGroups[addressKey(f)] ||= []).push(lic);
  }

  const facilities = Object.entries(facilitiesObj).map(([license, f]) => {
    const surveys = surveysByLicense[license] || [];
    const closed = Boolean(f.date_closed) || f.licensure_status === "CLOSED";
    // Latest Internet Archive capture of the state's page: unlike the
    // state link, it survives the weekly key rotation.
    const pageCopy = (waybackObj.pages[license] || []).at(-1)?.copy || "";
    // Where the Census Bureau placed the roster address (geocode.py), or
    // null when it couldn't — the map names those instead of guessing.
    // Only for the address the roster shows now: a facility that moved and
    // hasn't been geocoded again (a Census outage) has no dot, not an old one.
    const g = geocodesObj[license];
    const here = `${f.address}, ${f.city}, WI, ${f.zip}`; // geocode.py address_of()
    const point = g && g.lat != null && g.address === here ? { lat: g.lat, lon: g.lon } : null;
    return {
      ...f,
      license,
      pageCopy,
      point,
      surveys,
      closed,
      probationary: f.licensure_status === "PROBATIONARY",
      typeAbbr: TYPE_ABBR[f.provider_type.trim()] || f.provider_type.trim(),
      enforcementCount: surveys.filter((s) => s.hasEnforcement).length,
      fineTotal: surveys.reduce((n, s) => n + (s.enr.fine || 0), 0),
      heldCount: surveys.filter((s) => s.expired_from_state).length,
      newCount: surveys.filter((s) => s.isNew).length,
      // Citation categories this facility was cited in, for the chart's
      // click-to-filter ("which facilities were cited for medications?").
      categories: new Set(surveys.flatMap((s) => s.enr.citations.map((c) => c.category))),
      // Only revisions are new: the row's chip says "Revised", not "New".
      revisedOnly: surveys.some((s) => s.isNew) && !surveys.some((s) => s.newReason === "new"),
      latest: surveys[0]?.exit_date || "",
      siblings: addressGroups[addressKey(f)].filter((l) => l !== license),
      // The printed name too: "the waterford" must find WATERFORD AT COLBY (THE).
      haystack: [f.name, smartTitle(f.name), f.city, f.corporate_name, f.licensee, license, f.address]
        .join(" ")
        .toLowerCase(),
    };
  });

  const operatorCounts = {};
  for (const f of facilities) {
    if (f.corporate_name) {
      operatorCounts[f.corporate_name] = (operatorCounts[f.corporate_name] || 0) + 1;
    }
  }
  return {
    facilities,
    byLicense: Object.fromEntries(facilities.map((f) => [f.license, f])),
    counties: Object.keys(countyStart).sort(),
    categories: [...new Set(facilities.flatMap((f) => [...f.categories]))].sort(),
    countyStart,
    operatorCounts,
    lastUpdated,
    // Over STALE_AFTER_DAYS since the refresh: no "New this week", and the
    // widget says the ledger is behind. One rule for both.
    stale: Boolean(stale),
  };
}

/* A facility's static page: facility/<name>-<license>/ — the license keeps
   it unique and stable, the name makes it readable. Shared by the widget's
   link and scripts/facility-pages.mjs. */
export function facilitySlug(f) {
  const name = smartTitle(f.name).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-");
  return `${name.replace(/^-|-$/g, "")}-${f.license}`;
}

/* Where "Support this work" goes: the page wausaupilotandreview.com itself
   links as its support page. utm_source lets WPR count what the ledger
   brings in. */
export const SUPPORT_URL =
  "https://wausaupilotandreview.com/support-our-publication/?utm_source=care-ledger&utm_medium=referral";

/* What a state revision changed, in words: "forfeiture reduced from
   $1,000 to $400; deficiencies cited went from 4 to 1". Empty when the figures
   the ledger reads didn't move (the wording or a date changed). */
export function revisionChanges(rev) {
  const money = (n) => `$${fmtNum(n || 0)}`;
  const parts = [];
  if ((rev.was.fine || 0) !== (rev.now.fine || 0)) {
    const verb = (rev.now.fine || 0) < (rev.was.fine || 0) ? "reduced" : "raised";
    parts.push(`forfeiture ${verb} from ${money(rev.was.fine)} to ${money(rev.now.fine)}`);
  }
  if (rev.was.deficiencies != null && rev.now.deficiencies != null && rev.was.deficiencies !== rev.now.deficiencies) {
    parts.push(`deficiencies cited went from ${rev.was.deficiencies} to ${rev.now.deficiencies}`);
  }
  return parts.join("; ");
}

/* A citation category as a story link writes it: "Abuse, neglect and
   incident reporting" -> "abuse-neglect-and-incident-reporting". */
export function catSlug(category) {
  return category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/* The category a #cat= link names: its slug, or the start of one, so
   #cat=abuse and #cat=medications both work. Null when nothing matches. */
export function findCategory(categories, text) {
  const want = catSlug(text);
  if (!want) return null;
  return categories.find((c) => catSlug(c) === want) || categories.find((c) => catSlug(c).startsWith(want)) || null;
}

/* ------------------------------------------------------------------ maps */

/* A Polygon or MultiPolygon as a list of polygons (each a list of rings). */
export const ringsOf = (geometry) => (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates);

/* A map frame fit to the given county outlines (data/basemap.json): width
   fixed, height capped. Equirectangular with longitude shrunk by the
   cosine of the middle latitude — at two degrees across, true enough to
   read distance by. Shared by the widget's map and the facility pages. */
export function mapFrame(features, width, maxHeight, pad = 12) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const f of features)
    for (const poly of ringsOf(f.geometry))
      for (const [lon, lat] of poly[0]) {
        x0 = Math.min(x0, lon); x1 = Math.max(x1, lon);
        y0 = Math.min(y0, lat); y1 = Math.max(y1, lat);
      }
  const k = Math.cos((((y0 + y1) / 2) * Math.PI) / 180);
  const s = Math.min((width - 2 * pad) / ((x1 - x0) * k), (maxHeight - 2 * pad) / (y1 - y0));
  const ox = (width - (x1 - x0) * k * s) / 2;
  return {
    height: Math.ceil((y1 - y0) * s + 2 * pad),
    project: (lon, lat) => [ox + (lon - x0) * k * s, pad + (y1 - lat) * s],
    unproject: (x, y) => [x0 + (x - ox) / (k * s), y1 - (y - pad) / s],
  };
}

/* SVG path data for a county outline in a frame. */
export function outlinePath(geometry, project) {
  return ringsOf(geometry)
    .flatMap((poly) =>
      poly.map((ring) => "M" + ring.map((p) => project(...p).map((v) => v.toFixed(1)).join(",")).join("L") + "Z")
    )
    .join("");
}

/* A small locator: the nine counties, the facility's own shaded, one dot
   (red with an enforcement action on record). Plain SVG markup with its
   colors inline, so a static page and the widget draw it the same. Empty
   when the geocoder couldn't place the facility. */
export function locatorSvg(basemap, f, width = 240) {
  if (!f.point) return "";
  const frame = mapFrame(basemap.counties, width, width, 6);
  const own = (c) => c.properties.county === f.county;
  const paths = [...basemap.counties]
    .sort((a, b) => own(a) - own(b)) // its county last, so no neighbor overdraws the outline
    .map(
      (c) =>
        `<path d="${outlinePath(c.geometry, frame.project)}" fill="${own(c) ? "#e6e6e6" : "#fafafa"}" ` +
        `stroke="${own(c) ? "#777" : "#cfcfcf"}" stroke-width="1" stroke-linejoin="round"/>`
    )
    .join("");
  const [x, y] = frame.project(f.point.lon, f.point.lat).map((v) => v.toFixed(1));
  const color = f.enforcementCount > 0 ? "#b32d2e" : "#3d3d3d";
  const label = `Map: ${smartTitle(f.name)} in ${titleCase(f.county)} County, among the nine counties in the ledger`
    .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${frame.height}" width="${width}" height="${frame.height}" role="img" aria-label="${label}">` +
    paths +
    `<circle cx="${x}" cy="${y}" r="10" fill="none" stroke="${color}" stroke-opacity="0.35" stroke-width="2"/>` +
    `<circle cx="${x}" cy="${y}" r="5" fill="${color}" stroke="#fff" stroke-width="1.5"/>` +
    `</svg>`
  );
}

/* Straight-line miles between two {lat, lon} points (haversine). */
export function milesBetween(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

/* The operating facilities nearest a facility, for a family comparing
   options: up to `n` within `maxMiles`, nearest first, as {f, miles}.
   Licenses at the same address are left out (the record lists them as
   "Also licensed at this address"). Empty without a location. */
export function nearbyOf(facilities, f, n = 5, maxMiles = 15) {
  if (!f.point) return [];
  return facilities
    .filter((o) => o !== f && o.point && !o.closed && !f.siblings.includes(o.license))
    .map((o) => ({ f: o, miles: milesBetween(f.point, o.point) }))
    .filter((x) => x.miles <= maxMiles)
    .sort((a, b) => a.miles - b.miles)
    .slice(0, n);
}

/* How far back the records go for the given counties, in words: "since
   July 12, 2023, in Marathon County and Oct. 7, 2023, in the other eight
   counties" — each county's archive starts at the state's window on its
   first capture. One date for one start: "since Oct. 7, 2023". */
export function sinceArchive(countyStart, counties) {
  const groups = {};
  for (const c of counties) (groups[windowStartOf(countyStart[c])] ||= []).push(c);
  const dates = Object.keys(groups).sort();
  if (dates.length === 1) return `since ${fmtDate(dates[0])}`;
  const all = dates.map((d) => groups[d]);
  return `since ${andList(dates.map((d) => `${fmtDate(d)}, in ${countyGroupLabel(groups[d], all)}`))}`;
}

/* A group of counties that share an archive start, named so a sentence
   listing every group stays true: "Marathon County"; "the other eight
   counties" when it is the only multi-county group; otherwise by name
   ("Clark and Wood counties"). groups: every group, as county arrays. */
export function countyGroupLabel(cs, groups) {
  if (cs.length === 1) return `${titleCase(cs[0])} County`;
  return groups.filter((g) => g.length > 1).length === 1
    ? `the other ${apNum(cs.length)} counties`
    : `${andList([...cs].sort().map(titleCase))} counties`;
}
