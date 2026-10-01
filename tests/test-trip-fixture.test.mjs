import test from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage = { getItem: () => null, setItem() {} };

const { parsePlanJson, PLAN_VERSION } = await import("../js/core/plan-json.js");
const { loadTestTrip, TEST_TRIP_JSON } = await import("./fixtures/load-test-trip.mjs");

test("el viaje de prueba es un plan portable válido de 14 días consecutivos", () => {
    const plan = parsePlanJson(TEST_TRIP_JSON);
    assert.equal(plan.version, PLAN_VERSION);
    assert.equal(plan.days.length, 14);
    plan.days.forEach((day, index) => {
        const expected = new Date(Date.UTC(2026, 10, 2 + index)).toISOString().slice(0, 10);
        assert.equal(day.date, expected);
        assert.ok(day.stage, `${day.id} debe tener etapa`);
    });
});

test("la normalización no pierde ningún campo del viaje de prueba", () => {
    const raw = loadTestTrip();
    const plan = parsePlanJson(TEST_TRIP_JSON);
    assert.deepEqual(plan.days, raw.days);
    assert.deepEqual(plan.backlog, raw.backlog);
    assert.deepEqual(plan.travelLegs, raw.travelLegs);
    assert.deepEqual(plan.reminders, raw.reminders);
});

test("loadTestTrip devuelve copias independientes", () => {
    const first = loadTestTrip();
    first.days[0].spots.length = 0;
    assert.notEqual(loadTestTrip().days[0].spots.length, 0);
});
