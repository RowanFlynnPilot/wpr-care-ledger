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
5. Detail keys are stable system identifiers, cached per facility in
   `facilities.json`. Detail pages are then plain GETs
   (`?key=N&keyb=-1`) — the postback dance only happens for facilities
   without a cached key.
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
`expired_from_state`. **Append-only.** A row that vanishes from DQA flips
`expired_from_state: true` and stays forever. That flag is the product.

`archive/{license}/{exit_date}_{survey-type-slug}_{kind}.pdf` — the
permanent document archive.

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

`widget/` — React/Vite facility lookup, WPR design system (teal `#3A867C`,
cream `#F6F2E9`, Fraunces display, Public Sans body, JetBrains Mono data).
Search by facility / city / operator / license, type filter, closed toggle,
sort by name / latest activity / most enforcement. Expandable ledger rows:
license facts + survey timeline linking to archived PDFs, "View on state
site" link built from the cached detail key, and same-address cross-links
(neutral copy — the dates tell the Acorn Hill story on their own).

Signature element: the sepia **held in the ledger** treatment on survey
records with `expired_from_state: true`, plus the masthead stat that counts
them once records start aging off (until then the fourth stat shows
documents archived).

Build plumbing: `predev`/`prebuild` run `scripts/dev-sync.mjs`, which copies
`data/` (always) and `archive/` (if missing) into `widget/public/` — Vite
then bundles them into `dist/`, so **the Pages artifact is just
`widget/dist`**. Widget fetches `./data/*.json`; PDF links are relative
`archive/...` paths. `public/data` and `public/archive` are gitignored.

## Deploy

- `fetch.yml` — Mondays 09:00 UTC, commits `data/` + `archive/` updates.
- `deploy.yml` — builds the widget and publishes `widget/dist` to GitHub
  Pages. Triggers: pushes to main, successful completion of the fetch
  workflow (`workflow_run`), or manual dispatch. The `workflow_run` chain
  exists because commits pushed with the default `GITHUB_TOKEN` (the fetch
  bot) never trigger other workflows — a plain push trigger would leave the
  live widget silently stale.
- Repo settings: Pages source must be set to "GitHub Actions" once.

## Commands

- Fetch: `python pipeline/fetch.py` (idempotent; safe to re-run)
- Widget dev: `cd widget; npm install; npm run dev`
- Windows local: `python -m pip install requests beautifulsoup4 lxml openpyxl`
- Chain with `;` not `&&` in PowerShell 5.1
