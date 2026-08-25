import { store } from "../../core/store.js";
import { getTripRepository } from "./workspace.js";
import { stateFromOperationQueue, SYNC_COPY } from "../cloud/sync-state.js";

async function renderStatus() {
    const label = document.querySelector("#tripPersistenceStatus");
    const exportButton = document.querySelector("#tripPersistenceExport");
    const reviewButton = document.querySelector("#tripPersistenceReview");
    const envelope = store.activeTripId ? await getTripRepository()?.getTrip(store.activeTripId) : null;
    const operations = store.activeTripId
        ? await getTripRepository()?.listOperations(store.activeTripId) || []
        : [];
    let state = store.saveStatus === "saving" || store.saveStatus === "error"
        ? store.saveStatus
        : stateFromOperationQueue(operations, {
            online: globalThis.navigator?.onLine !== false,
            authenticated: Boolean(store.accountSession),
            fallback: envelope?.syncState || "local",
        });
    if (!["saving", "error"].includes(state) && envelope?.remote.id) {
        if (store.liveTripSyncState === "pull-error") state = "live-pull-error";
        else if (store.liveTripConnectionState === "connecting") state = "live-connecting";
        else if (store.liveTripConnectionState === "reconnecting") state = "live-reconnecting";
        else if (store.liveTripConnectionState === "error") state = "live-error";
        else if (store.liveTripSyncState === "applied") state = "live-applied";
    }
    const liveCopy = {
        "live-connecting": "Conectando la colaboración en vivo…",
        "live-reconnecting": "Reconectando la colaboración en vivo…",
        "live-error": "No se pudo abrir la colaboración en vivo · se reintentará",
        "live-pull-error": "No se pudo leer la última revisión · se reintentará",
        "live-applied": "Revisión de colaboración aplicada",
    };
    const baseCopy = state === "error"
        ? "No se pudo guardar en este dispositivo. Exporta ahora para evitar perder cambios."
        : (liveCopy[state] || SYNC_COPY[state] || "Guardado en este dispositivo");
    label.textContent = envelope?.remote.id && store.presenceConnectionState === "unavailable"
        ? `${baseCopy} · presencia no disponible`
        : baseCopy;
    exportButton.hidden = state !== "error";
    reviewButton.hidden = state !== "localized-conflict";
    document.querySelector("#tripPersistenceBar").dataset.state = state;
}

document.querySelector("#tripPersistenceExport").addEventListener("click", () => document.querySelector("#exportBtn").click());
document.querySelector("#tripPersistenceReview").addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("review-operation-conflicts", { detail: { tripId: store.activeTripId } }));
});
document.addEventListener("trip-save-state", renderStatus);
document.addEventListener("trip-library-changed", renderStatus);
document.addEventListener("trip-live-state", renderStatus);
renderStatus();
