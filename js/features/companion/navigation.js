// Pure navigation calculations used by the on-trip companion.

import { distanceMeters, validCoordinatePair } from "../../core/geo.js";

const CARDINAL_LABELS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];

export function localDateKey(now = new Date()) {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

export function normalizeDegrees(value) {
    if (!Number.isFinite(value)) return null;
    return ((value % 360) + 360) % 360;
}

export function haversineMeters(fromLat, fromLng, toLat, toLng) {
    return distanceMeters(
        { lat: fromLat, lng: fromLng },
        { lat: toLat, lng: toLng },
    );
}

export function initialBearingDegrees(fromLat, fromLng, toLat, toLng) {
    if (
        !validCoordinatePair(fromLat, fromLng) ||
        !validCoordinatePair(toLat, toLng)
    )
        return null;
    if (fromLat === toLat && fromLng === toLng) return 0;
    const radians = Math.PI / 180;
    const lat1 = fromLat * radians;
    const lat2 = toLat * radians;
    const deltaLng = (toLng - fromLng) * radians;
    const y = Math.sin(deltaLng) * Math.cos(lat2);
    const x =
        Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
    return normalizeDegrees(Math.atan2(y, x) / radians);
}

export function cardinalLabel(bearing) {
    const normalized = normalizeDegrees(bearing);
    return normalized === null
        ? ""
        : CARDINAL_LABELS[Math.round(normalized / 45) % CARDINAL_LABELS.length];
}

export function formatApproxDistance(meters) {
    if (!Number.isFinite(meters) || meters < 0) return "";
    if (meters < 1000) return `${Math.round(meters)} m`;
    const kilometers = meters / 1000;
    return `${kilometers < 10 ? kilometers.toFixed(1) : Math.round(kilometers)} km`;
}

export function orientationHeadingFromEvent(event) {
    const webkitHeading = event?.webkitCompassHeading;
    const webkitAccuracy = event?.webkitCompassAccuracy;
    if (
        Number.isFinite(webkitHeading) &&
        (!Number.isFinite(webkitAccuracy) || webkitAccuracy >= 0)
    )
        return normalizeDegrees(webkitHeading);
    if (event?.absolute === true && Number.isFinite(event.alpha))
        return normalizeDegrees(360 - event.alpha);
    return null;
}

export function preferredHeading(position, deviceHeading) {
    const rawGpsHeading = position?.heading;
    const gpsHeading =
        Number.isFinite(rawGpsHeading) && rawGpsHeading >= 0
            ? normalizeDegrees(rawGpsHeading)
            : null;
    const speed = position?.speed;
    if (gpsHeading !== null && (!Number.isFinite(speed) || speed > 0.5))
        return gpsHeading;
    return normalizeDegrees(deviceHeading);
}

