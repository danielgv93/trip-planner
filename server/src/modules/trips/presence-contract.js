import { ApiError } from "../../http/api-error.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGET_ID = /^[A-Za-z0-9._>-]{1,160}$/;
const TARGET_TYPES = new Set([
    "plan", "day", "spot", "backlog", "backlog-group", "category",
    "note-page", "reminder", "travel-leg", "section",
]);
const TARGET_FIELDS = new Set([
    "tripTitle", "localCurrency", "foreignCurrency", "exchangeRate",
    "exchangeRateDate", "routeProfile", "routeVisualization", "date",
    "title", "startTime", "collapsed", "name", "address", "note",
    "tags", "category", "lat", "lng", "cost", "visitMinutes",
    "openingTime", "closingTime", "plannedStart", "optional", "fixedStart",
    "scheduleNotApplicable", "mapEnabled", "kind", "positionConstraint",
    "content", "timing", "mode", "durationMinutes", "departureTime",
    "line", "reminders", "notes", "budget", "map", "timeline",
]);

export const PRESENCE_STATES = Object.freeze(["viewing", "editing"]);
export const PRESENCE_ROLES = Object.freeze(["owner", "editor", "viewer"]);

export function assertPresenceSessionId(value) {
    if (!UUID.test(String(value || ""))) {
        throw new ApiError(400, "INVALID_PRESENCE_SESSION", "Sesión de presencia no válida");
    }
    return String(value);
}

export function normalizePresenceTarget(value) {
    if (!value || !TARGET_TYPES.has(value.type) || !TARGET_ID.test(String(value.id || ""))) {
        throw new ApiError(400, "INVALID_PRESENCE_TARGET", "Objetivo de presencia no válido");
    }
    if (value.field !== undefined && !TARGET_FIELDS.has(value.field)) {
        throw new ApiError(400, "INVALID_PRESENCE_TARGET", "Campo de presencia no permitido");
    }
    return {
        type: value.type,
        id: String(value.id),
        ...(value.field ? { field: value.field } : {}),
    };
}

export function normalizePresenceInput(input, { role }) {
    const sequence = Number(input?.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
        throw new ApiError(400, "INVALID_PRESENCE_SEQUENCE", "Secuencia de presencia no válida");
    }
    if (!PRESENCE_STATES.includes(input?.state)) {
        throw new ApiError(400, "INVALID_PRESENCE_STATE", "Estado de presencia no válido");
    }
    const target = normalizePresenceTarget(input.target);
    if (role === "viewer" && (
        input.state !== "viewing" || target.type !== "plan" || target.id !== "plan" || target.field
    )) {
        throw new ApiError(403, "PRESENCE_VIEWER_READ_ONLY", "Un lector solo puede anunciar que está viendo el viaje");
    }
    return { sequence, state: input.state, target };
}

export function publicPresence(row) {
    return {
        presenceSessionId: String(row.presence_session_id),
        userId: String(row.user_id),
        displayName: String(row.display_name || "Viajero").slice(0, 80),
        role: row.role,
        state: row.state,
        target: {
            type: row.target_type,
            id: row.target_id,
            ...(row.target_field ? { field: row.target_field } : {}),
        },
        sequence: Number(row.sequence),
        expiresAt: new Date(row.expires_at).toISOString(),
    };
}
