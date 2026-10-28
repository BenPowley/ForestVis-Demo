# Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
# Licensed under the MIT License; see LICENSE.txt in the project root.
# SPDX-License-Identifier: MIT

"""Build the thinned context ("base") point clouds around the demo crop.

Downloads NEON TEAK classified LiDAR tiles (DP1.30003.001) for a block of 1 km
tiles, removes noise, trims to -3..75 m above ground, thins evenly with Poisson
disk sampling and writes one COPC per tile for the app's `copcBase` layer.

    python build_base.py --raw <download dir> --out <dir> \
        --east 320000 322000 --north 4096000 4098000 [--radius 1.15] [--month 2023-07]

The NEON API token is read from ~/.neon_token.
"""
import argparse
import json
import os
import urllib.request

import pdal

API = "https://data.neonscience.org/api/v0/data/DP1.30003.001/TEAK/{month}"


def tile_urls(month):
    token = open(os.path.expanduser("~/.neon_token")).read().strip()
    req = urllib.request.Request(API.format(month=month), headers={"X-API-Token": token})
    with urllib.request.urlopen(req) as res:
        files = json.load(res)["data"]["files"]
    return {f["name"]: f for f in files if f["name"].endswith("_classified_point_cloud_colorized.laz")}


def download(entry, folder):
    path = os.path.join(folder, entry["name"])
    if os.path.exists(path) and os.path.getsize(path) == int(entry["size"]):
        return path
    print(f"  downloading {entry['name']} ({int(entry['size']) / 1e6:.0f} MB)")
    urllib.request.urlretrieve(entry["url"], path + ".part")
    os.replace(path + ".part", path)
    return path


def thin(src, dst, radius):
    pipeline = pdal.Pipeline(json.dumps([
        src,
        {"type": "filters.expression", "expression": "Classification != 7 && Classification != 18"},
        {"type": "filters.hag_nn"},
        {"type": "filters.expression", "expression": "HeightAboveGround >= -3 && HeightAboveGround <= 75"},
        {"type": "filters.sample", "radius": radius},
        {"type": "writers.copc", "filename": dst},
    ]))
    return pipeline.execute()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--east", type=int, nargs=2, required=True, metavar=("MIN", "MAX"))
    ap.add_argument("--north", type=int, nargs=2, required=True, metavar=("MIN", "MAX"))
    # 1.15 m gives about 2 points/m² over TEAK's canopy (calibrated on 321000_4097000)
    ap.add_argument("--radius", type=float, default=1.15, help="Poisson sampling radius (m)")
    ap.add_argument("--month", default="2023-07")
    args = ap.parse_args()
    os.makedirs(args.raw, exist_ok=True)
    os.makedirs(args.out, exist_ok=True)

    urls = tile_urls(args.month)
    for n in range(args.north[0], args.north[1] + 1, 1000):
        for e in range(args.east[0], args.east[1] + 1, 1000):
            name = f"NEON_D17_TEAK_DP1_{e}_{n}_classified_point_cloud_colorized.laz"
            if name not in urls:
                print(f"{e}_{n}: no tile")
                continue
            src = download(urls[name], args.raw)
            dst = os.path.join(args.out, f"base_{e}_{n}.copc.laz")
            count = thin(src, dst, args.radius)
            print(f"{e}_{n}: {count:,} points ({count / 1e6:.2f} per m²)  {os.path.getsize(dst) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
