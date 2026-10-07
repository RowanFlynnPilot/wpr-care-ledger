# wpr-care-ledger

The Care Ledger — assisted living oversight in Marathon County, permanently
archived. Wisconsin's DQA only shows three years of survey history; this
repo never forgets.

- Live widget: <https://rowanflynnpilot.github.io/wpr-care-ledger/>
- Architecture and data contract: `CLAUDE.md`
- Setup: `python -m pip install -r pipeline/requirements.txt` (pinned)
- Tests: `python -m unittest discover -s pipeline/tests`
- Run the fetcher, then the document miner:
  `python pipeline/fetch.py` · `python pipeline/enrich.py`
- Run the widget: `cd widget; npm install; npm run dev`
- Data: `data/facilities.json`, `data/surveys.json`, and the derived
  `data/enrichment.json` (fines, sanctions, citations read from the PDFs)
- Document archive: `archive/{license}/`

## Every Monday

GitHub Actions runs the tests, then the fetch, then the miner, commits what
changed, and redeploys the widget. Each run's summary page carries a **tip
sheet**: new surveys, new enforcement actions with their forfeitures, and
records that aged off the state site that week (Actions → fetch → latest
run). If a run fails, nothing is committed, a `fetch-failure` issue opens,
and the widget keeps last week's data — telling readers it is behind if a
failure lasts past ten days.

## Embedding on wausaupilotandreview.com

Paste this into a **Custom HTML** block in WordPress. The widget reports its
height to the parent page, so the iframe grows and shrinks with searches and
expanded rows — no inner scrollbar.

```html
<iframe
  id="care-ledger"
  src="https://rowanflynnpilot.github.io/wpr-care-ledger/"
  title="The Care Ledger — assisted living oversight in Marathon County"
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

A [Wausau Pilot & Review](https://wausaupilotandreview.com) project.
