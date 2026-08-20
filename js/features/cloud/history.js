import { store } from "../../core/store.js";
import { openModal } from "../../shared/modal.js";
import { confirmAction, toast } from "../../shared/notify.js";
import { getTripRepository, replaceActiveTrip } from "../library/workspace.js";
import { getCloudClient, getCurrentUserId } from "./coordinator.js";
import { memberAvatar } from "./member-avatar.js";

let selectedSnapshot = null;

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
            const parts = [];
            if (revision.summary.titleChanged) parts.push("título actualizado");
            if (revision.summary.daysDelta) parts.push(`${revision.summary.daysDelta > 0 ? "+" : ""}${revision.summary.daysDelta} días`);
            if (revision.summary.spotsDelta) parts.push(`${revision.summary.spotsDelta > 0 ? "+" : ""}${revision.summary.spotsDelta} paradas`);
            summary.textContent = `${revision.origin || "usuario"} · ${parts.join(", ") || "sin cambios estructurales"}`;
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

document.querySelector("#historyList").addEventListener("click", async (event) => {
    const row = event.target.closest("[data-revision]");
    if (!row) return;
    const envelope = await activeRemoteEnvelope();
    const revision = Number(row.dataset.revision);
    const repository = getTripRepository();
    let snapshot = await repository.getCachedRevision(envelope.id, revision);
    if (!snapshot) {
        try {
            const result = await getCloudClient().getRevision(envelope.remote.id, revision);
            snapshot = { tripId: envelope.id, ...result.revision };
            await repository.cacheRevision(snapshot);
        } catch {
            toast("Esta revisión necesita conexión.", "error");
            return;
        }
    }
    selectedSnapshot = snapshot;
    // A "lector" may read every past version but never write one back.
    document.querySelector("#revisionRestoreBtn").hidden = store.readOnly;
    document.querySelector("#revisionPreviewTitle").textContent = `Revisión ${revision} · ${snapshot.document.tripTitle}`;
    const content = document.querySelector("#revisionPreviewContent");
    content.replaceChildren();
    for (const day of snapshot.document.days) {
        const section = document.createElement("section");
        const heading = document.createElement("h4");
        heading.textContent = `${day.date || "Sin fecha"} · ${day.title}`;
        const list = document.createElement("ul");
        for (const spot of day.spots) {
            const item = document.createElement("li");
            item.textContent = spot.name;
            list.append(item);
        }
        section.append(heading, list);
        content.append(section);
    }
    openModal(document.querySelector("#revisionPreviewDialog"));
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
