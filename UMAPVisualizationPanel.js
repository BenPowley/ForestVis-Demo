/*
 * Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
 * Licensed under the MIT License; see LICENSE.txt in the project root.
 * SPDX-License-Identifier: MIT
 */

/* UMAPVisualizationPanel class integrates the UMAP visualization into the Forest3D application.
   It manages the panel UI, data loading, and interaction with the UMAPVisualization component.
*/

import * as d3 from "d3";
import { VerticalBarsPanel } from './VerticalBarsPanel.js';
import { getRegionStatisticsGeoJson } from './DataSources.js';
import { computeUMAP } from './umapLocal.js';

export class UMAPVisualizationPanel {
  constructor() {
    this.umapViz = null;
    this.data = null;
    this.metadata = null;
    this.parentSelector = null;
    this.width = 0;
    this.height = 0;
    this.containerWidth = 0;
    this.containerHeight = 0;
    this.colorByAttribute = 'Height';
    this.pointRadius = 4;
    this.pointOpacity = 0.6;
    this.nodataValue = -9999.0;
    this.geojsonData = null; // Store original geojson data
    this.availableAttributes = []; // All available attributes from geojson
    this.areaGeojson = null; // Store region statistics geojson
  }
  /**
   * Helper to group selection by area using areaGeojson
   * @param {Array<Object>} selection - Array of selected points
   * @returns {Object} Dictionary: { [area_numbe_mean]: { means: {...} }, selection: { means: {...} } }
   */
  _groupSelectionByArea(selection) {
    if (selection.length === 0) {
      //take everything as a selection
      selection = this.data || [];
    }
    if (!this.areaGeojson || !Array.isArray(selection)) return { selection: { means: this._calculateMeans(selection) } };
    
    const grouped = {};
    const attrs = this.availableAttributes || [];
    
    // For each area in areaGeojson, use pre-calculated means from region_statistics
    for (const feature of (this.areaGeojson.features || [])) {
      const areaNum = feature.properties?.area_numbe_mean;
      if (areaNum !== undefined) {
        const means = {};
        // Extract mean values for attributes (e.g., AvgNDVI -> AvgNDVI_mean)
        for (const attr of attrs) {
          const meanKey = `${attr}_mean`;
          if (feature.properties[meanKey] !== undefined) {
            means[attr] = feature.properties[meanKey];
          }
        }
        grouped[areaNum] = { means };
      }
    }
    
    // Calculate means for the full selection
    grouped.selection = { means: this._calculateMeans(selection) };
    
    return grouped;
  }

  /**
   * Calculate means for a selection of points
   * @param {Array<Object>} selection - Array of points
   * @returns {Object} Dictionary of attribute means
   */
  _calculateMeans(selection) {
    if (!Array.isArray(selection) || selection.length === 0) return {};
    
    const attrs = this.availableAttributes || [];
    const means = {};
    for (const attr of attrs) {
      const vals = selection.map(d => parseFloat(d[attr])).filter(v => !isNaN(v));
      means[attr] = vals.length ? d3.mean(vals) : 0;
    }
    return means;
  }

  /**
   * Initialize UMAP visualization from configuration with auto-sizing and callbacks
   * @param {Object} config - Configuration object
   * @param {string} config.containerSelector - CSS selector for the container element
   * @param {string} config.parentSelector - CSS selector for the UMAP visualization parent
   * @param {string} config.geojsonPath - Path to GeoJSON file OR
   * @param {Object} config.geojsonData - Pre-loaded GeoJSON data object
   * @param {string} config.metadataPath - Path to metadata JSON file
   * @param {string} config.colorBy - Initial attribute to color points by
   * @param {number} config.pointRadius - Radius of points
   * @param {number} config.pointOpacity - Opacity of points
   * @param {Function} config.onSelectionChange - Callback when selection changes
   * @param {Function} config.onResize - Optional callback on resize
   * @returns {Promise<UMAPVisualizationPanel>} Initialized panel instance
   */
  static async initializeFromConfig(config) {
    try {
      

      // Load GeoJSON data if path provided, otherwise use provided data
      let geojsonData = config.geojsonData;
      if (!geojsonData && config.geojsonPath) {
        const response = await fetch(config.geojsonPath);
        if (!response.ok) {
          throw new Error(`Failed to fetch GeoJSON: ${response.statusText}`);
        }
        geojsonData = await response.json();
      }

      if (!geojsonData) {
        throw new Error('No GeoJSON data provided or loaded');
      }

      // Load areaGeojson using getRegionStatisticsGeoJson if not provided
      let areaGeojson = config.areaGeojson;
      if (!areaGeojson) {
        try {
          areaGeojson = await getRegionStatisticsGeoJson(config.aoiKey);
        } catch (e) {
          console.warn('Could not load region statistics geojson:', e);
        }
      }
      
      // Load UMAP metadata to get nodata value
      let nodataValue = -9999.0;
      if (config.metadataPath) {
        try {
          const metadataResponse = await fetch(config.metadataPath);
          if (metadataResponse.ok) {
            const umapMetadata = await metadataResponse.json();
            nodataValue = umapMetadata.umap_parameters?.nodata_value ?? -9999.0;
          }
        } catch (metadataError) {
          console.warn('Could not load metadata, using default nodata value:', metadataError);
        }
      }
      
      // Get container dimensions
      const container = document.querySelector(config.containerSelector || '#umap-panel');
      const measuredWidth = container ? container.offsetWidth : 700;
      // Floor lowered 400->320 so the UMAP scatter fits inside the panel without
      // forcing a horizontal scrollbar in the narrower polished layout.
      const panelWidth = Math.max(320, measuredWidth - 40);
      
      // Initialize the panel
      const panel = await UMAPVisualizationPanel.initialize({
        parentSelector: config.parentSelector || '#umap-container',
        geojsonData: geojsonData,
        areaGeojson: areaGeojson,
        colorBy: config.colorBy || 'Height',
        width: panelWidth,
        height: config.height || 400,
        pointRadius: config.pointRadius || 4,
        pointOpacity: config.pointOpacity || 0.6,
        nodataValue: nodataValue,
        metadataPath: config.metadataPath,
        onSelectionChange: config.onSelectionChange
      });

      // Setup UMAP filter switch listener as part of initialization
      if (config.fSwitch && config.updateFilter && config.resetFilter) {
        panel.setupFilterSwitch({
          fSwitch: config.fSwitch,
          updateFilter: config.updateFilter,
          resetFilter: config.resetFilter
        });
      }
      
      // Setup resize observer if container specified
      if (container && panel) {
        let resizeTimeout;
        let isResizing = false;
        let lastWidth = 0;
        
        const resizeObserver = new ResizeObserver(entries => {
          if (isResizing) return;
          
          if (resizeTimeout) {
            clearTimeout(resizeTimeout);
          }
          
          resizeTimeout = setTimeout(() => {
            for (const entry of entries) {
              const width = entry.target.offsetWidth;
              const newWidth = Math.max(400, width - 40);
              
              // Only update if width changed significantly
              if (Math.abs(lastWidth - newWidth) > 10) {
                isResizing = true;
                lastWidth = newWidth;
                
                if (panel) {
                  panel.updateSize(newWidth, config.height || 400);
                  if (config.onResize) {
                    config.onResize(newWidth, config.height || 400);
                  }
                }
                
                // Reset flag after a short delay
                setTimeout(() => {
                  isResizing = false;
                }, 100);
              }
            }
          }, 50);
        });
        
        resizeObserver.observe(container);
        panel.resizeObserver = resizeObserver;
      }
      
      return panel;
      
    } catch (error) {
      console.error('Failed to initialize UMAP Visualization from config:', error);
      return null;
    }
  }

  /**
   * Initialize the UMAP visualization panel
   * @param {Object} config - Configuration object
   * @param {string} config.parentSelector - CSS selector for the parent container
   * @param {Object} config.geojsonData - GeoJSON data object with UMAP coordinates
   * @param {string} config.colorBy - Initial attribute to color points by
   * @param {number} config.width - Width of the visualization
   * @param {number} config.height - Height of the visualization
   * @param {number} config.pointRadius - Radius of points
   * @param {number} config.pointOpacity - Opacity of points
   * @param {Function} config.onPointClick - Callback for point click events
   * @param {Function} config.onSelectionChange - Callback for selection change events
   */
  static async initialize(config) {
    const panel = new UMAPVisualizationPanel();

    panel.parentSelector = config.parentSelector || '#umap-container';
    panel.containerWidth = config.width || 700;
    panel.containerHeight = config.height || 500;
    panel.width = panel.containerWidth;
    panel.height = panel.containerHeight;
    panel.colorByAttribute = config.colorBy || 'Height';
    panel.pointRadius = config.pointRadius || 4;
    panel.pointOpacity = config.pointOpacity || 0.6;
    panel.nodataValue = config.nodataValue || -9999.0;
    panel.areaGeojson = config.areaGeojson || null;

    try {
      // Use provided GeoJSON data
      if (!config.geojsonData) {
        throw new Error('No GeoJSON data provided to UMAPVisualizationPanel');
      }
      const geojson = config.geojsonData;

      // Load metadata for UMAP features
      const metadataPath = config.metadataPath || './layer/tree_centroids_umap_metadata.json';
      try {
        const metadataResponse = await fetch(metadataPath);
        if (metadataResponse.ok) {
          panel.metadata = await metadataResponse.json();
        } else {
          console.warn('Could not load UMAP metadata, using default attributes');
        }
      } catch (metadataError) {
        console.warn('Error loading UMAP metadata:', metadataError);
      }

      // Store the original geojson data; regenerated UMAPs always start from
      // baseGeojson so trees dropped for nodata in one run come back in the next.
      panel.geojsonData = geojson;
      panel.baseGeojson = geojson;
      
      // Extract available attributes from the first feature
      if (geojson.features && geojson.features.length > 0) {
        const firstFeature = geojson.features[0].properties;
        panel.availableAttributes = Object.keys(firstFeature).filter(key => 
          !key.startsWith('UMAP_') && // Exclude UMAP coordinates
          typeof firstFeature[key] === 'number' && // Only numeric attributes
          key !== 'PredInstan' && // Exclude ID fields
          key !== 'area_numbe' // Exclude area number
        );
      }
      
      // Extract features with UMAP coordinates
      panel.data = geojson.features.map(feature => {
        const props = feature.properties;
        return {
          umap_1: props.UMAP_1,
          umap_2: props.UMAP_2,
          ...props
        };
      });

      // Filter out any entries without UMAP coordinates
      panel.data = panel.data.filter(d => 
        d.umap_1 !== undefined && 
        d.umap_2 !== undefined &&
        !isNaN(d.umap_1) &&
        !isNaN(d.umap_2)
      );


      // Ensure d3 is available globally (required by UMAPVisualization.js)
      if (typeof window.d3 === 'undefined') {
        // d3 is imported as a module in index.js, make it available globally
        window.d3 = d3;
      }

      // Load UMAPVisualization script if not already loaded
      if (typeof UMAPVisualization === 'undefined') {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = './tree-2D-DR/UMAPVisualization.js';
          script.onload = resolve;
          script.onerror = () => reject(new Error('Failed to load UMAPVisualization.js'));
          document.head.appendChild(script);
        });
      }
      
      // Create container element if it doesn't exist
      const container = d3.select(panel.parentSelector);
      if (container.empty()) {
        console.error('UMAP container not found:', panel.parentSelector);
        return null;
      }

      container.html('');

      const containerId = 'umap-viz-container';
      container.append('div')
        .attr('id', containerId)
        .style('width', '100%')
        .style('height', '100%')
        .style('overflow', 'auto');

      const modeStateId = 'umap-mode-state';
      container.append('input')
        .attr('type', 'hidden')
        .attr('id', modeStateId)
        .attr('value', 'pan'); // Default to pan mode

      const handleSelectionChange = (selectedPoints) => {
        const event = new CustomEvent('umap-selection-change', {
          bubbles: true
        });
        document.dispatchEvent(event);
        //calculate means for selected points and update bars
        
        if (this.horizontalBarsPanel) {
          this.horizontalBarsPanel.updateBars(selectedPoints);
        }
        if (config.onSelectionChange) {
          config.onSelectionChange(selectedPoints);
        }
      };
      
      panel.umapViz = new UMAPVisualization(containerId, {
        width: panel.width,
        height: panel.height,
        colorBy: panel.colorByAttribute,
        pointRadius: panel.pointRadius,
        pointOpacity: panel.pointOpacity,
        nodataValue: panel.nodataValue,
        modeStateId: modeStateId, // Pass the mode state element ID
        onSelectionChange: handleSelectionChange
      });

      await panel.umapViz.render(panel.data);
      panel.createControls(config.onPointClick);
      panel.createSettingsPanel();

      return panel;

    } catch (error) {
      console.error('Error initializing UMAP visualization:', error);
      return null;
    }
  }

  /**
   * Create control UI elements for the UMAP visualization
   */
  createControls(onPointClick) {
    const container = d3.select(this.parentSelector);

    // Create umap-controls as a flex column (upper/lower panels)
    const controlsDiv = container.insert('div', ':first-child')
      .attr('class', 'umap-controls mb-3 d-flex flex-column')
      .style('padding', '10px')
      .style('background-color', '#f8f9fa')
      .style('border-radius', '4px')
      .style('gap', '9px');

    // Centroid count text at top
    controlsDiv.append('p')
      .attr('class', 'text-muted mb-2')
      .style('font-size', '11px')
      .style('margin-bottom', '8px')
      .text(`Displaying ${this.data.length} tree centroids in UMAP space`);

    // Prepare attributes list
    let attributes = ['Height', 'AvgNDVI', 'AvgGNDVI', 'AvgLCI', 'AvgNDRE', 'AvgOSAVI'];
    if (this.metadata && this.metadata.umap_input_features) {
      attributes = ['Height', ...this.metadata.umap_input_features];
      if (attributes.includes('MedianGNDVI')) {
        attributes = attributes.map(attr => attr === 'MedianGNDVI' ? 'MedianGNDV' : attr);
      }
      if (attributes.includes('MedianOSAVI')) {
        attributes = attributes.map(attr => attr === 'MedianOSAVI' ? 'MedianOSAV' : attr);
      }
    }

    // Indices filter buttons (collapsible, hidden when settings shown)
    const filterRow = controlsDiv.append('div')
      .attr('class', 'collapse show')
      .attr('id', 'umap-indices-filter-row');
    
    const filterRowContent = filterRow.append('div')
      .attr('class', 'd-flex flex-wrap')
      .style('gap', '0.35em')
      .attr('role', 'group')
      .attr('aria-label', 'Indices Filter');
    
    const filterOptions = [
      { label: 'All', prefix: null },
      { label: 'Max', prefix: 'Max' },
      { label: 'Min', prefix: 'Min' },
      { label: 'Avg', prefix: 'Avg' },
      { label: 'Median', prefix: 'Median' },
      { label: 'Q25', prefix: 'Q25' },
      { label: 'Q75', prefix: 'Q75' },
      { label: 'Std', prefix: 'Std' }
    ];
    filterOptions.forEach(opt => {
      filterRowContent.append('button')
        .attr('type', 'button')
        .attr('class', 'btn btn-outline-secondary btn-sm umap-indices-filter-btn')
        .attr('data-prefix', opt.prefix === null ? '' : opt.prefix)
        .classed('active', opt.label === 'All')
        .text(opt.label);
    });

    const lowerPanel = controlsDiv.append('div')
      .attr('class', 'collapse show')
      .attr('id', 'umap-bars-section');

    // Area legend shared by the Indices and Pointcloud bar charts, spanning both columns
    lowerPanel.append('div')
      .attr('id', 'umap-bars-legend')
      .attr('class', 'px-2')
      .style('display', 'flex')
      .style('flex-wrap', 'wrap')
      .style('gap', '4px 14px')
      .style('margin-bottom', '9px') // matches the controls box's 9px gap above, so buttons/legend/titles are evenly spaced
      .style('font-size', '12px');

    const barsRow = lowerPanel.append('div')
      .attr('class', 'd-flex flex-row flex-wrap g-2 px-2')
      .style('gap', '18px');

    const indicesCol = barsRow.append('div')
      .attr('class', 'd-flex flex-column')
      .style('flex', '1 1 0')
      .style('max-width', '75%');
    indicesCol.append('h6')
      .attr('class', 'mb-2')
      .style('font-size', '0.9rem')
      .text('Indices');
    indicesCol.append('div')
      .attr('id', 'umap-indices-bars-panel')
      .style('max-height', '250px')
      .style('overflow-y', 'auto');

    const pointcloudCol = barsRow.append('div')
      .attr('class', 'd-flex flex-column')
      .style('flex', '1 1 0')
      .style('min-width', '40px');
    pointcloudCol.append('h6')
      .attr('class', 'mb-2')
      .style('font-size', '0.9rem')
      .text('Pointcloud');
    pointcloudCol.append('div')
      .attr('id', 'umap-pointcloud-bars-panel');

    // Bottom panel: Color By and Point Size controls (always visible, below bars)
    const bottomPanel = controlsDiv.append('div')
      .attr('class', 'mt-1')
      .attr('id', 'umap-bottom-controls')
      .style('display', 'flex')
      .style('flex-direction', 'row')
      .style('gap', '18px')
      .style('align-items', 'flex-start');

    // Color By selector
    const colorByCol = bottomPanel.append('div')
      .attr('class', 'col-auto');
    colorByCol.append('h6')
      .attr('class', 'mb-2')
      .style('font-size', '0.9rem')
      .text('Color By');
    const colorByDiv = colorByCol.append('div')
      .attr('id', 'umap-colorby-list');
    colorByDiv.append('label')
      .attr('for', 'umapColorBySelect')
      .attr('class', 'form-label visually-hidden') // the "Color By" heading already names it
      .style('font-size', '12px')
      .text('Attribute:');
    const colorSelect = colorByDiv.append('select')
      .attr('id', 'umapColorBySelect')
      .attr('class', 'form-select form-select-sm');

    attributes.forEach(attr => {
      colorSelect.append('option')
        .attr('value', attr)
        .property('selected', attr === this.colorByAttribute)
        .text(attr);
    });

    const self = this;
    colorSelect.on('change', function() {
      const selectedAttr = this.value;
      self.colorByAttribute = selectedAttr;
      if (self.umapViz) {
        self.umapViz.updateColorAttribute(selectedAttr);
      }
    });

    // Point Size slider
    const pointSizeCol = bottomPanel.append('div')
      .attr('class', 'col-auto');
    pointSizeCol.append('h6')
      .attr('class', 'mb-2')
      .style('font-size', '0.9rem')
      .text('Point Size');
    const sizeDiv = pointSizeCol.append('div')
      .attr('id', 'umap-pointsize-list');
    sizeDiv.append('label')
      .attr('for', 'umapPointSizeSlider')
      .attr('class', 'form-label visually-hidden') // the "Point Size" heading already names it
      .style('font-size', '12px')
      .text('Size:');
    const sliderContainer = sizeDiv.append('div')
      .attr('class', 'd-flex align-items-center');
    const sizeSlider = sliderContainer.append('input')
      .attr('type', 'range')
      .attr('id', 'umapPointSizeSlider')
      .attr('class', 'form-range me-2')
      .attr('min', '2')
      .attr('max', '10')
      .attr('step', '0.5')
      .attr('value', this.pointRadius);
    const sizeValue = sliderContainer.append('span')
      .attr('id', 'umapPointSizeValue')
      .attr('class', 'badge bg-secondary')
      .text(this.pointRadius);
    sizeSlider.on('input', function() {
      const size = parseFloat(this.value);
      self.pointRadius = size;
      sizeValue.text(size.toFixed(1));
      if (self.umapViz) {
        self.umapViz.updatePointSize(size);
      }
    });

    this._initVerticalBarsPanels(attributes);
  }

  /**
   * Initialize the horizontal bars panel and set up selection update
   */
  _initVerticalBarsPanels(attributes) {
    // Separate attributes
    const pointcloudAttrs = ['Height'];
    const allIndicesAttrs = attributes.filter(attr => attr !== 'Height');
    let indicesAttrs = allIndicesAttrs.slice();

    const indicesBarSpacing = 32;
    const pointcloudBarSpacing = 11;
    this.pointcloudBarsPanel = new VerticalBarsPanel('#umap-pointcloud-bars-panel', pointcloudAttrs, pointcloudBarSpacing, false);
    this.indicesBarsPanel = new VerticalBarsPanel('#umap-indices-bars-panel', indicesAttrs, indicesBarSpacing, true, '#umap-bars-legend');
    const pcData = this.areaGeojson ? this._groupSelectionByArea(this.data) : this.data;
    this.pointcloudBarsPanel.updateBars(pcData);
    const idxData = this.areaGeojson ? this._groupSelectionByArea(this.data) : this.data;
    this.indicesBarsPanel.updateBars(idxData);

    const filterBtns = d3.select('.umap-controls').selectAll('.umap-indices-filter-btn');
    const self = this;
    filterBtns.on('click', function() {
      filterBtns.classed('active', false);
      d3.select(this).classed('active', true);
      const prefix = d3.select(this).attr('data-prefix');
      let filteredAttrs;
      if (!prefix) {
        filteredAttrs = allIndicesAttrs;
      } else {
        filteredAttrs = allIndicesAttrs.filter(attr => attr.toLowerCase().startsWith(prefix.toLowerCase()));
      }
      self.indicesBarsPanel.attributes = filteredAttrs;
      self.indicesBarsPanel.scales.y.domain(filteredAttrs);
      self.indicesBarsPanel._initialize();
      let selection = self.umapViz && typeof self.umapViz.getSelectedPoints === 'function' ? self.umapViz.getSelectedPoints() : self.data;
      if (!selection || selection.length === 0) {
        selection = self.data;
      }
      const idxData = self.areaGeojson ? self._groupSelectionByArea(selection) : selection;
      self.indicesBarsPanel.updateBars(idxData);
      const pcData = self.areaGeojson ? self._groupSelectionByArea(selection) : selection;
      self.pointcloudBarsPanel.updateBars(pcData);
    });

    // Listen for selection changes
    if (this.umapViz && this.umapViz.onSelectionChange) {
      const origCallback = this.umapViz.onSelectionChange;
      this.umapViz.onSelectionChange = function(selectedPoints) {
        const pcData = self.areaGeojson ? self._groupSelectionByArea(selectedPoints) : selectedPoints;
        self.pointcloudBarsPanel.updateBars(pcData);
        const idxData = self.areaGeojson ? self._groupSelectionByArea(selectedPoints) : selectedPoints;
        self.indicesBarsPanel.updateBars(idxData);
        origCallback.call(this, selectedPoints);
      };
    }
    // For handleSelectionChange direct update
    this.horizontalBarsPanel = {
      updateBars: (selection) => {
        const pcData = this.areaGeojson ? this._groupSelectionByArea(selection) : selection;
        this.pointcloudBarsPanel.updateBars(pcData);
        const idxData = this.areaGeojson ? this._groupSelectionByArea(selection) : selection;
        this.indicesBarsPanel.updateBars(idxData);
      }
    };
  }

  /**
   * Update the visualization with new data
   * @param {Object} geojsonData - GeoJSON data object
   */
  async updateData(geojsonData) {
    try {
      if (!geojsonData) {
        throw new Error('No GeoJSON data provided');
      }

      this.data = geojsonData.features.map(feature => {
        const props = feature.properties;
        return {
          umap_1: props.UMAP_1,
          umap_2: props.UMAP_2,
          ...props
        };
      }).filter(d => 
        d.umap_1 !== undefined && 
        d.umap_2 !== undefined &&
        !isNaN(d.umap_1) &&
        !isNaN(d.umap_2)
      );

      // Update bars with new data
      const pcData = this.areaGeojson ? this._groupSelectionByArea(this.data) : this.data;
      this.pointcloudBarsPanel.updateBars(pcData);
      const idxData = this.areaGeojson ? this._groupSelectionByArea(this.data) : this.data;
      this.indicesBarsPanel.updateBars(idxData);

      if (this.umapViz) {
        await this.umapViz.render(this.data);
      }

    } catch (error) {
      console.error('Error updating UMAP data:', error);
    }
  }

  /**
   * Update the visualization size
   */
  updateSize(width, height) {
    if (!this.umapViz) return;

    this.containerWidth = width;
    this.containerHeight = height;
    this.width = width;
    this.height = height;

    this.umapViz.updateSize(width, height);
  }

  /**
   * Get currently selected points from the UMAP visualization
   * @returns {Array} Array of selected data points with PredInstan IDs
   */
  getSelectedPoints() {
    if (!this.umapViz) return [];
    return this.umapViz.getSelectedPoints();
  }

  /**
   * Get PredInstance IDs of currently selected points
   * @returns {Array} Array of PredInstance IDs
   */
  getSelectedPredInstanceIds() {
    const selectedPoints = this.getSelectedPoints();
    return selectedPoints.map(d => d.PredInstan).filter(id => id !== undefined);
  }

  /**
   * Get the current mode (pan or select)
   * @returns {string} Current mode ('pan' or 'select')
   */
  getCurrentMode() {
    if (!this.umapViz) return 'pan';
    return this.umapViz.getMode();
  }

  /**
   * Set the mode (pan or select)
   * @param {string} mode - 'pan' or 'select'
   */
  setMode(mode) {
    if (this.umapViz) {
      this.umapViz.setMode(mode);
    }
  }

  /**
   * Check if there are any selected points
   * @returns {boolean} True if points are selected
   */
  hasSelection() {
    return this.getSelectedPoints().length > 0;
  }

  /**
   * Get the current selected color attribute
   */
  getColorAttribute() {
    return this.colorByAttribute;
  }

  /**
   * Set the color attribute
   */
  setColorAttribute(attribute) {
    this.colorByAttribute = attribute;
    if (this.umapViz) {
      this.umapViz.updateColorAttribute(attribute);
    }
  }

  /**
   * Refresh the visualization state (mode, selection highlights)
   * Call this when the UMAP tab becomes visible to ensure correct display
   */
  refreshVisualization() {
    if (!this.umapViz) return;
    
    // Use the UMAPVisualization's own refresh method to maintain consistency
    if (this.umapViz.refreshSelection) {
      this.umapViz.refreshSelection();
    }
  }

  /**
   * Setup UMAP filter switch listener
   * @param {Object} config - Configuration object
   * @param {Object} config.fSwitch - FilterSwitch instance
   * @param {Function} config.updateFilter - Function to update filter
   * @param {Function} config.resetFilter - Function to reset filter
   */
  setupFilterSwitch(config) {
    const umapFilterSwitch = document.getElementById('umapFSwitch');
    if (umapFilterSwitch) {
      umapFilterSwitch.addEventListener('change', () => {
        if (umapFilterSwitch.checked) {
          config.fSwitch.mode = 'umap';
          config.updateFilter();
        } else {
          config.resetFilter();
        }
      });
    }
  }

  /**
   * Create settings panel for attribute selection and UMAP regeneration
   */
  createSettingsPanel() {
    const container = d3.select(this.parentSelector);
    
    const settingsPanel = container.insert('div', ':first-child')
      .attr('class', 'collapse')
      .attr('id', 'umap-settings-panel')
      .style('margin-bottom', '15px');
    
    // Add event listeners to toggle between settings and bars panels
    // Use setTimeout to ensure DOM elements are available
    setTimeout(() => {
      const settingsPanelElement = document.getElementById('umap-settings-panel');
      const barsPanelElement = document.getElementById('umap-bars-section');
      const filterRowElement = document.getElementById('umap-indices-filter-row');
      
      if (settingsPanelElement && barsPanelElement && filterRowElement) {
        settingsPanelElement.addEventListener('show.bs.collapse', () => {
          // Hide bars panel and filter row when settings panel is shown
          const barsCollapse = new bootstrap.Collapse(barsPanelElement, { toggle: false });
          barsCollapse.hide();
          const filterCollapse = new bootstrap.Collapse(filterRowElement, { toggle: false });
          filterCollapse.hide();
        });
        
        settingsPanelElement.addEventListener('hide.bs.collapse', () => {
          // Show bars panel and filter row when settings panel is hidden
          const barsCollapse = new bootstrap.Collapse(barsPanelElement, { toggle: false });
          barsCollapse.show();
          const filterCollapse = new bootstrap.Collapse(filterRowElement, { toggle: false });
          filterCollapse.show();
        });
      }
    }, 0);
    
    const settingsCard = settingsPanel.append('div')
      .attr('class', 'card card-body')
      .style('padding', '15px')
      .style('background-color', '#f8f9fa');
    
    settingsCard.append('h6')
      .attr('class', 'mb-3')
      .text('Select Attributes for UMAP Analysis');
    
    const checkboxContainer = settingsCard.append('div')
      .attr('id', 'umap-attribute-checkboxes')
      .attr('class', 'row g-2')
      .style('max-height', '220px')
      .style('overflow-y', 'auto')
      .style('margin-bottom', '15px');

    // Get current UMAP attributes from metadata
    let currentUmapAttributes = ['Height', 'AvgNDVI', 'AvgGNDVI', 'AvgLCI', 'AvgNDRE', 'AvgOSAVI'];
    if (this.metadata && this.metadata.umap_input_features) {
      currentUmapAttributes = ['Height', ...this.metadata.umap_input_features];
      // Handle attribute name variations
      if (currentUmapAttributes.includes('MedianGNDVI')) {
        currentUmapAttributes = currentUmapAttributes.map(attr => attr === 'MedianGNDVI' ? 'MedianGNDV' : attr);
      }
      if (currentUmapAttributes.includes('MedianOSAVI')) {
        currentUmapAttributes = currentUmapAttributes.map(attr => attr === 'MedianOSAVI' ? 'MedianOSAV' : attr);
      }
    }

    const attributesByCategory = this._categorizeAttributes(this.availableAttributes);

    const nonEmptyCategories = Object.entries(attributesByCategory).filter(([_, attrs]) => attrs.length > 0);
    const colClass = nonEmptyCategories.length > 0 ? `col-md-${Math.max(2, Math.floor(12 / nonEmptyCategories.length))}` : 'col-md-3';

    nonEmptyCategories.forEach(([category, attrs]) => {
      const categoryDiv = checkboxContainer.append('div')
        .attr('class', `${colClass} mb-2 d-flex flex-column`)
        .style('min-width', '120px');

      if (category !== 'Other') {
        categoryDiv.append('small')
          .attr('class', 'text-muted fw-bold d-block mb-1')
          .text(category);
      }

      attrs.forEach(attr => {
        const checkDiv = categoryDiv.append('div')
          .attr('class', 'form-check');

        // Check if this attribute is in the current UMAP
        const isInCurrentUmap = currentUmapAttributes.includes(attr);

        checkDiv.append('input')
          .attr('class', 'form-check-input umap-attr-checkbox')
          .attr('type', 'checkbox')
          .attr('value', attr)
          .attr('id', `umap-checkbox-${attr}`)
          .property('checked', isInCurrentUmap);

        checkDiv.append('label')
          .attr('class', 'form-check-label')
          .attr('for', `umap-checkbox-${attr}`)
          .style('font-size', '12px')
          .text(attr);
      });
    });
    
    const buttonRow = settingsCard.append('div')
      .attr('class', 'd-flex justify-content-between align-items-center');
    
    const selectButtonGroup = buttonRow.append('div')
      .attr('class', 'btn-group btn-group-sm')
      .attr('role', 'group');
    
    selectButtonGroup.append('button')
      .attr('class', 'btn btn-outline-secondary')
      .text('Select All')
      .on('click', () => {
        d3.selectAll('.umap-attr-checkbox').property('checked', true);
      });
    
    selectButtonGroup.append('button')
      .attr('class', 'btn btn-outline-secondary')
      .text('Deselect All')
      .on('click', () => {
        d3.selectAll('.umap-attr-checkbox').property('checked', false);
      });
    
    const generateBtn = buttonRow.append('button')
      .attr('class', 'btn btn-primary btn-sm')
      .attr('id', 'umap-generate-btn')
      .text('Generate UMAP')
      .on('click', () => this._generateNewUMAP());
    
    settingsCard.append('div')
      .attr('id', 'umap-loading-indicator')
      .attr('class', 'alert alert-info mt-3')
      .style('display', 'none')
      .html('<div class="spinner-border spinner-border-sm me-2" role="status"></div>Generating UMAP...');
  }

  /**
   * Categorize attributes by their prefixes for better organization
   */
  _categorizeAttributes(attributes) {
    const categories = {
      'NDVI': [],
      'GNDVI': [],
      'LCI': [],
      'NDRE': [],
      'OSAVI': [],
      'Height': [],
      'Other': []
    };
    
    attributes.forEach(attr => {
      if (attr.includes('NDVI') && !attr.includes('GNDVI') && !attr.includes('GNDV')) {
        categories['NDVI'].push(attr);
      } else if (attr.includes('GNDVI') || attr.includes('GNDV')) {
        categories['GNDVI'].push(attr);
      } else if (attr.includes('LCI')) {
        categories['LCI'].push(attr);
      } else if (attr.includes('NDRE')) {
        categories['NDRE'].push(attr);
      } else if (attr.includes('OSAVI') || attr.includes('OSAV')) {
        categories['OSAVI'].push(attr);
      } else if (attr.includes('Height')) {
        categories['Height'].push(attr);
      } else {
        categories['Other'].push(attr);
      }
    });
    
    return categories;
  }

  /**
   * Generate new UMAP based on selected attributes
   */
  async _generateNewUMAP() {
    try {
      const selectedAttributes = [];
      d3.selectAll('.umap-attr-checkbox:checked').each(function() {
        selectedAttributes.push(d3.select(this).property('value'));
      });
      
      if (selectedAttributes.length === 0) {
        alert('Please select at least one attribute for UMAP analysis.');
        return;
      }
      
      d3.select('#umap-loading-indicator').style('display', 'block');
      d3.select('#umap-generate-btn').property('disabled', true);
      

      // Computed in the browser; the static demo has no UMAP server.
      const newGeojsonData = await computeUMAP(this.baseGeojson, selectedAttributes, {
        nodataValue: this.nodataValue,
      });
      
      await this._updateWithNewData(newGeojsonData);
      
      d3.select('#umap-loading-indicator').style('display', 'none');
      d3.select('#umap-generate-btn').property('disabled', false);
      
      const settingsPanel = document.getElementById('umap-settings-panel');
      if (settingsPanel) {
        const bsCollapse = new bootstrap.Collapse(settingsPanel, { toggle: false });
        bsCollapse.hide();
      }
      
      
    } catch (error) {
      console.error('Error generating new UMAP:', error);
      alert(`Failed to generate UMAP: ${error.message}`);
      
      // Hide loading indicator
      d3.select('#umap-loading-indicator').style('display', 'none');
      d3.select('#umap-generate-btn').property('disabled', false);
    }
  }

  /**
   * Update visualization with new UMAP data while preserving state
   */
  async _updateWithNewData(newGeojsonData) {
    try {
      const currentMode = this.getCurrentMode();
      const currentColorAttr = this.colorByAttribute;
      const currentPointSize = this.pointRadius;
      const currentSelection = this.getSelectedPredInstanceIds();
      
      this.geojsonData = newGeojsonData;
      
      this.data = newGeojsonData.features.map(feature => {
        const props = feature.properties;
        return {
          umap_1: props.UMAP_1,
          umap_2: props.UMAP_2,
          ...props
        };
      }).filter(d => 
        d.umap_1 !== undefined && 
        d.umap_2 !== undefined &&
        !isNaN(d.umap_1) &&
        !isNaN(d.umap_2)
      );
      
      
      // Re-render UMAP visualization
      if (this.umapViz) {
        await this.umapViz.render(this.data);
        
        this.umapViz.setMode(currentMode);
        
        const availableAttrs = this.data.length > 0 ? Object.keys(this.data[0]) : [];
        if (availableAttrs.includes(currentColorAttr)) {
          this.umapViz.updateColorAttribute(currentColorAttr);
        }
        
        this.umapViz.updatePointSize(currentPointSize);
        
        if (currentSelection && currentSelection.length > 0) {
          const newSelection = this.data.filter(d => 
            currentSelection.includes(d.PredInstan)
          );
          if (newSelection.length > 0 && this.umapViz.setSelectedPoints) {
            this.umapViz.setSelectedPoints(newSelection);
          }
        }
      }
      
      // Update bars panels with grouped data
      if (this.pointcloudBarsPanel) {
        const pcData = this.areaGeojson ? this._groupSelectionByArea(this.data) : this.data;
        this.pointcloudBarsPanel.updateBars(pcData);
      }
      if (this.indicesBarsPanel) {
        const idxData = this.areaGeojson ? this._groupSelectionByArea(this.data) : this.data;
        this.indicesBarsPanel.updateBars(idxData);
      }
      
      // Update point count text
      d3.select('.umap-controls .text-muted')
        .text(`Displaying ${this.data.length} tree centroids in UMAP space`);
      
      const event = new CustomEvent('umap-selection-change', {
        bubbles: true
      });
      document.dispatchEvent(event);
      
    } catch (error) {
      console.error('Error updating UMAP visualization with new data:', error);
      throw error;
    }
  }

  /**
   * Destroy the panel and clean up resources
   */
  destroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.umapViz && this.umapViz.tooltip) {
      this.umapViz.tooltip.remove();
    }
    const container = d3.select(this.parentSelector);
    container.html('');
    this.umapViz = null;
    this.data = null;
  }
}
