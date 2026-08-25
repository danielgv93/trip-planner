// The render cycle — the core convention. render() is destructive: it wipes
// #days and rebuilds every day/spot node from scratch, re-attaching listeners.
// Almost every mutation ends with the trio save(); render(); drawMap();.
//
// NOTE the circular import with dialogs.js (openDialog): it's safe because every
// cross-module reference here fires from an event handler at runtime, never
// during module evaluation.

import {
    store,
    saveLocalPreferences,
    dayBy,
    categoryMeta,
    toggleTagFilter,
    clearTagFilter,
    spotMatchesFilter,
    spotIsEnabled,
    routeTimeOverride,
    routeTimeProfile,
    travelLeg,
} from "../../core/store.js";
import { isWaypoint, positionConstraintInsertionIndex, spotPositionConstraint } from "../../core/itinerary.js";
import { AUTOMATIC_TRAVEL_MODES, normalizeTravelLeg, parseTravelLegKey, travelLegKey } from "../../core/travel-legs.js";
import {
    travelLegPresentation,
    visibleConsecutiveTravelLegs,
} from "../../core/travel-leg-presentation.js";
import { $, esc, safeColor, fmt, daysEl, id } from "../../shared/dom.js";
import { openModal } from "../../shared/modal.js";
import { toast, confirmAction } from "../../shared/notify.js";
import {
    drawMap,
    mapsLinkFor,
    cachedDayTravelMinutes,
    cachedRouteTravelMinutes,
    ensureRouteTravelTimes,
    highlightMapSpot,
    highlightMapLeg,
} from "../map/map.js";
import { openDialog } from "./dialogs.js";
import { foreignAmount, localAmount } from "../finance/currency.js";
import {
    formatCost,
    formatDualCost,
    sumCosts,
    sumTravelCosts,
} from "../finance/totals.js";
import { DAY_LOAD_WARNING_MINUTES } from "../../core/constants.js";
import { dayWorkload as calculateDayWorkload } from "./workload.js";
import { healthBadgeMarkup } from "../health/session.js";
import { buildTimelineProjection, createTimelineView, estimatedTravelMinutes } from "../timeline/timeline.js";
import {
    timelineScrollForCenter,
    timelineViewportCenter,
} from "../companion/timeline-viewport.js";
import { timeToMinutes, minutesToTime } from "../../core/time.js";
import {
    openingHourSegments,
    scheduleIntervals,
    schedulesOverlap,
    scheduleOverlapSegments,
} from "./schedule.js";
import { reminderStripMarkup } from "../reminders/presentation.js";
import { targetFingerprint } from "../../core/plan-operations.js";
import { createDraftAutosaveController } from "../../shared/draft-autosave.js";
import {
    commandIntent,
    derivedPlanOperation,
    insertEntityIntent,
    moveEntityIntent,
    setFieldIntent,
    updateFieldsIntent,
} from "../../core/plan-operation-commit.js";
import { formatDurationMinutes } from "./duration-presentation.js";
import {
    configurePlannerCommands,
    duplicateDay,
    duplicateSpot,
    moveDay,
    moveSpot,
    moveTravelCard,
} from "./commands.js";
import {
    beginTimelineRender,
    configureTimelineEditor,
    dayLoadPercents,
    dayLoadText,
    dayWorkload,
    enabledSpotCount,
    openTravelLegDialog,
    openTravelTimeDialog,
    presentationForLeg,
    renderDayTimeTools,
    renderSpotHours,
    restoreTimelineRender,
    wireDayTimeTools,
    wireHoursComparison,
} from "./timeline-editor.js";

export { timeToMinutes } from "../../core/time.js";
export { openingHourSegments, schedulesOverlap, scheduleOverlapSegments };
export { formatCost, formatDualCost, sumCosts, sumTravelCosts };
export { formatDurationMinutes };
export { duplicateDay, duplicateSpot, moveDay, moveSpot, moveTravelCard };
export { openTravelLegDialog, renderSpotHours };

configurePlannerCommands({ repaint: (options) => render(options) });
configureTimelineEditor({
    repaint: (options) => render(options),
    wireMapSpotHighlight,
    wireMapLegHighlight,
});

// View-only state for the single inline quick-add editor. The draft survives
// destructive renders but remains outside persisted plan state.
let quickAddOpenFor = null;
let quickAddDraft = "";

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
            updateTagFilter(() => toggleTagFilter(tag));
        };
        bar.insertBefore(e, anchor);
    });
    const n = store.activeTagFilter.size,
        hasFilter = n > 0;
    $("#filterActive").textContent = n === 1 ? "1 activo" : n + " activos";
    $("#filterActive").hidden = !hasFilter;
    $("#clearFilter").hidden = !hasFilter;
    $("#clearFilter").onclick = () => {
        updateTagFilter(clearTagFilter);
    };
}

// Filtering can remove enough cards above the viewport to shrink the document
// past the current scroll position. It also replaces every day node, so the
// browser's native scroll anchoring has nothing stable to follow. Keep the day
// currently underneath the sticky headers at the same visual position and
// retain the unfiltered list height until the filter is cleared.
function updateTagFilter(changeFilter) {
    const tagBarBottom = $("#tagBar").getBoundingClientRect().bottom;
    const days = [...daysEl.querySelectorAll(".day")];
    const anchorDay =
        days.find((day) => {
            const rect = day.getBoundingClientRect();
            return rect.top <= tagBarBottom && rect.bottom > tagBarBottom;
        }) ||
        days.find((day) => day.getBoundingClientRect().bottom > tagBarBottom);
    const anchorHead = anchorDay?.querySelector(":scope > .day-head");
    const anchor = anchorHead
        ? {
              id: anchorDay.dataset.day,
              top: anchorHead.getBoundingClientRect().top,
          }
        : null;
    const previousHeight = daysEl.getBoundingClientRect().height;

    changeFilter();
    if (store.activeTagFilter.size > 0) {
        const reservedHeight = Number.parseFloat(daysEl.style.minHeight) || 0;
        daysEl.style.minHeight = `${Math.max(previousHeight, reservedHeight)}px`;
    }

    render();
    if (store.activeTagFilter.size === 0) daysEl.style.minHeight = "";

    const restoreAnchor = () => {
        if (anchor && window.scrollY > 0) {
            const nextDay = [...daysEl.querySelectorAll(".day")].find(
                (day) => day.dataset.day === anchor.id,
            );
            const nextHead = nextDay?.querySelector(":scope > .day-head");
            if (nextHead)
                window.scrollBy(
                    0,
                    nextHead.getBoundingClientRect().top - anchor.top,
                );
        }
    };
    requestAnimationFrame(() => {
        restoreAnchor();
        // Sticky offsets and native focus handling settle after the first
        // frame; correct once more before the user can interact again.
        requestAnimationFrame(restoreAnchor);
    });
    drawMap();
}

function renderList(list, spots, isBacklog = false) {
    const visible = spots.filter(spotMatchesFilter);
    const activeSequence = spots.filter(spotIsEnabled);
    const connectorPairs = visibleConsecutiveTravelLegs(spots, {
        enabled: spotIsEnabled,
        visible: spotMatchesFilter,
    });
    const visibleNextByFrom = new Map(
        connectorPairs.map(({ from, to }) => [String(from.id), to]),
    );
    let mapNumber = 0;
    if (!visible.length)
        list.innerHTML = store.activeTagFilter.size > 0
            ? '<div class="empty">Ninguna parada coincide con el filtro</div>'
            : '<div class="empty">Arrastra aquí una idea o añade una nueva.</div>';
    visible.forEach((s) => {
        const activeIndex = activeSequence.findIndex((spot) => String(spot.id) === String(s.id));
        const previous = activeIndex > 0 ? activeSequence[activeIndex - 1] : null;
        const next = activeIndex >= 0 ? activeSequence[activeIndex + 1] : null;
        const incoming = previous ? travelLeg(previous.id, s.id) : null;
        const outgoing = next ? travelLeg(s.id, next.id) : null;
        const pairIsVisible = next && visibleNextByFrom.get(String(s.id)) === next;
        const hiddenAsEndpoint = spotIsEnabled(s) && (
            incoming?.embeddedEndpoints?.includes("to") ||
            outgoing?.embeddedEndpoints?.includes("from")
        );
        const spot = document.createElement("div");
        spot.className = "spot";
        spot.dataset.spot = s.id;
        spot.dataset.presenceTarget = `spot:${s.id}`;
        spot.dataset.spotName = s.name || "Parada sin nombre";
        const cat = categoryMeta(s.category);
        const spotCost =
            Number.isFinite(s.cost) && s.cost > 0
                ? `<span class="spot-cost"><strong>${esc(foreignAmount(s.cost))}</strong><small>${esc(localAmount(s.cost))}</small></span>`
                : "";
        const visitMinutes =
            !isWaypoint(s) && Number.isInteger(s.visitMinutes) && s.visitMinutes > 0
                ? s.visitMinutes
                : null;
        // Purely presentational (no tabindex, no pointer handlers) so the
        // pointer-events drag-and-drop is unaffected when a drag starts here.
        const spotDuration = visitMinutes
            ? `<span class="spot-duration" title="Tiempo de visita estimado"><span aria-hidden="true">◔</span> ${formatDurationMinutes(visitMinutes)}</span>`
            : "";
        const spotNote = s.note?.trim()
            ? `<span class="spot-meta">${esc(s.note)}</span>`
            : "";
        const enabled = spotIsEnabled(s);
        const waypoint = isWaypoint(s);
        const positionConstraint = spotPositionConstraint(s);
        const spotHours = waypoint
            ? ""
            : renderSpotHours(s, cat.color, enabled);
        const spotTiming =
            spotHours || spotDuration
                ? `<span class="spot-timing">${spotHours}${spotDuration}</span>`
                : "";
        if (enabled && !hiddenAsEndpoint) mapNumber += 1;
        const number = isBacklog
            ? ""
            : enabled
              ? `<span class="number">${mapNumber}</span>`
              : '<span class="number number-placeholder" aria-hidden="true">−</span>';
        spot.classList.toggle("spot-disabled", !enabled);
        spot.classList.toggle("spot-waypoint", waypoint);
        spot.classList.toggle("spot-position-anchored", Boolean(positionConstraint));
        if (positionConstraint) spot.dataset.positionConstraint = positionConstraint;
        const waypointTime =
            waypoint && timeToMinutes(s.plannedStart) !== null
                ? ` · ${esc(s.plannedStart)}`
                : "";
        const kindBadge = waypoint
            ? `<span class="spot-kind-badge" title="Forma parte de la ruta sin duración de visita"><span aria-hidden="true">◇</span> Solo paso${waypointTime}</span>`
            : "";
        const positionLabels = { first: "Primera parada", last: "Última parada", locked: "Posición fija" };
        const positionBadge = positionConstraint
            ? `<span class="spot-position-badge" title="Las mejoras y los movimientos respetarán este anclaje"><span aria-hidden="true">⌖</span> ${positionLabels[positionConstraint]}</span>`
            : "";
        const handleTitle = positionConstraint ? "Parada anclada; edítala para hacerla flexible" : "Reordenar parada";
        spot.innerHTML = `<button class="handle${positionConstraint ? " is-anchored" : ""}" type="button" title="${handleTitle}" aria-label="${positionConstraint ? "Parada anclada" : "Reordenar"} ${esc(s.name || "parada")}"${positionConstraint ? ' aria-disabled="true"' : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/></svg></button><label class="spot-toggle" title="${enabled ? "Desactivar parada" : "Activar parada"}"><input type="checkbox" data-act="toggle-enabled" ${enabled ? "checked" : ""} aria-label="${enabled ? "Desactivar" : "Activar"} ${esc(s.name || "parada")}"></label><span class="spot-content"><span class="spot-name">${number}<span class="spot-name-label">${esc(s.name)}</span></span>${kindBadge}${positionBadge}${spotNote}${spotTiming}${reminderStripMarkup(s.id)}<span class="spot-tags"><span class="category-badge" style="--category-color:${safeColor(cat.color)}">${esc(cat.label)}</span>${s.tags?.length ? s.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join("") : ""}</span></span>${spotCost}<span class="spot-actions"><span class="spot-overflow-control"><button type="button" class="spot-overflow-button" data-act="overflow" title="Más acciones" aria-label="Más acciones para ${esc(s.name || "parada")}" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg></button></span></span>`;
        if (!hiddenAsEndpoint) {
            wireMapSpotHighlight(spot, s.id);
            list.append(spot);
        }
        if (pairIsVisible && outgoing?.embeddedEndpoints?.length && next) {
            const travelCard = document.createElement("div");
            travelCard.className = "spot travel-card";
            travelCard.dataset.travelLeg = travelLegKey(s.id, next.id);
            travelCard.dataset.presenceTarget = `travel-leg:${travelLegKey(s.id, next.id)}`;
            const modeIcons = { walking: "🚶", driving: "🚗", cycling: "🚲", bus: "🚌", train: "🚄", metro: "🚇", ferry: "⛴", flight: "✈", other: "↝" };
            const presentation = presentationForLeg(s, next);
            const arrival = outgoing.departureTime && presentation.minutes
                ? minutesToTime(timeToMinutes(outgoing.departureTime) + presentation.minutes, { wrap: true })
                : "";
            const price = Number.isFinite(outgoing.cost) && outgoing.cost > 0
                ? `<span class="spot-cost"><strong>${esc(foreignAmount(outgoing.cost))}</strong><small>${esc(localAmount(outgoing.cost))}</small></span>` : "";
            const draggable = outgoing.embeddedEndpoints?.includes("from") && outgoing.embeddedEndpoints?.includes("to") && !spotPositionConstraint(s) && !spotPositionConstraint(next);
            travelCard.innerHTML = `${draggable ? `<button class="handle travel-card-handle" type="button" title="Reordenar viaje" aria-label="Reordenar viaje ${esc(s.name)} a ${esc(next.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/></svg></button>` : ""}<span class="travel-card-icon" aria-hidden="true">${modeIcons[outgoing.mode] || "↝"}</span><span class="spot-content"><span class="spot-name">${esc(s.name || "Origen")} → ${esc(next.name || "Destino")}</span><span class="spot-meta">${esc(outgoing.line || presentation.modeLabel)} · ${presentation.minutes ? `${presentation.minutes} min` : "Duración pendiente"}</span>${outgoing.departureTime ? `<span class="spot-timing">Salida ${esc(outgoing.departureTime)}${arrival ? ` · llegada ${esc(arrival)}` : ""}</span>` : ""}${outgoing.note ? `<span class="spot-meta">${esc(outgoing.note)}</span>` : ""}</span>${price}<span class="travel-card-actions"><button type="button" class="travel-card-edit" aria-label="Editar trayecto">Editar</button><button type="button" class="travel-card-delete" aria-label="Eliminar trayecto">×</button></span>`;
            wireMapLegHighlight(travelCard, s.id, next.id);
            travelCard.querySelector(".travel-card-edit").addEventListener("click", () => {
                openTravelTimeDialog(list.closest(".day")?.dataset.day, { dataset: { timelineTravelFrom: String(s.id), timelineTravelTo: String(next.id), timelineTravelMinutes: String(outgoing.durationMinutes || "") } });
            });
            travelCard.querySelector(".travel-card-delete").addEventListener("click", async () => {
                const ok = await confirmAction({ title: "Eliminar trayecto", message: `¿Eliminar el trayecto ${s.name} → ${next.name}?`, confirmLabel: "Eliminar" });
                if (!ok) return;
                const key = travelLegKey(s.id, next.id);
                await derivedPlanOperation((document) => commandIntent({
                    target: { type: "travel-leg", id: key },
                    command: "delete-travel-card",
                    precondition: { expectedFingerprint: targetFingerprint(document, { type: "travel-leg", id: key }) },
                }));
                toast("Trayecto eliminado.", "info");
            });
            list.append(travelCard);
        } else if (pairIsVisible && !isBacklog && !store.previewMode && !outgoing?.embeddedEndpoints?.length) {
            const presentation = presentationForLeg(s, next);
            const connector = document.createElement("div");
            connector.className = `travel-leg-connector is-${presentation.status}`;
            const key = travelLegKey(s.id, next.id);
            connector.dataset.presenceTarget = `travel-leg:${key}`;
            const duration = presentation.minutes
                ? `${presentation.minutes} min`
                : presentation.sourceLabel;
            const accessible = `Trayecto de ${s.name || "origen"} a ${next.name || "destino"}, ${presentation.modeLabel}, ${duration}`;
            connector.innerHTML = `<button type="button" class="travel-leg-connector-button" data-leg-connector-key="${esc(key)}" aria-label="${esc(accessible)}" aria-haspopup="dialog"><span class="travel-leg-connector-route"><span aria-hidden="true">↝</span><strong>${esc(presentation.modeLabel)}</strong><span>${esc(duration)}</span></span><span class="travel-leg-connector-action">${esc(presentation.actionLabel)}</span></button>`;
            const trigger = connector.querySelector("button");
            trigger.addEventListener("click", () => openTravelTimeDialog(
                list.closest(".day")?.dataset.day,
                { dataset: { timelineTravelFrom: String(s.id), timelineTravelTo: String(next.id) } },
                { returnFocus: trigger },
            ));
            wireMapLegHighlight(connector, s.id, next.id);
            list.append(connector);
        }
    });
    wireHoursComparison(list);
}

function wireMapSpotHighlight(element, spotId) {
    let pointerInside = false;
    let focusInside = false;
    const sync = () =>
        highlightMapSpot(spotId, pointerInside || focusInside);

    element.addEventListener("pointerenter", () => {
        pointerInside = true;
        sync();
    });
    element.addEventListener("pointerleave", () => {
        pointerInside = false;
        sync();
    });
    element.addEventListener("focusin", () => {
        focusInside = true;
        sync();
    });
    element.addEventListener("focusout", (event) => {
        focusInside = element.contains(event.relatedTarget);
        sync();
    });
}

function wireMapLegHighlight(element, fromId, toId) {
    let pointerInside = false;
    let focusInside = false;
    const sync = () =>
        highlightMapLeg(fromId, toId, pointerInside || focusInside);

    element.addEventListener("pointerenter", () => {
        pointerInside = true;
        sync();
    });
    element.addEventListener("pointerleave", () => {
        pointerInside = false;
        sync();
    });
    element.addEventListener("focusin", () => {
        focusInside = true;
        sync();
    });
    element.addEventListener("focusout", (event) => {
        focusInside = element.contains(event.relatedTarget);
        sync();
    });
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
    syncOpenMenuDays();
}

function closeOverflowMenus(except) {
    daysEl.querySelectorAll(".spot-overflow-menu").forEach((menu) => {
        if (menu === except) return;
        menu.remove();
    });
    daysEl
        .querySelectorAll('.spot-overflow-button[aria-expanded="true"]')
        .forEach((button) => {
            if (
                except &&
                button.closest(".spot-overflow-control")?.contains(except)
            )
                return;
            button.setAttribute("aria-expanded", "false");
        });
    syncOpenMenuDays();
}

function closeDayActionMenus(except) {
    daysEl.querySelectorAll(".day-action-menu").forEach((menu) => {
        if (menu === except) return;
        menu.remove();
    });
    daysEl
        .querySelectorAll('.day-overflow-button[aria-expanded="true"]')
        .forEach((button) => {
            if (
                except &&
                button.closest(".day-overflow-control")?.contains(except)
            )
                return;
            button.setAttribute("aria-expanded", "false");
        });
    syncOpenMenuDays();
}

function syncOpenMenuDays() {
    daysEl.querySelectorAll(".day").forEach((day) => {
        day.classList.toggle(
            "menu-open",
            Boolean(
                day.querySelector(
                    ".move-menu, .spot-overflow-menu, .day-action-menu",
                ),
            ),
        );
    });
}

function openDayActionMenu(button, day, { remove }) {
    const control = button.closest(".day-overflow-control"),
        alreadyOpen = button.getAttribute("aria-expanded") === "true";
    closeMoveMenus();
    closeOverflowMenus();
    closeDayActionMenus();
    if (alreadyOpen || !control) return;

    const menu = document.createElement("span");
    menu.className = "day-action-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", `Acciones para ${day.title || "día"}`);
    menu.innerHTML = `<span class="move-control day-action-move-control"><button type="button" class="move-button day-action-item" data-day-action="move" role="menuitem" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M14 8l4 4-4 4"/><path d="M8 7V5M8 19v-2"/></svg><span>Mover día</span><span class="day-action-arrow" aria-hidden="true">›</span></button></span><button type="button" class="day-action-item" data-day-action="duplicate" role="menuitem"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg><span>Duplicar día</span></button><button type="button" class="day-action-item day-action-danger" data-day-action="delete" role="menuitem"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M9 7l1-3h4l1 3M6 7l1 14h10l1-14"/></svg><span>Eliminar día</span></button>`;
    control.append(menu);
    control.closest(".day")?.classList.add("menu-open");
    button.setAttribute("aria-expanded", "true");
    menu.querySelector('[role="menuitem"]')?.focus();

    menu.addEventListener("click", (event) => {
        const moveIndex = event.target.closest("[data-day-move-index]")
            ?.dataset.dayMoveIndex;
        if (moveIndex !== undefined) {
            closeDayActionMenus();
            moveDay(day.id, Number(moveIndex));
            return;
        }
        const action = event.target.closest("[data-day-action]")?.dataset
            .dayAction;
        if (!action) return;
        if (action === "move") {
            openDayMoveMenu(
                event.target.closest("[data-day-action]"),
                day.id,
            );
            return;
        }
        closeDayActionMenus();
        if (action === "duplicate") duplicateDay(day.id);
        else if (action === "delete") remove();
    });
}

function openDayMoveMenu(button, dayId) {
    const control = button.closest(".move-control"),
        alreadyOpen = button.getAttribute("aria-expanded") === "true";
    closeMoveMenus();
    if (alreadyOpen || !control) return;

    const currentIndex = store.state.findIndex((day) => day.id === dayId),
        otherDays = store.state.filter((day) => day.id !== dayId),
        positions = store.state.map((_, index) => ({
            index,
            title: index === 0
                ? "Al principio"
                : otherDays[index - 1].title || "Día sin nombre",
            detail: `Posición ${index + 1} de ${store.state.length}`,
        }));
    const menu = document.createElement("span");
    menu.className = "move-menu day-move-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Mover día debajo de");
    menu.innerHTML = `<span class="move-menu-title">Mover debajo de…</span>${positions
        .map((position) => {
            const current = position.index === currentIndex;
            const icon = position.index === 0 ? "↑" : "↳";
            return `<button type="button" role="menuitem" data-day-move-index="${position.index}" ${current ? "disabled" : ""}><span class="day-move-position-icon${position.index === 0 ? " is-first" : ""}" aria-hidden="true">${icon}</span><span class="move-destination"><strong>${esc(position.title)}</strong><small>${esc(position.detail)}</small></span>${current ? '<span class="move-current">Actual</span>' : '<span class="move-arrow">›</span>'}</button>`;
        })
        .join("")}`;
    control.append(menu);
    control.closest(".day")?.classList.add("menu-open");
    button.setAttribute("aria-expanded", "true");
    menu.querySelector("button:not(:disabled)")?.focus();
}

function openMoveMenu(button, currentDay) {
    const control = button.closest(".move-control"),
        alreadyOpen = button.getAttribute("aria-expanded") === "true";
    closeOverflowMenus(button.closest(".spot-overflow-menu"));
    closeMoveMenus();
    if (alreadyOpen) return;

    const spotId = button.closest(".spot")?.dataset.spot,
        currentSpot =
            currentDay === "backlog"
                ? store.backlog.find((spot) => spot.id === spotId)
                : null,
        currentBacklogGroup = store.backlogGroups.some(
            (group) => group.id === currentSpot?.backlogGroupId,
        )
            ? currentSpot.backlogGroupId
            : "",
        ungrouped = store.backlog.filter(
            (spot) =>
                !store.backlogGroups.some(
                    (group) => group.id === spot.backlogGroupId,
                ),
        ),
        backlogDestinations = [
            {
                groupId: "",
                title: "Sin grupo",
                detail: `${enabledSpotCount(ungrouped)} activas`,
            },
            ...store.backlogGroups.map((group) => {
            const spots = store.backlog.filter(
                (spot) => spot.backlogGroupId === group.id,
            );
            return {
                groupId: group.id,
                title: group.title,
                detail: `${enabledSpotCount(spots)} activas`,
            };
        }),
        ],
        destinations = store.state.map((day) => ({
            id: day.id,
            title: day.title,
            detail: `${fmt(day.date).day} ${fmt(day.date).month} · ${enabledSpotCount(day.spots)} activas`,
        }));
    const menu = document.createElement("span");
    menu.className = "move-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Mover parada a");
    const currentBacklogTitle =
        currentDay === "backlog"
            ? backlogDestinations.find(
                  (destination) =>
                      destination.groupId === currentBacklogGroup,
              )?.title || "Sin grupo"
            : "";
    const backlogMenuMarkup = backlogDestinations
        .map((destination) => {
            const current =
                currentDay === "backlog" &&
                destination.groupId === currentBacklogGroup;
            return `<button type="button" role="menuitem" data-act="move-to" data-day="backlog" data-backlog-group="${esc(destination.groupId)}" ${current ? "disabled" : ""}><span class="move-destination"><strong>${esc(destination.title)}</strong><small>${esc(destination.detail)}</small></span>${current ? '<span class="move-current">Actual</span>' : '<span class="move-arrow">›</span>'}</button>`;
        })
        .join(""),
        dayMenuMarkup = destinations
        .map((destination) => {
            const current = destination.id === currentDay;
            return `<button type="button" role="menuitem" data-act="move-to" data-day="${esc(destination.id)}" ${current ? "disabled" : ""}><span class="move-destination"><strong>${esc(destination.title)}</strong><small>${esc(destination.detail)}</small></span>${current ? '<span class="move-current">Actual</span>' : '<span class="move-arrow">›</span>'}</button>`;
        })
        .join("");
    menu.innerHTML = `<span class="move-menu-page move-menu-main"><span class="move-menu-title">Mover parada a</span><span class="move-menu-days"><button type="button" role="menuitem" class="backlog-submenu-trigger" aria-haspopup="menu" aria-expanded="false"><span class="move-destination"><strong>Backlog</strong><small>${currentDay === "backlog" ? `Actual: ${esc(currentBacklogTitle)}` : `${enabledSpotCount(store.backlog)} activas sin asignar`}</small></span><span class="move-arrow" aria-hidden="true">›</span></button><span class="backlog-move-submenu" role="menu" aria-label="Grupos del backlog" hidden><span class="move-menu-title">Grupos del backlog</span>${backlogMenuMarkup}</span>${dayMenuMarkup}</span></span>`;
    control.append(menu);
    control.closest(".day").classList.add("menu-open");
    button.setAttribute("aria-expanded", "true");
    menu.querySelector("button:not(:disabled)")?.focus();

    const submenu = menu.querySelector(".backlog-move-submenu"),
        submenuTrigger = menu.querySelector(".backlog-submenu-trigger"),
        destinationsList = menu.querySelector(".move-menu-days"),
        compactMenu = () => matchMedia("(max-width: 620px)").matches;
    let submenuCloseTimer = null;
    const positionBacklogSubmenu = () => {
        if (compactMenu()) {
            submenu.style.removeProperty("left");
            submenu.style.removeProperty("top");
            return;
        }
        const gap = 8,
            margin = 8,
            triggerRect = submenuTrigger.getBoundingClientRect(),
            submenuRect = submenu.getBoundingClientRect(),
            fitsLeft = triggerRect.left - submenuRect.width - gap >= margin,
            left = fitsLeft
                ? triggerRect.left - submenuRect.width - gap
                : Math.min(
                      window.innerWidth - submenuRect.width - margin,
                      triggerRect.right + gap,
                  ),
            top = Math.max(
                margin,
                Math.min(
                    triggerRect.top,
                    window.innerHeight - submenuRect.height - margin,
                ),
            );
        submenu.style.left = `${Math.max(margin, left)}px`;
        submenu.style.top = `${top}px`;
    };
    const showBacklogSubmenu = ({ focus = false } = {}) => {
        clearTimeout(submenuCloseTimer);
        submenu.hidden = false;
        submenuTrigger.setAttribute("aria-expanded", "true");
        positionBacklogSubmenu();
        if (focus) submenu.querySelector("button:not(:disabled)")?.focus();
    };
    const hideBacklogSubmenu = ({ focus = false } = {}) => {
        clearTimeout(submenuCloseTimer);
        submenu.hidden = true;
        submenuTrigger.setAttribute("aria-expanded", "false");
        if (focus) submenuTrigger.focus();
    };
    submenuTrigger.addEventListener("click", () => {
        if (!compactMenu()) return;
        if (submenu.hidden) showBacklogSubmenu({ focus: true });
        else hideBacklogSubmenu({ focus: true });
    });
    const scheduleHoverClose = () => {
        clearTimeout(submenuCloseTimer);
        submenuCloseTimer = setTimeout(() => {
            if (
                compactMenu() ||
                submenuTrigger.matches(":hover") ||
                submenu.matches(":hover") ||
                submenu.contains(document.activeElement)
            )
                return;
            hideBacklogSubmenu();
        }, 140);
    };
    submenuTrigger.addEventListener("mouseenter", () => {
        if (!compactMenu()) showBacklogSubmenu();
    });
    submenuTrigger.addEventListener("mouseleave", scheduleHoverClose);
    submenu.addEventListener("mouseenter", () =>
        clearTimeout(submenuCloseTimer),
    );
    submenu.addEventListener("mouseleave", scheduleHoverClose);
    destinationsList.addEventListener("scroll", () => {
        if (!submenu.hidden) positionBacklogSubmenu();
    });
    submenuTrigger.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowRight" && event.key !== "Enter") return;
        event.preventDefault();
        showBacklogSubmenu({ focus: true });
    });
    submenu.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        hideBacklogSubmenu({ focus: true });
    });
}

function openOverflowMenu(button, spot, currentDay) {
    const control = button.closest(".spot-overflow-control"),
        alreadyOpen = button.getAttribute("aria-expanded") === "true";
    closeMoveMenus();
    closeDayActionMenus();
    closeOverflowMenus();
    if (alreadyOpen || !control) return;

    const mapsLink = mapsLinkFor(spot);
    const menu = document.createElement("span");
    menu.className = "spot-overflow-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute(
        "aria-label",
        `Acciones para ${spot.name || "parada"}`,
    );
    const anchored = Boolean(spotPositionConstraint(spot));
    menu.innerHTML = `${
        mapsLink
            ? `<a class="spot-overflow-item" href="${mapsLink}" target="_blank" rel="noopener" role="menuitem" data-act="overflow-maps"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-9 9"/><path d="M19 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4"/></svg><span>Abrir en Google Maps</span></a>`
            : ""
    }<span class="move-control spot-overflow-move-control"><button type="button" class="move-button spot-overflow-item"${anchored ? ' disabled title="Haz flexible la posición para moverla a otro día"' : ' data-act="move"'} role="menuitem" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M14 8l4 4-4 4"/><path d="M8 7V5M8 19v-2"/></svg><span>${anchored ? "Anclada a este día" : "Mover a otro día"}</span><span class="spot-overflow-arrow" aria-hidden="true">›</span></button></span><button type="button" class="spot-overflow-item" data-act="duplicate" role="menuitem"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg><span>Duplicar parada</span></button><button type="button" class="spot-overflow-item" data-act="edit" role="menuitem"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg><span>Editar parada</span></button><button type="button" class="spot-overflow-item spot-overflow-danger" data-act="delete" role="menuitem"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M9 7l1-3h4l1 3M6 7l1 14h10l1-14"/></svg><span>Borrar parada</span></button>`;
    control.append(menu);
    control.closest(".day")?.classList.add("menu-open");
    button.setAttribute("aria-expanded", "true");
    menu.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
}

// Targeted status update of the day-head workload text, badge and meter for
// one already-rendered day article — no node creation, no listener rewiring.
// Used both right after render() builds a day (so the initial paint and the
// async refresh share one computation) and from refreshDayLoad().
function applyDayLoad(dayEl, day) {
    const loadSpan = dayEl.querySelector("[data-day-load]"),
        badge = dayEl.querySelector(".day-load-badge"),
        meter = dayEl.querySelector(".day-load-meter"),
        detail = meter?.querySelector(".day-load-detail");
    if (!loadSpan || !badge || !meter || !detail) return;
    const { activity, travel } = dayWorkload(day),
        total = activity + (travel ?? 0),
        isOver = total > DAY_LOAD_WARNING_MINUTES,
        hasData = activity > 0 || travel != null;
    loadSpan.textContent = dayLoadText(activity, travel);
    badge.hidden = !isOver;
    meter.hidden = !hasData;
    meter.classList.toggle("is-over", hasData && isOver);
    if (hasData) {
        const { activityPct, travelPct } = dayLoadPercents(activity, travel);
        meter.style.setProperty("--load-activity", `${activityPct.toFixed(4)}%`);
        meter.style.setProperty("--load-travel", `${travelPct.toFixed(4)}%`);
        const activityText =
                activity > 0 ? formatDurationMinutes(activity) : "sin estimación",
            travelText =
                travel != null ? formatDurationMinutes(travel) : "calculando…",
            totalText =
                travel != null ? formatDurationMinutes(total) : "pendiente";
        detail.innerHTML = `<span><i class="is-activity"></i>Visitas <strong>${esc(activityText)}</strong></span><span><i class="is-travel"></i>Trayectos <strong>${esc(travelText)}</strong></span><span class="day-load-total">Total <strong>${esc(totalText)}</strong></span>`;
        meter.setAttribute(
            "aria-label",
            `Carga del día. Visitas: ${activityText}. Trayectos: ${travelText}. Total: ${totalText}.`,
        );
    } else {
        meter.style.removeProperty("--load-activity");
        meter.style.removeProperty("--load-travel");
        meter.removeAttribute("aria-label");
        detail.textContent = "";
    }
}

// Refreshes the workload text/badge/meter of every real day-head after
// debounced OSRM legs resolve, WITHOUT running the destructive render() cycle
// — open move menus, an in-progress title edit and an active drag survive.
// Never touches the backlog (it has no day-load elements to begin with).
export function refreshDayLoad() {
    daysEl.querySelectorAll(".day[data-day]").forEach((dayEl) => {
        const dayId = dayEl.dataset.day;
        if (dayId === "backlog") return;
        const day = dayBy(dayId);
        if (day) applyDayLoad(dayEl, day);
    });
}

function refreshTravelLegConnectors() {
    daysEl.querySelectorAll("[data-leg-connector-key]").forEach((button) => {
        const pair = parseTravelLegKey(button.dataset.legConnectorKey);
        const day = dayBy(button.closest(".day")?.dataset.day);
        const from = day?.spots.find((spot) => String(spot.id) === pair?.fromId);
        const to = day?.spots.find((spot) => String(spot.id) === pair?.toId);
        if (!from || !to) return;
        const presentation = presentationForLeg(from, to);
        const duration = presentation.minutes
            ? `${presentation.minutes} min`
            : presentation.sourceLabel;
        button.closest(".travel-leg-connector").className =
            `travel-leg-connector is-${presentation.status}`;
        button.setAttribute(
            "aria-label",
            `Trayecto de ${from.name || "origen"} a ${to.name || "destino"}, ${presentation.modeLabel}, ${duration}`,
        );
        button.innerHTML = `<span class="travel-leg-connector-route"><span aria-hidden="true">↝</span><strong>${esc(presentation.modeLabel)}</strong><span>${esc(duration)}</span></span><span class="travel-leg-connector-action">${esc(presentation.actionLabel)}</span>`;
    });
}

document.addEventListener("trip:route-times-updated", () => {
    refreshDayLoad();
    refreshTravelLegConnectors();
});

function quickAddKey(dayId, backlogGroupId) {
    return dayId === "backlog"
        ? `backlog:${backlogGroupId || "ungrouped"}`
        : dayId;
}

function quickAddMarkup(dayId, buttonLabel, backlogGroupId) {
    const key = quickAddKey(dayId, backlogGroupId);
    if (quickAddOpenFor !== key)
        return `<button class="add-place">${buttonLabel}</button>`;
    return `<div class="quick-add"><input class="quick-add-input" type="text" aria-label="Nombre de la nueva parada" placeholder="Nombre de la parada…" autocomplete="off"><button class="quick-add-details" type="button">Detalles…</button></div>`;
}

function closeQuickAdd() {
    quickAddOpenFor = null;
    quickAddDraft = "";
    render({ persist: false });
}

function wireQuickAdd(card, dayId, backlogGroupId) {
    const key = quickAddKey(dayId, backlogGroupId);
    const addButton = card.querySelector(".add-place");
    if (addButton) {
        addButton.addEventListener("click", () => {
            quickAddOpenFor = key;
            quickAddDraft = "";
            render({ persist: false });
        });
        return;
    }

    const editor = card.querySelector(".quick-add"),
        input = editor?.querySelector(".quick-add-input"),
        detailsButton = editor?.querySelector(".quick-add-details");
    if (!editor || !input || !detailsButton) return;

    input.value = quickAddDraft;
    input.addEventListener("input", () => {
        quickAddDraft = input.value;
    });
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            const name = input.value.trim();
            if (!name) return;
            const target =
                dayId === "backlog" ? store.backlog : dayBy(dayId)?.spots;
            if (!target) return;
            const spot = { id: id(), name, address: "", note: "", tags: [], kind: "activity" };
            if (dayId === "backlog" && backlogGroupId)
                spot.backlogGroupId = backlogGroupId;
            const insertAt = dayId === "backlog"
                ? target.length
                : positionConstraintInsertionIndex(target, spot, target.length);
            if (insertAt === null) {
                toast("No hay una posición compatible con los anclajes actuales.", "info");
                return;
            }
            quickAddDraft = "";
            store.active = dayId;
            const beforeId = target[insertAt]?.id ?? null;
            void derivedPlanOperation(() => insertEntityIntent(
                { type: "spot", id: spot.id },
                spot,
                { containerId: dayId, beforeId, backlogGroupId },
            ));
        } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeQuickAdd();
        }
    });
    input.addEventListener("blur", () => {
        // Let focus settle first: clicking Detalles… blurs the input before
        // its click handler runs and must not tear down the editor early.
        setTimeout(() => {
            if (quickAddOpenFor !== key || input.value.trim()) return;
            if (editor.contains(document.activeElement)) return;
            closeQuickAdd();
        }, 0);
    });
    detailsButton.addEventListener("click", () => {
        const name = input.value;
        quickAddOpenFor = null;
        quickAddDraft = "";
        render({ persist: false });
        openDialog(dayId, undefined, { name, backlogGroupId });
    });

    requestAnimationFrame(() => {
        if (!input.isConnected || quickAddOpenFor !== key) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    });
}

function editBacklogGroupTitle(section, group) {
    const title = section.querySelector(".backlog-group-title");
    if (!title) return;
    const input = document.createElement("input");
    input.className = "backlog-group-title-input";
    input.value = group.title;
    input.setAttribute("aria-label", "Nombre del grupo");
    title.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = () => {
        if (done) return;
        done = true;
        const next = input.value.trim() || group.title;
        if (next === group.title) { render({ persist: false }); return; }
        void derivedPlanOperation((document) => setFieldIntent(
            document,
            { type: "backlog-group", id: group.id, field: "title" },
            next,
        ));
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            input.blur();
        } else if (event.key === "Escape") {
            event.preventDefault();
            done = true;
            render({ persist: false });
        }
    });
}

function wireBacklogGroup(section, group) {
    section
        .querySelector(".backlog-group-collapse")
        .addEventListener("click", () => {
            void derivedPlanOperation((document) => setFieldIntent(
                document,
                { type: "backlog-group", id: group.id, field: "collapsed" },
                !group.collapsed,
            ), { undo: false });
        });
    // Collapsing is presentation; renaming and deleting are not, so a read-only
    // view never wires them (the double click included).
    if (store.readOnly) return;
    const edit = () => editBacklogGroupTitle(section, group);
    section.querySelector(".backlog-group-title").addEventListener("dblclick", edit);
    section.querySelector(".backlog-group-edit").addEventListener("click", edit);
    section.querySelector(".backlog-group-delete").addEventListener("click", () => {
        const count = store.backlog.filter(
            (spot) => spot.backlogGroupId === group.id,
        ).length;
        confirmAction({
            title: "Eliminar grupo",
            message: count
                ? `¿Eliminar “${group.title}”? Sus ${count} ideas quedarán en “Sin grupo”.`
                : `¿Eliminar el grupo vacío “${group.title}”?`,
            confirmLabel: "Eliminar",
        }).then((ok) => {
            if (!ok) return;
            void derivedPlanOperation((document) => commandIntent({
                target: { type: "backlog-group", id: group.id },
                command: "delete-backlog-group",
                precondition: { expectedFingerprint: targetFingerprint(document, { type: "backlog-group", id: group.id }) },
            }));
        });
    });
}

export function render() {
    // Also protects long-lived tabs that reload a newer renderer while an
    // older store module remains in the browser cache.
    if (!Array.isArray(store.backlogGroups)) store.backlogGroups = [];
    const timelineRender = beginTimelineRender();
    renderTags();
    const totalStops = store.backlog.length +
        store.state.reduce((total, day) => total + day.spots.length, 0);
    const overview = $("#itineraryOverview");
    if (overview)
        overview.textContent = `${store.state.length} ${store.state.length === 1 ? "día" : "días"} · ${totalStops} ${totalStops === 1 ? "parada" : "paradas"}`;
    daysEl.innerHTML = "";
    const b = document.createElement("article");
    b.className =
        "day backlog " +
        (store.active === "backlog" ? "active " : "") +
        (store.backlogCollapsed ? "collapsed" : "");
    b.dataset.day = "backlog";
    b.dataset.presenceTarget = "backlog:all";
    const activeBacklogCount = enabledSpotCount(store.backlog);
    b.innerHTML = `<div class="day-head"><div class="date-box"><span>ideas</span><strong>+</strong></div><div class="day-title"><div class="title-line"><span class="day-name">Backlog de paradas</span></div><small>${activeBacklogCount} sin asignar · ${esc(formatCost(sumCosts(store.backlog)))} · arrástralas a un día cuando decidáis</small></div><button class="day-collapse" title="${store.backlogCollapsed ? "Restaurar backlog" : "Minimizar backlog"}" aria-label="Minimizar o restaurar backlog">${store.backlogCollapsed ? "▸" : "▾"}</button></div><div class="backlog-groups"></div><div class="backlog-footer"><button class="add-backlog-group" type="button">＋ Crear grupo</button></div>`;
    const groupsContainer = b.querySelector(".backlog-groups");
    const renderBacklogSection = (group) => {
        const groupId = group?.id,
            spots = store.backlog.filter((spot) =>
                groupId
                    ? spot.backlogGroupId === groupId
                    : !store.backlogGroups.some(
                          (known) => known.id === spot.backlogGroupId,
                      ),
            ),
            section = document.createElement("section");
        section.className =
            "backlog-group" + (group?.collapsed ? " collapsed" : "");
        if (groupId) section.dataset.backlogGroup = groupId;
        section.dataset.presenceTarget = groupId ? `backlog-group:${groupId}` : "backlog:ungrouped";
        section.innerHTML = group
            ? `<div class="backlog-group-head"><button class="backlog-group-collapse" type="button" aria-expanded="${group.collapsed ? "false" : "true"}" aria-label="${group.collapsed ? "Desplegar" : "Plegar"} ${esc(group.title)}">${group.collapsed ? "▸" : "▾"}</button><span class="backlog-group-title">${esc(group.title)}</span><small>${spots.length} ${spots.length === 1 ? "idea" : "ideas"}</small><button class="backlog-group-edit" type="button" aria-label="Renombrar ${esc(group.title)}" title="Renombrar grupo">✎</button><button class="backlog-group-delete" type="button" aria-label="Eliminar grupo ${esc(group.title)}" title="Eliminar grupo">×</button></div><div class="spots" data-backlog-group="${esc(groupId)}"></div>${quickAddMarkup("backlog", "＋ Añadir una idea", groupId)}`
            : `<div class="backlog-group-head backlog-ungrouped-head"><span class="backlog-group-title">Sin grupo</span><small>${spots.length} ${spots.length === 1 ? "idea" : "ideas"}</small></div><div class="spots"></div>${quickAddMarkup("backlog", "＋ Añadir al backlog")}`;
        renderList(section.querySelector(".spots"), spots, true);
        wireQuickAdd(section, "backlog", groupId);
        if (group) wireBacklogGroup(section, group);
        groupsContainer.append(section);
    };
    if (
        !store.backlogGroups.length ||
        store.backlog.some(
            (spot) =>
                !store.backlogGroups.some(
                    (group) => group.id === spot.backlogGroupId,
                ),
        )
    )
        renderBacklogSection(null);
    store.backlogGroups.forEach(renderBacklogSection);
    b.querySelector(".day-head").addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        store.active = "backlog";
        render({ persist: false });
        drawMap();
    });
    b.querySelector(".day-collapse").onclick = (e) => {
        e.stopPropagation();
        store.backlogCollapsed = !store.backlogCollapsed;
        saveLocalPreferences();
        render({ persist: false });
    };
    b.querySelector(".add-backlog-group").addEventListener("click", () => {
        const group = { id: id(), title: "Nuevo grupo", collapsed: false };
        void derivedPlanOperation(() => insertEntityIntent(
            { type: "backlog-group", id: group.id },
            group,
        )).then(() => requestAnimationFrame(() => {
            const section = daysEl.querySelector(
                `.backlog-group[data-backlog-group="${CSS.escape(group.id)}"]`,
            );
            if (section) editBacklogGroupTitle(section, group);
        }));
    });
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
        el.dataset.presenceTarget = `day:${day.id}`;
        el.innerHTML = `<div class="day-head"><button class="day-handle" type="button" title="Reordenar día" aria-label="Reordenar ${esc(day.title || "día")}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/></svg></button><div class="date-box editable" title="Cambiar fecha"><span>${f.month}</span><strong>${f.day}</strong><input type="date" value="${day.date}" tabindex="-1" aria-label="Fecha del día"></div><div class="day-title"><div class="title-line"><span class="day-name" title="Pulsa para ver la ruta">${esc(day.title)}</span><button class="day-title-edit" type="button" title="Editar nombre del día" aria-label="Editar nombre de ${esc(day.title || "día")}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg></button></div><small>${activeSpotCount} ${activeSpotCount === 1 ? "parada activa" : "paradas activas"} · ${esc(formatCost(sumCosts(day.spots)))}<span class="day-load" data-day-load></span><span class="day-load-badge" hidden>día muy cargado</span> · pulsa para ver ruta</small><button class="day-load-meter" type="button" hidden aria-expanded="false"><span class="day-load-track" aria-hidden="true"><span class="day-load-fill is-activity"></span><span class="day-load-fill is-travel"></span></span><span class="day-load-detail" aria-hidden="true"></span></button></div><div class="day-actions"><button class="day-collapse" type="button" title="${day.collapsed ? "Desplegar día" : "Plegar día"}" aria-label="${day.collapsed ? "Desplegar" : "Plegar"} ${esc(day.title || "día")}" aria-expanded="${day.collapsed ? "false" : "true"}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><span class="day-overflow-control"><button class="day-overflow-button" type="button" title="Más acciones" aria-label="Más acciones para ${esc(day.title || "día")}" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg></button></span></div></div>${renderDayTimeTools(day)}<div class="spots"></div>${quickAddMarkup(day.id, "＋ Añadir una parada")}`;
        el.querySelector(".day-actions").insertAdjacentHTML("afterbegin", healthBadgeMarkup(day));
        renderList(el.querySelector(".spots"), day.spots);
        wireDayTimeTools(el, day.id);
        applyDayLoad(el, day);
        const loadMeter = el.querySelector(".day-load-meter");
        loadMeter.addEventListener("click", (event) => {
            event.stopPropagation();
            const open = loadMeter.classList.toggle("is-open");
            loadMeter.setAttribute("aria-expanded", String(open));
        });
        loadMeter.addEventListener("blur", () => {
            loadMeter.classList.remove("is-open");
            loadMeter.setAttribute("aria-expanded", "false");
        });
        loadMeter.addEventListener("keydown", (event) => {
            if (event.key !== "Escape") return;
            loadMeter.classList.remove("is-open");
            loadMeter.setAttribute("aria-expanded", "false");
            loadMeter.blur();
        });
        el.querySelector(".day-head").addEventListener("click", (e) => {
            if (
                e.target.closest(".date-box") ||
                e.target.closest("button") ||
                e.target.tagName === "INPUT"
            )
                return;
            store.active = day.id;
            render({ persist: false });
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
            if (!e.target.value || e.target.value === day.date) return;
            const value = e.target.value;
            void derivedPlanOperation((document) => setFieldIntent(
                document,
                { type: "day", id: day.id, field: "date" },
                value,
            ));
        });
        const startEdit = () => {
            if (store.previewMode) return;
            editTitle(day, el);
        };
        el.querySelector(".day-name").addEventListener("dblclick", startEdit);
        el.querySelector(".day-title-edit").addEventListener("click", startEdit);
        el.querySelector(".day-collapse").onclick = (e) => {
            e.stopPropagation();
            void derivedPlanOperation((document) => setFieldIntent(
                document,
                { type: "day", id: day.id, field: "collapsed" },
                !day.collapsed,
            ), { undo: false });
        };
        const removeDay = () => {
            confirmAction({
                title: "Eliminar día",
                message:
                    "¿Eliminar este día? Sus paradas pasarán al backlog.",
            }).then((ok) => {
                if (!ok) return;
                void derivedPlanOperation((document) => commandIntent({
                    target: { type: "day", id: day.id },
                    command: "delete-day",
                    precondition: { expectedFingerprint: targetFingerprint(document, { type: "day", id: day.id }) },
                })).then(() => {
                    store.active = "backlog";
                    toast("Día eliminado. Sus paradas están en el backlog.", "info");
                });
            });
        };
        el.querySelector(".day-overflow-button").onclick = (e) => {
            e.stopPropagation();
            openDayActionMenu(e.currentTarget, day, {
                remove: removeDay,
            });
        };
        wireQuickAdd(el, day.id);
        daysEl.append(el);
    });
    const tripTotal =
        sumCosts(store.backlog) +
        store.state.reduce((total, day) => total + sumCosts(day.spots) + sumTravelCosts(day), 0);
    const budgetTotal = $("#tripBudgetTotal"),
        fullBudgetTotal = formatDualCost(tripTotal);
    budgetTotal.textContent = `Total: ${store.exchangeRate ? localAmount(tripTotal) : foreignAmount(tripTotal)}`;
    budgetTotal.title = fullBudgetTotal;
    budgetTotal.setAttribute("aria-label", `Ver presupuesto. Total del viaje: ${fullBudgetTotal}`);
    restoreTimelineRender(timelineRender);
    if (timelineRender.viewports.size) {
        const restoreAfterLayout = () => {
            return restoreTimelineRender(timelineRender);
        };
        // Scroll anchoring and focus corrections are applied during layout.
        // Restore on the following two frames so neither the first layout nor
        // its resulting scrollbar adjustment can move the visible hours.
        requestAnimationFrame(() => {
            if (restoreAfterLayout()) requestAnimationFrame(restoreAfterLayout);
        });
    }
    document.dispatchEvent(new CustomEvent("planner-rendered"));
}

function editTitle(day, el) {
    const line = el.querySelector(".title-line");
    if (!line) return;
    const input = document.createElement("input");
    input.className = "editing";
    input.value = day.title;
    input.dataset.presenceTarget = `day:${day.id}:title`;
    input.setAttribute("aria-label", "Título del día");
    line.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = () => {
        if (done) return;
        done = true;
        const v = input.value.trim();
        const nextTitle = v || day.title;
        if (nextTitle === day.title) { render({ persist: false }); return; }
        void derivedPlanOperation((document) => setFieldIntent(
            document,
            { type: "day", id: day.id, field: "title" },
            nextTitle,
        ));
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

export function applyTitle() {
    $("#tripTitle").value = store.tripTitle;
    $("#localCurrency").value = store.localCurrency;
    $("#foreignCurrency").value = store.foreignCurrency;
    document.title = (store.tripTitle || "Viaje") + " · Planificador de ruta";
}

// Clicking a spot opens the same editor as the pencil. Interactive controls keep
// their own actions, and dnd.js swallows the synthetic click after a real drag.
// Spot action buttons (move/edit/delete/duplicate) are delegated here too.
daysEl.addEventListener("click", (e) => {
    const spotEl = e.target.closest(".spot");
    if (!spotEl || !daysEl.contains(spotEl)) return;
    const b = e.target.closest("[data-act]"),
        dayId = spotEl.closest(".day").dataset.day,
        items = dayId === "backlog" ? store.backlog : dayBy(dayId).spots,
        i = items.findIndex((s) => s.id === spotEl.dataset.spot);
    if (i === -1) return;
    if (!b) {
        if (e.target.closest("a, button, input, label, select, textarea")) return;
        openDialog(dayId, items[i]);
        return;
    }
    if (
        b.closest(".spot-overflow-menu") &&
        b.dataset.act !== "move"
    ) {
        closeMoveMenus();
        closeOverflowMenus();
    }
    if (b.dataset.act === "toggle-enabled") {
        const value = b.checked;
        void derivedPlanOperation((document) => setFieldIntent(
            document,
            { type: "spot", id: items[i].id, field: "mapEnabled" },
            value,
        ));
    } else if (b.dataset.act === "move") {
        openMoveMenu(b, dayId);
    } else if (b.dataset.act === "overflow") {
        openOverflowMenu(b, items[i], dayId);
    } else if (b.dataset.act === "move-to") {
        const destination = b.dataset.day,
            backlogGroupId = b.dataset.backlogGroup || undefined,
            target = destination === "backlog" ? store.backlog : dayBy(destination)?.spots,
            targetLength =
                destination === "backlog"
                    ? store.backlog.filter((spot) =>
                          backlogGroupId
                              ? spot.backlogGroupId === backlogGroupId
                              : !store.backlogGroups.some(
                                    (group) =>
                                        group.id === spot.backlogGroupId,
                                ),
                      ).length
                    : target
                      ? positionConstraintInsertionIndex(target, items[i], target.length)
                      : null;
        if (!target) return;
        if (targetLength === null) {
            toast("No hay una posición compatible con los anclajes de ese día.", "info");
            return;
        }
        moveSpot(spotEl.dataset.spot, destination, targetLength, backlogGroupId);
    } else if (b.dataset.act === "edit") openDialog(dayId, items[i]);
    else if (b.dataset.act === "delete") {
        const name = items[i].name;
        const affectedLegs = Object.keys(store.travelLegs || {}).filter((key) => {
            const [fromId, toId] = key.split(">");
            return fromId === items[i].id || toId === items[i].id;
        });
        confirmAction({
            title: "Borrar parada",
            message: `¿Borrar “${name}”?${affectedLegs.length ? ` También se eliminarán ${affectedLegs.length} ${affectedLegs.length === 1 ? "trayecto asociado" : "trayectos asociados"}.` : ""}`,
        }).then((ok) => {
            if (!ok) return;
            const idx = items.findIndex((s) => s.id === spotEl.dataset.spot);
            if (idx === -1) return;
            void derivedPlanOperation((document) => commandIntent({
                target: { type: "spot", id: items[idx].id },
                command: "delete-spot",
                precondition: { expectedFingerprint: targetFingerprint(document, { type: "spot", id: items[idx].id }) },
            })).then(() => toast(`“${name}” eliminada.`, "info"));
        });
    } else if (b.dataset.act === "duplicate") {
        duplicateSpot(items[i].id, dayId);
    }
});

document.addEventListener("click", (e) => {
    if (!e.target.closest(".move-control")) closeMoveMenus();
    if (
        e.target.closest('[data-act="overflow-maps"]') ||
        !e.target.closest(".spot-overflow-control")
    )
        closeOverflowMenus();
    if (!e.target.closest(".day-overflow-control")) closeDayActionMenus();
});

window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const openMoveButton = daysEl.querySelector(
        '.move-button[aria-expanded="true"]',
    );
    if (openMoveButton) {
        closeMoveMenus();
        openMoveButton.focus();
        return;
    }
    const openButton = daysEl.querySelector(
        '.spot-overflow-button[aria-expanded="true"]',
    );
    if (openButton) {
        closeOverflowMenus();
        openButton.focus();
        return;
    }
    const openDayButton = daysEl.querySelector(
        '.day-overflow-button[aria-expanded="true"]',
    );
    if (!openDayButton) return;
    closeDayActionMenus();
    openDayButton.focus();
});
