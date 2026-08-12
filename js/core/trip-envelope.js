import { normalizePortablePlan } from "./portable-plan.js";

export const LOCAL_TRIP_VERSION = 1;
export const TRIP_SYNC_STATES = new Set([
    "local", "saving", "saved", "synced", "pending", "offline",
    "auth-required", "error", "conflict", "pending-deletion",
]);

function optionalString(value) {
    return typeof value === "string" && value ? value : null;
}
export function createTripEnvelope({
    id,
    document,
    remoteId = null,
    baseRevision = null,
    remoteHash = null,
    syncState = remoteId ? "pending" : "local",
    archived = false,
    pendingDeletion = false,
    updatedAt = new Date().toISOString(),
    preferences = {},
} = {}) {
    if (typeof id !== "string" || !id) throw new Error("INVALID_TRIP_ENVELOPE");
    if (!TRIP_SYNC_STATES.has(syncState)) throw new Error("INVALID_TRIP_ENVELOPE");
    if (baseRevision !== null && (!Number.isInteger(baseRevision) || baseRevision < 0)) {
        throw new Error("INVALID_TRIP_ENVELOPE");
    }
    return {
        version: LOCAL_TRIP_VERSION,
        id,
        document: normalizePortablePlan(document),
        remote: {
            id: optionalString(remoteId),
            baseRevision,
            hash: optionalString(remoteHash),
        },
        syncState,
        archived: archived === true,
        pendingDeletion: pendingDeletion === true,
        updatedAt,
        preferences: preferences && typeof preferences === "object" && !Array.isArray(preferences)
            ? { ...preferences }
            : {},
    };
}

export function normalizeTripEnvelope(value) {
    if (!value || typeof value !== "object" || value.version !== LOCAL_TRIP_VERSION) {
        throw new Error("INVALID_TRIP_ENVELOPE");
    }
    return createTripEnvelope({
        id: value.id,
        document: value.document,
        remoteId: value.remote?.id,
        baseRevision: value.remote?.baseRevision,
        remoteHash: value.remote?.hash,
        syncState: value.syncState,
        archived: value.archived,
        pendingDeletion: value.pendingDeletion,
        updatedAt: value.updatedAt,
        preferences: value.preferences,
    });
}
