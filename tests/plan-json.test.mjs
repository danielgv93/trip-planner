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

test("normalizePlan migra las notas antiguas a una página General", () => {
    const value = { ...plan(), tripNotes: "Reserva confirmada" };
    const normalized = normalizePlan(value);
    assert.deepEqual(normalized.tripNotePages, [{
        id: "notes-general",
        title: "General",
        content: "Reserva confirmada",
    }]);
    assert.equal(normalized.activeTripNotePageId, "notes-general");
});

test("normalizePlan conserva páginas de notas y valida la pestaña activa", () => {
    const value = {
        ...plan(),
        tripNotePages: [
            { id: "p1", title: "Reservas", content: "Hotel" },
            { id: "p2", title: "Equipaje", content: "Pasaporte" },
        ],
        activeTripNotePageId: "p2",
    };
    const normalized = normalizePlan(value);
    assert.equal(normalized.tripNotePages.length, 2);
    assert.equal(normalized.activeTripNotePageId, "p2");
});

test("normalizePlan rechaza páginas de notas con identificadores repetidos", () => {
    const value = {
        ...plan(),
        tripNotePages: [
            { id: "p1", title: "Una", content: "" },
            { id: "p1", title: "Otra", content: "" },
        ],
    };
    assert.throws(() => normalizePlan(value), /INVALID_PLAN/);
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
    assert.equal(Object.hasOwn(serialized, "activeTripNotePageId"), false);
    assert.ok(Array.isArray(serialized.days));
    assert.ok(Array.isArray(serialized.tripNotePages));
});

test("normalizePlan conserva metadatos de salud seguros", () => {
    const value = plan();
    value.days[0].startTime = "08:15";
    Object.assign(value.days[0].spots[0], {
        plannedStart: "10:00",
        fixedStart: true,
        optional: true,
        scheduleNotApplicable: true,
    });
    const normalized = normalizePlan(value);
    assert.equal(normalized.days[0].startTime, "08:15");
    assert.equal(normalized.days[0].spots[0].fixedStart, true);
    assert.equal(normalized.days[0].spots[0].optional, true);
});

test("normalizePlan descarta metadatos retirados y reservas incoherentes", () => {
    const value = plan();
    Object.assign(value.days[0].spots[0], {
        fixedStart: true,
        scheduleUrl: "javascript:alert(1)",
        scheduleVerifiedAt: "ayer",
    });
    const spot = normalizePlan(value).days[0].spots[0];
    assert.equal(spot.fixedStart, undefined);
    assert.equal(spot.scheduleUrl, undefined);
    assert.equal(spot.scheduleVerifiedAt, undefined);
});

test("normalizePlan migra roles y trayectos legacy al contrato portable", () => {
    const value = plan();
    value.days[0].spots.push({ id: "s2", name: "Hotel", kind: "waypoint" });
    value.routeTimeProfiles = { "s1>s2": "driving" };
    value.routeTimeOverrides = { "driving:s1>s2": 18 };
    const normalized = normalizePlan(value);
    assert.equal(normalized.days[0].spots[0].kind, "activity");
    assert.equal(normalized.days[0].spots[1].kind, "waypoint");
    assert.deepEqual(normalized.travelLegs["s1>s2"], { mode: "driving", durationMinutes: 18 });
});

test("normalizePlan conserva un trayecto completo con precio y extremos embebidos", () => {
    const value = plan();
    value.days[0].spots.push({ id: "s2", name: "Tokyo", kind: "waypoint" });
    value.travelLegs = { "s1>s2": { mode: "train", durationMinutes: 135, departureTime: "09:12", fixedDeparture: true, line: "Shinkansen", note: "Andén 6", cost: 13320, embeddedEndpoints: ["from", "to"] } };
    assert.deepEqual(normalizePlan(value).travelLegs, value.travelLegs);
});

test("normalizePlan no deduce el tipo de parada a partir del identificador de categoría", () => {
    const value = plan();
    value.categories = [
        { id: "hotel", label: "Alojamiento", color: "#123456" },
        { id: "transport", label: "Transporte", color: "#654321", defaultSpotKind: "waypoint" },
    ];
    const normalized = normalizePlan(value);
    assert.equal(normalized.categories[0].defaultSpotKind, "activity");
    assert.equal(normalized.categories[1].defaultSpotKind, "waypoint");
});

test("normalizePlan conserva anclajes válidos y limpia valores desconocidos o de backlog", () => {
    const value = plan();
    value.days[0].spots[0].positionConstraint = "first";
    value.days[0].spots.push({ id: "s2", name: "Libre", positionConstraint: "desconocido" });
    value.backlog.push({ id: "s3", name: "Idea", positionConstraint: "last" });
    const normalized = normalizePlan(value);
    assert.equal(normalized.days[0].spots[0].positionConstraint, "first");
    assert.equal(normalized.days[0].spots[1].positionConstraint, undefined);
    assert.equal(normalized.backlog[0].positionConstraint, undefined);
});
