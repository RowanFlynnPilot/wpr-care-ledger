# Draws each facility's 1200x630 share card, dist/og/<slug>.png, from
# dist/og/cards.json (written by facility-pages.mjs from the widget's own
# shape(), so a card never disagrees with its page). Runs in postbuild:
#   python scripts/facility-cards.py
# A link to a facility page, shared on Facebook or in a text, then shows
# that facility — its name, place and record — not the ledger's general card.
# Same Newspack "Joseph" look as og-card.py, whose helpers it uses; Oswald
# only (committed in scripts/fonts/, OFL), so the build fetches nothing.
import importlib.util
import json
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("og_card", HERE / "og-card.py")
og = importlib.util.module_from_spec(spec)
spec.loader.exec_module(og)

DIST = HERE.parent / "dist"
OUT = DIST / "og"
OSWALD = (HERE / "fonts" / "Oswald[wght].ttf").read_bytes()
RED = (179, 45, 46)  # #b32d2e, the widget's --red: enforcement
W, H, M = og.W, og.H, 64


def wrap(d, text, f, width):
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if line and d.textlength(trial, font=f) > width:
            lines.append(line)
            line = word
        else:
            line = trial
    return lines + [line]


def card(c, seal, mark):
    img = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)

    # The flag, compact: seal, wordmark over the tool's name, the double rule.
    img.paste(seal, (M, 44))
    col = M + seal.width + 22
    img.paste(mark, (col, 56))
    d.text((col - 2, 82), "THE CARE LEDGER", font=og.font(OSWALD, 46, 700), fill=og.BLACK)
    d.rectangle([M, 160, W - M, 164], fill=og.BLACK)
    d.rectangle([M, 168, W - M, 168], fill=og.BLACK)
    if c["held"]:
        og.stamp(img, "HELD IN THE LEDGER", og.font(OSWALD, 28, 600), (W - M - 150, 98), angle=-5)

    # The facility: as large as fits — one line up to 84px, two up to 68px,
    # so a two-line name leaves room for its place line.
    name = c["name"].upper()
    for size in range(84, 34, -4):
        f = og.font(OSWALD, size, 700)
        lines = wrap(d, name, f, W - 2 * M)
        if len(lines) == 1 or (len(lines) == 2 and size <= 68):
            break
    y = 196
    for line in lines[:2]:
        d.text((M - 2, y), line, font=f, fill=og.BLACK)
        y += round(size * 1.08)
    place = f"{c['kind']} · {c['place']}" + (" · Closed" if c["closed"] else "")
    d.text((M, y + 10), place, font=og.font(OSWALD, 30, 400), fill=og.INK)

    # The record, in three figures; enforcement in red when there is any.
    figures = [
        (f"{c['inspections']:,}", "INSPECTION" if c["inspections"] == 1 else "INSPECTIONS", og.BLACK),
        (f"{c['enforcement']:,}", "ENFORCEMENT ACTION" if c["enforcement"] == 1 else "ENFORCEMENT ACTIONS",
         RED if c["enforcement"] else og.BLACK),
        (f"${c['fines']:,}", "IN FINES ASSESSED", RED if c["fines"] else og.BLACK),
    ]
    big, small = og.font(OSWALD, 76, 700), og.font(OSWALD, 19, 500)
    x = M
    for value, label, color in figures:
        d.text((x, 428), value, font=big, fill=color)
        og.tracked(d, (x + 2, 528), label, small, og.SOFT, 2.4)
        x += (W - 2 * M) // 3
    d.text((M, 574), f"Wisconsin Division of Quality Assurance inspection records since {c['since']}",
           font=og.font(OSWALD, 20, 400), fill=og.SOFT)
    # A small palette keeps 300-odd cards light; text stays crisp.
    return img.convert("P", palette=Image.Palette.ADAPTIVE, colors=64)


def main():
    cards = json.loads((OUT / "cards.json").read_text(encoding="utf-8"))
    seal = Image.open(og.BRAND / "wpr-typewriter.png").convert("RGB").resize((96, 96), Image.LANCZOS)
    mark = Image.open(og.BRAND / "wpr-wordmark.png").convert("RGB")
    mark = mark.resize((230, round(mark.height * 230 / mark.width)), Image.LANCZOS)
    for c in cards:
        card(c, seal, mark).save(OUT / f"{c['slug']}.png", optimize=True)
    total = sum((OUT / f"{c['slug']}.png").stat().st_size for c in cards)
    print(f"drew {len(cards)} facility share cards ({total // 1024} KB)")


if __name__ == "__main__":
    main()
