import {
    store,
    dayBy,
    categoryMeta,
    spotIsEnabled,
    routeTimeOverride,
    routeTimeProfile,
    travelLeg,
} from "../../core/store.js";
import { isWaypoint } from "../../core/itinerary.js";
import {
    AUTOMATIC_TRAVEL_MODES,
    normalizeTravelLeg,
    travelLegKey,
} from "../../core/travel-legs.js";
import { travelLegPresentation } from "../../core/travel-leg-presentation.js";
import { $, esc, safeColor, daysEl } from "../../shared/dom.js";
import { openModal } from "../../shared/modal.js";
import { toast, confirmAction } from "../../shared/notify.js";
import {
    cachedDayTravelMinutes,
    cachedRouteTravelMinutes,
    ensureRouteTravelTimes,
} from "../map/map.js";
import { foreignAmount, localAmount } from "../finance/currency.js";
import { DAY_LOAD_WARNING_MINUTES } from "../../core/constants.js";
import { dayWorkload as calculateDayWorkload } from "./workload.js";
import {
    buildTimelineProjection,
    createTimelineView,
    estimatedTravelMinutes,
} from "../timeline/timeline.js";
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
import { targetFingerprint } from "../../core/plan-operations.js";
import { createDraftAutosaveController } from "../../shared/draft-autosave.js";
import {
    commandIntent,
    derivedPlanOperation,
    insertEntityIntent,
    setFieldIntent,
    updateFieldsIntent,
} from "../../core/plan-operation-commit.js";
import { formatDurationMinutes } from "./duration-presentation.js";

let repaint = () => {};
let wireItineraryMapSpotHighlight = () => {};
let wireItineraryMapLegHighlight = () => {};

export function configureTimelineEditor({
    repaint: nextRepaint,
    wireMapSpotHighlight,
    wireMapLegHighlight,
} = {}) {
    if (typeof nextRepaint === "function") repaint = nextRepaint;
    if (typeof wireMapSpotHighlight === "function")
        wireItineraryMapSpotHighlight = wireMapSpotHighlight;
    if (typeof wireMapLegHighlight === "function")
        wireItineraryMapLegHighlight = wireMapLegHighlight;
}

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
const TIMELINE_ZOOM_MAX = 10;
const TIMELINE_ZOOM_STEP = 0.25;
const TIMELINE_HALF_HOUR_ZOOM = 4;
const TIMELINE_TICK_LABEL_GAP = 48;
let timelineViewportRestoreToken = 0;
const pendingTimelineViewportCenters = new Map();
const timelineViewportCentersByDay = new Map();

function timelineCenterForCanvas(canvas) {
    const track = canvas?.querySelector(".companion-timeline-track");
    if (!canvas || !track) return null;
    return timelineViewportCenter({
        boundStart: Number(track.dataset.timelineBoundStart),
        boundEnd: Number(track.dataset.timelineBoundEnd),
        scrollLeft: canvas.scrollLeft,
        viewportWidth: canvas.clientWidth,
        trackWidth: track.scrollWidth,
    });
}

function captureTimelineViewports() {
    const viewports = new Map();
    daysEl.querySelectorAll(".day[data-day]").forEach((dayElement) => {
        const canvas = dayElement.querySelector(".companion-timeline-canvas");
        const centerMinute = timelineCenterForCanvas(canvas);
        if (centerMinute !== null)
            viewports.set(String(dayElement.dataset.day), centerMinute);
    });
    // Pointer focus can nudge a scroll container before pointerup. A timeline
    // drag therefore gets priority over the last DOM measurement so the view
    // returns to exactly what the user saw when the gesture began.
    pendingTimelineViewportCenters.forEach((centerMinute, dayId) =>
        viewports.set(String(dayId), centerMinute),
    );
    return viewports;
}

function restoreTimelineViewports(viewports) {
    if (!viewports.size) return;
    daysEl.querySelectorAll(".day[data-day]").forEach((dayElement) => {
        const centerMinute = viewports.get(String(dayElement.dataset.day));
        if (centerMinute === undefined) return;
        const canvas = dayElement.querySelector(".companion-timeline-canvas");
        const track = canvas?.querySelector(".companion-timeline-track");
        if (!canvas || !track) return;
        canvas.scrollLeft = timelineScrollForCenter({
            boundStart: Number(track.dataset.timelineBoundStart),
            boundEnd: Number(track.dataset.timelineBoundEnd),
            centerMinute,
            viewportWidth: canvas.clientWidth,
            trackWidth: track.scrollWidth,
        });
    });
}

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
const durationDialog = $("#durationDialog");
const durationForm = $("#durationForm");
const durationInput = $("#durationMinutes");
const durationIsWaypoint = $("#durationIsWaypoint");
const durationActivityFields = $("#durationActivityFields");
const durationOpeningTime = $("#durationOpeningTime");
const durationClosingTime = $("#durationClosingTime");
const durationScheduleNotApplicable = $("#durationScheduleNotApplicable");
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

// Modifier keys change what dragging or scrolling does in the day timeline.
// Reflect that mode in the cursor before the pointer action begins. Keeping the
// state on the root element also survives the destructive itinerary render.
const timelineModifierRoot = document.documentElement;
function syncTimelineModifierCursor(event) {
    timelineModifierRoot.classList.toggle(
        "is-timeline-zoom-modifier",
        event.ctrlKey || event.metaKey,
    );
    timelineModifierRoot.classList.toggle(
        "is-timeline-select-modifier",
        event.shiftKey,
    );
}
function clearTimelineModifierCursor() {
    timelineModifierRoot.classList.remove(
        "is-timeline-zoom-modifier",
        "is-timeline-select-modifier",
    );
}
window.addEventListener("keydown", syncTimelineModifierCursor);
window.addEventListener("keyup", syncTimelineModifierCursor);
window.addEventListener("blur", clearTimelineModifierCursor);
document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimelineModifierCursor();
});

export function enabledSpotCount(spots) {
    return spots.filter(spotIsEnabled).length;
}

// Estimated activity minutes (sum of enabled spots' visitMinutes) and measured
// travel minutes (null when not every leg is cached) for one day. Only
// enabled spots count, matching every other day summary.
export function dayWorkload(day) {
    return calculateDayWorkload(day, cachedDayTravelMinutes(day));
}

// Spanish workload segment for the day-head <small> line, e.g.
// " · ~3 h de visitas · ~45 min de trayectos". Empty string (no leading
// separator) when neither part has data, so the line stays byte-identical to
// today's output.
export function dayLoadText(activity, travel) {
    const parts = [];
    if (activity > 0) parts.push(`${formatDurationMinutes(activity)} de visitas`);
    if (travel != null) parts.push(`${formatDurationMinutes(travel)} de trayectos`);
    return parts.length ? ` · ${parts.join(" · ")}` : "";
}

// Capacity-meter fill percentages for the two stacked segments (activity
// first, then travel), scaled down proportionally so their sum never exceeds
// 100% while preserving their relative proportion.
export function dayLoadPercents(activity, travel) {
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

export function renderDayTimeTools(day) {
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
    // The timeline's interactive mode is what emits the buttons that open the
    // duration and travel dialogs, so a read-only view renders the same picture
    // as plain, unclickable blocks — exactly like companion mode does.
    const timeline = createTimelineView(day, {
        interactive: !store.readOnly,
        travelForLeg: timelineTravelForLeg,
    });
    const timelineZoom = timelineZoomByDay.get(day.id) || TIMELINE_ZOOM_MIN;
    const zoomLabel = `${Number(timelineZoom.toFixed(2))}×`;
    const zoomControls = timeline.empty ? "" : `<label class="day-timeline-zoom"><span>Zoom</span><input type="range" min="${TIMELINE_ZOOM_MIN}" max="${TIMELINE_ZOOM_MAX}" step="${TIMELINE_ZOOM_STEP}" value="${timelineZoom}" data-timeline-zoom aria-label="Nivel de zoom del timeline"><output data-timeline-zoom-output aria-live="polite">${zoomLabel}</output></label>`;
    const baseId = `day-time-${esc(String(day.id))}`;
    return `<section class="day-time-tools" aria-label="Planificación horaria"><div class="day-time-tabs" role="group" aria-label="Vista horaria"><button id="${baseId}-schedule-tab" class="day-time-tab" type="button" data-day-time-tab="schedule" aria-expanded="${scheduleSelected}" aria-controls="${baseId}-schedule-panel" ${scheduled.length ? "" : "disabled"}><svg class="day-time-tab-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 1.9"/></svg><span>Horarios</span><span class="day-schedule-count">${scheduled.length}</span><svg class="day-time-tab-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><button id="${baseId}-timeline-tab" class="day-time-tab" type="button" data-day-time-tab="timeline" aria-expanded="${timelineSelected}" aria-controls="${baseId}-timeline-panel"><svg class="day-time-tab-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h7M9 12h11M6 16.5h8"/></svg><span>Timeline</span><svg class="day-time-tab-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></div><div id="${baseId}-schedule-panel" class="day-schedule-body" role="region" aria-label="Horarios del día" ${scheduleSelected ? "" : "hidden"}><span class="day-schedule-guide" aria-hidden="true"></span><div class="day-schedule-axis" aria-hidden="true"><span></span><span class="day-schedule-axis-hours"><i>00</i><i>06</i><i>12</i><i>18</i><i>24</i></span></div>${rows}</div><div id="${baseId}-timeline-panel" class="day-timeline-panel" role="region" aria-label="Timeline del día" ${timelineSelected ? "" : "hidden"}><div class="day-timeline-toolbar"><p class="day-timeline-summary">${esc(timeline.summary)}${store.readOnly ? "" : " Pulsa para editar, arrastra para planificar o usa Mayús + arrastre para seleccionar varias paradas."}</p>${zoomControls}</div><div class="companion-timeline-canvas" role="group" aria-label="${esc(timeline.aria)}">${timeline.html}</div>${timeline.empty ? "" : `<div class="companion-timeline-insight${timeline.warning ? " is-warning" : ""}" role="status">${esc(timeline.insight)}</div>`}</div></section>`;
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
    const rememberViewportCenter = () => {
        const centerMinute = timelineCenterForCanvas(canvas);
        if (centerMinute !== null)
            timelineViewportCentersByDay.set(String(dayId), centerMinute);
    };
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
        // Leave one device-independent pixel for fractional layout rounding:
        // clientWidth is floored while scrollWidth is rounded up, which would
        // otherwise expose a one-pixel scrollbar even when both visually fit.
        track.style.width = `calc(${zoom * 100}% - 1px)`;
        track.classList.toggle("shows-half-hour-grid", zoom >= TIMELINE_HALF_HOUR_ZOOM);
        updateTimelineTickLabels(track);
        canvas.scrollLeft = timelineRatio * track.scrollWidth - anchorX;
        rememberViewportCenter();
    };

    paint(timelineZoomByDay.get(dayId) || TIMELINE_ZOOM_MIN);
    // Day cards are wired before they are appended. Capture again once layout
    // exists so the very first drag also has a stable viewport to restore.
    requestAnimationFrame(() => {
        if (canvas.isConnected) rememberViewportCenter();
    });
    canvas.addEventListener("scroll", rememberViewportCenter, { passive: true });
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
    durationEditing = { dayId, spot };
    durationDialog.dataset.presenceTarget = `spot:${spot.id}`;
    $("#durationSpotName").textContent = spot.name || "Parada sin nombre";
    durationInput.value =
        Number.isInteger(spot.visitMinutes) && spot.visitMinutes > 0
            ? spot.visitMinutes
            : "";
    durationOpeningTime.value = timeToMinutes(spot.openingTime) === null
        ? ""
        : spot.openingTime;
    durationClosingTime.value = timeToMinutes(spot.closingTime) === null
        ? ""
        : spot.closingTime;
    durationScheduleNotApplicable.checked = spot.scheduleNotApplicable === true;
    durationIsWaypoint.checked = isWaypoint(spot);
    syncDurationKind();
    durationAutosave?.reset({
        kind: durationIsWaypoint.checked ? "waypoint" : "activity",
        visitMinutes: durationInput.value,
        openingTime: durationOpeningTime.value,
        closingTime: durationClosingTime.value,
        scheduleNotApplicable: durationScheduleNotApplicable.checked,
    });
    openModal(durationDialog);
    const focusTarget = durationIsWaypoint.checked
        ? durationIsWaypoint
        : durationInput;
    focusTarget.focus();
    focusTarget.select?.();
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

export function presentationForLeg(from, to) {
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

export async function openTravelTimeDialog(dayId, button, { returnFocus = null } = {}) {
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
    travelDialog.dataset.presenceTarget = `travel-leg:${travelLegKey(from.id, to.id)}`;
    travelReturnFocus = {
        element: returnFocus || (button instanceof Element ? button : document.activeElement),
        dayId,
        key: travelLegKey(from.id, to.id),
    };
    $("#travelTimeDialogTitle").textContent = configured ? "Editar trayecto" : "Configurar trayecto";
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
    travelAutosave?.reset({
        mode: travelMode.value,
        duration: travelInput.value,
        durationSource: durationSource(),
        departureTime: travelDepartureTime.value,
        fixedDeparture: travelFixedDeparture.checked,
        line: travelLine.value,
        note: travelNote.value,
        cost: travelCost.value,
        embedFrom: $("#travelEmbedFrom").checked,
        embedTo: $("#travelEmbedTo").checked,
    });
    openModal(travelDialog);
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
    const nextStarts = {};
    day.spots.forEach((spot) => {
        const minute = starts.get(String(spot.id));
        if (Number.isFinite(minute)) nextStarts[spot.id] = minutesToTime(minute);
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
    const order = day.spots.map((candidate) =>
        spotIsEnabled(candidate) ? ordered[enabledIndex++] : candidate,
    ).map((spot) => spot.id);
    void derivedPlanOperation((document) => {
        const source = document.days.find((candidate) => candidate.id === dayId);
        return commandIntent({
            target: { type: "day", id: dayId },
            command: "update-timeline",
            precondition: {
                expectedOrder: source.spots.map((spot) => spot.id),
                expectedStarts: Object.fromEntries(Object.keys(nextStarts).map((id) => [id, source.spots.find((spot) => spot.id === id)?.plannedStart ?? null])),
            },
            payload: { starts: nextStarts, order },
        });
    });
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
                pendingTimelineViewportCenters.delete(String(dayId));
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
        const viewportCenter = pointer.viewportCenter;
        const starts = new Map(pointer.members.map(({ id, minute }) => [id, minute + pointer.delta]));
        cleanup();
        pointer = null;
        if (dragged) {
            if (viewportCenter !== null)
                pendingTimelineViewportCenters.set(String(dayId), viewportCenter);
            commitTimelineStarts(dayId, starts);
        }
        pendingTimelineViewportCenters.delete(String(dayId));
    };

    const cancel = (event) => {
        if (!pointer || event.pointerId !== pointer.id) return;
        ignoreClick = pointer.dragging || ignoreClick;
        cleanup();
        pointer = null;
        repaint({ persist: false });
        pendingTimelineViewportCenters.delete(String(dayId));
    };

    const escape = (event) => {
        if (event.key !== "Escape" || !pointer) return;
        event.preventDefault();
        ignoreClick = true;
        cleanup();
        pointer = null;
        repaint({ persist: false });
        pendingTimelineViewportCenters.delete(String(dayId));
    };

    button.addEventListener("pointerdown", (event) => {
        if (store.previewMode || event.shiftKey || (event.button !== undefined && event.button !== 0)) return;
        // Focusing a partially visible timeline button may pan its scroll
        // container before the drag begins. Focus it explicitly without
        // scrolling so only the user's own pan changes the visible hours.
        if (event.pointerType !== "touch") {
            event.preventDefault();
            button.focus({ preventScroll: true });
        }
        const track = button.closest(".companion-timeline-track");
        if (!track) return;
        const rect = track.getBoundingClientRect();
        const start = Number(track.dataset.timelineBoundStart);
        const end = Number(track.dataset.timelineBoundEnd);
        const centerMinute = timelineViewportCentersByDay.get(String(dayId)) ??
            timelineCenterForCanvas(track.closest(".companion-timeline-canvas"));
        if (centerMinute !== null)
            pendingTimelineViewportCenters.set(String(dayId), centerMinute);
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
            viewportCenter: centerMinute,
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

export function wireDayTimeTools(el, dayId) {
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
            repaint({ persist: false });
            if (opening && panel === "timeline") {
                const day = dayBy(dayId);
                ensureTimelineTravelTimes(day).then(() => {
                    if (expandedDayTools.get(dayId) === "timeline")
                        repaint({ persist: false });
                });
            }
        });
    });
    tools?.querySelectorAll("[data-timeline-spot]").forEach((button) => {
        wireTimelineSpot(button, tools, dayId);
        wireItineraryMapSpotHighlight(button, button.dataset.timelineSpot);
    });
    wireTimelineSelection(tools?.querySelector(".companion-timeline-track"), dayId);
    tools?.querySelectorAll("[data-timeline-travel-from]").forEach((button) => {
        wireItineraryMapLegHighlight(
            button,
            button.dataset.timelineTravelFrom,
            button.dataset.timelineTravelTo,
        );
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

function syncDurationKind() {
    const waypoint = durationIsWaypoint.checked;
    durationDialog.classList.toggle("is-waypoint", waypoint);
    durationActivityFields.hidden = waypoint;
    durationActivityFields.querySelectorAll("input, button").forEach((control) => {
        control.disabled = waypoint;
    });
    removeDurationButton.hidden = waypoint || !durationInput.value;
}

durationIsWaypoint.addEventListener("change", syncDurationKind);
durationInput.addEventListener("input", syncDurationKind);
durationScheduleNotApplicable.addEventListener("change", () => {
    if (!durationScheduleNotApplicable.checked) return;
    durationOpeningTime.value = "";
    durationClosingTime.value = "";
});
[durationOpeningTime, durationClosingTime].forEach((input) => {
    input.addEventListener("input", () => {
        if (input.value) durationScheduleNotApplicable.checked = false;
    });
});

async function commitDurationEditor({ close = false } = {}) {
    if (!durationEditing) return { status: "skipped" };
    const waypoint = durationIsWaypoint.checked;
    if (!waypoint && !durationInput.reportValidity()) return { status: "invalid" };
    const minutesValue = durationInput.value.trim();
    const parsedMinutes = Number(minutesValue);
    const minutes = minutesValue !== "" &&
        Number.isInteger(parsedMinutes) && parsedMinutes > 0
        ? parsedMinutes
        : undefined;
    if (!waypoint && minutesValue !== "" && minutes === undefined) return { status: "invalid" };

    const spot = durationEditing.spot;
    const openingTime = durationOpeningTime.value || undefined;
    const closingTime = durationClosingTime.value || undefined;
    const scheduleNotApplicable = durationScheduleNotApplicable.checked;
    const changed = isWaypoint(spot) !== waypoint || (!waypoint && (
        spot.visitMinutes !== minutes ||
        spot.openingTime !== openingTime ||
        spot.closingTime !== closingTime ||
        (spot.scheduleNotApplicable === true) !== scheduleNotApplicable
    ));
    if (!changed) {
        if (close) durationDialog.close();
        return { status: "unchanged" };
    }

    const fields = { kind: waypoint ? "waypoint" : "activity" };
    const remove = [];
    if (!waypoint) {
        if (minutes === undefined) remove.push("visitMinutes"); else fields.visitMinutes = minutes;
        if (openingTime === undefined) remove.push("openingTime"); else fields.openingTime = openingTime;
        if (closingTime === undefined) remove.push("closingTime"); else fields.closingTime = closingTime;
        if (scheduleNotApplicable) fields.scheduleNotApplicable = true; else remove.push("scheduleNotApplicable");
    }
    await derivedPlanOperation((document) => updateFieldsIntent(
        document,
        { type: "spot", id: spot.id },
        fields,
        { remove },
    ));
    if (close) durationDialog.close();
    return { status: "saved" };
}

durationForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void commitDurationEditor({ close: true });
});

const durationAutosave = createDraftAutosaveController({
    root: durationForm,
    read: () => ({
        kind: durationIsWaypoint.checked ? "waypoint" : "activity",
        visitMinutes: durationInput.value,
        openingTime: durationOpeningTime.value,
        closingTime: durationClosingTime.value,
        scheduleNotApplicable: durationScheduleNotApplicable.checked,
    }),
    validate: (draft) => draft.kind === "activity" && draft.visitMinutes && (!Number.isInteger(Number(draft.visitMinutes)) || Number(draft.visitMinutes) <= 0)
        ? ["La duración debe ser un entero positivo."] : [],
    disabled: () => store.readOnly || !durationEditing,
    commit: () => commitDurationEditor(),
    onState: ({ state }) => {
        const status = durationDialog.querySelector(".form-status");
        if (!status) return;
        if (state === "dirty" || state === "saving") status.textContent = "Autoguardando…";
        else if (state === "saved") status.textContent = "Cambios autoguardados";
        else if (state === "invalid") status.textContent = "Corrige el valor; el borrador no se ha descartado";
    },
});

durationDialog.addEventListener("click", async (event) => {
    if (!event.target.closest(".cancel")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const result = await durationAutosave.flush("close");
    if (result.status !== "invalid") durationDialog.close();
}, true);

durationDialog.querySelectorAll("[data-duration-preset]").forEach((button) => {
    button.addEventListener("click", () => {
        durationInput.value = button.dataset.durationPreset;
        durationInput.focus();
    });
});

removeDurationButton.addEventListener("click", () => {
    durationInput.value = "";
    syncDurationKind();
    durationInput.focus();
});

durationDialog.addEventListener("close", () => {
    durationEditing = null;
});

async function commitTravelEditor({ close = false } = {}) {
    if (!travelEditing) return { status: "skipped" };
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
        return { status: "invalid" };
    }
    if (automatic && !customDuration && !travelEditing.route) {
        travelDurationError.textContent = "La estimación no está disponible; elige Personalizar.";
        travelFormStatus.textContent = "Elige una duración válida antes de guardar.";
        return { status: "invalid" };
    }
    if (travelFixedDeparture.checked && !travelDepartureTime.value) {
        travelDetails.open = true;
        travelDepartureError.textContent = "Añade una hora para marcar la salida como fija.";
        travelFormStatus.textContent = "Revisa la hora de salida.";
        travelDepartureTime.focus();
        return { status: "invalid" };
    }
    const key = travelLegKey(travelEditing.from.id, travelEditing.to.id);
    const parsedCost = Number(travelCost.value);
    const requestedEndpoints = [$("#travelEmbedFrom").checked ? ["from", travelEditing.from] : null, $("#travelEmbedTo").checked ? ["to", travelEditing.to] : null].filter(Boolean);
    const currentKey = travelLegKey(travelEditing.from.id, travelEditing.to.id);
    const invalidEndpoint = requestedEndpoints.find(([, spot]) => !endpointEligibility(spot, currentKey).eligible);
    if (invalidEndpoint) {
        travelAdvanced.open = true;
        travelFormStatus.textContent = `“${invalidEndpoint[1].name}” no puede agruparse en este trayecto.`;
        return { status: "invalid" };
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
    if (JSON.stringify(store.travelLegs[key]) === JSON.stringify(next)) {
        if (close) travelDialog.close();
        return { status: "unchanged" };
    }
    await derivedPlanOperation((document) => {
        const existing = document.travelLegs[key];
        if (!existing) return insertEntityIntent({ type: "travel-leg", id: key }, next);
        const fields = { ...next };
        const remove = Object.keys(existing).filter((field) => !(field in next));
        return updateFieldsIntent(document, { type: "travel-leg", id: key }, fields, { remove });
    });
    if (close) travelDialog.close();
    travelFormStatus.textContent = "Cambios autoguardados";
    return { status: "saved" };
}

travelForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void commitTravelEditor({ close: true });
});

const travelAutosave = createDraftAutosaveController({
    root: travelForm,
    read: () => ({
        mode: travelMode.value,
        duration: travelInput.value,
        durationSource: durationSource(),
        departureTime: travelDepartureTime.value,
        fixedDeparture: travelFixedDeparture.checked,
        line: travelLine.value,
        note: travelNote.value,
        cost: travelCost.value,
        embedFrom: $("#travelEmbedFrom").checked,
        embedTo: $("#travelEmbedTo").checked,
    }),
    validate: () => [],
    disabled: () => store.readOnly || !travelEditing,
    debounceMs: 450,
    commit: () => commitTravelEditor(),
    onState: ({ state }) => {
        if (state === "dirty" || state === "saving") travelFormStatus.textContent = "Autoguardando…";
        else if (state === "invalid") travelFormStatus.textContent = "Revisa los campos; el borrador sigue abierto";
    },
});

travelDialog.addEventListener("click", async (event) => {
    if (!event.target.closest(".cancel")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const result = await travelAutosave.flush("close");
    if (result.status !== "invalid") travelDialog.close();
}, true);

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
    const key = travelLegKey(from.id, to.id);
    travelDialog.close();
    void derivedPlanOperation((document) => commandIntent({
        target: { type: "travel-leg", id: key },
        command: "delete-travel-card",
        precondition: { expectedFingerprint: targetFingerprint(document, { type: "travel-leg", id: key }) },
    })).then(() => toast("Configuración del trayecto eliminada.", "info"));
}

deleteTravelLegButton.addEventListener("click", removeTravelConfiguration);

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

export function wireHoursComparison(list) {
    list.querySelectorAll(
        ".spot:not(.spot-disabled) .spot-hours.is-complete",
    ).forEach((row) => {
        row.addEventListener("mouseenter", () => activateHoursComparison(list, row));
        row.addEventListener("mouseleave", () => clearHoursComparison(list));
        row.addEventListener("focus", () => activateHoursComparison(list, row));
        row.addEventListener("blur", () => clearHoursComparison(list));
    });
}


export function beginTimelineRender() {
    const viewports = captureTimelineViewports();
    const token = ++timelineViewportRestoreToken;
    timelineTickResizeObserver?.disconnect();
    timelineTooltip.hidden = true;
    return { viewports, token };
}

export function restoreTimelineRender({ viewports, token }) {
    if (token !== timelineViewportRestoreToken) return false;
    restoreTimelineViewports(viewports);
    return true;
}

