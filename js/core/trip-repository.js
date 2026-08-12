import { createTripEnvelope, normalizeTripEnvelope } from "./trip-envelope.js";

export const TRIP_DATABASE_NAME = "trip-planner-workspaces";
export const TRIP_DATABASE_VERSION = 1;
const STORES = ["trips", "outbox", "preferences", "cachedRevisions"];

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error("TRANSACTION_ABORTED"));
    });
}

export function openIndexedDb(indexedDb = globalThis.indexedDB) {
    if (!indexedDb) return Promise.reject(new Error("INDEXEDDB_UNAVAILABLE"));
    const request = indexedDb.open(TRIP_DATABASE_NAME, TRIP_DATABASE_VERSION);
    request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("trips")) {
            const trips = db.createObjectStore("trips", { keyPath: "id" });
            trips.createIndex("updatedAt", "updatedAt");
        }
        if (!db.objectStoreNames.contains("outbox")) {
            const outbox = db.createObjectStore("outbox", { keyPath: "tripId" });
            outbox.createIndex("createdAt", "createdAt");
        }
        if (!db.objectStoreNames.contains("preferences")) db.createObjectStore("preferences", { keyPath: "key" });
        if (!db.objectStoreNames.contains("cachedRevisions")) {
            const revisions = db.createObjectStore("cachedRevisions", { keyPath: ["tripId", "revision"] });
            revisions.createIndex("tripId", "tripId");
        }
    };
    return requestResult(request);
}

export function createIndexedDbAdapter(db) {
    return {
        async transaction(storeNames, mode, callback) {
            const tx = db.transaction(storeNames, mode);
            const stores = Object.fromEntries(storeNames.map((name) => [name, {
                get: (key) => requestResult(tx.objectStore(name).get(key)),
                getAll: () => requestResult(tx.objectStore(name).getAll()),
                put: (value) => requestResult(tx.objectStore(name).put(value)),
                delete: (key) => requestResult(tx.objectStore(name).delete(key)),
            }]));
            const result = await callback(stores);
            await transactionDone(tx);
            return result;
        },
        close: () => db.close(),
    };
}

export function createMemoryStorage(seed = {}) {
    const maps = Object.fromEntries(STORES.map((name) => [name, new Map()]));
    for (const [name, values] of Object.entries(seed)) {
        for (const value of values) {
            const key = name === "cachedRevisions" ? `${value.tripId}:${value.revision}` : value.id ?? value.tripId ?? value.key;
            maps[name].set(JSON.stringify(key), clone(value));
        }
    }
    return {
        async transaction(storeNames, _mode, callback) {
            const snapshots = Object.fromEntries(storeNames.map((name) => [name, new Map(maps[name])]));
            const stores = Object.fromEntries(storeNames.map((name) => [name, {
                get: async (key) => clone(maps[name].get(JSON.stringify(Array.isArray(key) ? `${key[0]}:${key[1]}` : key))),
                getAll: async () => [...maps[name].values()].map(clone),
                put: async (value) => {
                    const rawKey = name === "cachedRevisions" ? `${value.tripId}:${value.revision}` : value.id ?? value.tripId ?? value.key;
                    maps[name].set(JSON.stringify(rawKey), clone(value));
                    return rawKey;
                },
                delete: async (key) => maps[name].delete(JSON.stringify(Array.isArray(key) ? `${key[0]}:${key[1]}` : key)),
            }]));
            try {
                return await callback(stores);
            } catch (error) {
                storeNames.forEach((name) => { maps[name] = snapshots[name]; });
                throw error;
            }
        },
        close() {},
    };
}

export function createTripRepository(storage) {
    const read = (names, callback) => storage.transaction(names, "readonly", callback);
    const write = (names, callback) => storage.transaction(names, "readwrite", callback);
    return {
        async listTrips({ includeArchived = false, includePendingDeletion = false } = {}) {
            const trips = await read(["trips"], ({ trips }) => trips.getAll());
            return trips
                .filter((trip) => (includeArchived || !trip.archived) && (includePendingDeletion || !trip.pendingDeletion))
                .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        },
        async getTrip(id) {
            const value = await read(["trips"], ({ trips }) => trips.get(id));
            return value ? normalizeTripEnvelope(value) : null;
        },
        async putTrip(envelope) {
            const normalized = normalizeTripEnvelope(envelope);
            await write(["trips"], ({ trips }) => trips.put(normalized));
            return normalized;
        },
        async duplicateTrip(id, { newId, title, updatedAt = new Date().toISOString() }) {
            return write(["trips"], async ({ trips }) => {
                const source = await trips.get(id);
                if (!source) throw new Error("TRIP_NOT_FOUND");
                const duplicate = createTripEnvelope({
                    id: newId,
                    document: { ...source.document, tripTitle: title || `${source.document.tripTitle} (copia)` },
                    updatedAt,
                    preferences: clone(source.preferences),
                });
                await trips.put(duplicate);
                return duplicate;
            });
        },
        async setArchived(id, archived) {
            return write(["trips"], async ({ trips }) => {
                const value = await trips.get(id);
                if (!value) throw new Error("TRIP_NOT_FOUND");
                value.archived = archived === true;
                value.updatedAt = new Date().toISOString();
                await trips.put(value);
                return value;
            });
        },
        async markForDeletion(id) {
            return write(["trips", "outbox"], async ({ trips, outbox }) => {
                const value = await trips.get(id);
                if (!value) return null;
                if (value.remote.id) {
                    value.pendingDeletion = true;
                    value.syncState = "pending-deletion";
                    await trips.put(value);
                    await outbox.put({
                        tripId: id,
                        remoteId: value.remote.id,
                        type: "delete",
                        clientMutationId: crypto.randomUUID(),
                        createdAt: new Date().toISOString(),
                    });
                } else {
                    await trips.delete(id);
                    await outbox.delete(id);
                }
                return value;
            });
        },
        async deleteTripPermanently(id) {
            await write(["trips", "outbox"], async ({ trips, outbox }) => {
                await trips.delete(id);
                await outbox.delete(id);
            });
        },
        async commitTrip(envelope, mutation = null) {
            const normalized = normalizeTripEnvelope(envelope);
            return write(["trips", "outbox"], async ({ trips, outbox }) => {
                await trips.put(normalized);
                if (mutation) {
                    const existing = await outbox.get(normalized.id);
                    const pending = {
                        ...existing,
                        ...mutation,
                        tripId: normalized.id,
                        clientMutationId: existing?.clientMutationId || mutation.clientMutationId,
                        createdAt: existing?.createdAt || mutation.createdAt || new Date().toISOString(),
                    };
                    if (
                        (existing?.type === "document" && mutation.type === "metadata") ||
                        (existing?.type === "metadata" && mutation.type === "document")
                    ) {
                        pending.type = "document";
                        pending.patch = { ...(existing?.patch || {}), ...(mutation.patch || {}) };
                    }
                    await outbox.put(pending);
                }
                return normalized;
            });
        },
        listOutbox: () => read(["outbox"], async ({ outbox }) => (await outbox.getAll()).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))),
        getOutbox: (tripId) => read(["outbox"], ({ outbox }) => outbox.get(tripId)),
        deleteOutbox: (tripId) => write(["outbox"], ({ outbox }) => outbox.delete(tripId)),
        async setPreference(key, value) {
            await write(["preferences"], ({ preferences }) => preferences.put({ key, value }));
        },
        async getPreference(key) {
            return (await read(["preferences"], ({ preferences }) => preferences.get(key)))?.value;
        },
        async cacheRevision(entry, limit = 20) {
            await write(["cachedRevisions"], async ({ cachedRevisions }) => {
                await cachedRevisions.put(entry);
                const all = (await cachedRevisions.getAll())
                    .filter((item) => item.tripId === entry.tripId)
                    .sort((a, b) => b.revision - a.revision);
                await Promise.all(all.slice(limit).map((item) => cachedRevisions.delete([item.tripId, item.revision])));
            });
        },
        async getCachedRevision(tripId, revision) {
            return read(["cachedRevisions"], ({ cachedRevisions }) => cachedRevisions.get([tripId, revision]));
        },
        close: () => storage.close(),
    };
}

export async function openTripRepository(indexedDb) {
    return createTripRepository(createIndexedDbAdapter(await openIndexedDb(indexedDb)));
}
