import test from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.document = { querySelector: () => null };
const { buildTimelineProjection } = await import("../js/features/companion/timeline.js");

test("un waypoint es un hito sin duración de actividad", () => {
    const day = { date: "2026-07-20", startTime: "09:00", spots: [
        { id: "hotel", name: "Hotel", kind: "waypoint", visitMinutes: 60 },
        { id: "museum", name: "Museo", kind: "activity", visitMinutes: 90 },
    ] };
    const projection = buildTimelineProjection(day, { now: new Date("2026-07-19T12:00:00"), travelForLeg: () => ({ minutes: 15, profile: "walking" }) });
    assert.equal(projection.items[0].duration, 0);
    assert.equal(projection.items[0].waypoint, true);
    assert.equal(projection.items[0].opening, null);
    assert.equal(projection.items[0].closing, null);
    assert.equal(projection.items[1].start, 555);
});

test("un waypoint no reserva carril y marca conflicto si cae dentro de una visita", () => {
    const day = { date: "2026-07-20", startTime: "09:00", spots: [
        { id: "museum", name: "Museo", kind: "activity", visitMinutes: 90, plannedStart: "09:00" },
        { id: "meeting", name: "Encuentro", kind: "waypoint", plannedStart: "09:30" },
    ] };
    const projection = buildTimelineProjection(day, {
        now: new Date("2026-07-19T12:00:00"),
        travelForLeg: () => ({ minutes: 0, profile: "walking" }),
    });
    const [activity, waypoint] = projection.items;
    assert.equal(projection.lanes, 1);
    assert.equal(activity.lane, 0);
    assert.equal(waypoint.lane, 0);
    assert.deepEqual(activity.overlaps, []);
    assert.deepEqual(waypoint.overlaps, [[570, 570]]);
    assert.equal(waypoint.conflicts.some((item) => item.type === "visit-overlap"), true);
});

test("una salida fija espera o produce missed-departure", () => {
    const base = { date: "2026-07-20", startTime: "09:00", spots: [
        { id: "a", name: "Origen", kind: "activity", visitMinutes: 30 },
        { id: "b", name: "Destino", kind: "waypoint" },
    ] };
    const travelForLeg = () => ({ mode: "train", minutes: 45, departureTime: "10:00", fixedDeparture: true, profile: "walking" });
    const waits = buildTimelineProjection(base, { now: new Date("2026-07-19T12:00:00"), travelForLeg });
    assert.equal(waits.items[1].travelStart, 600);
    assert.equal(waits.items[1].travelWait, 30);
    const late = structuredClone(base);
    late.spots[0].visitMinutes = 70;
    const missed = buildTimelineProjection(late, { now: new Date("2026-07-19T12:00:00"), travelForLeg });
    assert.equal(missed.items[1].conflicts.find((item) => item.type === "missed-departure").minutes, 10);
});
