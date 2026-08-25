import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryStorage, createTripRepository } from "../js/core/trip-repository.js";
import { createTripEnvelope } from "../js/core/trip-envelope.js";
import { applyPlanOperation } from "../js/core/plan-operations.js";
import { createIncrementalTripSync } from "../js/features/cloud/incremental-sync.js";

const baseDocument = () => ({
    tripTitle: "Viaje",
    days: [{ id: "day", date: "2026-08-25", title: "Día", spots: [
        { id: "a", name: "A", cost: 10 }, { id: "b", name: "B", cost: 20 },
    ] }],
});

let counter = 0;
function scalar(id, from, to, revision) {
    counter += 1;
    return {
        revision,
        hash: `hash-${revision}`,
        actor: { userId: `remote-${revision}`, displayName: `Colaborador ${revision}` },
        targetKeys: [`spot:${id}:cost`],
        operation: {
            protocolVersion: 1,
            clientMutationId: `70000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
            deviceId: "remote-device",
            baseRevision: revision - 1,
            kind: "set-field",
            target: { type: "spot", id, field: "cost" },
            precondition: { expectedValue: from },
            payload: { value: to },
        },
    };
}

async function repositoryWithEnvelope() {
    const repository = createTripRepository(createMemoryStorage());
    await repository.putTrip(createTripEnvelope({
        id: "local", document: baseDocument(), remoteId: "remote", baseRevision: 1,
        remoteHash: "hash-1", protocolVersion: 1, syncState: "synced",
    }));
    return repository;
}

test("catch-up aplica una ráfaga en orden y notifica un único lote", async () => {
    const repository = await repositoryWithEnvelope();
    const operations = [scalar("a", 10, 11, 2), scalar("b", 20, 21, 3)];
    const notifications = [];
    const sync = createIncrementalTripSync({
        repository,
        client: { catchUpTripOperations: async () => ({ currentRevision: 3, hasMore: false, snapshotRequired: false, operations }) },
        onEnvelope: async (envelope, detail) => notifications.push({ envelope, detail }),
    });
    const [first, second] = await Promise.all([sync.sync("local", 2), sync.sync("local", 3)]);
    assert.equal(first.status, "applied");
    assert.equal(second.revision, 3);
    assert.equal(notifications.length, 1);
    assert.deepEqual(notifications[0].envelope.document.days[0].spots.map((spot) => spot.cost), [11, 21]);
    assert.deepEqual(notifications[0].envelope.remote.lastModifiedBy, {
        userId: "remote-3",
        displayName: "Colaborador 3",
    });
});

test("un solape pide snapshot y reproduce la outbox conservando solo conflictos locales", async () => {
    const repository = await repositoryWithEnvelope();
    const envelope = await repository.getTrip("local");
    const localRemote = scalar("a", 10, 15, 2).operation;
    localRemote.deviceId = "local-device";
    const applied = applyPlanOperation(envelope.document, localRemote);
    envelope.document = applied.document;
    await repository.commitOperation(envelope, { operation: localRemote, inverse: applied.inverse, localValue: 15 });
    const serverRemote = scalar("a", 10, 14, 2);
    const snapshots = [];
    const sync = createIncrementalTripSync({
        repository,
        client: {
            catchUpTripOperations: async () => ({ currentRevision: 2, snapshotRequired: false, hasMore: false, operations: [serverRemote] }),
            getTrip: async () => ({ trip: {
                id: "remote",
                document: applyPlanOperation(baseDocument(), serverRemote.operation).document,
                current_revision: 2,
                document_hash: "hash-2",
                last_modified_by: serverRemote.actor,
            } }),
        },
        onEnvelope: async (next, detail) => snapshots.push({ next, detail }),
    });
    const result = await sync.sync("local", 2);
    assert.equal(result.status, "snapshot");
    assert.equal(result.conflicts.length, 1);
    assert.equal(snapshots[0].next.document.days[0].spots[0].cost, 14);
    assert.deepEqual(snapshots[0].next.remote.lastModifiedBy, serverRemote.actor);
});

test("un hueco o revisión legacy usa directamente el snapshot indicado por el servidor", async () => {
    const repository = await repositoryWithEnvelope();
    const remoteDocument = baseDocument();
    remoteDocument.tripTitle = "Snapshot recuperado";
    const notifications = [];
    const sync = createIncrementalTripSync({
        repository,
        client: {
            catchUpTripOperations: async () => ({ currentRevision: 8, snapshotRequired: true, operations: [] }),
            getTrip: async () => ({ trip: { id: "remote", document: remoteDocument, current_revision: 8, document_hash: "hash-8" } }),
        },
        onEnvelope: async (envelope, detail) => notifications.push({ envelope, detail }),
    });
    const result = await sync.sync("local", 8);
    assert.equal(result.status, "snapshot");
    assert.equal((await repository.getTrip("local")).document.tripTitle, "Snapshot recuperado");
    assert.equal(notifications[0].detail.reason, "server-required");
});
