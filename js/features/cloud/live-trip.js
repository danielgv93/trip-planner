import { store } from "../../core/store.js";
import { toast } from "../../shared/notify.js";
import { getTripRepository, updateEnvelope } from "../library/workspace.js";
import { dropRevokedTrip, getCloudClient, getCurrentUserId, reconcileRemoteTrip, refreshRemoteTrips } from "./coordinator.js";
import { isVisuallyRemoteChange, remoteVisualEffects, streamEffectAllowed } from "./live-sync-contracts.js";
import { createIncrementalTripSync } from "./incremental-sync.js";

let source = null;
let streamedLocalId = null;
let streamedRemoteId = null;
let streamGeneration = 0;
let incremental = null;
let remoteNoticeTimer = null;
const remoteNoticeNames = new Set();
let remoteNoticeCount = 0;

function queueRemoteNotice(actor, count = 1) {
    remoteNoticeNames.add(actor?.displayName || "Otro colaborador");
    remoteNoticeCount += count;
    clearTimeout(remoteNoticeTimer);
    remoteNoticeTimer = setTimeout(() => {
        const who = [...remoteNoticeNames].join(", ");
        toast(`${who} aplicó ${remoteNoticeCount} cambio${remoteNoticeCount === 1 ? "" : "s"}.`, "info");
        remoteNoticeNames.clear();
        remoteNoticeCount = 0;
    }, 400);
}

function incrementalSync() {
    if (incremental) return incremental;
    const repository = getTripRepository();
    const client = getCloudClient();
    if (!repository || !client) return null;
    incremental = createIncrementalTripSync({
        repository,
        client,
        onEnvelope: async (envelope, detail) => {
            await updateEnvelope(envelope, { remoteTargetKeys: detail.targetKeys || [] });
            document.dispatchEvent(new CustomEvent("trip-remote-operations", {
                detail: { tripId: envelope.id, ...detail },
            }));
        },
    });
    return incremental;
}

export function catchUpLiveTripOperations(localId, targetRevision = 0) {
    return incrementalSync()?.sync(localId, targetRevision)
        || Promise.resolve({ status: "unavailable" });
}

function setConnectionState(state, detail = {}) {
    store.liveTripConnectionState = state;
    document.dispatchEvent(new CustomEvent("trip-live-state", { detail: { state, ...detail } }));
}

function currentStream(localId, remoteId, generation) {
    return localId === streamedLocalId && streamEffectAllowed({
        generation,
        currentGeneration: streamGeneration,
        localId,
        activeLocalId: store.activeTripId,
        remoteId,
        streamedRemoteId,
    });
}

function closeStream() {
    streamGeneration += 1;
    source?.close();
    source = null;
    streamedLocalId = null;
    streamedRemoteId = null;
    setConnectionState("closed");
}

function safePayload(event, type, localId) {
    try {
        const value = JSON.parse(event.data);
        return value && typeof value === "object" ? value : null;
    } catch (error) {
        console.warn("live_trip_event_invalid", { type, tripId: localId, code: error?.name || "PARSE_ERROR" });
        return null;
    }
}

async function refreshMembership(localId, remoteId, generation) {
    const repository = getTripRepository();
    const envelope = await repository?.getTrip(localId);
    if (!envelope?.remote.id || envelope.remote.id !== remoteId) return;
    const remote = (await refreshRemoteTrips().catch((error) => {
        console.warn("live_trip_members_failed", { tripId: localId, code: error?.code || null, status: error?.status || null });
        return [];
    })).find((trip) => trip.id === envelope.remote.id);
    if (!remote) return;
    envelope.remote.role = remote.role;
    envelope.remote.ownerId = remote.owner_id;
    envelope.remote.members = remote.members || [];
    if (currentStream(localId, remoteId, generation)) await updateEnvelope(envelope);
    else await repository.putTrip(envelope);
    document.dispatchEvent(new CustomEvent("trip-members-changed", { detail: { tripId: localId } }));
}

function attachHandlers(localId, remoteId, generation) {
    source.addEventListener("open", () => {
        if (!currentStream(localId, remoteId, generation)) return;
        setConnectionState("open", { tripId: localId });
        void getTripRepository()?.getTrip(localId).then((envelope) => {
            if (envelope?.remote.protocolVersion >= 1) return catchUpLiveTripOperations(localId);
            return reconcileRemoteTrip(localId, "sse-open", {
                isCurrent: () => currentStream(localId, remoteId, generation),
            });
        }).catch(() => {});
    });
    source.addEventListener("error", () => {
        if (!currentStream(localId, remoteId, generation)) return;
        const closed = source?.readyState === EventSource.CLOSED;
        setConnectionState(closed ? "error" : "reconnecting", { tripId: localId });
        console.warn("live_trip_stream_error", { tripId: localId, state: closed ? "error" : "reconnecting", generation });
    });
    source.addEventListener("revision", async (event) => {
        const payload = safePayload(event, "revision", localId);
        if (!payload || !Number.isInteger(Number(payload.revision))) return;
        try {
            // Revision comparison suppresses this device's echo while allowing
            // another device signed into the same account to converge.
            const result = await reconcileRemoteTrip(localId, "sse-revision", {
                targetRevision: Number(payload.revision),
                isCurrent: () => currentStream(localId, remoteId, generation),
            });
            if (result.status === "apply-remote"
                && currentStream(localId, remoteId, generation)
                && isVisuallyRemoteChange({ actor: payload.actor }, getCurrentUserId())) {
                queueRemoteNotice(payload.actor);
            }
        } catch {
            // The central reconciler already emits a bounded diagnostic and a
            // later open/focus/online trigger retries the pull.
        }
    });
    source.addEventListener("operation", async (event) => {
        const payload = safePayload(event, "operation", localId);
        if (!payload || !Number.isInteger(Number(payload.revision))) return;
        const startedAt = performance.now();
        try {
            const result = await catchUpLiveTripOperations(localId, Number(payload.revision));
            if (!currentStream(localId, remoteId, generation)) return;
            const remoteEffects = remoteVisualEffects({
                result,
                payload,
                currentUserId: getCurrentUserId(),
            });
            if (remoteEffects.length) {
                if (result.status !== "applied") {
                    document.dispatchEvent(new CustomEvent("trip-remote-operations", {
                        detail: {
                            tripId: localId,
                            mode: "event-attribution",
                            targetKeys: payload.targetKeys || [],
                            applied: remoteEffects,
                        },
                    }));
                }
                remoteEffects.forEach((entry) => queueRemoteNotice(entry.actor));
                console.info("live_operation_applied", {
                    tripId: localId,
                    revision: Number(payload.revision),
                    operationCount: remoteEffects.length,
                    targetKeyCount: result.targetKeys?.length || payload.targetKeys?.length || 0,
                    latencyMs: Math.round(performance.now() - startedAt),
                });
            }
        } catch (error) {
            console.warn("live_trip_operation_catchup_failed", {
                tripId: localId,
                revision: Number(payload.revision),
                code: error?.code || error?.name || "ERROR",
            });
        }
    });
    source.addEventListener("presence-snapshot", (event) => {
        const payload = safePayload(event, "presence-snapshot", localId);
        if (!payload || !currentStream(localId, remoteId, generation)) return;
        document.dispatchEvent(new CustomEvent("trip-presence-snapshot", {
            detail: { tripId: localId, presences: payload.presences || [], ttlMs: payload.ttlMs },
        }));
    });
    source.addEventListener("presence-upsert", (event) => {
        const payload = safePayload(event, "presence-upsert", localId);
        if (!payload?.presence || !currentStream(localId, remoteId, generation)) return;
        document.dispatchEvent(new CustomEvent("trip-presence-upsert", {
            detail: { tripId: localId, presence: payload.presence },
        }));
    });
    source.addEventListener("presence-leave", (event) => {
        const payload = safePayload(event, "presence-leave", localId);
        if (!payload || !currentStream(localId, remoteId, generation)) return;
        document.dispatchEvent(new CustomEvent("trip-presence-leave", {
            detail: { tripId: localId, ...payload },
        }));
    });
    source.addEventListener("members", () => void refreshMembership(localId, remoteId, generation));
    source.addEventListener("access-revoked", async (event) => {
        const payload = safePayload(event, "access-revoked", localId);
        if (!payload) return;
        if (payload.userId !== getCurrentUserId()) return void refreshMembership(localId, remoteId, generation);
        if (!currentStream(localId, remoteId, generation)) return;
        closeStream();
        await dropRevokedTrip(localId);
        toast("Ya no colaboras en este viaje.", "error");
    });
    source.addEventListener("trip-deleted", async () => {
        if (!currentStream(localId, remoteId, generation)) return;
        closeStream();
        await dropRevokedTrip(localId);
        toast("El propietario eliminó este viaje.", "error");
    });
}

export async function syncLiveTripStream() {
    const client = getCloudClient();
    const repository = getTripRepository();
    if (!client || !repository || !store.accountSession || store.accountSession.offline) return closeStream();
    const envelope = store.activeTripId ? await repository.getTrip(store.activeTripId) : null;
    const remoteId = envelope?.remote.id || null;
    if (!remoteId) return closeStream();
    if (remoteId === streamedRemoteId && source) return;
    closeStream();
    const generation = streamGeneration;
    streamedLocalId = store.activeTripId;
    streamedRemoteId = remoteId;
    setConnectionState("connecting", { tripId: streamedLocalId });
    source = new EventSource(client.tripEventsUrl(remoteId), { withCredentials: true });
    attachHandlers(streamedLocalId, streamedRemoteId, generation);
}

export function initializeLiveTripStream() {
    if (typeof EventSource !== "function") return;
    for (const event of ["active-trip-changed", "cloud-session-changed", "trip-library-changed"]) {
        document.addEventListener(event, () => void syncLiveTripStream());
    }
    void syncLiveTripStream();
}
