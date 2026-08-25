import { canonicalPlanHash } from "../../core/plan-hash.js";
import { randomUUID } from "../../core/random-id.js";
import { store } from "../../core/store.js";
import { createTripEnvelope } from "../../core/trip-envelope.js";
import {
    attachRemote,
    convertPendingToLocalCopies,
    detachRemoteTrips,
    duplicateTrip,
    getTripRepository,
    refreshTripLibrary,
    switchTrip,
    tripId,
    updateEnvelope,
} from "../library/workspace.js";
import { cloudClientConfig } from "./config.js";
import { createCloudClient } from "./client.js";
import { cloudAvailabilityAfterError, conflictResolutionEffects, nextRetryDelay, stateAfterFailure } from "./sync-state.js";
import { createSingleFlight, reconciliationDecision } from "./live-sync-contracts.js";
import { createOperationOutboxDrain } from "./operation-outbox.js";
import { LIVE_COLLABORATION_PROTOCOL_VERSION } from "./protocol-capability.js";

let csrf = null;
let client = null;
let retryTimer = null;
let attempts = 0;
let remoteLibrary = [];
const conflicts = new Map();
const reconciliationFlights = new Map();
let deviceIdentifier = null;
let liveCollaborationCapability = { enabled: false, protocolVersion: 0 };
let granularDrain = null;
let operationRetryTimer = null;
let operationAttempts = 0;

// Resolved lazily so that merely loading the page — as an anonymous visitor
// following a share link does — never stamps a device identifier on storage.
function deviceId() {
    if (deviceIdentifier) return deviceIdentifier;
    deviceIdentifier = localStorage.getItem("trip-planner-device-id") || randomUUID();
    localStorage.setItem("trip-planner-device-id", deviceIdentifier);
    return deviceIdentifier;
}

function emitSession() {
    document.dispatchEvent(new CustomEvent("cloud-session-changed"));
}

function setCloudAvailability(availability, error = null) {
    store.cloudAvailability = availability;
    store.cloudError = error;
    emitSession();
}

function emitRemoteLibrary() {
    document.dispatchEvent(new CustomEvent("remote-trip-library", { detail: remoteLibrary }));
}

function setLiveSyncState(state, error = null, detail = {}) {
    store.liveTripSyncState = state;
    store.liveTripSyncError = error;
    document.dispatchEvent(new CustomEvent("trip-live-state", { detail: { state, ...detail } }));
}

async function setEnvelopeState(id, state) {
    const repository = getTripRepository();
    const envelope = await repository?.setSyncState(id, state);
    if (!envelope) return;
    await refreshTripLibrary();
}

export async function refreshCloudSession() {
    if (!client) return null;
    setCloudAvailability("checking");
    try {
        const result = await client.session();
        store.accountSession = result.authenticated ? result : null;
        csrf = result.csrfToken || null;
        await getTripRepository()?.setPreference("accountSessionHint", store.accountSession
            ? { authenticated: true, user: result.user, expiresAt: result.expiresAt }
            : null);
        setCloudAvailability("available");
    } catch (error) {
        const cached = await getTripRepository()?.getPreference("accountSessionHint");
        store.accountSession = ["NETWORK", "TIMEOUT"].includes(error.code) && cached
            ? { ...cached, offline: true }
            : null;
        csrf = null;
        setCloudAvailability("unavailable", error);
    }
    return store.accountSession;
}

async function acceptAuthentication(result) {
    store.accountSession = { authenticated: true, user: result.user, expiresAt: result.expiresAt };
    csrf = result.csrfToken;
    setCloudAvailability("available");
    await getTripRepository()?.setPreference("accountSessionHint", store.accountSession);
    await refreshRemoteTrips();
    drainOutbox();
    return result;
}

export async function registerCloudAccount(email, password) {
    try {
        return await acceptAuthentication(await client.register(email, password, navigator.userAgent.slice(0, 100)));
    } catch (error) {
        setCloudAvailability(cloudAvailabilityAfterError(error), error);
        throw error;
    }
}

export async function loginCloud(email, password) {
    try {
        return await acceptAuthentication(await client.login(email, password, navigator.userAgent.slice(0, 100)));
    } catch (error) {
        setCloudAvailability(cloudAvailabilityAfterError(error), error);
        throw error;
    }
}

export async function updateCloudProfile(profile) {
    const result = await client.updateProfile(profile);
    store.accountSession = { ...store.accountSession, user: result.user };
    await getTripRepository()?.setPreference("accountSessionHint", store.accountSession);
    emitSession();
    return result.user;
}

export async function changeCloudPassword(currentPassword, newPassword) {
    return client.changePassword(currentPassword, newPassword);
}

export async function logoutCloud({ preservePending = false } = {}) {
    const pending = await getTripRepository().listOutbox();
    if (pending.length && preservePending) await convertPendingToLocalCopies();
    await client.logout();
    store.accountSession = null;
    csrf = null;
    remoteLibrary = [];
    await getTripRepository()?.setPreference("accountSessionHint", null);
    await getTripRepository()?.setPreference("remoteLibrary", []);
    emitSession();
    emitRemoteLibrary();
}

export async function deleteCloudAccount(password) {
    await client.deleteAccount(password);
    await detachRemoteTrips();
    store.accountSession = null;
    csrf = null;
    remoteLibrary = [];
    await getTripRepository()?.setPreference("accountSessionHint", null);
    await getTripRepository()?.setPreference("remoteLibrary", []);
    emitSession();
    emitRemoteLibrary();
}

export async function refreshRemoteTrips() {
    if (!store.accountSession) return [];
    const [active, archived] = await Promise.all([client.listTrips(false), client.listTrips(true)]);
    remoteLibrary = [...active.trips, ...archived.trips].map((trip) => ({ ...trip, remoteOnly: true }));
    await getTripRepository()?.setPreference("remoteLibrary", remoteLibrary);
    emitRemoteLibrary();
    return remoteLibrary;
}

export async function uploadLocalTrip(localId) {
    const repository = getTripRepository();
    const envelope = await repository.getTrip(localId);
    if (!envelope || envelope.remote.id) return envelope;
    const response = await client.createTrip(envelope.document, deviceId());
    const trip = response.trip;
    await attachRemote(localId, {
        id: trip.id,
        revision: trip.current_revision,
        hash: trip.document_hash,
        protocolVersion: trip.sync_protocol_version,
        role: trip.role,
        ownerId: trip.owner_id,
        members: trip.members,
    });
    await refreshRemoteTrips();
    return repository.getTrip(localId);
}

export async function openRemoteTrip(remoteId) {
    const repository = getTripRepository();
    const local = (await repository.listTrips({ includeArchived: true })).find((trip) => trip.remote.id === remoteId);
    if (local) return switchTrip(local.id);
    const response = await client.getTrip(remoteId);
    const remote = response.trip;
    const envelope = createTripEnvelope({
        id: tripId(),
        document: remote.document,
        remoteId: remote.id,
        baseRevision: Number(remote.current_revision),
        remoteHash: remote.document_hash,
        protocolVersion: Number(remote.sync_protocol_version) || 0,
        role: remote.role,
        ownerId: remote.owner_id,
        members: remote.members,
        archived: Boolean(remote.archived_at),
        syncState: "synced",
    });
    await repository.putTrip(envelope);
    await switchTrip(envelope.id);
    return envelope;
}

async function drainItem(item) {
    const repository = getTripRepository();
    const envelope = await repository.getTrip(item.tripId);
    if (!envelope) {
        await repository.deleteOutbox(item.tripId);
        return { removed: true };
    }
    if (item.type === "delete") {
        await client.deleteTrip(item.remoteId);
        await repository.deleteTripPermanently(item.tripId);
        await refreshTripLibrary();
        return { deleted: true };
    }
    let result = null;
    let patched = null;
    if (item.type === "document") {
        result = await client.mutateTrip(item.remoteId, {
            baseRevision: item.baseRevision,
            clientMutationId: item.clientMutationId,
            hash: item.hash || canonicalPlanHash(item.document),
            document: item.document,
            deviceId: deviceId(),
            origin: item.origin,
        });
    }
    if (item.patch) {
        patched = await client.patchTrip(item.remoteId, item.patch);
    }
    if (!result && !patched) return { pending: true };
    const revision = Number(patched?.trip.revision ?? result.revision);
    const hash = patched?.trip.hash ?? result.hash;
    const accepted = await repository.confirmMutation({
        tripId: item.tripId,
        sent: item,
        revision,
        remoteHash: hash,
        archived: patched ? Boolean(patched.trip.archivedAt) : undefined,
        nextClientMutationId: randomUUID(),
    });
    await refreshTripLibrary();
    return {
        revision,
        hash,
        noOp: result ? result.noOp === true && !patched?.trip.renamed : !patched?.trip.renamed,
        pending: accepted.pending,
    };
}

async function drainOutboxOnce() {
    const summary = { processed: [], confirmed: [], noOps: [], pending: [], conflicts: [], terminalError: null };
    if (!client || !store.accountSession) {
        summary.terminalError = Object.assign(new Error("AUTH_REQUIRED"), { code: "AUTH_REQUIRED", status: 401 });
        return summary;
    }
    clearTimeout(retryTimer);
    try {
        const repository = getTripRepository();
        const pending = await repository.listOutbox();
        if (!csrf) {
            const state = store.accountSession.offline ? "offline" : "auth-required";
            for (const item of pending) await setEnvelopeState(item.tripId, state);
            summary.pending.push(...pending.map((item) => item.tripId));
            summary.terminalError = Object.assign(new Error(state), {
                code: state === "auth-required" ? "AUTH_REQUIRED" : "NETWORK",
                status: state === "auth-required" ? 401 : undefined,
            });
            return summary;
        }
        client.reportQueueDepth(pending.length).catch(() => {});
        for (const item of pending) {
            summary.processed.push(item.tripId);
            try {
                await setEnvelopeState(item.tripId, navigator.onLine ? "pending" : "offline");
                if (!navigator.onLine) throw Object.assign(new Error("offline"), { code: "NETWORK" });
                const result = await drainItem(item);
                if (result.pending) summary.pending.push(item.tripId);
                else if (result.noOp) summary.noOps.push({ tripId: item.tripId, revision: result.revision, hash: result.hash });
                else summary.confirmed.push({ tripId: item.tripId, revision: result.revision, hash: result.hash });
                attempts = 0;
            } catch (error) {
                const state = stateAfterFailure(error, { online: navigator.onLine, authenticated: Boolean(store.accountSession) });
                await setEnvelopeState(item.tripId, state);
                if (state === "conflict") {
                    const remote = await client.getTrip(item.remoteId);
                    conflicts.set(item.tripId, { item, remote: remote.trip });
                    summary.conflicts.push(item.tripId);
                    document.dispatchEvent(new CustomEvent("trip-conflict", { detail: { tripId: item.tripId } }));
                    continue;
                }
                if (state === "auth-required") {
                    summary.pending.push(item.tripId);
                    summary.terminalError = error;
                    store.accountSession = null;
                    emitSession();
                    break;
                }
                attempts += 1;
                summary.pending.push(item.tripId);
                summary.terminalError = error;
                retryTimer = setTimeout(drainOutbox, nextRetryDelay(attempts));
                break;
            }
        }
        await refreshRemoteTrips().catch(() => {});
        if (store.activeTripId) await reconcileRemoteTrip(store.activeTripId, "drain-complete").catch(() => {});
        return summary;
    } catch (error) {
        summary.terminalError = error;
        return summary;
    }
}

const sharedDrain = createSingleFlight(drainOutboxOnce);

export function drainOutbox() {
    return sharedDrain();
}

function operationDrainForCurrentClient() {
    if (granularDrain) return granularDrain;
    const repository = getTripRepository();
    if (!repository || !client) return null;
    granularDrain = createOperationOutboxDrain({
        repository,
        publish: async (entry) => {
            if (!store.accountSession) throw Object.assign(new Error("AUTH_REQUIRED"), { code: "AUTH_REQUIRED", status: 401 });
            if (globalThis.navigator?.onLine === false) throw Object.assign(new Error("NETWORK"), { code: "NETWORK" });
            const envelope = await repository.getTrip(entry.tripId);
            if (!envelope?.remote.id) throw new Error("TRIP_NOT_AVAILABLE");
            return client.mutateTripOperation(envelope.remote.id, entry.operation);
        },
        onState: ({ tripId: localId, state, entry, error, result }) => {
            if (state === "conflict") {
                document.dispatchEvent(new CustomEvent("trip-operation-conflict", {
                    detail: { tripId: localId, localSequence: entry.localSequence, conflict: result?.error || error?.details },
                }));
            }
            if (state === "pending" && error) {
                const next = stateAfterFailure(error, {
                    online: globalThis.navigator?.onLine !== false,
                    authenticated: Boolean(store.accountSession),
                });
                void repository.setSyncState(localId, next);
                if (next !== "auth-required") {
                    clearTimeout(operationRetryTimer);
                    operationRetryTimer = setTimeout(
                        () => void drainOperationOutbox(localId),
                        nextRetryDelay(operationAttempts++),
                    );
                }
            } else if (state === "confirmed") {
                operationAttempts = 0;
                clearTimeout(operationRetryTimer);
            }
            document.dispatchEvent(new CustomEvent("trip-save-state"));
        },
    });
    return granularDrain;
}

export async function drainOperationOutbox(tripId = null) {
    const drain = operationDrainForCurrentClient();
    if (!drain) return [];
    const result = tripId ? [await drain.drainTrip(tripId)] : await drain.drainAll();
    await refreshTripLibrary();
    return result;
}

async function activateEligibleTrips() {
    if (!liveCollaborationCapability.enabled || Number(liveCollaborationCapability.protocolVersion) < LIVE_COLLABORATION_PROTOCOL_VERSION) return;
    const repository = getTripRepository();
    for (const envelope of await repository.listTrips({ includeArchived: true })) {
        if (!envelope.remote.id || envelope.remote.protocolVersion >= LIVE_COLLABORATION_PROTOCOL_VERSION) continue;
        if (envelope.remote.role === "viewer" || await repository.hasLegacyOutbox(envelope.id)) continue;
        const result = await client.activateTripOperations(envelope.remote.id, {
            expectedRevision: Number(envelope.remote.baseRevision),
            legacyOutboxEmpty: true,
        }).catch(() => null);
        if (!result) continue;
        envelope.remote.protocolVersion = Number(result.protocolVersion) || 0;
        await repository.putTrip(envelope);
    }
    await refreshTripLibrary();
}

async function reconcileRemoteTripOnce(localId, reason, { targetRevision = 0, isCurrent = () => true } = {}) {
    const repository = getTripRepository();
    const envelope = await repository?.getTrip(localId);
    if (!client || !store.accountSession || !envelope?.remote.id) return { status: "unavailable", reason };
    if (targetRevision && Number(targetRevision) <= Number(envelope.remote.baseRevision)) {
        return { status: "up-to-date", reason, revision: Number(envelope.remote.baseRevision) };
    }
    if (envelope.remote.protocolVersion >= LIVE_COLLABORATION_PROTOCOL_VERSION) {
        setLiveSyncState("pulling", null, { reason, tripId: localId, targetRevision: Number(targetRevision) || null });
        try {
            const { catchUpLiveTripOperations } = await import("./live-trip.js");
            const result = await catchUpLiveTripOperations(localId, Number(targetRevision) || 0);
            setLiveSyncState(result.status === "applied" || result.status === "snapshot" ? "applied" : "idle", null, {
                reason, tripId: localId, revision: result.revision,
            });
            return { ...result, reason };
        } catch (error) {
            setLiveSyncState("pull-error", error, { reason, tripId: localId, targetRevision: Number(targetRevision) || null });
            throw error;
        }
    }
    setLiveSyncState("pulling", null, { reason, tripId: localId, targetRevision: Number(targetRevision) || null });
    try {
        const [outbox, response] = await Promise.all([
            repository.getOutbox(localId),
            client.getTrip(envelope.remote.id),
        ]);
        const remote = response.trip;
        const latest = await repository.getTrip(localId);
        if (!latest || latest.remote.id !== remote.id) return { status: "stale", reason };
        const decision = reconciliationDecision({
            baseRevision: latest.remote.baseRevision,
            remoteRevision: remote.current_revision,
            hasOutbox: Boolean(outbox),
        });
        latest.remote.role = remote.role;
        latest.remote.ownerId = remote.owner_id;
        latest.remote.members = remote.members || [];
        if (decision === "pending-local") {
            latest.syncState = latest.syncState === "conflict" ? "conflict" : "pending";
            await repository.putTrip(latest);
            await refreshTripLibrary();
            setLiveSyncState("pending", null, { reason, tripId: localId, revision: Number(remote.current_revision) });
            return { status: decision, reason, revision: Number(remote.current_revision) };
        }
        if (decision === "apply-remote") {
            latest.document = remote.document;
            latest.remote.baseRevision = Number(remote.current_revision);
            latest.remote.hash = remote.document_hash;
            latest.syncState = "synced";
        }
        if (isCurrent()) await updateEnvelope(latest);
        else {
            await repository.putTrip(latest);
            await refreshTripLibrary();
        }
        setLiveSyncState(decision === "apply-remote" ? "applied" : "idle", null, {
            reason,
            tripId: localId,
            revision: Number(remote.current_revision),
        });
        return { status: decision, reason, revision: Number(remote.current_revision) };
    } catch (error) {
        setLiveSyncState("pull-error", error, { reason, tripId: localId, targetRevision: Number(targetRevision) || null });
        console.warn("live_trip_reconcile_failed", {
            reason,
            tripId: localId,
            revision: Number(targetRevision) || null,
            state: store.liveTripConnectionState,
            code: error?.code || null,
            status: error?.status || null,
        });
        throw error;
    }
}

export function reconcileRemoteTrip(localId, reason = "manual", options = {}) {
    if (!localId) return Promise.resolve({ status: "unavailable", reason });
    const existing = reconciliationFlights.get(localId);
    if (existing) {
        existing.targetRevision = Math.max(existing.targetRevision, Number(options.targetRevision) || 0);
        return existing.promise;
    }
    const state = { targetRevision: Number(options.targetRevision) || 0, promise: null };
    state.promise = (async () => {
        let result;
        let handledTarget = -1;
        do {
            handledTarget = state.targetRevision;
            result = await reconcileRemoteTripOnce(localId, reason, { ...options, targetRevision: handledTarget });
        } while (state.targetRevision > handledTarget && result.status !== "pending-local");
        return result;
    })().finally(() => reconciliationFlights.delete(localId));
    reconciliationFlights.set(localId, state);
    return state.promise;
}

async function resumeSync() {
    if (store.accountSession?.offline || !csrf) await refreshCloudSession();
    await drainOutbox();
    await activateEligibleTrips();
    await drainOperationOutbox();
    if (store.activeTripId) await reconcileRemoteTrip(store.activeTripId, "resume");
}

export async function resolveConflict(localId, action) {
    const conflict = conflicts.get(localId);
    if (!conflict) throw new Error("CONFLICT_NOT_FOUND");
    const repository = getTripRepository();
    const local = await repository.getTrip(localId);
    conflictResolutionEffects(action);
    if (action === "cloud") {
        await repository.duplicateTrip(localId, { newId: tripId(), title: `${local.document.tripTitle} (copia recuperable)` });
        local.document = conflict.remote.document;
        local.remote.baseRevision = Number(conflict.remote.current_revision);
        local.remote.hash = conflict.remote.document_hash;
        local.syncState = "synced";
        await updateEnvelope(local, { removeOutbox: true });
    } else if (action === "local") {
        local.remote.baseRevision = Number(conflict.remote.current_revision);
        local.syncState = "pending";
        await repository.putTrip(local);
        await repository.commitTrip(local, {
            ...conflict.item,
            baseRevision: local.remote.baseRevision,
            clientMutationId: randomUUID(),
        });
    } else if (action === "copy") {
        await repository.duplicateTrip(localId, { newId: tripId(), title: `${local.document.tripTitle} (copia)` });
        local.document = conflict.remote.document;
        local.remote.baseRevision = Number(conflict.remote.current_revision);
        local.remote.hash = conflict.remote.document_hash;
        local.syncState = "synced";
        await updateEnvelope(local, { removeOutbox: true });
    } else {
        throw new Error("INVALID_CONFLICT_ACTION");
    }
    conflicts.delete(localId);
    document.dispatchEvent(new CustomEvent("active-trip-changed"));
    if (action === "local") drainOutbox();
}

export async function checkRemoteUpdates() {
    if (!store.accountSession || !navigator.onLine) return;
    await refreshRemoteTrips();
    const repository = getTripRepository();
    const pendingIds = new Set([
        ...(await repository.listOutbox()).map((item) => item.tripId),
        ...(await repository.listOperations()).map((item) => item.tripId),
    ]);
    for (const local of await repository.listTrips({ includeArchived: true })) {
        if (!local.remote.id) continue;
        const remote = remoteLibrary.find((item) => item.id === local.remote.id);
        // A trip that vanished from the account is one this user was removed
        // from — or the owner deleted. Either way the local copy is stale.
        if (!remote) {
            if (!pendingIds.has(local.id)) await dropRevokedTrip(local.id);
            continue;
        }
        await reconcileRemoteTrip(local.id, "library-refresh", {
            targetRevision: Number(remote.current_revision),
        });
    }
}

// Losing access is not an error to retry: the local copy simply stops being a
// mirror of anything, so it is removed rather than left to fail forever.
export async function dropRevokedTrip(localId) {
    const repository = getTripRepository();
    await repository.deleteTripPermanently(localId);
    if (store.activeTripId === localId) {
        const next = (await repository.listTrips()).find((trip) => !trip.pendingDeletion);
        if (next) await switchTrip(next.id);
        else store.activeTripId = null;
    }
    await refreshTripLibrary();
    document.dispatchEvent(new CustomEvent("trip-access-revoked", { detail: { tripId: localId } }));
}

export async function listTripMembers(remoteId) {
    return client.listTripMembers(remoteId);
}

export async function inviteTripMember(remoteId, email, role) {
    const result = await client.inviteTripMember(remoteId, email, role);
    await refreshRemoteTrips().catch(() => {});
    return result.member;
}

export async function updateTripMemberRole(remoteId, memberId, role) {
    const result = await client.updateTripMemberRole(remoteId, memberId, role);
    await refreshRemoteTrips().catch(() => {});
    return result.member;
}

export async function removeTripMember(remoteId, memberId) {
    await client.removeTripMember(remoteId, memberId);
    await refreshRemoteTrips().catch(() => {});
}

// Leaving is a membership operation, like sharing: it only exists in the cloud,
// so it needs a connection instead of an outbox entry.
export async function leaveTrip(localId) {
    const repository = getTripRepository();
    const envelope = await repository.getTrip(localId);
    if (!envelope?.remote.id) throw new Error("TRIP_NOT_AVAILABLE");
    await client.leaveTrip(envelope.remote.id);
    await repository.deleteTripPermanently(localId);
    if (store.activeTripId === localId) {
        const next = (await repository.listTrips()).find((trip) => !trip.pendingDeletion);
        if (next) await switchTrip(next.id);
        else store.activeTripId = null;
    }
    await refreshRemoteTrips().catch(() => {});
    await refreshTripLibrary();
}

export async function initializeCloud() {
    const config = cloudClientConfig();
    client = createCloudClient({ ...config, csrfToken: () => csrf });
    liveCollaborationCapability = (await client.health().catch(() => null))?.capabilities?.liveCollaboration
        || { enabled: false, protocolVersion: 0 };
    const repository = getTripRepository();
    const cachedSession = await repository?.getPreference("accountSessionHint");
    if (cachedSession) {
        store.accountSession = { ...cachedSession, offline: true };
        emitSession();
    }
    remoteLibrary = await repository?.getPreference("remoteLibrary") || [];
    emitRemoteLibrary();
    await refreshCloudSession();
    if (store.accountSession) {
        await refreshRemoteTrips().catch(() => {});
        await drainOutbox();
        await activateEligibleTrips();
        await repository?.recoverSendingOperations();
        await drainOperationOutbox();
        if (store.activeTripId) await reconcileRemoteTrip(store.activeTripId, "startup").catch(() => {});
    }
    addEventListener("online", resumeSync);
    addEventListener("focus", async () => {
        await resumeSync();
        await checkRemoteUpdates();
    });
    document.addEventListener("active-trip-changed", () => {
        if (store.activeTripId) void reconcileRemoteTrip(store.activeTripId, "active-trip").catch(() => {});
    });
    document.addEventListener("trip-operation-needed", (event) => {
        void drainOperationOutbox(event.detail?.tripId || store.activeTripId);
    });
    return { available: store.cloudAvailability === "available", authenticated: Boolean(store.accountSession) };
}

// Share state lives only in the cloud: a link cannot exist for a trip that was
// never uploaded, so these go straight to the API instead of the envelope.
export async function readTripShare(remoteId) {
    return (await client.getTripShare(remoteId)).share;
}

export async function shareTrip(remoteId) {
    const share = (await client.shareTrip(remoteId)).share;
    await refreshRemoteTrips().catch(() => {});
    return share;
}

export async function unshareTrip(remoteId) {
    const share = (await client.unshareTrip(remoteId)).share;
    await refreshRemoteTrips().catch(() => {});
    return share;
}

export const getCloudClient = () => client;
export const getRemoteLibrary = () => remoteLibrary;
export const getCurrentUserId = () => store.accountSession?.user?.id || null;
export const getDeviceId = () => deviceId();
