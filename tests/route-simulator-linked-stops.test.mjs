import test from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.document = { querySelector: () => null };

const { optimizeRoute } = await import("../js/features/route-simulator/optimizer.js");
const { establishedBaseline } = await import("../js/features/route-simulator/baseline.js");
const { brokenStopChains, linkedStopChains } = await import("../js/features/route-simulator/legs.js");
const { optimizeWithOptionalStops } = await import("../js/features/route-simulator/optional-stops.js");
const { moveImpacts } = await import("../js/features/route-simulator/move-impact.js");
const { reorderDiff } = await import("../js/features/route-simulator/reorder.js");

const NOT_TODAY = new Date("2020-01-01T12:00:00");

// Two piers folded into one ferry card, then one more leg folded into it.
test("el «antes» agrupa en cadenas las paradas unidas en una tarjeta de trayecto", () => {
    const embedded = new Set(["b>c", "c>d"]);
    const baseline = establishedBaseline({ date: "2026-11-27", startTime: "09:00", spots: [] }, [
        { id: "a", name: "Hotel" },
        { id: "b", name: "Muelle de salida" },
        { id: "c", name: "Muelle de llegada" },
        { id: "d", name: "Parque" },
        { id: "e", name: "Museo" },
    ], {
        now: NOT_TODAY,
        travelForLeg: (from, to) => ({
            minutes: 10,
            profile: "walking",
            embeddedEndpoints: embedded.has(`${from.id}>${to.id}`) ? ["from", "to"] : undefined,
        }),
    });
    const chains = linkedStopChains(baseline);
    assert.equal(chains.length, 1);
    assert.deepEqual(chains[0].indexes, [1, 2, 3]);
    assert.deepEqual(chains[0].names, ["Muelle de salida", "Muelle de llegada", "Parque"]);
});

// Alone, the arrival pier would jump next to A; the card keeps it with its
// departure pier, so the pair moves (or stays) as one.
const spots = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "salida", name: "Ferry salida" },
    { id: "llegada", name: "Ferry llegada" },
    { id: "e", name: "E" },
];
const travel = [
    [0, 30, 30, 1, 30],
    [30, 0, 1, 30, 30],
    [30, 1, 0, 10, 1],
    [1, 30, 10, 0, 30],
    [30, 30, 1, 30, 0],
];

test("el optimizador nunca separa una cadena de paradas unidas", () => {
    const libre = optimizeRoute(spots, travel, { firstSpotIndex: 0 });
    const unida = optimizeRoute(spots, travel, { firstSpotIndex: 0, chains: [[2, 3]] });
    assert.notEqual(libre.order.indexOf(3), libre.order.indexOf(2) + 1);
    assert.equal(unida.order.indexOf(3), unida.order.indexOf(2) + 1);
    assert.equal(brokenStopChains(unida, [{ indexes: [2, 3], names: [] }]).length, 0);
});

test("la búsqueda heurística también mueve la cadena entera", () => {
    const many = Array.from({ length: 11 }, (_, index) => ({ id: `s${index}`, name: `S${index}` }));
    const distance = many.map((_, from) => many.map((__, to) => Math.abs(from - to) * 5));
    // The arrival pier sits right next to the start, far from its departure pier.
    distance[0][9] = 1;
    distance[9][0] = 1;
    const result = optimizeRoute(many, distance, { firstSpotIndex: 0, chains: [[4, 9]] });
    assert.equal(result.exact, false);
    assert.equal(result.order.indexOf(9), result.order.indexOf(4) + 1);
});

test("una cadena que toca una parada fijada se queda entera en su sitio", () => {
    const result = optimizeRoute(spots, travel, { firstSpotIndex: 0, fixedSpotIndexes: [2], chains: [[2, 3]] });
    assert.deepEqual(result.order.slice(2, 4), [2, 3]);
});

test("una parada fijada entre huecos libres no acaba dentro de una cadena", () => {
    // Free slots 1, 2 and 4 around pinned slot 3: putting E first would push
    // the ferry across the pinned stop.
    const result = optimizeRoute(spots, travel, { firstSpotIndex: 0, fixedSpotIndexes: [3], chains: [[1, 2]] });
    assert.equal(result.order.indexOf(2), result.order.indexOf(1) + 1);
    assert.equal(result.order[3], 3);
});

test("si ninguna posición deja la cadena entera, se queda donde estaba", () => {
    const four = spots.slice(0, 4);
    const matrix = travel.slice(0, 4).map((row) => row.slice(0, 4));
    // Only slots 1 and 3 are free, split by pinned slot 2.
    const result = optimizeRoute(four, matrix, { firstSpotIndex: 0, fixedSpotIndexes: [2], chains: [[1, 3]] });
    assert.deepEqual(result.order, [0, 1, 2, 3]);
});

test("una parada opcional de una cadena no se deja fuera a medias", () => {
    const options = { firstSpotIndex: 0, chains: [[2, 3]] };
    const outcome = optimizeWithOptionalStops(spots, travel, options, [1]);
    const order = outcome.result.order;
    assert.equal(order.indexOf(3), order.indexOf(2) + 1);
});

test("deshacer el movimiento de una parada unida deshace también el de su pareja", () => {
    const before = [0, 1, 2, 3, 4].map((spotIndex) => ({ spotIndex, spot: spots[spotIndex] }));
    const after = [0, 2, 3, 1, 4].map((spotIndex) => ({ spotIndex, spot: spots[spotIndex] }));
    const diff = reorderDiff(before, after);
    const orders = [];
    moveImpacts(diff, {
        chains: [[2, 3]],
        evaluate: (order) => {
            orders.push(order.join(","));
            return { finish: 100, start: 0, steps: [], metrics: { reservationLateStops: 0, overtime: 0, scheduleConflictStops: 0 } };
        },
    });
    // No priced order ever splits the ferry.
    for (const order of orders.map((value) => value.split(",").map(Number)))
        assert.equal(order.indexOf(3), order.indexOf(2) + 1, order.join(","));
});
