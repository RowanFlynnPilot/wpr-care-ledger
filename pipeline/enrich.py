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
    ("Forfeiture", r"NOTICE OF (?:IMPOSED )?FORFEITURE"),
    ("Special orders", r"NOTICE OF SPECIAL ORDERS"),
    ("Order to comply", r"ORDER TO COMPLY WITH REQUIREMENTS"),
    ("Revisit fee", r"NOTICE OF REVISIT FEE"),
]

WORD_NUM = {
    "no": 0, "the": 1, "a": 1, "one": 1, "two": 2, "three": 3, "four": 4,
    "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12,
}

# "M 43688.07(2)(a) SERVICES" — tag prefix+number glued to the rule code by
# text extraction, title on the same line; repeat violations brace the tag
# ("{N 617} 83.55(6)(b) …"). Prefixes: N CBRF (DHS 83), M AFH (88), U RCAC
# (89).
CITATION_RE = re.compile(
    r"^\s*\{?([A-Z]{1,2})\s?(\d{2,4})\}?\s*((?:8[389]|50)\.\d+(?:\([0-9A-Za-z]+\))*)\s*(.*)$"
)


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
    if "Forfeiture" in sanctions and fine is None:
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

    deficiencies = None
    m = re.search(r"(\w+)\s+deficienc(?:y|ies)\s+(?:was|were)\s+identified", text, re.I)
    if m:
        deficiencies = num(m.group(1))

    substantiated = 0
    unsubstantiated = 0
    for m in re.finditer(r"(\w+)\s+complaints?\s+(?:was|were)\s+(un)?substantiated", text, re.I):
        n = num(m.group(1))
        if n is None:
            continue
        if m.group(2):
            unsubstantiated += n
        else:
            substantiated += n

    citations = []
    seen = set()
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if "Continued From" in line:
            continue
        m = CITATION_RE.match(line)
        if not m:
            continue
        prefix, tagnum, code, title = m.groups()
        key = (prefix, tagnum, code)
        if key in seen:
            continue
        seen.add(key)
        title = title.strip()
        # Titles wrap: absorb short lower-case continuation lines.
        j = i + 1
        while (
            j < len(lines)
            and j <= i + 2
            and title
            and (frag := lines[j].strip())
            and len(frag) <= 45
            and frag[0].islower()
            and not frag.startswith("This Rule")
            and not CITATION_RE.match(lines[j])
        ):
            title += " " + frag
            j += 1
        if title.isupper():
            title = title.capitalize()
        citations.append({"tag": f"{prefix} {tagnum}", "code": code, "title": title})

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


if __name__ == "__main__":
    sys.exit(main())
