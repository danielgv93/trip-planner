import { DEFAULT_CATEGORIES } from "../../core/constants.js";
import { migrateLegacyTrip } from "../../core/legacy-trip-migration.js";
import { normalizePlan, portablePlanFrom } from "../../core/plan-json.js";
import { randomUUID } from "../../core/random-id.js";
import { canonicalPlanHash } from "../../core/plan-hash.js";
import { store, registerTripCommitter, replacePlanState } from "../../core/store.js";
import { createTripEnvelope } from "../../core/trip-envelope.js";
import { openTripRepository } from "../../core/trip-repository.js";
import { clearHistory, pushUndo } from "../planner/history.js";

let repository = null;
let lastCommit = Promise.resolve();

export function tripId() {
    return randomUUID();
}

function emptyDocument(title = "Nuevo viaje") {
    const today = new Date().toISOString().slice(0, 10);
    return {
        version: 28,
        tripTitle: title,
        localCurrency: "EUR",
        foreignCurrency: "JPY",
        exchangeRate: null,
        exchangeRateDate: "",
        tripNotePages: [{ id: "notes-general", title: "General", content: "" }],
        days: [{ id: tripId(), date: today, title: "Primer día", spots: [] }],
        backlog: [],
        backlogGroups: [],
        tags: [],
        categories: structuredClone(DEFAULT_CATEGORIES),
        routeProfile: "driving",
        routeVisualization: "straight",
        travelLegs: {},
        reminders: [],
    };
}

function preferencesFromStore() {
    return {
        backlogCollapsed: store.backlogCollapsed,
        activeTripNotePageId: store.activeTripNotePageId,
        basemap: store.basemap,
        workspaceSplit: store.workspaceSplit,
        itineraryDensity: store.itineraryDensity,
    };
}

function applyPreferences(preferences = {}) {
    store.backlogCollapsed = preferences.backlogCollapsed === true;
    store.basemap = ["liberty", "osm"].includes(preferences.basemap) ? preferences.basemap : store.basemap;
    store.workspaceSplit = Number.isFinite(preferences.workspaceSplit) ? preferences.workspaceSplit : null;
    store.itineraryDensity = preferences.itineraryDensity === "compact" ? "compact" : "comfortable";
    if (store.tripNotePages.some((page) => page.id === preferences.activeTripNotePageId)) {
        store.activeTripNotePageId = preferences.activeTripNotePageId;
    }
}

export async function refreshTripLibrary() {
    if (!repository) return [];
    store.tripLibrary = await repository.listTrips({ includeArchived: true, includePendingDeletion: true });
    document.dispatchEvent(new CustomEvent("trip-library-changed"));
    return store.tripLibrary;
}

async function envelopeForActive() {
    const existing = store.activeTripId ? await repository.getTrip(store.activeTripId) : null;
    return createTripEnvelope({
        id: store.activeTripId,
        document: portablePlanFrom(store),
        remoteId: existing?.remote.id,
        baseRevision: existing?.remote.baseRevision,
        remoteHash: existing?.remote.hash,
        syncState: existing?.remote.id ? "pending" : "local",
        archived: existing?.archived,
        pendingDeletion: existing?.pendingDeletion,
        preferences: preferencesFromStore(),
    });
}

export function commitActiveTrip() {
    if (!repository || !store.activeTripId) return Promise.resolve();
    lastCommit = lastCommit.then(async () => {
        const envelope = await envelopeForActive();
        if (envelope.pendingDeletion) throw new Error("TRIP_PENDING_DELETION");
        const mutation = envelope.remote.id ? {
            type: "document",
            remoteId: envelope.remote.id,
            baseRevision: envelope.remote.baseRevision,
            clientMutationId: randomUUID(),
            hash: canonicalPlanHash(envelope.document),
            document: envelope.document,
        } : null;
        await repository.commitTrip(envelope, mutation);
        await refreshTripLibrary();
        if (mutation) document.dispatchEvent(new CustomEvent("trip-sync-needed"));
    });
    return lastCommit;
}

export async function waitForActiveCommit() {
    await lastCommit;
}

export async function initializeTripWorkspace() {
    try {
        repository = await openTripRepository();
        const migration = await migrateLegacyTrip({
            repository,
            localStorage,
            createId: tripId,
        });
        let trips = await repository.listTrips({ includeArchived: true, includePendingDeletion: true });
        if (!trips.length) {
            const initial = createTripEnvelope({ id: tripId(), document: portablePlanFrom(store), preferences: preferencesFromStore() });
            await repository.putTrip(initial);
            trips = [initial];
        }
        const preferredId = store.activeTripId || migration.id || await repository.getPreference("activeTripId");
        const active = trips.find((trip) => trip.id === preferredId && !trip.pendingDeletion)
            || trips.find((trip) => !trip.archived && !trip.pendingDeletion)
            || null;
        if (active) await loadTrip(active);
        else store.activeTripId = null;
        registerTripCommitter(commitActiveTrip);
        await refreshTripLibrary();
        return { available: true, migration, hasActiveTrip: Boolean(active) };
    } catch (error) {
        store.saveStatus = "error";
        store.saveError = error;
        document.dispatchEvent(new CustomEvent("trip-save-state"));
        return { available: false, error, hasActiveTrip: true };
    }
}

async function loadTrip(envelope) {
    replacePlanState(normalizePlan(envelope.document));
    applyPreferences(envelope.preferences);
    store.activeTripId = envelope.id;
    localStorage.setItem("trip-planner-active-trip-id", envelope.id);
    if (repository) await repository.setPreference("activeTripId", envelope.id);
    clearHistory();
}

export async function createTrip(title) {
    await waitForActiveCommit();
    const envelope = createTripEnvelope({ id: tripId(), document: emptyDocument(title) });
    await repository.putTrip(envelope);
    await loadTrip(envelope);
    await refreshTripLibrary();
    return envelope;
}

export async function duplicateTrip(id) {
    await waitForActiveCommit();
    const duplicate = await repository.duplicateTrip(id, { newId: tripId() });
    await refreshTripLibrary();
    return duplicate;
}

export async function switchTrip(id) {
    if (id === store.activeTripId) return repository.getTrip(id);
    await waitForActiveCommit();
    const envelope = await repository.getTrip(id);
    if (!envelope || envelope.pendingDeletion) throw new Error("TRIP_NOT_AVAILABLE");
    await loadTrip(envelope);
    await refreshTripLibrary();
    document.dispatchEvent(new CustomEvent("active-trip-changed"));
    return envelope;
}

export async function renameTrip(id, title) {
    const envelope = await repository.getTrip(id);
    if (!envelope) throw new Error("TRIP_NOT_FOUND");
    envelope.document.tripTitle = title.trim() || "Viaje sin título";
    envelope.updatedAt = new Date().toISOString();
    envelope.syncState = envelope.remote.id ? "pending" : "local";
    const mutation = envelope.remote.id ? {
        type: "document",
        remoteId: envelope.remote.id,
        baseRevision: envelope.remote.baseRevision,
        clientMutationId: randomUUID(),
        hash: canonicalPlanHash(envelope.document),
        document: envelope.document,
    } : null;
    await repository.commitTrip(envelope, mutation);
    if (id === store.activeTripId) store.tripTitle = envelope.document.tripTitle;
    await refreshTripLibrary();
    if (mutation) document.dispatchEvent(new CustomEvent("trip-sync-needed"));
}

export async function archiveTrip(id, archived) {
    const envelope = await repository.setArchived(id, archived);
    if (envelope.remote.id) {
        envelope.syncState = "pending";
        await repository.commitTrip(envelope, {
            type: "metadata",
            remoteId: envelope.remote.id,
            clientMutationId: randomUUID(),
            patch: { archived: archived === true },
        });
        document.dispatchEvent(new CustomEvent("trip-sync-needed"));
    }
    await refreshTripLibrary();
}

export async function deleteTrip(id) {
    await repository.markForDeletion(id);
    if (id === store.activeTripId) {
        const next = (await repository.listTrips()).find((trip) => !trip.pendingDeletion);
        if (next) await loadTrip(next);
        else store.activeTripId = null;
    }
    await refreshTripLibrary();
    document.dispatchEvent(new CustomEvent("trip-sync-needed"));
}

export async function importAsNewTrip(document) {
    const envelope = createTripEnvelope({ id: tripId(), document });
    await repository.putTrip(envelope);
    await refreshTripLibrary();
    return envelope;
}

export async function replaceActiveTrip(planDocument) {
    pushUndo();
    replacePlanState(normalizePlan(planDocument));
    await commitActiveTrip();
    document.dispatchEvent(new CustomEvent("active-trip-changed"));
}

export async function attachRemote(id, remote) {
    const envelope = await repository.getTrip(id);
    if (!envelope) throw new Error("TRIP_NOT_FOUND");
    envelope.remote = { id: remote.id, baseRevision: Number(remote.revision), hash: remote.hash };
    envelope.syncState = "synced";
    await repository.putTrip(envelope);
    await repository.deleteOutbox(id);
    await refreshTripLibrary();
    return envelope;
}

export async function updateEnvelope(envelope, { removeOutbox = false } = {}) {
    await repository.putTrip(envelope);
    if (removeOutbox) await repository.deleteOutbox(envelope.id);
    const changed = envelope.id === store.activeTripId
        && canonicalPlanHash(envelope.document) !== canonicalPlanHash(portablePlanFrom(store));
    if (changed) {
        replacePlanState(normalizePlan(envelope.document));
        applyPreferences(envelope.preferences);
        document.dispatchEvent(new CustomEvent("active-trip-changed"));
    }
    await refreshTripLibrary();
}

export async function convertPendingToLocalCopies() {
    const pending = await repository.listOutbox();
    for (const item of pending) {
        if (item.type !== "document") continue;
        const source = await repository.getTrip(item.tripId);
        if (!source) continue;
        await repository.putTrip(createTripEnvelope({
            id: tripId(),
            document: { ...source.document, tripTitle: `${source.document.tripTitle} (copia local)` },
            preferences: source.preferences,
        }));
    }
    await refreshTripLibrary();
}

export async function detachRemoteTrips() {
    const trips = await repository.listTrips({ includeArchived: true, includePendingDeletion: true });
    for (const envelope of trips) {
        if (!envelope.remote.id) continue;
        envelope.remote = { id: null, baseRevision: 0, hash: null };
        envelope.syncState = "local";
        envelope.pendingDeletion = false;
        await repository.putTrip(envelope);
        await repository.deleteOutbox(envelope.id);
    }
    await refreshTripLibrary();
}

export const getTripRepository = () => repository;
