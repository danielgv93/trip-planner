// Shared day timeline used by the planner cards and the on-trip companion.
// It derives a route forecast from persisted stop data without mutating it.

import { esc, safeColor } from "../../shared/dom.js";
import { categoryMeta, spotIsEnabled } from "../../core/store.js?v=25";
import { distanceMeters } from "../../core/geo.js";
import { timeToMinutes, minutesToTime } from "../../core/time.js";

function stringValue(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
}

function localDateKey(now = new Date()) {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function localMinutes(now = new Date()) {
    return now.getHours() * 60 + now.getMinutes();
}

function isAllDaySchedule(opening, closing) {
    return opening === 0 && closing === 0;
}

function clockLabel(minutes) {
    return minutesToTime(minutes, { wrap: true });
}

function invalidScheduleRanges(start, end, opening, closing) {
    if (!(end > start)) return [];
    if (isAllDaySchedule(opening, closing)) return [];
    // Overnight/equal windows need a date-aware model before they can be
    // compared safely. Preserve the previous permissive behaviour for them.
    if (opening !== null && closing !== null && opening >= closing) return [];
    const ranges = [];
    if (opening !== null && start < opening)
        ranges.push([start, Math.min(end, opening)]);
    if (closing !== null && end > closing)
        ranges.push([Math.max(start, closing), end]);
    return ranges.filter(([from, to]) => to > from);
}

function assignOverlapMetadata(items) {
    const laneEnds = [];
    [...items].sort((a, b) => a.start - b.start || a.end - b.end).forEach((item) => {
        item.overlaps = [];
        let lane = laneEnds.findIndex((end) => end <= item.start);
        if (lane === -1) lane = laneEnds.length;
        item.lane = lane;
        laneEnds[lane] = Math.max(laneEnds[lane] ?? 0, item.end, item.start + 30);
    });
    items.forEach((item, index) => {
        items.slice(index + 1).forEach((other) => {
            const start = Math.max(item.start, other.start);
            const end = Math.min(item.end, other.end);
            if (start >= end) return;
            item.overlaps.push([start, end]);
            other.overlaps.push([start, end]);
        });
    });
    return Math.max(1, laneEnds.length);
}

function validVisitedAt(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function estimatedTravelMinutes(from, to, profile = "walking") {
    const meters = distanceMeters(from, to);
    if (!Number.isFinite(meters)) return 0;
    const metersPerMinute = profile === "walking" ? 75 : profile === "cycling" ? 250 : 500;
    return Math.max(1, Math.round((meters * 1.25) / metersPerMinute));
}

export function buildTimelineProjection(
    day,
    {
        now = new Date(),
        delayMinutes = 0,
        profile = "walking",
        travelForLeg = null,
    } = {},
) {
    const spots = Array.isArray(day?.spots) ? day.spots.filter(spotIsEnabled) : [];
    const isToday = day?.date === localDateKey(now);
    const openings = spots
        .filter((spot) => !isAllDaySchedule(
            timeToMinutes(spot.openingTime),
            timeToMinutes(spot.closingTime),
        ))
        .map((spot) => timeToMinutes(spot.openingTime))
        .filter(Number.isFinite);
    let cursor = (isToday ? localMinutes(now) : openings.length ? Math.min(...openings) : 540) + delayMinutes;
    let previous = null;

    const items = spots.map((spot) => {
        const duration = Number.isInteger(spot.visitMinutes) && spot.visitMinutes > 0 ? spot.visitMinutes : 0;
        const opening = timeToMinutes(spot.openingTime);
        const storedClosing = timeToMinutes(spot.closingTime);
        const allDay = isAllDaySchedule(opening, storedClosing);
        const closing = allDay ? 1440 : storedClosing;
        const plannedStart = timeToMinutes(spot.plannedStart);
        const visited = validVisitedAt(spot.visitedAt);
        const resolvedTravel = previous
            ? travelForLeg?.(previous, spot, profile) || null
            : null;
        let travel = previous
            ? resolvedTravel?.minutes ??
              estimatedTravelMinutes(
                  previous,
                  spot,
                  resolvedTravel?.profile || profile,
              )
            : 0;
        let travelStart = cursor;
        let travelEnd = cursor;
        let start;
        let actual = false;

        if (visited && isToday) {
            const visitedDate = new Date(spot.visitedAt);
            if (localDateKey(visitedDate) === day.date) {
                const completedAt = localMinutes(visitedDate);
                start = Math.max(0, completedAt - duration);
                cursor = Math.max(cursor, completedAt);
                travel = 0;
                actual = true;
            }
        }
        if (!actual && plannedStart !== null) {
            travelStart = cursor;
            travelEnd = cursor + travel;
            start = plannedStart;
            cursor = Math.max(cursor, start + duration);
        } else if (!actual) {
            travelStart = cursor;
            cursor += travel;
            travelEnd = cursor;
            start = opening !== null && opening < (closing ?? 1440) ? Math.max(cursor, opening) : cursor;
            cursor = start + duration;
        }

        const end = start + duration;
        const outsideRanges = invalidScheduleRanges(start, end, opening, closing);
        const outside = outsideRanges.length > 0 ||
            (!duration && ((opening !== null && start < opening) || (closing !== null && start >= closing)));
        const item = {
            spot,
            start,
            end,
            duration,
            opening,
            closing,
            allDay,
            plannedStart,
            travel,
            travelOfficial: resolvedTravel?.officialMinutes ?? null,
            travelOverridden: resolvedTravel?.overridden === true,
            travelProfile: resolvedTravel?.profile || profile,
            travelApproximate:
                previous !== null &&
                !Number.isFinite(resolvedTravel?.minutes),
            travelStart,
            travelEnd,
            fromSpot: previous,
            visited,
            actual,
            outside,
            outsideRanges,
            margin: closing === null ? null : closing - end,
        };
        previous = spot;
        return item;
    });

    const lanes = assignOverlapMetadata(items);
    return { items, lanes, isToday, current: localMinutes(now), delayMinutes };
}

function timelineBounds(projection, interactive = false) {
    const values = projection.items.flatMap((item) => [item.start, item.end]).filter(Number.isFinite);
    if (projection.isToday) values.push(projection.current);
    if (!values.length) return { start: 540, end: 600 };
    let start = Math.max(0, Math.floor((Math.min(...values) - 30) / 15) * 15);
    let end = Math.max(start + 60, Math.ceil((Math.max(...values) + 30) / 15) * 15);
    if (interactive) {
        start = Math.min(start, 360);
        end = Math.max(end, 1440);
    }
    return { start, end };
}

export function createTimelineView(
    day,
    {
        now = new Date(),
        delayMinutes = 0,
        nextSpot = null,
        interactive = false,
        travelForLeg = null,
    } = {},
) {
    const projection = buildTimelineProjection(day, {
        now,
        delayMinutes,
        travelForLeg,
    });
    if (!projection.items.length) {
        return {
            empty: true,
            html: '<div class="companion-timeline-empty">El timeline aparecerá cuando el día tenga paradas activas.</div>',
            summary: "Añade paradas activas para crear la previsión.",
            insight: "",
            warning: false,
            aria: "No hay paradas activas para crear la previsión.",
        };
    }

    const { start, end } = timelineBounds(projection, interactive);
    const span = end - start;
    const percent = (value) => `${Math.max(0, Math.min(100, ((value - start) / span) * 100)).toFixed(3)}%`;
    const ticks = [];
    for (let minute = Math.ceil(start / 60) * 60; minute <= end; minute += 60)
        ticks.push(`<span class="companion-timeline-tick" style="left:${percent(minute)}">${clockLabel(minute)}</span>`);

    const transfers = projection.items.filter((item) => item.travel > 0 && item.fromSpot).map((item) => {
        const from = stringValue(item.fromSpot.name, "la parada anterior") || "la parada anterior";
        const to = stringValue(item.spot.name, "la siguiente parada") || "la siguiente parada";
        const modeLabel = item.travelProfile === "driving" ? "en coche" : "andando";
        const source = item.travelOverridden
            ? "ajustado"
            : item.travelOfficial !== null
              ? `API · ${modeLabel}`
              : "estimado";
        const aria = `Trayecto ${modeLabel} de ${from} a ${to}: ${item.travel} min, ${source}`;
        const tag = interactive ? "button" : "div";
        const travelConflict = item.travelEnd > item.start;
        const classes = `companion-timeline-transfer${interactive ? " is-editable" : ""}${item.travelOverridden ? " is-overridden" : ""}${travelConflict ? " is-conflict" : ""}`;
        const interactionAttrs = interactive
            ? ` type="button" data-timeline-travel-from="${esc(String(item.fromSpot.id))}" data-timeline-travel-to="${esc(String(item.spot.id))}" data-timeline-travel-profile="${esc(item.travelProfile)}" data-timeline-travel-minutes="${item.travel}" data-timeline-start="${item.travelStart}" data-timeline-tooltip="${esc(aria)}" aria-haspopup="dialog"`
            : "";
        const titleAttr = interactive ? "" : ` title="${esc(aria)}"`;
        return `<${tag} class="${classes}"${interactionAttrs} style="--timeline-start:${percent(item.travelStart)};--timeline-width:${((item.travel / span) * 100).toFixed(3)}%"${titleAttr} aria-label="${esc(aria)}"><span aria-hidden="true">↝</span><strong>${item.travel} min</strong><small>${source}</small></${tag}>`;
    });

    const resolvedNext = nextSpot || projection.items.find((item) => !item.visited)?.spot || null;
    const blocks = projection.items.map((item, index) => {
        const nextItem = projection.items[index + 1];
        const outgoingTravel = nextItem?.fromSpot === item.spot ? nextItem.travel : 0;
        const color = safeColor(categoryMeta(item.spot.category).color, "#6b6b6b");
        const widthMinutes = Math.max(item.duration, interactive ? 30 : 6);
        const hasOverlap = item.overlaps.length > 0;
        const classes = ["companion-timeline-block", interactive ? "is-editable" : "", item.spot === resolvedNext ? "is-next" : "", item.outside ? "is-outside-hours" : "", hasOverlap ? "is-overlapping" : "", item.plannedStart !== null ? "is-planned" : "", item.duration ? "" : "is-unsized", item.visited ? "is-visited" : ""].filter(Boolean).join(" ");
        const rawName = stringValue(item.spot.name, "Parada sin nombre") || "Parada sin nombre";
        const name = esc(rawName);
        const timing = item.duration ? `${clockLabel(item.start)}–${clockLabel(item.end)}` : `${clockLabel(item.start)} · sin duración`;
        const hours = item.allDay
            ? "Todo el día"
            : item.opening !== null && item.closing !== null
            ? `${clockLabel(item.opening)}–${clockLabel(item.closing)}`
            : item.opening !== null ? `Desde ${clockLabel(item.opening)}` : item.closing !== null ? `Hasta ${clockLabel(item.closing)}` : "";
        const outsideCopy = item.outside ? " · parcialmente fuera del horario" : "";
        const rangeMarkup = (ranges, className) => ranges.map(([rangeStart, rangeEnd]) => {
            const left = item.duration ? ((rangeStart - item.start) / item.duration) * 100 : 0;
            const width = item.duration ? ((rangeEnd - rangeStart) / item.duration) * 100 : 100;
            return `<span class="${className}" style="--conflict-start:${Math.max(0, left).toFixed(3)}%;--conflict-width:${Math.min(100, width).toFixed(3)}%" aria-hidden="true"></span>`;
        }).join("");
        const outside = rangeMarkup(item.outsideRanges, "companion-timeline-outside");
        const overlaps = rangeMarkup(item.overlaps, "companion-timeline-overlap");
        const aria = `${rawName}: visita prevista ${timing}${hours ? `; horario ${hours}` : ""}${outsideCopy}${hasOverlap ? "; se solapa con otra parada" : ""}`;
        const tag = interactive ? "button" : "div";
        const interactionAttrs = interactive
            ? ` type="button" data-timeline-spot="${esc(String(item.spot.id))}" data-timeline-start="${item.start}" data-timeline-duration="${item.duration}" data-timeline-outgoing-travel="${outgoingTravel}" data-timeline-opening="${item.opening ?? ""}" data-timeline-closing="${item.closing ?? ""}" data-timeline-tooltip="${name}" aria-haspopup="dialog"`
            : "";
        const titleAttr = interactive ? "" : ` title="${esc(aria)}"`;
        return `<${tag} class="${classes}"${interactionAttrs} style="--timeline-start:${percent(item.start)};--timeline-width:${((widthMinutes / span) * 100).toFixed(3)}%;--timeline-color:${color};--timeline-lane:${item.lane}"${titleAttr} aria-label="${esc(aria)}">${outside}${overlaps}<span class="companion-timeline-content"><strong>${name}</strong><small data-timeline-timing>${esc(timing)}</small>${hours ? `<small class="companion-timeline-hours"><span aria-hidden="true">◷</span> ${esc(hours)}</small>` : ""}</span></${tag}>`;
    });
    const nowMarker = projection.isToday && projection.current >= start && projection.current <= end
        ? `<span class="companion-now" style="--timeline-now:${percent(projection.current)}"><span>ahora</span></span>`
        : "";
    const dragHours = interactive
        ? '<span class="companion-timeline-drag-hours" aria-hidden="true"></span><span class="companion-timeline-drag-hours" aria-hidden="true"></span>'
        : "";
    const dragStartGuide = interactive
        ? '<span class="companion-timeline-position-guide is-start" aria-hidden="true"></span><span class="companion-timeline-position-guide is-end" aria-hidden="true"></span><span class="companion-timeline-position-guide is-travel-end" aria-hidden="true"></span><span class="companion-timeline-selection-box" aria-hidden="true"></span>'
        : "";
    const html = `<div class="companion-timeline-track${interactive ? " is-interactive" : ""}" data-timeline-bound-start="${start}" data-timeline-bound-end="${end}" style="--timeline-lanes:${projection.lanes}"><div class="companion-timeline-axis">${ticks.join("")}</div>${dragHours}${dragStartGuide}${transfers.join("")}${blocks.join("")}${nowMarker}</div>`;

    const outsideItems = projection.items.filter((item) => item.outside && !item.visited);
    const missingDuration = projection.items.filter((item) => !item.duration).length;
    const approximateTravel = projection.items.some(
        (item) => item.travel > 0 && item.travelApproximate,
    );
    const travelProfiles = new Set(
        projection.items
            .filter((item) => item.travel > 0 && item.fromSpot)
            .map((item) => item.travelProfile),
    );
    const modeCopy = travelProfiles.size > 1
        ? "a pie y en coche"
        : travelProfiles.has("driving")
          ? "en coche"
          : "andando";
    const travelCopy = approximateTravel
        ? `con trayectos aproximados ${modeCopy}`
        : `con tiempos de trayecto ${modeCopy}`;
    const summary = projection.isToday
        ? `Proyección desde ahora, ${travelCopy}.`
        : `Simulación del día desde la primera apertura, ${travelCopy}.`;
    let insight;
    if (outsideItems.length) {
        const first = outsideItems[0];
        insight = first.closing !== null &&
            (first.end > first.closing || (!first.duration && first.start >= first.closing))
            ? `Atención: ${stringValue(first.spot.name, "una parada")} terminaría a las ${clockLabel(first.end)}, después de su cierre a las ${clockLabel(first.closing)}.`
            : `Atención: ${stringValue(first.spot.name, "una parada")} empezaría a las ${clockLabel(first.start)}, antes de su apertura a las ${clockLabel(first.opening)}.`;
    } else {
        const constrained = projection.items.filter((item) => !item.visited && item.margin !== null && item.margin >= 0).sort((a, b) => a.margin - b.margin)[0];
        insight = constrained
            ? `Llegas a ${stringValue(constrained.spot.name, "la próxima parada")} con ${constrained.margin} min de margen antes del cierre.${missingDuration ? ` ${missingDuration} ${missingDuration === 1 ? "parada no tiene" : "paradas no tienen"} duración estimada.` : ""}`
            : missingDuration
              ? `${missingDuration} ${missingDuration === 1 ? "parada no tiene" : "paradas no tienen"} duración estimada; añádela para comprobar su horario.`
              : "No se detectan conflictos con los horarios guardados.";
    }
    return { empty: false, html, summary, insight, warning: outsideItems.length > 0, aria: `${summary} ${insight}` };
}
