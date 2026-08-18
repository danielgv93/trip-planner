const SYNC_STATE_PRIORITY = {
    local: 0,
    saved: 1,
    synced: 1,
    "auth-required": 2,
    offline: 2,
    pending: 3,
    saving: 4,
    error: 5,
    conflict: 6,
};

export function combinedSyncState(...states) {
    return states
        .filter((state) => state in SYNC_STATE_PRIORITY)
        .reduce((current, state) => (
            SYNC_STATE_PRIORITY[state] > SYNC_STATE_PRIORITY[current] ? state : current
        ), "local");
}
