import test from "node:test";
import assert from "node:assert/strict";

import {
    openingHourSegments,
    scheduleOverlapSegments,
    schedulesOverlap,
} from "../js/features/planner/schedule.js";
import {
    cardinalLabel,
    haversineMeters,
    initialBearingDegrees,
    normalizeDegrees,
    preferredHeading,
} from "../js/features/companion/navigation.js";

test("los horarios nocturnos se dividen y comparan correctamente", () => {
    const overnightWidths = openingHourSegments("22:00", "02:00")
        .map((segment) => segment.width);
    assert.equal(overnightWidths.length, 2);
    assert.ok(overnightWidths.every((width) => Math.abs(width - 100 / 12) < 1e-10));
    assert.equal(schedulesOverlap("22:00", "02:00", "01:00", "03:00"), true);
    assert.equal(schedulesOverlap("09:00", "10:00", "10:00", "11:00"), false);
    assert.equal(scheduleOverlapSegments("09:00", "12:00", "10:00", "11:00").length, 1);
});

test("la navegación normaliza rumbo, distancia y fuente preferida", () => {
    assert.equal(normalizeDegrees(-45), 315);
    assert.equal(cardinalLabel(270), "O");
    assert.equal(initialBearingDegrees(0, 0, 0, 1), 90);
    assert.equal(haversineMeters(0, 0, 0, 0), 0);
    assert.equal(preferredHeading({ heading: 120, speed: 2 }, 45), 120);
    assert.equal(preferredHeading({ heading: 120, speed: 0.1 }, 45), 45);
});
