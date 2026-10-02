import test from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.document = { querySelector: () => null };
const { buildTimelineProjection } = await import("../js/features/timeline/timeline.js");
const {
    buildDayForecast,
    departureCue,
    formatDurationMinutes,
    paceLabel,
    visitLegs,
} = await import("../js/features/companion/day-forecast.js");
const { directionsUrl } = await import("../js/features/companion/navigation.js");

const walk15 = () => ({ minutes: 15, profile: "walking" });

function day(spots, date = "2026-07-20") {
    return { date, startTime: "09:00", spots };
}

function at(time, date = "2026-07-20") {
    return new Date(`${date}T${time}:00`);
}

const museum = () => ({ id: "museum", name: "Museo", visitMinutes: 60, lat: 35.68, lng: 139.76 });
const park = () => ({ id: "park", name: "Parque", visitMinutes: 60, lat: 35.69, lng: 139.77 });
const dinner = () => ({ id: "dinner", name: "Cena", visitMinutes: 90, lat: 35.7, lng: 139.78 });

test("la proyección en vivo no termina la parada pendiente antes de ahora", () => {
    const trip = day([museum(), park()]);
    const live = buildTimelineProjection(trip, { now: at("11:00"), travelForLeg: walk15, mode: "live" });
    // Museum planned 09:00-10:00 but not checked off at 11:00: the park waits.
    assert.equal(live.items[0].start, 540);
    assert.equal(live.items[1].start, 660 + 15);
    const plan = buildTimelineProjection(trip, { now: at("11:00"), travelForLeg: walk15, mode: "plan" });
    assert.equal(plan.items[1].start, 600 + 15);
    assert.equal(plan.isToday, false);
});

test("la proyección por defecto del planificador sigue arrancando en la hora actual", () => {
    const trip = { date: "2026-07-20", spots: [museum()] };
    const projection = buildTimelineProjection(trip, { now: at("11:00"), travelForLeg: walk15 });
    assert.equal(projection.items[0].start, 660);
});

test("el ritmo detecta retraso, adelanto, inicio pendiente y día completado", () => {
    const late = buildDayForecast(day([museum(), park()]), { now: at("11:00"), travelForLeg: walk15 });
    assert.equal(late.pace.status, "late");
    assert.equal(late.pace.minutes, 60);
    assert.equal(late.current.spot.id, "museum");
    assert.equal(late.remainingMinutes, (675 + 60) - 660);

    const doneEarly = museum();
    doneEarly.visitedAt = at("09:20").toISOString();
    const ahead = buildDayForecast(day([doneEarly, park()]), { now: at("09:25"), travelForLeg: walk15 });
    assert.equal(ahead.pace.status, "ahead");
    assert.equal(ahead.pace.minutes, 40);

    const upcoming = buildDayForecast(day([museum(), park()]), { now: at("08:00"), travelForLeg: walk15 });
    assert.equal(upcoming.pace.status, "upcoming");
    assert.equal(upcoming.pace.minutes, 60);
    assert.equal(upcoming.remainingMinutes, null);

    const onTime = buildDayForecast(day([museum(), park()]), { now: at("09:30"), travelForLeg: walk15 });
    assert.equal(onTime.pace.status, "on-time");

    const visited = museum();
    visited.visitedAt = at("10:00").toISOString();
    const done = buildDayForecast(day([visited]), { now: at("10:05"), travelForLeg: walk15 });
    assert.equal(done.pace.status, "done");
    assert.equal(paceLabel(done.pace), "Día completado");

    const otherDay = buildDayForecast(day([museum()], "2026-07-21"), { now: at("11:00"), travelForLeg: walk15 });
    assert.equal(otherDay.pace.status, "plan");
});

test("el retraso se propaga y avisa de cierres y reservas en riesgo", () => {
    const closing = { ...park(), closingTime: "12:00" };
    const reservation = { ...dinner(), plannedStart: "13:00", fixedStart: true };
    const forecast = buildDayForecast(day([museum(), closing, reservation]), {
        now: at("11:50"),
        travelForLeg: walk15,
    });
    const types = forecast.warnings.map((warning) => [warning.spot.id, warning.type]);
    assert.deepEqual(types, [["park", "closing"], ["dinner", "late-reservation"]]);
    assert.match(forecast.warnings[0].message, /cierra a las 12:00/);
});

test("los trayectos visibles agrupan los extremos embebidos", () => {
    const trip = day([
        museum(),
        { id: "station-a", name: "Estación A", kind: "waypoint" },
        { id: "station-b", name: "Estación B", kind: "waypoint" },
        park(),
    ]);
    const travel = (from, to) => from.id === "station-a"
        ? { minutes: 40, profile: "walking", mode: "train", line: "Shinkansen", note: "Andén 14" }
        : { minutes: 10, profile: "walking" };
    const projection = buildTimelineProjection(trip, { now: at("08:00"), travelForLeg: travel, mode: "plan" });
    const visible = new Set(["museum", "park"]);
    const legs = visitLegs(projection.items, (spot) => visible.has(spot.id));
    const leg = legs.get(projection.items[3].spot);
    assert.equal(leg.minutes, 60);
    assert.equal(leg.mode, "train");
    assert.equal(leg.line, "Shinkansen");
    assert.equal(leg.note, "Andén 14");
    assert.equal(legs.size, 1);
});

test("los enlaces de ruta usan el modo de transporte de Google Maps", () => {
    assert.equal(
        directionsUrl({ lat: 35.5, lng: 139.25 }, "metro"),
        "https://www.google.com/maps/dir/?api=1&destination=35.5%2C139.25&travelmode=transit",
    );
    assert.match(directionsUrl({ lat: 1, lng: 2 }, "cycling"), /travelmode=bicycling/);
    assert.doesNotMatch(directionsUrl({ lat: 1, lng: 2 }, "flight"), /travelmode/);
    assert.equal(directionsUrl({ name: "Sin coordenadas" }, "walking"), null);
});

test("las duraciones se formatean en horas y minutos", () => {
    assert.equal(formatDurationMinutes(45), "45 min");
    assert.equal(formatDurationMinutes(120), "2 h");
    assert.equal(formatDurationMinutes(200), "3 h 20 min");
});

test("la señal de salida resta el trayecto a la llegada", () => {
    const cue = departureCue({ start: 600, end: 660, legMinutes: 20, now: 560 });
    assert.deepEqual(cue, { lead: "Sal a las", time: "09:40", relative: "en 20 min" });
});

test("la señal de salida pide salir ya cuando no queda margen", () => {
    const cue = departureCue({ start: 600, end: 660, legMinutes: 20, now: 590 });
    assert.deepEqual(cue, { lead: "Sal ya", time: "", relative: "llegada 10:00" });
});

test("una salida fija manda sobre el cálculo del trayecto", () => {
    const cue = departureCue({ start: 600, end: 660, legMinutes: 50, departureTime: "09:05", now: 530 });
    assert.deepEqual(cue, { lead: "Sale a las", time: "09:05", relative: "en 15 min" });
});

test("durante la visita la señal indica hasta cuándo quedarse", () => {
    const cue = departureCue({ start: 600, end: 690, legMinutes: 20, now: 630 });
    assert.deepEqual(cue, { lead: "Hasta las", time: "11:30", relative: "quedan 1 h" });
});

test("la señal omite la cuenta atrás lejana y no la usa fuera de hoy", () => {
    assert.equal(departureCue({ start: 900, end: 960, now: 480 }).relative, "");
    assert.equal(departureCue({ start: 900, end: 960, now: 480 }).lead, "Empieza a las");
    assert.deepEqual(departureCue({ start: 600, end: 660, legMinutes: 20, now: 560, isToday: false }), { lead: "", time: "10:00", relative: "" });
    assert.equal(departureCue({ start: null }), null);
});

test("una parada sin trayecto que ya debería haber empezado pide ir ya", () => {
    const cue = departureCue({ start: 540, end: 660, now: 660 });
    assert.deepEqual(cue, { lead: "Ve ya", time: "", relative: "prevista 09:00" });
});
