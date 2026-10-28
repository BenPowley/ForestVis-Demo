/*
 * Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
 * Licensed under the MIT License; see LICENSE.txt in the project root.
 * SPDX-License-Identifier: MIT
 */

/**
 * Retrieves the default rendering panel settings from the attribute configuration object.
 * @param {Object} attributeConfig - The attribute configuration object
 * @returns {Object} The renderingPanel settings or defaults
 */
export function getDefaultRenderingPanelSettings(attributeConfig) {
  if (attributeConfig && attributeConfig.renderingPanel) {
    return attributeConfig.renderingPanel;
  }
  // Fallback defaults if not present
  return {
    mainPointSize: 1.0,
    mainOpacity: 1.0,
    basePointSize: 1.0,
    baseOpacity: 1.0,
    subdivisionThreshold: 1.0,
    pointBudget: 10000000,
    enableEDL: true,
    enableInpainting: true,
    enablePointCloudOcclusion: true
  };
}

/**
 * Retrieves a specific default value for a rendering setting from the attribute configuration.
 * @param {Object} attributeConfig - The attribute configuration object
 * @param {string} key - The renderingPanel setting key
 * @returns {*} The value for the key, or undefined if not found
 */
export function getDefaultRenderingSetting(attributeConfig, key) {
  if (attributeConfig && attributeConfig.renderingPanel && key in attributeConfig.renderingPanel) {
    return attributeConfig.renderingPanel[key];
  }
  return undefined;
}
import * as Copc from 'copc';

/**
 * Extracts the nodata VLR from a COPC file.
 * @param {string} filename - The URL or path to the COPC file
 * @returns {Promise<Uint8Array>} The VLR data
 */
async function extractNodataVLR(filename) {
  const copc = await Copc.Copc.create(filename)  
  const nodataVlr = Copc.Las.Vlr.find(copc.vlrs, 'nodata', 0)
  if (!nodataVlr) {
    throw new Error('VLR with user_id "nodata" not found in the COPC file')
  }
  const vlrData = await Copc.Las.Vlr.fetch(filename, nodataVlr)
  return vlrData
}

/**
 * Retrieves and parses the nodata VLR from a COPC source.
 * @param {string} copcSourceUrl - The URL to the COPC source
 * @returns {Promise<Object|null>} Parsed JSON data from the VLR, or null on error
 */
export async function getNoDataVLR(copcSourceUrl) {
  try {
    const filename = copcSourceUrl;
    if (!filename) {
      console.error('No URL provided');
      return null;
    }
    const absoluteUrl = new URL(filename, window.location.href).href;
    const vlrData = await extractNodataVLR(absoluteUrl);
    const textDecoder = new TextDecoder('utf-8');
    const jsonString = textDecoder.decode(vlrData);
    const parsedData = JSON.parse(jsonString);

    return parsedData;
  } catch (error) {
    console.error('Error retrieving nodata VLR:', error);
    return null;
  }
}

/**
 * Fetches and parses a QGIS color categorization QML file.
 * @param {string} qmlUrl - The URL to the QML file
 * @returns {Promise<Array>} Array of color arrays [r, g, b, a]
 */
export async function fetchQGISColorCategorization(qmlUrl) {
  try {
    const response = await fetch(qmlUrl);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const qmlText = await response.text();
    
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(qmlText, 'text/xml');
    
    const parserError = xmlDoc.querySelector('parsererror');
    if (parserError) {
      throw new Error('XML parsing error: ' + parserError.textContent);
    }
    
    const renderer = xmlDoc.querySelector('renderer');
    if (!renderer) {
      throw new Error('No renderer tag found in QML file');
    }
    
    const categories = renderer.querySelectorAll('categories category');
    if (categories.length === 0) {
      throw new Error('No categories found in QML file');
    }
    
    // Extract colors from each category
    const colors = [];
    categories.forEach(category => {
      const colorAttr = category.getAttribute('color');
      if (colorAttr) {
        // Parse color string (format: "r,g,b,a" or similar)
        const colorParts = colorAttr.split(',').map(part => parseInt(part.trim()));
        if (colorParts.length >= 3) {
          // Ensure we have at least RGB, add alpha if missing
          const color = [
            Math.max(0, Math.min(255, colorParts[0])), // R
            Math.max(0, Math.min(255, colorParts[1])), // G
            Math.max(0, Math.min(255, colorParts[2])), // B
            colorParts[3] !== undefined ? Math.max(0, Math.min(255, colorParts[3])) : 255 // A
          ];
          colors.push(color);
        }
      }
    });
    
    return colors;
    
  } catch (error) {
    console.error('Error fetching or parsing QML file:', error);
    throw error;
  }
}

/**
 * Fetches and parses the attribute configuration JSON file.
 * @param {string} configUrl - The URL to the configuration file
 * @returns {Promise<Object>} Parsed configuration object
 */
export async function fetchAttributeConfig(configUrl = './attributeConfig.json') {
  try {
    const response = await fetch(configUrl);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const config = await response.json();
    return config;
  } catch (error) {
    console.error('Error fetching attribute configuration:', error);
    throw error;
  }
}
