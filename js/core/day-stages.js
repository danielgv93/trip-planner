// Optional "stage" of a day (e.g. "Kioto"): a display grouping for long trips.
// `stage` is the only persisted value. The title-prefix fallback below is
// display-only and must never be written back into the plan data.

export const STAGE_MAX_LENGTH = 60;
// The date strip adds nothing for short trips, where the whole itinerary fits
// in a couple of screens: show it from this many days onwards.
export const DATE_STRIP_MIN_DAYS = 5;

const TITLE_SEPARATOR = " · ";
// "Día 1 · Llegada" or "Días 3-4 · X" prefix a counter, not a place: they
// must not form a group.
const DAY_COUNTER = /^(d[ií]as?|days?)\s*\d[\d\s,&y\-–]*$/i;
const WEEKDAY_INITIALS = ["D", "L", "M", "X", "J", "V", "S"];
const WEEKDAY_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const WEEKDAY_LONG = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

export function normalizeStage(value) {
    if (typeof value !== "string") return undefined;
    const stage = value.replace(/\s+/g, " ").trim().slice(0, STAGE_MAX_LENGTH).trim();
    return stage || undefined;
}

export function effectiveStage(day) {
    const explicit = normalizeStage(day?.stage);
    if (explicit) return explicit;
    const title = typeof day?.title === "string" ? day.title : "";
    const at = title.indexOf(TITLE_SEPARATOR);
    if (at <= 0) return "";
    const prefix = normalizeStage(title.slice(0, at)) || "";
    return DAY_COUNTER.test(prefix) ? "" : prefix;
}

// Consecutive days sharing the same effective stage form one group. Days with
// no stage group together under "" so the caller can render them unlabeled.
export function groupDaysByStage(days) {
    const groups = [];
    (days || []).forEach((day, index) => {
        const stage = effectiveStage(day);
        const last = groups[groups.length - 1];
        if (last && last.stage === stage) last.days.push({ day, index });
        else groups.push({ stage, days: [{ day, index }] });
    });
    return groups;
}

export function stageNames(days) {
    const names = [];
    for (const day of days || []) {
        const stage = effectiveStage(day);
        if (stage && !names.includes(stage)) names.push(stage);
    }
    return names;
}

function weekdayIndex(date) {
    const parsed = new Date(`${date}T12:00:00`);
    return Number.isNaN(parsed.getTime()) ? -1 : parsed.getDay();
}

export function weekdayInitial(date) {
    return WEEKDAY_INITIALS[weekdayIndex(date)] ?? "";
}

export function weekdayShort(date) {
    return WEEKDAY_SHORT[weekdayIndex(date)] ?? "";
}

export function weekdayLong(date) {
    return WEEKDAY_LONG[weekdayIndex(date)] ?? "";
}

export function shouldShowDateStrip(dayCount) {
    return dayCount >= DATE_STRIP_MIN_DAYS;
}
