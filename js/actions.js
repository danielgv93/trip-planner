// Header / top-bar actions: trip title editing, add day, preview toggle, reset,
// import/export. Side-effect module — importing it wires the top-bar listeners.

import { store, save, clearTagFilter } from "./store.js";
import { $, slug, id } from "./dom.js";
import { render, applyTitle } from "./render.js";
import { drawMap, syncRouteVisualizationControl } from "./map.js";
import { toast, confirmAction } from "./notify.js";
import { sample, DEFAULT_CATEGORIES, DEFAULT_TITLE } from "./constants.js";
import { syncTripNotes } from "./notes.js";
import { CURRENCIES, refreshExchangeRate } from "./currency.js";

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
    btn.textContent = store.previewMode ? "Editar" : "Previsualizar";
    btn.classList.toggle("active", store.previewMode);
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
            {
                version: 16,
                exportedAt: new Date().toISOString(),
                tripTitle: store.tripTitle,
                localCurrency: store.localCurrency,
                foreignCurrency: store.foreignCurrency,
                exchangeRate: store.exchangeRate,
                exchangeRateDate: store.exchangeRateDate,
                tripNotes: store.tripNotes,
                days: store.state,
                backlog: store.backlog,
                tags: store.tags,
                categories: store.categories,
                routeProfile: store.routeProfile,
                routeVisualization: store.routeVisualization,
            },
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

// Header "Gestionar" menu: a native <details> dropdown holding the tag and
// category managers (their #manageTags/#manageCategories click handlers still
// live in dialogs.js, wired by id). Unlike <select>, <details> doesn't close on
// its own, so close it when an option is chosen (it opens a modal dialog) and
// when the user clicks anywhere outside the menu.
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

// Mobile hamburger: toggles the collapsed action bar (see the max-width:600px
// block in styles.css). Desktop hides #navToggle, so this is a no-op there.
const navToggle = $("#navToggle");
const topActions = navToggle && navToggle.closest(".top-actions");
if (navToggle && topActions) {
    const closeNav = () => {
        topActions.classList.remove("nav-open");
        navToggle.setAttribute("aria-expanded", "false");
    };
    navToggle.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = topActions.classList.toggle("nav-open");
        navToggle.setAttribute("aria-expanded", String(open));
    });
    // Close after choosing an action, but keep it open when toggling the
    // nested "Gestionar" <summary> (which isn't a <button>).
    $("#navMenuItems").addEventListener("click", (e) => {
        if (e.target.closest("button")) closeNav();
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
        const plan = JSON.parse(await file.text());
        if (!Array.isArray(plan.days)) throw Error();
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
        store.state = plan.days;
        store.backlog = Array.isArray(plan.backlog) ? plan.backlog : [];
        store.tags = Array.isArray(plan.tags) ? plan.tags : store.tags;
        store.categories = Array.isArray(plan.categories)
            ? plan.categories
            : store.categories;
        if (typeof plan.tripTitle === "string") store.tripTitle = plan.tripTitle;
        store.localCurrency = typeof plan.localCurrency === "string" ? plan.localCurrency : "EUR";
        store.foreignCurrency = typeof plan.foreignCurrency === "string" ? plan.foreignCurrency : "JPY";
        store.exchangeRate = Number.isFinite(plan.exchangeRate) ? plan.exchangeRate : null;
        store.exchangeRateDate = typeof plan.exchangeRateDate === "string" ? plan.exchangeRateDate : "";
        store.tripNotes = typeof plan.tripNotes === "string" ? plan.tripNotes : "";
        if (["walking", "driving", "cycling"].includes(plan.routeProfile)) {
            store.routeProfile = plan.routeProfile;
            $("#routeProfile").value = store.routeProfile;
        }
        store.routeVisualization = ["straight", "streets"].includes(
            plan.routeVisualization,
        )
            ? plan.routeVisualization
            : "straight";
        $("#routeVisualization").value = store.routeVisualization;
        syncRouteVisualizationControl();
        store.active = store.state[0]?.id || "backlog";
        clearTagFilter();
        applyTitle();
        syncTripNotes();
        save();
        render();
        drawMap();
        toast("Plan importado correctamente.", "success");
    } catch {
        toast("Ese archivo no parece un plan válido.", "error");
    }
    e.target.value = "";
};
