"""Weekly tip sheet: what changed in the ledger on its latest run.

Read-only over data/. Prints markdown, and in GitHub Actions also writes it
to the run's summary page ($GITHUB_STEP_SUMMARY), so each weekly run shows
reporters the new surveys, new enforcement actions with assessed
forfeitures, and records that aged off the state site that week.

Run after fetch.py and enrich.py:  python pipeline/digest.py
"""

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# Same print rules as the widget's smartTitle(): state names arrive in
# ALL CAPS; keep licensing acronyms, lowercase the small words.
KEEP_UPPER = {"LLC", "LLP", "INC", "CO", "II", "III", "IV", "AFH", "CBRF", "RCAC", "AF", "ALF"}
KEEP_LOWER = {"of", "and", "the", "at", "by", "for", "on", "in"}


def smart_title(s):
    words = []
    for i, w in enumerate(s.split()):
        bare = "".join(c for c in w if c.isalnum())
        if bare.upper() in KEEP_UPPER:
            words.append(w.upper())
        elif i and bare.lower() in KEEP_LOWER:
            words.append(w.lower())
        else:
            words.append(w[:1].upper() + w[1:].lower())
    return " ".join(words)


def main():
    facilities = json.loads((DATA / "facilities.json").read_text())
    surveys = json.loads((DATA / "surveys.json").read_text())
    enrichment = json.loads((DATA / "enrichment.json").read_text())

    run = max(s["last_seen"] for s in surveys.values())
    first_pull = min(s["first_seen"] for s in surveys.values())

    def fine(s):
        return sum(enrichment.get(p, {}).get("fine") or 0 for p in s["documents"].values())

    def name(s):
        return smart_title(facilities[s["license"]]["name"])

    new = sorted(
        (s for s in surveys.values() if s["first_seen"] == run and run != first_pull),
        key=lambda s: s["exit_date"],
    )
    # Documents that arrived this run on rows first seen earlier — usually an
    # enforcement letter catching up with its statement of deficiency.
    late_docs = sorted(
        ((s, kind) for s in surveys.values() if s["first_seen"] != run
         for kind, seen in s.get("documents_first_seen", {}).items() if seen == run),
        key=lambda sk: sk[0]["exit_date"],
    )
    # expired_on is stamped by fetch.py when it flags a record; rows flagged
    # before that field existed have none and are never credited to a run.
    aged_off = sorted(
        (s for s in surveys.values() if s.get("expired_on") == run),
        key=lambda s: s["exit_date"],
    )
    held = sum(s["expired_from_state"] for s in surveys.values())

    lines = [f"## The Care Ledger — run of {run}", ""]
    lines.append(
        f"**{len(new)}** new survey records · **{len(aged_off)}** aged off the state site "
        f"this run · **{held}** held in the ledger in all"
    )
    enf = [s for s in new if "enforcement" in s["documents"]]
    if enf:
        lines += ["", "### New enforcement actions", "",
                  "| Facility | Survey exit | Type | Forfeiture |", "|---|---|---|---|"]
        for s in enf:
            f = fine(s)
            lines.append(f"| {name(s)} | {s['exit_date']} | {s['survey_type']} | "
                         f"{'$' + format(f, ',') if f else '—'} |")
    other = [s for s in new if "enforcement" not in s["documents"]]
    if other:
        lines += ["", "### Other new surveys", ""]
        lines += [f"- {name(s)} — {s['exit_date']}, {s['survey_type']}" for s in other]
    if late_docs:
        labels = {"enforcement": "**enforcement letter**", "sod": "statement of deficiency",
                  "poc": "plan of correction"}
        lines += ["", "### New documents on earlier surveys", ""]
        lines += [f"- {name(s)} — {s['exit_date']} {s['survey_type']}: {labels[kind]}"
                  + (f" (${fine(s):,} forfeiture)" if kind == "enforcement" and fine(s) else "")
                  for s, kind in late_docs]
    if aged_off:
        lines += ["", "### No longer on the state site (now held only here)", ""]
        lines += [
            f"- {name(s)} — {s['exit_date']}, {s['survey_type']}"
            + (" · **enforcement**" if "enforcement" in s["documents"] else "")
            for s in aged_off
        ]
    text = "\n".join(lines) + "\n"

    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(text)


if __name__ == "__main__":
    sys.exit(main())
