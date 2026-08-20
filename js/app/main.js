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
import "../features/reminders/reminders.js";
import "../features/health/health.js";
import "../features/github/github.js";
import "../features/finance/budget.js";
import "../features/workspace/workspace-resize.js";
import "../features/library/library.js";
import "../features/library/persistence-status.js";
import "../features/cloud/account.js";
import "../features/cloud/conflicts.js";
import "../features/cloud/history.js";
import "../features/cloud/collaborators.js";
import { render, applyTitle } from "../features/planner/render.js";
import { drawMap } from "../features/map/map.js";
import { initCompanion } from "../features/companion/companion.js";
import { refreshExchangeRate } from "../features/finance/currency.js";
import { initializeTripWorkspace } from "../features/library/workspace.js";
import { initializeCloud } from "../features/cloud/coordinator.js";
import { initializeLiveTripStream } from "../features/cloud/live-trip.js";
import { bootstrapPublicView, publicShareToken } from "../features/share/public-view.js";

function startExchangeRate() {
    refreshExchangeRate().then((ok) => {
        document.querySelector("#exchangeRateStatus").textContent = ok
            ? `Cambio del ${store.exchangeRateDate}`
            : store.exchangeRate ? `Último cambio: ${store.exchangeRateDate}` : "Conversión no disponible";
        document.querySelector("#exchangeRateValue").textContent = store.exchangeRate
            ? `1 ${store.foreignCurrency} = ${store.exchangeRate.toLocaleString("es-ES", { maximumFractionDigits: 6 })} ${store.localCurrency}`
            : "Conversión no disponible";
        render({ persist: false });
    });
}

// A visitor arriving from a share link gets a completely different startup: no
// local repository, no cloud session, no companion mode and no assistant. The
// device of whoever opens the link stays untouched.
const shareToken = publicShareToken();
if (shareToken) {
    const publicView = await bootstrapPublicView(shareToken);
    document.querySelector("#publicViewBanner").hidden = !publicView.loaded;
    if (publicView.loaded) startExchangeRate();
} else {
    const workspace = await initializeTripWorkspace();
    applyTitle();
    render();
    drawMap();
    initCompanion();
    await initializeCloud().catch((error) => {
        console.warn("La nube no está disponible; se mantiene el modo local.", error);
    });
    // Live collaboration only makes sense once the session is resolved: the
    // stream is authenticated by the same cookie the cloud bootstrap validates.
    initializeLiveTripStream();
    if (!workspace.hasActiveTrip) document.querySelector("#libraryBtn")?.click();

    import("../features/assistant/llm-chat.js")
        .then(({ initLlmChat }) => initLlmChat())
        .catch((error) => {
            console.error("No se pudo iniciar el asistente del viaje", error);
            const launcher = document.querySelector("#llmChatLauncher");
            if (launcher) launcher.title = `No se pudo iniciar el asistente: ${error.message}`;
        });
    startExchangeRate();
}
