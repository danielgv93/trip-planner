export function createMetrics() {
    const state = {
        requests: 0,
        errors: 0,
        conflicts: 0,
        latencyTotalMs: 0,
        latencyMaxMs: 0,
        queueDepth: 0,
        operationConfirmations: 0,
        operationConflicts: 0,
        operationLatencyTotalMs: 0,
        operationLatencyMaxMs: 0,
        automaticRebases: 0,
        snapshotFallbacks: 0,
        catchupOperations: 0,
        presenceUpdates: 0,
        presenceSessions: 0,
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
        observeOperation({ durationMs = 0, conflict = false, rebased = false } = {}) {
            state.operationConfirmations += conflict ? 0 : 1;
            state.operationConflicts += conflict ? 1 : 0;
            state.operationLatencyTotalMs += Math.max(0, durationMs);
            state.operationLatencyMaxMs = Math.max(state.operationLatencyMaxMs, durationMs);
            state.automaticRebases += rebased ? 1 : 0;
        },
        observeCatchup({ operationCount = 0, snapshotFallback = false } = {}) {
            state.catchupOperations += Math.max(0, operationCount);
            state.snapshotFallbacks += snapshotFallback ? 1 : 0;
        },
        observePresenceUpdate() {
            state.presenceUpdates += 1;
        },
        setPresenceSessions(count) {
            state.presenceSessions = Math.max(0, Number(count) || 0);
        },
        snapshot() {
            return {
                requests: state.requests,
                errors: state.errors,
                conflicts: state.conflicts,
                latencyAverageMs: state.requests ? Math.round(state.latencyTotalMs / state.requests) : 0,
                latencyMaxMs: state.latencyMaxMs,
                queueDepth: state.queueDepth,
                operationConfirmations: state.operationConfirmations,
                operationConflicts: state.operationConflicts,
                operationLatencyAverageMs: state.operationConfirmations + state.operationConflicts
                    ? Math.round(state.operationLatencyTotalMs / (state.operationConfirmations + state.operationConflicts)) : 0,
                operationLatencyMaxMs: state.operationLatencyMaxMs,
                automaticRebases: state.automaticRebases,
                snapshotFallbacks: state.snapshotFallbacks,
                catchupOperations: state.catchupOperations,
                presenceUpdates: state.presenceUpdates,
                presenceSessions: state.presenceSessions,
            };
        },
    };
}
