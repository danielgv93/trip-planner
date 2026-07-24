// Entry point. Importing the side-effect modules (dialogs, dnd, actions) wires
// every event listener; then the initial paint runs once, after the whole module
// graph has evaluated — so no cross-module call fires against a half-initialised
// binding.

import { store } from "../core/store.js?v=28";
import "../shared/modal-scroll.js?v=1";
import "../features/planner/dialogs.js?v=3";
import "../features/planner/dnd.js";
import "../features/planner/undo-controls.js?v=2";
import "../features/planner/actions.js?v=36";
import "../features/planner/spot-search.js";
import "../features/planner/sticky-days.js";
import "../features/health/health.js?v=3";
import "../features/github/github.js?v=34";
import "../features/finance/budget.js?v=30";
import "../features/workspace/workspace-resize.js?v=3";
import { render, applyTitle } from "../features/planner/render.js";
import { drawMap } from "../features/map/map.js";
import { initCompanion } from "../features/companion/companion.js?v=9";
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

import("../features/assistant/llm-chat.js?v=15")
    .then(({ initLlmChat }) => initLlmChat())
    .catch((error) => {
        console.error("No se pudo iniciar el asistente del viaje", error);
        const launcher = document.querySelector("#llmChatLauncher");
        if (launcher) launcher.title = `No se pudo iniciar el asistente: ${error.message}`;
    });
