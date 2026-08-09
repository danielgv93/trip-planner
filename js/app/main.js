// Entry point. Importing the side-effect modules (dialogs, dnd, actions) wires
// every event listener; then the initial paint runs once, after the whole module
// graph has evaluated — so no cross-module call fires against a half-initialised
// binding.

import { store } from "../core/store.js";
import "../shared/modal.js";
import "../features/planner/dialogs.js";
import "../features/planner/dnd.js";
import "../features/planner/undo-controls.js";
import "../features/planner/actions.js";
import "../features/planner/spot-search.js";
import "../features/planner/sticky-days.js";
import "../features/guide/onboarding.js";
import "../features/health/health.js";
import "../features/github/github.js";
import "../features/finance/budget.js";
import "../features/workspace/workspace-resize.js";
import { render, applyTitle } from "../features/planner/render.js";
import { drawMap } from "../features/map/map.js";
import { initCompanion } from "../features/companion/companion.js";
import { refreshExchangeRate } from "../features/finance/currency.js";

applyTitle();
render();
drawMap();
initCompanion();
refreshExchangeRate().then((ok) => {
    document.querySelector("#exchangeRateStatus").textContent = ok
        ? `Cambio del ${store.exchangeRateDate}`
        : store.exchangeRate ? `Último cambio: ${store.exchangeRateDate}` : "Conversión no disponible";
    document.querySelector("#exchangeRateValue").textContent = store.exchangeRate
        ? `1 ${store.foreignCurrency} = ${store.exchangeRate.toLocaleString("es-ES", { maximumFractionDigits: 6 })} ${store.localCurrency}`
        : "Conversión no disponible";
    render({ persist: false });
});

import("../features/assistant/llm-chat.js")
    .then(({ initLlmChat }) => initLlmChat())
    .catch((error) => {
        console.error("No se pudo iniciar el asistente del viaje", error);
        const launcher = document.querySelector("#llmChatLauncher");
        if (launcher) launcher.title = `No se pudo iniciar el asistente: ${error.message}`;
    });
