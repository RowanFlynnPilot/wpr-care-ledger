# Generates public/og-card.png — the 1200x630 social share card (og:image).
# One-time asset; rerun after a branding change:  python widget/scripts/og-card.py
# Newspack "Joseph" system: newsprint white, Oswald uppercase over Merriweather,
# the WPR flag and its thick-over-thin rule, plus the tool's signature stamp.
# Uses the committed brand copies in public/brand/; fonts are fetched from the
# Google Fonts repo at run time and nothing ships at runtime.
import io
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

WIDGET = Path(__file__).resolve().parent.parent
BRAND = WIDGET / "public" / "brand"
OUT = WIDGET / "public" / "og-card.png"

W, H, M = 1200, 630, 72
BLACK = (17, 17, 17)
INK = (49, 49, 49)
SOFT = (102, 102, 102)
SEPIA = (125, 88, 47)  # #7d582f, the widget's --sepia

FONTS = "https://raw.githubusercontent.com/google/fonts/main/ofl/"
OSWALD = FONTS + "oswald/Oswald%5Bwght%5D.ttf"
MERRI_ITALIC = FONTS + "merriweather/Merriweather-Italic%5Bopsz%2Cwdth%2Cwght%5D.ttf"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as r:
        return r.read()


def font(data, size, weight):
    f = ImageFont.truetype(io.BytesIO(data), size)
    axes = [weight if a["name"] in (b"Weight", "Weight") else a["default"]
            for a in f.get_variation_axes()]
    f.set_variation_by_axes(axes)
    return f


def tracked(d, xy, text, f, fill, tracking):
    """Draw text with letter-spacing (PIL has no tracking option)."""
    x, y = xy
    for ch in text:
        d.text((x, y), ch, font=f, fill=fill)
        x += d.textlength(ch, font=f) + tracking
    return x


def stamp(img, text, f, center, angle=-6):
    """The "held in the ledger" rubber stamp: sepia double border, rotated."""
    probe = ImageDraw.Draw(img)
    tw = probe.textlength(text, font=f)
    th = f.size
    pad_x, pad_y = 26, 16
    w, h = int(tw + pad_x * 2), int(th + pad_y * 2 + 8)
    layer = Image.new("RGBA", (w + 20, h + 20), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    ld.rectangle([10, 10, 10 + w, 10 + h], outline=SEPIA + (255,), width=4)
    ld.rectangle([18, 18, 2 + w, 2 + h], outline=SEPIA + (255,), width=1)
    ld.text((10 + pad_x, 10 + pad_y - 4), text, font=f, fill=SEPIA + (255,))
    layer = layer.rotate(angle, expand=True, resample=Image.BICUBIC)
    img.paste(layer, (center[0] - layer.width // 2, center[1] - layer.height // 2), layer)


def main():
    oswald = fetch(OSWALD)
    merri_i = fetch(MERRI_ITALIC)

    img = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)

    # The flag: seal left, wordmark and the tool's name stacked to its right.
    seal = Image.open(BRAND / "wpr-typewriter.png").convert("RGB").resize((196, 196), Image.LANCZOS)
    img.paste(seal, (M, 62))
    col = M + 196 + 34
    mark = Image.open(BRAND / "wpr-wordmark.png").convert("RGB")
    mark = mark.resize((330, round(mark.height * 330 / mark.width)), Image.LANCZOS)
    img.paste(mark, (col, 78))

    title = "THE CARE LEDGER"
    size = 118
    while d.textlength(title, font=font(oswald, size, 700)) > W - M - col:
        size -= 2
    d.text((col - 3, 118), title, font=font(oswald, size, 700), fill=BLACK)

    # Classic newspaper double rule under the flag: 4px over 1px.
    y = 292
    d.rectangle([M, y, W - M, y + 4], fill=BLACK)
    d.rectangle([M, y + 8, W - M, y + 8], fill=BLACK)

    dek = font(merri_i, 31, 400)
    lines = [
        "State inspection and enforcement records for",
        "assisted living in Marathon County and its neighbors —",
        "kept after the state stops showing them.",
    ]
    for i, line in enumerate(lines):
        d.text((M, 330 + i * 50), line, font=dek, fill=INK)

    # WPR's tagline, set exactly, letter-spaced ~0.28em per the brand.
    tracked(d, (M, 548), "WHERE LOCALS LOOK FIRST FOR NEWS", font(oswald, 20, 500), SOFT, 5.6)

    stamp(img, "HELD IN THE LEDGER", font(oswald, 36, 600), (W - M - 170, 545))

    OUT.parent.mkdir(exist_ok=True)
    img.save(OUT, "PNG", optimize=True)
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
