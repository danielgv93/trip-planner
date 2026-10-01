import test from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.document = { querySelector: () => null };

const { parsePlanJson, PLAN_VERSION } = await import("../js/core/plan-json.js");
const { loadTestTrip, TEST_TRIP_JSON } = await import("./fixtures/load-test-trip.mjs");
const { buildTimelineProjection } = await import("../js/features/timeline/timeline.js");
const { diagnoseDay } = await import("../js/features/health/diagnostics.js");
const { AUTOMATIC_TRAVEL_MODES, disconnectedTravelLegs, travelLegKey } = await import("../js/core/travel-legs.js");

// Deterministic travel: configured legs win; any other leg takes 10 min walking.
function fixtureTravel(plan) {
    return (from, to) => {
        const leg = plan.travelLegs[travelLegKey(from.id, to.id)];
        if (!leg) return { minutes: 10, officialMinutes: 10, profile: "walking" };
        return {
            minutes: leg.durationMinutes,
            mode: leg.mode,
            profile: AUTOMATIC_TRAVEL_MODES.includes(leg.mode) ? leg.mode : "walking",
            overridden: Number.isFinite(leg.durationMinutes),
            departureTime: leg.departureTime,
            fixedDeparture: leg.fixedDeparture,
        };
    };
}

function issueTypes(plan, dayId) {
    const day = plan.days.find((candidate) => candidate.id === dayId);
    const projection = buildTimelineProjection(day, {
        now: new Date("2026-10-01T12:00:00"),
        travelForLeg: fixtureTravel(plan),
    });
    return diagnoseDay(day, projection).issues.map((issue) => issue.type);
}

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

test("el viaje de prueba provoca cada diagnóstico de salud en su día", () => {
    const plan = parsePlanJson(TEST_TRIP_JSON);
    const expected = {
        "day-04": ["missing-location"],
        "day-05": ["missing-travel-duration"],
        "day-06": ["ambiguous-schedule"],
        "day-07": ["missed-departure"],
        "day-08": ["walking-leg"],
        "day-09": ["outside-hours"],
        "day-12": ["late-reservation", "visit-overlap"],
        "day-13": ["empty"],
    };
    for (const [dayId, types] of Object.entries(expected)) {
        const found = issueTypes(plan, dayId);
        for (const type of types) assert.ok(found.includes(type), `${dayId} debe provocar ${type}; obtuvo ${found.join(", ")}`);
    }
});

test("el viaje de prueba cubre los casos límite de datos", () => {
    const plan = parsePlanJson(TEST_TRIP_JSON);
    const spots = [...plan.days.flatMap((day) => day.spots), ...plan.backlog];
    const categoryIds = new Set(plan.categories.map((category) => category.id));
    const usedCategories = new Set(spots.map((spot) => spot.category));
    const names = plan.days.flatMap((day) => day.spots.map((spot) => spot.name));

    assert.ok(spots.some((spot) => spot.visitedAt), "parada visitada");
    assert.ok(spots.some((spot) => /[<>&"']/.test(spot.name)), "nombre con HTML y comillas");
    assert.ok(spots.some((spot) => /<script>/.test(spot.note)), "nota con HTML");
    assert.ok(spots.some((spot) => spot.name.length > 100), "nombre muy largo");
    assert.ok(spots.some((spot) => spot.category === undefined), "parada sin categoría");
    assert.ok(spots.some((spot) => spot.category && !categoryIds.has(spot.category)), "categoría inexistente");
    assert.ok(plan.categories.some((category) => !usedCategories.has(category.id)), "categoría sin uso");
    assert.ok(spots.some((spot) => spot.tags.some((tag) => !plan.tags.includes(tag))), "etiqueta no registrada");
    assert.ok(spots.some((spot) => !Number.isFinite(spot.lat)), "parada sin ubicación");
    assert.ok(spots.some((spot) => spot.lng < -150), "coordenadas en el otro hemisferio");
    assert.ok(spots.some((spot) => spot.cost === 0), "coste cero");
    assert.ok(spots.some((spot) => spot.cost % 1 !== 0), "coste decimal");
    assert.ok(spots.some((spot) => spot.openingTime === "00:00" && spot.closingTime === "00:00"), "abierto 24 horas");
    assert.ok(spots.some((spot) => spot.positionConstraint === "locked"), "parada fija");
    assert.ok(spots.some((spot) => spot.kind === "waypoint" && spot.category !== "transport"), "punto de paso fuera de transporte");
    assert.notEqual(new Set(names).size, names.length, "nombres de parada duplicados");

    assert.ok(plan.days.some((day) => day.title === ""), "día sin título");
    assert.ok(plan.days.some((day) => day.startTime === undefined), "día sin hora de inicio");
    assert.ok(plan.backlogGroups.some((group) => group.collapsed), "grupo plegado");
    assert.ok(plan.backlogGroups.some((group) => !plan.backlog.some((spot) => spot.backlogGroupId === group.id)), "grupo vacío");
    assert.ok(plan.backlog.some((spot) => !spot.backlogGroupId), "pendiente sin grupo");

    const disconnected = disconnectedTravelLegs(plan.travelLegs, plan.days).map(([key]) => key);
    assert.ok(disconnected.includes("s-02-sensoji>s-02-ueno"), "trayecto entre paradas no contiguas");
    assert.ok(disconnected.includes("s-05-ryokan>s-06-kyoto-st"), "trayecto entre días");

    assert.ok(plan.reminders.some((reminder) => reminder.pendingSpotAnchor), "recordatorio sin parada");
    assert.ok(plan.reminders.some((reminder) => plan.backlog.some((spot) => spot.id === reminder.spotId)), "recordatorio de un pendiente");
    assert.ok(plan.reminders.some((reminder) => reminder.timing.type === "fixed" && reminder.timing.date < "2026-10-01"), "recordatorio pasado");
    assert.ok(plan.tripNotePages.some((page) => page.content === ""), "página de notas vacía");
});
