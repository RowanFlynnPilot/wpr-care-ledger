# wpr-care-ledger

The Care Ledger — assisted living oversight in Marathon County, permanently
archived. Wisconsin's DQA only shows three years of survey history; this
repo never forgets.

- Live widget: <https://rowanflynnpilot.github.io/wpr-care-ledger/>
- Architecture and data contract: `CLAUDE.md`
- Run the fetcher: `python pipeline/fetch.py`
- Run the widget: `cd widget; npm install; npm run dev`
- Data: `data/facilities.json`, `data/surveys.json`
- Document archive: `archive/{license}/`

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

A [Wausau Pilot & Review](https://wausaupilotandreview.com) project.
