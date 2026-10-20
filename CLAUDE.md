# wpr-care-ledger

The Care Ledger — permanent archive of Wisconsin DQA oversight records for
every assisted living facility in Marathon County and the eight counties
around it (Clark, Langlade, Lincoln, Portage, Shawano, Taylor, Waupaca,
Wood). The state's Provider Search only shows the past three years;
enforcement history quietly ages off the public record. This repo archives
it forever.

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

### Counties

`COUNTIES` in `fetch.py` maps each county as the roster export spells it
(`MARATHON`) to its County-dropdown code (`2744`). Marathon since
2026-07-12; its eight neighbors since 2026-10-07 (211 facilities; Wood 70,
Portage 36, Clark 29, Waupaca 27, Shawano 25, Lincoln 12, Langlade 8,
Taylor 4). Each county is searched in its own session (the export and the
grid's viewstate belong to the session's latest search), and its roster
must contain only that county — a check that catches a wrong code. Each
county's archive starts at the state's window on its first capture, so a
county's first capture is never "new" (digest alerts, widget stamps).
**Never drop a county from the list:** its facilities would read as off
the roster and its records as aged off, when only the ledger stopped
looking. The results grid isn't paged despite the 50-row setting (Wood's
70 all list); if it ever pages, the missing-key check fails the run.

### The postback dance (documented so nobody rediscovers it)

1. GET `DQAProviderSearch.aspx`, POST county-change postback
   (`__EVENTTARGET = …$County`, e.g. Marathon = value `2744`) — server-side
   city-list population, required before search. Done per county.
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
   (`https://www.forwardhealth.wi.gov/kw/dqa/XXXXXXSODS.PDF`). An archived
   file is never overwritten — but the state *can* replace a document at
   its address (The Waterford at Colby, 2026-09-21), so every run checks
   each one (`check_revisions`: a HEAD for its Last-Modified, a download
   only when that changed) and archives a changed file beside the
   original as a revision.

## Data contract

`data/facilities.json` — dict keyed by license number. State roster fields
(export columns) + detail-page fields (`licensure_status`, `ownership_type`,
`owner_name`) + `key`, `first_seen`, `last_seen`, `on_state_roster`.

`data/surveys.json` — dict keyed by `license|exit_date|survey-type-slug`.
Fields: `license`, `survey_type`, `exit_date`, `documents` (kind → archive
path; kinds: `enforcement`, `sod`, `poc`), `first_seen`, `last_seen`,
`expired_from_state`, `documents_first_seen` (kind → run date the document
was archived; a Notice & Order often posts weeks after its SOD, onto a
row that is no longer new — absent on documents archived before
2026-10), `expired_on` (the run date that flagged it;
absent on the 7 rows that aged off during the 2026-07/10 outage, whose
exact dates are unknowable — never backfill a guess; removed if a record
reappears), and `document_urls` (kind → the address the state published
the document at, `https://www.forwardhealth.wi.gov/kw/dqa/` + the survey's
event ID + `SODS`/`ENFS`/`POCS` + `.PDF`; first seen wins, like the file;
provenance, and what the Internet Archive copies from). The infix follows
the state's grid column, swap included — 0019331's `OBDO11ENFS.PDF` is an
SOD — so a document's kind comes from enrichment, never from its address.
Recorded since
2026-10-07; the 7 rows already aged off by then got theirs from the event
ID each of their documents prints, every one proven by a byte-identical
download from the state that day — derived, not guessed.
`revisions` (kind → list of `{path, first_seen, last_modified}`, oldest
first): versions the state posted over the original at the same address,
archived as `{exit_date}_{slug}_rev2_{kind}.pdf`, `rev3`, …; the original
in `documents` is never touched. `documents_last_modified` (kind → the
state's Last-Modified for the version held) lets a normal week check
each document with one HEAD and download only what changed; a new date
on identical bytes is not a revision. Fines, sanctions and citations
everywhere (widget, facility pages, CSV, tip sheet, alerts) come from
each document's latest version; the original stays linked with what
changed. First found 2026-10-19: The Waterford at Colby (0015955), Feb.
18, 2026 complaint — the state reissued both documents on 2026-09-18
(posted 09-21), 4 deficiencies → 1 and $1,000 → $400, with no notice;
the ledger holds the only copy of the originals (the Internet Archive
step copies only current versions — an original is no longer served).
**Append-only.** A row that vanishes from DQA flips
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
headers; the same phrases appear lowercase in boilerplate; includes
"Admissions ban" and "Accruing forfeiture" — an accruing letter's `fine`
is the amount so far, not final) and `fine` ("Total Forfeiture Due";
audited 2026-10 against all 36 forfeiture letters: every value matches).
SODs (state 2567 form) yield `census`, `deficiencies`, complaint outcomes
("Two of 8 complaints" = 2; "Both" = 2), and `citations` (tag + full rule
code including suffixes like `2.c` or `-(3)` + title; titles wrap in
lowercase, ALL CAPS, and Title Case — see `continues_title()`; repeat
violations brace the tag; the newer layout's first-page index repeats
every tag as `N0283`, so tags normalize to 3+ digits and the fullest
title wins; prefixes N=CBRF, M=AFH, U=RCAC, Y/Z=ch. 50). Each citation
also carries a plain-English `category` (nine: Care and service plans,
Medications, Building, cleanliness and food, Fire safety and evacuation,
Resident rights, Staff training and background checks, Staffing and
supervision, Abuse, neglect and incident reporting, Records and
administration): a few title words decide first, because sections mix
topics (83.38 = medication administration and leisure time), then the
code's section (`CATEGORY_SECTIONS` in enrich.py). Reapplied to every
citation each run, so a mapping change needs no `--rebuild`; an unmapped
section comes out "Other" with a warning — add it. Every ledger
document path must exist on disk in POSIX form and be mined, or
enrich.py fails the run.
Kind is detected from document *structure* — the state has served
letters and SODs in swapped grid columns (see license 0019331). Docs are
immutable so each parses once; `--rebuild` reparses all after parser
changes. Deleting the file and rerunning is always safe; never hand-edit.
Per-document parse gaps warn loudly but never fail the weekly run.

`data/wayback.json` — the Internet Archive's independent copies, written
by `pipeline/seed_wayback.py`: `documents` (archive path → Wayback URL of
a capture of the document's `document_urls` address) and `pages` (license
→ captures of the facility's state detail page, each `{copy,
fingerprint}`; the fingerprint hashes what the page showed — license
status, owner, survey rows and their documents — so a page is captured
again only when that changes, never just because its key rotated). Save
Page Now fetches from the state's own server, which is the point: nobody
has to take WPR's word for what the state published. **Only proven copies
are listed** — `documents` and `pages` are what the widget and facility
pages link. Save Page Now's "success" is not proof: in the first full
run (2026-10-15), 108 of 621 captures it reported done never opened. So
a capture waits in `pending` until a run downloads its raw bytes back
(`id_` replay): a document must equal the ledger's file byte for byte
(the state serves PDFs as static files); a page must open on its own
license and not on the portal's `UnexpectedError` page (a stale key
"succeeds" there, and such a capture is refused even before proof). A
copy that opens as something else is dropped and warned about; one still
missing 48 hours after capture is dropped and captured again. Each run
proves pending captures first, captures, then proves again. The
Wayback CDX index is not used: it lagged hours behind replay and its
prefix queries timed out. Never hand-edit; deleting the file and
rerunning recaptures everything (two runs).

`data/geocodes.json` — **derived** map locations from
`pipeline/geocode.py`, keyed by license: `address` (the one-line roster
address sent, which is also the change detector — only new or moved
facilities are sent again; an unplaced address is not retried until it
changes), `match` (Census `Exact` / `Non_Exact` / `No_Match` / `Tie`, or
`Wrong_County`), and `lat`/`lon` only when placed. One request to the
Census Bureau's batch geocoder (free, no key). Every match must fall
inside the facility's own roster county or within 250 m of it — some
streets *are* the county line (McMillan St in Marshfield divides Wood
from Marathon; County Line Rd at Stanley) and the geocoder lands on the
centerline; farther out is `Wrong_County`, no point: a dot in the wrong
place is worse than a missing one. 2026-10-19: 292 of 305 placed (rural
fire numbers and new subdivisions miss). The widget uses a point only
while its `address` still matches the roster, so a facility that moved
and wasn't geocoded again shows no dot rather than its old one. Delete
and rerun to geocode everything; never hand-edit.

`data/basemap.json` — the map's static base, built once 2026-10-19 (the
recipe is in geocode.py's docstring): `counties`, the nine outlines from
Census TIGERweb generalized to ~30 m (these boundaries are mostly
surveyed straight lines: 19–45 vertices each, 6.5 KB), used by the
widget and by geocode.py's county check; and `places`, the 2025 Census
Gazetteer point for each roster city that is a Census place in the nine
counties (40 of 43; Marathon City, Phlox and Stanley aren't), where the
widget prints town names. geocode.py fails if a county in `COUNTIES` has
no outline — add one when the ledger grows.

## Known migration event — READ THIS WHEN THE SCRAPER DIES

DHS announced the **Wisconsin Provider Finder** (planned spring 2026, not
yet launched as of 2026-07-11) will replace DQA Provider Search, and the
old page "will redirect once it launches." When that happens the fetcher's
structural assertions will fail loudly. That is correct behavior. Rewrite
`run_search`/`harvest_keys`/`fetch_detail` against the new tool; the ledger
and archive carry forward untouched — that's the point. Whatever history
the state drops in the migration, we already have — and so does the
Internet Archive, at the state's own addresses (`data/wayback.json`).
`seed_wayback.py` captures pages by their detail key, so its page half
needs the same rewrite; its document half keeps working as long as new
documents carry a `document_urls` address.

## Editorial angles encoded in the data

- `expired_from_state` records: oversight history invisible to families
  using the state tool.
- Same-address license flips: closed license + new license, same address,
  same capacity, same day (see Acorn Hill, 430 Orbiting Dr, Mosinee —
  Wisteria Assisted Living LLC closed 2025-02-17 after 3 enforcement
  actions; Mosinee Senior LLC licensed same day, clean record).
  A second flip, found by the 2026-10 audit: 226446 Hummingbird Rd,
  Wausau — Azura Wausau LLC (0013419, closed, enforcement 2026-03-18) and
  VOP Wausau LLC (0021269, probationary since 2026-06-08), same name, same
  19 beds.
- Admissions bans ("Order not to admit new residents") — Stone Crest
  2026-02-17 (with an accruing forfeiture), 0010689 2023-10-19
  (extended), 0018760 2025-07-23.
- Corporate operator comparison via `corporate_name` (e.g., Cedar Ridge
  Holdings LLC: 4 facilities, 9 enforcement events).
- Verify before quoting: accruing forfeitures (Stone Crest 2026-02-17
  $500, Pine Meadows 2 2025-09-12 $950) show the amount so far, not the
  final total; Pine Meadows 4's 2026-04-01 letter states $2,900 (its
  reduced amount matches) but its itemized rows add to $2,500 or $3,000 —
  ask DQA.
- Enforcement density: 126 of 305 facilities (about 4 in 10) had an
  enforcement action in the window the ledger holds (as of 2026-10-19;
  Marathon alone in July: 32 of 93).
- Records the state rewrites: `revisions`. The Waterford at Colby's Feb.
  18, 2026 complaint documents were replaced 2026-09-21 (fine $1,000 →
  $400, deficiencies 4 → 1) with nothing on the state's site saying so.
  Ask DQA why (appeal? informal dispute resolution?) before characterizing
  it; the tip sheet's "Documents the state replaced" lists new ones.
- Aged-off records are delisted, not deleted: on 2026-10-07 all 10 PDFs of
  the 7 held records were still served at their state addresses,
  byte-identical to the archive. "No longer shown by the state" means the
  Provider Search stopped listing them — a family can't find them, but the
  files exist for anyone who knows the address. Never write that the state
  deleted records.

## Widget

`widget/` — React/Vite facility lookup in WPR's **Newspack "Joseph"**
system (the `wpr-brand` skill classifies this repo there): Oswald
uppercase headlines, Merriweather body, black-on-white newspaper frame,
JetBrains Mono for data — all self-hosted via `@fontsource` (no Google
Fonts request; renders offline and in headless screenshots). Teal
`#3A867C` is the brand accent — the typewriter in the WPR seal
(`widget/public/brand/`: seal, committed wordmark copy, favicons).
Enforcement reads newspaper red `#b32d2e`.

Support ask: one quiet line — "The Care Ledger is free, with no paywall,
because readers support Wausau Pilot & Review's reporting. Support this
work" — in the footer, the single-facility embed's foot and every
facility page, linking `SUPPORT_URL` in src/ledger.js (the support page
wausaupilotandreview.com itself links, tagged `utm_source=care-ledger`
so WPR can count it). No tax-deduction claim; never a popup or overlay.

House invariants, from the brand skill: the masthead is WPR's flag — seal
(alt="") left, linked wordmark above the tool's name, italic one-line
dek, "Updated <date>" line — closed by the thick-over-thin `.flag-rule`;
WPR's name always sits above the tool's. The footer is the 44px seal +
provenance + a DHS non-affiliation line + `Wausau Pilot & Review ·
715-301-5539`. The 1200×630 share card is generated by
`widget/scripts/og-card.py` (rerun only on a branding change).

A county filter (default: all nine) scopes everything — the four stats,
the chart, the lenses, the list; `#county=Wood` deep-links to one. The
chart marks quarters only partly covered because county archives start
on different dates (`†`, with a footnote naming each start), and the
methodology's coverage sentence is generated from the data. Record panels
render on first open and stay mounted (300+ hidden timelines on load
would be tens of thousands of DOM nodes on a phone).

Search by facility / city / operator / license, type filter, closed toggle,
sort by name / latest activity / most enforcement / largest fines.
Lenses (buttons with live counts under the current search/type/closed
narrowing): All · Enforcement actions · Held in the ledger · New this week
(the last two appear only when the ledger has any). Four stats (slot 2 =
total forfeitures assessed, red; slot 4 = held count, sepia, once records
age off); the enforcement and held stats are buttons that set showClosed
and the matching lens, because stats count closed facilities too; when a
lens or search hides matching closed facilities, a row offers "N closed
facilities also match — Show them". "New this week" = the record, or a
document added to it later (`documents_first_seen`), was first seen
strictly within 7 days of the latest refresh — last Monday's run excluded,
a mid-week rerun harmless — and never while the ledger is stale. If the
data is over 10 days old, a notice tells readers the ledger is behind
instead of letting stale data pass as current. Document kinds, labels,
enforcement counts, and the chart all come from each PDF's parsed
structure (`enrichment.json` `kind`), the state's column only as fallback
— 0019331's links are swapped at the source. Survey timeline events show
the assessed forfeiture ("(accruing)" when still running), serious
sanctions ("Order not to admit new residents", revocation, suspension,
nonrenewal), "Complaint substantiated", and up to three distinct
cited-rule titles (repeats grouped "Services ×2"); held records show
"Held in the ledger" plus when the state's Provider Search last listed
them (worded "no longer listed", never "no longer on the state site" —
their PDFs are still served, and archive.org copies made after they
aged off prove it); records
the state rewrote show a dashed "Revised by the state" stamp, the date
its new file carries, what changed (`revisionChanges()` in ledger.js:
"forfeiture reduced from $1,000 to $400; deficiencies cited went from 4 to
1"), and links to the originals — the figures shown are the current
version's, and a revision found this week counts toward "New this week"
but is labeled "Revised this week" (row chip "Revised") so it never
reads as a new inspection (`newReason` in ledger.js). A record with no
surveys says "No survey records since <its county's archive start>" —
July 12, 2023 for Marathon, Oct. 7, 2023 for the rest. Search also
matches the printed name ("the waterford"). A
probationary license gets a neutral chip with a tooltip — it is
Wisconsin's standard first-year license, never styled as discipline.
Below the masthead, "Inspections by quarter": each bar is the
quarter's surveys as a light outlined bar (outline #8a8a8a, 3.4:1, so it
reads as a shape on white) filled from the baseline in red with those
that led to enforcement — a whole and its red part, so the eye lands on
the share the title states (it replaced dark-gray-on-red stacks,
2026-10-20, whose gray dominated). No gridlines (every bar is labeled):
totals above, the red count inside tall red or just above short red;
quarter + year axis, quarter labels shrink on phones rather than hide;
hover tooltips + sr-only table; the window line is drawn under the bars
so it never strikes a label; footnote marks
on bar labels: `*` for quarters ended within ~90 days of the refresh,
still filling in because the state posts surveys weeks after they close,
and `†` when the archive starts partway through the first quarter — no
opacity dimming, which failed contrast). A sepia field marks history older than the state's
three-year window, bounded by a dashed line placed to the day — it
advances every week, so the chart itself shows the archive outliving
the state's public record. Its title carries the finding, computed for
the counties in view: "223 of 547 surveys (41%) led to an enforcement
action." Its tooltip and sr-only table give each quarter's enforcement
rate. Next, "Enforcement by county": the share of each county's
facilities (closed included) with at least one enforcement action,
always all nine, sorted, on a fixed 0-100% scale with a visible track so
a bar's length is its share, labeled count-first ("19 of 36 · 53%", then
fines on wide screens), red because it measures enforcement; each row
sets the county filter (again to clear) and the selected county stays
marked; a footnote names the smallest county ("Taylor has 4
facilities") because small counties swing widely. Then "What inspectors cite": facilities cited at least
once in each citation category (a facility counts once per category)
and their share of the facilities in view, sorted, plain labeled rows
rather than a plot, following the county filter; phones drop the
citation count to give the bar room. Each row is a button: it filters
the list to the facilities cited in that category (`category` state,
`facility.categories` from ledger.js), resetting search, type and lens
and including closed facilities so the list count equals the bar; the
result count reads "50 facilities cited for medications · Show all".
`#cat=<slug>` deep-links the same view (`catSlug()`; `findCategory()`
also accepts the start of a slug, so `#cat=abuse` works); `county`, `cat`
and `q` combine with `&` (`#county=Wood&cat=medications`), and the URL
reflects all three; `view=map` opens on the map and joins them too. Any link without `lic` closes an open record, so the
address never sticks on a record the new view hides. Cross-links, stats
and Clear reset the category.
Expandable ledger rows: license facts + survey timeline
linking to archived PDFs, "View on state site" link built from the current
week's detail key (known gap: it can 404 to the portal error page between
DQA's weekly refresh, which rotates keys, and the next Monday fetch — a
stable deep link to the state's record doesn't exist; beside it, "State
page as archived <date>" links the latest Internet Archive capture from
`wayback.json`, which never breaks), an "archive.org copy" link beside
each PDF that has one (quiet mono; drops under its document on phones),
same-address
cross-links (addresses compare with street suffixes normalized — "RD" vs
"Road" once hid the Azura/VOP Wausau flip; neutral copy, the dates tell
the story; a closed sibling reads "(closed)" even without a closure date),
and operator cross-links when a `corporate_name` runs 2+ facilities. Deep
links for stories: `#lic=<license>` opens one facility (an unknown
license, or one missing its leading zeros, becomes a search),
`#q=<text>` presets the search (`+` decodes as a space; documented in
README); `?facility=<license>` is the single-facility embed — that one
record alone, open, under a compact flag (44px seal, wordmark, "The Care
Ledger · updated"), its header a static `h1` instead of the accordion
button, cross-links and the operator link opening the full ledger in a
new tab, leading zeros optional, an unknown license an honest "not in the
ledger" (README has a snippet whose resize script matches each message to
its frame, so several embeds can share an article); every deep link and cross-link resets the lens and type filters
so it can't hide its own target; the URL reflects the open record or
current search, and malformed `%` escapes are tolerated rather than
crashing the page.

Signature element: the sepia **held in the ledger** treatment on survey
records with `expired_from_state: true`, plus the masthead stat that counts
them once records start aging off (until then the fourth stat shows
documents archived).

Reader-facing copy follows AP style and one vocabulary, edited
2026-10-20 (a copy review of every string): "inspection" in headings,
counts and the chart (the state's own type names stay: "Standard survey",
and the glossary's "Survey" entry explains the word on documents); "fines"
in summaries, "forfeiture" on a record's own line, where it quotes the
letter; "enforcement action(s)", never a bare "enforcement" count; numbers
one through nine spelled (`apNum()`), no serial comma (`andList()`),
"miles" not "mi"; combined survey types read "Standard survey and
complaint investigation"; the state's VV and VERIFICATION VISIT are both
"Follow-up visit". License status reads "Regular license" /
"Probationary (first-year) license, not a penalty" (`statusLabel()`), so
phones, which never see the chip's tooltip, get the explanation too;
"Licensed" is the first license date — probationary before regular
(`licensedOn()`; 95 facilities have a regular date about six months
later); ownership types are tidied (`ownershipLabel()`). "Since each
county's archive began" is always spelled out with its dates
(`sinceArchive()`: "since July 12, 2023, in Marathon County and Oct. 7,
2023, in the other eight counties"). "State-regulated", not
"state-licensed": residential care apartment complexes are certified or
registered, not licensed. "What inspectors cite" bars are each
category's share of the facilities in view on the same 0-100% track as
the county chart (they were scaled to the largest category, so the top
bar always looked full).

State names arrive ALL CAPS; `smartTitle()` title-cases them for print,
preserving acronyms (LLC, CBRF, HCBS, …) and never capitalizing after an
apostrophe (Alzheimer's).

The list renders 20 rows, then "Show 20 more" / "show all" (focus moves
to the first new row); any new search, filter, sort, lens or county
starts again at 20. All 279 at once made the embedded frame ~30,000px
tall, burying the rest of the article; now ~4,000. Deep links and
cross-links narrow the list to their target, so paging never hides it;
the CSV still exports every row in view.

Embedding in WordPress: articles carry only an `<iframe>` — no inline
JavaScript, which host firewalls (ModSecurity) reject on save ("The
response is not a valid JSON response") and WordPress strips for authors
without unfiltered_html. The resize listener is `widget/public/embed.js`,
installed once site-wide (`<script src=".../embed.js" defer>`): it takes
the ledger's origin from its own src, sizes any iframe whose src is the
ledger (class or not) by matching `e.source`, is idempotent, and on load
posts `wpr-care-ledger:measure` to every ledger frame so ones that
reported before it listened answer again (the widget re-posts its height
on that message). For full-ledger frames (not `?facility=`) it also
forwards the host page's ledger hash (`#lic=`, `#q=`, `#county=`,
`#cat=`, `#view=`; other hashes such as `#comments` are left alone) by
setting the frame's src fragment, on load and on hashchange, so
`wausaupilotandreview.com/care-ledger/#lic=0015955` opens the record;
and, after the frame's first height message, posts
`wpr-care-ledger:host` with the page's address, which the widget uses
(`hostUrl`) for "Copy link to this record". Without it a frame works at its fallback height with
its own scrollbar. Tested with frames loaded before the script, a
classless frame, and the script included twice (README, Embedding).
The widget posts its height to the parent page measured from
`#root` — never `documentElement.scrollHeight`, which can't drop below
the iframe's own height, so the frame could grow but never shrink. When
embedded it never calls `scrollIntoView` (that would scroll the reader's
article). Numbers format with a fixed `en-US` locale ("$39,640" on a
German browser too); dates are AP style from `fmtDate()` in ledger.js
("Sept. 21, 2026", "March 27, 2026"; the masthead too — there is no
spelled-out form), never the
browser's locale.

Accessibility: masthead, `<main>`, footer landmarks (the single embed
too, its foot a `<footer>`). Each facility's header button sits inside an `h3` (sr-only
`h2` "Facilities" above the list; each panel's "Inspection history" is an
`h4` naming the facility for screen readers; in the single-facility
embed the record is the frame's `h1` and its history an `h2`). Document
links, archive.org links, the CSV buttons and the unplaced-facility
names are padded to 24px-tall tap targets (WCAG 2.5.8). Audited
2026-10-19 with axe-core 4.10 (WCAG 2.2 AA + best practices) at phone
width: list, open record, map with a pinned card, single embed, and the
static facility and index pages — no violations; facts are a real `<dl>`;
closing a record (Escape) or following a cross-link returns focus to a
row header, and the operator link focuses the operator brief, so focus
is never stranded in an inert panel. `inert` is set as a DOM property
from an effect, not as `inert=""` — React 19 reads that as false.

UX details: rows expand with an animated grid-rows reveal (caret rotates
+ to ×; closed panels are `inert`; the reduced-motion media query kills
all transitions and animations). Search covers name, city, operator,
licensee, license, and street address; matches highlight in names and
cities (highlighter-yellow `<mark>`), and when the hit is in a field the
row doesn't show, the meta line explains it ("· operator: …"). Expanded
panels lead with a summary band (surveys · enforcement · $ assessed ·
latest survey) and offer "Copy link to this record" (deep-link URL;
aria-live feedback; the WordPress iframe needs `allow="clipboard-write"`,
already in the README snippet). A search that exactly matches a corporate
name — which the operator cross-link produces — renders a boxed operator
brief above the results. Empty results offer a one-click filter reset, or
"Show N closed facilities that match" when the closed toggle is what's
hiding them. Keyboard: "/" focuses search, Escape closes the open record.
Above the footer (and in the single-facility embed), a collapsed "What
these terms mean" glossary: 24 terms in four groups (inspections,
documents, enforcement, facilities and licenses), from `GLOSSARY` in
App.jsx, worded to match the labels the ledger prints. Verify a
definition with DQA before changing its substance.
Beside the result count, "Download as CSV: facilities · survey records"
exports exactly the rows in view (county, search, type, closed toggle,
lens): one row per facility, or per survey record with its fine,
sanctions, citation categories, cited rules, held status and absolute
links to the archived PDFs and their archive.org copies. Built in the
browser (no server): UTF-8 BOM for Excel, and a cell starting `= + - @`
gets a leading apostrophe so a spreadsheet can't run it as a formula.
Filenames carry the county and the ledger's update date.
Beside it, a List · Map toggle (`view` state, `#view=map`). The map
(`FacilityMap`) draws exactly the facilities in view — every narrowing
applies, pagination doesn't — over the county outlines in plain SVG: no
tile service, nothing loaded from a third party. Equirectangular with
longitude scaled by cos(latitude), framed to the county filter (all nine,
or one county with its neighbors faint), not to the dots, so it holds
still while a search narrows it; a single county's height is capped at
560px. Every dot is one facility — a locator, not a density map: red =
an enforcement action on record (drawn on top), gray = none, hollow =
closed; the legend counts each. Pointing at a dot (hover; tap on touch)
shows a card for every facility within a few pixels, nearest first —
Wausau's dots overlap — previewing five; clicking pins it, listing all
in a scroll box with a close button (Escape and clicking empty map close
it too); a name opens that record in the list via `crossLink`. With all
nine shown, clicking empty space in a county zooms to it; zoomed, a
"Show all nine counties" button returns. County names sit at each
county's open spot farthest from any dot (`labelSpot`); zoomed in, towns
with 2+ facilities in view are named, anchored at the Gazetteer point
(never at their facilities — a mailing city's addresses spread miles
out), placed beside it where the name covers fewest dots and skipped
rather than overlapping another name. Facilities without a location are
named under the map, each a link to its record. Dots aren't focusable:
the SVG is `role="img"` with a summary label, and the list is the
accessible equivalent. Cross-links, the operator link and Clear return
to the list. Each record's "Show on the map" (beside "Page for this
facility", when it has a location) resets the narrowing, zooms to its
county and opens its card with focus on its name — the record closes,
so focus can't be stranded, and closing a card that holds focus hands it
to the map figure; the Map toggle closes an open record (it would keep
the address on `#lic=`); cards hang from their first facility's dot,
so they stay attached when the frame resizes. Every record's facts end
with a small locator ("Location": the nine counties, its own shaded, one
dot) from `locatorSvg()` in ledger.js — built when the panel first
opens, and drawn identically on the facility pages. The projection
(`mapFrame()`, `outlinePath()`) lives in ledger.js for both. Above the
locator, "Nearest operating facilities": up to five open facilities
within 15 straight-line miles (`nearbyOf()`, haversine `milesBetween()`
in ledger.js), nearest first, each with its city, distance and
enforcement count, a cross-link to its record; same-address licenses
are left out (they have their own fact). The facility pages list the
same five, linked page to page.
Cross-links and deep links scroll the opened record into view
(standalone only). A print stylesheet hides interactive chrome and keeps
records intact across page breaks.

Static facility pages, for search and sharing (the widget is one
script-built page a search engine can't see into): `postbuild` runs
`scripts/facility-pages.mjs`, which writes `dist/facility/<name>-<license>/`
for every facility (plain HTML: title and description built from the
record, canonical URL, share tags, facts, the full inspection history
with PDF and archive.org links, a button into the interactive ledger),
`dist/facility/` (every facility by county), and `dist/sitemap.xml`. It
imports `src/ledger.js` — the vocabulary, formatters, `shape()` and
`facilitySlug()` the widget itself uses — so a page can never disagree
with the ledger; keep that module free of React and browser APIs. The
widget links each record's page ("Page for this facility"; the
facilities CSV has it too), and index.html's root holds a plain link to
`facility/` until the app replaces it. No robots.txt: a GitHub project
site can't serve one at the domain root, where crawlers look. `SITE` in
the script is the published address — change it there if the ledger
moves to a custom domain.

Build plumbing: `predev`/`prebuild` run `scripts/dev-sync.mjs`, which copies
`data/` (overwriting) and `archive/` (new files only — PDFs are immutable)
into `widget/public/` — Vite
then bundles them into `dist/`, so **the Pages artifact is just
`widget/dist`**. Widget fetches `./data/*.json`; PDF links are relative
`archive/...` paths. `public/data` and `public/archive` are gitignored.

## Deploy

- `fetch.yml` — Mondays 09:00 UTC: tests → fetch → **commit the ledger
  and archive** → enrich → digest → commit `enrichment.json` → alert →
  geocode new or moved facilities and commit `geocodes.json` (5-minute
  step limit; a Census Bureau outage is a `::warning::` inside
  geocode.py that writes nothing, so the facilities wait a week, named
  under the map; any other geocoder error — a county with no outline, a
  dropped or malformed row — fails the run and opens the issue). The archive
  commits before any derived step can fail, so a parser problem never
  costs a week of records. One run at a time (concurrency group), 30-min
  timeout, `pull --rebase` before each push. On failure it opens a
  `fetch-failure` issue (one at a time) so a dead scraper is loud —
  expected to fire at the Provider Finder migration. Parse warnings go to
  the run's summary page beside the tip sheet.
- `deploy.yml` — builds the widget and publishes `widget/dist` to GitHub
  Pages. Triggers: pushes to main, successful completion of the fetch or
  wayback workflow (`workflow_run`), or manual dispatch. The `workflow_run` chain
  exists because commits pushed with the default `GITHUB_TOKEN` (the fetch
  bot) never trigger other workflows — a plain push trigger would leave the
  live widget silently stale.
- `wayback.yml` — after each successful fetch (`workflow_run`), or Run
  workflow: `seed_wayback.py`, then commits `data/wayback.json`, even after
  a partial failure (every recorded copy is real). Its own workflow so the
  deploy never waits on archive.org. Needs repository secrets
  `IA_ACCESS_KEY` / `IA_SECRET_KEY`, an archive.org account's S3 keys —
  Save Page Now stopped taking anonymous captures in 2026-10. A failed run
  is red in Actions and touches neither the ledger nor the deploy.
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
  actions with forfeitures, documents the state replaced, records that
  aged off that run)
- Email alerts: `digest.py --alert` (last step of fetch.yml) opens one
  `new-enforcement` issue per run listing enforcement actions new that run
  — new surveys carrying a letter, and letters that arrived later on older
  surveys (structural kind, so swapped columns can't hide one). The issue
  @mentions the `ALERT_MENTIONS` repository variable (space-separated
  GitHub usernames; currently `@RowanFlynnPilot`), and GitHub emails
  whoever it notifies — mentions notify even non-watchers. A hidden marker
  per action means nothing is ever emailed twice, however often the fetch
  reruns. The step is `continue-on-error` so a notification hiccup can't
  block the deploy. `alert-test.yml` (Run workflow) posts a `[TEST]` issue
  to confirm delivery. Alert issues are public, like the repo — public
  records only.
- Map locations: `python pipeline/geocode.py` (new or moved facilities
  only; idempotent)
- Internet Archive copies: `python pipeline/seed_wayback.py` (needs
  `IA_ACCESS_KEY` / `IA_SECRET_KEY`; idempotent). Paces itself under Save
  Page Now's documented 7 captures a minute, at most six in flight —
  archive.org actually delivered ~2.5 a minute on the first full run —
  and stops submitting after four hours, leaving the rest for the next
  run, so a full copy (or a deleted wayback.json) takes two runs.
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
