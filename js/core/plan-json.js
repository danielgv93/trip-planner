// Browser adapter around the pure portable plan codec. File import/export and
// GitHub continue to use this module and therefore keep their existing API.

import { store } from "./store.js";
import { activeTripNotePage } from "./note-pages.js";
import {
    PLAN_VERSION,
    normalizePortableDay,
    normalizePortablePlan,
    normalizePortableSpot,
    parsePortablePlanJson,
    portablePlanFrom,
} from "./portable-plan.js";

export { PLAN_VERSION };
export const normalizeSpot = normalizePortableSpot;
export const normalizeDay = normalizePortableDay;

export function serializePlan({ exportedAt = true } = {}) {
    const plan = portablePlanFrom(store);
    if (exportedAt) plan.exportedAt = new Date().toISOString();
    return plan;
}

export function normalizePlan(value) {
    const plan = normalizePortablePlan(value, {
        defaultTitle: store.tripTitle,
        defaultTags: store.tags,
        defaultCategories: store.categories,
    });
    return {
        ...plan,
        activeTripNotePageId: activeTripNotePage(
            plan.tripNotePages,
            value?.activeTripNotePageId,
        ).id,
        backlogCollapsed: store.backlogCollapsed === true,
        routeTimeOverrides: {},
        routeTimeProfiles: {},
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

export { parsePortablePlanJson, portablePlanFrom };
