import { openModal } from "../../shared/modal.js";
import { confirmAction, toast } from "../../shared/notify.js";
import { commitPlanOperation } from "../../core/plan-operation-commit.js";
import { getTripRepository, refreshTripLibrary } from "../library/workspace.js";
import { catchUpLiveTripOperations } from "./live-trip.js";
import { resolveConflict } from "./coordinator.js";
import {
    canCombineConflict,
    canRecreateConflict,
    conflictCopyText,
    conflictLocalValue,
    conflictRemoteValue,
    conflictResolutionIntent,
} from "./operation-conflict-resolution.js";

const dialog = document.querySelector("#conflictDialog");
const localizedDialog = document.querySelector("#localizedConflictDialog");
const localizedList = localizedDialog.querySelector("#localizedConflictList");
const localizedStatus = localizedDialog.querySelector("#localizedConflictStatus");
let activeConflictId = null;
let localizedTripId = null;

const TARGET_COPY = {
    plan: "el viaje",
    day: "un día",
    spot: "una parada",
    "backlog-group": "un grupo de pendientes",
    category: "una categoría",
    tag: "una etiqueta",
    "note-page": "una página de notas",
    reminder: "un recordatorio",
    "travel-leg": "un trayecto",
};

function displayValue(value) {
    if (value === undefined) return "No existe en la nube";
    if (value === null) return "Vacío";
    if (typeof value === "string") return value || "Vacío";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
}

function actionButton(action, label, className = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.localizedConflictAction = action;
    button.textContent = label;
    if (className) button.className = className;
    return button;
}

function conflictCard(entry) {
    const card = document.createElement("article");
    card.className = "localized-conflict-card";
    card.dataset.localSequence = String(entry.localSequence);
    const operation = entry.operation;
    const heading = document.createElement("div");
    heading.className = "localized-conflict-heading";
    const title = document.createElement("h4");
    title.textContent = operation.kind === "move-entity"
        ? `Se movió ${TARGET_COPY[operation.target.type] || "un elemento"} en otro lugar`
        : entry.conflict?.code === "ENTITY_DELETED"
            ? `${TARGET_COPY[operation.target.type] || "El elemento"} se eliminó en otra sesión`
            : `Cambió ${TARGET_COPY[operation.target.type] || "el mismo elemento"} en otra sesión`;
    const meta = document.createElement("small");
    meta.textContent = `Revisión remota ${entry.conflict?.currentRevision ?? entry.conflict?.remoteRevision ?? "actual"}`;
    heading.append(title, meta);

    const comparison = document.createElement("div");
    comparison.className = "localized-conflict-comparison";
    [["Tu cambio", conflictLocalValue(entry)], ["Versión actual", conflictRemoteValue(entry)]]
        .forEach(([label, value]) => {
            const block = document.createElement("div");
            const strong = document.createElement("strong");
            const text = document.createElement("p");
            strong.textContent = label;
            text.textContent = displayValue(value);
            block.append(strong, text);
            comparison.append(block);
        });

    const actions = document.createElement("div");
    actions.className = "localized-conflict-actions";
    actions.append(actionButton("remote", "Conservar la versión actual"));
    if (entry.conflict?.code === "ENTITY_DELETED") {
        actions.append(actionButton("copy", "Copiar mi contenido"));
        if (canRecreateConflict(entry)) actions.append(actionButton("recreate", "Recrear como copia", "primary"));
    } else {
        actions.append(actionButton("local", operation.kind === "move-entity" ? "Reintentar el movimiento" : "Aplicar mi cambio", "primary"));
    }
    if (canCombineConflict(entry)) {
        const combine = document.createElement("div");
        combine.className = "localized-conflict-combine";
        const label = document.createElement("label");
        const span = document.createElement("span");
        const textarea = document.createElement("textarea");
        span.textContent = "Combinar texto";
        textarea.rows = 4;
        textarea.value = `${conflictRemoteValue(entry)}\n${conflictLocalValue(entry)}`;
        label.append(span, textarea);
        combine.append(label, actionButton("combine", "Guardar combinación"));
        card.append(heading, comparison, actions, combine);
    } else card.append(heading, comparison, actions);
    return card;
}

async function renderLocalizedConflicts(tripId = localizedTripId) {
    localizedTripId = tripId;
    const entries = tripId
        ? (await getTripRepository()?.listOperations(tripId) || []).filter((entry) => entry.status === "conflict")
        : [];
    localizedList.replaceChildren(...entries.map(conflictCard));
    localizedStatus.textContent = entries.length
        ? `${entries.length} cambio${entries.length === 1 ? "" : "s"} necesita${entries.length === 1 ? "" : "n"} tu decisión. El resto sigue sincronizándose.`
        : "No quedan cambios por revisar.";
    if (!entries.length && localizedDialog.open) localizedDialog.close();
    return entries;
}

async function openLocalizedConflicts(tripId) {
    const entries = await renderLocalizedConflicts(tripId);
    if (entries.length) openModal(localizedDialog);
}

async function resolveLocalizedEntry(entry, action, mergedValue) {
    if (action === "copy") {
        await navigator.clipboard.writeText(conflictCopyText(entry));
        toast("Tu contenido se copió al portapapeles.", "success");
        return;
    }
    const repository = getTripRepository();
    const targetRevision = Number(entry.conflict?.currentRevision || entry.conflict?.remoteRevision) || 0;
    await catchUpLiveTripOperations(entry.tripId, targetRevision);
    const current = await repository.getOperation(entry.tripId, entry.localSequence);
    if (!current || current.status !== "conflict") return;
    if (action !== "remote") {
        await commitPlanOperation(
            (document) => conflictResolutionIntent(document, current, action, { mergedValue }),
            { tripId: entry.tripId },
        );
    }
    await repository.discardOperationConflict(entry.tripId, entry.localSequence);
    await refreshTripLibrary();
    document.dispatchEvent(new CustomEvent("trip-save-state"));
}

document.addEventListener("trip-conflict", (event) => {
    activeConflictId = event.detail.tripId;
    openModal(dialog);
});

dialog.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-conflict-action]")?.dataset.conflictAction;
    if (!action || !activeConflictId) return;
    if (action === "local") {
        const ok = await confirmAction({ title: "Conservar tus cambios", message: "Tu copia se publicará como una revisión posterior a la versión actual de la nube.", confirmLabel: "Publicar mis cambios" });
        if (!ok) return;
}
    try {
        await resolveConflict(activeConflictId, action);
        activeConflictId = null;
        dialog.close();
        toast("Conflicto resuelto sin perder ninguna versión.", "success");
    } catch {
        toast("No se pudo resolver el conflicto. Tus cambios siguen guardados.", "error");
    }
});

document.addEventListener("trip-operation-conflict", (event) => {
    void openLocalizedConflicts(event.detail.tripId);
});

document.addEventListener("review-operation-conflicts", (event) => {
    void openLocalizedConflicts(event.detail?.tripId);
});

localizedDialog.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-localized-conflict-action]");
    const card = button?.closest("[data-local-sequence]");
    if (!button || !card || !localizedTripId) return;
    const sequence = Number(card.dataset.localSequence);
    const entry = await getTripRepository()?.getOperation(localizedTripId, sequence);
    if (!entry) return renderLocalizedConflicts();
    button.disabled = true;
    localizedStatus.textContent = "Aplicando tu decisión…";
    try {
        const mergedValue = card.querySelector("textarea")?.value;
        const action = button.dataset.localizedConflictAction;
        await resolveLocalizedEntry(entry, action, mergedValue);
        await renderLocalizedConflicts();
        if (action !== "copy") toast("Cambio resuelto.", "success");
    } catch (error) {
        localizedStatus.textContent = "No se pudo aplicar la decisión. El cambio local sigue guardado.";
        toast(error?.message === "CONFLICT_NOT_COMBINABLE"
            ? "Este cambio ya no se puede combinar como texto."
            : "No se pudo resolver el cambio. No se ha descartado.", "error");
        button.disabled = false;
    }
});
