import { ApiError } from "../../http/api-error.js";
import { secret, SlidingWindowLimiter } from "../../security/session-security.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// `secret()` produces base64url, so the token alphabet is fixed and safe to
// validate before it ever reaches Postgres.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function assertTripId(tripId) {
    if (!UUID_PATTERN.test(String(tripId || ""))) {
        throw new ApiError(404, "TRIP_NOT_FOUND", "Viaje no encontrado");
    }
    return tripId;
}

export function createTripShareService({ database }) {
    // A share token carries 256 bits of entropy, so this limiter is only there
    // to keep an anonymous scan from turning into database load.
    const publicReadLimiter = new SlidingWindowLimiter({ limit: 120, windowMs: 60_000 });

    async function assertOwned(tripId, userId) {
        assertTripId(tripId);
        const result = await database.query(
            "SELECT id FROM trips WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL",
            [tripId, userId],
        );
        if (!result.rowCount) throw new ApiError(404, "TRIP_NOT_FOUND", "Viaje no encontrado");
    }

    async function readShare({ userId, tripId }) {
        await assertOwned(tripId, userId);
        const result = await database.query("SELECT token FROM trip_shares WHERE trip_id = $1", [tripId]);
        return { shared: result.rowCount > 0, token: result.rows[0]?.token || null };
    }

    // Publishing twice keeps the same link: rotating it silently would break
    // every copy the owner already sent.
    async function share({ userId, tripId }) {
        await assertOwned(tripId, userId);
        await database.query(
            "INSERT INTO trip_shares(trip_id, token) VALUES ($1, $2) ON CONFLICT (trip_id) DO NOTHING",
            [tripId, secret()],
        );
        const result = await database.query("SELECT token FROM trip_shares WHERE trip_id = $1", [tripId]);
        return { shared: true, token: result.rows[0].token };
    }

    // Going private destroys the token, so the old URL stops working for good.
    // Publishing again mints a new one.
    async function unshare({ userId, tripId }) {
        await assertOwned(tripId, userId);
        await database.query("DELETE FROM trip_shares WHERE trip_id = $1", [tripId]);
        return { shared: false, token: null };
    }

    async function readPublicTrip({ token, clientKey }) {
        if (!publicReadLimiter.take(String(clientKey || "anon"))) {
            throw new ApiError(429, "TOO_MANY_REQUESTS", "Demasiadas solicitudes. Inténtalo en un minuto.");
        }
        if (!TOKEN_PATTERN.test(String(token || ""))) {
            throw new ApiError(404, "SHARE_NOT_FOUND", "Este enlace ya no está disponible");
        }
        const result = await database.query(`SELECT t.title, t.document, t.updated_at
            FROM trip_shares s JOIN trips t ON t.id = s.trip_id
            WHERE s.token = $1 AND t.deleted_at IS NULL`, [token]);
        if (!result.rowCount) throw new ApiError(404, "SHARE_NOT_FOUND", "Este enlace ya no está disponible");
        // Deliberately no ids and no owner: an anonymous reader gets the plan
        // and nothing that identifies the account behind it.
        return {
            title: result.rows[0].title,
            document: result.rows[0].document,
            updatedAt: result.rows[0].updated_at,
        };
    }

    return { readPublicTrip, readShare, share, unshare };
}
