import test from "node:test";
import assert from "node:assert/strict";

Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => {} },
});

const {
    dayPositionConstraintViolation,
    positionConstraintInsertionIndex,
} = await import("../js/core/itinerary.js");
const {
    relocateSpot,
    relocationConstraintViolation,
} = await import("../js/features/planner/move-spot.js");
const { generateSuggestions } = await import("../js/features/health/suggestions.js");

function spot(id, positionConstraint) {
    return { id, name: id, ...(positionConstraint ? { positionConstraint } : {}) };
}

test("los extremos anclados reservan el inicio y el final para nuevas paradas", () => {
    const spots = [spot("hotel", "first"), spot("museo"), spot("aeropuerto", "last")];
    assert.equal(positionConstraintInsertionIndex(spots, spot("cafe"), spots.length), 2);
    assert.match(
        dayPositionConstraintViolation(spots, [spots[1], spots[0], spots[2]]),
        /primera parada/,
    );
});

test("una posición fija actúa como frontera durante los movimientos", () => {
    const value = {
        state: [
            { id: "d1", spots: [spot("a"), spot("hotel", "locked"), spot("b")] },
            { id: "d2", spots: [spot("c")] },
        ],
        backlog: [],
        backlogGroups: [],
    };
    assert.match(relocationConstraintViolation(value, "b", "d1", 0), /mantener su posición/);
    assert.equal(relocateSpot(value, "b", "d1", 0), null);
    assert.deepEqual(value.state[0].spots.map(({ id }) => id), ["a", "hotel", "b"]);
    assert.match(relocationConstraintViolation(value, "hotel", "d2", 1), /anclada al día/);
});

test("las mejoras simuladas respetan primera y última parada", () => {
    const day = {
        id: "d1",
        spots: [spot("hotel", "first"), spot("museo"), spot("cafe"), spot("estacion", "last")],
    };
    const baseline = { state: "tight", issues: [{ type: "workload" }], metrics: { travel: 100 } };
    const evaluate = (candidate) => {
        const order = candidate.spots.map(({ id }) => id).join(">");
        return order === "hotel>cafe>museo>estacion"
            ? { state: "solid", issues: [], metrics: { travel: 75 } }
            : baseline;
    };
    const reorder = generateSuggestions(day, baseline, evaluate).find((item) => item.kind === "reorder");
    assert.deepEqual(reorder?.payload.order, ["hotel", "cafe", "museo", "estacion"]);
});

test("una parada anclada nunca se propone como opcional ni para otro día", () => {
    const anchored = { ...spot("hotel", "first"), optional: true };
    const day = { id: "d1", spots: [anchored, spot("museo")] };
    const receiver = { id: "d2", date: "2026-08-10", title: "Día 2", spots: [] };
    const baseline = { state: "tight", issues: [{ type: "workload", spotId: "hotel" }], metrics: { travel: 0 } };
    const evaluate = (candidate) => candidate.spots.some(({ id }) => id === "hotel")
        ? baseline
        : { state: "solid", issues: [], metrics: { travel: 0 } };
    const suggestions = generateSuggestions(day, baseline, evaluate, [day, receiver]);
    assert.equal(suggestions.some((item) => ["remove-optional", "move-day"].includes(item.kind)), false);
});
