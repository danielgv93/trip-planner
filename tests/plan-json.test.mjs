import test from "node:test";
import assert from "node:assert/strict";

const memory = new Map();
globalThis.localStorage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, String(value)),
};

const { normalizePlan, parsePlanJson, serializePlan, PLAN_VERSION } =
    await import("../js/core/plan-json.js");

function plan() {
    return {
        days: [{ id: "d1", date: "2026-07-18", title: "Madrid", spots: [
            { id: "s1", name: "Prado", openingTime: "09:00", closingTime: "25:00" },
        ] }],
        backlog: [],
        tags: [],
        categories: [],
    };
}

test("normalizePlan conserva datos válidos y descarta horas inválidas", () => {
    const normalized = normalizePlan(plan());
    assert.equal(normalized.version, PLAN_VERSION);
    assert.equal(normalized.days[0].spots[0].openingTime, "09:00");
    assert.equal(normalized.days[0].spots[0].closingTime, undefined);
    assert.equal(normalized.days[0].spots[0].mapEnabled, true);
});

test("normalizePlan rechaza identificadores repetidos", () => {
    const value = plan();
    value.backlog.push({ id: "s1", name: "Duplicada" });
    assert.throws(() => normalizePlan(value), /INVALID_PLAN/);
});

test("normalizePlan conserva grupos válidos y limpia referencias huérfanas", () => {
    const value = plan();
    value.backlogGroups = [
        { id: "g1", title: "Kyoto", collapsed: true },
    ];
    value.backlog = [
        { id: "s2", name: "Arashiyama", backlogGroupId: "g1" },
        { id: "s3", name: "Osaka", backlogGroupId: "grupo-inexistente" },
    ];
    const normalized = normalizePlan(value);
    assert.deepEqual(normalized.backlogGroups, [
        { id: "g1", title: "Kyoto", collapsed: true },
    ]);
    assert.equal(normalized.backlog[0].backlogGroupId, "g1");
    assert.equal(normalized.backlog[1].backlogGroupId, undefined);
});

test("parsePlanJson distingue JSON roto de un plan inválido", () => {
    assert.throws(() => parsePlanJson("{"), /INVALID_JSON/);
    assert.throws(() => parsePlanJson("{}"), /INVALID_PLAN/);
});

test("serializePlan genera el documento portable actual", () => {
    const serialized = serializePlan({ exportedAt: false });
    assert.equal(serialized.version, PLAN_VERSION);
    assert.equal(Object.hasOwn(serialized, "exportedAt"), false);
    assert.ok(Array.isArray(serialized.days));
});
