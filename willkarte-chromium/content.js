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

  if (window.__willkarteLoaded) return;
  window.__willkarteLoaded = true;

  const api = typeof browser !== "undefined" ? browser : chrome;

  // Searches can have thousands of hits; cap for politeness/performance.
  const MAX_LISTINGS = 1000;
  const ROWS_PER_PAGE = 100; // requested page size (willhaben may cap it lower)
  const MAX_PAGES = 40; // hard safety bound on number of requests
  const DEFAULT_PILLS = 50; // price pills shown at once (slider in the top bar)
  const PAGE_DELAY_MS = 200; // pause between requests

  // Load state. A fresh load starts on each map open; `loadGen` supersedes any
  // load still running if you re-open before it finished.
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
          rooms: a.NUMBER_OF_ROOMS || null,
          // ALL_IMAGE_URLS is one ";"-separated string of every photo of the ad;
          // MMO is just the primary one. Fall back to MMO if it's missing.
          images: (a.ALL_IMAGE_URLS ? a.ALL_IMAGE_URLS.split(";") : a.MMO ? [a.MMO] : [])
            .map((p) => p.trim())
            .filter(Boolean)
            .map((p) => "https://cache.willhaben.at/mmo/" + p),
          url: a.SEO_URL ? "https://www.willhaben.at/iad/" + a.SEO_URL : ad.selfLink || null,
        };
      })
      .filter(Boolean);
  }

  // ---- Merkliste (willhaben's own "Anzeige merken") ---------------------
  // Saved state isn't in the search JSON; it lives in willhaben's BFF at /webapi.
  // We call it with the session cookie (this script runs on willhaben.at):
  //   GET    /iad/userfolders/all/{loginId}  -> { adIds: [{ adId }, ...] }
  //   GET    /iad/userfolders/{loginId}      -> { advertFolders: [{ id, name }] }
  //   POST   /iad/userfolders/save/{loginId}/{folderId}/{adId}
  //   DELETE /iad/userfolders/savedAd/{loginId}/{adId}
  // Headers: X-WH-Client on every call, and a CSRF token (the x-bbx-csrf-token
  // cookie echoed back as a header) on non-GETs — without them the BFF rejects.
  // `loginId` is in __NEXT_DATA__ when signed in; absent ⇒ no stars.
  // URL must be absolute: a Firefox content-script fetch has no page origin to
  // resolve "/webapi/…" against.
  const API = "https://www.willhaben.at/webapi";
  const CSRF = "x-bbx-csrf-token";
  const loginId = (() => {
    const p = rootFrom(document)?.props?.profileData;
    return p && p.loginId != null ? String(p.loginId) : null;
  })();
  let folderId = null; // the Merkliste to save into (willhaben's default: the first)
  let saved = new Set(); // ad ids currently on the Merkliste

  function cookie(name) {
    const hit = document.cookie
      .split("; ")
      .find((c) => c.slice(0, name.length + 1) === name + "=");
    return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
  }
  async function wh(path, opts = {}) {
    const method = opts.method || "GET";
    const token = method === "GET" ? null : cookie(CSRF);
    const res = await fetch(API + path, {
      credentials: "include",
      ...opts,
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        "X-WH-Client": "api@willhaben.at;responsive_web;server;1.0.0;",
        ...(token ? { [CSRF]: token } : {}),
        ...opts.headers,
      },
    });
    if (!res.ok) throw new Error(method + " " + path + " → HTTP " + res.status);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  function sendSaved() {
    post({ type: "willkarte:saved", ids: [...saved], canSave: !!loginId });
  }
  async function loadSaved() {
    if (!loginId) return;
    try {
      const data = await wh("/iad/userfolders/all/" + loginId);
      saved = new Set((data?.adIds || []).map((a) => String(a.adId)));
    } catch (e) {
      console.log("[willkarte] Merkliste not readable:", e);
    }
    sendSaved();
  }
  async function folder() {
    if (folderId == null) {
      const data = await wh("/iad/userfolders/" + loginId);
      const f = (data?.advertFolders || [])[0];
      if (!f || f.id == null) throw new Error("no Merkliste folder");
      folderId = f.id;
    }
    return folderId;
  }
  // The map updates its star optimistically; we always answer with the real state,
  // so a failed call snaps the star back.
  async function setSaved(id, want) {
    if (!loginId) return;
    try {
      if (want) {
        await wh("/iad/userfolders/save/" + loginId + "/" + (await folder()) + "/" + id, {
          method: "POST",
        });
        saved.add(String(id));
      } else {
        await wh("/iad/userfolders/savedAd/" + loginId + "/" + id, { method: "DELETE" });
        saved.delete(String(id));
      }
    } catch (e) {
      console.log("[willkarte] Merkliste update failed:", e);
    }
    sendSaved();
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
    '<label id="willkarte-pills" title="Wie viele Preise gleichzeitig auf der Karte. ' +
    'Über das, was überschneidungsfrei Platz hat, werden die Preise übereinander gezeichnet.">' +
    "<span>Sichtbare Preise</span>" +
    '<input type="range" id="willkarte-pills-range" min="0" max="' + DEFAULT_PILLS +
    '" step="1" value="' + DEFAULT_PILLS + '">' +
    '<output id="willkarte-pills-val">' + DEFAULT_PILLS + "</output>" +
    "</label>" +
    '<button type="button" id="willkarte-close" title="Karte schließen">✕ Karte schließen</button>' +
    "</div>";

  const iframe = document.createElement("iframe");
  iframe.id = "willkarte-iframe";
  iframe.src = api.runtime.getURL("map.html");
  overlay.appendChild(iframe);

  document.body.append(toggle, overlay);

  function openMap() {
    overlay.classList.add("willkarte-open");
    toggle.style.display = "none";
    // A tagged history entry so the back button closes the map instead of
    // navigating willhaben away.
    if (!(history.state && history.state.willkarte)) {
      history.pushState({ willkarte: true }, "");
    }
    startLoading(); // (re)load the current search each time the map opens
    post({ type: "willkarte:show" }); // the map was sized while hidden — recalc
  }
  function hideMap() {
    overlay.classList.remove("willkarte-open");
    toggle.style.display = "";
  }
  // User-initiated close (button/Escape): pop our history entry, which fires
  // popstate → hideMap. If it's not on top (shouldn't happen), hide directly.
  function closeMap() {
    if (history.state && history.state.willkarte) history.back();
    else hideMap();
  }

  // Pill count lives here (not the map) so the slider can sit in the top bar; the
  // map is told on every change and on ready. Max = loaded count ("show them all").
  const pillRange = overlay.querySelector("#willkarte-pills-range");
  const pillVal = overlay.querySelector("#willkarte-pills-val");
  function sendMaxPills() {
    post({ type: "willkarte:maxpills", n: Number(pillRange.value) });
  }
  // As listings stream in the ceiling is the result count, and until the user
  // touches the slider the value derives from it — so 3 hits show 3, not "50 of 3".
  let pillsTouched = false;
  function setPillMax(loaded) {
    const max = Math.max(Number(pillRange.min), loaded);
    const value = pillsTouched
      ? Math.min(Number(pillRange.value), max) // keep the user's choice, but in range
      : Math.min(DEFAULT_PILLS, max);
    if (Number(pillRange.max) === max && Number(pillRange.value) === value) return;
    pillRange.max = String(max);
    pillRange.value = String(value);
    pillVal.textContent = pillRange.value;
    sendMaxPills();
  }
  pillRange.addEventListener("input", () => {
    pillsTouched = true;
    pillVal.textContent = pillRange.value;
    sendMaxPills();
  });

  toggle.addEventListener("click", openMap);
  overlay.querySelector("#willkarte-close").addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMap();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("willkarte-open")) closeMap();
  });
  // Back button while the map is open: close it (consuming our pushed entry).
  window.addEventListener("popstate", () => {
    if (overlay.classList.contains("willkarte-open")) hideMap();
  });

  function setCount(loaded) {
    setPillMax(loaded);
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
    const d = e.data;
    if (d?.type === "willkarte:ready") {
      iframeReady = true;
      sendMaxPills();
      sendListings();
      sendSaved();
    }
    if (d?.type === "willkarte:save") setSaved(d.id, d.save);
  });

  // ---- Loading ----------------------------------------------------------
  function startLoading() {
    const gen = ++loadGen; // invalidates any load still running
    current = [];
    byId = new Map();
    total = null;
    loadAll(gen);
    loadSaved(); // the Merkliste may have changed since the last open
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
