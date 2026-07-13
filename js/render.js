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
    spotIsEnabled,
} from "./store.js";
import { $, esc, safeColor, fmt, daysEl, id } from "./dom.js";
import { toast, confirmAction } from "./notify.js?v=3";
import { drawMap, mapsLinkFor } from "./map.js";
import { openDialog } from "./dialogs.js";
import { foreignAmount, localAmount } from "./currency.js";

// View-only state: keep an opened day schedule open across destructive renders
// without adding presentation preferences to the persisted trip data.
const expandedSchedules = new Set();

export function sumCosts(spots) {
    return spots.reduce(
        (total, spot) =>
            total +
            (spotIsEnabled(spot) &&
            Number.isFinite(spot?.cost) &&
            spot.cost > 0
                ? spot.cost
                : 0),
        0,
    );
}

function enabledSpotCount(spots) {
    return spots.filter(spotIsEnabled).length;
}

export function formatCost(amount) {
    return foreignAmount(amount);
}

export function formatDualCost(amount) {
    return `${foreignAmount(amount)} · ${localAmount(amount)}`;
}

export function timeToMinutes(value) {
    if (
        typeof value !== "string" ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
    )
        return null;
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
}

export function openingHourSegments(openingTime, closingTime) {
    const opening = timeToMinutes(openingTime),
        closing = timeToMinutes(closingTime);
    if (opening === null || closing === null) return [];
    if (opening === closing)
        return [{ start: 0, width: 100, equal: true }];

    const percentage = (minutes) =>
        Math.min(100, Math.max(0, (minutes / 1440) * 100));
    if (opening < closing)
        return [
            {
                start: percentage(opening),
                width: percentage(closing - opening),
            },
        ];
    return [
        {
            start: percentage(opening),
            width: percentage(1440 - opening),
        },
        { start: 0, width: percentage(closing) },
    ];
}

function scheduleIntervals(openingTime, closingTime) {
    const opening = timeToMinutes(openingTime),
        closing = timeToMinutes(closingTime);
    // Equal endpoints are intentionally ambiguous in this data model. Show
    // their full rail, but do not pretend they overlap with other schedules.
    if (opening === null || closing === null || opening === closing) return [];
    return opening < closing
        ? [[opening, closing]]
        : [[opening, 1440], [0, closing]];
}

export function schedulesOverlap(firstOpening, firstClosing, secondOpening, secondClosing) {
    const first = scheduleIntervals(firstOpening, firstClosing),
        second = scheduleIntervals(secondOpening, secondClosing);
    return first.some(([start, end]) =>
        second.some(([otherStart, otherEnd]) => start < otherEnd && otherStart < end),
    );
}

export function scheduleOverlapSegments(
    firstOpening,
    firstClosing,
    secondOpening,
    secondClosing,
) {
    const first = scheduleIntervals(firstOpening, firstClosing),
        second = scheduleIntervals(secondOpening, secondClosing),
        percentage = (minutes) =>
            Math.min(100, Math.max(0, (minutes / 1440) * 100));
    return first.flatMap(([start, end]) =>
        second.flatMap(([otherStart, otherEnd]) => {
            const overlapStart = Math.max(start, otherStart),
                overlapEnd = Math.min(end, otherEnd);
            return overlapStart < overlapEnd
                ? [
                      {
                          start: percentage(overlapStart),
                          width: percentage(overlapEnd - overlapStart),
                      },
                  ]
                : [];
        }),
    );
}

export function renderSpotHours(spot, color, interactive = true) {
    const opening = timeToMinutes(spot?.openingTime),
        closing = timeToMinutes(spot?.closingTime),
        hasOpening = opening !== null,
        hasClosing = closing !== null;
    if (!hasOpening && !hasClosing) return "";

    const openingTime = hasOpening ? spot.openingTime : "",
        closingTime = hasClosing ? spot.closingTime : "";
    if (!hasOpening)
        return `<span class="spot-hours" aria-label="Horario: cierra a las ${esc(closingTime)}"><span class="spot-hours-icon" aria-hidden="true">◷</span><span class="spot-hours-text">Hasta ${esc(closingTime)}</span></span>`;
    if (!hasClosing)
        return `<span class="spot-hours" aria-label="Horario: abre a las ${esc(openingTime)}"><span class="spot-hours-icon" aria-hidden="true">◷</span><span class="spot-hours-text">Desde ${esc(openingTime)}</span></span>`;

    const segments = openingHourSegments(openingTime, closingTime),
        rail = segments
            .map(
                ({ start, width, equal }) =>
                    `<span class="spot-hours-segment${equal ? " is-equal" : ""}" style="--segment-start:${start.toFixed(4)}%;--segment-width:${width.toFixed(4)}%"></span>`,
            )
            .join("");
    return `<span class="spot-hours is-complete"${interactive ? ' tabindex="0"' : ""} data-hours-opening="${esc(openingTime)}" data-hours-closing="${esc(closingTime)}" aria-label="Horario: abre a las ${esc(openingTime)} y cierra a las ${esc(closingTime)}" style="--hours-color:${safeColor(color)}"><span class="spot-hours-icon" aria-hidden="true">◷</span><span class="spot-hours-text">${esc(openingTime)}–${esc(closingTime)}</span><span class="spot-hours-rail" aria-hidden="true">${rail}<span class="spot-hours-overlaps"></span></span><span class="spot-hours-detail" aria-hidden="true">Abre ${esc(openingTime)} · Cierra ${esc(closingTime)}</span></span>`;
}

function renderDaySchedule(spots, dayId) {
    const scheduled = spots.filter(
        (spot) =>
            spotIsEnabled(spot) &&
            (timeToMinutes(spot?.openingTime) !== null ||
                timeToMinutes(spot?.closingTime) !== null),
    );
    if (!scheduled.length) return "";

    const rows = scheduled
        .map((spot) => {
            const opening = timeToMinutes(spot.openingTime),
                closing = timeToMinutes(spot.closingTime),
                hasOpening = opening !== null,
                hasClosing = closing !== null,
                color = categoryMeta(spot.category).color,
                label = hasOpening && hasClosing
                    ? `${spot.openingTime}–${spot.closingTime}`
                    : hasOpening
                      ? `Desde ${spot.openingTime}`
                      : `Hasta ${spot.closingTime}`,
                tooltipMinute = hasOpening && hasClosing
                    ? opening === closing
                        ? 720
                        : opening < closing
                          ? opening + (closing - opening) / 2
                          : (opening + ((closing + 1440 - opening) / 2)) % 1440
                    : hasOpening
                      ? opening
                      : closing,
                tooltipPosition = (tooltipMinute / 1440) * 100;
            let rail = "";
            if (hasOpening && hasClosing) {
                rail = openingHourSegments(spot.openingTime, spot.closingTime)
                    .map(
                        ({ start, width, equal }) =>
                            `<span class="day-schedule-segment${equal ? " is-equal" : ""}" style="--segment-start:${start.toFixed(4)}%;--segment-width:${width.toFixed(4)}%"></span>`,
                    )
                    .join("");
            } else {
                const minute = hasOpening ? opening : closing,
                    position = (minute / 1440) * 100;
                rail = `<span class="day-schedule-marker ${hasOpening ? "is-opening" : "is-closing"}" style="--marker-position:${position.toFixed(4)}%"></span>`;
            }
            return `<div class="day-schedule-row" tabindex="0" data-hours-opening="${hasOpening ? esc(spot.openingTime) : ""}" data-hours-closing="${hasClosing ? esc(spot.closingTime) : ""}" aria-label="${esc(spot.name || "Parada sin nombre")}: ${esc(label)}" style="--schedule-color:${safeColor(color)};--tooltip-position:${tooltipPosition.toFixed(4)}%"><span class="day-schedule-name" title="${esc(spot.name || "Parada sin nombre")}">${esc(spot.name || "Parada sin nombre")}</span><span class="day-schedule-rail" aria-hidden="true">${rail}<span class="day-schedule-time">${esc(label)}</span></span></div>`;
        })
        .join("");
    const count = scheduled.length,
        open = expandedSchedules.has(dayId) ? " open" : "";
    return `<details class="day-schedule"${open}><summary><span class="day-schedule-summary-icon" aria-hidden="true">◷</span><span>Horarios</span><span class="day-schedule-count">${count}</span><span class="day-schedule-chevron" aria-hidden="true">⌄</span></summary><div class="day-schedule-body"><span class="day-schedule-guide" aria-hidden="true"></span><div class="day-schedule-axis" aria-hidden="true"><span></span><span class="day-schedule-axis-hours"><i>00</i><i>06</i><i>12</i><i>18</i><i>24</i></span></div>${rows}</div></details>`;
}

function wireDaySchedule(el, dayId) {
    const schedule = el.querySelector(".day-schedule");
    schedule?.addEventListener("toggle", () => {
        if (schedule.open) expandedSchedules.add(dayId);
        else expandedSchedules.delete(dayId);
    });
    const body = schedule?.querySelector(".day-schedule-body");
    body?.querySelectorAll(".day-schedule-rail").forEach((rail) => {
        rail.addEventListener("pointermove", (event) => {
            const bodyRect = body.getBoundingClientRect(),
                railRect = rail.getBoundingClientRect(),
                x = Math.min(
                    railRect.right,
                    Math.max(railRect.left, event.clientX),
                ) - bodyRect.left,
                row = rail.closest(".day-schedule-row"),
                color = getComputedStyle(row)
                    .getPropertyValue("--schedule-color")
                    .trim(),
                ratio = (event.clientX - railRect.left) / railRect.width,
                minute = Math.min(1439, Math.max(0, ratio * 1440)),
                activeContainsMinute = scheduleIntervals(
                    row.dataset.hoursOpening,
                    row.dataset.hoursClosing,
                ).some(([start, end]) => start <= minute && minute < end);
            body.style.setProperty("--guide-x", `${x}px`);
            body.style.setProperty("--guide-color", color);
            body.style.setProperty("--guide-ratio", `${ratio * 100}%`);
            body.classList.add("has-guide");
            body.querySelector(".is-hovered")?.classList.remove("is-hovered");
            row.classList.add("is-hovered");
            body.querySelectorAll(".day-schedule-row").forEach((candidate) => {
                const coincides = activeContainsMinute && candidate !== row &&
                    scheduleIntervals(
                        candidate.dataset.hoursOpening,
                        candidate.dataset.hoursClosing,
                    ).some(([start, end]) => start <= minute && minute < end);
                candidate.classList.toggle("is-coincident", coincides);
            });
        });
    });
    body?.addEventListener("pointerleave", () => {
        body.classList.remove("has-guide");
        body.querySelector(".is-hovered")?.classList.remove("is-hovered");
        body.querySelectorAll(".is-coincident").forEach((row) =>
            row.classList.remove("is-coincident"),
        );
    });
}

function spotNameForHours(row) {
    return row.closest(".spot")?.dataset.spotName || "Parada sin nombre";
}

function setHoursDetail(row, text) {
    row.querySelector(".spot-hours-detail").textContent = text;
}

function setOverlapSegments(row, segments) {
    const layer = row.querySelector(".spot-hours-overlaps");
    layer.replaceChildren();
    segments.forEach(({ start, width }) => {
        const segment = document.createElement("span");
        segment.className = "spot-hours-overlap-segment";
        segment.style.setProperty("--overlap-start", `${start.toFixed(4)}%`);
        segment.style.setProperty("--overlap-width", `${width.toFixed(4)}%`);
        layer.append(segment);
    });
}

function clearHoursComparison(list) {
    list.classList.remove("hours-comparison");
    list.querySelectorAll(".spot-hours.is-complete").forEach((row) => {
        row.classList.remove("hours-context-active", "hours-context-overlap", "hours-context-dimmed");
        setHoursDetail(
            row,
            `Abre ${row.dataset.hoursOpening} · Cierra ${row.dataset.hoursClosing}`,
        );
        setOverlapSegments(row, []);
    });
}

function activateHoursComparison(list, activeRow) {
    const rows = [
            ...list.querySelectorAll(
                ".spot:not(.spot-disabled) .spot-hours.is-complete",
            ),
        ],
        overlaps = rows.filter(
            (row) =>
                row !== activeRow &&
                schedulesOverlap(
                    activeRow.dataset.hoursOpening,
                    activeRow.dataset.hoursClosing,
                    row.dataset.hoursOpening,
                    row.dataset.hoursClosing,
                ),
        );
    clearHoursComparison(list);
    list.classList.add("hours-comparison");
    activeRow.classList.add("hours-context-active");
    setOverlapSegments(
        activeRow,
        overlaps.flatMap((row) =>
            scheduleOverlapSegments(
                activeRow.dataset.hoursOpening,
                activeRow.dataset.hoursClosing,
                row.dataset.hoursOpening,
                row.dataset.hoursClosing,
            ),
        ),
    );
    rows.forEach((row) => {
        if (row === activeRow) return;
        const overlapsActive = overlaps.includes(row);
        row.classList.add(overlapsActive ? "hours-context-overlap" : "hours-context-dimmed");
        if (overlapsActive)
            setOverlapSegments(
                row,
                scheduleOverlapSegments(
                    row.dataset.hoursOpening,
                    row.dataset.hoursClosing,
                    activeRow.dataset.hoursOpening,
                    activeRow.dataset.hoursClosing,
                ),
            );
    });
    if (scheduleIntervals(activeRow.dataset.hoursOpening, activeRow.dataset.hoursClosing).length === 0) {
        setHoursDetail(activeRow, "Horario ambiguo: no se compara con otras paradas");
        return;
    }
    if (!overlaps.length) {
        setHoursDetail(activeRow, "Sin solapamientos con otras paradas");
        return;
    }
    const names = overlaps.map(spotNameForHours),
        shownNames = names.slice(0, 2).join(", "),
        remaining = names.length - 2,
        label = `${overlaps.length} ${overlaps.length === 1 ? "parada" : "paradas"}`;
    setHoursDetail(
        activeRow,
        `Coincide con ${label}: ${shownNames}${remaining > 0 ? ` y ${remaining} más` : ""}`,
    );
}

function wireHoursComparison(list) {
    list.querySelectorAll(
        ".spot:not(.spot-disabled) .spot-hours.is-complete",
    ).forEach((row) => {
        row.addEventListener("mouseenter", () => activateHoursComparison(list, row));
        row.addEventListener("mouseleave", () => clearHoursComparison(list));
        row.addEventListener("focus", () => activateHoursComparison(list, row));
        row.addEventListener("blur", () => clearHoursComparison(list));
    });
}

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
    let mapNumber = 0;
    if (!visible.length)
        list.innerHTML = store.activeTagFilter.size > 0
            ? '<div class="empty">Ninguna parada coincide con el filtro</div>'
            : '<div class="empty">Arrastra aquí una idea o añade una nueva.</div>';
    visible.forEach((s) => {
        const spot = document.createElement("div");
        spot.className = "spot";
        spot.dataset.spot = s.id;
        spot.dataset.spotName = s.name || "Parada sin nombre";
        const cat = categoryMeta(s.category);
        const spotCost =
            Number.isFinite(s.cost) && s.cost > 0
                ? `<span class="spot-cost"><strong>${esc(foreignAmount(s.cost))}</strong><small>${esc(localAmount(s.cost))}</small></span>`
                : "";
        const spotNote = s.note?.trim()
            ? `<span class="spot-meta">${esc(s.note)}</span>`
            : "";
        const enabled = spotIsEnabled(s);
        const spotHours = renderSpotHours(s, cat.color, enabled);
        const mapsLink = mapsLinkFor(s);
        const mapsAction = mapsLink
            ? `<a class="open-in-maps" href="${mapsLink}" target="_blank" rel="noopener" title="Abrir en Google Maps" aria-label="Abrir ${esc(s.name || "parada")} en Google Maps"><span aria-hidden="true">↗</span></a>`
            : "";
        if (enabled) mapNumber += 1;
        const number = isBacklog
            ? ""
            : enabled
              ? `<span class="number">${mapNumber}</span>`
              : '<span class="number number-placeholder" aria-hidden="true">−</span>';
        spot.classList.toggle("spot-disabled", !enabled);
        spot.innerHTML = `<span class="handle">⠿</span><label class="spot-toggle" title="${enabled ? "Desactivar parada" : "Activar parada"}"><input type="checkbox" data-act="toggle-enabled" ${enabled ? "checked" : ""} aria-label="${enabled ? "Desactivar" : "Activar"} ${esc(s.name || "parada")}"></label><span class="spot-content"><span class="spot-name">${number} ${esc(s.name)}</span>${spotNote}${spotHours}<span class="spot-tags"><span class="category-badge" style="--category-color:${safeColor(cat.color)}">${esc(cat.label)}</span>${s.tags?.length ? s.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join("") : ""}</span></span>${spotCost}<span class="spot-actions">${mapsAction}<span class="move-control"><button class="move-button" data-act="move" title="Mover a otro día" aria-label="Mover a otro día" aria-haspopup="menu" aria-expanded="false"><span aria-hidden="true">↪</span></button></span><button data-act="duplicate" title="Duplicar">⧉</button><button data-act="edit" title="Editar">✎</button><button data-act="delete" title="Borrar">×</button></span>`;
        list.append(spot);
    });
    wireHoursComparison(list);
}

function closeMoveMenus(except) {
    daysEl.querySelectorAll(".move-menu").forEach((menu) => {
        if (menu === except) return;
        menu.remove();
    });
    daysEl.querySelectorAll('.move-button[aria-expanded="true"]').forEach((b) => {
        if (except && b.closest(".move-control")?.contains(except)) return;
        b.setAttribute("aria-expanded", "false");
    });
    daysEl.querySelectorAll(".day.menu-open").forEach((day) => {
        if (!except || !day.contains(except)) day.classList.remove("menu-open");
    });
}

function openMoveMenu(button, currentDay) {
    const control = button.closest(".move-control"),
        alreadyOpen = button.getAttribute("aria-expanded") === "true";
    closeMoveMenus();
    if (alreadyOpen) return;

    const destinations = [
        { id: "backlog", title: "Backlog", detail: `${enabledSpotCount(store.backlog)} activas sin asignar` },
        ...store.state.map((day) => ({
            id: day.id,
            title: day.title,
            detail: `${fmt(day.date).day} ${fmt(day.date).month} · ${enabledSpotCount(day.spots)} activas`,
        })),
    ];
    const menu = document.createElement("span");
    menu.className = "move-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Mover parada a");
    menu.innerHTML = `<span class="move-menu-title">Mover parada a</span>${destinations
        .map((destination) => {
            const current = destination.id === currentDay;
            return `<button type="button" role="menuitem" data-act="move-to" data-day="${esc(destination.id)}" ${current ? "disabled" : ""}><span class="move-destination"><strong>${esc(destination.title)}</strong><small>${esc(destination.detail)}</small></span>${current ? '<span class="move-current">Actual</span>' : '<span class="move-arrow">›</span>'}</button>`;
        })
        .join("")}`;
    control.append(menu);
    control.closest(".day").classList.add("menu-open");
    button.setAttribute("aria-expanded", "true");
    menu.querySelector("button:not(:disabled)")?.focus();
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
    const activeBacklogCount = enabledSpotCount(store.backlog);
    b.innerHTML = `<div class="day-head"><div class="date-box"><span>ideas</span><strong>+</strong></div><div class="day-title"><div class="title-line"><span class="day-name">Backlog de paradas</span></div><small>${activeBacklogCount} sin asignar · ${esc(formatCost(sumCosts(store.backlog)))} · arrástralas a un día cuando decidáis</small></div><button class="day-collapse" title="${store.backlogCollapsed ? "Restaurar backlog" : "Minimizar backlog"}" aria-label="Minimizar o restaurar backlog">${store.backlogCollapsed ? "▸" : "▾"}</button></div><div class="spots"></div><button class="add-place">＋ Añadir al backlog</button>`;
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
            activeSpotCount = enabledSpotCount(day.spots),
            el = document.createElement("article");
        el.className =
            "day " +
            (day.id === store.active ? "active " : "") +
            (day.collapsed ? "collapsed" : "");
        el.dataset.day = day.id;
        el.innerHTML = `<div class="day-head"><button class="day-handle" type="button" title="Reordenar día" aria-label="Reordenar día">⠿</button><div class="date-box editable" title="Cambiar fecha"><span>${f.month}</span><strong>${f.day}</strong><input type="date" value="${day.date}" tabindex="-1" aria-label="Fecha del día"></div><div class="day-title"><div class="title-line"><span class="day-name" title="Pulsa para ver la ruta · doble clic para renombrar">${esc(day.title)}</span><button class="title-edit" title="Renombrar día" aria-label="Renombrar día">✎</button></div><small>${activeSpotCount} ${activeSpotCount === 1 ? "parada activa" : "paradas activas"} · ${esc(formatCost(sumCosts(day.spots)))} · pulsa para ver ruta</small></div><button class="day-collapse" title="${day.collapsed ? "Restaurar día" : "Minimizar día"}" aria-label="Minimizar o restaurar día">${day.collapsed ? "▸" : "▾"}</button><button class="day-duplicate" title="Duplicar día">⧉</button><button class="day-options" title="Eliminar día">×</button></div>${renderDaySchedule(day.spots, day.id)}<div class="spots"></div><button class="add-place">＋ Añadir una parada</button>`;
        renderList(el, day.spots);
        wireDaySchedule(el, day.id);
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
    const tripTotal =
        sumCosts(store.backlog) +
        store.state.reduce((total, day) => total + sumCosts(day.spots), 0);
    const budgetTotal = $("#tripBudgetTotal"),
        fullBudgetTotal = formatDualCost(tripTotal);
    budgetTotal.textContent = `Total: ${store.exchangeRate ? localAmount(tripTotal) : foreignAmount(tripTotal)}`;
    budgetTotal.title = fullBudgetTotal;
    budgetTotal.setAttribute("aria-label", `Total del viaje: ${fullBudgetTotal}`);
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
    $("#localCurrency").value = store.localCurrency;
    $("#foreignCurrency").value = store.foreignCurrency;
    document.title = (store.tripTitle || "Viaje") + " · Planificador de ruta";
}

// Spot action buttons (move/edit/delete/duplicate), delegated on #days.
daysEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const spotEl = b.closest(".spot"),
        dayId = spotEl.closest(".day").dataset.day,
        items = dayId === "backlog" ? store.backlog : dayBy(dayId).spots,
        i = items.findIndex((s) => s.id === spotEl.dataset.spot);
    if (b.dataset.act === "toggle-enabled") {
        items[i].mapEnabled = b.checked;
        save();
        render();
        drawMap();
    } else if (b.dataset.act === "move") {
        openMoveMenu(b, dayId);
    } else if (b.dataset.act === "move-to") {
        const destination = b.dataset.day,
            target = destination === "backlog" ? store.backlog : dayBy(destination)?.spots;
        if (!target || destination === dayId) return;
        moveSpot(spotEl.dataset.spot, destination, target.length);
    } else if (b.dataset.act === "edit") openDialog(dayId, items[i]);
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
    }
});

document.addEventListener("click", (e) => {
    if (!e.target.closest(".move-control")) closeMoveMenus();
});

window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const openButton = daysEl.querySelector('.move-button[aria-expanded="true"]');
    if (!openButton) return;
    closeMoveMenus();
    openButton.focus();
});
