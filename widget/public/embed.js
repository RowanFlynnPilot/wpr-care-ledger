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

  window.addEventListener("message", function (e) {
    if (e.origin !== ORIGIN || !e.data || e.data.type !== "wpr-care-ledger:height") return;
    var frames = ledgerFrames();
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === e.source) {
        frames[i].style.height = Math.ceil(e.data.height) + "px";
        frames[i].setAttribute("scrolling", "no");
      }
    }
  });

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
