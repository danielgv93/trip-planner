import { EventEmitter } from "node:events";

export const TRIP_EVENTS_CHANNEL = "trip_planner_events";
export const MAX_NOTIFY_BYTES = 7_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_TYPES = new Set([
    "revision", "operation", "members", "access-revoked", "trip-deleted",
    "presence-upsert", "presence-leave",
]);
const TARGET_KEY = /^[a-z-]+:[A-Za-z0-9._>-]{1,160}(?::[A-Za-z0-9._>-]{1,160})?$/;

function normalizedActor(actor) {
    return actor && UUID.test(String(actor.userId))
        ? { userId: String(actor.userId), displayName: String(actor.displayName || "").slice(0, 200) }
        : null;
}

export function normalizeTripEventPacket(tripId, event) {
    if (!UUID.test(String(tripId)) || !event || !EVENT_TYPES.has(event.type)) throw new Error("INVALID_TRIP_EVENT");
    let normalized;
    if (event.type === "revision") {
        const revision = Number(event.revision);
        if (!Number.isInteger(revision) || revision < 1 || typeof event.hash !== "string" || event.hash.length > 200) {
            throw new Error("INVALID_TRIP_EVENT");
        }
        const actor = normalizedActor(event.actor);
        normalized = { type: "revision", revision, hash: event.hash, ...(actor ? { actor } : {}) };
    } else if (event.type === "operation") {
        const revision = Number(event.revision);
        const targetKeys = Array.isArray(event.targetKeys)
            ? [...new Set(event.targetKeys)].filter((key) => typeof key === "string" && TARGET_KEY.test(key)).slice(0, 50)
            : [];
        if (
            !Number.isInteger(revision) || revision < 1 ||
            typeof event.hash !== "string" || event.hash.length > 200 ||
            !UUID.test(String(event.clientMutationId)) ||
            typeof event.deviceId !== "string" || event.deviceId.length < 1 || event.deviceId.length > 128 ||
            typeof event.kind !== "string" || event.kind.length < 1 || event.kind.length > 80 ||
            targetKeys.length !== event.targetKeys?.length
        ) throw new Error("INVALID_TRIP_EVENT");
        const actor = normalizedActor(event.actor);
        normalized = {
            type: "operation",
            revision,
            hash: event.hash,
            clientMutationId: String(event.clientMutationId),
            deviceId: event.deviceId,
            kind: event.kind,
            targetKeys,
            ...(actor ? { actor } : {}),
        };
    } else if (event.type === "presence-upsert") {
        const presence = event.presence;
        if (
            !presence || !UUID.test(String(presence.presenceSessionId)) ||
            !UUID.test(String(presence.userId)) ||
            !["owner", "editor", "viewer"].includes(presence.role) ||
            !["viewing", "editing"].includes(presence.state) ||
            !Number.isSafeInteger(Number(presence.sequence)) || Number(presence.sequence) < 0 ||
            !presence.target || !TARGET_KEY.test(`${presence.target.type}:${presence.target.id}${presence.target.field ? `:${presence.target.field}` : ""}`) ||
            !Number.isFinite(Date.parse(presence.expiresAt))
        ) throw new Error("INVALID_TRIP_EVENT");
        normalized = {
            type: event.type,
            presence: {
                presenceSessionId: String(presence.presenceSessionId),
                userId: String(presence.userId),
                displayName: String(presence.displayName || "Viajero").slice(0, 80),
                role: presence.role,
                state: presence.state,
                target: {
                    type: presence.target.type,
                    id: presence.target.id,
                    ...(presence.target.field ? { field: presence.target.field } : {}),
                },
                sequence: Number(presence.sequence),
                expiresAt: new Date(presence.expiresAt).toISOString(),
            },
        };
    } else if (event.type === "presence-leave") {
        if (
            !UUID.test(String(event.presenceSessionId)) || !UUID.test(String(event.userId)) ||
            !Number.isSafeInteger(Number(event.sequence)) || Number(event.sequence) < 0
        ) throw new Error("INVALID_TRIP_EVENT");
        normalized = {
            type: event.type,
            presenceSessionId: String(event.presenceSessionId),
            userId: String(event.userId),
            sequence: Number(event.sequence),
        };
    } else if (event.type === "access-revoked") {
        if (!UUID.test(String(event.userId))) throw new Error("INVALID_TRIP_EVENT");
        normalized = { type: event.type, userId: String(event.userId) };
    } else {
        normalized = { type: event.type };
    }
    const packet = { tripId: String(tripId), event: normalized };
    if (Buffer.byteLength(JSON.stringify(packet)) > MAX_NOTIFY_BYTES) throw new Error("TRIP_EVENT_TOO_LARGE");
    return packet;
}

function emitterBus() {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    return {
        emit: (tripId, event) => emitter.emit(String(tripId), event),
        subscribe(tripId, listener) {
            const channel = String(tripId);
            emitter.on(channel, listener);
            return () => emitter.off(channel, listener);
        },
        listenerCount: (tripId) => emitter.listenerCount(String(tripId)),
        close: async () => emitter.removeAllListeners(),
    };
}

export function createMemoryTripEventBus() {
    const local = emitterBus();
    return {
        publish(tripId, event) {
            local.emit(tripId, event);
            return true;
        },
        subscribe: local.subscribe,
        listenerCount: local.listenerCount,
        close: local.close,
    };
}

// Kept as the unit-test/default composition name for backwards compatibility.
export const createTripEventBus = createMemoryTripEventBus;

export function createPostgresTripEventBus({ database, logger = console, retryBaseMs = 500, retryMaxMs = 30_000 } = {}) {
    const local = emitterBus();
    let listener = null;
    let retryTimer = null;
    let attempts = 0;
    let closing = false;
    let starting = null;

    const log = (level, event, detail = {}) => logger[level]?.(JSON.stringify({ event, ...detail }));

    function scheduleReconnect(reason) {
        if (closing || retryTimer) return;
        const delayMs = Math.min(retryMaxMs, retryBaseMs * (2 ** Math.min(attempts, 8)));
        attempts += 1;
        log("warn", "trip_event_listener_reconnecting", { reason, delayMs, attempt: attempts });
        retryTimer = setTimeout(() => {
            retryTimer = null;
            void start().catch(() => {});
        }, delayMs);
        retryTimer.unref?.();
    }

    function acceptNotification(message) {
        if (message.channel !== TRIP_EVENTS_CHANNEL || typeof message.payload !== "string") return;
        try {
            const raw = JSON.parse(message.payload);
            const packet = normalizeTripEventPacket(raw.tripId, raw.event);
            local.emit(packet.tripId, packet.event);
        } catch (error) {
            log("warn", "trip_event_payload_rejected", { reason: error.message, bytes: Buffer.byteLength(message.payload) });
        }
    }

    function lost(reason) {
        if (!listener) return;
        const stale = listener;
        listener = null;
        stale.removeListener?.("notification", acceptNotification);
        try { stale.release?.(true); } catch (error) {
            log("warn", "trip_event_listener_release_failed", { reason: error.code || error.name || "ERROR" });
        }
        scheduleReconnect(reason);
    }

    async function start() {
        if (closing || listener) return;
        if (starting) return starting;
        starting = (async () => {
            try {
                const connected = await database.connect();
                if (closing) {
                    connected.release?.();
                    return;
                }
                listener = connected;
                listener.on?.("notification", acceptNotification);
                listener.once?.("error", () => lost("error"));
                listener.once?.("end", () => lost("end"));
                await listener.query(`LISTEN ${TRIP_EVENTS_CHANNEL}`);
                attempts = 0;
                log("info", "trip_event_listener_open");
            } catch (error) {
                const failed = listener;
                listener = null;
                failed?.removeListener?.("notification", acceptNotification);
                try { failed?.release?.(true); } catch (releaseError) {
                    log("warn", "trip_event_listener_release_failed", { reason: releaseError.code || releaseError.name || "ERROR" });
                }
                log("error", "trip_event_listener_failed", { reason: error.code || error.name || "ERROR" });
                scheduleReconnect(error.code || "connect");
                throw error;
            } finally {
                starting = null;
            }
        })();
        return starting;
    }

    return {
        start,
        async publish(tripId, event) {
            let packet;
            try {
                packet = normalizeTripEventPacket(tripId, event);
                await database.query("SELECT pg_notify($1, $2)", [TRIP_EVENTS_CHANNEL, JSON.stringify(packet)]);
                return true;
            } catch (error) {
                // A revision is already committed at this point. Notification
                // failure is observable but never changes the HTTP result.
                log("error", "trip_event_publish_failed", {
                    tripId: UUID.test(String(tripId)) ? String(tripId) : null,
                    type: event?.type || null,
                    revision: Number(event?.revision) || null,
                    reason: error.code || error.message,
                });
                return false;
            }
        },
        subscribe: local.subscribe,
        listenerCount: local.listenerCount,
        async close() {
            closing = true;
            clearTimeout(retryTimer);
            retryTimer = null;
            const active = listener;
            listener = null;
            if (active) {
                active.removeListener?.("notification", acceptNotification);
                try { await active.query(`UNLISTEN ${TRIP_EVENTS_CHANNEL}`); } catch (error) {
                    log("warn", "trip_event_unlisten_failed", { reason: error.code || error.name || "ERROR" });
                }
                active.release?.();
            }
            await local.close();
            log("info", "trip_event_listener_closed");
        },
    };
}
