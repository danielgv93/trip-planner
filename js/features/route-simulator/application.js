import { minutesToTime } from "../../core/time.js";
import { dayPositionConstraintViolation } from "../../core/itinerary.js";
import { isReservationSpot } from "./optimizer.js";

export function simulationDayFingerprint(day) {
    return JSON.stringify(day ?? null);
}

function firstVisits(result) {
    const seen = new Set();
    return result.steps.filter((step) => {
        const id = String(step?.spot?.id ?? "");
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });
}

// A reservation keeps the hour it was booked for. Whatever the optimizer
// computed for it is at best the same hour and at worst the late arrival,
// and writing the late arrival would silently move a booking nobody moved.
//
// Only a stop that entered the simulation with a time keeps one. Every other
// stop is placed by the order and the day's start, which the timeline already
// projects; writing their computed hours turned each estimate into an
// appointment, so every later run had less room than the one before.
function appliedPlannedStart(original, step) {
    if (isReservationSpot(original)) return original.plannedStart;
    if (step.planned === null || step.planned === undefined) return null;
    return minutesToTime(step.start, { wrap: false });
}

// An appointment pushed past midnight cannot be written to this day: the
// stored HH:MM wraps and reads as an early-morning appointment instead.
export function overnightAppointments(result) {
    if (!result || !Array.isArray(result.steps)) return [];
    return firstVisits(result).filter((step) => !isReservationSpot(step.spot)
        && step.planned !== null && step.planned !== undefined && step.start >= 1440);
}

// A booking the proposed order arrives late for. Applying keeps the booked
// hour, so the itinerary will report the conflict instead of hiding it.
export function lateReservations(result) {
    if (!result || !Array.isArray(result.steps)) return [];
    return firstVisits(result).filter((step) => isReservationSpot(step.spot) && step.late > 0);
}

// An optional stop the proposal leaves out is not deleted: it goes to the
// backlog, exactly like the health check's "remove optional" suggestion, and
// with the same cleanup as any spot that changes container: no day-only
// position constraint, no group, and no hour or booking that belonged to the
// day it left.
export function backlogCopiesOfDropped(day, droppedSpotIds = []) {
    const dropped = new Set([...droppedSpotIds].map(String));
    return (day?.spots || [])
        .filter((spot) => dropped.has(String(spot.id)))
        .map(({
            positionConstraint: _constraint,
            backlogGroupId: _group,
            plannedStart: _plannedStart,
            fixedStart: _fixedStart,
            ...spot
        }) => spot);
}

// Removing a stop that sits before a locked one shifts the locked one. The
// dialog never offers such a drop; this is the last line of defence.
export function droppingBreaksLockedStops(day, droppedSpotIds = []) {
    const dropped = new Set([...droppedSpotIds].map(String));
    if (!dropped.size) return false;
    const after = (day?.spots || []).filter((spot) => !dropped.has(String(spot.id)));
    return dayPositionConstraintViolation(day?.spots || [], after) !== null;
}

export function applySimulationToDay(day, selectedSpotIds, result, { droppedSpotIds = [] } = {}) {
    if (!day || !Array.isArray(day.spots) || !result || !Array.isArray(result.steps)) {
        throw new TypeError("La simulación no contiene un día aplicable.");
    }
    if (overnightAppointments(result).length) {
        throw new Error("SIMULATION_RESULT_OVERNIGHT");
    }
    const dropped = new Set([...droppedSpotIds].map(String));
    if ([...dropped].some((id) => !day.spots.some((spot) => String(spot.id) === id))
        || droppingBreaksLockedStops(day, dropped)) {
        throw new Error("SIMULATION_RESULT_STALE");
    }
    const selected = new Set([...selectedSpotIds].map(String).filter((id) => !dropped.has(id)));
    const originals = new Map(day.spots.map((spot) => [String(spot.id), spot]));
    const ordered = [];

    firstVisits(result).forEach((step) => {
        const id = String(step?.spot?.id ?? "");
        const spot = originals.get(id);
        if (!selected.has(id) || !spot) return;
        const { plannedStart: _previous, ...rest } = spot;
        const plannedStart = appliedPlannedStart(spot, step);
        ordered.push(plannedStart ? { ...rest, plannedStart } : rest);
    });

    if (ordered.length !== selected.size) {
        throw new Error("SIMULATION_RESULT_STALE");
    }

    let cursor = 0;
    const spots = day.spots
        .filter((spot) => !dropped.has(String(spot.id)))
        .map((spot) => selected.has(String(spot.id))
            ? ordered[cursor++]
            : spot);
    const startTime = minutesToTime(result.start, { wrap: true });
    if (!startTime) throw new Error("SIMULATION_RESULT_STALE");
    return { ...day, startTime, spots };
}
