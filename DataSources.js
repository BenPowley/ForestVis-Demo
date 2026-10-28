/*
 * Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
 * Licensed under the MIT License; see LICENSE.txt in the project root.
 * SPDX-License-Identifier: MIT
 */

// Returns the configured camera height for an AOI, or a default if not set
export function getCameraHeight(aoiKey, defaultHeight = 500) {
  const config = AOI_CONFIGS[aoiKey];
  if (config && typeof config.cameraHeight === 'number') {
    return config.cameraHeight;
  }
  return defaultHeight;
}
// Loads and caches region_statistics.geojson

// Loads and caches region_statistics.geojson for a given AOI (or default path)
const regionStatisticsCache = {};
export async function getRegionStatisticsGeoJson(aoiKey = getDefaultAOIKey()) {
  if (regionStatisticsCache[aoiKey]) return regionStatisticsCache[aoiKey];
  let geojsonPath = './layer2/region_statistics.geojson';
  if (AOI_CONFIGS[aoiKey] && AOI_CONFIGS[aoiKey].regionStatisticsGeoJson) {
    geojsonPath = AOI_CONFIGS[aoiKey].regionStatisticsGeoJson;
  }
  const response = await fetch(geojsonPath);
  if (!response.ok) {
    throw new Error(`Failed to fetch region_statistics.geojson: ${response.statusText}`);
  }
  const data = await response.json();
  regionStatisticsCache[aoiKey] = data;
  return data;
}
// DataSources.js
// Centralized data sources and configuration for multiple AOIs

import { Color } from "three";
import Extent from "@giro3d/giro3d/core/geographic/Extent.js";
import PointCloud from "@giro3d/giro3d/entities/PointCloud.js";
import COPCSource from "@giro3d/giro3d/sources/COPCSource.js";
import GeoTIFFSource from "@giro3d/giro3d/sources/GeoTIFFSource.js";
import {fromUrl} from "geotiff";
import { fetchQGISColorCategorization }  from "./Metadata.js";
import { MODE } from "@giro3d/giro3d/renderer/PointCloudMaterial.js";


// AOI configuration, keyed by AOI name. Populated by loadAOIConfigs().
export let AOI_CONFIGS = {};

// Data is not part of this repo: the Pages workflow copies the data repo into
// public/data, and local dev links public/data to a local copy.
const AOI_CONFIG_URL = './data/aoi-config.json';

/**
 * Fetches the AOI config. Must be awaited before any other function here is
 * used (previously this was a fire-and-forget fetch that raced with callers).
 * @returns {Promise<object>} the AOI configs
 */
export async function loadAOIConfigs(url = AOI_CONFIG_URL) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load AOI config ${url}: ${response.statusText}`);
  }
  loadAOIConfig(await response.json());
  return AOI_CONFIGS;
}

/** The AOI to show: the first (and in the demo, only) AOI in the config. */
export function getDefaultAOIKey() {
  return Object.keys(AOI_CONFIGS)[0];
}

// Loads and caches GeoJSON for a given AOI (or default path)
const geoJsonCache = {};
export async function getTreeCentroidsGeoJson(aoiKey = getDefaultAOIKey()) {
  if (geoJsonCache[aoiKey]) return geoJsonCache[aoiKey];
  const geojsonPath = AOI_CONFIGS[aoiKey].treeCentroidsGeoJson;
  const response = await fetch(geojsonPath);
  if (!response.ok) {
    throw new Error(`Failed to fetch GeoJSON: ${response.statusText}`);
  }
  const data = await response.json();
  geoJsonCache[aoiKey] = data;
  return data;
}

// Allow dynamic loading/replacement of AOI_CONFIGS from an external config object
export function loadAOIConfig(newConfig) {
  AOI_CONFIGS = newConfig;
}

export async function calculateExtentFromImage(url, proj) {
    const tiff = await fromUrl(url);
    const image = await tiff.getImage();
    const [minX, minY, maxX, maxY] = image.getBoundingBox()
    const code = proj;
    return new Extent(code, minX, minY, maxX, maxY);
}

// Utility to create ColorMap from preset
export function makeColorRamp(preset, invert = false, mirror = false) {
  const values = preset.map(v => v.hex);
  const colors = values.map((v) => new Color(v));
  if (invert) colors.reverse();
  if (mirror) return [...colors, ...colors.reverse()];
  return colors;
}

// Returns base point cloud sources and entities for a given AOI
export function getBasePointClouds(aoiKey) {
  const config = AOI_CONFIGS[aoiKey];
  if (!config) throw new Error(`Unknown AOI: ${aoiKey}`);
  const copcSources = (config.copcBase ?? []).map(function(url) {
    const src =  new COPCSource({ url: `./${url}` });
    return src;
  });
  const pointclouds = copcSources.map(function(source) {
    return new PointCloud({ source, pointCloudMode: MODE.TEXTURE });
  });
  return { copcSources, pointclouds };
}

// Example: dynamic sources for selected AOI
export async function getAOISources(aoiKey) {
  const config = AOI_CONFIGS[aoiKey];
  if (!config) throw new Error(`Unknown AOI: ${aoiKey}`);

  const copcSource = new COPCSource({ url: config.copcSourceUrl });
  const pointcloud = new PointCloud({ source: copcSource, pointCloudMode: MODE.TEXTURE });
  let qmlColors = await fetchQGISColorCategorization(config.qmlColorUrl);
  // Use first ndviSource for extent (for compatibility)
  return {
    pointcloud,
    aerialImage: config.aerialImage,
    ndviSource: config.ndviSource,
    qmlColors
  };
}
