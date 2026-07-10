# willkarte

A Firefox extension that shows **willhaben.at** real estate search results on an
interactive map. Every listing for your current filters appears as a price pill
at its location — hover one for a photo, details, and a link to the ad.

*willkarte = willhaben + Karte ("map").*

## Features

- **🗺 Karte button** on any willhaben real estate search opens a full-screen map.
- **Price pills** for each flat/house; **hover** to preview (photo, size, rooms,
  address, link).
- **Whole search on the map**, not just the first page — results are loaded in
  the background (up to 1000, to stay light).
- **Uncluttered at every zoom**: only a capped number of pills are shown, spaced
  out; denser areas are hinted with small dots (click one to zoom in).
- **Stacked listings**: flats at the exact same address share one pill with a
  `+N` badge; its popup has arrows to page through them.
- **Modern vector basemap** (OpenFreeMap), with a raster fallback.

## Install

### Firefox (recommended — full vector map)

Quick, for yourself / testers:

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** → select `manifest.json`
3. Open a willhaben real estate search and click the orange **🗺 Karte** button.

Temporary add-ons unload when Firefox closes. To install permanently or hand a
single file to friends, **sign it** (see *Sharing* below).

### Chrome / Edge / Brave (Manifest V3)

1. In this folder, replace `manifest.json` with `manifest.chrome.json`
   (i.e. copy `manifest.chrome.json` over `manifest.json`).
2. Go to `chrome://extensions`, turn on **Developer mode**, click
   **Load unpacked**, and select the folder.

> **Note:** Chrome's stricter extension rules block the vector map engine's web
> worker, so on Chrome-based browsers willkarte automatically falls back to a
> raster basemap. Everything else works the same; it just looks a little less
> crisp than on Firefox.

## Sharing with others

- **A few people:** send them the folder (a zip) and the load steps above.
- **Firefox, permanent/one-click:** sign it with Mozilla's
  [`web-ext`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)
  tool — `web-ext sign` (with a free addons.mozilla.org API key) produces a
  signed `.xpi` that installs permanently, without a public store listing.
- **Public listing:** publish on [addons.mozilla.org](https://addons.mozilla.org)
  (Firefox) and/or the [Chrome Web Store](https://chrome.google.com/webstore)
  (one-time $5 developer fee, review required).

`web-ext build` (run in this folder) zips everything into
`web-ext-artifacts/` ready to upload or share.

## Notes

- **Filters live on willhaben.** Set them there, then open the map. It loads the
  active search fresh **every time you open it**, so after changing filters just
  close and reopen the map — no page reload needed.
- **No servers, no API keys, no scraping.** It reads the listing data willhaben
  already embeds in the page and draws it on a map.

## How it works

willhaben server-renders its search results and embeds the full listing data
(price, address, GPS coordinates) as JSON in the page. willkarte reads that JSON —
paginating the current search URL to gather the whole result set — and plots it
with [Leaflet](https://leafletjs.com) + [MapLibre GL](https://maplibre.org) on an
[OpenFreeMap](https://openfreemap.org) basemap. The map runs in an
extension-owned iframe so it isn't blocked by willhaben's content-security policy.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Extension manifest (Firefox MV2) |
| `content.js` | Reads listings, injects the button + map overlay |
| `panel.css` | Styles for the button and overlay |
| `map.html` / `map.js` | The map (runs inside the iframe) |
| `vendor/` | Leaflet, MapLibre GL, leaflet-maplibre-gl (vendored) |
| `CLAUDE.md` | Architecture notes for contributors |

## Attribution

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors,
tiles by [OpenFreeMap](https://openfreemap.org). Listing data from willhaben.at.
