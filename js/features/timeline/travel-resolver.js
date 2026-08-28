// Single source of truth for "how long does this leg actually take according to
// the plan": the duration configured on the leg wins, then the cached official
// route for its profile, and only then nothing at all — which lets the timeline
// projection fall back to its own distance estimate. Every view that projects a
// day (planner cards, companion, health, route simulator) shares this cascade so
// they can never disagree about an established travel time.

import {
    routeTimeOverride,
    routeTimeProfile,
    travelLeg,
} from "../../core/store.js";
import { AUTOMATIC_TRAVEL_MODES } from "../../core/travel-legs.js";
import { cachedRouteTravelMinutes } from "../map/map.js";

export function resolveTravelForLeg(from, to) {
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

// Travel profiles actually in play for a day, so callers can warm the route
// cache for every mode the day uses instead of assuming a single one.
export function travelProfilesForSpots(spots) {
    const profiles = new Set(["walking"]);
    const sequence = Array.isArray(spots) ? spots : [];
    for (let index = 1; index < sequence.length; index += 1) {
        const mode = travelLeg(sequence[index - 1].id, sequence[index].id)?.mode
            || routeTimeProfile(sequence[index - 1].id, sequence[index].id);
        if (AUTOMATIC_TRAVEL_MODES.includes(mode)) profiles.add(mode);
    }
    return profiles;
}
