# Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
# Licensed under the MIT License; see LICENSE.txt in the project root.
# SPDX-License-Identifier: MIT

"""Print the structure of a NEON bidirectional reflectance HDF5 tile."""
import sys

import h5py
import numpy as np

path = sys.argv[1]
with h5py.File(path, "r") as f:
    site = list(f.keys())[0]
    refl = f[site]["Reflectance"]
    data = refl["Reflectance_Data"]
    print("site", site, "shape", data.shape, "dtype", data.dtype, "chunks", data.chunks)
    for k, v in data.attrs.items():
        if k in ("Scale_Factor", "Data_Ignore_Value", "No_Data_Value", "Dimension_Labels"):
            print("  attr", k, v)
    md = refl["Metadata"]
    wl = md["Spectral_Data"]["Wavelength"][:]
    print("wavelengths", len(wl), "range", wl.min().round(1), wl.max().round(1))
    for target in (550, 560, 650, 670, 705, 715, 720, 800, 840):
        i = int(np.abs(wl - target).argmin())
        print(f"  {target} nm -> band {i} ({wl[i]:.1f} nm)")
    ci = md["Coordinate_System"]
    print("map info", ci["Map_Info"][()])
    print("epsg", ci["EPSG Code"][()])
