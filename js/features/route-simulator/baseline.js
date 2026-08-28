// The "Antes" side of the simulator comparison. It must show the day exactly as
// it is already established — the stored order, the clock the planner cards
// project, and the travel durations configured for the legs that exist — so any
// difference against "Ahora" comes from the optimizer and never from measuring
// the same day twice with two different engines.
//
// It therefore reuses buildTimelineProjection() instead of simulateOrder():
// nothing is reordered, no visit is shifted to make an opening window fit, and
// no leg is re-measured. Conflicts are reported, not resolved.

import { buildTimelineProjection } from "../timeline/timeline.js";
import { outsideSchedule, scheduleForSpot } from "./optimizer.js";

const EMPTY_METRICS = Object.freeze({
    travel: 0,
    waiting: 0,
    visit: 0,
    lateStops: 0,
    totalLate: 0,
    maxLate: 0,
    outsideStops: 0,
    totalOutside: 0,
    maxOutside: 0,
    scheduleConflictStops: 0,
    totalScheduleConflict: 0,
    maxScheduleConflict: 0,
});

function accumulate(steps) {
    return steps.reduce((totals, step) => {
        const conflict = step.late + step.outsideMinutes;
        return {
            travel: totals.travel + step.travel,
            waiting: totals.waiting + step.wait,
            visit: totals.visit + step.duration,
            lateStops: totals.lateStops + (step.late > 0 ? 1 : 0),
            totalLate: totals.totalLate + step.late,
            maxLate: Math.max(totals.maxLate, step.late),
            outsideStops: totals.outsideStops + (step.outsideSchedule ? 1 : 0),
            totalOutside: totals.totalOutside + step.outsideMinutes,
            maxOutside: Math.max(totals.maxOutside, step.outsideMinutes),
            scheduleConflictStops: totals.scheduleConflictStops + (step.late > 0 || step.outsideSchedule ? 1 : 0),
            totalScheduleConflict: totals.totalScheduleConflict + conflict,
            maxScheduleConflict: Math.max(totals.maxScheduleConflict, conflict),
        };
    }, { ...EMPTY_METRICS });
}

// Returns a result shaped like simulateOrder()'s so both sides of the
// comparison render through the same markup.
export function establishedBaseline(day, spots, {
    travelForLeg = null,
    profile = "walking",
    now = new Date(),
} = {}) {
    if (!Array.isArray(spots) || spots.length === 0) return null;
    const projection = buildTimelineProjection({ ...day, spots }, { now, profile, travelForLeg });
    const indexById = new Map(spots.map((spot, index) => [String(spot.id), index]));
    const steps = projection.items.map((item, position) => {
        // Both sides of the comparison are judged by the optimizer's schedule
        // model and by nothing else. Reading item.outside/item.outsideRanges
        // here would measure the same stop with the projection's rules, which
        // decline to model overnight windows and honour stored hours on stops
        // marked as not applicable — handing "Antes" conflicts that "Ahora" is
        // structurally unable to have, and inventing an improvement out of the
        // difference between two rulebooks.
        const schedule = scheduleForSpot(item.spot);
        const outside = outsideSchedule(item.start, item.duration, schedule);
        return {
            spot: item.spot,
            spotIndex: indexById.get(String(item.spot.id)) ?? position,
            travel: item.travel,
            arrival: item.arrival,
            planned: item.plannedStart,
            wait: item.wait,
            // Established lateness is the arrival the plan cannot make, not a
            // slot the optimizer chose to move.
            late: item.plannedStart === null ? 0 : Math.max(0, item.arrival - item.start),
            start: item.start,
            finish: item.end,
            duration: item.duration,
            repeated: false,
            schedule,
            outsideSchedule: outside.outside,
            outsideMinutes: outside.minutes,
            // A visit already checked off zeroes its own inbound leg in the
            // projection. That 0 records the past; it never measured the walk.
            actual: item.actual === true,
            // A timetabled leg is a commitment, not a duration. The optimizer
            // cannot model it, so the simulator needs to know it is there.
            fixedDeparture: item.travelFixedDeparture === true,
            departureTime: item.travelDepartureTime || null,
        };
    });
    const start = projection.start;
    return {
        order: steps.map((step) => step.spotIndex),
        start,
        finish: steps.length ? Math.max(start, ...steps.map((step) => step.finish)) : start,
        steps,
        metrics: accumulate(steps),
        established: true,
    };
}
