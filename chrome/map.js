// willkarte — map (runs inside the extension iframe)
// Receives listings from the content script via postMessage and plots them as
// Airbnb-style price pills on a Leaflet + MapLibre (vector) map.
//
// Display model:
//  - Flats at (almost) the exact same spot are merged into a "unit". A unit with
//    one flat shows its price; a unit with several shows the cheapest price plus a
//    "+N" badge, and its popup has ‹ › arrows to page through the flats there.
//    Merging uses a fixed real-world threshold (projected at COINCIDE_ZOOM), so it
//    only merges flats genuinely on top of each other — never ones that separate
//    as you zoom in.
//  - Up to MAX_PILLS price pills are drawn, spaced on a pixel grid so they don't
//    overlap and stay a roughly constant, readable number in view.
//  - Units that don't get a pill are hinted with small empty "density dots".
//  - Popups open on HOVER (with a short close delay so you can reach them).
//  - The view is recomputed on pan/zoom (reconciled, so open popups survive).

(function () {
  "use strict";

  const AUSTRIA = [47.6, 13.3];
  const PILL_CELL = 64; // min spacing between price pills (screen px)
  const MAX_PILLS = 30; // cap on price pills shown at once
  const DOT_CELL = 46; // coarse grid for density dots (screen px)
  const COINCIDE_ZOOM = 18; // reference zoom for "same spot" test
  const COINCIDE_PX = 22; // <= this many px apart at that zoom => same spot

  const map = L.map("map", { zoomControl: true, attributionControl: false }).setView(AUSTRIA, 7);

  // A pane for the density dots, sitting below the default marker pane (600) so
  // dots always render beneath the price pills, never on top of a listing.
  map.createPane("wkDots");
  map.getPane("wkDots").style.zIndex = 550;

  // ---- Basemap (vector, with raster fallback) ---------------------------
  const ATTR =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const RASTER = [
    {
      url: "https://{s}.basemap.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      opts: { subdomains: "abcd", maxZoom: 20, attribution: ATTR + " &copy; CARTO" },
    },
    {
      url: "https://tile.openstreetmap.de/{z}/{x}/{y}.png",
      opts: { maxZoom: 19, attribution: ATTR },
    },
    {
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      opts: { subdomains: "abc", maxZoom: 19, attribution: ATTR },
    },
  ];
  let tileLayer = null;
  function useRaster(i = 0) {
    if (i >= RASTER.length) return;
    if (tileLayer) map.removeLayer(tileLayer);
    let errors = 0;
    tileLayer = L.tileLayer(RASTER[i].url, RASTER[i].opts);
    tileLayer.on("tileerror", () => {
      if (++errors > 4 && i < RASTER.length - 1) useRaster(i + 1);
    });
    tileLayer.addTo(map);
  }
  try {
    if (typeof maplibregl === "undefined" || typeof L.maplibreGL !== "function")
      throw new Error("maplibre-gl not loaded");
    const gl = L.maplibreGL({
      style: "https://tiles.openfreemap.org/styles/bright",
      attribution:
        '&copy; <a href="https://openfreemap.org">OpenFreeMap</a> ' +
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);

    // Some browsers (notably Chrome under Manifest V3) block MapLibre's web worker
    // via CSP, so the vector map silently never renders. If it hasn't loaded
    // shortly, drop it and fall back to raster tiles.
    const glMap = gl.getMaplibreMap && gl.getMaplibreMap();
    let vectorOk = false;
    if (glMap) glMap.on("load", () => (vectorOk = true));
    setTimeout(() => {
      if (vectorOk) return;
      console.log("[willkarte] vector basemap didn't load — using raster");
      map.removeLayer(gl);
      useRaster();
    }, 5000);
  } catch (e) {
    console.log("[willkarte] vector basemap unavailable, using raster:", e);
    useRaster();
  }

  const layer = L.layerGroup().addTo(map); // pills + dots (reconciled)
  const empty = document.getElementById("wk-empty");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
    }[c]));
  }
  function priceAsc(a, b) {
    return (a.priceNum == null ? Infinity : a.priceNum) - (b.priceNum == null ? Infinity : b.priceNum);
  }

  // ---- Popup content ----------------------------------------------------
  function imageInner(l) {
    if (!l.thumb) return "";
    const img = '<img src="' + esc(l.thumb) + '" loading="lazy" alt="">';
    return l.url
      ? '<a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + img + "</a>"
      : img;
  }
  function detailsHtml(l) {
    const specs = [
      l.rooms ? l.rooms + " Zi." : null,
      l.size ? l.size + " m²" : null,
    ].filter(Boolean).join(" · ");
    return (
      '<div class="wk-pop-head">' +
        '<span class="wk-pop-price">' + esc(l.priceDisplay) + "</span>" +
        (specs ? '<span class="wk-pop-specs">' + esc(specs) + "</span>" : "") +
      "</div>" +
      (l.address ? '<div class="wk-pop-addr">' + esc(l.address) + "</div>" : "") +
      (l.title ? '<div class="wk-pop-title">' + esc(l.title) + "</div>" : "") +
      (l.url
        ? '<a class="wk-open" href="' + esc(l.url) + '" target="_blank" rel="noopener">Auf willhaben öffnen →</a>'
        : "")
    );
  }
  function popupOneHtml(l) {
    return (
      '<div class="wk-pop"><div class="wk-figure"><div class="wk-figure-img">' +
      imageInner(l) + "</div></div>" + detailsHtml(l) + "</div>"
    );
  }

  function navButton(glyph) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wk-nav-btn";
    b.textContent = glyph;
    return b;
  }

  // Carousel popup for a group of coincident flats: a short control strip across
  // the top of the image lets you page through the listings at that spot.
  function groupPopupEl(unit) {
    const el = document.createElement("div");
    el.className = "wk-pop";
    let idx = 0;

    const figure = document.createElement("div");
    figure.className = "wk-figure";
    const imgBox = document.createElement("div");
    imgBox.className = "wk-figure-img";
    const nav = document.createElement("div");
    nav.className = "wk-nav";
    const prev = navButton("‹");
    const next = navButton("›");
    const counter = document.createElement("span");
    counter.className = "wk-counter";
    nav.append(prev, counter, next);
    figure.append(imgBox, nav);

    const details = document.createElement("div");
    el.append(figure, details);

    function show() {
      const l = unit.flats[idx];
      imgBox.innerHTML = imageInner(l);
      details.innerHTML = detailsHtml(l);
      counter.textContent = idx + 1 + " / " + unit.flats.length;
    }
    function go(step, e) {
      e.preventDefault();
      e.stopPropagation();
      idx = (idx + step + unit.flats.length) % unit.flats.length;
      show();
    }
    prev.addEventListener("click", (e) => go(-1, e));
    next.addEventListener("click", (e) => go(1, e));
    show();
    return el;
  }

  // ---- Hover-to-open popups ---------------------------------------------
  let popupTimer = null;
  function cancelClose() {
    if (popupTimer) {
      clearTimeout(popupTimer);
      popupTimer = null;
    }
  }
  function scheduleClose() {
    cancelClose();
    popupTimer = setTimeout(() => map.closePopup(), 240);
  }
  function attachHoverPopup(marker) {
    // Attach to the visible pill element itself (not the Leaflet marker, whose
    // hit-target is the whole container). mouseenter/leave fire on the pill's
    // real rendered shape, so the popup opens only when the cursor is on the pill.
    marker.on("add", () => {
      const root = marker.getElement();
      const el = root && root.querySelector(".wk-price");
      if (!el) return;
      el.addEventListener("mouseenter", () => {
        cancelClose();
        marker.openPopup();
      });
      el.addEventListener("mouseleave", scheduleClose);
    });
    marker.on("popupopen", (e) => {
      const node = e.popup.getElement();
      if (!node) return;
      node.addEventListener("mouseenter", cancelClose);
      node.addEventListener("mouseleave", scheduleClose);
    });
  }

  // ---- Markers ----------------------------------------------------------
  function pill(html) {
    // className "wk-pin": the container is pointer-events:none (see CSS) so only
    // the visible pill/dot inside it catches the mouse — no offset ghost hit-area.
    return L.divIcon({ className: "wk-pin", html, iconSize: null, iconAnchor: [0, 0] });
  }

  function pricePillMarker(l) {
    const m = L.marker([l.lat, l.lng], {
      icon: pill('<div class="wk-price">' + esc(l.priceLabel) + "</div>"),
      riseOnHover: true,
    });
    m.bindPopup(popupOneHtml(l), { minWidth: 220, autoPan: false });
    attachHoverPopup(m);
    return m;
  }

  function groupMarker(unit) {
    const cheapest = unit.flats[0];
    const html =
      '<div class="wk-price wk-group">' +
      esc(cheapest.priceLabel) +
      '<span class="wk-more">+' + (unit.n - 1) + "</span>" +
      "</div>";
    const m = L.marker([unit.lat, unit.lng], { icon: pill(html), riseOnHover: true });
    m.bindPopup(groupPopupEl(unit), { minWidth: 220, autoPan: false });
    attachHoverPopup(m);
    return m;
  }

  function dotMarker(lat, lng) {
    const m = L.marker([lat, lng], { icon: pill('<div class="wk-dot"></div>'), pane: "wkDots" });
    m.on("click", () => map.setZoomAround([lat, lng], Math.min(map.getZoom() + 2, 19)));
    return m;
  }

  // ---- Build "units" (merge only genuinely-coincident flats) ------------
  let units = [];
  function buildUnits(flats) {
    const buckets = new Map();
    for (const l of flats) {
      const p = map.project([l.lat, l.lng], COINCIDE_ZOOM);
      const k = Math.round(p.x / COINCIDE_PX) + "_" + Math.round(p.y / COINCIDE_PX);
      let b = buckets.get(k);
      if (!b) buckets.set(k, (b = []));
      b.push(l);
    }
    const out = [];
    for (const b of buckets.values()) {
      b.sort(priceAsc);
      out.push({ lat: b[0].lat, lng: b[0].lng, flats: b, n: b.length, priceNum: b[0].priceNum });
    }
    out.sort((a, b) => {
      if (a.n > 1 && b.n <= 1) return -1;
      if (b.n > 1 && a.n <= 1) return 1;
      if (a.n > 1 && b.n > 1) return b.n - a.n;
      return priceAsc(a, b);
    });
    return out;
  }

  // ---- Reconciled render of pills + dots --------------------------------
  const shown = new Map(); // key -> marker
  let didFit = false;
  let lastLoadId = null;

  function updateVisible() {
    if (!units.length) {
      layer.clearLayers();
      shown.clear();
      return;
    }
    const zoom = map.getZoom();
    const bounds = map.getBounds().pad(0.15);

    const desired = new Map(); // key -> () => marker
    const pillCells = new Set();
    const leftovers = [];
    let pills = 0;

    for (const u of units) {
      if (!bounds.contains([u.lat, u.lng])) continue;
      const p = map.project([u.lat, u.lng], zoom);
      const cell = Math.round(p.x / PILL_CELL) + "_" + Math.round(p.y / PILL_CELL);
      if (pills < MAX_PILLS && !pillCells.has(cell)) {
        pillCells.add(cell);
        pills++;
        desired.set("p:" + cell, () => (u.n > 1 ? groupMarker(u) : pricePillMarker(u.flats[0])));
      } else {
        leftovers.push({ u, p });
      }
    }

    // Density dots for everything that didn't get a pill, one per coarse cell.
    // They render below the pills (wkDots pane), so any dot under a pill is hidden.
    const dotCells = new Set();
    for (const { u, p } of leftovers) {
      const dcell = Math.round(p.x / DOT_CELL) + "_" + Math.round(p.y / DOT_CELL);
      if (dotCells.has(dcell)) continue;
      dotCells.add(dcell);
      desired.set("d:" + dcell, () => dotMarker(u.lat, u.lng));
    }

    // Reconcile: keep markers whose key persists (so an open popup survives a pan).
    for (const [k, m] of shown) {
      if (!desired.has(k)) {
        layer.removeLayer(m);
        shown.delete(k);
      }
    }
    for (const [k, make] of desired) {
      if (shown.has(k)) continue;
      const m = make();
      shown.set(k, m);
      layer.addLayer(m);
    }
  }

  function render(listings, loadId) {
    // A new load id means a fresh search (filters changed / map re-opened): allow
    // the view to auto-fit again so it recenters on the new results.
    if (loadId !== lastLoadId) {
      lastLoadId = loadId;
      didFit = false;
    }
    const flats = (listings || []).slice().sort(priceAsc);
    units = buildUnits(flats);

    layer.clearLayers();
    shown.clear();

    if (!units.length) {
      empty.style.display = "flex";
      return;
    }
    empty.style.display = "none";

    if (!didFit) {
      const pts = flats.map((l) => [l.lat, l.lng]);
      if (pts.length === 1) map.setView(pts[0], 15);
      else map.fitBounds(pts, { padding: [40, 40], maxZoom: 16 });
      didFit = true;
    }
    updateVisible();
  }

  map.on("zoomend", updateVisible);
  map.on("moveend", updateVisible);

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d) return;
    if (d.type === "willkarte:listings") render(d.listings, d.loadId);
    if (d.type === "willkarte:show")
      setTimeout(() => {
        map.invalidateSize();
        updateVisible();
      }, 60);
  });

  if (window.parent) window.parent.postMessage({ type: "willkarte:ready" }, "*");
})();
