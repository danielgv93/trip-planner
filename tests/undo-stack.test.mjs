import test from "node:test";
import assert from "node:assert/strict";

import { createIntentUndoStack, createUndoStack, UNDO_LIMIT } from "../js/core/undo-stack.js";

function setup(initial = { value: 0, nested: { label: "inicio" } }) {
    let live = initial;
    const history = createUndoStack({
        capture: () => live,
        restore: (snapshot) => {
            live = snapshot;
        },
    });
    return {
        history,
        get live() {
            return live;
        },
        set live(value) {
            live = value;
        },
    };
}

test("undo y redo restauran snapshots profundos independientes", () => {
    const context = setup();
    context.history.pushUndo();
    context.live.value = 1;
    context.live.nested.label = "cambiado";

    assert.equal(context.history.undo(), true);
    assert.deepEqual(context.live, { value: 0, nested: { label: "inicio" } });
    assert.equal(context.history.redo(), true);
    assert.deepEqual(context.live, { value: 1, nested: { label: "cambiado" } });
});

test("una mutación nueva invalida redo", () => {
    const context = setup({ value: 0 });
    context.history.pushUndo();
    context.live.value = 1;
    context.history.undo();
    assert.equal(context.history.status().canRedo, true);

    context.history.pushUndo();
    context.live.value = 2;
    assert.equal(context.history.status().canRedo, false);
    assert.equal(context.history.redo(), false);
});

test("el historial descarta la entrada más antigua al superar el límite", () => {
    const context = setup({ value: 0 });
    for (let value = 1; value <= UNDO_LIMIT + 1; value += 1) {
        context.history.pushUndo();
        context.live.value = value;
    }

    assert.equal(context.history.status().undoCount, UNDO_LIMIT);
    for (let i = 0; i < UNDO_LIMIT; i += 1)
        assert.equal(context.history.undo(), true);
    assert.equal(context.live.value, 1);
    assert.equal(context.history.undo(), false);
});

test("el historial colaborativo aplica inversas como intenciones y limita a 20", async () => {
    const applied = [];
    const history = createIntentUndoStack({ apply: async (operation, direction) => applied.push({ operation, direction }) });
    for (let index = 0; index < 22; index += 1) {
        history.record({
            operation: { kind: "command", payload: { command: "update-fields", value: index } },
            inverse: { kind: "command", payload: { command: "update-fields", value: index - 1 } },
        });
    }
    assert.equal(history.status().undoCount, 20);
    await history.undo();
    assert.deepEqual(applied[0], {
        operation: { kind: "command", payload: { command: "update-fields", value: 20 } },
        direction: "undo",
    });
    await history.redo();
    assert.equal(applied[1].operation.payload.value, 21);
    assert.equal(applied[1].direction, "redo");
});

test("una inversa incompatible no se pierde ni entra por una operación remota", async () => {
    let reject = true;
    const history = createIntentUndoStack({
        apply: async () => {
            if (reject) throw new Error("INVERSE_CONFLICT");
        },
    });
    history.record({ operation: { kind: "local" }, inverse: { kind: "inverse" } });
    // Las operaciones remotas no llaman record(): el contador queda intacto.
    assert.equal(history.status().undoCount, 1);
    await assert.rejects(history.undo(), /INVERSE_CONFLICT/);
    assert.equal(history.status().undoCount, 1);
    reject = false;
    await history.undo();
    assert.equal(history.status().undoCount, 0);
    assert.equal(history.status().redoCount, 1);
});
