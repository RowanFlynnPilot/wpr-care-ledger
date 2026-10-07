import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------------------------------------- vocabulary */

const SURVEY_PART_LABELS = {
  SURVEY: "Standard survey",
  COMPLAINT: "Complaint investigation",
  VV: "Follow-up visit",
  "VERIFICATION VISIT": "Verification visit",
  "SELF REPORT": "Self-report investigation",
  "DESK REVIEW": "Desk review",
};

const DOC_LABELS = {
  enforcement: "Enforcement action",
  sod: "Statement of deficiency",
  poc: "Plan of correction",
};

const TYPE_ABBR = {
  "Adult Family Home": "AFH",
  "Community Based Residential Facility": "CBRF",
  "Residential Care Apartment Complex": "RCAC",
};

const TYPE_FULL = {
  AFH: "Adult family home",
  CBRF: "Community-based residential facility",
  RCAC: "Residential care apartment complex",
};

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

/* The ledger refreshes every Monday; past this many days the data is stale
   and readers are told so rather than left to assume it is current. */
const STALE_AFTER_DAYS = 10;

/* Inside the WordPress iframe the page has no scroller of its own, and
   scrolling into view would yank the reader's article instead. */
const EMBEDDED = window.parent !== window;

/* Sanctions worth a reader's eye on the timeline (enrich.py's labels). */
const SANCTION_LABELS = {
  Revocation: "License revocation",
  "Summary suspension": "Summary suspension",
  Nonrenewal: "License nonrenewal",
  "Admissions ban": "Order not to admit new residents",
};

const DOC_ORDER = ["enforcement", "sod", "poc"];

/* Fixed locale: a German browser would otherwise print "$39.640". */
function fmtNum(n) {
  return n.toLocaleString("en-US");
}

/* Street-suffix spellings differ between licenses at one address
   ("226446 HUMMINGBIRD RD" / "226446 Hummingbird Road"). */
const STREET_ABBR = {
  ROAD: "RD", DRIVE: "DR", STREET: "ST", AVENUE: "AVE", LANE: "LN", COURT: "CT",
  BOULEVARD: "BLVD", PLACE: "PL", CIRCLE: "CIR", PARKWAY: "PKWY", HIGHWAY: "HWY",
  TRAIL: "TRL", TERRACE: "TER", NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W",
};

function surveyLabel(raw) {
  return raw
    .split("/")
    .map((p) => SURVEY_PART_LABELS[p.trim()] || titleCase(p.trim()))
    .join(" + ");
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/* Facility and operator names arrive from the state in ALL CAPS. Title-case
   them for print, preserving corporate and licensing acronyms. */
const KEEP_UPPER = new Set([
  "LLC", "LLP", "INC", "CO", "II", "III", "IV", "AFH", "CBRF", "RCAC",
  "AF", "ALF", "WI", "USA", "SLF", "HCBS",
]);
const KEEP_LOWER = new Set(["of", "and", "the", "at", "by", "for", "on", "in"]);

function smartTitle(s) {
  if (!s) return s;
  return s
    .trim()
    .split(/\s+/)
    .map((w, i) => {
      const bare = w.replace(/[^A-Za-z0-9]/g, "");
      if (KEEP_UPPER.has(bare.toUpperCase())) return w.toUpperCase();
      const lower = w.toLowerCase();
      if (i > 0 && KEEP_LOWER.has(bare.toLowerCase())) return lower;
      // Capitalize after hyphens, slashes, parens — but not apostrophes
      // (Alzheimer's, not Alzheimer'S).
      return lower.replace(/(^|[-/(])([a-z])/g, (m, p, c) => p + c.toUpperCase());
    })
    .join(" ");
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

function fmtDate(iso, month = "short") {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month,
    day: "numeric",
    year: "numeric",
  });
}

function isoUTC(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function isoMinusDays(iso, days) {
  return new Date(isoUTC(iso) - days * 86400e3).toISOString().slice(0, 10);
}

/* Start of the state's three-year public window, as of a given date. */
function windowStartOf(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const day = m === 2 && d === 29 ? 28 : d;
  return `${y - 3}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // a stray "%" in a hand-typed link must not blank the widget
  }
}

function addressKey(f) {
  return `${f.address} ${f.city}`
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .map((w) => STREET_ABBR[w] || w)
    .join("");
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
  const [sort, setSort] = useState("name");
  const [showClosed, setShowClosed] = useState(false);
  const [lens, setLens] = useState("all");
  const [open, setOpen] = useState(null);

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
      ["data/facilities.json", "data/surveys.json", "data/enrichment.json"].map((p) =>
        fetch(p).then((r) => {
          if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
          return r.json();
        })
      )
    )
      .then(([facilities, surveys, enrichment]) =>
        setDb(shape(facilities, surveys, enrichment))
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
      const m = window.location.hash.match(/^#(?:lic=([0-9A-Za-z]+)|q=(.+))$/);
      if (!m) return;
      setLens("all");
      setType("ALL");
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

  // Keep the standalone URL shareable: the open record, else the search.
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
        : window.location.pathname + window.location.search
    );
  }, [open, query, db]);

  // Search, type, and the closed toggle narrow everything; a lens then picks
  // a slice. Lens counts are computed under the same narrowing so each
  // button says exactly how many rows it will show.
  const { list, lensCounts } = useMemo(() => {
    if (!db) return { list: [], lensCounts: {} };
    const q = query.trim().toLowerCase();
    const base = db.facilities.filter(
      (f) =>
        (showClosed || !f.closed) &&
        (type === "ALL" || f.typeAbbr === type) &&
        (!q || f.haystack.includes(q))
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
  }, [db, query, type, sort, showClosed, lens]);

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

  // A dead-end search may only be hiding closed facilities — offer them.
  const hiddenClosedMatches = useMemo(() => {
    if (!db || showClosed) return 0;
    const q = query.trim().toLowerCase();
    return db.facilities.filter(
      (f) =>
        f.closed &&
        LENS_TEST[lens](f) &&
        (type === "ALL" || f.typeAbbr === type) &&
        (!q || f.haystack.includes(q))
    ).length;
  }, [db, query, type, lens, showClosed]);

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
    setType("ALL");
    setQuery(license);
    revealRow(license);
  };

  const showOperator = (name) => {
    setShowClosed(true);
    setLens("all");
    setType("ALL");
    setQuery(name);
    setOpen(null);
    requestAnimationFrame(() => briefRef.current?.focus());
  };

  const clearFilters = () => {
    setQuery("");
    setType("ALL");
    setLens("all");
    setShowClosed(false);
    setOpen(null);
  };

  // Headline stats count everything on record, closed facilities included,
  // so clicking one shows everything it counted.
  const showLensFromStat = (id) => {
    setQuery("");
    setType("ALL");
    setShowClosed(true);
    setLens(lens === id ? "all" : id);
    setOpen(null);
  };

  const staleDays = Math.floor(
    (Date.now() - isoUTC(db.stats.lastUpdated)) / 86400e3
  );

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
            Inspection and enforcement records for every state-licensed
            assisted living facility in Marathon County since mid-2023 —
            kept after Wisconsin stops showing them.
          </p>
          <p className="fresh">Updated {fmtDate(db.stats.lastUpdated, "long")}</p>
        </div>
      </header>
      <div className="flag-rule" />

      {staleDays > STALE_AFTER_DAYS && (
        <p className="stale-notice" role="note">
          <strong>This ledger is behind.</strong> It was last refreshed{" "}
          {fmtDate(db.stats.lastUpdated, "long")}. Records the state has posted
          since then may not appear here yet.
        </p>
      )}

      <dl className="stats" aria-label="Ledger totals">
        <Stat n={db.stats.openFacilities} label="facilities operating" />
        {db.stats.finesTotal > 0 ? (
          <Stat
            n={`$${fmtNum(db.stats.finesTotal)}`}
            label="in forfeitures assessed"
            tone="fine"
          />
        ) : (
          <Stat n={db.stats.surveyEvents} label="survey events on record" />
        )}
        <Stat
          n={db.stats.withEnforcement}
          label="facilities with enforcement"
          action="Show facilities with enforcement actions"
          pressed={lens === "enforcement"}
          onClick={() => showLensFromStat("enforcement")}
        />
        {db.stats.held > 0 ? (
          <Stat
            n={db.stats.held}
            label="records the state no longer shows"
            tone="held"
            action="Show facilities with records the state no longer shows"
            pressed={lens === "held"}
            onClick={() => showLensFromStat("held")}
          />
        ) : (
          <Stat n={db.stats.documents} label="documents archived" />
        )}
      </dl>

      <ActivityChart
        surveys={db.surveysAll}
        lastUpdated={db.stats.lastUpdated}
        firstPull={db.stats.firstPull}
      />

      <div className="controls">
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder="Search facility, city, operator, or license"
          aria-label="Search facilities"
          onChange={(e) => setQuery(e.target.value)}
        />
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
              (id !== "held" || db.stats.held > 0) &&
              (id !== "new" || db.stats.newRecords > 0)
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
      <p className="result-count" role="status">
        {list.length} {list.length === 1 ? "facility" : "facilities"}
      </p>

      <ol className="rows">
        {list.map((f) => (
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
        {list.length > 0 && hiddenClosedMatches > 0 && (
          <li className="closed-hint">
            {hiddenClosedMatches} closed{" "}
            {hiddenClosedMatches === 1 ? "facility also matches" : "facilities also match"}.{" "}
            <button className="clear-filters" onClick={() => setShowClosed(true)}>
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
                onClick={() => setShowClosed(true)}
              >
                Show {hiddenClosedMatches} closed{" "}
                {hiddenClosedMatches === 1 ? "facility" : "facilities"} that{" "}
                {hiddenClosedMatches === 1 ? "matches" : "match"}
              </button>
            ) : (
              <button className="clear-filters" onClick={clearFilters}>
                Clear search and filters
              </button>
            )}
          </li>
        )}
      </ol>

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
            <span className="held-inline">held in the ledger</span>. The
            archive starts with everything the state showed in July 2026 —
            records back to July 2023 — and grows every week. Earlier history
            is not included, so a facility with no records listed has none
            since mid-2023. Forfeiture amounts and rule citations are machine-read from
            the archived documents; forfeitures shown are the amounts assessed
            in enforcement letters, before any reduction for waived appeals,
            and an accruing forfeiture shows the amount assessed so far. Last
            updated {fmtDate(db.stats.lastUpdated, "long")}.
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

function ActivityChart({ surveys, lastUpdated, firstPull }) {
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
  // The archive starts at the state's window on the first pull, which can
  // fall partway through the first quarter.
  const archiveStart = windowStartOf(firstPull);
  const cutFirst =
    archiveStart > `${quarters[0].y}-${String((quarters[0].q - 1) * 3 + 1).padStart(2, "0")}-01`;
  const qMark = (i) => (filling[i] ? "*" : i === 0 && cutFirst ? "†" : "");

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
              <span className="swatch swatch-held" /> No longer on the state site
            </li>
          )}
        </ul>
      </div>
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
                ? ` A shaded area marks surveys older than the state's three-year window, which the state no longer shows and this ledger keeps.`
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
      {(filling.some(Boolean) || cutFirst) && (
        <p className="chart-note">
          {filling.some(Boolean) && (
            <span>* Still filling in: the state posts surveys weeks after they close.</span>
          )}
          {cutFirst && (
            <span>
              † The archive begins {fmtDate(archiveStart, "long")}, partway through this
              quarter.
            </span>
          )}
        </p>
      )}
      <table className="sr-only">
        <caption>Survey events per quarter</caption>
        <thead>
          <tr>
            <th scope="col">Quarter</th>
            <th scope="col">Surveys</th>
            <th scope="col">With enforcement action</th>
            <th scope="col">No longer on the state site</th>
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


/* ------------------------------------------------------------ facility row */

function FacilityRow({ f, db, query, open, onToggle, onCrossLink, onOperator }) {
  const panelId = `panel-${f.license}`;
  const [copied, setCopied] = useState(false);
  const panelRef = useRef(null);

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

  return (
    <li className={open ? "row is-open" : "row"}>
      <h3 className="row-heading">
      <button
        id={`head-${f.license}`}
        className="row-head"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
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
          {f.newCount > 0 && <span className="chip chip-new">New</span>}
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
          <span className="row-caret" aria-hidden="true">+</span>
        </span>
      </button>
      </h3>

      <div className={open ? "row-reveal is-open" : "row-reveal"}>
        <div className="row-panel" id={panelId} ref={panelRef}>
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
            <h4>
              Survey history<span className="sr-only"> for {smartTitle(f.name)}</span>
            </h4>
            {f.surveys.length === 0 ? (
              <p className="no-surveys">
                No survey records since mid-2023
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
                            <span className="new-stamp">New this week</span>
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
                              : `No longer on the state site — last seen there ${fmtDate(s.last_seen)}.`}
                          </span>
                        </>
                      )}
                      <span className="event-docs">
                        {s.docs.map((d) => (
                          <a
                            key={d.path}
                            className={`doc doc-${d.kind}`}
                            href={d.path}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {DOC_LABELS[d.kind]} (PDF)
                          </a>
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
              <button className="copy-link" onClick={copyLink}>
                {copied ? "Link copied ✓" : "Copy link to this record"}
              </button>
              <span className="sr-only" role="status">
                {copied ? "Link to this record copied" : ""}
              </span>
            </p>
          </div>
          </div>
        </div>
      </div>
    </li>
  );
}

/* Different rules can share a title (DHS 89 has two "Services" rules), so
   repeats are grouped: "Services ×2 · Tenant rights". */
function citeSummary(citations) {
  const counts = new Map();
  for (const c of citations) {
    const t = c.title.replace(/[.:]\s*$/, "");
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  const titles = [...counts].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t));
  return titles.slice(0, 3).join(" · ") + (titles.length > 3 ? ` · +${titles.length - 3} more` : "");
}

function Fact({ k, v, mono, wide }) {
  return (
    <div className={wide ? "fact fact-wide" : "fact"}>
      <dt>{k}</dt>
      <dd className={mono ? "mono" : undefined}>{v}</dd>
    </div>
  );
}

/* ----------------------------------------------------------------- shaping */

function shape(facilitiesObj, surveysObj, enrichmentObj) {
  // Join machine-read document facts onto each survey event. A survey's
  // documents map kind -> archive path; enrichment.json is keyed by that
  // same path. Kinds come from the parsed structure, not the state's grid
  // column (the state has served letters and SODs in swapped columns).
  const enrich = (s) => {
    let fine = null;
    const sanctions = [];
    const citations = [];
    let substantiated = 0;
    const seen = new Set();
    for (const path of Object.values(s.documents)) {
      const e = enrichmentObj[path];
      if (!e) continue;
      if (e.fine) fine = (fine || 0) + e.fine;
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
    return { fine, sanctions, citations, substantiated };
  };

  // Each document's kind comes from its parsed structure where the miner
  // read it; the state's column is only the fallback (plans of correction,
  // which aren't mined). One survey, 0019331, has its two links swapped.
  const docsOf = (s) =>
    Object.entries(s.documents)
      .map(([column, path]) => {
        const k = enrichmentObj[path]?.kind;
        return { kind: k === "enforcement" || k === "sod" ? k : column, path };
      })
      .sort((a, b) => DOC_ORDER.indexOf(a.kind) - DOC_ORDER.indexOf(b.kind));

  const rawSurveys = Object.values(surveysObj);
  const lastUpdated = rawSurveys.reduce((m, s) => (s.last_seen > m ? s.last_seen : m), "");
  const firstPull = rawSurveys.reduce(
    (m, s) => (m === "" || s.first_seen < m ? s.first_seen : m),
    ""
  );
  // "New this week": the record, or a document added to it later (a Notice
  // & Order often follows its SOD by weeks), was first seen after the
  // previous weekly run — strictly within 7 days of the latest refresh, so
  // last Monday's run doesn't count and a mid-week rerun doesn't erase the
  // marker. Never for the initial pull, and never while the ledger is
  // stale: then there is no "this week".
  const stale = lastUpdated && (Date.now() - isoUTC(lastUpdated)) / 86400e3 > STALE_AFTER_DAYS;
  const newSince = lastUpdated ? isoMinusDays(lastUpdated, 7) : "";
  const recent = (d) => d && d !== firstPull && d > newSince;
  const isNew = (s) =>
    !stale &&
    (recent(s.first_seen) || Object.values(s.documents_first_seen || {}).some(recent));

  const surveysAll = [];
  const surveysByLicense = {};
  for (const [id, s] of Object.entries(surveysObj)) {
    const docs = docsOf(s);
    const row = {
      ...s,
      id,
      docs,
      hasEnforcement: docs.some((d) => d.kind === "enforcement"),
      enr: enrich(s),
      isNew: isNew(s),
    };
    surveysAll.push(row);
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
    return {
      ...f,
      license,
      surveys,
      closed,
      probationary: f.licensure_status === "PROBATIONARY",
      typeAbbr: TYPE_ABBR[f.provider_type.trim()] || f.provider_type.trim(),
      enforcementCount: surveys.filter((s) => s.hasEnforcement).length,
      fineTotal: surveys.reduce((n, s) => n + (s.enr.fine || 0), 0),
      heldCount: surveys.filter((s) => s.expired_from_state).length,
      newCount: surveys.filter((s) => s.isNew).length,
      latest: surveys[0]?.exit_date || "",
      siblings: addressGroups[addressKey(f)].filter((l) => l !== license),
      haystack: [f.name, f.city, f.corporate_name, f.licensee, license, f.address]
        .join(" ")
        .toLowerCase(),
    };
  });

  const openFacilities = facilities.filter((f) => !f.closed);
  const operatorCounts = {};
  for (const f of facilities) {
    if (f.corporate_name) {
      operatorCounts[f.corporate_name] = (operatorCounts[f.corporate_name] || 0) + 1;
    }
  }
  return {
    facilities,
    byLicense: Object.fromEntries(facilities.map((f) => [f.license, f])),
    surveysAll,
    operatorCounts,
    stats: {
      openFacilities: openFacilities.length,
      surveyEvents: surveysAll.length,
      withEnforcement: new Set(
        surveysAll.filter((s) => s.hasEnforcement).map((s) => s.license)
      ).size,
      held: surveysAll.filter((s) => s.expired_from_state).length,
      documents: surveysAll.reduce((n, s) => n + s.docs.length, 0),
      finesTotal: facilities.reduce((n, f) => n + f.fineTotal, 0),
      newRecords: surveysAll.filter((s) => s.isNew).length,
      lastUpdated,
      firstPull,
    },
  };
}
