import { store } from "../../core/store.js";
import { getTripRepository } from "./workspace.js";
import { stateFromOperationQueue, SYNC_COPY } from "../cloud/sync-state.js";
import { liveConnectionPresentation } from "../cloud/live-connection-presentation.js";
import { liveTripIsPaused, pauseLiveTripStream, resumeLiveTripStream } from "../cloud/live-trip.js";
import { confirmAction, toast } from "../../shared/notify.js";

let liveActivityTimer = null;

function renderLiveIndicator(remoteId) {
    const indicator = document.querySelector("#tripLiveIndicator");
    const presentation = liveConnectionPresentation(remoteId, store.liveTripConnectionState);
    indicator.hidden = presentation.hidden;
    indicator.dataset.state = presentation.state;
    indicator.querySelector(".trip-live-label").textContent = presentation.label;
    indicator.setAttribute("aria-label", presentation.actionLabel);
    indicator.title = `${presentation.description}. ${presentation.actionLabel}`;
}

function showLiveActivity(event) {
    if (event.detail?.tripId !== store.activeTripId || store.liveTripConnectionState !== "open") return;
    const indicator = document.querySelector("#tripLiveIndicator");
    if (indicator.hidden) return;
    clearTimeout(liveActivityTimer);
    indicator.classList.remove("is-receiving");
    requestAnimationFrame(() => indicator.classList.add("is-receiving"));
    liveActivityTimer = setTimeout(() => indicator.classList.remove("is-receiving"), 900);
}

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
        else if (store.liveTripConnectionState === "paused") state = "live-paused";
        else if (store.liveTripSyncState === "applied") state = "live-applied";
    }
    const liveCopy = {
        "live-connecting": "Conectando la colaboración en vivo…",
        "live-reconnecting": "Reconectando la colaboración en vivo…",
        "live-error": "No se pudo abrir la colaboración en vivo · se reintentará",
        "live-paused": "Colaboración en vivo pausada · tus cambios siguen guardándose",
        "live-pull-error": "No se pudo leer la última revisión · se reintentará",
        "live-applied": "Revisión de colaboración aplicada",
    };
    const baseCopy = state === "error"
        ? "No se pudo guardar en este dispositivo. Exporta ahora para evitar perder cambios."
        : (liveCopy[state] || SYNC_COPY[state] || "Guardado en este dispositivo");
    label.textContent = envelope?.remote.id && store.presenceConnectionState === "unavailable"
        ? `${baseCopy} · presencia no disponible`
        : baseCopy;
    renderLiveIndicator(envelope?.remote.id);
    exportButton.hidden = state !== "error";
    reviewButton.hidden = state !== "localized-conflict";
    document.querySelector("#tripPersistenceBar").dataset.state = state;
}

document.querySelector("#tripPersistenceExport").addEventListener("click", () => document.querySelector("#exportBtn").click());
document.querySelector("#tripPersistenceReview").addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("review-operation-conflicts", { detail: { tripId: store.activeTripId } }));
});
document.querySelector("#tripLiveIndicator").addEventListener("click", async () => {
    if (liveTripIsPaused()) {
        await resumeLiveTripStream();
        toast("Reconectando la colaboración en vivo…", "info");
        return;
    }
    if (["error", "closed"].includes(store.liveTripConnectionState)) {
        await resumeLiveTripStream();
        toast("Reintentando la conexión en vivo…", "info");
        return;
    }
    const accepted = await confirmAction({
        title: "Pausar colaboración en vivo",
        message: "Dejarás de recibir cambios y de mostrar tu presencia en tiempo real hasta que reconectes o recargues la página. El viaje seguirá vinculado a la nube y tus ediciones continuarán guardándose. Al reconectar, se recuperarán los cambios pendientes.",
        confirmLabel: "Pausar conexión",
    });
    if (!accepted) return;
    pauseLiveTripStream();
    toast("Colaboración en vivo pausada. Pulsa “En pausa” para reconectar.", "info");
});
document.addEventListener("trip-save-state", renderStatus);
document.addEventListener("trip-library-changed", renderStatus);
document.addEventListener("trip-live-state", renderStatus);
document.addEventListener("trip-remote-operations", showLiveActivity);
renderStatus();
