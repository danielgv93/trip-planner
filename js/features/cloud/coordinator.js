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

let csrf = null;
let client = null;
let draining = false;
let retryTimer = null;
let attempts = 0;
let remoteLibrary = [];
const conflicts = new Map();
let deviceIdentifier = null;

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

async function setEnvelopeState(id, state) {
    const repository = getTripRepository();
    const envelope = await repository?.getTrip(id);
    if (!envelope) return;
    envelope.syncState = state;
    await repository.putTrip(envelope);
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
        syncState: "synced",
    });
    await repository.putTrip(envelope);
    await switchTrip(envelope.id);
    return envelope;
}

async function drainItem(item) {
    const repository = getTripRepository();
    const envelope = await repository.getTrip(item.tripId);
    if (!envelope) return repository.deleteOutbox(item.tripId);
    if (item.type === "delete") {
        await client.deleteTrip(item.remoteId);
        await repository.deleteTripPermanently(item.tripId);
        await refreshTripLibrary();
        return;
    }
    if (item.type === "document") {
        const result = await client.mutateTrip(item.remoteId, {
            baseRevision: item.baseRevision,
            clientMutationId: item.clientMutationId,
            hash: item.hash || canonicalPlanHash(item.document),
            document: item.document,
            deviceId: deviceId(),
            origin: item.origin,
        });
        envelope.remote.baseRevision = Number(result.revision);
        envelope.remote.hash = result.hash;
        envelope.document = item.document;
    }
    if (item.patch) {
        const patched = await client.patchTrip(item.remoteId, item.patch);
        envelope.archived = Boolean(patched.trip.archivedAt);
        envelope.remote.baseRevision = Number(patched.trip.revision);
        envelope.remote.hash = patched.trip.hash;
    }
    envelope.syncState = "synced";
    await updateEnvelope(envelope, { removeOutbox: true });
}

export async function drainOutbox() {
    if (draining || !client || !store.accountSession) return;
    draining = true;
    clearTimeout(retryTimer);
    try {
        const repository = getTripRepository();
        const pending = await repository.listOutbox();
        if (!csrf) {
            const state = store.accountSession.offline ? "offline" : "auth-required";
            for (const item of pending) await setEnvelopeState(item.tripId, state);
            return;
        }
        client.reportQueueDepth(pending.length).catch(() => {});
        for (const item of pending) {
            try {
                await setEnvelopeState(item.tripId, navigator.onLine ? "pending" : "offline");
                if (!navigator.onLine) throw Object.assign(new Error("offline"), { code: "NETWORK" });
                await drainItem(item);
                attempts = 0;
            } catch (error) {
                const state = stateAfterFailure(error, { online: navigator.onLine, authenticated: Boolean(store.accountSession) });
                await setEnvelopeState(item.tripId, state);
                if (state === "conflict") {
                    const remote = await client.getTrip(item.remoteId);
                    conflicts.set(item.tripId, { item, remote: remote.trip });
                    document.dispatchEvent(new CustomEvent("trip-conflict", { detail: { tripId: item.tripId } }));
                    continue;
                }
                if (state === "auth-required") {
                    store.accountSession = null;
                    emitSession();
                    break;
                }
                attempts += 1;
                retryTimer = setTimeout(drainOutbox, nextRetryDelay(attempts));
                break;
            }
        }
        await refreshRemoteTrips().catch(() => {});
    } finally {
        draining = false;
    }
}

async function resumeSync() {
    if (store.accountSession?.offline || !csrf) await refreshCloudSession();
    await drainOutbox();
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
    const pendingIds = new Set((await repository.listOutbox()).map((item) => item.tripId));
    for (const local of await repository.listTrips({ includeArchived: true })) {
        const remote = remoteLibrary.find((item) => item.id === local.remote.id);
        if (!remote || pendingIds.has(local.id) || Number(remote.current_revision) <= Number(local.remote.baseRevision)) continue;
        const response = await client.getTrip(remote.id);
        local.document = response.trip.document;
        local.remote.baseRevision = Number(response.trip.current_revision);
        local.remote.hash = response.trip.document_hash;
        local.syncState = "synced";
        await updateEnvelope(local);
    }
}

export async function initializeCloud() {
    const config = cloudClientConfig();
    client = createCloudClient({ ...config, csrfToken: () => csrf });
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
        drainOutbox();
    }
    addEventListener("online", resumeSync);
    addEventListener("focus", async () => {
        await resumeSync();
        await checkRemoteUpdates();
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
