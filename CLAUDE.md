# willkarte

A **Firefox browser extension** that adds an interactive map to real-estate
search on **willhaben.at** (Austria's biggest classifieds site). "willkarte" =
*willhaben* + *Karte* (German for "map"). Every listing matching the user's
current search filters is shown as a price pill at its geographic location.
Hovering a pill shows a thumbnail, details, and a link to the ad. Filtering is
left entirely to willhaben's own UI — the extension only augments the results.

## How it works

willhaben is a Next.js app that server-renders its search results and embeds the
full listing data as JSON in a `<script id="__NEXT_DATA__">` tag. willkarte reads
that JSON — no HTML scraping, no private-API reverse-engineering, no server, no
API keys.

- **Listings path:** `__NEXT_DATA__` → `props.pageProps.searchResult.advertSummaryList.advertSummary` (30 per page).
- Each listing has `attributes.attribute` = array of `{name, values:[...]}`. Key attribute names:
  - `COORDINATES` — `"lat,lng"` string, present on every listing.
  - `PRICE` (number string) / `PRICE_FOR_DISPLAY` (e.g. `"€ 679,83"`).
  - `SEO_URL` — relative; full link = `https://www.willhaben.at/iad/` + `SEO_URL`.
  - `HEADING`, `ADDRESS`, `POSTCODE`, `LOCATION`, `ESTATE_SIZE`, `NUMBER_OF_ROOMS`.
  - `MMO` — primary image path; full = `https://cache.willhaben.at/mmo/` + `MMO`.
- **All listings, not just page 1:** `content.js` fetches the remaining result
  pages in the background (same-origin `fetch` of the current URL with `&page=N`,
  parsing `__NEXT_DATA__` out of each response), capped by `MAX_LISTINGS` for
  politeness/perf. The current filters are already in `location.href`, so
  paginating that URL reuses them.
- **Loading is deferred and re-run on every open** (`startLoading`, called from
  `openMap`). Nothing is fetched while adjusting filters. Each open starts a FRESH
  load from `location.href` (current filters) — no page reload needed to pick up
  new filters. A `loadGen` counter supersedes any still-running load if you re-open
  quickly; the fresh `total` is read from the fetched page 1. Each load is tagged
  with `loadId`; `map.js` refits the view (`didFit=false`) when `loadId` changes so
  it recenters on the new results.

## Architecture

- `manifest.json` — Firefox **Manifest V2**. Content script on
  `https://www.willhaben.at/iad/immobilien/*`. Map assets are
  `web_accessible_resources`.
- `content.js` — runs in willhaben's page (isolated world). Parses listings,
  loads all pages, builds the floating **🗺 Karte** toggle button and a
  **full-screen overlay** containing the map iframe. Talks to the iframe via
  `postMessage` (`willkarte:listings`, `willkarte:show`; iframe replies
  `willkarte:ready`).
- `panel.css` — styles for the toggle button and overlay (ids scoped
  `#willkarte-*`).
- `map.html` / `map.js` — the map, rendered **inside an extension-owned iframe**.
  This is deliberate: it sidesteps willhaben's Content-Security-Policy (which
  would block map tiles injected directly) and isolates Leaflet's CSS.
  Basemap is a modern **vector** style: **OpenFreeMap "Bright"** rendered by
  **MapLibre GL**, bridged into Leaflet via **leaflet-maplibre-gl** (`L.maplibreGL`)
  so all the Leaflet markers/panes/logic are unchanged. Falls back to a raster
  tile chain (CARTO Voyager → OSM.de → OSM) if the vector engine is unavailable.
  The Leaflet attribution control is disabled (`attributionControl: false`) at the
  user's request — note OSM/OpenFreeMap attribution is technically expected.
- `vendor/` — Leaflet 1.9.4, MapLibre GL 4.7.1, leaflet-maplibre-gl 0.0.22,
  vendored locally (no CDN, no key, no build step).

## Gotchas / decisions

- **Tiles have an automatic fallback chain** (`map.js` `PROVIDERS`): CARTO
  Positron → OpenStreetMap.de → standard OSM. If a provider's tiles fail to load
  (raw OSM `403`s from an extension origin — "referer required"; CARTO can be
  blocked by tracking protection / regionally), the `tileerror` handler switches
  to the next. This is why the map is robust to any single provider being blocked.
- **Firefox isolated world:** values set on `window` by the content script are
  NOT visible from the devtools console (page context). Log/act in the script.
- **Marker centering:** price boxes are variable width, so they're centered on
  their coordinate with CSS `transform: translate(-50%,-50%)` and
  `iconAnchor:[0,0]`, not a fixed pixel anchor.
- **Display model (map.js), NOT markercluster.** The user rejected cluster
  circles. Pipeline:
  1. `buildUnits()` merges only *genuinely coincident* flats — bucketed by pixels
     projected at a FIXED `COINCIDE_ZOOM` (so the merge distance is a fixed ~15 m
     in the real world and never merges flats that separate when you zoom in). A
     unit is one flat or a coincidence group.
  2. `updateVisible()` draws at most `MAX_PILLS` price pills, spaced on a
     `PILL_CELL` pixel grid so they don't overlap and stay a roughly constant
     readable number. Priority: coincidence groups first, then cheapest singles.
  3. Units that don't get a pill become small empty **density dots** (`.wk-dot`,
     one per `DOT_CELL` coarse cell); clicking a dot zooms in there. Dots render
     in a custom **`wkDots` pane (z-index 550, below the marker pane 600)** so
     they always sit *beneath* the price pills — a dot under a pill is just hidden
     by it, so no overlap. They are always drawn (no pill-overlap suppression).
  4. A coincidence group renders as a **`.wk-group` pill**: the cheapest price + a
     `.wk-more` "+N" badge for the extra flats. Its popup is a **carousel**
     (`groupPopupEl`) with ‹ › `.wk-nav-btn` arrows overlaid on the image + a
     `.wk-counter` "i / n" badge, to page through the flats. (Earlier fan-out/spider
     approach was removed.) Leaflet's popup ✕ is hidden and `.leaflet-popup-content`
     margin made symmetric (default reserves right-side space for the ✕).
- **Popups open on HOVER, not click** (`attachHoverPopup`): listeners are bound to
  the visible `.wk-price` element (via the marker's `add` event), NOT the Leaflet
  marker — the marker's hit-target is the whole container, which is offset from the
  pill by the centering transform and gave a "ghost" hover zone. `mouseenter` opens,
  `mouseleave` schedules a ~240 ms close (`scheduleClose`/`cancelClose`), and the
  same on the popup element keeps it open so you can reach the arrows/links. Popups
  use `autoPan:false` (no map jump on hover). The container is also
  `pointer-events:none` (`.wk-pin`) with the pill/dot `pointer-events:auto`.
  - `updateVisible` **reconciles** by cell key (adds/removes only what changed) so
     an open popup survives a pan. `map.project(latlng, zoom)` returns absolute
     pixels, so grid cells are stable under panning (only change on zoom).
  - Recomputed on `zoomend`/`moveend`.
- **Marker look is deliberately Airbnb-style:** white rounded price *pills* with a
  thin outline and soft shadow that invert to dark on hover. Photo in a popup links
  to the ad.
- **View auto-fits once per load** (`didFit`), reset when `loadId` changes so a new
  search recenters but streaming pages don't yank the map mid-pan.

## Notes

- **Filters come from the page URL.** `location.href` carries willhaben's active
  filters, so paginating it reuses them. A filter that changed results *without*
  changing the URL wouldn't be picked up — but willhaben puts filters in the URL,
  and each map-open re-reads it, so this is rarely an issue.

## Dev / loading

Load unpacked in Firefox: `about:debugging#/runtime/this-firefox` → **Load
Temporary Add-on…** → pick `manifest.json`. After editing files, click
**Reload** there, then hard-reload the willhaben tab (Ctrl+Shift+R). Temporary
add-ons unload when Firefox closes. There is **no build step** and Node is not
required.

## Cross-browser

- `manifest.json` = **Firefox, MV2** (vector map works; CSP allows MapLibre's
  `blob:` worker).
- `manifest.chrome.json` = **Chrome/Edge/Brave, MV3**. To load in Chrome, copy it
  over `manifest.json`. Chrome MV3's CSP won't allow `worker-src blob:`, so
  MapLibre's worker is blocked → the **5 s timeout in `map.js` falls back to the
  raster basemap** on Chrome. Everything else is identical (`content.js` already
  uses `browser`/`chrome` detection). Keep the two manifests in sync on changes.
