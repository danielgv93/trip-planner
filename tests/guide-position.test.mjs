import test from "node:test";
import assert from "node:assert/strict";
import { placeGuideCard } from "../js/shared/guide.js";

test("places the guide below a target when there is room", () => {
    const result = placeGuideCard({
        target: { top: 100, right: 300, bottom: 150, left: 200, width: 100, height: 50 },
        card: { width: 240, height: 120 },
        viewport: { width: 800, height: 600 },
        preferred: "bottom",
    });
    assert.deepEqual(result, { placement: "bottom", top: 164, left: 130 });
});

test("chooses another side and keeps the card inside the viewport", () => {
    const result = placeGuideCard({
        target: { top: 540, right: 460, bottom: 590, left: 340, width: 120, height: 50 },
        card: { width: 300, height: 180 },
        viewport: { width: 800, height: 600 },
        preferred: "bottom",
    });
    assert.equal(result.placement, "top");
    assert.ok(result.top >= 16);
    assert.ok(result.left >= 16);
    assert.ok(result.left + 300 <= 784);
});
