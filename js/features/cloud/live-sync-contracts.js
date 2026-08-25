export function editorPreflightDecision({ readOnly = false, hasActiveEditor = false, valid = true } = {}) {
    if (readOnly) return { status: "invalid", reason: "read-only" };
    if (!hasActiveEditor) return { status: "none" };
    return valid ? { status: "committed" } : { status: "invalid", reason: "validation" };
}

export function reconciliationDecision({ baseRevision = 0, remoteRevision = 0, hasOutbox = false } = {}) {
    if (Number(remoteRevision) <= Number(baseRevision)) return "up-to-date";
    return hasOutbox ? "pending-local" : "apply-remote";
}

export function streamEffectAllowed({ generation, currentGeneration, localId, activeLocalId, remoteId, streamedRemoteId } = {}) {
    return generation === currentGeneration && localId === activeLocalId && remoteId === streamedRemoteId;
}

export function isVisuallyRemoteChange(entry, currentUserId = null) {
    if (!entry || entry.effect === "echo") return false;
    const actorUserId = entry.actor?.userId;
    return !currentUserId || !actorUserId || actorUserId !== currentUserId;
}

export function remoteVisualEffects({ result, payload, currentUserId = null } = {}) {
    const applied = result?.status === "applied"
        ? result.applied || []
        : ["snapshot", "up-to-date"].includes(result?.status) && Array.isArray(payload?.targetKeys)
          ? [{ ...payload, effect: "applied" }]
          : [];
    return applied.filter((entry) => isVisuallyRemoteChange(entry, currentUserId));
}

export function classifyCloudSaveResult({
    readOnly = false,
    validationFailed = false,
    before = {},
    after = {},
    summary = {},
    error = null,
} = {}) {
    if (readOnly) return { status: "read-only", tone: "error", message: "Este viaje es de solo lectura." };
    if (validationFailed) return { status: "invalid", tone: "error", message: "Corrige los campos indicados antes de guardar." };
    const terminal = error || summary.terminalError;
    const state = terminal?.status === 401 || terminal?.code === "AUTH_REQUIRED"
        ? "auth-required"
        : terminal?.status === 409 || terminal?.code === "REVISION_CONFLICT" || summary.conflicts?.length
          ? "conflict"
          : terminal?.code === "NETWORK" || terminal?.code === "TIMEOUT"
            ? "network"
            : null;
    if (state === "auth-required") return { status: state, tone: "error", message: "Vuelve a iniciar sesión para sincronizar el viaje." };
    if (state === "conflict") return { status: state, tone: "error", message: "Hay un conflicto pendiente. Elige qué versión conservar." };
    if (state === "network") return { status: state, tone: "error", message: "Sin conexión: los cambios siguen guardados en este dispositivo." };
    if (terminal) return { status: "error", tone: "error", message: "No se pudo sincronizar. Los cambios siguen guardados en este dispositivo." };
    if (after.hasOutbox || summary.pending?.length) {
        return { status: "pending", tone: "error", message: "Los cambios siguen pendientes de sincronizar." };
    }
    const confirmed = summary.confirmed?.length
        || (before.hasOutbox && !after.hasOutbox && (
            Number(after.baseRevision) > Number(before.baseRevision)
            || (after.remoteHash && after.remoteHash !== before.remoteHash)
        ));
    if (confirmed) return { status: "confirmed", tone: "success", message: "Viaje guardado en tu cuenta." };
    return { status: "no-op", tone: "info", message: "No hay cambios pendientes." };
}

export async function runExplicitCloudSave({ readOnly = false, preflight, waitForCommit, synchronize }) {
    if (readOnly) return { preflight: editorPreflightDecision({ readOnly }), synchronized: false };
    const result = await preflight();
    if (result.status === "invalid") return { preflight: result, synchronized: false };
    await waitForCommit();
    return { preflight: result, synchronized: true, result: await synchronize() };
}

export function createSingleFlight(operation) {
    let active = null;
    return (...args) => {
        if (active) return active;
        active = Promise.resolve().then(() => operation(...args)).finally(() => {
            active = null;
        });
        return active;
    };
}
