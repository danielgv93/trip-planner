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
    routeTimeOverride,
    routeTimeProfile,
    travelLeg,
} from "../../core/store.js";
import { isWaypoint } from "../../core/itinerary.js";
import { AUTOMATIC_TRAVEL_MODES, normalizeTravelLeg, parseTravelLegKey, travelLegKey } from "../../core/travel-legs.js";
import {
    travelLegPresentation,
    visibleConsecutiveTravelLegs,
} from "../../core/travel-leg-presentation.js";
import { $, esc, safeColor, fmt, daysEl, id } from "../../shared/dom.js";
import { toast, confirmAction } from "../../shared/notify.js";
import {
    drawMap,
    mapsLinkFor,
    cachedDayTravelMinutes,
    cachedRouteTravelMinutes,
    ensureRouteTravelTimes,
    highlightMapSpot,
} from "../map/map.js";
import { openDialog } from "./dialogs.js";
import { pushUndo } from "./history.js";
import { foreignAmount, localAmount } from "../finance/currency.js";
import { DAY_LOAD_WARNING_MINUTES } from "../../core/constants.js";
import { dayWorkload as calculateDayWorkload } from "./workload.js";
import { healthBadgeMarkup } from "../health/session.js";
import { relocateSpot, relocateTravelCard } from "./move-spot.js";
import { buildTimelineProjection, createTimelineView, estimatedTravelMinutes } from "../companion/timeline.js";
import { timeToMinutes, minutesToTime } from "../../core/time.js";
import {
    openingHourSegments,
    scheduleIntervals,
    schedulesOverlap,
    scheduleOverlapSegments,
} from "./schedule.js";

export { timeToMinutes } from "../../core/time.js";
export { openingHourSegments, schedulesOverlap, scheduleOverlapSegments };

// View-only state: keep the selected time panel open across destructive renders
// without adding presentation preferences to the persisted trip data.
const expandedDayTools = new Map();

// View-only rectangular selections in each day timeline. A destructive render
// restores these classes without persisting presentation state in the plan.
const selectedTimelineSpots = new Map();

// View-only zoom for each day timeline. Keeping it beside the other timeline
// UI state lets destructive renders rebuild the same editor viewport without
// leaking a personal display preference into the portable trip plan.
const timelineZoomByDay = new Map();
const TIMELINE_ZOOM_MIN = 1;
const TIMELINE_ZOOM_MAX = 4;
const TIMELINE_ZOOM_STEP = 0.25;
const TIMELINE_MIN_BLOCK_MINUTES = 30;
const TIMELINE_TICK_LABEL_GAP = 48;

// One observer is enough for every rendered day. It is disconnected before
// the destructive render replaces the cards, avoiding references to old DOM.
const timelineTickResizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver((entries) => {
        entries.forEach(({ target }) => updateTimelineTickLabels(target));
    })
    : null;

// View-only state for the single inline quick-add editor. The draft lives here
// too so an unrelated destructive render cannot silently discard typed text.
// Neither value is part of the persisted store.
let quickAddOpenFor = null;
let quickAddDraft = "";

const durationDialog = $("#durationDialog");
const durationForm = $("#durationForm");
const durationInput = $("#durationMinutes");
const removeDurationButton = $("#removeDuration");
let durationEditing = null;

const travelDialog = $("#travelTimeDialog");
const travelForm = $("#travelTimeForm");
const travelInput = $("#travelTimeMinutes");
const travelMode = $("#travelMode");
const travelApiValue = $("#travelApiValue");
const resetTravelTimeButton = $("#resetTravelTime");
const deleteTravelLegButton = $("#deleteTravelLeg");
const travelDurationChoice = $("#travelDurationChoice");
const travelDurationRadios = [...travelDurationChoice.querySelectorAll('input[name="travelDurationSource"]')];
const travelTimeField = $("#travelTimeField");
const travelManualHint = $("#travelManualHint");
const travelDetails = $("#travelDetails");
const travelAdvanced = $("#travelAdvanced");
const travelSaveButton = $("#travelSaveButton");
const travelDurationError = $("#travelDurationError");
const travelDepartureError = $("#travelDepartureError");
const travelFormStatus = $("#travelFormStatus");
const travelDepartureTime = $("#travelDepartureTime");
const travelFixedDeparture = $("#travelFixedDeparture");
const travelLine = $("#travelLine");
const travelCost = $("#travelCost");
const travelNote = $("#travelNote");
let travelEditing = null;
let travelReturnFocus = null;

const timelineTooltip = document.createElement("div");
timelineTooltip.id = "timelineTooltip";
timelineTooltip.className = "timeline-tooltip";
timelineTooltip.setAttribute("role", "tooltip");
timelineTooltip.hidden = true;
document.body.append(timelineTooltip);

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

export function sumTravelCosts(day) {
    const sequence = (day?.spots || []).filter(spotIsEnabled);
    let total = 0;
    for (let index = 1; index < sequence.length; index += 1) {
        const cost = travelLeg(sequence[index - 1].id, sequence[index].id)?.cost;
        if (Number.isFinite(cost) && cost > 0) total += cost;
    }
    return total;
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

// Spanish duration formatting shared by the spot-card chip and the day-head
// workload text/meter tooltip: "~45 min" / "~3 h" / "~3 h 30 min".
export function formatDurationMinutes(minutes) {
    const total = Math.max(0, Math.round(minutes));
    if (total < 60) return `~${total} min`;
    const hours = Math.floor(total / 60),
        rest = total % 60;
    return rest === 0 ? `~${hours} h` : `~${hours} h ${rest} min`;
}

// Estimated activity minutes (sum of enabled spots' visitMinutes) and measured
// travel minutes (null when not every leg is cached) for one day. Only
// enabled spots count, matching every other day summary.
function dayWorkload(day) {
    return calculateDayWorkload(day, cachedDayTravelMinutes(day));
}

// Spanish workload segment for the day-head <small> line, e.g.
// " · ~3 h de visitas · ~45 min de trayectos". Empty string (no leading
// separator) when neither part has data, so the line stays byte-identical to
// today's output.
function dayLoadText(activity, travel) {
    const parts = [];
    if (activity > 0) parts.push(`${formatDurationMinutes(activity)} de visitas`);
    if (travel != null) parts.push(`${formatDurationMinutes(travel)} de trayectos`);
    return parts.length ? ` · ${parts.join(" · ")}` : "";
}

// Capacity-meter fill percentages for the two stacked segments (activity
// first, then travel), scaled down proportionally so their sum never exceeds
// 100% while preserving their relative proportion.
function dayLoadPercents(activity, travel) {
    const activityPct = (activity / DAY_LOAD_WARNING_MINUTES) * 100,
        travelPct = ((travel || 0) / DAY_LOAD_WARNING_MINUTES) * 100,
        totalPct = activityPct + travelPct,
        scale = totalPct > 100 ? 100 / totalPct : 1;
    return { activityPct: activityPct * scale, travelPct: travelPct * scale };
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
        allDay = opening === 0 && closing === 0,
        rail = segments
            .map(
                ({ start, width, equal }) =>
                    `<span class="spot-hours-segment${equal ? " is-equal" : ""}" style="--segment-start:${start.toFixed(4)}%;--segment-width:${width.toFixed(4)}%"></span>`,
            )
            .join("");
    const label = allDay ? "Todo el día" : `${openingTime}–${closingTime}`;
    const detail = allDay ? "Abierto todo el día" : `Abre ${openingTime} · Cierra ${closingTime}`;
    return `<span class="spot-hours is-complete"${interactive ? ' tabindex="0"' : ""} data-hours-opening="${esc(openingTime)}" data-hours-closing="${esc(closingTime)}" aria-label="Horario: ${esc(allDay ? "todo el día" : `abre a las ${openingTime} y cierra a las ${closingTime}`)}" style="--hours-color:${safeColor(color)}"><span class="spot-hours-icon" aria-hidden="true">◷</span><span class="spot-hours-text">${esc(label)}</span><span class="spot-hours-rail" aria-hidden="true">${rail}<span class="spot-hours-overlaps"></span></span><span class="spot-hours-detail" aria-hidden="true">${esc(detail)}</span></span>`;
}

function timelineTravelForLeg(from, to) {
    const configured = travelLeg(from.id, to.id);
    const profile = AUTOMATIC_TRAVEL_MODES.includes(configured?.mode)
        ? configured.mode
        : routeTimeProfile(from.id, to.id);
    const officialMinutes = AUTOMATIC_TRAVEL_MODES.includes(profile)
        ? cachedRouteTravelMinutes(from, to, profile)
        : null;
    const override = configured?.durationMinutes ?? routeTimeOverride(from.id, to.id, profile);
    return {
        minutes: override ?? officialMinutes,
        officialMinutes,
        overridden: override !== null,
        profile,
        mode: configured?.mode || profile,
        departureTime: configured?.departureTime,
        fixedDeparture: configured?.fixedDeparture,
        line: configured?.line,
        note: configured?.note,
        cost: configured?.cost,
        embeddedEndpoints: configured?.embeddedEndpoints,
    };
}

function timelineProfilesForDay(day) {
    const spots = day?.spots?.filter(spotIsEnabled) || [];
    const profiles = new Set(["walking"]);
    for (let index = 1; index < spots.length; index += 1) {
        const mode = travelLeg(spots[index - 1].id, spots[index].id)?.mode || routeTimeProfile(spots[index - 1].id, spots[index].id);
        if (AUTOMATIC_TRAVEL_MODES.includes(mode)) profiles.add(mode);
    }
    return profiles;
}

function ensureTimelineTravelTimes(day) {
    return Promise.all(
        [...timelineProfilesForDay(day)].map((profile) =>
            ensureRouteTravelTimes(day?.spots, profile),
        ),
    );
}

function renderDayTimeTools(day) {
    const spots = day.spots;
    const scheduled = spots.filter(
        (spot) =>
            spotIsEnabled(spot) &&
            (timeToMinutes(spot?.openingTime) !== null ||
                timeToMinutes(spot?.closingTime) !== null),
    );
    const enabled = spots.filter(spotIsEnabled);
    if (!enabled.length) return "";

    const rows = scheduled
        .map((spot) => {
            const opening = timeToMinutes(spot.openingTime),
                closing = timeToMinutes(spot.closingTime),
                hasOpening = opening !== null,
                hasClosing = closing !== null,
                allDay = opening === 0 && closing === 0,
                color = categoryMeta(spot.category).color,
                label = hasOpening && hasClosing
                    ? allDay
                        ? "Todo el día"
                        : `${spot.openingTime}–${spot.closingTime}`
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
    let selected = expandedDayTools.get(day.id) || "";
    if (selected === "schedule" && !scheduled.length) selected = "";
    const scheduleSelected = selected === "schedule";
    const timelineSelected = selected === "timeline";
    const timeline = createTimelineView(day, {
        interactive: true,
        travelForLeg: timelineTravelForLeg,
    });
    const timelineZoom = timelineZoomByDay.get(day.id) || TIMELINE_ZOOM_MIN;
    const zoomLabel = `${Number(timelineZoom.toFixed(2))}×`;
    const zoomControls = timeline.empty ? "" : `<label class="day-timeline-zoom"><span>Zoom</span><input type="range" min="${TIMELINE_ZOOM_MIN}" max="${TIMELINE_ZOOM_MAX}" step="${TIMELINE_ZOOM_STEP}" value="${timelineZoom}" data-timeline-zoom aria-label="Nivel de zoom del timeline"><output data-timeline-zoom-output aria-live="polite">${zoomLabel}</output></label>`;
    const baseId = `day-time-${esc(String(day.id))}`;
    return `<section class="day-time-tools" aria-label="Planificación horaria"><div class="day-time-tabs" role="group" aria-label="Vista horaria"><button id="${baseId}-schedule-tab" class="day-time-tab" type="button" data-day-time-tab="schedule" aria-expanded="${scheduleSelected}" aria-controls="${baseId}-schedule-panel" ${scheduled.length ? "" : "disabled"}><span class="day-schedule-summary-icon" aria-hidden="true">◷</span><span>Horarios</span><span class="day-schedule-count">${scheduled.length}</span><span class="day-schedule-chevron" aria-hidden="true">⌄</span></button><button id="${baseId}-timeline-tab" class="day-time-tab" type="button" data-day-time-tab="timeline" aria-expanded="${timelineSelected}" aria-controls="${baseId}-timeline-panel"><span aria-hidden="true">↝</span><span>Timeline</span><span class="day-schedule-chevron" aria-hidden="true">⌄</span></button></div><div id="${baseId}-schedule-panel" class="day-schedule-body" role="region" aria-label="Horarios del día" ${scheduleSelected ? "" : "hidden"}><span class="day-schedule-guide" aria-hidden="true"></span><div class="day-schedule-axis" aria-hidden="true"><span></span><span class="day-schedule-axis-hours"><i>00</i><i>06</i><i>12</i><i>18</i><i>24</i></span></div>${rows}</div><div id="${baseId}-timeline-panel" class="day-timeline-panel" role="region" aria-label="Timeline del día" ${timelineSelected ? "" : "hidden"}><div class="day-timeline-toolbar"><p class="day-timeline-summary">${esc(timeline.summary)} Pulsa para editar, arrastra para planificar o usa Mayús + arrastre para seleccionar varias paradas.</p>${zoomControls}</div><div class="companion-timeline-canvas" role="group" aria-label="${esc(timeline.aria)}">${timeline.html}</div>${timeline.empty ? "" : `<div class="companion-timeline-insight${timeline.warning ? " is-warning" : ""}" role="status">${esc(timeline.insight)}</div>`}</div></section>`;
}

function wireTimelineZoom(tools, dayId) {
    const canvas = tools?.querySelector(".companion-timeline-canvas");
    const track = canvas?.querySelector(".companion-timeline-track");
    const input = tools?.querySelector("[data-timeline-zoom]");
    const output = tools?.querySelector("[data-timeline-zoom-output]");
    if (!canvas || !track || !input || !output) return;

    const clampZoom = (value) => Math.min(
        TIMELINE_ZOOM_MAX,
        Math.max(TIMELINE_ZOOM_MIN, Number(value) || TIMELINE_ZOOM_MIN),
    );
    const paint = (value, anchorX = canvas.clientWidth / 2) => {
        const zoom = clampZoom(value);
        const previousWidth = track.scrollWidth || 1;
        const timelineRatio = (canvas.scrollLeft + anchorX) / previousWidth;
        timelineZoomByDay.set(dayId, zoom);
        input.value = String(zoom);
        output.value = `${Number(zoom.toFixed(2))}×`;
        input.style.setProperty(
            "--timeline-zoom-progress",
            `${((zoom - TIMELINE_ZOOM_MIN) / (TIMELINE_ZOOM_MAX - TIMELINE_ZOOM_MIN)) * 100}%`,
        );
        // Override the shared companion minimum: at 1x the whole day fits the
        // available canvas exactly, so the minimum cannot retain any panning.
        track.style.minWidth = "0";
        const timelineSpan = Number(track.dataset.timelineBoundEnd) - Number(track.dataset.timelineBoundStart);
        if (timelineSpan > 0) {
            const minimumWidth = (TIMELINE_MIN_BLOCK_MINUTES / zoom / timelineSpan) * 100;
            track.style.setProperty("--timeline-min-block-width", `${minimumWidth.toFixed(3)}%`);
        }
        // Leave one device-independent pixel for fractional layout rounding:
        // clientWidth is floored while scrollWidth is rounded up, which would
        // otherwise expose a one-pixel scrollbar even when both visually fit.
        track.style.width = `calc(${zoom * 100}% - 1px)`;
        updateTimelineTickLabels(track);
        canvas.scrollLeft = timelineRatio * track.scrollWidth - anchorX;
    };

    paint(timelineZoomByDay.get(dayId) || TIMELINE_ZOOM_MIN);
    timelineTickResizeObserver?.observe(track);
    input.addEventListener("input", () => paint(input.value));
    canvas.addEventListener("wheel", (event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const anchorX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
        paint(Number(input.value) + (event.deltaY < 0 ? TIMELINE_ZOOM_STEP : -TIMELINE_ZOOM_STEP), anchorX);
    }, { passive: false });
}

function updateTimelineTickLabels(track) {
    const ticks = [...track.querySelectorAll("[data-timeline-tick-minute]")];
    const start = Number(track.dataset.timelineBoundStart);
    const end = Number(track.dataset.timelineBoundEnd);
    const width = track.clientWidth;
    if (!ticks.length || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || !width)
        return;

    const pixelsPerMinute = width / (end - start);
    const first = ticks[0];
    const last = ticks.at(-1);
    const lastMinute = Number(last.dataset.timelineTickMinute);
    let previousVisibleMinute = Number(first.dataset.timelineTickMinute);

    ticks.forEach((tick, index) => {
        const label = tick.querySelector(".companion-timeline-tick-label");
        if (!label) return;
        const minute = Number(tick.dataset.timelineTickMinute);
        const isFirst = index === 0;
        const isLast = index === ticks.length - 1;
        const enoughAfterPrevious = (minute - previousVisibleMinute) * pixelsPerMinute >= TIMELINE_TICK_LABEL_GAP;
        const enoughBeforeLast = (lastMinute - minute) * pixelsPerMinute >= TIMELINE_TICK_LABEL_GAP;
        const visible = isFirst || isLast || (enoughAfterPrevious && enoughBeforeLast);

        label.hidden = !visible;
        tick.classList.toggle("is-labeled", visible);
        tick.classList.toggle("is-first", isFirst);
        tick.classList.toggle("is-last", isLast);
        if (visible) previousVisibleMinute = minute;
    });
}

function wireTimelinePan(tools) {
    const canvas = tools?.querySelector(".companion-timeline-canvas");
    if (!canvas) return;
    canvas.classList.add("is-drag-scroll");
    let pointer = null;

    const cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", escape);
        canvas.classList.remove("is-panning");
        document.body.style.userSelect = "";
        document.body.style.webkitUserSelect = "";
    };
    const move = (event) => {
        if (!pointer || event.pointerId !== pointer.id) return;
        const dx = event.clientX - pointer.x;
        const dy = event.clientY - pointer.y;
        if (!pointer.dragging) {
            if (Math.hypot(dx, dy) <= 5) return;
            if (Math.abs(dy) > Math.abs(dx)) {
                cleanup();
                pointer = null;
                return;
            }
            pointer.dragging = true;
            canvas.classList.add("is-panning");
            document.body.style.userSelect = "none";
            document.body.style.webkitUserSelect = "none";
            getSelection()?.removeAllRanges();
        }
        event.preventDefault();
        canvas.scrollLeft = pointer.scrollLeft - dx;
    };
    const finish = (event) => {
        if (!pointer || event.pointerId !== pointer.id) return;
        cleanup();
        pointer = null;
    };
    const cancel = (event) => {
        if (!pointer || event.pointerId !== pointer.id) return;
        cleanup();
        pointer = null;
    };
    const escape = (event) => {
        if (event.key !== "Escape" || !pointer) return;
        event.preventDefault();
        canvas.scrollLeft = pointer.scrollLeft;
        cleanup();
        pointer = null;
    };

    canvas.addEventListener("pointerdown", (event) => {
        if (
            store.previewMode ||
            event.shiftKey ||
            event.pointerType === "touch" ||
            (event.button !== undefined && event.button !== 0) ||
            canvas.scrollWidth <= canvas.clientWidth ||
            event.target.closest?.(
                "[data-timeline-spot], [data-timeline-travel-from], a, button, input",
            )
        ) return;
        pointer = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            scrollLeft: canvas.scrollLeft,
            dragging: false,
        };
        window.addEventListener("pointermove", move, { passive: false });
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", cancel);
        window.addEventListener("keydown", escape);
    });
}

function openDurationDialog(dayId, spotId) {
    const day = dayBy(dayId);
    const spot = day?.spots.find((candidate) => String(candidate.id) === spotId);
    if (!spot) return;
    if (isWaypoint(spot)) {
        openDialog(dayId, spot);
        return;
    }
    durationEditing = { dayId, spot };
    $("#durationSpotName").textContent = spot.name || "Parada sin nombre";
    durationInput.value =
        Number.isInteger(spot.visitMinutes) && spot.visitMinutes > 0
            ? spot.visitMinutes
            : "";
    removeDurationButton.hidden = !durationInput.value;
    durationDialog.showModal();
    durationInput.focus();
    durationInput.select();
}

function positionTimelineTooltip(target) {
    const targetRect = target.getBoundingClientRect();
    timelineTooltip.style.left = "0";
    timelineTooltip.style.top = "0";
    timelineTooltip.hidden = false;
    const tooltipRect = timelineTooltip.getBoundingClientRect();
    const margin = 10;
    const left = Math.min(
        window.innerWidth - tooltipRect.width - margin,
        Math.max(
            margin,
            targetRect.left + targetRect.width / 2 - tooltipRect.width / 2,
        ),
    );
    const timelineCanvas = target.dataset.timelineSpot
        ? target.closest(".companion-timeline-canvas")
        : null;
    const verticalAnchor = timelineCanvas?.getBoundingClientRect() || targetRect;
    const above = verticalAnchor.top - tooltipRect.height - 9;
    const below = verticalAnchor.bottom + 9;
    // Stop hover paints its timing labels across the track. Keep the tooltip
    // outside the whole canvas so it cannot cover opening, start or end guides.
    const top = above >= margin
        ? above
        : Math.min(window.innerHeight - tooltipRect.height - margin, below);
    timelineTooltip.style.left = `${Math.round(left)}px`;
    timelineTooltip.style.top = `${Math.round(top)}px`;
}

function showTimelineTooltip(target) {
    timelineTooltip.textContent = target.dataset.timelineTooltip || "";
    target.setAttribute("aria-describedby", timelineTooltip.id);
    positionTimelineTooltip(target);
}

function hideTimelineTooltip(target) {
    target?.removeAttribute("aria-describedby");
    timelineTooltip.hidden = true;
}

function wireTimelineTooltips(tools) {
    tools?.querySelectorAll("[data-timeline-tooltip]").forEach((target) => {
        target.addEventListener("mouseenter", () => showTimelineTooltip(target));
        target.addEventListener("mouseleave", () => hideTimelineTooltip(target));
        target.addEventListener("focus", () => showTimelineTooltip(target));
        target.addEventListener("blur", () => hideTimelineTooltip(target));
    });
}

function routeResultForLeg(from, to, profile) {
    const official = cachedRouteTravelMinutes(from, to, profile);
    if (official !== null) return { minutes: official, approximate: false };
    const approximate = estimatedTravelMinutes(from, to, profile);
    return approximate > 0 ? { minutes: approximate, approximate: true } : null;
}

function presentationForLeg(from, to) {
    const configured = travelLeg(from.id, to.id);
    const mode = configured?.mode || routeTimeProfile(from.id, to.id);
    return travelLegPresentation({
        leg: configured,
        defaultMode: mode,
        route: AUTOMATIC_TRAVEL_MODES.includes(mode)
            ? routeResultForLeg(from, to, mode)
            : null,
    });
}

function durationSource() {
    return travelDurationRadios.find((radio) => radio.checked)?.value || "custom";
}

function setDurationSource(value) {
    travelDurationRadios.forEach((radio) => {
        radio.checked = radio.value === value;
    });
    syncTravelDurationControls();
}

function syncTravelDurationControls() {
    if (!travelEditing) return;
    const automatic = AUTOMATIC_TRAVEL_MODES.includes(travelEditing.profile);
    const custom = !automatic || durationSource() === "custom";
    travelDurationChoice.hidden = !automatic;
    travelManualHint.hidden = automatic;
    travelTimeField.hidden = automatic && !custom;
    travelInput.required = custom;
    travelInput.disabled = !custom;
    resetTravelTimeButton.hidden = !automatic || !travelEditing.configured?.durationMinutes || durationSource() === "estimate";
    $("#travelTimeLabel").textContent = automatic ? "Duración personalizada" : "Duración manual";
    travelDurationError.textContent = "";
    if (!automatic) travelFormStatus.textContent = "Duración manual";
    else if (durationSource() === "custom")
        travelFormStatus.textContent = "Se guardará una duración personalizada.";
    else if (travelEditing.route?.approximate)
        travelFormStatus.textContent = "Duración aproximada";
    else if (travelEditing.route)
        travelFormStatus.textContent = "Duración estimada por ruta";
}

function endpointEligibility(spot, currentKey) {
    if (!isWaypoint(spot))
        return { eligible: false, reason: "Solo los puntos de paso pueden agruparse en la tarjeta." };
    const shared = Object.keys(store.travelLegs).some(
        (key) => key !== currentKey && key.split(">").includes(String(spot.id)),
    );
    return shared
        ? { eligible: false, reason: "Este punto de paso ya participa en otro trayecto." }
        : { eligible: true, reason: "Dejará de mostrarse como tarjeta independiente." };
}

function paintEndpointOptions() {
    if (!travelEditing) return;
    const key = travelLegKey(travelEditing.from.id, travelEditing.to.id);
    [["From", travelEditing.from], ["To", travelEditing.to]].forEach(([suffix, spot]) => {
        const checkbox = $(`#travelEmbed${suffix}`);
        const reason = $(`#travelEmbed${suffix}Reason`);
        const eligibility = endpointEligibility(spot, key);
        checkbox.disabled = !eligibility.eligible;
        if (!eligibility.eligible) checkbox.checked = false;
        reason.textContent = `${spot.name || "Parada"}: ${eligibility.reason}`;
    });
    travelAdvanced.hidden = !["From", "To"].some((suffix) => {
        const checkbox = $(`#travelEmbed${suffix}`);
        return !checkbox.disabled || checkbox.checked;
    });
}

function paintTravelDialogValues({ preserveInput = false } = {}) {
    if (!travelEditing) return;
    const automatic = AUTOMATIC_TRAVEL_MODES.includes(travelEditing.profile);
    const route = automatic
        ? routeResultForLeg(travelEditing.from, travelEditing.to, travelEditing.profile)
        : null;
    travelEditing.route = route;
    const apiCard = travelApiValue.closest(".travel-api-card");
    apiCard.hidden = !automatic;
    $("#travelApiBadge").hidden = !automatic || route?.approximate === true;
    travelApiValue.textContent = route
        ? `${route.approximate ? "≈ " : ""}${route.minutes} min${route.approximate ? " · cálculo geográfico" : ""}`
        : "No disponible";
    apiCard.dataset.state = route ? (route.approximate ? "approximate" : "ready") : "unavailable";
    const estimateRadio = travelDurationRadios.find((radio) => radio.value === "estimate");
    estimateRadio.disabled = !route;
    if (!preserveInput) {
        const source = automatic && !travelEditing.configured?.durationMinutes && route ? "estimate" : "custom";
        setDurationSource(source);
        travelInput.value = travelEditing.configured?.durationMinutes || "";
    } else if (automatic && durationSource() === "estimate" && !route) {
        setDurationSource("custom");
    }
    syncTravelDurationControls();
    if (automatic && !route)
        travelFormStatus.textContent = "La estimación no está disponible. Puedes guardar una duración personalizada.";
}

async function openTravelTimeDialog(dayId, button, { returnFocus = null } = {}) {
    const day = dayBy(dayId);
    const from = day?.spots.find(
        (spot) => String(spot.id) === button.dataset.timelineTravelFrom,
    );
    const to = day?.spots.find(
        (spot) => String(spot.id) === button.dataset.timelineTravelTo,
    );
    if (!day || !from || !to) return;
    const configured = travelLeg(from.id, to.id);
    const mode = configured?.mode || routeTimeProfile(from.id, to.id);
    travelEditing = { dayId, from, to, profile: mode, configured, requestToken: 0 };
    travelReturnFocus = {
        element: returnFocus || (button instanceof Element ? button : document.activeElement),
        dayId,
        key: travelLegKey(from.id, to.id),
    };
    $("#travelTimeDialogTitle").textContent = configured ? "Editar trayecto" : "Configurar trayecto";
    travelSaveButton.textContent = configured ? "Guardar cambios" : "Guardar trayecto";
    deleteTravelLegButton.hidden = !configured;
    $("#travelFromName").textContent = from.name || "Parada anterior";
    $("#travelToName").textContent = to.name || "Parada siguiente";
    travelMode.value = mode;
    travelDepartureTime.value = configured?.departureTime || "";
    travelFixedDeparture.checked = configured?.fixedDeparture === true;
    travelLine.value = configured?.line || "";
    travelCost.value = configured?.cost || "";
    travelNote.value = configured?.note || "";
    $("#travelCostCurrency").textContent = store.foreignCurrency;
    $("#travelEmbedFrom").checked = configured?.embeddedEndpoints?.includes("from") || false;
    $("#travelEmbedTo").checked = configured?.embeddedEndpoints?.includes("to") || false;
    travelDurationError.textContent = "";
    travelDepartureError.textContent = "";
    travelFormStatus.textContent = "";
    travelDetails.open = !AUTOMATIC_TRAVEL_MODES.includes(mode) || Boolean(
        configured?.departureTime || configured?.fixedDeparture || configured?.line || configured?.cost || configured?.note,
    );
    paintEndpointOptions();
    travelAdvanced.open = Boolean(configured?.embeddedEndpoints?.length);
    paintTravelDialogValues();
    if (!travelDialog.open) travelDialog.showModal();
    travelMode.focus();
    const requestToken = ++travelEditing.requestToken;
    if (AUTOMATIC_TRAVEL_MODES.includes(mode))
        await ensureRouteTravelTimes(day.spots, mode);
    if (!travelEditing || travelEditing.from !== from || travelEditing.to !== to)
        return;
    if (travelEditing.requestToken !== requestToken) return;
    paintTravelDialogValues({ preserveInput: true });
}

export function openTravelLegDialog(dayId, fromId, toId) {
    return openTravelTimeDialog(dayId, {
        dataset: {
            timelineTravelFrom: String(fromId),
            timelineTravelTo: String(toId),
            timelineTravelMinutes: "",
        },
    });
}

function commitTimelineStarts(dayId, starts) {
    const day = dayBy(dayId);
    if (!day || !(starts instanceof Map) || !starts.size) return;
    const currentStarts = new Map(
        buildTimelineProjection(day, {
            travelForLeg: timelineTravelForLeg,
        }).items.map((item) => [String(item.spot.id), item.start]),
    );
    const changed = [...starts].some(
        ([spotId, minute]) =>
            Number.isFinite(minute) &&
            currentStarts.get(String(spotId)) !== minute,
    );
    if (!changed) return;
    pushUndo();
    day.spots.forEach((spot) => {
        const minute = starts.get(String(spot.id));
        if (Number.isFinite(minute)) spot.plannedStart = minutesToTime(minute);
    });

    // The chronological timeline is the source of truth for enabled stops.
    // Replace only enabled slots so disabled stops keep their relative place.
    const ordered = day.spots
        .filter(spotIsEnabled)
        .map((candidate, index) => ({
            spot: candidate,
            start: starts.get(String(candidate.id)) ?? currentStarts.get(candidate.id) ?? 1440,
            index,
        }))
        .sort((a, b) => a.start - b.start || a.index - b.index)
        .map((item) => item.spot);
    let enabledIndex = 0;
    day.spots = day.spots.map((candidate) =>
        spotIsEnabled(candidate) ? ordered[enabledIndex++] : candidate,
    );
    save();
    render();
    drawMap();
}

function commitTimelineStart(dayId, spotId, minute) {
    commitTimelineStarts(dayId, new Map([[String(spotId), minute]]));
}

function paintLiveTimelineConflicts(tools, active) {
    const blocks = [...tools.querySelectorAll("[data-timeline-spot]")];
    blocks.forEach((block) =>
        block.classList.remove("is-live-overlap", "is-live-outside"),
    );
    const start = Number(active.dataset.timelineStart);
    const duration = Number(active.dataset.timelineDuration);
    const end = start + duration;
    const opening = Number(active.dataset.timelineOpening);
    const closing = Number(active.dataset.timelineClosing);
    const hasOpening = active.dataset.timelineOpening !== "";
    const hasClosing = active.dataset.timelineClosing !== "";
    const comparableWindow = !(hasOpening && hasClosing && opening >= closing);
    if (comparableWindow && (
        (hasOpening && start < opening) ||
        (hasClosing && end > closing) ||
        (hasClosing && !duration && start >= closing)
    )) active.classList.add("is-live-outside");
    if (!duration) {
        blocks.forEach((other) => {
            if (other === active) return;
            const otherStart = Number(other.dataset.timelineStart);
            const otherDuration = Number(other.dataset.timelineDuration);
            if (
                otherDuration > 0 &&
                start >= otherStart &&
                start < otherStart + otherDuration
            ) active.classList.add("is-live-overlap");
        });
        return;
    }
    blocks.forEach((other) => {
        if (other === active) return;
        const otherStart = Number(other.dataset.timelineStart);
        const otherDuration = Number(other.dataset.timelineDuration);
        const otherEnd = otherStart + otherDuration;
        if (!otherDuration && other.classList.contains("is-waypoint")) {
            if (otherStart >= start && otherStart < end)
                other.classList.add("is-live-overlap");
            return;
        }
        if (start < otherEnd && otherStart < end) {
            active.classList.add("is-live-overlap");
            other.classList.add("is-live-overlap");
        }
    });
}

function paintTimelineDragHours(tools, active, visible) {
    const track = active.closest(".companion-timeline-track");
    const guides = [...(track?.querySelectorAll(".companion-timeline-drag-hours") || [])];
    guides.forEach((guide) => {
        guide.classList.remove("is-visible", "has-label");
        guide.removeAttribute("data-hours-label");
    });
    if (!visible || !track || !guides.length) return;

    const boundStart = Number(track.dataset.timelineBoundStart);
    const boundEnd = Number(track.dataset.timelineBoundEnd);
    const opening = Number(active.dataset.timelineOpening);
    const closing = Number(active.dataset.timelineClosing);
    const hasOpening = active.dataset.timelineOpening !== "";
    const hasClosing = active.dataset.timelineClosing !== "";
    let ranges;
    if (hasOpening && hasClosing && opening === closing) {
        ranges = [[boundStart, boundEnd]];
    } else if (hasOpening && hasClosing && opening > closing) {
        ranges = [[boundStart, closing], [opening, boundEnd]];
    } else if (hasOpening && hasClosing) {
        ranges = [[opening, closing]];
    } else if (hasOpening) {
        ranges = [[opening, boundEnd]];
    } else if (hasClosing) {
        ranges = [[boundStart, closing]];
    } else {
        return;
    }

    const span = boundEnd - boundStart;
    const clipped = ranges
        .map(([start, end]) => [Math.max(boundStart, start), Math.min(boundEnd, end)])
        .filter(([start, end]) => end > start);
    const label = hasOpening && hasClosing
        ? `Horario ${minutesToTime(opening)}–${minutesToTime(closing)}`
        : hasOpening
          ? `Abre ${minutesToTime(opening)}`
          : `Cierra ${minutesToTime(closing)}`;
    clipped.slice(0, guides.length).forEach(([start, end], index) => {
        const guide = guides[index];
        guide.style.setProperty("--drag-hours-start", `${(((start - boundStart) / span) * 100).toFixed(3)}%`);
        guide.style.setProperty("--drag-hours-width", `${(((end - start) / span) * 100).toFixed(3)}%`);
        guide.style.setProperty(
            "--drag-hours-color",
            active.style.getPropertyValue("--timeline-color") || "#2f678f",
        );
        guide.classList.add("is-visible");
        if (index === 0) {
            guide.dataset.hoursLabel = label;
            guide.classList.add("has-label");
        }
    });
}

function paintTimelinePositionGuides(active, minute, visible) {
    const track = active.closest(".companion-timeline-track");
    const guides = [...(track?.querySelectorAll(".companion-timeline-position-guide") || [])];
    guides.forEach((guide) => {
        guide.classList.remove("is-visible");
        guide.classList.remove("is-label-before");
        guide.removeAttribute("data-guide-label");
    });
    if (!visible || !track || !guides.length) return;
    const start = Number(track.dataset.timelineBoundStart);
    const end = Number(track.dataset.timelineBoundEnd);
    const duration = Number(active.dataset.timelineDuration) || 0;
    const outgoingTravel = Number(active.dataset.timelineOutgoingTravel) || 0;
    const color = active.style.getPropertyValue("--timeline-color") || "#2f678f";
    const values = [
        ["is-start", minute, `Inicio ${minutesToTime(minute)}`, color],
        ["is-end", minute + duration, `Fin ${minutesToTime(minute + duration)}`, color],
        [
            "is-travel-end",
            minute + duration + outgoingTravel,
            `Fin caminata ${minutesToTime(minute + duration + outgoingTravel)}`,
            "#c66a2f",
        ],
    ];
    values.forEach(([className, value, label, guideColor]) => {
        if (!Number.isFinite(value) || value < start || value > end ||
            (className === "is-end" && duration <= 0) ||
            (className === "is-travel-end" && outgoingTravel <= 0)) return;
        const guide = guides.find((candidate) => candidate.classList.contains(className));
        if (!guide) return;
        const position = ((value - start) / (end - start)) * 100;
        guide.style.setProperty(
            "--timeline-guide-position",
            `${position.toFixed(3)}%`,
        );
        guide.style.setProperty("--timeline-guide-color", guideColor);
        guide.dataset.guideLabel = label;
        guide.classList.add("is-visible");

        // Labels grow to the right by default. Only flip one when its rendered
        // width would cross the timeline's right edge.
        const labelStyle = getComputedStyle(guide, "::before");
        const labelWidth = parseFloat(labelStyle.width) +
            parseFloat(labelStyle.paddingLeft) +
            parseFloat(labelStyle.paddingRight);
        const labelRight = guide.offsetLeft + 6 + labelWidth;
        guide.classList.toggle("is-label-before", labelRight > track.clientWidth);
    });
}

function timelineSelection(dayId, buttons) {
    const valid = new Set(buttons.map((button) => button.dataset.timelineSpot));
    const selected = selectedTimelineSpots.get(dayId) || new Set();
    [...selected].forEach((spotId) => {
        if (!valid.has(spotId)) selected.delete(spotId);
    });
    if (selected.size) selectedTimelineSpots.set(dayId, selected);
    else selectedTimelineSpots.delete(dayId);
    buttons.forEach((button) =>
        button.classList.toggle("is-selected", selected.has(button.dataset.timelineSpot)),
    );
    return selected;
}

function wireTimelineSelection(track, dayId) {
    if (!track) return;
    const buttons = [...track.querySelectorAll("[data-timeline-spot]")];
    timelineSelection(dayId, buttons);
    const box = track.querySelector(".companion-timeline-selection-box");
    let pointer = null;
    let suppressClick = false;

    const paint = (event) => {
        if (!pointer || event.pointerId !== pointer.id) return;
        const trackRect = track.getBoundingClientRect();
        const x = Math.max(0, Math.min(trackRect.width, event.clientX - trackRect.left));
        const y = Math.max(0, Math.min(trackRect.height, event.clientY - trackRect.top));
        const left = Math.min(pointer.x, x);
        const top = Math.min(pointer.y, y);
        const width = Math.abs(x - pointer.x);
        const height = Math.abs(y - pointer.y);
        pointer.dragging ||= Math.hypot(width, height) > 4;
        if (!pointer.dragging) return;
        event.preventDefault();
        box.style.left = `${left}px`;
        box.style.top = `${top}px`;
        box.style.width = `${width}px`;
        box.style.height = `${height}px`;
        box.classList.add("is-visible");
        const selectionRect = {
            left: trackRect.left + left,
            right: trackRect.left + left + width,
            top: trackRect.top + top,
            bottom: trackRect.top + top + height,
        };
        const selected = new Set(
            buttons
                .filter((button) => {
                    const rect = button.getBoundingClientRect();
                    return rect.left <= selectionRect.right &&
                        rect.right >= selectionRect.left &&
                        rect.top <= selectionRect.bottom &&
                        rect.bottom >= selectionRect.top;
                })
                .map((button) => button.dataset.timelineSpot),
        );
        if (selected.size) selectedTimelineSpots.set(dayId, selected);
        else selectedTimelineSpots.delete(dayId);
        timelineSelection(dayId, buttons);
    };

    const cleanup = () => {
        window.removeEventListener("pointermove", paint);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", escape);
        box?.classList.remove("is-visible");
        document.body.style.userSelect = "";
        document.body.style.webkitUserSelect = "";
    };
    const finish = (event) => {
        if (!pointer || event.pointerId !== pointer.id) return;
        if (!pointer.dragging) {
            const target = pointer.target.closest?.("[data-timeline-spot]");
            const selected = target
                ? new Set([target.dataset.timelineSpot])
                : new Set();
            if (selected.size) selectedTimelineSpots.set(dayId, selected);
            else selectedTimelineSpots.delete(dayId);
            timelineSelection(dayId, buttons);
        }
        cleanup();
        pointer = null;
        setTimeout(() => { suppressClick = false; }, 0);
    };
    const cancel = (event) => {
        if (!pointer || event.pointerId !== pointer.id) return;
        if (pointer.previous.size)
            selectedTimelineSpots.set(dayId, new Set(pointer.previous));
        else selectedTimelineSpots.delete(dayId);
        timelineSelection(dayId, buttons);
        cleanup();
        pointer = null;
        setTimeout(() => { suppressClick = false; }, 0);
    };
    const escape = (event) => {
        if (event.key !== "Escape" || !pointer) return;
        event.preventDefault();
        cancel({ pointerId: pointer.id });
    };

    track.addEventListener("pointerdown", (event) => {
        if (store.previewMode || !event.shiftKey || event.pointerType === "touch" ||
            (event.button !== undefined && event.button !== 0)) return;
        const rect = track.getBoundingClientRect();
        pointer = {
            id: event.pointerId,
            x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
            y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
            target: event.target,
            dragging: false,
            previous: new Set(selectedTimelineSpots.get(dayId) || []),
        };
        suppressClick = true;
        selectedTimelineSpots.delete(dayId);
        timelineSelection(dayId, buttons);
        event.preventDefault();
        document.body.style.userSelect = "none";
        document.body.style.webkitUserSelect = "none";
        getSelection()?.removeAllRanges();
        window.addEventListener("pointermove", paint, { passive: false });
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", cancel);
        window.addEventListener("keydown", escape);
    });
    track.addEventListener("click", (event) => {
        if (!suppressClick) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClick = false;
    }, true);
}

function wireTimelineSpot(button, tools, dayId) {
    let pointer = null;
    let ignoreClick = false;

    const paintHoverTiming = (visible) => {
        if (tools.classList.contains("is-timeline-dragging")) return;
        paintTimelineDragHours(tools, button, visible);
        paintTimelinePositionGuides(
            button,
            Number(button.dataset.timelineStart),
            visible,
        );
    };

    button.addEventListener("mouseenter", () => paintHoverTiming(true));
    button.addEventListener("mouseleave", () =>
        paintHoverTiming(document.activeElement === button),
    );
    button.addEventListener("focus", () => paintHoverTiming(true));
    button.addEventListener("blur", () => paintHoverTiming(button.matches(":hover")));

    const cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", escape);
        tools.classList.remove("is-timeline-dragging");
        button.classList.remove("is-dragging");
        pointer?.members.forEach(({ element }) =>
            element.classList.remove("is-group-dragging"),
        );
        pointer?.members.forEach(({ transfer }) =>
            transfer?.classList.remove("is-dragging"),
        );
        paintTimelineDragHours(tools, button, false);
        paintTimelinePositionGuides(button, pointer?.minute, false);
        tools.querySelectorAll(".is-live-overlap, .is-live-outside").forEach(
            (block) => block.classList.remove("is-live-overlap", "is-live-outside"),
        );
        document.body.style.userSelect = "";
        document.body.style.webkitUserSelect = "";
    };

    const move = (event) => {
        if (!pointer || event.pointerId !== pointer.id) return;
        const dx = event.clientX - pointer.x;
        const dy = event.clientY - pointer.y;
        if (!pointer.dragging) {
            if (Math.hypot(dx, dy) <= 7) return;
            if (Math.abs(dy) > Math.abs(dx) * 1.15) {
                ignoreClick = true;
                cleanup();
                pointer = null;
                return;
            }
            if (Math.abs(dx) <= Math.abs(dy) * 1.15) return;
            pointer.dragging = true;
            ignoreClick = true;
            hideTimelineTooltip(button);
            tools.classList.add("is-timeline-dragging");
            button.classList.add("is-dragging");
            pointer.members.forEach(({ element }) => {
                if (element !== button) element.classList.add("is-group-dragging");
            });
            pointer.members.forEach(({ transfer }) =>
                transfer?.classList.add("is-dragging"),
            );
            paintTimelineDragHours(tools, button, true);
            paintTimelinePositionGuides(button, pointer.minute, true);
            document.body.style.userSelect = "none";
            document.body.style.webkitUserSelect = "none";
            getSelection()?.removeAllRanges();
        }
        event.preventDefault();
        const rawDelta = Math.round(((dx / pointer.trackWidth) * pointer.span) / 5) * 5;
        const minimumDelta = Math.max(...pointer.members.map(({ minute }) => pointer.start - minute));
        const maximumDelta = Math.min(...pointer.members.map(({
            minute,
            duration,
            transfer,
            travelStart,
            travelMinutes,
        }) => Math.min(
            Math.min(1439, pointer.end - Math.min(duration, pointer.span)) - minute,
            transfer && Number.isFinite(travelStart)
                ? pointer.end - travelStart - travelMinutes
                : Infinity,
        )));
        pointer.delta = Math.max(minimumDelta, Math.min(maximumDelta, rawDelta));
        pointer.members.forEach(({ element, minute: original, duration, transfer, travelStart }) => {
            const minute = original + pointer.delta;
            const left = ((minute - pointer.start) / pointer.span) * 100;
            element.style.setProperty("--timeline-start", `${left.toFixed(3)}%`);
            element.dataset.timelineStart = String(minute);
            const timing = element.querySelector("[data-timeline-timing]");
            if (timing)
                timing.textContent = element.classList.contains("is-waypoint")
                    ? `${minutesToTime(minute)} · solo paso`
                    : duration
                    ? `${minutesToTime(minute)}–${minutesToTime(minute + duration)}`
                    : `${minutesToTime(minute)} · sin duración`;
            if (transfer && Number.isFinite(travelStart)) {
                const transferLeft = ((travelStart + pointer.delta - pointer.start) / pointer.span) * 100;
                transfer.style.setProperty("--timeline-start", `${transferLeft.toFixed(3)}%`);
                transfer.dataset.timelineStart = String(travelStart + pointer.delta);
            }
        });
        paintTimelinePositionGuides(
            button,
            Number(button.dataset.timelineStart),
            true,
        );
        paintLiveTimelineConflicts(tools, button);
    };

    const finish = (event) => {
        if (!pointer || event.pointerId !== pointer.id) return;
        const dragged = pointer.dragging;
        const starts = new Map(pointer.members.map(({ id, minute }) => [id, minute + pointer.delta]));
        cleanup();
        pointer = null;
        if (dragged) commitTimelineStarts(dayId, starts);
    };

    const cancel = (event) => {
        if (!pointer || event.pointerId !== pointer.id) return;
        ignoreClick = pointer.dragging || ignoreClick;
        cleanup();
        pointer = null;
        render({ persist: false });
    };

    const escape = (event) => {
        if (event.key !== "Escape" || !pointer) return;
        event.preventDefault();
        ignoreClick = true;
        cleanup();
        pointer = null;
        render({ persist: false });
    };

    button.addEventListener("pointerdown", (event) => {
        if (store.previewMode || event.shiftKey || (event.button !== undefined && event.button !== 0)) return;
        const track = button.closest(".companion-timeline-track");
        if (!track) return;
        const rect = track.getBoundingClientRect();
        const start = Number(track.dataset.timelineBoundStart);
        const end = Number(track.dataset.timelineBoundEnd);
        const buttons = [...track.querySelectorAll("[data-timeline-spot]")];
        const selected = timelineSelection(dayId, buttons);
        if (!selected.has(button.dataset.timelineSpot)) {
            selectedTimelineSpots.delete(dayId);
            timelineSelection(dayId, buttons);
        }
        const members = (selected.has(button.dataset.timelineSpot) && selected.size > 1
            ? buttons.filter((candidate) => selected.has(candidate.dataset.timelineSpot))
            : [button]
        ).map((element) => ({
            element,
            id: element.dataset.timelineSpot,
            minute: Number(element.dataset.timelineStart),
            duration: Number(element.dataset.timelineDuration) || 0,
            transfer: track.querySelector(
                `[data-timeline-travel-from="${CSS.escape(element.dataset.timelineSpot)}"]`,
            ),
        })).map((member) => ({
            ...member,
            travelStart: Number(member.transfer?.dataset.timelineStart),
            travelMinutes: Number(member.transfer?.dataset.timelineTravelMinutes) || 0,
        }));
        pointer = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            minute: Number(button.dataset.timelineStart),
            start,
            end,
            span: end - start,
            trackWidth: rect.width,
            members,
            delta: 0,
            dragging: false,
        };
        ignoreClick = false;
        window.addEventListener("pointermove", move, { passive: false });
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", cancel);
        window.addEventListener("keydown", escape);
    });
    button.addEventListener("click", (event) => {
        if (ignoreClick) {
            ignoreClick = false;
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        openDurationDialog(dayId, button.dataset.timelineSpot);
    });
    button.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const delta = (event.shiftKey ? 15 : 5) * (event.key === "ArrowLeft" ? -1 : 1);
        const minute = Math.max(0, Math.min(1439, Number(button.dataset.timelineStart) + delta));
        commitTimelineStart(dayId, button.dataset.timelineSpot, minute);
    });
}

function wireDayTimeTools(el, dayId) {
    const tools = el.querySelector(".day-time-tools");
    wireTimelineTooltips(tools);
    wireTimelineZoom(tools, dayId);
    wireTimelinePan(tools);
    tools?.querySelectorAll("[data-day-time-tab]").forEach((button) => {
        button.addEventListener("click", () => {
            const panel = button.dataset.dayTimeTab;
            const opening = expandedDayTools.get(dayId) !== panel;
            if (!opening) expandedDayTools.delete(dayId);
            else expandedDayTools.set(dayId, panel);
            render({ persist: false });
            if (opening && panel === "timeline") {
                const day = dayBy(dayId);
                ensureTimelineTravelTimes(day).then(() => {
                    if (expandedDayTools.get(dayId) === "timeline")
                        render({ persist: false });
                });
            }
        });
    });
    tools?.querySelectorAll("[data-timeline-spot]").forEach((button) => {
        wireTimelineSpot(button, tools, dayId);
        wireMapSpotHighlight(button, button.dataset.timelineSpot);
    });
    wireTimelineSelection(tools?.querySelector(".companion-timeline-track"), dayId);
    tools?.querySelectorAll("[data-timeline-travel-from]").forEach((button) => {
        button.addEventListener("click", () =>
            openTravelTimeDialog(dayId, button),
        );
    });
    const body = tools?.querySelector(".day-schedule-body");
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

durationForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!durationEditing || !durationInput.reportValidity()) return;
    const minutes = Number(durationInput.value);
    if (!Number.isInteger(minutes) || minutes <= 0) return;
    if (durationEditing.spot.visitMinutes === minutes) {
        durationDialog.close();
        return;
    }
    pushUndo();
    durationEditing.spot.visitMinutes = minutes;
    durationDialog.close();
    save();
    render();
    drawMap();
    toast("Duración de la parada actualizada.", "success");
});

durationDialog.querySelectorAll("[data-duration-preset]").forEach((button) => {
    button.addEventListener("click", () => {
        durationInput.value = button.dataset.durationPreset;
        durationInput.focus();
    });
});

removeDurationButton.addEventListener("click", () => {
    if (!durationEditing || durationEditing.spot.visitMinutes === undefined)
        return;
    pushUndo();
    delete durationEditing.spot.visitMinutes;
    durationDialog.close();
    save();
    render();
    drawMap();
    toast("Estimación de duración eliminada.", "info");
});

durationDialog.querySelector(".close").addEventListener("click", () =>
    durationDialog.close(),
);
durationDialog.querySelector(".cancel").addEventListener("click", () =>
    durationDialog.close(),
);
durationDialog.addEventListener("click", (event) => {
    if (event.target === durationDialog) durationDialog.close();
});
durationDialog.addEventListener("close", () => {
    durationEditing = null;
});

travelForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!travelEditing) return;
    travelDurationError.textContent = "";
    travelDepartureError.textContent = "";
    travelFormStatus.textContent = "";
    const automatic = AUTOMATIC_TRAVEL_MODES.includes(travelEditing.profile);
    const customDuration = !automatic || durationSource() === "custom";
    const minutes = Number(travelInput.value);
    if (customDuration && (!Number.isInteger(minutes) || minutes <= 0)) {
        travelDurationError.textContent = automatic
            ? "Introduce una duración personalizada en minutos enteros."
            : "Introduce la duración manual en minutos enteros.";
        travelFormStatus.textContent = "Revisa la duración del trayecto.";
        travelInput.focus();
        return;
    }
    if (automatic && !customDuration && !travelEditing.route) {
        travelDurationError.textContent = "La estimación no está disponible; elige Personalizar.";
        travelFormStatus.textContent = "Elige una duración válida antes de guardar.";
        return;
    }
    if (travelFixedDeparture.checked && !travelDepartureTime.value) {
        travelDetails.open = true;
        travelDepartureError.textContent = "Añade una hora para marcar la salida como fija.";
        travelFormStatus.textContent = "Revisa la hora de salida.";
        travelDepartureTime.focus();
        return;
    }
    const key = travelLegKey(travelEditing.from.id, travelEditing.to.id);
    const parsedCost = Number(travelCost.value);
    const requestedEndpoints = [$("#travelEmbedFrom").checked ? ["from", travelEditing.from] : null, $("#travelEmbedTo").checked ? ["to", travelEditing.to] : null].filter(Boolean);
    const currentKey = travelLegKey(travelEditing.from.id, travelEditing.to.id);
    const invalidEndpoint = requestedEndpoints.find(([, spot]) => !endpointEligibility(spot, currentKey).eligible);
    if (invalidEndpoint) {
        travelAdvanced.open = true;
        travelFormStatus.textContent = `“${invalidEndpoint[1].name}” no puede agruparse en este trayecto.`;
        return;
    }
    const embeddedEndpoints = requestedEndpoints.map(([role]) => role);
    const next = normalizeTravelLeg({
        mode: travelEditing.profile,
        durationMinutes: customDuration ? minutes : undefined,
        departureTime: travelDepartureTime.value,
        fixedDeparture: travelFixedDeparture.checked,
        line: travelLine.value,
        note: travelNote.value,
        cost: Number.isFinite(parsedCost) && parsedCost > 0 ? parsedCost : undefined,
        embeddedEndpoints,
    });
    if (JSON.stringify(store.travelLegs[key]) === JSON.stringify(next)) { travelDialog.close(); return; }
    pushUndo();
    store.travelLegs[key] = next;
    travelDialog.close();
    save();
    render();
    drawMap();
    toast("Trayecto guardado.", "success");
});

travelMode.addEventListener("change", async () => {
    if (!travelEditing) return;
    const profile = travelMode.value;
    travelEditing.profile = profile;
    const token = ++travelEditing.requestToken;
    const automatic = AUTOMATIC_TRAVEL_MODES.includes(profile);
    travelEditing.configured = {
        ...(travelEditing.configured || {}),
        mode: profile,
    };
    paintEndpointOptions();
    if (!automatic) {
        travelDetails.open = true;
        paintTravelDialogValues();
        travelInput.focus();
        return;
    }
    paintTravelDialogValues();
    const day = dayBy(travelEditing.dayId);
    await ensureRouteTravelTimes(day?.spots, profile);
    if (!travelEditing || travelEditing.requestToken !== token) return;
    paintTravelDialogValues({ preserveInput: true });
});

travelDurationRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
        syncTravelDurationControls();
        if (radio.checked && radio.value === "custom") travelInput.focus();
    });
});

travelDialog.querySelectorAll("[data-travel-step]").forEach((button) => {
    button.addEventListener("click", () => {
        const current = Number(travelInput.value) || 1;
        travelInput.value = Math.max(
            1,
            current + Number(button.dataset.travelStep),
        );
        travelInput.focus();
    });
});

resetTravelTimeButton.addEventListener("click", () => {
    if (!travelEditing) return;
    if (!AUTOMATIC_TRAVEL_MODES.includes(travelEditing.profile)) return;
    setDurationSource("estimate");
    travelFormStatus.textContent = "Se volverá a la estimación al guardar los cambios.";
});

async function removeTravelConfiguration() {
    if (!travelEditing?.configured) return;
    const { dayId, from, to, configured } = travelEditing;
    const endpoints = configured.embeddedEndpoints || [];
    const grouped = endpoints.length > 0;
    const ok = await confirmAction({
        title: "Eliminar configuración",
        message: grouped
            ? `¿Eliminar la configuración ${from.name} → ${to.name}? Los puntos de paso agrupados que no use otro trayecto también se retirarán del día.`
            : `¿Eliminar la configuración ${from.name} → ${to.name}? El tramo volverá a usar el comportamiento automático o predeterminado.`,
        confirmLabel: "Eliminar configuración",
    });
    if (!ok || !travelEditing) return;
    pushUndo();
    const key = travelLegKey(from.id, to.id);
    delete store.travelLegs[key];
    const spots = dayBy(dayId)?.spots || [];
    [["from", from], ["to", to]].forEach(([role, endpoint]) => {
        if (!endpoints.includes(role) || !isWaypoint(endpoint)) return;
        const shared = Object.keys(store.travelLegs).some((candidate) =>
            candidate.split(">").includes(String(endpoint.id)),
        );
        if (!shared) {
            const index = spots.findIndex((candidate) => candidate.id === endpoint.id);
            if (index >= 0) spots.splice(index, 1);
        }
    });
    travelDialog.close();
    save();
    render();
    drawMap();
    toast("Configuración del trayecto eliminada.", "info");
}

deleteTravelLegButton.addEventListener("click", removeTravelConfiguration);

travelDialog.querySelector(".close").addEventListener("click", () =>
    travelDialog.close(),
);
travelDialog.querySelector(".cancel").addEventListener("click", () =>
    travelDialog.close(),
);
travelDialog.addEventListener("click", (event) => {
    if (event.target === travelDialog) travelDialog.close();
});
travelDialog.addEventListener("close", () => {
    const returnTarget = travelReturnFocus;
    travelEditing = null;
    travelReturnFocus = null;
    requestAnimationFrame(() => {
        if (returnTarget?.element?.isConnected) {
            returnTarget.element.focus();
            return;
        }
        const connector = returnTarget?.key
            ? document.querySelector(`[data-leg-connector-key="${CSS.escape(returnTarget.key)}"]`)
            : null;
        const fallback = returnTarget?.dayId
            ? document.querySelector(`.day[data-day="${CSS.escape(String(returnTarget.dayId))}"] .day-overflow-button`)
            : null;
        (connector || fallback)?.focus();
    });
});

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
            row.dataset.hoursOpening === "00:00" && row.dataset.hoursClosing === "00:00"
                ? "Abierto todo el día"
                : `Abre ${row.dataset.hoursOpening} · Cierra ${row.dataset.hoursClosing}`,
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
        spotIdMap = new Map(),
        clone = {
            id: id(),
            date: day.date,
            title: day.title + " (copia)",
            spots: day.spots.map((s) => {
                const nextId = id();
                spotIdMap.set(String(s.id), nextId);
                return { ...s, id: nextId, tags: [...(s.tags || [])] };
            }),
        };
    pushUndo();
    Object.entries(store.travelLegs).forEach(([key, leg]) => {
        const [fromId, toId] = key.split(">");
        if (spotIdMap.has(fromId) && spotIdMap.has(toId))
            store.travelLegs[travelLegKey(spotIdMap.get(fromId), spotIdMap.get(toId))] = structuredClone(leg);
    });
    store.state.splice(idx + 1, 0, clone);
    save();
    render();
    drawMap();
    toast(`“${clone.title}” añadido.`, "info");
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
    pushUndo();
    arr.splice(idx + 1, 0, clone);
    save();
    render();
    drawMap();
    toast(`“${clone.name || "Parada"}” duplicada.`, "info");
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
        const waypointTime =
            waypoint && timeToMinutes(s.plannedStart) !== null
                ? ` · ${esc(s.plannedStart)}`
                : "";
        const kindBadge = waypoint
            ? `<span class="spot-kind-badge" title="Forma parte de la ruta sin duración de visita"><span aria-hidden="true">◇</span> Solo paso${waypointTime}</span>`
            : "";
        spot.innerHTML = `<button class="handle" type="button" title="Reordenar parada" aria-label="Reordenar ${esc(s.name || "parada")}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/></svg></button><label class="spot-toggle" title="${enabled ? "Desactivar parada" : "Activar parada"}"><input type="checkbox" data-act="toggle-enabled" ${enabled ? "checked" : ""} aria-label="${enabled ? "Desactivar" : "Activar"} ${esc(s.name || "parada")}"></label><span class="spot-content"><span class="spot-name">${number}<span class="spot-name-label">${esc(s.name)}</span></span>${kindBadge}${spotNote}${spotTiming}<span class="spot-tags"><span class="category-badge" style="--category-color:${safeColor(cat.color)}">${esc(cat.label)}</span>${s.tags?.length ? s.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join("") : ""}</span></span>${spotCost}<span class="spot-actions"><span class="spot-overflow-control"><button type="button" class="spot-overflow-button" data-act="overflow" title="Más acciones" aria-label="Más acciones para ${esc(s.name || "parada")}" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg></button></span></span>`;
        if (!hiddenAsEndpoint) {
            wireMapSpotHighlight(spot, s.id);
            list.append(spot);
        }
        if (pairIsVisible && outgoing?.embeddedEndpoints?.length && next) {
            const travelCard = document.createElement("div");
            travelCard.className = "spot travel-card";
            travelCard.dataset.travelLeg = travelLegKey(s.id, next.id);
            const modeIcons = { walking: "🚶", driving: "🚗", cycling: "🚲", bus: "🚌", train: "🚄", metro: "🚇", ferry: "⛴", flight: "✈", other: "↝" };
            const presentation = presentationForLeg(s, next);
            const arrival = outgoing.departureTime && presentation.minutes
                ? minutesToTime(timeToMinutes(outgoing.departureTime) + presentation.minutes, { wrap: true })
                : "";
            const price = Number.isFinite(outgoing.cost) && outgoing.cost > 0
                ? `<span class="spot-cost"><strong>${esc(foreignAmount(outgoing.cost))}</strong><small>${esc(localAmount(outgoing.cost))}</small></span>` : "";
            const draggable = outgoing.embeddedEndpoints?.includes("from") && outgoing.embeddedEndpoints?.includes("to");
            travelCard.innerHTML = `${draggable ? `<button class="handle travel-card-handle" type="button" title="Reordenar viaje" aria-label="Reordenar viaje ${esc(s.name)} a ${esc(next.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/></svg></button>` : ""}<span class="travel-card-icon" aria-hidden="true">${modeIcons[outgoing.mode] || "↝"}</span><span class="spot-content"><span class="spot-name">${esc(s.name || "Origen")} → ${esc(next.name || "Destino")}</span><span class="spot-meta">${esc(outgoing.line || presentation.modeLabel)} · ${presentation.minutes ? `${presentation.minutes} min` : "Duración pendiente"}</span>${outgoing.departureTime ? `<span class="spot-timing">Salida ${esc(outgoing.departureTime)}${arrival ? ` · llegada ${esc(arrival)}` : ""}</span>` : ""}${outgoing.note ? `<span class="spot-meta">${esc(outgoing.note)}</span>` : ""}</span>${price}<span class="travel-card-actions"><button type="button" class="travel-card-edit" aria-label="Editar trayecto">Editar</button><button type="button" class="travel-card-delete" aria-label="Eliminar trayecto">×</button></span>`;
            travelCard.querySelector(".travel-card-edit").addEventListener("click", () => {
                openTravelTimeDialog(list.closest(".day")?.dataset.day, { dataset: { timelineTravelFrom: String(s.id), timelineTravelTo: String(next.id), timelineTravelMinutes: String(outgoing.durationMinutes || "") } });
            });
            travelCard.querySelector(".travel-card-delete").addEventListener("click", async () => {
                const ok = await confirmAction({ title: "Eliminar trayecto", message: `¿Eliminar el trayecto ${s.name} → ${next.name}?`, confirmLabel: "Eliminar" });
                if (!ok) return;
                pushUndo();
                const key = travelLegKey(s.id, next.id);
                const endpoints = outgoing.embeddedEndpoints || [];
                delete store.travelLegs[key];
                [["from", s], ["to", next]].forEach(([role, endpoint]) => {
                    if (!endpoints.includes(role) || !isWaypoint(endpoint)) return;
                    const shared = Object.keys(store.travelLegs).some((candidate) => candidate.split(">").includes(String(endpoint.id)));
                    if (!shared) {
                        const endpointIndex = spots.findIndex((candidate) => candidate.id === endpoint.id);
                        if (endpointIndex >= 0) spots.splice(endpointIndex, 1);
                    }
                });
                save(); render(); drawMap();
                toast("Trayecto eliminado.", "info");
            });
            list.append(travelCard);
        } else if (pairIsVisible && !isBacklog && !store.previewMode && !outgoing?.embeddedEndpoints?.length) {
            const presentation = presentationForLeg(s, next);
            const connector = document.createElement("div");
            connector.className = `travel-leg-connector is-${presentation.status}`;
            const key = travelLegKey(s.id, next.id);
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
    menu.innerHTML = `${
        mapsLink
            ? `<a class="spot-overflow-item" href="${mapsLink}" target="_blank" rel="noopener" role="menuitem" data-act="overflow-maps"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-9 9"/><path d="M19 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4"/></svg><span>Abrir en Google Maps</span></a>`
            : ""
    }<span class="move-control spot-overflow-move-control"><button type="button" class="move-button spot-overflow-item" data-act="move" role="menuitem" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M14 8l4 4-4 4"/><path d="M8 7V5M8 19v-2"/></svg><span>Mover a otro día</span><span class="spot-overflow-arrow" aria-hidden="true">›</span></button></span><button type="button" class="spot-overflow-item" data-act="duplicate" role="menuitem"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg><span>Duplicar parada</span></button><button type="button" class="spot-overflow-item" data-act="edit" role="menuitem"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg><span>Editar parada</span></button><button type="button" class="spot-overflow-item spot-overflow-danger" data-act="delete" role="menuitem"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M9 7l1-3h4l1 3M6 7l1 14h10l1-14"/></svg><span>Borrar parada</span></button>`;
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
            pushUndo();
            const spot = { id: id(), name, address: "", note: "", tags: [], kind: "activity" };
            if (dayId === "backlog" && backlogGroupId)
                spot.backlogGroupId = backlogGroupId;
            target.push(spot);
            quickAddDraft = "";
            store.active = dayId;
            save();
            render();
            drawMap();
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
        if (next !== group.title) pushUndo();
        group.title = next;
        save();
        render();
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
            group.collapsed = !group.collapsed;
            save();
            render();
        });
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
            pushUndo();
            store.backlog.forEach((spot) => {
                if (spot.backlogGroupId === group.id)
                    delete spot.backlogGroupId;
            });
            store.backlogGroups = store.backlogGroups.filter(
                (candidate) => candidate.id !== group.id,
            );
            save();
            render();
            drawMap();
        });
    });
}

export function render({ persist = true } = {}) {
    // Also protects long-lived tabs that reload a newer renderer while an
    // older store module remains in the browser cache.
    if (!Array.isArray(store.backlogGroups)) store.backlogGroups = [];
    timelineTickResizeObserver?.disconnect();
    timelineTooltip.hidden = true;
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
        render();
        drawMap();
    });
    b.querySelector(".day-collapse").onclick = (e) => {
        e.stopPropagation();
        store.backlogCollapsed = !store.backlogCollapsed;
        save();
        render();
    };
    b.querySelector(".add-backlog-group").addEventListener("click", () => {
        pushUndo();
        const group = { id: id(), title: "Nuevo grupo", collapsed: false };
        store.backlogGroups.push(group);
        save();
        render();
        requestAnimationFrame(() => {
            const section = daysEl.querySelector(
                `.backlog-group[data-backlog-group="${CSS.escape(group.id)}"]`,
            );
            if (section) editBacklogGroupTitle(section, group);
        });
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
            if (!e.target.value || e.target.value === day.date) return;
            pushUndo();
            day.date = e.target.value;
            save();
            render();
            drawMap();
        });
        const startEdit = () => {
            if (store.previewMode) return;
            editTitle(day, el);
        };
        el.querySelector(".day-name").addEventListener("dblclick", startEdit);
        el.querySelector(".day-title-edit").addEventListener("click", startEdit);
        el.querySelector(".day-collapse").onclick = (e) => {
            e.stopPropagation();
            day.collapsed = !day.collapsed;
            save();
            render();
        };
        const removeDay = () => {
            confirmAction({
                title: "Eliminar día",
                message:
                    "¿Eliminar este día? Sus paradas pasarán al backlog.",
            }).then((ok) => {
                if (!ok) return;
                pushUndo();
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
        const nextTitle = v || day.title;
        if (nextTitle !== day.title) pushUndo();
        day.title = nextTitle;
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
export function moveSpot(spotId, toDay, at, backlogGroupId) {
    pushUndo();
    if (!relocateSpot(store, spotId, toDay, at, backlogGroupId)) return;
    store.active = toDay;
    save();
    render();
    drawMap();
}

export function moveTravelCard(key, toDay, beforeSpotId = null) {
    if (toDay === "backlog") {
        toast("Una tarjeta de viaje debe permanecer dentro de un día.", "info");
        render({ persist: false });
        return false;
    }
    const targetDay = dayBy(toDay);
    if (!targetDay) {
        render({ persist: false });
        return false;
    }
    pushUndo();
    if (!relocateTravelCard(store, key, toDay, beforeSpotId)) {
        render({ persist: false });
        return false;
    }
    store.active = targetDay.id;
    save(); render(); drawMap();
    toast("Viaje movido con sus puntos de origen y destino.", "success");
    return true;
}

// Reorder real days without changing the active day or any persisted shape.
export function moveDay(dayId, at) {
    const from = store.state.findIndex((day) => day.id === dayId);
    if (from === -1) return;
    const targetIndex = Math.max(0, Math.min(at, store.state.length - 1));
    if (from === targetIndex) return;
    pushUndo();
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
        items[i].mapEnabled = b.checked;
        save();
        render();
        drawMap();
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
                    : target?.length;
        if (!target) return;
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
            pushUndo();
            items.splice(idx, 1);
            affectedLegs.forEach((key) => delete store.travelLegs[key]);
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
