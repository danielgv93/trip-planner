export function cloudClientConfig() {
    const configured = globalThis.TRIP_PLANNER_CLOUD || {};
    const meta = document.querySelector('meta[name="trip-planner-cloud"]');
    const localDevelopment = !globalThis.location
        || ["localhost", "127.0.0.1"].includes(globalThis.location.hostname);
    return {
        baseUrl: configured.baseUrl || (localDevelopment ? meta?.dataset.apiBase : "") || "",
        timeoutMs: Number.isInteger(configured.timeoutMs) ? configured.timeoutMs : 12_000,
    };
}
