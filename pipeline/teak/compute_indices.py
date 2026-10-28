# Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
# Licensed under the MIT License; see LICENSE.txt in the project root.
# SPDX-License-Identifier: MIT

"""Compute vegetation index rasters from a NEON bidirectional reflectance tile.

Bands approximate a multispectral camera (green 560, red 670, red edge 715,
NIR 840 nm); each is the mean of the nearest NEON band and its two neighbours.

    python compute_indices.py <reflectance.h5> <out_dir> [xmin ymin xmax ymax]

Writes NDVI, GNDVI, NDRE, LCI and OSAVI as float32 GeoTIFFs (nodata -9999).
"""
import os
import sys

import h5py
import numpy as np
import rasterio
from rasterio.transform import from_origin

NODATA = -9999.0
MIN_NIR = 0.03
MIN_VIS = 0.005
TARGETS = {"green": 560, "red": 670, "rededge": 715, "nir": 840}


def read_band(data, wavelengths, target, scale, ignore, rows, cols):
    i = int(np.abs(wavelengths - target).argmin())
    stack = data[rows, cols, i - 1 : i + 2].astype(np.float32)
    valid = np.all(stack != ignore, axis=2)
    return stack.mean(axis=2) / scale, valid


def main():
    h5_path, out_dir = sys.argv[1], sys.argv[2]
    bounds = [float(v) for v in sys.argv[3:7]] if len(sys.argv) >= 7 else None
    os.makedirs(out_dir, exist_ok=True)

    with h5py.File(h5_path, "r") as f:
        site = list(f.keys())[0]
        refl = f[site]["Reflectance"]
        data = refl["Reflectance_Data"]
        scale = float(data.attrs["Scale_Factor"])
        ignore = int(data.attrs["Data_Ignore_Value"])
        md = refl["Metadata"]
        wavelengths = md["Spectral_Data"]["Wavelength"][:]
        map_info = md["Coordinate_System"]["Map_Info"][()].decode().split(",")
        epsg = int(md["Coordinate_System"]["EPSG Code"][()])
        x0, y0 = float(map_info[3]), float(map_info[4])
        res = float(map_info[1])

        if bounds:
            xmin, ymin, xmax, ymax = bounds
            c0, c1 = int(round((xmin - x0) / res)), int(round((xmax - x0) / res))
            r0, r1 = int(round((y0 - ymax) / res)), int(round((y0 - ymin) / res))
        else:
            r0, c0 = 0, 0
            r1, c1 = data.shape[0], data.shape[1]
        rows, cols = slice(r0, r1), slice(c0, c1)

        bands, valid = {}, None
        for name, target in TARGETS.items():
            arr, ok = read_band(data, wavelengths, target, scale, ignore, rows, cols)
            bands[name] = arr
            valid = ok if valid is None else valid & ok

    g, r, re, n = bands["green"], bands["red"], bands["rededge"], bands["nir"]
    # Ratios are meaningless where reflectance is ~0 (deep shadow, bad pixels).
    reliable = valid & (g >= MIN_VIS) & (r >= MIN_VIS) & (re >= MIN_VIS) & (n >= MIN_NIR)
    print(f"masked as unreliable: {100 * (1 - reliable.mean()):.2f}% of pixels")
    valid = reliable
    with np.errstate(divide="ignore", invalid="ignore"):
        indices = {
            "NDVI": (n - r) / (n + r),
            "GNDVI": (n - g) / (n + g),
            "NDRE": (n - re) / (n + re),
            "LCI": (n - re) / (n + r),
            "OSAVI": 1.16 * (n - r) / (n + r + 0.16),
        }

    transform = from_origin(x0 + c0 * res, y0 - r0 * res, res, res)
    profile = dict(driver="GTiff", dtype="float32", count=1, crs=f"EPSG:{epsg}",
                   transform=transform, width=c1 - c0, height=r1 - r0,
                   nodata=NODATA, compress="deflate", predictor=3, tiled=True)
    for name, arr in indices.items():
        arr = np.where(valid & np.isfinite(arr), arr, NODATA).astype(np.float32)
        out = os.path.join(out_dir, f"{name}.tif")
        with rasterio.open(out, "w", **profile) as dst:
            dst.write(arr, 1)
        v = arr[arr != NODATA]
        print(f"{name}: {out}  min {v.min():.3f}  median {np.median(v):.3f}  max {v.max():.3f}")


if __name__ == "__main__":
    main()
