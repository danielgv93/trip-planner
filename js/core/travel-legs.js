import { isTime } from "./time.js";

export const AUTOMATIC_TRAVEL_MODES = Object.freeze(["walking", "driving", "cycling"]);
export const MANUAL_TRAVEL_MODES = Object.freeze(["bus", "train", "metro", "ferry", "flight", "other"]);
export const TRAVEL_MODES = Object.freeze([...AUTOMATIC_TRAVEL_MODES, ...MANUAL_TRAVEL_MODES]);

export function travelLegKey(fromId, toId) {
    return `${String(fromId)}>${String(toId)}`;
}

export function parseTravelLegKey(key) {
    if (typeof key !== "string") return null;
    const separator = key.indexOf(">");
    if (separator <= 0 || separator === key.length - 1 || key.indexOf(">", separator + 1) !== -1)
        return null;
    return { fromId: key.slice(0, separator), toId: key.slice(separator + 1) };
}

function cleanText(value, max) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function normalizeTravelLeg(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const mode = TRAVEL_MODES.includes(value.mode) ? value.mode : "other";
    const leg = { mode };
    if (Number.isInteger(value.durationMinutes) && value.durationMinutes > 0)
        leg.durationMinutes = value.durationMinutes;
    if (isTime(value.departureTime)) leg.departureTime = value.departureTime;
    if (value.fixedDeparture === true && leg.departureTime) leg.fixedDeparture = true;
    const line = cleanText(value.line, 120);
    const note = cleanText(value.note, 1200);
    if (line) leg.line = line;
    if (note) leg.note = note;
    if (Number.isFinite(value.cost) && value.cost > 0) leg.cost = value.cost;
    if (Array.isArray(value.embeddedEndpoints)) {
        const endpoints = [...new Set(value.embeddedEndpoints.filter((item) => item === "from" || item === "to"))];
        if (endpoints.length) leg.embeddedEndpoints = endpoints;
    }
    return leg;
}

export function normalizeTravelLegs(value, { spotIds = null } = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([key, raw]) => {
        const pair = parseTravelLegKey(key);
        const leg = normalizeTravelLeg(raw);
        if (!pair || !leg || pair.fromId === pair.toId) return [];
        if (spotIds && (!spotIds.has(pair.fromId) || !spotIds.has(pair.toId))) return [];
        return [[travelLegKey(pair.fromId, pair.toId), leg]];
    }));
}

export function migrateLegacyTravelLegs(travelLegs, routeTimeProfiles, routeTimeOverrides, options = {}) {
    const migrated = normalizeTravelLegs(travelLegs, options);
    const profiles = routeTimeProfiles && typeof routeTimeProfiles === "object" && !Array.isArray(routeTimeProfiles)
        ? routeTimeProfiles : {};
    const overrides = routeTimeOverrides && typeof routeTimeOverrides === "object" && !Array.isArray(routeTimeOverrides)
        ? routeTimeOverrides : {};
    const keys = new Set([...Object.keys(profiles), ...Object.keys(overrides).map((key) => key.includes(":") ? key.slice(key.indexOf(":") + 1) : key)]);
    for (const key of keys) {
        const pair = parseTravelLegKey(key);
        if (!pair || pair.fromId === pair.toId) continue;
        if (options.spotIds && (!options.spotIds.has(pair.fromId) || !options.spotIds.has(pair.toId))) continue;
        const canonical = travelLegKey(pair.fromId, pair.toId);
        const existing = migrated[canonical] || {};
        const legacyMode = TRAVEL_MODES.includes(profiles[canonical]) ? profiles[canonical] : undefined;
        const candidates = Object.entries(overrides).filter(([overrideKey]) => {
            const route = overrideKey.includes(":") ? overrideKey.slice(overrideKey.indexOf(":") + 1) : overrideKey;
            return route === canonical;
        });
        const preferred = candidates.find(([overrideKey]) => overrideKey.startsWith(`${legacyMode || "walking"}:`)) || candidates[0];
        const duration = preferred?.[1];
        migrated[canonical] = normalizeTravelLeg({
            mode: existing.mode || legacyMode || (preferred?.[0].split(":")[0]) || "walking",
            ...(Number.isInteger(duration) && duration > 0 ? { durationMinutes: duration } : {}),
            ...existing,
        });
    }
    return migrated;
}

export function applicableTravelLeg(travelLegs, day, from, to, enabled = (spot) => spot?.mapEnabled !== false) {
    if (!from || !to || !Array.isArray(day?.spots)) return null;
    const sequence = day.spots.filter(enabled);
    const index = sequence.findIndex((spot) => String(spot.id) === String(from.id));
    if (index < 0 || sequence[index + 1]?.id !== to.id) return null;
    return travelLegs?.[travelLegKey(from.id, to.id)] || null;
}

export function disconnectedTravelLegs(travelLegs, days, enabled = (spot) => spot?.mapEnabled !== false) {
    const applicable = new Set();
    for (const day of days || []) {
        const sequence = (day.spots || []).filter(enabled);
        for (let index = 1; index < sequence.length; index += 1)
            applicable.add(travelLegKey(sequence[index - 1].id, sequence[index].id));
    }
    return Object.entries(travelLegs || {}).filter(([key]) => !applicable.has(key));
}

export function travelLegCost(leg) {
    return Number.isFinite(leg?.cost) && leg.cost > 0 ? leg.cost : 0;
}
