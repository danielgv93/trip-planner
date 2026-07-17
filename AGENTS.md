# AGENTS.md

This file provides guidance to Codex when working with code in this repository.

## What this is

A browser-based trip route planner. It uses vanilla JavaScript **ES modules**, with no framework, build step, package manager, or backend. Small pure-logic tests use the built-in Node.js test runner. UI copy is in **Spanish** (`lang="es"`). The app is split across `index.html` (markup shell and dialogs), `styles/` (CSS by layer and feature), and `js/` (ES modules, entry point `js/app/main.js`).

Plans are stored only in the browser and can be imported/exported as JSON. There is no account or server-side synchronization.

## Running and verification

Because the app uses ES modules (`<script type="module">`), it **must be served over HTTP**. Opening `index.html` through `file://` fails because browsers block module loading. From the repository root, run for example:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/`.

Run pure-logic tests with `node --test`. There is no lint or build command. Also verify changes by serving the app and exercising the affected flow in a browser. Check desktop and mobile behavior when changing responsive UI, sticky elements, dialogs, or drag-and-drop.

Runtime network dependencies:

- **Leaflet 1.9.4** and Google Fonts load from CDNs. Leaflet is exposed as the global `L` by a classic script loaded before `js/app/main.js`.
- Leaflet map tiles come from OpenStreetMap.
- Place geocoding uses Nominatim.
- Street routing uses the public `routing.openstreetmap.de` OSRM instances.
- Exchange rates use Frankfurter.
- Place thumbnails use the Spanish and English Wikipedia APIs.

Map tiles, search, street routes, exchange rates, and thumbnails therefore require network access. Straight-line routes and saved plan data still work without those APIs. Routing falls back to an approximate great-circle distance when OSRM is unavailable.

## Architecture

The ES modules under `js/` are wired by `js/app/main.js`. Importing the side-effect modules attaches event listeners; after the module graph is evaluated, `main.js` performs the initial `applyTitle(); render(); drawMap();` and refreshes the exchange rate.

The source tree follows four explicit boundaries:

- **`js/app/`** — composition and startup only. Feature modules never import from this layer.
- **`js/core/`** — shared state, constants, persistence, and portable plan normalization.
- **`js/shared/`** — small domain-neutral browser/UI primitives.
- **`js/features/<domain>/`** — product behavior grouped by owning capability. Cross-feature imports must be explicit; do not add new flat modules directly under `js/`.

There is an intentional circular import between `features/planner/render.js` and `features/planner/dialogs.js`. It is safe because their cross-module references run from handlers after module initialization, not during top-level evaluation.

Module map (paths are relative to `js/`):

- **`core/constants.js`** — sample itinerary and static design/default data.
- **`core/store.js`** — the single source of truth and local persistence.
- **`core/plan-json.js`** — portable plan normalization and serialization; it does not apply UI changes.
- **`core/time.js`** / **`core/geo.js`** — pure time and geographic calculations.
- **`shared/dom.js`** / **`shared/notify.js`** — stateless DOM helpers and reusable notifications.
- **`features/planner/`** — destructive itinerary rendering, dialogs, actions, plan-application workflow, drag/drop, and search.
- **`features/map/`** — Leaflet maps, basemaps, routes, and place images.
- **`features/finance/`** — budget and exchange-rate behavior.
- **`features/notes/`** — autosaved trip notes and Markdown preview.
- **`features/companion/`** — focused on-trip experience, pure navigation calculations, and timeline projection.
- **`features/github/`** — optional explicit GitHub JSON synchronization, with transport isolated in `github-api.js`.
- **`features/assistant/`** — multi-provider LLM chat with validated plan mutations isolated in `proposal.js`.
- **`features/workspace/`** — persisted desktop workspace resizing.
- **`app/main.js`** — imports side-effect modules, paints the initial UI/map, and starts background initialization.

CSS has a single entry point at `styles/app.css`. It imports global rules from `styles/foundation/`, feature-owned rules from `styles/features/`, and workspace/responsive rules from `styles/layout/`. Its explicit import order preserves the established cascade; update it deliberately when adding styles.

## State and persisted data

All shared mutable state lives as properties of the single exported `store` object in `js/core/store.js`. Do not introduce parallel global state. ES module consumers all mutate the same object reference.

Important `store` fields:

- Persisted: `tripTitle`, currencies/rate, `tripNotes`, `state` (the days array), `backlog`, `backlogCollapsed`, `tags`, `categories`, route settings/overrides, `basemap`, and `workspaceSplit`.
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
  visitMinutes?,// positive integer estimated duration
  openingTime?, // canonical 24-hour HH:MM
  closingTime?, // canonical 24-hour HH:MM
  plannedStart?,// canonical 24-hour HH:MM
  visitedAt?,   // ISO timestamp from companion mode
  mapEnabled?   // false disables the stop everywhere; missing means enabled
}

category = {
  id,
  label,
  color,
  connects? // only explicit false excludes the category from route polylines
}
```

`save()` writes `localStorage["trip-planner"]` with schema **version 23** (`STORAGE_VERSION` in `core/store.js`). Portable JSON uses its own independently versioned `PLAN_VERSION` in `core/plan-json.js`. Loading still accepts the legacy `japan-planner` key and old saves whose root is directly an array of days. If the persisted shape changes, bump the relevant version and preserve these read fallbacks/migrations.

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
