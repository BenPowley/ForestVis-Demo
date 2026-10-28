/*
 * Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
 * Licensed under the MIT License; see LICENSE.txt in the project root.
 * SPDX-License-Identifier: MIT
 */

/* HistogramBandsPanel class manages multiple HistogramBands instances for the Forest3D application.
   It handles initialization, resize observers, and coordination between NDVI and RGB histograms.
*/

import * as d3 from "d3";
import chroma from "chroma-js";
import { HistogramBands } from "./HistogramBands.js";

export class HistogramBandsPanel {
  constructor() {
    this.histogramBandsNDVI = null;
    this.histogramBandsRGB = null;
    this.resizeObserver = null;
    this.geoJsonData = null;
    this.metadata = null;
  }

  /**
   * Initialize histogram bands panel from configuration
  * @param {Object} config - Configuration object
  * @param {Object} config.aoiConfig - AOI configuration object (from DataSources.js AOI_CONFIGS)
  * @param {string} config.containerSelector - CSS selector for the container element for sizing
  * @param {string} config.geojsonPath - Path to GeoJSON file OR
  * @param {Object} config.geojsonData - Pre-loaded GeoJSON data object
  * @param {Function} config.onNDVIUpdate - Callback when NDVI histogram updates
  * @param {Function} config.onRGBUpdate - Callback when RGB histogram updates
  * @param {Function} config.onResize - Optional callback on resize
  * @returns {Promise<HistogramBandsPanel>} Initialized panel instance
   */
  static async initializeFromConfig(config) {
    try {
      
      const panel = new HistogramBandsPanel();
      
      // Load GeoJSON data if path provided, otherwise use provided data
      if (config.geojsonData) {
        panel.geoJsonData = config.geojsonData;
      } else if (config.geojsonPath) {
        const response = await fetch(config.geojsonPath);
        if (!response.ok) {
          throw new Error(`Failed to fetch GeoJSON: ${response.statusText}`);
        }
        panel.geoJsonData = await response.json();
      } else {
        throw new Error('No GeoJSON data provided or loaded');
      }
      
      // Load metadata with ranges
      if (!config.aoiConfig || !config.aoiConfig.treeCentroidsMetadata) {
        throw new Error('AOI config with treeCentroidsMetadata is required');
      }
      const metadataResponse = await fetch(config.aoiConfig.treeCentroidsMetadata);
      if (!metadataResponse.ok) {
        throw new Error(`Failed to fetch metadata: ${metadataResponse.statusText}`);
      }
      panel.metadata = await metadataResponse.json();
      
      // Get container dimensions
      const container = document.querySelector(config.containerSelector || '#details-panel');
      const measuredWidth = container ? container.offsetWidth : 0;
      const panelWidth = Math.max(300, measuredWidth);
      
      // Initialize NDVI histogram
      const ndviRanges = {
        'NDVI_1_min': panel.metadata.NDVI_1_min,
        'NDVI_1_max': panel.metadata.NDVI_1_max
      };
      
      panel.histogramBandsNDVI = HistogramBands.initialize({
        geoJsonLayer: panel.geoJsonData,
        attributes: config.ndviAttributes || ['NDVI_1'],
        ranges: ndviRanges,
        callback: (event) => {
          if (config.onNDVIUpdate) {
            config.onNDVIUpdate(event);
          }
        },
        parentSelector: config.ndviParentSelector || '#details-histogram-ndvi',
        width: panelWidth,
        height: config.ndviHeight || 190,
        margin: config.ndviMargin || { top: 10, right: 20, bottom: 60, left: 60 },
        colors: config.ndviColors || ['#1f77b4'],
        instanceZFilterUrl: Array.isArray(config.aoiConfig.instanceZFilter) ? config.aoiConfig.instanceZFilter : [config.aoiConfig.instanceZFilter],
        dataImageUrl: Array.isArray(config.aoiConfig.ndviSource) ? config.aoiConfig.ndviSource.map(s => s.url) : [config.aoiConfig.ndviSource.url],
        bandMapping: config.ndviBandMapping || { 'NDVI_1': 0 },
        projection: config.aoiConfig.ndviProjection || 'EPSG:3006',
        attributeLabels: config.ndviAttributeLabels || { 'NDVI_1': 'NDVI' },
        showBars: config.ndviShowBars !== undefined ? config.ndviShowBars : true
      });
      
      // Initialize RGB histogram
      const rgbRanges = {
        'RGB_1_min': panel.metadata.RGB_1_min,
        'RGB_1_max': panel.metadata.RGB_1_max,
        'RGB_2_min': panel.metadata.RGB_2_min,
        'RGB_2_max': panel.metadata.RGB_2_max,
        'RGB_3_min': panel.metadata.RGB_3_min,
        'RGB_3_max': panel.metadata.RGB_3_max
      };
      
      // Generate RGB colors if not provided
      let rgbColors = config.rgbColors;
      if (!rgbColors) {
        const scale = d3.scaleSequential(d3.interpolateTurbo).domain([0, 1.0]);
        rgbColors = [scale(0.8), scale(0.5), scale(0.2)].map(color => chroma(color).darken(1).hex());
      }
      
      panel.histogramBandsRGB = HistogramBands.initialize({
        geoJsonLayer: panel.geoJsonData,
        attributes: config.rgbAttributes || ['RGB_1', 'RGB_2', 'RGB_3'],
        ranges: rgbRanges,
        callback: (event) => {
          if (config.onRGBUpdate) {
            config.onRGBUpdate(event);
          }
        },
        parentSelector: config.rgbParentSelector || '#details-histogram-rgb',
        width: panelWidth,
        height: config.rgbHeight || 210,
        margin: config.rgbMargin || { top: 10, right: 20, bottom: 60, left: 60 },
        colors: rgbColors,
        instanceZFilterUrl: Array.isArray(config.aoiConfig.instanceZFilter) ? config.aoiConfig.instanceZFilter : [config.aoiConfig.instanceZFilter],
        dataImageUrl: Array.isArray(config.aoiConfig.aerialImage) ? config.aoiConfig.aerialImage.map(s => s.url) : [config.aoiConfig.aerialImage.url],
        bandMapping: config.rgbBandMapping || { 'RGB_1': 0, 'RGB_2': 1, 'RGB_3': 2 },
        projection: config.aoiConfig.ndviProjection || 'EPSG:3006',
        attributeLabels: config.rgbAttributeLabels || { 'RGB_1': 'Red', 'RGB_2': 'Green', 'RGB_3': 'Blue' },
        showBars: config.rgbShowBars !== undefined ? config.rgbShowBars : false
      });
      
      // Setup resize observer if container specified
      if (container) {
        panel.resizeObserver = new ResizeObserver(entries => {
          for (const entry of entries) {
            const width = entry.target.offsetWidth;
            const newWidth = Math.max(300, width - 40);
            
            if (panel.histogramBandsNDVI && panel.histogramBandsNDVI.width !== newWidth) {
              panel.histogramBandsNDVI.updateWidth(newWidth);
            }
            if (panel.histogramBandsRGB && panel.histogramBandsRGB.width !== newWidth) {
              panel.histogramBandsRGB.updateWidth(newWidth);
            }
            
            if (config.onResize) {
              config.onResize(newWidth);
            }
          }
        });
        
        panel.resizeObserver.observe(container);
      }
      
      return panel;
      
    } catch (error) {
      console.error('Failed to initialize HistogramBands Panel:', error);
      return null;
    }
  }
  
  /**
   * Redraw both histograms for a specific PredInstance
   * @param {number} predInstance - The PredInstance ID to draw
   */
  redraw(predInstance) {
    if (this.histogramBandsNDVI) {
      this.histogramBandsNDVI.redraw(predInstance);
    }
    if (this.histogramBandsRGB) {
      this.histogramBandsRGB.redraw(predInstance);
    }
  }
  
  /**
   * Draw empty axes on both histograms
   */
  drawEmptyAxes() {
    if (this.histogramBandsNDVI) {
      this.histogramBandsNDVI.drawEmptyAxes();
    }
    if (this.histogramBandsRGB) {
      this.histogramBandsRGB.drawEmptyAxes();
    }
  }
  
  /**
   * Update width of both histograms
   * @param {number} width - New width
   */
  updateWidth(width) {
    if (this.histogramBandsNDVI) {
      this.histogramBandsNDVI.updateWidth(width);
    }
    if (this.histogramBandsRGB) {
      this.histogramBandsRGB.updateWidth(width);
    }
  }
  
  /**
   * Get the NDVI histogram instance
   * @returns {HistogramBands} NDVI histogram instance
   */
  getNDVIHistogram() {
    return this.histogramBandsNDVI;
  }
  
  /**
   * Get the RGB histogram instance
   * @returns {HistogramBands} RGB histogram instance
   */
  getRGBHistogram() {
    return this.histogramBandsRGB;
  }
  
  /**
   * Destroy the panel and clean up resources
   */
  destroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    
    // HistogramBands instances don't have a destroy method,
    // but we can clear the references
    this.histogramBandsNDVI = null;
    this.histogramBandsRGB = null;
    this.geoJsonData = null;
    this.metadata = null;
  }
}
