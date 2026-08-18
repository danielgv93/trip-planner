import { openModal } from "../../shared/modal.js";
import { confirmAction, toast } from "../../shared/notify.js";
import { resolveConflict } from "./coordinator.js";

const dialog = document.querySelector("#conflictDialog");
let activeConflictId = null;

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
