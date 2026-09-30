import test from "node:test";
import assert from "node:assert/strict";
import {
    RANGE,
    COMPACT_HEIGHT,
    morphHeight,
    morphMargin,
    stuckProgress,
} from "../js/features/planner/sticky-compact.js";

test("progress is clamped to 0..1 over RANGE", () => {
    assert.equal(RANGE, 48);
    assert.equal(stuckProgress(100, 120), 0);
    assert.equal(stuckProgress(100, 100), 0);
    assert.equal(stuckProgress(100, 76), 0.5);
    assert.equal(stuckProgress(100, 52), 1);
    assert.equal(stuckProgress(100, -400), 1);
    assert.equal(stuckProgress(NaN, 0), 0);
});

test("progress with a zero or invalid range is a hard switch", () => {
    assert.equal(stuckProgress(100, 99, 0), 1);
    assert.equal(stuckProgress(100, 100, 0), 0);
    assert.equal(stuckProgress(100, 99, -5), 1);
});

test("height interpolates between full and compact", () => {
    assert.equal(morphHeight(82, COMPACT_HEIGHT, 0), 82);
    assert.equal(morphHeight(82, COMPACT_HEIGHT, 0.5), 62);
    assert.equal(morphHeight(82, COMPACT_HEIGHT, 1), 42);
    assert.equal(morphHeight(82, COMPACT_HEIGHT, 7), 42);
    assert.equal(morphHeight(82, COMPACT_HEIGHT, -1), 82);
});

test("height is left untouched when full <= compact", () => {
    assert.equal(morphHeight(40, 42, 1), 40);
    assert.equal(morphHeight(42, 42, 0.5), 42);
    assert.equal(morphHeight(undefined, 42, 0.5), 0);
});

test("height + margin always equals the full height", () => {
    for (const full of [30, 42, 57.5, 82, 120.25]) {
        for (let p = 0; p <= 1.0001; p += 0.05) {
            const h = morphHeight(full, COMPACT_HEIGHT, p);
            assert.ok(Math.abs(h + morphMargin(full, h) - full) < 0.011 || h >= full);
        }
    }
    assert.equal(morphMargin(82, 62), 20);
    assert.equal(morphMargin(40, 42), 0);
});
