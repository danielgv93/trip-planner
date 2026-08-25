import test from "node:test";
import assert from "node:assert/strict";
import { modifiedAtLabel } from "../js/shared/modified-at.js";

const now = Date.parse("2026-08-25T12:00:00.000Z");

test("formats recent modification times relatively", () => {
    assert.equal(modifiedAtLabel("2026-08-25T11:59:30.000Z", now).label, "Ahora mismo");
    assert.equal(modifiedAtLabel("2026-08-25T10:00:00.000Z", now).label, "hace 2 horas");
    assert.equal(modifiedAtLabel("2026-08-24T12:00:00.000Z", now).label, "ayer");
});

test("keeps a machine-readable timestamp and rejects invalid values", () => {
    const result = modifiedAtLabel("2026-08-20T12:00:00.000Z", now);
    assert.equal(result.dateTime, "2026-08-20T12:00:00.000Z");
    assert.ok(result.title);
    assert.deepEqual(modifiedAtLabel(undefined, now), { label: "Sin fecha", title: "", dateTime: "" });
});
