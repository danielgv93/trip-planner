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
