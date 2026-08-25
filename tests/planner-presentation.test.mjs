import test from "node:test";
import assert from "node:assert/strict";

const localValues = new Map();
globalThis.localStorage = {
    getItem: (key) => localValues.get(key) ?? null,
    setItem: (key, value) => localValues.set(key, String(value)),
};

const { store } = await import("../js/core/store.js");
const {
    formatCost,
    formatDualCost,
    sumCosts,
    sumTravelCosts,
} = await import("../js/features/finance/totals.js");
const {
    formatDurationMinutes,
} = await import("../js/features/planner/duration-presentation.js");

test("los totales excluyen paradas desactivadas y costes inválidos", () => {
    const spots = [
        { id: "a", cost: 12 },
        { id: "b", cost: 8, mapEnabled: false },
        { id: "c", cost: -4 },
        { id: "d", cost: 3.5 },
    ];
    assert.equal(sumCosts(spots), 15.5);
});

test("el total de trayectos usa solo parejas activas consecutivas", () => {
    store.travelLegs = {
        "a>c": { mode: "train", cost: 20 },
        "a>b": { mode: "bus", cost: 999 },
    };
    const day = {
        spots: [
            { id: "a" },
            { id: "b", mapEnabled: false },
            { id: "c" },
        ],
    };
    assert.equal(sumTravelCosts(day), 20);
});

test("el formato financiero y de duración conserva la presentación pública", () => {
    store.foreignCurrency = "EUR";
    store.localCurrency = "USD";
    store.exchangeRate = 2;
    assert.match(formatCost(10), /10/);
    assert.match(formatDualCost(10), /20/);
    assert.equal(formatDurationMinutes(45), "~45 min");
    assert.equal(formatDurationMinutes(180), "~3 h");
    assert.equal(formatDurationMinutes(210), "~3 h 30 min");
});
