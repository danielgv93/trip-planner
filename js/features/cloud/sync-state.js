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
    "pending-deletion": "Eliminación pendiente",
};

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
