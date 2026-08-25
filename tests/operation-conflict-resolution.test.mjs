import test from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.document = { dispatchEvent: () => {} };
globalThis.CustomEvent = class CustomEvent {};

const {
    canCombineConflict,
    canRecreateConflict,
    conflictResolutionIntent,
} = await import("../js/features/cloud/operation-conflict-resolution.js");

function plan() {
    return {
        tripTitle: "Viaje",
        days: [{ id: "day-a", date: "2026-08-25", title: "Día", spots: [
            { id: "spot-a", name: "Remoto", note: "Texto remoto" },
            { id: "spot-b", name: "B" },
        ] }],
        backlog: [], backlogGroups: [], tags: [], categories: [], tripNotePages: [],
        travelLegs: {}, reminders: [],
    };
}

function fieldConflict() {
    return {
        operation: {
            kind: "set-field",
            target: { type: "spot", id: "spot-a", field: "note" },
            precondition: { expectedValue: "Anterior" },
            payload: { value: "Texto local" },
        },
        localValue: { value: "Texto local", entity: { id: "spot-a", name: "Local", note: "Texto local" } },
        conflict: { code: "TARGET_CONFLICT", currentValue: "Texto remoto", currentRevision: 8 },
    };
}

test("resolver un campo recalcula la precondición y combinar conserva ambos textos", () => {
    const entry = fieldConflict();
    assert.equal(canCombineConflict(entry), true);
    const local = conflictResolutionIntent(plan(), entry, "local");
    assert.deepEqual(local.precondition, { expectedValue: "Texto remoto" });
    assert.deepEqual(local.payload, { value: "Texto local" });
    const combined = conflictResolutionIntent(plan(), entry, "combine", { mergedValue: "Remoto + local" });
    assert.deepEqual(combined.payload, { value: "Remoto + local" });
});

test("un movimiento concurrente se reintenta desde la posición vigente", () => {
    const entry = {
        operation: {
            kind: "move-entity",
            target: { type: "spot", id: "spot-a" },
            payload: { containerId: "backlog", beforeId: null },
        },
        conflict: { code: "MOVE_CONFLICT", currentLocation: { containerId: "day-a", beforeId: "spot-b" } },
    };
    const retry = conflictResolutionIntent(plan(), entry, "local");
    assert.deepEqual(retry.precondition.expectedLocation, { containerId: "day-a", beforeId: "spot-b" });
    assert.equal(retry.payload.containerId, "backlog");
});

test("edit-vs-delete solo recrea bajo decisión explícita y con id nuevo", () => {
    const entry = fieldConflict();
    entry.conflict = { code: "ENTITY_DELETED", currentRevision: 9 };
    entry.localValue.location = { containerId: "day-a", beforeId: "missing-anchor" };
    assert.equal(canRecreateConflict(entry), true);
    const recreated = conflictResolutionIntent(plan(), entry, "recreate", {
        createId: () => "spot-copy",
    });
    assert.equal(recreated.kind, "insert-entity");
    assert.equal(recreated.target.id, "spot-copy");
    assert.equal(recreated.payload.entity.id, "spot-copy");
    assert.equal(recreated.payload.beforeId, null);
});
