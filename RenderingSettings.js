/*
 * Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
 * Licensed under the MIT License; see LICENSE.txt in the project root.
 * SPDX-License-Identifier: MIT
 */

import * as d3 from "d3";
import { MODE } from "@giro3d/giro3d/renderer/PointCloudMaterial.js";
import ColorMapMode from "@giro3d/giro3d/core/ColorMapMode.js";
import ColorMap from "@giro3d/giro3d/core/ColorMap.js";
import { Color } from "three";
import { fetchQGISColorCategorization, getDefaultRenderingPanelSettings } from "./Metadata.js";
import chroma from 'chroma-js';


/**
 * Class to manage rendering settings for point clouds
 */
export class RenderingSettings {
  /**
   * @param {Object} config - Configuration object
   * @param {Object} config.pointcloud - Main point cloud instance
   * @param {Object} config.instance - Giro3D instance
   * @param {Array} config.pointclouds - Array of base point cloud instances
   * @param {Object} config.attributeConfig - Attribute configuration from JSON
   */
  constructor(config) {
    this.pointcloud = config.pointcloud;
    this.instance = config.instance;
    this.pointclouds = config.pointclouds;
    this.attributeConfig = config.attributeConfig || { attributes: {} };

    // Load default rendering settings from attributeConfig
    const renderingDefaults = getDefaultRenderingPanelSettings(this.attributeConfig);
    // Main point cloud
    if (typeof renderingDefaults.mainPointSize === 'number') {
      this.pointcloud.pointSize = renderingDefaults.mainPointSize;
    }
    if (typeof renderingDefaults.mainOpacity === 'number') {
      this.pointcloud.opacity = renderingDefaults.mainOpacity;
    }
    if (typeof renderingDefaults.subdivisionThreshold === 'number') {
      this.pointcloud.subdivisionThreshold = renderingDefaults.subdivisionThreshold;
    }
    if (typeof renderingDefaults.pointBudget === 'number') {
      this.pointcloud.pointBudget = renderingDefaults.pointBudget;
    }
    // Rendering options
    if (typeof renderingDefaults.enableEDL === 'boolean') {
      this.instance.renderingOptions.enableEDL = renderingDefaults.enableEDL;
    }
    if (typeof renderingDefaults.enableInpainting === 'boolean') {
      this.instance.renderingOptions.enableInpainting = renderingDefaults.enableInpainting;
    }
    if (typeof renderingDefaults.enablePointCloudOcclusion === 'boolean') {
      this.instance.renderingOptions.enablePointCloudOcclusion = renderingDefaults.enablePointCloudOcclusion;
    }
    // Base point clouds
    if (Array.isArray(this.pointclouds)) {
      this.pointclouds.forEach(pc => {
        if (typeof renderingDefaults.basePointSize === 'number') {
          pc.pointSize = renderingDefaults.basePointSize;
        }
        if (typeof renderingDefaults.baseOpacity === 'number') {
          pc.opacity = renderingDefaults.baseOpacity;
        }
        // The base is context only; a coarser fixed LOD keeps its initial load
        // small (TEAK, 45° start view: 106 MB at threshold 1, 45 MB at 3, 24 MB at 4).
        const baseThreshold = renderingDefaults.baseSubdivisionThreshold ?? renderingDefaults.subdivisionThreshold;
        if (typeof baseThreshold === 'number') {
          pc.subdivisionThreshold = baseThreshold;
        }
        if (typeof renderingDefaults.pointBudget === 'number') {
          pc.pointBudget = renderingDefaults.pointBudget;
        }
      });
    }

    /**
     * Optional callback fired whenever the pointcloud rendering mode changes.
     * Signature: (attributeName: string, colorMode: string) => void
     * Set externally: renderingSettings.onModeChange = async (attr, mode) => { … }
     */
    this.onModeChange = null;

    /** Colour mode on load (renderingPanel.defaultColorMode, else PredInstance) */
    this.defaultColorMode = this.attributeConfig.attributes[renderingDefaults.defaultColorMode]
      ? renderingDefaults.defaultColorMode : 'PredInstance';
    this.selectMode(this.defaultColorMode);
  }

  /**
   * Switches the point cloud coloring mode
   * @param {string} selectedMode - The mode to switch to ('rgb', 'ndvi', 'predinstance', 'ndvimean', 'height', 'elevation')
   */
  async selectMode(selectedMode) {
    // selectedMode is the attribute name from attributeConfig
    const attrConfig = this.attributeConfig.attributes[selectedMode];

    if (!attrConfig) {
      console.warn(`No configuration found for attribute: ${selectedMode}`);
      return;
    }

    const colorMode = attrConfig.colorMode;
    this.pointcloud.removeColorLayer();
    if (colorMode === 'rgb') {

      // Switch to RGB mode - use RGB texture mode
      this.pointcloud.setActiveAttribute('Color');
      this.pointcloud.pointCloudMode = MODE.TEXTURE;
    } else if (colorMode === 'attribute') {

      // Use attributeName from config if specified (e.g., Z for Elevation)
      const actualAttributeName = attrConfig.attributeName || selectedMode;
      this.pointcloud.setActiveAttribute(actualAttributeName);
      this.pointcloud.pointCloudMode = MODE.ELEVATION;

      // Construct the color map
      const scale = this.attributeConfig.colorscales[attrConfig.scale];
      let colorMap = await this.getColorMapForAttribute(this.attributeConfig, attrConfig);
      if (!colorMap) {
        console.warn('Color map could not be constructed');
        return;
      }
      this.pointcloud.colorMap = colorMap;

      if (scale.type === 'gradient') {
        this.pointcloud.colorMap.colors = [...colorMap.colors];

        // Handle auto-range for attributes
        if (attrConfig.useAutoRange && attrConfig.autoRangeBboxProperty) {
          const bbox = this.pointcloud.getBoundingBox();
          const prop = attrConfig.autoRangeBboxProperty;
          this.pointcloud.colorMap.min = bbox?.min[prop] ?? (attrConfig.colorMapMin || 0);
          this.pointcloud.colorMap.max = bbox?.max[prop] ?? (attrConfig.colorMapMax || 1);
        }
      }
    }
    this.instance.notifyChange(this.pointcloud);

    // Notify external listeners (e.g. minimap legend switcher)
    if (typeof this.onModeChange === 'function') {
      const attrCfg = this.attributeConfig?.attributes?.[selectedMode];
      this.onModeChange(selectedMode, attrCfg?.colorMode ?? selectedMode);
    }
  }

  /**
   * Populates the color mode select dropdown from attribute configuration
   */
  populateColorModeSelect() {
    const colorModeSelect = document.getElementById('colorModeSelect');
    if (!colorModeSelect || !this.attributeConfig) return;

    // Clear existing options
    colorModeSelect.innerHTML = '';

    // Add options from attributeConfig
    Object.entries(this.attributeConfig.attributes).forEach(([attributeName, config]) => {
      const option = document.createElement('option');
      option.value = attributeName;
      option.textContent = config.label;

      // Pre-select the default colour mode
      if (attributeName === this.defaultColorMode) {
        option.selected = true;
      }

      colorModeSelect.appendChild(option);
    });
  }

  /**
   * Creates the selected color map from the configuration file.
   * @param {*} config - The configuration file
   * @param {*} attrConfig - The selected color map
   * @returns constructed color map
   */
  async getColorMapForAttribute(config, attrConfig) {
    const scale = config.colorscales[attrConfig.scale];
    if (!scale) {
      console.warn('Colorscale could not be fetched from the configuration');
      return;
    }
    switch (scale.type) {
      case "palette":
        return new ColorMap({
          colors: scale.bounds.filter(c => c?.index).map(v => v.hex).map((h) => new Color(h)),
          min: Number(attrConfig.colorMapMin),
          max: Number(attrConfig.colorMapMax),
          mode: ColorMapMode.Elevation
        });

      case "gradient":
        return new ColorMap({
          colors: chroma.scale(scale.palette).colors(256).map(v => new Color(v)),
          min: Number(attrConfig.colorMapMin),
          max: Number(attrConfig.colorMapMax),
          mode: ColorMapMode.Continuous // Use Continuous mode for gradients
        });

      case "qml":
        const qmlColors = await fetchQGISColorCategorization(scale.file);
        const maxPredInstance = config?.attributes?.PredInstance?.range?.numInstances ?? 0;
        const baseColors = qmlColors.map(c => new Color(c[0] / 255, c[1] / 255, c[2] / 255));
        const numBaseColors = baseColors.length;
  
        // Generate extended color array by cycling through base colors using modulo
        const extendedColors = Array.from({ length: Math.ceil(maxPredInstance) + 1 }, (_, i) => 
            baseColors[i % numBaseColors].clone()
        );
        const instanceColorMap = new ColorMap({
          colors: extendedColors,
          min: 0,
          max: maxPredInstance,
          mode: ColorMapMode.Elevation   // Use Elevation mode for a linear scale
        });
        return instanceColorMap;
      default:
        console.warn(`Unsupported colorscale type: ${scale.type}`);
    }
  }

  /**
   * Sets up the color mode toggle dropdown
   */
  setupColorModeToggle() {
    // Populate dropdown from config
    this.populateColorModeSelect();
    
    const colorModeSelect = document.getElementById('colorModeSelect');
    d3.select('#toggleOptions')
      .style('background-color', 'white')
      .style('opacity', '1')
      .style('width', '200pt')
    d3.select('#colorModeSelect')
      .style('width', 'fit-content')
      .style('margin-left', '10pt');

    this.instance.domElement.addEventListener("dblclick", (e) => {
      // const tempActiveAttribute = this.pointcloud.activeAttribute.name;
      // const picked = this.pointcloud.pick(e, { radius: 5, limit: 10, gpuPicking: true})[0];
      // this.selectMode('predinstance');
      // const picked = this.pointcloud.pick(e, { radius: 5, limit: 10, gpuPicking: true})[0].object.geometry.attributes.intensity;
    });
    
    colorModeSelect.addEventListener('change', (e) => {
      this.selectMode(e.target.value);
    });
  }


  /**
   * Sets up point size sliders for point clouds
   */
  setupPointSizeSliders() {
    // Main pointcloud slider
    const mainPointSizeSlider = document.getElementById('mainPointSizeSlider');
    const mainPointSizeValue = document.getElementById('mainPointSizeValue');
    d3.select('#mainslider').style('top', '30pt');
    if (mainPointSizeSlider && mainPointSizeValue) {
      mainPointSizeSlider.value = this.pointcloud.pointSize;
      mainPointSizeValue.textContent = this.pointcloud.pointSize;
      mainPointSizeSlider.addEventListener('input', () => {
        const size = parseFloat(mainPointSizeSlider.value);
        this.pointcloud.pointSize = size;
        mainPointSizeValue.textContent = size.toFixed(1);
        this.instance.notifyChange(this.pointcloud);
      });
    }

    // Main pointcloud opacity slider
    const mainOpacitySlider = document.getElementById('mainOpacitySlider');
    const mainOpacityValue = document.getElementById('mainOpacityValue');
    d3.select('#mainOpacity').style('top', '90pt');
    if (mainOpacitySlider && mainOpacityValue) {
      mainOpacitySlider.value = this.pointcloud.opacity;
      mainOpacityValue.textContent = this.pointcloud.opacity;
      mainOpacitySlider.addEventListener('input', () => {
        const opacity = parseFloat(mainOpacitySlider.value);
        this.pointcloud.opacity = opacity;
        mainOpacityValue.textContent = opacity.toFixed(1);
        this.instance.notifyChange(this.pointcloud);
      });
    }

    // CopcBase pointclouds slider
    const copcPointSizeSlider = document.getElementById('copcPointSizeSlider');
    const copcPointSizeValue = document.getElementById('copcPointSizeValue');
    d3.select('#basePoints').style('top', '60pt');
    if (copcPointSizeSlider && copcPointSizeValue && this.pointclouds.length > 0) {
      // Use the first base pointcloud's value as initial
      copcPointSizeSlider.value = this.pointclouds[0].pointSize;
      copcPointSizeValue.textContent = this.pointclouds[0].pointSize;
      copcPointSizeSlider.addEventListener('input', () => {
        const size = parseFloat(copcPointSizeSlider.value);
        this.pointclouds.forEach(pc => {
          pc.pointSize = size;
          this.instance.notifyChange(pc);
        });
        copcPointSizeValue.textContent = size.toFixed(1);
      });
    }

    // CopcBase pointclouds opacity slider
    const copcOpacitySlider = document.getElementById('copcOpacitySlider');
    const copcOpacityValue = document.getElementById('copcOpacityValue');
    d3.select('#baseOpacity').style('top', '120pt');
    if (copcOpacitySlider && copcOpacityValue && this.pointclouds.length > 0) {
      // Use the first base pointcloud's value as initial
      copcOpacitySlider.value = this.pointclouds[0].opacity;
      copcOpacityValue.textContent = this.pointclouds[0].opacity;
      copcOpacitySlider.addEventListener('input', () => {
        const opacity = parseFloat(copcOpacitySlider.value);
        this.pointclouds.forEach(pc => {
          pc.opacity = opacity;
          this.instance.notifyChange(pc);
        });
        copcOpacityValue.textContent = opacity.toFixed(1);
      });
    }
  }

  /**
   * Sets up rendering option toggles (EDL, Inpainting, Occlusion, etc.)
   * @param {Function} resetFilter - Callback for resetting filters
   * @param {Function} updateFilter - Callback for updating filters
   */
  setupRenderingToggles(resetFilter, updateFilter) {
    // Eye Dome Lighting toggle
    const edlToggle = document.getElementById('edlToggle');
    if (edlToggle) {
      // Set initial state
      edlToggle.checked = this.instance.renderingOptions.enableEDL;
      edlToggle.addEventListener('change', () => {
        this.instance.renderingOptions.enableEDL = edlToggle.checked;
        this.instance.notifyChange(this.instance.view.camera);
      });
    }
    
    // Inpainting toggle
    const inpaintingToggle = document.getElementById('inpaintingToggle');
    if (inpaintingToggle) {
      // Set initial state
      inpaintingToggle.checked = this.instance.renderingOptions.enableInpainting;
      inpaintingToggle.addEventListener('change', () => {
        this.instance.renderingOptions.enableInpainting = inpaintingToggle.checked;
        this.instance.notifyChange(this.instance.view.camera);
      });
    }
    
    // Point Cloud Occlusion toggle
    const occlusionToggle = document.getElementById('occlusionToggle');
    if (occlusionToggle) {
      // Set initial state
      occlusionToggle.checked = this.instance.renderingOptions.enablePointCloudOcclusion;
      occlusionToggle.addEventListener('change', () => {
        this.instance.renderingOptions.enablePointCloudOcclusion = occlusionToggle.checked;
        this.instance.notifyChange(this.instance.view.camera);
      });
    }

    const subdivisionThresholdInput = document.getElementById('subdivisionThreshold');
    const subdivisionThresholdValue = document.getElementById('subdivisionThresholdValue');
    if (subdivisionThresholdInput && subdivisionThresholdValue) {
      // Use the current value from the main pointcloud
      subdivisionThresholdInput.value = this.pointcloud.subdivisionThreshold;
      subdivisionThresholdValue.textContent = this.pointcloud.subdivisionThreshold;

      if (this.pointcloud) {
        this.pointcloud.subdivisionThreshold = parseFloat(subdivisionThresholdInput.value);
        this.instance.notifyChange(this.pointcloud);
      }

      // The slider controls the main point cloud only; the base keeps its
      // fixed LOD (renderingPanel.baseSubdivisionThreshold).
      subdivisionThresholdInput.addEventListener('input', () => {
        const threshold = parseFloat(subdivisionThresholdInput.value);
        if (this.pointcloud) {
          this.pointcloud.subdivisionThreshold = threshold;
          this.instance.notifyChange(this.pointcloud);
        }
        subdivisionThresholdValue.textContent = threshold.toFixed(2);
      });
    }

    // Point Budget slider
    const budgetToggle = document.getElementById('budgetToggle');
    const pointBudgetSlider = document.getElementById('pointBudgetSlider');
    const pointBudgetValue = document.getElementById('pointBudgetValue');
    
    // Function to apply budget settings
    const applyBudgetSettings = (budgetEnabled, budgetValue = null) => {
      if (budgetEnabled && budgetValue) {
        // Apply budget to camera;
        // Calculate number of point cloud objects and divide budget
        const totalPointClouds = 1 + this.pointclouds.length; // main pointcloud + base pointclouds
        const budgetPerPointCloud = Math.floor(budgetValue / totalPointClouds);
        
        if (this.pointcloud) {
          this.pointcloud.pointBudget = budgetPerPointCloud;
          this.instance.notifyChange(this.pointcloud);
        }
        
        if (this.pointclouds && this.pointclouds.length > 0) {
          this.pointclouds.forEach(pc => {
            pc.pointBudget = budgetPerPointCloud;
            this.instance.notifyChange(pc);
          });
        }
      } else {
        
        if (this.pointcloud) {
          this.pointcloud.pointBudget = null;
          this.instance.notifyChange(this.pointcloud);
        }
        
        if (this.pointclouds && this.pointclouds.length > 0) {
          this.pointclouds.forEach(pc => {
            pc.pointBudget = null;
            this.instance.notifyChange(pc);
          });
        }
      }
      
      this.instance.notifyChange(this.instance);
    };
    
    if (budgetToggle && pointBudgetSlider && pointBudgetValue) {
      // Use the current value from the main pointcloud as initial
      const currentBudget = this.pointcloud.pointBudget || 10000000;
      const initialValue = Math.round(currentBudget / 1000000); // Convert to millions
      pointBudgetSlider.value = initialValue;
      pointBudgetValue.textContent = initialValue + 'M';
      budgetToggle.checked = false; // Budget disabled by default

      pointBudgetSlider.disabled = true;
      pointBudgetSlider.style.opacity = '0.5';
      pointBudgetValue.style.opacity = '0.5';
      applyBudgetSettings(false); // Start with budget disabled

      budgetToggle.addEventListener('change', () => {
        const isEnabled = budgetToggle.checked;
        pointBudgetSlider.disabled = !isEnabled;

        if (isEnabled) {
          const budgetInMillions = parseInt(pointBudgetSlider.value);
          const actualBudget = budgetInMillions * 1000000;
          applyBudgetSettings(true, actualBudget);
        } else {
          applyBudgetSettings(false);
        }
        pointBudgetSlider.style.opacity = isEnabled ? '1' : '0.5';
        pointBudgetValue.style.opacity = isEnabled ? '1' : '0.5';
      });

      pointBudgetSlider.addEventListener('input', () => {
        if (budgetToggle.checked) {
          const budgetInMillions = parseInt(pointBudgetSlider.value);
          const actualBudget = budgetInMillions * 1000000;
          applyBudgetSettings(true, actualBudget);
          pointBudgetValue.textContent = budgetInMillions + 'M';
        }
      });
    }
  }
}
