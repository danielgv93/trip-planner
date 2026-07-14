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
    localCurrency:
        typeof saved?.localCurrency === "string" ? saved.localCurrency : "EUR",
    foreignCurrency:
        typeof saved?.foreignCurrency === "string" ? saved.foreignCurrency : "JPY",
    exchangeRate:
        Number.isFinite(saved?.exchangeRate) && saved.exchangeRate > 0
            ? saved.exchangeRate
            : null,
    exchangeRateDate:
        typeof saved?.exchangeRateDate === "string" ? saved.exchangeRateDate : "",
    tripNotes: typeof saved?.tripNotes === "string" ? saved.tripNotes : "",
    state: Array.isArray(saved)
        ? saved
        : saved?.days || structuredClone(sample),
    backlog: Array.isArray(saved?.backlog) ? saved.backlog : [],
    backlogCollapsed: saved?.backlogCollapsed === true,
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
    routeVisualization: ["straight", "streets"].includes(
        saved?.routeVisualization,
    )
        ? saved.routeVisualization
        : "straight",
    previewMode: false,
    // Held from a picked Nominatim suggestion until the place form is submitted.
    selectedLocation: null,
    // id of the selected day, or the literal "backlog".
    active: undefined,
    // View-only tag filter (Set<string>). NOT persisted — never part of
    // save()/localStorage/export — resets to empty on every reload.
    activeTagFilter: new Set(),
    // Runtime-only GitHub integration state. The credential is deliberately
    // never copied here; github.js reads it from sessionStorage on demand.
    githubConnection: null,
    githubVerified: false,
    githubBusy: false,
    githubRemoteSnapshot: null,
};
store.active = store.state[0]?.id;

export function toggleTagFilter(tag) {
    if (store.activeTagFilter.has(tag)) store.activeTagFilter.delete(tag);
    else store.activeTagFilter.add(tag);
}

export function clearTagFilter() {
    store.activeTagFilter.clear();
}

// OR/union semantics: a spot is visible if it carries at least one of the
// active filter tags, or if no filter is active at all.
export function spotMatchesFilter(spot) {
    if (store.activeTagFilter.size === 0) return true;
    return (spot.tags || []).some((t) => store.activeTagFilter.has(t));
}

// Missing is enabled so legacy plans and newly-created stops work by default.
// `mapEnabled` is kept as the persisted field for backwards compatibility, but
// the switch now controls whether the stop participates in any trip summary or
// calculation (maps, routes, schedules, budgets and active-stop counts).
export function spotIsEnabled(spot) {
    return spot?.mapEnabled !== false;
}

export function save() {
    localStorage.setItem(
        "trip-planner",
        JSON.stringify({
            version: 18,
            tripTitle: store.tripTitle,
            localCurrency: store.localCurrency,
            foreignCurrency: store.foreignCurrency,
            exchangeRate: store.exchangeRate,
            exchangeRateDate: store.exchangeRateDate,
            tripNotes: store.tripNotes,
            days: store.state,
            backlog: store.backlog,
            backlogCollapsed: store.backlogCollapsed,
            tags: store.tags,
            categories: store.categories,
            routeProfile: store.routeProfile,
            routeVisualization: store.routeVisualization,
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
