const stampFormatter = new Intl.DateTimeFormat("es-ES", {
    dateStyle: "medium",
    timeStyle: "short",
});
const relativeFormatter = new Intl.RelativeTimeFormat("es-ES", { numeric: "auto" });
const RELATIVE_STEPS = [
    ["minute", 60_000, 60],
    ["hour", 3_600_000, 24],
    ["day", 86_400_000, 7],
    ["week", 604_800_000, 4.35],
];

export function modifiedAtLabel(value, now = Date.now()) {
    const stamp = new Date(value);
    if (Number.isNaN(stamp.getTime())) return { label: "Sin fecha", title: "", dateTime: "" };
    const exact = stampFormatter.format(stamp);
    const elapsed = Math.max(0, now - stamp.getTime());
    if (elapsed < 60_000) return { label: "Ahora mismo", title: exact, dateTime: stamp.toISOString() };
    for (const [unit, ms, limit] of RELATIVE_STEPS) {
        const amount = elapsed / ms;
        if (amount < limit) {
            return {
                label: relativeFormatter.format(-Math.round(amount), unit),
                title: exact,
                dateTime: stamp.toISOString(),
            };
        }
    }
    return { label: exact, title: exact, dateTime: stamp.toISOString() };
}
