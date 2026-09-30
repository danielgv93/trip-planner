// Presence is scoped to the open trip, never to the user's whole account.
export function memberPresenceState(userId, {
    sessions = new Map(), currentUserId = null,
    connectionState = "closed", liveState = "closed", online = true,
    now = Date.now(),
} = {}) {
    if (!online || connectionState !== "open" || liveState !== "open") return "unknown";
    if (userId === currentUserId) return "online";
    return [...sessions.values()].some((session) => session.userId === userId
        && Date.parse(session.expiresAt) > now) ? "online" : "offline";
}

export const MEMBER_PRESENCE_LABEL = {
    online: "En línea en este viaje",
    offline: "Sin presencia en este viaje",
    unknown: "Presencia no disponible",
};
