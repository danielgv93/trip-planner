export const SPOT_KINDS = Object.freeze(["activity", "waypoint"]);
export const POSITION_CONSTRAINTS = Object.freeze(["first", "last", "locked"]);

export function spotKind(spot) {
    return spot?.kind === "waypoint" ? "waypoint" : "activity";
}

export function categoryDefaultSpotKind(category) {
    return category?.defaultSpotKind === "waypoint"
        ? "waypoint"
        : "activity";
}

export function spotPositionConstraint(spot) {
    return POSITION_CONSTRAINTS.includes(spot?.positionConstraint)
        ? spot.positionConstraint
        : null;
}

export function dayPositionConstraintViolation(beforeSpots, afterSpots) {
    const first = afterSpots.filter((spot) => spotPositionConstraint(spot) === "first");
    if (first.length > 1) return "Solo puede haber una primera parada anclada por día.";
    if (first.length === 1 && afterSpots[0]?.id !== first[0].id)
        return "La primera parada anclada debe permanecer al inicio del día.";

    const last = afterSpots.filter((spot) => spotPositionConstraint(spot) === "last");
    if (last.length > 1) return "Solo puede haber una última parada anclada por día.";
    if (last.length === 1 && afterSpots.at(-1)?.id !== last[0].id)
        return "La última parada anclada debe permanecer al final del día.";

    for (let index = 0; index < beforeSpots.length; index += 1) {
        const spot = beforeSpots[index];
        if (spotPositionConstraint(spot) !== "locked") continue;
        if (afterSpots.findIndex((candidate) => candidate.id === spot.id) !== index)
            return `“${spot.name || "La parada fija"}” debe mantener su posición.`;
    }
    return null;
}

export function positionConstraintInsertionIndex(spots, spot, preferred = spots.length) {
    const indexes = Array.from({ length: spots.length + 1 }, (_, index) => index)
        .sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred));
    for (const index of indexes) {
        const candidate = [...spots];
        candidate.splice(index, 0, spot);
        if (!dayPositionConstraintViolation(spots, candidate)) return index;
    }
    return null;
}

export function normalizeSpotKind(spot) {
    const normalized = { ...spot, kind: spotKind(spot) };
    const positionConstraint = spotPositionConstraint(spot);
    if (positionConstraint) normalized.positionConstraint = positionConstraint;
    else delete normalized.positionConstraint;
    return normalized;
}

export function isWaypoint(spot) {
    return spotKind(spot) === "waypoint";
}

export function activityDuration(spot) {
    return spotKind(spot) === "activity" && Number.isInteger(spot?.visitMinutes) && spot.visitMinutes > 0
        ? spot.visitMinutes
        : 0;
}
