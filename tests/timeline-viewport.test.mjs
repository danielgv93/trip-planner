import test from "node:test";
import assert from "node:assert/strict";

import {
    timelineScrollForCenter,
    timelineViewportCenter,
} from "../js/features/companion/timeline-viewport.js";

test("conserva la hora central al reconstruir un timeline", () => {
    const centerMinute = timelineViewportCenter({
        boundStart: 360,
        boundEnd: 1440,
        scrollLeft: 1200,
        viewportWidth: 600,
        trackWidth: 3600,
    });
    assert.equal(centerMinute, 810);

    const scrollLeft = timelineScrollForCenter({
        boundStart: 300,
        boundEnd: 1500,
        centerMinute,
        viewportWidth: 600,
        trackWidth: 4000,
    });
    assert.equal(scrollLeft, 1400);
});

test("ajusta la restauración a los extremos disponibles", () => {
    const base = {
        boundStart: 360,
        boundEnd: 1440,
        viewportWidth: 600,
        trackWidth: 3600,
    };
    assert.equal(timelineScrollForCenter({ ...base, centerMinute: 300 }), 0);
    assert.equal(timelineScrollForCenter({ ...base, centerMinute: 1500 }), 3000);
});

test("ignora geometrías de timeline que todavía no son visibles", () => {
    assert.equal(timelineViewportCenter({
        boundStart: 360,
        boundEnd: 1440,
        scrollLeft: 0,
        viewportWidth: 0,
        trackWidth: 0,
    }), null);
});
