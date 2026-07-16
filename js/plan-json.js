// Canonical codec for the portable version-20 trip document. Local file import/
// export and GitHub transport all use the same field selection.

import { store, save, clearTagFilter } from "./store.js";
import { DEFAULT_CATEGORIES } from "./constants.js";
import { applyTitle, render } from "./render.js";
import { drawMap, syncRouteVisualizationControl } from "./map.js";
import { syncTripNotes } from "./notes.js";

export const PLAN_VERSION = 20;

export function serializePlan({ exportedAt = true } = {}) {
    const plan = {
        version: PLAN_VERSION,
        tripTitle: store.tripTitle,
        localCurrency: store.localCurrency,
        foreignCurrency: store.foreignCurrency,
        exchangeRate: store.exchangeRate,
        exchangeRateDate: store.exchangeRateDate,
        tripNotes: store.tripNotes,
        days: store.state,
        backlog: store.backlog,
        tags: store.tags,
        categories: store.categories,
        routeProfile: store.routeProfile,
        routeVisualization: store.routeVisualization,
        routeTimeOverrides: store.routeTimeOverrides,
    };
    if (exportedAt) plan.exportedAt = new Date().toISOString();
    return plan;
}

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeSpot(spot) {
    if (!isRecord(spot) || typeof spot.id !== "string" || typeof spot.name !== "string") {
        throw new Error("INVALID_PLAN");
    }
    const normalized = {
        ...spot,
        address: typeof spot.address === "string" ? spot.address : "",
        note: typeof spot.note === "string" ? spot.note : "",
        tags: Array.isArray(spot.tags)
            ? spot.tags.filter((tag) => typeof tag === "string")
            : [],
    };
    if (typeof spot.category !== "string") delete normalized.category;
    if (!Number.isFinite(spot.lat)) delete normalized.lat;
    if (!Number.isFinite(spot.lng)) delete normalized.lng;
    if (!Number.isFinite(spot.cost) || spot.cost < 0) delete normalized.cost;
    if (!Number.isInteger(spot.visitMinutes) || spot.visitMinutes <= 0)
        delete normalized.visitMinutes;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(spot.openingTime || "")) delete normalized.openingTime;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(spot.closingTime || "")) delete normalized.closingTime;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(spot.plannedStart || "")) delete normalized.plannedStart;
    if (typeof spot.visitedAt === "string" && Number.isFinite(Date.parse(spot.visitedAt))) {
        normalized.visitedAt = new Date(spot.visitedAt).toISOString();
    } else {
        delete normalized.visitedAt;
    }
    normalized.mapEnabled = spot.mapEnabled !== false;
    return normalized;
}

function normalizeDay(day) {
    if (!isRecord(day) || typeof day.id !== "string" || !Array.isArray(day.spots)) {
        throw new Error("INVALID_PLAN");
    }
    return {
        ...day,
        date: typeof day.date === "string" ? day.date : "",
        title: typeof day.title === "string" ? day.title : "",
        spots: day.spots.map(normalizeSpot),
    };
}

export function normalizePlan(value) {
    if (!isRecord(value) || !Array.isArray(value.days)) {
        throw new Error("INVALID_PLAN");
    }

    const days = value.days.map(normalizeDay);
    const backlog = Array.isArray(value.backlog)
        ? value.backlog.map(normalizeSpot)
        : [];
    const dayIds = days.map((day) => day.id);
    const spotIds = [
        ...days.flatMap((day) => day.spots.map((spot) => spot.id)),
        ...backlog.map((spot) => spot.id),
    ];
    if (new Set(dayIds).size !== dayIds.length || new Set(spotIds).size !== spotIds.length) {
        throw new Error("INVALID_PLAN");
    }
    const categories = Array.isArray(value.categories)
        ? value.categories.map((category) => {
            if (!isRecord(category) || typeof category.id !== "string" || typeof category.label !== "string") {
                throw new Error("INVALID_PLAN");
            }
            return {
                ...category,
                color: typeof category.color === "string" ? category.color : "#7d8589",
                connects: category.connects !== false,
            };
        })
        : structuredClone(store.categories || DEFAULT_CATEGORIES);

    const routeTimeOverrides = isRecord(value.routeTimeOverrides)
        ? Object.fromEntries(
              Object.entries(value.routeTimeOverrides).filter(
                  ([key, minutes]) =>
                      typeof key === "string" &&
                      Number.isInteger(minutes) &&
                      minutes > 0,
              ),
          )
        : {};

    return {
        version: PLAN_VERSION,
        tripTitle: typeof value.tripTitle === "string" ? value.tripTitle : store.tripTitle,
        localCurrency: typeof value.localCurrency === "string" ? value.localCurrency : "EUR",
        foreignCurrency: typeof value.foreignCurrency === "string" ? value.foreignCurrency : "JPY",
        exchangeRate: Number.isFinite(value.exchangeRate) && value.exchangeRate > 0
            ? value.exchangeRate
            : null,
        exchangeRateDate: typeof value.exchangeRateDate === "string" ? value.exchangeRateDate : "",
        tripNotes: typeof value.tripNotes === "string" ? value.tripNotes : "",
        days,
        backlog,
        backlogCollapsed: store.backlogCollapsed === true,
        tags: Array.isArray(value.tags)
            ? value.tags.filter((tag) => typeof tag === "string")
            : structuredClone(store.tags),
        categories,
        routeProfile: ["walking", "driving", "cycling"].includes(value.routeProfile)
            ? value.routeProfile
            : "driving",
        routeVisualization: ["straight", "streets"].includes(value.routeVisualization)
            ? value.routeVisualization
            : "straight",
        routeTimeOverrides,
    };
}

export function parsePlanJson(text) {
    let value;
    try {
        value = JSON.parse(text);
    } catch {
        throw new Error("INVALID_JSON");
    }
    return normalizePlan(value);
}

export function applyImportedPlan(plan) {
    const normalized = normalizePlan(plan);
    store.state = normalized.days;
    store.backlog = normalized.backlog;
    store.backlogCollapsed = normalized.backlogCollapsed;
    store.tags = normalized.tags;
    store.categories = normalized.categories;
    store.tripTitle = normalized.tripTitle;
    store.localCurrency = normalized.localCurrency;
    store.foreignCurrency = normalized.foreignCurrency;
    store.exchangeRate = normalized.exchangeRate;
    store.exchangeRateDate = normalized.exchangeRateDate;
    store.tripNotes = normalized.tripNotes;
    store.routeProfile = normalized.routeProfile;
    store.routeVisualization = normalized.routeVisualization;
    store.routeTimeOverrides = normalized.routeTimeOverrides;
    store.previewMode = false;
    store.selectedLocation = null;
    store.active = store.state[0]?.id || "backlog";
    clearTagFilter();

    document.body.classList.remove("preview-mode");
    const previewBtn = document.querySelector("#previewBtn");
    if (previewBtn) {
        previewBtn.textContent = "Vista completa";
        previewBtn.classList.remove("active");
        previewBtn.setAttribute("aria-pressed", "false");
    }
    const routeProfile = document.querySelector("#routeProfile");
    const routeVisualization = document.querySelector("#routeVisualization");
    const localCurrency = document.querySelector("#localCurrency");
    const foreignCurrency = document.querySelector("#foreignCurrency");
    if (routeProfile) routeProfile.value = store.routeProfile;
    if (routeVisualization) routeVisualization.value = store.routeVisualization;
    if (localCurrency) localCurrency.value = store.localCurrency;
    if (foreignCurrency) foreignCurrency.value = store.foreignCurrency;
    const currencyLabel = document.querySelector("#currencyConfigLabel");
    const exchangeRateValue = document.querySelector("#exchangeRateValue");
    const exchangeRateStatus = document.querySelector("#exchangeRateStatus");
    if (currencyLabel) currencyLabel.textContent = `${store.foreignCurrency} → ${store.localCurrency}`;
    if (exchangeRateValue) {
        exchangeRateValue.textContent = store.exchangeRate
            ? `1 ${store.foreignCurrency} = ${store.exchangeRate.toLocaleString("es-ES", { maximumFractionDigits: 6 })} ${store.localCurrency}`
            : "Conversión no disponible";
    }
    if (exchangeRateStatus) {
        exchangeRateStatus.textContent = store.exchangeRateDate
            ? `Último cambio: ${store.exchangeRateDate}`
            : "Conversión no disponible";
    }
    syncRouteVisualizationControl();
    applyTitle();
    syncTripNotes();
    save();
    render();
    drawMap();
}
