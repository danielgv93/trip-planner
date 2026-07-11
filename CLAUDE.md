# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A collaborative trip route planner. The **entire application is a single self-contained file**: `trip-planner.html` (~1870 lines). Vanilla JS, no framework, no build step, no package manager, no tests. UI copy is in **Spanish** (`lang="es"`).

## Running

Open `trip-planner.html` directly in a browser (`file://`) — no server needed. The only external dependencies are loaded from CDNs at runtime: **Leaflet 1.9.4** (maps) and Google Fonts. Geocoding hits the **Nominatim** (OpenStreetMap) public API, so the search-for-a-place feature requires network access.

There is no lint/build/test command. Changes are verified by opening the file and exercising the flow in the browser.

## Architecture

Everything lives inside the one `<script>` block at the bottom of the file. Key mental model:

- **State is module-level mutable globals**, not a store: `state` (array of days), `backlog` (unassigned spots), `tags` (string[]), `active` (id of the selected day, or the literal `"backlog"`), `tripTitle`, plus transient drag/dialog vars.
- **Data shapes**:
  - day = `{ id, date: "YYYY-MM-DD", title, spots: [] }`
  - spot = `{ id, name, address, note, tags: [], lat?, lng? }` — `lat`/`lng` are absent until a Nominatim suggestion is picked; an un-located spot renders in the list but not on the map.
- **The render cycle is the core convention**: almost every mutation ends with the trio `save(); render(); drawMap();`. `render()` is destructive — it wipes `#days` with `innerHTML = ""` and rebuilds every day/spot node from scratch, re-attaching event listeners each time. There is no diffing. Follow this pattern for any new mutation; do not try to surgically patch the DOM.
- **`save()`** writes the whole state to `localStorage` under key `trip-planner` as `{ version: 4, tripTitle, days, backlog, tags }`. On load it reads `trip-planner`, falling back to the legacy `japan-planner` key. Bump the `version` and keep both read fallbacks if you change the persisted shape.
- **`esc()`** HTML-escapes every user string interpolated into the `innerHTML` templates. Any new template literal that includes user data MUST route it through `esc()`.

### Drag-and-drop (read this before touching it)

Spot reordering/moving is a **custom pointer-events implementation, deliberately NOT native HTML5 DnD**. Native DnD's OS drag image can't be styled, so instead the code floats a styled clone ("ghost") of the card under the cursor and animates the remaining cards with a FLIP technique (`captureRects()` → reorder DOM → `playFlip()`). Relevant pieces: `pointerdown` on `#days`, `onMove`/`onUp`/`onCancel`, and `moveSpot(spotId, toDay, at)` which is the single source of truth for relocating a spot between `backlog` and any day. `suppressClick` swallows the click that fires right after a drag so it isn't treated as a tap. Touch drags require grabbing the `.handle`; mouse drags work anywhere on the card.

### Maps

Two independent Leaflet instances: the main `#map` (draws the active day's route as a dashed polyline with numbered pins via `drawMap()`) and the small `#previewMap` inside the add/edit dialog (confirms a geocoded point before saving). `drawMap()` skips the polyline for the backlog. Place search (`searchPlaces`) is debounced 450ms and needs ≥3 characters; the chosen result is held in `selectedLocation` until the form is submitted.

### Special cases to keep in mind

- **Backlog is a pseudo-day** with the fixed id `"backlog"`. It renders as the first card, has no route line, and is a valid `active` target. Code that branches on the active/target day frequently special-cases the string `"backlog"`.
- Deleting a day moves its spots into the backlog (nothing is lost).
- Import/export is JSON matching the persisted shape (`days`, `backlog`, `tags`, `tripTitle`); import validates that `days` is an array.
