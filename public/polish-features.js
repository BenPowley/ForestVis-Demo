/*
 * Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
 * Licensed under the MIT License; see LICENSE.txt in the project root.
 * SPDX-License-Identifier: MIT
 */

/* polish-features.js — runtime-served extras for the Forest3D interface-polish fork.
 *
 * Loaded by index.js via an injected <script src="./polish-features.js"> and
 * served from public/ as-is, so it can be edited and reloaded WITHOUT
 * rebuilding the Vite bundle.
 *
 * Two features:
 *   1. Hidden background-colour flag — a discreet Black/White choice that only
 *      appears in "Base Controls" once Base Opacity is dragged to 0. It sets the
 *      3D engine clear colour (instance.engine.clearColor), so when the base
 *      cloud is invisible you can pick a black or white backdrop.
 *   2. SVG export — a discreet button at the bottom of the Settings menu. The
 *      layout is set by renderingPanel.svgExportLayout:
 *        "figure" (default): the visualisations (not the UI panels) as a
 *          figure — the 3D view across the top with the minimap inset, then
 *          the visible charts in a grid of titled cards;
 *        "screen": the whole interface as on screen — the 3D view with every
 *          visible panel (boxes, labels, controls, charts) in place.
 *      Either way ONE editable SVG made of NATIVE SVG primitives (no
 *      <foreignObject>), so it opens and edits cleanly in
 *      CorelDRAW / Illustrator / Inkscape:
 *        - native d3 charts (histogram / UMAP / detail plots) -> real vectors,
 *          flattened into a <g transform> so nested-SVG-shy editors cope;
 *        - the WebGL point cloud and the minimap -> clearly-labelled, deletable
 *          raster <image> layers (millions of GPU points can't be vector),
 *          with the compass and the data/map attributions.
 */
(function () {
  "use strict";

  const SVG = "http://www.w3.org/2000/svg";
  const XLINK = "http://www.w3.org/1999/xlink";
  // Panels captured by the "screen" export layout, in back-to-front order.
  const PANEL_SELECTORS = [
    "#minimapControlsPanel",
    "#tabControlsPanel",
    "#toggleOptions",
    "#tooltip",
    "#data-attribution", // data credit footer, so screen captures stay attributed
  ];

  // The figure layout leaves interactive controls drawn inside charts (UMAP
  // pan/select buttons) out; the screen layout keeps the whole interface.
  let stripChartControls = true;

  // Presentation props copied onto chart <svg> subtrees (d3 sets most as
  // attributes; this fills in anything driven by CSS classes).
  const CHART_STYLE_PROPS = [
    "fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray",
    "stroke-opacity", "opacity", "color", "font-family", "font-size",
    "font-weight", "font-style", "text-anchor", "dominant-baseline",
    "letter-spacing", "display", "visibility",
  ];
  const SKIP_VALUES = new Set(["none", "normal", "auto", ""]);

  const TRANSPARENT = new Set(["rgba(0, 0, 0, 0)", "transparent", ""]);

  // ---------------------------------------------------------------- bootstrap
  function whenReady(cb) {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      const fv = window.__forestvis;
      const ready =
        fv && fv.instance &&
        document.getElementById("copcOpacitySlider") &&
        document.getElementById("toggleOptions");
      if (ready) {
        clearInterval(timer);
        try { cb(); } catch (e) { console.error("[polish-features] init error", e); }
      } else if (tries > 300) {
        clearInterval(timer);
        console.warn("[polish-features] gave up waiting for app to be ready");
      }
    }, 200);
  }

  whenReady(() => {
    injectStyles();
    setupBackgroundToggle();
    setupSvgExport();
  });

  // ------------------------------------------------ feature 1: background flag
  function setupBackgroundToggle() {
    const instance = window.__forestvis.instance;
    const slider = document.getElementById("copcOpacitySlider");
    if (!slider) return;
    const host =
      slider.closest(".card-body") ||
      document.getElementById("baseOpacity") ||
      slider.parentElement;

    const wrap = document.createElement("div");
    wrap.id = "bgColorChoice";
    wrap.className = "pf-bg-choice";
    wrap.style.display = "none";
    wrap.innerHTML =
      '<span class="pf-bg-label">Backdrop</span>' +
      '<div class="pf-bg-opts" role="group" aria-label="3D background colour">' +
      '<button type="button" class="pf-bg-btn" data-bg="dark">Black</button>' +
      '<button type="button" class="pf-bg-btn" data-bg="light">White</button>' +
      "</div>";
    host.appendChild(wrap);

    function apply(kind) {
      const color = kind === "light" ? 0xffffff : 0x000000;
      try {
        instance.engine.clearColor = color;
        instance.engine.clearAlpha = 1;
        instance.notifyChange();
      } catch (e) {
        console.warn("[polish-features] could not set background colour", e);
      }
      const view = document.getElementById("view");
      if (view) view.style.background = kind === "light" ? "#ffffff" : "#000000";
      wrap.querySelectorAll(".pf-bg-btn").forEach((b) =>
        b.classList.toggle("active", b.dataset.bg === kind));
    }

    wrap.querySelectorAll(".pf-bg-btn").forEach((b) =>
      b.addEventListener("click", () => apply(b.dataset.bg)));

    function refresh() {
      wrap.style.display = parseFloat(slider.value) === 0 ? "" : "none";
    }
    slider.addEventListener("input", refresh);
    slider.addEventListener("change", refresh);
    refresh();
  }

  // ---------------------------------------------------- feature 2: SVG export
  function setupSvgExport() {
    const settings = document.getElementById("toggleOptions");
    if (!settings) return;
    const btn = document.createElement("button");
    btn.id = "pf-export-svg";
    btn.type = "button";
    btn.className = "pf-export-btn";
    btn.title = "Export the 3D view, charts and minimap as an editable SVG (CorelDRAW/Illustrator/Inkscape)";
    btn.innerHTML = '<span class="pf-export-icon">⤓</span> Export view as SVG';
    settings.appendChild(btn);

    btn.addEventListener("click", async () => {
      const original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = "Exporting…";
      try {
        await exportSvg();
      } catch (e) {
        console.error("[polish-features] SVG export failed", e);
        alert("SVG export failed: " + (e && e.message ? e.message : e));
      } finally {
        btn.disabled = false;
        btn.innerHTML = original;
      }
    });
  }

  // renderingPanel.svgExportLayout: "figure" (default) lays the visualisations
  // out as a figure; "screen" captures the whole interface as it is on screen
  // (panels, controls and charts in place), e.g. for screenshots.
  async function exportSvg() {
    // Make sure the WebGL buffers hold the latest frame before reading them back.
    try { window.__forestvis.instance.notifyChange(); } catch (e) {}
    try {
      const m = window.__forestvis.minimapInstance;
      if (m) m.notifyChange();
    } catch (e) {}
    await nextFrame();
    await nextFrame();

    const layout = (window.__forestvis && window.__forestvis.svgExportLayout) || "figure";
    stripChartControls = layout !== "screen";
    if (layout === "screen") await exportSvgScreen();
    else await exportSvgFigure();
  }

  async function exportSvgFigure() {
    // Figure layout, independent of where things sit in the interface:
    //   3D view across the top (minimap inset in its corner), data credit,
    //   then the visible charts in a grid of cards, each shown in full.
    // Each piece is drawn by the emitters in screen coordinates, then wrapped
    // in a <g transform> that moves/scales it into its slot.
    const screenW = Math.max(window.innerWidth, document.documentElement.clientWidth);
    const screenH = Math.max(window.innerHeight, document.documentElement.clientHeight);
    const PAD = 24, GAP = 16, CARD_PAD = 10, TITLE_H = 22, MAX_COLS = 3, MAX_SCALE = 1.6;
    const W = 1600;
    const contentW = W - 2 * PAD;
    const FONT = "IBM Plex Sans, sans-serif";

    const svg = el("svg");
    svg.setAttribute("xmlns", SVG);
    svg.setAttribute("xmlns:xlink", XLINK);
    const defs = el("defs");
    svg.appendChild(defs);
    const page = rectEl(0, 0, W, 0); // height set once the layout is known
    page.setAttribute("fill", "#ffffff");
    svg.appendChild(page);

    let clipCount = 0;
    function clipTo(g, x, y, w, h) {
      const clipId = `pf-clip-${clipCount++}`;
      const clip = el("clipPath");
      clip.setAttribute("id", clipId);
      clip.appendChild(rectEl(x, y, w, h));
      defs.appendChild(clip);
      g.setAttribute("clip-path", `url(#${clipId})`);
    }
    // Wrap screen-space content so the screen rect `r` lands at (x, y) scaled by s.
    function placed(id, r, x, y, s) {
      const outer = el("g");
      outer.setAttribute("id", id);
      outer.setAttribute("transform",
        `translate(${round2(x - r.left * s)},${round2(y - r.top * s)}) scale(${round4(s)})`);
      const inner = el("g");
      clipTo(inner, r.left, r.top, r.width, r.height);
      outer.appendChild(inner);
      svg.appendChild(outer);
      return inner;
    }
    function textEl(str, x, y, size, opts = {}) {
      const t = el("text");
      t.setAttribute("x", round2(x));
      t.setAttribute("y", round2(y));
      t.setAttribute("font-family", FONT);
      t.setAttribute("font-size", size);
      t.setAttribute("fill", opts.fill || "#1d2530");
      if (opts.weight) t.setAttribute("font-weight", opts.weight);
      if (opts.anchor) t.setAttribute("text-anchor", opts.anchor);
      t.textContent = str;
      return t;
    }

    // ---- 3D view (raster), full content width ----
    const viewH = Math.round(contentW * screenH / screenW);
    const rasterG = el("g");
    rasterG.setAttribute("id", "raster-3d-context");
    rasterG.setAttribute(
      "data-note",
      "WebGL point cloud — raster, not vector. Delete this group for a pure-vector file.",
    );
    const viewCanvas = document.querySelector("#view canvas");
    if (viewCanvas) {
      const url = rasterizeCanvas(viewCanvas, { maxDim: 2400, mime: "image/jpeg", quality: 0.92 });
      const img = imageEl(url, PAD, PAD, contentW, viewH, "xMidYMid slice");
      if (img) rasterG.appendChild(img);
    }
    svg.appendChild(rasterG);

    // ---- minimap inset, top-left of the 3D view ----
    const minimapEl = document.getElementById("minimap");
    if (minimapEl && isVisible(minimapEl)) {
      const r = minimapEl.getBoundingClientRect();
      const s = Math.min(1.4, (contentW * 0.24) / r.width);
      const x = PAD + 12, y = PAD + 12;
      const frame = rectEl(x - 2, y - 2, r.width * s + 4, r.height * s + 4);
      frame.setAttribute("fill", "#ffffff");
      svg.appendChild(frame);
      const g = placed("minimap", r, x, y, s);
      const canvas = minimapEl.querySelector("canvas");
      if (canvas) emitCanvas(canvas, g);
      const compass = document.getElementById("compass");
      if (compass && isVisible(compass)) {
        emitCompass(compass, g, await preloadImages([compass.parentElement]));
      }
      const credit = minimapEl.querySelector(".minimap-attribution");
      if (credit) renderNode(credit, g, new Map());
    }

    // ---- data credit under the 3D view ----
    let y = PAD + viewH + 16;
    svg.appendChild(textEl("Data: NEON, CC BY 4.0", W - PAD, y, 11, { fill: "#5a6573", anchor: "end" }));
    y += 12;

    // ---- charts: visible top-level d3 <svg>s, in full, in a grid of cards ----
    const charts = [];
    const chartPanel = document.getElementById("tabControlsPanel");
    if (chartPanel && isVisible(chartPanel)) {
      chartPanel.querySelectorAll("svg").forEach((chart) => {
        if (chart.parentElement.closest("svg")) return; // nested inside another chart
        if (!isVisible(chart)) return;
        // Some charts are titled by an HTML heading just before their container
        // (e.g. "NDVI Density"); others carry their title inside the <svg>.
        const prev = chart.parentElement.previousElementSibling;
        const title = prev && /^H[1-6]$/.test(prev.tagName) && isVisible(prev)
          ? prev.textContent.trim() : "";
        charts.push({ chart, title, r: chart.getBoundingClientRect() });
      });
    }
    if (charts.length) {
      y += GAP;
      // Very wide charts (e.g. bars for every index statistic) get a full-width
      // row, together with any charts right after them of the same height (the
      // matching bar panels), all at ONE shared scale so their bars compare.
      // The other charts are packed up to MAX_COLS per row.
      const isWide = (c) => c.r.width / c.r.height > 2.5;
      const sameHeight = (a, b) => Math.abs(a.r.height - b.r.height) < 2;
      const rows = []; // { charts, shared }
      let current = [];
      for (let k = 0; k < charts.length; k++) {
        const c = charts[k];
        if (isWide(c)) {
          if (current.length) { rows.push({ charts: current }); current = []; }
          const group = [c];
          while (k + 1 < charts.length && !isWide(charts[k + 1]) && sameHeight(c, charts[k + 1])) {
            group.push(charts[++k]);
          }
          rows.push({ charts: group, shared: true });
        } else {
          current.push(c);
          if (current.length === MAX_COLS) { rows.push({ charts: current }); current = []; }
        }
      }
      if (current.length) rows.push({ charts: current });
      const normalCount = rows.filter((r) => !r.shared).reduce((n, r) => Math.max(n, r.charts.length), 0);
      const cols = Math.max(1, Math.min(MAX_COLS, normalCount));

      rows.forEach(({ charts: rowCharts, shared }, i) => {
        let row;
        if (shared) {
          // One scale for the whole row; each card is as wide as its chart.
          const n = rowCharts.length;
          const avail = contentW - (n - 1) * GAP - n * 2 * CARD_PAD;
          const s = Math.min(MAX_SCALE, avail / rowCharts.reduce((w, c) => w + c.r.width, 0));
          row = rowCharts.map((c) => ({ ...c, s, cellW: c.r.width * s + 2 * CARD_PAD }));
        } else {
          const cellW = (contentW - (cols - 1) * GAP) / cols;
          row = rowCharts.map((c) => ({
            ...c, cellW, s: Math.min(MAX_SCALE, (cellW - 2 * CARD_PAD) / c.r.width),
          }));
        }
        row.forEach((c) => { c.h = 2 * CARD_PAD + (c.title ? TITLE_H : 0) + c.r.height * c.s; });
        const rowH = Math.max(...row.map((c) => c.h));
        let x = PAD;
        row.forEach((c, j) => {
          const cellW = c.cellW;
          const card = rectEl(x, y, cellW, rowH);
          card.setAttribute("rx", "8");
          card.setAttribute("ry", "8");
          card.setAttribute("fill", "#ffffff");
          card.setAttribute("stroke", "#e3e7ec");
          svg.appendChild(card);
          let cy = y + CARD_PAD;
          if (c.title) {
            svg.appendChild(textEl(c.title, x + CARD_PAD, cy + 14, 14, { weight: "600" }));
            cy += TITLE_H;
          }
          const cx = x + (cellW - c.r.width * c.s) / 2; // centre the chart in its card
          emitChart(c.chart, placed("chart-" + (c.chart.parentElement.id || i + j), c.r, cx, cy, c.s));
          x += cellW + GAP;
        });
        y += rowH + GAP;
      });
      y -= GAP;
    }

    const H = Math.round(y + PAD);
    page.setAttribute("height", H);
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

    const xml = new XMLSerializer().serializeToString(svg);
    const out =
      '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
      "<!-- Exported from ForestVis. #charts = vector d3 charts, " +
      "#raster-3d-context and #minimap = embedded rasters. -->\n" +
      xml;
    downloadBlob(new Blob([out], { type: "image/svg+xml" }), `forestvis-${stamp()}.svg`);
  }

  // Screen layout: the 3D view full-size with every visible panel drawn as
  // native SVG at its on-screen position (boxes, labels, controls, charts).
  async function exportSvgScreen() {
    const W = Math.max(window.innerWidth, document.documentElement.clientWidth);
    const H = Math.max(window.innerHeight, document.documentElement.clientHeight);

    const svg = el("svg");
    svg.setAttribute("xmlns", SVG);
    svg.setAttribute("xmlns:xlink", XLINK);
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

    const defs = el("defs");
    svg.appendChild(defs);

    // ---- raster context layer: the main 3D point cloud (not vectorisable) ----
    const rasterG = el("g");
    rasterG.setAttribute("id", "raster-3d-context");
    rasterG.setAttribute(
      "data-note",
      "WebGL point cloud — raster, not vector. Delete this group for a pure-vector file.",
    );
    const viewCanvas = document.querySelector("#view canvas");
    if (viewCanvas) {
      const url = rasterizeCanvas(viewCanvas, { maxDim: 2400, mime: "image/jpeg", quality: 0.92 });
      const img = imageEl(url, 0, 0, W, H, "xMidYMid slice");
      if (img) rasterG.appendChild(img);
    }
    svg.appendChild(rasterG);

    // ---- panels as native SVG ----
    const panels = PANEL_SELECTORS
      .map((s) => document.querySelector(s))
      .filter((e) => e && isVisible(e));

    const imgMap = await preloadImages(panels);

    let i = 0;
    for (const panel of panels) {
      const rect = panel.getBoundingClientRect();
      const clipId = `pf-clip-${i}`;
      const clip = el("clipPath");
      clip.setAttribute("id", clipId);
      clip.appendChild(rectEl(rect.left, rect.top, rect.width, rect.height));
      defs.appendChild(clip);

      const g = el("g");
      g.setAttribute("id", "panel" + (panel.id ? "-" + panel.id : "-" + i));
      g.setAttribute("clip-path", `url(#${clipId})`);
      renderNode(panel, g, imgMap);
      svg.appendChild(g);
      i += 1;
    }

    const xml = new XMLSerializer().serializeToString(svg);
    const out =
      '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
      "<!-- Exported from ForestVis (screen layout). Native SVG: boxes=<rect>, " +
      "labels=<text>, charts=vector <g>, #raster-3d-context=embedded raster. -->\n" +
      xml;
    downloadBlob(new Blob([out], { type: "image/svg+xml" }), `forestvis-${stamp()}.svg`);
  }

  // -------------------------------------------------- native DOM -> SVG walk
  function renderNode(node, out, imgMap) {
    if (node.nodeType === 3) { emitText(node, out); return; } // text node
    if (node.nodeType !== 1) return;                          // comment/etc.

    const elm = node;
    const cs = getComputedStyle(elm);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0)
      return;

    const tag = elm.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "br" || tag === "noscript") return;

    // The export button itself reads "Exporting…" while this runs; leave it out.
    if (elm.id === "pf-export-svg") return;

    if (tag === "svg") {
      // Charts in scrolling boxes (e.g. the wide index bars) must be clipped to
      // what is visible, or their hidden part is drawn over neighbouring charts.
      const r = visibleRect(elm);
      if (!r) return;
      const g = el("g");
      const clipId = `pf-chart-clip-${chartClipCount++}`;
      const clip = el("clipPath");
      clip.setAttribute("id", clipId);
      clip.appendChild(rectEl(r.left, r.top, r.width, r.height));
      g.appendChild(clip);
      g.setAttribute("clip-path", `url(#${clipId})`);
      out.appendChild(g);
      emitChart(elm, g);
      return;
    }
    if (tag === "canvas") { emitCanvas(elm, out); return; }
    if (tag === "img") { emitImg(elm, out, imgMap); return; }
    if (tag === "input") {
      const ty = (elm.getAttribute("type") || "text").toLowerCase();
      if (ty === "checkbox" || ty === "radio") { emitToggle(elm, cs, out); return; }
      if (ty === "range") { emitRange(elm, cs, out); return; }
      emitBox(elm, cs, out); // text/number input: just the box
      return;
    }
    if (tag === "select") { emitSelect(elm, cs, out); return; }

    // generic element: paint its own box, then its children in document order
    emitBox(elm, cs, out);
    for (const child of elm.childNodes) renderNode(child, out, imgMap);
  }

  // Box (background + border + rounded corners) for an element.
  function emitBox(elm, cs, out) {
    const r = elm.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const bg = cs.backgroundColor;
    const hasBg = !TRANSPARENT.has(bg);
    const bw = px(cs.borderTopWidth);
    const bc = cs.borderTopColor;
    const hasBorder = bw > 0 && cs.borderTopStyle !== "none" && !TRANSPARENT.has(bc);
    if (!hasBg && !hasBorder) return;

    const radius = Math.min(
      px(cs.borderTopLeftRadius),
      Math.min(r.width, r.height) / 2,
    );
    const rect = rectEl(r.left, r.top, r.width, r.height);
    rect.setAttribute("fill", hasBg ? bg : "none");
    if (radius > 0.5) { rect.setAttribute("rx", round2(radius)); rect.setAttribute("ry", round2(radius)); }
    if (hasBorder) {
      rect.setAttribute("stroke", bc);
      rect.setAttribute("stroke-width", round2(bw));
    }
    out.appendChild(rect);
  }

  // Real <text> per visible line of a text node (handles wrapping).
  function emitText(textNode, out) {
    const parent = textNode.parentElement;
    if (!parent) return;
    const cs = getComputedStyle(parent);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const raw = textNode.nodeValue;
    if (!raw || !raw.trim()) return;

    const fontSize = px(cs.fontSize) || 12;
    const range = document.createRange();
    const lines = [];
    let cur = null;
    for (let i = 0; i < raw.length; i++) {
      range.setStart(textNode, i);
      range.setEnd(textNode, i + 1);
      const rs = range.getClientRects();
      const cr = rs.length ? rs[rs.length - 1] : null;
      if (!cr || (cr.width === 0 && cr.height === 0)) {
        if (cur) cur.text += raw[i];
        continue;
      }
      if (!cur || Math.abs(cr.top - cur.top) > 2) {
        cur = { text: raw[i], top: cr.top, bottom: cr.bottom, left: cr.left, right: cr.right };
        lines.push(cur);
      } else {
        cur.text += raw[i];
        cur.left = Math.min(cur.left, cr.left);
        cur.right = Math.max(cur.right, cr.right);
        cur.bottom = Math.max(cur.bottom, cr.bottom);
      }
    }

    const fill = cs.color;
    const fam = cs.fontFamily;
    const fw = cs.fontWeight;
    const fst = cs.fontStyle;
    const ta = cs.textAlign;
    for (const ln of lines) {
      const t = ln.text.replace(/\s+$/, "");
      if (!t.trim()) continue;
      const lineH = ln.bottom - ln.top;
      const baseline = ln.top + (lineH - fontSize) / 2 + fontSize * 0.8;
      let x = ln.left, anchor = null;
      if (ta === "center") { x = (ln.left + ln.right) / 2; anchor = "middle"; }
      else if (ta === "right" || ta === "end") { x = ln.right; anchor = "end"; }
      const te = el("text");
      te.setAttribute("x", round2(x));
      te.setAttribute("y", round2(baseline));
      if (anchor) te.setAttribute("text-anchor", anchor);
      te.setAttribute("font-family", fam);
      te.setAttribute("font-size", round2(fontSize));
      if (fw && fw !== "400" && fw !== "normal") te.setAttribute("font-weight", fw);
      if (fst && fst !== "normal") te.setAttribute("font-style", fst);
      te.setAttribute("fill", fill);
      te.setAttribute("xml:space", "preserve");
      te.textContent = t;
      out.appendChild(te);
    }
  }

  // Checkbox / radio / Bootstrap switch.
  function emitToggle(elm, cs, out) {
    const r = elm.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const radius = px(cs.borderTopLeftRadius);
    const isSwitch =
      (elm.getAttribute("role") === "switch") ||
      (elm.closest && elm.closest(".form-switch")) ||
      radius >= r.height / 2 - 0.5;
    const accent = !TRANSPARENT.has(cs.backgroundColor) ? cs.backgroundColor : "#166534";
    const border = !TRANSPARENT.has(cs.borderTopColor) ? cs.borderTopColor : "#9ca3af";

    if (isSwitch) {
      const track = rectEl(r.left, r.top, r.width, r.height);
      track.setAttribute("rx", round2(r.height / 2));
      track.setAttribute("ry", round2(r.height / 2));
      track.setAttribute("fill", elm.checked ? accent : "#e5e7eb");
      track.setAttribute("stroke", border);
      track.setAttribute("stroke-width", "1");
      out.appendChild(track);
      const knobR = r.height / 2 - 2;
      const cx = elm.checked ? r.right - knobR - 2 : r.left + knobR + 2;
      const knob = el("circle");
      knob.setAttribute("cx", round2(cx));
      knob.setAttribute("cy", round2(r.top + r.height / 2));
      knob.setAttribute("r", round2(knobR));
      knob.setAttribute("fill", "#ffffff");
      out.appendChild(knob);
      return;
    }

    const box = rectEl(r.left, r.top, r.width, r.height);
    box.setAttribute("rx", elm.type === "radio" ? round2(r.height / 2) : "3");
    box.setAttribute("ry", elm.type === "radio" ? round2(r.height / 2) : "3");
    box.setAttribute("fill", elm.checked ? accent : "#ffffff");
    box.setAttribute("stroke", elm.checked ? accent : border);
    box.setAttribute("stroke-width", "1");
    out.appendChild(box);
    if (elm.checked && elm.type !== "radio") {
      const p = el("path");
      const x0 = r.left + r.width * 0.22, y0 = r.top + r.height * 0.52;
      const x1 = r.left + r.width * 0.42, y1 = r.top + r.height * 0.72;
      const x2 = r.left + r.width * 0.78, y2 = r.top + r.height * 0.30;
      p.setAttribute("d", `M${round2(x0)},${round2(y0)} L${round2(x1)},${round2(y1)} L${round2(x2)},${round2(y2)}`);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", "#ffffff");
      p.setAttribute("stroke-width", round2(Math.max(1.2, r.height * 0.12)));
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-linejoin", "round");
      out.appendChild(p);
    }
  }

  // Range slider -> track line + thumb circle.
  function emitRange(elm, cs, out) {
    const r = elm.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const cy = r.top + r.height / 2;
    const track = el("line");
    track.setAttribute("x1", round2(r.left));
    track.setAttribute("y1", round2(cy));
    track.setAttribute("x2", round2(r.right));
    track.setAttribute("y2", round2(cy));
    track.setAttribute("stroke", "#cbd5e1");
    track.setAttribute("stroke-width", "4");
    track.setAttribute("stroke-linecap", "round");
    out.appendChild(track);

    const min = parseFloat(elm.min) || 0;
    const max = elm.max !== "" && elm.max != null ? parseFloat(elm.max) : 100;
    const val = parseFloat(elm.value);
    const frac = max > min && !isNaN(val) ? (val - min) / (max - min) : 0;
    const cx = r.left + frac * r.width;
    const thumb = el("circle");
    thumb.setAttribute("cx", round2(cx));
    thumb.setAttribute("cy", round2(cy));
    thumb.setAttribute("r", round2(Math.max(5, r.height / 2)));
    thumb.setAttribute("fill", "#1f4ea3");
    out.appendChild(thumb);
  }

  // Select -> box + selected option text + chevron.
  function emitSelect(elm, cs, out) {
    emitBox(elm, cs, out);
    const r = elm.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const opt = elm.options && elm.options[elm.selectedIndex];
    const fontSize = px(cs.fontSize) || 13;
    if (opt && opt.text) {
      const padL = px(cs.paddingLeft) || 8;
      const te = el("text");
      te.setAttribute("x", round2(r.left + padL));
      te.setAttribute("y", round2(r.top + r.height / 2 + fontSize * 0.34));
      te.setAttribute("font-family", cs.fontFamily);
      te.setAttribute("font-size", round2(fontSize));
      te.setAttribute("fill", cs.color);
      te.textContent = opt.text;
      out.appendChild(te);
    }
    const cxr = r.right - 14, cyr = r.top + r.height / 2;
    const chev = el("path");
    chev.setAttribute("d", `M${round2(cxr - 4)},${round2(cyr - 2)} L${round2(cxr)},${round2(cyr + 3)} L${round2(cxr + 4)},${round2(cyr - 2)}`);
    chev.setAttribute("fill", "none");
    chev.setAttribute("stroke", cs.color || "#444");
    chev.setAttribute("stroke-width", "1.4");
    chev.setAttribute("stroke-linecap", "round");
    chev.setAttribute("stroke-linejoin", "round");
    out.appendChild(chev);
  }

  // Native d3 chart -> flattened vector <g transform> (avoids nested <svg>).
  function emitChart(svgEl, out) {
    if (!isVisible(svgEl)) return;
    const r = svgEl.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const clone = svgEl.cloneNode(true);
    inlineChartStyles(svgEl, clone);
    // Interactive controls drawn inside a chart (UMAP pan/select buttons) are UI, not data
    if (stripChartControls) clone.querySelectorAll(".tool-button").forEach((b) => b.remove());

    let sx = 1, sy = 1;
    const vb = svgEl.getAttribute("viewBox");
    if (vb) {
      const p = vb.split(/[ ,]+/).map(Number);
      if (p.length === 4 && p[2] && p[3]) { sx = r.width / p[2]; sy = r.height / p[3]; }
    }
    const g = el("g");
    const t = `translate(${round2(r.left)},${round2(r.top)})` +
      (sx !== 1 || sy !== 1 ? ` scale(${round4(sx)},${round4(sy)})` : "");
    g.setAttribute("transform", t);
    while (clone.firstChild) g.appendChild(clone.firstChild); // drop the outer <svg>
    out.appendChild(g);
  }

  function inlineChartStyles(src, dst) {
    const s = [src, ...src.querySelectorAll("*")];
    const d = [dst, ...dst.querySelectorAll("*")];
    const n = Math.min(s.length, d.length);
    for (let i = 0; i < n; i++) {
      const cs = getComputedStyle(s[i]);
      const parts = [];
      for (const p of CHART_STYLE_PROPS) {
        const v = cs.getPropertyValue(p);
        if (v && !SKIP_VALUES.has(v) && !TRANSPARENT.has(v)) parts.push(`${p}:${v}`);
      }
      if (parts.length) {
        const prev = d[i].getAttribute("style");
        d[i].setAttribute("style", (prev ? prev + ";" : "") + parts.join(";"));
      }
    }
  }

  function emitCanvas(canvasEl, out) {
    if (!isVisible(canvasEl)) return;
    const r = canvasEl.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const url = rasterizeCanvas(canvasEl, { mime: "image/png" });
    const img = imageEl(url, r.left, r.top, r.width, r.height, "none");
    if (img) out.appendChild(img);
  }

  // The compass is rotated with a CSS transform; keep that rotation.
  function emitCompass(imgNode, out, imgMap) {
    const r = imgNode.getBoundingClientRect();
    const w = imgNode.offsetWidth, h = imgNode.offsetHeight;
    if (!w || !h) return;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const m = new DOMMatrixReadOnly(getComputedStyle(imgNode).transform === "none"
      ? undefined : getComputedStyle(imgNode).transform);
    const deg = Math.atan2(m.b, m.a) * 180 / Math.PI;
    const src = imgNode.getAttribute("src") || "";
    const url = src.startsWith("data:") ? src : imgMap.get(src) || src;
    const img = imageEl(url, cx - w / 2, cy - h / 2, w, h, "xMidYMid meet");
    if (!img) return;
    img.setAttribute("transform", `rotate(${round2(deg)},${round2(cx)},${round2(cy)})`);
    out.appendChild(img);
  }

  function emitImg(imgNode, out, imgMap) {
    if (!isVisible(imgNode)) return;
    const r = imgNode.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const src = imgNode.getAttribute("src") || "";
    const url = src.startsWith("data:") ? src : imgMap.get(src) || src;
    const img = imageEl(url, r.left, r.top, r.width, r.height, "xMidYMid meet");
    if (img) out.appendChild(img);
  }

  // ------------------------------------------------------------- SVG helpers
  function el(name) { return document.createElementNS(SVG, name); }
  function rectEl(x, y, w, h) {
    const r = el("rect");
    r.setAttribute("x", round2(x));
    r.setAttribute("y", round2(y));
    r.setAttribute("width", round2(w));
    r.setAttribute("height", round2(h));
    return r;
  }
  function imageEl(url, x, y, w, h, par) {
    if (!url || url === "data:,") return null;
    const img = el("image");
    img.setAttribute("x", round2(x));
    img.setAttribute("y", round2(y));
    img.setAttribute("width", round2(w));
    img.setAttribute("height", round2(h));
    if (par) img.setAttribute("preserveAspectRatio", par);
    img.setAttribute("href", url);
    img.setAttributeNS(XLINK, "xlink:href", url);
    return img;
  }

  function rasterizeCanvas(canvas, opts) {
    const o = opts || {};
    const mime = o.mime || "image/png";
    const quality = o.quality != null ? o.quality : 0.92;
    const sw = canvas.width, sh = canvas.height;
    if (!sw || !sh) return "";
    let scale = 1;
    if (o.maxDim) scale = Math.min(1, o.maxDim / Math.max(sw, sh));
    const tw = Math.max(1, Math.round(sw * scale));
    const th = Math.max(1, Math.round(sh * scale));
    try {
      if (scale === 1 && mime === "image/png") return canvas.toDataURL("image/png");
      const off = document.createElement("canvas");
      off.width = tw; off.height = th;
      const cx = off.getContext("2d");
      if (mime === "image/jpeg") { cx.fillStyle = "#ffffff"; cx.fillRect(0, 0, tw, th); }
      cx.drawImage(canvas, 0, 0, tw, th);
      return off.toDataURL(mime, quality);
    } catch (e) {
      try { return canvas.toDataURL("image/png"); } catch (e2) { return ""; }
    }
  }

  async function preloadImages(panels) {
    const map = new Map();
    const srcs = new Set();
    panels.forEach((p) =>
      p.querySelectorAll("img").forEach((im) => {
        const s = im.getAttribute("src");
        if (s && !s.startsWith("data:")) srcs.add(s);
      }));
    await Promise.all([...srcs].map(async (s) => {
      try {
        const res = await fetch(s);
        const blob = await res.blob();
        map.set(s, await blobToDataURL(blob));
      } catch (e) { /* leave original src */ }
    }));
    return map;
  }

  // --------------------------------------------------------------- utilities
  // Screen rect of the part of elm not clipped by a scrolling/overflow-hidden
  // ancestor; null if nothing is visible.
  let chartClipCount = 0;
  function visibleRect(elm) {
    const b = elm.getBoundingClientRect();
    let left = b.left, top = b.top, right = b.right, bottom = b.bottom;
    for (let a = elm.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
        const ar = a.getBoundingClientRect();
        if (cs.overflowX !== "visible") { left = Math.max(left, ar.left); right = Math.min(right, ar.right); }
        if (cs.overflowY !== "visible") { top = Math.max(top, ar.top); bottom = Math.min(bottom, ar.bottom); }
      }
    }
    if (right <= left || bottom <= top) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function isVisible(elm) {
    const cs = getComputedStyle(elm);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0)
      return false;
    const r = elm.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
      r.top < window.innerHeight && r.left < window.innerWidth;
  }
  function px(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function round4(n) { return Math.round(n * 10000) / 10000; }
  function nextFrame() { return new Promise((r) => requestAnimationFrame(() => r())); }
  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  function stamp() {
    const d = new Date();
    const p = (x) => String(x).padStart(2, "0");
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  // ------------------------------------------------------------------ styles
  function injectStyles() {
    if (document.getElementById("pf-styles")) return;
    const style = document.createElement("style");
    style.id = "pf-styles";
    style.textContent = `
      .pf-bg-choice {
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px; margin-top: 6px; padding: 6px 8px;
        border: 1px dashed rgba(0,0,0,.18); border-radius: 10px;
        background: rgba(0,0,0,.025); animation: pf-fade .18s ease;
      }
      .pf-bg-label { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: #6b7280; }
      .pf-bg-opts { display: inline-flex; gap: 4px; }
      .pf-bg-btn {
        font-size: 11px; line-height: 1; padding: 4px 9px;
        border: 1px solid rgba(0,0,0,.18); border-radius: 999px;
        background: #fff; color: #374151; cursor: pointer; transition: all .12s;
      }
      .pf-bg-btn:hover { border-color: rgba(0,0,0,.4); }
      .pf-bg-btn.active { background: #166534; border-color: #166534; color: #fff; }
      .pf-bg-btn[data-bg="dark"].active { background:#111827; border-color:#111827; }
      .pf-export-btn {
        display: block; width: calc(100% - 8px); margin: 12px auto 6px;
        font-size: 11px; letter-spacing: .02em; padding: 6px 10px;
        border: 1px solid rgba(0,0,0,.14); border-radius: 10px;
        background: rgba(255,255,255,.6); color: #6b7280; cursor: pointer; transition: all .12s;
      }
      .pf-export-btn:hover { color:#166534; border-color: rgba(22,101,52,.45); background: rgba(22,101,52,.06); }
      .pf-export-btn:disabled { opacity:.6; cursor: default; }
      .pf-export-icon { font-weight: 600; margin-right: 4px; }
      @keyframes pf-fade { from { opacity: 0; transform: translateY(-2px); } to { opacity:1; transform:none; } }
    `;
    document.head.appendChild(style);
  }
})();
