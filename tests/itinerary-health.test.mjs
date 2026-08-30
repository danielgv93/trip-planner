import test from "node:test";
import assert from "node:assert/strict";

Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => {} },
});

const { diagnoseDay } = await import("../js/features/health/diagnostics.js");
const { generateSuggestions } = await import("../js/features/health/suggestions.js");
const { getHealthResult, setHealthResult, clearHealthResults } = await import("../js/features/health/session.js");

function spot(overrides = {}) {
    return { id: "s1", name: "Museo", visitMinutes: 60, lat: 40, lng: -3, openingTime: "09:00", closingTime: "18:00", ...overrides };
}

function projection(itemOverrides = {}) {
    return { items: [{ spot: spot(), duration: 60, travel: 15, travelProfile: "walking", travelMode: "walking", travelSource: "official", margin: 120, conflicts: [], ...itemOverrides }] };
}

test("el conflicto duro tiene precedencia sobre datos ausentes", () => {
    const day = { id: "d1", spots: [spot({ visitMinutes: undefined })] };
    const result = diagnoseDay(day, projection({ spot: day.spots[0], conflicts: [{ type: "late-reservation", minutes: 12 }] }));
    assert.equal(result.state, "impossible");
    assert.ok(result.issues.some((issue) => issue.type === "missing-duration"));
    assert.ok(result.issues.some((issue) => issue.type === "late-reservation"));
});

test("sin horario aplicable satisface el dato horario", () => {
    const value = spot({ openingTime: undefined, closingTime: undefined, scheduleNotApplicable: true });
    const result = diagnoseDay({ id: "d1", spots: [value] }, projection({ spot: value, travel: 0, margin: null }));
    assert.equal(result.state, "solid");
    assert.equal(result.issues.some((issue) => issue.type === "missing-schedule"), false);
});

test("un punto de paso no exige duración ni horario aunque conserve datos antiguos", () => {
    const value = spot({
        kind: "waypoint",
        visitMinutes: undefined,
        openingTime: undefined,
        closingTime: undefined,
    });
    const result = diagnoseDay(
        { id: "d1", spots: [value] },
        projection({ spot: value, duration: 0, travel: 0, margin: null }),
    );
    assert.equal(result.issues.some((issue) => issue.type === "missing-duration"), false);
    assert.equal(result.issues.some((issue) => issue.type === "missing-schedule"), false);
});

test("los datos ausentes se distinguen de un día sin comprobar", () => {
    const value = spot({ visitMinutes: undefined, openingTime: undefined, closingTime: undefined });
    const result = diagnoseDay({ id: "d1", spots: [value] }, projection({ spot: value }));
    assert.equal(result.state, "incomplete");
    assert.ok(result.issues.some((issue) => issue.severity === "missing"));
});

test("un día sin paradas activas queda marcado como incompleto", () => {
    const result = diagnoseDay({ id: "d1", spots: [] }, { items: [] });
    assert.equal(result.state, "incomplete");
});

test("los umbrales de margen y caminata clasifican el día como justo", () => {
    const value = spot();
    const result = diagnoseDay({ id: "d1", spots: [value] }, projection({ spot: value, travel: 121, margin: 30 }));
    assert.equal(result.state, "tight");
    assert.ok(result.issues.some((issue) => issue.type === "low-margin"));
    assert.ok(result.issues.some((issue) => issue.type === "walking-total"));
});

test("un tramo largo en otro medio no se contabiliza como caminata", () => {
    const value = spot();
    const result = diagnoseDay(
        { id: "d1", spots: [value] },
        projection({ spot: value, travel: 60, travelMode: "train", travelProfile: "walking" }),
    );
    assert.equal(result.metrics.walking, 0);
    assert.equal(result.issues.some((issue) => issue.type === "walking-leg"), false);
});

test("las rutas estimadas impiden un resultado sólido", () => {
    const value = spot();
    const result = diagnoseDay({ id: "d1", spots: [value] }, projection({ spot: value, travelSource: "estimated" }));
    assert.equal(result.state, "tight");
    assert.equal(result.approximate, true);
});

test("retirar una parada opcional solo se propone cuando mejora", () => {
    const day = { id: "d1", spots: [spot({ optional: true }), spot({ id: "s2", name: "Parque" })] };
    const baseline = { state: "tight", issues: [{ type: "workload", spotId: "s1" }], metrics: { travel: 0 } };
    const evaluate = (candidate) => candidate.spots.length === 1
        ? { state: "solid", issues: [], metrics: { travel: 0 } }
        : baseline;
    const suggestions = generateSuggestions(day, baseline, evaluate, []);
    assert.ok(suggestions.some((item) => item.kind === "remove-optional" && item.payload.spotId === "s1"));
});

test("la firma de sesión invalida resultados al cambiar una entrada", () => {
    clearHealthResults();
    const day = { id: "signature-day", spots: [spot()] };
    setHealthResult(day, { state: "solid", issues: [], metrics: {} });
    assert.equal(getHealthResult(day).state, "solid");
    day.spots[0].visitMinutes = 75;
    assert.equal(getHealthResult(day).state, "unchecked");
});
