# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A collaborative trip route planner. Vanilla JS **ES modules**, no framework, no build step, no package manager, no tests. UI copy is in **Spanish** (`lang="es"`). Split across three concerns: `trip-planner.html` (markup shell), `styles/` (CSS split by UI responsibility), and `js/` (ES modules, entry point `js/main.js`).

## Running

Because it uses ES modules (`<script type="module">`), it **must be served over HTTP** — opening `trip-planner.html` via `file://` fails (the browser blocks module loading cross-origin). Run any static server from the repo root, e.g. `python3 -m http.server`, then open `http://localhost:8000/trip-planner.html`.

External dependencies load from CDNs at runtime: **Leaflet 1.9.4** (maps, exposed as the global `L` via a classic `<script>` before the module) and Google Fonts. Geocoding hits **Nominatim** and routing hits **OSRM** (both OpenStreetMap public APIs), so search and route distances require network access.

There is no lint/build/test command. Changes are verified by serving the app and exercising the flow in the browser.

## Architecture

The code is split into ES modules under `js/`, wired by `js/main.js`. Because there is no bundler, cross-module references only ever fire at runtime (inside handlers), never during module top-level evaluation — this is what makes the intentional circular import between `render.js` and `dialogs.js` safe.

Module map:

- **`constants.js`** — static seed data (`sample`, `DEFAULT_CATEGORIES`, `UNCATEGORIZED`, `DEFAULT_TITLE`, `DAY_COLORS`). Pure exports.
- **`store.js`** — the single source of truth. `save()`, `dayBy()`, `categoryMeta()`, `categoryConnects()`.
- **`dom.js`** — stateless helpers: `$`, `esc`, `slug`, `safeColor`, `fmt`, `id`, and the cached `daysEl`.
- **`notify.js`** — `toast()` and the styled `confirmAction()`.
- **`images.js`** — `fetchSpotImage()` (Wikipedia thumbnails, in-memory cached).
- **`map.js`** — both Leaflet instances, `drawMap()`, `drawGlobalMap()`, OSRM routing + cache, legend, and the dialog preview map (`setPreview`, `openPreview`).
- **`render.js`** — the destructive render cycle, day/spot operations (`moveSpot`, `duplicateDay`, `duplicateSpot`), and the delegated spot-action handler.
- **`dialogs.js`** — add/edit place dialog, Nominatim search, tag + category managers. `openDialog()`.
- **`dnd.js`** — custom pointer-events drag-and-drop (side-effect module).
- **`actions.js`** — top-bar actions (title, add day, preview, reset, import/export). Side-effect module.
- **`main.js`** — imports the side-effect modules and runs the initial `applyTitle(); render(); drawMap();`.

Key mental model:

- **State is a single shared mutable `store` object** exported from `js/store.js`, not scattered globals. ES module bindings can't be reassigned from an importing module, so all reassignable state lives as PROPERTIES of `store` (mutated as `store.state`, `store.active`, etc.) — every module shares the one object reference. Fields: `state` (array of days), `backlog` (unassigned spots), `tags` (string[]), `categories`, `active` (id of the selected day, or the literal `"backlog"`), `tripTitle`, `routeProfile`, `previewMode`, `selectedLocation`. Transient drag/dialog vars stay module-local where only one module uses them (`editing` in `dialogs.js`, all drag vars in `dnd.js`).
- **Data shapes**:
  - day = `{ id, date: "YYYY-MM-DD", title, spots: [] }`
  - spot = `{ id, name, address, note, tags: [], lat?, lng? }` — `lat`/`lng` are absent until a Nominatim suggestion is picked; an un-located spot renders in the list but not on the map.
- **The render cycle is the core convention**: almost every mutation ends with the trio `save(); render(); drawMap();`. `render()` is destructive — it wipes `#days` with `innerHTML = ""` and rebuilds every day/spot node from scratch, re-attaching event listeners each time. There is no diffing. Follow this pattern for any new mutation; do not try to surgically patch the DOM.
- **`save()`** (in `store.js`) writes the whole state to `localStorage` under key `trip-planner` as `{ version: 8, tripTitle, days, backlog, tags, categories, routeProfile }`. On load it reads `trip-planner`, falling back to the legacy `japan-planner` key. Bump the `version` and keep both read fallbacks if you change the persisted shape.
- **`esc()`** HTML-escapes every user string interpolated into the `innerHTML` templates. Any new template literal that includes user data MUST route it through `esc()`.

### Drag-and-drop (read this before touching it)

Spot reordering/moving is a **custom pointer-events implementation, deliberately NOT native HTML5 DnD**. Native DnD's OS drag image can't be styled, so instead the code floats a styled clone ("ghost") of the card under the cursor and animates the remaining cards with a FLIP technique (`captureRects()` → reorder DOM → `playFlip()`). Relevant pieces: `pointerdown` on `#days`, `onMove`/`onUp`/`onCancel`, and `moveSpot(spotId, toDay, at)` which is the single source of truth for relocating a spot between `backlog` and any day. `suppressClick` swallows the click that fires right after a drag so it isn't treated as a tap. Touch drags require grabbing the `.handle`; mouse drags work anywhere on the card.

### Maps

Two independent Leaflet instances: the main `#map` (draws the active day's route as a dashed polyline with numbered pins via `drawMap()`) and the small `#previewMap` inside the add/edit dialog (confirms a geocoded point before saving). `drawMap()` skips the polyline for the backlog. Place search (`searchPlaces`) is debounced 450ms and needs ≥3 characters; the chosen result is held in `selectedLocation` until the form is submitted.

### Special cases to keep in mind

- **Backlog is a pseudo-day** with the fixed id `"backlog"`. It renders as the first card, has no route line, and is a valid `active` target. Code that branches on the active/target day frequently special-cases the string `"backlog"`.
- Deleting a day moves its spots into the backlog (nothing is lost).
- Import/export is JSON matching the persisted shape (`days`, `backlog`, `tags`, `tripTitle`); import validates that `days` is an array.
