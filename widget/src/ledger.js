/* The ledger's vocabulary, formatting and data shaping, shared by the
   widget (App.jsx) and the static facility pages (scripts/facility-pages.mjs)
   so a label, a fine or a document's kind can never differ between them.
   Plain JavaScript: no React, no browser APIs. */

export const SURVEY_PART_LABELS = {
  SURVEY: "Standard survey",
  COMPLAINT: "Complaint investigation",
  VV: "Follow-up visit",
  "VERIFICATION VISIT": "Verification visit",
  "SELF REPORT": "Self-report investigation",
  "DESK REVIEW": "Desk review",
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

export function surveyLabel(raw) {
  return raw
    .split("/")
    .map((p) => SURVEY_PART_LABELS[p.trim()] || titleCase(p.trim()))
    .join(" + ");
}

export function titleCase(s) {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/* Facility and operator names arrive from the state in ALL CAPS. Title-case
   them for print, preserving corporate and licensing acronyms. */
export const KEEP_UPPER = new Set([
  "LLC", "LLP", "INC", "CO", "II", "III", "IV", "AFH", "CBRF", "RCAC",
  "AF", "ALF", "WI", "USA", "SLF", "HCBS",
]);
export const KEEP_LOWER = new Set(["of", "and", "the", "at", "by", "for", "on", "in"]);

export function smartTitle(s) {
  if (!s) return s;
  // The roster files names by their main word: "WATERFORD AT COLBY (THE)"
  // (11 facilities) reads "The Waterford at Colby" in print.
  const filed = s.trim().match(/^(.*?)\s*(?:\(THE\)|,\s*THE)$/i);
  if (filed) s = `The ${filed[1]}`;
  return s
    .trim()
    .split(/\s+/)
    .map((w, i) => {
      const bare = w.replace(/[^A-Za-z0-9]/g, "");
      if (KEEP_UPPER.has(bare.toUpperCase())) return w.toUpperCase();
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

/* AP style, as the newsroom prints dates: "Sept. 21, 2026", "March 27,
   2026" ("long" spells every month: "September 21, 2026"). */
const AP_MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];

export function fmtDate(iso, month = "short") {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return `${(month === "long" ? LONG_MONTHS : AP_MONTHS)[m - 1]} ${d}, ${y}`;
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

export function shape(facilitiesObj, surveysObj, enrichmentObj, waybackObj) {
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
          path,
          // The Internet Archive's copy, fetched from the state's server.
          copy: waybackObj.documents[path],
          // The version the state replaced, kept here only.
          original: path !== original(s, column) ? original(s, column) : null,
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
    return {
      ...f,
      license,
      pageCopy,
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
   $1,000 to $400; deficiencies cited reduced from 4 to 1". Empty when the figures
   the ledger reads didn't move (the wording or a date changed). */
export function revisionChanges(rev) {
  const money = (n) => `$${fmtNum(n || 0)}`;
  const parts = [];
  if ((rev.was.fine || 0) !== (rev.now.fine || 0)) {
    const verb = (rev.now.fine || 0) < (rev.was.fine || 0) ? "reduced" : "raised";
    parts.push(`forfeiture ${verb} from ${money(rev.was.fine)} to ${money(rev.now.fine)}`);
  }
  if (rev.was.deficiencies != null && rev.now.deficiencies != null && rev.was.deficiencies !== rev.now.deficiencies) {
    const verb = rev.now.deficiencies < rev.was.deficiencies ? "reduced" : "raised";
    parts.push(`deficiencies cited ${verb} from ${rev.was.deficiencies} to ${rev.now.deficiencies}`);
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
