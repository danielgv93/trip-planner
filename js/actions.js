// Header / top-bar actions: trip title editing, add day, preview toggle, reset,
// import/export. Side-effect module — importing it wires the top-bar listeners.

import { store, save, clearTagFilter } from "./store.js";
import { $, slug, id } from "./dom.js";
import { render, applyTitle } from "./render.js";
import { drawMap, syncRouteVisualizationControl } from "./map.js";
import { toast, confirmAction } from "./notify.js?v=3";
import { sample, DEFAULT_CATEGORIES, DEFAULT_TITLE } from "./constants.js";
import { syncTripNotes } from "./notes.js";
import { CURRENCIES, refreshExchangeRate } from "./currency.js";
import { serializePlan, parsePlanJson, applyImportedPlan } from "./plan-json.js?v=29";

$("#tripTitle").addEventListener("input", (e) => {
    store.tripTitle = e.target.value;
    document.title = (store.tripTitle || "Viaje") + " · Planificador de ruta";
    save();
});

function fillCurrencySelect(select) {
    select.innerHTML = CURRENCIES.map(([code, name]) =>
        `<option value="${code}">${code} · ${name}</option>`,
    ).join("");
}
fillCurrencySelect($("#localCurrency"));
fillCurrencySelect($("#foreignCurrency"));

function syncCurrencyUi() {
    $("#currencyConfigLabel").textContent = `${store.foreignCurrency} → ${store.localCurrency}`;
    $("#exchangeRateValue").textContent = store.exchangeRate
        ? `1 ${store.foreignCurrency} = ${store.exchangeRate.toLocaleString("es-ES", { maximumFractionDigits: 6 })} ${store.localCurrency}`
        : "Conversión no disponible";
}
syncCurrencyUi();

const currencyDialog = $("#currencyDialog");
$("#currencyConfigBtn").onclick = () => currencyDialog.showModal();
currencyDialog.querySelector(".close").onclick = () => currencyDialog.close();
currencyDialog.addEventListener("click", (event) => {
    if (event.target === currencyDialog) currencyDialog.close();
});

async function changeCurrency(key, value) {
    store[key] = value;
    store.exchangeRate = null;
    store.exchangeRateDate = "";
    $("#exchangeRateStatus").textContent = "Actualizando cambio…";
    save();
    syncCurrencyUi();
    render({ persist: false });
    const ok = await refreshExchangeRate();
    $("#exchangeRateStatus").textContent = ok
        ? `Cambio del ${store.exchangeRateDate}`
        : "Sin conexión · conversión no disponible";
    syncCurrencyUi();
    render({ persist: false });
}
$("#localCurrency").addEventListener("change", (e) => changeCurrency("localCurrency", e.target.value));
$("#foreignCurrency").addEventListener("change", (e) => changeCurrency("foreignCurrency", e.target.value));

$("#addDay").onclick = () => {
    const date = store.state.length
        ? new Date(store.state[store.state.length - 1].date + "T12:00:00")
        : new Date();
    date.setDate(date.getDate() + 1);
    const d = {
        id: id(),
        date: date.toISOString().slice(0, 10),
        title: "Nuevo día",
        spots: [],
    };
    store.state.push(d);
    store.active = d.id;
    save();
    render();
    drawMap();
};

function togglePreview() {
    store.previewMode = !store.previewMode;
    document.body.classList.toggle("preview-mode", store.previewMode);
    const btn = $("#previewBtn");
    btn.textContent = store.previewMode ? "Editar plan" : "Vista completa";
    btn.classList.toggle("active", store.previewMode);
    btn.setAttribute("aria-pressed", String(store.previewMode));
    render();
    drawMap();
}
$("#previewBtn").onclick = togglePreview;

$("#resetBtn").onclick = () => {
    confirmAction({
        title: "Restaurar ejemplo",
        message:
            "¿Restaurar el ejemplo? Se perderán tus cambios guardados en este navegador.",
        confirmLabel: "Restaurar",
    }).then((ok) => {
        if (!ok) return;
        store.state = structuredClone(sample);
        store.backlog = [];
        store.tags = ["comida", "templo", "reserva", "compras"];
        store.categories = structuredClone(DEFAULT_CATEGORIES);
        store.tripTitle = DEFAULT_TITLE;
        store.localCurrency = "EUR";
        store.foreignCurrency = "JPY";
        store.exchangeRate = null;
        store.exchangeRateDate = "";
        store.tripNotes = "";
        store.routeVisualization = "straight";
        $("#routeVisualization").value = store.routeVisualization;
        syncRouteVisualizationControl();
        store.active = "d1";
        clearTagFilter();
        applyTitle();
        syncTripNotes();
        save();
        render();
        drawMap();
        toast("Ejemplo restaurado.", "info");
    });
};

$("#exportBtn").onclick = () => {
    const data = JSON.stringify(
            serializePlan(),
            null,
            2,
        ),
        url = URL.createObjectURL(
            new Blob([data], { type: "application/json" }),
        ),
        a = document.createElement("a");
    a.href = url;
    a.download = "ruta-" + slug(store.tripTitle) + ".json";
    a.click();
    URL.revokeObjectURL(url);
};

// Header overflow menu: taxonomy management and the destructive sample reset.
// Their existing handlers remain wired by id; close the native <details> after
// choosing an action and when clicking outside it.
const manageMenu = $("#manageMenu");
if (manageMenu) {
    manageMenu.addEventListener("click", (e) => {
        if (e.target.closest(".manage-menu-items button")) manageMenu.open = false;
    });
    document.addEventListener("click", (e) => {
        if (manageMenu.open && !manageMenu.contains(e.target))
            manageMenu.open = false;
    });
}

$("#importBtn").onclick = () => $("#importFile").click();

// Responsive hamburger: toggles the action bar at compact widths. Desktop
// hides #navToggle, so this listener is a no-op there.
const navToggle = $("#navToggle");
const topActions = navToggle && navToggle.closest(".top-actions");
if (navToggle && topActions) {
    const closeNav = () => {
        topActions.classList.remove("nav-open");
        navToggle.setAttribute("aria-expanded", "false");
        navToggle.setAttribute("aria-label", "Abrir menú");
        if (matchMedia("(max-width: 860px)").matches && manageMenu)
            manageMenu.open = false;
    };
    navToggle.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = topActions.classList.toggle("nav-open");
        navToggle.setAttribute("aria-expanded", String(open));
        navToggle.setAttribute("aria-label", open ? "Cerrar menú" : "Abrir menú");
        if (matchMedia("(max-width: 860px)").matches && manageMenu)
            manageMenu.open = open;
    });
    // Close after choosing an action, but keep it open when toggling the
    // nested "Gestionar" <summary> (which isn't a <button>).
    $("#navMenuItems").addEventListener("click", (e) => {
        if (e.target.closest("button") && !e.target.closest("#githubOpenBtn")) closeNav();
    });
    document.addEventListener("click", (e) => {
        if (topActions.classList.contains("nav-open") && !topActions.contains(e.target))
            closeNav();
    });
}
$("#importFile").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        const plan = parsePlanJson(await file.text());
        const ok = await confirmAction({
            title: "Importar plan",
            message:
                "¿Importar este plan? Sustituirá la ruta guardada actualmente.",
            confirmLabel: "Importar",
        });
        if (!ok) {
            e.target.value = "";
            return;
        }
        applyImportedPlan(plan);
        toast("Plan importado correctamente.", "success");
    } catch {
        toast("Ese archivo no parece un plan válido.", "error");
    }
    e.target.value = "";
};
