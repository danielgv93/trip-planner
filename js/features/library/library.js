import { parsePortablePlanJson } from "../../core/portable-plan.js";
import { store } from "../../core/store.js";
import { openModal } from "../../shared/modal.js";
import { confirmAction, promptAction, toast } from "../../shared/notify.js";
import { drawMap, syncRouteVisualizationControl } from "../map/map.js";
import { syncTripNotes } from "../notes/notes.js";
import { applyTitle, render } from "../planner/render.js";
import {
    archiveTrip,
    createTrip,
    deleteTrip,
    duplicateTrip,
    getTripRepository,
    importAsNewTrip,
    renameTrip,
    switchTrip,
    waitForActiveCommit,
} from "./workspace.js";
import {
    drainOutbox,
    getRemoteLibrary,
    openRemoteTrip,
    uploadLocalTrip,
} from "../cloud/coordinator.js";
import { cloudSaveActionState } from "../cloud/global-action-state.js";
import { SYNC_COPY } from "../cloud/sync-state.js";

const dialog = document.querySelector("#libraryDialog");
const saveCloudButton = document.querySelector("#saveCloudBtn");
let showArchived = false;
let uploadingTripId = null;

function repaintActiveTrip() {
    document.body.classList.toggle("compact-itinerary", store.itineraryDensity === "compact");
    document.body.classList.remove("preview-mode");
    const preview = document.querySelector("#previewBtn");
    if (preview) {
        preview.textContent = "Vista completa";
        preview.classList.remove("active");
        preview.setAttribute("aria-pressed", "false");
    }
    for (const [selector, value] of [
        ["#routeProfile", store.routeProfile],
        ["#routeVisualization", store.routeVisualization],
        ["#basemapSelect", store.basemap],
        ["#localCurrency", store.localCurrency],
        ["#foreignCurrency", store.foreignCurrency],
    ]) {
        const control = document.querySelector(selector);
        if (control) control.value = value;
    }
    syncRouteVisualizationControl();
    applyTitle();
    syncTripNotes();
    render({ persist: false });
    drawMap();
}

function button(label, action, id, className = "") {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.dataset.libraryAction = action;
    element.dataset.tripId = id;
    element.className = className;
    return element;
}

function renderLibrary() {
    const list = document.querySelector("#libraryList");
    list.replaceChildren();
    const localByRemote = new Map(store.tripLibrary.filter((trip) => trip.remote.id).map((trip) => [trip.remote.id, trip]));
    const local = store.tripLibrary.filter((trip) => trip.archived === showArchived);
    const remoteOnly = getRemoteLibrary().filter((trip) => Boolean(trip.archived_at) === showArchived && !localByRemote.has(trip.id));

    for (const trip of [...local, ...remoteOnly]) {
        const remote = trip.remoteOnly === true;
        const id = remote ? trip.id : trip.id;
        const card = document.createElement("article");
        card.className = "library-card";
        if (!remote && trip.id === store.activeTripId) card.dataset.active = "true";
        if (!remote && trip.pendingDeletion) card.dataset.disabled = "true";
        const heading = document.createElement("div");
        const title = document.createElement("h4");
        title.textContent = remote ? trip.title : trip.document.tripTitle;
        const date = document.createElement("time");
        date.textContent = new Intl.DateTimeFormat("es-ES", { dateStyle: "medium", timeStyle: "short" }).format(new Date(remote ? trip.updated_at : trip.updatedAt));
        heading.append(title, date);
        const meta = document.createElement("div");
        meta.className = "library-card-meta";
        const availability = document.createElement("span");
        availability.textContent = remote ? "Necesita conexión para la primera apertura" : "Disponible sin conexión";
        const status = document.createElement("span");
        status.textContent = remote ? "En la nube" : (SYNC_COPY[trip.syncState] || trip.syncState);
        meta.append(availability, status);
        const actions = document.createElement("div");
        actions.className = "library-card-actions";
        if (!trip.pendingDeletion) actions.append(button(trip.id === store.activeTripId ? "Abierto" : "Abrir", remote ? "open-remote" : "open", id, "primary"));
        if (!remote && !trip.pendingDeletion) {
            actions.append(button("Renombrar", "rename", id), button("Duplicar", "duplicate", id));
            actions.append(button(showArchived ? "Restaurar" : "Archivar", "archive", id));
            actions.append(button("Eliminar", "delete", id, "danger"));
        }
        if (trip.pendingDeletion) {
            const pending = document.createElement("strong");
            pending.textContent = "Eliminación pendiente · no editable";
            actions.append(pending);
        }
        card.append(heading, meta, actions);
        list.append(card);
    }
    document.querySelector("#libraryEmpty").hidden = list.childElementCount > 0;
    document.querySelector("#libraryArchivedBtn").setAttribute("aria-pressed", String(showArchived));
    document.querySelector("#libraryArchivedBtn").textContent = showArchived ? "Ver activos" : "Ver archivados";
}

function renderGlobalCloudAction() {
    const state = cloudSaveActionState({
        activeTripId: store.activeTripId,
        trips: store.tripLibrary,
        accountSession: store.accountSession,
        cloudAvailability: store.cloudAvailability,
        uploadingTripId,
    });
    saveCloudButton.hidden = !state.visible;
    saveCloudButton.disabled = state.disabled;
    saveCloudButton.setAttribute("aria-label", state.label);
    saveCloudButton.title = `${state.title}${state.title ? " · " : ""}Ctrl/Cmd + S`;
    saveCloudButton.querySelector(".save-cloud-label").textContent = state.label;
}

document.querySelector("#libraryBtn").addEventListener("click", () => {
    renderLibrary();
    openModal(dialog);
});

document.querySelector("#libraryCreateBtn").addEventListener("click", async () => {
    const title = await promptAction({ title: "Nuevo viaje", message: "Ponle un nombre. Podrás cambiarlo después.", inputLabel: "Nombre", confirmLabel: "Crear", inputPlaceholder: "Mi próximo viaje" });
    if (title === null) return;
    await createTrip(title || "Nuevo viaje");
    repaintActiveTrip();
    renderLibrary();
});

document.querySelector("#libraryArchivedBtn").addEventListener("click", () => {
    showArchived = !showArchived;
    renderLibrary();
});

document.querySelector("#libraryImportBtn").addEventListener("click", () => document.querySelector("#libraryImportFile").click());
document.querySelector("#libraryImportFile").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
        const plan = parsePortablePlanJson(await file.text());
        await importAsNewTrip(plan);
        renderLibrary();
        toast("Viaje importado como una copia independiente.", "success");
    } catch {
        toast("Ese archivo no parece un plan válido.", "error");
    } finally {
        event.target.value = "";
    }
});

document.querySelector("#libraryList").addEventListener("click", async (event) => {
    const control = event.target.closest("[data-library-action]");
    if (!control) return;
    const { libraryAction: action, tripId: id } = control.dataset;
    try {
        if (action === "open") {
            await switchTrip(id);
            repaintActiveTrip();
            dialog.close();
        } else if (action === "open-remote") {
            await openRemoteTrip(id);
            repaintActiveTrip();
            dialog.close();
        } else if (action === "rename") {
            const current = store.tripLibrary.find((trip) => trip.id === id);
            const title = await promptAction({ title: "Renombrar viaje", message: "El título cambiará también dentro del plan.", inputLabel: "Nombre", inputPlaceholder: current.document.tripTitle, confirmLabel: "Guardar" });
            if (title !== null) await renameTrip(id, title || current.document.tripTitle);
            if (id === store.activeTripId) applyTitle();
        } else if (action === "duplicate") {
            await duplicateTrip(id);
            toast("Copia independiente creada.", "success");
        } else if (action === "archive") {
            await archiveTrip(id, !showArchived);
        } else if (action === "delete") {
            const ok = await confirmAction({ title: "Eliminar viaje", message: "Se eliminará de este dispositivo y, si corresponde, de la nube. Esta acción no se puede deshacer.", confirmLabel: "Eliminar" });
            if (ok) await deleteTrip(id);
        }
        renderLibrary();
    } catch (error) {
        toast(error.message === "TRIP_NOT_AVAILABLE" ? "Este viaje no está disponible." : "No se pudo completar la acción.", "error");
    }
});

async function saveActiveToCloud() {
    await waitForActiveCommit();
    const activeTripId = store.activeTripId;
    const activeTrip = store.tripLibrary.find((trip) => trip.id === activeTripId);
    const action = cloudSaveActionState({
        activeTripId,
        trips: store.tripLibrary,
        accountSession: store.accountSession,
        cloudAvailability: store.cloudAvailability,
        uploadingTripId,
    });
    if (!activeTrip || action.disabled || activeTrip.pendingDeletion) return false;
    uploadingTripId = activeTripId;
    renderGlobalCloudAction();
    try {
        if (activeTrip.remote.id) {
            await drainOutbox();
            const stillPending = (await getTripRepository().listOutbox())
                .some((item) => item.tripId === activeTripId);
            if (stillPending) throw new Error("CLOUD_SAVE_PENDING");
        } else {
            await uploadLocalTrip(activeTripId);
        }
        toast("Viaje guardado en tu cuenta.", "success");
        return true;
    } catch {
        toast("No se pudo guardar el viaje en la nube. Sigue disponible en este dispositivo.", "error");
        return false;
    } finally {
        if (uploadingTripId === activeTripId) uploadingTripId = null;
        renderGlobalCloudAction();
    }
}

saveCloudButton.addEventListener("click", () => void saveActiveToCloud());

document.addEventListener("keydown", (event) => {
    if (typeof event.key !== "string" || event.key.toLowerCase() !== "s" || (!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey) return;
    event.preventDefault();
    void saveActiveToCloud();
});

document.addEventListener("trip-library-changed", () => {
    renderLibrary();
    renderGlobalCloudAction();
});
document.addEventListener("remote-trip-library", renderLibrary);
document.addEventListener("active-trip-changed", () => {
    repaintActiveTrip();
    renderGlobalCloudAction();
});
document.addEventListener("cloud-session-changed", renderGlobalCloudAction);
document.addEventListener("trip-sync-needed", renderGlobalCloudAction);
renderGlobalCloudAction();

export { renderLibrary, repaintActiveTrip };
