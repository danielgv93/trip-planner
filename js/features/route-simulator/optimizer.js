import { minutesToTime, timeToMinutes } from "../../core/time.js";
import { isWaypoint } from "../../core/itinerary.js";

const DEFAULT_START = 9 * 60;
// Ocho paradas movibles son 40320 ordenes: el caso exacto costaba mas que la
// busqueda heuristica de doce. La heuristica encuentra el optimo en la mayoria
// de dias reales y se queda a pocos minutos cuando no, asi que el limite baja
// donde la busqueda completa sigue siendo instantanea.
const EXACT_LIMIT = 7;

function compareScore(left, right) {
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return left[index] - right[index];
    }
    return 0;
}

function normalizedDuration(spot) {
    return Number.isInteger(spot?.visitMinutes) && spot.visitMinutes > 0
        ? spot.visitMinutes
        : 0;
}

export function scheduleForSpot(spot) {
    if (isWaypoint(spot) || spot?.scheduleNotApplicable === true) return null;
    const opening = timeToMinutes(spot?.openingTime);
    const closing = timeToMinutes(spot?.closingTime);
    if (opening === null && closing === null) return null;
    if (opening === 0 && closing === 0) return null;
    // Equal non-midnight endpoints are ambiguous in the persisted model. The
    // health check reports them, but the optimizer must not invent a window.
    if (opening !== null && opening === closing) return null;
    if (opening === null) return { opening, closing, intervals: [[0, closing]] };
    if (closing === null) return { opening, closing, intervals: [[opening, 1440]] };
    if (opening < closing) return { opening, closing, intervals: [[opening, closing]] };
    return { opening, closing, intervals: [[0, closing], [opening, 1440 + closing]] };
}

function intervalContains(interval, minute) {
    return minute >= interval[0] && minute < interval[1];
}

function scheduledServiceStart(target, duration, schedule, hasAppointment) {
    if (!schedule) return target;
    const containingIndex = schedule.intervals.findIndex((interval) => intervalContains(interval, target));
    if (containingIndex !== -1) {
        const interval = schedule.intervals[containingIndex];
        if (target + duration <= interval[1] || hasAppointment) return target;
        const laterFit = schedule.intervals.slice(containingIndex + 1)
            .find(([start, end]) => start >= target && start + duration <= end);
        return laterFit ? laterFit[0] : target;
    }
    const future = schedule.intervals.filter(([, end]) => end > target);
    const fitting = future.find(([start, end]) => Math.max(target, start) + duration <= end);
    if (fitting) return Math.max(target, fitting[0]);
    return future.length ? Math.max(target, future[0][0]) : target;
}

export function outsideSchedule(start, duration, schedule) {
    if (!schedule) return { outside: false, minutes: 0 };
    if (duration <= 0) {
        const outside = !schedule.intervals.some((interval) => intervalContains(interval, start));
        return { outside, minutes: 0 };
    }
    const finish = start + duration;
    const inside = schedule.intervals.reduce((total, [from, to]) =>
        total + Math.max(0, Math.min(finish, to) - Math.max(start, from)), 0);
    const minutes = Math.max(0, duration - inside);
    return { outside: minutes > 0, minutes };
}

// plannedStart, visitMinutes y el horario de una parada no cambian entre ordenes
// ni entre candidatos de salida, pero se recalculaban dentro del bucle mas
// caliente: con ocho paradas eso son millones de parseos de "HH:MM" repetidos.
// Se resuelven una vez y viajan por referencia.
function timingFacts(spots) {
    return spots.map((spot) => ({
        planned: timeToMinutes(spot.plannedStart),
        duration: normalizedDuration(spot),
        schedule: scheduleForSpot(spot),
    }));
}

function addStartCandidate(candidates, value) {
    if (!Number.isFinite(value)) return;
    candidates.add(Math.max(0, Math.min(1439, value)));
}

function simulationStart(order, travelMinutes, fixedStart, facts) {
    if (Number.isInteger(fixedStart)) return fixedStart;
    const candidates = new Set([DEFAULT_START]);
    let elapsed = 0;
    const visited = new Set();
    order.forEach((spotIndex, position) => {
        if (position > 0) elapsed += travelMinutes[order[position - 1]][spotIndex];
        const repeated = visited.has(spotIndex);
        const planned = repeated ? null : facts[spotIndex].planned;
        const duration = repeated ? 0 : facts[spotIndex].duration;
        if (planned !== null) addStartCandidate(candidates, planned - elapsed);
        if (!repeated) {
            const schedule = facts[spotIndex].schedule;
            if (schedule && schedule.opening !== null)
                addStartCandidate(candidates, schedule.opening - elapsed);
            if (schedule && schedule.closing !== null)
                addStartCandidate(candidates, schedule.closing - duration - elapsed);
            elapsed += duration;
        }
        visited.add(spotIndex);
    });
    return [...candidates];
}

export function simulateOrder(spots, order, travelMinutes, { fixedStart = null, facts = null } = {}) {
    const timing = facts || timingFacts(spots);
    const starts = simulationStart(order, travelMinutes, fixedStart, timing);
    let best = null;
    for (const start of Array.isArray(starts) ? starts : [starts]) {
        let clock = start;
        let travel = 0;
        let waiting = 0;
        let totalLate = 0;
        let maxLate = 0;
        let lateStops = 0;
        let outsideStops = 0;
        let totalOutside = 0;
        let maxOutside = 0;
        let scheduleConflictStops = 0;
        let totalScheduleConflict = 0;
        let maxScheduleConflict = 0;
        const steps = [];
        const visited = new Set();
        order.forEach((spotIndex, position) => {
            const leg = position === 0 ? 0 : travelMinutes[order[position - 1]][spotIndex];
            travel += leg;
            const arrival = clock + leg;
            const repeated = visited.has(spotIndex);
            const planned = repeated ? null : timing[spotIndex].planned;
            const duration = repeated ? 0 : timing[spotIndex].duration;
            const schedule = repeated ? null : timing[spotIndex].schedule;
            const requestedStart = Math.max(arrival, planned ?? arrival);
            const serviceStart = scheduledServiceStart(requestedStart, duration, schedule, planned !== null);
            const wait = Math.max(0, serviceStart - arrival);
            const late = planned === null ? 0 : Math.max(0, serviceStart - planned);
            const outside = outsideSchedule(serviceStart, duration, schedule);
            const finish = serviceStart + duration;
            waiting += wait;
            totalLate += late;
            maxLate = Math.max(maxLate, late);
            if (late > 0) lateStops += 1;
            if (outside.outside) outsideStops += 1;
            totalOutside += outside.minutes;
            maxOutside = Math.max(maxOutside, outside.minutes);
            const scheduleConflict = late > 0 || outside.outside;
            const scheduleConflictMinutes = late + outside.minutes;
            if (scheduleConflict) scheduleConflictStops += 1;
            totalScheduleConflict += scheduleConflictMinutes;
            maxScheduleConflict = Math.max(maxScheduleConflict, scheduleConflictMinutes);
            steps.push({
                spot: spots[spotIndex],
                spotIndex,
                travel: leg,
                arrival,
                planned,
                wait,
                late,
                start: serviceStart,
                finish,
                duration,
                repeated,
                schedule,
                outsideSchedule: outside.outside,
                outsideMinutes: outside.minutes,
            });
            visited.add(spotIndex);
            clock = finish;
        });
        const score = [
            scheduleConflictStops,
            totalScheduleConflict,
            maxScheduleConflict,
            lateStops,
            totalLate,
            maxLate,
            outsideStops,
            totalOutside,
            maxOutside,
            // What the traveller actually spends is the whole day, not the
            // asphalt: travel and waiting are interchangeable minutes of it. An
            // order that walks less but stands waiting longer finishes later
            // and is worse, so the elapsed day leads and travel only breaks
            // ties between orders that end at the same time.
            clock - start,
            travel,
            waiting,
            // Ties are broken by the departure closest to the reference hour,
            // never by the latest one. Candidate starts are derived from every
            // opening and closing in the day, so preferring the largest start
            // pushed an unconstrained day to a 19:00 departure, and preferring
            // the smallest pushed it to 06:40. Neither is a day anyone travels.
            Math.abs(start - DEFAULT_START),
        ];
        const result = {
            order: [...order],
            start,
            finish: clock,
            steps,
            metrics: {
                travel,
                waiting,
                visit: steps.reduce((sum, step) => sum + step.duration, 0),
                lateStops,
                totalLate,
                maxLate,
                outsideStops,
                totalOutside,
                maxOutside,
                scheduleConflictStops,
                totalScheduleConflict,
                maxScheduleConflict,
            },
            score,
        };
        if (!best || compareScore(result.score, best.score) < 0) best = result;
    }
    return best;
}

function permutations(values, visit, prefix = []) {
    if (!values.length) {
        visit(prefix);
        return;
    }
    values.forEach((value, index) => permutations(
        [...values.slice(0, index), ...values.slice(index + 1)],
        visit,
        [...prefix, value],
    ));
}

function nearestNeighborSeed(values, travelMinutes, first) {
    const order = [first];
    const remaining = new Set(values.filter((index) => index !== first));
    while (remaining.size) {
        const previous = order.at(-1);
        const next = [...remaining].sort((a, b) => travelMinutes[previous][a] - travelMinutes[previous][b] || a - b)[0];
        order.push(next);
        remaining.delete(next);
    }
    return order;
}

function improveSeed(spots, seed, travelMinutes, options, completeOrder) {
    let bestSeed = [...seed];
    let best = simulateOrder(spots, completeOrder(bestSeed), travelMinutes, options);
    let improved = true;
    let passes = 0;
    while (improved && passes < 6) {
        improved = false;
        passes += 1;
        for (let from = 0; from < seed.length; from += 1) {
            for (let to = 0; to < seed.length; to += 1) {
                if (from === to) continue;
                const candidate = [...bestSeed];
                const [moved] = candidate.splice(from, 1);
                candidate.splice(to, 0, moved);
                const result = simulateOrder(spots, completeOrder(candidate), travelMinutes, options);
                if (compareScore(result.score, best.score) < 0) {
                    best = result;
                    bestSeed = candidate;
                    improved = true;
                }
            }
        }
    }
    return best;
}

function routeConstraint(size, {
    firstSpotIndex = null,
    lastSpotIndex = null,
    fixedSpotIndexes = [],
} = {}) {
    const indexes = Array.from({ length: size }, (_, index) => index);
    const valid = (value) => Number.isInteger(value) && value >= 0 && value < size;
    const first = valid(firstSpotIndex) ? firstSpotIndex : null;
    const last = valid(lastSpotIndex) ? lastSpotIndex : null;
    const circular = first !== null && first === last;
    const template = Array.from({ length: size + (circular ? 1 : 0) }, () => null);
    const exact = new Set(Array.isArray(fixedSpotIndexes) ? fixedSpotIndexes.filter(valid) : []);
    if (first !== null) exact.delete(first);
    if (last !== null) exact.delete(last);
    exact.forEach((spotIndex) => { template[spotIndex] = spotIndex; });

    const forceEndpoint = (position, spotIndex) => {
        if (spotIndex === null) return;
        template.forEach((value, index) => {
            if (value === spotIndex) template[index] = null;
        });
        template[position] = spotIndex;
    };
    if (circular) {
        template.forEach((value, index) => {
            if (value === first) template[index] = null;
        });
        template[0] = first;
        template[template.length - 1] = first;
    } else {
        forceEndpoint(0, first);
        forceEndpoint(template.length - 1, last);
    }

    const locked = new Set(template.filter((value) => value !== null));
    const movable = indexes.filter((index) => !locked.has(index));
    const completeOrder = (orderedMovable) => {
        let cursor = 0;
        return template.map((spotIndex) => spotIndex ?? orderedMovable[cursor++]);
    };
    return { movable, completeOrder };
}

export function optimizeRoute(spots, travelMinutes, {
    fixedStart = null,
    firstSpotIndex = null,
    lastSpotIndex = null,
    fixedSpotIndexes = [],
} = {}) {
    if (!Array.isArray(spots) || spots.length === 0) return null;
    if (!Array.isArray(travelMinutes) || travelMinutes.length !== spots.length)
        throw new TypeError("La matriz de trayectos no coincide con las paradas.");
    const { movable, completeOrder } = routeConstraint(spots.length, {
        firstSpotIndex,
        lastSpotIndex,
        fixedSpotIndexes,
    });
    const facts = timingFacts(spots);
    let best = null;
    const consider = (middle) => {
        const result = simulateOrder(spots, completeOrder(middle), travelMinutes, { fixedStart, facts });
        if (!best || compareScore(result.score, best.score) < 0) best = result;
    };
    if (movable.length <= EXACT_LIMIT) {
        permutations(movable, consider);
        return { ...best, exact: true };
    }

    const schedulePriority = (spot) => {
        const planned = timeToMinutes(spot.plannedStart);
        if (planned !== null) return planned;
        const schedule = scheduleForSpot(spot);
        if (!schedule) return null;
        return schedule.closing ?? schedule.opening;
    };
    const timed = movable.filter((index) => schedulePriority(spots[index]) !== null)
        .sort((a, b) => schedulePriority(spots[a]) - schedulePriority(spots[b]) || a - b);
    const timedIndexes = new Set(timed);
    const untimed = movable.filter((index) => !timedIndexes.has(index));
    const seeds = [movable, [...timed, ...untimed], [...movable].reverse()];
    movable.forEach((seedStart) => seeds.push(nearestNeighborSeed(movable, travelMinutes, seedStart)));
    for (const seed of seeds) {
        const result = improveSeed(spots, seed, travelMinutes, { fixedStart, facts }, completeOrder);
        if (!best || compareScore(result.score, best.score) < 0) best = result;
    }
    return { ...best, exact: false };
}

export function formatSimulationTime(minutes) {
    if (!Number.isFinite(minutes)) return "—";
    const dayOffset = Math.floor(minutes / 1440);
    const label = minutesToTime(minutes, { wrap: true });
    return dayOffset > 0 ? `${label} (+${dayOffset} d)` : label;
}
