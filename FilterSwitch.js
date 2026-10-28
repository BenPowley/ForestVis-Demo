/*
 * Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
 * Licensed under the MIT License; see LICENSE.txt in the project root.
 * SPDX-License-Identifier: MIT
 */

/**
 * Manages filter state and UI for the application.
 * Coordinates between different filter modes (histogram, UMAP) and the toggle UI element.
 */
export class FilterSwitch {
  /**
   * Creates a new FilterSwitch instance.
   * @param {Object.<string, string>} toggleElements - Dictionary mapping mode names to toggle element IDs
   *   Example: { histogram: 'fSwitch', umap: 'umapFSwitch' }
   */
  constructor(toggleElements) {
    this._toggleElements = {};
    this._mode = null; // 'histogram' or 'umap'
    this._enabled = false;
    
    // Initialize toggle elements from dictionary
    for (const [mode, elementId] of Object.entries(toggleElements)) {
      const element = document.getElementById(elementId);
      if (!element) {
        console.warn(`FilterSwitch: Toggle element with ID '${elementId}' for mode '${mode}' not found`);
      }
      this._toggleElements[mode] = element;
    }
  }
  
  /**
   * Enables the filter with the specified mode.
   * If no mode is provided, uses the previously set mode or the first available mode.
   * @param {string} [mode] - The filter mode to enable (optional)
   */
  enable(mode) {
    // If no mode provided, use the previous mode or default to first available mode
    if (mode === undefined) {
      mode = this._mode || Object.keys(this._toggleElements)[0];
    }
    
    // Validate mode exists in toggle elements
    if (!this._toggleElements[mode]) {
      console.warn(`FilterSwitch: Invalid mode '${mode}'. Expected one of: ${Object.keys(this._toggleElements).join(', ')}`);
      return;
    }

    // Uncheck all other toggle elements
    for (const [otherMode, element] of Object.entries(this._toggleElements)) {
      if (element) {
        element.checked = (otherMode === mode);
      }
    }

    this._mode = mode;
    this._enabled = true;
  }
  
  /**
   * Disables the filter and clears the mode.
   */
  disable() {
    const previousMode = this._mode;
    this._mode = null;
    this._enabled = false;
    
    // Uncheck the toggle element for the previous mode
    if (previousMode && this._toggleElements[previousMode]) {
      this._toggleElements[previousMode].checked = false;
    }
  }
  
  /**
   * Gets the current filter mode.
   * @returns {string | null} The current mode, or null if disabled
   */
  get mode() {
    return this._mode;
  }
  
  /**
   * Sets the filter mode without enabling/disabling.
   * @param {string | null} value - The mode to set
   */
  set mode(value) {
    if (value !== null && !this._toggleElements[value]) {
      console.warn(`FilterSwitch: Invalid mode '${value}'. Expected one of: ${Object.keys(this._toggleElements).join(', ')}, or null.`);
      return;
    }
    this._mode = value;
  }
  
  /**
   * Checks if the filter is currently enabled.
   * @returns {boolean} True if enabled, false otherwise
   */
  get isEnabled() {
    return this._enabled;
  }
  
  /**
   * Gets the checked state of the toggle element for the current mode.
   * @returns {boolean} True if checked, false otherwise
   */
  get checked() {
    if (this._mode && this._toggleElements[this._mode]) {
      return this._toggleElements[this._mode].checked;
    }
    return this._enabled;
  }
}
