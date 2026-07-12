// Read-only budget breakdown dialog. It derives every value from the shared
// store, so moving or editing spots needs no budget-specific mutation path.

import { store } from "./store.js";
import { $, esc } from "./dom.js";
import { sumCosts, formatCost } from "./render.js";

const dialog = $("#budgetDialog");

function validCost(spot) {
    return Number.isFinite(spot?.cost) && spot.cost > 0 ? spot.cost : 0;
}

function renderGroup(title, spots) {
    const pricedSpots = spots.filter(
        (spot) => Number.isFinite(spot?.cost) && spot.cost > 0,
    );
    const rows = pricedSpots.length
        ? pricedSpots
              .map(
                  (spot) =>
                      `<tr><td>${esc(spot.name || "Parada sin nombre")}</td><td>${esc(formatCost(validCost(spot)))}</td></tr>`,
              )
              .join("")
        : '<tr><td colspan="2" class="budget-empty">Sin paradas con coste</td></tr>';
    return `<section class="budget-group"><div class="budget-group-head"><h4>${esc(title)}</h4><strong>${esc(formatCost(sumCosts(spots)))}</strong></div><div class="budget-table-wrap"><table><thead><tr><th>Parada</th><th>Coste</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderBudget() {
    const groups = [
        { title: "Backlog", spots: store.backlog },
        ...store.state.map((day) => ({ title: day.title, spots: day.spots })),
    ];
    $("#budgetTables").innerHTML = groups
        .map((group) => renderGroup(group.title, group.spots))
        .join("");
    $("#budgetGrandTotal").textContent = formatCost(
        groups.reduce((total, group) => total + sumCosts(group.spots), 0),
    );
}

$("#budgetBtn").onclick = () => {
    renderBudget();
    dialog.showModal();
};

dialog.querySelector(".close").onclick = () => dialog.close();
dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
});
