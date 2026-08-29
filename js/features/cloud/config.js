export function cloudClientConfig() {
    const configured = globalThis.TRIP_PLANNER_CLOUD || {};
    const meta = document.querySelector('meta[name="trip-planner-cloud"]');
    return {
        baseUrl: configured.baseUrl || meta?.dataset.apiBase || "",
        timeoutMs: Number.isInteger(configured.timeoutMs) ? configured.timeoutMs : 12_000,
    };
}
