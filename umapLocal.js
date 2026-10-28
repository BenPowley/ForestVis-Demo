/*
 * Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
 * Licensed under the MIT License; see LICENSE.txt in the project root.
 * SPDX-License-Identifier: MIT
 */

// In-browser UMAP, replacing the Flask /api/umap server used before the static build.
// Mirrors the server: rows with nodata or missing values in any selected
// attribute are dropped, raw values are used without scaling, and UMAP runs
// with n_neighbors=15, min_dist=0.1, n_components=2, seed 100. umap-js is a
// port of umap-learn, so layouts are similar but not identical to the server's.

import { UMAP } from 'umap-js';

export const UMAP_PARAMS = { nNeighbors: 15, minDist: 0.1, nComponents: 2, seed: 100 };

// Deterministic PRNG (mulberry32) so the same attributes give the same layout.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Runs UMAP over the selected feature properties.
 * @param {object} geojson FeatureCollection of tree centroids
 * @param {string[]} attributes property names to embed
 * @param {object} [options]
 * @param {number} [options.nodataValue=-9999]
 * @param {(progress: number) => void} [options.onProgress] fraction of epochs done
 * @returns {Promise<object>} FeatureCollection of the kept features with UMAP_1/UMAP_2 set
 */
export async function computeUMAP(geojson, attributes, { nodataValue = -9999, onProgress } = {}) {
  const kept = [];
  const rows = [];
  for (const feature of geojson.features) {
    const row = attributes.map((a) => feature.properties[a]);
    if (row.every((v) => typeof v === 'number' && Number.isFinite(v) && v !== nodataValue)) {
      kept.push(feature);
      rows.push(row);
    }
  }
  if (rows.length <= UMAP_PARAMS.nNeighbors) {
    throw new Error(`Only ${rows.length} trees have valid values for the selected attributes`);
  }

  const umap = new UMAP({
    nNeighbors: UMAP_PARAMS.nNeighbors,
    minDist: UMAP_PARAMS.minDist,
    nComponents: UMAP_PARAMS.nComponents,
    random: seededRandom(UMAP_PARAMS.seed),
  });
  const embedding = await umap.fitAsync(rows, (epoch) => {
    onProgress?.(epoch / umap.getNEpochs());
  });

  return {
    type: 'FeatureCollection',
    features: kept.map((feature, i) => ({
      ...feature,
      properties: { ...feature.properties, UMAP_1: embedding[i][0], UMAP_2: embedding[i][1] },
    })),
    metadata: {
      umap_input_features: attributes,
      umap_parameters: { ...UMAP_PARAMS, nodata_value: nodataValue },
      total_points: kept.length,
    },
  };
}
