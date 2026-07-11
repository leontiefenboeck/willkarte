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

    // If the vector engine can't run (e.g. Chrome under Manifest V3 blocks
    // MapLibre's web worker via CSP) it fires an error before it ever renders —
    // fall back to raster then. A slow load is NOT an error, so this leaves a
    // working (or still-loading) vector map alone.
    const glMap = gl.getMaplibreMap && gl.getMaplibreMap();
    if (glMap) {
      glMap.on("error", (ev) => {
        if (glMap.loaded()) return; // already worked — ignore later tile hiccups
        const msg = (ev && ev.error && ev.error.message) || "";
        if (!/worker|blob|security|content security|not allowed|failed to construct/i.test(msg))
          return;
        console.log("[willkarte] vector engine blocked — using raster:", msg);
        map.removeLayer(gl);
        useRaster();
      });
    }
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

  // ---- Merkliste state (mirrors willhaben's, kept by the content script) --
  let savedIds = new Set();
  let canSave = false; // false when signed out — then no stars at all
  // Elements whose "is-saved" class follows the Merkliste. A group pill watches
  // every flat at its spot (it shows a star if any of them is saved), a single
  // pill or a popup star watches just one.
  let starTargets = [];

  function isSaved(l) {
    return savedIds.has(String(l.id));
  }
  function trackStar(el, flats) {
    const ids = flats.map((l) => String(l.id));
    starTargets.push({ el, ids });
    el.classList.toggle("is-saved", ids.some((id) => savedIds.has(id)));
  }
  function paintStars() {
    starTargets = starTargets.filter((t) => t.el.isConnected); // drop removed markers
    for (const t of starTargets)
      t.el.classList.toggle("is-saved", t.ids.some((id) => savedIds.has(id)));
  }
  // Optimistic: flip the star now, and ask the content script to do the real call.
  // It always answers with the true state, so a failure snaps the star back.
  function toggleSaved(l) {
    const want = !isSaved(l);
    if (want) savedIds.add(String(l.id));
    else savedIds.delete(String(l.id));
    paintStars();
    parent.postMessage({ type: "willkarte:save", id: l.id, save: want }, "*");
  }

  // ---- Popup content ----------------------------------------------------
  // One builder for both cases: a photo gallery of the current listing (‹ › on the
  // image edges + progress dots), and — when several flats share the spot — a bar
  // above the image to page between the listings themselves.
  function detailsHtml(l) {
    const specs = [
      parseFloat(l.rooms) > 0 ? l.rooms + " Zi." : null,
      l.size ? l.size + " m²" : null,
    ].filter(Boolean).join(" · ");
    return (
      '<div class="wk-pop-head">' +
        '<span class="wk-pop-price">' + esc(l.priceDisplay) + "</span>" +
        (specs ? '<span class="wk-pop-specs">' + esc(specs) + "</span>" : "") +
      "</div>" +
      (l.address ? '<div class="wk-pop-addr">' + esc(l.address) + "</div>" : "") +
      (l.title ? '<div class="wk-pop-title">' + esc(l.title) + "</div>" : "")
    );
  }

  function navButton(glyph, cls) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = glyph;
    return b;
  }
  // Star for the Merkliste: outline when not saved, filled when saved (the CSS
  // swaps them on "is-saved"), same shape either way.
  const STAR_PATH =
    "M11 2.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L11 15.9l-5.2 2.7 1-5.8L2.6 8.7l5.8-.8z";
  function starButton() {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wk-star-btn";
    b.title = "Auf die Merkliste";
    b.innerHTML =
      '<svg viewBox="0 0 22 22" aria-hidden="true"><path d="' + STAR_PATH + '" ' +
      'stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    return b;
  }

  // The photo arrows use an SVG chevron, not a "‹" glyph: text arrows sit on the
  // baseline (never optically centred in a circle) and their size varies by font.
  function chevronButton(dir, cls) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    const d = dir < 0 ? "M14.5 4.5 8 11l6.5 6.5" : "M7.5 4.5 14 11l-6.5 6.5";
    b.innerHTML =
      '<svg viewBox="0 0 22 22" aria-hidden="true"><path d="' + d + '" fill="none" ' +
      'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return b;
  }
  // Arrow clicks must not bubble: the image is a link to the ad, and the pill
  // itself opens the ad on click.
  function onNav(btn, fn) {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    });
  }
  const MAX_DOTS = 10; // beyond this, show "i / n" instead of a dot per photo

  function popupEl(flats) {
    const el = document.createElement("div");
    el.className = "wk-pop";
    let flat = 0; // which listing at this spot
    let shot = 0; // which photo of that listing

    // Listing bar (only when the spot holds several flats).
    if (flats.length > 1) {
      const bar = document.createElement("div");
      bar.className = "wk-listings";
      const prev = navButton("‹", "wk-listings-btn");
      const next = navButton("›", "wk-listings-btn");
      const label = document.createElement("span");
      label.className = "wk-listings-label";
      onNav(prev, () => goFlat(-1));
      onNav(next, () => goFlat(1));
      bar.append(prev, label, next);
      el.append(bar);
      el._label = label;
    }

    const figure = document.createElement("div");
    figure.className = "wk-figure";
    const imgBox = document.createElement("div");
    imgBox.className = "wk-figure-img";
    const back = chevronButton(-1, "wk-shot-btn wk-shot-prev");
    const fwd = chevronButton(1, "wk-shot-btn wk-shot-next");
    const dots = document.createElement("div");
    dots.className = "wk-dots";
    onNav(back, () => goShot(-1));
    onNav(fwd, () => goShot(1));
    figure.append(imgBox, back, fwd, dots);

    const body = document.createElement("div");
    body.className = "wk-pop-body";
    // The star lives in the white strip, bottom-right. It's a sibling of the body,
    // not a child, because the body's innerHTML is rewritten on every flat change.
    const star = starButton();
    onNav(star, () => toggleSaved(flats[flat]));
    el.append(figure, body, star);

    function renderPhoto() {
      const l = flats[flat];
      const src = l.images[shot];
      const img = src ? '<img src="' + esc(src) + '" alt="">' : "";
      imgBox.innerHTML = l.url
        ? '<a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + img + "</a>"
        : img;

      const n = l.images.length;
      figure.classList.toggle("wk-single-shot", n < 2);
      if (n < 2) dots.innerHTML = "";
      else if (n <= MAX_DOTS) {
        dots.className = "wk-dots";
        dots.innerHTML = "";
        for (let i = 0; i < n; i++) {
          const d = document.createElement("span");
          d.className = "wk-dot-i" + (i === shot ? " is-on" : "");
          dots.append(d);
        }
      } else {
        dots.className = "wk-dots wk-dots-count";
        dots.textContent = shot + 1 + " / " + n;
      }
    }
    function renderFlat() {
      shot = 0;
      body.innerHTML = detailsHtml(flats[flat]);
      if (el._label) el._label.textContent = "Wohnung " + (flat + 1) + " von " + flats.length;
      // The one star button follows whichever flat is on show.
      starTargets = starTargets.filter((t) => t.el !== star);
      trackStar(star, [flats[flat]]);
      renderPhoto();
    }
    function goShot(step) {
      const n = flats[flat].images.length;
      if (n < 2) return;
      shot = (shot + step + n) % n;
      renderPhoto();
    }
    function goFlat(step) {
      flat = (flat + step + flats.length) % flats.length;
      renderFlat();
    }

    renderFlat();
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
  // Placement: Leaflet always draws a popup above the marker, which clips near the
  // top edge. Instead we pick a side (above / below / left / right) that (a) fits in
  // the viewport and (b) never covers the pill itself, preferring the side that
  // points towards the map centre — so the popup grows inwards, not off-screen.
  // Done by measuring the popup at offset (0,0) and then setting the offset that
  // moves it to the chosen rectangle (Leaflet positions from options.offset).
  const POPUP_GAP = 10; // px between pill and popup
  const POPUP_PAD = 12; // min px between popup and map edge
  function fitPopup(popup) {
    if (!popup || !popup.isOpen()) return;
    const el = popup.getElement();
    const src = popup._source;
    const pin = src && src.getElement() && src.getElement().querySelector(".wk-price");
    if (!el || !pin) return;

    popup.options.offset = L.point(0, 0);
    popup._updatePosition();

    const box = map.getContainer().getBoundingClientRect();
    const nat = el.getBoundingClientRect(); // natural (offset-free) position
    const m = pin.getBoundingClientRect(); // the pill we must not cover
    const w = nat.width;
    const h = nat.height;
    const cx = (m.left + m.right) / 2;
    const cy = (m.top + m.bottom) / 2;
    const minX = box.left + POPUP_PAD;
    const maxX = box.right - POPUP_PAD - w;
    const minY = box.top + POPUP_PAD;
    const maxY = box.bottom - POPUP_PAD - h;
    const clamp = (v, lo, hi) => (lo > hi ? lo : Math.min(Math.max(v, lo), hi));

    // Candidate rects: fixed on the placement axis, clamped on the other one (so
    // clamping slides the popup along the pill, never on top of it).
    const cands = [
      { x: clamp(cx - w / 2, minX, maxX), y: m.top - POPUP_GAP - h, ok: m.top - POPUP_GAP - h >= minY },
      { x: clamp(cx - w / 2, minX, maxX), y: m.bottom + POPUP_GAP, ok: m.bottom + POPUP_GAP <= maxY },
      { x: m.left - POPUP_GAP - w, y: clamp(cy - h / 2, minY, maxY), ok: m.left - POPUP_GAP - w >= minX },
      { x: m.right + POPUP_GAP, y: clamp(cy - h / 2, minY, maxY), ok: m.right + POPUP_GAP <= maxX },
    ];
    // Prefer the placement whose popup centre lands closest to the map centre.
    const mx = (box.left + box.right) / 2;
    const my = (box.top + box.bottom) / 2;
    const score = (c) => Math.hypot(c.x + w / 2 - mx, c.y + h / 2 - my);
    const fits = cands.filter((c) => c.ok);
    const pick = (fits.length ? fits : [{ x: clamp(cx - w / 2, minX, maxX), y: clamp(m.bottom + POPUP_GAP, minY, maxY) }])
      .sort((a, b) => score(a) - score(b))[0];

    popup.options.offset = L.point(pick.x - nat.left, pick.y - nat.top);
    popup._updatePosition();
  }
  map.on("popupopen", (e) => {
    fitPopup(e.popup);
    // The image loads late and grows the popup upwards — re-fit when it arrives.
    const node = e.popup.getElement();
    if (node) {
      node.querySelectorAll("img").forEach((img) => {
        if (!img.complete) img.addEventListener("load", () => fitPopup(e.popup), { once: true });
      });
    }
  });
  map.on("move zoom", () => {
    const p = map._popup;
    if (p) fitPopup(p);
  });

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

  // A pill on the Merkliste carries "is-saved" and the CSS recolours it (gold);
  // no icon — a star glyph crowds a pill this small.
  function pricePillMarker(l) {
    const m = L.marker([l.lat, l.lng], {
      icon: pill('<div class="wk-price">' + esc(l.priceLabel) + "</div>"),
      riseOnHover: true,
    });
    m.bindPopup(popupEl([l]), { minWidth: 320, maxWidth: 520, autoPan: false });
    attachHoverPopup(m);
    m.on("add", () => {
      const el = m.getElement() && m.getElement().querySelector(".wk-price");
      if (!el) return;
      trackStar(el, [l]);
      // Clicking the pill opens the willhaben ad, same as clicking the image.
      if (l.url) {
        el.style.cursor = "pointer";
        el.addEventListener("click", () => window.open(l.url, "_blank", "noopener"));
      }
    });
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
    m.bindPopup(popupEl(unit.flats), { minWidth: 320, maxWidth: 520, autoPan: false });
    attachHoverPopup(m);
    // A group pill stars if any flat at that spot is on the Merkliste.
    m.on("add", () => {
      const el = m.getElement() && m.getElement().querySelector(".wk-price");
      if (el) trackStar(el, unit.flats);
    });
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

    const marker = (u) => () => (u.n > 1 ? groupMarker(u) : pricePillMarker(u.flats[0]));

    // Merkliste units first: they always get a pill — never demoted to a dot by the
    // MAX_PILLS cap or the spacing grid — so a starred flat can't hide at any zoom.
    // Their key is the listing id, not the cell, so it survives a zoom change.
    for (const u of units) {
      if (!u.flats.some(isSaved)) continue;
      if (!bounds.contains([u.lat, u.lng])) continue;
      const p = map.project([u.lat, u.lng], zoom);
      const cell = Math.round(p.x / PILL_CELL) + "_" + Math.round(p.y / PILL_CELL);
      pillCells.add(cell);
      // If it's already on screen as a normal pill, keep that key: the reconciler
      // then leaves the marker (and its open popup) alone when you star it.
      desired.set(shown.has("p:" + cell) ? "p:" + cell : "s:" + u.flats[0].id, marker(u));
    }

    for (const u of units) {
      if (u.flats.some(isSaved)) continue; // already pinned above
      if (!bounds.contains([u.lat, u.lng])) continue;
      const p = map.project([u.lat, u.lng], zoom);
      const cell = Math.round(p.x / PILL_CELL) + "_" + Math.round(p.y / PILL_CELL);
      if (pills < MAX_PILLS && !pillCells.has(cell)) {
        pillCells.add(cell);
        pills++;
        desired.set("p:" + cell, marker(u));
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
    if (d.type === "willkarte:saved") {
      savedIds = new Set((d.ids || []).map(String));
      canSave = !!d.canSave; // signed out: no star button at all
      document.body.classList.toggle("wk-can-save", canSave);
      paintStars();
      updateVisible(); // a newly starred flat gets promoted from dot to pill
    }
    if (d.type === "willkarte:show")
      setTimeout(() => {
        map.invalidateSize();
        updateVisible();
      }, 60);
  });

  if (window.parent) window.parent.postMessage({ type: "willkarte:ready" }, "*");
})();
