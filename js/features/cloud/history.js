import { store } from "../../core/store.js";
import { buildPlanChanges } from "../../core/plan-changes.js";
import { openModal } from "../../shared/modal.js";
import { confirmAction, renderChangePreview, toast } from "../../shared/notify.js";
import { getTripRepository, replaceActiveTrip } from "../library/workspace.js";
import { getCloudClient, getCurrentUserId } from "./coordinator.js";
import { memberAvatar } from "./member-avatar.js";

let selectedSnapshot = null;
let previewRequest = 0;

// This is the blame: every revision already recorded who wrote it, the history
// simply never showed it. An account deleted since then leaves the row without
// an author rather than attributing the change to somebody else.
function authorLine(revision) {
    const line = document.createElement("span");
    line.className = "history-author";
    if (!revision.actor_user_id) {
        line.textContent = "Cuenta eliminada";
        return line;
    }
    const displayName = revision.actor_display_name || "Viajero";
    line.append(memberAvatar({
        userId: revision.actor_user_id,
        displayName,
        role: "editor",
    }));
    const name = document.createElement("span");
    name.textContent = revision.actor_user_id === getCurrentUserId() ? `${displayName} (tú)` : displayName;
    line.append(name);
    return line;
}

async function activeRemoteEnvelope() {
    return store.activeTripId ? getTripRepository()?.getTrip(store.activeTripId) : null;
}

function revisionSummary(revision) {
    const value = revision.summary || {};
    const parts = [];
    const quantity = (count, singular, plural = `${singular}s`) => `${count} ${Math.abs(count) === 1 ? singular : plural}`;
    if (value.titleChanged) parts.push("título actualizado");
    if (value.daysAdded !== undefined) {
        if (value.daysAdded) parts.push(`+${quantity(value.daysAdded, "día")}`);
        if (value.daysRemoved) parts.push(`−${quantity(value.daysRemoved, "día")}`);
    } else if (value.daysDelta) {
        parts.push(`${value.daysDelta > 0 ? "+" : ""}${quantity(value.daysDelta, "día")}`);
    }
    if (value.daysChanged) parts.push(`${quantity(value.daysChanged, "día")} ${value.daysChanged === 1 ? "modificado" : "modificados"}`);
    if (value.spotsAdded !== undefined) {
        if (value.spotsAdded) parts.push(`+${quantity(value.spotsAdded, "parada")}`);
        if (value.spotsRemoved) parts.push(`−${quantity(value.spotsRemoved, "parada")}`);
    } else if (value.spotsDelta) {
        parts.push(`${value.spotsDelta > 0 ? "+" : ""}${quantity(value.spotsDelta, "parada")}`);
    }
    if (value.spotsChanged) parts.push(`${quantity(value.spotsChanged, "parada")} ${value.spotsChanged === 1 ? "modificada" : "modificadas"}`);
    if (value.backlogGroupsChanged) parts.push(`${quantity(value.backlogGroupsChanged, "grupo de ideas", "grupos de ideas")} ${value.backlogGroupsChanged === 1 ? "cambiado" : "cambiados"}`);
    if (value.categoriesChanged) parts.push(`${quantity(value.categoriesChanged, "categoría")} ${value.categoriesChanged === 1 ? "cambiada" : "cambiadas"}`);
    if (value.tagsChanged) parts.push(`${quantity(value.tagsChanged, "etiqueta")} ${value.tagsChanged === 1 ? "cambiada" : "cambiadas"}`);
    if (value.notePagesChanged) parts.push("notas actualizadas");
    if (value.remindersChanged) parts.push(`${quantity(value.remindersChanged, "recordatorio")} ${value.remindersChanged === 1 ? "cambiado" : "cambiados"}`);
    if (value.travelLegsChanged) parts.push(`${quantity(value.travelLegsChanged, "trayecto")} ${value.travelLegsChanged === 1 ? "cambiado" : "cambiados"}`);
    if (value.settingsChanged) parts.push("ajustes actualizados");
    if (!parts.length && value.structureChanged) parts.push("estructura reorganizada");
    if (!parts.length) parts.push("cambios guardados");
    const visible = parts.slice(0, 3);
    if (parts.length > visible.length) visible.push(`+${parts.length - visible.length} más`);
    const origin = {
        create: "creación",
        rename: "renombrado",
        restore: "restauración",
        user: "edición",
    }[revision.origin] || revision.origin || "edición";
    return { text: `${origin} · ${visible.join(", ")}`, detail: parts.join(", ") };
}

async function loadHistory() {
    const root = document.querySelector("#historyList");
    const status = document.querySelector("#historyStatus");
    root.replaceChildren();
    const envelope = await activeRemoteEnvelope();
    if (!envelope?.remote.id || !getCloudClient()) {
        status.textContent = "El historial aparece cuando este viaje se guarda en la nube.";
        return;
    }
    status.textContent = "Cargando revisiones…";
    try {
        const result = await getCloudClient().listRevisions(envelope.remote.id);
        for (const revision of result.revisions) {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "history-row";
            row.dataset.revision = revision.revision;
            const heading = document.createElement("span");
            const strong = document.createElement("strong");
            strong.textContent = `Revisión ${revision.revision}${revision.current ? " · actual" : ""}`;
            const time = document.createElement("time");
            time.textContent = new Intl.DateTimeFormat("es-ES", { dateStyle: "medium", timeStyle: "short" }).format(new Date(revision.created_at));
            heading.append(strong, time);
            const summary = document.createElement("small");
            const summaryCopy = revisionSummary(revision);
            summary.textContent = summaryCopy.text;
            summary.title = summaryCopy.detail;
            row.append(heading, authorLine(revision), summary);
            root.append(row);
        }
        status.textContent = result.revisions.length ? "" : "Todavía no hay revisiones disponibles.";
    } catch {
        status.textContent = "Sin conexión. Las revisiones no guardadas en este dispositivo necesitan red.";
    }
}

document.querySelector("#historyOpenBtn").addEventListener("click", () => {
    openModal(document.querySelector("#historyDialog"));
    loadHistory();
});

async function revisionSnapshot(envelope, revision) {
    if (revision < 1) return null;
    const repository = getTripRepository();
    let snapshot = await repository.getCachedRevision(envelope.id, revision);
    if (snapshot) return snapshot;
    const result = await getCloudClient().getRevision(envelope.remote.id, revision);
    snapshot = { tripId: envelope.id, ...result.revision };
    await repository.cacheRevision(snapshot);
    return snapshot;
}

document.querySelector("#historyList").addEventListener("click", async (event) => {
    const row = event.target.closest("[data-revision]");
    if (!row) return;
    const request = ++previewRequest;
    const envelope = await activeRemoteEnvelope();
    const revision = Number(row.dataset.revision);
    const dialog = document.querySelector("#revisionPreviewDialog");
    const content = document.querySelector("#revisionPreviewContent");
    document.querySelector("#revisionRestoreBtn").hidden = true;
    document.querySelector("#revisionPreviewTitle").textContent = `Revisión ${revision}`;
    content.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "revision-preview-status";
    loading.textContent = "Calculando cambios…";
    content.append(loading);
    openModal(dialog);
    let snapshot;
    let previousSnapshot = null;
    try {
        snapshot = await revisionSnapshot(envelope, revision);
    } catch {
        if (request !== previewRequest) return;
        dialog.close();
        toast("Esta revisión necesita conexión.", "error");
        return;
    }
    let previousUnavailable = false;
    if (revision > 1) {
        try {
            previousSnapshot = await revisionSnapshot(envelope, revision - 1);
        } catch {
            previousUnavailable = true;
        }
    }
    if (request !== previewRequest) return;
    selectedSnapshot = snapshot;
    // A "lector" may read every past version but never write one back.
    document.querySelector("#revisionRestoreBtn").hidden = store.readOnly;
    document.querySelector("#revisionPreviewTitle").textContent = `Revisión ${revision} · ${snapshot.document.tripTitle}`;
    renderChangePreview(content, buildPlanChanges(previousSnapshot?.document || null, snapshot.document));
    if (previousUnavailable) {
        const notice = document.createElement("p");
        notice.className = "revision-preview-notice";
        notice.textContent = "La revisión anterior ya no está disponible; se muestra el contenido conservado de esta versión.";
        content.prepend(notice);
    }
});

document.querySelector("#revisionRestoreBtn").addEventListener("click", async () => {
    if (!selectedSnapshot) return;
    const ok = await confirmAction({ title: "Restaurar revisión", message: "El documento actual quedará disponible en Deshacer y la restauración se sincronizará como una revisión nueva.", confirmLabel: "Restaurar" });
    if (!ok) return;
    await replaceActiveTrip(selectedSnapshot.document);
    document.querySelector("#revisionPreviewDialog").close();
    document.querySelector("#historyDialog").close();
    toast("Revisión restaurada. Se guardó como un cambio nuevo.", "success");
});
