import test from "node:test";
import assert from "node:assert/strict";

import {
    countdownForDate,
    findSpotDayDate,
    localDateString,
    normalizeReminders,
    resolveReminderDate,
    sortPresentedReminders,
    subtractDate,
    unlinkSpotReminders,
} from "../js/core/reminders.js";

const fixed = (id, date, extra = {}) => ({
    id,
    title: `Recordatorio ${id}`,
    timing: { type: "fixed", date },
    ...extra,
});

test("normaliza recordatorios válidos y descarta formas inválidas en modo tolerante", () => {
    assert.deepEqual(normalizeReminders([
        { id: " a ", title: " Reserva ", note: " Nota ", timing: { type: "fixed", date: "2026-05-01" } },
        { id: "bad", title: "", timing: { type: "fixed", date: "2026-02-30" } },
        fixed("a", "2026-06-01"),
    ]), [{ id: "a", title: "Reserva", note: "Nota", timing: { type: "fixed", date: "2026-05-01" } }]);
});

test("la normalización estricta rechaza colecciones, ids y combinaciones inválidas", () => {
    assert.throws(() => normalizeReminders({}, { strict: true }), /INVALID_PLAN/);
    assert.throws(() => normalizeReminders([fixed("x", "2026-01-01"), fixed("x", "2026-01-02")], { strict: true }), /INVALID_PLAN/);
    assert.throws(() => normalizeReminders([{ id: "x", title: "X", timing: { type: "offset", amount: 1, unit: "days", anchor: { type: "spot" } } }], { strict: true }), /INVALID_PLAN/);
});

test("resta días, semanas y meses naturales con ajuste de fin de mes", () => {
    assert.equal(subtractDate("2026-08-20", 2, "weeks"), "2026-08-06");
    assert.equal(subtractDate("2026-05-31", 1, "months"), "2026-04-30");
    assert.equal(subtractDate("2024-03-31", 1, "months"), "2024-02-29");
    assert.equal(subtractDate("2026-01-15", 2, "months"), "2025-11-15");
});

test("las diferencias por día canónico no cambian durante el DST", () => {
    assert.equal(countdownForDate("2026-03-30", "2026-03-28").days, 2);
    assert.equal(countdownForDate("2026-10-26", "2026-10-24").days, 2);
    const local = new Date(2026, 2, 29, 23, 30);
    assert.equal(localDateString(local), "2026-03-29");
});

test("resuelve anclas de parada al mover entre días y queda pendiente en backlog", () => {
    const reminder = { id: "r", title: "Reserva", spotId: "s", timing: { type: "offset", amount: 1, unit: "months", anchor: { type: "spot" } } };
    const may = [{ date: "2026-05-31", spots: [{ id: "s" }] }];
    const june = [{ date: "2026-06-30", spots: [{ id: "s" }] }];
    assert.equal(findSpotDayDate(may, "s"), "2026-05-31");
    assert.equal(resolveReminderDate(reminder, may), "2026-04-30");
    assert.equal(resolveReminderDate(reminder, june), "2026-05-30");
    assert.equal(resolveReminderDate(reminder, []), null);
});

test("clasifica y ordena por urgencia, fecha e id de forma estable", () => {
    const ordered = sortPresentedReminders([
        fixed("future", "2026-08-15"),
        fixed("today", "2026-08-10"),
        fixed("old-b", "2026-08-09"),
        fixed("old-a", "2026-08-09"),
    ], [], "2026-08-10");
    assert.deepEqual(ordered.map((item) => item.reminder.id), ["old-a", "old-b", "today", "future"]);
    assert.equal(ordered[0].countdown.label, "Vencido hace 1 día");
    assert.equal(ordered[1].countdown.status, "overdue");
    assert.equal(ordered[2].countdown.label, "Hoy");
    assert.equal(ordered[3].countdown.label, "en 5 días");
});

test("desvincula de forma segura materializando fechas o conservando pendientes", () => {
    const relative = { id: "relative", title: "Reserva", spotId: "s", timing: { type: "offset", amount: 2, unit: "weeks", anchor: { type: "spot" } } };
    const fixedLinked = fixed("fixed", "2026-01-02", { spotId: "s" });
    const resolved = unlinkSpotReminders([relative, fixedLinked], "s", [{ date: "2026-08-20", spots: [{ id: "s" }] }]);
    assert.deepEqual(resolved[0].timing, { type: "fixed", date: "2026-08-06" });
    assert.equal(resolved[0].spotId, undefined);
    assert.equal(resolved[1].spotId, undefined);

    const pending = unlinkSpotReminders([relative], "s", [])[0];
    assert.equal(resolveReminderDate(pending, []), null);
    assert.equal(pending.pendingSpotAnchor, true);
    assert.deepEqual(normalizeReminders([pending]), [pending]);
});
