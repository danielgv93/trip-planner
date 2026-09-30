import test from "node:test";
import assert from "node:assert/strict";

const {
    STAGE_MAX_LENGTH,
    normalizeStage,
    effectiveStage,
    groupDaysByStage,
    stageNames,
    weekdayInitial,
    weekdayShort,
    weekdayLong,
    shouldShowDateStrip,
    DATE_STRIP_MIN_DAYS,
} = await import("../js/core/day-stages.js");

test("normalizeStage recorta, limita y descarta valores vacíos o no textuales", () => {
    assert.equal(normalizeStage("  Kioto  "), "Kioto");
    assert.equal(normalizeStage("   "), undefined);
    assert.equal(normalizeStage(12), undefined);
    assert.equal(normalizeStage(undefined), undefined);
    assert.equal(normalizeStage("a".repeat(STAGE_MAX_LENGTH + 20)).length, STAGE_MAX_LENGTH);
    assert.equal(normalizeStage("Kioto\n  Sur"), "Kioto Sur");
});

test("effectiveStage prefiere stage y deriva del prefijo del título sin escribir datos", () => {
    const explicit = { title: "Tokio · Shibuya", stage: "Kioto" };
    assert.equal(effectiveStage(explicit), "Kioto");
    const derived = { title: "Tokio · Shibuya" };
    assert.equal(effectiveStage(derived), "Tokio");
    assert.equal(derived.stage, undefined);
    assert.equal(effectiveStage({ title: "Llegada" }), "");
    assert.equal(effectiveStage({ title: " · Solo sufijo" }), "");
    assert.equal(effectiveStage({ title: "Tokio · Shibuya · Noche" }), "Tokio");
    assert.equal(effectiveStage({}), "");
});

test("groupDaysByStage agrupa días consecutivos con la misma etapa efectiva", () => {
    const days = [
        { id: "a", title: "Tokio · Uno" },
        { id: "b", title: "Tokio · Dos" },
        { id: "c", title: "Libre" },
        { id: "d", title: "Otro", stage: "Kioto" },
        { id: "e", title: "Kioto · Tres" },
        { id: "f", title: "Tokio · Vuelta" },
    ];
    const groups = groupDaysByStage(days);
    assert.deepEqual(groups.map((g) => [g.stage, g.days.map((d) => d.day.id), g.days.map((d) => d.index)]), [
        ["Tokio", ["a", "b"], [0, 1]],
        ["", ["c"], [2]],
        ["Kioto", ["d", "e"], [3, 4]],
        ["Tokio", ["f"], [5]],
    ]);
    assert.deepEqual(groupDaysByStage([]), []);
});

test("stageNames devuelve nombres únicos en orden de aparición", () => {
    assert.deepEqual(stageNames([
        { title: "Tokio · A" }, { title: "x", stage: "Kioto" }, { title: "Tokio · B" }, { title: "Suelto" },
    ]), ["Tokio", "Kioto"]);
});

test("weekdayInitial usa iniciales españolas L M X J V S D", () => {
    assert.equal(weekdayInitial("2026-08-24"), "L");
    assert.equal(weekdayInitial("2026-08-25"), "M");
    assert.equal(weekdayInitial("2026-08-26"), "X");
    assert.equal(weekdayInitial("2026-08-27"), "J");
    assert.equal(weekdayInitial("2026-08-28"), "V");
    assert.equal(weekdayInitial("2026-08-29"), "S");
    assert.equal(weekdayInitial("2026-08-30"), "D");
    assert.equal(weekdayInitial(""), "");
});

test("la tira de fechas solo aparece a partir del umbral de días", () => {
    assert.equal(shouldShowDateStrip(DATE_STRIP_MIN_DAYS - 1), false);
    assert.equal(shouldShowDateStrip(DATE_STRIP_MIN_DAYS), true);
    assert.equal(DATE_STRIP_MIN_DAYS, 5);
});

test("weekdayShort y weekdayLong devuelven nombres españoles o vacío", () => {
    assert.equal(weekdayShort("2026-08-26"), "Mié");
    assert.equal(weekdayLong("2026-08-27"), "Jueves");
    assert.equal(weekdayShort("nope"), "");
    assert.equal(weekdayLong(""), "");
});

test("effectiveStage ignora prefijos que solo son un contador de día", () => {
    assert.equal(effectiveStage({ title: "Día 1 · Llegada" }), "");
    assert.equal(effectiveStage({ title: "dia 12 · Llegada" }), "");
    assert.equal(effectiveStage({ title: "DAY 3 · Arrival" }), "");
    assert.equal(effectiveStage({ title: "Día2 · Llegada" }), "");
    assert.equal(effectiveStage({ title: "Días 3-4 · Kioto" }), "");
    assert.equal(effectiveStage({ title: "Día 1 y 2 · Llegada" }), "");
    assert.equal(effectiveStage({ title: "Día del Pilar · Fiesta" }), "Día del Pilar");
    assert.equal(effectiveStage({ title: "Día 1 · Llegada", stage: "Kioto" }), "Kioto");
});
