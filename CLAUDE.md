# CLAUDE.md

This repository's canonical development instructions live in [`AGENTS.md`](./AGENTS.md). Read and follow that file before making changes.

The short version:

- Serve `index.html` over HTTP; native ES modules do not work through `file://`.
- Keep UI copy in Spanish and preserve the destructive `save(); render(); drawMap();` cycle.
- Keep shared mutable state in `js/core/store.js`.
- Put composition in `js/app/`, data/persistence in `js/core/`, neutral primitives in `js/shared/`, and product behavior in `js/features/<domain>/`.
- Use `styles/app.css` as the only stylesheet entry point and preserve its import order.
- Verify changes in a browser because the project has no automated test suite.
