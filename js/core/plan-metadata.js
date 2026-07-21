import { isTime } from "./time.js";

export function normalizeHealthSpot(spot) {
    const normalized = { ...spot };
    for (const field of ["optional", "fixedStart", "scheduleNotApplicable"])
        if (spot?.[field] === true) normalized[field] = true;
        else delete normalized[field];
    if (normalized.fixedStart && !isTime(normalized.plannedStart))
        delete normalized.fixedStart;
    // Removed health-source fields are explicitly stripped from old saves and
    // portable plans so they do not survive a later save/export round-trip.
    delete normalized.scheduleUrl;
    delete normalized.scheduleVerifiedAt;
    return normalized;
}

export function normalizeHealthDay(day) {
    const normalized = { ...day };
    if (!isTime(day?.startTime)) delete normalized.startTime;
    return normalized;
}
