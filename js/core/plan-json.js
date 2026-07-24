// Canonical codec for the portable trip document. Local file import/
// export and GitHub transport all use the same field selection.

import { store } from "./store.js?v=25";
import { DEFAULT_CATEGORIES } from "./constants.js";
import { isTime } from "./time.js";
import {
    activeTripNotePage,
    normalizeTripNotePages,
} from "./note-pages.js";

export const PLAN_VERSION = 23;

export function serializePlan({ exportedAt = true } = {}) {
    const plan = {
        version: PLAN_VERSION,
        tripTitle: store.tripTitle,
        localCurrency: store.localCurrency,
        foreignCurrency: store.foreignCurrency,
        exchangeRate: store.exchangeRate,
        exchangeRateDate: store.exchangeRateDate,
        tripNotePages: store.tripNotePages,
        days: store.state,
        backlog: store.backlog,
        backlogGroups: store.backlogGroups,
        tags: store.tags,
        categories: store.categories,
        routeProfile: store.routeProfile,
        routeVisualization: store.routeVisualization,
        routeTimeOverrides: store.routeTimeOverrides,
        routeTimeProfiles: store.routeTimeProfiles,
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
    if (!isTime(spot.openingTime)) delete normalized.openingTime;
    if (!isTime(spot.closingTime)) delete normalized.closingTime;
    if (!isTime(spot.plannedStart)) delete normalized.plannedStart;
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
    const spots = day.spots.map(normalizeSpot);
    spots.forEach((spot) => delete spot.backlogGroupId);
    return {
        ...day,
        date: typeof day.date === "string" ? day.date : "",
        title: typeof day.title === "string" ? day.title : "",
        spots,
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
    const backlogGroups = Array.isArray(value.backlogGroups)
        ? value.backlogGroups.map((group) => {
              if (
                  !isRecord(group) ||
                  typeof group.id !== "string" ||
                  typeof group.title !== "string"
              )
                  throw new Error("INVALID_PLAN");
              return {
                  id: group.id,
                  title: group.title.trim() || "Grupo",
                  collapsed: group.collapsed === true,
              };
          })
        : [];
    const dayIds = days.map((day) => day.id);
    const spotIds = [
        ...days.flatMap((day) => day.spots.map((spot) => spot.id)),
        ...backlog.map((spot) => spot.id),
    ];
    const backlogGroupIds = backlogGroups.map((group) => group.id);
    if (
        new Set(dayIds).size !== dayIds.length ||
        new Set(spotIds).size !== spotIds.length ||
        new Set(backlogGroupIds).size !== backlogGroupIds.length
    ) {
        throw new Error("INVALID_PLAN");
    }
    const validBacklogGroups = new Set(backlogGroupIds);
    backlog.forEach((spot) => {
        if (!validBacklogGroups.has(spot.backlogGroupId))
            delete spot.backlogGroupId;
    });
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
    const routeTimeProfiles = isRecord(value.routeTimeProfiles)
        ? Object.fromEntries(
              Object.entries(value.routeTimeProfiles).filter(
                  ([key, profile]) =>
                      typeof key === "string" &&
                      ["walking", "driving"].includes(profile),
              ),
          )
        : {};
    const tripNotePages = normalizeTripNotePages(value.tripNotePages, {
        legacyNotes: typeof value.tripNotes === "string" ? value.tripNotes : "",
        strict: value.tripNotePages !== undefined,
    });
    const activeNotePage = activeTripNotePage(
        tripNotePages,
        value.activeTripNotePageId,
    );

    return {
        version: PLAN_VERSION,
        tripTitle: typeof value.tripTitle === "string" ? value.tripTitle : store.tripTitle,
        localCurrency: typeof value.localCurrency === "string" ? value.localCurrency : "EUR",
        foreignCurrency: typeof value.foreignCurrency === "string" ? value.foreignCurrency : "JPY",
        exchangeRate: Number.isFinite(value.exchangeRate) && value.exchangeRate > 0
            ? value.exchangeRate
            : null,
        exchangeRateDate: typeof value.exchangeRateDate === "string" ? value.exchangeRateDate : "",
        tripNotePages,
        activeTripNotePageId: activeNotePage.id,
        days,
        backlog,
        backlogGroups,
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
        routeTimeProfiles,
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
