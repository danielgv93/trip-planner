import { randomUUID } from "./random-id.js";
import { createTripEnvelope, normalizeTripEnvelope } from "./trip-envelope.js";
import { canonicalPlanHash } from "./plan-hash.js";
import { applyPlanOperation, PlanOperationError } from "./plan-operations.js";

export const TRIP_DATABASE_NAME = "trip-planner-workspaces";
export const TRIP_DATABASE_VERSION = 2;
const STORES = ["trips", "outbox", "operations", "preferences", "cachedRevisions"];

function storageKey(name, value) {
    if (name === "cachedRevisions") return `${value.tripId}:${value.revision}`;
    if (name === "operations") return `${value.tripId}:${value.localSequence}`;
    return value.id ?? value.tripId ?? value.key;
}

function requestKey(name, key) {
    if (name === "cachedRevisions" || name === "operations") {
        return Array.isArray(key) ? `${key[0]}:${key[1]}` : key;
    }
    return key;
}

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
        if (!db.objectStoreNames.contains("operations")) {
            const operations = db.createObjectStore("operations", { keyPath: ["tripId", "localSequence"] });
            operations.createIndex("tripId", "tripId");
            operations.createIndex("tripStatus", ["tripId", "status"]);
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
            const key = storageKey(name, value);
            maps[name].set(JSON.stringify(key), clone(value));
        }
    }
    return {
        async transaction(storeNames, _mode, callback) {
            const snapshots = Object.fromEntries(storeNames.map((name) => [name, new Map(maps[name])]));
            const stores = Object.fromEntries(storeNames.map((name) => [name, {
                get: async (key) => clone(maps[name].get(JSON.stringify(requestKey(name, key)))),
                getAll: async () => [...maps[name].values()].map(clone),
                put: async (value) => {
                    const rawKey = storageKey(name, value);
                    maps[name].set(JSON.stringify(rawKey), clone(value));
                    return rawKey;
                },
                delete: async (key) => maps[name].delete(JSON.stringify(requestKey(name, key))),
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

function sameScalarTarget(first, second) {
    return first?.kind === "set-field" && second?.kind === "set-field"
        && first.target?.type === second.target?.type
        && first.target?.id === second.target?.id
        && first.target?.field === second.target?.field;
}

export function coalesceQueuedOperation(existing, incoming, now = new Date().toISOString()) {
    if (existing?.status !== "queued" || existing.sentAt || !sameScalarTarget(existing.operation, incoming.operation)) {
        return null;
    }
    const desired = incoming.operation.payload?.remove === true
        ? undefined
        : clone(incoming.operation.payload?.value);
    const inverse = existing.inverse ? clone(existing.inverse) : null;
    if (inverse) {
        inverse.precondition = desired === undefined
            ? { expectedAbsent: true }
            : { expectedValue: desired };
    }
    return {
        ...existing,
        operation: {
            ...existing.operation,
            payload: clone(incoming.operation.payload),
        },
        inverse,
        localValue: clone(incoming.localValue),
        updatedAt: now,
    };
}

function operationRecords(values, tripId = null) {
    return values
        .filter((entry) => !tripId || entry.tripId === tripId)
        .sort((a, b) => String(a.tripId).localeCompare(String(b.tripId)) || a.localSequence - b.localSequence);
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
        async setSyncState(id, syncState) {
            const value = await write(["trips"], async ({ trips }) => {
                const envelope = await trips.get(id);
                if (!envelope) return null;
                envelope.syncState = syncState;
                await trips.put(envelope);
                return envelope;
            });
            return value ? normalizeTripEnvelope(value) : null;
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
            return write(["trips", "outbox", "operations"], async ({ trips, outbox, operations }) => {
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
                        clientMutationId: randomUUID(),
                        createdAt: new Date().toISOString(),
                    });
                } else {
                    await trips.delete(id);
                    await outbox.delete(id);
                    const queued = await operations.getAll();
                    await Promise.all(queued.filter((entry) => entry.tripId === id)
                        .map((entry) => operations.delete([entry.tripId, entry.localSequence])));
                }
                return value;
            });
        },
        async deleteTripPermanently(id) {
            await write(["trips", "outbox", "operations"], async ({ trips, outbox, operations }) => {
                await trips.delete(id);
                await outbox.delete(id);
                const queued = await operations.getAll();
                await Promise.all(queued.filter((entry) => entry.tripId === id)
                    .map((entry) => operations.delete([entry.tripId, entry.localSequence])));
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
        async commitOperation(envelope, entry) {
            const normalized = normalizeTripEnvelope(envelope);
            return write(["trips", "outbox", "operations"], async ({ trips, outbox, operations }) => {
                if (await outbox.get(normalized.id)) throw new Error("LEGACY_OUTBOX_PENDING");
                const all = operationRecords(await operations.getAll(), normalized.id);
                const latest = all.at(-1);
                const merged = coalesceQueuedOperation(latest, entry);
                let stored;
                if (merged) {
                    stored = merged;
                } else {
                    const localSequence = (latest?.localSequence || 0) + 1;
                    stored = {
                        tripId: normalized.id,
                        localSequence,
                        status: "queued",
                        operation: clone(entry.operation),
                        inverse: clone(entry.inverse),
                        localValue: clone(entry.localValue),
                        attempts: 0,
                        createdAt: entry.createdAt || new Date().toISOString(),
                        updatedAt: entry.updatedAt || entry.createdAt || new Date().toISOString(),
                    };
                }
                normalized.syncState = "pending";
                await trips.put(normalized);
                await operations.put(stored);
                return { envelope: normalized, entry: clone(stored), coalesced: Boolean(merged) };
            });
        },
        async listOperations(tripId = null) {
            return read(["operations"], async ({ operations }) => operationRecords(await operations.getAll(), tripId));
        },
        async getOperation(tripId, localSequence) {
            return read(["operations"], ({ operations }) => operations.get([tripId, localSequence]));
        },
        async claimNextOperation(tripId) {
            return write(["operations"], async ({ operations }) => {
                const entry = operationRecords(await operations.getAll(), tripId)
                    .find((candidate) => candidate.status !== "conflict");
                if (!entry || entry.status !== "queued") return null;
                entry.status = "sending";
                entry.sentAt = new Date().toISOString();
                entry.updatedAt = entry.sentAt;
                await operations.put(entry);
                return clone(entry);
            });
        },
        async recoverSendingOperations(tripId = null) {
            return write(["operations"], async ({ operations }) => {
                const entries = operationRecords(await operations.getAll(), tripId);
                let recovered = 0;
                for (const entry of entries) {
                    if (entry.status !== "sending") continue;
                    entry.status = "queued";
                    delete entry.sentAt;
                    entry.attempts = (entry.attempts || 0) + 1;
                    entry.updatedAt = new Date().toISOString();
                    await operations.put(entry);
                    recovered += 1;
                }
                return recovered;
            });
        },
        async retryOperation(tripId, localSequence) {
            return write(["operations"], async ({ operations }) => {
                const entry = await operations.get([tripId, localSequence]);
                if (!entry || entry.status === "conflict") return entry || null;
                entry.status = "queued";
                delete entry.sentAt;
                entry.attempts = (entry.attempts || 0) + 1;
                entry.updatedAt = new Date().toISOString();
                await operations.put(entry);
                return clone(entry);
            });
        },
        async confirmOperation({ tripId, localSequence, clientMutationId, revision, remoteHash }) {
            return write(["trips", "operations"], async ({ trips, operations }) => {
                const envelope = await trips.get(tripId);
                const entry = await operations.get([tripId, localSequence]);
                if (!envelope || !entry || entry.operation?.clientMutationId !== clientMutationId) {
                    return { envelope: envelope ? normalizeTripEnvelope(envelope) : null, confirmed: false };
                }
                await operations.delete([tripId, localSequence]);
                envelope.remote.baseRevision = Number(revision);
                envelope.remote.hash = remoteHash || envelope.remote.hash;
                const remaining = operationRecords(await operations.getAll(), tripId);
                envelope.syncState = remaining.some((item) => item.status === "conflict")
                    ? "conflict"
                    : remaining.length ? "pending" : "synced";
                await trips.put(envelope);
                return { envelope: normalizeTripEnvelope(envelope), confirmed: true, pending: remaining.length > 0 };
            });
        },
        async markOperationConflict({ tripId, localSequence, conflict }) {
            return write(["trips", "operations"], async ({ trips, operations }) => {
                const entry = await operations.get([tripId, localSequence]);
                if (!entry) return null;
                entry.status = "conflict";
                delete entry.sentAt;
                entry.conflict = clone(conflict);
                entry.updatedAt = new Date().toISOString();
                await operations.put(entry);
                const envelope = await trips.get(tripId);
                if (envelope) {
                    envelope.syncState = "conflict";
                    await trips.put(envelope);
                }
                return clone(entry);
            });
        },
        async discardOperationConflict(tripId, localSequence) {
            return write(["trips", "operations"], async ({ trips, operations }) => {
                const entry = await operations.get([tripId, localSequence]);
                if (!entry || entry.status !== "conflict") return null;
                await operations.delete([tripId, localSequence]);
                const envelope = await trips.get(tripId);
                if (envelope) {
                    const remaining = operationRecords(await operations.getAll(), tripId);
                    envelope.syncState = remaining.some((item) => item.status === "conflict")
                        ? "conflict" : remaining.length ? "pending" : envelope.remote?.id ? "synced" : "local";
                    await trips.put(envelope);
                }
                return clone(entry);
            });
        },
        async rebaseOperations({ tripId, remoteDocument, revision, remoteHash }) {
            return write(["trips", "operations"], async ({ trips, operations }) => {
                const envelope = await trips.get(tripId);
                if (!envelope) throw new Error("TRIP_NOT_FOUND");
                let document = clone(remoteDocument);
                const conflicts = [];
                const entries = operationRecords(await operations.getAll(), tripId);
                for (const entry of entries) {
                    if (entry.status === "conflict") {
                        conflicts.push(clone(entry));
                        continue;
                    }
                    try {
                        const applied = applyPlanOperation(document, entry.operation, { currentRevision: Number(revision) });
                        document = applied.document;
                        entry.status = "queued";
                        delete entry.sentAt;
                        await operations.put(entry);
                    } catch (error) {
                        if (!(error instanceof PlanOperationError)) throw error;
                        entry.status = "conflict";
                        delete entry.sentAt;
                        entry.conflict = {
                            code: error.code,
                            target: error.target,
                            details: error.details,
                            remoteRevision: Number(revision),
                        };
                        await operations.put(entry);
                        conflicts.push(clone(entry));
                    }
                }
                envelope.document = document;
                envelope.remote.baseRevision = Number(revision);
                envelope.remote.hash = remoteHash || envelope.remote.hash;
                envelope.syncState = conflicts.length ? "conflict" : entries.length ? "pending" : "synced";
                await trips.put(envelope);
                return { envelope: normalizeTripEnvelope(envelope), conflicts, pending: entries.length - conflicts.length };
            });
        },
        async applyRemoteOperation({ tripId, remote }) {
            return write(["trips", "operations"], async ({ trips, operations }) => {
                const envelope = await trips.get(tripId);
                if (!envelope) throw new Error("TRIP_NOT_FOUND");
                const entries = operationRecords(await operations.getAll(), tripId);
                const echo = entries.find((entry) =>
                    entry.operation?.clientMutationId === remote.operation?.clientMutationId
                    && entry.operation?.deviceId === remote.operation?.deviceId,
                );
                if (echo) {
                    await operations.delete([echo.tripId, echo.localSequence]);
                    envelope.remote.baseRevision = Number(remote.revision);
                    envelope.remote.hash = remote.hash || envelope.remote.hash;
                    const remaining = entries.filter((entry) => entry !== echo);
                    envelope.syncState = remaining.some((entry) => entry.status === "conflict")
                        ? "conflict" : remaining.length ? "pending" : "synced";
                    await trips.put(envelope);
                    return { status: "echo", envelope: normalizeTripEnvelope(envelope), entry: clone(echo) };
                }
                try {
                    const applied = applyPlanOperation(envelope.document, remote.operation, {
                        currentRevision: Number(remote.revision) - 1,
                    });
                    envelope.document = applied.document;
                    envelope.remote.baseRevision = Number(remote.revision);
                    envelope.remote.hash = remote.hash || envelope.remote.hash;
                    envelope.syncState = entries.some((entry) => entry.status === "conflict")
                        ? "conflict" : entries.length ? "pending" : "synced";
                    await trips.put(envelope);
                    return {
                        status: applied.noOp ? "no-op" : "applied",
                        envelope: normalizeTripEnvelope(envelope),
                        targetKeys: clone(remote.targetKeys || applied.targetKeys),
                    };
                } catch (error) {
                    if (!(error instanceof PlanOperationError)) throw error;
                    return {
                        status: "overlap",
                        error: { code: error.code, target: error.target, details: error.details },
                        envelope: normalizeTripEnvelope(envelope),
                    };
                }
            });
        },
        hasLegacyOutbox: (tripId) => read(["outbox"], async ({ outbox }) => Boolean(await outbox.get(tripId))),
        async confirmMutation({ tripId, sent, revision, remoteHash, nextClientMutationId, archived }) {
            const value = await write(["trips", "outbox"], async ({ trips, outbox }) => {
                const envelope = await trips.get(tripId);
                if (!envelope) return { envelope: null, pending: false };
                const current = await outbox.get(tripId);
                const sameDocument = sent.type !== "document"
                    || (current?.document && canonicalPlanHash(current.document) === (sent.hash || canonicalPlanHash(sent.document)));
                const samePatch = JSON.stringify(current?.patch || null) === JSON.stringify(sent.patch || null);
                const acceptedCurrent = current?.clientMutationId === sent.clientMutationId && sameDocument && samePatch;
                envelope.remote.baseRevision = Number(revision);
                envelope.remote.hash = remoteHash || envelope.remote.hash;
                if (acceptedCurrent) {
                    if (sent.type === "document") envelope.document = sent.document;
                    if (typeof archived === "boolean") envelope.archived = archived;
                    envelope.syncState = "synced";
                    await outbox.delete(tripId);
                } else if (current) {
                    // The accepted id is now spent. A coalesced edit needs a new
                    // id and the confirmed revision as its next base.
                    current.baseRevision = Number(revision);
                    current.clientMutationId = nextClientMutationId;
                    await outbox.put(current);
                    envelope.syncState = "pending";
                }
                await trips.put(envelope);
                return { envelope, pending: Boolean(current && !acceptedCurrent) };
            });
            return { ...value, envelope: value.envelope ? normalizeTripEnvelope(value.envelope) : null };
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
