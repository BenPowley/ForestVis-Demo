/*
 * Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
 * Licensed under the MIT License; see LICENSE.txt in the project root.
 * SPDX-License-Identifier: MIT
 */

/* HistogramSliderPanel class manages the HistogramSlider for filtering point cloud data.
   It handles initialization, resize observers, and interaction with the filter histogram.
*/

import * as d3 from "d3";
import { HistogramSlider } from "./HistogramSlider";

export class HistogramSliderPanel {
  constructor() {
    this.histogram = null;
    this.resizeObserver = null;
    this.currentAttribute = null;
    this.attributeValues = [];
    this.records = null;
    this.invertRange = false;
    this.containerSelector = null;
    this.parentSelector = null;
    this.histogramWidth = 150;
    this.isResizing = false;
    this.fSwitch = null;
    this.callbacks = {};
  }

  /**
   * Initialize histogram slider panel from configuration
   * @param {Object} config - Configuration object
   * @param {string} config.containerSelector - CSS selector for the container element for resize
   * @param {string} config.parentSelector - CSS selector for the histogram parent element
   * @param {Function} config.getAttributeValues - Function that returns array of attribute values
   * @param {Object} config.nodataRecords - Nodata records array from metadata
   * @param {Object} config.attributeConfig - Attribute configuration object
   * @param {string} config.filterAttributeSelectSelector - CSS selector for attribute select dropdown
   * @param {Object} config.fSwitch - FilterSwitch instance
   * @param {Function} config.onFilterChange - Callback when filter values change
   * @param {Function} config.onResize - Optional callback on resize
   * @param {Function} config.updateFilter - Callback to update filter
   * @param {Function} config.resetFilter - Callback to reset filter
   * @param {Function} config.initFilterHistogram - Callback to reinitialize histogram with new attribute
   * @param {Function} config.onAttributeChangeNoFilter - Callback when attribute changes without active filter
   * @param {boolean} config.invertRange - Initial invert state (default: false)
   * @returns {HistogramSliderPanel} Initialized panel instance
   */
  static initializeFromConfig(config) {
    const panel = new HistogramSliderPanel();

    panel.containerSelector = config.containerSelector;
    panel.parentSelector = config.parentSelector || '#histogram-div';
    panel.currentAttribute = config.initialAttribute || 'AvgNDVI';
    panel.invertRange = config.invertRange || false;
    panel.fSwitch = config.fSwitch;

    // Store callbacks
    panel.callbacks = {
      updateFilter: config.updateFilter,
      resetFilter: config.resetFilter,
      initFilterHistogram: config.initFilterHistogram,
      onAttributeChangeNoFilter: config.onAttributeChangeNoFilter
    };

    // Dynamically populate filter attribute select options if selector and attributeConfig are provided
    if (config.filterAttributeSelectSelector && config.attributeConfig?.attributes) {
      const select = document.querySelector(config.filterAttributeSelectSelector);
      if (select) {
        // Remove existing options
        select.innerHTML = '';
        const attributes = config.attributeConfig.attributes;
        Object.keys(attributes).forEach(attrKey => {
          const attr = attributes[attrKey];
          if (attr.pointCloudOnly === true) {
            return; // skip if pointCloudOnly is true
          }
          const option = document.createElement('option');
          if (attr.label && attr.label.includes("PredInstance")) { // handle truncation for predInstance
            return; // skip if label includes "PredInstance"
          } else {
            option.value = attrKey;
          }
          option.textContent = attr.label || attrKey;
          if (attrKey === panel.currentAttribute) {
            option.selected = true;
          }
          select.appendChild(option);
        });
      }
    }

    // Get attribute values from the provided function
    const attributeValues = config.getAttributeValues(panel.currentAttribute);

    // Get nodata value for this attribute
    let nodata = null;
    if (config.nodataRecords) {
      config.nodataRecords.forEach((e) => {
        if (e["dimension"] === panel.currentAttribute) {
          nodata = e["nodata_value"];
        }
      });
    }

    // Filter out nodata values
    panel.attributeValues = attributeValues.filter(value => {
      const val = parseFloat(value);
      return !(val === nodata) && !isNaN(val);
    });

    if (panel.attributeValues.length > 0) {
      const margin = {
        top: 20,
        right: 30,
        bottom: 30,
        left: 52
      };

      function updateRecords(thresholds) {
        const bin = d3.bin()
          .domain(d3.extent(panel.attributeValues))
          .thresholds(thresholds)(panel.attributeValues);
        return bin.map(b => ({ x0: b.x0, x1: b.x1, height: b.length }));
      }

      panel.records = updateRecords(20);

      const attrConfig = config.attributeConfig?.attributes[panel.currentAttribute];
      const xLabel = attrConfig?.label || panel.currentAttribute;
      const yLabel = "Frequency";

      const container = document.querySelector(config.containerSelector);
      panel.histogramWidth = container ? container.offsetWidth - 20 : 150;

      panel.histogram = HistogramSlider.instantiate(
        0,
        panel.parentSelector,
        xLabel,
        yLabel,
        margin,
        panel.histogramWidth,
        panel.records,
        panel.invertRange,
        function (e, x, y) {
          if (config.onFilterChange && !panel.isResizing) {
            config.onFilterChange(e, x, y);
          } else {
            this.disableHistogram(!d3.select('#fSwitch').property('checked'));
          }
        }
      );

      // Store records on histogram instance for external access
      panel.histogram.records = panel.records;

      // Setup invert toggle if provided
      if (config.invertToggleSelector) {
        const ihToggle = document.querySelector(config.invertToggleSelector);
        if (ihToggle) {
          ihToggle.addEventListener('change', function() {
            panel.invertRange = ihToggle.checked;
            panel.histogram.invert(panel.invertRange);
            panel.histogram.updateWidth(panel.histogramWidth, panel.records);
          });
        }
      }

      // Setup resize observer if container specified
      if (container) {
        panel.resizeObserver = new ResizeObserver(entries => {
          for (const entry of entries) {
            const width = entry.target.offsetWidth;
            // A hidden tab reports 0; rebuilding then gives negative SVG sizes.
            // The observer fires again with the real width when it is shown.
            if (width === 0) continue;
            if (!(panel.histogramWidth === width - 20)) {
              panel.isResizing = true;
              panel.histogramWidth = width - 20;
              panel.records = updateRecords(20);
              panel.histogram.updateWidth(panel.histogramWidth, panel.records);

                if (config.onResize) {
                  config.onResize(panel.histogramWidth);
                }
                // Reset the flag after a short delay to allow the resize to complete
                setTimeout(() => {
                  panel.isResizing = false;
                }, 100);
              }
            }
          });

          panel.resizeObserver.observe(container);
        }
      }

      // Setup filter controls after initialization
      if (config.filterAttributeSelectSelector) {
        panel.setupFilterControls(config.filterAttributeSelectSelector);
      }
      return panel;
    }
  
  /**
   * Update histogram with a new attribute
   * @param {string} attribute - New attribute name
   * @param {Function} getAttributeValues - Function to get values for the attribute
   * @param {Object} nodataRecords - Nodata records array
   * @param {Object} attributeConfig - Attribute configuration
   */
  updateAttribute(attribute, getAttributeValues, nodataRecords, attributeConfig) {
    this.currentAttribute = attribute;
    
    // Get attribute values
    const attributeValues = getAttributeValues(attribute);
    
    // Get nodata value for this attribute
    let nodata = null;
    if (nodataRecords) {
      nodataRecords.forEach((e) => {
        if (e["dimension"] === attribute) {
          nodata = e["nodata_value"];
        }
      });
    }
    
    // Filter out nodata values
    this.attributeValues = attributeValues.filter(value => {
      const val = parseFloat(value);
      return !(val === nodata) && !isNaN(val);
    });
    
    if (this.attributeValues.length > 0 && this.histogram) {
      function updateRecords(thresholds) {
        const bin = d3.bin()
          .domain(d3.extent(this.attributeValues))
          .thresholds(thresholds)(this.attributeValues);
        return bin.map(b => ({ x0: b.x0, x1: b.x1, height: b.length }));
      }
      
      this.records = updateRecords.call(this, 20);
      
      const attrConfig = attributeConfig?.attributes[attribute];
      const xLabel = attrConfig?.label || attribute;
      
      // Update the histogram with new data
      this.histogram.updateData(xLabel, this.records);
      this.histogram.records = this.records;
    }
  }
  
  /**
   * Get the current filter range
   * @returns {Object} Object with fromValue and toValue
   */
  getFilterRange() {
    if (this.histogram) {
      return this.histogram.getFilterRange();
    }
    return { fromValue: 0, toValue: 0 };
  }
  
  /**
   * Enable or disable the histogram
   * @param {boolean} disabled - Whether to disable the histogram
   */
  setDisabled(disabled) {
    if (this.histogram) {
      this.histogram.disableHistogram(disabled);
    }
  }
  
  /**
   * Get the current attribute being displayed
   * @returns {string} Current attribute name
   */
  getCurrentAttribute() {
    return this.currentAttribute;
  }
  
  /**
   * Get the invert range state
   * @returns {boolean} Whether range is inverted
   */
  isInverted() {
    return this.invertRange;
  }
  
  /**
   * Get the histogram instance
   * @returns {HistogramSlider} Histogram instance
   */
  getHistogram() {
    return this.histogram;
  }
  
  /**
   * Setup filter controls (attribute selector and filter switch listener)
   * @param {string} filterAttributeSelectSelector - CSS selector for attribute select dropdown
   */
  setupFilterControls(filterAttributeSelectSelector) {
    // Add attribute selector for filtering
    const filterAttributeSelect = document.querySelector(filterAttributeSelectSelector);
    if (filterAttributeSelect) {
      filterAttributeSelect.addEventListener('change', () => {
        const selectedAttribute = filterAttributeSelect.value;
        const wasFilterActive = this.fSwitch?.isEnabled;

        this.invertRange = false;
        if (this.callbacks.initFilterHistogram) {
          this.callbacks.initFilterHistogram(selectedAttribute);
        }
        
        // If filter was active, reapply it with new values
        if (wasFilterActive && this.callbacks.updateFilter) {
          this.callbacks.updateFilter();
        } else if (this.callbacks.onAttributeChangeNoFilter) {
          // Callback for when attribute changes without active filter
          this.callbacks.onAttributeChangeNoFilter();
        }
      });
    }
    
    // Add histogram filter switch listener
    const fSwitch = document.getElementById('fSwitch');
    if (fSwitch) {
      fSwitch.addEventListener('change', () => {
        const fSwitchEnabled = fSwitch.checked;
        if (!fSwitchEnabled) {
          if (this.callbacks.resetFilter) {
            this.callbacks.resetFilter();
          }
        } else {
          // Set mode to histogram
          if (this.fSwitch) {
            this.fSwitch.mode = 'histogram';
          }
          if (this.callbacks.updateFilter) {
            this.callbacks.updateFilter();
          }
        }
      });
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
    
    if (this.histogram) {
      this.histogram.destroy();
      this.histogram = null;
    }
    
    this.attributeValues = [];
    this.records = null;
  }
}
