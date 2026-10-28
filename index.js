/*
 * Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
 * Licensed under the MIT License; see LICENSE.txt in the project root.
 * SPDX-License-Identifier: MIT
 */

/*
 * Portions of this file are adapted, with modification, from the Giro3D v0.43.5 examples:
 * https://gitlab.com/giro3d/giro3d/-/blob/v0.43.5/examples/lidar_hd.js
 * https://gitlab.com/giro3d/giro3d/-/blob/v0.43.5/examples/ol_vector.js
 * https://gitlab.com/giro3d/giro3d/-/blob/v0.43.5/examples/minimap.js
 * Copyright (c) 2020-2024 Giro3D contributors.
 * SPDX-License-Identifier: MIT (full text in THIRD_PARTY_LICENSES.txt)
 */

import { Vector3 } from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import GeoJSON from "ol/format/GeoJSON.js";
import { Fill, Stroke, Style, Circle as CircleStyle } from "ol/style.js";

import Extent from "@giro3d/giro3d/core/geographic/Extent.js";
import Instance from "@giro3d/giro3d/core/Instance.js";
import ColorLayer from "@giro3d/giro3d/core/layer/ColorLayer.js";
import Map from "@giro3d/giro3d/entities/Map.js";
import { Color } from "three";

import ColorMap from "@giro3d/giro3d/core/ColorMap.js";
import ColorMapMode from "@giro3d/giro3d/core/ColorMapMode.js";
import PointCloud from "@giro3d/giro3d/entities/PointCloud.js";
import GeoTIFFSource from "@giro3d/giro3d/sources/GeoTIFFSource.js";
import COPCSource from "@giro3d/giro3d/sources/COPCSource.js";

import { MODE } from "@giro3d/giro3d/renderer/PointCloudMaterial.js";
import * as d3 from "d3";
import TiledImageSource from "@giro3d/giro3d/sources/TiledImageSource.js";
import OSM from "ol/source/OSM.js";
import VectorSource from "@giro3d/giro3d/sources/VectorSource.js";

import { OrthographicCamera } from "three";
import Coordinates from "@giro3d/giro3d/core/geographic/Coordinates.js";
import { MathUtils } from "three";
import { HistogramSliderPanel } from "./HistogramSliderPanel.js";
import { HistogramBandsPanel } from "./HistogramBandsPanel.js";
import { UMAPVisualizationPanel } from "./UMAPVisualizationPanel.js";
import { getNoDataVLR, fetchAttributeConfig } from "./Metadata.js";
import { RenderingSettings } from "./RenderingSettings.js";
import { MinimapRenderSettings } from "./MinimapRenderSettings.js";
import { FilterSwitch } from "./FilterSwitch.js";
import { getAOISources, getBasePointClouds, AOI_CONFIGS, loadAOIConfigs, getDefaultAOIKey } from "./DataSources.js";
import { Feature } from "ol";
import { setLazPerfPath } from "@giro3d/giro3d/sources/las/config.js";

// Fonts and the laz-perf decoder are self-hosted rather than fetched from
// Google Fonts / jsDelivr, so visitors' browsers make no third-party requests.
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

// Absolute URL: the path is handed to the decoder workers, which resolve
// relative paths against their own script location.
setLazPerfPath(new URL("./vendor/laz-perf", document.baseURI).href);

// The AOI config defines the data and its CRS, so it must load before the
// instance is created.
await loadAOIConfigs();
const AOI_KEY = getDefaultAOIKey();
const AOI_CRS = AOI_CONFIGS[AOI_KEY].crs.code;
Instance.registerCRS(AOI_CRS, AOI_CONFIGS[AOI_KEY].crs.proj4);

const tmpVec3 = new Vector3();
const instance = new Instance({
  target: "view",
  crs: AOI_CRS,
  // preserveDrawingBuffer lets the SVG exporter read back the WebGL canvas
  // (toDataURL) at any time. Polish-fork only; small perf cost is acceptable.
  renderer: { preserveDrawingBuffer: true },
});

// Expose a tiny hook for the runtime-served polish features (background
// toggle + SVG export). See polish-features.js. Populated incrementally.
window.__forestvis = window.__forestvis || {};
window.__forestvis.instance = instance;

let renderingSettings;

const controls = new MapControls(instance.view.camera, instance.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.2;
instance.view.setControls(controls);

const attributeConfig = await fetchAttributeConfig();
// SVG export layout for polish-features.js: "figure" (default) or "screen"
window.__forestvis.svgExportLayout = attributeConfig.renderingPanel?.svgExportLayout || "figure";
const {
  pointcloud,
  aerialImage,
  qmlColors,
} = await getAOISources(AOI_KEY);
const { copcSources, pointclouds } = await getBasePointClouds(AOI_KEY);
const sourceNoDataVLR = await getNoDataVLR(AOI_CONFIGS[AOI_KEY].copcSourceUrl);

let treeCentroidsLayer;
let treeCentroidsSource;
let areaExtentLayer;
let enabledAreas = {}; // Track which areas are enabled (indexed by area number)
let currentFilterAttribute = 'AvgNDVI'; // Current attribute being filtered ('AvgNDVI' or 'Height')
let fSwitch = new FilterSwitch({ histogram: "fSwitch", umap: "umapFSwitch" });
window.fSwitch = fSwitch; // Make fSwitch globally accessible for RenderingSettings
let selectedFeature = null;
let hoveredFeature = null;
let invertRange = false;
let histogramSliderPanel = null;
let histogramBandsPanel = null;
let umapVisualizationPanel = null;
let geoJsonData = null; // Store geojson data for reuse
let nodata;

let pointsCounter = {
  active: [],
  all: 0
};
let minimapPointSizeValue = 2.5;
let minimapCamera;
let minimapInstance;
let minimap;
let minimapRenderSettings = null;
/** Whether the minimap zoom is driven by the main camera FOV + distance */
let syncCameraHeight = true;
/** Minimap drag-to-pan state */
let isDraggingMinimap = false;
let lastDragPixel = null;
/** Minimap interaction mode: 'pan' | 'select' | 'lasso' | 'polygon' | 'complex' */
let minimapSelectMode = 'pan';

const tooltip = document.getElementById("tooltip");

/**
 * Displays a tooltip with the input data.
 * @param {object} data key-value pairs
 * @param {*} x coordinate to display
 * @param {*} y coordinate to display
 * @returns 
 */
function showTooltip(data, x, y) {
  if (!data) return hideTooltip();

  tooltip.innerHTML = "";

  const table = document.createElement("table");

  for (let key in data) {
    const row = document.createElement("tr");

    const cellKey = document.createElement("th");
    cellKey.textContent = key;

    const cellValue = document.createElement("td");
    cellValue.textContent = data[key];

    row.appendChild(cellKey);
    row.appendChild(cellValue);
    table.appendChild(row);
  }

  tooltip.appendChild(table);

  tooltip.style.left = `${x + 12}px`;
  tooltip.style.top = `${y + 12}px`;
  tooltip.classList.remove("hidden");
}

/**
 * Hides tooltip.
 */
function hideTooltip() {
  tooltip.classList.add("hidden");
}

/**
 * Keeps the full-screen #loadingOverlay up until the 3D point cloud has
 * actually processed and rendered, then fades it out. Readiness = giro3d has
 * begun loading tiles (instance.loading) and then gone idle for a short debounce
 * (initial view streamed in). Falls back to a hard timeout so it can never hang.
 */
function setupLoadingOverlay() {
  const overlay = document.getElementById('loadingOverlay');
  if (!overlay) return;
  const fill = overlay.querySelector('.loader-bar-fill');
  const sub = overlay.querySelector('.loader-sub');
  const startTime = Date.now();
  const MIN_MS = 700;     // show at least briefly (avoid a flash)
  const IDLE_MS = 700;    // loading must be idle this long before we call it done
  const MAX_MS = 30000;   // safety cap: never hang forever
  let started = false;    // has the instance begun loading tiles at least once?
  let lastLoadingAt = Date.now();
  let done = false;

  function hide() {
    if (done) return;
    done = true;
    if (fill) fill.style.width = '100%';
    overlay.classList.add('hidden-fade');
    setTimeout(() => { overlay.style.display = 'none'; }, 550);
  }

  function tick() {
    if (done) return;
    const elapsed = Date.now() - startTime;
    let loading = false;
    let progress = 1;
    try { loading = instance.loading; progress = instance.progress; } catch (e) { /* not ready yet */ }

    if (loading) { started = true; lastLoadingAt = Date.now(); }

    const pct = Math.round((progress || 0) * 100);
    if (fill) fill.style.width = (started ? Math.max(8, pct) : 8) + '%';
    if (sub && started) sub.textContent = `Loading 3D point cloud… ${pct}%`;

    const idleFor = Date.now() - lastLoadingAt;
    const ready = started && idleFor > IDLE_MS && elapsed > MIN_MS;
    const settledFast = !started && elapsed > 3500; // nothing ever needed loading
    if (ready || settledFast || elapsed > MAX_MS) { hide(); return; }

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

await instance.add(pointcloud);
await pointcloud.ready;
for (const pc of pointclouds) {
  await instance.add(pc);
}
// Begin watching for the 3D map to finish rendering so we can drop the overlay.
setupLoadingOverlay();
let colorLayer;


initializeCameraPosition(pointcloud);

async function initializeCameraPosition(entity) {
  await entity.ready;
  const bbox = entity.getBoundingBox();
  
  // Check if bbox is valid
  if (!bbox || !bbox.min || !bbox.max) {
    console.error('Could not get valid bounding box from entity');
    return;
  }

  // configure camera; the far plane must also reach the surrounding base tiles
  const sceneBox = bbox.clone();
  for (const pc of pointclouds) {
    const b = pc.getBoundingBox();
    if (b && !b.isEmpty()) sceneBox.union(b);
  }
  instance.view.camera.far = 2.0 * sceneBox.getSize(tmpVec3).length();

  // Import getCameraHeight dynamically to avoid circular dependency
  const { getCameraHeight } = await import('./DataSources.js');
  const cameraHeight = getCameraHeight(AOI_KEY, 500);

  // Start looking straight down on the data from cameraHeight above its centre
  // (cameraHeight used to be an absolute Z, which put the camera below the
  // TEAK data at ~2,170 m elevation). A tiny southward offset keeps the view,
  // and the minimap and compass that follow its azimuth, north-up.
  const center = bbox.getCenter(new Vector3());
  const position = new Vector3(center.x, center.y - cameraHeight * 0.001, center.z + cameraHeight);

  instance.view.camera.position.set(position.x, position.y, position.z);
  instance.view.camera.lookAt(center);
  controls.target.copy(center);
  controls.saveState();

  // EDL / inpainting / occlusion defaults come from attributeConfig.json
  // (renderingPanel), applied by RenderingSettings so the toggles match.

  instance.notifyChange(instance.view.camera);
  instance.notifyChange(pointcloud);
  let mini = await createMinimap();
 
  // Setup rendering settings
  renderingSettings = new RenderingSettings({
    pointcloud,
    instance,
    pointclouds,
    attributeConfig
  });
  
  renderingSettings.setupColorModeToggle();
  renderingSettings.setupPointSizeSliders();
  renderingSettings.setupRenderingToggles();

  // Wire up minimap legend switching whenever the pointcloud attribute changes
  renderingSettings.onModeChange = (attribute, colorMode) => {
    switchMinimapLegend(attribute, colorMode);
  };

  d3.select('#toggleOptions').style('visibility', 'visible');
}

/**
 * Calculates the active-to-all ratio of points on the minimap.
 * The parameter input overrides the calculation of active points.
 * 
 * @param {number} inputActive The number of active points on the minimap (optional)
 */
function updatePointsCounter(inputActive) {
  const countOnes = obj =>
    Object.values(obj).reduce((sum, v) => sum + v, 0);

  let active = inputActive ? inputActive : countOnes(pointsCounter.active);
  pointsCounter.all = treeCentroidsSource.featureCount;
  const span = document.getElementById("points-counter");
  span.textContent = `${active} / ${pointsCounter.all}`;
};

function updateFilter() {
  if (selectedFeature) selectedFeature.set("highlight", false); // hide highlighted point on minimap
  // check if the mode is set to histogram
  if (fSwitch.mode == 'histogram'){
    fSwitch.enable();
    invertRange = ihToggle.checked;
    if (histogramSliderPanel) {
      histogramSliderPanel.setDisabled(false);
    }
    
    const { fromValue, toValue } = histogramSliderPanel ? histogramSliderPanel.getFilterRange() : { fromValue: 0, toValue: 0 };
    
    if (invertRange) {
      pointcloud.source.filters = [
        { dimension: currentFilterAttribute, operator: 'less', value: fromValue, descriptor: { useOrLogic: true } },
        { dimension: currentFilterAttribute, operator: 'greater', value: toValue }
      ];
    } else {
      pointcloud.source.filters = [
        { dimension: currentFilterAttribute, operator: 'greaterequal', value: fromValue },
        { dimension: currentFilterAttribute, operator: 'lessequal', value: toValue }
      ];
    }
  } else if (fSwitch.mode == 'umap') {
    fSwitch.enable();
    
    // Get selected PredInstance IDs from UMAP visualization
    if (umapVisualizationPanel) {
      const selectedPredInstanceIds = umapVisualizationPanel.getSelectedPredInstanceIds();
      
      if (selectedPredInstanceIds && selectedPredInstanceIds.length > 0) {
        // Filter pointcloud to show only selected instances
        pointcloud.source.filters = selectedPredInstanceIds.map(id => ({
          dimension: "PredInstance",
          operator: "equal",
          value: id,
          descriptor: { useOrLogic: true }
        }));
      } else {
        // No selection, clear filters
        pointcloud.source.filters = [];
      }
    }
  }
  
  instance.notifyChange(pointcloud);
  treeCentroidsSource.update();
  updatePointsCounter();
}

function resetFilter() {
  selectedFeature?.set("highlight", false); // hide highlighted point on minimap
  invertRange = false;
  fSwitch.disable();
  if (histogramSliderPanel) {
    histogramSliderPanel.setDisabled(true);
  }
  
  pointcloud.source.filters = [];
  instance.notifyChange(pointcloud);
  treeCentroidsSource.update();
  updatePointsCounter();
}

function initFilterHistogram(attribute = 'AvgNDVI') {
  currentFilterAttribute = attribute;
  
  // Destroy existing histogram if present
  if (histogramSliderPanel) {
    histogramSliderPanel.destroy();
  }
  
  histogramSliderPanel = HistogramSliderPanel.initializeFromConfig({
    // Measure the histogram's own container (Filter tab) so it fills the box
    // width, instead of the unrelated minimap panel which made it too narrow.
    containerSelector: '#histogram-div',
    parentSelector: '#histogram-div',
    getAttributeValues: (attr) => {
      const values = [];
      treeCentroidsSource.forEachFeature(function (feature) {
        const value = parseFloat(feature.get(attr));
        if(!(value === nodata) && !isNaN(value)) {
           values.push(value);
        }
      });
      return values;
    },
    nodataRecords: sourceNoDataVLR["nodata_records"],
    attributeConfig: attributeConfig,
    initialAttribute: attribute,
    invertToggleSelector: '#ihToggle',
    filterAttributeSelectSelector: '#filterAttributeSelect',
    fSwitch: fSwitch,
    invertRange: invertRange,
    onFilterChange: (e, x, y) => {
      fSwitch.enable('histogram');
      updateFilter();
    },
    updateFilter: updateFilter,
    resetFilter: resetFilter,
    initFilterHistogram: initFilterHistogram,
    onAttributeChangeNoFilter: () => {
      // Update minimap when attribute changes without active filter
      treeCentroidsSource.update();
      updatePointsCounter();
    },
    onResize: (width) => {
      // Optional resize callback
    }
  });
  
  // Update nodata value for the legend
  sourceNoDataVLR["nodata_records"].forEach((e) => {
    if (e["dimension"] === attribute) {
      nodata = e["nodata_value"];
    }
  });
}

async function initHistogramBands() {
  // Use DataSources.js for resource URLs and GeoJSON
  const aoiKey = AOI_KEY;
  const { AOI_CONFIGS, getTreeCentroidsGeoJson } = await import('./DataSources.js');
  const config = AOI_CONFIGS[aoiKey];
  if (!geoJsonData) {
    geoJsonData = await getTreeCentroidsGeoJson(aoiKey);
  }
  histogramBandsPanel = await HistogramBandsPanel.initializeFromConfig({
    aoiConfig: config,
    containerSelector: '#details-panel',
    geojsonData: geoJsonData,
    ndviParentSelector: '#details-histogram-ndvi',
    rgbParentSelector: '#details-histogram-rgb',
  });
}

async function initUMAPVisualization() {
  if (!geoJsonData) {
    console.error('GeoJSON data not loaded yet');
    return;
  }
  
  // Add event listener for UMAP selection changes
  document.addEventListener('umap-selection-change', (event) => {
    handleSelection();
    updateFilter();
  });
  
  const { AOI_CONFIGS } = await import('./DataSources.js');
  const config = AOI_CONFIGS[AOI_KEY];
  umapVisualizationPanel = await UMAPVisualizationPanel.initializeFromConfig({
    containerSelector: '#umap-panel',
    parentSelector: '#umap-container',
    geojsonData: geoJsonData,
    metadataPath: config.treeCentroidsUMAPMetadata,
    colorBy: 'Height',
    height: 400,
    pointRadius: 4,
    pointOpacity: 0.6,
    onSelectionChange: () => {
      // Selection change is already handled by the event listener above
    },
    fSwitch: fSwitch,
    updateFilter: updateFilter,
    resetFilter: resetFilter
  });
}

const EPSG3857= new Extent(
  "EPSG:3857",
  -20037508.342789244,
  20037508.342789244,
  -20037508.342789244,
  20037508.342789244,
);

// Per-area colours shared by the areas legend chips and the minimap area outlines.
function areaColorScale(config) {
  const areaKeys = Object.keys(config['index-to-area-name'] || {}).map(Number);
  return d3.scaleOrdinal().domain(areaKeys).range(d3.schemeSet2);
}

async function initializeAreasList() {
  try {
    const { AOI_CONFIGS } = await import('./DataSources.js');
    const config = AOI_CONFIGS[AOI_KEY];
    const indexToAreaName = config['index-to-area-name'];
    if (!indexToAreaName) {
      console.warn('No index-to-area-name mapping found in config');
      return;
    }
    const container = document.getElementById('minimap-areas-list');
    if (!container) {
      console.warn('minimap-areas-list container not found');
      return;
    }
    //container.innerHTML = '';

    // Color ramp: use d3.schemeSet2 (same as VerticalBarsPanel)
    //const areaKeys = Object.keys(indexToAreaName).map(Number);
    //const color = d3.scaleOrdinal()
    //  .domain(areaKeys)
    //  .range(d3.schemeSet2);

    // Grid container

      container.innerHTML = '';

      // Add annotation/heading for Areas
     

      // Color ramp: use d3.schemeSet2 (same as VerticalBarsPanel)
      const areaKeys = Object.keys(indexToAreaName).map(Number);
      const color = areaColorScale(config);

      const annotation = document.createElement('div');
      annotation.className = 'areas-annotation';
      annotation.style.width = "6em";
      annotation.textContent = 'Areas';
      container.appendChild(annotation);

      // Grid container
      const grid = document.createElement('div');
      
      grid.className = 'areas-grid';
      container.appendChild(grid);
      
      areaKeys.forEach(areaNum => {
      const areaName = indexToAreaName[areaNum];
      const chip = document.createElement('div');
      chip.className = 'area-chip area-chip-selected';
      chip.setAttribute('data-area', areaNum);
      chip.title = areaName;
      chip.style.setProperty('--area-color', color(areaNum));

      // Color swatch
      const swatch = document.createElement('span');
      swatch.className = 'area-chip-swatch';
      swatch.style.backgroundColor = color(areaNum);
      chip.appendChild(swatch);

      // Label
      const label = document.createElement('span');
      label.className = 'area-chip-label';
      label.textContent = areaName;
      chip.appendChild(label);

      chip.addEventListener('click', function() {
        const selected = chip.classList.toggle('area-chip-selected');
        enabledAreas[areaNum] = selected;
        toggleArea(areaNum, selected);
      });

      grid.appendChild(chip);
    });
  } catch (error) {
    console.error('Error initializing areas list:', error);
  }
}

function toggleArea(areaNum, enabled) {
  // Toggle visibility of tree centroids for this area
  if (treeCentroidsSource) {
    treeCentroidsSource.update();
  }
  
  // Toggle visibility of corresponding area extent layer
  if (areaExtentLayer && areaExtentLayer[areaNum]) {
    areaExtentLayer[areaNum].visible = enabled;
  }
  
  // Update the minimap display
  if (minimapInstance) {
    minimapInstance.notifyChange(minimap);
  }
  
  // Update points counter
  updatePointsCounter();
}

async function initTreeCentroidsLayer() {
  try {
    // Add area extent layers (background polygons)
    const vectorLayers = await addAreaExtentLayers(minimap);
    if (vectorLayers) {
      areaExtentLayer = vectorLayers;
    }
    // Add tree centroids layer
    const treeCentroidsResult = await addTreeCentroidsLayer(minimap, 'tree_centroids');
    if (treeCentroidsResult) {
      treeCentroidsLayer = treeCentroidsResult.shapefileLayer;
      treeCentroidsSource = treeCentroidsResult.shapefileSource;
      initFilterHistogram();
      updatePointsCounter(treeCentroidsSource.featureCount);
      initializeAreasList();
      await initHistogramBands();
      // Set up event listener for UMAP tab - initialize when first shown
      const umapTab = document.getElementById('umap-tab');
      if (umapTab) {
        umapTab.addEventListener('shown.bs.tab', async function (event) {
          if (!umapVisualizationPanel) {
            await initUMAPVisualization();
          } else {
            // Refresh visualization state when tab is shown again
            // Use setTimeout to ensure DOM is ready after tab switch
            setTimeout(() => {
              umapVisualizationPanel.refreshVisualization();
            }, 10);
          }
        });
      }
    }
  } catch (error) {
    console.error('Failed to add tree centroids to minimap:', error);
  }
  // Show Point Layer toggle
  const splToggle = document.getElementById('splToggle');
  const saelToggle = document.getElementById('saelToggle');

  // Set initial state
  splToggle.addEventListener('change', function () {
    treeCentroidsLayer.visible = splToggle.checked;
    instance.notifyChange(instance.view.camera);
  });
  // Set initial state
  saelToggle.addEventListener('change', function () {
    for (const l  of areaExtentLayer) {
        l.visible = saelToggle.checked;
    }
    instance.notifyChange(instance.view.camera);
  });
}

/**
 * Angle (radians, counter-clockwise) from Web Mercator north to the AOI CRS's
 * grid north at a point. The controls' azimuth is measured from grid north, but
 * the minimap is drawn in EPSG:3857, so rotations need this added. About 0° for
 * SWEREF99 TM near its central meridian, about 1.2° at TEAK in UTM 11N.
 */
function gridConvergence(x, y) {
  const src = instance.referenceCrs;
  const dst = minimapInstance.referenceCrs;
  const a = new Coordinates(src, x, y).as(dst);
  const b = new Coordinates(src, x, y + 100).as(dst);
  return Math.atan2(-(b.x - a.x), b.y - a.y);
}

function synchronizeCameras() {
  const target = controls.target;
  // Rotate the minimap and compass with the point cloud, in the minimap's frame
  const rot = controls.getAzimuthalAngle() + gridConvergence(target.x, target.y);
  minimapCamera.rotation.z = rot;
  const compass = document.getElementById("compass");
  compass.style.transform = 'rotate('+ rot +'rad)';
  // Since our minimap does not use the same projection as the main view (AOI_CRS),
  // we must convert the camera position into this projection (EPSG:3857).
  const srcProj = instance.referenceCrs;
  const dstProj = minimapInstance.referenceCrs;
  const srcPosition = new Coordinates(srcProj, target.x, target.y);
  const position = srcPosition.as(dstProj);

  // Then we can assign the position to the camera, while still keeping a constant altitude.
  // The minimap camera "altitude" never changes because we are using an orthographic camera.
  // Changing this value will not change the size of objects rendered in this view.
  const MINIMAP_CAMERA_ALTITUDE = 2;
  minimapInstance.view.camera.position.set(
    position.x,
    position.y,
    MINIMAP_CAMERA_ALTITUDE,
  );

  // ── Height synchronization: FOV + distance → ground footprint → zoom ────
  if (syncCameraHeight) {
    const cam = instance.view.camera;
    // Distance from camera to orbit target (more accurate than altitude alone)
    const d = cam.position.distanceTo(controls.target);
    if (d > 0) {
      const fovRad = (cam.fov * Math.PI) / 180;
      // Visible width in scene units (AOI CRS metres) at the target plane
      const visibleWidthScene = 2 * d * Math.tan(fovRad / 2) * cam.aspect;
      // Mercator scale factor: EPSG:3857 stretches distances at high latitudes
      // (y3857 → latitude → 1/cos(lat))
      const y3857 = minimapInstance.view.camera.position.y;
      const latRad = Math.atan(Math.sinh(y3857 / 6378137)); // constant from wgs84 definition of elipsoid: lat = atan(sinh(y / R))
      const mercScale = 1 / Math.cos(latRad);
      // Ortho frustum base width in EPSG:3857 (zoom-independent, from camera params)
      const orthoBaseWidth = minimapCamera.right - minimapCamera.left;
      minimapCamera.zoom = orthoBaseWidth / (visibleWidthScene * mercScale);
      minimapCamera.updateProjectionMatrix();
    }
  }

  minimapInstance.notifyChange(minimap);
}

function handleMouseWheel(event) {
  const delta = event.wheelDelta;
  const absDelta = Math.abs(delta);
  const ZOOM_SPEED = MathUtils.mapLinear(absDelta, 0, 120, 1.01, 1.2);

  if (syncCameraHeight) {
    // Dolly the main camera along its look direction so synchronizeCameras
    // can derive the correct minimap zoom automatically via syncCameraHeight.
    const cam = instance.view.camera;
    const target = controls.target;
    const distance = cam.position.distanceTo(target);

    // Zoom in → shrink distance, zoom out → grow distance
    const newDistance = delta > 0 ? distance / ZOOM_SPEED : distance * ZOOM_SPEED;

    // Move camera along the camera→target axis, keeping target fixed
    const dollyDir = target.clone().sub(cam.position).normalize();
    cam.position.copy(target.clone().sub(dollyDir.multiplyScalar(newDistance)));
    controls.saveState();
    instance.notifyChange(cam);
  } else {
    // Sync is off: zoom the minimap orthographic camera directly
    if (delta > 0) {
      minimapCamera.zoom *= ZOOM_SPEED;
    } else {
      minimapCamera.zoom /= ZOOM_SPEED;
    }
    minimapCamera.updateProjectionMatrix();
    minimapInstance.notifyChange(minimapCamera);
  }

  event.preventDefault();
}

function getFeatureFromMouseEvent(mouseEvent) {
  const pickResult = minimapInstance.pickObjectsAt(mouseEvent);
  const picked = pickResult?.[0];
  if (!picked) return null;

  const { x, y } = picked.point;
  // the extent is a square
  const options = {
    radius: minimapPointSizeValue / 2,
    xTileRes: 1,
    yTileRes: 1,
  };

  const features = treeCentroidsLayer.getVectorFeaturesAtCoordinate(
    new Coordinates("EPSG:3857", x, y),
    options
  );

  return features.length > 0 ? features[0] : null;
}

function handleHover(mouseEvent) {
  const feature = getFeatureFromMouseEvent(mouseEvent);

  if (!feature) {
    hoveredFeature = null;
    hideTooltip();
    return;
  }

  hoveredFeature = feature;
  showTooltip(buildTreeInfo(feature), mouseEvent.clientX, mouseEvent.clientY);
}

function handleSelection() {
  if (!treeCentroidsSource) {
    console.warn('Tree centroids source not available yet');
    return;
  }
  
  if (!umapVisualizationPanel) {
    console.warn('UMAP visualization panel not available yet');
    return;
  }
  
  // Query current selection from UMAP visualization
  const predInstanceIds = umapVisualizationPanel.getSelectedPredInstanceIds();
  
  // If no selection, clear all UMAP selections
  if (!predInstanceIds || predInstanceIds.length === 0) {
    // Clear all UMAP selections (but keep click highlights)
    treeCentroidsSource.forEachFeature(function(feature) {
      feature.set('umapSelected', false);
    });
    treeCentroidsSource.update();
    return;
  }
  
  // Mark UMAP selected features on minimap (shown as blue)
  treeCentroidsSource.forEachFeature(function(feature) {
    const predInstan = feature.get('PredInstan');
    if (predInstanceIds.includes(predInstan)) {
      feature.set('umapSelected', true);
    } else {
      feature.set('umapSelected', false);
    }
  });
  
  // Update minimap visualization to show UMAP selections
  treeCentroidsSource.update();
}

function handleMinimapMouseDown(mouseEvent) {
  if (minimapSelectMode !== 'pan') return; // selection overlay handles drags
  if (mouseEvent.button !== 0) return; // left button only
  isDraggingMinimap = true;
  lastDragPixel = { x: mouseEvent.clientX, y: mouseEvent.clientY };
  mouseEvent.preventDefault();
}

function handleMinimapMouseMove(mouseEvent) {
  if (minimapSelectMode !== 'pan') return; // no hover/pan while selecting
  if (!isDraggingMinimap || !lastDragPixel) {
    handleHover(mouseEvent);
    return;
  }

  const dx_px = mouseEvent.clientX - lastDragPixel.x;
  const dy_px = mouseEvent.clientY - lastDragPixel.y;
  lastDragPixel = { x: mouseEvent.clientX, y: mouseEvent.clientY };

  if (dx_px === 0 && dy_px === 0) return;

  // Convert pixel delta to EPSG:3857 world delta via the minimap orthographic camera
  const canvas = minimapInstance.domElement;
  const effectiveWidth3857 = (minimapCamera.right - minimapCamera.left) / minimapCamera.zoom;
  const effectiveHeight3857 = (minimapCamera.top - minimapCamera.bottom) / minimapCamera.zoom;

  // Account for the minimap camera rotation (mirrors main view azimuth)
  const θ = minimapCamera.rotation.z;
  // dxCam/dyCam: pixel delta → camera-space world delta (screen Y is flipped relative to world Y)
  const dxCam = dx_px * effectiveWidth3857 / canvas.clientWidth;
  const dyCam = dy_px * effectiveHeight3857 / canvas.clientHeight;

  // Rotate from camera space into world space (EPSG:3857), negate for drag direction.
  // Correct rotation accounting for screen-Y flip: worldY component uses +cos, not -cos.
  const dx3857 = -(dxCam * Math.cos(θ) + dyCam * Math.sin(θ));
  const dy3857 = -(dxCam * Math.sin(θ) - dyCam * Math.cos(θ));

  // Convert EPSG:3857 delta to the AOI CRS by differencing two nearby projected points
  const camPos3857 = minimapInstance.view.camera.position;
  const p1 = new Coordinates("EPSG:3857", camPos3857.x, camPos3857.y).as(AOI_CRS);
  const p2 = new Coordinates("EPSG:3857", camPos3857.x + dx3857, camPos3857.y + dy3857).as(AOI_CRS);
  const dxAoi = p2.x - p1.x;
  const dyAoi = p2.y - p1.y;

  const cam = instance.view.camera;
  cam.position.x += dxAoi;
  cam.position.y += dyAoi;
  controls.target.x += dxAoi;
  controls.target.y += dyAoi;
  controls.saveState();
  instance.notifyChange(cam);
}

function handleMinimapMouseUp() {
  isDraggingMinimap = false;
  lastDragPixel = null;
}

function handleClick(mouseEvent) {
  if (minimapSelectMode !== 'pan') return; // selection overlay handles clicks
  const feature = getFeatureFromMouseEvent(mouseEvent);

  if (!feature) {
    clearSelection();
    return;
  }

  if (selectedFeature !== feature) {
    selectedFeature?.set("highlight", false);    
    feature.set("highlight", true);
    treeCentroidsSource.updateFeature(selectedFeature, feature);
    selectedFeature = feature;

    if (histogramSliderPanel) {
      histogramSliderPanel.setDisabled(true);
    }
    fSwitch.disable();
    invertRange = false;
    updatePointsCounter(1);

    pointcloud.source.filters = [
      {
        dimension: "PredInstance",
        operator: "equal",
        value: feature.get("PredInstan"),
      },
    ];

    instance.notifyChange(pointcloud);
    treeCentroidsSource.update();
    
    // Update HistogramBands in details panel
    if (histogramBandsPanel) {
      const predInstance = feature.get("PredInstan");
      histogramBandsPanel.redraw(predInstance);
    }
  }
}

function clearSelection() {
  selectedFeature?.set("highlight", false);
  selectedFeature = null;
  resetFilter();
  
  // Show empty axes when no point is selected
  if (histogramBandsPanel) {
    histogramBandsPanel.drawEmptyAxes();
  }
}

/**
 * Gets information about the feature.
 * @param {Feature} feature 
 * @returns object that hold information about the feature
 */
function buildTreeInfo(feature) {
  const formatValue = (attrName, value) => {
    const config = attributeConfig?.attributes[attrName];
    if (!config || config.decimals === undefined) return value;
    const multiplier = Math.pow(10, config.decimals);
    return Math.round(value * multiplier) / multiplier;
  };
  
  const info = {};
  if (attributeConfig && attributeConfig.attributes) {
    Object.keys(attributeConfig.attributes).forEach(attrName => {
      let attr = attributeConfig.attributes[attrName];
      if (attrName.startsWith('PredInstan') ) {
        info.PredInstance = feature.get('PredInstan');
        attr = attributeConfig.attributes['PredInstance'];
        info[attr.label || attrName] = formatValue('PredInstance', feature.get('PredInstan'));
        return;
      }
      if (attr.pointCloudOnly === true) return;
      info[attr.label || attrName] = formatValue(attrName, feature.get(attrName));
    });
  }
  return info;
}

/**
 * Adds UMAP-style spatial selection tools to the minimap: a small toolbox
 * (pan / box / lasso / polygon / complex) plus an SVG drawing overlay. Trees are
 * hit-tested by projecting their EPSG:3857 centroid through the minimap camera to
 * screen pixels, then the chosen PredInstance IDs are fed into the shared
 * selection (umapViz.selectByPredInstanceIds) so the minimap, the UMAP scatter
 * and the 3D filter all stay in sync — exactly like selecting in the UMAP.
 */
function setupMinimapSelection() {
  const container = document.getElementById('minimap');
  if (!container) { console.warn('[minimap-select] #minimap not found'); return; }
  if (container.querySelector('.minimap-select-overlay')) return; // already set up
  if (!container.style.position) container.style.position = 'relative';
  const SVGNS = 'http://www.w3.org/2000/svg';

  if (!document.getElementById('minimap-select-styles')) {
    const st = document.createElement('style');
    st.id = 'minimap-select-styles';
    st.textContent = `
      /* Toolbar sits in its own row ABOVE the minimap (not over the map), so it
         never introduces a scrollbar inside #minimap. */
      .minimap-toolbox { display:flex; gap:4px; align-items:center; height:24px; margin:2px 0 8px; }
      .minimap-tool-btn { width:24px; height:24px; padding:0; line-height:1; font-size:13px;
        border:1px solid #dee2e6; border-radius:5px; background:#f8f9fa; color:#333; cursor:pointer;
        display:flex; align-items:center; justify-content:center; box-shadow:0 1px 2px rgba(0,0,0,.15); }
      .minimap-tool-btn:hover { border-color:#9ca3af; }
      .minimap-tool-btn.active { background:#2f6db0; color:#fff; border-color:#2f6db0; }
      /* Explicit size: an <svg> with only inset:0 keeps its intrinsic 300x150
         and would overflow the map (causing a scrollbar). */
      .minimap-select-overlay { position:absolute; inset:0; display:block; width:100%; height:100%;
        z-index:5; cursor:crosshair; }
      /* Push the compass down by the toolbar's height so it still sits over the map. */
      #compass { top: 80px; }
    `;
    document.head.appendChild(st);
  }

  const tools = [
    { mode: 'pan',     icon: '✋', title: 'Pan / move the view' },
    { mode: 'select',  icon: '⬚', title: 'Box select (drag a rectangle; Shift adds)' },
    { mode: 'lasso',   icon: '✎', title: 'Freehand lasso (drag a free shape; Shift adds)' },
    { mode: 'polygon', icon: '⬢', title: 'Polygon (click vertices; click first point / double-click to close; draw several to union)' },
    { mode: 'complex', icon: '⧉', title: 'Complex (drag adds regions; hold Alt to subtract)' },
  ];
  const toolbox = document.createElement('div');
  toolbox.className = 'minimap-toolbox';
  const buttons = {};
  tools.forEach((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'minimap-tool-btn' + (t.mode === minimapSelectMode ? ' active' : '');
    b.textContent = t.icon;
    b.title = t.title;
    b.addEventListener('click', (e) => { e.stopPropagation(); setMinimapMode(t.mode); });
    toolbox.appendChild(b);
    buttons[t.mode] = b;
  });
  // Place the toolbar in a row ABOVE the minimap (its parent flow), not over the
  // map, so it cannot create an internal scrollbar.
  (container.parentElement || container).insertBefore(toolbox, container);

  const overlay = document.createElementNS(SVGNS, 'svg');
  overlay.setAttribute('class', 'minimap-select-overlay');
  overlay.style.pointerEvents = 'none';
  container.appendChild(overlay);

  // --- project every tree centroid (EPSG:3857) to overlay pixel coords ---
  function projectTrees() {
    const out = [];
    if (!treeCentroidsSource || !minimapInstance) return out;
    const cam = minimapInstance.view.camera;
    cam.updateMatrixWorld(true);
    const rect = overlay.getBoundingClientRect();
    treeCentroidsSource.forEachFeature((f) => {
      const g = f.getGeometry();
      if (!g) return;
      const c = g.getCoordinates(); // [x, y] in EPSG:3857
      const v = new Vector3(c[0], c[1], 0).project(cam);
      if (v.z < -1 || v.z > 1) return; // outside the camera frustum
      out.push({
        id: f.get('PredInstan'),
        x: (v.x * 0.5 + 0.5) * rect.width,
        y: (1 - (v.y * 0.5 + 0.5)) * rect.height,
      });
    });
    return out;
  }

  function pointInPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      const intersect = ((yi > y) !== (yj > y)) &&
        (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function selectionCount() {
    const viz = umapVisualizationPanel && umapVisualizationPanel.umapViz;
    return viz && viz.selectedPoints ? viz.selectedPoints.length : 0;
  }

  function applyPolygon(poly, combine) {
    if (!poly || poly.length < 3) return;
    const trees = projectTrees();
    const ids = [];
    trees.forEach((t) => { if (pointInPolygon(t.x, t.y, poly)) ids.push(t.id); });
    const viz = umapVisualizationPanel && umapVisualizationPanel.umapViz;
    if (viz && typeof viz.selectByPredInstanceIds === 'function') {
      viz.selectByPredInstanceIds(ids, combine);
    }
  }

  // --- gesture wiring (torn down + rebuilt on each mode change) ---
  let cleanup = [];
  function on(target, type, handler, opts) {
    target.addEventListener(type, handler, opts);
    cleanup.push(() => target.removeEventListener(type, handler, opts));
  }
  function teardown() {
    cleanup.forEach((fn) => { try { fn(); } catch (e) {} });
    cleanup = [];
    while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
  }
  function ptr(e) {
    const rect = overlay.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }
  function mkShape(tag) {
    const s = document.createElementNS(SVGNS, tag);
    s.setAttribute('fill', 'rgba(47,109,176,0.12)');
    s.setAttribute('stroke', '#2f6db0');
    s.setAttribute('stroke-width', '1.5');
    return s;
  }

  function enableBox() {
    let drawing = false, start = null, r = null;
    on(overlay, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      drawing = true; start = ptr(e);
      r = mkShape('rect'); r.setAttribute('stroke-dasharray', '4 3');
      overlay.appendChild(r);
      try { overlay.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    on(overlay, 'pointermove', (e) => {
      if (!drawing) return;
      const p = ptr(e);
      r.setAttribute('x', Math.min(start[0], p[0]));
      r.setAttribute('y', Math.min(start[1], p[1]));
      r.setAttribute('width', Math.abs(p[0] - start[0]));
      r.setAttribute('height', Math.abs(p[1] - start[1]));
    });
    const finish = (e) => {
      if (!drawing) return;
      drawing = false;
      const p = ptr(e);
      const x0 = Math.min(start[0], p[0]), y0 = Math.min(start[1], p[1]);
      const x1 = Math.max(start[0], p[0]), y1 = Math.max(start[1], p[1]);
      if (r) { r.remove(); r = null; }
      if (x1 - x0 > 2 && y1 - y0 > 2) {
        applyPolygon([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], e.shiftKey ? 'add' : 'replace');
      }
    };
    on(overlay, 'pointerup', finish);
    on(overlay, 'pointerleave', (e) => { if (drawing) finish(e); });
  }

  function enableFreehand(modeName) {
    let drawing = false, pts = [], path = null;
    on(overlay, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      drawing = true; pts = [ptr(e)];
      path = mkShape('path'); path.setAttribute('stroke-dasharray', '4 3');
      overlay.appendChild(path);
      try { overlay.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    on(overlay, 'pointermove', (e) => {
      if (!drawing) return;
      pts.push(ptr(e));
      path.setAttribute('d', 'M' + pts.map((p) => p.join(',')).join('L') + 'Z');
    });
    const finish = (e) => {
      if (!drawing) return;
      drawing = false;
      if (pts.length >= 3) {
        let combine = 'replace';
        if (modeName === 'complex') combine = e.altKey ? 'subtract' : 'add';
        else if (e.shiftKey) combine = 'add';
        applyPolygon(pts, combine);
      }
      if (path) { path.remove(); path = null; }
      pts = [];
    };
    on(overlay, 'pointerup', finish);
    on(overlay, 'pointerleave', (e) => { if (drawing) finish(e); });
  }

  function enablePolygon() {
    let verts = [];
    const shape = mkShape('path');
    const dots = document.createElementNS(SVGNS, 'g');
    overlay.appendChild(shape); overlay.appendChild(dots);
    const redraw = () => {
      shape.setAttribute('d', verts.length
        ? 'M' + verts.map((p) => p.join(',')).join('L') + (verts.length > 2 ? 'Z' : '')
        : '');
      while (dots.firstChild) dots.removeChild(dots.firstChild);
      verts.forEach((p) => {
        const c = document.createElementNS(SVGNS, 'circle');
        c.setAttribute('cx', p[0]); c.setAttribute('cy', p[1]);
        c.setAttribute('r', 3); c.setAttribute('fill', '#2f6db0');
        dots.appendChild(c);
      });
    };
    const commit = (e) => {
      if (verts.length >= 3) {
        const combine = (selectionCount() > 0 || e.shiftKey) ? 'add' : 'replace';
        applyPolygon(verts, combine);
      }
      verts = []; redraw();
    };
    on(overlay, 'click', (e) => {
      e.stopPropagation();
      const p = ptr(e);
      if (verts.length >= 3) {
        const f = verts[0];
        if (Math.hypot(p[0] - f[0], p[1] - f[1]) < 9) { commit(e); return; }
      }
      verts.push(p); redraw();
    });
    on(overlay, 'dblclick', (e) => { e.preventDefault(); e.stopPropagation(); commit(e); });
  }

  function setMinimapMode(mode) {
    minimapSelectMode = mode;
    Object.keys(buttons).forEach((m) => buttons[m].classList.toggle('active', m === mode));
    teardown();
    if (mode === 'pan') {
      overlay.style.pointerEvents = 'none'; // let the canvas pan/click/hover
      return;
    }
    overlay.style.pointerEvents = 'all';
    // keep wheel-zoom working over the overlay in selection modes
    on(overlay, 'wheel', (e) => handleMouseWheel(e), { passive: false });
    if (mode === 'select') enableBox();
    else if (mode === 'lasso' || mode === 'complex') enableFreehand(mode);
    else if (mode === 'polygon') enablePolygon();
  }

  setMinimapMode(minimapSelectMode);
}

async function createMinimap() {
  // Get the main scene extent for the minimap bounds
  const mainBbox = pointcloud.getBoundingBox();
  const mapExtent = Extent.fromBox3(AOI_CRS, mainBbox);

  minimapInstance = new Instance({
    target: "minimap",
    crs: "EPSG:3857", // Contrary to the main view, this minimap uses the Web mercator projection
    renderer: { preserveDrawingBuffer: true }, // allow SVG-export raster capture
  });
  window.__forestvis = window.__forestvis || {};
  window.__forestvis.minimapInstance = minimapInstance;

  // Use the configured camera height for minimap camera width
  let minimapCameraWidth = 16000;
  try {
    // Import getCameraHeight dynamically to avoid circular dependency
    const { getCameraHeight } = await import('./DataSources.js');
    const cameraHeight = getCameraHeight(AOI_KEY, 500);
    minimapCameraWidth = cameraHeight * 1.8;
  } catch (e) {
    // fallback to default if import fails
  }
  minimapCamera = new OrthographicCamera(
    -minimapCameraWidth / 10,
    minimapCameraWidth / 10,
    500,
    -500,
  );

  minimapInstance.view.camera = minimapCamera;

  // Let's create our minimap map with the same extent than the main map.
  minimap = new Map({
    extent: EPSG3857,
    backgroundColor: "black",
  });

  minimapInstance.add(minimap);

  const osmLayer = new ColorLayer({
    name: "osm",
    preloadImages: true,
    source: new TiledImageSource({ source: new OSM() }),
  });
  osmLayer.userData.zOrder = 0;

  minimap.addLayer(osmLayer);

  // Giro3D does not render OpenLayers' attribution control, so credit the
  // minimap's sources ourselves: the tree/area overlay is processed NEON data
  // (CC BY 4.0) and the basemap is OSM (ODbL and the OSM tile usage policy).
  const minimapAttribution = document.createElement("div");
  minimapAttribution.className = "minimap-attribution";
  minimapAttribution.innerHTML =
    'Processed <button type="button" class="minimap-attribution-neon">NEON</button> data, ' +
    '<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a> · ' +
    '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
  minimapAttribution.querySelector("button").addEventListener("click", () => {
    document.getElementById("datasetInfoLink").click();
  });
  const minimapContainer = document.getElementById("minimap");
  if (!minimapContainer.style.position) minimapContainer.style.position = "relative";
  minimapContainer.appendChild(minimapAttribution);

  // Build a live-state proxy so MinimapRenderSettings always reads current values
  const minimapState = {
    get nodata()                 { return nodata; },
    get fSwitch()                { return fSwitch; },
    get histogramSliderPanel()   { return histogramSliderPanel; },
    get currentFilterAttribute() { return currentFilterAttribute; },
    get umapVisualizationPanel() { return umapVisualizationPanel; },
    get invertRange()            { return invertRange; },
    get enabledAreas()           { return enabledAreas; },
    get minimapPointSizeValue()  { return minimapPointSizeValue; },
    get pointsCounter()          { return pointsCounter; },
  };

  minimapRenderSettings = new MinimapRenderSettings({
    attributeConfig,
    aoiConfig: AOI_CONFIGS[AOI_KEY],
    state: minimapState,
  });

  const minimapPointSizeSlider = document.getElementById("minimapPointSizeSlider");
  const minimapPointSizeLabel = document.getElementById("minimapPointSizeValue");
  minimapPointSizeSlider.addEventListener('input', function() {
      minimapPointSizeValue = parseFloat(this.value).toFixed(1);
      minimapPointSizeLabel.textContent = minimapPointSizeValue;
      // Clear style cache to force recreation with new point size
      minimapRenderSettings.clearStyleCache();
      treeCentroidsSource.update();
    });

  initTreeCentroidsLayer();

  minimapInstance.domElement.addEventListener("wheel", handleMouseWheel);
  instance.addEventListener("after-camera-update", synchronizeCameras);

  minimapRenderSettings.renderLegend('minimap-legend');

  // Wire up the Sync Height toggle button
  const syncHeightBtn = document.getElementById('syncCameraHeightBtn');
  if (syncHeightBtn) {
      // Set initial visual state (enabled)
      syncHeightBtn.classList.add('btn-primary');
      syncHeightBtn.classList.remove('btn-outline-secondary');
      syncHeightBtn.title = 'Zoom sync ON – click to disable';
      syncHeightBtn.addEventListener('click', () => {
        syncCameraHeight = !syncCameraHeight;
        syncHeightBtn.classList.toggle('btn-primary', syncCameraHeight);
        syncHeightBtn.classList.toggle('btn-outline-secondary', !syncCameraHeight);
        syncHeightBtn.title = syncCameraHeight
          ? 'Zoom sync ON – click to disable'
          : 'Zoom sync OFF – click to enable';
        // Apply immediately
        synchronizeCameras();
      });
  }

  minimapInstance.domElement.addEventListener("mousedown", handleMinimapMouseDown);
  minimapInstance.domElement.addEventListener("mousemove", handleMinimapMouseMove);
  minimapInstance.domElement.addEventListener("mouseup", handleMinimapMouseUp);
  minimapInstance.domElement.addEventListener("mouseleave", () => { isDraggingMinimap = false; lastDragPixel = null; hideTooltip(); });
  minimapInstance.domElement.addEventListener("click", handleClick);

  setupMinimapSelection();

  return minimap;
}

/**
 * Called when the user changes the pointcloud rendering attribute.
 * Delegates to MinimapRenderSettings which re-maps the attribute name via
 * minimapDefaultLayerMapping, flushes the style cache and triggers a legend
 * update on the minimap.
 *
 * @param {string} attribute  – the pointcloud attribute key (e.g. 'AvgNDVI', 'Height', 'PredInstance')
 * @param {string} colorMode  – colour-mode hint forwarded from RenderingSettings
 */
async function switchMinimapLegend(attribute, colorMode) {
  if (!minimapRenderSettings) return;
  await minimapRenderSettings.switchMinimapLegend(attribute, colorMode);
  // Trigger minimap re-render with the new style
  if (treeCentroidsSource) {
    treeCentroidsSource.update();
  }
  if (minimapInstance) {
    minimapInstance.notifyChange(minimap);
  }
}


async function addAreaExtentLayers(minimap) {
  try {
    const { AOI_CONFIGS } = await import('./DataSources.js');
    const config = AOI_CONFIGS[AOI_KEY];

    const color = areaColorScale(config);

    const vectorLayers = [];
    for (const [areaNum, r] of config.regionBoundingGeoJson.entries()) {
      // Outline in the area's legend colour with a faint tint, so the basemap and tree points stay visible
      const areaColor = color(areaNum);
      const customVectorLayerStyle = new Style({
        zIndex: 10,
        fill: new Fill({
          color: d3.color(areaColor).copy({ opacity: 0.15 }).formatRgb(),
        }),
        stroke: new Stroke({
          color: areaColor,
          width: 2.5,
        }),
      });

      const vectorLayer = new ColorLayer({
        name: "points ".concat(r),
        extent: EPSG3857,
        source: new VectorSource({
          data: {
            url: r,
            format: new GeoJSON(),
          },
          dataProjection: AOI_CRS,// Adjust CRS as needed for your shapefile
          style: customVectorLayerStyle,
        }),
      });
      vectorLayer.userData.zOrder = 2;

      // Add the vector layer to the provided minimap
      minimap.addLayer(vectorLayer);
      vectorLayers.push(vectorLayer);
    }

    return vectorLayers;
  } catch (error) {
    console.error('Error adding area extent layers to minimap:', error);
    return null;
  }
}

async function addTreeCentroidsLayer(minimap, layerName) {
  try {
    const { AOI_CONFIGS } = await import('./DataSources.js');
    const config = AOI_CONFIGS[AOI_KEY];
    const response = await fetch(config.treeCentroidsGeoJson);
    if (!response.ok) {
      throw new Error(`Failed to fetch GeoJSON: ${response.statusText}`);
    }

    const features = new GeoJSON().readFeatures(await response.json(), {
      dataProjection: AOI_CRS,
      featureProjection: "EPSG:3857",
    });

    // Style function is managed by MinimapRenderSettings
    const shapeFileLayerStyle = minimapRenderSettings.createStyleFunction();

    const shapefileSource = new VectorSource({
      data: features,
      style: shapeFileLayerStyle,
    });

    const shapefileLayer = new ColorLayer({
      name: layerName,
      extent: minimap.extent,
      source: shapefileSource
    });
    shapefileLayer.userData.zOrder = 3;

    minimap.addLayer(shapefileLayer);
    return { shapefileLayer, shapefileSource };
  } catch (error) {
    console.error('Error adding tree centroids layer to minimap:', error);
    return null;
  }
}

// Inspector.attach("inspector", instance);

// Load the runtime-served polish features (hidden background toggle + SVG
// export). Served from public/ as-is. Injected as a plain <script> (not
// import()) so Vite does NOT bundle it — the file stays editable/reloadable
// without rebuilding the bundle. Relative so it works under a Pages subpath.
(function loadPolishFeatures() {
  const s = document.createElement("script");
  s.src = "./polish-features.js";
  s.onerror = () => console.warn("[polish-features] failed to load");
  document.head.appendChild(s);
})();
