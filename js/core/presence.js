const STATES = new Set(["viewing", "editing"]);
export const PRESENCE_FOCUS_DEBOUNCE_MS = 120;
export const PRESENCE_HEARTBEAT_MS = 15_000;
export const REMOTE_HIGHLIGHT_MS = 3_500;

export function presenceTargetKey(target) {
    if (!target?.type || !target?.id) return null;
    return `${target.type}:${target.id}${target.field ? `:${target.field}` : ""}`;
}

export function normalizeIncomingPresence(value) {
    const sequence = Number(value?.sequence);
    const expiresAt = Date.parse(value?.expiresAt);
    const targetKey = presenceTargetKey(value?.target);
    if (
        !value?.presenceSessionId || !value?.userId || !STATES.has(value.state) ||
        !Number.isSafeInteger(sequence) || sequence < 0 || !Number.isFinite(expiresAt) || !targetKey
    ) return null;
    return {
        presenceSessionId: String(value.presenceSessionId),
        userId: String(value.userId),
        displayName: String(value.displayName || "Viajero").slice(0, 80),
        role: value.role,
        state: value.state,
        target: { ...value.target },
        sequence,
        expiresAt: new Date(expiresAt).toISOString(),
    };
}

export function presenceSnapshot(values, now = Date.now()) {
    const map = new Map();
    for (const value of values || []) {
        const presence = normalizeIncomingPresence(value);
        if (presence && Date.parse(presence.expiresAt) > now) map.set(presence.presenceSessionId, presence);
    }
    return map;
}

export function applyPresenceUpsert(map, value, now = Date.now()) {
    const presence = normalizeIncomingPresence(value);
    if (!presence || Date.parse(presence.expiresAt) <= now) return false;
    const current = map.get(presence.presenceSessionId);
    if (current && current.sequence > presence.sequence) return false;
    map.set(presence.presenceSessionId, presence);
    return true;
}

export function applyPresenceLeave(map, value) {
    const current = map.get(String(value?.presenceSessionId));
    if (!current || Number(value?.sequence) <= current.sequence) return false;
    map.delete(String(value.presenceSessionId));
    return true;
}

export function pruneExpiredPresence(map, now = Date.now()) {
    let removed = 0;
    for (const [sessionId, presence] of map) {
        if (Date.parse(presence.expiresAt) > now) continue;
        map.delete(sessionId);
        removed += 1;
    }
    return removed;
}
