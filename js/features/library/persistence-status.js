import { store } from "../../core/store.js";
import { getTripRepository } from "./workspace.js";
import { combinedSyncState } from "../cloud/sync-indicator-state.js";
import { SYNC_COPY } from "../cloud/sync-state.js";

async function renderStatus() {
    const label = document.querySelector("#tripPersistenceStatus");
    const exportButton = document.querySelector("#tripPersistenceExport");
    const envelope = store.activeTripId ? await getTripRepository()?.getTrip(store.activeTripId) : null;
    const state = store.saveStatus === "saving" || store.saveStatus === "error"
        ? store.saveStatus
        : envelope?.syncState || "local";
    label.textContent = state === "error"
        ? "No se pudo guardar en este dispositivo. Exporta ahora para evitar perder cambios."
        : (SYNC_COPY[state] || "Guardado en este dispositivo");
    exportButton.hidden = state !== "error";
    document.querySelector("#tripPersistenceBar").dataset.state = state;
    const menuState = combinedSyncState(state, store.githubSyncState);
    const syncMenu = document.querySelector("#syncMenu");
    syncMenu.dataset.state = menuState;
    syncMenu.querySelector("summary").title = SYNC_COPY[menuState] || "Estado de sincronización";
}

document.querySelector("#tripPersistenceExport").addEventListener("click", () => document.querySelector("#exportBtn").click());
document.addEventListener("trip-save-state", renderStatus);
document.addEventListener("trip-library-changed", renderStatus);
document.addEventListener("github-sync-state", renderStatus);
renderStatus();
