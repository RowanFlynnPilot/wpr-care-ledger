"""Care Ledger geocoder: puts each facility on the map.

Sends roster addresses to the U.S. Census Bureau's batch geocoder (free, no
key, one request for any number of addresses) and writes
data/geocodes.json keyed by license:

    {"address": "519 FLIGHT ROAD, ANTIGO, WI, 54409",
     "match": "Exact" | "Non_Exact" | "No_Match" | "Tie" | "Wrong_County",
     "lat": 45.1, "lon": -89.1}            # lat/lon only when placed

Only facilities that are new, or whose roster address changed, are sent;
an unplaced address is not retried until it changes. Every match must fall
inside the facility's own county (data/basemap.json; the roster's county
is authoritative), or within BORDER_SLACK of it — some streets *are* the
county line (McMillan Street in Marshfield divides Wood from Marathon),
and the geocoder puts the point on the centerline. Anything farther out is
recorded as "Wrong_County" with no point: a dot in the wrong place is
worse than a missing one, and the map counts what it can't place.

Derived data only, like enrichment.json: delete the file and rerun to
geocode everything again. Never hand-edit.

data/basemap.json is the map's static base, built once (2026-10-19):
`counties`, the nine counties' outlines from the Census Bureau's TIGERweb
State_County layer (MapServer/1, STATE='55', the nine COUNTY codes,
outSR=4326, maxAllowableOffset=0.0003 — about 30 m, which keeps these
mostly surveyed-straight boundaries to 19-45 vertices); and `places`, the
2025 Census Gazetteer's internal point for each Wisconsin place named as
a city in the roster and lying in one of the nine counties — where the
widget prints town names, since a mailing city's facilities can sit miles
from the town itself.

Run: python pipeline/geocode.py
"""

import csv
import io
import json
import math
from pathlib import Path

from fetch import COUNTIES, requests_session

ROOT = Path(__file__).resolve().parent.parent
FACILITIES_PATH = ROOT / "data" / "facilities.json"
BASEMAP_PATH = ROOT / "data" / "basemap.json"
GEOCODES_PATH = ROOT / "data" / "geocodes.json"

BATCH_URL = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"
BENCHMARK = "Public_AR_Current"
TIMEOUT = 600  # the batch endpoint answers in seconds, but can be slow
BORDER_SLACK = 250  # meters; street centerline + the outlines' ~30 m generalization


def address_of(facility):
    """The one-line address the geocoder sees, and the change detector."""
    return f"{facility['address']}, {facility['city']}, WI, {facility['zip']}"


def load_counties():
    basemap = json.loads(BASEMAP_PATH.read_text(encoding="utf-8"))
    shapes = {}
    for feature in basemap["counties"]:
        g = feature["geometry"]
        shapes[feature["properties"]["county"]] = (
            [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"])
    if set(shapes) != set(COUNTIES):
        raise RuntimeError(
            f"data/basemap.json covers {sorted(shapes)}, the ledger searches "
            f"{sorted(COUNTIES)} — add the missing outline (see docstring)")
    return shapes


def inside(polygons, lon, lat):
    """Even-odd ray cast over every ring, so holes count."""
    hit = False
    for polygon in polygons:
        for ring in polygon:
            for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
                if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
                    hit = not hit
    return hit


def meters_outside(polygons, lon, lat):
    """0 inside, else the distance in meters to the nearest boundary."""
    if inside(polygons, lon, lat):
        return 0.0
    kx = 111_320 * math.cos(math.radians(lat))  # meters per degree, locally
    ky = 110_540
    best = math.inf
    for polygon in polygons:
        for ring in polygon:
            for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
                ax, ay = (x1 - lon) * kx, (y1 - lat) * ky
                bx, by = (x2 - lon) * kx, (y2 - lat) * ky
                dx, dy = bx - ax, by - ay
                t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy or 1)))
                best = min(best, math.hypot(ax + t * dx, ay + t * dy))
    return best


def batch(session, addresses):
    """{id: (match, lon, lat)} from one Census batch request.

    addresses: {id: one-line address}. Every id must come back; a row the
    service drops would otherwise read as never sent.
    """
    rows = io.StringIO()
    writer = csv.writer(rows)
    for key, line in addresses.items():
        street, city, state, zip_code = [p.strip() for p in line.split(",")]
        writer.writerow([key, street, city, state, zip_code])
    r = session.post(
        BATCH_URL,
        files={"addressFile": ("addresses.csv", rows.getvalue(), "text/csv")},
        data={"benchmark": BENCHMARK},
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    out = {}
    for row in csv.reader(io.StringIO(r.text)):
        if not row:
            continue
        key, status = row[0], row[2]
        if status == "Match":
            lon, lat = (float(v) for v in row[5].split(","))
            out[key] = (row[3], lon, lat)  # Exact / Non_Exact
        elif status in ("No_Match", "Tie"):
            out[key] = (status, None, None)
        else:
            raise RuntimeError(f"Census geocoder: unexpected row {row!r}")
    missing = set(addresses) - set(out)
    if missing:
        raise RuntimeError(f"Census geocoder dropped {len(missing)} addresses: {sorted(missing)}")
    return out


def update(facilities, geocodes, shapes, lookup):
    """Geocode new or moved facilities into `geocodes`; returns how many.

    lookup: {license: one-line address} -> {license: (match, lon, lat)},
    the Census batch in production.
    """
    todo = {lic: address_of(f) for lic, f in facilities.items()
            if geocodes.get(lic, {}).get("address") != address_of(f)}
    if not todo:
        return 0
    for lic, (match, lon, lat) in lookup(todo).items():
        entry = {"address": todo[lic], "match": match}
        if lon is not None:
            county = facilities[lic]["county"]
            off = meters_outside(shapes[county], lon, lat)
            if off <= BORDER_SLACK:
                entry.update(lat=round(lat, 6), lon=round(lon, 6))
            else:
                entry["match"] = "Wrong_County"
                print(f"WARN {lic} {todo[lic]}: geocoded {off:,.0f} m outside "
                      f"{county} County ({lat:.5f}, {lon:.5f}); left off the map")
        else:
            print(f"WARN {lic} {todo[lic]}: {match}; left off the map")
        geocodes[lic] = entry
    return len(todo)


def main():
    facilities = json.loads(FACILITIES_PATH.read_text(encoding="utf-8"))
    geocodes = (json.loads(GEOCODES_PATH.read_text(encoding="utf-8"))
                if GEOCODES_PATH.exists() else {})
    session = requests_session()
    sent = update(facilities, geocodes, load_counties(), lambda todo: batch(session, todo))
    GEOCODES_PATH.write_text(
        json.dumps(dict(sorted(geocodes.items())), indent=1, ensure_ascii=False) + "\n",
        encoding="utf-8")
    placed = sum(1 for lic in facilities if "lat" in geocodes.get(lic, {}))
    print(f"geocoded {sent} new or moved; {placed} of {len(facilities)} facilities on the map")


if __name__ == "__main__":
    main()
