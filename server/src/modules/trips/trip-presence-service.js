import { ApiError } from "../../http/api-error.js";
import { SlidingWindowLimiter } from "../../security/session-security.js";
import { readTripAccess } from "./trip-access.js";
import {
    assertPresenceSessionId,
    normalizePresenceInput,
    publicPresence,
} from "./presence-contract.js";

export function createTripPresenceService({ database, events, config, logger = console, metrics = null }) {
    const limiter = new SlidingWindowLimiter({
        limit: config.presenceRateLimit,
        windowMs: config.presenceRateWindowMs,
    });

    async function cleanupExpired() {
        const result = await database.query(`DELETE FROM trip_presence
            WHERE ctid IN (
                SELECT ctid FROM trip_presence WHERE expires_at <= now()
                ORDER BY expires_at LIMIT $1
            )`, [config.presenceCleanupLimit]);
        return result.rowCount || 0;
    }

    async function snapshot({ userId, tripId }) {
        await readTripAccess(database, tripId, userId);
        await cleanupExpired();
        const result = await database.query(`SELECT p.presence_session_id, p.user_id, p.role,
                p.state, p.target_type, p.target_id, p.target_field, p.sequence,
                p.expires_at, u.display_name
            FROM trip_presence p JOIN users u ON u.id = p.user_id
            WHERE p.trip_id = $1 AND p.expires_at > now()
            ORDER BY p.updated_at, p.presence_session_id`, [tripId]);
        metrics?.setPresenceSessions(result.rows.length);
        return {
            presences: result.rows.map(publicPresence),
            serverTime: new Date().toISOString(),
            ttlMs: config.presenceTtlMs,
        };
    }

    async function upsert({ active, tripId, presenceSessionId, input }) {
        const startedAt = Date.now();
        const sessionId = assertPresenceSessionId(presenceSessionId);
        const access = await readTripAccess(database, tripId, active.user_id);
        const presence = normalizePresenceInput(input, { role: access.role });
        const rateKey = `${active.user_id}:${tripId}:${sessionId}`;
        if (!limiter.take(rateKey)) {
            throw new ApiError(429, "PRESENCE_RATE_LIMIT", "Demasiadas actualizaciones de presencia", {
                retryAfterMs: config.presenceRateWindowMs,
            });
        }
        await cleanupExpired();
        const result = await database.query(`INSERT INTO trip_presence(
                trip_id, presence_session_id, user_id, role, state, target_type,
                target_id, target_field, sequence, expires_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                now() + ($10 * interval '1 millisecond'), now())
            ON CONFLICT (trip_id, presence_session_id) DO UPDATE SET
                role = EXCLUDED.role,
                state = EXCLUDED.state,
                target_type = EXCLUDED.target_type,
                target_id = EXCLUDED.target_id,
                target_field = EXCLUDED.target_field,
                sequence = EXCLUDED.sequence,
                expires_at = EXCLUDED.expires_at,
                updated_at = now()
            WHERE trip_presence.user_id = EXCLUDED.user_id
              AND trip_presence.sequence < EXCLUDED.sequence
            RETURNING presence_session_id, user_id, role, state, target_type,
                target_id, target_field, sequence, expires_at`, [
            tripId, sessionId, active.user_id, access.role, presence.state,
            presence.target.type, presence.target.id, presence.target.field || null,
            presence.sequence, config.presenceTtlMs,
        ]);
        if (!result.rowCount) {
            const current = await database.query(`SELECT p.presence_session_id, p.user_id, p.role,
                    p.state, p.target_type, p.target_id, p.target_field, p.sequence,
                    p.expires_at, u.display_name
                FROM trip_presence p JOIN users u ON u.id = p.user_id
                WHERE p.trip_id = $1 AND p.presence_session_id = $2`, [tripId, sessionId]);
            if (!current.rowCount || String(current.rows[0].user_id) !== String(active.user_id)) {
                throw new ApiError(409, "PRESENCE_SESSION_IN_USE", "La sesión de presencia ya está en uso");
            }
            return { presence: publicPresence(current.rows[0]), accepted: false, ttlMs: config.presenceTtlMs };
        }
        const item = publicPresence({ ...result.rows[0], display_name: active.display_name });
        try {
            await events?.publish(tripId, { type: "presence-upsert", presence: item });
        } catch (error) {
            logger.warn?.(JSON.stringify({ event: "presence_notification_failed", tripId, reason: error.code || error.name }));
        }
        metrics?.observePresenceUpdate();
        logger.info?.(JSON.stringify({
            event: "trip_presence_upsert", tripId, presenceSessionId: sessionId,
            state: item.state, targetType: item.target.type, sequence: item.sequence,
            durationMs: Date.now() - startedAt,
        }));
        return { presence: item, accepted: true, ttlMs: config.presenceTtlMs };
    }

    async function leave({ active, tripId, presenceSessionId, input }) {
        const sessionId = assertPresenceSessionId(presenceSessionId);
        await readTripAccess(database, tripId, active.user_id);
        const sequence = Number(input?.sequence);
        if (!Number.isSafeInteger(sequence) || sequence < 0) {
            throw new ApiError(400, "INVALID_PRESENCE_SEQUENCE", "Secuencia de presencia no válida");
        }
        const result = await database.query(`DELETE FROM trip_presence
            WHERE trip_id = $1 AND presence_session_id = $2 AND user_id = $3
              AND sequence < $4
            RETURNING presence_session_id, user_id`, [tripId, sessionId, active.user_id, sequence]);
        if (result.rowCount) {
            try {
                await events?.publish(tripId, {
                    type: "presence-leave",
                    presenceSessionId: sessionId,
                    userId: String(active.user_id),
                    sequence,
                });
            } catch (error) {
                logger.warn?.(JSON.stringify({ event: "presence_notification_failed", tripId, reason: error.code || error.name }));
            }
        }
        return { ok: true, removed: Boolean(result.rowCount) };
    }

    return { snapshot, upsert, leave, cleanupExpired };
}
