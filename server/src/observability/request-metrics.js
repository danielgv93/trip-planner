export function createMetrics() {
    const state = {
        requests: 0,
        errors: 0,
        conflicts: 0,
        latencyTotalMs: 0,
        latencyMaxMs: 0,
        queueDepth: 0,
    };
    return {
        observeRequest({ status, durationMs }) {
            state.requests += 1;
            state.latencyTotalMs += durationMs;
            state.latencyMaxMs = Math.max(state.latencyMaxMs, durationMs);
            if (status >= 400) state.errors += 1;
            if (status === 409) state.conflicts += 1;
        },
        setQueueDepth(depth) {
            state.queueDepth = Math.max(0, Number(depth) || 0);
        },
        snapshot() {
            return {
                requests: state.requests,
                errors: state.errors,
                conflicts: state.conflicts,
                latencyAverageMs: state.requests ? Math.round(state.latencyTotalMs / state.requests) : 0,
                latencyMaxMs: state.latencyMaxMs,
                queueDepth: state.queueDepth,
            };
        },
    };
}
