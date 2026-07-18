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

function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function addressKey(f) {
  return (f.address + f.city).toUpperCase().replace(/[^A-Z0-9]/g, "");
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
    quarters.push({ y, q, total: 0, enforcement: 0 });
  }
  const at = Object.fromEntries(quarters.map((b) => [`${b.y}-${b.q}`, b]));
  for (const s of dated) {
    const k = quarterOf(s.exit_date);
    const b = at[`${k.y}-${k.q}`];
    b.total += 1;
    if ("enforcement" in s.documents) b.enforcement += 1;
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
  const [enfOnly, setEnfOnly] = useState(false);
  const [open, setOpen] = useState(null);

  const searchRef = useRef(null);

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
      } else if (e.key === "Escape" && !typing) {
        setOpen(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Report content height to the WordPress page embedding this widget so
  // the iframe can grow and shrink with searches and expanded rows.
  useEffect(() => {
    if (window.parent === window) return;
    const post = () =>
      window.parent.postMessage(
        { type: "wpr-care-ledger:height", height: document.documentElement.scrollHeight },
        "*"
      );
    const ro = new ResizeObserver(post);
    ro.observe(document.body);
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
      if (m[1] && db.byLicense[m[1]]) {
        setShowClosed(true);
        setQuery(m[1]);
        setOpen(m[1]);
        setTimeout(() => {
          document
            .getElementById(`panel-${m[1]}`)
            ?.scrollIntoView({ block: "nearest", behavior: "auto" });
        }, 120);
      } else if (m[2]) {
        setQuery(decodeURIComponent(m[2]));
      }
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [db]);

  // Keep the standalone URL shareable: reflect the open row in the hash.
  useEffect(() => {
    if (!db) return;
    window.history.replaceState(
      null,
      "",
      open ? `#lic=${open}` : window.location.pathname + window.location.search
    );
  }, [open, db]);

  const list = useMemo(() => {
    if (!db) return [];
    const q = query.trim().toLowerCase();
    let rows = db.facilities.filter((f) => {
      if (!showClosed && f.closed) return false;
      if (enfOnly && f.enforcementCount === 0) return false;
      if (type !== "ALL" && f.typeAbbr !== type) return false;
      if (!q) return true;
      return f.haystack.includes(q);
    });
    const bySort = {
      name: (a, b) => a.name.localeCompare(b.name),
      recent: (a, b) => (b.latest || "").localeCompare(a.latest || ""),
      enforcement: (a, b) =>
        b.enforcementCount - a.enforcementCount || a.name.localeCompare(b.name),
    };
    return rows.sort(bySort[sort]);
  }, [db, query, type, sort, showClosed, enfOnly]);

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
        (!enfOnly || f.enforcementCount > 0) &&
        (type === "ALL" || f.typeAbbr === type) &&
        (!q || f.haystack.includes(q))
    ).length;
  }, [db, query, type, enfOnly, showClosed]);

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
    // Standalone view: bring the record into view once it renders. Inside
    // the auto-height iframe there is no inner scroller, so this no-ops.
    setTimeout(() => {
      document.getElementById(`panel-${license}`)?.scrollIntoView({
        block: "nearest",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    }, 80);
  };

  const crossLink = (license) => {
    setShowClosed(true);
    setQuery(license);
    revealRow(license);
  };

  const showOperator = (name) => {
    setShowClosed(true);
    setEnfOnly(false);
    setQuery(name);
    setOpen(null);
  };

  const clearFilters = () => {
    setQuery("");
    setType("ALL");
    setEnfOnly(false);
    setShowClosed(false);
    setOpen(null);
  };

  return (
    <div className="ledger">
      <header className="masthead">
        <div className="masthead-brand">
          <img
            className="badge"
            src="brand/wpr-typewriter.png"
            alt="Wausau Pilot &amp; Review — More News. Less Fluff. All Local."
            width="84"
            height="84"
          />
          <div className="masthead-text">
            <p className="eyebrow">
              <span>
                Wausau Pilot &amp; Review <span className="sep">·</span>{" "}
                Marathon County
              </span>
              <span className="eyebrow-date">
                Updated {fmtDate(db.stats.lastUpdated)}
              </span>
            </p>
            <h1>The Care Ledger</h1>
          </div>
        </div>
        <p className="dek">
          Every state-licensed assisted living facility in Marathon County,
          with its complete inspection and enforcement record. Wisconsin only
          shows the public three years of history — this ledger keeps all of
          it, permanently.
        </p>
        <dl className="stats" aria-label="Ledger totals">
          <Stat n={db.stats.openFacilities} label="facilities operating" />
          {db.stats.finesTotal > 0 ? (
            <Stat
              n={`$${db.stats.finesTotal.toLocaleString()}`}
              label="in forfeitures assessed"
              fine
            />
          ) : (
            <Stat n={db.stats.surveyEvents} label="survey events on record" />
          )}
          <Stat n={db.stats.withEnforcement} label="facilities with enforcement" />
          {db.stats.held > 0 ? (
            <Stat n={db.stats.held} label="records the state no longer shows" held />
          ) : (
            <Stat n={db.stats.documents} label="documents archived" />
          )}
        </dl>
      </header>

      <ActivityChart surveys={db.surveysFlat} lastUpdated={db.stats.lastUpdated} />

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
        </select>
        <label className="closed-toggle">
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(e) => setShowClosed(e.target.checked)}
          />
          Include closed
        </label>
        <label className="closed-toggle">
          <input
            type="checkbox"
            checked={enfOnly}
            onChange={(e) => setEnfOnly(e.target.checked)}
          />
          Enforcement only
        </label>
      </div>

      {operatorBrief && (
        <aside className="operator-brief">
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
                · <strong>${operatorBrief.fines.toLocaleString()} assessed</strong>
              </>
            )}
          </p>
        </aside>
      )}

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

      <footer className="methodology">
        <p>
          <strong>About this data.</strong> Compiled from the Wisconsin
          Department of Health Services Division of Quality Assurance (DQA)
          Provider Search, which shows only the past three years of survey
          history. The Care Ledger checks the state record weekly, archives
          every statement of deficiency, enforcement action, and plan of
          correction, and retains records after the state stops showing them
          — those entries are marked{" "}
          <span className="held-inline">held in the ledger</span>, as are
          older records recovered from Internet Archive crawls of the state
          site. A facility with no records listed has none in the
          state&rsquo;s current three-year window; that is not a statement
          about its earlier history. Forfeiture amounts and rule citations are machine-read
          from the archived documents; forfeitures shown are the amounts
          assessed in enforcement letters, before any reduction for waived
          appeals. Last updated {fmtDate(db.stats.lastUpdated)}.
        </p>
        <p>
          Questions or corrections:{" "}
          <a href="mailto:editor@wausaupilotandreview.com">
            editor@wausaupilotandreview.com
          </a>
          .
        </p>
        <p className="credit">
          <img src="brand/wpr-typewriter-192.png" alt="" width="28" height="28" />
          <span>
            A{" "}
            <a
              href="https://wausaupilotandreview.com"
              target="_blank"
              rel="noopener noreferrer"
            >
              Wausau Pilot &amp; Review
            </a>{" "}
            watchdog project
          </span>
        </p>
      </footer>
    </div>
  );
}

function Stat({ n, label, held, fine }) {
  const cls = held ? "stat stat-held" : fine ? "stat stat-fine" : "stat";
  return (
    <div className={cls}>
      <dt>{label}</dt>
      <dd>{typeof n === "number" ? n.toLocaleString() : n}</dd>
    </div>
  );
}

/* ------------------------------------------------------- activity chart */

const CHART = { TOP: 22, PLOT: 150, BASE: 172, Q_Y: 187, YEAR_Y: 204, H: 210 };

function ActivityChart({ surveys, lastUpdated }) {
  const [hover, setHover] = useState(null);
  const { quarters, max } = useMemo(() => bucketQuarters(surveys), [surveys]);
  if (quarters.length < 2) return null;

  const n = quarters.length;
  const slot = 100 / n;
  const barW = slot * 0.6;
  const inset = (slot - barW) / 2;
  const hOf = (v) => (v / max) * CHART.PLOT;
  const center = (i) => `${i * slot + slot / 2}%`;

  // The ledger updates weekly, so the newest quarter is usually mid-flight.
  const nowQ = quarterOf(lastUpdated);
  const lastQ = quarters[n - 1];
  const partial = lastQ.y === nowQ.y && lastQ.q === nowQ.q;

  const gridStep = max > 12 ? 5 : max > 6 ? 3 : 2;
  const gridLines = [];
  for (let v = gridStep; v < max; v += gridStep) gridLines.push(v);

  const years = [];
  quarters.forEach((b, i) => {
    const cur = years[years.length - 1];
    if (!cur || cur.y !== b.y) years.push({ y: b.y, from: i, to: i });
    else cur.to = i;
  });

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
            {`Survey events per quarter from ${quarters[0].y} through ${quarters[n - 1].y}, with the number that carried an enforcement action shown in red. Full figures in the table that follows.`}
          </desc>
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
            const dim = partial && i === n - 1 ? 0.5 : 1;
            return (
              <g key={`${b.y}q${b.q}`} fillOpacity={dim}>
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
                <text className="bar-label" x={center(i)} y={top - 6} textAnchor="middle" fillOpacity="1">
                  {b.total}
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
              {`Q${b.q}${partial && i === n - 1 ? "*" : ""}`}
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
          </div>
        )}
      </div>
      {partial && (
        <p className="chart-note">* Latest quarter still in progress</p>
      )}
      <table className="sr-only">
        <caption>Survey events per quarter</caption>
        <thead>
          <tr>
            <th scope="col">Quarter</th>
            <th scope="col">Surveys</th>
            <th scope="col">With enforcement action</th>
          </tr>
        </thead>
        <tbody>
          {quarters.map((b) => (
            <tr key={`sr-${b.y}q${b.q}`}>
              <th scope="row">{`Q${b.q} ${b.y}`}</th>
              <td>{b.total}</td>
              <td>{b.enforcement}</td>
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
      <button
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
              {f.fineTotal > 0 && ` · $${f.fineTotal.toLocaleString()}`}
            </span>
          )}
          {f.probationary && <span className="chip chip-probation">Probationary</span>}
          {f.heldCount > 0 && <span className="chip chip-held">{f.heldCount} held</span>}
          {f.closed && <span className="chip chip-closed">Closed</span>}
          <span className="row-caret" aria-hidden="true">+</span>
        </span>
      </button>

      <div className={open ? "row-reveal is-open" : "row-reveal"}>
        <div className="row-panel" id={panelId} inert={open ? undefined : ""}>
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
                <span className="sum-enf">
                  ${f.fineTotal.toLocaleString()} assessed
                </span>
              )}
              {f.latest && <span>last visit {fmtDate(f.latest)}</span>}
            </p>
          )}
          <div className="panel-grid">
          <div className="facts">
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
            {f.date_regular && <Fact k="Licensed" v={fmtDate(f.date_regular)} mono />}
            {f.date_closed && <Fact k="Closed" v={fmtDate(f.date_closed)} mono />}
            <Fact k="Serves" v={f.client_groups ? smartTitle(f.client_groups) : "—"} wide />
            {f.siblings.length > 0 && (
              <div className="fact fact-wide">
                <dt>Also licensed at this address</dt>
                <dd>
                  {f.siblings.map((lic) => {
                    const s = db.byLicense[lic];
                    return (
                      <button key={lic} className="sibling" onClick={() => onCrossLink(lic)}>
                        {smartTitle(s.name)}
                        {s.date_closed
                          ? ` (closed ${fmtDate(s.date_closed)})`
                          : s.date_regular
                          ? ` (licensed ${fmtDate(s.date_regular)})`
                          : ""}
                      </button>
                    );
                  })}
                </dd>
              </div>
            )}
          </div>

          <div className="history">
            <h2>Survey history</h2>
            {f.surveys.length === 0 ? (
              <p className="no-surveys">
                No survey records in the state&rsquo;s current three-year
                window{f.date_regular ? ` — licensed ${fmtDate(f.date_regular)}` : ""}.
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
                          <span className="event-fine">
                            ${s.enr.fine.toLocaleString()} forfeiture
                          </span>
                        )}
                        {s.first_seen === db.stats.lastUpdated &&
                          s.first_seen !== db.stats.firstPull && (
                            <span className="new-stamp">New this update</span>
                          )}
                      </span>
                      {(s.enr.substantiated > 0 || s.enr.citations.length > 0) && (
                        <span className="event-cites">
                          {s.enr.substantiated > 0 && (
                            <strong>
                              Complaint substantiated
                              {s.enr.citations.length > 0 && " · "}
                            </strong>
                          )}
                          {s.enr.citations.length > 0 && (
                            <>
                              Cited:{" "}
                              {s.enr.citations
                                .slice(0, 3)
                                .map((c) => c.title.replace(/[.:]\s*$/, ""))
                                .join(" · ")}
                              {s.enr.citations.length > 3 &&
                                ` · +${s.enr.citations.length - 3} more`}
                            </>
                          )}
                        </span>
                      )}
                      {s.expired_from_state && (
                        <span className="held-stamp">
                          {s.source && s.source.startsWith("wayback")
                            ? "Recovered via the Internet Archive · held in the ledger"
                            : "No longer shown by the state · held in the ledger"}
                        </span>
                      )}
                      <span className="event-docs">
                        {Object.entries(s.documents).map(([kind, path]) => (
                          <a
                            key={kind}
                            className={`doc doc-${kind}`}
                            href={path}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {DOC_LABELS[kind]} (PDF)
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
              <button className="copy-link" aria-live="polite" onClick={copyLink}>
                {copied ? "Link copied ✓" : "Copy link to this record"}
              </button>
            </p>
          </div>
          </div>
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

  const surveysByLicense = {};
  for (const [id, s] of Object.entries(surveysObj)) {
    (surveysByLicense[s.license] ||= []).push({ ...s, id, enr: enrich(s) });
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
      enforcementCount: surveys.filter((s) => "enforcement" in s.documents).length,
      fineTotal: surveys.reduce((n, s) => n + (s.enr.fine || 0), 0),
      heldCount: surveys.filter((s) => s.expired_from_state).length,
      latest: surveys[0]?.exit_date || "",
      siblings: addressGroups[addressKey(f)].filter((l) => l !== license),
      haystack: [f.name, f.city, f.corporate_name, f.licensee, license, f.address]
        .join(" ")
        .toLowerCase(),
    };
  });

  const openFacilities = facilities.filter((f) => !f.closed);
  const allSurveys = Object.values(surveysObj);
  const operatorCounts = {};
  for (const f of facilities) {
    if (f.corporate_name) {
      operatorCounts[f.corporate_name] = (operatorCounts[f.corporate_name] || 0) + 1;
    }
  }
  return {
    facilities,
    byLicense: Object.fromEntries(facilities.map((f) => [f.license, f])),
    surveysFlat: allSurveys,
    operatorCounts,
    stats: {
      openFacilities: openFacilities.length,
      surveyEvents: allSurveys.length,
      withEnforcement: new Set(
        allSurveys.filter((s) => "enforcement" in s.documents).map((s) => s.license)
      ).size,
      held: allSurveys.filter((s) => s.expired_from_state).length,
      documents: allSurveys.reduce((n, s) => n + Object.keys(s.documents).length, 0),
      finesTotal: facilities.reduce((n, f) => n + f.fineTotal, 0),
      lastUpdated: allSurveys.reduce((m, s) => (s.last_seen > m ? s.last_seen : m), ""),
      firstPull: allSurveys.reduce(
        (m, s) => (m === "" || s.first_seen < m ? s.first_seen : m),
        ""
      ),
    },
  };
}
