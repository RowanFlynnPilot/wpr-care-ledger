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
  and `data/wayback.json` (the Internet Archive's copies)
- Document archive: `archive/{license}/`

## Every Monday

GitHub Actions runs the tests, then the fetch, then the miner, commits what
changed, and redeploys the widget. Each run's summary page carries a **tip
sheet**: new surveys, new enforcement actions with their forfeitures, and
records that aged off the state site that week (Actions → fetch → latest
run). If a run fails, nothing is committed, a `fetch-failure` issue opens,
and the widget keeps last week's data — telling readers it is behind if a
failure lasts past ten days.

## Email alerts for new enforcement actions

When a run finds a new enforcement action, it opens one GitHub issue
(label `new-enforcement`) per run: the facility, survey, forfeiture,
serious orders, cited rules, and links to the record and the letter.
GitHub emails everyone the issue @mentions.

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
- **First run:** Actions → wayback → Run workflow. It copies everything,
  about 1,100 captures at Save Page Now's limit of 7 a minute: roughly
  three hours. Later weeks take minutes.
- **Finding a copy:** `data/wayback.json` maps each archived PDF to its
  Wayback URL, and each license to the captures of its state page.

## Embedding on wausaupilotandreview.com

Paste this into a **Custom HTML** block in WordPress. The widget reports its
height to the parent page, so the iframe grows and shrinks with searches and
expanded rows — no inner scrollbar.

```html
<iframe
  id="care-ledger"
  src="https://rowanflynnpilot.github.io/wpr-care-ledger/"
  title="The Care Ledger — assisted living oversight in central Wisconsin"
  style="width:100%;border:0;display:block;"
  height="1200"
  loading="lazy"
  allow="clipboard-write"
></iframe>
<script>
  window.addEventListener("message", function (e) {
    if (e.origin !== "https://rowanflynnpilot.github.io") return;
    if (e.data && e.data.type === "wpr-care-ledger:height") {
      document.getElementById("care-ledger").style.height =
        e.data.height + "px";
    }
  });
</script>
```

The `height="1200"` is only the fallback before the first message arrives.

### Linking to one facility from a story

Add a hash to the iframe `src` (or to the standalone URL):

- `…/wpr-care-ledger/#lic=0015628` — opens that license's row, closed
  facilities included.
- `…/wpr-care-ledger/#q=cedar%20ridge` — presets the search box (works for
  operator names too).
- `…/wpr-care-ledger/#county=Wood` — opens on one county (stats, chart, and
  list all follow), for stories about a neighboring county.

A [Wausau Pilot & Review](https://wausaupilotandreview.com) project.
