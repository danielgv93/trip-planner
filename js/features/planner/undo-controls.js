// Header controls and keyboard shortcuts for the planner history.

import { store } from "../../core/store.js";
import { $ } from "../../shared/dom.js";
import { syncTripNotes } from "../notes/notes.js";
import { drawMap, syncRouteVisualizationControl } from "../map/map.js";
import { isDragInProgress } from "./dnd.js";
import { applyTitle, render } from "./render.js";
import { refreshRemindersView } from "../reminders/reminders.js";
import {
    configureHistoryView,
    redo,
    subscribeHistory,
    undo,
} from "./history.js";

function syncRestoredControls() {
    applyTitle();
    $("#routeProfile").value = store.routeProfile;
    $("#routeVisualization").value = store.routeVisualization;
    syncRouteVisualizationControl();
    $("#currencyConfigLabel").textContent = `${store.foreignCurrency} → ${store.localCurrency}`;
    $("#exchangeRateValue").textContent = store.exchangeRate
        ? `1 ${store.foreignCurrency} = ${store.exchangeRate.toLocaleString("es-ES", { maximumFractionDigits: 6 })} ${store.localCurrency}`
        : "Conversión no disponible";
    $("#exchangeRateStatus").textContent = store.exchangeRateDate
        ? `Último cambio: ${store.exchangeRateDate}`
        : "Conversión no disponible";
    syncTripNotes();
    render();
    drawMap();
    if (document.querySelector("#remindersDialog")?.open)
        refreshRemindersView();
    document.dispatchEvent(new CustomEvent("reminders-changed"));
}

configureHistoryView(syncRestoredControls);

const undoButton = $("#undoBtn");
const redoButton = $("#redoBtn");
undoButton.onclick = undo;
redoButton.onclick = redo;
subscribeHistory(({ canUndo, canRedo }) => {
    undoButton.disabled = !canUndo;
    redoButton.disabled = !canRedo;
});

window.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (typeof event.key !== "string" || event.key.toLowerCase() !== "z") return;

    const focused = document.activeElement;
    if (
        focused?.matches("input, textarea") ||
        focused?.isContentEditable ||
        document.querySelector("dialog[open]") ||
        isDragInProgress() ||
        document.querySelector(".is-timeline-dragging")
    )
        return;

    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
});
