// The render cycle — the core convention. render() is destructive: it wipes
// #days and rebuilds every day/spot node from scratch, re-attaching listeners.
// Almost every mutation ends with the trio save(); render(); drawMap();.
//
// NOTE the circular import with dialogs.js (openDialog): it's safe because every
// cross-module reference here fires from an event handler at runtime, never
// during module evaluation.

import {
    store,
    save,
    dayBy,
    categoryMeta,
    toggleTagFilter,
    clearTagFilter,
    spotMatchesFilter,
} from "./store.js";
import { $, esc, safeColor, fmt, daysEl, id } from "./dom.js";
import { toast, confirmAction } from "./notify.js";
import { drawMap } from "./map.js";
import { openDialog } from "./dialogs.js";

export function duplicateDay(dayId) {
    if (dayId === "backlog") return;
    const idx = store.state.findIndex((d) => d.id === dayId);
    if (idx === -1) return;
    const day = store.state[idx],
        clone = {
            id: id(),
            date: day.date,
            title: day.title + " (copia)",
            spots: day.spots.map((s) => ({
                ...s,
                id: id(),
                tags: [...(s.tags || [])],
            })),
        };
    store.state.splice(idx + 1, 0, clone);
    save();
    render();
    drawMap();
}

export function duplicateSpot(spotId, listId) {
    const arr = listId === "backlog" ? store.backlog : dayBy(listId).spots,
        idx = arr.findIndex((s) => s.id === spotId);
    if (idx === -1) return;
    const clone = {
        ...arr[idx],
        id: id(),
        tags: [...(arr[idx].tags || [])],
    };
    arr.splice(idx + 1, 0, clone);
    save();
    render();
    drawMap();
}

function renderTags() {
    const bar = $("#tagBar");
    bar.querySelectorAll(".tag").forEach((x) => x.remove());
    const anchor = $("#filterActive");
    store.tags.forEach((tag) => {
        const e = document.createElement("span");
        e.className =
            "tag" + (store.activeTagFilter.has(tag) ? " selected" : "");
        e.textContent = "#" + tag;
        e.onclick = () => {
            toggleTagFilter(tag);
            render();
            drawMap();
        };
        bar.insertBefore(e, anchor);
    });
    const n = store.activeTagFilter.size,
        hasFilter = n > 0;
    $("#filterActive").textContent = n === 1 ? "1 activo" : n + " activos";
    $("#filterActive").hidden = !hasFilter;
    $("#clearFilter").hidden = !hasFilter;
    $("#clearFilter").onclick = () => {
        clearTagFilter();
        render();
        drawMap();
    };
}

function renderList(el, spots, isBacklog = false) {
    const list = el.querySelector(".spots");
    const visible = spots.filter(spotMatchesFilter);
    if (!visible.length)
        list.innerHTML = store.activeTagFilter.size > 0
            ? '<div class="empty">Ninguna parada coincide con el filtro</div>'
            : '<div class="empty">Arrastra aquí una idea o añade una nueva.</div>';
    visible.forEach((s, i) => {
        const spot = document.createElement("div");
        spot.className = "spot";
        spot.dataset.spot = s.id;
        const cat = categoryMeta(s.category);
        spot.innerHTML = `<span class="handle">⠿</span><span class="spot-content"><span class="spot-name">${isBacklog ? "" : `<span class="number">${i + 1}</span>`} ${esc(s.name)}</span><span class="spot-meta">${esc(s.note || s.address || "Sin detalles")}</span><span class="spot-tags"><span class="category-badge" style="--category-color:${safeColor(cat.color)}">${esc(cat.label)}</span>${s.tags?.length ? s.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join("") : ""}</span></span><span class="spot-actions"><button data-act="up" title="Subir">↑</button><button data-act="down" title="Bajar">↓</button><button data-act="duplicate" title="Duplicar">⧉</button><button data-act="edit" title="Editar">✎</button><button data-act="delete" title="Borrar">×</button></span>`;
        list.append(spot);
    });
}

export function render({ persist = true } = {}) {
    renderTags();
    daysEl.innerHTML = "";
    const b = document.createElement("article");
    b.className =
        "day backlog " +
        (store.active === "backlog" ? "active " : "") +
        (store.backlogCollapsed ? "collapsed" : "");
    b.dataset.day = "backlog";
    b.innerHTML = `<div class="day-head"><div class="date-box"><span>ideas</span><strong>+</strong></div><div class="day-title"><div class="title-line"><span class="day-name">Backlog de paradas</span></div><small>${store.backlog.length} sin asignar · arrástralas a un día cuando decidáis</small></div><button class="day-collapse" title="${store.backlogCollapsed ? "Restaurar backlog" : "Minimizar backlog"}" aria-label="Minimizar o restaurar backlog">${store.backlogCollapsed ? "▸" : "▾"}</button></div><div class="spots"></div><button class="add-place">＋ Añadir al backlog</button>`;
    renderList(b, store.backlog, true);
    b.querySelector(".day-head").addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        store.active = "backlog";
        render();
        drawMap();
    });
    b.querySelector(".day-collapse").onclick = (e) => {
        e.stopPropagation();
        store.backlogCollapsed = !store.backlogCollapsed;
        save();
        render();
    };
    b.querySelector(".add-place").onclick = () => openDialog("backlog");
    daysEl.append(b);
    store.state.forEach((day) => {
        const f = fmt(day.date),
            el = document.createElement("article");
        el.className =
            "day " +
            (day.id === store.active ? "active " : "") +
            (day.collapsed ? "collapsed" : "");
        el.dataset.day = day.id;
        el.innerHTML = `<div class="day-head"><button class="day-handle" type="button" title="Reordenar día" aria-label="Reordenar día">⠿</button><div class="date-box editable" title="Cambiar fecha"><span>${f.month}</span><strong>${f.day}</strong><input type="date" value="${day.date}" tabindex="-1" aria-label="Fecha del día"></div><div class="day-title"><div class="title-line"><span class="day-name" title="Pulsa para ver la ruta · doble clic para renombrar">${esc(day.title)}</span><button class="title-edit" title="Renombrar día" aria-label="Renombrar día">✎</button></div><small>${day.spots.length} ${day.spots.length === 1 ? "parada" : "paradas"} · pulsa para ver ruta</small></div><button class="day-collapse" title="${day.collapsed ? "Restaurar día" : "Minimizar día"}" aria-label="Minimizar o restaurar día">${day.collapsed ? "▸" : "▾"}</button><button class="day-duplicate" title="Duplicar día">⧉</button><button class="day-options" title="Eliminar día">×</button></div><div class="spots"></div><button class="add-place">＋ Añadir una parada</button>`;
        renderList(el, day.spots);
        el.querySelector(".day-head").addEventListener("click", (e) => {
            if (
                e.target.closest(".date-box") ||
                e.target.closest("button") ||
                e.target.tagName === "INPUT"
            )
                return;
            store.active = day.id;
            render();
            drawMap();
        });
        const dateBox = el.querySelector(".date-box");
        dateBox.addEventListener("click", () => {
            const inp = dateBox.querySelector("input");
            try {
                inp.showPicker();
            } catch (_) {
                inp.focus();
            }
        });
        el.querySelector(".date-box input").addEventListener("change", (e) => {
            if (!e.target.value) return;
            day.date = e.target.value;
            save();
            render();
            drawMap();
        });
        const startEdit = () => {
            if (store.previewMode) return;
            editTitle(day, el);
        };
        el.querySelector(".title-edit").addEventListener("click", (ev) => {
            ev.stopPropagation();
            startEdit();
        });
        el.querySelector(".day-name").addEventListener("dblclick", startEdit);
        el.querySelector(".day-collapse").onclick = (e) => {
            e.stopPropagation();
            day.collapsed = !day.collapsed;
            save();
            render();
        };
        el.querySelector(".day-duplicate").onclick = (e) => {
            e.stopPropagation();
            duplicateDay(day.id);
        };
        el.querySelector(".day-options").onclick = () => {
            confirmAction({
                title: "Eliminar día",
                message:
                    "¿Eliminar este día? Sus paradas pasarán al backlog.",
            }).then((ok) => {
                if (!ok) return;
                store.backlog.push(...day.spots);
                store.state = store.state.filter((d) => d.id !== day.id);
                store.active = "backlog";
                save();
                render();
                drawMap();
                toast(
                    "Día eliminado. Sus paradas están en el backlog.",
                    "info",
                );
            });
        };
        el.querySelector(".add-place").onclick = () => openDialog(day.id);
        daysEl.append(el);
    });
    if (persist) save();
}

function editTitle(day, el) {
    const line = el.querySelector(".title-line");
    if (!line) return;
    const input = document.createElement("input");
    input.className = "editing";
    input.value = day.title;
    input.setAttribute("aria-label", "Título del día");
    line.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = () => {
        if (done) return;
        done = true;
        const v = input.value.trim();
        day.title = v || day.title;
        save();
        drawMap();
        render();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            input.blur();
        } else if (e.key === "Escape") {
            e.preventDefault();
            input.removeEventListener("blur", commit);
            done = true;
            render();
        }
    });
}

// Single source of truth for relocating a spot between backlog and any day.
export function moveSpot(spotId, toDay, at) {
    let spot;
    const bi = store.backlog.findIndex((s) => s.id === spotId);
    if (bi > -1) spot = store.backlog.splice(bi, 1)[0];
    store.state.forEach((d) => {
        const i = d.spots.findIndex((s) => s.id === spotId);
        if (i > -1) spot = d.spots.splice(i, 1)[0];
    });
    if (!spot) return;
    const target = toDay === "backlog" ? store.backlog : dayBy(toDay).spots;
    target.splice(at, 0, spot);
    store.active = toDay;
    save();
    render();
    drawMap();
}

// Reorder real days without changing the active day or any persisted shape.
export function moveDay(dayId, at) {
    const from = store.state.findIndex((day) => day.id === dayId);
    if (from === -1) return;
    const [day] = store.state.splice(from, 1);
    store.state.splice(Math.max(0, Math.min(at, store.state.length)), 0, day);
    save();
    render();
    drawMap();
}

export function applyTitle() {
    $("#tripTitle").value = store.tripTitle;
    document.title = (store.tripTitle || "Viaje") + " · Planificador de ruta";
}

// Spot action buttons (up/down/edit/delete/duplicate), delegated on #days.
daysEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const spotEl = b.closest(".spot"),
        dayId = spotEl.closest(".day").dataset.day,
        items = dayId === "backlog" ? store.backlog : dayBy(dayId).spots,
        i = items.findIndex((s) => s.id === spotEl.dataset.spot);
    if (b.dataset.act === "edit") openDialog(dayId, items[i]);
    else if (b.dataset.act === "delete") {
        const name = items[i].name;
        confirmAction({
            title: "Borrar parada",
            message: `¿Borrar “${name}”?`,
        }).then((ok) => {
            if (!ok) return;
            const idx = items.findIndex((s) => s.id === spotEl.dataset.spot);
            if (idx === -1) return;
            items.splice(idx, 1);
            save();
            render();
            drawMap();
            toast(`“${name}” eliminada.`, "info");
        });
    } else if (b.dataset.act === "duplicate") {
        duplicateSpot(items[i].id, dayId);
    } else {
        if (store.activeTagFilter.size > 0) {
            toast("Limpia el filtro para reordenar las paradas.", "info");
            return;
        }
        const to = b.dataset.act === "up" ? i - 1 : i + 1;
        if (to >= 0 && to < items.length) {
            [items[i], items[to]] = [items[to], items[i]];
            store.active = dayId;
            save();
            render();
            drawMap();
        }
    }
});
