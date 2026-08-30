// Pure codec for portable trip documents. This module deliberately has no
// dependency on the active store or browser-only APIs so the API can reuse it.

import { DEFAULT_CATEGORIES, DEFAULT_TITLE } from "./constants.js";
import { isTime } from "./time.js";
import { normalizeHealthDay, normalizeHealthSpot } from "./plan-metadata.js";
import {
    categoryDefaultSpotKind,
    normalizeSpotKind,
} from "./itinerary.js";
import { migrateLegacyTravelLegs } from "./travel-legs.js";
import { normalizeTripNotePages } from "./note-pages.js";
import { normalizeReminders } from "./reminders.js";

export const PLAN_VERSION = 29;

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function normalizePortableSpot(spot) {
    if (!isRecord(spot) || typeof spot.id !== "string" || typeof spot.name !== "string") {
        throw new Error("INVALID_PLAN");
    }
    const normalized = normalizeSpotKind(normalizeHealthSpot({
        ...spot,
        address: typeof spot.address === "string" ? spot.address : "",
        note: typeof spot.note === "string" ? spot.note : "",
        tags: Array.isArray(spot.tags)
            ? spot.tags.filter((tag) => typeof tag === "string")
            : [],
    }));
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

export function normalizePortableDay(day) {
    if (!isRecord(day) || typeof day.id !== "string" || !Array.isArray(day.spots)) {
        throw new Error("INVALID_PLAN");
    }
    const spots = day.spots.map(normalizePortableSpot);
    spots.forEach((spot) => delete spot.backlogGroupId);
    const normalized = normalizeHealthDay({
        ...day,
        date: typeof day.date === "string" ? day.date : "",
        title: typeof day.title === "string" ? day.title : "",
        spots,
    });
    // Folding a day is device-local presentation state, not trip content.
    delete normalized.collapsed;
    return normalized;
}

export function normalizePortablePlan(value, {
    defaultTitle = DEFAULT_TITLE,
    defaultTags = [],
    defaultCategories = DEFAULT_CATEGORIES,
} = {}) {
    if (!isRecord(value) || !Array.isArray(value.days)) {
        throw new Error("INVALID_PLAN");
    }

    const days = value.days.map(normalizePortableDay);
    const backlog = Array.isArray(value.backlog)
        ? value.backlog.map((spot) => {
              const normalized = normalizePortableSpot(spot);
              delete normalized.positionConstraint;
              return normalized;
          })
        : [];
    const backlogGroups = Array.isArray(value.backlogGroups)
        ? value.backlogGroups.map((group) => {
              if (!isRecord(group) || typeof group.id !== "string" || typeof group.title !== "string") {
                  throw new Error("INVALID_PLAN");
              }
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
        if (!validBacklogGroups.has(spot.backlogGroupId)) delete spot.backlogGroupId;
    });

    const categorySource = Array.isArray(value.categories)
        ? value.categories
        : clone(defaultCategories);
    const categories = categorySource.map((category) => {
              if (!isRecord(category) || typeof category.id !== "string" || typeof category.label !== "string") {
                  throw new Error("INVALID_PLAN");
              }
              return {
                  ...category,
                  color: typeof category.color === "string" ? category.color : "#7d8589",
                  connects: category.connects !== false,
                  defaultSpotKind: categoryDefaultSpotKind(category),
              };
          });

    const routeTimeOverrides = isRecord(value.routeTimeOverrides)
        ? Object.fromEntries(Object.entries(value.routeTimeOverrides).filter(
              ([key, minutes]) => typeof key === "string" && Number.isInteger(minutes) && minutes > 0,
          ))
        : {};
    const routeTimeProfiles = isRecord(value.routeTimeProfiles)
        ? Object.fromEntries(Object.entries(value.routeTimeProfiles).filter(
              ([key, profile]) => typeof key === "string" && ["walking", "driving", "cycling"].includes(profile),
          ))
        : {};
    const travelLegs = migrateLegacyTravelLegs(
        value.travelLegs,
        routeTimeProfiles,
        routeTimeOverrides,
        { spotIds: new Set(spotIds) },
    );
    const reminders = value.reminders === undefined
        ? []
        : normalizeReminders(value.reminders, { strict: true, spotIds: new Set(spotIds) });
    const tripNotePages = normalizeTripNotePages(value.tripNotePages, {
        legacyNotes: typeof value.tripNotes === "string" ? value.tripNotes : "",
        strict: value.tripNotePages !== undefined,
    });

    return {
        version: PLAN_VERSION,
        tripTitle: typeof value.tripTitle === "string" ? value.tripTitle : defaultTitle,
        localCurrency: typeof value.localCurrency === "string" ? value.localCurrency : "EUR",
        foreignCurrency: typeof value.foreignCurrency === "string" ? value.foreignCurrency : "JPY",
        exchangeRate: Number.isFinite(value.exchangeRate) && value.exchangeRate > 0
            ? value.exchangeRate
            : null,
        exchangeRateDate: typeof value.exchangeRateDate === "string" ? value.exchangeRateDate : "",
        tripNotePages,
        days,
        backlog,
        backlogGroups,
        tags: Array.isArray(value.tags)
            ? value.tags.filter((tag) => typeof tag === "string")
            : clone(defaultTags),
        categories,
        routeProfile: ["walking", "driving", "cycling"].includes(value.routeProfile)
            ? value.routeProfile
            : "driving",
        routeVisualization: ["straight", "streets"].includes(value.routeVisualization)
            ? value.routeVisualization
            : "straight",
        travelLegs,
        reminders,
    };
}

export function parsePortablePlanJson(text, options) {
    let value;
    try {
        value = JSON.parse(text);
    } catch {
        throw new Error("INVALID_JSON");
    }
    return normalizePortablePlan(value, options);
}

export function portablePlanFrom(source) {
    const days = source.days ?? source.state;
    return {
        version: PLAN_VERSION,
        tripTitle: source.tripTitle,
        localCurrency: source.localCurrency,
        foreignCurrency: source.foreignCurrency,
        exchangeRate: source.exchangeRate,
        exchangeRateDate: source.exchangeRateDate,
        tripNotePages: source.tripNotePages,
        days: days.map(({ collapsed: _collapsed, ...day }) => day),
        backlog: source.backlog,
        backlogGroups: source.backlogGroups,
        tags: source.tags,
        categories: source.categories,
        routeProfile: source.routeProfile,
        routeVisualization: source.routeVisualization,
        travelLegs: source.travelLegs,
        reminders: source.reminders,
    };
}
