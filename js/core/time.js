export const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function isTime(value) {
    return typeof value === "string" && TIME_PATTERN.test(value);
}

export function timeToMinutes(value) {
    if (!isTime(value)) return null;
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
}

export function minutesToTime(value, { wrap = false } = {}) {
    if (!Number.isFinite(value)) return null;
    const rounded = Math.round(value);
    const minutes = wrap
        ? ((rounded % 1440) + 1440) % 1440
        : Math.max(0, Math.min(1439, rounded));
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
