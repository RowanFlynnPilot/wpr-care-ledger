/* The Care Ledger: sizes its embedded frames to their content.
 *
 * Install once, site-wide (a header/footer code setting), so articles carry
 * only a plain <iframe> - no JavaScript in post content, which security
 * firewalls (ModSecurity) often block when WordPress saves a post ("The
 * response is not a valid JSON response"), and which WordPress strips for
 * authors without unfiltered_html anyway:
 *
 *   <script src="https://rowanflynnpilot.github.io/wpr-care-ledger/embed.js" defer></script>
 *
 * Each ledger frame posts {type: "wpr-care-ledger:height", height} whenever
 * its content changes size; this sets that frame - matched by the window
 * that sent the message, so the full ledger and any number of
 * single-facility embeds share a page - to that height. Frames that loaded
 * before this script are asked to measure again. Safe to include twice.
 *
 * For full-ledger frames (not ?facility= embeds) it also passes this page's
 * ledger link on (wausaupilotandreview.com/care-ledger/#lic=0015955 opens
 * that record) and tells the frame this page's address, so the ledger's
 * "Copy link to this record" points readers here.
 */
(function () {
  if (window.__careLedgerEmbed) return;
  window.__careLedgerEmbed = true;

  // The ledger's own address, from where this file was served: it can't
  // drift from the frames it sizes.
  var ORIGIN = new URL(document.currentScript.src).origin;

  function ledgerFrames() {
    var all = document.getElementsByTagName("iframe");
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if ((all[i].src || "").indexOf(ORIGIN + "/") === 0) out.push(all[i]);
    }
    return out;
  }

  // The full ledger, not a ?facility= embed of one record.
  function isFullLedger(frame) {
    return frame.src.indexOf("?facility=") === -1;
  }

  window.addEventListener("message", function (e) {
    if (e.origin !== ORIGIN || !e.data || e.data.type !== "wpr-care-ledger:height") return;
    var frames = ledgerFrames();
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === e.source) {
        frames[i].style.height = Math.ceil(e.data.height) + "px";
        frames[i].setAttribute("scrolling", "no");
        // Once a full ledger is up, tell it which page it is on (query
        // included: ?p=123 and preview links address a page by it), so its
        // "Copy link to this record" gives readers this page (which opens
        // on the record, below) rather than the ledger's own address. And
        // pass the story link on again: a lazy-loading plugin may have
        // given the frame its src after this script first looked.
        if (isFullLedger(frames[i]) && !frames[i].hasAttribute("data-host-told")) {
          frames[i].setAttribute("data-host-told", "");
          e.source.postMessage(
            { type: "wpr-care-ledger:host", url: location.origin + location.pathname + location.search },
            ORIGIN
          );
          forwardHash();
        }
      }
    }
  });

  // A link to this page ending in a ledger link (#lic=0015955, #q=…,
  // #county=…, #cat=…, #view=map) is passed on to the full-ledger frames:
  // the hash belongs to this page, and would never reach them otherwise.
  // Other hashes (#comments) are left alone.
  var LEDGER_HASH = /(?:^#|&)(?:lic|q|county|cat|view)=/;
  function forwardHash() {
    if (!LEDGER_HASH.test(location.hash)) return;
    var frames = ledgerFrames();
    for (var i = 0; i < frames.length; i++) {
      if (!isFullLedger(frames[i])) continue;
      var next = frames[i].src.split("#")[0] + location.hash;
      if (frames[i].src !== next) frames[i].src = next; // a fragment change: no reload
    }
  }
  forwardHash();
  window.addEventListener("hashchange", forwardHash);

  // A frame that reported its height before this script ran would stay at
  // its fallback height: ask every ledger frame to measure again.
  function askAll() {
    var frames = ledgerFrames();
    for (var i = 0; i < frames.length; i++) {
      try {
        frames[i].contentWindow.postMessage({ type: "wpr-care-ledger:measure" }, ORIGIN);
      } catch (err) {
        /* not loaded yet: it reports on its own once it is */
      }
    }
  }
  askAll();
  window.addEventListener("load", askAll);
})();
