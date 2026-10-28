# Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
# Licensed under the MIT License; see LICENSE.txt in the project root.
# SPDX-License-Identifier: MIT

"""Build the ForestVis demo dataset from a SegmentAnyTree result.

Produces the same files and schema the app reads for the Swedish data:

  teak.copc.laz                      points with PredInstance, PredSemantic, per-point
                                     NDVI/GNDVI/LCI/NDRE/OSAVI, per-tree Avg* and Height
  tree_centroids_umap.geojson        one point per tree with crown statistics + UMAP_1/2
  tree_centroids_umap_metadata.json
  region_statistics.geojson, region_{i}.geojson
  instance-z-filter.tif              PredInstance of the highest point per 0.1 m cell
  ndvi.tif, aerial.tif               rasters the KDE panel samples
  color_categorization.qml           instance palette

    python build_dataset.py --source crop.laz --segmented sat_result.laz \
        --indices <dir with NDVI.tif ...> --aerial aerial.tif --qml palette.qml \
        --out <dir> [--areas 3]
"""
import argparse
import base64
import json
import os
import shutil

import laspy
import numpy as np
import pdal
import rasterio
from rasterio.fill import fillnodata
from rasterio.transform import from_origin
from scipy.interpolate import griddata
from scipy.spatial import cKDTree

NODATA = -9999.0
INDICES = ["NDVI", "GNDVI", "LCI", "NDRE", "OSAVI"]
# Property names are truncated to 10 characters, as in the shapefile-derived Swedish data.
STATS = {
    "Avg": np.mean, "Max": np.max, "Min": np.min, "Std": np.std,
    "Q25": lambda v: np.percentile(v, 25), "Q75": lambda v: np.percentile(v, 75),
    "Median": np.median,
}
MIN_TREE_POINTS = 50
MIN_TREE_HEIGHT = 3.0
ZFILTER_RES = 0.1


def prop(stat, index):
    return f"{stat}{index}"[:10]


def find_dim(names, *needles):
    for name in names:
        low = name.lower()
        if any(n in low for n in needles):
            return name
    raise KeyError(f"no dimension matching {needles} in {names}")


def height_above_ground(x, y, z, ground):
    """Linear interpolation of the lowest ground return per 0.5 m cell."""
    gx, gy, gz = x[ground], y[ground], z[ground]
    cell = np.floor(np.c_[gx, gy] / 0.5).astype(np.int64)
    order = np.lexsort((gz, cell[:, 1], cell[:, 0]))
    _, first = np.unique(cell[order], axis=0, return_index=True)
    keep = order[first]
    pts, vals = np.c_[gx[keep], gy[keep]], gz[keep]
    dem = griddata(pts, vals, (x, y), method="linear")
    missing = np.isnan(dem)
    if missing.any():
        dem[missing] = griddata(pts, vals, (x[missing], y[missing]), method="nearest")
    return z - dem


def sample(raster, x, y):
    rows, cols = rasterio.transform.rowcol(raster["transform"], x, y)
    rows = np.clip(np.asarray(rows), 0, raster["data"].shape[0] - 1)
    cols = np.clip(np.asarray(cols), 0, raster["data"].shape[1] - 1)
    return raster["data"][rows, cols], rows, cols


def load_indices(folder):
    rasters = {}
    for name in INDICES:
        with rasterio.open(os.path.join(folder, f"{name}.tif")) as src:
            data = src.read(1)
            valid = data != src.nodata
            rasters[name] = {
                "data": data, "valid": valid, "transform": src.transform, "crs": src.crs,
                # Points take values from a gap-filled copy so shadowed crowns still colour.
                "filled": fillnodata(data.copy(), mask=valid.astype(np.uint8), max_search_distance=10),
            }
    return rasters


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    ap.add_argument("--segmented", required=True)
    ap.add_argument("--indices", required=True)
    ap.add_argument("--aerial", required=True)
    ap.add_argument("--qml", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--areas", type=int, default=3)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    src = laspy.read(args.source)
    x, y, z = np.asarray(src.x), np.asarray(src.y), np.asarray(src.z)
    crs = src.header.parse_crs()
    # The cropped NEON LAZ carries a BoundCRS (UTM 11N + towgs84); its EPSG is on source_crs.
    epsg = crs.to_epsg() or (crs.source_crs.to_epsg() if crs.is_bound else None)
    if epsg is None:
        raise ValueError(f"cannot determine an EPSG code for {crs.name}")
    print(f"source: {len(x)} points, EPSG:{epsg}")

    # --- transfer SegmentAnyTree labels onto the source points -------------
    seg = laspy.read(args.segmented)
    names = list(seg.point_format.dimension_names)
    inst_dim = find_dim(names, "instance", "treeid")
    sem_dim = find_dim(names, "semantic", "label")
    tree = cKDTree(np.c_[seg.x, seg.y, seg.z])
    dist, nn = tree.query(np.c_[x, y, z], k=1, workers=-1)
    print(f"segmented: {len(seg.x)} points, dims {inst_dim}/{sem_dim}, "
          f"match distance p99 {np.percentile(dist, 99):.3f} m")
    raw_inst = np.asarray(seg[inst_dim])[nn].astype(np.int64)
    raw_sem = np.asarray(seg[sem_dim])[nn].astype(np.int64)

    hag = height_above_ground(x, y, z, np.asarray(src.classification) == 2)

    # Keep instances that look like trees; renumber 1..K, everything else 0.
    pred_instance = np.zeros(len(x), dtype=np.uint16)
    tree_height = np.zeros(len(x), dtype=np.float32)
    trees = []
    for label in np.unique(raw_inst):
        if label <= 0:
            continue
        m = raw_inst == label
        if m.sum() < MIN_TREE_POINTS or np.median(raw_sem[m]) < 1:
            continue
        h = float(hag[m].max())
        if h < MIN_TREE_HEIGHT:
            continue
        trees.append(np.flatnonzero(m))
    trees.sort(key=lambda idx: (-y[idx].mean(), x[idx].mean()))  # stable north-west first
    for new_id, idx in enumerate(trees, start=1):
        pred_instance[idx] = new_id
        tree_height[idx] = round(float(hag[idx].max()), 2)
    pred_semantic = (pred_instance > 0).astype(np.uint8)
    print(f"trees kept: {len(trees)} of {len(np.unique(raw_inst[raw_inst > 0]))} instances")

    # --- instance-z-filter: top-most point per 0.1 m cell ------------------
    xmin, ymin, xmax, ymax = x.min(), y.min(), x.max(), y.max()
    xmin, ymin = np.floor(xmin), np.floor(ymin)
    width = int(np.ceil((xmax - xmin) / ZFILTER_RES))
    height = int(np.ceil((ymax - ymin) / ZFILTER_RES))
    col = np.clip(((x - xmin) / ZFILTER_RES).astype(np.int64), 0, width - 1)
    row = np.clip(((ymin + height * ZFILTER_RES - y) / ZFILTER_RES).astype(np.int64), 0, height - 1)
    cell = row * width + col
    order = np.lexsort((-z, cell))
    _, first = np.unique(cell[order], return_index=True)
    top = order[first]
    zfilter = np.full(height * width, NODATA, dtype=np.float32)
    top_trees = top[pred_instance[top] > 0]
    zfilter[cell[top_trees]] = pred_instance[top_trees]
    zfilter = zfilter.reshape(height, width)
    zf_transform = from_origin(xmin, ymin + height * ZFILTER_RES, ZFILTER_RES, ZFILTER_RES)
    with rasterio.open(os.path.join(args.out, "instance-z-filter.tif"), "w", driver="GTiff",
                       dtype="float32", count=1, width=width, height=height, crs=crs.to_wkt(),
                       transform=zf_transform, nodata=NODATA, compress="deflate", tiled=True) as dst:
        dst.write(zfilter, 1)

    # --- per-point and per-tree index values -------------------------------
    rasters = load_indices(args.indices)
    point_values = {}
    for name, r in rasters.items():
        point_values[name] = sample({**r, "data": r["filled"]}, x, y)[0].astype(np.float32)

    # Crown pixels: the 1 m index pixels under each tree's top-surface 0.1 m cells.
    cell_x = xmin + ((cell[top_trees] % width) + 0.5) * ZFILTER_RES
    cell_y = ymin + height * ZFILTER_RES - ((cell[top_trees] // width) + 0.5) * ZFILTER_RES
    cell_tree = pred_instance[top_trees]

    edges = np.linspace(xmin, xmax, args.areas + 1)
    features, per_tree_avg = [], {}
    for tid, idx in enumerate(trees, start=1):
        props = {"PredInstan": tid, "Height": float(tree_height[idx[0]]),
                 "Z_min": round(float(z[idx].min()), 3), "Z_max": round(float(z[idx].max()), 3),
                 "X_min": round(float(x[idx].min()), 3), "X_max": round(float(x[idx].max()), 3),
                 "Y_min": round(float(y[idx].min()), 3), "Y_max": round(float(y[idx].max()), 3),
                 "RGB_1": None, "RGB_2": None, "RGB_3": None}
        crown = cell_tree == tid
        for name, r in rasters.items():
            vals, rows_, cols_ = sample(r, cell_x[crown], cell_y[crown])
            vals = vals[r["valid"][rows_, cols_]]
            for stat, fn in STATS.items():
                props[prop(stat, name)] = round(float(fn(vals)), 6) if vals.size else NODATA
            per_tree_avg.setdefault(name, {})[tid] = props[prop("Avg", name)]
        tx, ty = float(x[idx].mean()), float(y[idx].mean())
        props["area_numbe"] = int(np.clip(np.searchsorted(edges, tx, side="right") - 1, 0, args.areas - 1))
        features.append({"type": "Feature", "properties": props,
                         "geometry": {"type": "Point", "coordinates": [round(tx, 3), round(ty, 3)]}})

    # --- initial UMAP, same as the Flask server ----------------------------
    import umap
    umap_features = [prop(s, i) for i in INDICES for s in STATS]
    matrix = np.array([[f["properties"][k] for k in umap_features] for f in features], dtype=float)
    ok = np.all(matrix != NODATA, axis=1)
    reducer = umap.UMAP(n_neighbors=15, min_dist=0.1, n_components=2, metric="euclidean", random_state=100)
    emb = reducer.fit_transform(matrix[ok])
    kept = [f for f, keep in zip(features, ok) if keep]
    for f, (u1, u2) in zip(kept, emb):
        f["properties"]["UMAP_1"], f["properties"]["UMAP_2"] = float(u1), float(u2)
    print(f"UMAP over {len(kept)} trees ({(~ok).sum()} dropped for nodata)")

    crs_name = f"urn:ogc:def:crs:EPSG::{epsg}"
    with open(os.path.join(args.out, "tree_centroids_umap.geojson"), "w") as fh:
        json.dump({"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": crs_name}},
                   "features": kept}, fh)

    metadata = {
        "umap_input_features": umap_features,
        "umap_parameters": {"n_neighbors": 15, "min_dist": 0.1, "n_components": 2,
                            "metric": "euclidean", "random_state": 100, "nodata_value": NODATA},
        "total_points": len(kept), "coordinate_system": f"EPSG:{epsg}",
        "NDVI_1_min": -1, "NDVI_1_max": 1,
        **{f"RGB_{b}_{e}": v for b in (1, 2, 3) for e, v in (("min", 0), ("max", 255))},
        **{f"{i}_1_{e}": v for i in INDICES[1:] for e, v in (("min", -1), ("max", 1))},
    }
    with open(os.path.join(args.out, "tree_centroids_umap_metadata.json"), "w") as fh:
        json.dump(metadata, fh, indent=2)

    # --- areas: equal-width strips west to east -----------------------------
    region_features = []
    numeric = [k for k, v in kept[0]["properties"].items()
               if isinstance(v, (int, float)) and not k.startswith("UMAP_")]
    for a in range(args.areas):
        ring = [[edges[a], ymin], [edges[a + 1], ymin], [edges[a + 1], ymax], [edges[a], ymax], [edges[a], ymin]]
        poly = {"type": "Polygon", "coordinates": [[[round(px, 3), round(py, 3)] for px, py in ring]]}
        with open(os.path.join(args.out, f"region_{a}.geojson"), "w") as fh:
            json.dump({"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": crs_name}},
                       "features": [{"type": "Feature", "properties": {"id": a + 1}, "geometry": poly}]}, fh)
        members = [f["properties"] for f in kept if f["properties"]["area_numbe"] == a]
        stats = {"region_name": f"Region_{a}", "region_id": a, "centroid_count": len(members)}
        for k in numeric:
            vals = [m[k] for m in members if m[k] is not None and m[k] != NODATA]
            stats[f"{k}_mean"] = float(np.mean(vals)) if vals else NODATA
        region_features.append({"type": "Feature", "properties": stats, "geometry": poly})
    with open(os.path.join(args.out, "region_statistics.geojson"), "w") as fh:
        json.dump({"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": crs_name}},
                   "features": region_features}, fh)

    # --- point cloud --------------------------------------------------------
    header = laspy.LasHeader(point_format=7, version="1.4")
    header.offsets = src.header.offsets
    header.scales = src.header.scales
    header.add_crs(crs)
    extra = [("PredInstance", np.uint16), ("PredSemantic", np.uint8), ("Height", np.float32)]
    extra += [(n, np.float32) for n in INDICES] + [(f"Avg{n}", np.float32) for n in INDICES]
    header.add_extra_dims([laspy.ExtraBytesParams(name=n, type=t) for n, t in extra])
    out = laspy.LasData(header)
    for dim in ("x", "y", "z", "intensity", "return_number", "number_of_returns", "classification",
                "gps_time", "red", "green", "blue", "point_source_id"):
        setattr(out, dim, getattr(src, dim))
    out.PredInstance = pred_instance
    out.PredSemantic = pred_semantic
    out.Height = tree_height
    for n in INDICES:
        out[n] = point_values[n]
        avg = np.full(len(x), NODATA, dtype=np.float32)
        for tid, value in per_tree_avg[n].items():
            avg[pred_instance == tid] = value
        out[f"Avg{n}"] = avg
    tmp_las = os.path.join(args.out, "_points.laz")
    out.write(tmp_las)

    nodata_vlr = json.dumps({"nodata_records": [{"dimension": f"Avg{n}", "nodata_value": NODATA}
                                                for n in INDICES]}).encode()
    pipeline = pdal.Pipeline(json.dumps([
        tmp_las,
        {"type": "writers.copc", "filename": os.path.join(args.out, "teak.copc.laz"),
         "forward": "all", "extra_dims": "all",
         "vlrs": [{"user_id": "nodata", "record_id": 0, "description": "nodata values",
                   "data": base64.b64encode(nodata_vlr).decode()}]},
    ]))
    pipeline.execute()
    os.remove(tmp_las)

    # --- rasters the KDE panel samples --------------------------------------
    shutil.copyfile(os.path.join(args.indices, "NDVI.tif"), os.path.join(args.out, "ndvi.tif"))
    shutil.copyfile(args.aerial, os.path.join(args.out, "aerial.tif"))
    shutil.copyfile(args.qml, os.path.join(args.out, "color_categorization.qml"))

    for name in sorted(os.listdir(args.out)):
        print(f"  {name:36s} {os.path.getsize(os.path.join(args.out, name)) / 1e6:7.2f} MB")


if __name__ == "__main__":
    main()
