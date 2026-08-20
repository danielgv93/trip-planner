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
import { normalizeHealthDay, normalizeHealthSpot } from "./plan-metadata.js";
import {
    categoryDefaultSpotKind,
    normalizeSpotKind,
} from "./itinerary.js";
import { migrateLegacyTravelLegs, travelLegKey } from "./travel-legs.js";
import {
    activeTripNotePage,
    normalizeTripNotePages,
} from "./note-pages.js";
import { normalizeReminders } from "./reminders.js";

export const STORAGE_VERSION = 31;

let tripCommitter = null;

function emitSaveState() {
    if (globalThis.document && typeof globalThis.CustomEvent === "function") {
        document.dispatchEvent(new CustomEvent("trip-save-state"));
    }
}

function loadSavedState() {
    const raw =
        localStorage.getItem("trip-planner") ||
        localStorage.getItem("japan-planner");
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (error) {
        console.warn("No se pudo leer el plan guardado; se cargará el ejemplo.", error);
        return null;
    }
}

const saved = loadSavedState();
const savedTripNotePages = normalizeTripNotePages(saved?.tripNotePages, {
    legacyNotes: typeof saved?.tripNotes === "string" ? saved.tripNotes : "",
});
const savedActiveTripNotePage = activeTripNotePage(
    savedTripNotePages,
    saved?.activeTripNotePageId,
);

function normalizeSavedDay(day) {
    const normalized = normalizeHealthDay(day);
    normalized.spots = Array.isArray(day?.spots)
        ? day.spots.map((spot) => normalizeSpotKind(normalizeHealthSpot(spot)))
        : [];
    return normalized;
}

export const store = {
    // Library identity and projected metadata share the same state object as
    // the active plan. Durable repository/coordinator details remain owned by
    // their feature modules.
    activeTripId: localStorage.getItem("trip-planner-active-trip-id") || null,
    tripLibrary: [],
    saveStatus: "local",
    saveError: null,
    accountSession: null,
    cloudAvailability: "checking",
    cloudError: null,
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
    tripNotePages: savedTripNotePages,
    activeTripNotePageId: savedActiveTripNotePage.id,
    state: (Array.isArray(saved)
        ? saved
        : saved?.days || structuredClone(sample)).map(normalizeSavedDay),
    backlog: Array.isArray(saved?.backlog)
        ? saved.backlog.map((spot) => {
              const normalized = normalizeSpotKind(normalizeHealthSpot(spot));
              delete normalized.positionConstraint;
              return normalized;
          })
        : [],
    backlogCollapsed: saved?.backlogCollapsed === true,
    backlogGroups: Array.isArray(saved?.backlogGroups)
        ? saved.backlogGroups.filter(
              (group) =>
                  group &&
                  typeof group.id === "string" &&
                  typeof group.title === "string",
          )
        : [],
    tags: Array.isArray(saved?.tags)
        ? saved.tags
        : ["comida", "templo", "reserva", "compras"],
    categories: Array.isArray(saved?.categories)
        ? saved.categories.map((category) => ({
              ...category,
              defaultSpotKind: categoryDefaultSpotKind(category),
          }))
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
    // Local display preference. Liberty is the international-label default;
    // legacy basemap values migrate to it automatically.
    basemap: ["liberty", "osm"].includes(saved?.basemap)
        ? saved.basemap
        : "liberty",
    routeTimeOverrides:
        saved?.routeTimeOverrides &&
        typeof saved.routeTimeOverrides === "object" &&
        !Array.isArray(saved.routeTimeOverrides)
            ? Object.fromEntries(
                  Object.entries(saved.routeTimeOverrides).filter(
                      ([key, value]) =>
                          typeof key === "string" &&
                          Number.isInteger(value) &&
                          value > 0,
                  ),
              )
            : {},
    routeTimeProfiles:
        saved?.routeTimeProfiles &&
        typeof saved.routeTimeProfiles === "object" &&
        !Array.isArray(saved.routeTimeProfiles)
            ? Object.fromEntries(
                  Object.entries(saved.routeTimeProfiles).filter(
                      ([key, profile]) =>
                          typeof key === "string" &&
                          ["walking", "driving", "cycling"].includes(profile),
                  ),
              )
            : {},
    travelLegs: {},
    reminders: [],
    // Local presentation preference. It deliberately stays out of portable
    // plan exports: collaborators can choose their own column balance.
    workspaceSplit:
        Number.isFinite(saved?.workspaceSplit) &&
        saved.workspaceSplit > 0 &&
        saved.workspaceSplit < 1
            ? saved.workspaceSplit
            : null,
    // Device-local presentation preference. It is persisted with the browser
    // save, but deliberately excluded from portable plan JSON.
    itineraryDensity: saved?.itineraryDensity === "compact"
        ? "compact"
        : "comfortable",
    previewMode: false,
    // Anonymous public-link viewing. It is the single choke point that keeps a
    // shared trip from touching the visitor's own device storage: see save().
    readOnly: false,
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
    githubSyncState: "local",
};
store.travelLegs = migrateLegacyTravelLegs(
    saved?.travelLegs,
    store.routeTimeProfiles,
    store.routeTimeOverrides,
    { spotIds: new Set([...store.state.flatMap((day) => day.spots), ...store.backlog].map((spot) => spot.id)) },
);
store.reminders = normalizeReminders(saved?.reminders, {
    spotIds: new Set(
        [...store.state.flatMap((day) => day.spots), ...store.backlog]
            .map((spot) => spot.id),
    ),
});
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
    // A visitor reading somebody else's public link must never overwrite their
    // own workspace, so persistence stops here rather than in the UI layer.
    if (store.readOnly) return;
    try {
        localStorage.setItem(
            "trip-planner",
            JSON.stringify({
                version: STORAGE_VERSION,
                tripTitle: store.tripTitle,
                localCurrency: store.localCurrency,
                foreignCurrency: store.foreignCurrency,
                exchangeRate: store.exchangeRate,
                exchangeRateDate: store.exchangeRateDate,
                tripNotePages: store.tripNotePages,
                activeTripNotePageId: store.activeTripNotePageId,
                days: store.state,
                backlog: store.backlog,
                backlogCollapsed: store.backlogCollapsed,
                backlogGroups: store.backlogGroups,
                tags: store.tags,
                categories: store.categories,
                routeProfile: store.routeProfile,
                routeVisualization: store.routeVisualization,
                basemap: store.basemap,
                travelLegs: store.travelLegs,
                reminders: store.reminders,
                workspaceSplit: store.workspaceSplit,
                itineraryDensity: store.itineraryDensity,
            }),
        );
    } catch (error) {
        console.warn("No se pudo actualizar la copia localStorage de recuperación.", error);
        if (!tripCommitter) {
            store.saveStatus = "error";
            store.saveError = error;
            emitSaveState();
        }
    }
    if (tripCommitter) {
        store.saveStatus = "saving";
        store.saveError = null;
        emitSaveState();
        Promise.resolve()
            .then(() => tripCommitter())
            .then(() => {
                if (store.saveStatus === "saving") store.saveStatus = "saved";
                emitSaveState();
            })
            .catch((error) => {
                store.saveStatus = "error";
                store.saveError = error;
                emitSaveState();
            });
    }
}

export function registerTripCommitter(callback) {
    tripCommitter = callback;
}

export function replacePlanState(plan) {
    store.state = plan.days;
    store.backlog = plan.backlog;
    store.backlogCollapsed = plan.backlogCollapsed;
    store.backlogGroups = plan.backlogGroups;
    store.tags = plan.tags;
    store.categories = plan.categories;
    store.tripTitle = plan.tripTitle;
    store.localCurrency = plan.localCurrency;
    store.foreignCurrency = plan.foreignCurrency;
    store.exchangeRate = plan.exchangeRate;
    store.exchangeRateDate = plan.exchangeRateDate;
    store.tripNotePages = plan.tripNotePages;
    store.activeTripNotePageId = plan.activeTripNotePageId;
    store.routeProfile = plan.routeProfile;
    store.routeVisualization = plan.routeVisualization;
    store.routeTimeOverrides = plan.routeTimeOverrides;
    store.routeTimeProfiles = plan.routeTimeProfiles;
    store.travelLegs = plan.travelLegs;
    store.reminders = plan.reminders;
    store.previewMode = false;
    store.selectedLocation = null;
    const keepsSelection =
        store.active === "backlog" ||
        store.state.some((day) => day.id === store.active);
    if (!keepsSelection) store.active = store.state[0]?.id || "backlog";
    clearTagFilter();
}

export function routeTimeOverrideKey(fromId, toId, profile = "walking") {
    return `${profile}:${String(fromId)}>${String(toId)}`;
}

export function routeTimeOverride(fromId, toId, profile = "walking") {
    const leg = store.travelLegs[travelLegKey(fromId, toId)];
    if (leg?.mode === profile && Number.isInteger(leg.durationMinutes))
        return leg.durationMinutes;
    const value =
        store.routeTimeOverrides[
            routeTimeOverrideKey(fromId, toId, profile)
        ];
    return Number.isInteger(value) && value > 0 ? value : null;
}

export function routeTimeProfileKey(fromId, toId) {
    return `${String(fromId)}>${String(toId)}`;
}

export function routeTimeProfile(fromId, toId) {
    const mode = store.travelLegs[travelLegKey(fromId, toId)]?.mode;
    if (["walking", "driving", "cycling"].includes(mode)) return mode;
    const profile = store.routeTimeProfiles[routeTimeProfileKey(fromId, toId)];
    return profile === "driving" ? "driving" : "walking";
}

export function travelLeg(fromId, toId) {
    return store.travelLegs[travelLegKey(fromId, toId)] || null;
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
