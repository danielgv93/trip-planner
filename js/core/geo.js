const EARTH_RADIUS_METERS = 6371000;

export function validCoordinatePair(lat, lng) {
    return (
        Number.isFinite(lat) && Number.isFinite(lng) &&
        lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
    );
}

export function locatedPoint(point) {
    return validCoordinatePair(point?.lat, point?.lng);
}

export function distanceMeters(from, to) {
    if (!locatedPoint(from) || !locatedPoint(to)) return null;
    const radians = Math.PI / 180;
    const lat1 = from.lat * radians;
    const lat2 = to.lat * radians;
    const deltaLat = (to.lat - from.lat) * radians;
    const deltaLng = (to.lng - from.lng) * radians;
    const sinLat = Math.sin(deltaLat / 2);
    const sinLng = Math.sin(deltaLng / 2);
    const a = Math.min(1, Math.max(
        0,
        sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng,
    ));
    return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
