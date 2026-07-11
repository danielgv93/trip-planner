// Single source of truth for shared, mutable app state.
//
// ES module bindings can't be reassigned from an importing module, so the
// mutable state lives as PROPERTIES of one exported object. Every module reads
// and writes `store.X`; because they all share the same object reference, the
// mutations are visible everywhere — the live-binding equivalent of the old
// module-level globals, but with an explicit home.

import {
    sample,
    DEFAULT_CATEGORIES,
    DEFAULT_TITLE,
    UNCATEGORIZED,
} from "./constants.js";

const saved = JSON.parse(
    localStorage.getItem("trip-planner") ||
        localStorage.getItem("japan-planner") ||
        "null",
);

export const store = {
    tripTitle:
        typeof saved?.tripTitle === "string" ? saved.tripTitle : DEFAULT_TITLE,
    state: Array.isArray(saved)
        ? saved
        : saved?.days || structuredClone(sample),
    backlog: Array.isArray(saved?.backlog) ? saved.backlog : [],
    tags: Array.isArray(saved?.tags)
        ? saved.tags
        : ["comida", "templo", "reserva", "compras"],
    categories: Array.isArray(saved?.categories)
        ? saved.categories
        : structuredClone(DEFAULT_CATEGORIES),
    // Routing preference persisted with the trip. Legacy/array saves lack it,
    // so fall back to "driving".
    routeProfile: ["walking", "driving", "cycling"].includes(
        saved?.routeProfile,
    )
        ? saved.routeProfile
        : "driving",
    previewMode: false,
    // Held from a picked Nominatim suggestion until the place form is submitted.
    selectedLocation: null,
    // id of the selected day, or the literal "backlog".
    active: undefined,
};
store.active = store.state[0]?.id;

export function save() {
    localStorage.setItem(
        "trip-planner",
        JSON.stringify({
            version: 8,
            tripTitle: store.tripTitle,
            days: store.state,
            backlog: store.backlog,
            tags: store.tags,
            categories: store.categories,
            routeProfile: store.routeProfile,
        }),
    );
}

export function dayBy(id) {
    return store.state.find((d) => d.id === id);
}

export function categoryMeta(category) {
    return store.categories.find((c) => c.id === category) || UNCATEGORIZED;
}

// A category acts as a "nexo" (joins its stop to the route line) by default.
// Only an explicit connects:false turns a stop into a standalone point: it keeps
// its numbered pin but the polyline skips it. undefined/missing (legacy plans)
// still connects.
export function categoryConnects(category) {
    return categoryMeta(category).connects !== false;
}
