// Read-only budget breakdown dialog. It derives every value from the shared
// store, so moving or editing spots needs no budget-specific mutation path.

import { store, spotIsEnabled } from "../../core/store.js?v=26";
import { $, esc } from "../../shared/dom.js";
import { sumCosts } from "../planner/render.js";
import { foreignAmount, localAmount } from "./currency.js";

const dialog = $("#budgetDialog");

function validCost(spot) {
    return Number.isFinite(spot?.cost) && spot.cost > 0 ? spot.cost : 0;
}

function renderGroup(title, spots) {
    const pricedSpots = spots.filter(
        (spot) =>
            spotIsEnabled(spot) &&
            Number.isFinite(spot?.cost) &&
            spot.cost > 0,
    );
    const rows = pricedSpots.length
        ? pricedSpots
              .map(
                  (spot) =>
                      `<tr><td>${esc(spot.name || "Parada sin nombre")}</td><td>${esc(foreignAmount(validCost(spot)))}</td><td>${esc(localAmount(validCost(spot)))}</td></tr>`,
              )
              .join("")
        : '<tr><td colspan="3" class="budget-empty">Sin paradas con coste</td></tr>';
    const total = sumCosts(spots);
    return `<section class="budget-group"><div class="budget-group-head"><h4>${esc(title)}</h4><strong>${esc(foreignAmount(total))}<small>${esc(localAmount(total))}</small></strong></div><div class="budget-table-wrap"><table><thead><tr><th>Parada</th><th>${esc(store.foreignCurrency)}</th><th>${esc(store.localCurrency)}</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderBudget() {
    const groups = [
        { title: "Backlog", spots: store.backlog },
        ...store.state.map((day) => ({ title: day.title, spots: day.spots })),
    ];
    $("#budgetTables").innerHTML = groups
        .map((group) => renderGroup(group.title, group.spots))
        .join("");
    const total = groups.reduce((sum, group) => sum + sumCosts(group.spots), 0);
    $("#budgetGrandTotalForeign").textContent = foreignAmount(total);
    $("#budgetGrandTotal").textContent = localAmount(total);
    $("#budgetRateInfo").textContent = store.exchangeRate
        ? `1 ${store.foreignCurrency} = ${store.exchangeRate.toLocaleString("es-ES", { maximumFractionDigits: 6 })} ${store.localCurrency} · ${store.exchangeRateDate}`
        : "Tipo de cambio no disponible";
}

$("#tripBudgetTotal").onclick = () => {
    renderBudget();
    dialog.showModal();
};

dialog.querySelector(".close").onclick = () => dialog.close();
dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
});
