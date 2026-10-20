"""Tests for the geocoder: a dot is only drawn where the facility's own
county says it can be, and an address is only sent when it changes.

Run: python -m unittest discover -s pipeline/tests
"""

import contextlib
import io
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import geocode as gc  # noqa: E402

SHAPES = gc.load_counties()  # the committed outlines, all nine


def facility(county="MARATHON", address="210 W CAMPUS DR", city="WAUSAU", zip_code="54401"):
    return {"county": county, "address": address, "city": city, "zip": zip_code}


def quiet(fn, *args):
    with contextlib.redirect_stdout(io.StringIO()) as out:
        result = fn(*args)
    return result, out.getvalue()


class Outlines(unittest.TestCase):
    def test_covers_every_county_the_ledger_searches(self):
        self.assertEqual(set(SHAPES), set(gc.COUNTIES))

    def test_wausau_is_in_marathon_not_wood(self):
        self.assertTrue(gc.inside(SHAPES["MARATHON"], -89.6301, 44.9591))
        self.assertFalse(gc.inside(SHAPES["WOOD"], -89.6301, 44.9591))

    def test_distance_outside(self):
        self.assertEqual(gc.meters_outside(SHAPES["MARATHON"], -89.6301, 44.9591), 0.0)
        # Wisconsin Rapids is tens of kilometers south of Marathon County.
        self.assertGreater(gc.meters_outside(SHAPES["MARATHON"], -89.8173, 44.3836), 20_000)


class Placing(unittest.TestCase):
    def test_match_inside_its_county_is_placed(self):
        geocodes = {}
        quiet(gc.update, {"1": facility()}, geocodes, SHAPES,
              lambda todo: {"1": ("Exact", -89.638853, 44.988250)})
        self.assertEqual(geocodes["1"]["match"], "Exact")
        self.assertAlmostEqual(geocodes["1"]["lat"], 44.98825)

    def test_match_in_another_county_is_not_placed(self):
        # A Wood County facility the geocoder put in Wausau: no dot.
        geocodes = {}
        _, out = quiet(gc.update, {"1": facility(county="WOOD")}, geocodes, SHAPES,
                       lambda todo: {"1": ("Non_Exact", -89.638853, 44.988250)})
        self.assertEqual(geocodes["1"]["match"], "Wrong_County")
        self.assertNotIn("lat", geocodes["1"])
        self.assertIn("WARN", out)

    def test_street_on_the_county_line_is_placed(self):
        # 1204 W McMillan St, Marshfield: the roster says Wood; McMillan is
        # the Wood-Marathon line and the geocoder lands just north of it.
        geocodes = {}
        quiet(gc.update, {"1": facility(county="WOOD")}, geocodes, SHAPES,
              lambda todo: {"1": ("Exact", -90.19142, 44.68522)})
        self.assertIn("lat", geocodes["1"])

    def test_no_match_is_recorded_without_a_point(self):
        geocodes = {}
        _, out = quiet(gc.update, {"1": facility()}, geocodes, SHAPES,
                       lambda todo: {"1": ("No_Match", None, None)})
        self.assertEqual(geocodes["1"], {"address": gc.address_of(facility()), "match": "No_Match"})
        self.assertIn("WARN", out)


class Resending(unittest.TestCase):
    def test_unchanged_addresses_are_not_sent_again(self):
        geocodes = {"1": {"address": gc.address_of(facility()), "match": "No_Match"}}
        sent, _ = quiet(gc.update, {"1": facility()}, geocodes, SHAPES,
                        lambda todo: self.fail("nothing should be sent"))
        self.assertEqual(sent, 0)

    def test_a_moved_facility_is_sent_again(self):
        geocodes = {"1": {"address": gc.address_of(facility()), "match": "No_Match"}}
        moved = facility(address="500 GRAND AVE")
        seen = {}
        quiet(gc.update, {"1": moved}, geocodes, SHAPES,
              lambda todo: seen.update(todo) or {"1": ("Exact", -89.63, 44.96)})
        self.assertEqual(seen, {"1": gc.address_of(moved)})
        self.assertEqual(geocodes["1"]["address"], gc.address_of(moved))


class CensusBatch(unittest.TestCase):
    def session(self, text):
        posted = {}

        def post(url, files, data, timeout):
            posted["csv"] = files["addressFile"][1]
            return SimpleNamespace(text=text, raise_for_status=lambda: None)

        return SimpleNamespace(post=post), posted

    def test_parses_matches_and_misses(self):
        session, posted = self.session(
            '"1","210 W CAMPUS DR, WAUSAU, WI, 54401","Match","Exact","210 W CAMPUS DR, WAUSAU, WI, 54401",'
            '"-89.638852727293,44.988249611611","657414273","R"\n'
            '"2","W7343 HWY 47, PHLOX, WI, 54464","No_Match"\n'
            '"3","1200 ST JOSEPH AVE, MARSHFIELD, WI, 54449","Tie"\n')
        out = gc.batch(session, {"1": "210 W CAMPUS DR, WAUSAU, WI, 54401",
                                 "2": "W7343 HWY 47, PHLOX, WI, 54464",
                                 "3": "1200 ST JOSEPH AVE, MARSHFIELD, WI, 54449"})
        self.assertEqual(out["1"][0], "Exact")
        self.assertAlmostEqual(out["1"][2], 44.988249611611)
        self.assertEqual(out["2"], ("No_Match", None, None))
        self.assertEqual(out["3"], ("Tie", None, None))
        self.assertIn("1,210 W CAMPUS DR,WAUSAU,WI,54401", posted["csv"])

    def test_a_dropped_address_fails_loudly(self):
        session, _ = self.session('"1","x","No_Match"\n')
        with self.assertRaises(RuntimeError):
            gc.batch(session, {"1": "A, B, WI, 1", "2": "C, D, WI, 2"})


if __name__ == "__main__":
    unittest.main()
