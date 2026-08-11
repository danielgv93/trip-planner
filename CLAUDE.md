# CLAUDE.md

This repository's canonical development instructions live in [`AGENTS.md`](./AGENTS.md). Read and follow that file before making changes.

## Project snapshot

Trip Planner is a browser-only, responsive itinerary planner built with vanilla
JavaScript ES modules. It has no framework, package manager, build step, or
project-owned backend. The interface is in Spanish. Plans persist in
`localStorage`, support JSON import/export, and can optionally be synchronized
explicitly with an existing GitHub JSON file. Notes are multi-page, and
portable plan data also includes backlog groups, directed travel legs, and
fixed or relative reminders.

## Development essentials

- Serve the repository over HTTP (for example, `python3 -m http.server 8000`);
  native ES modules do not work through `file://`.
- Run the pure-logic suite with `node --test`. There is no lint or build command.
- Also exercise affected UI flows in a browser. Check desktop and mobile when
  changing responsive layout, sticky UI, dialogs, timelines, or drag-and-drop.
- Keep user-facing copy in Spanish and escape user/imported values before
  interpolating them into HTML.
- Preserve the established state mutation cycle: `save(); render(); drawMap();`.
  `render()` destructively rebuilds the itinerary DOM. Capture `pushUndo()`
  first for user-initiated portable plan mutations covered by session history.
- Keep shared mutable state in the exported `store` object in
  `js/core/store.js`; do not introduce parallel global state.
- Put startup/composition in `js/app/`, portable data and domain logic in
  `js/core/`, neutral browser primitives in `js/shared/`, and product behavior
  in `js/features/<domain>/`.
- Current feature domains include planner, map, finance, notes, companion,
  health, reminders, GitHub synchronization, the LLM assistant, and workspace
  resizing.
- Use `styles/app.css` as the only stylesheet entry point and update its import
  order deliberately.
- Preserve legacy plan loading and keep local persistence and portable JSON
  normalization in sync whenever persisted plan fields change.
- Use the itinerary helpers for anchored stop positions and the planner move
  helpers for relocations across days and grouped backlog sections.

For data shapes, rendering rules, drag-and-drop invariants, routing behavior,
and persistence compatibility requirements, defer to [`AGENTS.md`](./AGENTS.md).
