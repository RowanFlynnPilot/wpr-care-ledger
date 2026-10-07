"""Weekly tip sheet and new-enforcement alerts.

Read-only over data/.

  python pipeline/digest.py               tip sheet: prints markdown and, in
                                          Actions, writes it to the run's
                                          summary page
  python pipeline/digest.py --alert       opens a GitHub issue for enforcement
                                          actions new in the latest run; the
                                          issue @mentions $ALERT_MENTIONS, and
                                          GitHub emails whoever it notifies
  python pipeline/digest.py --test-alert  the same issue, marked [TEST], built
                                          from the three most recent
                                          enforcement actions on record

Alerts need the gh CLI and GH_TOKEN (Actions provides both). Each action
carries a hidden marker in its issue body; an action already alerted is
never alerted again, so reruns don't send duplicate email.
"""

import json
import os
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

SITE = "https://rowanflynnpilot.github.io/wpr-care-ledger/"
LABEL = "new-enforcement"
ITEM_MARK = "care-ledger-alert-item:"
TEST_MARK = "care-ledger-test-item:"

# Same print rules as the widget's smartTitle(): state names arrive in
# ALL CAPS; keep licensing acronyms, lowercase the small words.
KEEP_UPPER = {"LLC", "LLP", "INC", "CO", "II", "III", "IV", "AFH", "CBRF", "RCAC", "AF", "ALF"}
KEEP_LOWER = {"of", "and", "the", "at", "by", "for", "on", "in"}

SURVEY_PART_LABELS = {
    "SURVEY": "Standard survey", "COMPLAINT": "Complaint investigation",
    "VV": "Follow-up visit", "VERIFICATION VISIT": "Verification visit",
    "SELF REPORT": "Self-report investigation", "DESK REVIEW": "Desk review",
}
TYPE_ABBR = {
    "Adult Family Home": "AFH",
    "Community Based Residential Facility": "CBRF",
    "Residential Care Apartment Complex": "RCAC",
}
# Orders worth a line in an alert; every letter carries "Order to comply".
ORDER_TEXT = {
    "Revocation": "License revocation",
    "Summary suspension": "Summary suspension",
    "Nonrenewal": "License nonrenewal",
    "Admissions ban": "Order not to admit new residents",
    "Special orders": "Special orders",
    "Plan of correction ordered": "Order to submit a plan of correction",
}


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


def long_date(iso):
    d = date.fromisoformat(iso)
    return f"{d:%B} {d.day}, {d.year}"


def survey_label(raw):
    return " + ".join(SURVEY_PART_LABELS.get(p.strip(), p.strip().title()) for p in raw.split("/"))


class Ledger:
    def __init__(self):
        self.facilities = json.loads((DATA / "facilities.json").read_text())
        self.surveys = json.loads((DATA / "surveys.json").read_text())
        self.enrichment = json.loads((DATA / "enrichment.json").read_text())
        self.run = max(s["last_seen"] for s in self.surveys.values())
        self.first_pull = min(s["first_seen"] for s in self.surveys.values())

    def kind(self, column, path):
        # Parsed structure wins over the state's column (0019331 is swapped).
        k = self.enrichment.get(path, {}).get("kind")
        return k if k in ("enforcement", "sod") else column

    def doc(self, s, kind):
        """(column, path) of the survey's document of a structural kind."""
        return next(((c, p) for c, p in s["documents"].items() if self.kind(c, p) == kind), None)

    def fine(self, s):
        return sum(self.enrichment.get(p, {}).get("fine") or 0 for p in s["documents"].values())

    def name(self, s):
        return smart_title(self.facilities[s["license"]]["name"])

    def new_enforcement(self):
        """(survey id, survey, letter path, late) for every enforcement
        action new in the latest run: a new survey that carries a letter, or
        a letter that arrived on a survey first seen earlier."""
        items = []
        for sid, s in self.surveys.items():
            found = self.doc(s, "enforcement")
            if not found:
                continue
            column, path = found
            if s["first_seen"] == self.run and self.run != self.first_pull:
                items.append((sid, s, path, False))
            elif s.get("documents_first_seen", {}).get(column) == self.run:
                items.append((sid, s, path, True))
        return sorted(items, key=lambda it: it[1]["exit_date"])

    def recent_enforcement(self, n):
        items = [(sid, s, self.doc(s, "enforcement")[1], False)
                 for sid, s in self.surveys.items() if self.doc(s, "enforcement")]
        return sorted(items, key=lambda it: it[1]["exit_date"])[-n:]


# --------------------------------------------------------------- tip sheet

def tip_sheet(L):
    new = sorted(
        (s for s in L.surveys.values() if s["first_seen"] == L.run and L.run != L.first_pull),
        key=lambda s: s["exit_date"],
    )
    # Documents that arrived this run on rows first seen earlier — usually an
    # enforcement letter catching up with its statement of deficiency.
    late_docs = sorted(
        ((s, L.kind(column, s["documents"][column]))
         for s in L.surveys.values() if s["first_seen"] != L.run
         for column, seen in s.get("documents_first_seen", {}).items() if seen == L.run),
        key=lambda sk: sk[0]["exit_date"],
    )
    # expired_on is stamped by fetch.py when it flags a record; rows flagged
    # before that field existed have none and are never credited to a run.
    aged_off = sorted(
        (s for s in L.surveys.values() if s.get("expired_on") == L.run),
        key=lambda s: s["exit_date"],
    )
    held = sum(s["expired_from_state"] for s in L.surveys.values())

    lines = [f"## The Care Ledger — run of {L.run}", ""]
    lines.append(
        f"**{len(new)}** new survey records · **{len(aged_off)}** aged off the state site "
        f"this run · **{held}** held in the ledger in all"
    )
    enf = [s for s in new if L.doc(s, "enforcement")]
    if enf:
        lines += ["", "### New enforcement actions", "",
                  "| Facility | Survey exit | Type | Forfeiture |", "|---|---|---|---|"]
        for s in enf:
            f = L.fine(s)
            lines.append(f"| {L.name(s)} | {s['exit_date']} | {s['survey_type']} | "
                         f"{'$' + format(f, ',') if f else '—'} |")
    other = [s for s in new if not L.doc(s, "enforcement")]
    if other:
        lines += ["", "### Other new surveys", ""]
        lines += [f"- {L.name(s)} — {s['exit_date']}, {s['survey_type']}" for s in other]
    if late_docs:
        labels = {"enforcement": "**enforcement letter**", "sod": "statement of deficiency",
                  "poc": "plan of correction"}
        lines += ["", "### New documents on earlier surveys", ""]
        lines += [f"- {L.name(s)} — {s['exit_date']} {s['survey_type']}: {labels[kind]}"
                  + (f" (${L.fine(s):,} forfeiture)" if kind == "enforcement" and L.fine(s) else "")
                  for s, kind in late_docs]
    if aged_off:
        lines += ["", "### No longer on the state site (now held only here)", ""]
        lines += [
            f"- {L.name(s)} — {s['exit_date']}, {s['survey_type']}"
            + (" · **enforcement**" if L.doc(s, "enforcement") else "")
            for s in aged_off
        ]
    text = "\n".join(lines) + "\n"
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(text)


# ------------------------------------------------------------------ alerts

def render_item(L, sid, s, path, late, mark):
    f = L.facilities[s["license"]]
    letter = L.enrichment.get(path, {})
    sod_doc = L.doc(s, "sod")
    sod = L.enrichment.get(sod_doc[1], {}) if sod_doc else {}
    abbr = TYPE_ABBR.get(f["provider_type"].strip(), f["provider_type"].strip())
    repo = os.environ.get("GITHUB_REPOSITORY", "RowanFlynnPilot/wpr-care-ledger")
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")

    lines = [f"### {smart_title(f['name'])} — {f['city'].title()} ({abbr})", ""]
    lines.append(f"- **Survey:** {survey_label(s['survey_type'])}, closed {long_date(s['exit_date'])}"
                 + (" — the enforcement letter was posted after the survey first appeared"
                    if late else ""))
    if letter.get("fine"):
        accruing = "Accruing forfeiture" in letter.get("sanctions", [])
        lines.append(f"- **Forfeiture:** ${letter['fine']:,}"
                     + (" (accruing — the amount so far, not final)" if accruing else ""))
    orders = [ORDER_TEXT[x] for x in letter.get("sanctions", []) if x in ORDER_TEXT]
    if orders:
        lines.append(f"- **Orders:** {' · '.join(orders)}")
    if sod.get("complaints_substantiated"):
        lines.append("- **Complaint substantiated**")
    titles = {}
    for c in sod.get("citations", []):
        t = c["title"].rstrip(".:")
        titles[t] = titles.get(t, 0) + 1
    if titles:
        shown = [f"{t} ×{n}" if n > 1 else t for t, n in titles.items()]
        lines.append(f"- **Cited:** {' · '.join(shown[:4])}"
                     + (f" · +{len(shown) - 4} more" if len(shown) > 4 else ""))
    lines.append(f"- [Open in the Care Ledger]({SITE}#lic={s['license']}) · "
                 f"[Enforcement letter (PDF)]({server}/{repo}/blob/main/{path})")
    lines.append(f"<!-- {mark} {sid} -->")
    return "\n".join(lines)


def compose(L, items, mark, test):
    names = list(dict.fromkeys(L.name(s) for _, s, _, _ in items))
    if len(items) == 1:
        fine = L.enrichment.get(items[0][2], {}).get("fine")
        title = f"New enforcement action: {names[0]}" + (f" — ${fine:,} forfeiture" if fine else "")
    else:
        at = f" at {len(names)} facilities" if len(names) < len(items) else ""
        title = (f"{len(items)} new enforcement actions{at}: {', '.join(names[:2])}"
                 + (f" and {len(names) - 2} more" if len(names) > 2 else ""))
    intro = (f"**{len(items)} new enforcement action{'s' if len(items) > 1 else ''}** "
             f"appeared in the Care Ledger's run of {long_date(L.run)}.")
    if test:
        title = f"[TEST] {title}"
        intro = ("> **Test alert.** Nothing new happened — this shows what an alert looks "
                 "like, using the three most recent enforcement actions on record. Close "
                 "this issue when you've seen the email.")
    run_url = (f"{os.environ['GITHUB_SERVER_URL']}/{os.environ['GITHUB_REPOSITORY']}"
               f"/actions/runs/{os.environ['GITHUB_RUN_ID']}"
               if os.environ.get("GITHUB_RUN_ID") else None)
    footer = ("---\nSent by the Care Ledger's alert-test workflow." if test else
              "---\nSent automatically by the Care Ledger's weekly fetch. "
              + (f"[Full weekly tip sheet]({run_url}). " if run_url else "")
              + "Close this issue once reviewed.")
    body = "\n\n".join([intro] + [render_item(L, *it, mark) for it in items] + [footer])
    mentions = os.environ.get("ALERT_MENTIONS", "").strip()
    if mentions:
        body += f"\n\nNotifying: {mentions}"
    return title, body + "\n"


def gh(*args, stdin=None):
    return subprocess.run(["gh", *args], input=stdin, capture_output=True,
                          text=True, check=True).stdout


def ensure_label():
    gh("label", "create", LABEL, "--color", "B32D2E",
       "--description", "New enforcement action in the Care Ledger", "--force")


def post(title, body):
    url = gh("issue", "create", "--title", title, "--label", LABEL, "--body-file", "-",
             stdin=body).strip()
    print(f"alert posted: {url}")


def alert(L):
    items = L.new_enforcement()
    if items:
        ensure_label()
        # Markers of every action already alerted; reruns send nothing twice.
        sent = gh("issue", "list", "--label", LABEL, "--state", "all", "--limit", "200",
                  "--json", "body", "--jq", ".[].body")
        items = [it for it in items if f"{ITEM_MARK} {it[0]} " not in sent]
    if not items:
        print("no new enforcement actions to alert")
        return
    post(*compose(L, items, ITEM_MARK, test=False))


def main():
    L = Ledger()
    if "--alert" in sys.argv:
        alert(L)
    elif "--test-alert" in sys.argv:
        ensure_label()
        post(*compose(L, L.recent_enforcement(3), TEST_MARK, test=True))
    else:
        tip_sheet(L)


if __name__ == "__main__":
    sys.exit(main())
