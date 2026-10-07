"""Care Ledger document miner.

Extracts structured facts from the PDFs already in archive/:

- Enforcement letters ("NOTICE and ORDER"): which sanctions were noticed,
  and the assessed forfeiture from "Total Forfeiture Due: $X" (falling back
  to "FORFEITURE OF $X IS IMPOSED").
- Statements of deficiency (state 2567 form): census at survey, deficiency
  count, complaint outcomes, and the cited rule tags with their titles
  (e.g. "M 436 / 88.07(2)(a) / Services").

Writes data/enrichment.json keyed by the document's archive path — the same
path surveys.json stores in `documents`, so the widget joins with no new id
scheme. Archived documents are immutable, so each is parsed exactly once;
--rebuild reparses everything (after parser improvements).

Derived data only: this file can be deleted and rebuilt from archive/ at any
time. The ledger itself (facilities.json, surveys.json) is never touched.

Per-document parse gaps are warnings, not failures — a format oddity in one
letter must not kill the weekly fetch commit. Real errors still raise.

Run: python pipeline/enrich.py [--rebuild]
"""

import json
import os
import re
import sys
from pathlib import Path

from pypdf import PdfReader

ROOT = Path(__file__).resolve().parent.parent
ARCHIVE_DIR = ROOT / "archive"
ENRICHMENT_PATH = ROOT / "data" / "enrichment.json"

# Fixed vocabulary of notice headers on DQA "NOTICE and ORDER" letters.
# Headers stand alone as ALL-CAPS lines; the same phrases also appear
# lowercase inside boilerplate prose (the POSTING OF NOTICES paragraph
# mentions "notice of revocation" in every letter), so matching is
# case-sensitive and line-anchored. Order is display order.
NOTICE_TYPES = [
    ("Revocation", r"NOTICE OF (?:LICENSE )?REVOCATION"),
    ("Summary suspension", r"NOTICE OF SUMMARY SUSPENSION"),
    ("Nonrenewal", r"NOTICE OF NON-?RENEWAL"),
    ("Admissions ban", r"ORDER NOT TO ADMIT NEW OR ADDITIONAL RESIDENTS(?: - EXTENDED)?"),
    ("Accruing forfeiture", r"NOTICE OF ACCRUING FORFEITURE"),
    ("Forfeiture", r"NOTICE OF (?:IMPOSED )?FORFEITURE"),
    ("Special orders", r"NOTICE OF SPECIAL ORDERS"),
    ("Plan of correction ordered", r"ORDER TO SUBMIT A PLAN OF CORRECTION"),
    ("Order to comply", r"ORDER TO COMPLY WITH REQUIRE?MENTS"),  # sic: one letter drops the E
    ("Revisit fee", r"NOTICE OF REVISIT FEE"),
]

WORD_NUM = {
    "no": 0, "the": 1, "a": 1, "one": 1, "two": 2, "both": 2, "three": 3,
    "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
    "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19, "twenty": 20,
}

# A citation's first line: tag, rule code, title. The tag number may be
# glued to the code ("M 43688.07(2)(a) SERVICES"), zero-padded or glued to
# its prefix in the newer layout's index ("N0283"), or braced on a repeat
# violation ("{N 617}"). The code runs to the first space and carries
# suffixes ("89.23(2)(a)2.c", "83.21(1)-(3)", "50.09(1)(a)1."). Prefixes:
# N CBRF (DHS 83), M AFH (88), U RCAC (89), Y/Z statute (ch. 50).
CITATION_RE = re.compile(
    r"^\s*\{?([A-Z]{1,2})\s?(\d{2,4})\}?\s*((?:8[389]|50)\.\d+\S*)\s*(.*)$"
)
# The next column's tag sometimes lands on the title line.
GLUED_TAG_RE = re.compile(r"\s+\{?[A-Z]{1,2}\s?\d{2,4}\}?\s*$")
PAGE_FURNITURE = (
    "This Rule", "If continuation sheet", "A. BUILDING", "B. WING", "PRINTED:",
    "STATEMENT OF DEFICIENCIES", "LABORATORY DIRECTOR", "Continued From",
)
SMALL_WORDS = {"of", "and", "or", "the", "a", "an", "to", "in", "on", "for", "at", "by", "with"}
# Acronyms that must survive sentence-casing an ALL-CAPS title.
ACRONYMS = {"OSHA", "CBRF", "RCAC", "AFH", "RN", "LPN", "PRN", "TB", "CPR", "AED",
            "DHS", "DQA", "ISP", "HIV", "ID", "OTC"}


def sentence_case(title):
    words = title.capitalize().split(" ")
    return " ".join(
        w.upper() if w.strip(".,:;()-").upper() in ACRONYMS else w for w in words
    )


def title_case_fragment(frag):
    return all(w[0].isupper() or not w[0].isalpha() or w.lower() in SMALL_WORDS
               for w in frag.split())


def continues_title(title, frag):
    """Whether the line after a citation's title line is more of the title.

    Titles wrap three ways: lowercase ("…receive" / "medication"), ALL CAPS
    ("FIRE EVACUATION ANNUAL" / "EVALUATION"), and Title Case
    ("Comprehensive Individualized" / "Service Plan"). The rule text that
    follows looks similar, so: no internal sentence period ever; an ALL-CAPS
    continuation may not end in a period ("SUFFICIENT SERVICES." is a rule
    subheading, not title); short lowercase or Title Case lines may.
    """
    if (not frag or len(frag) > 45 or "." in frag[:-1]
            or frag.startswith(PAGE_FURNITURE) or CITATION_RE.match(frag)):
        return False
    if frag[0].islower():
        return True
    if title.isupper():
        return frag.isupper() and not frag.endswith(".")
    return len(frag) <= 30 and title_case_fragment(frag)


def num(word):
    w = word.lower().strip()
    return WORD_NUM.get(w, int(w) if w.isdigit() else None)


def dollars(s):
    return int(s.replace(",", ""))


def parse_enforcement(text):
    stripped = [ln.strip() for ln in text.splitlines()]
    sanctions = [
        label
        for label, rx in NOTICE_TYPES
        if any(re.fullmatch(rx, ln) for ln in stripped)
    ]

    fine = None
    m = re.search(r"Total\s+Forfeiture\s+Due:\s*\$\s*([\d,]+)", text, re.I)
    if not m:
        m = re.search(r"FORFEITURE\s+OF\s+\$\s*([\d,]+)\s+IS\s+IMPOSED", text, re.I)
    if m:
        fine = dollars(m.group(1))

    sod_ref = None
    m = re.search(r"SOD\s+#([A-Z0-9]+)", text)
    if m:
        sod_ref = m.group(1)

    warn = None
    if {"Forfeiture", "Accruing forfeiture"} & set(sanctions) and fine is None:
        warn = "letter notices a forfeiture but no amount parsed"
    if not sanctions:
        warn = "no notice headers recognized"
    return {"kind": "enforcement", "sanctions": sanctions, "fine": fine,
            "sod_ref": sod_ref}, warn


def parse_sod(text):
    census = None
    m = re.search(r"Census:\s*(\d+)", text)
    if m:
        census = int(m.group(1))

    # "One repeat deficiency was identified", "Thirteen deficiencies…", and
    # the state's own "identifed" typo; "no deficiencies" only if no count.
    deficiencies = None
    m = re.search(
        r"(\w+)\s+(?:(?:new|repeat|additional)\s+)?deficienc(?:y|ies)\s+(?:was|were)\s+identifi?ed",
        text, re.I,
    )
    if m:
        deficiencies = num(m.group(1))
    elif re.search(r"\bno\s+(?:new\s+|repeat\s+)?deficiencies\s+(?:were\s+)?identifi?ed", text, re.I):
        deficiencies = 0

    # "Two of 8 complaints were substantiated" counts two, not eight.
    substantiated = 0
    unsubstantiated = 0
    for m in re.finditer(
        r"\b(\w+)(?:\s+of\s+(?:the\s+)?\w+)?\s+complaints?\s+(?:was|were)\s+(un)?substantiated",
        text, re.I,
    ):
        n = num(m.group(1))
        if n is None:
            continue
        if m.group(2):
            unsubstantiated += n
        else:
            substantiated += n

    # Keyed by normalized tag + code; when a citation appears twice (the
    # newer layout's first-page index repeats every tag, truncated), keep
    # the fullest title.
    by_key = {}
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if "Continued From" in line:
            continue
        m = CITATION_RE.match(line)
        if not m:
            continue
        prefix, tagnum, code, title = m.groups()
        title = GLUED_TAG_RE.sub("", title.strip())
        j = i + 1
        while (title and not title.endswith(".") and j <= i + 2 and j < len(lines)
               and continues_title(title, lines[j].strip())):
            title += " " + lines[j].strip()
            j += 1
        title = GLUED_TAG_RE.sub("", title)
        if title.isupper():
            title = sentence_case(title)
        key = (prefix, int(tagnum), code)
        tag = f"{prefix} {str(int(tagnum)).zfill(3)}"  # N0283 -> N 283; Z 019 stays
        if key not in by_key or len(title) >= len(by_key[key]["title"]):
            by_key[key] = {"tag": tag, "code": code, "title": title}
    citations = list(by_key.values())

    warn = None
    if deficiencies and not citations:
        warn = f"{deficiencies} deficiencies stated but no citation tags parsed"
    return {"kind": "sod", "census": census, "deficiencies": deficiencies,
            "complaints_substantiated": substantiated,
            "complaints_unsubstantiated": unsubstantiated,
            "citations": citations}, warn


def main():
    rebuild = "--rebuild" in sys.argv
    enrichment = {}
    if ENRICHMENT_PATH.exists() and not rebuild:
        enrichment = json.loads(ENRICHMENT_PATH.read_text())

    parsed = skipped = 0
    warnings = []
    for pdf in sorted(ARCHIVE_DIR.rglob("*.pdf")):
        rel = pdf.relative_to(ROOT).as_posix()
        kind = rel.rsplit("_", 1)[-1].removesuffix(".pdf")
        if kind == "poc":
            continue  # plans of correction: provider prose, nothing to mine
        if rel in enrichment:
            skipped += 1
            continue
        text = "\n".join(p.extract_text() or "" for p in PdfReader(pdf).pages)
        # Some PDFs map an ordinary font into the Unicode private-use area
        # (U+F020..U+F0FF); shifting back by 0xF000 recovers the text.
        if sum(0xF020 <= ord(c) <= 0xF0FF for c in text) > 100:
            text = "".join(chr(ord(c) - 0xF000) if 0xF020 <= ord(c) <= 0xF0FF else c
                           for c in text)
        # Classify by structure, not by the state's grid column: the state
        # occasionally serves a 2567 SOD form under the enforcement link.
        if sum(c.isalpha() for c in text) < 200:
            # Scanned page or broken font mapping — nothing minable.
            entry, warn = {"kind": "unreadable"}, "no readable text extracted"
        elif "NOTICE and ORDER" in text or re.search(r"NOTICE OF VIOLATION", text):
            entry, warn = parse_enforcement(text)
        elif "STATEMENT OF DEFICIENCIES" in text:
            entry, warn = parse_sod(text)
        else:
            raise RuntimeError(f"Unrecognized document structure in {rel}")
        if entry["kind"] not in (kind, "unreadable"):
            warnings.append(f"{rel}: filed as {kind}, structurally a {entry['kind']}")
        enrichment[rel] = entry
        parsed += 1
        if warn:
            warnings.append(f"{rel}: {warn}")

    ENRICHMENT_PATH.write_text(
        json.dumps(enrichment, indent=2, sort_keys=True) + "\n"
    )

    # The widget joins surveys to enrichment by exact path string, so every
    # document path in the ledger must be a real file, in POSIX form, and
    # (unless a plan of correction) mined. A Windows run once stored 20
    # backslash paths and the live forfeiture total silently dropped $7,550.
    surveys = json.loads((ROOT / "data" / "surveys.json").read_text())
    broken = [
        f"{sid}: {path}"
        for sid, s in surveys.items()
        for kind, path in s["documents"].items()
        if "\\" in path or not (ROOT / path).is_file()
        or (kind != "poc" and path not in enrichment)
    ]
    if broken:
        raise RuntimeError(f"{len(broken)} ledger documents don't join to the archive: {broken}")

    enf = [e for e in enrichment.values() if e["kind"] == "enforcement"]
    sods = [e for e in enrichment.values() if e["kind"] == "sod"]
    fines = [e["fine"] for e in enf if e.get("fine")]
    cited = sum(len(e["citations"]) for e in sods)
    print(
        f"Parsed {parsed} new documents ({skipped} already mined).\n"
        f"{len(enf)} enforcement letters: {len(fines)} with forfeitures, "
        f"${sum(fines):,} total.\n"
        f"{len(sods)} SODs: {cited} citations, "
        f"{sum(1 for e in sods if e['complaints_substantiated'])} with substantiated complaints."
    )
    if warnings:
        print(f"\n{len(warnings)} documents parsed incompletely:")
        for w in warnings:
            print(f"  WARN {w}")
        # A gap in a green run's log is invisible; put it on the run's
        # summary page next to the weekly tip sheet.
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a", encoding="utf-8") as fh:
                fh.write("### Document parse warnings\n\n")
                fh.write("".join(f"- {w}\n" for w in warnings) + "\n")


if __name__ == "__main__":
    sys.exit(main())
