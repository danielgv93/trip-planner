// Header / top-bar actions: trip title editing, add day, preview toggle, reset,
// import/export. Side-effect module — importing it wires the top-bar listeners.

import { store, save, clearTagFilter } from "../../core/store.js";
import { $, slug, id } from "../../shared/dom.js";
import { openModal } from "../../shared/modal.js";
import { render, applyTitle } from "./render.js";
import { drawMap, syncRouteVisualizationControl } from "../map/map.js";
import { toast, confirmAction } from "../../shared/notify.js";
import { sample, DEFAULT_CATEGORIES, DEFAULT_TITLE } from "../../core/constants.js";
import { syncTripNotes } from "../notes/notes.js";
import { CURRENCIES, refreshExchangeRate } from "../finance/currency.js";
import { serializePlan, parsePlanJson } from "../../core/plan-json.js";
import { applyImportedPlan } from "./import-plan.js";
import { pushUndo } from "./history.js";

let titleEditCaptured = false;
$("#tripTitle").addEventListener("focus", () => {
    titleEditCaptured = false;
});
$("#tripTitle").addEventListener("input", (e) => {
    if (!titleEditCaptured) {
        pushUndo();
        titleEditCaptured = true;
    }
    store.tripTitle = e.target.value;
    document.title = (store.tripTitle || "Viaje") + " · Planificador de ruta";
    save();
});
$("#tripTitle").addEventListener("blur", () => {
    titleEditCaptured = false;
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
$("#currencyConfigBtn").onclick = () => openModal(currencyDialog);

function syncItineraryDensity() {
    const density = store.itineraryDensity === "compact"
        ? "compact"
        : "comfortable";
    document.body.classList.toggle("compact-itinerary", density === "compact");
    document.querySelectorAll("[data-density]").forEach((button) => {
        const active = button.dataset.density === density;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
    });
}

document.querySelectorAll("[data-density]").forEach((button) => {
    button.addEventListener("click", () => {
        const density = button.dataset.density;
        if (!["comfortable", "compact"].includes(density) || density === store.itineraryDensity)
            return;
        store.itineraryDensity = density;
        syncItineraryDensity();
        save();
        // Compact markup omits secondary route-source copy entirely, so the
        // destructive render keeps the DOM aligned with the chosen density.
        render({ persist: false });
    });
});
syncItineraryDensity();

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
    pushUndo();
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
        pushUndo();
        store.state = structuredClone(sample);
        store.backlog = [];
        store.backlogGroups = [];
        store.tags = ["comida", "templo", "reserva", "compras"];
        store.categories = structuredClone(DEFAULT_CATEGORIES);
        store.tripTitle = DEFAULT_TITLE;
        store.localCurrency = "EUR";
        store.foreignCurrency = "JPY";
        store.exchangeRate = null;
        store.exchangeRateDate = "";
        store.tripNotePages = [{
            id: "notes-general",
            title: "General",
            content: "",
        }];
        store.activeTripNotePageId = "notes-general";
        store.travelLegs = {};
        store.reminders = [];
        store.routeTimeOverrides = {};
        store.routeTimeProfiles = {};
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

// Named navigation groups replace the previous catch-all overflow. Keep only
// one desktop menu open and close it after choosing a concrete action.
const navGroups = [...document.querySelectorAll(".nav-group")];
const desktopHoverNavigation = () =>
    matchMedia("(min-width: 1401px) and (hover: hover) and (pointer: fine)").matches;
navGroups.forEach((group) => {
    let hoverCloseTimer;
    group.addEventListener("toggle", () => {
        if (!group.open || matchMedia("(max-width: 1400px)").matches) return;
        navGroups.forEach((other) => { if (other !== group) other.open = false; });
    });
    group.addEventListener("click", (e) => {
        if (e.target.closest(".nav-group-items > button")) group.open = false;
    });
    group.addEventListener("pointerenter", () => {
        if (!desktopHoverNavigation()) return;
        clearTimeout(hoverCloseTimer);
        group.open = true;
    });
    group.addEventListener("pointerleave", () => {
        if (!desktopHoverNavigation()) return;
        clearTimeout(hoverCloseTimer);
        hoverCloseTimer = setTimeout(() => { group.open = false; }, 120);
    });
});
document.addEventListener("click", (e) => {
    navGroups.forEach((group) => {
        if (group.open && !group.contains(e.target)) group.open = false;
    });
});

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
        navGroups.forEach((group) => { group.open = false; });
    };
    navToggle.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = topActions.classList.toggle("nav-open");
        navToggle.setAttribute("aria-expanded", String(open));
        navToggle.setAttribute("aria-label", open ? "Cerrar menú" : "Abrir menú");
    });
    // Close after choosing an action; summaries only expand their group.
    $("#navMenuItems").addEventListener("click", (e) => {
        if (e.target.closest("button") && !e.target.closest("#githubOpenBtn, #accountBtn")) closeNav();
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
