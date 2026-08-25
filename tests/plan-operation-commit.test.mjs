import test from "node:test";
import assert from "node:assert/strict";

const localValues = new Map();
globalThis.localStorage = {
    getItem: (key) => localValues.get(key) ?? null,
    setItem: (key, value) => localValues.set(key, String(value)),
};
const emitted = [];
globalThis.CustomEvent = class CustomEvent {
    constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
    }
};
globalThis.document = { dispatchEvent: (event) => emitted.push(event) };

const { normalizePortablePlan, portablePlanFrom } = await import("../js/core/portable-plan.js");
const { createMemoryStorage, createTripRepository } = await import("../js/core/trip-repository.js");
const { createTripEnvelope } = await import("../js/core/trip-envelope.js");
const {
    acceptPortablePlanCheckpoint,
    applyPortablePlanState,
    configureMutationInstrumentation,
    save,
    store,
} = await import("../js/core/store.js");
const {
    commitPlanOperation,
    configurePlanOperationCommit,
    derivedPlanOperation,
    setFieldIntent,
    waitForPlanOperationCommits,
} = await import("../js/core/plan-operation-commit.js");

function plan(title = "Origen") {
    return normalizePortablePlan({
        tripTitle: title,
        days: [{ id: "day", date: "2026-08-25", title: "Día", spots: [] }],
    });
}

async function prepare({ cloud = false, protocolVersion = 0, actor = null } = {}) {
    const repository = createTripRepository(createMemoryStorage());
    const envelope = createTripEnvelope({
        id: "trip",
        document: plan(),
        remoteId: cloud ? "remote-trip" : null,
        baseRevision: cloud ? 3 : null,
        remoteHash: cloud ? "hash-3" : null,
        protocolVersion,
        syncState: cloud ? "synced" : "local",
    });
    await repository.putTrip(envelope);
    applyPortablePlanState(envelope.document);
    store.activeTripId = envelope.id;
    store.readOnly = false;
    store.accountSession = actor ? { user: actor } : null;
    acceptPortablePlanCheckpoint();
    configureMutationInstrumentation("production");
    const calls = { undo: 0, repaint: 0, refresh: 0, drain: [] };
    configurePlanOperationCommit({
        getRepository: () => repository,
        getDeviceId: () => "device-boundary",
        recordUndo: () => { calls.undo += 1; },
        repaint: () => { calls.repaint += 1; },
        refreshLibrary: async () => { calls.refresh += 1; },
        scheduleDrain: (value) => calls.drain.push(value),
    });
    emitted.length = 0;
    return { repository, calls };
}

const titleTarget = { type: "plan", id: "plan", field: "tripTitle" };

test("el límite local aplica y guarda sin crear ninguna entrada cloud", async () => {
    const { repository, calls } = await prepare();
    const sharedStore = store;
    const result = await derivedPlanOperation((document) => setFieldIntent(document, titleTarget, "Local"));
    assert.equal(result.mode, "local");
    assert.equal(store, sharedStore);
    assert.equal(store.tripTitle, "Local");
    assert.equal((await repository.getTrip("trip")).document.tripTitle, "Local");
    assert.equal((await repository.listOperations("trip")).length, 0);
    assert.equal(await repository.getOutbox("trip"), undefined);
    assert.deepEqual(calls, { undo: 1, repaint: 1, refresh: 1, drain: [] });
    assert.equal(JSON.parse(localValues.get("trip-planner")).tripTitle, "Local");
});

test("el límite cloud encola granularmente y programa el drain", async () => {
    const { repository, calls } = await prepare({ cloud: true, protocolVersion: 1 });
    const result = await derivedPlanOperation((document) => setFieldIntent(document, titleTarget, "Compartido"));
    assert.equal(result.mode, "granular");
    const [entry] = await repository.listOperations("trip");
    assert.equal(entry.operation.kind, "set-field");
    assert.deepEqual(entry.operation.precondition, { expectedValue: "Origen" });
    assert.deepEqual(calls.drain, [{ tripId: "trip", mode: "granular" }]);
    assert.equal((await repository.getTrip("trip")).syncState, "pending");
});

test("una edición cloud conserva quién hizo la última modificación", async () => {
    const actor = { id: "user-1", displayName: "Ana" };
    const { repository } = await prepare({ cloud: true, protocolVersion: 1, actor });
    await derivedPlanOperation((document) => setFieldIntent(document, titleTarget, "Atribuido"));
    assert.deepEqual((await repository.getTrip("trip")).remote.lastModifiedBy, {
        userId: "user-1",
        displayName: "Ana",
    });
});

test("un viaje cloud legacy conserva el fallback snapshot temporal", async () => {
    const { repository, calls } = await prepare({ cloud: true, protocolVersion: 0 });
    const result = await derivedPlanOperation((document) => setFieldIntent(document, titleTarget, "Legacy"));
    assert.equal(result.mode, "snapshot");
    assert.equal((await repository.listOperations("trip")).length, 0);
    assert.equal((await repository.getOutbox("trip")).document.tripTitle, "Legacy");
    assert.deepEqual(calls.drain, [{ tripId: "trip", mode: "snapshot" }]);
});

test("las intenciones rápidas se serializan y leen el store optimista más reciente", async () => {
    const { repository } = await prepare({ cloud: true, protocolVersion: 1 });
    const first = derivedPlanOperation((document) => setFieldIntent(document, titleTarget, "Primero"));
    const second = derivedPlanOperation((document) => {
        assert.equal(document.tripTitle, "Primero");
        return setFieldIntent(document, titleTarget, "Segundo");
    });
    await Promise.all([first, second]);
    await waitForPlanOperationCommits();
    assert.equal(store.tripTitle, "Segundo");
    const [coalesced] = await repository.listOperations("trip");
    assert.equal(coalesced.operation.payload.value, "Segundo");
    assert.deepEqual(coalesced.operation.precondition, { expectedValue: "Origen" });
});

test("read-only se corta antes de memoria, almacenamiento, repositorio o ids", async () => {
    const { repository, calls } = await prepare({ cloud: true, protocolVersion: 1 });
    store.readOnly = true;
    const beforeStorage = localValues.get("trip-planner");
    configurePlanOperationCommit({
        getRepository: () => { throw new Error("no debe leer IndexedDB"); },
        getDeviceId: () => { throw new Error("no debe crear device id"); },
    });
    const result = await commitPlanOperation({
        kind: "set-field",
        target: titleTarget,
        precondition: { expectedValue: "Origen" },
        payload: { value: "Bloqueado" },
    });
    assert.deepEqual(result, { skipped: "read-only" });
    assert.equal(store.tripTitle, "Origen");
    assert.equal(localValues.get("trip-planner"), beforeStorage);
    assert.equal((await repository.listOperations("trip")).length, 0);
    assert.deepEqual(calls, { undo: 0, repaint: 0, refresh: 0, drain: [] });
    store.readOnly = false;
});

test("save detecta una escritura portable directa en modo test", async () => {
    await prepare();
    configureMutationInstrumentation("test");
    store.tripTitle = "Fuera del límite";
    assert.throws(() => save(), { code: "UNINSTRUMENTED_PLAN_MUTATION" });
    applyPortablePlanState(plan());
    acceptPortablePlanCheckpoint();
    configureMutationInstrumentation("production");
});
