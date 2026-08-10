const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const OFFSET_UNITS = new Set(["days", "weeks", "months"]);

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isCanonicalDate(value) {
    if (typeof value !== "string") return false;
    const match = DATE_RE.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    );
}

function invalid(strict) {
    if (strict) throw new Error("INVALID_PLAN");
    return null;
}

export function normalizeReminder(value, { strict = false } = {}) {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim())
        return invalid(strict);
    if (typeof value.title !== "string" || !value.title.trim())
        return invalid(strict);
    if (!isRecord(value.timing)) return invalid(strict);

    const reminder = {
        id: value.id.trim(),
        title: value.title.trim(),
    };
    if (typeof value.note === "string" && value.note.trim())
        reminder.note = value.note.trim();
    if (typeof value.spotId === "string" && value.spotId.trim())
        reminder.spotId = value.spotId.trim();

    if (value.timing.type === "fixed") {
        if (!isCanonicalDate(value.timing.date)) return invalid(strict);
        reminder.timing = { type: "fixed", date: value.timing.date };
        return reminder;
    }

    if (
        value.timing.type !== "offset" ||
        !Number.isInteger(value.timing.amount) ||
        value.timing.amount <= 0 ||
        !OFFSET_UNITS.has(value.timing.unit) ||
        !isRecord(value.timing.anchor)
    ) return invalid(strict);

    let anchor;
    if (value.timing.anchor.type === "date") {
        if (!isCanonicalDate(value.timing.anchor.date)) return invalid(strict);
        anchor = { type: "date", date: value.timing.anchor.date };
    } else if (value.timing.anchor.type === "spot") {
        if (!reminder.spotId && value.pendingSpotAnchor !== true)
            return invalid(strict);
        anchor = { type: "spot" };
    } else {
        return invalid(strict);
    }
    reminder.timing = {
        type: "offset",
        amount: value.timing.amount,
        unit: value.timing.unit,
        anchor,
    };
    if (!reminder.spotId && anchor.type === "spot")
        reminder.pendingSpotAnchor = true;
    return reminder;
}

export function normalizeReminders(value, {
    strict = false,
    spotIds,
} = {}) {
    if (value === undefined && !strict) return [];
    if (!Array.isArray(value)) {
        if (strict) throw new Error("INVALID_PLAN");
        return [];
    }
    const result = [];
    const ids = new Set();
    for (const candidate of value) {
        const reminder = normalizeReminder(candidate, { strict });
        if (!reminder) continue;
        if (ids.has(reminder.id)) {
            if (strict) throw new Error("INVALID_PLAN");
            continue;
        }
        ids.add(reminder.id);
        if (spotIds && reminder.spotId && !spotIds.has(reminder.spotId)) {
            delete reminder.spotId;
            // A removed spot anchor has no truthful fallback date. Preserve the
            // rule as a visible pending reminder until the user edits it.
            if (reminder.timing.anchor?.type === "spot")
                reminder.pendingSpotAnchor = true;
        }
        result.push(reminder);
    }
    return result;
}

function dateParts(value) {
    const [, year, month, day] = DATE_RE.exec(value);
    return { year: Number(year), month: Number(month), day: Number(day) };
}

function formatDate(year, month, day) {
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function utcDay(value) {
    const { year, month, day } = dateParts(value);
    return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function dateFromUtcDay(dayNumber) {
    const date = new Date(dayNumber * 86400000);
    return formatDate(
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        date.getUTCDate(),
    );
}

export function subtractDate(date, amount, unit) {
    if (!isCanonicalDate(date) || !Number.isInteger(amount) || amount <= 0 || !OFFSET_UNITS.has(unit))
        return null;
    if (unit === "days" || unit === "weeks")
        return dateFromUtcDay(utcDay(date) - amount * (unit === "weeks" ? 7 : 1));

    const { year, month, day } = dateParts(date);
    const zeroBasedTarget = year * 12 + (month - 1) - amount;
    const targetYear = Math.floor(zeroBasedTarget / 12);
    const targetMonth = ((zeroBasedTarget % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    return formatDate(targetYear, targetMonth + 1, Math.min(day, lastDay));
}

export function findSpotDayDate(days, spotId) {
    if (!Array.isArray(days) || typeof spotId !== "string") return null;
    for (const day of days) {
        if (
            isCanonicalDate(day?.date) &&
            Array.isArray(day?.spots) &&
            day.spots.some((spot) => spot?.id === spotId)
        ) return day.date;
    }
    return null;
}

export function resolveReminderDate(reminder, days = []) {
    if (reminder?.timing?.type === "fixed")
        return isCanonicalDate(reminder.timing.date) ? reminder.timing.date : null;
    if (reminder?.timing?.type !== "offset") return null;
    const anchor = reminder.timing.anchor;
    const anchorDate = anchor?.type === "date"
        ? anchor.date
        : anchor?.type === "spot" && reminder.spotId
          ? findSpotDayDate(days, reminder.spotId)
          : null;
    if (!isCanonicalDate(anchorDate)) return null;
    return subtractDate(anchorDate, reminder.timing.amount, reminder.timing.unit);
}

export function localDateString(date = new Date()) {
    return formatDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

export function countdownForDate(date, today = localDateString()) {
    if (!isCanonicalDate(date) || !isCanonicalDate(today)) return null;
    const days = utcDay(date) - utcDay(today);
    if (days < 0) return { status: "overdue", days, label: `Vencido hace ${Math.abs(days)} ${Math.abs(days) === 1 ? "día" : "días"}` };
    if (days === 0) return { status: "today", days: 0, label: "Hoy" };
    return { status: "future", days, label: `en ${days} ${days === 1 ? "día" : "días"}` };
}

const URGENCY = { overdue: 0, today: 1, future: 2, pending: 3 };

export function presentReminder(reminder, days = [], today = localDateString()) {
    const date = resolveReminderDate(reminder, days);
    const countdown = date ? countdownForDate(date, today) : null;
    return {
        reminder,
        date,
        countdown,
        status: countdown?.status || "pending",
    };
}

export function sortPresentedReminders(reminders, days = [], today = localDateString()) {
    return reminders
        .map((reminder, index) => ({ ...presentReminder(reminder, days, today), index }))
        .sort((a, b) =>
            URGENCY[a.status] - URGENCY[b.status] ||
            (a.date || "9999-12-31").localeCompare(b.date || "9999-12-31") ||
            String(a.reminder.id).localeCompare(String(b.reminder.id)) ||
            a.index - b.index,
        );
}

export function unlinkSpotReminders(reminders, spotId, days = []) {
    return reminders.map((reminder) => {
        if (reminder.spotId !== spotId) return reminder;
        const copy = structuredClone(reminder);
        const effectiveDate = resolveReminderDate(copy, days);
        delete copy.spotId;
        if (copy.timing?.anchor?.type === "spot") {
            if (effectiveDate) copy.timing = { type: "fixed", date: effectiveDate };
            else copy.pendingSpotAnchor = true;
        }
        return copy;
    });
}
