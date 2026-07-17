import test from "node:test";
import assert from "node:assert/strict";

import { createUndoStack, UNDO_LIMIT } from "../js/core/undo-stack.js";

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
