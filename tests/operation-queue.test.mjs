import test from "node:test";
import assert from "node:assert/strict";

import {
    coalesceQueuedOperation,
    createMemoryStorage,
    createTripRepository,
    TRIP_DATABASE_VERSION,
} from "../js/core/trip-repository.js";
import { createTripEnvelope } from "../js/core/trip-envelope.js";
import { applyPlanOperation } from "../js/core/plan-operations.js";
import { createOperationOutboxDrain } from "../js/features/cloud/operation-outbox.js";

function document(costA = 10, costB = 20) {
    return {
        tripTitle: "Cola",
        days: [{ id: "day", date: "2026-08-25", title: "Día", spots: [
            { id: "spot-a", name: "A", cost: costA },
            { id: "spot-b", name: "B", cost: costB },
        ] }],
    };
}

let counter = 0;
function scalar(spotId, from, to, baseRevision = 1) {
    counter += 1;
    return {
        protocolVersion: 1,
        clientMutationId: `50000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
        deviceId: "queue-device",
        baseRevision,
        kind: "set-field",
        target: { type: "spot", id: spotId, field: "cost" },
        precondition: { expectedValue: from },
        payload: { value: to },
    };
}

function entryFor(plan, operation) {
    const applied = applyPlanOperation(plan, operation);
    return { operation, inverse: applied.inverse, localValue: operation.payload.value };
}

function cloudEnvelope(id = "trip") {
    return createTripEnvelope({
        id,
        document: document(),
        remoteId: `remote-${id}`,
        baseRevision: 1,
        remoteHash: "hash-1",
        protocolVersion: 1,
        syncState: "synced",
    });
}

test("IndexedDB v2 conserva la outbox snapshot legacy antes de activar operaciones", async () => {
    assert.equal(TRIP_DATABASE_VERSION, 2);
    const storage = createMemoryStorage({ outbox: [{ tripId: "trip", type: "document", document: document() }] });
    const repository = createTripRepository(storage);
    await repository.putTrip(cloudEnvelope());
    assert.equal(await repository.hasLegacyOutbox("trip"), true);
    await assert.rejects(
        repository.commitOperation(cloudEnvelope(), entryFor(document(), scalar("spot-a", 10, 11))),
        /LEGACY_OUTBOX_PENDING/,
    );
    assert.equal((await repository.getOutbox("trip")).type, "document");
    assert.equal((await repository.listOperations("trip")).length, 0);
});

test("envelope y enqueue son atómicos, FIFO y con confirmación exacta", async () => {
    const repository = createTripRepository(createMemoryStorage());
    const envelope = cloudEnvelope();
    await repository.putTrip(envelope);
    const firstOp = scalar("spot-a", 10, 11);
    const firstPlan = applyPlanOperation(envelope.document, firstOp).document;
    envelope.document = firstPlan;
    const first = await repository.commitOperation(envelope, entryFor(document(), firstOp));
    assert.equal(first.entry.localSequence, 1);
    assert.equal((await repository.getTrip("trip")).document.days[0].spots[0].cost, 11);

    const secondOp = scalar("spot-b", 20, 21);
    envelope.document = applyPlanOperation(firstPlan, secondOp).document;
    const second = await repository.commitOperation(envelope, entryFor(firstPlan, secondOp));
    assert.equal(second.entry.localSequence, 2);
    assert.deepEqual((await repository.listOperations("trip")).map((item) => item.localSequence), [1, 2]);
    const claimed = await repository.claimNextOperation("trip");
    assert.equal(claimed.localSequence, 1);
    assert.equal(await repository.claimNextOperation("trip"), null);
    assert.equal((await repository.confirmOperation({
        tripId: "trip", localSequence: 1, clientMutationId: "incorrecto", revision: 2, remoteHash: "hash-2",
    })).confirmed, false);
    const confirmed = await repository.confirmOperation({
        tripId: "trip", localSequence: 1, clientMutationId: firstOp.clientMutationId, revision: 2, remoteHash: "hash-2",
    });
    assert.equal(confirmed.confirmed, true);
    assert.equal(confirmed.pending, true);
    assert.equal((await repository.getTrip("trip")).remote.baseRevision, 2);
    assert.equal((await repository.claimNextOperation("trip")).localSequence, 2);
});

test("solo coalesce escalares no enviados conservando primera precondición e inversa", async () => {
    const repository = createTripRepository(createMemoryStorage());
    const envelope = cloudEnvelope();
    await repository.putTrip(envelope);
    const firstOp = scalar("spot-a", 10, 11);
    const firstApplied = applyPlanOperation(envelope.document, firstOp);
    envelope.document = firstApplied.document;
    await repository.commitOperation(envelope, { operation: firstOp, inverse: firstApplied.inverse, localValue: 11 });

    const secondOp = scalar("spot-a", 11, 12);
    const secondApplied = applyPlanOperation(envelope.document, secondOp);
    envelope.document = secondApplied.document;
    const merged = await repository.commitOperation(envelope, { operation: secondOp, inverse: secondApplied.inverse, localValue: 12 });
    assert.equal(merged.coalesced, true);
    const [queued] = await repository.listOperations("trip");
    assert.equal(queued.operation.clientMutationId, firstOp.clientMutationId);
    assert.deepEqual(queued.operation.precondition, { expectedValue: 10 });
    assert.deepEqual(queued.operation.payload, { value: 12 });
    assert.deepEqual(queued.inverse.precondition, { expectedValue: 12 });
    assert.deepEqual(queued.inverse.payload, { value: 10 });

    await repository.claimNextOperation("trip");
    const thirdOp = scalar("spot-a", 12, 13);
    envelope.document = applyPlanOperation(envelope.document, thirdOp).document;
    const separate = await repository.commitOperation(envelope, entryFor(merged.envelope.document, thirdOp));
    assert.equal(separate.coalesced, false);
    assert.equal(separate.entry.localSequence, 2);
});

test("reintento y conflicto conservan la operación y su valor local tras reload", async () => {
    const storage = createMemoryStorage();
    const repository = createTripRepository(storage);
    const envelope = cloudEnvelope();
    await repository.putTrip(envelope);
    const op = scalar("spot-a", 10, 15);
    envelope.document = applyPlanOperation(envelope.document, op).document;
    await repository.commitOperation(envelope, entryFor(document(), op));
    await repository.claimNextOperation("trip");
    assert.equal((await repository.retryOperation("trip", 1)).status, "queued");
    await repository.markOperationConflict({
        tripId: "trip",
        localSequence: 1,
        conflict: { code: "TARGET_CONFLICT", currentValue: 14, remoteRevision: 2 },
    });
    const reloaded = createTripRepository(storage);
    const stored = await reloaded.getOperation("trip", 1);
    assert.equal(stored.status, "conflict");
    assert.equal(stored.localValue, 15);
    assert.equal(stored.conflict.currentValue, 14);
    assert.equal((await reloaded.getTrip("trip")).syncState, "conflict");
});

test("replay sobre snapshot aplica independientes y localiza solo incompatibles", async () => {
    const repository = createTripRepository(createMemoryStorage());
    const envelope = cloudEnvelope();
    await repository.putTrip(envelope);
    const firstOp = scalar("spot-a", 10, 15);
    envelope.document = applyPlanOperation(envelope.document, firstOp).document;
    await repository.commitOperation(envelope, entryFor(document(), firstOp));
    const secondOp = scalar("spot-b", 20, 25);
    const beforeSecond = envelope.document;
    envelope.document = applyPlanOperation(envelope.document, secondOp).document;
    await repository.commitOperation(envelope, entryFor(beforeSecond, secondOp));

    const rebased = await repository.rebaseOperations({
        tripId: "trip",
        remoteDocument: document(14, 20),
        revision: 2,
        remoteHash: "remote-2",
    });
    assert.equal(rebased.conflicts.length, 1);
    assert.equal(rebased.pending, 1);
    assert.deepEqual(rebased.envelope.document.days[0].spots.map((spot) => spot.cost), [14, 25]);
    assert.deepEqual((await repository.listOperations("trip")).map((item) => item.status), ["conflict", "queued"]);
});

test("un fallo de IndexedDB revierte envelope y enqueue sin pérdida parcial", async () => {
    const base = createMemoryStorage();
    const reliable = createTripRepository(base);
    await reliable.putTrip(cloudEnvelope());
    const failing = {
        transaction(names, mode, callback) {
            return base.transaction(names, mode, (stores) => callback({
                ...stores,
                operations: stores.operations && {
                    ...stores.operations,
                    put: async () => { throw new Error("DISK_FULL"); },
                },
            }));
        },
        close: () => base.close(),
    };
    const repository = createTripRepository(failing);
    const changed = cloudEnvelope();
    changed.document = document(15, 20);
    await assert.rejects(
        repository.commitOperation(changed, entryFor(document(), scalar("spot-a", 10, 15))),
        /DISK_FULL/,
    );
    assert.equal((await reliable.getTrip("trip")).document.days[0].spots[0].cost, 10);
    assert.equal((await reliable.listOperations("trip")).length, 0);
});

test("el drain es FIFO por viaje, single-flight y paralelo entre viajes", async () => {
    const repository = createTripRepository(createMemoryStorage());
    async function seed(tripId) {
        const envelope = cloudEnvelope(tripId);
        await repository.putTrip(envelope);
        const first = scalar("spot-a", 10, 11);
        const firstApplied = applyPlanOperation(envelope.document, first);
        envelope.document = firstApplied.document;
        await repository.commitOperation(envelope, { operation: first, inverse: firstApplied.inverse });
        const second = scalar("spot-b", 20, 21);
        const secondApplied = applyPlanOperation(envelope.document, second);
        envelope.document = secondApplied.document;
        await repository.commitOperation(envelope, { operation: second, inverse: secondApplied.inverse });
    }
    await seed("a");
    await seed("b");
    const calls = [];
    const activeTrips = new Set();
    let parallel = false;
    const drain = createOperationOutboxDrain({
        repository,
        publish: async (entry) => {
            calls.push(`${entry.tripId}:${entry.localSequence}`);
            activeTrips.add(entry.tripId);
            if (activeTrips.size > 1) parallel = true;
            await new Promise((resolve) => setTimeout(resolve, 5));
            activeTrips.delete(entry.tripId);
            return { status: "accepted", revision: entry.localSequence + 1, hash: `hash-${entry.localSequence + 1}` };
        },
    });
    const firstFlight = drain.drainTrip("a");
    assert.equal(drain.drainTrip("a"), firstFlight);
    const all = drain.drainAll();
    await Promise.all([firstFlight, all]);
    assert.equal(parallel, true);
    assert.deepEqual(calls.filter((call) => call.startsWith("a:")), ["a:1", "a:2"]);
    assert.deepEqual(calls.filter((call) => call.startsWith("b:")), ["b:1", "b:2"]);
    assert.equal((await repository.listOperations()).length, 0);
});

test("offline reintenta y una confirmación perdida se recupera con el mismo id", async () => {
    const repository = createTripRepository(createMemoryStorage());
    const envelope = cloudEnvelope();
    await repository.putTrip(envelope);
    const op = scalar("spot-a", 10, 11);
    const applied = applyPlanOperation(envelope.document, op);
    envelope.document = applied.document;
    await repository.commitOperation(envelope, { operation: op, inverse: applied.inverse });
    const offlineDrain = createOperationOutboxDrain({
        repository,
        publish: async () => { throw Object.assign(new Error("offline"), { code: "NETWORK", retryable: true }); },
    });
    const [offline] = await offlineDrain.drainAll();
    assert.equal(offline.pending, 1);
    assert.equal((await repository.getOperation("trip", 1)).status, "queued");

    await repository.claimNextOperation("trip");
    assert.equal(await repository.claimNextOperation("trip"), null);
    assert.equal(await repository.recoverSendingOperations("trip"), 1);
    let retriedId = null;
    const recoveredDrain = createOperationOutboxDrain({
        repository,
        publish: async (entry) => {
            retriedId = entry.operation.clientMutationId;
            return { status: "accepted", revision: 2, hash: "hash-2", idempotent: true };
        },
    });
    await recoveredDrain.drainAll();
    assert.equal(retriedId, op.clientMutationId);
    assert.equal((await repository.listOperations("trip")).length, 0);
});

test("una operación remota independiente se aplica sobre el documento optimista y el eco confirma", async () => {
    const repository = createTripRepository(createMemoryStorage());
    const envelope = cloudEnvelope();
    await repository.putTrip(envelope);
    const local = scalar("spot-a", 10, 15);
    const localApplied = applyPlanOperation(envelope.document, local);
    envelope.document = localApplied.document;
    await repository.commitOperation(envelope, { operation: local, inverse: localApplied.inverse });

    const remote = scalar("spot-b", 20, 25, 1);
    const applied = await repository.applyRemoteOperation({
        tripId: "trip",
        remote: { revision: 2, hash: "hash-2", operation: remote, targetKeys: ["spot:spot-b:cost"] },
    });
    assert.equal(applied.status, "applied");
    assert.deepEqual(applied.envelope.document.days[0].spots.map((spot) => spot.cost), [15, 25]);
    assert.equal((await repository.listOperations("trip")).length, 1);

    const echo = await repository.applyRemoteOperation({
        tripId: "trip",
        remote: { revision: 3, hash: "hash-3", operation: local, targetKeys: ["spot:spot-a:cost"] },
    });
    assert.equal(echo.status, "echo");
    assert.equal((await repository.listOperations("trip")).length, 0);
    assert.equal((await repository.getTrip("trip")).syncState, "synced");
});

test("el helper de coalescencia rechaza estructura, target distinto y sending", () => {
    const first = scalar("spot-a", 10, 11);
    const queued = { status: "queued", operation: first };
    assert.equal(coalesceQueuedOperation({ ...queued, status: "sending" }, { operation: scalar("spot-a", 11, 12) }), null);
    assert.equal(coalesceQueuedOperation(queued, { operation: scalar("spot-b", 20, 21) }), null);
});
