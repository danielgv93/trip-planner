# AGENTS.md

This file provides guidance to Codex when working with code in this repository.

## What this is

A browser-based trip route planner. It uses vanilla JavaScript **ES modules**, with no framework, build step, package manager, backend, or automated tests. UI copy is in **Spanish** (`lang="es"`). The app is split across `index.html` (markup shell and dialogs), `styles/` (CSS by UI responsibility), and `js/` (ES modules, entry point `js/main.js`).

Plans are stored only in the browser and can be imported/exported as JSON. There is no account or server-side synchronization.

## Running and verification

Because the app uses ES modules (`<script type="module">`), it **must be served over HTTP**. Opening `index.html` through `file://` fails because browsers block module loading. From the repository root, run for example:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/`.

There is no lint, build, or test command. Verify changes by serving the app and exercising the affected flow in a browser. Check desktop and mobile behavior when changing responsive UI, sticky elements, dialogs, or drag-and-drop.

Runtime network dependencies:

- **Leaflet 1.9.4** and Google Fonts load from CDNs. Leaflet is exposed as the global `L` by a classic script loaded before `js/main.js`.
- Leaflet map tiles come from OpenStreetMap.
- Place geocoding uses Nominatim.
- Street routing uses the public `routing.openstreetmap.de` OSRM instances.
- Exchange rates use Frankfurter.
- Place thumbnails use the Spanish and English Wikipedia APIs.

Map tiles, search, street routes, exchange rates, and thumbnails therefore require network access. Straight-line routes and saved plan data still work without those APIs. Routing falls back to an approximate great-circle distance when OSRM is unavailable.

## Architecture

The ES modules under `js/` are wired by `js/main.js`. Importing the side-effect modules attaches event listeners; after the module graph is evaluated, `main.js` performs the initial `applyTitle(); render(); drawMap();` and refreshes the exchange rate.

There is an intentional circular import between `render.js` and `dialogs.js`. It is safe because their cross-module references run from handlers after module initialization, not during top-level evaluation.

Module map:

- **`constants.js`** — sample itinerary and static design/default data: `sample`, `DEFAULT_CATEGORIES`, `UNCATEGORIZED`, `DEFAULT_TITLE`, and `DAY_COLORS`.
- **`store.js`** — the single source of truth, persistence, tag filtering, enabled-stop semantics, day/category lookup, and category route-connectivity rules.
- **`dom.js`** — stateless helpers: `$`, `esc`, `slug`, `safeColor`, `fmt`, `id`, and cached `daysEl`.
- **`notify.js`** — toast notifications and the styled async `confirmAction()` dialog.
- **`images.js`** — Wikipedia thumbnail lookup with an in-memory cache. Images are preview-only and are not persisted on spots.
- **`currency.js`** — supported currencies, money formatting, conversion helpers, and Frankfurter exchange-rate refresh.
- **`map.js`** — main Leaflet map, dialog preview map, global preview, Google Maps links, straight/street route drawing, OSRM requests/cache, route controls, and legend.
- **`render.js`** — destructive itinerary rendering, tag filters, hours/schedule visualization, budget totals, day/spot operations, and delegated spot actions.
- **`dialogs.js`** — add/edit-place dialog, debounced Nominatim search, location preview, time normalization, and tag/category managers.
- **`dnd.js`** — custom pointer-based reordering for spots and real days, including ghost elements and FLIP animation.
- **`actions.js`** — trip title, currency dialog, add day, preview, reset, navigation, and JSON import/export.
- **`budget.js`** — read-only per-group and whole-trip budget dialog derived from shared state.
- **`notes.js`** — autosaved trip notes and a small, escaped Markdown preview implementation.
- **`spot-search.js`** — fuzzy in-plan stop search (`Ctrl/Cmd + K`) and navigation to the selected card.
- **`sticky-days.js`** — responsive sticky offsets and pinned-state classes for the tag bar/day headers.
- **`modal-scroll.js`** — prevents wheel gestures inside native dialogs from leaking to the page when no inner scroller can consume them.
- **`main.js`** — imports side-effect modules, paints the initial UI/map, and starts the exchange-rate refresh.

CSS is split by responsibility:

- `base.css` — tokens, global styles, and top navigation.
- `search.css` — quick-search overlay.
- `planner.css` — day/spot cards, schedules, and drag-and-drop.
- `map-notes.css` — map panel, Leaflet overrides, and trip notes.
- `dialog-finance.css` — shared dialog, currency, and budget styling.
- `dialogs.css` — forms, confirmations, and notifications.
- `taxonomy.css` — tag/category controls.
- `responsive.css` — preview mode and responsive overrides.

## State and persisted data

All shared mutable state lives as properties of the single exported `store` object in `js/store.js`. Do not introduce parallel global state. ES module consumers all mutate the same object reference.

Important `store` fields:

- Persisted: `tripTitle`, `localCurrency`, `foreignCurrency`, `exchangeRate`, `exchangeRateDate`, `tripNotes`, `state` (the days array), `backlog`, `backlogCollapsed`, `tags`, `categories`, `routeProfile`, and `routeVisualization`.
- Runtime-only: `active` (day id or `"backlog"`), `previewMode`, `selectedLocation`, and `activeTagFilter` (`Set<string>`).
- Module-local transient state stays in the module that owns it: e.g. `editing`/search debounce in `dialogs.js`, route/thumbnail caches, and drag variables in `dnd.js`.

Current data shapes:

```js
day = {
  id,
  date: "YYYY-MM-DD",
  title,
  spots: [],
  collapsed? // UI state, persisted as part of the day object
}

spot = {
  id,
  name,
  address,
  note,
  tags: [],
  category?,
  lat?,
  lng?,
  cost?,        // positive number in foreignCurrency
  openingTime?, // canonical 24-hour HH:MM
  closingTime?, // canonical 24-hour HH:MM
  mapEnabled?   // false disables the stop everywhere; missing means enabled
}

category = {
  id,
  label,
  color,
  connects? // only explicit false excludes the category from route polylines
}
```

`save()` writes `localStorage["trip-planner"]` with schema **version 16**. Loading still accepts the legacy `japan-planner` key and old saves whose root is directly an array of days. If the persisted shape changes, bump the version and preserve these read fallbacks/migrations.

JSON export includes the plan data needed for restoration (`days`, `backlog`, title, tags/categories, currencies/rate, notes, and route settings) plus `version` and `exportedAt`. Import requires `days` to be an array and supplies fallbacks for optional/older fields. Keep import and export in sync when adding a portable persisted field. Browser-only presentation state such as active filters is intentionally excluded.

## Core conventions

### Destructive render cycle

`render()` clears `#days` and rebuilds every day and spot node, then reattaches its listeners. There is no DOM diffing. Normal state mutations use:

```js
save();
render();
drawMap();
```

Some paths use `render({ persist: false })` when repainting derived UI without changing state. Do not surgically patch rendered day/spot DOM as a substitute for the established render cycle.

### Escaping and validation

Every user/imported string interpolated into an `innerHTML` template must pass through `esc()`. Imported colors used in HTML style attributes must pass through `safeColor()`. Prefer DOM properties such as `textContent` where practical. Times entering state should be normalized through `normalizeTime()` and kept in `HH:MM` form.

### Enabled stops

Use `spotIsEnabled(spot)` rather than checking `mapEnabled` ad hoc. A missing `mapEnabled` is enabled for legacy compatibility; only explicit `false` disables a stop. Disabled stops remain visible/editable in the itinerary but are excluded from maps, routes, schedules, budgets, and active-stop counts.

### Tag filters

`activeTagFilter` is view-only and not persisted or exported. Multiple active tags use OR/union semantics through `spotMatchesFilter()`. Dragging spots is blocked while a tag filter is active because filtered DOM indexes do not match the underlying arrays.

## Drag-and-drop

Drag-and-drop is a **custom pointer-events implementation, deliberately not native HTML5 DnD**. It floats a clone (`ghost`) under the pointer and animates remaining cards with FLIP (`captureRects()` → DOM reorder → `playFlip()`).

- `moveSpot(spotId, toDay, at)` is the single source of truth for moving/reordering a spot between backlog and days.
- `moveDay(dayId, at)` commits real-day reordering; the backlog remains fixed first.
- Mouse spot drags can start from most of the card; touch spot drags must start on `.handle`.
- Day drags always start on `.day-handle`.
- Interactive spot controls, schedule rails, and enable toggles do not start drags.
- `suppressClick` consumes the click emitted immediately after a drag.

Preserve the pointer-cancel cleanup, transition fallback timeouts, auto-scroll, ghost animation, and FLIP flow when changing this code.

## Maps and routing

There are two Leaflet instances:

- Main `#map`: active-day/backlog map or whole-trip map in preview mode.
- Lazy `#previewMap`: confirms a Nominatim result in the add/edit dialog.

`routeVisualization` chooses `"straight"` or `"streets"`. `routeProfile` (`walking`, `driving`, or `cycling`) affects street routes. OSRM legs are cached in memory by coordinates and profile, and stale async batches are discarded with a token guard. A category with `connects: false` keeps its numbered marker but is omitted from route lines and routing legs.

Backlog is a pseudo-day with the fixed id `"backlog"`. It can be active and accept/move spots, but it has no route polyline. Code that resolves an active or destination list must continue to special-case it.

Place search in `dialogs.js` is debounced by 450 ms and requires at least 3 characters. A chosen suggestion is stored temporarily in `store.selectedLocation` until form submission. A spot without finite `lat`/`lng` still renders in the itinerary but not on maps.

## Behavioral invariants

- Deleting a day moves all its spots to the backlog; it must not discard them.
- Deleting or renaming tags updates all spots that reference them and the active filter when relevant.
- Deleting a category leaves affected spots uncategorized.
- Cost/schedule/map totals must use only enabled stops.
- Preview mode is read-only and draws the complete trip map.
- User-facing copy remains in Spanish.
