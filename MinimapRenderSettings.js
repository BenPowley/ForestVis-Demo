/*
 * Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
 * Licensed under the MIT License; see LICENSE.txt in the project root.
 * SPDX-License-Identifier: MIT
 */

import { Color } from "three";
import chroma from 'chroma-js';
import { Fill, Stroke, Style, Circle as CircleStyle } from "ol/style.js";
import { fetchQGISColorCategorization } from "./Metadata.js";

/**
 * Manages the rendering (coloring / styling) of tree-centroid dots on the minimap.
 * • Map a pointcloud attribute name → minimap GeoJSON feature attribute using
 *   `minimapDefaultLayerMapping` from the AOI config.
 * • Produce a colour for a given feature value, supporting palette, gradient and
 *   qml colour-scales that are already defined in attributeConfig.json.
 */
export class MinimapRenderSettings {
  /**
   * @param {Object}   config
   * @param {Object}   config.attributeConfig  – parsed attributeConfig.json
   * @param {Object}   config.aoiConfig         – AOI entry from aoi-config*.json
   *                                              (contains minimapDefaultLayerMapping)
   * @param {Object}   config.state             – live state reference from index.js;
   *                                              use property getters so reads are always fresh
   */
  constructor({ attributeConfig, aoiConfig, state }) {
    this.attributeConfig = attributeConfig;
    this.aoiConfig = aoiConfig;
    this.state = state;

    /** Currently active GeoJSON feature attribute used for dot colouring */
    this.currentMinimapAttribute = 'AvgNDVI';
    this.styleCache = new Map();
    this._qmlColors = null;

    /**
     * Optional callback fired after a legend switch.
     */
    this.onLegendChange = null;
  }

  /**
   * Maps a pointcloud attribute name → the corresponding GeoJSON feature attribute
   * that should be used for minimap dot colouring.
   *
   * @param   {string} pointcloudAttribute
   * @returns {string} minimap attribute name
   */
  getMinimapAttribute(pointcloudAttribute) {
    const mapping = this.aoiConfig?.minimapDefaultLayerMapping;
    if (!mapping) return pointcloudAttribute;
    if (Object.prototype.hasOwnProperty.call(mapping, pointcloudAttribute)) {
      const mapped = mapping[pointcloudAttribute];
      // if mapped is the empty string, it means apply a default style with no coloring
      // (transparent circles with a grey stroke).
      return mapped ?? pointcloudAttribute;
    }
    return pointcloudAttribute;
  }

  /**
   * Returns an `rgba(…)` CSS string for `value` using a palette colourscale
   * (array of { index, rgb } bounds sorted by index ascending).
   *
   * @param {number}   value   – normalised or raw attribute value
   * @param {Array}    preset  – palette bounds array from attributeConfig
   * @returns {string}
   */
  getColorFromPreset(value, preset) {
    const clamped = Math.max(0, Math.min(1, value));
    for (let i = preset.length - 1; i >= 0; i--) {
      if (clamped >= preset[i].index) {
        const [r, g, b] = preset[i].rgb;
        return `rgba(${r}, ${g}, ${b}, 1)`;
      }
    }
    return 'grey';
  }

  /**
   * Resolves a CSS color string for `value` using the colourscale that is
   * configured for `minimapAttr` in attributeConfig.
   *
   * Falls back to the ndviPalette when no specific config is found.
   *
   * @param   {*}      value       – raw feature attribute value
   * @param   {string} minimapAttr – the minimap GeoJSON attribute name
   * @returns {string|null}        – CSS color string, or null for nodata/missing
   */
  getColorForValue(value, minimapAttr) {
    const nodata = this.state.nodata;
    if (value === nodata || value === undefined || value === null) return null;

    //handle truncation of predinstance variable name
    if (minimapAttr.startsWith("PredInstan")) {
      minimapAttr = "PredInstance";
    }

    const attrConfig  = this.attributeConfig?.attributes?.[minimapAttr];
    const fallback    = () => {
      const bounds = this.attributeConfig?.colorscales?.ndviPalette?.bounds;
      return bounds ? this.getColorFromPreset(value, bounds) : '#eeeeee';
    };

    if (!attrConfig) return fallback();

    const scale = this.attributeConfig?.colorscales?.[attrConfig.scale];
    if (!scale) return fallback();

    switch (scale.type) {
      case 'palette':
        return this.getColorFromPreset(value, scale.bounds);

      case 'gradient': {
        const min = attrConfig.colorMapMin ?? 0;
        const max = attrConfig.colorMapMax ?? 1;
        const t   = Math.max(0, Math.min(1, (value - min) / (max - min)));
        const [r, g, b] = chroma.scale(scale.palette)(t).rgb();
        return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, 1)`;
      }

      case 'qml': {
        if (this._qmlColors && this._qmlColors.length > 0) {
          const idx  = Math.round(Math.abs(value)) % this._qmlColors.length;
          const [r, g, b] = this._qmlColors[idx];
          return `rgba(${r}, ${g}, ${b}, 1)`;
        }
        return '#eeeeee';
      }

      default:
        return fallback();
    }
  }

  /**
   * Asynchronously loads QML colours (needed for the PredInstance colourscale).
   * Safe to call multiple times; colours are cached after the first load.
   *
   * @param {string} qmlUrl
   */
  async loadQmlColors(qmlUrl) {
    if (this._qmlColors) return;
    try {
      this._qmlColors = await fetchQGISColorCategorization(qmlUrl);
    } catch (e) {
      console.warn('[MinimapRenderSettings] Failed to load QML colours:', e);
    }
  }

  /**
   * Returns an OpenLayers style function `(feature) => Style` that can be passed
   * directly to a `VectorSource`.  The function reads live state through
   * `this.state` getters so filter / selection changes are always reflected.
   *
   * @returns {Function}
   */
  createStyleFunction() {
    return (feature) => this._computeStyle(feature);
  }

  /**
   * Clears the style cache, e.g. after a point-size or attribute change.
   */
  clearStyleCache() {
    this.styleCache.clear();
  }

  /** @private */
  _computeStyle(feature) {
    const {
      nodata,
      fSwitch,
      histogramSliderPanel,
      currentFilterAttribute,
      umapVisualizationPanel,
      invertRange,
      enabledAreas,
      minimapPointSizeValue,
      pointsCounter,
    } = this.state;

    // ── 1. Base colour from the current mapped attribute ──────────────────────
    let f = this.currentMinimapAttribute;
    if (f.startsWith("PredInstan")) {
      f = "PredInstan";
    }

    // Empty-string attribute → default style: transparent fill, grey stroke.
    const isDefaultStyle = (f === '');

    const attrValue  = feature.get(f);
    const colorStr   = isDefaultStyle ? null : this.getColorForValue(attrValue, f);
    let   color      = colorStr ? new Color(colorStr) : new Color('black');

    // ── 2. Override colour for highlight / UMAP selection ────────────────────
    const highlight    = feature.get('highlight');   // click-selected (red)
    const umapSelected = feature.get('umapSelected'); // UMAP-selected (blue)

    if (highlight) {
      color = new Color('red');
    } else if (umapSelected) {
      color = new Color('blue');
    }

    const stroke = (highlight || umapSelected)
      ? new Stroke({ color: 'white', width: 1 })
      : new Stroke({ color: 'black', width: 1 });

    // ── 3. Opacity: hidden areas collapse to 0 ────────────────────────────────
    let opacity    = 1;
    const areaNumber = feature.get('area_numbe');
    if (areaNumber !== undefined && enabledAreas[areaNumber] === false) {
      opacity = 0;
    }

    // ── 4. Opacity: apply histogram / UMAP filter dimming ────────────────────
    const lowOpacity = 0.2;
    if (fSwitch.isEnabled && opacity > 0) {
      if (fSwitch.mode === 'histogram' && histogramSliderPanel) {
        const filterValue = feature.get(currentFilterAttribute);
        const { fromValue, toValue } = histogramSliderPanel.getFilterRange();
        const checkInRange    = filterValue >= fromValue && filterValue <= toValue;
        const attrCfg         = this.attributeConfig?.attributes[currentFilterAttribute];
        const validMin        = attrCfg?.range?.min ?? -1;
        const validMax        = attrCfg?.range?.max ??  1;
        const checkValidRange = validMin <= filterValue && filterValue <= validMax;
        opacity = invertRange
          ? (checkValidRange && !checkInRange ? 1 : lowOpacity)
          : (checkInRange ? 1 : lowOpacity);
      } else if (
        fSwitch.mode === 'umap' &&
        typeof umapVisualizationPanel?.getSelectedPredInstanceIds === 'function'
      ) {
        const selectedIds = umapVisualizationPanel.getSelectedPredInstanceIds();
        const predInstan  = feature.get('PredInstan');
        if (selectedIds && selectedIds.length > 0) {
          opacity = selectedIds.includes(predInstan) ? 1 : lowOpacity;
        } else {
          opacity = 1;
        }
      }
    }

    // ── 5. z-index ────────────────────────────────────────────────────────────
    const zIndex = highlight ? 3 : umapSelected ? 2 : opacity === 1 ? 1 : 0;

    // ── 6. Cache lookup / creation ────────────────────────────────────────────
    const colorHex = `#${color.getHexString()}`;

    // For default style (no attribute), use transparent fill + grey stroke unless
    // the feature is explicitly highlighted or UMAP-selected.
    const useDefaultAppearance = isDefaultStyle && !highlight && !umapSelected;
    const fillColor   = useDefaultAppearance ? 'rgba(0,0,0,0)' : colorHex;
    const circleStroke = useDefaultAppearance
      ? new Stroke({ color: 'grey', width: 1 })
      : stroke;

    const cacheKey = `${useDefaultAppearance ? '__default' : colorHex}_${opacity}_${zIndex}`;

    if (this.styleCache.has(cacheKey)) {
      if (pointsCounter) {
        pointsCounter.active[feature.get('PredInstan')] = opacity === 1 ? 1 : 0;
      }
      return this.styleCache.get(cacheKey);
    }

    const circle = new CircleStyle({
      radius: parseFloat(minimapPointSizeValue),
      fill:   new Fill({ color: fillColor }),
      stroke: circleStroke,
    });
    circle.setOpacity(opacity);

    const style = new Style({ zIndex, image: circle });
    this.styleCache.set(cacheKey, style);

    if (pointsCounter) {
      pointsCounter.active[feature.get('PredInstan')] = opacity === 1 ? 1 : 0;
    }
    return style;
  }

  /**
   * Called when the user switches the pointcloud rendering attribute.
   * Re-maps to the correct minimap feature attribute, flushes the style cache,
   * pre-loads QML colours if necessary, redraws the legend, and notifies `onLegendChange`.
   *
   * @param   {string}  pointcloudAttribute – the attribute key chosen in the UI
   * @param   {string}  [colorMode]         – optional colour mode hint
   * @param   {string}  [legendContainerId] – id of the legend container (default: 'minimap-legend')
   * @returns {Promise<void>}
   */
  async switchMinimapLegend(pointcloudAttribute, colorMode, legendContainerId = 'minimap-legend') {
    let minimapAttr = this.getMinimapAttribute(pointcloudAttribute);
    //get label from attributeConfig if available, otherwise use the raw minimapAttr as fallback
    let label = minimapAttr;
    if (this.attributeConfig?.attributes?.[minimapAttr]?.label) {
      label = this.attributeConfig.attributes[minimapAttr].label;
    }
    // handle predinstance truncation
    if (minimapAttr.startsWith('PredInstan')) {
      minimapAttr = 'PredInstance';
      label = 'PredInstance';
    }
    // add the minimapped attribute label to theheading of the panel using a span element
    const heading = document.querySelector('#minimap-panel-heading');
    if (heading) {
      // try getting the span element if it already exists (from a previous switch), otherwise create a new one
      let span = heading.querySelector('span');
      if (!span) {
        span = document.createElement('span');
        heading.appendChild(span);
      }
      span.textContent = ` (${label})`;
      heading.appendChild(span);
    }
    this.currentMinimapAttribute = minimapAttr;
    this.styleCache.clear();

    // Pre-load QML colours so they are ready on first render
    const attrCfg = this.attributeConfig?.attributes?.[minimapAttr];
    const scale   = attrCfg ? this.attributeConfig?.colorscales?.[attrCfg.scale] : null;
    if (scale?.type === 'qml' && scale.file && !this._qmlColors) {
      await this.loadQmlColors(scale.file);
      this.styleCache.clear(); // flush again after async load
    }

    this.renderLegend(legendContainerId);

    if (typeof this.onLegendChange === 'function') {
      this.onLegendChange(minimapAttr, pointcloudAttribute, colorMode);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Legend rendering
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Renders the minimap legend for the currently active attribute.
   * Handles all colorscale types: palette (discrete), gradient (continuous),
   * qml (categorical) and the empty-string default style.
   *
   * Always appends the active-points counter at the bottom so it survives
   * re-renders.
   *
   * @param {string} containerId – id of the legend <div> (e.g. 'minimap-legend')
   */
  renderLegend(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '';

    const attr   = this.currentMinimapAttribute;
    const nodata = this.state.nodata;

    // ── Resolve scale config ─────────────────────────────────────────────────
    const attrKey  = attr.startsWith('PredInstan') ? 'PredInstance' : attr;
    const attrCfg  = this.attributeConfig?.attributes?.[attrKey];
    const scale    = attrCfg ? this.attributeConfig?.colorscales?.[attrCfg.scale] : null;
    // Determine effective scale type
    const scaleType = attr === '' ? 'default'
      : (scale?.type ?? 'fallback');

    // ── Shared helper: one circle + label entry ───────────────────────────────
    const buildEntry = (row, hexColor, text) => {
      const entry = document.createElement('div');
      entry.classList.add('minimap-legend-entry');
      const circle = document.createElement('div');
      circle.classList.add('minimap-legend-circle');
      circle.style.backgroundColor = hexColor;
      entry.appendChild(circle);
      const label = document.createElement('div');
      label.classList.add('minimap-legend-label');
      label.textContent = text;
      entry.appendChild(label);
      row.appendChild(entry);
    };

    // Alternative: build entry as a square (for unique instance ID mapping)
    const buildEntrySquare = (row, hexColor, text, indicies) => {
      const entry = document.createElement('div');
      entry.classList.add('minimap-legend-entry');
      const square = document.createElement('div');
      square.classList.add('minimap-legend-square');
      square.style.backgroundColor = hexColor;
      entry.appendChild(square);
      const label = document.createElement('div');
      label.classList.add('minimap-legend-label');
      // Fixed width for indices display
      label.style.display = 'inline-block';
      label.style.minWidth = '48px'; // enough for two 2-digit indices and comma
      label.style.textAlign = 'left';
      if (!indicies || indicies.length === 0) {
        label.textContent = text;
      }
      if (indicies && indicies.length > 1) {
        const displayIndices = indicies.slice(0, 2).map(i => i.toString().padStart(2, '0')).join(', ');
        label.textContent = `${displayIndices} `;
        if (indicies.length > 2) {
          const suffix = document.createElement('span');
          suffix.classList.add('minimap-legend-suffix');
          suffix.textContent = `(+${indicies.length - 2})`;
          label.appendChild(suffix);
          suffix.style.color = 'blue';
          suffix.style.cursor = 'pointer';
          suffix.addEventListener('mouseenter', () => {
            label.title = `Indices: ${indicies.join(', ')}`;
          });
          suffix.addEventListener('mouseleave', () => {
            label.title = '';
          });
        }
      }
      entry.appendChild(label);
      row.appendChild(entry);
    };

    const items = document.createElement('div');
    items.classList.add('minimap-legend-items');
    container.appendChild(items);

    // ── Render by scale type ─────────────────────────────────────────────────
    if (scaleType === 'default') {
      // Transparent circles – no coloring
      const msg = document.createElement('div');
      msg.classList.add('minimap-legend-description');
      msg.textContent = 'No minimap single-instance coloring, 3D pointcloud data only';
      items.appendChild(msg);

    } else if (scaleType === 'palette' || scaleType === 'fallback') {
      // Discrete palette: equal-width circles with tick + boundary labels below
      const bounds = scale?.bounds
        ?? this.attributeConfig?.colorscales?.ndviPalette?.bounds
        ?? [];

      // Build unique categories (merge consecutive same-hex bounds)
      const categories = [];
      let i = 0;
      while (i < bounds.length) {
        const startHex = bounds[i].hex;
        const lower    = bounds[i].index;
        let j = i + 1;
        while (j < bounds.length && bounds[j].hex === startHex) j++;
        const upper = j < bounds.length ? bounds[j].index : 1.0;
        categories.push({ hex: startHex, lower, upper });
        i = j;
      }
      const N = categories.length;

      const wrapper = document.createElement('div');
      wrapper.classList.add('minimap-legend-palette-wrapper');

      // ── Circles row: one equal-size slot per category ──────────────────────
      const circlesRow = document.createElement('div');
      circlesRow.classList.add('minimap-legend-palette-circles');
      categories.forEach(cat => {
        const slot = document.createElement('div');
        slot.classList.add('minimap-legend-palette-slot');
        const rect = document.createElement('div');
        rect.classList.add('minimap-legend-rect');
        rect.style.backgroundColor = cat.hex;
        slot.appendChild(rect);
        circlesRow.appendChild(slot);
      });
      wrapper.appendChild(circlesRow);

      // ── Tick + label row: N+1 ticks at left edge of each slot + right edge ─
      // Tick values: lower of each category, then upper of the last one
      const tickValues = categories.map(c => c.lower);
      tickValues.push(categories[N - 1].upper);

      const ticksRow = document.createElement('div');
      ticksRow.classList.add('minimap-legend-palette-ticks');
      tickValues.forEach((val, ti) => {
        const tick = document.createElement('div');
        tick.classList.add('minimap-legend-palette-tick');
        tick.style.left = `${(ti / N) * 100}%`;
        const mark = document.createElement('div');
        mark.classList.add('minimap-legend-palette-tick-mark');
        const lbl  = document.createElement('div');
        lbl.classList.add('minimap-legend-palette-tick-label');
        lbl.textContent = val.toFixed(2);
        tick.appendChild(mark);
        tick.appendChild(lbl);
        ticksRow.appendChild(tick);
      });
      wrapper.appendChild(ticksRow);
      items.appendChild(wrapper);

      if (nodata !== undefined && nodata !== null) {
        const nodataRow = document.createElement('div');
        nodataRow.classList.add('minimap-legend-circles-row');
        nodataRow.style.marginTop = '6px';
        buildEntry(nodataRow, '#000000', 'No data');
        items.appendChild(nodataRow);
      }

    } else if (scaleType === 'gradient') {
      // Continuous gradient: 256-stop CSS linear-gradient bar
      const min     = attrCfg?.colorMapMin ?? 0;
      const max     = attrCfg?.colorMapMax ?? 1;
      const N       = 256;
      const palette = scale.palette;

      const stops = [];
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        stops.push(`${chroma.scale(palette)(t).hex()} ${(t * 100).toFixed(1)}%`);
      }

      const barWrapper = document.createElement('div');
      barWrapper.classList.add('minimap-legend-gradient-wrapper');

      const bar = document.createElement('div');
      bar.classList.add('minimap-legend-gradient-bar');
      bar.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
      barWrapper.appendChild(bar);

      const labelsRow = document.createElement('div');
      labelsRow.classList.add('minimap-legend-gradient-labels');
      const leftLbl = document.createElement('span');
      leftLbl.textContent = min.toFixed(2);
      const rightLbl = document.createElement('span');
      rightLbl.textContent = max.toFixed(2);
      labelsRow.appendChild(leftLbl);
      labelsRow.appendChild(rightLbl);
      barWrapper.appendChild(labelsRow);

      items.appendChild(barWrapper);

      if (nodata !== undefined && nodata !== null) {
        const row = document.createElement('div');
        row.classList.add('minimap-legend-circles-row');
        row.style.marginTop = '4px';
        buildEntry(row, '#000000', 'No data');
        items.appendChild(row);
      }

    } else if (scaleType === 'qml') {
      // Special handling for PredInstan: show unique colors as squares with a custom title
      if (attrKey === 'PredInstance') {
        const colors = this._qmlColors;
        if (!colors || colors.length === 0) {
          const msg = document.createElement('div');
          msg.classList.add('minimap-legend-description');
          msg.textContent = 'Loading colors…';
          items.appendChild(msg);
        } else {
          // --- Legend mode state (persisted on the container for toggling) ---
          let legendMode = container._predInstanceLegendMode || 'instance-grid';
          // UI: Title and toggle buttons
          const titleRow = document.createElement('div');
          titleRow.classList.add('minimap-legend-description');
          titleRow.style.display = 'flex';
          titleRow.style.alignItems = 'center';
          // Title text
          const titleText = document.createElement('span');
          titleText.textContent = 'Instance ID mapping from palette';
          titleRow.appendChild(titleText);
          // Toggle buttons
          const sep = document.createElement('span'); sep.textContent = ' . '; sep.style.margin = '0 6px';
          const btnColor = document.createElement('span');
          btnColor.textContent = 'color';
          btnColor.style.cursor = 'pointer';
          btnColor.style.color = legendMode === 'color-grouped' ? 'lightblue' : 'blue';
          btnColor.style.marginLeft = '8px';
          const btnGrid = document.createElement('span');
          btnGrid.textContent = 'instance';
          btnGrid.style.cursor = 'pointer';
          btnGrid.style.color = legendMode === 'instance-grid' ? 'lightblue' : 'blue';
          btnGrid.style.marginLeft = '8px';
          titleRow.appendChild(btnColor);
          titleRow.appendChild(sep);
          titleRow.appendChild(btnGrid);
          items.appendChild(titleRow);

          // --- Render legend content based on mode ---
          const renderColorGrouped = () => {
            // Find unique colors (as string), looping over colors up to pc.all
            const pc = this.state.pointsCounter;
            const totalInstances = pc?.all ?? colors.length;
            const uniqueColorMap = new Map();
            for (let idx = 0; idx < totalInstances; idx++) {
              const colorIdx = idx % colors.length;
              const [r, g, b] = colors[colorIdx];
              const key = `${r},${g},${b}`;
              if (!uniqueColorMap.has(key)) {
                uniqueColorMap.set(key, [idx]);
              } else {
                uniqueColorMap.get(key).push(idx);
              }
            }
            const uniqueColors = Array.from(uniqueColorMap.entries());
            const row = document.createElement('div');
            row.classList.add('minimap-legend-squares-row');
            row.style.flexWrap = 'wrap';
            items.appendChild(row);
            uniqueColors.forEach(([rgb, idx]) => {
              buildEntrySquare(row, `rgb(${rgb})`, String(idx), uniqueColorMap.get(rgb));
            });
            if (nodata !== undefined && nodata !== null) {
              buildEntrySquare(row, '#000000', 'No data', []);
            }
          };

          const renderInstanceGrid = () => {
            // Show each instance in order, 5 columns, scroll after 4 rows, looping colors as needed
            const pc = this.state.pointsCounter;
            const totalInstances = pc?.all ?? colors.length;
            const grid = document.createElement('div');
            grid.classList.add('minimap-legend-instance-grid');
            grid.style.display = 'grid';
            grid.style.gridTemplateColumns = 'repeat(5, 1fr)';
            grid.style.gap = '4px';
            grid.style.maxHeight = 'calc(4 * 48px)'; // 4 rows, each ~48px tall (room for label)
            grid.style.overflowY = 'auto';
            grid.style.marginTop = '6px';
            items.appendChild(grid);
            for (let idx = 0; idx < totalInstances; idx++) {
              const colorIdx = idx % colors.length;
              const [r, g, b] = colors[colorIdx];
              // Each cell: color square on top, index label below
              const cell = document.createElement('div');
              cell.style.display = 'flex';
              cell.style.flexDirection = 'column';
              cell.style.alignItems = 'center';
              cell.style.justifyContent = 'flex-start';
              // Color square
              const square = document.createElement('div');
              square.classList.add('minimap-legend-square');
              square.style.backgroundColor = `rgb(${r},${g},${b})`;
              cell.appendChild(square);
              // Index label
              const label = document.createElement('div');
              label.classList.add('minimap-legend-label');
              label.style.fontSize = '11px';
              label.style.marginTop = '2px';
              label.textContent = idx.toString();
              cell.appendChild(label);
              grid.appendChild(cell);
            }
            if (nodata !== undefined && nodata !== null) {
              const cell = document.createElement('div');
              cell.style.display = 'flex';
              cell.style.flexDirection = 'column';
              cell.style.alignItems = 'center';
              cell.style.justifyContent = 'flex-start';
              const square = document.createElement('div');
              square.classList.add('minimap-legend-square');
              square.style.backgroundColor = '#000000';
              cell.appendChild(square);
              const label = document.createElement('div');
              label.classList.add('minimap-legend-label');
              label.style.fontSize = '11px';
              label.style.marginTop = '2px';
              label.textContent = 'No data';
              cell.appendChild(label);
              grid.appendChild(cell);
            }
          };

          // Initial render
          if (legendMode === 'color-grouped') {
            renderColorGrouped();
          } else {
            renderInstanceGrid();
          }

          // Toggle handlers
          btnColor.onclick = () => {
            if (container._predInstanceLegendMode !== 'color-grouped') {
              container._predInstanceLegendMode = 'color-grouped';
              this.renderLegend(containerId);
            }
          };
          btnGrid.onclick = () => {
            if (container._predInstanceLegendMode !== 'instance-grid') {
              container._predInstanceLegendMode = 'instance-grid';
              this.renderLegend(containerId);
            }
          };
        }
      } else {
        // Categorical: show up to 20 swatches from the loaded QML palette
        const colors = this._qmlColors;
        if (!colors || colors.length === 0) {
          const msg = document.createElement('div');
          msg.classList.add('minimap-legend-description');
          msg.textContent = 'Loading colors…';
          items.appendChild(msg);
        } else {
          const MAX_SWATCHES = 20;
          const row = document.createElement('div');
          row.classList.add('minimap-legend-circles-row');
          row.style.flexWrap = 'wrap';
          items.appendChild(row);
          colors.slice(0, MAX_SWATCHES).forEach(([r, g, b], idx) => {
            buildEntry(row, `rgb(${r},${g},${b})`, String(idx));
          });
          if (colors.length > MAX_SWATCHES) {
            const more = document.createElement('div');
            more.classList.add('minimap-legend-label');
            more.style.alignSelf = 'center';
            more.textContent = `+${colors.length - MAX_SWATCHES} more`;
            row.appendChild(more);
          }
          if (nodata !== undefined && nodata !== null) {
            buildEntry(row, '#000000', 'No data');
          }
        }
      }
    }

    // ── Points counter (always rendered) ─────────────────────────────────────
    const counterContainer = document.createElement('div');
    counterContainer.classList.add('minimap-legend-counter');
    const counterDesc = document.createElement('span');
    counterDesc.textContent = 'Active points: ';
    const counter = document.createElement('span');
    counter.id = 'points-counter';
    const pc = this.state.pointsCounter;
    counter.textContent = `0 / ${pc?.all ?? 0}`;
    counterContainer.appendChild(counterDesc);
    counterContainer.appendChild(counter);
    container.appendChild(counterContainer);
  }
}
