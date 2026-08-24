import test from "node:test";
import assert from "node:assert/strict";
import { buildPlanChanges } from "../js/core/plan-changes.js";

test("el diff detecta movimientos y ediciones aunque los totales no cambien", () => {
    const previous = {
        tripTitle: "Viaje",
        foreignCurrency: "EUR",
        days: [
            { id: "d1", title: "Uno", date: "2026-08-22", spots: [{ id: "s1", name: "Museo", note: "Antes" }] },
            { id: "d2", title: "Dos", date: "2026-08-23", spots: [] },
        ],
        backlog: [],
    };
    const next = {
        ...previous,
        days: [
            { ...previous.days[1], spots: [{ id: "s1", name: "Museo", note: "Después" }] },
            { ...previous.days[0], spots: [] },
        ],
    };

    const preview = buildPlanChanges(previous, next);
    assert.deepEqual(preview.stats.map((stat) => stat.value), [0, 3, 0]);
    assert.ok(preview.groups.some((group) => group.title === "Día modificado · Uno"));
    const spot = preview.groups.find((group) => group.title === "Parada modificada · Museo");
    assert.deepEqual(spot.changes.map((change) => change.label), ["Día", "Nota"]);
});

test("el diff agrupa altas y bajas por identidad", () => {
    const preview = buildPlanChanges(
        { days: [{ id: "old", title: "Anterior", spots: [] }], backlog: [], categories: [], tags: [] },
        { days: [{ id: "new", title: "Nuevo", spots: [] }], backlog: [], categories: [], tags: [] },
    );
    assert.deepEqual(preview.stats.map((stat) => stat.value), [1, 0, 1]);
    assert.equal(preview.groups[0].tone, "add");
    assert.equal(preview.groups[1].tone, "remove");
});
