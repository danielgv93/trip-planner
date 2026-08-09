import test from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
};

const { buildProposedPlan } = await import("../js/features/assistant/proposal.js");

function currentPlan() {
    return {
        days: [{
            id: "d1",
            date: "2026-07-18",
            title: "Día 1",
            spots: [{ id: "s1", name: "Museo", tags: [], plannedStart: "09:00" }],
        }],
        backlog: [],
        tags: [],
        categories: [],
        routeTimeOverrides: { "walking:s1>s2": 15 },
        routeTimeProfiles: { "s1>s2": "walking" },
    };
}

test("borrar un día mediante propuesta conserva sus paradas en ideas", () => {
    const result = buildProposedPlan(currentPlan(), [
        { type: "delete_day", dayId: "d1" },
    ]).plan;
    assert.equal(result.days.length, 0);
    assert.equal(result.backlog[0].id, "s1");
    assert.equal(result.backlog[0].plannedStart, undefined);
});

test("las propuestas inválidas no alteran el plan original", () => {
    const original = currentPlan();
    assert.throws(
        () => buildProposedPlan(original, [{ type: "update_spot", spotId: "s1", patch: { openingTime: "25:00" } }]),
        /formato HH:MM/,
    );
    assert.equal(original.days[0].spots[0].openingTime, undefined);
});

test("las propuestas validan reservas y paradas opcionales", () => {
    const original = currentPlan();
    const fixed = buildProposedPlan(original, [{ type: "update_spot", spotId: "s1", patch: { fixedStart: true, optional: true } }]).plan.days[0].spots[0];
    assert.equal(fixed.fixedStart, true);
    assert.equal(fixed.optional, true);
});

test("una propuesta puede configurar el inicio explícito del día", () => {
    const result = buildProposedPlan(currentPlan(), [{ type: "update_day", dayId: "d1", startTime: "08:30" }]).plan;
    assert.equal(result.days[0].startTime, "08:30");
});

test("las propuestas pueden anclar extremos y no moverlos fuera del día", () => {
    const original = currentPlan();
    original.days[0].spots.push({ id: "s2", name: "Hotel", tags: [] });
    original.days.push({ id: "d2", date: "2026-07-19", title: "Día 2", spots: [] });
    const anchored = buildProposedPlan(original, [
        { type: "update_spot", spotId: "s2", patch: { positionConstraint: "first" } },
    ]).plan;
    assert.deepEqual(anchored.days[0].spots.map(({ id }) => id), ["s2", "s1"]);
    assert.throws(
        () => buildProposedPlan(anchored, [{ type: "move_spot", spotId: "s2", dayId: "d2", at: 0 }]),
        /anclada no puede moverse/,
    );
});

test("las propuestas rechazan dos anclajes para el mismo extremo", () => {
    const original = currentPlan();
    original.days[0].spots.push({ id: "s2", name: "Hotel", tags: [], positionConstraint: "first" });
    assert.throws(
        () => buildProposedPlan(original, [{ type: "update_spot", spotId: "s1", patch: { positionConstraint: "first" } }]),
        /primera parada anclada/,
    );
});
