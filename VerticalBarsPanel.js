/*
 * Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
 * Licensed under the MIT License; see LICENSE.txt in the project root.
 * SPDX-License-Identifier: MIT
 */

import * as d3 from "d3";

/**
 * VerticalBarsPanel renders vertical bar chart for attribute averages.
 * Call updateBars(selection) to update chart with new selection.
 */
export class VerticalBarsPanel {
  /**
   * @param {string} containerSelector - CSS selector for the container div
   * @param {Array<string>} attributes - List of attribute names to show
   * @param {number} barSpacing - Fixed spacing per bar in pixels (default 38px)
   * @param {boolean} drawLegend - Whether to draw the area legend for grouped bars
   * @param {string|null} legendSelector - HTML element for the legend (e.g. shared with a sibling chart); null draws it in the SVG
   */
  constructor(containerSelector, attributes, barSpacing = 38, drawLegend = true, legendSelector = null) {
    this.drawLegend = drawLegend;
    this.legendSelector = legendSelector;
    this.containerSelector = containerSelector;
    this.attributes = attributes;
    this.barSpacing = barSpacing;
    // Grouped bar layout parameters
    this.barWidth = 16;
    this.barGap = 6;
    this.groupPadding = 28;
    this.valueLabelHeadroom = 30; // room above the tallest bar for its rotated value label
    this.legendItemWidth = 90;
    this.width = Math.max(80, attributes.length * barSpacing + 20); // Calculate width based on bars
    this.height = 190;
    this.margin = { top: 24, right: 20, bottom: 60, left: 40 };
    this.svg = null;
    this.barGroup = null;
    this.scales = {
      x: d3.scaleBand().domain(attributes).range([0, this.width - this.margin.left - this.margin.right]).paddingInner(0.1).paddingOuter(0.05),
      y: d3.scaleLinear().domain([0, 1]).range([this.height - this.margin.bottom, this.margin.top])
    };
    this._initialize();
  }

  static instantiate(config) {
    return new VerticalBarsPanel(config.containerSelector, config.attributes, config.barSpacing);
  }

  _initialize() {
    const container = d3.select(this.containerSelector);
    container.html("");
    this.svg = container.append("svg")
      .attr("width", this.width)
      .attr("height", this.height)
      .attr("class", "vertical-bars-svg");
    this.barGroup = this.svg.append("g")
      .attr("transform", `translate(${this.margin.left},0)`);
    // Draw attribute labels (x axis)
    this.svg.append("g")
      .attr("transform", `translate(${this.margin.left},${this.height - this.margin.bottom})`)
      .call(d3.axisBottom(this.scales.x))
      .selectAll("text")
      .attr("font-size", "12px")
      .attr("fill", "#333")
      .attr("transform", "rotate(30)")
      .attr("text-anchor", "start");
    // Draw y axis
    this.svg.append("g")
      .attr("transform", `translate(${this.margin.left},0)`)
      .call(d3.axisLeft(this.scales.y).ticks(5));
    // Draw initial bars with fixed width (1.2em = 19px), centered in band
    const barWidth = 19;
    this.barGroup.selectAll("rect")
      .data(this.attributes)
      .enter()
      .append("rect")
      .attr("x", d => {
        const xVal = this.scales.x(d) + (this.scales.x.bandwidth() - barWidth) / 2;
        if (isNaN(xVal)) {
          //console.warn('NaN detected for <rect> x attribute (init):', { attr: d, xVal });
          return 0;
        }
        return xVal;
      })
      .attr("y", d => {
        let yVal = this.scales.y(0);
        if (isNaN(yVal)) {
          //console.warn('NaN detected for <rect> y attribute (init):', { attr: d, yVal, scale: this.scales.y });
          yVal = 0;
        }
        return yVal;
      })
      .attr("width", barWidth)
      .attr("height", 0)
      .attr("fill", "#6c757d");
    // Draw value labels
    this.barGroup.selectAll("text")
      .data(this.attributes)
      .enter()
      .append("text")
      .attr("x", d => {
        const xVal = this.scales.x(d) + this.scales.x.bandwidth() / 2;
        if (isNaN(xVal)) {
          //console.warn('NaN detected for <text> x attribute (init):', { attr: d, xVal });
          return 0;
        }
        return xVal;
      })
      .attr("y", d => {
        let yVal = this.scales.y(0) - 6;
        if (isNaN(yVal)) {
          //console.warn('NaN detected for <text> y attribute (init):', { attr: d, yVal, scale: this.scales.y });
          yVal = 0;
        }
        return yVal;
      })
      .attr("text-anchor", "middle")
      .attr("font-size", "11px")
      .attr("fill", "#222")
      .text("");
  }

  /**
   * Update bars for grouped bar chart with pre-calculated means
   * Expects selection to be an object with area keys, each containing a 'means' object with attribute means
   * @param {Object} selection - Object with area keys and means for each attribute 
   */
  updateBarsGrouped(selection){    // Grouped bar chart with pre-calculated means
    // Attributes are main groups, areas are sub-bars
    const areaKeys = Object.keys(selection); //Object.keys(selection).filter(k => k !== 'selection');
    const filteredAttrs = this.attributes;
    
    const areaMeans = {};
    areaKeys.forEach(area => {
      areaMeans[area] = selection[area].means || {};
    });
    
    const maxVal = d3.max(areaKeys.flatMap(area => filteredAttrs.map(attr => areaMeans[area][attr] || 0)));      
    const groupWidth = areaKeys.length * (this.barWidth + this.barGap) - this.barGap;      
    this.width = filteredAttrs.length * (groupWidth + this.groupPadding) + this.margin.left + this.margin.right;
    
    // Set up grouped x scale: attributes are the main groups
    const attrBand = d3.scaleBand()
      .domain(filteredAttrs)
      .range([0, this.width - this.margin.left - this.margin.right])
      .paddingInner(this.groupPadding / (groupWidth + this.groupPadding))
      .paddingOuter(0.1);
    
    // Redraw chart for new scale
    const container = d3.select(this.containerSelector);
    container.html("");
    this.svg = container.append("svg")
      .attr("width", this.width)
      .attr("height", this.height)
      .attr("class", "vertical-bars-svg");

    // Color scale for areas
    const color = d3.scaleOrdinal()
      .domain(areaKeys)
      .range(d3.schemeSet2);

    // Legend first, so the bars can start below however many rows it wraps to
    let legendExtraRows = 0;
    if(this.drawLegend && this.legendSelector) {
      // HTML legend outside the chart, so it can span sibling charts and wrap naturally
      const legend = d3.select(this.legendSelector);
      legend.html("");
      areaKeys.forEach((area) => {
        const item = legend.append("span")
          .style("display", "inline-flex")
          .style("align-items", "center")
          .style("gap", "4px")
          .style("white-space", "nowrap");
        item.append("span")
          .style("display", "inline-block")
          .style("width", "14px")
          .style("height", "14px")
          .style("background", color(area));
        item.append("span").text(`Area ${area}`);
      });
    } else if(this.drawLegend) {
      const legend = this.svg.append("g")
        .attr("class", "legend")
        .attr("transform", `translate(4,${this.margin.top - 18})`);
      // Pack items by measured label width; wrap at the visible width (the panel scrolls sideways)
      const rowHeight = 18;
      const maxWidth = Math.min(this.width, container.node().clientWidth || this.width) - 8;
      let x = 0;
      let row = 0;
      areaKeys.forEach((area) => {
        const item = legend.append("g");
        item.append("rect")
          .attr("width", 14)
          .attr("height", 14)
          .attr("y", -6)
          .attr("fill", color(area));
        const label = item.append("text")
          .attr("x", 18)
          .attr("y", 5)
          .attr("font-size", "12px")
          .text(`Area ${area}`);
        const itemWidth = 18 + (label.node().getBBox().width || this.legendItemWidth - 18);
        if (x > 0 && x + itemWidth > maxWidth) {
          x = 0;
          row++;
        }
        item.attr("transform", `translate(${x},${row * rowHeight})`);
        x += itemWidth + 12;
      });
      legendExtraRows = row;
    }

    this.scales.y.domain([0, maxVal || 1]);
    // Only reserve top margin when the legend is drawn inside the SVG
    const legendSpace = this.drawLegend && !this.legendSelector ? this.margin.top + legendExtraRows * 18 : 0;
    const y = this.scales.y.copy().range([this.height - this.margin.bottom, legendSpace + this.valueLabelHeadroom]);

    this.barGroup = this.svg.append("g")
      .attr("transform", `translate(${this.margin.left},10)`);
    
    // Draw attribute labels (x axis)
    this.svg.append("g")
      .attr("transform", `translate(${this.margin.left},${this.height - this.margin.bottom + 10})`)
      .call(d3.axisBottom(attrBand))
      .selectAll("text")
      .attr("font-size", "12px")
      .attr("fill", "#333")
      .attr("transform", "rotate(30)")
      .attr("text-anchor", "start");
    
    // Draw y axis
    this.svg.append("g")
      .attr("transform", `translate(${this.margin.left},10)`)
      .call(d3.axisLeft(y).ticks(5));

    // Draw bars for each attribute group with fixed width and spacing
    filteredAttrs.forEach(attr => {
      this.barGroup.selectAll(`rect.attr-${attr}`)
        .data(areaKeys)
        .enter()
        .append("rect")
        .attr("x", (area, i) => attrBand(attr) + i * (this.barWidth + this.barGap))
        .attr("y", area => y(areaMeans[area][attr] || 0))
        .attr("width", this.barWidth)
        .attr("height", area => y(0) - y(areaMeans[area][attr] || 0))
        .attr("fill", area => color(area))
        .attr("class", `attr-${attr}`);

      // Value labels, rotated so neighbouring labels on narrow bars don't collide
      this.barGroup.selectAll(`text.attr-${attr}`)
        .data(areaKeys)
        .enter()
        .append("text")
        .attr("transform", (area, i) => {
          const lx = attrBand(attr) + i * (this.barWidth + this.barGap) + this.barWidth / 2 - 3;
          const ly = y(areaMeans[area][attr] || 0) - 4;
          return `translate(${lx},${ly}) rotate(-60)`;
        })
        .attr("text-anchor", "start")
        .attr("font-size", "10px")
        .attr("fill", "#222")
        .text(area => {
          const val = areaMeans[area][attr];
          return val !== undefined ? val.toFixed(2) : "";
        });
    });
    return;
  }

  /**
   * Upate bars for single group (no pre-calculated means)
   * Expects selection to be an array of data points
   * @param {Array<Object>} selection 
   */
  updateBarsSingleGroup(selection){
    const filteredAttrs = this.attributes;
    // Compute averages
    const means = {};
    filteredAttrs.forEach(attr => {
      const vals = (Array.isArray(selection) ? selection : [selection]).map(d => parseFloat(d[attr])).filter(v => !isNaN(v));
      means[attr] = vals.length ? d3.mean(vals) : 0;
    });
    // Sort attributes by value descending
    let sortedAttrs = [...filteredAttrs].sort((a, b) => (means[b] || 0) - (means[a] || 0));
    // Filter out attributes with invalid means
    sortedAttrs = sortedAttrs.filter(a => typeof means[a] === 'number' && !isNaN(means[a]));
    // Find max for scaling
    const maxVal = d3.max(sortedAttrs.map(a => means[a]));
    this.width = Math.max(80, sortedAttrs.length * this.barSpacing + 80);
    this.scales.x.domain(sortedAttrs);
    this.scales.x.range([0, this.width - this.margin.left - this.margin.right]);
    this.scales.y.domain([0, maxVal || 1]);
    // Redraw chart for new scale
    const container = d3.select(this.containerSelector);
    container.html("");
    this.svg = container.append("svg")
      .attr("width", this.width)
      .attr("height", this.height)
      .attr("class", "vertical-bars-svg");
    this.barGroup = this.svg.append("g")
      .attr("transform", `translate(${this.margin.left},0)`);
    // Draw attribute labels (x axis)
    this.svg.append("g")
      .attr("transform", `translate(${this.margin.left},${this.height - this.margin.bottom})`)
      .call(d3.axisBottom(this.scales.x))
      .selectAll("text")
      .attr("font-size", "12px")
      .attr("fill", "#333")
      .attr("transform", "rotate(30)")
      .attr("text-anchor", "start");
    // Draw y axis
    this.svg.append("g")
      .attr("transform", `translate(${this.margin.left},0)`)
      .call(d3.axisLeft(this.scales.y).ticks(5));
    // Draw bars with fixed width (1.2em = 19px), centered in band
    const barWidth = 19;
    this.barGroup.selectAll("rect")
      .data(sortedAttrs)
      .enter()
      .append("rect")
      .attr("x", d => this.scales.x(d) + (this.scales.x.bandwidth() - barWidth) / 2)
      .attr("y", d => {
        const yVal = this.scales.y(means[d]);
        if (isNaN(yVal)) {
          console.warn('NaN detected for <rect> y attribute:', { attr: d, means: means[d], yVal });
        }
        return yVal;
      })
      .attr("width", barWidth)
      .attr("height", d => {
        const hVal = this.scales.y(0) - this.scales.y(means[d]);
        if (isNaN(hVal)) {
          console.warn('NaN detected for <rect> height attribute:', { attr: d, means: means[d], hVal });
        }
        return hVal;
      })
      .attr("fill", "#6c757d");
    // Draw value labels
    this.barGroup.selectAll("text")
      .data(sortedAttrs)
      .enter()
      .append("text")
      .attr("x", d => this.scales.x(d) + this.scales.x.bandwidth() / 2)
      .attr("y", d => this.scales.y(means[d]) - 6)
      .attr("text-anchor", "middle")
      .attr("font-size", "11px")
      .attr("fill", "#222")
      .text(d => means[d] !== undefined ? means[d].toFixed(2) : "");
  }

  /**
   * Update bars with averages from selection
   * @param {Array<Object>} selection - Array of selected data points
   */
  updateBars(selection) {
    // Handle empty or null selection
    if (!selection || (Array.isArray(selection) && selection.length === 0) || (typeof selection === 'object' && !Array.isArray(selection) && Object.keys(selection).length === 0)) {
      // Reset bars to zero
      this.barGroup.selectAll("rect")
        .data(this.attributes)
        .transition()
        .duration(300)
        .attr("y", this.scales.y(0))
        .attr("height", 0);
      this.barGroup.selectAll("text")
        .data(this.attributes)
        .text("");
      return;
    }

    // Check if selection is a dictionary with grouped means
    const isGrouped = (
      typeof selection === 'object' &&
      !Array.isArray(selection) &&
      Object.values(selection).every(v => v && typeof v === 'object' && v.means)
    );

    if (isGrouped) {
      this.updateBarsGrouped(selection);
    } else {
      this.updateBarsSingleGroup(selection);
    }    
  }
}
