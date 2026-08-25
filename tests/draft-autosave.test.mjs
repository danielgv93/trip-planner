import test from "node:test";
import assert from "node:assert/strict";

import { createDraftAutosaveController } from "../js/shared/draft-autosave.js";

test("debounce coalesce escritura y change/blur fuerzan flush una sola vez", async () => {
    const root = new EventTarget();
    let draft = { value: "a" };
    const commits = [];
    const controller = createDraftAutosaveController({
        root,
        read: () => ({ ...draft }),
        commit: async (value, context) => commits.push({ value, reason: context.reason }),
        debounceMs: 10,
    });
    draft.value = "ab";
    root.dispatchEvent(new Event("input"));
    draft.value = "abc";
    root.dispatchEvent(new Event("input"));
    root.dispatchEvent(new Event("change"));
    await controller.settle();
    assert.deepEqual(commits, [{ value: { value: "abc" }, reason: "change" }]);
    root.dispatchEvent(new Event("focusout"));
    await controller.settle();
    assert.equal(commits.length, 1);
    controller.destroy();
});

test("un borrador inválido se conserva sin commit y puede recuperarse", async () => {
    const root = new EventTarget();
    let draft = { value: "válido" };
    const states = [];
    const commits = [];
    const controller = createDraftAutosaveController({
        root,
        read: () => ({ ...draft }),
        validate: (value) => value.value ? [] : ["REQUERIDO"],
        commit: async (value) => commits.push(value),
        onState: ({ state }) => states.push(state),
        debounceMs: 5,
    });
    draft.value = "";
    root.dispatchEvent(new Event("input"));
    assert.equal(controller.hasInvalidDraft(), true);
    assert.equal((await controller.flush("blur")).status, "invalid");
    assert.equal(commits.length, 0);
    draft.value = "recuperado";
    root.dispatchEvent(new Event("change"));
    await controller.settle();
    assert.deepEqual(commits, [{ value: "recuperado" }]);
    assert.ok(states.includes("invalid"));
});

test("read-only cancela antes del commit y destroy desmonta listeners", async () => {
    const root = new EventTarget();
    let draft = { value: "a" };
    let calls = 0;
    let readOnly = true;
    const controller = createDraftAutosaveController({
        root,
        read: () => ({ ...draft }),
        commit: async () => { calls += 1; },
        disabled: () => readOnly,
        debounceMs: 1,
    });
    draft.value = "b";
    assert.equal((await controller.flush()).status, "skipped");
    readOnly = false;
    controller.destroy();
    root.dispatchEvent(new Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls, 0);
});
