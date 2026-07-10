// willkarte — content script
// Runs on willhaben real estate search pages. Adds a floating "Karte" button
// that opens a full-screen map of the current search results. The map itself is
// rendered in an extension-owned iframe (map.html) so it isn't blocked by
// willhaben's content-security policy.
//
// Listing data is read from willhaben's own server-rendered JSON (the
// __NEXT_DATA__ script tag), fetched page by page from the current search URL.

(function () {
  "use strict";

  if (window.__willkarteLoaded) return; // guard against double-injection
  window.__willkarteLoaded = true;

  const api = typeof browser !== "undefined" ? browser : chrome;

  // How many listings to pull. Searches can have thousands; we cap for
  // politeness and performance (the map handles this many comfortably).
  const MAX_LISTINGS = 1000;
  const ROWS_PER_PAGE = 100; // requested page size (willhaben may cap it lower)
  const MAX_PAGES = 40; // hard safety bound on number of requests
  const PAGE_DELAY_MS = 200; // pause between requests

  // Load state. A fresh load starts each time the map is opened; `loadGen`
  // supersedes any load still running if you re-open before it finished.
  let current = []; // listings collected so far
  let byId = new Map(); // de-dupes across pages
  let total = null; // full hit count for the current filters
  let loadGen = 0;

  // ---- Parsing willhaben's embedded data --------------------------------
  function rootFrom(doc) {
    const el = doc.getElementById("__NEXT_DATA__");
    try {
      return el ? JSON.parse(el.textContent) : null;
    } catch (e) {
      return null;
    }
  }

  function searchResultOf(root) {
    return root?.props?.pageProps?.searchResult || null;
  }

  function totalOf(sr) {
    return sr?.rowsFound || sr?.rowsRequested || sr?.rowsReturned || null;
  }

  // Short marker label, e.g. 679 -> "€679", 320000 -> "€320k", 1.25M -> "€1,3M".
  function compactPrice(num, fallback) {
    if (!isFinite(num)) return fallback || "?";
    if (num >= 1e6) return "€" + (num / 1e6).toFixed(1).replace(".", ",") + "M";
    if (num >= 1e4) return "€" + Math.round(num / 1e3) + "k";
    return "€" + Math.round(num);
  }

  // Turn willhaben's advert list into the compact shape the map needs.
  function parseListings(root) {
    const raw = searchResultOf(root)?.advertSummaryList?.advertSummary;
    if (!Array.isArray(raw)) return [];

    return raw
      .map((ad) => {
        // willhaben stores fields as a [{name, values}] list — flatten it.
        const a = {};
        const attrs = ad?.attributes?.attribute;
        if (Array.isArray(attrs)) for (const at of attrs) a[at.name] = at.values && at.values[0];

        const [lat, lng] = (a.COORDINATES || "").split(",").map(Number);
        if (!isFinite(lat) || !isFinite(lng)) return null; // no map without coords

        const priceNum = parseFloat(a.PRICE);
        return {
          id: String(ad.id || a.ADID || a.AD_UUID),
          lat,
          lng,
          priceNum: isFinite(priceNum) ? priceNum : null,
          priceDisplay: a.PRICE_FOR_DISPLAY || (a.PRICE ? "€ " + a.PRICE : "—"),
          priceLabel: compactPrice(priceNum, a.PRICE_FOR_DISPLAY),
          title: a.HEADING || ad.description || "",
          address: [a.ADDRESS, a.POSTCODE, a.LOCATION].filter(Boolean).join(", "),
          size: a["ESTATE_SIZE/LIVING_AREA"] || a.ESTATE_SIZE || null,
          rooms: a.OF_ROOMS || null,
          thumb: a.MMO ? "https://cache.willhaben.at/mmo/" + a.MMO : null,
          url: a.SEO_URL ? "https://www.willhaben.at/iad/" + a.SEO_URL : ad.selfLink || null,
        };
      })
      .filter(Boolean);
  }

  // ---- UI: floating toggle + full-screen overlay ------------------------
  const toggle = document.createElement("button");
  toggle.id = "willkarte-toggle";
  toggle.textContent = "🗺 Karte";

  const overlay = document.createElement("div");
  overlay.id = "willkarte-overlay";
  overlay.innerHTML =
    '<div id="willkarte-bar">' +
    '<span id="willkarte-count">willkarte</span>' +
    '<button type="button" id="willkarte-close" title="Zurück zur Liste">Zurück zur Liste →</button>' +
    "</div>";

  const iframe = document.createElement("iframe");
  iframe.id = "willkarte-iframe";
  iframe.src = api.runtime.getURL("map.html");
  overlay.appendChild(iframe);

  document.body.append(toggle, overlay);

  function openMap() {
    overlay.classList.add("willkarte-open");
    toggle.style.display = "none";
    startLoading(); // (re)load the current search each time the map opens
    post({ type: "willkarte:show" }); // the map was sized while hidden — recalc
  }
  function closeMap() {
    overlay.classList.remove("willkarte-open");
    toggle.style.display = "";
  }

  toggle.addEventListener("click", openMap);
  overlay.querySelector("#willkarte-close").addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMap();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("willkarte-open")) closeMap();
  });

  function setCount(loaded) {
    const capped = loaded >= MAX_LISTINGS && total && total > MAX_LISTINGS;
    overlay.querySelector("#willkarte-count").textContent =
      "willkarte · " + loaded + (total ? " / " + total : "") + " Inserate" +
      (capped ? " (Limit " + MAX_LISTINGS + ")" : "");
  }

  // ---- Messaging with the map iframe ------------------------------------
  let iframeReady = false;
  function post(msg) {
    if (iframe.contentWindow) iframe.contentWindow.postMessage(msg, "*");
  }
  function sendListings() {
    post({ type: "willkarte:listings", listings: current, loadId: loadGen });
  }

  window.addEventListener("message", (e) => {
    if (e.data?.type === "willkarte:ready") {
      iframeReady = true;
      sendListings();
    }
  });

  // ---- Loading ----------------------------------------------------------
  function startLoading() {
    const gen = ++loadGen; // invalidates any load still running
    current = [];
    byId = new Map();
    total = null;
    loadAll(gen);
  }

  async function loadAll(gen) {
    let pageSize = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (gen !== loadGen) return; // a newer load took over
      if (byId.size >= MAX_LISTINGS) break;
      if (total && byId.size >= total) break;

      const url = new URL(location.href);
      url.searchParams.set("rows", String(ROWS_PER_PAGE));
      url.searchParams.set("page", String(page));

      let root;
      try {
        const res = await fetch(url.toString(), { credentials: "include" });
        if (!res.ok) break;
        root = rootFrom(new DOMParser().parseFromString(await res.text(), "text/html"));
      } catch (e) {
        console.log("[willkarte] page", page, "fetch failed:", e);
        break;
      }
      if (gen !== loadGen) return;

      if (page === 1) total = totalOf(searchResultOf(root)); // fresh count
      const pageListings = parseListings(root);
      if (!pageListings.length) break;
      if (pageSize === null) pageSize = pageListings.length;

      for (const l of pageListings) byId.set(l.id, l);
      current = [...byId.values()];
      if (iframeReady) sendListings();
      setCount(current.length);

      // Fewer results than the first page means we've reached the end.
      if (pageListings.length < pageSize) break;
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    }
  }
})();
