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
import re
import subprocess
import sys
import unicodedata
from datetime import date, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

SITE = "https://rowanflynnpilot.github.io/wpr-care-ledger/"
LABEL = "new-enforcement"
ITEM_MARK = "care-ledger-alert-item:"
TEST_MARK = "care-ledger-test-item:"
REVISION_MARK = "care-ledger-revision:"

# Same print rules as the widget's smartTitle(): state names arrive in
# ALL CAPS; keep licensing acronyms, lowercase the small words.
KEEP_UPPER = {"LLC", "LLP", "CO", "II", "III", "IV", "VI", "VII", "VIII", "AFH", "CBRF", "RCAC", "CSL", "LSS",
              "NSH", "AF", "ALF", "WI", "USA", "SLF", "HCBS", "OSL"}
KEEP_LOWER = {"of", "and", "the", "at", "by", "for", "on", "in", "or", "to"}
# Vowel-less abbreviations that are words in an address, not initials.
STREET_WORDS = {"ST", "RD", "DR", "LN", "CT", "PL", "MT", "FT", "BLDG", "BLVD", "PKWY", "CTR"}

SURVEY_PART_LABELS = {
    "SURVEY": "Standard survey", "COMPLAINT": "Complaint investigation",
    "VV": "Follow-up visit", "VERIFICATION VISIT": "Follow-up visit",
    "SELF REPORT": "Self-report investigation", "DESK REVIEW": "Desk review",
    "OTHER": "Other inspection", "LICENSURE": "Licensure inspection",
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
    "Admissions ban extended": "Order not to admit new residents, extended",
    "Special orders": "Special orders",
    "Plan of correction ordered": "Order to submit a plan of correction",
}


def smart_title(s):
    # "WATERFORD AT COLBY (THE)" -> "The Waterford at Colby", as the widget prints it.
    # Also a bare trailing "THE": "COTTAGES MEMORY CARE THE".
    filed = re.match(r"^(.*?)\s*(?:\(THE\)|,\s*THE|\s+THE)$", s.strip(), re.I)
    if filed:
        s = f"The {filed.group(1)}"
    words = []
    for i, w in enumerate(s.split()):
        bare = re.sub(r"[^A-Za-z0-9]", "", w)
        BARE = bare.upper()
        if BARE == "INC" and BARE not in KEEP_UPPER:
            words.append(re.sub(r"inc\.?", "Inc.", w, flags=re.I))  # AP: "Inc.", not "INC"
        elif (BARE in KEEP_UPPER or re.fullmatch(r"[A-Za-z]{1,3}&[A-Za-z]{1,3}", w)
              # initials: short, vowel-less, not a street word (KSMS, TC; not St, Rd)
              or (re.fullmatch(r"[A-Z]{2,5}", BARE) and not re.search(r"[AEIOUY]", BARE)
                  and BARE not in STREET_WORDS)
              or re.fullmatch(r"[A-Z]{1,3}\d+", BARE)):  # an identifier: WR1, M311
            words.append(w.upper())  # LLC; initials joined by "&": C&K, K&DS
        elif i and bare.lower() in KEEP_LOWER:
            words.append(w.lower())
        else:
            w = re.sub(r"(^|[-/(&])([a-z])", lambda m: m.group(1) + m.group(2).upper(), w.lower())
            words.append(re.sub(r"^Mc([a-z])(?=[a-z]{2})", lambda m: "Mc" + m.group(1).upper(), w))
    return " ".join(words)


AP_MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.",
             "Nov.", "Dec."]


def ap_date(iso):
    # AP style, as the widget's fmtDate(): "Sept. 21, 2026", "March 27, 2026".
    d = date.fromisoformat(iso)
    return f"{AP_MONTHS[d.month - 1]} {d.day}, {d.year}"


def facility_slug(f):
    # The widget's facilitySlug(): facility/<name>-<license>/. Same steps in
    # the same order, so a tip-sheet link lands on the page the build wrote.
    name = unicodedata.normalize("NFKD", smart_title(f["name"]).lower())
    name = re.sub(r"[^a-z0-9]+", "-", name).strip("-")
    return f"{name}-{f['license']}"


def page_url(f):
    return f"{SITE}facility/{facility_slug(f)}/"


# The widget's STREET_ABBR / addressKey(): "RD" and "Road" are one address.
STREET_ABBR = {
    "ROAD": "RD", "DRIVE": "DR", "STREET": "ST", "AVENUE": "AVE", "LANE": "LN", "COURT": "CT",
    "BOULEVARD": "BLVD", "PLACE": "PL", "CIRCLE": "CIR", "PARKWAY": "PKWY", "HIGHWAY": "HWY",
    "TRAIL": "TRL", "TERRACE": "TER", "NORTH": "N", "SOUTH": "S", "EAST": "E", "WEST": "W",
}


def address_key(f):
    words = re.split(r"[^A-Z0-9]+", f"{f['address']} {f['city']}".upper())
    return "".join(STREET_ABBR.get(w, w) for w in words if w)


def cite_summary(citations, limit=3):
    # "Services ×2 · Tenant rights", as the widget's citeSummary().
    counts = {}
    for c in citations:
        t = c["title"].rstrip(".:")
        counts[t] = counts.get(t, 0) + 1
    shown = [f"{t} ×{n}" if n > 1 else t for t, n in counts.items()]
    return " · ".join(shown[:limit]) + (f" · +{len(shown) - limit} more" if len(shown) > limit else "")


def complaints_line(n):
    return "Complaint substantiated" if n == 1 else f"{n} complaints substantiated"


def survey_label(raw):
    # "SURVEY/COMPLAINT" -> "Standard survey and complaint investigation", as the widget prints it.
    parts = [SURVEY_PART_LABELS.get(p.strip().upper(), p.strip().title()) for p in raw.split("/")]
    return " and ".join([parts[0]] + [p[0].lower() + p[1:] for p in parts[1:]])


class Ledger:
    def __init__(self):
        self.facilities = json.loads((DATA / "facilities.json").read_text())
        self.surveys = json.loads((DATA / "surveys.json").read_text())
        self.enrichment = json.loads((DATA / "enrichment.json").read_text())
        self.run = max(s["last_seen"] for s in self.surveys.values())
        # Each county's first capture is its starting archive, not news:
        # Marathon began 2026-07-12, its neighbors 2026-10-06.
        self.county_start = {}
        for f in self.facilities.values():
            c = f["county"]
            self.county_start[c] = min(self.county_start.get(c, f["first_seen"]), f["first_seen"])

    def is_new(self, s):
        """First seen this run, in a county the ledger already covered."""
        county = self.facilities[s["license"]]["county"]
        return s["first_seen"] == self.run and self.county_start[county] < self.run

    def kind(self, column, path):
        # Parsed structure wins over the state's column (0019331 is swapped).
        k = self.enrichment.get(path, {}).get("kind")
        return k if k in ("enforcement", "sod") else column

    @staticmethod
    def current(s):
        """column -> path of each document's latest version (a revision the
        state posted over the original, else the original)."""
        return {c: (s.get("revisions", {}).get(c) or [{"path": p}])[-1]["path"]
                for c, p in s["documents"].items()}

    def doc(self, s, kind):
        """(column, path) of the survey's document of a structural kind."""
        return next(((c, p) for c, p in self.current(s).items() if self.kind(c, p) == kind), None)

    def fine(self, s, paths=None):
        paths = self.current(s).values() if paths is None else paths
        return sum(self.enrichment.get(p, {}).get("fine") or 0 for p in paths)

    def revised(self):
        """(survey, column, original path, revision) for each document the
        state replaced, found this run."""
        return sorted(
            ((s, c, s["documents"][c], revs[-1])
             for s in self.surveys.values()
             for c, revs in s.get("revisions", {}).items() if revs[-1]["first_seen"] == self.run),
            key=lambda x: x[0]["exit_date"],
        )

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
            if self.is_new(s):
                items.append((sid, s, path, False))
            elif (s["first_seen"] < self.run
                  and s.get("documents_first_seen", {}).get(column) == self.run):
                # A letter arriving on a survey seen in an earlier run. Every
                # document of a county's first capture is stamped this run
                # too; without the row check, adding eight counties would
                # have emailed 156 "new" actions.
                items.append((sid, s, path, True))
        return sorted(items, key=lambda it: it[1]["exit_date"])

    def recent_enforcement(self, n):
        items = [(sid, s, self.doc(s, "enforcement")[1], False)
                 for sid, s in self.surveys.items() if self.doc(s, "enforcement")]
        return sorted(items, key=lambda it: it[1]["exit_date"])[-n:]


def http_date(header):
    """The state's Last-Modified header as a newsroom date ("on Sept. 21,
    2026"); "this week" if the server sent none."""
    if not header:
        return "this week"
    return "on " + ap_date(parsedate_to_datetime(header).date().isoformat())


def revision_changes(L, original, revised):
    """What the ledger's figures did between two versions of a document."""
    was, now = L.enrichment.get(original, {}), L.enrichment.get(revised, {})
    changes = []
    if (was.get("fine") or 0) != (now.get("fine") or 0):
        changes.append(f"forfeiture ${was.get('fine') or 0:,} → ${now.get('fine') or 0:,}")
    if was.get("deficiencies") != now.get("deficiencies"):
        changes.append(f"deficiencies {was.get('deficiencies')} → {now.get('deficiencies')}")
    return changes


# --------------------------------------------------------------- tip sheet

def tip_sheet(L):
    """The weekly tip sheet: what changed in the run, each item linked to
    its facility page and documents, in the widget's vocabulary."""
    new = sorted((s for s in L.surveys.values() if L.is_new(s)), key=lambda s: s["exit_date"])
    started = sorted(c.title() for c, d in L.county_start.items() if d == L.run)
    # Documents that arrived this run on rows first seen earlier — usually an
    # enforcement letter catching up with its statement of deficiency.
    late_docs = sorted(
        ((s, column)
         for s in L.surveys.values() if s["first_seen"] != L.run
         for column, seen in s.get("documents_first_seen", {}).items() if seen == L.run),
        key=lambda sc: sc[0]["exit_date"],
    )
    # expired_on is stamped by fetch.py when it flags a record; rows flagged
    # before that field existed have none and are never credited to a run.
    aged_off = sorted(
        (s for s in L.surveys.values() if s.get("expired_on") == L.run),
        key=lambda s: s["exit_date"],
    )
    held = sum(s["expired_from_state"] for s in L.surveys.values())
    enf = [s for s in new if L.doc(s, "enforcement")]
    other = [s for s in new if not L.doc(s, "enforcement")]
    late_enf = [(s, c) for s, c in late_docs if L.kind(c, L.current(s)[c]) == "enforcement"]
    actions = len(enf) + len(late_enf)
    labels = {"enforcement": "enforcement letter", "sod": "statement of deficiency",
              "poc": "plan of correction"}

    def who(s):
        f = L.facilities[s["license"]]
        return (f"[{smart_title(f['name'])}]({page_url(f)}) "
                f"({f['city'].title()}, {f['county'].title()} County)")

    def pdf(path, text):
        return f"[{text}]({SITE}{path})"

    def facts(s):
        """Fine, orders, complaints and cited rules, as the record prints them."""
        parts = []
        letter = L.doc(s, "enforcement")
        if letter:
            e = L.enrichment.get(letter[1], {})
            if e.get("fine"):
                accruing = "Accruing forfeiture" in e.get("sanctions", [])
                parts.append(f"**${e['fine']:,} forfeiture**" + (" (accruing, so far)" if accruing else ""))
            parts += [ORDER_TEXT[x] for x in e.get("sanctions", []) if x in ORDER_TEXT]
        sod = L.doc(s, "sod")
        if sod:
            e = L.enrichment.get(sod[1], {})
            if e.get("complaints_substantiated"):
                parts.append(complaints_line(e["complaints_substantiated"]))
            if e.get("citations"):
                parts.append(f"Cited: {cite_summary(e['citations'])}")
            elif e.get("deficiencies") == 0:
                parts.append("No deficiencies")
        return parts

    def inspection(s):
        return f"{survey_label(s['survey_type'])} ended {ap_date(s['exit_date'])}"

    def docs(s):
        return " · ".join(pdf(p, f"{labels.get(L.kind(c, p), c).capitalize()} (PDF)")
                          for c, p in L.current(s).items())

    def line(s, lead=""):
        detail = " · ".join(facts(s))
        return f"- {lead}{who(s)} — {inspection(s)}" + (f". {detail}" if detail else "") + f". {docs(s)}"

    plural = lambda n, one, many: f"**{n}** {one if n == 1 else many}"
    lines = [f"## The Care Ledger: week of {ap_date(L.run)}", ""]
    lines.append(" · ".join([
        plural(len(new), "new inspection record", "new inspection records"),
        plural(actions, "new enforcement action", "new enforcement actions"),
        f"**{len(aged_off)}** no longer listed by the state this week",
        f"**{held}** held in the ledger in all",
    ]))
    if started:
        lines += ["", f"First capture of {', '.join(started)} "
                      f"{'County' if len(started) == 1 else 'counties'}: its archive starts here, "
                      "so none of its records count as new."]
    if enf:
        lines += ["", "### New enforcement actions", ""]
        lines += [line(s) for s in enf]
    if late_docs:
        lines += ["", "### New documents on earlier inspections", ""]
        for s, column in late_docs:
            path = L.current(s)[column]
            kind = L.kind(column, path)
            detail = " · ".join(facts(s)) if kind == "enforcement" else ""
            lines.append(f"- {who(s)} — {inspection(s)}: new {pdf(path, labels.get(kind, kind))}"
                         + (f". {detail}" if detail else ""))
    if other:
        lines += ["", "### Other new inspections", ""]
        lines += [line(s) for s in other]
    revised = L.revised()
    if revised:
        lines += ["", "### Documents the state replaced (originals kept here)", ""]
        for s, column, original, rev in revised:
            changes = revision_changes(L, original, rev["path"])
            label = labels.get(L.kind(column, original), column)
            lines.append(f"- {who(s)} — {inspection(s)}: the state replaced the {label} "
                         f"{http_date(rev['last_modified'])}"
                         + (f" ({', '.join(changes)})" if changes else "")
                         + f". {pdf(original, 'Original')} · {pdf(rev['path'], 'new version')}")
    # A document whose state address stopped answering this run: the state
    # removing a file, the one thing that would make "delisted, not
    # deleted" untrue. The ledger's copy is then the public one.
    stopped = sorted(((s, c) for s in L.surveys.values()
                      for c, day in s.get("documents_gone", {}).items() if day == L.run),
                     key=lambda sc: sc[0]["exit_date"])
    if stopped:
        lines += ["", "### Documents the state stopped serving (copies kept here)", ""]
        for s, column in stopped:
            path = L.current(s)[column]
            label = labels.get(L.kind(column, path), column)
            lines.append(f"- **{who(s)}** — {inspection(s)}: the state's address for the {label} "
                         f"no longer answers. {pdf(path, 'The ledger’s copy')} · "
                         f"state address: {s['document_urls'][column]}")
    # The roster: new licenses — flagged when one opens where a closed
    # facility was, the license flip of the Acorn Hill and Hummingbird Road
    # stories — and closures the roster reports in the last two weeks.
    opened = sorted((f for f in L.facilities.values()
                     if f["first_seen"] == L.run and L.county_start[f["county"]] < L.run),
                    key=lambda f: f["name"])
    since = (date.fromisoformat(L.run) - timedelta(days=13)).isoformat()
    closed = sorted((f for f in L.facilities.values() if (f.get("date_closed") or "") >= since),
                    key=lambda f: f["date_closed"])
    if opened or closed:
        lines += ["", "### Roster changes", ""]
        for f in opened:
            flips = [o for o in L.facilities.values()
                     if o is not f and o.get("date_closed") and address_key(o) == address_key(f)]
            abbr = TYPE_ABBR.get(f["provider_type"].strip(), f["provider_type"].strip())
            lines.append(f"- New: [{smart_title(f['name'])}]({page_url(f)}) ({f['city'].title()}, {abbr})"
                         + "".join(f" — **same address as [{smart_title(o['name'])}]({page_url(o)}), "
                                   f"closed {ap_date(o['date_closed'])}**" for o in flips))
        for f in closed:
            lines.append(f"- Closed {ap_date(f['date_closed'])}: "
                         f"[{smart_title(f['name'])}]({page_url(f)}) ({f['city'].title()})")
    if aged_off:
        lines += ["", "### No longer listed by the state (now held here)", ""]
        lines += [f"- {who(s)} — {inspection(s)}"
                  + (" · **enforcement action**" if L.doc(s, "enforcement") else "")
                  for s in aged_off]
    lines += ["", f"[Open the Care Ledger]({SITE}) · figures as of the {ap_date(L.run)} run"]
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

    lines = [f"### {smart_title(f['name'])} — {f['city'].title()}, "
             f"{f['county'].title()} County ({abbr})", ""]
    lines.append(f"- **Inspection:** {survey_label(s['survey_type'])}, ended {ap_date(s['exit_date'])}"
                 + (" — the enforcement letter was posted after the inspection first appeared"
                    if late else ""))
    if letter.get("fine"):
        accruing = "Accruing forfeiture" in letter.get("sanctions", [])
        lines.append(f"- **Forfeiture:** ${letter['fine']:,}"
                     + (" (accruing — the amount so far, not final)" if accruing else ""))
    orders = [ORDER_TEXT[x] for x in letter.get("sanctions", []) if x in ORDER_TEXT]
    if orders:
        lines.append(f"- **Orders:** {' · '.join(orders)}")
    if sod.get("complaints_substantiated"):
        lines.append(f"- **{complaints_line(sod['complaints_substantiated'])}**")
    if sod.get("citations"):
        lines.append(f"- **Cited:** {cite_summary(sod['citations'], limit=4)}")
    lines.append(f"- [Open in the Care Ledger]({SITE}#lic={s['license']}) · "
                 f"[Facility page]({page_url(f)}) · [Enforcement letter (PDF)]({SITE}{path})")
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
             f"appeared in the Care Ledger's run of {ap_date(L.run)}.")
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
    # UTF-8 explicitly: on Windows the default code page can't encode "→".
    return subprocess.run(["gh", *args], input=stdin, capture_output=True,
                          text=True, encoding="utf-8", check=True).stdout


def ensure_label():
    gh("label", "create", LABEL, "--color", "B32D2E",
       "--description", "New enforcement action in the Care Ledger", "--force")


def post(title, body):
    url = gh("issue", "create", "--title", title, "--label", LABEL, "--body-file", "-",
             stdin=body).strip()
    print(f"alert posted: {url}")


def compose_revisions(L, items):
    """One alert for documents the state replaced at their addresses."""
    names = list(dict.fromkeys(L.name(s) for s, *_ in items))
    labels = {"enforcement": "enforcement letter", "sod": "statement of deficiency",
              "poc": "plan of correction"}
    title = (f"State revised records: {', '.join(names[:2])}"
             + (f" and {len(names) - 2} more" if len(names) > 2 else ""))
    parts = [f"**The state replaced {len(items)} document{'s' if len(items) > 1 else ''}** "
             f"at {'their addresses' if len(items) > 1 else 'its address'}, found in the Care "
             f"Ledger's run of {ap_date(L.run)}. The originals are kept in the ledger; the "
             f"state's site now shows only the new versions. Ask DQA why before reporting it."]
    # One heading per survey: a reissue usually replaces its letter and its
    # statement of deficiency together.
    by_survey = {}
    for item in items:
        by_survey.setdefault(id(item[0]), []).append(item)
    for group in by_survey.values():
        s = group[0][0]
        f = L.facilities[s["license"]]
        lines = [
            f"### {smart_title(f['name'])} — {f['city'].title()}, {f['county'].title()} County",
            "",
            f"- **Inspection:** {survey_label(s['survey_type'])}, ended {ap_date(s['exit_date'])}",
        ]
        for _, column, original, rev in group:
            changes = revision_changes(L, original, rev["path"])
            lines.append(
                f"- **{labels[L.kind(column, original)].capitalize()}** replaced on the state's site "
                f"{http_date(rev['last_modified'])}" + (f": {'; '.join(changes)}" if changes else "")
                + f" — [original]({SITE}{original}) · [new version]({SITE}{rev['path']})"
            )
        lines.append(f"- [Open in the Care Ledger]({SITE}#lic={s['license']}) · "
                     f"[Facility page]({page_url(f)})")
        lines += [f"<!-- {REVISION_MARK} {s['license']}|{s['exit_date']}|{rev['path']} -->"
                  for _, _, _, rev in group]
        parts.append("\n".join(lines))
    body = "\n\n".join(parts + ["---\nSent automatically by the Care Ledger's weekly fetch. "
                                "Close this issue once reviewed."])
    mentions = os.environ.get("ALERT_MENTIONS", "").strip()
    if mentions:
        body += f"\n\nNotifying: {mentions}"
    return title, body + "\n"


def alert(L):
    items = L.new_enforcement()
    revised = L.revised()
    if items or revised:
        ensure_label()
        # Markers of everything already alerted; reruns send nothing twice.
        sent = gh("issue", "list", "--label", LABEL, "--state", "all", "--limit", "200",
                  "--json", "body", "--jq", ".[].body")
        items = [it for it in items if f"{ITEM_MARK} {it[0]} " not in sent]
        revised = [r for r in revised
                   if f"{REVISION_MARK} {r[0]['license']}|{r[0]['exit_date']}|{r[3]['path']} " not in sent]
    if items:
        post(*compose(L, items, ITEM_MARK, test=False))
    else:
        print("no new enforcement actions to alert")
    if revised:
        post(*compose_revisions(L, revised))


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
