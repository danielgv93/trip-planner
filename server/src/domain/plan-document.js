import { normalizePortablePlan, PLAN_VERSION } from "../../../js/core/portable-plan.js";
import { ApiError } from "../http/api-error.js";

function documentDepth(value, depth = 0) {
    if (depth > 40) return depth;
    if (!value || typeof value !== "object") return depth;
    return Math.max(depth, ...Object.values(value).map((child) => documentDepth(child, depth + 1)));
}

export function validatePlanDocument(value, config) {
    if (Buffer.byteLength(JSON.stringify(value)) > config.bodyLimitBytes) {
        throw new ApiError(413, "DOCUMENT_TOO_LARGE", "El viaje supera el tamaño permitido");
    }
    if (documentDepth(value) > 40) {
        throw new ApiError(400, "DOCUMENT_TOO_DEEP", "El viaje tiene demasiados niveles");
    }
    if (value?.version !== undefined && (!Number.isInteger(value.version) || value.version > PLAN_VERSION)) {
        throw new ApiError(400, "UNSUPPORTED_PLAN_VERSION", "Versión de viaje no compatible");
    }
    try {
        return normalizePortablePlan(value);
    } catch {
        throw new ApiError(400, "INVALID_PLAN", "El documento del viaje no es válido");
    }
}

export function summarizePlanRevision(previous, next) {
    const collectionChanges = (beforeItems, afterItems, comparable = (item) => item) => {
        const before = new Map(beforeItems.map((item, index) => [item.id, { item, index }]));
        const after = new Map(afterItems.map((item, index) => [item.id, { item, index }]));
        const added = [...after].filter(([id]) => !before.has(id)).length;
        const removed = [...before].filter(([id]) => !after.has(id)).length;
        const changed = [...after].filter(([id, entry]) => {
            const prior = before.get(id);
            return prior && (prior.index !== entry.index
                || JSON.stringify(comparable(prior.item)) !== JSON.stringify(comparable(entry.item)));
        }).length;
        return { added, removed, changed, total: added + removed + changed };
    };
    const previousDays = previous?.days || [];
    const nextDays = next.days || [];
    const flattenSpots = (plan) => [
        ...((plan?.backlog || []).map((spot, index) => ({ spot, container: "backlog", index }))),
        ...((plan?.days || []).flatMap((day) => (day.spots || []).map((spot, index) => ({ spot, container: day.id, index })))),
    ];
    const previousSpots = flattenSpots(previous);
    const nextSpots = flattenSpots(next);
    const previousSpotById = new Map(previousSpots.map((entry) => [entry.spot.id, entry]));
    const nextSpotById = new Map(nextSpots.map((entry) => [entry.spot.id, entry]));
    const previousDayById = new Map(previousDays.map((day, index) => [day.id, { day, index }]));
    const nextDayById = new Map(nextDays.map((day, index) => [day.id, { day, index }]));
    const dayCollection = collectionChanges(previousDays, nextDays, ({ spots: _spots, ...day }) => day);
    const spotCollection = collectionChanges(
        previousSpots.map((entry) => ({ ...entry.spot, _container: entry.container })),
        nextSpots.map((entry) => ({ ...entry.spot, _container: entry.container })),
    );
    const dayStructureChanged = JSON.stringify(previousDays.map((day) => day.id))
        !== JSON.stringify(nextDays.map((day) => day.id));
    const spotStructureChanged = JSON.stringify(previousSpots.map((entry) => [entry.spot.id, entry.container]))
        !== JSON.stringify(nextSpots.map((entry) => [entry.spot.id, entry.container]));
    const daysChanged = [...nextDayById].filter(([id, entry]) => {
        const before = previousDayById.get(id);
        if (!before) return false;
        const { spots: _beforeSpots, ...beforeDay } = before.day;
        const { spots: _nextSpots, ...nextDay } = entry.day;
        return before.index !== entry.index || JSON.stringify(beforeDay) !== JSON.stringify(nextDay);
    }).length;
    const spotsChanged = [...nextSpotById].filter(([id, entry]) => {
        const before = previousSpotById.get(id);
        return before && (before.container !== entry.container || before.index !== entry.index
            || JSON.stringify(before.spot) !== JSON.stringify(entry.spot));
    }).length;
    const backlogGroupsChanged = collectionChanges(previous?.backlogGroups || [], next.backlogGroups || []).total;
    const categoriesChanged = collectionChanges(previous?.categories || [], next.categories || []).total;
    const notePagesChanged = collectionChanges(previous?.tripNotePages || [], next.tripNotePages || []).total;
    const remindersChanged = collectionChanges(previous?.reminders || [], next.reminders || []).total;
    const previousTags = new Set(previous?.tags || []);
    const nextTags = new Set(next.tags || []);
    const tagsChanged = [...previousTags].filter((tag) => !nextTags.has(tag)).length
        + [...nextTags].filter((tag) => !previousTags.has(tag)).length;
    const previousLegs = previous?.travelLegs || {};
    const nextLegs = next.travelLegs || {};
    const travelLegsChanged = new Set([...Object.keys(previousLegs), ...Object.keys(nextLegs)]).size
        ? [...new Set([...Object.keys(previousLegs), ...Object.keys(nextLegs)])]
            .filter((key) => JSON.stringify(previousLegs[key]) !== JSON.stringify(nextLegs[key])).length
        : 0;
    const settingsChanged = [
        "localCurrency",
        "foreignCurrency",
        "exchangeRate",
        "exchangeRateDate",
        "routeProfile",
        "routeVisualization",
    ].filter((key) => JSON.stringify(previous?.[key]) !== JSON.stringify(next[key])).length;
    return {
        titleChanged: previous?.tripTitle !== next.tripTitle,
        daysDelta: nextDays.length - previousDays.length,
        spotsDelta: nextSpots.length - previousSpots.length,
        daysAdded: dayCollection.added,
        daysRemoved: dayCollection.removed,
        daysChanged,
        spotsAdded: spotCollection.added,
        spotsRemoved: spotCollection.removed,
        spotsChanged,
        backlogGroupsChanged,
        categoriesChanged,
        tagsChanged,
        notePagesChanged,
        remindersChanged,
        travelLegsChanged,
        settingsChanged,
        structureChanged: previous === null
            || previous === undefined
            || dayStructureChanged
            || spotStructureChanged
            || daysChanged > 0
            || spotsChanged > 0
            || nextDays.length !== previousDays.length
            || nextSpots.length !== previousSpots.length,
    };
}
