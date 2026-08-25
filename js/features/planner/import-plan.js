// Application-level import workflow. The portable codec stays in core while
// this module owns the browser/UI synchronization required after replacing a plan.

import { store } from "../../core/store.js";
import { clearHealthResults } from "../health/session.js";
import { normalizePlan } from "../../core/plan-json.js";
import { applyTitle } from "./render.js";
import { syncRouteVisualizationControl } from "../map/map.js";
import { syncTripNotes } from "../notes/notes.js";
import { derivedPlanOperation, replacePlanIntent } from "../../core/plan-operation-commit.js";

function setControlValue(selector, value) {
    const control = document.querySelector(selector);
    if (control) control.value = value;
}

export async function applyImportedPlan(plan) {
    const normalized = normalizePlan(plan);
    await derivedPlanOperation((document) => replacePlanIntent(document, normalized));
    clearHealthResults();

    document.body.classList.remove("preview-mode");
    const previewBtn = document.querySelector("#previewBtn");
    if (previewBtn) {
        previewBtn.textContent = "Vista completa";
        previewBtn.classList.remove("active");
        previewBtn.setAttribute("aria-pressed", "false");
    }

    setControlValue("#routeProfile", store.routeProfile);
    setControlValue("#routeVisualization", store.routeVisualization);
    setControlValue("#localCurrency", store.localCurrency);
    setControlValue("#foreignCurrency", store.foreignCurrency);

    const currencyLabel = document.querySelector("#currencyConfigLabel");
    const exchangeRateValue = document.querySelector("#exchangeRateValue");
    const exchangeRateStatus = document.querySelector("#exchangeRateStatus");
    if (currencyLabel)
        currencyLabel.textContent = `${store.foreignCurrency} → ${store.localCurrency}`;
    if (exchangeRateValue) {
        exchangeRateValue.textContent = store.exchangeRate
            ? `1 ${store.foreignCurrency} = ${store.exchangeRate.toLocaleString("es-ES", { maximumFractionDigits: 6 })} ${store.localCurrency}`
            : "Conversión no disponible";
    }
    if (exchangeRateStatus) {
        exchangeRateStatus.textContent = store.exchangeRateDate
            ? `Último cambio: ${store.exchangeRateDate}`
            : "Conversión no disponible";
    }

    syncRouteVisualizationControl();
    applyTitle();
    syncTripNotes();
}
