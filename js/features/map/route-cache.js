import { createRequestCache } from "../../shared/request-cache.js";

export const ROUTE_CACHE_STORAGE_KEY = "trip-planner-osrm-routes";
export const ROUTE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ROUTE_CACHE_MAX_ENTRIES = 75;
export const ROUTE_CACHE_MAX_BYTES = 2_000_000;

function validPoint(point) {
    return (
        Array.isArray(point) &&
        point.length === 2 &&
        Number.isFinite(point[0]) &&
        Number.isFinite(point[1])
    );
}

function persistableLeg(leg) {
    return (
        leg?.approx === false &&
        Number.isFinite(leg.km) &&
        leg.km >= 0 &&
        Number.isFinite(leg.min) &&
        leg.min >= 0 &&
        Array.isArray(leg.points) &&
        leg.points.length >= 2 &&
        leg.points.every(validPoint)
    );
}

// OSRM-specific policy over the shared request cache. Approximate fallbacks are
// useful for the current session but deliberately excluded from persistence.
export function createRouteCache({
    storage,
    now,
    ttlMs = ROUTE_CACHE_TTL_MS,
    maxEntries = ROUTE_CACHE_MAX_ENTRIES,
    maxBytes = ROUTE_CACHE_MAX_BYTES,
} = {}) {
    return createRequestCache({
        storageKey: ROUTE_CACHE_STORAGE_KEY,
        storage,
        now,
        ttlMs,
        maxEntries,
        maxBytes,
        shouldPersist: persistableLeg,
    });
}
