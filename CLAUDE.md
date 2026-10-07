# wpr-care-ledger

The Care Ledger — permanent archive of Wisconsin DQA oversight records for
every assisted living facility in Marathon County. The state's Provider
Search only shows the past three years; enforcement history quietly ages off
the public record. This repo archives it forever.

## Philosophy

One correct path, no fallbacks, fail fast and loud, surgical changes, no
overengineering. Same rules as every other WPR repo.

## Architecture

Python scraper → GitHub Actions weekly cron → static JSON + PDF archive in
repo → React/Vite widget → GitHub Pages → WordPress iframe. The standard
WPR pattern. No database, no server, no external storage — Git *is* the
permanent archive (~40 MB initial, grows ~15–20 MB/year at county scale).

## Data source

WI DHS Division of Quality Assurance (DQA) Provider Search:
`https://www.forwardhealth.wi.gov/WIPortal/Subsystem/Public/DQAProviderSearch.aspx`

- Classic ASP.NET WebForms (VIEWSTATE + `__doPostBack`). Plain `requests`
  replay — no JavaScript engine, no proxies, no Playwright. Friendliest
  government target in the WPR portfolio.
- Updated weekly on **Sunday**. Cron runs Monday.
- Shows survey history from the **past three years only**. Everything the
  scraper has ever seen is retained here with `first_seen` / `last_seen` /
  `expired_from_state` flags. Rows never delete.
- Provider types covered: Adult Family Home (3–4 bed), Community Based
  Residential Facility, Residential Care Apartment Complex. Closed
  facilities included (`IndIncludeClosed`) — closures after enforcement are
  part of the story. Nursing homes are excluded (currently disabled in the
  tool during the state's CMS system transition, and out of scope).

### The postback dance (documented so nobody rediscovers it)

1. GET `DQAProviderSearch.aspx`, POST county-change postback
   (`__EVENTTARGET = …$County`, Marathon = value `2744`) — server-side
   city-list population, required before search.
2. POST search (`__EVENTTARGET = …$ButtonSearch`). `ResultsSortOrder` is
   **required** (`NAM_LEGAL`); omit it and you get a validation bounce.
   Response lands on `DqaProviderSearchResults.aspx` — all subsequent grid
   postbacks go to *that* URL, not the search page.
3. GET `DqaSearchResultsExport.aspx` in the same session → xlsx roster with
   24 columns including corporate name, licensee, license dates, closure
   date.
4. Each grid row link (`…GridViewResults$ctlNN$LinkSakDqa`) posted with the
   results-page viewstate 302s to `DqaProviderDetails.aspx?key=NNNNNNNN`.
   The key is read from the **Location header** — no need to follow. The
   results viewstate is reusable across all row clicks.
5. **Detail keys rotate every weekly refresh** — DQA reloads its provider
   table and every facility gets a new key (Our House: 15226164 on
   2026-07-12, 15570764 by October). A stale key 302s to
   `UnexpectedError.aspx`, a 200 page that `raise_for_status()` can't see.
   So keys are harvested fresh on every run (~93 POSTs, under a minute)
   and never reused. `facilities.json` stores the current week's `key`
   only for the widget's "view on state site" link; detail pages work
   without a session given a current key. Lesson paid for in full: an
   earlier version cached keys, broke on the first weekly run, and for 12
   weeks parsed error pages as empty histories — flagging every record
   "no longer shown by the state" on the live site while every run
   reported success.
6. Survey document PDFs are direct URLs
   (`https://www.forwardhealth.wi.gov/kw/dqa/XXXXXXSODS.PDF`). Immutable
   legal documents: archived once, never re-fetched.

## Data contract

`data/facilities.json` — dict keyed by license number. State roster fields
(export columns) + detail-page fields (`licensure_status`, `ownership_type`,
`owner_name`) + `key`, `first_seen`, `last_seen`, `on_state_roster`.

`data/surveys.json` — dict keyed by `license|exit_date|survey-type-slug`.
Fields: `license`, `survey_type`, `exit_date`, `documents` (kind → archive
path; kinds: `enforcement`, `sod`, `poc`), `first_seen`, `last_seen`,
`expired_from_state`, and `expired_on` (the run date that flagged it;
absent on the 7 rows that aged off during the 2026-07/10 outage, whose
exact dates are unknowable — never backfill a guess; removed if a record
reappears). **Append-only.** A row that vanishes from DQA flips
`expired_from_state: true` and stays forever. That flag is the product —
so it is guarded twice in `fetch.py`: every detail page must prove its
identity (License Number field matches, Survey History section present
as a table or the state's explicit "No survey information available."),
and a record of a facility still on the roster may only age off if its
exit date is older than the three-year window plus 30 days' slack.
Anything newer vanishing fails the run (opening a `fetch-failure` issue)
instead of being published as "no longer shown by the state".
Rows recovered by `pipeline/backfill_wayback.py` (one-time Internet
Archive recovery of history the state already dropped; survey type
reconstructed from the documents' own prose) additionally carry
`source: "wayback:<timestamp>"`, with `last_seen` = the snapshot date. If
a later fetch ever sees the same row live, the fetch's update wins and
`source` survives as provenance.

`archive/{license}/{exit_date}_{survey-type-slug}_{kind}.pdf` — the
permanent document archive.

`data/enrichment.json` — **derived, rebuildable** facts machine-read from
the archived PDFs by `pipeline/enrich.py`, keyed by archive path (the same
path `surveys.json` stores in `documents`, which is the widget's join key).
Enforcement letters yield `sanctions` (line-anchored ALL-CAPS notice
headers; the same phrases appear lowercase in boilerplate) and `fine`
("Total Forfeiture Due"). SODs (state 2567 form) yield `census`,
`deficiencies`, complaint outcomes, and `citations` (tag + rule code +
title; repeat violations brace the tag; prefixes N=CBRF, M=AFH, U=RCAC).
Kind is detected from document *structure* — the state has served
letters and SODs in swapped grid columns (see license 0019331). Docs are
immutable so each parses once; `--rebuild` reparses all after parser
changes. Deleting the file and rerunning is always safe; never hand-edit.
Per-document parse gaps warn loudly but never fail the weekly run.

## Known migration event — READ THIS WHEN THE SCRAPER DIES

DHS announced the **Wisconsin Provider Finder** (planned spring 2026, not
yet launched as of 2026-07-11) will replace DQA Provider Search, and the
old page "will redirect once it launches." When that happens the fetcher's
structural assertions will fail loudly. That is correct behavior. Rewrite
`run_search`/`harvest_keys`/`fetch_detail` against the new tool; the ledger
and archive carry forward untouched — that's the point. Whatever history
the state drops in the migration, we already have.

## Editorial angles encoded in the data

- `expired_from_state` records: oversight history invisible to families
  using the state tool.
- Same-address license flips: closed license + new license, same address,
  same capacity, same day (see Acorn Hill, 430 Orbiting Dr, Mosinee —
  Wisteria Assisted Living LLC closed 2025-02-17 after 3 enforcement
  actions; Mosinee Senior LLC licensed same day, clean record).
- Corporate operator comparison via `corporate_name` (e.g., Cedar Ridge
  Holdings LLC: 4 facilities, 9 enforcement events).
- Enforcement density: 32 of 93 facilities have enforcement actions within
  the 3-year visible window alone.

## Widget

`widget/` — React/Vite facility lookup in WPR's **Newspack "Joseph"**
system (the `wpr-brand` skill classifies this repo there): Oswald
uppercase headlines, Merriweather body, black-on-white newspaper frame,
JetBrains Mono for data — all self-hosted via `@fontsource` (no Google
Fonts request; renders offline and in headless screenshots). Teal
`#3A867C` is the brand accent — the typewriter in the WPR seal
(`widget/public/brand/`: seal, committed wordmark copy, favicons).
Enforcement reads newspaper red `#b32d2e`.

House invariants, from the brand skill: the masthead is WPR's flag — seal
(alt="") left, linked wordmark above the tool's name, italic one-line
dek, "Updated <date>" line — closed by the thick-over-thin `.flag-rule`;
WPR's name always sits above the tool's. The footer is the 44px seal +
provenance + a DHS non-affiliation line + `Wausau Pilot & Review ·
715-301-5539`. The 1200×630 share card is generated by
`widget/scripts/og-card.py` (rerun only on a branding change).

Search by facility / city / operator / license, type filter, closed toggle,
sort by name / latest activity / most enforcement / most forfeitures.
Lenses (buttons with live counts under the current search/type/closed
narrowing): All · Enforcement actions · Held in the ledger · New this week
(the last two appear only when the ledger has any). Four stats (slot 2 =
total forfeitures assessed, red; slot 4 = held count, sepia, once records
age off); the enforcement and held stats are buttons that set showClosed
and the matching lens, because stats count closed facilities too. "New
this week" = first seen within 8 days of the latest refresh (not "equal
to it" — a mid-week manual run once hid every new stamp). If the data is
over 10 days old, a notice tells readers the ledger is behind instead of
letting stale data pass as current. Survey timeline events show the
assessed forfeiture, "Complaint substantiated", and up to three
cited-rule titles from `enrichment.json`; held records show "Held in the
ledger" plus when the state site last showed them. Below the masthead, a
quarterly survey-activity chart (gray = no enforcement, red =
enforcement; every bar value-labeled, enforcement counts printed inside
tall red segments, quarter + year axis, hover tooltips + sr-only table;
quarter labels hide on mobile; an in-progress quarter renders dimmed
with a footnote). A sepia field marks history older than the state's
three-year window, bounded by a dashed line placed to the day — it
advances every week, so the chart itself shows the archive outliving
the state's public record.
Expandable ledger rows: license facts + survey timeline
linking to archived PDFs, "View on state site" link built from the cached
detail key, same-address cross-links (neutral copy — the dates tell the
Acorn Hill story on their own), and operator cross-links when a
`corporate_name` runs 2+ facilities. Survey events first seen by the most
recent fetch get a "New this update" stamp (suppressed for the initial
pull). Deep links for stories: `#lic=<license>` opens one facility,
`#q=<text>` presets the search (documented in README); the URL reflects
the open record or current search, and malformed `%` escapes are
tolerated rather than crashing the page.

Signature element: the sepia **held in the ledger** treatment on survey
records with `expired_from_state: true`, plus the masthead stat that counts
them once records start aging off (until then the fourth stat shows
documents archived).

State names arrive ALL CAPS; `smartTitle()` title-cases them for print,
preserving acronyms (LLC, CBRF, HCBS, …) and never capitalizing after an
apostrophe (Alzheimer's).

UX details: rows expand with an animated grid-rows reveal (caret rotates
+ to ×; closed panels are `inert`; the reduced-motion media query kills
all transitions and animations). Search covers name, city, operator,
licensee, license, and street address; matches highlight in names and
cities (highlighter-yellow `<mark>`), and when the hit is in a field the
row doesn't show, the meta line explains it ("· operator: …"). Expanded
panels lead with a summary band (surveys · enforcement · $ assessed ·
last visit) and offer "Copy link to this record" (deep-link URL;
aria-live feedback; the WordPress iframe needs `allow="clipboard-write"`,
already in the README snippet). A search that exactly matches a corporate
name — which the operator cross-link produces — renders a boxed operator
brief above the results. Empty results offer a one-click filter reset, or
"Show N closed facilities that match" when the closed toggle is what's
hiding them. Keyboard: "/" focuses search, Escape closes the open record.
Cross-links and deep links scroll the opened record into view
(standalone only — the iframe has no inner scroller). The masthead's
eyebrow carries an "Updated <date>" folio and closes with an Oxford rule
(thick-thin). A print stylesheet hides interactive chrome and keeps
records intact across page breaks.

Build plumbing: `predev`/`prebuild` run `scripts/dev-sync.mjs`, which copies
`data/` (overwriting) and `archive/` (new files only — PDFs are immutable)
into `widget/public/` — Vite
then bundles them into `dist/`, so **the Pages artifact is just
`widget/dist`**. Widget fetches `./data/*.json`; PDF links are relative
`archive/...` paths. `public/data` and `public/archive` are gitignored.

## Deploy

- `fetch.yml` — Mondays 09:00 UTC, commits `data/` + `archive/` updates.
  On failure it opens a `fetch-failure` issue (one at a time) so a dead
  scraper is loud — expected to fire at the Provider Finder migration.
- `deploy.yml` — builds the widget and publishes `widget/dist` to GitHub
  Pages. Triggers: pushes to main, successful completion of the fetch
  workflow (`workflow_run`), or manual dispatch. The `workflow_run` chain
  exists because commits pushed with the default `GITHUB_TOKEN` (the fetch
  bot) never trigger other workflows — a plain push trigger would leave the
  live widget silently stale.
- Repo settings: Pages source must be set to "GitHub Actions" once.

## Commands

- Tests: `python -m unittest discover -s pipeline/tests` (stdlib only; run
  in CI before every fetch). Pins the guards that make a silent failure
  impossible — real portal error page and wrong-facility pages must raise,
  in-window records vanishing must be caught — plus forfeiture/citation
  parsing against excerpts with the known traps. Fixtures are real portal
  pages in `pipeline/tests/fixtures/`.
- Fetch: `python pipeline/fetch.py` (idempotent; safe to re-run)
- Mine documents: `python pipeline/enrich.py` (new docs only; `--rebuild`
  reparses everything — run after parser changes)
- Weekly tip sheet: `python pipeline/digest.py` (read-only; in Actions it
  also lands on each run's summary page — new surveys, new enforcement
  actions with forfeitures, records that aged off that run)
- Wayback recovery (rarely; idempotent): `python pipeline/backfill_wayback.py`,
  then rerun enrich.py. Empirical result 2026-07: the Internet Archive
  holds zero Marathon County assisted-living items (attribution verified
  against foreign-county documents), so the ledger's own weekly fetch is
  the only archive this county has. Re-run only if IA coverage grows.
- Widget dev: `cd widget; npm install; npm run dev`
- Deps are pinned: `python -m pip install -r pipeline/requirements.txt`
  (upgrade deliberately: bump, run fetch + `enrich.py --rebuild`, diff
  data/ before committing)
- Chain with `;` not `&&` in PowerShell 5.1
