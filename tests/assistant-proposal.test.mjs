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
