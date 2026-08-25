import test from "node:test";
import assert from "node:assert/strict";

import {
    applyPlanOperation,
    deriveTargetKeys,
    PlanOperationError,
    targetFingerprint,
    validatePlanOperation,
    valueFingerprint,
} from "../js/core/plan-operations.js";

function plan() {
    return {
        tripTitle: "Compartido",
        localCurrency: "EUR",
        foreignCurrency: "JPY",
        exchangeRate: 0.006,
        exchangeRateDate: "2026-08-25",
        tripNotePages: [{ id: "note-1", title: "General", content: "Texto" }],
        days: [
            {
                id: "day-1",
                date: "2026-08-25",
                title: "Primero",
                startTime: "09:00",
                spots: [
                    { id: "spot-first", name: "Inicio", tags: ["arte"], positionConstraint: "first", mapEnabled: true },
                    { id: "spot-a", name: "Museo", tags: ["arte"], cost: 12, visitMinutes: 60, openingTime: "10:00", mapEnabled: false },
                    { id: "spot-b", name: "Cena", tags: ["comida"], cost: 20, mapEnabled: true },
                    { id: "spot-last", name: "Hotel", tags: [], positionConstraint: "last", mapEnabled: true },
                ],
            },
            { id: "day-2", date: "2026-08-26", title: "Segundo", spots: [] },
        ],
        backlog: [{ id: "spot-idea", name: "Idea", tags: [], backlogGroupId: "group-1", mapEnabled: true }],
        backlogGroups: [{ id: "group-1", title: "Quizá", collapsed: false }],
        tags: ["arte", "comida"],
        categories: [
            { id: "culture", label: "Cultura", color: "#123456", connects: true },
            { id: "food", label: "Comida", color: "#654321", connects: true },
        ],
        routeProfile: "walking",
        routeVisualization: "streets",
        travelLegs: {
            "spot-a>spot-b": { mode: "walking" },
            "spot-first>spot-a": { mode: "train", embeddedEndpoints: ["from", "to"] },
        },
        reminders: [
            { id: "reminder-spot", title: "Reserva", spotId: "spot-a", timing: { type: "offset", amount: 1, unit: "days", anchor: { type: "spot" } } },
            { id: "reminder-fixed", title: "Seguro", timing: { type: "fixed", date: "2026-08-20" } },
        ],
    };
}

let mutationCounter = 0;
function operation(kind, target, { precondition = {}, payload = {}, baseRevision = 4 } = {}) {
    mutationCounter += 1;
    return {
        protocolVersion: 1,
        clientMutationId: `10000000-0000-4000-8000-${String(mutationCounter).padStart(12, "0")}`,
        deviceId: "device-test",
        baseRevision,
        kind,
        target,
        precondition,
        payload,
    };
}

function errorCode(code) {
    return (error) => error instanceof PlanOperationError && error.code === code;
}

test("valida el sobre, la allowlist y deriva target keys sin valores", () => {
    const op = operation("set-field", { type: "spot", id: "spot-a", field: "cost" }, {
        precondition: { expectedValue: 12 }, payload: { value: 18 },
    });
    assert.equal(validatePlanOperation(op).kind, "set-field");
    assert.deepEqual(deriveTargetKeys(op, plan()), ["day:day-1", "spot:spot-a", "spot:spot-a:cost"]);
    assert.throws(() => validatePlanOperation({ ...op, protocolVersion: 99 }), errorCode("UNSUPPORTED_OPERATION_VERSION"));
    assert.throws(() => validatePlanOperation({ ...op, target: { ...op.target, field: "__proto__" } }), errorCode("INVALID_OPERATION"));
});

test("aplica escalares con precondición, conflicto, no-op e inversa", () => {
    const original = plan();
    const op = operation("set-field", { type: "spot", id: "spot-a", field: "cost" }, {
        precondition: { expectedValue: 12 }, payload: { value: 18 },
    });
    const changed = applyPlanOperation(original, op);
    assert.equal(changed.document.days[0].spots[1].cost, 18);
    assert.equal(changed.noOp, false);
    const restored = applyPlanOperation(changed.document, changed.inverse);
    assert.equal(restored.document.days[0].spots[1].cost, 12);
    assert.deepEqual(restored.document, applyPlanOperation(original, operation("replace-plan", { type: "plan", id: "plan" }, {
        precondition: { expectedRevision: 4 }, payload: { document: original },
    }), { currentRevision: 4 }).document);
    assert.equal(applyPlanOperation(changed.document, op).noOp, true);
    assert.throws(
        () => applyPlanOperation({ ...original, days: original.days.map((day, index) => index ? day : { ...day, spots: day.spots.map((spot) => spot.id === "spot-a" ? { ...spot, cost: 14 } : spot) }) }, op),
        errorCode("TARGET_CONFLICT"),
    );
});

test("inserta por id estable y detecta ausencia, duplicado y edición concurrente al borrar", () => {
    const insertedSpot = { id: "spot-new", name: "Nueva", tags: [], plannedStart: "11:00" };
    const insert = operation("insert-entity", { type: "spot", id: insertedSpot.id }, {
        precondition: { absent: true },
        payload: { entity: insertedSpot, containerId: "day-2", beforeId: null },
    });
    const added = applyPlanOperation(plan(), insert);
    assert.equal(added.document.days[1].spots[0].id, "spot-new");
    assert.equal(applyPlanOperation(added.document, insert).noOp, true);
    assert.throws(
        () => applyPlanOperation({ ...plan(), backlog: [...plan().backlog, { id: "spot-new", name: "Otra", tags: [] }] }, insert),
        errorCode("DUPLICATE_ENTITY"),
    );

    const note = plan().tripNotePages[0];
    const remove = operation("delete-entity", { type: "note-page", id: note.id }, {
        precondition: { expectedFingerprint: valueFingerprint(note) },
    });
    const deleted = applyPlanOperation(plan(), remove);
    assert.equal(deleted.document.tripNotePages.some((page) => page.id === note.id), false);
    assert.equal(applyPlanOperation(deleted.document, remove).noOp, true);
    const edited = plan();
    edited.tripNotePages[0].content = "Cambio remoto";
    assert.throws(() => applyPlanOperation(edited, remove), errorCode("TARGET_CONFLICT"));
});

test("mueve días y spots por contenedor/beforeId preservando grupos y constraints", () => {
    const moveDay = operation("move-entity", { type: "day", id: "day-2" }, {
        precondition: { expectedLocation: { containerId: "days", beforeId: null } },
        payload: { containerId: "days", beforeId: "day-1" },
    });
    assert.deepEqual(applyPlanOperation(plan(), moveDay).document.days.map((day) => day.id), ["day-2", "day-1"]);

    const moveIdea = operation("move-entity", { type: "spot", id: "spot-idea" }, {
        precondition: { expectedLocation: { containerId: "backlog", beforeId: null } },
        payload: { containerId: "day-2", beforeId: null },
    });
    const moved = applyPlanOperation(plan(), moveIdea);
    assert.equal(moved.document.days[1].spots[0].id, "spot-idea");
    assert.equal("backlogGroupId" in moved.document.days[1].spots[0], false);
    assert.deepEqual(moved.targetKeys, ["backlog-group:group-1", "backlog:all", "day:day-2", "spot:spot-idea"]);

    const violateFirst = operation("move-entity", { type: "spot", id: "spot-first" }, {
        precondition: { expectedLocation: { containerId: "day-1", beforeId: "spot-a" } },
        payload: { containerId: "day-1", beforeId: "spot-last" },
    });
    assert.throws(() => applyPlanOperation(plan(), violateFirst), errorCode("CONSTRAINT_VIOLATION"));
});

test("mueve una travel card con extremos embebidos de forma atómica", () => {
    const op = operation("command", { type: "travel-leg", id: "spot-first>spot-a" }, {
        precondition: { expectedContainerId: "day-1" },
        payload: { command: "move-travel-card", containerId: "day-2", beforeId: null },
    });
    const moved = applyPlanOperation(plan(), op);
    assert.deepEqual(moved.document.days[1].spots.map((spot) => spot.id), ["spot-first", "spot-a"]);
    assert.deepEqual(moved.document.days[0].spots.map((spot) => spot.id), ["spot-b", "spot-last"]);
});

test("los comandos compuestos conservan invariantes cruzadas", () => {
    const original = plan();
    const deleteSpot = operation("command", { type: "spot", id: "spot-a" }, {
        precondition: { expectedFingerprint: targetFingerprint(original, { type: "spot", id: "spot-a" }) },
        payload: { command: "delete-spot" },
    });
    const withoutSpot = applyPlanOperation(original, deleteSpot).document;
    assert.equal(withoutSpot.days[0].spots.some((spot) => spot.id === "spot-a"), false);
    assert.equal(Object.keys(withoutSpot.travelLegs).some((key) => key.includes("spot-a")), false);
    assert.equal(withoutSpot.reminders[0].spotId, undefined);
    assert.equal(withoutSpot.reminders[0].timing.type, "fixed");

    const source = plan();
    const deleteDay = operation("command", { type: "day", id: "day-1" }, {
        precondition: { expectedFingerprint: targetFingerprint(source, { type: "day", id: "day-1" }) },
        payload: { command: "delete-day" },
    });
    const withoutDay = applyPlanOperation(source, deleteDay).document;
    assert.equal(withoutDay.days.some((day) => day.id === "day-1"), false);
    assert.equal(withoutDay.backlog.length, 5);
    assert.equal(withoutDay.backlog.some((spot) => "positionConstraint" in spot), false);

    const renameTag = operation("command", { type: "plan", id: "plan" }, {
        payload: { command: "rename-tag", from: "arte", to: "museo" },
    });
    const renamed = applyPlanOperation(plan(), renameTag).document;
    assert.deepEqual(renamed.tags, ["museo", "comida"]);
    assert.deepEqual(renamed.days[0].spots[1].tags, ["museo"]);

    const deleteCategory = operation("command", { type: "category", id: "culture" }, {
        precondition: { expectedFingerprint: targetFingerprint(plan(), { type: "category", id: "culture" }) },
        payload: { command: "delete-category" },
    });
    const withCategory = plan();
    withCategory.days[0].spots[1].category = "culture";
    const categoryDeleted = applyPlanOperation(withCategory, deleteCategory).document;
    assert.equal(categoryDeleted.days[0].spots[1].category, undefined);
});

test("el reemplazo excepcional exige la revisión completa", () => {
    const replacement = plan();
    replacement.tripTitle = "Importado";
    const op = operation("replace-plan", { type: "plan", id: "plan" }, {
        precondition: { expectedRevision: 4 }, payload: { document: replacement },
    });
    assert.equal(applyPlanOperation(plan(), op, { currentRevision: 4 }).document.tripTitle, "Importado");
    assert.throws(() => applyPlanOperation(plan(), op, { currentRevision: 5 }), errorCode("REVISION_CONFLICT"));
});

test("operación más inversa recupera el estado y repetir no duplica efectos", () => {
    const original = plan();
    const reminder = { id: "reminder-new", title: "Nuevo", timing: { type: "fixed", date: "2026-08-24" } };
    const insert = operation("insert-entity", { type: "reminder", id: reminder.id }, {
        precondition: { absent: true }, payload: { entity: reminder, beforeId: null },
    });
    const applied = applyPlanOperation(original, insert);
    assert.equal(applyPlanOperation(applied.document, insert).noOp, true);
    assert.deepEqual(applyPlanOperation(applied.document, applied.inverse).document, applyPlanOperation(original, operation("replace-plan", { type: "plan", id: "plan" }, {
        precondition: { expectedRevision: 4 }, payload: { document: original },
    }), { currentRevision: 4 }).document);

    const move = operation("move-entity", { type: "day", id: "day-2" }, {
        precondition: { expectedLocation: { containerId: "days", beforeId: null } },
        payload: { containerId: "days", beforeId: "day-1" },
    });
    const moved = applyPlanOperation(original, move);
    assert.deepEqual(applyPlanOperation(moved.document, moved.inverse).document, applied.inverse
        ? applyPlanOperation(original, operation("replace-plan", { type: "plan", id: "plan" }, {
            precondition: { expectedRevision: 4 }, payload: { document: original },
        }), { currentRevision: 4 }).document
        : null);

    const deleteDay = operation("command", { type: "day", id: "day-2" }, {
        precondition: { expectedFingerprint: targetFingerprint(original, { type: "day", id: "day-2" }) },
        payload: { command: "delete-day" },
    });
    const deleted = applyPlanOperation(original, deleteDay);
    assert.deepEqual(
        applyPlanOperation(deleted.document, deleted.inverse, { currentRevision: 5 }).document,
        applyPlanOperation(original, operation("replace-plan", { type: "plan", id: "plan" }, {
            precondition: { expectedRevision: 4 }, payload: { document: original },
        }), { currentRevision: 4 }).document,
    );
});

test("el reductor valida stops desactivados, horarios, recordatorios, legs y anclajes", () => {
    const op = operation("set-field", { type: "spot", id: "spot-a", field: "openingTime" }, {
        precondition: { expectedValue: "10:00" }, payload: { value: "09:30" },
    });
    const result = applyPlanOperation(plan(), op).document;
    const spot = result.days[0].spots.find((candidate) => candidate.id === "spot-a");
    assert.equal(spot.openingTime, "09:30");
    assert.equal(spot.mapEnabled, false);
    assert.equal(result.reminders[0].spotId, "spot-a");
    assert.deepEqual(result.travelLegs["spot-a>spot-b"], { mode: "walking" });
    assert.equal(result.days[0].spots[0].positionConstraint, "first");
    assert.equal(result.days[0].spots.at(-1).positionConstraint, "last");

    const locked = plan();
    delete locked.days[0].spots[0].positionConstraint;
    delete locked.days[0].spots.at(-1).positionConstraint;
    locked.days[0].spots[1].positionConstraint = "locked";
    const crossing = operation("move-entity", { type: "spot", id: "spot-first" }, {
        precondition: { expectedLocation: { containerId: "day-1", beforeId: "spot-a" } },
        payload: { containerId: "day-1", beforeId: "spot-last" },
    });
    assert.throws(() => applyPlanOperation(locked, crossing), errorCode("CONSTRAINT_VIOLATION"));
});

test("los comandos instrumentados actualizan formularios, timeline, duplicados y travel cards", () => {
    const update = operation("command", { type: "spot", id: "spot-a" }, {
        precondition: { expectedFields: { name: "Museo", cost: 12 }, expectedAbsent: ["optional"] },
        payload: { command: "update-fields", fields: { name: "Museo nuevo", optional: true }, remove: ["cost"] },
    });
    const updated = applyPlanOperation(plan(), update);
    const updatedSpot = updated.document.days[0].spots.find((spot) => spot.id === "spot-a");
    assert.equal(updatedSpot.name, "Museo nuevo");
    assert.equal(updatedSpot.optional, true);
    assert.equal("cost" in updatedSpot, false);
    assert.deepEqual(updated.targetKeys.filter((key) => key.includes("spot-a:")), ["spot:spot-a:cost", "spot:spot-a:name", "spot:spot-a:optional"]);
    assert.equal(updated.inverse.kind, "command");
    assert.equal(updated.inverse.payload.command, "update-fields");
    const withIndependentRemoteChange = structuredClone(updated.document);
    withIndependentRemoteChange.days[0].spots.find((spot) => spot.id === "spot-a").note = "Nota remota independiente";
    const undone = applyPlanOperation(withIndependentRemoteChange, updated.inverse).document;
    const undoneSpot = undone.days[0].spots.find((spot) => spot.id === "spot-a");
    assert.equal(undoneSpot.name, "Museo");
    assert.equal(undoneSpot.cost, 12);
    assert.equal("optional" in undoneSpot, false);
    assert.equal(undoneSpot.note, "Nota remota independiente");
    assert.throws(() => applyPlanOperation({ ...plan(), days: plan().days.map((day, index) => index ? day : { ...day, spots: day.spots.map((spot) => spot.id === "spot-a" ? { ...spot, cost: 13 } : spot) }) }, update), errorCode("TARGET_CONFLICT"));

    const timeline = operation("command", { type: "day", id: "day-1" }, {
        precondition: {
            expectedOrder: ["spot-first", "spot-a", "spot-b", "spot-last"],
            expectedStarts: { "spot-a": null, "spot-b": null },
        },
        payload: {
            command: "update-timeline",
            starts: { "spot-a": "11:00", "spot-b": "10:00" },
            order: ["spot-first", "spot-b", "spot-a", "spot-last"],
        },
    });
    const timelineResult = applyPlanOperation(plan(), timeline).document.days[0];
    assert.deepEqual(timelineResult.spots.map((spot) => spot.id), ["spot-first", "spot-b", "spot-a", "spot-last"]);
    assert.equal(timelineResult.spots.find((spot) => spot.id === "spot-a").plannedStart, "11:00");

    const duplicateEntity = {
        id: "day-copy",
        date: "2026-08-25",
        title: "Copia",
        spots: [{ id: "spot-copy-a", name: "A", tags: [] }, { id: "spot-copy-b", name: "B", tags: [] }],
    };
    const duplicate = operation("command", { type: "day", id: "day-1" }, {
        precondition: { expectedFingerprint: targetFingerprint(plan(), { type: "day", id: "day-1" }) },
        payload: { command: "duplicate-day", entity: duplicateEntity, travelLegs: { "spot-copy-a>spot-copy-b": { mode: "walking" } } },
    });
    const duplicated = applyPlanOperation(plan(), duplicate).document;
    assert.equal(duplicated.days[1].id, "day-copy");
    assert.deepEqual(duplicated.travelLegs["spot-copy-a>spot-copy-b"], { mode: "walking" });

    const removeTravel = operation("command", { type: "travel-leg", id: "spot-a>spot-b" }, {
        precondition: { expectedFingerprint: targetFingerprint(plan(), { type: "travel-leg", id: "spot-a>spot-b" }) },
        payload: { command: "delete-travel-card" },
    });
    assert.equal("spot-a>spot-b" in applyPlanOperation(plan(), removeTravel).document.travelLegs, false);
});
