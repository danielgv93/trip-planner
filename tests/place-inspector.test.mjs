import assert from "node:assert/strict";
import test from "node:test";

const {
    PLACE_FOCUS_TARGETS,
    buildPlaceSummary,
    findTimelineItem,
    normalizePlaceDraft,
    placeDraftChanged,
} = await import("../js/features/planner/place-inspector.js");

test("maps contextual inspector entry points to a group and control", () => {
    assert.deepEqual(PLACE_FOCUS_TARGETS.duration, { group: "schedule", selector: "#placeVisitMinutes" });
    assert.deepEqual(PLACE_FOCUS_TARGETS.location, { group: "location", selector: "#placeAddress" });
    assert.deepEqual(PLACE_FOCUS_TARGETS.schedule, { group: "schedule", selector: "#placeOpeningTime" });
    assert.deepEqual(PLACE_FOCUS_TARGETS.reservation, { group: "schedule", selector: "#placePlannedStart" });
});

test("normalizes equivalent drafts without dirty false positives", () => {
    const initial = { name: " Museo ", tags: ["arte", "arte", "hoy"], cost: "12.50", visitMinutes: "60", openingTime: "9:00", optional: undefined };
    const current = { name: "Museo", tags: ["hoy", "arte"], cost: 12.5, visitMinutes: 60, openingTime: undefined, optional: false, kind: "activity", mapEnabled: true };
    assert.deepEqual(normalizePlaceDraft(initial), normalizePlaceDraft(current));
    assert.equal(placeDraftChanged(initial, current), false);
    assert.equal(placeDraftChanged(initial, { ...current, cost: 13 }), true);
});

test("builds a complete activity summary and reuses timeline values", () => {
    const spot = { id: "museum", name: "Museo", category: "culture", tags: ["arte"], address: "Calle 1", lat: 40.4, lng: -3.7, cost: 15, visitMinutes: 90, openingTime: "10:00", closingTime: "18:00", plannedStart: "11:00", fixedStart: true, positionConstraint: "first", note: "Entrada norte" };
    const item = { spot, start: 660, end: 750 };
    const summary = buildPlaceSummary(spot, { categories: [{ id: "culture", label: "Cultura", color: "#123456" }], currency: "EUR", timelineItem: item });
    assert.equal(summary.identity.kindLabel, "Actividad");
    assert.equal(summary.identity.category.label, "Cultura");
    assert.equal(summary.location.status, "Ubicación confirmada");
    assert.equal(summary.temporal.schedule, "10:00–18:00");
    assert.equal(summary.temporal.duration, "1 h 30 min");
    assert.equal(summary.temporal.projectedEnd, "12:30");
    assert.equal(summary.temporal.fixedStart, true);
    assert.equal(summary.cost.label, "15 EUR");
    assert.equal(summary.position.label, "Primera");
    assert.equal(findTimelineItem({ items: [item] }, "museum"), item);
});

test("summarizes waypoints, partial data, disabled stops and non-applicable schedules", () => {
    const waypoint = buildPlaceSummary({ id: "station", name: "Estación", kind: "waypoint", plannedStart: "08:15", visitMinutes: 30, mapEnabled: false });
    assert.equal(waypoint.identity.kindLabel, "Punto de paso");
    assert.equal(waypoint.temporal.duration, "No aplicable");
    assert.equal(waypoint.temporal.summary, "08:15 · paso");
    assert.equal(waypoint.enabled, false);
    assert.equal(waypoint.location.status, "Falta la ubicación");

    const activity = buildPlaceSummary({ name: "Parque", scheduleNotApplicable: true, fixedStart: true });
    assert.equal(activity.temporal.schedule, "Sin horario aplicable");
    assert.equal(activity.temporal.fixedStart, false);
    assert.equal(activity.cost, null);
});
