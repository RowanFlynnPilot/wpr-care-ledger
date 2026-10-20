import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DOC_LABELS,
  SUPPORT_URL,
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

/* The terms the ledger prints, in plain English, grouped as a reader meets
   them. Labels match SURVEY_PART_LABELS, DOC_LABELS and SANCTION_LABELS. */
const GLOSSARY = [
  ["Inspections", [
    ["Survey", "An inspection by the state Division of Quality Assurance. The date shown is the exit date, the last day inspectors were on site."],
    ["Standard survey", "A routine licensing inspection of the whole facility."],
    ["Complaint investigation", "An inspection prompted by a complaint from a resident, family member, employee or anyone else."],
    ["Self-report investigation", "An inspection of an incident the facility itself reported to the state, as it is required to."],
    ["Verification visit / Follow-up visit", "A return inspection to check whether the facility fixed what it was cited for."],
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
    ["Order not to admit new residents", "A ban on taking new residents until the state lifts it — among the most serious steps short of closing a facility."],
    ["License revocation", "The state moving to take away the facility's license. A facility can appeal."],
    ["Revisit fee", "A fee the facility pays for the inspection that checks its corrections."],
  ]],
  ["Facilities and licenses", [
    ["Adult family home (AFH)", "A home where three or four adults not related to the operator live and receive care. The ledger covers these 3–4 bed homes."],
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
    ["license", "facility", "type", "address", "city", "zip", "county", "license_status",
     "closed", "date_closed", "operator", "licensee", "capacity", "surveys",
     "enforcement_actions", "fines_assessed", "records_state_no_longer_shows",
     "latest_survey", "ledger_record", "facility_page", "state_page_archived"],
    list.map((f) => [
      f.license, f.name, TYPE_FULL[f.typeAbbr], f.address, f.city, f.zip, f.county,
      f.licensure_status, yesNo(f.closed), f.date_closed, f.corporate_name, f.licensee,
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
      ["data/facilities.json", "data/surveys.json", "data/enrichment.json", "data/wayback.json"].map(
        (p) =>
          fetch(p).then((r) => {
            if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
            return r.json();
          })
      )
    )
      .then(([facilities, surveys, enrichment, wayback]) =>
        setDb(shape(facilities, surveys, enrichment, wayback))
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
    return () => ro.disconnect();
  }, []);

  // Deep links: #lic=0015628 opens one facility (closed included so links
  // to closed licenses always resolve); #q=text presets the search box.
  // Applied at load and on later hash changes (replaceState below doesn't
  // fire hashchange, so reflecting the open row can't loop back here).
  useEffect(() => {
    if (!db) return;
    const apply = () => {
      const m = window.location.hash.match(
        /^#(?:lic=([0-9A-Za-z]+)|q=(.+)|county=([A-Za-z]+))$/
      );
      if (!m) return;
      setLens("all");
      setType("ALL");
      setCategory(null);
      if (m[3]) {
        const c = db.counties.find((x) => x === m[3].toUpperCase());
        setCounty(c || "ALL");
        return;
      }
      setCounty("ALL");
      if (m[1]) {
        // An unknown license (or one missing its leading zeros) becomes a
        // search, so the reader sees a match or an honest "no match".
        setShowClosed(true);
        setQuery(m[1]);
        if (db.byLicense[m[1]]) {
          setOpen(m[1]);
          if (!EMBEDDED) {
            setTimeout(() => {
              document
                .getElementById(`panel-${m[1]}`)
                ?.scrollIntoView({ block: "nearest", behavior: "auto" });
            }, 120);
          }
        }
      } else {
        setQuery(safeDecode(m[2].replace(/\+/g, " ")));
      }
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [db]);

  // Keep the standalone URL shareable: the open record, else the search,
  // else the county.
  useEffect(() => {
    if (!db) return;
    const q = query.trim();
    window.history.replaceState(
      null,
      "",
      open
        ? `#lic=${open}`
        : q
        ? `#q=${encodeURIComponent(q)}`
        : county !== "ALL"
        ? `#county=${titleCase(county)}`
        : window.location.pathname + window.location.search
    );
  }, [open, query, county, db]);

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
        <img src="brand/wpr-typewriter.png" alt="" width="52" height="52" />
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
    revealRow(license);
  };

  // Operators run facilities across county lines; show all of them.
  const showOperator = (name) => {
    setShowClosed(true);
    setLens("all");
    setCategory(null);
    setType("ALL");
    setCounty("ALL");
    setQuery(name);
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
    requestAnimationFrame(() => {
      if (!EMBEDDED) countRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
      countRef.current?.focus({ preventScroll: true });
    });
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
          src="brand/wpr-typewriter.png"
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
              src="brand/wpr-wordmark.png"
              alt="Wausau Pilot &amp; Review"
              width="133"
              height="17"
            />
          </a>
          <h1>The Care Ledger</h1>
          <p className="dek">
            Inspection and enforcement records since 2023 for every
            state-licensed assisted living facility in Marathon County and the
            eight counties around it — kept after Wisconsin stops showing them.
          </p>
          <p className="fresh">Updated {fmtDate(db.lastUpdated, "long")}</p>
        </div>
      </header>
      <div className="flag-rule" />

      {staleDays > STALE_AFTER_DAYS && (
        <p className="stale-notice" role="note">
          <strong>This ledger is behind.</strong> It was last refreshed{" "}
          {fmtDate(db.lastUpdated, "long")}. Records the state has posted
          since then may not appear here yet.
        </p>
      )}

      <dl className="stats" aria-label="Ledger totals">
        <Stat n={stats.openFacilities} label="facilities operating" />
        {stats.finesTotal > 0 ? (
          <Stat
            n={`$${fmtNum(stats.finesTotal)}`}
            label="in forfeitures assessed"
            tone="fine"
          />
        ) : (
          <Stat n={stats.surveyEvents} label="survey events on record" />
        )}
        <Stat
          n={stats.withEnforcement}
          label="facilities with enforcement"
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

      <ActivityChart surveys={scopedSurveys} lastUpdated={db.lastUpdated} coverage={coverage} />

      <CitationChart
        surveys={scopedSurveys}
        total={scoped.length}
        active={category}
        onPick={pickCategory}
      />

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
          <option value="CBRF">CBRF — community-based</option>
          <option value="RCAC">RCAC — care apartments</option>
          <option value="AFH">AFH — adult family home</option>
        </select>
        <select value={sort} aria-label="Sort order" onChange={(e) => setSort(e.target.value)}>
          <option value="name">A to Z</option>
          <option value="recent">Latest activity</option>
          <option value="enforcement">Most enforcement</option>
          <option value="fines">Most forfeitures</option>
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

      <ol className="rows">
        {list.slice(0, shown).map((f) => (
          <FacilityRow
            key={f.license}
            f={f}
            db={db}
            query={query.trim()}
            open={open === f.license}
            onToggle={() => setOpen(open === f.license ? null : f.license)}
            onCrossLink={crossLink}
            onOperator={showOperator}
          />
        ))}
        {list.length > shown && (
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

      <Glossary />

      <footer className="site-footer">
        <img
          className="footer-seal"
          src="brand/wpr-typewriter-192.png"
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
            plan of correction, and keeps records after the state stops
            showing them — those entries are marked{" "}
            <span className="held-inline">held in the ledger</span>. Covers
            Marathon County and its neighbors: {db.counties
              .filter((c) => c !== "MARATHON")
              .map(titleCase)
              .join(", ")}
            . {coverageText(db)} Each archive grows every week; earlier history
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
            {fmtDate(db.lastUpdated, "long")}.
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
      ? `† The archive begins ${fmtDate(startGroups[0][0], "long")}, partway through this quarter.`
      : `† Partly covered: the archive begins ${startGroups
          .map(
            ([d, cs]) =>
              `${fmtDate(d, "long")} for ${
                cs.length === 1 ? `${titleCase(cs[0])} County` : `the other ${cs.length} counties`
              }`
          )
          .join(" and ")}.`;

  const gridStep = max > 12 ? 5 : max > 6 ? 3 : 2;
  const gridLines = [];
  for (let v = gridStep; v < max; v += gridStep) gridLines.push(v);

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
        <h2 id="activity-title">Survey activity by quarter</h2>
        <ul className="legend">
          <li>
            <span className="swatch swatch-enf" /> Enforcement action
          </li>
          <li>
            <span className="swatch swatch-plain" /> No enforcement
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
          {fmtNum(enforcedTotal)} of {fmtNum(surveys.length)} surveys (
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
            {`Survey events per quarter from ${quarters[0].y} through ${quarters[n - 1].y}, with the number that carried an enforcement action shown in red.${
              boundary !== null && anyHeld
                ? ` A shaded area marks surveys older than the state's three-year window, which the state no longer lists and this ledger keeps.`
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
          {gridLines.map((v) => (
            <line
              key={`grid-${v}`}
              className="gridline"
              x1="0"
              x2="100%"
              y1={CHART.BASE - hOf(v)}
              y2={CHART.BASE - hOf(v)}
            />
          ))}
          {hover !== null && (
            <rect
              x={`${hover * slot}%`}
              width={`${slot}%`}
              y={CHART.TOP - 16}
              height={CHART.BASE - CHART.TOP + 16}
              fill="var(--paper-shade)"
            />
          )}
          {quarters.map((b, i) => {
            const x = `${i * slot + inset}%`;
            const w = `${barW}%`;
            const enfH = hOf(b.enforcement);
            const plainH = hOf(b.total - b.enforcement);
            const gap = b.enforcement > 0 && b.total > b.enforcement ? 2 : 0;
            const top = CHART.BASE - enfH - gap - plainH;
            return (
              <g key={`${b.y}q${b.q}`}>
                {b.enforcement > 0 && (
                  <rect
                    x={x}
                    width={w}
                    y={CHART.BASE - enfH}
                    height={enfH}
                    rx={gap ? 0 : 2}
                    fill="var(--red)"
                  />
                )}
                {b.total - b.enforcement > 0 && (
                  <rect x={x} width={w} y={top} height={plainH} rx="2" fill="#767676" />
                )}
                <text className="bar-label" x={center(i)} y={top - 6} textAnchor="middle">
                  {`${b.total}${qMark(i)}`}
                </text>
                {b.enforcement > 0 && enfH >= 15 && (
                  <text
                    className="bar-label-inner"
                    x={center(i)}
                    y={CHART.BASE - enfH / 2 + 3.5}
                    textAnchor="middle"
                  >
                    {b.enforcement}
                  </text>
                )}
              </g>
            );
          })}
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
                State&rsquo;s 3-year window ▸
              </text>
            </>
          )}
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
            · {tip.total} {tip.total === 1 ? "survey" : "surveys"} ·{" "}
            {tip.enforcement} enforcement
            {tip.held > 0 && ` · ${tip.held} held in the ledger`}
          </div>
        )}
      </div>
      {(filling.some(Boolean) || partial.some(Boolean)) && (
        <p className="chart-note">
          {filling.some(Boolean) && (
            <span>* Still filling in: the state posts surveys weeks after they close.</span>
          )}
          {partial.some(Boolean) && <span>{partialNote}</span>}
        </p>
      )}
      <table className="sr-only">
        <caption>Survey events per quarter</caption>
        <thead>
          <tr>
            <th scope="col">Quarter</th>
            <th scope="col">Surveys</th>
            <th scope="col">With enforcement action</th>
            <th scope="col">No longer listed by the state</th>
          </tr>
        </thead>
        <tbody>
          {quarters.map((b) => (
            <tr key={`sr-${b.y}q${b.q}`}>
              <th scope="row">{`Q${b.q} ${b.y}`}</th>
              <td>{b.total}</td>
              <td>{b.enforcement}</td>
              <td>{b.held}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/* What inspectors cite: facilities cited at least once in each area, from
   the categories enrich.py gives every cited rule. One measure across
   categories, sorted, every bar labeled -- so plain rows, not a plot. */
function CitationChart({ surveys, total, active, onPick }) {
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
  const max = rows[0].facilities;

  return (
    <figure className="cites">
      <div className="activity-head">
        <h2 id="cites-title">What inspectors cite</h2>
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
                <span className="cites-bar" style={{ width: `${(r.facilities / max) * 100}%` }} />
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
          From the rules cited in statements of deficiency since each county&rsquo;s archive
          began. A facility counts once per area however often it was cited.
        </span>
      </p>
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
        <img className="badge" src="brand/wpr-typewriter.png" alt="" width="44" height="44" />
        <div className="masthead-text">
          <a
            className="wordmark-link"
            href="https://wausaupilotandreview.com/"
            target="_blank"
            rel="noopener noreferrer"
          >
            <img
              className="wordmark"
              src="brand/wpr-wordmark.png"
              alt="Wausau Pilot &amp; Review"
              width="133"
              height="17"
            />
          </a>
          <p className="single-title">
            The Care Ledger <span className="fresh">· updated {fmtDate(db.lastUpdated, "long")}</span>
          </p>
        </div>
      </header>
      <div className="flag-rule" />

      {staleDays > STALE_AFTER_DAYS && (
        <p className="stale-notice" role="note">
          <strong>This ledger is behind.</strong> It was last refreshed{" "}
          {fmtDate(db.lastUpdated, "long")}.
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

      <p className="single-foot">
        <a href={f ? `${LEDGER_URL}#lic=${f.license}` : LEDGER_URL} target="_blank" rel="noopener noreferrer">
          See all {db.facilities.length} facilities in The Care Ledger
        </a>{" "}
        · Records from the Wisconsin DHS Division of Quality Assurance, kept after the state stops
        showing them. Not affiliated with DHS. Wausau Pilot &amp; Review · 715-301-5539 ·{" "}
        <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
          Support this work
        </a>
      </p>
    </div>
  );
}

/* ------------------------------------------------------------ facility row */

function FacilityRow({ f, db, query, open, single, onToggle, onCrossLink, onOperator }) {
  const panelId = `panel-${f.license}`;
  const HistoryHeading = single ? "h3" : "h4";
  const [copied, setCopied] = useState(false);
  const panelRef = useRef(null);
  // Render a record's panel on first open, then keep it mounted so the
  // reveal can animate both ways: 300+ hidden timelines on load would cost
  // phones tens of thousands of DOM nodes.
  const everOpened = useRef(false);
  if (open) everOpened.current = true;

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
      matchNote = { label: "address", value: titleCase(f.address) };
    }
  }

  const copyLink = () => {
    const url = `${window.location.origin}${window.location.pathname}#lic=${f.license}`;
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
            {f.latest && <> · last survey {fmtDate(f.latest)}</>}
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
              {f.enforcementCount} enforcement
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
          {f.heldCount > 0 && <span className="chip chip-held">{f.heldCount} held</span>}
          {f.closed && <span className="chip chip-closed">Closed</span>}
          {!single && <span className="row-caret" aria-hidden="true">+</span>}
        </span>
    </>
  );

  return (
    <li className={open ? "row is-open" : "row"}>
      {single ? (
        // One record alone: it is the page's subject, always open.
        <h2 className="row-heading">
          <span id={`head-${f.license}`} className="row-head row-head-static">
            {head}
          </span>
        </h2>
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
                {f.surveys.length} {f.surveys.length === 1 ? "survey" : "surveys"} on
                record
              </span>
              {f.enforcementCount > 0 && (
                <span className="sum-enf">{f.enforcementCount} enforcement</span>
              )}
              {f.fineTotal > 0 && (
                <span className="sum-enf">${fmtNum(f.fineTotal)} assessed</span>
              )}
              {f.latest && <span>latest survey {fmtDate(f.latest)}</span>}
            </p>
          )}
          <div className="panel-grid">
          <dl className="facts">
            <Fact k="Facility type" v={TYPE_FULL[f.typeAbbr]} />
            <Fact k="Address" v={`${titleCase(f.address)}, ${titleCase(f.city)} ${f.zip}`} />
            <Fact k="County" v={titleCase(f.county)} />
            <Fact k="License" v={f.license} mono />
            <Fact k="Status" v={titleCase(f.licensure_status || "")} />
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
            <Fact k="Ownership" v={f.ownership_type || "—"} />
            {(f.date_regular || f.date_probationary) && (
              <Fact k="Licensed" v={fmtDate(f.date_regular || f.date_probationary)} mono />
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
                    const licensed = s.date_regular || s.date_probationary;
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
          </dl>

          <div className="history">
            {/* An h4 under each row's h3; the single-facility embed's record
                heading is an h2, so its history is an h3. */}
            <HistoryHeading className="history-heading">
              Survey history<span className="sr-only"> for {smartTitle(f.name)}</span>
            </HistoryHeading>
            {f.surveys.length === 0 ? (
              <p className="no-surveys">
                {/* The archive begins at the state's window on the county's
                    first capture: July 2023 for Marathon, October for the rest. */}
                No survey records since {fmtDate(windowStartOf(db.countyStart[f.county]))}
                {f.date_regular || f.date_probationary
                  ? ` — licensed ${fmtDate(f.date_regular || f.date_probationary)}`
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
                              Complaint substantiated
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
   2026 — records back to July 12, 2023; the other 8 counties' …". Built from
   the data so it stays true as counties are added. */
function coverageText(db) {
  const groups = Object.entries(
    db.counties.reduce((g, c) => ((g[db.countyStart[c]] ||= []).push(c), g), {})
  ).sort();
  return (
    groups
      .map(
        ([d, cs]) =>
          `${cs.length === 1 ? `${titleCase(cs[0])} County's` : `the other ${cs.length} counties'`}
          archive starts with what the state showed on ${fmtDate(d, "long")} — records back
          to ${fmtDate(windowStartOf(d), "long")}`
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
