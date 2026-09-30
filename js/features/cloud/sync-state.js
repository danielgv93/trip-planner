export const SYNC_COPY = {
    local: "Solo en este dispositivo",
    saving: "Guardando…",
    saved: "Guardado en el dispositivo",
    synced: "Sincronizado",
    pending: "Pendiente de sincronizar",
    offline: "Sin conexión · guardado en el dispositivo",
    "auth-required": "Vuelve a iniciar sesión para sincronizar",
    error: "No se pudo sincronizar · puedes reintentar",
    conflict: "Conflicto · elige qué versión conservar",
    "localized-conflict": "Conflicto localizado · revisa solo el cambio afectado",
    "pending-deletion": "Eliminación pendiente",
};

export function stateFromOperationQueue(entries = [], {
    online = true,
    authenticated = true,
    fallback = "synced",
} = {}) {
    if (entries.some((entry) => entry.status === "conflict")) return "localized-conflict";
    if (!entries.length) return fallback;
    if (!online) return "offline";
    if (!authenticated) return "auth-required";
    if (entries.some((entry) => entry.status === "sending")) return "saving";
    return "pending";
}

export const CLOUD_AVAILABILITY_COPY = {
    checking: "Comprobando la conexión con la nube…",
    unavailable: "La nube no está disponible ahora. Tus viajes siguen guardándose en este dispositivo.",
};

export function cloudAvailabilityAfterError(error) {
    if (!error) return "available";
    if (["NETWORK", "TIMEOUT", "CLOUD_DISABLED"].includes(error.code)) return "unavailable";
    if (error.status === 404 || error.status >= 500) return "unavailable";
    return "available";
}

export function nextRetryDelay(attempt, { base = 1_000, cap = 60_000, random = Math.random } = {}) {
    const bounded = Math.min(cap, base * (2 ** Math.max(0, attempt)));
    return Math.round(bounded * (0.75 + random() * 0.5));
}

export function stateAfterFailure(error, { online = true, authenticated = true } = {}) {
    if (!online || error?.code === "NETWORK") return "offline";
    if (!authenticated || error?.status === 401 || error?.code === "AUTH_REQUIRED") return "auth-required";
    if (error?.status === 409 || error?.code === "REVISION_CONFLICT") return "conflict";
    return "error";
}

export function conflictResolutionEffects(action) {
    if (action === "cloud") return { duplicateLocal: true, adoptRemote: true, enqueueLocal: false };
    if (action === "local") return { duplicateLocal: false, adoptRemote: false, enqueueLocal: true };
    if (action === "copy") return { duplicateLocal: true, adoptRemote: true, enqueueLocal: false };
    throw new Error("INVALID_CONFLICT_ACTION");
}

const INDICATOR_COPY = {
    live: "colaboración en vivo activa",
    synced: "sincronizado con la nube",
    saving: "guardando…",
    pending: "cambios pendientes de sincronizar",
    attention: "requiere tu atención",
    local: "solo en este dispositivo",
};

// Condenses the persistence state already computed by the status bar into one
// glanceable category for the "Guardado" menu dot. It derives, never invents:
// `state` is the queue/envelope state (before the live-stream override),
// `hasRemote` tells whether the trip is linked to the cloud.
export function syncIndicator({ state = "local", hasRemote = false, liveConnection = "closed", livePullError = false } = {}) {
    let key;
    if (state === "saving") key = "saving";
    else if (["error", "conflict", "localized-conflict", "auth-required"].includes(state)) key = "attention";
    else if (["pending", "offline", "pending-deletion"].includes(state)) key = "pending";
    else if (hasRemote && (livePullError || ["connecting", "reconnecting", "error"].includes(liveConnection))) key = "pending";
    else if (hasRemote && liveConnection === "open") key = "live";
    else if (state === "synced" || hasRemote) key = "synced";
    else key = "local";
    return { state: key, label: `Guardado: ${INDICATOR_COPY[key]}` };
}
