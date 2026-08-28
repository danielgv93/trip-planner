import { minutesToTime } from "../../core/time.js";

export function simulationDayFingerprint(day) {
    return JSON.stringify(day ?? null);
}

export function applySimulationToDay(day, selectedSpotIds, result) {
    if (!day || !Array.isArray(day.spots) || !result || !Array.isArray(result.steps)) {
        throw new TypeError("La simulación no contiene un día aplicable.");
    }
    const selected = new Set([...selectedSpotIds].map(String));
    const originals = new Map(day.spots.map((spot) => [String(spot.id), spot]));
    const ordered = [];
    const starts = new Map();

    result.steps.forEach((step) => {
        const id = String(step?.spot?.id ?? "");
        if (!selected.has(id) || starts.has(id)) return;
        const spot = originals.get(id);
        const plannedStart = minutesToTime(step.start, { wrap: true });
        if (!spot || !plannedStart) return;
        starts.set(id, plannedStart);
        ordered.push({ ...spot, plannedStart });
    });

    if (ordered.length !== selected.size) {
        throw new Error("SIMULATION_RESULT_STALE");
    }

    let cursor = 0;
    const spots = day.spots.map((spot) => selected.has(String(spot.id))
        ? ordered[cursor++]
        : spot);
    const startTime = minutesToTime(result.start, { wrap: true });
    if (!startTime) throw new Error("SIMULATION_RESULT_STALE");
    return { ...day, startTime, spots };
}
