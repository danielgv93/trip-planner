import test from "node:test";
import assert from "node:assert/strict";
import {
    insertionIndexFromMidpoints,
    outlineRowsMarkup,
} from "../js/features/planner/day-outline.js";

test("insertionIndexFromMidpoints picks the first midpoint below the pointer", () => {
    const mids = [10, 30, 50];
    assert.equal(insertionIndexFromMidpoints(mids, 0), 0);
    assert.equal(insertionIndexFromMidpoints(mids, 20), 1);
    assert.equal(insertionIndexFromMidpoints(mids, 30), 2);
    assert.equal(insertionIndexFromMidpoints(mids, 99), 3);
    assert.equal(insertionIndexFromMidpoints([], 5), 0);
});

const row = (over = {}) => ({
    key: "spot:a", number: "1", label: "Hotel", kind: "spot",
    anchored: false, disabled: false, ...over,
});

test("outlineRowsMarkup escapes labels and numbers and indexes rows", () => {
    const html = outlineRowsMarkup([
        row({ label: '<img src=x onerror="1">&' }),
        row({ key: "spot:b", number: "<b>", label: "Café" }),
    ]);
    assert.ok(!html.includes("<img"));
    assert.ok(html.includes("&lt;img src=x onerror=&quot;1&quot;&gt;&amp;"));
    assert.ok(html.includes("&lt;b&gt;"));
    assert.match(html, /data-outline-index="0"/);
    assert.match(html, /data-outline-index="1"/);
});

test("outlineRowsMarkup applies state modifiers", () => {
    const html = outlineRowsMarkup(
        [
            row(),
            row({ key: "travel-leg:x", kind: "travel", label: "A → B" }),
            row({ key: "spot:c", anchored: true }),
            row({ key: "spot:d", disabled: true, number: "" }),
        ],
        { sourceKey: "spot:a" },
    );
    const items = html.split("</li>");
    assert.match(items[0], /is-source/);
    assert.match(items[1], /is-travel/);
    assert.doesNotMatch(items[1], /is-source/);
    assert.match(items[2], /is-anchored/);
    assert.match(items[3], /is-disabled/);
    assert.doesNotMatch(outlineRowsMarkup([row()]), /is-source|is-travel|is-anchored|is-disabled/);
});
