import React, { useEffect, useMemo, useState } from "react";

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
  "AF", "ALF", "WI", "USA", "SLF",
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
      return lower.replace(/(^|[-/('’])([a-z])/g, (m, p, c) => p + c.toUpperCase());
    })
    .join(" ");
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

/* ------------------------------------------------------------------- app */

export default function App() {
  const [db, setDb] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("ALL");
  const [sort, setSort] = useState("name");
  const [showClosed, setShowClosed] = useState(false);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    Promise.all(
      ["data/facilities.json", "data/surveys.json"].map((p) =>
        fetch(p).then((r) => {
          if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
          return r.json();
        })
      )
    )
      .then(([facilities, surveys]) => setDb(shape(facilities, surveys)))
      .catch((e) => setError(e.message));
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

  const list = useMemo(() => {
    if (!db) return [];
    const q = query.trim().toLowerCase();
    let rows = db.facilities.filter((f) => {
      if (!showClosed && f.closed) return false;
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
  }, [db, query, type, sort, showClosed]);

  if (error)
    return (
      <div className="ledger">
        <p className="load-error">
          The ledger data didn&rsquo;t load ({error}). Reload the page to try
          again.
        </p>
      </div>
    );
  if (!db) return <div className="ledger loading">Opening the ledger…</div>;

  const crossLink = (license) => {
    setShowClosed(true);
    setQuery(license);
    setOpen(license);
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
          <div>
            <p className="eyebrow">
              Wausau Pilot &amp; Review <span className="sep">·</span> Marathon
              County
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
          <Stat n={db.stats.surveyEvents} label="survey events on record" />
          <Stat n={db.stats.withEnforcement} label="facilities with enforcement" />
          {db.stats.held > 0 ? (
            <Stat n={db.stats.held} label="records the state no longer shows" held />
          ) : (
            <Stat n={db.stats.documents} label="documents archived" />
          )}
        </dl>
      </header>

      <div className="controls">
        <input
          type="search"
          value={query}
          placeholder="Search by facility, city, operator, or license number"
          aria-label="Search facilities"
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={type} aria-label="Facility type" onChange={(e) => setType(e.target.value)}>
          <option value="ALL">All types</option>
          <option value="CBRF">CBRF</option>
          <option value="RCAC">RCAC</option>
          <option value="AFH">Adult family home</option>
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
      </div>

      <p className="result-count" role="status">
        {list.length} {list.length === 1 ? "facility" : "facilities"}
      </p>

      <ol className="rows">
        {list.map((f) => (
          <FacilityRow
            key={f.license}
            f={f}
            db={db}
            open={open === f.license}
            onToggle={() => setOpen(open === f.license ? null : f.license)}
            onCrossLink={crossLink}
          />
        ))}
        {list.length === 0 && (
          <li className="empty">
            No facilities match. Clear the search or include closed
            facilities.
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
          <span className="held-inline">held in the ledger</span>. A facility
          with no records listed has none in the state&rsquo;s current
          three-year window; that is not a statement about its earlier
          history. Last updated {fmtDate(db.stats.lastUpdated)}.
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

function Stat({ n, label, held }) {
  return (
    <div className={held ? "stat stat-held" : "stat"}>
      <dt>{label}</dt>
      <dd>{n.toLocaleString()}</dd>
    </div>
  );
}

/* ------------------------------------------------------------ facility row */

function FacilityRow({ f, db, open, onToggle, onCrossLink }) {
  const panelId = `panel-${f.license}`;
  return (
    <li className={open ? "row is-open" : "row"}>
      <button
        className="row-head"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <span className="row-main">
          <span className="row-name">{smartTitle(f.name)}</span>
          <span className="row-meta">
            {f.typeAbbr} · {titleCase(f.city)} · {f.capacity} beds
          </span>
        </span>
        <span className="row-chips">
          {f.enforcementCount > 0 && (
            <span className="chip chip-enforcement">
              {f.enforcementCount} enforcement
            </span>
          )}
          {f.probationary && <span className="chip chip-probation">Probationary</span>}
          {f.heldCount > 0 && <span className="chip chip-held">{f.heldCount} held</span>}
          {f.closed && <span className="chip chip-closed">Closed</span>}
          <span className="row-caret" aria-hidden="true">{open ? "–" : "+"}</span>
        </span>
      </button>

      {open && (
        <div className="row-panel" id={panelId}>
          <div className="facts">
            <Fact k="Facility type" v={TYPE_FULL[f.typeAbbr]} />
            <Fact k="Address" v={`${titleCase(f.address)}, ${titleCase(f.city)} ${f.zip}`} />
            <Fact k="License" v={f.license} mono />
            <Fact k="Status" v={titleCase(f.licensure_status || "")} />
            <Fact k="Operator" v={f.corporate_name ? smartTitle(f.corporate_name) : "—"} />
            <Fact k="Ownership" v={f.ownership_type || "—"} />
            {f.date_regular && <Fact k="Licensed" v={fmtDate(f.date_regular)} mono />}
            {f.date_closed && <Fact k="Closed" v={fmtDate(f.date_closed)} mono />}
            <Fact k="Serves" v={titleCase(f.client_groups || "—")} wide />
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
                      <span className="event-type">{surveyLabel(s.survey_type)}</span>
                      {s.expired_from_state && (
                        <span className="held-stamp">
                          No longer shown by the state · held in the ledger
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
            </p>
          </div>
        </div>
      )}
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

function shape(facilitiesObj, surveysObj) {
  const surveysByLicense = {};
  for (const [id, s] of Object.entries(surveysObj)) {
    (surveysByLicense[s.license] ||= []).push({ ...s, id });
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
      heldCount: surveys.filter((s) => s.expired_from_state).length,
      latest: surveys[0]?.exit_date || "",
      siblings: addressGroups[addressKey(f)].filter((l) => l !== license),
      haystack: [f.name, f.city, f.corporate_name, f.licensee, license]
        .join(" ")
        .toLowerCase(),
    };
  });

  const openFacilities = facilities.filter((f) => !f.closed);
  const allSurveys = Object.values(surveysObj);
  return {
    facilities,
    byLicense: Object.fromEntries(facilities.map((f) => [f.license, f])),
    stats: {
      openFacilities: openFacilities.length,
      surveyEvents: allSurveys.length,
      withEnforcement: new Set(
        allSurveys.filter((s) => "enforcement" in s.documents).map((s) => s.license)
      ).size,
      held: allSurveys.filter((s) => s.expired_from_state).length,
      documents: allSurveys.reduce((n, s) => n + Object.keys(s.documents).length, 0),
      lastUpdated: allSurveys.reduce((m, s) => (s.last_seen > m ? s.last_seen : m), ""),
    },
  };
}
