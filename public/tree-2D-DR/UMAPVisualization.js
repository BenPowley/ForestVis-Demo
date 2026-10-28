/*
 * Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
 * Licensed under the MIT License; see LICENSE.txt in the project root.
 * SPDX-License-Identifier: MIT
 */

// UMAP Visualization Script
// Renders a scatterplot of UMAP coordinates

class UMAPVisualization {
    constructor(containerId, options = {}) {
        this.containerId = containerId;
        this.margin = options.margin || { top: 40, right: 30, bottom: 100, left: 60 };
        this.width = (options.width || 1000) - this.margin.left - this.margin.right;
        this.height = (options.height || 700) - this.margin.top - this.margin.bottom;
        this.colorByAttribute = options.colorBy || 'Height';
        this.pointRadius = options.pointRadius || 4;
        this.pointOpacity = options.pointOpacity || 0.6;
        this.nodataValue = options.nodataValue || -9999.0;
        this.onSelectionChange = options.onSelectionChange || null;
        this.modeStateId = options.modeStateId || null; // ID of DOM element storing mode
        
        this.data = null;
        this.svg = null;
        this.svgElement = null;
        this.tooltip = null;
        this.colorScale = null;
        this.zoom = null;
        this.gPoints = null; // Group for points that will be zoomed
        this.brush = null;
        this.selectedPoints = [];
        this.selectionColor = '#ff6b6b';
        this.currentTransform = d3.zoomIdentity; // Track current zoom transform
        this.isModeChanging = false; // Flag to prevent rapid mode changes
    }

    initializeSVG() {
        // Remove any existing SVG
        d3.select(`#${this.containerId}`).select('svg').remove();

        // Note: SVG dimensions will be set after createScales calculates the proper height
        this.svg = d3.select(`#${this.containerId}`);

        // Remove any existing tooltip before creating a new one
        if (this.tooltip) {
            this.tooltip.remove();
        }

        this.tooltip = d3.select('body')
            .append('div')
            .attr('class', 'umap-tooltip')
            .style('position', 'absolute')
            .style('visibility', 'hidden')
            .style('background-color', 'white')
            .style('border', '1px solid #ddd')
            .style('border-radius', '4px')
            .style('padding', '10px')
            .style('font-size', '12px')
            .style('pointer-events', 'none')
            .style('box-shadow', '0 2px 4px rgba(0,0,0,0.2)')
            .style('z-index', '10000')
            .style('max-width', '300px');
    }

    finalizeSVG() {
        // Create the actual SVG with the correct height after scales are calculated
        this.svg.select('svg').remove();
        this.svgElement = this.svg
            .append('svg')
            .attr('width', this.width + this.margin.left + this.margin.right)
            .attr('height', this.height + this.margin.top + this.margin.bottom);
        
        // Create a group for the main content
        this.svg = this.svgElement
            .append('g')
            .attr('transform', `translate(${this.margin.left},${this.margin.top})`);
        
        // Create a clipping path to prevent points from rendering outside the chart area
        this.svg.append('defs')
            .append('clipPath')
            .attr('id', `clip-${this.containerId}`)
            .append('rect')
            .attr('width', this.width)
            .attr('height', this.height);
        
        // Create group for zoomable content
        this.gPoints = this.svg.append('g')
            .attr('clip-path', `url(#clip-${this.containerId})`);
        
        // A new SVG starts unzoomed; the transform from the previous render
        // (before a resize or a regenerated UMAP) no longer applies.
        this.currentTransform = d3.zoomIdentity;

        // Setup zoom behavior
        this.zoom = d3.zoom()
            .scaleExtent([0.5, 20]) // Allow zooming from 0.5x to 20x
            .on('zoom', (event) => this.zoomed(event));
        
        // Setup brush for selection
        this.brush = d3.brush()
            .extent([[0, 0], [this.width, this.height]])
            .on('end', (event) => this.brushended(event));
        
        // Apply zoom to the SVG by default
        this.svgElement.call(this.zoom);
        
        // Add click handler to clear selection when clicking on empty space
        this.svgElement.on('click', (event) => {
            // Only clear if clicking directly on SVG background (not on points or other interactive elements)
            // Check if the click target is not a point (data-point class)
            const isPoint = event.target.classList && event.target.classList.contains('data-point');
            const isToolButton = event.target.closest('.tool-button');
            
            if (!isPoint && !isToolButton && this.selectedPoints.length > 0) {
                this.clearSelection();
            }
        });
    }

    createScales() {
        const xExtent = d3.extent(this.data, d => d.umap_1);
        const xPadding = (xExtent[1] - xExtent[0]) * 0.05;
        const xDomain = [xExtent[0] - xPadding, xExtent[1] + xPadding];
        const xRange = xDomain[1] - xDomain[0];

        const yExtent = d3.extent(this.data, d => d.umap_2);
        const yPadding = (yExtent[1] - yExtent[0]) * 0.05;
        const yDomain = [yExtent[0] - yPadding, yExtent[1] + yPadding];
        const yRange = yDomain[1] - yDomain[0];

        // Calculate aspect ratio to maintain equal scales
        const aspectRatio = yRange / xRange;
        
        // Adjust height to maintain equal scales (1:1 aspect ratio)
        // The height should be proportional to the width based on the data aspect ratio
        const adjustedHeight = this.width * aspectRatio;
        
        // Update the actual height used for rendering
        this.height = adjustedHeight;

        this.xScale = d3.scaleLinear()
            .domain(xDomain)
            .range([0, this.width]);

        this.yScale = d3.scaleLinear()
            .domain(yDomain)
            .range([this.height, 0]);

        if (this.colorByAttribute && this.data[0][this.colorByAttribute] !== undefined) {
            const colorExtent = d3.extent(this.data, d => d[this.colorByAttribute]);
            this.colorScale = d3.scaleSequential(d3.interpolateViridis)
                .domain(colorExtent);
        } else {
            this.colorScale = () => '#1f77b4';
        }
    }

    drawAxes() {
        const xAxis = d3.axisBottom(this.xScale);
        this.svg.append('g')
            .attr('class', 'x-axis')
            .attr('transform', `translate(0,${this.height})`)
            .call(xAxis);

        this.svg.append('text')
            .attr('class', 'x-label')
            .attr('text-anchor', 'middle')
            .attr('x', this.width / 2)
            .attr('y', this.height + 45)
            .style('font-size', '14px')
            .text('UMAP 1');

        const yAxis = d3.axisLeft(this.yScale);
        this.svg.append('g')
            .attr('class', 'y-axis')
            .call(yAxis);

        this.svg.append('text')
            .attr('class', 'y-label')
            .attr('text-anchor', 'middle')
            .attr('transform', 'rotate(-90)')
            .attr('x', -this.height / 2)
            .attr('y', -45)
            .style('font-size', '14px')
            .text('UMAP 2');

        this.svg.append('text')
            .attr('class', 'title')
            .attr('text-anchor', 'middle')
            .attr('x', this.width / 2)
            .attr('y', -15)
            .style('font-size', '16px')
            .style('font-weight', 'bold')
            .text(`Tree Attribute UMAP`);
        
        // Add toolbox buttons
        this.createToolbox();
        
        // Initialize mode based on stored state
        const initialMode = this.getMode();
        this.setMode(initialMode);
    }

    createToolbox() {
        const self = this;
        const buttonSize = 30;
        const buttonSpacing = 5;
        const startX = this.width - (buttonSize * 2 + buttonSpacing);
        const startY = -35;

        // Pan button
        const panButton = this.svg.append('g')
            .attr('class', 'tool-button pan-button')
            .attr('data-mode', 'pan')
            .attr('data-active', this.getMode() === 'pan' ? 'true' : 'false')
            .attr('transform', `translate(${startX}, ${startY})`)
            .style('cursor', 'pointer')
            .on('click', () => this.setMode('pan'));

        panButton.append('rect')
            .attr('width', buttonSize)
            .attr('height', buttonSize)
            .attr('rx', 3)
            .style('fill', this.getMode() === 'pan' ? '#007bff' : '#f8f9fa')
            .style('stroke', '#dee2e6')
            .style('stroke-width', 1);

        panButton.append('text')
            .attr('x', buttonSize / 2)
            .attr('y', buttonSize / 2)
            .attr('dy', '0.35em')
            .attr('text-anchor', 'middle')
            .style('font-size', '16px')
            .style('fill', this.getMode() === 'pan' ? 'white' : '#333')
            .style('pointer-events', 'none')
            .text('✋');

        // Selection button
        const selectButton = this.svg.append('g')
            .attr('class', 'tool-button select-button')
            .attr('data-mode', 'select')
            .attr('data-active', this.getMode() === 'select' ? 'true' : 'false')
            .attr('transform', `translate(${startX + buttonSize + buttonSpacing}, ${startY})`)
            .style('cursor', 'pointer')
            .on('click', () =>{ 
                this.setMode('select')
            });

        selectButton.append('rect')
            .attr('width', buttonSize)
            .attr('height', buttonSize)
            .attr('rx', 3)
            .style('fill', this.getMode() === 'select' ? '#007bff' : '#f8f9fa')
            .style('stroke', '#dee2e6')
            .style('stroke-width', 1);

        selectButton.append('text')
            .attr('x', buttonSize / 2)
            .attr('y', buttonSize / 2)
            .attr('dy', '0.35em')
            .attr('text-anchor', 'middle')
            .style('font-size', '16px')
            .style('fill', this.getMode() === 'select' ? 'white' : '#333')
            .style('pointer-events', 'none')
            .text('⬚');
    }

    zoomed(event) {
        // Store current transform
        this.currentTransform = event.transform;
        
        // Create new scales based on the zoom transform
        const newXScale = event.transform.rescaleX(this.xScale);
        const newYScale = event.transform.rescaleY(this.yScale);
        
        // Update axes
        this.svg.select('.x-axis').call(d3.axisBottom(newXScale));
        this.svg.select('.y-axis').call(d3.axisLeft(newYScale));
        
        // Update points
        this.gPoints.selectAll('.data-point')
            .attr('cx', d => newXScale(d.umap_1))
            .attr('cy', d => newYScale(d.umap_2));
    }

    getMode() {
        // Query mode from persistent DOM element
        if (this.modeStateId) {
            const modeElement = document.getElementById(this.modeStateId);
            if (modeElement) {
                return modeElement.value || 'pan';
            }
        }
        return 'pan';
    }

    setMode(mode) {
        // Prevent mode changes while one is already in progress
        if (this.isModeChanging) {
            return;
        }
        
        this.isModeChanging = true;
        
        // Store mode in persistent DOM element if available
        if (this.modeStateId) {
            const modeElement = document.getElementById(this.modeStateId);
            if (modeElement) {
                modeElement.value = mode;
            }
        }
        
        // Update data-active attributes on buttons
        this.svg.selectAll('.tool-button')
            .attr('data-active', function() {
                return d3.select(this).attr('data-mode') === mode ? 'true' : 'false';
            });
        
        // Update button styles based on data-active attribute
        this.svg.select('.pan-button rect')
            .style('fill', mode === 'pan' ? '#007bff' : '#f8f9fa');
        this.svg.select('.pan-button text')
            .style('fill', mode === 'pan' ? 'white' : '#333');
        
        this.svg.select('.select-button rect')
            .style('fill', mode === 'select' ? '#007bff' : '#f8f9fa');
        this.svg.select('.select-button text')
            .style('fill', mode === 'select' ? 'white' : '#333');
        
        // Switch between pan and brush
        if (mode === 'pan') {
            // Remove brush and enable full zoom/pan functionality
            this.svg.select('.brush').remove();
            // Reset zoom filter to allow all events (wheel + drag)
            this.zoom.filter((event) => !event.ctrlKey && !event.button);
            this.svgElement.call(this.zoom);
            
            // Reset mode changing flag after brush is cleared
            this.isModeChanging = false;
        } else if (mode === 'select') {
            // Keep zoom enabled but filter to only wheel events
            const zoomFilter = (event) => {
                // Allow wheel zoom, prevent drag panning
                return event.type === 'wheel';
            };
            
            this.zoom.filter(zoomFilter);
            this.svgElement.call(this.zoom);
            
            // Add brush for selection
            this.svg.append('g')
                .attr('class', 'brush')
                .call(this.brush);
            
            // Reset mode changing flag after a short delay to ensure brush is ready
            setTimeout(() => {
                this.isModeChanging = false;
            }, 100);
        }
    }

    brushended(event) {
        if (!event.selection) {
            // Don't clear selection if brush is just cleared - keep previous selection
            return;
        }
        
        const [[x0, y0], [x1, y1]] = event.selection;
        
        // Create transformed scales based on current zoom/pan state, read from
        // the SVG that d3.zoom actually tracks
        this.currentTransform = d3.zoomTransform(this.svgElement.node());
        const transformedXScale = this.currentTransform.rescaleX(this.xScale);
        const transformedYScale = this.currentTransform.rescaleY(this.yScale);
        
        // Find points within the brush selection using transformed coordinates
        this.selectedPoints = [];
        this.data.forEach(d => {
            const cx = transformedXScale(d.umap_1);
            const cy = transformedYScale(d.umap_2);
            if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) {
                this.selectedPoints.push(d);
            }
        });
        
        this.updateSelectionHighlight();
        
        // Call callback with selected points
        if (this.onSelectionChange) {
            this.onSelectionChange(this.selectedPoints);
        }
        
        // Clear the brush visual immediately
        const brushGroup = this.svg.select('.brush');
        brushGroup.call(this.brush.move, null);
        
        // Also explicitly hide the selection overlay
        brushGroup.select('.selection').style('display', 'none');
    }

    updateSelectionHighlight() {
        const self = this;
        
        // Create a Set of selected PredInstan IDs for efficient lookup
        const selectedIds = new Set(
            this.selectedPoints
                .map(d => d.PredInstan)
                .filter(id => id !== undefined)
        );
        
        this.gPoints.selectAll('.data-point')
            .style('fill', d => {
                // Keep original color for all points
                return this.colorScale(d[this.colorByAttribute]);
            })
            .style('stroke', d => {
                return selectedIds.has(d.PredInstan) ? '#fff' : 'none';
            })
            .style('stroke-width', d => {
                return selectedIds.has(d.PredInstan) ? 1.5 : 0;
            })
            .style('opacity', d => {
                if (this.selectedPoints.length === 0) return this.pointOpacity;
                return selectedIds.has(d.PredInstan) ? 1 : this.pointOpacity * 0.3;
            })
            // Lift selected points above the dimmed ones drawn after them
            .filter(d => selectedIds.has(d.PredInstan))
            .raise();
    }

    getSelectedPoints() {
        return this.selectedPoints;
    }

    /**
     * Select points by tree ID, e.g. from the minimap's box/lasso/polygon tools.
     * @param {Array} ids PredInstan values
     * @param {'replace'|'add'|'subtract'} combine how to merge with the current selection
     */
    selectByPredInstanceIds(ids, combine = 'replace') {
        const incoming = new Set(ids);
        const current = new Set(this.selectedPoints.map(d => d.PredInstan));
        let keep;
        if (combine === 'add') {
            keep = d => current.has(d.PredInstan) || incoming.has(d.PredInstan);
        } else if (combine === 'subtract') {
            keep = d => current.has(d.PredInstan) && !incoming.has(d.PredInstan);
        } else {
            keep = d => incoming.has(d.PredInstan);
        }
        this.selectedPoints = this.data.filter(keep);
        this.updateSelectionHighlight();
        if (this.onSelectionChange) {
            this.onSelectionChange(this.selectedPoints);
        }
    }

    clearSelection() {
        this.selectedPoints = [];
        this.updateSelectionHighlight();
        if (this.onSelectionChange) {
            this.onSelectionChange([]);
        }
    }

    refreshSelection() {
        // Query current mode from DOM
        const currentMode = this.getMode();
        
        // Update button visual states to match current mode
        this.svg.select('.pan-button rect')
            .style('fill', currentMode === 'pan' ? '#007bff' : '#f8f9fa');
        this.svg.select('.pan-button text')
            .style('fill', currentMode === 'pan' ? 'white' : '#333');
        
        this.svg.select('.select-button rect')
            .style('fill', currentMode === 'select' ? '#007bff' : '#f8f9fa');
        this.svg.select('.select-button text')
            .style('fill', currentMode === 'select' ? 'white' : '#333');
        
        // Re-apply selection highlights
        this.updateSelectionHighlight();
        
    }

    drawPoints() {
        const self = this;

        // Create a Set of selected PredInstan IDs for applying selection state
        const selectedIds = new Set(
            this.selectedPoints
                .map(d => d.PredInstan)
                .filter(id => id !== undefined)
        );
        const hasSelection = selectedIds.size > 0;

        this.gPoints.selectAll('.data-point')
            .data(this.data)
            .enter()
            .append('circle')
            .attr('class', 'data-point')
            .attr('cx', d => this.xScale(d.umap_1))
            .attr('cy', d => this.yScale(d.umap_2))
            .attr('r', this.pointRadius)
            .style('fill', d => this.colorScale(d[this.colorByAttribute]))
            .style('opacity', d => {
                // Apply selection opacity if there's an active selection
                if (hasSelection) {
                    return selectedIds.has(d.PredInstan) ? 1 : this.pointOpacity * 0.3;
                }
                return this.pointOpacity;
            })
            .style('stroke', d => selectedIds.has(d.PredInstan) ? '#fff' : 'none')
            .style('stroke-width', d => selectedIds.has(d.PredInstan) ? 1.5 : 0)
            .on('mouseover', function(event, d) {
                d3.select(this)
                    .style('stroke', 'none')
                    .style('opacity', 1)
                    .attr('r', self.pointRadius * 1.5);

                let tooltipContent = `<strong>UMAP Coordinates:</strong><br/>`;
                tooltipContent += `UMAP 1: ${d.umap_1.toFixed(3)}<br/>`;
                tooltipContent += `UMAP 2: ${d.umap_2.toFixed(3)}<br/><br/>`;
                tooltipContent += `<strong>Attributes:</strong><br/>`;
                
                const keyAttributes = ['PredInstan', 'Height', 'AvgNDVI', 'AvgGNDVI', 'AvgLCI', 'AvgNDRE', 'AvgOSAVI'];
                keyAttributes.forEach(attr => {
                    if (d[attr] !== undefined && d[attr] !== self.nodataValue) {
                        tooltipContent += `${attr}: ${typeof d[attr] === 'number' ? d[attr].toFixed(3) : d[attr]}<br/>`;
                    }
                });

                self.tooltip
                    .html(tooltipContent)
                    .style('visibility', 'visible');
            })
            .on('mousemove', function(event) {
                self.tooltip
                    .style('top', (event.pageY - 10) + 'px')
                    .style('left', (event.pageX + 10) + 'px');
            })
            .on('mouseout', function(event, d) {
                // Check current selection state dynamically
                const currentSelectedIds = new Set(
                    self.selectedPoints
                        .map(point => point.PredInstan)
                        .filter(id => id !== undefined)
                );
                const currentHasSelection = currentSelectedIds.size > 0;
                const isSelected = currentSelectedIds.has(d.PredInstan);
                
                const restoreOpacity = currentHasSelection 
                    ? (isSelected ? 1 : self.pointOpacity * 0.3)
                    : self.pointOpacity;
                
                d3.select(this)
                    .style('opacity', restoreOpacity)
                    .style('stroke', isSelected ? '#fff' : 'none')
                    .style('stroke-width', isSelected ? 1.5 : 0)
                    .attr('r', self.pointRadius);

                self.tooltip.style('visibility', 'hidden');
            });
    }

    drawLegend() {
        if (!this.colorScale || this.colorByAttribute === null) return;

        const legendWidth = Math.min(this.width * 0.6, 400);
        const legendHeight = 20;
        const legendX = this.width / 2 - legendWidth / 2;
        const legendY = this.height + 50;

        const defs = this.svg.append('defs').attr('class', 'legend-defs');
        const linearGradient = defs.append('linearGradient')
            .attr('id', 'legend-gradient')
            .attr('x1', '0%')
            .attr('y1', '0%')
            .attr('x2', '100%')
            .attr('y2', '0%');

        const stops = 10;
        const colorExtent = this.colorScale.domain();
        for (let i = 0; i <= stops; i++) {
            const t = i / stops;
            const value = colorExtent[0] + t * (colorExtent[1] - colorExtent[0]);
            linearGradient.append('stop')
                .attr('offset', `${t * 100}%`)
                .attr('stop-color', this.colorScale(value));
        }

        this.svg.append('rect')
            .attr('class', 'legend-rect')
            .attr('x', legendX)
            .attr('y', legendY)
            .attr('width', legendWidth)
            .attr('height', legendHeight)
            .style('fill', 'url(#legend-gradient)')
            .style('stroke', '#333')
            .style('stroke-width', 1);

        const legendScale = d3.scaleLinear()
            .domain(colorExtent)
            .range([0, legendWidth]);

        const legendAxis = d3.axisBottom(legendScale)
            .ticks(5)
            .tickFormat(d3.format('.2f'));

        this.svg.append('g')
            .attr('class', 'legend-axis')
            .attr('transform', `translate(${legendX},${legendY + legendHeight})`)
            .call(legendAxis);

        this.svg.append('text')
            .attr('class', 'legend-title')
            .attr('x', legendX - 10)
            .attr('y', legendY + legendHeight / 2)
            .attr('dy', '0.35em')
            .style('font-size', '12px')
            .style('font-weight', 'bold')
            .style('text-anchor', 'end')
            .text(this.colorByAttribute);
    }

    async render(data) {
        this.data = data;
        
        if (!this.data || this.data.length === 0) {
            console.error('No valid data to visualize');
            return;
        }

        this.initializeSVG();
        this.createScales();
        this.finalizeSVG(); // Create SVG with correct height after scales are calculated
        this.drawAxes();
        this.drawPoints();
        this.drawLegend();

    }

    updateColorAttribute(attribute) {
        if (!this.data || this.data.length === 0) return;

        this.colorByAttribute = attribute;

        // Update color scale
        const colorExtent = d3.extent(this.data, d => d[attribute]);
        this.colorScale = d3.scaleSequential(d3.interpolateViridis)
            .domain(colorExtent);

        this.gPoints.selectAll('.data-point')
            .style('fill', d => this.colorScale(d[this.colorByAttribute]));

        this.svg.selectAll('.legend-axis').remove();
        this.svg.selectAll('.legend-rect').remove();
        this.svg.selectAll('.legend-title').remove();
        // Only the legend gradient: the other defs hold the points' clip path
        this.svg.selectAll('defs.legend-defs').remove();

        this.drawLegend();
    }

    updatePointSize(size) {
        if (!this.data || this.data.length === 0) return;

        this.pointRadius = size;

        this.gPoints.selectAll('.data-point')
            .transition()
            .duration(100)
            .attr('r', this.pointRadius);
    }

    updateSize(width, height) {
        if (!this.data || this.data.length === 0) return;

        // Calculate new dimensions (subtract margins)
        const newWidth = width - this.margin.left - this.margin.right;
        const newHeight = height - this.margin.top - this.margin.bottom;

        // Only re-render if dimensions have changed significantly (more than 5px)
        if (Math.abs(this.width - newWidth) < 5 && Math.abs(this.height - newHeight) < 5) {
            return;
        }

        // Update dimensions
        this.width = newWidth;
        this.height = newHeight;

        // Re-render the entire visualization
        this.render(this.data);
    }
}
