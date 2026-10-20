# wpr-care-ledger

The Care Ledger — assisted living oversight in Marathon County and the
eight counties around it (Clark, Langlade, Lincoln, Portage, Shawano,
Taylor, Waupaca, Wood), permanently archived. Wisconsin's DQA only shows
three years of survey history; this repo never forgets.

- Live widget: <https://rowanflynnpilot.github.io/wpr-care-ledger/>
- Architecture and data contract: `CLAUDE.md`
- Setup: `python -m pip install -r pipeline/requirements.txt` (pinned)
- Tests: `python -m unittest discover -s pipeline/tests`
- Run the fetcher, then the document miner:
  `python pipeline/fetch.py` · `python pipeline/enrich.py`
- Run the widget: `cd widget; npm install; npm run dev`
- Data: `data/facilities.json`, `data/surveys.json`, the derived
  `data/enrichment.json` (fines, sanctions, citations read from the PDFs),
  `data/wayback.json` (the Internet Archive's copies), and
  `data/geocodes.json` (map locations from the Census Bureau's geocoder)
- Document archive: `archive/{license}/`

## Every Monday

GitHub Actions runs the tests, then the fetch, then the miner, commits what
changed, and redeploys the widget. The fetch also checks every archived
document against the state's current file: if the state replaces one at
its address — it reissued The Waterford at Colby's records in September,
cutting a $1,000 fine to $400 without notice — the new version is archived
beside the original, and the ledger shows both. Each run's summary page
carries a **tip sheet**: new surveys, new enforcement actions with their
forfeitures, documents the state replaced, and records that aged off the
state site that week (Actions → fetch → latest
run). If a run fails, nothing is committed, a `fetch-failure` issue opens,
and the widget keeps last week's data — telling readers it is behind if a
failure lasts past ten days.

## Email alerts for new enforcement actions

When a run finds a new enforcement action, it opens one GitHub issue
(label `new-enforcement`) per run: the facility, survey, forfeiture,
serious orders, cited rules, and links to the record and the letter.
Documents the state replaced get their own issue ("State revised
records: …"), with what changed and links to the original and the new
version. GitHub emails everyone the issue @mentions.

- **Who gets it:** the `ALERT_MENTIONS` repository variable — Settings →
  Secrets and variables → Actions → Variables, space-separated GitHub
  usernames (e.g. `@RowanFlynnPilot @someeditor`). Each person needs a
  GitHub account with email notifications on (Settings → Notifications →
  "Participating, @mentions and custom": Email).
- **Test it:** Actions → alert-test → Run workflow posts a `[TEST]` alert.
- No action is ever emailed twice, even if the fetch reruns.

## Copies at the Internet Archive

After each fetch, the `wayback` workflow has the Internet Archive's Wayback
Machine capture every new document and every facility page whose contents
changed, straight from the state's server. That puts a second, timestamped
copy with an institution that has no stake in the records, so anyone can
check what the state published without taking WPR's word for it. Every
run checks each document's copy against the ledger's file byte for byte
and reports on its summary page (Actions → wayback → latest run).

- **One-time setup:** Save Page Now no longer accepts anonymous captures.
  Sign in to archive.org with a newsroom account (so the keys don't hang on
  one person), open <https://archive.org/account/s3.php>, and add the two
  keys as repository secrets (Settings → Secrets and variables → Actions →
  Secrets): `IA_ACCESS_KEY` and `IA_SECRET_KEY`.
- **Status:** set up 2026-10-15; since Oct. 19 every document and every
  facility page has a copy. Each week copies what's new, in minutes.
  Actions → wayback → Run workflow runs it by hand.
- **Only proven copies are listed.** Save Page Now sometimes reports a
  capture done that never appears, so each one is downloaded back and
  checked — documents byte for byte against the ledger's file — before
  the widget links it; a lost one is captured again.
- **Finding a copy:** `data/wayback.json` maps each archived PDF to its
  Wayback URL, and each license to the captures of its state page.

## Embedding on wausaupilotandreview.com

Two steps. Articles carry **only an iframe — no JavaScript** — because
security firewalls (ModSecurity at many hosts) often reject a WordPress
save whose content contains script, which surfaces as "Updating failed.
The response is not a valid JSON response," and because WordPress strips
`<script>` from authors without the unfiltered-HTML permission anyway.

**1. Once, site-wide (an admin):** add this line to the site's header or
footer code — e.g. a header/footer code plugin such as WPCode, or wherever
the site keeps other third-party scripts:

```html
<script src="https://rowanflynnpilot.github.io/wpr-care-ledger/embed.js" defer></script>
```

It sizes every Care Ledger frame on a page to its content as readers open
records and search — no inner scrollbar — each frame matched by the window
that sent its message, so the full ledger and any number of
single-facility embeds can share an article. Frames that load before it
are asked to measure again; including it twice is harmless.

**2. In each article:** a **Custom HTML** block (not a Paragraph or Code
block) with just the frame:

```html
<iframe class="care-ledger" src="https://rowanflynnpilot.github.io/wpr-care-ledger/" title="The Care Ledger: assisted living oversight in central Wisconsin" style="width:100%;border:0;display:block;" height="1200" loading="lazy" allow="clipboard-write"></iframe>
```

- Without step 1 the frame still works: 1,200px tall with its own
  scrollbar.
- Paste from a plain-text source; "smart" curly quotes break the
  attributes.
- If a save still fails with the JSON error, the host's firewall is
  blocking iframes too: ask the host to check its ModSecurity log for that
  save and whitelist the rule (save once without the frame to confirm).
- The earlier inline-script version of this snippet still works where it
  was pasted, but don't use it for new articles.

### A page of its own on the site

To give the ledger a permanent home on wausaupilotandreview.com (e.g.
`wausaupilotandreview.com/care-ledger/`), make a WordPress page with a
**Custom HTML** block holding the full ledger, without lazy loading since
it is the page's main content:

```html
<iframe class="care-ledger" src="https://rowanflynnpilot.github.io/wpr-care-ledger/" title="The Care Ledger: assisted living oversight in central Wisconsin" style="width:100%;border:0;display:block;" height="2000" allow="clipboard-write"></iframe>
```

- Use a wide or full-width page template so the charts and map get room.
  The ledger carries its own WPR flag and headline, so the page can hide
  its title (if the theme offers it) or keep just a one-line intro.
- With `embed.js` installed (step 1 above), links to that page take the
  same endings as the ledger's own address —
  `wausaupilotandreview.com/care-ledger/#lic=0015955`,
  `…/care-ledger/#county=Wood&view=map` — and the ledger's "Copy link to
  this record" gives readers the site page, not the github.io address.
  The same holds for the full ledger embedded in an article.

### Linking to one facility from a story

Add a hash to the iframe `src` (or to the standalone URL):

- `…/wpr-care-ledger/#lic=0015628` — opens that license's row, closed
  facilities included.
- `…/wpr-care-ledger/#q=cedar%20ridge` — presets the search box (works for
  operator names too).
- `…/wpr-care-ledger/#county=Wood` — opens on one county (stats, chart, and
  list all follow), for stories about a neighboring county.
- `…/wpr-care-ledger/#cat=medications` — lists the facilities cited in one
  "What inspectors cite" category (`#cat=abuse`, `#cat=fire-safety`,
  `#cat=staffing` … the start of the name is enough), the same as clicking
  its row.
- `…/wpr-care-ledger/#view=map` — opens on the map instead of the list.
- `county`, `cat`, `q` and `view` combine with `&`:
  `…/wpr-care-ledger/#county=Wood&cat=medications`, or
  `…/wpr-care-ledger/#county=Marathon&view=map` for a map of one county.

### Embedding one facility in a story

`?facility=<license>` shows that facility's record alone, already open,
under a compact WPR flag, with a link to the full ledger. Leading zeros may
be dropped (`?facility=13424`). Paste into a **Custom HTML** block — the
site-wide `embed.js` (step 1 above) sizes it too:

```html
<iframe class="care-ledger" src="https://rowanflynnpilot.github.io/wpr-care-ledger/?facility=0013424" title="The Care Ledger: inspection record for one facility" style="width:100%;border:0;display:block;" height="900" loading="lazy" allow="clipboard-write"></iframe>
```

Links to other facilities or the operator open the full ledger in a new tab.

### A page for every facility

Each facility also has its own plain page, built every deploy for search
engines and for sharing: `…/wpr-care-ledger/facility/our-house-wausau-assisted-care-0013424/`.
All of them are listed at `…/wpr-care-ledger/facility/`, and in
`sitemap.xml` (submit it in Google Search Console once). The widget's
"Page for this facility" link and the facilities CSV give each address.

### Getting the data

Above the facility list, **Download as CSV** exports whatever is in view
(county, search, filters): one row per facility, or one per survey record
with fines, sanctions, cited rules and links to every document. Or take
the raw files: `data/*.json` in this repo.

A [Wausau Pilot & Review](https://wausaupilotandreview.com) project.
