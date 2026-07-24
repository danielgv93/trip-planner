export const SPOT_KINDS = Object.freeze(["activity", "waypoint"]);

export function spotKind(spot) {
    return spot?.kind === "waypoint" ? "waypoint" : "activity";
}

export function categoryDefaultSpotKind(category) {
    return category?.defaultSpotKind === "waypoint"
        ? "waypoint"
        : "activity";
}

export function normalizeSpotKind(spot) {
    return { ...spot, kind: spotKind(spot) };
}

export function isWaypoint(spot) {
    return spotKind(spot) === "waypoint";
}

export function activityDuration(spot) {
    return spotKind(spot) === "activity" && Number.isInteger(spot?.visitMinutes) && spot.visitMinutes > 0
        ? spot.visitMinutes
        : 0;
}
