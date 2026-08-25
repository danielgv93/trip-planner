# AGENTS.md

This file provides guidance to Codex when working with code in this repository.

## What this is

A browser-based trip route planner. It uses vanilla JavaScript **ES modules**, with no framework, build step, package manager, or backend. Small pure-logic tests use the built-in Node.js test runner. UI copy is in **Spanish** (`lang="es"`). The app is split across `index.html` (markup shell and dialogs), `styles/` (CSS by layer and feature), and `js/` (ES modules, entry point `js/app/main.js`).

Plans are stored in the browser and can be imported/exported as JSON. There is no account or project-owned backend. GitHub synchronization and LLM providers are optional, explicit browser-to-service integrations.

## Running and verification

Because the app uses ES modules (`<script type="module">`), it **must be served over HTTP**. Opening `index.html` through `file://` fails because browsers block module loading. From the repository root, run for example:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/`.

Run pure-logic tests with `node --test`. There is no lint or build command. Also verify changes by serving the app and exercising the affected flow in a browser. Check desktop and mobile behavior when changing responsive UI, sticky elements, dialogs, or drag-and-drop.

Runtime network dependencies:

- **Leaflet 1.9.4**, **MapLibre GL 5.24.0**, the Leaflet/MapLibre bridge, and Google Fonts load from CDNs. Leaflet and MapLibre are exposed as globals by classic scripts loaded before `js/app/main.js`.
- The default Liberty vector basemap comes from OpenFreeMap. OpenStreetMap is the selectable raster basemap, and CARTO Voyager is the fallback when the vector renderer is unavailable.
- Place geocoding uses Nominatim.
- Street routing uses the public `routing.openstreetmap.de` OSRM instances.
- Exchange rates use Frankfurter.
- Place thumbnails use the Spanish and English Wikipedia APIs.
- Optional GitHub synchronization uses the GitHub API. The assistant calls only the LM Studio, OpenAI-compatible, or Anthropic endpoint configured by the user.

Map tiles, search, street routes, exchange rates, thumbnails, GitHub synchronization, and cloud LLM providers therefore require network access. Straight-line routes and saved plan data still work without those APIs. Routing falls back to an approximate great-circle distance when OSRM is unavailable. Successful OSRM responses use a bounded 30-day device-local cache under `localStorage["trip-planner-osrm-routes"]`; approximate fallbacks remain memory-only.

## Architecture

The ES modules under `js/` are wired by `js/app/main.js`. Importing the side-effect modules attaches event listeners; after the module graph is evaluated, `main.js` performs the initial `applyTitle(); render(); drawMap();`, initializes companion mode, refreshes the exchange rate, and lazily imports the LLM assistant.

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
- **`core/itinerary.js`** / **`core/travel-legs.js`** / **`core/travel-leg-presentation.js`** — portable spot-role, position-constraint, and directed travel-leg contracts.
- **`core/plan-metadata.js`** / **`core/note-pages.js`** / **`core/reminders.js`** — normalized scheduling metadata, multi-page notes, and date/reminder rules.
- **`core/undo-stack.js`** — bounded domain-neutral undo/redo engine; the planner owns captured snapshot fields.
- **`core/plan-operation-commit.js`** — shared optimistic operation commit and persistence boundary used by every mutating feature.
- **`shared/dom.js`** / **`shared/modal.js`** / **`shared/notify.js`** — stateless DOM, modal, and notification helpers.
- **`shared/request-cache.js`** — reusable asynchronous in-memory/persistent request cache.
- **`features/planner/`** — destructive itinerary rendering, dialogs, actions, plan-application workflow, session history, drag/drop, sticky days, and search. `render.js` is the stable facade; timeline/travel editing lives in `timeline-editor.js` and duplicate/move commands in `commands.js`.
- **`features/timeline/`** — timeline projection and shared HTML view consumed by planner, companion, and health.
- **`features/map/`** — Leaflet maps, shared basemaps, persistent OSRM route cache, routes, and place images.
- **`features/finance/`** — budget and exchange-rate behavior.
- **`features/notes/`** — autosaved multi-page trip notes and Markdown preview.
- **`features/companion/`** — focused on-trip experience, pure navigation calculations, and timeline projection.
- **`features/health/`** — itinerary feasibility diagnostics, session-only results, and constraint-aware suggestions.
- **`features/reminders/`** — fixed and relative trip reminders, calendar/dashboard, and spot associations.
- **`features/github/`** — optional explicit GitHub JSON synchronization, with transport isolated in `github-api.js`.
- **`features/assistant/`** — multi-provider LLM chat with validated plan mutations isolated in `proposal.js`.
- **`features/library/`** — the trip workspace: the IndexedDB-backed library,
  the active-trip lifecycle, and the "Mis viajes" cards.
- **`features/cloud/`** — the account session, the outbox sync coordinator, the
  revision history, and trip collaboration (`collaborators.js`, `live-trip.js`,
  `member-avatar.js`).
- **`features/share/`** — public read-only share links: the owner's link dialog,
  the anonymous bootstrap, and the pure URL rules in `share-url.js`.
- **`features/workspace/`** — persisted desktop workspace resizing.
- **`app/main.js`** — imports side-effect modules, paints the initial UI/map, and starts background initialization.

CSS has a single entry point at `styles/app.css`. It imports global rules from `styles/foundation/`, feature-owned rules from `styles/features/`, and workspace/responsive rules from `styles/layout/`. Its explicit import order preserves the established cascade; update it deliberately when adding styles.

## State and persisted data

All shared mutable state lives as properties of the single exported `store` object in `js/core/store.js`. Do not introduce parallel global state. ES module consumers all mutate the same object reference.

Important `store` fields:

- Persisted locally: `tripTitle`, currencies/rate, `tripNotePages`, `activeTripNotePageId`, `state` (the days array), `backlog`, `backlogCollapsed`, `backlogGroups`, `tags`, `categories`, route settings, `basemap`, `travelLegs`, `reminders`, `workspaceSplit`, and `itineraryDensity`.
- Runtime-only: `active` (day id or `"backlog"`), `previewMode`, `selectedLocation`, and `activeTagFilter` (`Set<string>`).
- Module-local transient state stays in the module that owns it: e.g. `editing`/search debounce in `dialogs.js`, health results, undo/redo history, route/thumbnail memory caches, timeline viewport state, and drag variables in `dnd.js`.

Current data shapes:

```js
day = {
  id,
  date: "YYYY-MM-DD",
  title,
  spots: [],
  startTime?, // canonical 24-hour HH:MM used by itinerary health simulation
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
  optional?,    // true allows health suggestions to move it to the backlog
  fixedStart?,  // true makes plannedStart an immovable reservation
  scheduleNotApplicable?, // true declares that opening/closing hours do not apply
  visitedAt?,   // ISO timestamp from companion mode
  mapEnabled?,  // false disables the stop everywhere; missing means enabled
  kind,         // "activity" | "waypoint"; legacy/missing means activity
  positionConstraint?, // "first" | "last" | "locked"; day spots only
  backlogGroupId? // group membership; backlog spots only
}

category = {
  id,
  label,
  color,
  connects?, // only explicit false excludes the category from route polylines
  defaultSpotKind? // suggestion for new spots; never retroactive
}

travelLegs["fromId>toId"] = {
  mode, // walking, driving, cycling, bus, train, metro, ferry, flight or other
  durationMinutes?, departureTime?, fixedDeparture?, line?, note?, cost?,
  embeddedEndpoints? // ["from"], ["to"] or both for a single travel card
}

backlogGroup = { id, title, collapsed? }
notePage = { id, title, content }

reminder = {
  id,
  title,
  note?,
  spotId?,
  timing: { type: "fixed", date: "YYYY-MM-DD" }
       | { type: "offset", amount, unit: "days" | "weeks" | "months",
           anchor: { type: "date", date: "YYYY-MM-DD" } | { type: "spot" } },
  pendingSpotAnchor? // unresolved relative reminder after its spot disappears
}
```

`save()` writes `localStorage["trip-planner"]` with schema **version 31** (`STORAGE_VERSION` in `core/store.js`). Portable JSON uses its own independently versioned **version 28** (`PLAN_VERSION` in `core/plan-json.js`). Loading still accepts the legacy `japan-planner` key and old saves whose root is directly an array of days. If the persisted shape changes, bump the relevant version and preserve these read fallbacks/migrations.

JSON export includes the portable plan data needed for restoration (`days`, `backlog`, `backlogGroups`, title, tags/categories, currencies/rate, note pages, route settings, travel legs, and reminders) plus `version` and `exportedAt`. Import requires `days` to be an array and supplies fallbacks or migrations for optional/older fields, including legacy `tripNotes` and route-time overrides. Keep import and export in sync when adding a portable persisted field. Browser-only presentation state such as `backlogCollapsed`, the selected note page, basemap, workspace split, itinerary density, active filters, and undo history is intentionally excluded.

## Core conventions

### Destructive render cycle

`render()` clears `#days` and rebuilds every day and spot node, then reattaches its listeners. There is no DOM diffing. Normal persisted plan mutations use this established sequence, omitting repaint steps that the affected feature does not need:

```js
pushUndo(); // before a user-initiated portable plan mutation
save();
render();
drawMap();
```

Only include `pushUndo()` for flows that participate in session history; local presentation changes and note autosave do not create history snapshots. Some paths use `render({ persist: false })` when repainting derived UI without changing state. Do not surgically patch rendered day/spot DOM as a substitute for the established render cycle.

### Escaping and validation

Every user/imported string interpolated into an `innerHTML` template must pass through `esc()`. Imported colors used in HTML style attributes must pass through `safeColor()`. Prefer DOM properties such as `textContent` where practical. Times entering state should be normalized through `normalizeTime()` and kept in `HH:MM` form.

### Enabled stops

Use `spotIsEnabled(spot)` rather than checking `mapEnabled` ad hoc. A missing `mapEnabled` is enabled for legacy compatibility; only explicit `false` disables a stop. Disabled stops remain visible/editable in the itinerary but are excluded from maps, routes, schedules, budgets, and active-stop counts.

### Tag filters

`activeTagFilter` is view-only and not persisted or exported. Multiple active tags use OR/union semantics through `spotMatchesFilter()`. Dragging spots is blocked while a tag filter is active because filtered DOM indexes do not match the underlying arrays.

### Position constraints and backlog groups

Use the helpers in `core/itinerary.js` for `positionConstraint`; do not reorder or relocate anchored spots ad hoc. A day can have at most one `first` and one `last` stop, while `locked` keeps its exact index. Day deletion strips position constraints before moving its spots to the backlog. `relocateSpot()` clears `plannedStart` and `fixedStart` when its source and destination differ.

`backlogGroupId` is meaningful only for backlog spots and must refer to an existing `backlogGroups` entry. Day spots must not retain it. Use the planner relocation helpers so grouped insertion indexes and constraints remain consistent.

## Drag-and-drop

Drag-and-drop is a **custom pointer-events implementation, deliberately not native HTML5 DnD**. It floats a clone (`ghost`) under the pointer and animates remaining cards with FLIP (`captureRects()` → DOM reorder → `playFlip()`).

- `moveSpot(spotId, toDay, at, backlogGroupId)` is the single source of truth for moving/reordering a spot between backlog groups and days.
- `moveTravelCard(key, toDay, beforeSpotId)` atomically relocates travel cards with both embedded waypoint endpoints; those cards cannot move to the backlog or cross anchored stops.
- `moveDay(dayId, at)` commits real-day reordering; the backlog remains fixed first.
- Mouse spot drags can start from most of the card; touch spot drags must start on `.handle`.
- Day drags always start on `.day-handle`.
- Anchored spots cannot be dragged.
- Interactive spot controls, schedule rails, and enable toggles do not start drags.
- `suppressClick` consumes the click emitted immediately after a drag.

Preserve the pointer-cancel cleanup, transition fallback timeouts, auto-scroll, ghost animation, and FLIP flow when changing this code.

## Maps and routing

There are several Leaflet instances with different lifecycles:

- Main `#map`: active-day/backlog map or whole-trip map in preview mode.
- Lazy `#previewMap`: picks or confirms a location in the add/edit dialog.
- Lazy read-only place preview map in the place inspector.
- Lazy companion map for the focused on-trip experience.

The main, edit-preview, and companion maps share the selected basemap; the small read-only place preview intentionally uses OSM raster directly. `routeVisualization` chooses `"straight"` or `"streets"`. `routeProfile` (`walking`, `driving`, or `cycling`) affects street routes unless an explicit travel leg selects its own automatic mode. OSRM legs are cached by coordinates and profile, and stale async batches are discarded with a token guard. A category with `connects: false` keeps its numbered marker but is omitted from route lines and routing legs.

Backlog is a pseudo-day with the fixed id `"backlog"`. It can be active and accept/move spots, but it has no route polyline. Code that resolves an active or destination list must continue to special-case it.

Place search in `dialogs.js` is debounced by 450 ms and requires at least 3 characters. A chosen suggestion is stored temporarily in `store.selectedLocation` until form submission. A spot without finite `lat`/`lng` still renders in the itinerary but not on maps.

## Public share links

A cloud trip can be published as a read-only link. The owner opens **Compartir**
from the library card menu; the server mints a token in `trip_shares` and the app
builds `?viaje=<token>` against the current origin and path. Making the trip
private deletes the token, so the old URL stops working for good; publishing
again mints a different one. Publishing twice in a row is idempotent and keeps
the link the owner already sent.

- `GET /api/public/trips/:token` is the only trip route registered **before** the
  authentication middleware. It is read-only, takes no session, and returns the
  current revision plus the title and `updatedAt` — never ids or owner data.
- The token travels as a query parameter, not a path segment: `index.html` loads
  its modules through relative URLs, so a deeper path would break every asset.
- `js/app/main.js` branches on the token before anything else. The public
  bootstrap never opens the trip repository, never creates a starter trip, and
  never initializes the cloud session, companion mode, or the assistant.
- `store.readOnly` is the real boundary: `save()` returns immediately when it is
  set, so a visitor cannot overwrite their own device storage. The `public-view`
  body class only hides affordances; never rely on CSS alone for this.
- `replacePlanState()` resets `previewMode`, so the public bootstrap forces the
  full-trip view *after* calling it.

Preview mode alone is **not** enough to make the view read-only: it hides drag
handles and spot actions, but plenty of editors are still reachable. When adding
any new way to mutate the plan, close it at its own source rather than only
hiding a button. The guards that exist today:

- `setPlaceMode()` in `planner/dialogs.js` refuses any non-read mode, which
  covers the place inspector's footer button and its read-card shortcuts.
- `wireBacklogGroup()` in `planner/render.js` skips the rename/delete wiring,
  including the double click on the group title.
- The day timeline is built with `interactive: !store.readOnly`, so it renders
  plain blocks instead of the buttons that open the duration and travel dialogs.
- The reminder click delegate in `features/reminders/reminders.js` returns early.
- The OSRM route cache in `features/map/map.js` resolves its storage at call
  time, so a visitor gets the in-memory cache and writes nothing.

## Trip collaboration

A cloud trip has one **owner** and any number of **collaborators**, each holding
a role: `editor` (edits the plan exactly like the owner) or `viewer` (reads it,
including the history). Owner-only actions: deleting the trip, publishing a
public link, and managing the member list. A collaborator leaves instead of
deleting.

- `trips.owner_id` used to be both the owner AND the authorization predicate of
  every query. Since `008_trip_collaboration.sql`, `trip_members` is the access
  list and `owner_id` is only ownership, mirrored by exactly one `role = 'owner'`
  member row (a partial unique index enforces the "exactly one"). **Never
  authorize a trip route with `owner_id` again** — go through
  `readTripAccess` / `requireTripRole` in `trip-access.js`.
- A trip the caller does not collaborate on returns **404, never 403**: a 403
  would confirm that the id belongs to somebody. A role the caller lacks on a
  trip they *do* belong to returns 403, which leaks nothing new.
- Archiving lives on `trip_members.archived_at`, not on the trip: tidying your
  own library must not hide the trip from the rest of the group.
- Idempotency (`trip_mutations`) is keyed by trip + client mutation id only. It
  is deliberately not scoped to the actor: replaying a mutation must return its
  original result whoever asks.
- Invitations are by the email of an **existing** account. That inherently tells
  the owner whether an account exists, so `inviteMember` is rate-limited per
  account rather than pretending otherwise. Members per trip are capped at
  `TRIP_MEMBER_LIMIT`.
- Card payloads (`GET /api/trips`) carry `role`, `owner_id` and a `members`
  summary **without avatars**: a profile picture is up to 500 KB and the library
  holds hundreds of trips. Cards draw initials via `member-avatar.js`; only
  `GET /api/trips/:tripId/members` downloads real photos, and it returns emails
  only to the owner.

### Live updates

`GET /api/trips/:tripId/events` is a server-sent event stream authenticated by
the session cookie. It emits `revision`, `members`, `access-revoked` and
`trip-deleted`. `features/cloud/live-trip.js` keeps **one** stream, for the trip
currently open, and:

- ignores a `revision` whose actor is the current user — it is our own mutation
  echoing back;
- **skips the pull entirely when the local outbox still holds an edit for that
  trip.** Applying the remote document there would discard local work without a
  trace; the existing conflict path handles it on the next drain.

The event bus in `server/src/realtime/trip-events.js` is an in-process
`EventEmitter`, which is correct while the api runs as a single container. It is
the only seam that knows how fan-out happens: swap it for Postgres
`LISTEN`/`NOTIFY` before running more than one instance.

`nginx.conf` disables `proxy_buffering` for `/api/`, and the stream also sets
`x-accel-buffering: no`. Without either, events sit in the proxy buffer until
the stream closes.

### Read-only collaborators

A `viewer` gets `store.readOnly = true` (via `applyTripPermissions` in
`library/workspace.js`) plus the `read-only-plan` body class. `save()` returns
early while `readOnly` is set, so no edit reaches `localStorage`, IndexedDB or
the outbox — the CSS only hides affordances. `read-only-plan` carries the
editing lockdown shared with the anonymous visitor; `public-view` adds only what
is specific to having no account (no library, no assistant, no preview toggle).
Keep new editing affordances behind `read-only-plan`, not `public-view`.

### Known limitation

`trips.owner_id` cascades on account deletion, and there is no ownership
transfer: if the owner deletes their account, the trip disappears for every
collaborator. Local device copies survive as detached local-only trips.

## Behavioral invariants

- Deleting a day moves all its spots to the backlog; it must not discard them.
- Deleting or renaming tags updates all spots that reference them and the active filter when relevant.
- Deleting a category leaves affected spots uncategorized.
- Deleting a spot must unlink or resolve its associated reminders rather than leave a dangling spot id.
- Undo/redo history is session-only and bounded to 20 snapshots; flows integrated with it capture state immediately before mutation.
- Cost/schedule/map totals must use only enabled stops.
- Preview mode is read-only and draws the complete trip map.
- A public visitor writes nothing: no `localStorage`, no IndexedDB, no device id.
- Making a trip private must invalidate the previous link permanently.
- Only the owner deletes a trip or publishes it; a collaborator only leaves.
- A trip must never be authorized by `owner_id`; membership is the permission.
- Leaving or being removed revokes access and never erases past revisions: the
  history keeps attributing them to their author.
- A live remote revision must never overwrite a local edit still in the outbox.
- User-facing copy remains in Spanish.
