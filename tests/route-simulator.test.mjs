import test from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.document = { querySelector: () => null };

const { formatSimulationTime, optimizeRoute, simulateOrder } = await import("../js/features/route-simulator/optimizer.js");
const { establishedBaseline } = await import("../js/features/route-simulator/baseline.js");
const { brokenDepartureLegs, brokenVisitedStops, departureLockedLegs, directedLegKey, seedEstablishedLegs, visitedLockedStops } = await import("../js/features/route-simulator/legs.js");
const { applySimulationToDay, simulationDayFingerprint } = await import("../js/features/route-simulator/application.js");
const { fetchTravelMatrix } = await import("../js/features/route-simulator/travel-matrix.js");
const { downloadPlanExport } = await import("../js/features/planner/export-plan.js");

function matrix(rows) { return rows; }

test("aplicar una simulación conserva los huecos no seleccionados y actualiza horarios", () => {
    const day = {
        id: "dia",
        title: "Centro",
        spots: [
            { id: "a", name: "A", plannedStart: "08:00" },
            { id: "fuera", name: "No simulada", note: "Conservar" },
            { id: "b", name: "B" },
        ],
    };
    const applied = applySimulationToDay(day, ["a", "b"], {
        start: 9 * 60,
        steps: [
            { spot: day.spots[2], start: 9 * 60 },
            { spot: day.spots[0], start: 10 * 60 + 15 },
        ],
    });

    assert.deepEqual(applied.spots.map((spot) => spot.id), ["b", "fuera", "a"]);
    assert.equal(applied.spots[0].plannedStart, "09:00");
    assert.equal(applied.spots[1], day.spots[1]);
    assert.equal(applied.spots[2].plannedStart, "10:15");
    assert.equal(applied.startTime, "09:00");
    assert.equal(day.spots[0].plannedStart, "08:00");
});

test("aplicar una ruta circular no duplica la parada de regreso", () => {
    const day = { id: "dia", spots: [{ id: "hotel" }, { id: "museo" }] };
    const applied = applySimulationToDay(day, ["hotel", "museo"], {
        start: 23 * 60 + 45,
        steps: [
            { spot: day.spots[0], start: 23 * 60 + 45 },
            { spot: day.spots[1], start: 24 * 60 + 30 },
            { spot: day.spots[0], start: 25 * 60 },
        ],
    });

    assert.deepEqual(applied.spots.map((spot) => spot.id), ["hotel", "museo"]);
    assert.deepEqual(applied.spots.map((spot) => spot.plannedStart), ["23:45", "00:30"]);
});

test("la huella del día detecta cambios posteriores al cálculo", () => {
    const day = { id: "dia", spots: [{ id: "a" }] };
    const before = simulationDayFingerprint(day);
    day.spots[0].name = "Cambiada";
    assert.notEqual(simulationDayFingerprint(day), before);
});

test("sin red la matriz conserva una simulación aproximada aplicable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("offline"); };
    try {
        const result = await fetchTravelMatrix([
            { lat: 40.4168, lng: -3.7038 },
            { lat: 40.4230, lng: -3.7110 },
        ], "walking");
        assert.equal(result.approximate, true);
        assert.equal(result.minutes.length, 2);
        assert.ok(result.minutes[0][1] > 0);
        assert.equal(result.minutes[0][0], 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("la copia preventiva usa el mismo JSON portable y nombre de descarga", () => {
    const originalDocument = globalThis.document;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    let clicked = false;
    let revoked = "";
    const link = { href: "", download: "", click: () => { clicked = true; } };
    globalThis.document = { ...originalDocument, createElement: () => link };
    URL.createObjectURL = (blob) => {
        assert.equal(blob.type, "application/json");
        return "blob:plan-export";
    };
    URL.revokeObjectURL = (url) => { revoked = url; };
    try {
        downloadPlanExport();
        assert.equal(clicked, true);
        assert.match(link.download, /^ruta-.+\.json$/);
        assert.equal(link.href, "blob:plan-export");
        assert.equal(revoked, "blob:plan-export");
    } finally {
        globalThis.document = originalDocument;
        URL.createObjectURL = originalCreateObjectURL;
        URL.revokeObjectURL = originalRevokeObjectURL;
    }
});

test("el simulador prioriza llegar a una cita antes que ahorrar trayecto", () => {
    const spots = [
        { id: "lejos", name: "Cita", plannedStart: "10:00", visitMinutes: 30 },
        { id: "cerca", name: "Café", visitMinutes: 30 },
        { id: "museo", name: "Museo", visitMinutes: 30 },
    ];
    const result = optimizeRoute(spots, matrix([
        [0, 5, 5],
        [40, 0, 5],
        [40, 5, 0],
    ]), { fixedStart: 9 * 60 + 30 });
    assert.equal(result.steps[0].spot.id, "lejos");
    assert.equal(result.metrics.lateStops, 0);
});

test("una salida flexible se ajusta a la primera cita sin guardar nada", () => {
    const spots = [
        { id: "a", name: "A", visitMinutes: 20 },
        { id: "b", name: "B", plannedStart: "11:00", visitMinutes: 30 },
    ];
    const result = optimizeRoute(spots, matrix([[0, 10], [10, 0]]));
    const appointment = result.steps.find((step) => step.spot.id === "b");
    assert.equal(appointment.start, 11 * 60);
    assert.equal(result.metrics.waiting, 0);
    assert.equal(result.metrics.lateStops, 0);
});

test("el simulador espera a la apertura y aprovecha antes una parada disponible", () => {
    const spots = [
        { id: "museo", name: "Museo", openingTime: "10:00", closingTime: "12:00", visitMinutes: 30 },
        { id: "cafe", name: "Café", visitMinutes: 30 },
    ];
    const result = optimizeRoute(spots, matrix([[0, 5], [5, 0]]), { fixedStart: 540 });
    assert.deepEqual(result.steps.map((step) => step.spot.id), ["cafe", "museo"]);
    const museum = result.steps.find((step) => step.spot.id === "museo");
    assert.equal(museum.start, 600);
    assert.equal(museum.wait, 25);
    assert.equal(result.metrics.outsideStops, 0);
});

test("la optimización coloca primero una visita que debe terminar antes del cierre", () => {
    const spots = [
        { id: "temprano", name: "Mercado", openingTime: "09:00", closingTime: "10:00", visitMinutes: 45 },
        { id: "libre", name: "Paseo", visitMinutes: 30 },
    ];
    const result = optimizeRoute(spots, matrix([[0, 5], [5, 0]]), { fixedStart: 540 });
    assert.equal(result.steps[0].spot.id, "temprano");
    assert.equal(result.steps[0].finish, 585);
    assert.equal(result.metrics.scheduleConflictStops, 0);
});

test("un horario imposible informa los minutos de visita fuera de la ventana", () => {
    const spots = [
        { id: "previa", name: "Parada fijada", visitMinutes: 5 },
        { id: "larga", name: "Visita larga", openingTime: "09:00", closingTime: "10:00", visitMinutes: 90 },
    ];
    const result = optimizeRoute(spots, matrix([[0, 1], [1, 0]]), {
        fixedStart: 540,
        firstSpotIndex: 0,
    });
    const longVisit = result.steps.find((step) => step.spot.id === "larga");
    assert.equal(longVisit.outsideSchedule, true);
    assert.equal(longVisit.outsideMinutes, 36);
    assert.equal(result.metrics.outsideStops, 1);
    assert.equal(result.metrics.totalOutside, 36);
});

test("los puntos de paso y las paradas sin horario aplicable no crean conflictos", () => {
    const spots = [
        { id: "paso", name: "Mirador", kind: "waypoint", openingTime: "12:00", closingTime: "12:30" },
        { id: "libre", name: "Exterior", scheduleNotApplicable: true, openingTime: "12:00", closingTime: "12:30", visitMinutes: 60 },
    ];
    const result = optimizeRoute(spots, matrix([[0, 5], [5, 0]]), { fixedStart: 540 });
    assert.equal(result.metrics.scheduleConflictStops, 0);
    assert.ok(result.steps.every((step) => step.schedule === null));
});

test("una duración ausente se trata como cero", () => {
    const spots = [
        { id: "a", name: "A" },
        { id: "b", name: "B", visitMinutes: 15 },
    ];
    const result = optimizeRoute(spots, matrix([[0, 7], [7, 0]]), { fixedStart: 540 });
    assert.equal(result.metrics.visit, 15);
    assert.ok(result.steps.some((step) => step.spot.id === "a" && step.duration === 0));
});

test("una primera y una última parada permanecen fijadas", () => {
    const spots = [
        { id: "hotel-a", name: "Hotel de salida" },
        { id: "museo", name: "Museo" },
        { id: "parque", name: "Parque" },
        { id: "hotel-b", name: "Hotel de llegada" },
    ];
    const result = optimizeRoute(spots, matrix([
        [0, 8, 5, 20],
        [8, 0, 3, 6],
        [5, 3, 0, 9],
        [20, 6, 9, 0],
    ]), { firstSpotIndex: 0, lastSpotIndex: 3 });
    assert.equal(result.steps[0].spot.id, "hotel-a");
    assert.equal(result.steps.at(-1).spot.id, "hotel-b");
});

test("una parada fijada conserva su posición aunque el trayecto sea menos óptimo", () => {
    const spots = [
        { id: "hotel", name: "Hotel" },
        { id: "kimono", name: "Alquiler de kimonos" },
        { id: "museo", name: "Museo" },
        { id: "parque", name: "Parque" },
    ];
    const travel = matrix([
        [0, 50, 1, 20],
        [50, 0, 20, 1],
        [1, 20, 0, 1],
        [20, 1, 1, 0],
    ]);
    const free = optimizeRoute(spots, travel, { firstSpotIndex: 0 });
    const fixed = optimizeRoute(spots, travel, { firstSpotIndex: 0, fixedSpotIndexes: [1] });
    assert.notEqual(free.order[1], 1);
    assert.equal(fixed.order[0], 0);
    assert.equal(fixed.order[1], 1);
    assert.ok(fixed.metrics.travel > free.metrics.travel);
});

test("una ruta circular vuelve a la misma parada sin contar dos visitas", () => {
    const spots = [
        { id: "hotel", name: "Hotel", visitMinutes: 15 },
        { id: "museo", name: "Museo", visitMinutes: 60 },
        { id: "parque", name: "Parque", visitMinutes: 30 },
    ];
    const result = optimizeRoute(spots, matrix([
        [0, 10, 8],
        [10, 0, 4],
        [8, 4, 0],
    ]), { firstSpotIndex: 0, lastSpotIndex: 0, fixedStart: 540 });
    assert.deepEqual(result.order, [0, 1, 2, 0]);
    assert.equal(result.steps.at(-1).repeated, true);
    assert.equal(result.steps.at(-1).duration, 0);
    assert.equal(result.metrics.visit, 105);
});

test("un tiempo de trayecto manual puede cambiar el orden óptimo", () => {
    const spots = [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
        { id: "c", name: "C" },
    ];
    const travel = matrix([
        [0, 1, 10],
        [1, 0, 1],
        [10, 1, 0],
    ]);
    const before = optimizeRoute(spots, travel, { fixedStart: 540 });
    travel[0][1] = 20;
    travel[1][0] = 20;
    const after = optimizeRoute(spots, travel, { fixedStart: 540 });
    assert.equal(before.metrics.travel, 2);
    assert.equal(after.metrics.travel, 11);
    assert.notDeepEqual(after.order, before.order);
    assert.equal(after.order.some((spotIndex, index) => index > 0 && new Set([spotIndex, after.order[index - 1]]).has(0) && new Set([spotIndex, after.order[index - 1]]).has(1)), false);
});

// Menos trayecto no es menos tiempo: los minutos de espera se gastan igual.
test("el simulador prefiere terminar antes aunque camine más", () => {
    const spots = [
        { id: "hotel", name: "Hotel", visitMinutes: 30 },
        { id: "museo", name: "Museo", openingTime: "10:00", closingTime: "21:00", visitMinutes: 30 },
        { id: "parque", name: "Parque", visitMinutes: 30 },
    ];
    // hotel > museo es el tramo corto, pero deja 3 h de espera hasta la apertura.
    const result = optimizeRoute(spots, matrix([
        [0, 10, 60],
        [10, 0, 10],
        [60, 10, 0],
    ]), { fixedStart: 6 * 60, firstSpotIndex: 0 });
    assert.deepEqual(result.steps.map((step) => step.spot.id), ["hotel", "parque", "museo"]);
    assert.equal(result.finish, 10 * 60 + 30);
    assert.equal(result.metrics.travel, 70);

    const cheaperTravel = simulateOrder(spots, [0, 1, 2], matrix([
        [0, 10, 60],
        [10, 0, 10],
        [60, 10, 0],
    ]), { fixedStart: 6 * 60 });
    assert.equal(cheaperTravel.metrics.travel, 20);
    assert.ok(cheaperTravel.finish > result.finish);
});

// El desempate final del score elige la salida más cercana a la hora de
// referencia. Prefiriendo la más tardía, este día se iba a las 19:00.
test("una salida flexible no se va a la noche para desempatar", () => {
    const spots = [
        { id: "a", name: "A", visitMinutes: 60 },
        { id: "b", name: "B", openingTime: "09:00", closingTime: "20:00", visitMinutes: 60 },
        { id: "c", name: "C", visitMinutes: 60 },
    ];
    const result = optimizeRoute(spots, matrix([
        [0, 10, 10],
        [10, 0, 10],
        [10, 10, 0],
    ]));
    assert.equal(result.start, 9 * 60);
    assert.equal(result.finish, 12 * 60 + 20);
});

test("una apertura tardía sigue retrasando la salida lo justo", () => {
    const spots = [
        { id: "a", name: "A", visitMinutes: 60 },
        { id: "museo", name: "Museo", openingTime: "14:00", closingTime: "18:00", visitMinutes: 60 },
    ];
    const result = optimizeRoute(spots, matrix([[0, 15], [15, 0]]));
    assert.equal(result.start, 12 * 60 + 45);
    assert.equal(result.metrics.waiting, 0);
});

test("las horas que cruzan medianoche son legibles", () => {
    assert.equal(formatSimulationTime(25 * 60 + 5), "01:05 (+1 d)");
});

// --- El lado "Antes" de la comparativa ---

const NOT_TODAY = new Date("2026-07-19T12:00:00");

test("el «antes» conserva el orden guardado aunque sea el peor posible", () => {
    const day = { date: "2026-07-20", startTime: "09:00", spots: [] };
    const spots = [
        { id: "a", name: "A", visitMinutes: 30 },
        { id: "b", name: "B", visitMinutes: 30 },
        { id: "c", name: "C", visitMinutes: 30 },
    ];
    const baseline = establishedBaseline(day, spots, {
        now: NOT_TODAY,
        travelForLeg: (from, to) => ({ minutes: from.id === "a" && to.id === "b" ? 90 : 5, profile: "walking" }),
    });
    assert.deepEqual(baseline.steps.map((step) => step.spot.id), ["a", "b", "c"]);
    assert.deepEqual(baseline.order, [0, 1, 2]);
    assert.equal(baseline.metrics.travel, 95);
});

test("el «antes» arranca en la hora de inicio del día, sin buscar una mejor", () => {
    const day = { date: "2026-07-20", startTime: "08:00", spots: [] };
    const spots = [
        { id: "a", name: "A", visitMinutes: 30 },
        { id: "b", name: "B", plannedStart: "12:00", visitMinutes: 30 },
    ];
    const baseline = establishedBaseline(day, spots, {
        now: NOT_TODAY,
        travelForLeg: () => ({ minutes: 10, profile: "walking" }),
    });
    assert.equal(baseline.start, 8 * 60);
    assert.equal(baseline.steps[0].start, 8 * 60);
    assert.equal(baseline.steps[1].start, 12 * 60);
    assert.equal(baseline.finish, 12 * 60 + 30);
});

test("el «antes» usa la duración establecida del tramo y no una medida nueva", () => {
    const day = { date: "2026-07-20", startTime: "09:00", spots: [] };
    const spots = [
        { id: "a", name: "A", visitMinutes: 20 },
        { id: "b", name: "B", visitMinutes: 20 },
    ];
    const baseline = establishedBaseline(day, spots, {
        now: NOT_TODAY,
        travelForLeg: () => ({ minutes: 47, overridden: true, mode: "train", profile: "walking" }),
    });
    assert.equal(baseline.steps[1].travel, 47);
    assert.equal(baseline.metrics.travel, 47);
    assert.equal(baseline.steps[1].start, 9 * 60 + 20 + 47);
});

// Mismo escenario que "el simulador espera a la apertura y aprovecha antes una
// parada disponible": el optimizador reordena para no perder la hora, el «antes»
// se come la espera porque es lo que el itinerario tiene establecido hoy.
test("el «antes» asume la espera a la apertura en vez de reordenar para evitarla", () => {
    const day = { date: "2026-07-20", startTime: "09:00", spots: [] };
    const spots = [
        { id: "museo", name: "Museo", openingTime: "10:00", closingTime: "12:00", visitMinutes: 30 },
        { id: "cafe", name: "Café", visitMinutes: 30 },
    ];
    const baseline = establishedBaseline(day, spots, {
        now: NOT_TODAY,
        travelForLeg: () => ({ minutes: 5, profile: "walking" }),
    });
    assert.deepEqual(baseline.steps.map((step) => step.spot.id), ["museo", "cafe"]);
    assert.equal(baseline.steps[0].start, 600);
    assert.equal(baseline.metrics.waiting, 60);

    const optimized = optimizeRoute(spots, matrix([[0, 5], [5, 0]]), { fixedStart: 540 });
    assert.deepEqual(optimized.steps.map((step) => step.spot.id), ["cafe", "museo"]);
    assert.equal(optimized.metrics.waiting, 25);
});

test("el «antes» informa los minutos fuera de horario sin tocar la visita", () => {
    const day = { date: "2026-07-20", startTime: "09:00", spots: [] };
    const spots = [
        { id: "museo", name: "Museo", openingTime: "09:00", closingTime: "10:00", visitMinutes: 90 },
    ];
    const baseline = establishedBaseline(day, spots, { now: NOT_TODAY, travelForLeg: () => null });
    assert.equal(baseline.steps[0].start, 9 * 60);
    assert.equal(baseline.steps[0].outsideSchedule, true);
    assert.equal(baseline.steps[0].outsideMinutes, 30);
    assert.equal(baseline.metrics.scheduleConflictStops, 1);
});

test("el «antes» marca como retraso la cita a la que no se puede llegar", () => {
    const day = { date: "2026-07-20", startTime: "09:00", spots: [] };
    const spots = [
        { id: "larga", name: "Visita larga", visitMinutes: 180 },
        { id: "cita", name: "Cita", plannedStart: "10:00", visitMinutes: 30 },
    ];
    const baseline = establishedBaseline(day, spots, {
        now: NOT_TODAY,
        travelForLeg: () => ({ minutes: 10, profile: "walking" }),
    });
    const appointment = baseline.steps[1];
    assert.equal(appointment.arrival, 12 * 60 + 10);
    assert.equal(appointment.late, 130);
    assert.equal(baseline.metrics.lateStops, 1);
});

test("una selección vacía no produce comparativa", () => {
    assert.equal(establishedBaseline({ spots: [] }, [], { now: NOT_TODAY }), null);
});

// La proyección del planificador declina modelar ventanas nocturnas y respeta
// las horas guardadas aunque la parada las tenga marcadas como no aplicables.
// El optimizador hace lo contrario en ambos casos. Si cada lado de la
// comparativa usa su propia regla, la diferencia entre reglamentos se presenta
// al viajero como una mejora que no existe.

test("el «antes» aplica el modelo horario del optimizador a una ventana nocturna", () => {
    const day = { date: "2026-07-20", startTime: "09:00", spots: [] };
    const baseline = establishedBaseline(day, [
        { id: "bar", name: "Bar", openingTime: "20:00", closingTime: "02:00", visitMinutes: 120 },
    ], { now: NOT_TODAY, travelForLeg: () => null });
    assert.equal(baseline.steps[0].outsideSchedule, true);
    assert.equal(baseline.steps[0].outsideMinutes, 120);
    assert.equal(baseline.metrics.scheduleConflictStops, 1);
});

test("el «antes» no inventa un conflicto en una parada sin horario aplicable", () => {
    const day = { date: "2026-07-20", startTime: "09:00", spots: [] };
    const baseline = establishedBaseline(day, [
        { id: "paseo", name: "Paseo", scheduleNotApplicable: true, openingTime: "12:00", closingTime: "13:00", visitMinutes: 180 },
    ], { now: NOT_TODAY, travelForLeg: () => null });
    assert.equal(baseline.steps[0].outsideSchedule, false);
    assert.equal(baseline.metrics.scheduleConflictStops, 0);
});

// Una visita ya marcada como hecha ancla la parada en la hora real y deja su
// tramo de entrada en 0. Ese 0 es un registro del pasado, no una medida del
// trayecto: sembrarlo en la matriz le diría al optimizador que ese par es
// gratis. El paso lo señala para que el simulador pueda descartarlo.
test("el «antes» señala la visita ya realizada para no sembrar su tramo a cero", () => {
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const baseline = establishedBaseline({ date: key, startTime: "09:00", spots: [] }, [
        { id: "a", name: "A", visitMinutes: 30 },
        { id: "b", name: "B", visitMinutes: 30, visitedAt: `${key}T11:00:00` },
        { id: "c", name: "C", visitMinutes: 30 },
    ], { travelForLeg: () => ({ minutes: 45, profile: "walking" }) });
    assert.equal(baseline.steps[1].actual, true);
    assert.equal(baseline.steps[1].travel, 0);
    assert.equal(baseline.steps[2].actual, false);
    assert.equal(baseline.steps[2].travel, 45);
});

// --- Tramos que el optimizador no puede reprogramar ---

test("el «antes» expone el tramo con hora de salida fija", () => {
    const baseline = establishedBaseline({ date: "2026-07-20", startTime: "09:00", spots: [] }, [
        { id: "a", name: "Hotel", visitMinutes: 20 },
        { id: "b", name: "Kioto", visitMinutes: 20 },
    ], {
        now: NOT_TODAY,
        travelForLeg: () => ({ minutes: 40, fixedDeparture: true, departureTime: "09:40", profile: "walking" }),
    });
    assert.equal(baseline.steps[1].fixedDeparture, true);
    assert.equal(baseline.steps[1].departureTime, "09:40");
    const legs = departureLockedLegs(baseline);
    assert.equal(legs.length, 1);
    assert.deepEqual([legs[0].fromIndex, legs[0].toIndex], [0, 1]);
    assert.equal(legs[0].departureTime, "09:40");
});

// El tren de las 09:40 no sale a otra hora porque el orden sea más corto.
test("un tramo con hora de salida fija conserva su posición aunque cueste trayecto", () => {
    const spots = [
        { id: "a", name: "A" },
        { id: "salida", name: "Estación de salida" },
        { id: "llegada", name: "Estación de llegada" },
        { id: "d", name: "D" },
    ];
    const travel = matrix([
        [0, 50, 1, 50],
        [50, 0, 1, 1],
        [1, 1, 0, 50],
        [50, 1, 50, 0],
    ]);
    const libre = optimizeRoute(spots, travel, { firstSpotIndex: 0 });
    const anclado = optimizeRoute(spots, travel, { firstSpotIndex: 0, fixedSpotIndexes: [1, 2] });
    assert.deepEqual(libre.order, [0, 2, 1, 3]);
    assert.deepEqual(anclado.order, [0, 1, 2, 3]);
    assert.ok(anclado.metrics.travel > libre.metrics.travel);
});

test("una cadena de salida fija rota por otra restricción se detecta", () => {
    const legs = [{ fromIndex: 1, toIndex: 2, fromName: "Salida", toName: "Llegada", departureTime: "09:40" }];
    const rota = { steps: [{ spotIndex: 0 }, { spotIndex: 2 }, { spotIndex: 1 }] };
    const intacta = { steps: [{ spotIndex: 0 }, { spotIndex: 1 }, { spotIndex: 2 }] };
    assert.equal(brokenDepartureLegs(rota, legs).length, 1);
    assert.equal(brokenDepartureLegs(intacta, legs).length, 0);
});

test("el sembrado aplica los tramos del plan y descarta el de una visita ya hecha", () => {
    const baseline = { steps: [
        { spotIndex: 0, travel: 0, actual: false },
        { spotIndex: 1, travel: 0, actual: true },
        { spotIndex: 2, travel: 45, actual: false },
    ] };
    const travelMinutes = [[0, 12, 12], [12, 0, 12], [12, 12, 0]];
    const seeded = seedEstablishedLegs(travelMinutes, baseline);
    // El 0 de la visita ya hecha es un registro del pasado: la matriz conserva
    // su medida y el optimizador no cree que ese par sea gratis.
    assert.equal(travelMinutes[0][1], 12);
    assert.equal(travelMinutes[1][0], 12);
    assert.equal(travelMinutes[1][2], 45);
    // El plan solo dice cuánto cuesta 1 → 2. La vuelta conserva lo medido.
    assert.equal(travelMinutes[2][1], 12);
    assert.deepEqual([...seeded.keys()], [directedLegKey(1, 2)]);
    assert.equal(seeded.has(directedLegKey(2, 1)), false);
});

// Un mirador en lo alto de una cuesta: subir cuesta 40 minutos y bajar 10. Si el
// sembrado copiara la subida sobre la bajada, el optimizador descartaría el único
// orden que aprovecha la cuesta a favor y recomendaría más del doble de camino.
test("el sembrado conserva la asimetría del sentido que el plan no recorre", () => {
    const spots = [
        { id: "plaza", name: "Plaza", visitMinutes: 30 },
        { id: "mirador", name: "Mirador", visitMinutes: 30 },
        { id: "museo", name: "Museo", visitMinutes: 60 },
    ];
    const travelMinutes = matrix([
        [0, 40, 10],
        [10, 0, 35],
        [10, 35, 0],
    ]);
    // El día establecido sube al mirador, y tiene esos 40 minutos configurados.
    const baseline = { steps: [
        { spotIndex: 0, travel: 0, actual: false },
        { spotIndex: 1, travel: 40, actual: false },
    ] };
    seedEstablishedLegs(travelMinutes, baseline);
    assert.equal(travelMinutes[0][1], 40);
    assert.equal(travelMinutes[1][0], 10);

    const result = optimizeRoute(spots, travelMinutes, { fixedStart: 9 * 60 });
    assert.deepEqual(result.steps.map((step) => step.spot.id), ["mirador", "plaza", "museo"]);
    assert.equal(result.metrics.travel, 20);
});

// --- El pasado no se reordena ---

// El optimizador puntúa una visita ya hecha como a cualquier otra parada y la
// mueve si eso acorta el día. El ahorro resultante exigiría des-visitarla.
test("una visita ya realizada se ancla en su posición establecida", () => {
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const baseline = establishedBaseline({ date: key, startTime: "09:00", spots: [] }, [
        { id: "a", name: "A", visitMinutes: 30 },
        { id: "b", name: "B", visitMinutes: 30, visitedAt: `${key}T11:00:00` },
        { id: "c", name: "C", visitMinutes: 30 },
    ], { travelForLeg: () => ({ minutes: 20, profile: "walking" }) });
    const visited = visitedLockedStops(baseline);
    assert.equal(visited.length, 1);
    assert.deepEqual([visited[0].spotIndex, visited[0].position, visited[0].name], [1, 1, "B"]);
});

test("un día sin visitas hechas no ancla nada y un «antes» ausente tampoco", () => {
    const baseline = establishedBaseline({ date: "2026-07-20", startTime: "09:00", spots: [] }, [
        { id: "a", name: "A", visitMinutes: 30 },
        { id: "b", name: "B", visitMinutes: 30 },
    ], { now: NOT_TODAY, travelForLeg: () => ({ minutes: 10, profile: "walking" }) });
    assert.deepEqual(visitedLockedStops(baseline), []);
    assert.deepEqual(visitedLockedStops(null), []);
});

// El anclaje se traduce en fixedSpotIndexes: la parada visitada conserva su
// posición aunque el orden libre sea más corto.
test("anclar la visita hecha impide que el optimizador la mueva al final", () => {
    const spots = [
        { id: "a", name: "A" },
        { id: "hecha", name: "Visitada" },
        { id: "c", name: "C" },
    ];
    const travel = matrix([
        [0, 50, 1],
        [50, 0, 50],
        [1, 50, 0],
    ]);
    const libre = optimizeRoute(spots, travel, { firstSpotIndex: 0 });
    const anclada = optimizeRoute(spots, travel, { firstSpotIndex: 0, fixedSpotIndexes: [1] });
    assert.deepEqual(libre.order, [0, 2, 1]);
    assert.deepEqual(anclada.order, [0, 1, 2]);
});

test("una visita hecha desalojada por otra restricción se detecta", () => {
    const visited = [{ spotIndex: 0, position: 0, name: "Visitada" }];
    const rota = { steps: [{ spotIndex: 2 }, { spotIndex: 0 }, { spotIndex: 1 }] };
    const intacta = { steps: [{ spotIndex: 0 }, { spotIndex: 1 }, { spotIndex: 2 }] };
    assert.equal(brokenVisitedStops(rota, visited).length, 1);
    assert.equal(brokenVisitedStops(intacta, visited).length, 0);
});

// ---- Route schematic ----
const { projectRoute, viewForSpots, routeMapMarkup, isLocated, routeNodes, separateNodes } = await import("../js/features/route-simulator/route-map.js");

function spot(id, lat, lng, name = `Parada ${id}`) {
    return { id, lat, lng, name };
}
function stepsOf(spots) {
    return spots.map((s, i) => ({ spot: s, spotIndex: i }));
}

test("la proyección conserva la forma del día en un único factor de escala", () => {
    const view = { width: 400, height: 400, padding: 20 };
    // Un cuadrado de 0,02° de lado debe dibujarse como un cuadrado, no como un
    // rectángulo estirado hasta llenar cada eje por separado.
    const projection = projectRoute([
        spot(1, 35.68, 139.70), spot(2, 35.70, 139.70),
        spot(3, 35.70, 139.72), spot(4, 35.68, 139.72),
    ], view);
    const a = projection.at(spot(1, 35.68, 139.70));
    const b = projection.at(spot(2, 35.70, 139.70));
    const c = projection.at(spot(4, 35.68, 139.72));
    const vertical = Math.abs(b.y - a.y);
    const horizontal = Math.abs(c.x - a.x);
    // Un grado de longitud cubre menos suelo que uno de latitud (cos(lat)), y
    // Mercator es conforme, así que ese cuadrado en grados se dibuja más alto
    // que ancho en la proporción 1/cos(lat).
    assert.ok(Math.abs(vertical / horizontal - 1 / Math.cos((35.69 * Math.PI) / 180)) < 0.01);
});

test("la proyección cabe dentro del área útil y no se sale del lienzo", () => {
    const view = { width: 400, height: 300, padding: 25 };
    const spots = [spot(1, 40.4, -3.7), spot(2, 41.4, 2.17), spot(3, 37.39, -5.99)];
    const projection = projectRoute(spots, view);
    for (const s of spots) {
        const point = projection.at(s);
        assert.ok(point.x >= view.padding - 0.01 && point.x <= view.width - view.padding + 0.01);
        assert.ok(point.y >= view.padding - 0.01 && point.y <= view.height - view.padding + 0.01);
    }
});

test("una sola parada, o varias en el mismo punto, no rompen la proyección", () => {
    const single = projectRoute([spot(1, 35.68, 139.7)]);
    assert.ok(Number.isFinite(single.scale) && single.scale > 0);
    assert.ok(Number.isFinite(single.at(spot(1, 35.68, 139.7)).x));
    const identical = projectRoute([spot(1, 35.68, 139.7), spot(2, 35.68, 139.7)]);
    assert.ok(Number.isFinite(identical.at(spot(2, 35.68, 139.7)).y));
});

test("paradas sobre un mismo meridiano toman la escala del eje que sí tiene extensión", () => {
    const view = { width: 400, height: 400, padding: 20 };
    const projection = projectRoute([spot(1, 35.60, 139.7), spot(2, 35.80, 139.7)], view);
    const top = projection.at(spot(2, 35.80, 139.7));
    const bottom = projection.at(spot(1, 35.60, 139.7));
    assert.equal(Math.round(top.y), view.padding);
    assert.equal(Math.round(bottom.y), view.height - view.padding);
    assert.equal(Math.round(top.x), view.width / 2);
});

test("el lienzo toma la proporción del día en lugar de un marco apaisado fijo", () => {
    // Norte-sur: alto. Este-oeste: apaisado. Nunca al revés.
    const northSouth = viewForSpots([spot(1, 35.60, 139.70), spot(2, 35.90, 139.70)]);
    const eastWest = viewForSpots([spot(1, 35.70, 139.50), spot(2, 35.70, 139.90)]);
    assert.ok(northSouth.height > eastWest.height);
    assert.ok(eastWest.height < eastWest.width);
});

test("la comparativa reserva un contenedor Leaflet con proporción estable", () => {
    const spots = [spot(1, 35.68, 139.70, "A"), spot(2, 35.70, 139.72, "B"), spot(3, 35.66, 139.69, "C")];
    const result = { steps: stepsOf([spots[1], spots[0], spots[2]]) };
    const baseline = { steps: stepsOf(spots) };
    const markup = routeMapMarkup(baseline, result);
    const view = viewForSpots([...spots, ...spots]);
    assert.match(markup, /data-route-simulator-map/);
    assert.match(markup, new RegExp(`aspect-ratio:${view.width}/${view.height}`));
    assert.match(markup, /Orden actual/);
    assert.match(markup, /Orden propuesto/);
});

test("una parada revisitada sigue produciendo una única comparativa", () => {
    const spots = [spot(1, 35.68, 139.70, "A"), spot(2, 35.70, 139.72, "B")];
    const result = { steps: [...stepsOf(spots), { spot: spots[0], spotIndex: 0 }] };
    const markup = routeMapMarkup({ steps: stepsOf(spots) }, result);
    assert.equal(markup.match(/data-route-simulator-map/g).length, 1);
});

test("el esquema se omite cuando no hay dos paradas ubicadas que comparar", () => {
    const only = { steps: stepsOf([spot(1, 35.68, 139.70)]) };
    assert.equal(routeMapMarkup(only, only), "");
    const unlocated = { steps: stepsOf([{ id: 9, name: "Sin coordenadas" }]) };
    assert.equal(routeMapMarkup(unlocated, unlocated), "");
    assert.equal(isLocated({ lat: 1, lng: null }), false);
});

test("los nombres de parada no se interpolan en el HTML del mapa", () => {
    const spots = [spot(1, 35.68, 139.70, '<script>"x"'), spot(2, 35.70, 139.72, "B")];
    const markup = routeMapMarkup({ steps: stepsOf(spots) }, { steps: stepsOf(spots) });
    assert.ok(!markup.includes("<script>"));
    assert.ok(!markup.includes("&lt;script&gt;"));
});

test("el mapa lleva una proporción explícita para no colapsar antes de montar Leaflet", () => {
    const spots = [spot(1, 35.68, 139.70, "A"), spot(2, 35.70, 139.72, "B")];
    const markup = routeMapMarkup({ steps: stepsOf(spots) }, { steps: stepsOf(spots) });
    const view = viewForSpots(spots);
    assert.match(markup, new RegExp(`aspect-ratio:${view.width}/${view.height}`));
});

test("las paradas amontonadas se separan y conservan un guía a su posición real", () => {
    const view = { width: 500, height: 500, padding: 26 };
    // La proyección siempre encaja al bounding box, así que un grupo compacto
    // sale ampliado y no solapa. El solape real lo provocan las paradas lejanas
    // que estiran el encuadre y aplastan el racimo del centro.
    const spots = [
        spot(1, 35.55, 139.60), spot(2, 35.85, 139.95), spot(3, 35.52, 139.98),
        ...Array.from({ length: 10 }, (_, i) =>
            spot(i + 4, 35.700 + (i % 4) * 0.0009, 139.750 + Math.floor(i / 4) * 0.0009)),
    ];
    const projection = projectRoute(spots, view);
    const nodes = separateNodes(routeNodes(stepsOf(spots), projection), 10, view);
    assert.equal(nodes.length, 13);
    for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
            const gap = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
            assert.ok(gap > 19, `los nodos ${i} y ${j} siguen solapados (${gap.toFixed(1)}px)`);
        }
    }
    assert.ok(nodes.some((node) => node.displaced), "ninguna parada quedó marcada como desplazada");
});

test("una ruta holgada no desplaza ninguna parada de su sitio", () => {
    const view = { width: 500, height: 500, padding: 26 };
    const spots = [spot(1, 35.60, 139.60), spot(2, 35.75, 139.80), spot(3, 35.50, 139.85)];
    const projection = projectRoute(spots, view);
    const nodes = separateNodes(routeNodes(stepsOf(spots), projection), 12, view);
    assert.ok(nodes.every((node) => !node.displaced));
    assert.ok(nodes.every((node) => node.x === node.anchorX && node.y === node.anchorY));
});

test("los nodos separados siguen cabiendo dentro del lienzo", () => {
    const view = { width: 400, height: 400, padding: 20 };
    const spots = Array.from({ length: 16 }, (_, i) => spot(i + 1, 35.68, 139.70 + i * 0.00005));
    const projection = projectRoute(spots, view);
    const nodes = separateNodes(routeNodes(stepsOf(spots), projection), 10, view);
    for (const node of nodes) {
        assert.ok(node.x >= 0 && node.x <= view.width, `x fuera del lienzo: ${node.x}`);
        assert.ok(node.y >= 0 && node.y <= view.height, `y fuera del lienzo: ${node.y}`);
    }
});

test("el mapa real delega la escala y la atribución en Leaflet", () => {
    const markup = routeMapMarkup(
        { steps: [] },
        { steps: stepsOf([spot(1, 35.60, 139.60), spot(2, 35.70, 139.85)]) },
    );
    assert.match(markup, /data-route-simulator-map/);
    assert.doesNotMatch(markup, /route-simulator-map-scale/);
});
