// Spanish duration formatting shared by spot cards and day workload summaries.
export function formatDurationMinutes(minutes) {
    const total = Math.max(0, Math.round(minutes));
    if (total < 60) return `~${total} min`;
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    return rest === 0 ? `~${hours} h` : `~${hours} h ${rest} min`;
}
