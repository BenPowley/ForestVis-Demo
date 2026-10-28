/*
 * Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
 * Licensed under the MIT License; see LICENSE.txt in the project root.
 * SPDX-License-Identifier: MIT
 */

/**
 * HistogramSlider - A reusable D3 histogram component with brush selection
 * Uses the Factory design pattern for object creation
 */
import * as d3 from "d3";

export class HistogramSlider {
    /**
     * Private constructor - use instantiate() factory method instead
     * @private
     */
    constructor(callback, id, parentSelector, xAxisLabel, yAxisLabel, margin, width, records, invertRange) {
        this.callback = callback.bind(this);
        this.id = id;
        this.parentSelector = parentSelector;
        this.xAxisLabel = xAxisLabel;
        this.yAxisLabel = yAxisLabel;
        this.margin = margin;
        this.records = records;
        this.id = this.id;
        this.svg = null;
        this.brush = null;
        this.brushGroup = null;
        this.g = null;
        this.width = width;
        this.height = 0;
        this.xScale = null;
        this.yScale = null;
        this.invertRange = invertRange;
        this._initialize();
    }

    /**
     * Factory method to create a new HistogramSlider instance
     * @param {Function} callback - Function to call when brush selection changes, receives event, xScale, yScale
     * @param {string} parentSelector - CSS selector for the parent element
     * @param {string} xAxisLabel - Label for the x-axis
     * @param {string} yAxisLabel - Label for the y-axis
     * @param {number} width - Width of the panel
     * @param {Object} margin - Margin object with top, right, bottom, left properties
     * @param {Array} records - Array of records, each with {x0, x1, height} properties
     * @param {Boolean} invertRange - true/false for range inversion
     * @returns {HistogramSlider} A new HistogramSlider instance
     */
    static instantiate(id, parentSelector, xAxisLabel, yAxisLabel, margin, width, records, invertRange, callback) {
        return new HistogramSlider(callback, id, parentSelector, xAxisLabel, yAxisLabel, margin, width, records, invertRange);
    }

    _initialize() {
        const parent = d3.select(this.parentSelector);
        this.svg = parent.append("svg")
            .attr("width", this.width);

        this.g = this.svg.append("g")
            .attr("transform", `translate(${this.margin.left},${this.margin.top})`);

        this.width = +this.svg.attr("width") - this.margin.left - this.margin.right;
        // Keep the plot area roughly square (height tracks the inner width,
        // clamped) so the frequency chart isn't vertically stretched.
        this.height = Math.min(Math.max(Math.round(this.width), 150), 300);
        // SVG must be tall enough for the plot + x-axis label + the range slider
        // below it (40px). (Originally a fixed 440 for a 350px-tall plot.)
        this.svg.attr("height", this.height + this.margin.top + this.margin.bottom + 40);

        this._createScales();
        this._drawBars();
        this._addBrush();
        this._addAxes();
        this._addLabels();
        this._addSlider();
    }

    getSliderRange() {
        return this.sliderGroup.datum();
    }

    _createScales() {
        const xMin = d3.min(this.records, d => d.x0);
        const xMax = d3.max(this.records, d => d.x1);

        this.xScale = d3.scaleLinear()
            .domain([xMin, xMax]).nice()
            .range([0, this.width]);

        const maxHeight = d3.max(this.records, d => d.height);
        this.yScale = d3.scaleLinear()
            .domain([0, maxHeight]).nice()
            .range([this.height, 0]);
    }

    _drawBars() {
        this.g.selectAll(".bar")
            .data(this.records)
            .enter().append("rect")
            .attr("class", "bar")
            .attr("x", d => this.xScale(d.x0))
            .attr("y", d => this.yScale(d.height))
            .attr("width", d => Math.max(0, this.xScale(d.x1) - this.xScale(d.x0) - 1))
            .attr("height", d => this.height - this.yScale(d.height))
            .attr("fill", "steelblue")
            .attr("opacity", 0.7);
    }

    _addBrush() {
        this.brush = d3.brushX()
            .extent([[0, 0], [this.width, this.height]])
            .on("start", (event) => this._onBrushStart(event))
            .on("brush", (event) => this._onBrushMove(event))
            .on("end", (event) => this._onBrushed(event));

        this.brushGroup = this.g.append("g")
            .attr("class", "brush")
            .call(this.brush);
    }

    _onBrushStart(event) {
        const sliderHeight = 40;
        if (event.selection) {
            const [x0, x1] = event.selection;
            this._updateSliderFromBrush(x0, x1, sliderHeight);
            this._updateTooltipPosition(this.leftTooltip, x0, sliderHeight, x0);
            this._updateTooltipPosition(this.rightTooltip, x1, sliderHeight, x1);
            this._showTooltip(this.leftTooltip, true);
            this._showTooltip(this.rightTooltip, true);
        }
    }

    _onBrushMove(event) {
        const sliderHeight = 40;
        if (event.selection) {
            const [x0, x1] = event.selection;
            this._updateSliderFromBrush(x0, x1, sliderHeight);
            this._updateTooltipPosition(this.leftTooltip, x0, sliderHeight, x0);
            this._updateTooltipPosition(this.rightTooltip, x1, sliderHeight, x1);
            this._showTooltip(this.leftTooltip, true);
            this._showTooltip(this.rightTooltip, true);
            this.callback(event, this.xScale, this.yScale);
        }
    }

    _updateSliderFromBrush(x0, x1, sliderHeight) {
        this.leftHandle.attr("transform", `translate(${x0},${sliderHeight / 2})`);
        this.rightHandle.attr("transform", `translate(${x1},${sliderHeight / 2})`);
        this._updateSliderSelection(x0, x1);

        if (this.sliderGroup.datum()) {
            const datum = this.sliderGroup.datum();
            datum.x0 = x0;
            datum.x1 = x1;
        }
    }

    _onBrushed(event) {
        const sliderHeight = 40;

        if (event.selection) {
            const [x0, x1] = event.selection;
            this._updateSliderFromBrush(x0, x1, sliderHeight);
        } else {
            this._updateSliderFromBrush(0, this.width, sliderHeight);
        }

        this._showTooltip(this.leftTooltip, false);
        this._showTooltip(this.rightTooltip, false);
        this.callback(event, this.xScale, this.yScale);
    }

    _addAxes() {
        this.g.append("g")
            .attr("class", "axis axis--x")
            .attr("transform", `translate(0,${this.height})`)
            .call(d3.axisBottom(this.xScale).ticks(5));

        this.yAxisGroup = this.g.append("g")
            .attr("class", "axis axis--y")
            .call(d3.axisLeft(this.yScale).ticks(10));
    }

    _addLabels() {
        this.svg.append("text")
            .attr("class", "axis-label")
            .attr("x", this.width / 2 + this.margin.left)
            .attr("y", this.height + this.margin.top + this.margin.bottom + 34)
            .attr("text-anchor", "middle")
            .text(this.xAxisLabel);

        // Sit the rotated label just left of the widest tick label so large counts don't overlap it.
        const yAxisWidth = this.yAxisGroup.node().getBBox().width;
        this.svg.append("text")
            .attr("class", "axis-label")
            .attr("transform", "rotate(-90)")
            .attr("x", -this.height / 2 - this.margin.top)
            .attr("y", yAxisWidth > 0 ? Math.max(12, this.margin.left - yAxisWidth - 6) : 15)
            .attr("text-anchor", "middle")
            .text(this.yAxisLabel);
    }

    _addSlider() {
        const sliderY = this.height + this.margin.top + 10;
        const sliderHeight = 40;

        this.sliderGroup = this.svg.append("g")
            .attr("class", "slider-group")
            .attr("transform", `translate(${this.margin.left},${sliderY})`);

        this.sliderTrack = this.sliderGroup.append("path")
            .attr("class", "slider-track")
            .attr("d", `M 0,${sliderHeight / 2} L ${this.width},${sliderHeight / 2}`)
            .attr("stroke", "#ccc")
            .attr("stroke-width", 4)
            .attr("fill", "none")
            .style("cursor", "pointer");

        this.sliderSelection = this.sliderGroup.append("path")
            .attr("class", "slider-selection")
            .attr("d", `M 0,${sliderHeight / 2} L ${this.width},${sliderHeight / 2}`)
            .attr("stroke", this.invertRange ? "#ccc" : "steelblue")
            .attr("stroke-width", 8)
            .attr("fill", "none")
            .attr("opacity", 0)
            .style("cursor", "move");

        this.leftHandle = this.sliderGroup.append("path")
            .attr("class", "slider-handle left-handle")
            .attr("transform", `translate(0,${sliderHeight / 2})`)
            .attr("d", d3.symbol().type(d3.symbolCircle).size(200))
            .attr("fill", "white")
            .attr("stroke", "#ccc")
            .attr("stroke-width", 2)
            .style("cursor", "ew-resize");

        this.rightHandle = this.sliderGroup.append("path")
            .attr("class", "slider-handle right-handle")
            .attr("transform", `translate(${this.width},${sliderHeight / 2})`)
            .attr("d", d3.symbol().type(d3.symbolCircle).size(200))
            .attr("fill", "white")
            .attr("stroke", "#ccc")
            .attr("stroke-width", 2)
            .style("cursor", "ew-resize");

        this.leftTooltip = this.sliderGroup.append("text")
            .attr("class", "slider-tooltip left-tooltip")
            .attr("transform", `translate(0,${sliderHeight / 2 + 20})`)
            .attr("text-anchor", "middle")
            .attr("font-size", "12px")
            .attr("font-weight", "bold")
            .attr("fill", "steelblue")
            .style("pointer-events", "none")
            .style("opacity", 0);

        this.rightTooltip = this.sliderGroup.append("text")
            .attr("class", "slider-tooltip right-tooltip")
            .attr("transform", `translate(${this.width},${sliderHeight / 2 + 20})`)
            .attr("text-anchor", "middle")
            .attr("font-size", "12px")
            .attr("font-weight", "bold")
            .attr("fill", "steelblue")
            .style("pointer-events", "none")
            .style("opacity", 0);

        this._addSliderDrag();
        this._addTrackClick();
        this._addSelectionDrag();
    }

    _addSliderDrag() {
        const sliderHeight = 40;
        this.sliderGroup.datum({ x0: 0, x1: this.width }); //store slider positions in the datum of the sliderGroup
        const leftDrag = d3.drag()
            .on("start", () => {
                this._showTooltip(this.leftTooltip, true);
            })
            .on("drag", (event) => {
                const datum = this.sliderGroup.datum();
                const newX = Math.max(0, Math.min(datum.x1 - 1, event.x));
                datum.x0 = newX;
                this._updateHandlePosition(this.leftHandle, newX, sliderHeight, datum.x0, datum.x1);
                this._updateTooltipPosition(this.leftTooltip, newX, sliderHeight, datum.x0);
                this._showTooltip(this.leftTooltip, true);
            })
            .on("end", () => {
                this._showTooltip(this.leftTooltip, false);
            });

        const rightDrag = d3.drag()
            .on("start", () => {
                this._showTooltip(this.rightTooltip, true);
            })
            .on("drag", (event) => {
                const datum = this.sliderGroup.datum();
                const newX = Math.max(datum.x0 + 1, Math.min(this.width, event.x));
                datum.x1 = newX;
                this._updateHandlePosition(this.rightHandle, newX, sliderHeight, datum.x0, datum.x1);
                this._updateTooltipPosition(this.rightTooltip, newX, sliderHeight, datum.x1);
                this._showTooltip(this.rightTooltip, true);
            })
            .on("end", () => {
                this._showTooltip(this.rightTooltip, false);
            });
        this.leftHandle.call(leftDrag);
        this.rightHandle.call(rightDrag);

        this.leftHandle
            .on("mouseenter", () => {
                const datum = this.sliderGroup.datum();
                this._updateTooltipPosition(this.leftTooltip, datum.x0, sliderHeight, datum.x0);
                this._showTooltip(this.leftTooltip, true);
            })
            .on("mouseleave", () => {
                this._showTooltip(this.leftTooltip, false);
            });

        this.rightHandle
            .on("mouseenter", () => {
                const datum = this.sliderGroup.datum();
                this._updateTooltipPosition(this.rightTooltip, datum.x1, sliderHeight, datum.x1);
                this._showTooltip(this.rightTooltip, true);
            })
            .on("mouseleave", () => {
                this._showTooltip(this.rightTooltip, false);
            });
    }

    _updateHandlePosition(handle, newX, sliderHeight, x0, x1) {
        handle.attr("transform", `translate(${newX},${sliderHeight / 2})`);
        this._updateSliderSelection(x0, x1);
        this.brushGroup.call(this.brush.move, [x0, x1]);
    }

    _showTooltip(tooltip, show) {
        tooltip.style("opacity", show ? 1 : 0);
    }

    _updateTooltipPosition(tooltip, xPos, sliderHeight, dataX) {
        const dataValue = this.xScale.invert(dataX);
        tooltip
            .attr("transform", `translate(${xPos},${sliderHeight / 2 + 20})`)
            .text(dataValue.toFixed(2));
    }

    _addTrackClick() {
        const sliderHeight = 40;
        this.sliderTrack.on("click", (event) => {
            const [clickX] = d3.pointer(event);
            const datum = this.sliderGroup.datum();
            const currentX0 = datum.x0;
            const currentX1 = datum.x1;
            const midpoint = (currentX0 + currentX1) / 2;

            if (clickX < midpoint) {
                datum.x0 = Math.max(0, Math.min(currentX1 - 1, clickX));
            } else {
                datum.x1 = Math.max(currentX0 + 1, Math.min(this.width, clickX));
            }

            this.leftHandle.attr("transform", `translate(${datum.x0},${sliderHeight / 2})`);
            this.rightHandle.attr("transform", `translate(${datum.x1},${sliderHeight / 2})`);
            this._updateSliderSelection(datum.x0, datum.x1);

            this.brushGroup.call(this.brush.move, [datum.x0, datum.x1]);
        });
    }

    _addSelectionDrag() {
        const sliderHeight = 40;
        let startX0, startX1, startDragX;

        const selectionDrag = d3.drag()
            .on("start", (event) => {
                const datum = this.sliderGroup.datum();
                startX0 = datum.x0;
                startX1 = datum.x1;
                startDragX = event.x;

                this._updateTooltipPosition(this.leftTooltip, datum.x0, sliderHeight, datum.x0);
                this._updateTooltipPosition(this.rightTooltip, datum.x1, sliderHeight, datum.x1);
                this._showTooltip(this.leftTooltip, true);
                this._showTooltip(this.rightTooltip, true);
            })
            .on("drag", (event) => {
                const datum = this.sliderGroup.datum();
                const dx = event.x - startDragX;
                const rangeWidth = startX1 - startX0;

                let newX0 = startX0 + dx;
                let newX1 = startX1 + dx;

                if (newX0 < 0) {
                    newX0 = 0;
                    newX1 = rangeWidth;
                } else if (newX1 > this.width) {
                    newX1 = this.width;
                    newX0 = this.width - rangeWidth;
                }

                datum.x0 = newX0;
                datum.x1 = newX1;

                this.leftHandle.attr("transform", `translate(${newX0},${sliderHeight / 2})`);
                this.rightHandle.attr("transform", `translate(${newX1},${sliderHeight / 2})`);
                this._updateSliderSelection(newX0, newX1);

                this.brushGroup.call(this.brush.move, [newX0, newX1]);
                this._updateTooltipPosition(this.leftTooltip, newX0, sliderHeight, newX0);
                this._updateTooltipPosition(this.rightTooltip, newX1, sliderHeight, newX1);

                this.brushGroup.call(this.brush.move, [newX0, newX1]);
                this._updateTooltipPosition(this.leftTooltip, newX0, sliderHeight, newX0);
                this._updateTooltipPosition(this.rightTooltip, newX1, sliderHeight, newX1);
                this._showTooltip(this.leftTooltip, true);
                this._showTooltip(this.rightTooltip, true);
            })
            .on("end", () => {
                this._showTooltip(this.leftTooltip, false);
                this._showTooltip(this.rightTooltip, false);
            });

        this.sliderSelection.call(selectionDrag);
    }

    _updateSliderSelection(x0, x1) {
        const sliderHeight = 40;
        this.sliderSelection
            .attr("d", `M ${x0},${sliderHeight / 2} L ${x1},${sliderHeight / 2}`);
    }

    /**
     * Set the brush selection between two x coordinates
     * @param {number} x0 - Start x coordinate in data space
     * @param {number} x1 - End x coordinate in data space
     * @public
     */
    setBrushSelection(x0, x1) {
        if (this.brushGroup && this.brush && this.xScale) {
            const pixelX0 = this.xScale(x0);
            const pixelX1 = this.xScale(x1);
            this.brushGroup.call(this.brush.move, [pixelX0, pixelX1]);
        }
    }

    /**
     * Clear the brush selection
     * @public
     */
    clear() {
        if (this.brushGroup && this.brush) {
            this.brushGroup.call(this.brush.move, null);
        }
    }

    /**
     * Remove the histogram from the DOM
     * @public
     */
    remove() {
        if (this.svg) {
            this.svg.remove();
        }
    }

    updateWidth(width, records) {
        this.width = width;
        this.records = records;
        const datum = this.sliderGroup.datum();
        const startX0 = this.xScale.invert(datum.x0);
        const startX1 = this.xScale.invert(datum.x1);

        this.remove();
        this._initialize();
        this.setBrushSelection(startX0, startX1);
    }

    invert(bool) {
        this.invertRange = bool;
    }

    disableHistogram(disable) {
        this.sliderSelection.attr("opacity", disable ? 0 : (this.invertRange ? 1: 0.7))
        this.sliderTrack.attr("stroke", (!disable && this.invertRange) ? "steelblue" : "#ccc")
        this.g.selectAll(".selection").attr("opacity", disable ? 0 : 1);
        this.leftHandle.attr("stroke", disable ? "#ccc" : "steelblue");
        this.rightHandle.attr("stroke", disable ? "#ccc" : "steelblue");
    }

    /**
     * Gets the current filter range values from the histogram
     * @returns {Object} Object with fromValue and toValue properties
     */
    getFilterRange() {
        const { x0, x1 } = this.getSliderRange();
        return {
            fromValue: this.xScale.invert(x0),
            toValue: this.xScale.invert(x1)
        };
    }

    /**
     * Gets the full extent (min/max) of the histogram data
     * @returns {Object} Object with min and max properties
     */
    getFullExtent() {
        const extent = d3.extent(this.records, d => d.x0);
        const extentMax = d3.max(this.records, d => d.x1);
        return {
            min: extent[0],
            max: extentMax
        };
    }

    /**
     * Alias for remove() - destroys the histogram and removes it from the DOM
     */
    destroy() {
        this.remove();
    }
}
