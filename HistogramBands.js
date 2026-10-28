/*
 * Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
 * Licensed under the MIT License; see LICENSE.txt in the project root.
 * SPDX-License-Identifier: MIT
 */

/* The histogram bands class takes a geojson layer as input and renders the histogram for selected points.
using a provided list of attributes, ranges for each attribute, and bucket counts.
 The histogram  displays grouped histograms for each attribute provided in the input list. Each group corresponds to a histogram bucket defined by the ranges provided. 
 Each bar within a group represents the count for that attribute in that bucket.
 */

import * as d3 from "d3";
import { fromUrl } from "geotiff";
import { density1d } from "fast-kde";
import proj4 from "proj4";
import geokeysToProj4 from "geotiff-geokeys-to-proj4";

export class HistogramBands {
  constructor() {
    this.geoJsonLayer = null;
    this.attributes = [];
    this.ranges = {};
    this.colors = null;
    this.callback = null;
    this.parentSelector = null;
    this.width = 0;
    this.height = 0;
    this.margin = { top: 20, right: 20, bottom: 140, left: 40 };
    this.svg = null;
    this.chartGroup = null;
    this.selectedPredInstance = null;
    this.instanceZFilterUrl = null; // Now supports array
    this.dataImageUrl = null; // Now supports array
    this.bandMapping = null; // Maps attribute names to band indices, e.g., { 'NDVI_1': 0 } or { 'RGB_1': 0, 'RGB_2': 1, 'RGB_3': 2 }
    this.projection = null; // Proj4 string for the point cloud/feature coordinates
    this.kdeData = null; // Store KDE data for each attribute
    this.showBars = true; // Toggle visibility of histogram bars
    this.attributeLabels = null; // Maps attribute names to display labels, e.g., { 'RGB_1': 'Red' }
  }

  // Fast KDE implementation using fast-kde library
  _computeFastKDE(data, bandwidth = null, extent = null) {
    if (!data || data.length === 0) {
      return { x: [], y: [] };
    }

    // Filter out NaN and invalid values
    const validData = data.filter(v => !isNaN(v) && isFinite(v));
    if (validData.length === 0) {
      return { x: [], y: [] };
    }

    // Configure options for density1d
    const options = {};
    if (bandwidth !== null) {
      options.bandwidth = bandwidth;
    }
    if (extent !== null) {
      options.extent = extent;
    }

    // Compute 1D density estimation using fast-kde
    const kde = density1d(validData, options);

    // Convert to array of {x, y} points
    const points = Array.from(kde);

    // Separate into x and y arrays
    const x = points.map(p => p.x);
    const y = points.map(p => p.y);

    return { x, y };
  }
/* Initialize the HistogramBands instance with provided parameters.
  geoJsonLayer: The GeoJSON layer containing features with histogram data.
  attributes: List of attribute names to include in the histogram, bucket counts are read from these attributes as lists.
  ranges: An object defining min and max ranges for each attribute.
  colors: Optional array of colors for the histogram bars.
  callback: Optional callback function to be called after rendering.
  parentSelector: The CSS selector of the parent element to attach the SVG.
*/
  static initialize({
    geoJsonLayer,
    attributes,
    ranges,
    colors = null,
    callback,
    parentSelector,
    width = 800,
    height = 310,
    margin = { top: 20, right: 20, bottom: 140, left: 60 },
    instanceZFilterUrl = null,
    dataImageUrl = null,
    bandMapping = null,
    projection = null,
    attributeLabels = null,
    showBars = true
  }) {
    const instance = new HistogramBands();
    instance.geoJsonLayer = geoJsonLayer;
    instance.attributes = attributes;
    instance.ranges = ranges;
    instance.colors = colors;
    instance.callback = callback;
    instance.parentSelector = parentSelector;
    instance.width = width;
    instance.height = height;
    instance.margin = margin;
    instance.instanceZFilterUrl = instanceZFilterUrl; // Should be array
    instance.dataImageUrl = dataImageUrl; // Should be array
    instance.bandMapping = bandMapping;
    instance.projection = projection;
    instance.attributeLabels = attributeLabels;
    instance.showBars = showBars;

    instance._setupSVG();
    instance.drawEmptyAxes();
    return instance;
  }

  _getAttributeLabel(attr) {
    return this.attributeLabels && this.attributeLabels[attr] ? this.attributeLabels[attr] : attr;
  }

  _setupSVG() {
    const parent = d3.select(this.parentSelector);
    parent.selectAll("*").remove();

    this.svg = parent
      .append("svg")
      .style("display", "block")
      .attr("width", this.width)
      .attr("height", this.height);

    this.chartGroup = this.svg
      .append("g")
      .attr("transform", `translate(${this.margin.left},${this.margin.top})`);
  }
/*
  When the histogram is redrawn, read the variables X_min, Y_min, Z_min, X_max, Y_max, Z_max from the point selected by the predInstanceId. 
  Then use these bounding coordinates to retrieve data using GeoTIFF.js from each of the images instanceZFilter, 
  aerialImage, and ndviImage. For all of the pixels of instanceZFilter that match the value of predInstanceId, 
  retrieve the value of the  corresponding pixels in each band of ndvi and the rgb images into 1D arrays, and then compute the fast KDE for each of these arrays.
*/
  async calculateFastKDE(predInstanceId) {
    try {
      // Find the feature with the selected PredInstance
      const features = this.geoJsonLayer.features || [];
      const selectedFeature = features.find(
        (f) => f.properties.PredInstan === predInstanceId
      );

      if (!selectedFeature) {
        console.warn(`No feature found with PredInstan: ${predInstanceId}`);
        this.kdeData = null;
        return;
      }

      const props = selectedFeature.properties;
      const bounds = {
        xMin: props.X_min,
        yMin: props.Y_min,
        zMin: props.Z_min,
        xMax: props.X_max,
        yMax: props.Y_max,
        zMax: props.Z_max
      };

      // Determine area index from area_number property
      const areaIndex = (typeof props.area_numbe === 'number') ? props.area_numbe : 0;

      // Support arrays for instanceZFilterUrl and dataImageUrl
      let instanceZFilterUrlArr = Array.isArray(this.instanceZFilterUrl) ? this.instanceZFilterUrl : [this.instanceZFilterUrl];
      let dataImageUrlArr = Array.isArray(this.dataImageUrl) ? this.dataImageUrl : [this.dataImageUrl];

      // Clamp areaIndex to available arrays
      const izfUrl = instanceZFilterUrlArr[Math.max(0, Math.min(areaIndex, instanceZFilterUrlArr.length - 1))];
      const dataUrl = dataImageUrlArr[Math.max(0, Math.min(areaIndex, dataImageUrlArr.length - 1))];

      // Load GeoTIFF files with range request support
      let instanceZFilterTiff, dataTiff;
      try {
        [instanceZFilterTiff, dataTiff] = await Promise.all([
          fromUrl(izfUrl),
          fromUrl(dataUrl)
        ]);
      } catch (error) {
        console.error('Error loading GeoTIFF files:', error);
        if (error.message && error.message.includes('416')) {
          console.error(`The TIFF file may be corrupted or truncated. File: ${dataUrl || izfUrl}`);
        }
        throw error;
      }

      // Get first image from each TIFF
      let instanceZFilterImage, dataImage;
      try {
        [instanceZFilterImage, dataImage] = await Promise.all([
          instanceZFilterTiff.getImage(),
          dataTiff.getImage()
        ]);
      } catch (error) {
        console.error('Error reading GeoTIFF image headers:', error);
        if (error.message && error.message.includes('416')) {
          console.error(`The TIFF file metadata references data beyond the file end. The file is likely corrupted or truncated.`);
          console.error(`File: ${this.dataImageUrl}`);
        }
        throw error;
      }

      // Get image projections from GeoTIFF metadata
      const instanceZFilterGeoKeys = instanceZFilterImage.getGeoKeys();
      const dataImageGeoKeys = dataImage.getGeoKeys();
      
      // Get proj4 definitions from images (using WKT if available, or constructing from GeoKeys)
      const instanceZFilterProj = this._getProj4FromGeoKeys(instanceZFilterGeoKeys, instanceZFilterImage);
      const dataImageProj = this._getProj4FromGeoKeys(dataImageGeoKeys, dataImage);
      

      // Transform bounding box and calculate window for instance filter image
      const transformToInstanceFilter = proj4(this.projection, instanceZFilterProj);
      const [xMinInstFilter, yMinInstFilter] = transformToInstanceFilter.forward([bounds.xMin, bounds.yMin]);
      const [xMaxInstFilter, yMaxInstFilter] = transformToInstanceFilter.forward([bounds.xMax, bounds.yMax]);
      
      const instFilterOrigin = instanceZFilterImage.getOrigin();
      const instFilterResolution = instanceZFilterImage.getResolution();
      const instFilterImageWidth = instanceZFilterImage.getWidth();
      const instFilterImageHeight = instanceZFilterImage.getHeight();
      
      let instFilterLeft = Math.floor((xMinInstFilter - instFilterOrigin[0]) / instFilterResolution[0]);
      let instFilterTop = Math.floor((instFilterOrigin[1] - yMaxInstFilter) / Math.abs(instFilterResolution[1]));
      let instFilterRight = Math.ceil((xMaxInstFilter - instFilterOrigin[0]) / instFilterResolution[0]);
      let instFilterBottom = Math.ceil((instFilterOrigin[1] - yMinInstFilter) / Math.abs(instFilterResolution[1]));
      
      // Clamp window coordinates to image bounds
      instFilterLeft = Math.max(0, Math.min(instFilterLeft, instFilterImageWidth - 1));
      instFilterTop = Math.max(0, Math.min(instFilterTop, instFilterImageHeight - 1));
      instFilterRight = Math.max(instFilterLeft + 1, Math.min(instFilterRight, instFilterImageWidth));
      instFilterBottom = Math.max(instFilterTop + 1, Math.min(instFilterBottom, instFilterImageHeight));
      
      const instFilterWindow = [instFilterLeft, instFilterTop, instFilterRight, instFilterBottom];

      // Transform bounding box and calculate window for data image
      const transformToDataImage = proj4(this.projection, dataImageProj);
      const [xMinData, yMinData] = transformToDataImage.forward([bounds.xMin, bounds.yMin]);
      const [xMaxData, yMaxData] = transformToDataImage.forward([bounds.xMax, bounds.yMax]);
      
      const dataOrigin = dataImage.getOrigin();
      const dataResolution = dataImage.getResolution();
      const dataImageWidth = dataImage.getWidth();
      const dataImageHeight = dataImage.getHeight();
      
      let dataLeft = Math.floor((xMinData - dataOrigin[0]) / dataResolution[0]);
      let dataTop = Math.floor((dataOrigin[1] - yMaxData) / Math.abs(dataResolution[1]));
      let dataRight = Math.ceil((xMaxData - dataOrigin[0]) / dataResolution[0]);
      let dataBottom = Math.ceil((dataOrigin[1] - yMinData) / Math.abs(dataResolution[1]));
      
      // Clamp window coordinates to image bounds
      dataLeft = Math.max(0, Math.min(dataLeft, dataImageWidth - 1));
      dataTop = Math.max(0, Math.min(dataTop, dataImageHeight - 1));
      dataRight = Math.max(dataLeft + 1, Math.min(dataRight, dataImageWidth));
      dataBottom = Math.max(dataTop + 1, Math.min(dataBottom, dataImageHeight));
      
      const dataWindow = [dataLeft, dataTop, dataRight, dataBottom];
      
      // Read data from both images using their respective window coordinates
      const [instanceZFilterData, imageData] = await Promise.all([
        instanceZFilterImage.readRasters({ window: instFilterWindow, fillValue: NaN }),
        dataImage.readRasters({ window: dataWindow, fillValue: NaN })
      ]);

      const instanceZFilterArray = instanceZFilterData[0]; // First band
      const instFilterWidth = instanceZFilterData.width;
      const instFilterHeight = instanceZFilterData.height;
      const dataWidth = imageData.width;
      const dataHeight = imageData.height;
      // GDAL nodata (e.g. -9999) is a finite number, so it must be excluded explicitly.
      // Compare at float32 precision so values like -3.4028235e+38 match the stored pixels.
      const noData = dataImage.getGDALNoData();
      const noDataF32 = noData === null ? null : Math.fround(noData);

      const dataArrays = {};
      Object.keys(this.bandMapping).forEach(attr => {
        dataArrays[attr] = [];
      });

      for (let instY = 0; instY < instFilterHeight; instY++) {
        for (let instX = 0; instX < instFilterWidth; instX++) {
          const instIdx = instY * instFilterWidth + instX;
          const instanceValue = instanceZFilterArray[instIdx];

          if (instanceValue === predInstanceId) {
            const geoX = instFilterOrigin[0] + (instFilterLeft + instX + 0.5) * instFilterResolution[0];
            const geoY = instFilterOrigin[1] - (instFilterTop + instY + 0.5) * Math.abs(instFilterResolution[1]);
            
            // Transform to data image coordinate system if projections differ
            let dataGeoX = geoX;
            let dataGeoY = geoY;
            if (instanceZFilterProj !== dataImageProj) {
              const transformInstToData = proj4(instanceZFilterProj, dataImageProj);
              [dataGeoX, dataGeoY] = transformInstToData.forward([geoX, geoY]);
            }
            
            // Convert to data image pixel coordinates
            const dataX = Math.floor((dataGeoX - dataOrigin[0]) / dataResolution[0]) - dataLeft;
            const dataY = Math.floor((dataOrigin[1] - dataGeoY) / Math.abs(dataResolution[1])) - dataTop;
            
            if (dataX >= 0 && dataX < dataWidth && dataY >= 0 && dataY < dataHeight) {
              const dataIdx = dataY * dataWidth + dataX;
              
              Object.entries(this.bandMapping).forEach(([attr, bandIndex]) => {
                if (imageData.length > bandIndex) {
                  const value = imageData[bandIndex][dataIdx];
                  if (!isNaN(value) && isFinite(value) && Math.fround(value) !== noDataF32) {
                    dataArrays[attr].push(value);
                  }
                }
              });
            }
          }
        }
      }

      // Calculate KDE for each attribute and store pixel counts
      this.kdeData = {};
      Object.entries(dataArrays).forEach(([attr, values]) => {
        if (values.length > 0) {
          const kdeData = this._computeFastKDE(values)
          this.kdeData[attr] = {
            kde: kdeData,
            pixelCount: values.length  // Store the number of pixels retrieved
          };
        }
      });

    } catch (error) {
      console.error('Error calculating KDE:', error);
      this.kdeData = null;
    }
  }

  // Helper method to get proj4 string from GeoTIFF GeoKeys
  _getProj4FromGeoKeys(geoKeys, image) {
    try {
      const result = geokeysToProj4.toProj4(geoKeys, image.fileDirectory);
      if (result) {
        const proj4String = typeof result === 'string' ? result : result.proj4;
        if (proj4String) {
          return proj4String;
        }
      }
    } catch (e) {
      console.warn('Failed to convert GeoKeys to proj4:', e);
    }

    // Fall back to EPSG code from GeoKeys
    if (geoKeys.ProjectedCSTypeGeoKey) {
      return `EPSG:${geoKeys.ProjectedCSTypeGeoKey}`;
    } else if (geoKeys.GeographicTypeGeoKey) {
      return `EPSG:${geoKeys.GeographicTypeGeoKey}`;
    }
    
    // Default to WGS84 if no projection info found
    console.warn('No projection information found in GeoTIFF, defaulting to EPSG:4326');
    return 'EPSG:4326';
  }
/* Redraw the histogram for the feature with the specified PredInstance ID.
predInstanceId: The PredInstance ID of the feature to render the histogram for.
*/
  async redraw(predInstanceId) {
    this.selectedPredInstance = predInstanceId;

    const features = this.geoJsonLayer.features || [];
    const selectedFeature = features.find(
      (f) => f.properties.PredInstan === predInstanceId
    );

    if (!selectedFeature) {
      console.warn(`No feature found with PredInstan: ${predInstanceId}`);
      this._clearChart();
      return;
    }

    const properties = selectedFeature.properties;

    if (this.instanceZFilterUrl && this.dataImageUrl && this.bandMapping) {
      await this.calculateFastKDE(predInstanceId);
    }
    const histogramData = this._prepareHistogramData(properties);
    this._drawGroupedHistogram(histogramData);

    // Call the callback if provided
    if (this.callback) {
      this.callback({ histogram: this, predInstanceId });
    }
  }

  _prepareHistogramData(properties) {
    const data = [];
    const firstAttr = this.attributes[0];
    const firstAttrData = properties[firstAttr];
    if (!firstAttrData || !Array.isArray(firstAttrData)) {
      return [];
    }

    const numBuckets = firstAttrData.length;

    for (let bucketIndex = 0; bucketIndex < numBuckets; bucketIndex++) {
      const bucketData = {
        bucketIndex,
        values: []
      };

      // For each attribute
      this.attributes.forEach((attr) => {
        const attrData = properties[attr];
        if (attrData && Array.isArray(attrData)) {
          const min = this.ranges[`${attr}_min`];
          const max = this.ranges[`${attr}_max`];
          const bucketRange = this._getBucketRange(min, max, numBuckets, bucketIndex);

          bucketData.values.push({
            attribute: attr,
            count: attrData[bucketIndex] || 0,
            rangeLabel: bucketRange
          });
        }
      });

      data.push(bucketData);
    }

    return data;
  }

  _getBucketRange(min, max, numBuckets, bucketIndex) {
    const bucketSize = (max - min) / numBuckets;
    const rangeMin = min + bucketIndex * bucketSize;
    const rangeMax = min + (bucketIndex + 1) * bucketSize;
    return `${rangeMin.toFixed(2)}-${rangeMax.toFixed(2)}`;
  }

  _drawGroupedHistogram(data) {
    // Clear previous chart
    this.chartGroup.selectAll("*").remove();

    const hasKdeData = this.kdeData && Object.keys(this.kdeData).length > 0;
    
    // Only return early if there's no histogram data AND no KDE data
    if (data.length === 0 && !hasKdeData) {
      return;
    }

    const innerWidth = this.width - this.margin.left - this.margin.right;
    const innerHeight = this.height - this.margin.top - this.margin.bottom;

    this._drawSingleHistogram(data, this.attributes, this.chartGroup, this.svg, innerWidth, innerHeight);
  }

  _drawSingleHistogram(data, attributes, chartGroup, svg, innerWidth, innerHeight) {
    const hasHistogramData = data && data.length > 0;
    const hasKdeData = this.kdeData && Object.keys(this.kdeData).length > 0;

    // Ensure ranges are valid, calculate from KDE data if needed
    this._ensureValidRanges(attributes, hasHistogramData, hasKdeData);

    // Calculate scales
    const scales = this._calculateScales(data, attributes, innerWidth, innerHeight, hasHistogramData, hasKdeData);

    // Draw histogram bars if data available
    if (hasHistogramData) {
      this._drawHistogramBars(data, attributes, chartGroup, scales, innerHeight);
    }

    // Without bars (which sit on the configured range), widen the x axis to fit the KDE curves
    const kdeDomain = hasKdeData && !hasHistogramData ? this._kdeXDomain(attributes) : null;

    // Draw KDE curves if data available
    if (hasKdeData) {
      this._drawKDE(attributes, chartGroup, scales.y, scales.color, innerWidth, innerHeight, kdeDomain);
    }

    // Draw axes and legend
    this._drawAxesAndLegend(attributes, chartGroup, scales.y, scales.color, innerWidth, innerHeight, hasKdeData, kdeDomain);
  }

  // x domain covering every attribute's configured range and its full KDE curve.
  // fast-kde pads the curve 3 bandwidths past the data, which can run beyond the
  // configured range (e.g. RGB near 0/255), so the axis is widened rather than the curve cut.
  _kdeXDomain(attributes) {
    let rangeLo = Infinity;
    let rangeHi = -Infinity;
    let kdeLo = Infinity;
    let kdeHi = -Infinity;
    attributes.forEach(attr => {
      const min = this.ranges[`${attr}_min`];
      const max = this.ranges[`${attr}_max`];
      if (Number.isFinite(min) && Number.isFinite(max)) {
        rangeLo = Math.min(rangeLo, min);
        rangeHi = Math.max(rangeHi, max);
      }
      const kde = this.kdeData[attr] && this.kdeData[attr].kde;
      if (kde && kde.x.length > 0) {
        kdeLo = Math.min(kdeLo, d3.min(kde.x));
        kdeHi = Math.max(kdeHi, d3.max(kde.x));
      }
    });
    const lo = Math.min(rangeLo, kdeLo);
    const hi = Math.max(rangeHi, kdeHi);
    if (!(lo < hi)) return null;
    // Curves already inside the configured range: keep it unchanged
    if (lo === rangeLo && hi === rangeHi) return [lo, hi];
    // Round only the widened side(s) outwards to a tidy tick value
    const nice = d3.scaleLinear().domain([lo, hi]).nice(10).domain();
    return [lo < rangeLo ? nice[0] : rangeLo, hi > rangeHi ? nice[1] : rangeHi];
  }

  _ensureValidRanges(attributes, hasHistogramData, hasKdeData) {
    // Ensure ranges are valid, calculate from KDE data if needed
    if (!hasHistogramData && hasKdeData) {
      attributes.forEach(attr => {
        const minKey = `${attr}_min`;
        const maxKey = `${attr}_max`;
        if (this.ranges[minKey] === undefined || this.ranges[maxKey] === undefined || 
            isNaN(this.ranges[minKey]) || isNaN(this.ranges[maxKey])) {
          // Calculate from KDE data
          if (this.kdeData[attr] && this.kdeData[attr].kde && this.kdeData[attr].kde.x.length > 0) {
            this.ranges[minKey] = d3.min(this.kdeData[attr].kde.x);
            this.ranges[maxKey] = d3.max(this.kdeData[attr].kde.x);
          }
        }
      });
    }
  }

  _calculateScales(data, attributes, innerWidth, innerHeight, hasHistogramData, hasKdeData) {
    let x0, x1, numBuckets, binWidths, totalCounts, maxDensity;

    if (hasHistogramData) {
      x0 = d3
        .scaleBand()
        .domain(data.map((d) => d.bucketIndex))
        .rangeRound([0, innerWidth])
        .paddingInner(0.1);

      x1 = d3
        .scaleBand()
        .domain(attributes)
        .rangeRound([0, x0.bandwidth()])
        .padding(0.05);

      numBuckets = data.length;
      binWidths = {};
      attributes.forEach(attr => {
        const attrMin = this.ranges[`${attr}_min`];
        const attrMax = this.ranges[`${attr}_max`];
        binWidths[attr] = (attrMax - attrMin) / numBuckets;
      });

      // Calculate total counts and convert to densities
      totalCounts = {};
      attributes.forEach(attr => {
        totalCounts[attr] = d3.sum(data, d => {
          const val = d.values.find(v => v.attribute === attr);
          return val ? val.count : 0;
        });
      });

      // Calculate max density for these specific attributes
      maxDensity = d3.max(data, (d) =>
        d3.max(d.values.filter(v => attributes.includes(v.attribute)), (v) => {
          const totalCount = totalCounts[v.attribute];
          const binWidth = binWidths[v.attribute];
          return totalCount > 0 ? v.count / (totalCount * binWidth) : 0;
        })
      );
    }

    // If no histogram data but KDE data exists, calculate max density from KDE
    if (!hasHistogramData && hasKdeData) {
      maxDensity = d3.max(attributes, attr => {
        if (this.kdeData[attr] && this.kdeData[attr].kde) {
          return d3.max(this.kdeData[attr].kde.y);
        }
        return 0;
      });
    }

    // Fallback if no data at all
    if (!maxDensity || maxDensity === 0 || isNaN(maxDensity)) {
      maxDensity = 1;
    }

    const y = d3
      .scaleLinear()
      .domain([0, maxDensity || 1])
      .nice()
      .range([innerHeight, 0]);

    const color = d3
      .scaleOrdinal()
      .domain(this.attributes)
      .range(this.colors || d3.schemeCategory10);

    return { x0, x1, y, color, binWidths, totalCounts };
  }

  _drawHistogramBars(data, attributes, chartGroup, scales, innerHeight) {
    const { x0, x1, y, color, binWidths, totalCounts } = scales;

    const bucketGroups = chartGroup
      .selectAll(".bucket-group")
      .data(data)
      .join("g")
      .attr("class", "bucket-group")
      .attr("transform", (d) => `translate(${x0(d.bucketIndex)},0)`);

    bucketGroups
      .selectAll("rect")
      .data((d) => d.values.filter(v => attributes.includes(v.attribute)))
      .join("rect")
      .attr("class", "histogram-bar")
      .attr("x", (d) => x1(d.attribute))
      .attr("y", (d) => {
        const totalCount = totalCounts[d.attribute];
        const binWidth = binWidths[d.attribute];
        const density = totalCount > 0 ? d.count / (totalCount * binWidth) : 0;
        return y(density);
      })
      .attr("width", x1.bandwidth())
      .attr("height", (d) => {
        const totalCount = totalCounts[d.attribute];
        const binWidth = binWidths[d.attribute];
        const density = totalCount > 0 ? d.count / (totalCount * binWidth) : 0;
        return innerHeight - y(density);
      })
      .attr("fill", (d) => color(d.attribute))
      .style("opacity", this.showBars ? 1 : 0);
  }

  _drawKDE(attributes, chartGroup, yScale, colorScale, innerWidth, innerHeight, xDomain = null) {
    attributes.forEach((attr) => {
      if (this.kdeData[attr]) {
        const kdeData = this.kdeData[attr];
        const kde = kdeData.kde;
        const pixelCount = kdeData.pixelCount;
        let attrMin = this.ranges[`${attr}_min`];
        let attrMax = this.ranges[`${attr}_max`];

        // Validate ranges, calculate from KDE if needed
        if (attrMin === undefined || attrMax === undefined || isNaN(attrMin) || isNaN(attrMax)) {
          if (kde.x && kde.x.length > 0) {
            attrMin = d3.min(kde.x);
            attrMax = d3.max(kde.x);
            console.warn(`[KDE] Using calculated ranges for ${attr}: [${attrMin}, ${attrMax}]`);
          } else {
            console.error(`[KDE] Cannot draw KDE for ${attr}: invalid ranges and no KDE data`);
            return;
          }
        }

        // Create x scale for this attribute's range (or the shared KDE-fitted domain)
        const xScale = d3.scaleLinear()
          .domain(xDomain || [attrMin, attrMax])
          .range([0, innerWidth]);

        const scaleFactor = 1;

        // Create line generator
        const line = d3.line()
          .x(d => xScale(d.x))
          .y(d => yScale(d.y * scaleFactor))
          .curve(d3.curveBasis);

        const lineData = kde.x.map((x, i) => ({ x, y: kde.y[i] }));

        chartGroup
          .append("path")
          .datum(lineData)
          .attr("class", `kde-line-${attr}`)
          .attr("fill", "none")
          .attr("stroke", colorScale(attr))
          .attr("stroke-width", 2.5)
          .attr("stroke-opacity", 0.8)
          .attr("d", line);
      }
    });
  }

  _drawAxesAndLegend(attributes, chartGroup, yScale, colorScale, innerWidth, innerHeight, hasKdeData, xDomain = null) {
    // Add x-axis for the first attribute only
    if (attributes.length > 0) {
      const attr = attributes[0];
      let attrMin = this.ranges[`${attr}_min`];
      let attrMax = this.ranges[`${attr}_max`];
      
      // Validate ranges
      if (attrMin === undefined || attrMax === undefined || isNaN(attrMin) || isNaN(attrMax)) {
        // Try to calculate from KDE data if available
        if (hasKdeData && this.kdeData[attr] && this.kdeData[attr].kde && this.kdeData[attr].kde.x.length > 0) {
          attrMin = d3.min(this.kdeData[attr].kde.x);
          attrMax = d3.max(this.kdeData[attr].kde.x);
        } else {
          // Fallback to default range
          attrMin = 0;
          attrMax = 1;
        }
      }
      
      const xScale = d3.scaleLinear()
        .domain(xDomain || [attrMin, attrMax])
        .range([0, innerWidth]);

      // Position the axis below the chart
      const yPosition = innerHeight + 5;
      
      const axis = chartGroup
        .append("g")
        .attr("class", `x-axis-${attr}`)
        .attr("transform", `translate(0,${yPosition})`)
        .call(d3.axisBottom(xScale).ticks(5));
    }

    const yAxis = chartGroup
      .append("g")
      .attr("class", "y-axis")
      .call(d3.axisLeft(yScale).ticks(5));

    this._addYLabel(chartGroup, yAxis, innerHeight);

    const legendYPosition = innerHeight + 40;
    const legend = chartGroup
      .append("g")
      .attr("class", "legend")
      .attr("transform", `translate(0,${legendYPosition})`);

    const legendItems = legend
      .selectAll(".legend-item")
      .data(attributes)
      .join("g")
      .attr("class", "legend-item")
      .attr("transform", (d, i) => `translate(${i * 100},0)`);

    legendItems
      .append("rect")
      .attr("width", 15)
      .attr("height", 15)
      .attr("fill", (d) => colorScale(d));

    legendItems
      .append("text")
      .attr("x", 20)
      .attr("y", 12)
      .text((d) => this._getAttributeLabel(d))
      .style("font-size", "12px");
  }

  // Rotated "Density" label just left of the widest tick label, so long values (e.g. 0.025) never cover it.
  _addYLabel(chartGroup, yAxis, innerHeight) {
    const axisWidth = yAxis.node().getBBox().width;
    const offset = axisWidth > 0 ? axisWidth + 6 : this.margin.left - 12;
    chartGroup
      .append("text")
      .attr("transform", "rotate(-90)")
      .attr("y", -Math.min(offset, this.margin.left - 12))
      .attr("x", 0 - innerHeight / 2)
      .style("text-anchor", "middle")
      .style("font-size", "11px")
      .text("Density");
  }

  _clearChart() {
    if (this.chartGroup) {
      this.chartGroup.selectAll("*").remove();
    }
  }

  drawEmptyAxes() {
    // Clear previous chart and reset state
    this._clearChart();
    this.selectedPredInstance = null;
    this.kdeData = null;

    const innerWidth = this.width - this.margin.left - this.margin.right;
    const innerHeight = this.height - this.margin.top - this.margin.bottom;

    // Create placeholder text
    this.chartGroup
      .append("text")
      .attr("x", innerWidth / 2)
      .attr("y", innerHeight / 2)
      .attr("text-anchor", "middle")
      .style("font-size", "14px")
      .style("fill", "#999")
      .text("Click on a point to view histogram");

    const x = d3.scaleLinear()
      .domain([0, 1])
      .range([0, innerWidth]);

    const y = d3.scaleLinear()
      .domain([0, 1])
      .range([innerHeight, 0]);

    this.chartGroup
      .append("g")
      .attr("class", "x-axis")
      .attr("transform", `translate(0,${innerHeight})`)
      .call(d3.axisBottom(x));

    const yAxis = this.chartGroup
      .append("g")
      .attr("class", "y-axis")
      .call(d3.axisLeft(y).ticks(5));

    this._addYLabel(this.chartGroup, yAxis, innerHeight);
  }

  updateWidth(width) {
    // Store current state
    const currentPredInstance = this.selectedPredInstance;
    this.width = width;
    this._setupSVG();
    if (currentPredInstance !== null) {
      this.redraw(currentPredInstance);
    } else {
      this.drawEmptyAxes();
    }
  }

  _toggleBars() {
    if (this.chartGroup) {
      this.chartGroup.selectAll(".histogram-bar")
        .transition()
        .duration(300)
        .style("opacity", this.showBars ? 1 : 0);
    }
  }

  destroy() {
    if (this.svg) {
      this.svg.remove();
      this.svg = null;
    }
    this.chartGroup = null;
    this.geoJsonLayer = null;
    this.attributes = [];
    this.ranges = {};
    this.callback = null;
  }
}

