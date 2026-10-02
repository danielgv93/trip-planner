// Pure on-trip forecast: compares the reference plan with what is really
// happening today (checked-off visits and the clock) to tell the traveller how
// they are doing and what is at risk. It never mutates the day.

import { buildTimelineProjection } from "../timeline/timeline.js";
import { minutesToTime, timeToMinutes } from "../../core/time.js";

// Below this many minutes a deviation is noise, not news.
const PACE_TOLERANCE = 10;

function clock(minutes) {
    return minutesToTime(minutes, { wrap: true });
}

function stopName(spot) {
    return (typeof spot?.name === "string" && spot.name.trim()) || "Parada sin nombre";
}

export function formatDurationMinutes(value) {
    const minutes = Math.max(0, Math.round(Number(value) || 0));
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function warningFor(item, live) {
    if (item.visited) return null;
    const name = stopName(item.spot);
    const missed = item.conflicts.find((conflict) => conflict.type === "missed-departure");
    if (missed)
        return { spot: item.spot, type: "missed-departure", message: `Llegarías ${formatDurationMinutes(missed.minutes)} tarde a la salida hacia ${name} (${item.travelDepartureTime}).` };
    const late = item.conflicts.find((conflict) => conflict.type === "late-reservation" || conflict.type === "travel-overlap");
    if (late && item.plannedStart !== null)
        return { spot: item.spot, type: "late-reservation", message: `Llegarías unos ${formatDurationMinutes(late.minutes)} tarde a ${name} (previsto a las ${clock(item.plannedStart)}).` };
    if (item.outside && item.closing !== null && item.end > item.closing)
        return { spot: item.spot, type: "closing", message: `${name} cierra a las ${clock(item.closing)} y terminarías a las ${clock(item.end)}.` };
    if (item.outside && item.opening !== null && item.start < item.opening)
        return { spot: item.spot, type: "opening", message: `${name} no abre hasta las ${clock(item.opening)}.` };
    if (live.isToday && item.closing !== null && !item.allDay && item.margin !== null && item.margin >= 0 && item.margin <= 30)
        return { spot: item.spot, type: "tight", message: `Margen justo en ${name}: cierra a las ${clock(item.closing)}.` };
    return null;
}

/**
 * @param day        Planner day.
 * @param options.isVisitStop  Predicate for stops the traveller checks off
 *                   (embedded transit endpoints are not).
 * @returns {{
 *   plan, live, current, pace, endMinutes, remainingMinutes, warnings,
 *   planItem(spot), liveItem(spot)
 * }}
 */
export function buildDayForecast(day, {
    now = new Date(),
    travelForLeg = null,
    isVisitStop = () => true,
} = {}) {
    const plan = buildTimelineProjection(day, { now, travelForLeg, mode: "plan" });
    const live = buildTimelineProjection(day, { now, travelForLeg, mode: "live" });
    const planBySpot = new Map(plan.items.map((item) => [item.spot, item]));
    const liveBySpot = new Map(live.items.map((item) => [item.spot, item]));
    const visitItems = live.items.filter((item) => isVisitStop(item.spot));
    const current = visitItems.find((item) => !item.visited) || null;
    const nowMinutes = live.current;
    const endMinutes = live.items.length ? Math.max(...live.items.map((item) => item.end)) : null;

    let pace;
    if (!live.items.length) pace = { status: "empty", minutes: 0 };
    else if (!current) pace = { status: "done", minutes: 0 };
    else if (!live.isToday) pace = { status: "plan", minutes: 0 };
    else {
        const planned = planBySpot.get(current.spot);
        const anyVisited = live.items.some((item) => item.visited);
        const firstStart = plan.items[0]?.start ?? planned.start;
        if (!anyVisited && nowMinutes < firstStart) {
            pace = { status: "upcoming", minutes: firstStart - nowMinutes };
        } else {
            const projectedFinish = Math.max(current.end, nowMinutes);
            const delay = projectedFinish - planned.end;
            const early = planned.arrival - current.arrival;
            if (delay >= PACE_TOLERANCE) pace = { status: "late", minutes: delay };
            else if (delay <= 0 && early >= PACE_TOLERANCE) pace = { status: "ahead", minutes: early };
            else pace = { status: "on-time", minutes: Math.max(0, delay) };
        }
    }

    const warnings = live.items
        .map((item) => warningFor(item, live))
        .filter(Boolean);

    return {
        plan,
        live,
        current,
        pace,
        endMinutes,
        remainingMinutes:
            live.isToday && current && endMinutes !== null && pace.status !== "upcoming"
                ? Math.max(0, endMinutes - nowMinutes)
                : null,
        warnings,
        planItem: (spot) => planBySpot.get(spot) || null,
        liveItem: (spot) => liveBySpot.get(spot) || null,
    };
}

export function paceLabel(pace) {
    switch (pace?.status) {
        case "late": return `Vas con ~${formatDurationMinutes(pace.minutes)} de retraso`;
        case "ahead": return `Vas ~${formatDurationMinutes(pace.minutes)} adelantado`;
        case "on-time": return "Vas a tiempo";
        case "upcoming": return `El día empieza en ${formatDurationMinutes(pace.minutes)}`;
        case "done": return "Día completado";
        case "plan": return "Previsión según el plan";
        default: return "Sin paradas activas";
    }
}

/**
 * Legs between the stops the traveller checks off. Embedded transit endpoints
 * are folded into the leg that carries them, adding their travel time.
 */
export function visitLegs(items, isVisitStop = () => true) {
    const legs = new Map();
    let pending = [];
    let seenVisitStop = false;
    for (const item of items) {
        if (seenVisitStop && item.fromSpot) pending.push(item);
        if (!isVisitStop(item.spot)) continue;
        if (seenVisitStop && pending.length) {
            const travel = pending.reduce((total, part) => total + (part.travel || 0), 0);
            const carrier = pending.find((part) => part.travelLine || !["walking", "driving", "cycling"].includes(part.travelMode)) || pending.at(-1);
            legs.set(item.spot, {
                minutes: travel,
                mode: carrier.travelMode,
                line: carrier.travelLine,
                departureTime: carrier.travelDepartureTime,
                approximate: pending.some((part) => part.travelApproximate),
                missingDuration: pending.some((part) => part.travelMissingDuration),
                cost: pending.reduce((total, part) => total + (Number(part.travelCost) || 0), 0),
                from: pending[0].fromSpot,
                note: [...new Set(pending.map((part) => part.travelNote?.trim()).filter(Boolean))].join(" · "),
            });
        }
        pending = [];
        seenVisitStop = true;
    }
    return legs;
}

// Beyond this horizon a countdown is noise; the clock time is enough.
const COUNTDOWN_LIMIT = 240;

// Turns the next stop's projected times into the action that matters on the
// street: when to leave (or when the transport leaves), or until when to stay.
// Returns { lead, time, relative } with empty strings for missing parts.
export function departureCue({
    start,
    end,
    legMinutes = 0,
    departureTime = null,
    now,
    isToday = true,
    waypoint = false,
}) {
    if (!Number.isFinite(start)) return null;
    if (!isToday || !Number.isFinite(now)) return { lead: "", time: clock(start), relative: "" };
    if (!waypoint && Number.isFinite(end) && now >= start && now < end)
        return { lead: "Hasta las", time: clock(end), relative: `quedan ${formatDurationMinutes(end - now)}` };

    const fixed = timeToMinutes(departureTime);
    const leave = fixed !== null
        ? fixed
        : legMinutes > 0 ? start - legMinutes : start;
    const lead = fixed !== null
        ? "Sale a las"
        : legMinutes > 0 ? "Sal a las" : waypoint ? "Paso a las" : "Empieza a las";
    const delta = leave - now;
    if (delta > 0)
        return { lead, time: clock(leave), relative: delta <= COUNTDOWN_LIMIT ? `en ${formatDurationMinutes(delta)}` : "" };
    if (fixed === null && legMinutes > 0)
        return { lead: "Sal ya", time: "", relative: `llegada ${clock(start)}` };
    if (fixed === null)
        return { lead: waypoint ? "Pasa ya" : "Ve ya", time: "", relative: `prevista ${clock(start)}` };
    return { lead, time: clock(leave), relative: "" };
}
