// Entry point. Importing the side-effect modules (dialogs, dnd, actions) wires
// every event listener; then the initial paint runs once, after the whole module
// graph has evaluated — so no cross-module call fires against a half-initialised
// binding.

import { render, applyTitle } from "./render.js";
import { drawMap } from "./map.js";
import "./dialogs.js";
import "./dnd.js";
import "./actions.js";
import "./budget.js";
import "./spot-search.js";
import { store } from "./store.js";
import { refreshExchangeRate } from "./currency.js";

applyTitle();
render();
drawMap();
refreshExchangeRate().then((ok) => {
    document.querySelector("#exchangeRateStatus").textContent = ok
        ? `Cambio del ${store.exchangeRateDate}`
        : store.exchangeRate ? `Último cambio: ${store.exchangeRateDate}` : "Conversión no disponible";
    document.querySelector("#exchangeRateValue").textContent = store.exchangeRate
        ? `1 ${store.foreignCurrency} = ${store.exchangeRate.toLocaleString("es-ES", { maximumFractionDigits: 6 })} ${store.localCurrency}`
        : "Conversión no disponible";
    render({ persist: false });
});
