import test from "node:test";
import assert from "node:assert/strict";

import { createMapViewportResetTracker } from "../js/features/map/viewport-lifecycle.js";

test("permite encuadrar el mapa en el primer dibujo", () => {
    const tracker = createMapViewportResetTracker();

    assert.equal(tracker.shouldReset("day-1"), true);
});

test("conserva la cámara al redibujar el mismo día", () => {
    const tracker = createMapViewportResetTracker();

    tracker.shouldReset("day-1");

    assert.equal(tracker.shouldReset("day-1"), false);
    assert.equal(tracker.shouldReset("day-1"), false);
});

test("permite reencuadrar solamente cuando cambia el día activo", () => {
    const tracker = createMapViewportResetTracker();

    tracker.shouldReset("day-1");

    assert.equal(tracker.shouldReset("day-2"), true);
    assert.equal(tracker.shouldReset("day-2"), false);
    assert.equal(tracker.shouldReset("backlog"), true);
});
