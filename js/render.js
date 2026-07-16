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
    routeTimeOverrideKey,
} from "./store.js";
import { $, esc, safeColor, fmt, daysEl, id } from "./dom.js";
import { toast, confirmAction } from "./notify.js?v=3";
import {
    drawMap,
    mapsLinkFor,
    cachedDayTravelMinutes,
    cachedRouteTravelMinutes,
    ensureRouteTravelTimes,
    highlightMapSpot,
} from "./map.js";
import { openDialog } from "./dialogs.js";
import { foreignAmount, localAmount } from "./currency.js";
import { DAY_LOAD_WARNING_MINUTES } from "./constants.js";
import { buildTimelineProjection, createTimelineView } from "./timeline.js";

// View-only state: keep the selected time panel open across destructive renders
// without adding presentation preferences to the persisted trip data.
const expandedDayTools = new Map();

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
const travelApiValue = $("#travelApiValue");
const resetTravelTimeButton = $("#resetTravelTime");
let travelEditing = null;

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
    const activity = day.spots
        .filter(spotIsEnabled)
        .reduce(
            (total, spot) =>
                total +
                (Number.isInteger(spot.visitMinutes) && spot.visitMinutes > 0
                    ? spot.visitMinutes
                    : 0),
            0,
        );
    return { activity, travel: cachedDayTravelMinutes(day) };
}

// Spanish workload segment for the day-head <small> line, e.g.
// " · ~3 h de actividad · ~45 min de trayectos". Empty string (no leading
// separator) when neither part has data, so the line stays byte-identical to
// today's output.
function dayLoadText(activity, travel) {
    const parts = [];
    if (activity > 0) parts.push(`${formatDurationMinutes(activity)} de actividad`);
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

export function timeToMinutes(value) {
    if (
        typeof value !== "string" ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
    )
        return null;
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
}

function minutesToTime(value) {
    const minutes = Math.max(0, Math.min(1439, Math.round(value)));
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
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

function timelineTravelForLeg(from, to, profile) {
    const officialMinutes = cachedRouteTravelMinutes(from, to, profile);
    const override = routeTimeOverride(from.id, to.id, profile);
    if (override === null && officialMinutes === null) return null;
    return {
        minutes: override ?? officialMinutes,
        officialMinutes,
        overridden: override !== null,
    };
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
    let selected = expandedDayTools.get(day.id) || "";
    if (selected === "schedule" && !scheduled.length) selected = "";
    const scheduleSelected = selected === "schedule";
    const timelineSelected = selected === "timeline";
    const timeline = createTimelineView(day, {
        interactive: true,
        travelForLeg: timelineTravelForLeg,
    });
    const baseId = `day-time-${esc(String(day.id))}`;
    return `<section class="day-time-tools" aria-label="Planificación horaria"><div class="day-time-tabs" role="group" aria-label="Vista horaria"><button id="${baseId}-schedule-tab" class="day-time-tab" type="button" data-day-time-tab="schedule" aria-expanded="${scheduleSelected}" aria-controls="${baseId}-schedule-panel" ${scheduled.length ? "" : "disabled"}><span class="day-schedule-summary-icon" aria-hidden="true">◷</span><span>Horarios</span><span class="day-schedule-count">${scheduled.length}</span><span class="day-schedule-chevron" aria-hidden="true">⌄</span></button><button id="${baseId}-timeline-tab" class="day-time-tab" type="button" data-day-time-tab="timeline" aria-expanded="${timelineSelected}" aria-controls="${baseId}-timeline-panel"><span aria-hidden="true">↝</span><span>Timeline</span><span class="day-schedule-chevron" aria-hidden="true">⌄</span></button></div><div id="${baseId}-schedule-panel" class="day-schedule-body" role="region" aria-label="Horarios del día" ${scheduleSelected ? "" : "hidden"}><span class="day-schedule-guide" aria-hidden="true"></span><div class="day-schedule-axis" aria-hidden="true"><span></span><span class="day-schedule-axis-hours"><i>00</i><i>06</i><i>12</i><i>18</i><i>24</i></span></div>${rows}</div><div id="${baseId}-timeline-panel" class="day-timeline-panel" role="region" aria-label="Timeline del día" ${timelineSelected ? "" : "hidden"}><p class="day-timeline-summary">${esc(timeline.summary)} Pulsa para editar o arrastra una parada para planificarla.</p><div class="companion-timeline-canvas" role="group" aria-label="${esc(timeline.aria)}">${timeline.html}</div>${timeline.empty ? "" : `<div class="companion-timeline-insight${timeline.warning ? " is-warning" : ""}" role="status">${esc(timeline.insight)}</div>`}</div></section>`;
}

function openDurationDialog(dayId, spotId) {
    const day = dayBy(dayId);
    const spot = day?.spots.find((candidate) => String(candidate.id) === spotId);
    if (!spot) return;
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
    const above = targetRect.top - tooltipRect.height - 9;
    const top =
        above >= margin ? above : Math.min(window.innerHeight - tooltipRect.height - margin, targetRect.bottom + 9);
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

function paintTravelDialogValues() {
    if (!travelEditing) return;
    const official = cachedRouteTravelMinutes(
        travelEditing.from,
        travelEditing.to,
        "walking",
    );
    const override = routeTimeOverride(
        travelEditing.from.id,
        travelEditing.to.id,
        "walking",
    );
    travelEditing.officialMinutes = official;
    travelApiValue.textContent =
        official === null ? "No disponible" : `${official} min`;
    travelApiValue.closest(".travel-api-card").dataset.state =
        official === null ? "unavailable" : "ready";
    resetTravelTimeButton.disabled = override === null;
    if (override !== null) travelInput.value = override;
    else if (official !== null) travelInput.value = official;
}

async function openTravelTimeDialog(dayId, button) {
    const day = dayBy(dayId);
    const from = day?.spots.find(
        (spot) => String(spot.id) === button.dataset.timelineTravelFrom,
    );
    const to = day?.spots.find(
        (spot) => String(spot.id) === button.dataset.timelineTravelTo,
    );
    if (!day || !from || !to) return;
    travelEditing = { dayId, from, to, officialMinutes: null };
    $("#travelFromName").textContent = from.name || "Parada anterior";
    $("#travelToName").textContent = to.name || "Parada siguiente";
    const shownMinutes = Number(button.dataset.timelineTravelMinutes);
    travelInput.value =
        routeTimeOverride(from.id, to.id, "walking") ??
        (Number.isFinite(shownMinutes) && shownMinutes > 0 ? shownMinutes : "");
    travelApiValue.textContent = "Consultando…";
    travelApiValue.closest(".travel-api-card").dataset.state = "loading";
    resetTravelTimeButton.disabled =
        routeTimeOverride(from.id, to.id, "walking") === null;
    travelDialog.showModal();
    travelInput.focus();
    travelInput.select();
    await ensureRouteTravelTimes(day.spots, "walking");
    if (!travelEditing || travelEditing.from !== from || travelEditing.to !== to)
        return;
    paintTravelDialogValues();
}

function commitTimelineStart(dayId, spotId, minute) {
    const day = dayBy(dayId);
    const spot = day?.spots.find((candidate) => String(candidate.id) === spotId);
    if (!day || !spot) return;
    const currentStarts = new Map(
        buildTimelineProjection(day, {
            travelForLeg: timelineTravelForLeg,
        }).items.map((item) => [item.spot.id, item.start]),
    );
    spot.plannedStart = minutesToTime(minute);

    // The chronological timeline is the source of truth for enabled stops.
    // Replace only enabled slots so disabled stops keep their relative place.
    const ordered = day.spots
        .filter(spotIsEnabled)
        .map((candidate, index) => ({
            spot: candidate,
            start: candidate === spot ? minute : currentStarts.get(candidate.id) ?? 1440,
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
    if (!duration) return;
    blocks.forEach((other) => {
        if (other === active) return;
        const otherStart = Number(other.dataset.timelineStart);
        const otherEnd = otherStart + Number(other.dataset.timelineDuration);
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

function wireTimelineSpot(button, tools, dayId) {
    let pointer = null;
    let ignoreClick = false;

    const cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", escape);
        tools.classList.remove("is-timeline-dragging");
        button.classList.remove("is-dragging");
        paintTimelineDragHours(tools, button, false);
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
            paintTimelineDragHours(tools, button, true);
            document.body.style.userSelect = "none";
            document.body.style.webkitUserSelect = "none";
            getSelection()?.removeAllRanges();
        }
        event.preventDefault();
        const minutesDelta = (dx / pointer.trackWidth) * pointer.span;
        const duration = Number(button.dataset.timelineDuration) || 0;
        const latest = Math.min(1439, pointer.end - Math.min(duration, pointer.span));
        const minute = Math.max(
            pointer.start,
            Math.min(latest, Math.round((pointer.minute + minutesDelta) / 5) * 5),
        );
        pointer.current = minute;
        const left = ((minute - pointer.start) / pointer.span) * 100;
        button.style.setProperty("--timeline-start", `${left.toFixed(3)}%`);
        button.dataset.timelineStart = String(minute);
        const timing = button.querySelector("[data-timeline-timing]");
        if (timing)
            timing.textContent = duration
                ? `${minutesToTime(minute)}–${minutesToTime(minute + duration)}`
                : `${minutesToTime(minute)} · sin duración`;
        paintLiveTimelineConflicts(tools, button);
    };

    const finish = (event) => {
        if (!pointer || event.pointerId !== pointer.id) return;
        const dragged = pointer.dragging;
        const minute = pointer.current;
        cleanup();
        pointer = null;
        if (dragged) commitTimelineStart(dayId, button.dataset.timelineSpot, minute);
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
        if (store.previewMode || (event.button !== undefined && event.button !== 0)) return;
        const track = button.closest(".companion-timeline-track");
        if (!track) return;
        const rect = track.getBoundingClientRect();
        const start = Number(track.dataset.timelineBoundStart);
        const end = Number(track.dataset.timelineBoundEnd);
        pointer = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            minute: Number(button.dataset.timelineStart),
            current: Number(button.dataset.timelineStart),
            start,
            end,
            span: end - start,
            trackWidth: rect.width,
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
    tools?.querySelectorAll("[data-day-time-tab]").forEach((button) => {
        button.addEventListener("click", () => {
            const panel = button.dataset.dayTimeTab;
            const opening = expandedDayTools.get(dayId) !== panel;
            if (!opening) expandedDayTools.delete(dayId);
            else expandedDayTools.set(dayId, panel);
            render({ persist: false });
            if (opening && panel === "timeline") {
                const day = dayBy(dayId);
                ensureRouteTravelTimes(day?.spots, "walking").then(() => {
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
    if (!durationEditing) return;
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
    if (!travelEditing || !travelInput.reportValidity()) return;
    const minutes = Number(travelInput.value);
    if (!Number.isInteger(minutes) || minutes <= 0) return;
    const key = routeTimeOverrideKey(
        travelEditing.from.id,
        travelEditing.to.id,
        "walking",
    );
    if (minutes === travelEditing.officialMinutes)
        delete store.routeTimeOverrides[key];
    else store.routeTimeOverrides[key] = minutes;
    travelDialog.close();
    save();
    render();
    drawMap();
    toast("Tiempo de trayecto actualizado.", "success");
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
    delete store.routeTimeOverrides[
        routeTimeOverrideKey(
            travelEditing.from.id,
            travelEditing.to.id,
            "walking",
        )
    ];
    travelDialog.close();
    save();
    render();
    drawMap();
    toast("Restablecido el tiempo oficial de la API.", "info");
});

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
    travelEditing = null;
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
        const visitMinutes =
            Number.isInteger(s.visitMinutes) && s.visitMinutes > 0
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
        const spotHours = renderSpotHours(s, cat.color, enabled);
        const spotTiming =
            spotHours || spotDuration
                ? `<span class="spot-timing">${spotHours}${spotDuration}</span>`
                : "";
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
        spot.innerHTML = `<span class="handle">⠿</span><label class="spot-toggle" title="${enabled ? "Desactivar parada" : "Activar parada"}"><input type="checkbox" data-act="toggle-enabled" ${enabled ? "checked" : ""} aria-label="${enabled ? "Desactivar" : "Activar"} ${esc(s.name || "parada")}"></label><span class="spot-content"><span class="spot-name">${number} ${esc(s.name)}</span>${spotNote}${spotTiming}<span class="spot-tags"><span class="category-badge" style="--category-color:${safeColor(cat.color)}">${esc(cat.label)}</span>${s.tags?.length ? s.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join("") : ""}</span></span>${spotCost}<span class="spot-actions">${mapsAction}<span class="move-control"><button class="move-button" data-act="move" title="Mover a otro día" aria-label="Mover a otro día" aria-haspopup="menu" aria-expanded="false"><span aria-hidden="true">↪</span></button></span><button data-act="duplicate" title="Duplicar">⧉</button><button data-act="edit" title="Editar">✎</button><button data-act="delete" title="Borrar">×</button></span>`;
        wireMapSpotHighlight(spot, s.id);
        list.append(spot);
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
        detail.innerHTML = `<span><i class="is-activity"></i>Actividad <strong>${esc(activityText)}</strong></span><span><i class="is-travel"></i>Trayectos <strong>${esc(travelText)}</strong></span><span class="day-load-total">Total <strong>${esc(totalText)}</strong></span>`;
        meter.setAttribute(
            "aria-label",
            `Carga del día. Actividad: ${activityText}. Trayectos: ${travelText}. Total: ${totalText}.`,
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

function quickAddMarkup(dayId, buttonLabel) {
    if (quickAddOpenFor !== dayId)
        return `<button class="add-place">${buttonLabel}</button>`;
    return `<div class="quick-add"><input class="quick-add-input" type="text" aria-label="Nombre de la nueva parada" placeholder="Nombre de la parada…" autocomplete="off"><button class="quick-add-details" type="button">Detalles…</button></div>`;
}

function closeQuickAdd() {
    quickAddOpenFor = null;
    quickAddDraft = "";
    render({ persist: false });
}

function wireQuickAdd(card, dayId) {
    const addButton = card.querySelector(".add-place");
    if (addButton) {
        addButton.addEventListener("click", () => {
            quickAddOpenFor = dayId;
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
            target.push({ id: id(), name, address: "", note: "", tags: [] });
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
            if (quickAddOpenFor !== dayId || input.value.trim()) return;
            if (editor.contains(document.activeElement)) return;
            closeQuickAdd();
        }, 0);
    });
    detailsButton.addEventListener("click", () => {
        const name = input.value;
        quickAddOpenFor = null;
        quickAddDraft = "";
        render({ persist: false });
        openDialog(dayId, undefined, { name });
    });

    requestAnimationFrame(() => {
        if (!input.isConnected || quickAddOpenFor !== dayId) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    });
}

export function render({ persist = true } = {}) {
    timelineTooltip.hidden = true;
    renderTags();
    daysEl.innerHTML = "";
    const b = document.createElement("article");
    b.className =
        "day backlog " +
        (store.active === "backlog" ? "active " : "") +
        (store.backlogCollapsed ? "collapsed" : "");
    b.dataset.day = "backlog";
    const activeBacklogCount = enabledSpotCount(store.backlog);
    b.innerHTML = `<div class="day-head"><div class="date-box"><span>ideas</span><strong>+</strong></div><div class="day-title"><div class="title-line"><span class="day-name">Backlog de paradas</span></div><small>${activeBacklogCount} sin asignar · ${esc(formatCost(sumCosts(store.backlog)))} · arrástralas a un día cuando decidáis</small></div><button class="day-collapse" title="${store.backlogCollapsed ? "Restaurar backlog" : "Minimizar backlog"}" aria-label="Minimizar o restaurar backlog">${store.backlogCollapsed ? "▸" : "▾"}</button></div><div class="spots"></div>${quickAddMarkup("backlog", "＋ Añadir al backlog")}`;
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
    wireQuickAdd(b, "backlog");
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
        el.innerHTML = `<div class="day-head"><button class="day-handle" type="button" title="Reordenar día" aria-label="Reordenar día">⠿</button><div class="date-box editable" title="Cambiar fecha"><span>${f.month}</span><strong>${f.day}</strong><input type="date" value="${day.date}" tabindex="-1" aria-label="Fecha del día"></div><div class="day-title"><div class="title-line"><span class="day-name" title="Pulsa para ver la ruta · doble clic para renombrar">${esc(day.title)}</span><button class="title-edit" title="Renombrar día" aria-label="Renombrar día">✎</button></div><small>${activeSpotCount} ${activeSpotCount === 1 ? "parada activa" : "paradas activas"} · ${esc(formatCost(sumCosts(day.spots)))}<span class="day-load" data-day-load></span><span class="day-load-badge" hidden>día muy cargado</span> · pulsa para ver ruta</small><button class="day-load-meter" type="button" hidden aria-expanded="false"><span class="day-load-track" aria-hidden="true"><span class="day-load-fill is-activity"></span><span class="day-load-fill is-travel"></span></span><span class="day-load-detail" aria-hidden="true"></span></button></div><button class="day-collapse" title="${day.collapsed ? "Restaurar día" : "Minimizar día"}" aria-label="Minimizar o restaurar día">${day.collapsed ? "▸" : "▾"}</button><button class="day-duplicate" title="Duplicar día">⧉</button><button class="day-options" title="Eliminar día">×</button></div>${renderDayTimeTools(day)}<div class="spots"></div>${quickAddMarkup(day.id, "＋ Añadir una parada")}`;
        renderList(el, day.spots);
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
        wireQuickAdd(el, day.id);
        daysEl.append(el);
    });
    const tripTotal =
        sumCosts(store.backlog) +
        store.state.reduce((total, day) => total + sumCosts(day.spots), 0);
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
    let fromDay = null;
    const bi = store.backlog.findIndex((s) => s.id === spotId);
    if (bi > -1) {
        spot = store.backlog.splice(bi, 1)[0];
        fromDay = "backlog";
    }
    store.state.forEach((d) => {
        const i = d.spots.findIndex((s) => s.id === spotId);
        if (i > -1) {
            spot = d.spots.splice(i, 1)[0];
            fromDay = d.id;
        }
    });
    if (!spot) return;
    if (fromDay !== toDay) delete spot.plannedStart;
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
