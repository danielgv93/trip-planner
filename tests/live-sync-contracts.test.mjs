import test from "node:test";
import assert from "node:assert/strict";

import {
    classifyCloudSaveResult,
    createSingleFlight,
    editorPreflightDecision,
    isVisuallyRemoteChange,
    reconciliationDecision,
    remoteVisualEffects,
    runExplicitCloudSave,
    streamEffectAllowed,
} from "../js/features/cloud/live-sync-contracts.js";
import { clearActiveEditor, preflightActiveEditor, registerActiveEditor } from "../js/features/planner/active-editor.js";
import { createMemoryStorage, createTripRepository } from "../js/core/trip-repository.js";
import { createTripEnvelope } from "../js/core/trip-envelope.js";

test("el preflight puro distingue none, committed, invalid y solo lectura", () => {
    assert.deepEqual(editorPreflightDecision(), { status: "none" });
    assert.deepEqual(editorPreflightDecision({ hasActiveEditor: true }), { status: "committed" });
    assert.deepEqual(editorPreflightDecision({ hasActiveEditor: true, valid: false }), { status: "invalid", reason: "validation" });
    assert.deepEqual(editorPreflightDecision({ readOnly: true, hasActiveEditor: true }), { status: "invalid", reason: "read-only" });
});

test("el registro del editor se limpia sin conservar estado de plan", async () => {
    clearActiveEditor();
    const unregister = registerActiveEditor(async () => ({ status: "committed", persistence: Promise.resolve("persistido") }));
    assert.equal((await preflightActiveEditor()).status, "committed");
    unregister();
    assert.deepEqual(await preflightActiveEditor(), { status: "none" });
});

test("Ctrl/Cmd+S aplica el editor antes de esperar el commit y sincronizar", async () => {
    const order = [];
    const result = await runExplicitCloudSave({
        preflight: async () => { order.push("editor"); return { status: "committed" }; },
        waitForCommit: async () => order.push("indexeddb"),
        synchronize: async () => { order.push("cloud"); return { confirmed: true }; },
    });
    assert.deepEqual(order, ["editor", "indexeddb", "cloud"]);
    assert.equal(result.synchronized, true);

    order.length = 0;
    const invalid = await runExplicitCloudSave({
        preflight: async () => ({ status: "invalid", reason: "validation" }),
        waitForCommit: async () => order.push("indexeddb"),
        synchronize: async () => order.push("cloud"),
    });
    assert.equal(invalid.synchronized, false);
    assert.deepEqual(order, []);
});

test("una parada abierta llega a la outbox antes de que Ctrl/Cmd+S confirme cloud", async () => {
    const repository = createTripRepository(createMemoryStorage());
    const envelope = createTripEnvelope({
        id: "local",
        remoteId: "remote",
        baseRevision: 1,
        syncState: "synced",
        document: { tripTitle: "Viaje", days: [{ id: "day", spots: [{ id: "spot", name: "Antes" }] }] },
    });
    await repository.putTrip(envelope);
    let undoSnapshots = 0;
    clearActiveEditor();
    const unregister = registerActiveEditor(async () => {
        undoSnapshots += 1;
        envelope.document.days[0].spots[0].name = "Editada en el formulario";
        await repository.commitTrip(envelope, {
            type: "document",
            clientMutationId: "mutation",
            baseRevision: 1,
            document: envelope.document,
        });
        return { status: "committed" };
    });
    try {
        const result = await runExplicitCloudSave({
            preflight: () => preflightActiveEditor(),
            waitForCommit: async () => {},
            synchronize: async () => ({ queuedName: (await repository.getOutbox("local")).document.days[0].spots[0].name }),
        });
        assert.equal(result.result.queuedName, "Editada en el formulario");
        assert.equal(undoSnapshots, 1);
    } finally {
        unregister();
    }
});

test("la reconciliación pura protege la outbox y evita repintados al día", () => {
    assert.equal(reconciliationDecision({ baseRevision: 4, remoteRevision: 4 }), "up-to-date");
    assert.equal(reconciliationDecision({ baseRevision: 4, remoteRevision: 5 }), "apply-remote");
    assert.equal(reconciliationDecision({ baseRevision: 4, remoteRevision: 5, hasOutbox: true }), "pending-local");
});

test("la generación e ids del stream bloquean respuestas tardías de otro viaje", () => {
    const current = { generation: 4, currentGeneration: 4, localId: "a", activeLocalId: "a", remoteId: "r-a", streamedRemoteId: "r-a" };
    assert.equal(streamEffectAllowed(current), true);
    assert.equal(streamEffectAllowed({ ...current, generation: 3 }), false);
    assert.equal(streamEffectAllowed({ ...current, activeLocalId: "b" }), false);
    assert.equal(streamEffectAllowed({ ...current, streamedRemoteId: "r-b" }), false);
    // Actor identity is deliberately absent: an event from another device of
    // the same account converges whenever its revision is newer.
    assert.equal(reconciliationDecision({ baseRevision: 6, remoteRevision: 7 }), "apply-remote");
    assert.equal(reconciliationDecision({ baseRevision: 7, remoteRevision: 7 }), "up-to-date");
});

test("la atribución visual omite cualquier cambio del usuario actual", () => {
    const currentUserId = "user-current";
    assert.equal(isVisuallyRemoteChange({
        effect: "no-op",
        actor: { userId: currentUserId, displayName: "Yo" },
    }, currentUserId), false, "una confirmación propia ya retirada de la outbox no se resalta");
    assert.equal(isVisuallyRemoteChange({
        effect: "applied",
        actor: { userId: currentUserId, displayName: "Yo" },
    }, currentUserId), false, "otra pestaña de la misma cuenta converge sin notificación visual");
    assert.equal(isVisuallyRemoteChange({
        effect: "applied",
        actor: { userId: "user-other", displayName: "Otra persona" },
    }, currentUserId), true);
    assert.equal(isVisuallyRemoteChange({
        effect: "echo",
        actor: { userId: "user-other", displayName: "Otra persona" },
    }, currentUserId), false);
});

test("un movimiento remoto conserva la atribución si el catch-up ya estaba al día o usó snapshot", () => {
    const payload = {
        revision: 8,
        actor: { userId: "user-other", displayName: "Otra persona" },
        targetKeys: ["day:day-a", "day:day-b", "spot:spot-a"],
    };
    for (const status of ["up-to-date", "snapshot"]) {
        assert.deepEqual(remoteVisualEffects({
            result: { status },
            payload,
            currentUserId: "user-current",
        }), [{ ...payload, effect: "applied" }]);
    }
    assert.deepEqual(remoteVisualEffects({
        result: { status: "up-to-date" },
        payload: { ...payload, actor: { userId: "user-current", displayName: "Yo" } },
        currentUserId: "user-current",
    }), []);
});

test("el resultado cloud distingue confirmación, no-op, pendiente, conflicto, red y autenticación", () => {
    assert.equal(classifyCloudSaveResult({ before: { baseRevision: 1, hasOutbox: true }, after: { baseRevision: 2 } }).status, "confirmed");
    assert.equal(classifyCloudSaveResult({ before: { baseRevision: 2 }, after: { baseRevision: 2 } }).status, "no-op");
    assert.equal(classifyCloudSaveResult({ after: { hasOutbox: true } }).status, "pending");
    assert.equal(classifyCloudSaveResult({ error: { status: 409 } }).status, "conflict");
    assert.equal(classifyCloudSaveResult({ error: { code: "NETWORK" } }).status, "network");
    assert.equal(classifyCloudSaveResult({ error: { status: 401 } }).status, "auth-required");
    for (const status of ["confirmed", "no-op", "pending", "conflict", "network", "auth-required"]) {
        const sample = status === "confirmed"
            ? classifyCloudSaveResult({ before: { baseRevision: 1, hasOutbox: true }, after: { baseRevision: 2 } })
            : status === "no-op"
              ? classifyCloudSaveResult({})
              : status === "pending"
                ? classifyCloudSaveResult({ after: { hasOutbox: true } })
                : classifyCloudSaveResult({ error: status === "conflict" ? { status: 409 } : status === "network" ? { code: "NETWORK" } : { status: 401 } });
        assert.match(sample.message, /[a-záéíóúñ]/i);
    }
});

test("dos guardados concurrentes esperan la misma ejecución", async () => {
    let calls = 0;
    let release;
    const flight = createSingleFlight(async () => {
        calls += 1;
        await new Promise((resolve) => { release = resolve; });
        return { processed: 1 };
    });
    const first = flight();
    const second = flight();
    await Promise.resolve();
    assert.equal(first, second);
    assert.equal(calls, 1);
    release();
    assert.deepEqual(await second, { processed: 1 });
});

test("dos Ctrl/Cmd+S comparten cloud y cada edición válida crea un solo snapshot", async () => {
    let undoSnapshots = 0;
    let cloudCalls = 0;
    let release;
    let entered;
    const cloudEntered = new Promise((resolve) => { entered = resolve; });
    const sharedCloud = createSingleFlight(async () => {
        cloudCalls += 1;
        entered();
        await new Promise((resolve) => { release = resolve; });
        return { status: "confirmed" };
    });
    const preflight = async () => {
        undoSnapshots += 1;
        return { status: "committed" };
    };
    const first = runExplicitCloudSave({ preflight, waitForCommit: async () => {}, synchronize: sharedCloud });
    const second = runExplicitCloudSave({ preflight: async () => ({ status: "none" }), waitForCommit: async () => {}, synchronize: sharedCloud });
    await cloudEntered;
    assert.equal(cloudCalls, 1);
    assert.equal(undoSnapshots, 1);
    release();
    await Promise.all([first, second]);
    assert.equal(undoSnapshots, 1, "el envío cloud no crea snapshots de undo");
});
