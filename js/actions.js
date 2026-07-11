// Header / top-bar actions: trip title editing, add day, preview toggle, reset,
// import/export. Side-effect module — importing it wires the top-bar listeners.

import { store, save } from "./store.js";
import { $, slug, id } from "./dom.js";
import { render, applyTitle } from "./render.js";
import { drawMap } from "./map.js";
import { toast, confirmAction } from "./notify.js";
import { sample, DEFAULT_CATEGORIES, DEFAULT_TITLE } from "./constants.js";

$("#tripTitle").addEventListener("input", (e) => {
    store.tripTitle = e.target.value;
    document.title = (store.tripTitle || "Viaje") + " · Planificador de ruta";
    save();
});

$("#addDay").onclick = () => {
    const date = store.state.length
        ? new Date(store.state[store.state.length - 1].date + "T12:00:00")
        : new Date();
    date.setDate(date.getDate() + 1);
    const d = {
        id: id(),
        date: date.toISOString().slice(0, 10),
        title: "Nuevo día",
        spots: [],
    };
    store.state.push(d);
    store.active = d.id;
    save();
    render();
    drawMap();
};

function togglePreview() {
    store.previewMode = !store.previewMode;
    document.body.classList.toggle("preview-mode", store.previewMode);
    const btn = $("#previewBtn");
    btn.textContent = store.previewMode ? "Editar" : "Previsualizar";
    btn.classList.toggle("active", store.previewMode);
    render();
    drawMap();
}
$("#previewBtn").onclick = togglePreview;

$("#resetBtn").onclick = () => {
    confirmAction({
        title: "Restaurar ejemplo",
        message:
            "¿Restaurar el ejemplo? Se perderán tus cambios guardados en este navegador.",
        confirmLabel: "Restaurar",
    }).then((ok) => {
        if (!ok) return;
        store.state = structuredClone(sample);
        store.backlog = [];
        store.tags = ["comida", "templo", "reserva", "compras"];
        store.categories = structuredClone(DEFAULT_CATEGORIES);
        store.tripTitle = DEFAULT_TITLE;
        store.active = "d1";
        applyTitle();
        save();
        render();
        drawMap();
        toast("Ejemplo restaurado.", "info");
    });
};

$("#exportBtn").onclick = () => {
    const data = JSON.stringify(
            {
                version: 8,
                exportedAt: new Date().toISOString(),
                tripTitle: store.tripTitle,
                days: store.state,
                backlog: store.backlog,
                tags: store.tags,
                categories: store.categories,
                routeProfile: store.routeProfile,
            },
            null,
            2,
        ),
        url = URL.createObjectURL(
            new Blob([data], { type: "application/json" }),
        ),
        a = document.createElement("a");
    a.href = url;
    a.download = "ruta-" + slug(store.tripTitle) + ".json";
    a.click();
    URL.revokeObjectURL(url);
};

$("#importBtn").onclick = () => $("#importFile").click();
$("#importFile").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        const plan = JSON.parse(await file.text());
        if (!Array.isArray(plan.days)) throw Error();
        const ok = await confirmAction({
            title: "Importar plan",
            message:
                "¿Importar este plan? Sustituirá la ruta guardada actualmente.",
            confirmLabel: "Importar",
        });
        if (!ok) {
            e.target.value = "";
            return;
        }
        store.state = plan.days;
        store.backlog = Array.isArray(plan.backlog) ? plan.backlog : [];
        store.tags = Array.isArray(plan.tags) ? plan.tags : store.tags;
        store.categories = Array.isArray(plan.categories)
            ? plan.categories
            : store.categories;
        if (typeof plan.tripTitle === "string") store.tripTitle = plan.tripTitle;
        if (["walking", "driving", "cycling"].includes(plan.routeProfile)) {
            store.routeProfile = plan.routeProfile;
            $("#routeProfile").value = store.routeProfile;
        }
        store.active = store.state[0]?.id || "backlog";
        applyTitle();
        save();
        render();
        drawMap();
        toast("Plan importado correctamente.", "success");
    } catch {
        toast("Ese archivo no parece un plan válido.", "error");
    }
    e.target.value = "";
};
