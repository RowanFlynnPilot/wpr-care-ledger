import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DOC_LABELS,
  SUPPORT_URL,
  catSlug,
  findCategory,
  revisionChanges,
  facilitySlug,
  TYPE_FULL,
  STALE_AFTER_DAYS,
  SANCTION_LABELS,
  fmtNum,
  surveyLabel,
  titleCase,
  smartTitle,
  fmtDate,
  waybackDate,
  isoUTC,
  isoMinusDays,
  windowStartOf,
  citeSummary,
  addressCase,
  andList,
  apNum,
  licensedOn,
  ownershipLabel,
  sinceArchive,
  statusLabel,
  locatorSvg,
  nearbyOf,
  mapFrame,
  outlinePath,
  shape,
} from "./ledger.js";

/* ------------------------------------------------------------- vocabulary */

const STATE_DETAIL_URL =
  "https://www.forwardhealth.wi.gov/WIPortal/Subsystem/Public/DqaProviderDetails.aspx";

/* Lenses: one-click slices of the ledger. Labels in display order. */
const LENS_TEST = {
  all: () => true,
  enforcement: (f) => f.enforcementCount > 0,
  held: (f) => f.heldCount > 0,
  new: (f) => f.newCount > 0,
};
const LENS_LABELS = {
  all: "All facilities",
  enforcement: "Enforcement actions",
  held: "Held in the ledger",
  new: "New this week",
};

/* Inside the WordPress iframe the page has no scroller of its own, and
   scrolling into view would yank the reader's article instead. */
const EMBEDDED = window.parent !== window;

/* Facility rows shown before "Show more": enough to browse, short enough
   that an embedded ledger doesn't bury the rest of the article. */
const PAGE = 20;
// ?facility=<license>: one facility's record alone, for a story about it.
const FACILITY = new URLSearchParams(window.location.search).get("facility");
// The full ledger, for links out of the single-facility view.
const LEDGER_URL = `${window.location.origin}${window.location.pathname}`;
// The site page this frame sits on, when embed.js says so (a page of the
// ledger's own on wausaupilotandreview.com, or an article): "Copy link to
// this record" then gives readers that page, which embed.js opens on the
// record. Null standalone, or before embed.js has spoken.
let hostUrl = null;

/* The terms the ledger prints, in plain English, grouped as a reader meets
   them. Labels match SURVEY_PART_LABELS, DOC_LABELS and SANCTION_LABELS. */
const GLOSSARY = [
  ["Inspections", [
    ["Survey", "An inspection by the state Division of Quality Assurance. The date shown is the exit date, the last day inspectors were on site."],
    ["Standard survey", "A routine licensing inspection of the whole facility."],
    ["Complaint investigation", "An inspection prompted by a complaint from a resident, family member, employee or anyone else."],
    ["Self-report investigation", "An inspection of an incident the facility itself reported to the state, as it is required to."],
    ["Follow-up visit", "A return inspection to check whether the facility fixed what it was cited for. The state also calls it a verification visit."],
    ["Desk review", "A review of records the state does without visiting."],
    ["Substantiated complaint", "Inspectors found evidence that what the complaint described happened."],
  ]],
  ["Documents", [
    ["Statement of deficiency", "The state's report of an inspection: each rule the facility was found to break, with the evidence."],
    ["Citation", "One rule cited in a statement of deficiency. Categories such as Medications group the rules by subject."],
    ["Plan of correction", "The facility's written response, describing how it will fix each problem cited."],
    ["Enforcement action", "A Notice and Order letter in which the state imposes penalties or orders after an inspection."],
  ]],
  ["Enforcement", [
    ["Forfeiture", "A fine. The ledger shows the amount assessed; a facility that pays within 10 days and doesn't appeal may pay a reduced amount."],
    ["Accruing forfeiture", "A fine that grows each day until the facility complies. The ledger shows the amount assessed so far."],
    ["Order to comply", "An order to correct the violations cited."],
    ["Order not to admit new residents", "A ban on taking new residents until the state lifts it — among the most serious steps short of closing a facility. When a later letter keeps an earlier ban in place, the ledger labels it \"extended.\""],
    ["License revocation", "The state moving to take away the facility's license. A facility can appeal."],
    ["Revisit fee", "A fee the facility pays for the inspection that checks its corrections."],
  ]],
  ["Facilities and licenses", [
    ["Adult family home (AFH)", "A home where three or four adults not related to the operator live and receive care. The ledger covers these three- or four-bed homes."],
    ["Community-based residential facility (CBRF)", "A residence for five or more adults that provides care and supervision, including limited nursing care."],
    ["Residential care apartment complex (RCAC)", "Independent apartments for five or more residents, with limited personal, supportive and nursing services."],
    ["Probationary license", "The license Wisconsin issues for a facility's first year. It is not a penalty."],
    ["Held in the ledger", "A record the state's online search no longer lists, usually because it is more than three years old. The Care Ledger keeps it."],
    ["Revised by the state", "The state replaced a document on its site with a new version. The ledger shows the new version's figures and keeps the original, with what changed."],
    ["archive.org copy", "A copy of the state's own document or page captured by the Internet Archive, a nonprofit library, so anyone can check it independently."],
  ]],
];

function Glossary() {
  return (
    <details className="glossary" id="glossary">
      {/* Its own h2, so its group h3s don't land under "Facilities". */}
      <summary><h2 className="glossary-title">What these terms mean</h2></summary>
      <div className="glossary-groups">
        {GLOSSARY.map(([group, terms]) => (
          <section key={group}>
            <h3>{group}</h3>
            <dl>
              {terms.map(([term, def]) => (
                <div key={term}>
                  <dt>{term}</dt>
                  <dd>{def}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </details>
  );
}

/* Newspaper highlighter: mark the search match inside a displayed name. */
function Highlight({ text, q }) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/* CSV for reporters: RFC 4180 quoting, a BOM so Excel reads UTF-8, and a
   leading apostrophe on any cell a spreadsheet would run as a formula. */
function downloadCsv(filename, header, rows) {
  const cell = (v) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿", text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const yesNo = (b) => (b ? "yes" : "no");
const absolute = (path) => new URL(path, document.baseURI).href;

function facilitiesCsv(list, filename) {
  const record = `${location.origin}${location.pathname}#lic=`;
  downloadCsv(
    filename,
    ["license", "facility", "type", "address", "city", "zip", "county", "latitude", "longitude", "license_status",
     "closed", "date_closed", "operator", "licensee", "capacity", "inspections",
     "enforcement_actions", "fines_assessed", "records_no_longer_listed_by_state",
     "latest_inspection", "ledger_record", "facility_page", "state_page_archived"],
    list.map((f) => [
      f.license, f.name, TYPE_FULL[f.typeAbbr], f.address, f.city, f.zip, f.county,
      // Blank where the Census geocoder couldn't place the address.
      f.point?.lat ?? "", f.point?.lon ?? "", f.licensure_status, yesNo(f.closed), f.date_closed, f.corporate_name, f.licensee,
      f.capacity, f.surveys.length, f.enforcementCount, f.fineTotal, f.heldCount,
      f.latest, record + f.license, `${LEDGER_URL}facility/${facilitySlug(f)}/`, f.pageCopy,
    ])
  );
}

function surveysCsv(list, filename) {
  const rows = [];
  for (const f of list) {
    for (const s of f.surveys) {
      rows.push([
        f.license, f.name, f.county, s.exit_date, s.survey_type, yesNo(s.hasEnforcement),
        s.enr.fine ?? "", yesNo(s.enr.sanctions.includes("Accruing forfeiture")),
        s.enr.sanctions.join("; "), s.enr.substantiated || "",
        [...new Set(s.enr.citations.map((c) => c.category))].join("; "),
        s.enr.citations.map((c) => `${c.code} ${c.title}`).join("; "),
        yesNo(s.expired_from_state), s.expired_from_state ? s.last_seen : "",
        s.docs.map((d) => `${DOC_LABELS[d.kind]}: ${absolute(d.path)}`).join(" | "),
        s.docs.filter((d) => d.copy).map((d) => d.copy).join(" | "),
        s.revision ? s.revision.posted : "",
        s.revision ? s.revision.was.fine ?? "" : "",
      ]);
    }
  }
  downloadCsv(
    filename,
    ["license", "facility", "county", "exit_date", "survey_type", "enforcement_action",
     "fine_assessed", "fine_accruing", "sanctions", "complaints_substantiated",
     "citation_categories", "cited_rules", "no_longer_listed_by_state", "state_last_listed",
     "documents", "archive_org_copies", "revised_by_state_on", "original_fine"],
    rows
  );
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // a stray "%" in a hand-typed link must not blank the widget
  }
}

function quarterOf(iso) {
  const [y, m] = iso.split("-").map(Number);
  return { y, q: Math.floor((m - 1) / 3) + 1 };
}

function bucketQuarters(surveys) {
  const dated = surveys.filter((s) => s.exit_date);
  if (dated.length === 0) return { quarters: [], max: 0 };
  const dates = dated.map((s) => s.exit_date).sort();
  const first = quarterOf(dates[0]);
  const last = quarterOf(dates[dates.length - 1]);
  const quarters = [];
  for (
    let y = first.y, q = first.q;
    y < last.y || (y === last.y && q <= last.q);
    q === 4 ? ((q = 1), y++) : q++
  ) {
    quarters.push({ y, q, total: 0, enforcement: 0, held: 0 });
  }
  const at = Object.fromEntries(quarters.map((b) => [`${b.y}-${b.q}`, b]));
  for (const s of dated) {
    const k = quarterOf(s.exit_date);
    const b = at[`${k.y}-${k.q}`];
    b.total += 1;
    if (s.hasEnforcement) b.enforcement += 1;
    if (s.expired_from_state) b.held += 1;
  }
  return { quarters, max: Math.max(...quarters.map((b) => b.total)) };
}

/* ------------------------------------------------------------------- app */

export default function App() {
  const [db, setDb] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("ALL");
  const [county, setCounty] = useState("ALL");
  const [sort, setSort] = useState("name");
  const [showClosed, setShowClosed] = useState(false);
  const [lens, setLens] = useState("all");
  // A citation category picked in "What inspectors cite": the list shows
  // the facilities cited in it.
  const [category, setCategory] = useState(null);
  const [open, setOpen] = useState(null);
  // The facilities in view as a list or on the map.
  const [view, setView] = useState("list");
  // A facility to show on the map, set by a record's "Show on the map".
  const [mapFocus, setMapFocus] = useState(null);
  // Rows rendered: the first PAGE, then more on request. All 279 at once
  // made the embedded frame ~30,000px tall — a reader had to scroll past
  // every facility to reach the rest of the article.
  const [shown, setShown] = useState(PAGE);

  const searchRef = useRef(null);
  const briefRef = useRef(null);
  const openRef = useRef(null);
  openRef.current = open;

  // Move keyboard focus to a facility's header once React has rendered it.
  const focusHeader = (license) =>
    requestAnimationFrame(() => document.getElementById(`head-${license}`)?.focus());

  const load = useCallback(() => {
    setError(null);
    Promise.all(
      [
        "data/facilities.json",
        "data/surveys.json",
        "data/enrichment.json",
        "data/wayback.json",
        "data/geocodes.json",
        "data/basemap.json",
      ].map(
        (p) =>
          fetch(p).then((r) => {
            if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
            return r.json();
          })
      )
    )
      .then(([facilities, surveys, enrichment, wayback, geocodes, basemap]) =>
        setDb({ ...shape(facilities, surveys, enrichment, wayback, geocodes), basemap })
      )
      .catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  // Newsroom keyboard ergonomics: "/" focuses search, Escape closes the
  // open record — neither fires while typing in a field.
  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape" && !typing && openRef.current) {
        // Closing makes the panel inert; focus would be stranded inside it.
        const lic = openRef.current;
        setOpen(null);
        focusHeader(lic);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Report content height to the WordPress page embedding this widget so
  // the iframe can grow and shrink with searches and expanded rows. Measure
  // the app root, not documentElement.scrollHeight — that never drops below
  // the iframe's current height, so the frame could grow but never shrink.
  useEffect(() => {
    if (!EMBEDDED) return;
    const root = document.getElementById("root");
    const post = () =>
      window.parent.postMessage(
        { type: "wpr-care-ledger:height", height: Math.ceil(root.getBoundingClientRect().height) },
        "*"
      );
    const ro = new ResizeObserver(post);
    ro.observe(root);
    post();
    // embed.js, installed site-wide, may load after this frame first
    // reported; it asks every ledger frame to measure again.
    const onAsk = (e) => {
      if (e.source !== window.parent || !e.data) return;
      if (e.data.type === "wpr-care-ledger:measure") post();
      if (e.data.type === "wpr-care-ledger:host" && /^https?:\/\/[^\s#]+$/.test(e.data.url)) hostUrl = e.data.url;
    };
    window.addEventListener("message", onAsk);
    return () => {
      ro.disconnect();
      window.removeEventListener("message", onAsk);
    };
  }, []);

  // Deep links: #lic=0015628 opens one facility (closed included so links
  // to closed licenses always resolve); #q=text presets the search box;
  // #county=Wood opens on one county; #cat=medications lists the facilities
  // cited in a category (the start of its name is enough: #cat=abuse).
  // #view=map opens on the map. county, cat, q and view combine with "&"
  // (#county=Wood&cat=medications&view=map).
  // Applied at load and on later hash changes (replaceState below doesn't
  // fire hashchange, so reflecting the open row can't loop back here).
  useEffect(() => {
    if (!db) return;
    // On a hashchange, read the address the event was fired for (newURL),
    // not the current one: the URL sync below can rewrite the address back
    // to the old view between the link and its event, and the link would
    // be lost (it was, in CI; tests/smoke.spec.js reproduces it).
    const apply = (e) => {
      const hash = e?.newURL ? new URL(e.newURL).hash : window.location.hash;
      const p = {};
      for (const part of hash.slice(1).split("&")) {
        const i = part.indexOf("=");
        if (i > 0) p[part.slice(0, i)] = safeDecode(part.slice(i + 1).replace(/\+/g, " "));
      }
      const lic = /^[0-9A-Za-z]+$/.test(p.lic || "") ? p.lic : null;
      if (!lic && !p.q && !p.county && !p.cat && !p.view) return;
      setLens("all");
      setType("ALL");
      setCounty((p.county && db.counties.find((x) => x === p.county.toUpperCase())) || "ALL");
      const cat = p.cat ? findCategory(db.categories, p.cat) : null;
      setCategory(cat);
      if (cat) setShowClosed(true); // the chart counts closed facilities too
      if (lic) {
        // An unknown license (or one missing its leading zeros) becomes a
        // search, so the reader sees a match or an honest "no match".
        setShowClosed(true);
        setQuery(lic);
        setView("list");
        if (db.byLicense[lic]) {
          setOpen(lic);
          if (!EMBEDDED) {
            setTimeout(() => {
              document
                .getElementById(`panel-${lic}`)
                ?.scrollIntoView({ block: "nearest", behavior: "auto" });
            }, 120);
          }
        }
      } else {
        setQuery(p.q || "");
        setView(p.view === "map" ? "map" : "list");
        // A record opened by an earlier link would stay open behind the new
        // view, and keep the address on its #lic=.
        setOpen(null);
      }
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [db]);

  // Keep the standalone URL shareable: the open record, else the county,
  // category and search in view.
  useEffect(() => {
    if (!db) return;
    const q = query.trim();
    const parts = open
      ? [`lic=${open}`]
      : [
          county !== "ALL" && `county=${titleCase(county)}`,
          category && `cat=${catSlug(category)}`,
          q && `q=${encodeURIComponent(q)}`,
          view === "map" && "view=map",
        ].filter(Boolean);
    window.history.replaceState(
      null,
      "",
      parts.length ? `#${parts.join("&")}` : window.location.pathname + window.location.search
    );
  }, [open, query, county, category, view, db]);

  // The county filter scopes everything: stats, chart, list. The rest of
  // the narrowing (search, type, closed toggle, lens) applies to the list.
  const scoped = useMemo(
    () => (!db ? [] : county === "ALL" ? db.facilities : db.facilities.filter((f) => f.county === county)),
    [db, county]
  );
  const stats = useMemo(() => statsFor(scoped), [scoped]);
  const scopedSurveys = useMemo(() => scoped.flatMap((f) => f.surveys), [scoped]);
  const coverage = useMemo(
    () =>
      !db
        ? []
        : db.counties
            .filter((c) => county === "ALL" || c === county)
            .map((c) => ({ county: c, start: windowStartOf(db.countyStart[c]) })),
    [db, county]
  );

  // Search, type, and the closed toggle narrow everything; a lens then picks
  // a slice. Lens counts are computed under the same narrowing so each
  // button says exactly how many rows it will show.
  const { list, lensCounts } = useMemo(() => {
    if (!db) return { list: [], lensCounts: {} };
    const q = query.trim().toLowerCase();
    const base = scoped.filter(
      (f) =>
        (showClosed || !f.closed) &&
        (type === "ALL" || f.typeAbbr === type) &&
        (!q || f.haystack.includes(q)) &&
        (!category || f.categories.has(category))
    );
    const lensCounts = Object.fromEntries(
      Object.entries(LENS_TEST).map(([id, test]) => [id, base.filter(test).length])
    );
    const bySort = {
      name: (a, b) => a.name.localeCompare(b.name),
      recent: (a, b) => (b.latest || "").localeCompare(a.latest || ""),
      enforcement: (a, b) =>
        b.enforcementCount - a.enforcementCount || a.name.localeCompare(b.name),
      fines: (a, b) => b.fineTotal - a.fineTotal || a.name.localeCompare(b.name),
    };
    return { list: base.filter(LENS_TEST[lens]).sort(bySort[sort]), lensCounts };
  }, [db, scoped, query, type, sort, showClosed, lens, category]);

  // A new search, filter or sort starts from the top of its results.
  useEffect(() => setShown(PAGE), [query, type, sort, showClosed, lens, county, category]);
  const showMore = (all) => {
    const next = list[shown];
    setShown(all ? list.length : shown + PAGE);
    if (next) focusHeader(next.license); // keyboard users land on the first new row
  };

  // When the search is exactly an operator's corporate name (the operator
  // cross-link does this), lead the results with an operator brief.
  const operatorBrief = useMemo(() => {
    if (!db) return null;
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const name = Object.keys(db.operatorCounts).find(
      (n) => n.toLowerCase() === q
    );
    if (!name || db.operatorCounts[name] < 2) return null;
    const group = db.facilities.filter((f) => f.corporate_name === name);
    return {
      name,
      count: group.length,
      operating: group.filter((f) => !f.closed).length,
      enforcement: group.reduce((n, f) => n + f.enforcementCount, 0),
      fines: group.reduce((n, f) => n + f.fineTotal, 0),
    };
  }, [db, query]);

  // The "Show them" and "Clear" buttons remove themselves when clicked;
  // hand keyboard focus to the result count (which announces the new
  // number) instead of letting it fall to the top of the page.
  const countRef = useRef(null);
  const thenFocusCount = (change) => {
    change();
    requestAnimationFrame(() => countRef.current?.focus());
  };

  // Download filenames name the county in view, so two files don't collide.
  const csvScope = county === "ALL" ? "all-counties" : county.toLowerCase();

  // A dead-end search may only be hiding closed facilities — offer them.
  const hiddenClosedMatches = useMemo(() => {
    if (!db || showClosed) return 0;
    const q = query.trim().toLowerCase();
    return scoped.filter(
      (f) =>
        f.closed &&
        LENS_TEST[lens](f) &&
        (type === "ALL" || f.typeAbbr === type) &&
        (!q || f.haystack.includes(q))
    ).length;
  }, [db, scoped, query, type, lens, showClosed]);

  if (error)
    return (
      <div className="ledger">
        <p className="load-error">
          The ledger data didn&rsquo;t load ({error}).{" "}
          <button className="clear-filters" onClick={load}>
            Try again
          </button>
        </p>
      </div>
    );
  if (!db)
    return (
      <div className="ledger loading">
        <img src="brand/wpr-seal-168.webp" alt="" width="52" height="52" />
        <span>Opening the ledger…</span>
      </div>
    );

  const revealRow = (license) => {
    setOpen(license);
    focusHeader(license);
    if (EMBEDDED) return;
    setTimeout(() => {
      document.getElementById(`panel-${license}`)?.scrollIntoView({
        block: "nearest",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    }, 80);
  };

  // Every filter that could hide the target is reset, or the link opens a
  // record nobody can see.
  const crossLink = (license) => {
    setShowClosed(true);
    setLens("all");
    setCategory(null);
    setType("ALL");
    setCounty("ALL");
    setQuery(license);
    setView("list");
    revealRow(license);
  };

  // From a record to its dot: the facility's county on the map, nothing
  // narrowed away, its card open. The record closes, so focus moves to
  // the card (FacilityMap) instead of being stranded in an inert panel.
  const showOnMap = (f) => {
    setShowClosed(true);
    setLens("all");
    setCategory(null);
    setType("ALL");
    setQuery("");
    setCounty(f.county);
    setOpen(null);
    setView("map");
    setMapFocus(f.license);
    if (!EMBEDDED)
      requestAnimationFrame(() =>
        document.querySelector(".facility-map")?.scrollIntoView({ block: "start", behavior: "auto" })
      );
  };

  // Operators run facilities across county lines; show all of them.
  const showOperator = (name) => {
    setShowClosed(true);
    setLens("all");
    setCategory(null);
    setType("ALL");
    setCounty("ALL");
    setQuery(name);
    setView("list");
    setOpen(null);
    requestAnimationFrame(() => briefRef.current?.focus());
  };

  const clearFilters = () => {
    setQuery("");
    setType("ALL");
    setCounty("ALL");
    setLens("all");
    setCategory(null);
    setShowClosed(false);
    setOpen(null);
    setView("list");
  };

  // Headline stats count everything on record, closed facilities included,
  // so clicking one shows everything it counted.
  const showLensFromStat = (id) => {
    setQuery("");
    setType("ALL");
    setCategory(null);
    setShowClosed(true);
    setLens(lens === id ? "all" : id);
    setOpen(null);
  };

  // The charts sit below the list, so a pick in one changes what's above
  // it: bring the reader back up to the result count, which announces the
  // new number. Embedded too — this scroll answers the reader's own click,
  // unlike the deep-link scrolls an embed skips.
  const backToList = () =>
    requestAnimationFrame(() => {
      countRef.current?.scrollIntoView({
        block: "start",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
      countRef.current?.focus({ preventScroll: true });
    });

  // The chart counts every facility in the county view, closed included,
  // so picking a category resets the narrowing to make the list match it.
  const pickCategory = (cat) => {
    const next = category === cat ? null : cat;
    setCategory(next);
    setQuery("");
    setType("ALL");
    setLens("all");
    setShowClosed(true);
    setOpen(null);
    backToList();
  };

  // A county row in the chart sets the county filter (again to clear).
  const pickCounty = (c) => {
    setCounty(county === c ? "ALL" : c);
    setOpen(null);
    backToList();
  };

  const staleDays = Math.floor(
    (Date.now() - isoUTC(db.lastUpdated)) / 86400e3
  );

  if (FACILITY) return <FacilityEmbed db={db} license={FACILITY} staleDays={staleDays} />;

  return (
    <div className="ledger">
      <header className="masthead">
        <img
          className="badge"
          src="brand/wpr-seal-168.webp"
          alt=""
          width="84"
          height="84"
        />
        <div className="masthead-text">
          <a
            className="wordmark-link"
            href="https://wausaupilotandreview.com/"
            target="_blank"
            rel="noopener noreferrer"
          >
            <img
              className="wordmark"
              src="brand/wpr-wordmark-266.webp"
              alt="Wausau Pilot &amp; Review"
              width="133"
              height="17"
            />
          </a>
          <h1>The Care Ledger</h1>
          <p className="dek">
            Inspection and enforcement records since 2023 for every
            state-regulated assisted living facility in Marathon County and the
            eight counties around it — kept after Wisconsin stops showing them.
          </p>
          <p className="fresh">Updated {fmtDate(db.lastUpdated)}</p>
        </div>
      </header>
      <div className="flag-rule" />

      <main>
      {staleDays > STALE_AFTER_DAYS && (
        <p className="stale-notice" role="note">
          <strong>This ledger is behind.</strong> It was last refreshed{" "}
          {fmtDate(db.lastUpdated)}. Records the state has posted
          since then may not appear here yet.
        </p>
      )}

      <dl className="stats" aria-label="Ledger totals">
        <Stat n={stats.openFacilities} label="facilities operating" />
        {stats.finesTotal > 0 ? (
          <Stat
            n={`$${fmtNum(stats.finesTotal)}`}
            label="in fines assessed"
            tone="fine"
          />
        ) : (
          <Stat n={stats.surveyEvents} label="inspections on record" />
        )}
        <Stat
          n={stats.withEnforcement}
          label="facilities with enforcement actions"
          action="Show facilities with enforcement actions"
          pressed={lens === "enforcement"}
          onClick={() => showLensFromStat("enforcement")}
        />
        {stats.held > 0 ? (
          <Stat
            n={stats.held}
            label="records the state no longer lists"
            tone="held"
            action="Show facilities with records the state no longer lists"
            pressed={lens === "held"}
            onClick={() => showLensFromStat("held")}
          />
        ) : (
          <Stat n={stats.documents} label="documents archived" />
        )}
      </dl>

      <div className="controls">
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder="Name, city, operator or license"
          aria-label="Search facilities"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={county} aria-label="County" onChange={(e) => setCounty(e.target.value)}>
          <option value="ALL">All counties</option>
          {db.counties.map((c) => (
            <option key={c} value={c}>
              {titleCase(c)} County
            </option>
          ))}
        </select>
        <select value={type} aria-label="Facility type" onChange={(e) => setType(e.target.value)}>
          <option value="ALL">All types</option>
          <option value="CBRF">Community-based residential facility (CBRF)</option>
          <option value="RCAC">Residential care apartment complex (RCAC)</option>
          <option value="AFH">Adult family home (AFH)</option>
        </select>
        <select value={sort} aria-label="Sort order" onChange={(e) => setSort(e.target.value)}>
          <option value="name">A to Z</option>
          <option value="recent">Latest activity</option>
          <option value="enforcement">Most enforcement</option>
          <option value="fines">Largest fines</option>
        </select>
        <label className="closed-toggle">
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(e) => setShowClosed(e.target.checked)}
          />
          Include closed
        </label>
      </div>

      <div className="lenses" role="group" aria-label="Show">
        {Object.keys(LENS_TEST)
          .filter(
            (id) =>
              id === lens ||
              ((id !== "held" || stats.held > 0) && (id !== "new" || stats.newRecords > 0))
          )
          .map((id) => (
            <button
              key={id}
              type="button"
              className={`lens lens-${id}`}
              aria-pressed={lens === id}
              onClick={() => setLens(id)}
            >
              {LENS_LABELS[id]}
              <span className="lens-count">{lensCounts[id]}</span>
            </button>
          ))}
      </div>

      {operatorBrief && (
        <aside className="operator-brief" ref={briefRef} tabIndex={-1}>
          <p className="op-kicker">Operator</p>
          <p className="op-name">{smartTitle(operatorBrief.name)}</p>
          <p className="op-stats">
            {operatorBrief.count} facilities in this ledger
            {operatorBrief.operating < operatorBrief.count &&
              ` (${operatorBrief.operating} operating)`}{" "}
            · {operatorBrief.enforcement} enforcement{" "}
            {operatorBrief.enforcement === 1 ? "action" : "actions"}
            {operatorBrief.fines > 0 && (
              <>
                {" "}
                · <strong>${fmtNum(operatorBrief.fines)} assessed</strong>
              </>
            )}
          </p>
        </aside>
      )}

      <h2 className="sr-only">Facilities</h2>
      <div className="result-bar">
        <p className="result-count" role="status" tabIndex={-1} ref={countRef}>
          {list.length} {list.length === 1 ? "facility" : "facilities"}
          {category && (
            <>
              {" "}
              cited for {category.toLowerCase()}{" "}
              <button className="clear-category" onClick={() => thenFocusCount(() => setCategory(null))}>
                Show all<span className="sr-only"> facilities</span>
              </button>
            </>
          )}
        </p>
        <div className="view-toggle" role="group" aria-label="View">
          {[
            ["list", "List"],
            ["map", "Map"],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              onClick={() => {
                setView(id);
                // The map hides the list: a record left open would keep the
                // address on its #lic= and catch Escape out of sight.
                if (id === "map") setOpen(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {list.length > 0 && (
          <p className="downloads">
            Download as CSV:{" "}
            <button
              className="download"
              onClick={() =>
                facilitiesCsv(list, `care-ledger-facilities-${csvScope}-${db.lastUpdated}.csv`)
              }
            >
              {list.length === 1 ? "facility" : "facilities"}
            </button>
            {" · "}
            <button
              className="download"
              onClick={() =>
                surveysCsv(list, `care-ledger-surveys-${csvScope}-${db.lastUpdated}.csv`)
              }
            >
              survey records
            </button>
            <span className="downloads-note">
              {" "}
              · Excel drops license numbers&rsquo; leading zeros unless the column is imported as text
            </span>
          </p>
        )}
      </div>

      {view === "map" && list.length > 0 && (
        <FacilityMap
          facilities={list}
          basemap={db.basemap}
          county={county}
          focus={mapFocus}
          onFocused={() => setMapFocus(null)}
          onOpen={crossLink}
          onPickCounty={setCounty}
        />
      )}

      <ol className="rows">
        {view === "list" && list.slice(0, shown).map((f) => (
          <FacilityRow
            key={f.license}
            f={f}
            db={db}
            query={query.trim()}
            open={open === f.license}
            onToggle={() => setOpen(open === f.license ? null : f.license)}
            onCrossLink={crossLink}
            onOperator={showOperator}
            onShowOnMap={showOnMap}
          />
        ))}
        {view === "list" && list.length > shown && (
          <li className="more-row">
            <button className="show-more" onClick={() => showMore(false)}>
              Show {Math.min(PAGE, list.length - shown)} more
            </button>
            <span className="more-count">
              {fmtNum(list.length - shown)} of {fmtNum(list.length)} not yet shown ·{" "}
              <button className="clear-filters" onClick={() => showMore(true)}>
                show all
              </button>
            </span>
          </li>
        )}
        {list.length > 0 && hiddenClosedMatches > 0 && (
          <li className="closed-hint">
            {hiddenClosedMatches} closed{" "}
            {hiddenClosedMatches === 1 ? "facility also matches" : "facilities also match"}.{" "}
            <button className="clear-filters" onClick={() => thenFocusCount(() => setShowClosed(true))}>
              Show {hiddenClosedMatches === 1 ? "it" : "them"}
            </button>
          </li>
        )}
        {list.length === 0 && (
          <li className="empty">
            No facilities match.{" "}
            {hiddenClosedMatches > 0 ? (
              <button
                className="clear-filters"
                onClick={() => thenFocusCount(() => setShowClosed(true))}
              >
                Show {hiddenClosedMatches} closed{" "}
                {hiddenClosedMatches === 1 ? "facility" : "facilities"} that{" "}
                {hiddenClosedMatches === 1 ? "matches" : "match"}
              </button>
            ) : (
              <button className="clear-filters" onClick={() => thenFocusCount(clearFilters)}>
                Clear search and filters
              </button>
            )}
          </li>
        )}
      </ol>

      {/* Lookup first, the overview after it: a family's task is finding
          one facility. A chart row filters the list above and jumps back
          up to it. */}
      <section className="big-picture" aria-labelledby="big-picture-title">
        <h2 id="big-picture-title" className="section-title">
          The big picture
        </h2>
        <ActivityChart surveys={scopedSurveys} lastUpdated={db.lastUpdated} coverage={coverage} />

        <CountyChart
          facilities={db.facilities}
          since={sinceArchive(db.countyStart, db.counties)}
          county={county}
          onPick={pickCounty}
        />

        <CitationChart
          surveys={scopedSurveys}
          total={scoped.length}
          since={sinceArchive(db.countyStart, county === "ALL" ? db.counties : [county])}
          active={category}
          onPick={pickCategory}
        />
      </section>

      <Glossary />
      </main>

      <footer className="site-footer">
        <img
          className="footer-seal"
          src="brand/wpr-seal-88.webp"
          alt=""
          width="44"
          height="44"
        />
        <div className="methodology">
          <p>
            <strong>About this data.</strong> Compiled from the Wisconsin
            Department of Health Services Division of Quality Assurance (DQA)
            Provider Search, which shows only the past three years of survey
            history. The Care Ledger checks the state record every Monday,
            archives every statement of deficiency, enforcement action, and
            plan of correction and keeps records after the state stops
            showing them — those entries are marked{" "}
            <span className="held-inline">held in the ledger</span>. Covers
            Marathon County and its neighbors,{" "}
            {andList(db.counties.filter((c) => c !== "MARATHON").map(titleCase))} counties.{" "}
            {coverageText(db)} Each archive grows every week; earlier history
            is not included, so a facility with no records listed has none
            since its county&rsquo;s archive begins. Forfeiture amounts and rule citations are machine-read from
            the archived documents; forfeitures shown are the amounts assessed
            in enforcement letters, before any reduction for waived appeals,
            and an accruing forfeiture shows the amount assessed so far. If the
            state replaces a document on its site, the ledger shows the new
            version&rsquo;s figures, keeps the original and says what changed. An
            independent copy of each document and facility page is kept at
            the Internet Archive, captured from the state&rsquo;s own server
            (&ldquo;archive.org copy&rdquo;). Last updated{" "}
            {fmtDate(db.lastUpdated)}.{" "}
            <a href={`${LEDGER_URL}about/`} target="_blank" rel="noopener noreferrer">
              How the Care Ledger works
            </a>
          </p>
          <p className="feeds">
            Follow new enforcement actions by RSS:{" "}
            <a href={`${LEDGER_URL}feed.xml`} target="_blank" rel="noopener noreferrer">
              all nine counties
            </a>
            {county !== "ALL" && (
              <>
                {" · "}
                <a
                  href={`${LEDGER_URL}feed/${county.toLowerCase()}.xml`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {titleCase(county)} County
                </a>
              </>
            )}
          </p>
          <p className="support">
            The Care Ledger is free, with no paywall, because readers support
            Wausau Pilot &amp; Review&rsquo;s reporting.{" "}
            <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
              Support this work
            </a>
          </p>
          <p>
            Not affiliated with or endorsed by the Wisconsin Department of
            Health Services. Questions or corrections:{" "}
            <a href="mailto:editor@wausaupilotandreview.com">
              editor@wausaupilotandreview.com
            </a>
            .
          </p>
          <p className="footer-line">
            <a
              href="https://wausaupilotandreview.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Wausau Pilot &amp; Review
            </a>{" "}
            · 715-301-5539
          </p>
        </div>
      </footer>
    </div>
  );
}

function Stat({ n, label, tone, action, pressed, onClick }) {
  const value = typeof n === "number" ? fmtNum(n) : n;
  return (
    <div className={tone ? `stat stat-${tone}` : "stat"}>
      <dt>{label}</dt>
      <dd>
        {onClick ? (
          <button
            type="button"
            className="stat-button"
            aria-label={`${value} ${label}. ${action}`}
            aria-pressed={pressed}
            onClick={onClick}
          >
            {value}
          </button>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

/* ------------------------------------------------------- activity chart */

const CHART = { TOP: 22, PLOT: 150, BASE: 172, Q_Y: 187, YEAR_Y: 204, H: 210 };

function ActivityChart({ surveys, lastUpdated, coverage }) {
  const [hover, setHover] = useState(null);
  const { quarters, max } = useMemo(() => bucketQuarters(surveys), [surveys]);
  if (quarters.length < 2) return null;

  const n = quarters.length;
  const slot = 100 / n;
  const barW = slot * 0.6;
  const inset = (slot - barW) / 2;
  const hOf = (v) => (v / max) * CHART.PLOT;
  const center = (i) => `${i * slot + slot / 2}%`;

  // Recent quarters are still filling in: the state posts a survey weeks
  // after it closes (June 2026 exits first appeared in October), so a
  // quarter that ended within ~90 days of the latest refresh is marked
  // rather than drawn as a decline.
  const lagCutoff = isoMinusDays(lastUpdated, 90);
  const filling = quarters.map(
    (b) => new Date(Date.UTC(b.y, b.q * 3, 1) - 86400e3).toISOString().slice(0, 10) >= lagCutoff
  );
  // Each county's archive starts at the state's window on its first capture
  // (Marathon's in July 2023, its neighbors' in October 2023). A quarter
  // that begins before the latest start in view is only partly covered —
  // in the all-counties view, its bar is Marathon-heavy, not a dip.
  const latestStart = coverage.reduce((m, c) => (c.start > m ? c.start : m), "");
  const partial = quarters.map(
    (b) => `${b.y}-${String((b.q - 1) * 3 + 1).padStart(2, "0")}-01` < latestStart
  );
  const qMark = (i) => (filling[i] ? "*" : partial[i] ? "†" : "");
  const startGroups = Object.entries(
    coverage.reduce((g, c) => ((g[c.start] ||= []).push(c.county), g), {})
  ).sort();
  const partialNote =
    startGroups.length === 1
      ? `† The archive begins ${fmtDate(startGroups[0][0])}, partway through this quarter.`
      : `† Partly covered: the archive begins ${startGroups
          .map(
            ([d, cs]) =>
              `${fmtDate(d)}, for ${
                cs.length === 1 ? `${titleCase(cs[0])} County` : `the other ${apNum(cs.length)} counties`
              }`
          )
          .join(" and ")}.`;

  const years = [];
  quarters.forEach((b, i) => {
    const cur = years[years.length - 1];
    if (!cur || cur.y !== b.y) years.push({ y: b.y, from: i, to: i });
    else cur.to = i;
  });

  // Where the state's three-year window begins, placed to the day within its
  // quarter. Left of the line is history only this ledger still shows; the
  // line advances every week as more records age off the state site.
  const ws = windowStartOf(lastUpdated);
  const wq = quarterOf(ws);
  const wi = quarters.findIndex((b) => b.y === wq.y && b.q === wq.q);
  let boundary = null;
  if (wi >= 0) {
    const qStart = Date.UTC(wq.y, (wq.q - 1) * 3, 1);
    const qEnd = Date.UTC(wq.y, wq.q * 3, 1);
    boundary = (wi + (isoUTC(ws) - qStart) / (qEnd - qStart)) * slot;
  }
  const anyHeld = quarters.some((b) => b.held > 0);

  const tip = hover === null ? null : quarters[hover];
  const enforcedTotal = surveys.filter((s) => s.hasEnforcement).length;

  return (
    <figure className="activity">
      <div className="activity-head">
        <h3 id="activity-title">Inspections by quarter</h3>
        <ul className="legend">
          <li>
            <span className="swatch swatch-plain" /> All inspections
          </li>
          <li>
            <span className="swatch swatch-enf" /> Led to an enforcement action
          </li>
          {boundary !== null && anyHeld && (
            <li>
              <span className="swatch swatch-held" /> No longer listed by the state
            </li>
          )}
        </ul>
      </div>
      {/* The chart's point in one line, for whatever counties are in view:
          the red share holds near 4 in 10 year after year. */}
      <p className="chart-finding">
        <strong>
          {fmtNum(enforcedTotal)} of {fmtNum(surveys.length)} inspections (
          {Math.round((enforcedTotal / surveys.length) * 100)}%)
        </strong>{" "}
        led to an enforcement action.
      </p>
      <div className="chart-wrap">
        <svg
          width="100%"
          height={CHART.H}
          role="img"
          aria-labelledby="activity-title"
          aria-describedby="activity-desc"
          onMouseLeave={() => setHover(null)}
        >
          <desc id="activity-desc">
            {`Inspections per quarter from ${quarters[0].y} through ${quarters[n - 1].y}, with the number that carried an enforcement action shown in red.${
              boundary !== null && anyHeld
                ? ` A shaded area marks inspections older than the state's three-year window, which the state no longer lists and this ledger keeps.`
                : ""
            } Full figures in the table that follows.`}
          </desc>
          {boundary !== null && anyHeld && (
            <rect
              className="held-wash"
              x="0"
              y={CHART.TOP - 16}
              width={`${boundary}%`}
              height={CHART.BASE - CHART.TOP + 16}
            />
          )}
          {hover !== null && (
            <rect
              x={`${hover * slot}%`}
              width={`${slot}%`}
              y={CHART.TOP - 16}
              height={CHART.BASE - CHART.TOP + 16}
              fill="var(--paper-shade)"
            />
          )}
          {/* Under the bars, so it never strikes through a bar's label. */}
          {boundary !== null && anyHeld && (
            <>
              <line
                className="window-line"
                x1={`${boundary}%`}
                x2={`${boundary}%`}
                y1={CHART.TOP - 16}
                y2={CHART.BASE}
              />
              <text className="window-label" x={`${boundary}%`} dx="5" y={CHART.TOP - 7}>
                State&rsquo;s three-year window ▸
              </text>
            </>
          )}
          {/* Each bar is a quarter's surveys, outlined, filled from the
              baseline with the share that led to enforcement: one whole and
              its red part, read at a glance. Totals above; the red count in
              the red, or just above it when the red is too short. */}
          {quarters.map((b, i) => {
            const x = `${i * slot + inset}%`;
            const w = `${barW}%`;
            const totalH = hOf(b.total);
            const enfH = hOf(b.enforcement);
            const top = CHART.BASE - totalH;
            const inside = enfH >= 15;
            const above = !inside && b.enforcement > 0 && totalH - enfH >= 14;
            return (
              <g key={`${b.y}q${b.q}`}>
                <rect className="bar-total" x={x} width={w} y={top} height={totalH} />
                {b.enforcement > 0 && (
                  <rect x={x} width={w} y={CHART.BASE - enfH} height={enfH} fill="var(--red)" />
                )}
                <text className="bar-label" x={center(i)} y={top - 6} textAnchor="middle">
                  {`${b.total}${qMark(i)}`}
                </text>
                {b.enforcement > 0 && (inside || above) && (
                  <text
                    className={inside ? "bar-label-inner" : "bar-label-enf"}
                    x={center(i)}
                    y={inside ? CHART.BASE - enfH / 2 + 3.5 : CHART.BASE - enfH - 4}
                    textAnchor="middle"
                  >
                    {b.enforcement}
                  </text>
                )}
              </g>
            );
          })}
          <line
            x1="0"
            x2="100%"
            y1={CHART.BASE}
            y2={CHART.BASE}
            stroke="var(--ink)"
            strokeWidth="1.5"
          />
          {quarters.map((b, i) => (
            <text
              key={`q-${b.y}q${b.q}`}
              className="q-label"
              x={center(i)}
              y={CHART.Q_Y}
              textAnchor="middle"
            >
              {`Q${b.q}`}
            </text>
          ))}
          {years.map(
            (yr) =>
              yr.from > 0 && (
                <line
                  key={`tick-${yr.y}`}
                  className="year-tick"
                  x1={`${yr.from * slot}%`}
                  x2={`${yr.from * slot}%`}
                  y1={CHART.BASE}
                  y2={CHART.BASE + 22}
                />
              )
          )}
          {years.map((yr) => (
            <text
              key={`yr-${yr.y}`}
              className="year-label"
              x={`${((yr.from + yr.to + 1) / 2) * slot}%`}
              y={CHART.YEAR_Y}
              textAnchor="middle"
            >
              {yr.y}
            </text>
          ))}
          {quarters.map((b, i) => (
            <rect
              key={`hit-${b.y}q${b.q}`}
              x={`${i * slot}%`}
              width={`${slot}%`}
              y={0}
              height={CHART.BASE}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          ))}
        </svg>
        {tip && (
          <div
            className="chart-tip"
            style={{
              left: `clamp(90px, ${hover * slot + slot / 2}%, calc(100% - 90px))`,
            }}
          >
            <strong>
              Q{tip.q} {tip.y}
            </strong>{" "}
            · {tip.total} {tip.total === 1 ? "inspection" : "inspections"} ·{" "}
            {tip.enforcement} enforcement ({Math.round((tip.enforcement / tip.total) * 100)}%)
            {tip.held > 0 && ` · ${tip.held} held in the ledger`}
          </div>
        )}
      </div>
      {(filling.some(Boolean) || partial.some(Boolean)) && (
        <p className="chart-note">
          {filling.some(Boolean) && (
            <span>* Still filling in: the state posts inspections weeks after they close.</span>
          )}
          {partial.some(Boolean) && <span>{partialNote}</span>}
        </p>
      )}
      {/* Hidden by a wrapping div: tables ignore width and overflow, so a
          table with the hiding class itself kept its full width and pushed
          the page wider than a phone. */}
      <div className="sr-only">
      <table>
        <caption>Inspections per quarter</caption>
        <thead>
          <tr>
            <th scope="col">Quarter</th>
            <th scope="col">Inspections</th>
            <th scope="col">With enforcement action</th>
            <th scope="col">No longer listed by the state</th>
          </tr>
        </thead>
        <tbody>
          {quarters.map((b) => (
            <tr key={`sr-${b.y}q${b.q}`}>
              <th scope="row">{`Q${b.q} ${b.y}`}</th>
              <td>{b.total}</td>
              <td>
                {b.enforcement} ({Math.round((b.enforcement / b.total) * 100)}%)
              </td>
              <td>{b.held}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </figure>
  );
}

/* Enforcement by county: the share of each county's facilities with at
   least one enforcement action. Always all nine (it compares them), on a
   fixed 0-100% scale so a bar's length is its share, counts first in every
   label because small counties swing widely (Taylor's 50% is 2 of 4).
   Each row sets the county filter; the selected county stays marked. */
function CountyChart({ facilities, since, county, onPick }) {
  const rows = useMemo(() => {
    const by = {};
    for (const f of facilities) {
      const r = (by[f.county] ||= { county: f.county, total: 0, enforced: 0, fines: 0 });
      r.total += 1;
      r.enforced += f.enforcementCount > 0 ? 1 : 0;
      r.fines += f.fineTotal;
    }
    return Object.values(by)
      .map((r) => ({ ...r, share: r.enforced / r.total }))
      .sort((a, b) => b.share - a.share || b.total - a.total);
  }, [facilities]);
  if (rows.length < 2) return null;
  const smallest = rows.reduce((m, r) => (r.total < m.total ? r : m));

  return (
    <figure className="cites county-chart">
      <div className="activity-head">
        <h3 id="county-title">Enforcement by county</h3>
        <p className="cites-sub">
          Share of each county&rsquo;s facilities with at least one enforcement action · select one
          to view it
        </p>
      </div>
      <ol className="cites-list" aria-labelledby="county-title">
        {rows.map((r) => (
          <li key={r.county}>
            <button
              className={county === r.county ? "cites-row is-active" : "cites-row"}
              aria-pressed={county === r.county}
              onClick={() => onPick(r.county)}
            >
              <span className="cites-cat">{titleCase(r.county)}</span>
              <span className="cites-track" aria-hidden="true">
                <span className="cites-bar" style={{ width: `${r.share * 100}%` }} />
              </span>
              <span className="cites-val">
                {r.enforced} of {r.total}
                <span className="cites-pct"> · {Math.round(r.share * 100)}%</span>
                <span className="cites-n"> · ${fmtNum(r.fines)} in fines</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      <p className="chart-note">
        <span>
          Counts include closed facilities and every record {since}. Small counties swing
          widely: {titleCase(smallest.county)} has {apNum(smallest.total)} facilities.
        </span>
      </p>
    </figure>
  );
}

/* What inspectors cite: facilities cited at least once in each area, from
   the categories enrich.py gives every cited rule. One measure across
   categories, sorted, every bar labeled -- so plain rows, not a plot. */
function CitationChart({ surveys, total, since, active, onPick }) {
  const rows = useMemo(() => {
    const by = {};
    for (const s of surveys) {
      for (const c of s.enr.citations) {
        const r = (by[c.category] ||= { category: c.category, facilities: new Set(), citations: 0 });
        r.facilities.add(s.license);
        r.citations += 1;
      }
    }
    return Object.values(by)
      .map((r) => ({ ...r, facilities: r.facilities.size }))
      .sort((a, b) => b.facilities - a.facilities || b.citations - a.citations);
  }, [surveys]);
  if (rows.length < 2) return null;

  return (
    <figure className="cites">
      <div className="activity-head">
        <h3 id="cites-title">What inspectors cite</h3>
        <p className="cites-sub">
          Share of the {fmtNum(total)} facilities in view cited at least once · select one to list them
        </p>
      </div>
      {/* Each row is a door into the list: "which facilities were cited
          for medications?" is the question this chart raises. */}
      <ol className="cites-list" aria-labelledby="cites-title">
        {rows.map((r) => (
          <li key={r.category}>
            <button
              className={active === r.category ? "cites-row is-active" : "cites-row"}
              aria-pressed={active === r.category}
              onClick={() => onPick(r.category)}
            >
              <span className="cites-cat">{r.category}</span>
              <span className="cites-track" aria-hidden="true">
                {/* Its share of the facilities in view, on a 0-100% track like the
                    county chart's, so the two read alike. */}
                <span className="cites-bar" style={{ width: `${(r.facilities / total) * 100}%` }} />
              </span>
              <span className="cites-val">
                {fmtNum(r.facilities)} {r.facilities === 1 ? "facility" : "facilities"}
                <span className="cites-pct"> · {Math.round((r.facilities / total) * 100)}%</span>
                <span className="cites-n">
                  {" "}
                  · {fmtNum(r.citations)} {r.citations === 1 ? "citation" : "citations"}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      <p className="chart-note">
        <span>
          From the rules cited in statements of deficiency {since}. A facility counts once per
          category however often it was cited.
        </span>
      </p>
    </figure>
  );
}

/* ------------------------------------------------------------------- map */

const MAP_MAX_H = 560; // a single county is taller than wide; keep it on screen
const MAP_PAD = 12;

// Even-odd ray cast over every ring of a GeoJSON Polygon/MultiPolygon.
function inOutline(geometry, lon, lat) {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let hit = false;
  for (const poly of polys)
    for (const ring of poly)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[j];
        if (y1 > lat !== y2 > lat && lon < x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1)) hit = !hit;
      }
  return hit;
}

// Where to print a county's name: the open spot inside it farthest from
// any dot (towns cluster at county centers, under a centered label),
// nudged toward the middle so labels don't hug the edges. Distances are
// stretched vertically because a label is wider than it is tall.
function labelSpot(geometry, unproject, box, dots) {
  const [x0, y0, x1, y1] = box;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let best = [cx, cy], score = -Infinity;
  for (let x = x0 + 34; x <= x1 - 34; x += 6)
    for (let y = y0 + 12; y <= y1 - 8; y += 6) {
      const edge = [[-32, -8], [32, -8], [-32, 4], [32, 4]];
      if (!edge.every(([dx, dy]) => inOutline(geometry, ...unproject(x + dx, y + dy)))) continue;
      let clear = 40;
      for (const d of dots) clear = Math.min(clear, Math.hypot((d.x - x) / 3, (d.y - y + 4) * 1.5));
      const s = clear - 0.08 * Math.hypot(x - cx, y - cy);
      if (s > score) [score, best] = [s, [x, y]];
    }
  return best;
}

/* Where the facilities in view are. A plain SVG over the Census Bureau's
   county lines — no tile service, so nothing loads from a third party and
   the frame stays light. Every dot is one facility, so this is a locator,
   not a density map: red marks an enforcement action on record, hollow a
   closed facility. Dots aren't focusable; the list view is the accessible
   equivalent, and the toggle sits right above. */
function FacilityMap({ facilities, basemap, county, focus, onFocused, onOpen, onPickCounty }) {
  const wrapRef = useRef(null);
  const cardRef = useRef(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState(null);
  const [pin, setPin] = useState(null);

  useEffect(() => {
    const el = wrapRef.current;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 640));
    ro.observe(el);
    setWidth(el.clientWidth || 640);
    return () => ro.disconnect();
  }, []);

  // A new search or filter is a new map: drop any open card.
  useEffect(() => {
    setPin(null);
    setHover(null);
  }, [facilities, county]);

  // Closing a card clears the hover preview under it too, and if focus was
  // inside the card (it is after "Show on the map"), hands it to the map
  // figure rather than dropping it to the top of the page.
  const figureRef = useRef(null);
  const closePin = () => {
    const hadFocus = cardRef.current?.contains(document.activeElement);
    setPin(null);
    setHover(null);
    if (hadFocus) figureRef.current?.focus({ preventScroll: EMBEDDED });
  };

  useEffect(() => {
    if (!pin) return;
    const onKey = (e) => e.key === "Escape" && closePin();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pin]);

  // Frame the county in view (all nine by default), not the dots, so the
  // map holds still while a search narrows it.
  const geo = useMemo(() => {
    const framed = basemap.counties.filter((f) => county === "ALL" || f.properties.county === county);
    const { height, project, unproject } = mapFrame(framed, width, MAP_MAX_H, MAP_PAD);
    const paths = basemap.counties.map((f) => {
      const pts = (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates).flatMap(
        (poly) => poly[0].map((p) => project(...p))
      );
      const box = [
        Math.min(...pts.map((p) => p[0])),
        Math.min(...pts.map((p) => p[1])),
        Math.max(...pts.map((p) => p[0])),
        Math.max(...pts.map((p) => p[1])),
      ];
      return { county: f.properties.county, d: outlinePath(f.geometry, project), box, geometry: f.geometry };
    });
    return { height, project, unproject, paths };
  }, [basemap, county, width]);

  const r = county === "ALL" ? 4.5 : 5.5;
  const dots = useMemo(
    () =>
      facilities
        .filter((f) => f.point)
        .map((f) => {
          const [x, y] = geo.project(f.point.lon, f.point.lat);
          return { f, x, y, enforced: f.enforcementCount > 0 };
        })
        // Red on top: an enforcement dot is never hidden under a gray one.
        .sort((a, b) => a.enforced - b.enforced),
    [facilities, geo]
  );
  const unplaced = facilities.filter((f) => !f.point);
  const countyLabels = useMemo(
    () =>
      county !== "ALL"
        ? []
        : geo.paths.map((p) => ({
            county: p.county,
            at: labelSpot(p.geometry, geo.unproject, p.box, dots),
          })),
    [geo, dots, county]
  );
  const enforcedN = dots.filter((d) => d.enforced).length;
  const anyClosed = dots.some((d) => d.f.closed);

  // Labels: county names across all nine; in one county, the towns where
  // two or more of the facilities in view have their address (the roster
  // spells some cities in capitals, some not). A name is anchored at the
  // Census Gazetteer's point for the town -- not at its facilities, which a
  // mailing city can spread miles out -- and set beside it, wherever it
  // covers the fewest dots; skipped rather than printed over another name.
  const towns = useMemo(() => {
    if (county === "ALL") return [];
    const count = {};
    for (const d of dots) {
      const c = titleCase(d.f.city.trim());
      count[c] = (count[c] || 0) + 1;
    }
    const H = 11;
    const placed = [];
    const out = [];
    // A town just across the county line still names its facilities here
    // (Marshfield's point is in Wood; its north side is in Marathon).
    const candidates = basemap.places
      .filter((p) => (count[p.name] || 0) >= 2)
      .map((p) => ({ ...p, at: geo.project(p.lon, p.lat) }))
      .filter(({ at: [x, y] }) => x > -30 && x < width + 30 && y > -30 && y < geo.height + 30)
      .sort((a, b) => count[b.name] - count[a.name]);
    for (const p of candidates) {
      const [px, py] = p.at;
      const w = p.name.length * 7 + 4;
      let best = null;
      [r + 4, r + 16, r + 30].forEach((reach, ring) => {
        for (const [ux, uy] of [[0, -1], [1, 0], [0, 1], [-1, 0], [0.7, -0.7], [-0.7, -0.7], [0.7, 0.7], [-0.7, 0.7]]) {
          const cx = px + ux * (reach + w / 2) * Math.abs(Math.sign(ux));
          const cy = py + uy * (reach + H / 2);
          const box = [cx - w / 2, cy - H / 2, cx + w / 2, cy + H / 2];
          if (box[0] < 0 || box[2] > width || box[1] < 0 || box[3] > geo.height) continue;
          if (placed.some((b) => b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3])) continue;
          const covered = dots.filter(
            (d) => d.x > box[0] - r && d.x < box[2] + r && d.y > box[1] - r && d.y < box[3] + r
          ).length;
          const score = covered * 10 + ring;
          if (!best || score < best.score) best = { box, score };
        }
      });
      if (!best) continue;
      placed.push(best.box);
      out.push({ city: p.name, x: (best.box[0] + best.box[2]) / 2, y: best.box[3] - 2 });
    }
    return out;
  }, [dots, county, width, geo, r, basemap]);

  // Everything under the pointer, nearest first: Wausau's dots overlap.
  const near = (x, y) =>
    dots
      .map((d) => ({ d, dist: Math.hypot(d.x - x, d.y - y) }))
      .filter((e) => e.dist <= r + 5)
      .sort((a, b) => a.dist - b.dist)
      .map((e) => e.d.f);
  const local = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    return [e.clientX - box.left, e.clientY - box.top];
  };
  const countyAt = (x, y) => {
    const [lon, lat] = geo.unproject(x, y);
    return geo.paths.find((p) => inOutline(p.geometry, lon, lat))?.county;
  };

  const onMove = (e) => {
    if (pin || e.pointerType === "touch") return;
    const items = near(...local(e));
    setHover(items.length ? { items } : null);
  };
  const onClick = (e) => {
    const [x, y] = local(e);
    const items = near(x, y);
    if (items.length) return setPin({ items });
    if (pin) return closePin();
    const c = county === "ALL" && countyAt(x, y);
    if (c) onPickCounty(c);
  };

  // "Show on the map" from a record: open its card, nearest neighbors
  // after it, and put keyboard focus on its name (Enter goes back).
  const dotOf = useMemo(() => Object.fromEntries(dots.map((d) => [d.f.license, d])), [dots]);
  useEffect(() => {
    const d = focus && dotOf[focus];
    if (!d) return;
    setPin({ items: [d.f, ...near(d.x, d.y).filter((f) => f !== d.f)], focus: true });
    onFocused();
  }, [focus, dotOf]);
  useEffect(() => {
    if (pin?.focus)
      requestAnimationFrame(() =>
        cardRef.current?.querySelector(".map-card-name")?.focus({ preventScroll: EMBEDDED })
      );
  }, [pin]);

  // A card hangs from its first facility's dot, so it stays attached when
  // the frame resizes.
  const card = pin || hover;
  const anchor = card && dotOf[card.items[0].license];
  const cardStyle = anchor && {
    left: Math.max(0, Math.min(anchor.x - 130, width - 260)),
    ...(anchor.y < geo.height / 2
      ? { top: anchor.y + r + 10 }
      : { bottom: geo.height - anchor.y + r + 10 }),
  };
  // A hover card previews a few; a clicked one lists them all, scrolling.
  const shownItems = card && (pin ? card.items : card.items.slice(0, 5));

  return (
    <figure className="facility-map" ref={figureRef} tabIndex={-1}>
      <ul className="map-legend">
        <li>
          <span className="key-dot is-red" aria-hidden="true" /> Enforcement action on record (
          {fmtNum(enforcedN)})
        </li>
        <li>
          <span className="key-dot" aria-hidden="true" /> None on record ({fmtNum(dots.length - enforcedN)})
        </li>
        {anyClosed && (
          <li>
            <span className="key-dot is-hollow" aria-hidden="true" /> Closed
          </li>
        )}
      </ul>
      <div className="map-frame" ref={wrapRef}>
        <svg
          width={width}
          height={geo.height}
          viewBox={`0 0 ${width} ${geo.height}`}
          role="img"
          aria-label={`Map of ${fmtNum(dots.length)} of the ${fmtNum(facilities.length)} facilities in view; ${fmtNum(
            enforcedN
          )} have an enforcement action on record. The list view has the same facilities.`}
          className={county === "ALL" && !card ? "is-pickable" : undefined}
          onPointerMove={onMove}
          onPointerLeave={() => !pin && setHover(null)}
          onClick={onClick}
        >
          {geo.paths.map((p) => (
            <path
              key={p.county}
              d={p.d}
              className={county === "ALL" || p.county === county ? "map-county" : "map-county is-context"}
            />
          ))}
          {countyLabels.map((l) => (
            <text key={l.county} x={l.at[0]} y={l.at[1]} className="map-label">
              {titleCase(l.county)}
            </text>
          ))}
          {towns.map((t) => (
            <text key={t.city} x={t.x} y={t.y} className="map-label is-town">
              {t.city}
            </text>
          ))}
          {dots.map(({ f, x, y, enforced }) => (
            <circle
              key={f.license}
              cx={x.toFixed(1)}
              cy={y.toFixed(1)}
              r={r}
              className={`map-dot${enforced ? " is-red" : ""}${f.closed ? " is-hollow" : ""}${
                card?.items.includes(f) ? " is-hot" : ""
              }`}
            />
          ))}
        </svg>
        {anchor && (
          <div ref={cardRef} className={pin ? "map-card is-pinned" : "map-card"} style={cardStyle}>
            {pin && (
              <button className="map-card-close" onClick={closePin} aria-label="Close">
                ×
              </button>
            )}
            {card.items.length > 1 && (
              <p className="map-card-head">{card.items.length} facilities here</p>
            )}
            <ul>
              {shownItems.map((f) => (
                <li key={f.license}>
                  <button className="map-card-name" onClick={() => onOpen(f.license)}>
                    {smartTitle(f.name)}
                  </button>
                  <span className="map-card-meta">
                    {titleCase(f.city)} · {f.typeAbbr}
                    {f.closed && " · closed"}
                  </span>
                  <span className={f.enforcementCount ? "map-card-enf is-red" : "map-card-enf"}>
                    {f.enforcementCount
                      ? `${f.enforcementCount} enforcement ${f.enforcementCount === 1 ? "action" : "actions"}${
                          f.fineTotal ? ` · $${fmtNum(f.fineTotal)} assessed` : ""
                        }`
                      : "No enforcement actions on record"}
                  </span>
                </li>
              ))}
            </ul>
            {!pin && (
              <p className="map-card-hint">
                {card.items.length > shownItems.length
                  ? `+${card.items.length - shownItems.length} more · click to list them all`
                  : "Click to keep this open"}
              </p>
            )}
          </div>
        )}
      </div>
      <figcaption className="chart-note">
        <span>
          {county === "ALL"
            ? "Hover over or tap a dot to see the facility; select a county to zoom in."
            : "Hover over or tap a dot to see the facility."}{" "}
          Locations are the state roster&rsquo;s addresses as placed by the U.S. Census
          Bureau&rsquo;s geocoder; county lines from Census TIGER.
        </span>
        {county !== "ALL" && (
          <span className="map-zoom-out">
            <button className="clear-filters" onClick={() => onPickCounty("ALL")}>
              Show all nine counties
            </button>
          </span>
        )}
        {unplaced.length > 0 && (
          <span className="map-unplaced">
            Not on the map — no reliable location for the address:{" "}
            {unplaced.map((f, i) => (
              <React.Fragment key={f.license}>
                {i > 0 && ", "}
                <button className="unplaced-name" onClick={() => onOpen(f.license)}>
                  {smartTitle(f.name)}
                </button>{" "}
                ({titleCase(f.city)})
              </React.Fragment>
            ))}
            .
          </span>
        )}
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------- single-facility embed */

/* ?facility=<license>: one record, open, under a compact WPR flag — for a
   story about one facility. Links to other facilities or an operator open
   the full ledger in a new tab rather than navigating the small frame. */
function FacilityEmbed({ db, license, staleDays }) {
  // Licenses are 6 or 7 digits; a link that dropped leading zeros still works.
  const f = db.byLicense[license] || db.byLicense[license.padStart(7, "0")];
  const openLedger = (hash) => window.open(`${LEDGER_URL}${hash}`, "_blank", "noopener");

  return (
    <div className="ledger ledger-single">
      <header className="masthead masthead-single">
        <img className="badge" src="brand/wpr-seal-168.webp" alt="" width="44" height="44" />
        <div className="masthead-text">
          <a
            className="wordmark-link"
            href="https://wausaupilotandreview.com/"
            target="_blank"
            rel="noopener noreferrer"
          >
            <img
              className="wordmark"
              src="brand/wpr-wordmark-266.webp"
              alt="Wausau Pilot &amp; Review"
              width="133"
              height="17"
            />
          </a>
          <p className="single-title">
            The Care Ledger <span className="fresh">· updated {fmtDate(db.lastUpdated)}</span>
          </p>
        </div>
      </header>
      <div className="flag-rule" />

      <main>
      {staleDays > STALE_AFTER_DAYS && (
        <p className="stale-notice" role="note">
          <strong>This ledger is behind.</strong> It was last refreshed{" "}
          {fmtDate(db.lastUpdated)}.
        </p>
      )}

      {f ? (
        <ol className="rows">
          <FacilityRow
            f={f}
            db={db}
            query=""
            open
            single
            onToggle={() => {}}
            onCrossLink={(lic) => openLedger(`#lic=${lic}`)}
            onOperator={(name) => openLedger(`#q=${encodeURIComponent(name)}`)}
          />
        </ol>
      ) : (
        <p className="empty">
          No facility with license {license} is in the ledger.{" "}
          <a href={LEDGER_URL} target="_blank" rel="noopener noreferrer">
            Search The Care Ledger
          </a>
          .
        </p>
      )}

      <Glossary />
      </main>

      <footer className="single-foot">
        <a href={f ? `${LEDGER_URL}#lic=${f.license}` : LEDGER_URL} target="_blank" rel="noopener noreferrer">
          See all {db.facilities.length} facilities in The Care Ledger
        </a>{" "}
        · Records from the Wisconsin DHS Division of Quality Assurance, kept after the state stops
        showing them. Not affiliated with DHS. Wausau Pilot &amp; Review · 715-301-5539 ·{" "}
        <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
          Support this work
        </a>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------ facility row */

function FacilityRow({ f, db, query, open, single, onToggle, onCrossLink, onOperator, onShowOnMap }) {
  const panelId = `panel-${f.license}`;
  const HistoryHeading = single ? "h2" : "h4";
  const [copied, setCopied] = useState(false);
  const panelRef = useRef(null);
  // Render a record's panel on first open, then keep it mounted so the
  // reveal can animate both ways: 300+ hidden timelines on load would cost
  // phones tens of thousands of DOM nodes.
  const everOpened = useRef(false);
  if (open) everOpened.current = true;
  // Built with the panel, not for all 300 rows on load.
  const locator = useMemo(
    () => (everOpened.current ? locatorSvg(db.basemap, f, 220) : ""),
    [db, f, everOpened.current]
  );
  const nearby = useMemo(
    () => (everOpened.current ? nearbyOf(db.facilities, f) : []),
    [db, f, everOpened.current]
  );

  // Closed panels stay mounted (for the reveal animation) but must leave
  // the tab order and the accessibility tree. Set as a DOM property: React
  // 19 reads inert="" as false.
  useEffect(() => {
    if (panelRef.current) panelRef.current.inert = !open;
  }, [open]);

  // When the search hit lives in a field the row doesn't show (operator,
  // licensee, address), say so — otherwise the result looks arbitrary.
  const q = query.toLowerCase();
  let matchNote = null;
  if (q && !f.name.toLowerCase().includes(q) && !f.city.toLowerCase().includes(q)) {
    if (f.corporate_name && f.corporate_name.toLowerCase().includes(q)) {
      matchNote = { label: "operator", value: smartTitle(f.corporate_name) };
    } else if (f.licensee && f.licensee.toLowerCase().includes(q)) {
      matchNote = { label: "licensee", value: smartTitle(f.licensee) };
    } else if (f.address && f.address.toLowerCase().includes(q)) {
      matchNote = { label: "address", value: addressCase(f.address) };
    }
  }

  const copyLink = () => {
    const url = `${hostUrl || LEDGER_URL}#lic=${f.license}`;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        },
        () => window.prompt("Copy this link:", url)
      );
    } else {
      window.prompt("Copy this link:", url);
    }
  };

  const head = (
    <>
        <span className="row-main">
          <span className="row-name">
            <Highlight text={smartTitle(f.name)} q={query} />
          </span>
          <span className="row-meta">
            {f.typeAbbr} · <Highlight text={titleCase(f.city)} q={query} /> ·{" "}
            {f.capacity} beds
            {f.latest && <> · latest inspection {fmtDate(f.latest)}</>}
            {matchNote && (
              <>
                {" "}
                · {matchNote.label}:{" "}
                <Highlight text={matchNote.value} q={query} />
              </>
            )}
          </span>
        </span>
        <span className="row-chips">
          {f.enforcementCount > 0 && (
            <span className="chip chip-enforcement">
              {f.enforcementCount} enforcement {f.enforcementCount === 1 ? "action" : "actions"}
              {f.fineTotal > 0 && ` · $${fmtNum(f.fineTotal)}`}
            </span>
          )}
          {f.newCount > 0 && <span className="chip chip-new">{f.revisedOnly ? "Revised" : "New"}</span>}
          {f.probationary && (
            <span
              className="chip chip-probation"
              title="Wisconsin issues a probationary license for a facility's first year of licensure; it is not a disciplinary status."
            >
              Probationary license
            </span>
          )}
          {f.heldCount > 0 && (
            <span className="chip chip-held">
              {f.heldCount} {f.heldCount === 1 ? "record" : "records"} held
            </span>
          )}
          {f.closed && <span className="chip chip-closed">Closed</span>}
          {!single && <span className="row-caret" aria-hidden="true">+</span>}
        </span>
    </>
  );

  return (
    <li className={open ? "row is-open" : "row"}>
      {single ? (
        // One record alone: it is the frame's subject (its h1), always open.
        <h1 className="row-heading">
          <span id={`head-${f.license}`} className="row-head row-head-static">
            {head}
          </span>
        </h1>
      ) : (
        <h3 className="row-heading">
          <button
            id={`head-${f.license}`}
            className="row-head"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={onToggle}
          >
            {head}
          </button>
        </h3>
      )}

      <div className={open ? "row-reveal is-open" : "row-reveal"}>
        <div className="row-panel" id={panelId} ref={panelRef}>
          {everOpened.current && (<>
          {f.surveys.length > 0 && (
            <p className="panel-summary">
              <span>
                {f.surveys.length} {f.surveys.length === 1 ? "inspection" : "inspections"} on
                record
              </span>
              {f.enforcementCount > 0 && (
                <span className="sum-enf">
                  {f.enforcementCount} enforcement {f.enforcementCount === 1 ? "action" : "actions"}
                </span>
              )}
              {f.fineTotal > 0 && (
                <span className="sum-enf">${fmtNum(f.fineTotal)} assessed</span>
              )}
              {f.latest && <span>latest inspection {fmtDate(f.latest)}</span>}
            </p>
          )}
          <div className="panel-grid">
          <dl className="facts">
            <Fact k="Facility type" v={TYPE_FULL[f.typeAbbr]} />
            <Fact k="Address" v={`${addressCase(f.address)}, ${titleCase(f.city)} ${f.zip}`} />
            <Fact k="County" v={titleCase(f.county)} />
            <Fact k="License" v={f.license} mono />
            <Fact k="Status" v={statusLabel(f.licensure_status)} />
            {f.corporate_name && db.operatorCounts[f.corporate_name] > 1 ? (
              <div className="fact">
                <dt>Operator</dt>
                <dd>
                  <button
                    className="operator-link"
                    title="Show every facility run by this operator"
                    onClick={() => onOperator(f.corporate_name)}
                  >
                    {smartTitle(f.corporate_name)} ·{" "}
                    {db.operatorCounts[f.corporate_name]} facilities
                  </button>
                </dd>
              </div>
            ) : (
              <Fact k="Operator" v={f.corporate_name ? smartTitle(f.corporate_name) : "—"} />
            )}
            <Fact k="Ownership" v={ownershipLabel(f.ownership_type)} />
            {licensedOn(f) && (
              <Fact k="Licensed" v={fmtDate(licensedOn(f))} mono />
            )}
            {f.date_closed && <Fact k="Closed" v={fmtDate(f.date_closed)} mono />}
            <Fact k="Serves" v={f.client_groups ? smartTitle(f.client_groups) : "—"} wide />
            {f.siblings.length > 0 && (
              <div className="fact fact-wide">
                <dt>Also licensed at this address</dt>
                <dd>
                  {f.siblings.map((lic) => {
                    const s = db.byLicense[lic];
                    // Closed status first: one closed license has no
                    // closure date and must not read as "licensed".
                    const licensed = licensedOn(s);
                    return (
                      <button key={lic} className="sibling" onClick={() => onCrossLink(lic)}>
                        {smartTitle(s.name)}
                        {s.closed
                          ? s.date_closed
                            ? ` (closed ${fmtDate(s.date_closed)})`
                            : " (closed)"
                          : licensed
                          ? ` (licensed ${fmtDate(licensed)})`
                          : ""}
                      </button>
                    );
                  })}
                </dd>
              </div>
            )}
            {nearby.length > 0 && (
              <div className="fact fact-wide">
                <dt>Nearest operating facilities</dt>
                <dd>
                  <ul className="nearby">
                    {nearby.map(({ f: o, miles }) => (
                      <li key={o.license}>
                        <button className="nearby-name" onClick={() => onCrossLink(o.license)}>
                          {smartTitle(o.name)}
                        </button>{" "}
                        <span className="nearby-meta">
                          {titleCase(o.city)} · {miles.toFixed(1)} miles
                          {o.enforcementCount > 0 && (
                            <span className="nearby-enf">
                              {" "}
                              · {o.enforcementCount} enforcement{" "}
                              {o.enforcementCount === 1 ? "action" : "actions"}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <span className="nearby-note">Straight-line distance, within 15 miles.</span>
                </dd>
              </div>
            )}
            {locator && (
              <div className="fact fact-wide fact-map">
                <dt>Location</dt>
                {/* Markup built by locatorSvg() from the ledger's own data. */}
                <dd dangerouslySetInnerHTML={{ __html: locator }} />
              </div>
            )}
          </dl>

          <div className="history">
            {/* An h4 under each row's h3; in the single-facility embed the
                record is the frame's h1, so its history is an h2. */}
            <HistoryHeading className="history-heading">
              Inspection history<span className="sr-only"> for {smartTitle(f.name)}</span>
            </HistoryHeading>
            {f.surveys.length === 0 ? (
              <p className="no-surveys">
                {/* The archive begins at the state's window on the county's
                    first capture: July 2023 for Marathon, October for the rest. */}
                No inspection records since {fmtDate(windowStartOf(db.countyStart[f.county]))}
                {licensedOn(f)
                  ? ` — licensed ${fmtDate(licensedOn(f))}`
                  : ""}
                .
              </p>
            ) : (
              <ol className="timeline">
                {f.surveys.map((s) => (
                  <li key={s.id} className={s.expired_from_state ? "event is-held" : "event"}>
                    <span className="event-date">{fmtDate(s.exit_date)}</span>
                    <span className="event-body">
                      <span className="event-type">
                        {surveyLabel(s.survey_type)}
                        {s.enr.fine && (
                          <>
                            {" "}
                            <span className="event-fine">
                              ${fmtNum(s.enr.fine)} forfeiture
                              {s.enr.sanctions.includes("Accruing forfeiture") && " (accruing)"}
                            </span>
                          </>
                        )}
                        {s.isNew && (
                          <>
                            {" "}
                            <span className="new-stamp">{s.newReason === "revised" ? "Revised this week" : "New this week"}</span>
                          </>
                        )}
                      </span>
                      {s.enr.sanctions
                        .filter((x) => SANCTION_LABELS[x])
                        .map((x) => (
                          <span key={x} className="event-sanction">
                            {SANCTION_LABELS[x]}
                          </span>
                        ))}
                      {(s.enr.substantiated > 0 || s.enr.citations.length > 0) && (
                        <span className="event-cites">
                          {s.enr.substantiated > 0 && (
                            <strong>
                              {s.enr.substantiated === 1
                                ? "Complaint substantiated"
                                : `${apNum(s.enr.substantiated)} complaints substantiated`}
                              {s.enr.citations.length > 0 && " · "}
                            </strong>
                          )}
                          {s.enr.citations.length > 0 && <>Cited: {citeSummary(s.enr.citations)}</>}
                        </span>
                      )}
                      {s.expired_from_state && (
                        <>
                          <span className="held-stamp">Held in the ledger</span>
                          <span className="held-note">
                            {s.source && s.source.startsWith("wayback")
                              ? `Recovered from an Internet Archive copy of the state site (${fmtDate(s.last_seen)}).`
                              : `No longer listed in the state's Provider Search — last listed ${fmtDate(s.last_seen)}.`}
                          </span>
                        </>
                      )}
                      {s.revision && (
                        <>
                          <span className="revised-stamp">Revised by the state</span>
                          <span className="revised-note">
                            The state replaced{" "}
                            {s.docs.filter((d) => d.original).length > 1 ? "these documents" : "this document"}{" "}
                            on its site on {fmtDate(s.revision.posted)}
                            {revisionChanges(s.revision) && `: ${revisionChanges(s.revision)}`}. The
                            figures above are from the current version. Originals, kept here:{" "}
                            {s.docs
                              .filter((d) => d.original)
                              .map((d, i) => (
                                <React.Fragment key={d.original}>
                                  {i > 0 && " · "}
                                  <a href={d.original} target="_blank" rel="noopener noreferrer">
                                    original {DOC_LABELS[d.kind].toLowerCase()} (PDF)
                                  </a>
                                </React.Fragment>
                              ))}
                          </span>
                        </>
                      )}
                      <span className="event-docs">
                        {s.docs.map((d) => (
                          <span key={d.path} className="doc-pair">
                            <a
                              className={`doc doc-${d.kind}`}
                              href={d.path}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {DOC_LABELS[d.kind]} (PDF)
                            </a>
                            {d.copy && (
                              <a
                                className="doc-copy"
                                href={d.copy}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={`Independent copy the Internet Archive fetched from the state's server on ${fmtDate(waybackDate(d.copy))}`}
                              >
                                archive.org copy
                                <span className="sr-only"> of the {DOC_LABELS[d.kind].toLowerCase()}</span>
                              </a>
                            )}
                            {d.gone && (
                              <span className="doc-gone">
                                no longer on the state&rsquo;s site since {fmtDate(d.gone)}; kept here
                              </span>
                            )}
                          </span>
                        ))}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
            <p className="state-link">
              <a
                href={`${STATE_DETAIL_URL}?key=${f.key}&keyb=-1`}
                target="_blank"
                rel="noopener noreferrer"
              >
                View this facility on the state site
              </a>
              <a
                className="page-copy"
                href={`${LEDGER_URL}facility/${facilitySlug(f)}/`}
                target="_blank"
                rel="noopener noreferrer"
                title="A permanent page for this facility, to share or bookmark"
              >
                Page for this facility
              </a>
              {onShowOnMap && f.point && (
                <button type="button" className="page-copy link-button" onClick={() => onShowOnMap(f)}>
                  Show on the map
                </button>
              )}
              {f.pageCopy && (
                <a
                  className="page-copy"
                  href={f.pageCopy}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="The Internet Archive's copy of the state's page, fetched from the state's server"
                >
                  State page as archived {fmtDate(waybackDate(f.pageCopy))}
                </a>
              )}
              <button className="copy-link" onClick={copyLink}>
                {copied ? "Link copied ✓" : "Copy link to this record"}
              </button>
              <span className="sr-only" role="status">
                {copied ? "Link to this record copied" : ""}
              </span>
            </p>
          </div>
          </div>
          </>)}
        </div>
      </div>
    </li>
  );
}

function Fact({ k, v, mono, wide }) {
  return (
    <div className={wide ? "fact fact-wide" : "fact"}>
      <dt>{k}</dt>
      <dd className={mono ? "mono" : undefined}>{v}</dd>
    </div>
  );
}

/* "Marathon County's archive starts with what the state showed on July 12,
   2026 — records back to July 12, 2023; the other eight counties' archives
   start …". Built from
   the data so it stays true as counties are added. */
function coverageText(db) {
  const groups = Object.entries(
    db.counties.reduce((g, c) => ((g[db.countyStart[c]] ||= []).push(c), g), {})
  ).sort();
  return (
    groups
      .map(
        ([d, cs]) =>
          `${cs.length === 1 ? `${titleCase(cs[0])} County's archive starts` : `the other ${apNum(cs.length)} counties' archives start`}
          with what the state showed on ${fmtDate(d)} — records back
          to ${fmtDate(windowStartOf(d))}`
      )
      .join("; ")
      .replace(/\s+/g, " ")
      .replace(/^./, (c) => c.toUpperCase()) + "."
  );
}

/* Headline numbers for whichever counties are in view. */
function statsFor(facilities) {
  const surveys = facilities.flatMap((f) => f.surveys);
  return {
    openFacilities: facilities.filter((f) => !f.closed).length,
    surveyEvents: surveys.length,
    withEnforcement: facilities.filter((f) => f.enforcementCount > 0).length,
    held: surveys.filter((s) => s.expired_from_state).length,
    documents: surveys.reduce((n, s) => n + s.docs.length, 0),
    finesTotal: facilities.reduce((n, f) => n + f.fineTotal, 0),
    newRecords: surveys.filter((s) => s.isNew).length,
  };
}
