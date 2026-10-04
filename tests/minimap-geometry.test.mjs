import test from "node:test";
import assert from "node:assert/strict";
import {
    SCALE,
    REVEAL_START,
    REVEAL_RANGE,
    FULL_REVEAL_MAP_FRACTION,
    revealForMapFraction,
    mapFraction,
    minimapGeometry,
    scrollTopFromSlider,
    scrollTopFromPoint,
    contentYFromMinimap,
} from "../js/features/workspace/minimap-geometry.js";

test("reveal is 0 above REVEAL_START, 1 at the full-reveal fraction, smooth in between", () => {
    const mid = REVEAL_START - REVEAL_RANGE / 2;
    assert.equal(revealForMapFraction(0.99), 0);
    assert.equal(revealForMapFraction(REVEAL_START), 0);
    assert.ok(revealForMapFraction(FULL_REVEAL_MAP_FRACTION) > 0.999);
    assert.equal(revealForMapFraction(0.01), 1);
    assert.ok(Math.abs(revealForMapFraction(mid) - 0.5) < 1e-9);
    assert.ok(
        revealForMapFraction(mid + REVEAL_RANGE / 4) <
            revealForMapFraction(mid - REVEAL_RANGE / 4),
    );
    assert.equal(revealForMapFraction(NaN), 0);
});

test("the default split lands on the full-reveal fraction", () => {
    const defaultPlannerShare = 1 - FULL_REVEAL_MAP_FRACTION;
    assert.ok(revealForMapFraction(1 - defaultPlannerShare) > 0.999);
});

test("mapFraction guards a zero-width workspace", () => {
    assert.equal(mapFraction(240, 960), 0.25);
    assert.equal(mapFraction(10, 0), 1);
});

test("short content: no minimap offset and the slider tracks scale", () => {
    const g = minimapGeometry({ scrollTop: 100, scrollH: 1000, clientH: 500, viewH: 500 });
    assert.equal(g.off, 0);
    assert.equal(g.k, SCALE);
    assert.equal(g.sliderH, 500 * SCALE);
    assert.equal(g.sliderTop, 100 * SCALE);
});

test("tall content offsets the minimap and the slider spans the free travel", () => {
    const base = { scrollH: 10000, clientH: 600, viewH: 600 };
    const top = minimapGeometry({ ...base, scrollTop: 0 });
    const end = minimapGeometry({ ...base, scrollTop: 9400 });
    assert.equal(top.off, 0);
    assert.equal(top.sliderTop, 0);
    assert.ok(Math.abs(end.off - (10000 * SCALE - 600)) < 1e-9);
    // At the bottom the slider rests on the bottom edge of the minimap.
    assert.ok(Math.abs(end.sliderTop + end.sliderH - 600) < 1e-9);
});

test("slider inverse maps back to the original scrollTop", () => {
    const base = { scrollH: 10000, clientH: 600, viewH: 600 };
    for (const scrollTop of [0, 1234, 5000, 9400]) {
        const g = minimapGeometry({ ...base, scrollTop });
        assert.ok(Math.abs(scrollTopFromSlider(g.sliderTop, g) - scrollTop) < 1e-6);
    }
    const g = minimapGeometry({ scrollH: 1000, clientH: 500, viewH: 500, scrollTop: 300 });
    assert.ok(Math.abs(scrollTopFromSlider(g.sliderTop, g) - 300) < 1e-9);
});

test("scrollTopFromSlider clamps to the scrollable range", () => {
    const g = minimapGeometry({ scrollH: 10000, clientH: 600, viewH: 600, scrollTop: 0 });
    assert.equal(scrollTopFromSlider(-50, g), 0);
    assert.equal(scrollTopFromSlider(99999, g), g.maxScroll);
});

test("clicking a point centers the viewport on it", () => {
    const g = minimapGeometry({ scrollH: 1000, clientH: 400, viewH: 400, scrollTop: 0 });
    const target = scrollTopFromPoint(60, { off: g.off, clientH: 400 });
    assert.equal(target, 60 / SCALE - 200);
    assert.equal(contentYFromMinimap(60, g.off), 60 / SCALE);
});

test("a region still below the page top yields a negative slider offset", () => {
    const g = minimapGeometry({ scrollTop: -200, scrollH: 1000, clientH: 600, viewH: 600 });
    assert.equal(g.off, 0);
    assert.equal(g.sliderTop, -200 * SCALE);
});
