import { ApiError } from "../../http/api-error.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TRIP_ROLES = ["owner", "editor", "viewer"];
export const ASSIGNABLE_ROLES = ["editor", "viewer"];
export const WRITERS = ["owner", "editor"];
export const OWNER_ONLY = ["owner"];

export function assertTripId(tripId) {
    if (!UUID_PATTERN.test(String(tripId || ""))) {
        throw new ApiError(404, "TRIP_NOT_FOUND", "Viaje no encontrado");
    }
    return tripId;
}

export function assertUserId(userId) {
    if (!UUID_PATTERN.test(String(userId || ""))) {
        throw new ApiError(404, "MEMBER_NOT_FOUND", "Esta persona ya no colabora en el viaje");
    }
    return userId;
}

// The membership row IS the authorization. A trip the caller does not
// collaborate on must be indistinguishable from one that does not exist, so a
// missing row is a 404 and never a 403: otherwise the API would confirm that a
// given trip id belongs to somebody.
export async function readTripAccess(client, tripId, userId, { forUpdate = false } = {}) {
    assertTripId(tripId);
    const result = await client.query(`SELECT t.owner_id, m.role
        FROM trips t JOIN trip_members m ON m.trip_id = t.id AND m.user_id = $2
        WHERE t.id = $1 AND t.deleted_at IS NULL${forUpdate ? " FOR UPDATE OF t" : ""}`, [tripId, userId]);
    if (!result.rowCount) throw new ApiError(404, "TRIP_NOT_FOUND", "Viaje no encontrado");
    return { ownerId: result.rows[0].owner_id, role: result.rows[0].role };
}

// Being a member is public knowledge inside the trip, so refusing a role the
// caller does not hold is a 403: it leaks nothing they cannot already see.
export async function requireTripRole(client, tripId, userId, allowed) {
    const access = await readTripAccess(client, tripId, userId);
    if (!allowed.includes(access.role)) {
        throw new ApiError(403, "TRIP_FORBIDDEN", "No tienes permiso para hacer esto en este viaje");
    }
    return access;
}
