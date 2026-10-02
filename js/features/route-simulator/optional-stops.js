// Optional stops are wishes, not commitments. When the day cannot fit every
// selected stop — a booking missed, a closing window broken, the end-of-day
// limit passed — the simulator looks for the fewest optional stops whose
// absence makes it fit. It never drops one just to walk less: an optional
// stop the day can afford stays, because the traveller wanted it.

import { optimizeRoute } from "./optimizer.js";

// Exhaustive subset search is only worth it while each subset is cheap: a
// handful of optional stops on a day the optimizer still solves exactly.
const EXHAUSTIVE_OPTIONAL_LIMIT = 4;
const EXHAUSTIVE_MOVABLE_LIMIT = 7;

// The part of the optimizer's score that says whether the day fits at all.
function hardScore(result) {
    const metrics = result.metrics;
    return [
        metrics.reservationLateStops,
        metrics.totalReservationLate,
        metrics.overtime,
        metrics.scheduleConflictStops,
        metrics.totalScheduleConflict,
    ];
}

function compare(left, right) {
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return left[index] - right[index];
    }
    return 0;
}

function fits(result) {
    return hardScore(result).every((value) => value === 0);
}

// Whole conflicts first (bookings lost, limit broken, stops out of hours),
// then the fewest stops left out, and only then the minutes. Ranking minutes
// ahead of drops let a candidate give up three stops to shave one minute off
// a conflict a one-stop drop already left in place.
function rank(candidate) {
    const metrics = candidate.result.metrics;
    return [
        metrics.reservationLateStops,
        metrics.overtime > 0 ? 1 : 0,
        metrics.scheduleConflictStops,
        candidate.dropped.length,
        metrics.totalReservationLate,
        metrics.overtime,
        metrics.totalScheduleConflict,
        ...candidate.result.score,
    ];
}

// Giving up a wished-for stop has to buy something whole: a day that fits, a
// booking reached or a conflict gone. Shaving twenty minutes off a day that
// still ends three hours late is not worth losing a stop over.
function fixesSomething(candidate, full) {
    if (fits(candidate)) return true;
    return candidate.metrics.reservationLateStops < full.metrics.reservationLateStops
        || candidate.metrics.scheduleConflictStops < full.metrics.scheduleConflictStops;
}

function remapIndex(map, value) {
    return Number.isInteger(value) && map.has(value) ? map.get(value) : null;
}

// Runs the optimizer on the kept stops only, then translates every index in
// the answer back to the full selection so callers never see the subset.
// A pinned stop keeps its place among the stops that remain: pinned third
// behind two stops, one of which is left out, it becomes second. That is the
// same slot the applied day will give it, since the dropped stop leaves the
// day too.
function optimizeKept(spots, travelMinutes, options, keep) {
    const toSubset = new Map(keep.map((spotIndex, subsetIndex) => [spotIndex, subsetIndex]));
    const subsetSpots = keep.map((spotIndex) => spots[spotIndex]);
    const subsetMatrix = keep.map((from) => keep.map((to) => travelMinutes[from][to]));
    const remapList = (values) => (values || [])
        .map((value) => remapIndex(toSubset, value))
        .filter((value) => value !== null);
    const result = optimizeRoute(subsetSpots, subsetMatrix, {
        ...options,
        firstSpotIndex: remapIndex(toSubset, options.firstSpotIndex),
        lastSpotIndex: remapIndex(toSubset, options.lastSpotIndex),
        fixedSpotIndexes: remapList(options.fixedSpotIndexes),
        pastSpotIndexes: remapList(options.pastSpotIndexes),
    });
    return {
        ...result,
        order: result.order.map((subsetIndex) => keep[subsetIndex]),
        steps: result.steps.map((step) => ({ ...step, spotIndex: keep[step.spotIndex] })),
    };
}

function subsetsOfSize(values, size, start = 0, prefix = [], visit) {
    if (prefix.length === size) {
        visit(prefix);
        return;
    }
    for (let index = start; index <= values.length - (size - prefix.length); index += 1) {
        subsetsOfSize(values, size, index + 1, [...prefix, values[index]], visit);
    }
}

// Returns { result, full, dropped }: the recommended answer, the answer that
// keeps every stop, and the spot indexes the recommendation leaves out.
// droppableIndexes must already exclude anything pinned, visited or tied to
// a timetable — leaving those out would break a promise the dialog made.
export function optimizeWithOptionalStops(spots, travelMinutes, options = {}, droppableIndexes = []) {
    const all = spots.map((_, index) => index);
    const evaluate = (dropped) => {
        const removed = new Set(dropped);
        return {
            dropped: [...dropped].sort((a, b) => a - b),
            result: optimizeKept(spots, travelMinutes, options, all.filter((index) => !removed.has(index))),
        };
    };
    const full = evaluate([]);
    const droppable = [...new Set(droppableIndexes)]
        .filter((index) => Number.isInteger(index) && index >= 0 && index < spots.length);
    // Two stops is the smallest route the simulator compares.
    const maxDrops = Math.min(droppable.length, spots.length - 2);
    if (fits(full.result) || maxDrops <= 0) return { result: full.result, full: full.result, dropped: [] };

    let best = full;
    // Only candidates that buy something whole compete, so a subset that
    // merely shortens the overrun can never hide one that removes a conflict.
    const consider = (candidate) => {
        if (!fixesSomething(candidate.result, full.result)) return;
        if (best === full || compare(rank(candidate), rank(best)) < 0) best = candidate;
    };

    if (droppable.length <= EXHAUSTIVE_OPTIONAL_LIMIT && spots.length <= EXHAUSTIVE_MOVABLE_LIMIT + 2) {
        for (let size = 1; size <= maxDrops; size += 1) {
            subsetsOfSize(droppable, size, 0, [], (subset) => consider(evaluate(subset)));
            // The fewest drops that make the day fit is the answer; dropping
            // more could only shorten a day that already works.
            if (fits(best.result)) break;
        }
    } else {
        // Greedy: leave out, one at a time, the optional stop whose absence
        // helps most, until the day fits or nothing helps.
        let current = full;
        while (!fits(current.result) && current.dropped.length < maxDrops) {
            let step = null;
            droppable.filter((index) => !current.dropped.includes(index)).forEach((index) => {
                const candidate = evaluate([...current.dropped, index]);
                if (!step || compare(rank(candidate), rank(step)) < 0) step = candidate;
            });
            if (!step || compare(hardScore(step.result), hardScore(current.result)) >= 0) break;
            current = step;
        }
        // Greedy can leave out a stop an earlier choice made unnecessary.
        // Put back whatever fits without making the day worse.
        let restored = true;
        while (restored) {
            restored = false;
            for (const index of current.dropped) {
                const candidate = evaluate(current.dropped.filter((value) => value !== index));
                if (compare(hardScore(candidate.result), hardScore(current.result)) <= 0) {
                    current = candidate;
                    restored = true;
                    break;
                }
            }
        }
        consider(current);
    }

    if (!best.dropped.length || !fixesSomething(best.result, full.result)) {
        return { result: full.result, full: full.result, dropped: [] };
    }
    return { result: best.result, full: full.result, dropped: best.dropped };
}
