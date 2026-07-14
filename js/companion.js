// Runtime-only switch and derived rendering for the focused on-trip view. It
// deliberately does not change planner selection, filters, preview state,
// URLs, browser history, or persisted data.

import { $, esc } from "./dom.js";
import { store, save, spotIsEnabled } from "./store.js";
import { render } from "./render.js";
import { drawMap, invalidateMainMap, mapsLinkFor } from "./map.js";

let companionActive = false;
let selectedDayId = null;
let initialized = false;
let companionMap = null;
let companionStopLayer = null;
let companionPositionLayer = null;
let companionPosition = null;
let locationIntent = false;
let locationStatus = "idle";
let watchId = null;
let orientationHeading = null;
let orientationListening = false;
let orientationEventName = null;
let orientationPermission = "unknown";
let compassFrame = null;
let pendingCompassAngle = null;
let displayedCompassAngle = null;
let compassTargetId = null;
let mappedDayId = null;
let mapNeedsStopFit = true;
let didInitialCenter = false;

const LOCATION_OPTIONS = {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 5000,
};
const LOCATION_COPY = {
    idle: "Ubicación sin activar.",
    requesting: "Solicitando acceso a tu ubicación…",
    active: "Ubicación activa.",
    denied:
        "No has permitido acceder a tu ubicación. El itinerario sigue disponible.",
    unavailable:
        "La ubicación no está disponible en este dispositivo o navegador.",
    timeout:
        "La ubicación está tardando demasiado. Puedes volver a intentarlo.",
    error: "No se pudo obtener tu ubicación. Puedes volver a intentarlo.",
};

const COMPANION_TILE_URL =
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const COMPANION_TILE_ATTRIBUTION = "© OpenStreetMap";
const COMPANION_DEFAULT_VIEW = [20, 0];
const EARTH_RADIUS_METERS = 6371000;
const CARDINAL_LABELS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];

const plannerView = $("#plannerView");
const companionView = $("#companionView");
const enterButton = $("#companionEnterBtn");
const heading = $("#companionHeading");
const top = document.querySelector(".top");

function geolocationApi() {
    try {
        const api = navigator.geolocation;
        return api &&
            typeof api.watchPosition === "function" &&
            typeof api.clearWatch === "function"
            ? api
            : null;
    } catch {
        return null;
    }
}

function updateLocationControls() {
    const status = $("#companionLocationStatus");
    const button = $("#companionLocationBtn");
    const available = Boolean(geolocationApi());
    status.textContent = LOCATION_COPY[locationStatus];
    status.dataset.state = locationStatus;

    const pending = locationStatus === "requesting";
    const active = locationStatus === "active";
    button.closest(".companion-location").hidden = active;
    button.disabled = !available || pending || active;
    const label = !available
        ? "Ubicación no disponible"
        : active
          ? "Ubicación activa"
          : locationStatus === "idle"
            ? "Activar ubicación"
            : "Reintentar ubicación";
    const icon = !available
        ? "×"
        : active
          ? "✓"
          : locationStatus === "idle"
            ? "⌖"
            : "↻";
    const iconNode = document.createElement("span");
    iconNode.setAttribute("aria-hidden", "true");
    iconNode.textContent = icon;
    button.replaceChildren(iconNode);
    button.setAttribute("aria-label", label);
    button.title = label;
}

function setLocationStatus(status) {
    if (!Object.hasOwn(LOCATION_COPY, status)) status = "error";
    if (locationStatus === status) return;
    locationStatus = status;
    updateLocationControls();
}

function stringValue(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
}

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

function validCoordinatePair(lat, lng) {
    return (
        Number.isFinite(lat) &&
        Number.isFinite(lng) &&
        lat >= -90 &&
        lat <= 90 &&
        lng >= -180 &&
        lng <= 180
    );
}

export function haversineMeters(fromLat, fromLng, toLat, toLng) {
    if (
        !validCoordinatePair(fromLat, fromLng) ||
        !validCoordinatePair(toLat, toLng)
    )
        return null;
    const radians = Math.PI / 180;
    const lat1 = fromLat * radians;
    const lat2 = toLat * radians;
    const deltaLat = (toLat - fromLat) * radians;
    const deltaLng = (toLng - fromLng) * radians;
    const sinLat = Math.sin(deltaLat / 2);
    const sinLng = Math.sin(deltaLng / 2);
    const a = Math.min(
        1,
        Math.max(
            0,
            sinLat * sinLat +
                Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng,
        ),
    );
    return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

export function validVisitedAt(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function enabledStops(day) {
    return Array.isArray(day?.spots) ? day.spots.filter(spotIsEnabled) : [];
}

export function visitProgress(day) {
    const enabled = enabledStops(day);
    const visited = enabled.filter((spot) => validVisitedAt(spot.visitedAt));
    return { enabled, visited, completed: visited.length, total: enabled.length };
}

export function nextUnvisitedStop(day) {
    return (
        enabledStops(day).find((spot) => !validVisitedAt(spot.visitedAt)) || null
    );
}

// Backlog is never considered because it is stored separately from state.
export function resolveCompanionDay(now = new Date()) {
    const days = Array.isArray(store.state) ? store.state : [];
    const today = localDateKey(now);
    const exact = days.find((day) => day.date === today) || null;
    const active = days.find((day) => day.id === store.active) || null;
    return {
        day: exact || active || days[0] || null,
        hasToday: Boolean(exact),
        today,
    };
}

function selectedDay() {
    return store.state.find((day) => day.id === selectedDayId) || null;
}

function locatedSpot(spot) {
    return Number.isFinite(spot?.lat) && Number.isFinite(spot?.lng);
}

function mapContainerIsVisible() {
    if (!companionActive || companionView.hidden) return false;
    const mapElement = $("#companionMap");
    const bounds = mapElement.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0;
}

function ensureCompanionMap() {
    if (companionMap) return true;
    if (!mapContainerIsVisible()) return false;

    const mapElement = $("#companionMap");
    mapElement.textContent = "";
    mapElement.classList.remove("companion-map-placeholder");
    mapElement.classList.add("companion-map");

    const reducedMotion = reducedMotionPreferred();
    companionMap = L.map(mapElement, {
        zoomControl: false,
        fadeAnimation: !reducedMotion,
        markerZoomAnimation: !reducedMotion,
        zoomAnimation: !reducedMotion,
    }).setView(
        COMPANION_DEFAULT_VIEW,
        2,
    );
    L.control.zoom({ position: "bottomright" }).addTo(companionMap);
    L.tileLayer(COMPANION_TILE_URL, {
        attribution: COMPANION_TILE_ATTRIBUTION,
    }).addTo(companionMap);
    companionStopLayer = L.layerGroup().addTo(companionMap);
    companionPositionLayer = L.layerGroup().addTo(companionMap);
    return true;
}

function stopMarkerIcon(number, state) {
    const size = state === "next" ? 38 : 32;
    return L.divIcon({
        className: `companion-map-marker companion-map-marker--${state}`,
        html: `<span><b>${number}</b></span>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size],
        popupAnchor: [0, -size + 2],
    });
}

function stopPopup(spot, state) {
    const name = esc(
        stringValue(spot.name, "Parada sin nombre") || "Parada sin nombre",
    );
    const detail = stringValue(spot.note || spot.address).trim();
    const label =
        state === "visited"
            ? "Visitada"
            : state === "next"
              ? "Siguiente parada"
              : "Pendiente";
    return `<b>${name}</b><br><small class="companion-map-popup-state">${label}</small>${detail ? `<br><small>${esc(detail)}</small>` : ""}`;
}

function fitStopPoints(points) {
    if (!points.length) {
        companionMap.setView(COMPANION_DEFAULT_VIEW, 2);
        return;
    }
    if (points.length === 1) {
        companionMap.setView(points[0], 15);
        return;
    }
    companionMap.fitBounds(points, { padding: [38, 38], maxZoom: 15 });
}

function nextLocatedStop() {
    const next = nextUnvisitedStop(selectedDay());
    return locatedSpot(next) ? next : null;
}

function centerOnPositionAndNext() {
    if (!companionMap || !companionPosition || didInitialCenter) return;
    const positionPoint = [companionPosition.lat, companionPosition.lng];
    const next = nextLocatedStop();
    if (next) {
        companionMap.fitBounds(
            [positionPoint, [next.lat, next.lng]],
            { padding: [42, 42], maxZoom: 16 },
        );
    } else {
        companionMap.setView(positionPoint, 16);
    }
    didInitialCenter = true;
}

function drawCompanionPosition() {
    if (!companionPositionLayer) return;
    companionPositionLayer.clearLayers();
    if (!companionPosition) return;

    const point = [companionPosition.lat, companionPosition.lng];
    if (companionPosition.accuracy > 0) {
        L.circle(point, {
            radius: companionPosition.accuracy,
            color: "#386f66",
            weight: 1,
            opacity: 0.8,
            fillColor: "#386f66",
            fillOpacity: 0.12,
            interactive: false,
        }).addTo(companionPositionLayer);
    }
    L.circleMarker(point, {
        radius: 7,
        color: "#fff",
        weight: 3,
        fillColor: "#386f66",
        fillOpacity: 1,
    })
        .addTo(companionPositionLayer)
        .bindPopup("<b>Tu ubicación</b>");
}

function validPosition(value) {
    return (
        Number.isFinite(value?.lat) &&
        Number.isFinite(value?.lng) &&
        value.lat >= -90 &&
        value.lat <= 90 &&
        value.lng >= -180 &&
        value.lng <= 180 &&
        Number.isFinite(value?.accuracy) &&
        value.accuracy > 0
    );
}

function reducedMotionPreferred() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function shortestAngleDelta(from, to) {
    return ((to - from + 540) % 360) - 180;
}

function scheduleCompassRotation(angle) {
    const normalized = normalizeDegrees(angle);
    if (normalized === null) return;
    pendingCompassAngle = normalized;
    if (compassFrame !== null) return;
    compassFrame = requestAnimationFrame(() => {
        compassFrame = null;
        const arrow = $("#companionCompassArrow");
        if (!arrow || pendingCompassAngle === null) return;
        if (displayedCompassAngle === null || reducedMotionPreferred()) {
            displayedCompassAngle = pendingCompassAngle;
        } else {
            displayedCompassAngle +=
                shortestAngleDelta(displayedCompassAngle, pendingCompassAngle);
        }
        arrow.style.transform = `rotate(${displayedCompassAngle}deg)`;
    });
}

function resetCompassAnimation(targetId = null) {
    if (compassFrame !== null) cancelAnimationFrame(compassFrame);
    compassFrame = null;
    pendingCompassAngle = null;
    displayedCompassAngle = null;
    compassTargetId = targetId;
}

function updateNavigationUi() {
    const next = nextLocatedStop();
    const panel = $("#companionCompassPanel");
    if (!panel || !next) {
        if (compassTargetId !== null) resetCompassAnimation();
        return;
    }

    const targetId = String(next.id);
    if (compassTargetId !== targetId) resetCompassAnimation(targetId);

    const distanceNode = $("#companionDistanceText");
    const directionNode = $("#companionDirectionText");
    const proximityNode = $("#companionProximity");
    const visitButton = panel
        .closest("#companionNextStop")
        ?.querySelector(".companion-visit-action");
    const distance = companionPosition
        ? haversineMeters(
              companionPosition.lat,
              companionPosition.lng,
              next.lat,
              next.lng,
          )
        : null;
    const bearing = companionPosition
        ? initialBearingDegrees(
              companionPosition.lat,
              companionPosition.lng,
              next.lat,
              next.lng,
          )
        : null;

    if (distance === null || bearing === null) {
        resetCompassAnimation(targetId);
        const arrow = $("#companionCompassArrow");
        if (arrow) arrow.style.transform = "rotate(0deg)";
        distanceNode.textContent =
            "Activa tu ubicación para calcular la distancia aproximada.";
        directionNode.textContent = "Dirección pendiente de ubicación.";
        proximityNode.hidden = true;
        visitButton?.classList.remove("is-near");
        visitButton?.removeAttribute("aria-describedby");
        return;
    }

    const cardinal = cardinalLabel(bearing);
    const deviceHeading = preferredHeading(
        companionPosition,
        orientationHeading,
    );
    const arrowAngle =
        deviceHeading === null
            ? bearing
            : normalizeDegrees(bearing - deviceHeading);
    distanceNode.textContent = `Distancia aproximada en línea recta: ${formatApproxDistance(distance)}.`;
    directionNode.textContent =
        deviceHeading === null
            ? `Dirección ${cardinal} (referencia norte).`
            : `Dirección ${cardinal}, brújula orientada al dispositivo.`;
    scheduleCompassRotation(arrowAngle);

    const isNear =
        distance <= 100 &&
        Number.isFinite(companionPosition.accuracy) &&
        companionPosition.accuracy <= 100;
    proximityNode.hidden = !isNear;
    visitButton?.classList.toggle("is-near", isNear);
    if (isNear) visitButton?.setAttribute("aria-describedby", "companionProximity");
    else visitButton?.removeAttribute("aria-describedby");
}

function handleOrientation(event) {
    if (!companionActive || !locationIntent || document.hidden) return;
    const heading = orientationHeadingFromEvent(event);
    if (heading === null) return;
    orientationHeading = heading;
    updateNavigationUi();
}

function orientationApi() {
    try {
        return window.DeviceOrientationEvent || null;
    } catch {
        return null;
    }
}

function attachOrientationListener() {
    if (orientationListening || document.hidden || !companionActive) return;
    const api = orientationApi();
    if (!api) return;
    const needsPermission = typeof api.requestPermission === "function";
    if (needsPermission && orientationPermission !== "granted") return;
    orientationEventName =
        !needsPermission && "ondeviceorientationabsolute" in window
            ? "deviceorientationabsolute"
            : "deviceorientation";
    window.addEventListener(orientationEventName, handleOrientation);
    orientationListening = true;
}

function startOrientation() {
    const api = orientationApi();
    if (!api) return;
    if (typeof api.requestPermission !== "function") {
        orientationPermission = "not-required";
        attachOrientationListener();
        return;
    }
    if (orientationPermission === "granted") {
        attachOrientationListener();
        return;
    }
    if (
        orientationPermission === "denied" ||
        orientationPermission === "requesting"
    )
        return;

    orientationPermission = "requesting";
    try {
        Promise.resolve(api.requestPermission())
            .then((result) => {
                orientationPermission =
                    result === "granted" ? "granted" : "denied";
                if (
                    orientationPermission === "granted" &&
                    companionActive &&
                    locationIntent &&
                    !document.hidden
                )
                    attachOrientationListener();
            })
            .catch(() => {
                orientationPermission = "denied";
            });
    } catch {
        orientationPermission = "denied";
    }
}

function stopOrientation() {
    if (orientationListening && orientationEventName)
        window.removeEventListener(orientationEventName, handleOrientation);
    orientationListening = false;
    orientationEventName = null;
    orientationHeading = null;
    resetCompassAnimation(compassTargetId);
    updateNavigationUi();
}

function updateAccuracy() {
    const accuracy = $("#companionLocationAccuracy");
    if (!companionPosition) {
        accuracy.hidden = true;
        accuracy.textContent = "";
        return;
    }
    accuracy.hidden = false;
    accuracy.textContent = `Precisión aproximada: ${Math.round(companionPosition.accuracy)} m`;
}

function updateMapSummary() {
    const summary = $("#companionMapSummary");
    if (!summary) return;
    const day = selectedDay();
    if (!day) {
        summary.textContent = "Mapa suplementario sin un día planificado.";
        return;
    }
    const enabled = enabledStops(day);
    const located = enabled.filter(locatedSpot);
    const next = nextUnvisitedStop(day);
    const nextText = next
        ? ` Siguiente parada: ${stringValue(next.name, "Parada sin nombre") || "Parada sin nombre"}.`
        : enabled.length
          ? " Todas las paradas activas están visitadas."
          : " No hay paradas activas.";
    const positionText = companionPosition
        ? " Tu posición y su precisión se muestran en el mapa."
        : " Tu posición no está activa.";
    summary.textContent = `${located.length} de ${enabled.length} paradas tienen ubicación.${nextText}${positionText}`;
}

function clearCompanionPosition({ resetCenter = false } = {}) {
    companionPosition = null;
    $("#companionRecenterBtn").disabled = true;
    updateAccuracy();
    updateNavigationUi();
    updateMapSummary();
    if (resetCenter) didInitialCenter = false;
    if (companionPositionLayer) companionPositionLayer.clearLayers();
}

// Runtime-only seam: accepted readings never enter store/localStorage and only
// update compact sensor UI plus the companion's dedicated position layer.
export function setCompanionPosition(value) {
    if (!validPosition(value)) {
        clearCompanionPosition({ resetCenter: true });
        return false;
    }
    companionPosition = {
        lat: value.lat,
        lng: value.lng,
        accuracy: value.accuracy,
        heading: Number.isFinite(value.heading) ? value.heading : null,
        speed: Number.isFinite(value.speed) ? value.speed : null,
        timestamp: Number.isFinite(value.timestamp) ? value.timestamp : Date.now(),
    };
    $("#companionRecenterBtn").disabled = false;
    updateAccuracy();
    updateNavigationUi();
    updateMapSummary();

    if (!ensureCompanionMap()) return true;
    drawCompanionPosition();
    centerOnPositionAndNext();
    return true;
}

function acceptPosition(reading) {
    if (!companionActive || !locationIntent || document.hidden) return;
    const coords = reading?.coords;
    const value = {
        lat: coords?.latitude,
        lng: coords?.longitude,
        accuracy: coords?.accuracy,
        heading: coords?.heading,
        speed: coords?.speed,
        timestamp: reading?.timestamp,
    };
    if (!validPosition(value)) {
        handleLocationError({ code: 0 });
        return;
    }
    setCompanionPosition(value);
    setLocationStatus("active");
}

function clearLocationWatch() {
    if (watchId === null) return;
    const id = watchId;
    watchId = null;
    try {
        geolocationApi()?.clearWatch(id);
    } catch {
        // Cleanup is deliberately idempotent even with partial browser mocks.
    }
}

function handleLocationError(error) {
    if (!companionActive || !locationIntent || document.hidden) {
        clearLocationWatch();
        return;
    }
    clearLocationWatch();
    clearCompanionPosition();
    stopOrientation();
    const code = Number(error?.code);
    if (code === 1) {
        locationIntent = false;
        setLocationStatus("denied");
    } else if (code === 2) {
        setLocationStatus("unavailable");
    } else if (code === 3) {
        setLocationStatus("timeout");
    } else {
        setLocationStatus("error");
    }
}

export function startLocation() {
    const api = geolocationApi();
    if (!api) {
        locationIntent = false;
        setLocationStatus("unavailable");
        return false;
    }
    if (!companionActive || document.hidden) return false;
    locationIntent = true;
    startOrientation();
    if (watchId !== null) return true;

    setLocationStatus("requesting");
    try {
        let synchronousError = null;
        let starting = true;
        const id = api.watchPosition(
            acceptPosition,
            (error) => {
                if (starting) synchronousError = error;
                else handleLocationError(error);
            },
            LOCATION_OPTIONS,
        );
        starting = false;
        watchId = id;
        if (synchronousError) {
            handleLocationError(synchronousError);
            return false;
        }
        return true;
    } catch {
        watchId = null;
        stopOrientation();
        setLocationStatus("error");
        return false;
    }
}

export function stopLocation({ preserveIntent = false } = {}) {
    clearLocationWatch();
    if (!preserveIntent) locationIntent = false;
    clearCompanionPosition({ resetCenter: !preserveIntent });
    stopOrientation();
    if (preserveIntent) {
        locationStatus = "idle";
        $("#companionLocationStatus").textContent =
            "Ubicación en pausa mientras esta pestaña está oculta.";
        $("#companionLocationStatus").dataset.state = "idle";
        $("#companionLocationBtn").disabled = true;
    } else {
        setLocationStatus("idle");
        updateLocationControls();
    }
}

function recenterCompanionMap() {
    if (!companionPosition || !ensureCompanionMap()) return;
    const zoom = Math.min(Math.max(companionMap.getZoom(), 15), 18);
    companionMap.setView([companionPosition.lat, companionPosition.lng], zoom, {
        animate: !reducedMotionPreferred(),
    });
    didInitialCenter = true;
}

export function drawCompanionMap() {
    if (!ensureCompanionMap()) return false;

    const day = selectedDay();
    const dayChanged = mappedDayId !== day?.id;
    if (dayChanged) {
        mappedDayId = day?.id || null;
        mapNeedsStopFit = true;
        if (!companionPosition) didInitialCenter = false;
    }

    companionStopLayer.clearLayers();
    const enabled = enabledStops(day);
    const next = nextUnvisitedStop(day);
    const located = enabled.filter(locatedSpot);
    const points = located.map((spot) => [spot.lat, spot.lng]);

    // A direct, synchronous line communicates itinerary order without sharing
    // the main map's OSRM requests, cache, instance, or route layers.
    if (points.length > 1) {
        L.polyline(points, {
            color: "#6c7479",
            weight: 2,
            opacity: 0.65,
            dashArray: "5 7",
            interactive: false,
        }).addTo(companionStopLayer);
    }

    located.forEach((spot) => {
        const visited = validVisitedAt(spot.visitedAt);
        const state = visited ? "visited" : spot === next ? "next" : "remaining";
        const number = enabled.indexOf(spot) + 1;
        L.marker([spot.lat, spot.lng], {
            icon: stopMarkerIcon(number, state),
            title: stringValue(spot.name, "Parada sin nombre"),
        })
            .addTo(companionStopLayer)
            .bindPopup(stopPopup(spot, state));
    });

    drawCompanionPosition();
    if (companionPosition) centerOnPositionAndNext();
    else if (mapNeedsStopFit) fitStopPoints(points);
    mapNeedsStopFit = false;
    return true;
}

function revealCompanionMap() {
    requestAnimationFrame(() => {
        if (!companionActive || !drawCompanionMap()) return;
        requestAnimationFrame(() => {
            if (!companionActive || !companionMap) return;
            companionMap.invalidateSize({ pan: false, animate: false });
        });
    });
}

export function toggleVisit(spotId, checked) {
    const day = selectedDay();
    const spot = day?.spots.find((candidate) => String(candidate.id) === spotId);
    if (!spot || !spotIsEnabled(spot)) return false;

    if (checked) spot.visitedAt = new Date().toISOString();
    else delete spot.visitedAt;

    save();
    renderCompanion();
    drawCompanionMap();
    const { completed, total } = visitProgress(day);
    const next = nextUnvisitedStop(day);
    const name = stringValue(spot.name, "Parada sin nombre") || "Parada sin nombre";
    requestAnimationFrame(() => {
        const checkbox = [...companionView.querySelectorAll(
            'input[data-companion-action="toggle-visit"]',
        )].find((candidate) => candidate.dataset.spotId === spotId);
        checkbox?.focus();
        const status = $("#companionVisitStatus");
        const mutation = checked
            ? `${name} marcada como visitada.`
            : `${name} vuelve a estar pendiente.`;
        const nextMessage = next
            ? ` Siguiente parada: ${stringValue(next.name, "Parada sin nombre") || "Parada sin nombre"}.`
            : total
              ? " Día completado."
              : "";
        status.textContent = `${mutation} Progreso: ${completed} de ${total}.${nextMessage}`;
    });
    return true;
}

function ensureSelectedDay() {
    const current = selectedDay();
    if (current) return current;
    const resolved = resolveCompanionDay();
    selectedDayId = resolved.day?.id || null;
    return resolved.day;
}

function dayLabel(day) {
    const title = stringValue(day?.title, "Día sin título").trim() || "Día sin título";
    const date = stringValue(day?.date).trim();
    return date ? `${date} · ${title}` : title;
}

function renderDaySelector(day) {
    const select = $("#companionDaySelect");
    select.replaceChildren();

    if (!store.state.length) {
        const option = document.createElement("option");
        option.textContent = "No hay días planificados";
        select.append(option);
        select.disabled = true;
        return;
    }

    store.state.forEach((candidate) => {
        const option = document.createElement("option");
        option.value = String(candidate.id);
        option.textContent = dayLabel(candidate);
        option.selected = candidate.id === day?.id;
        select.append(option);
    });
    select.disabled = false;
}

function localMinutes(now = new Date()) {
    return now.getHours() * 60 + now.getMinutes();
}

function timeMinutes(value) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value || "")) return null;
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
}

export function scheduleCue(spot, now = new Date()) {
    const opening = stringValue(spot?.openingTime);
    const closing = stringValue(spot?.closingTime);
    const openingMinutes = timeMinutes(opening);
    const closingMinutes = timeMinutes(closing);

    if (openingMinutes !== null && closingMinutes !== null) {
        if (openingMinutes >= closingMinutes)
            return `Horario guardado: ${opening}–${closing}`;
        const current = localMinutes(now);
        if (current < openingMinutes) return `Abre a las ${opening}`;
        if (current >= closingMinutes)
            return `El horario guardado termina a las ${closing}`;
        return `Horario guardado: ${opening}–${closing}`;
    }
    if (openingMinutes !== null) return `Horario guardado: desde ${opening}`;
    if (closingMinutes !== null) return `Horario guardado: hasta ${closing}`;
    return "";
}

function todayNotice() {
    return store.state.some((day) => day.date === localDateKey())
        ? ""
        : '<p class="companion-today-notice">No hay un día planificado para hoy</p>';
}

function renderNextStop(day, next, total, completed) {
    const card = $("#companionNextStop");
    const notice = todayNotice();
    card.classList.toggle("is-complete", Boolean(day && total > 0 && !next));

    if (!day) {
        card.innerHTML = `<span class="companion-kicker">Itinerario</span><h3 id="companionNextTitle">Todavía no hay días planificados</h3><p>Añade un día y sus paradas desde el planificador.</p><button class="companion-plan-action" type="button" data-companion-action="exit">Volver al plan</button>`;
        return;
    }

    if (total === 0) {
        card.innerHTML = `${notice}<span class="companion-kicker">Siguiente parada</span><h3 id="companionNextTitle">No hay paradas activas para este día</h3><p>Puedes activar o añadir paradas desde el planificador.</p>`;
        return;
    }

    if (!next) {
        card.innerHTML = `${notice}<span class="companion-kicker">Día completado</span><h3 id="companionNextTitle">¡Has visitado todas las paradas!</h3><p>${completed} de ${total} paradas completadas. Puedes desmarcar una visita desde la lista si necesitas recuperarla.</p>`;
        return;
    }

    const name = esc(stringValue(next.name, "Parada sin nombre") || "Parada sin nombre");
    const address = stringValue(next.address).trim();
    const note = stringValue(next.note).trim();
    const schedule = scheduleCue(next);
    const mapsLink = mapsLinkFor(next);
    const details = [
        address
            ? `<p class="companion-next-address"><strong>Dirección:</strong> ${esc(address)}</p>`
            : "",
        note ? `<p class="companion-next-note">${esc(note)}</p>` : "",
        schedule
            ? `<p class="companion-schedule"><span aria-hidden="true">◷</span> ${esc(schedule)}</p>`
            : "",
    ].join("");
    const directions = mapsLink
        ? `<a class="companion-directions" href="${mapsLink}" target="_blank" rel="noopener" aria-label="Cómo llegar a ${name} en Google Maps; se abre en una pestaña nueva">Cómo llegar <span aria-hidden="true">↗</span></a>`
        : '<p class="companion-no-location">Esta parada no tiene ubicación guardada.</p>';
    const compass = locatedSpot(next)
        ? `<section id="companionCompassPanel" class="companion-navigation" aria-label="Orientación hacia la siguiente parada"><div class="companion-compass" aria-hidden="true"><span class="companion-compass-north">N</span><span id="companionCompassArrow" class="companion-compass-arrow">↑</span></div><div class="companion-navigation-copy"><p id="companionDirectionText">Dirección pendiente de ubicación.</p><p id="companionDistanceText">Activa tu ubicación para calcular la distancia aproximada.</p><p id="companionProximity" class="companion-proximity" role="status" hidden>Estás cerca</p></div></section>`
        : "";
    const spotId = esc(String(next.id));

    card.innerHTML = `${notice}<span class="companion-kicker">Siguiente parada</span><h3 id="companionNextTitle">${name}</h3>${details}${compass}<div class="companion-next-actions">${directions}<button class="companion-visit-action" type="button" data-companion-action="toggle-visit" data-spot-id="${spotId}"><span aria-hidden="true">✓</span> Marcar como visitada</button></div>`;
}

function renderChecklist(day, enabled, next) {
    const list = $("#companionChecklist");
    if (!day) {
        list.innerHTML = "<li>No hay un itinerario que mostrar.</li>";
        return;
    }
    if (!enabled.length) {
        list.innerHTML = "<li>No hay paradas activas en este día.</li>";
        return;
    }

    list.innerHTML = enabled
        .map((spot) => {
            const name = esc(stringValue(spot.name, "Parada sin nombre") || "Parada sin nombre");
            const address = stringValue(spot.address).trim();
            const visited = validVisitedAt(spot.visitedAt);
            const isNext = spot === next;
            const state = visited ? "Visitada" : isNext ? "Siguiente" : "Pendiente";
            const classes = visited
                ? "is-visited"
                : isNext
                  ? "is-next"
                  : "is-remaining";
            const spotId = esc(String(spot.id));
            return `<li class="companion-stop ${classes}"><label class="companion-stop-toggle"><input type="checkbox" data-companion-action="toggle-visit" data-spot-id="${spotId}" ${visited ? "checked" : ""} aria-label="${visited ? "Desmarcar" : "Marcar"} ${name} como visitada"><span class="companion-stop-state" aria-hidden="true">${visited ? "✓" : isNext ? "→" : "○"}</span></label><span class="companion-stop-copy"><strong>${name}</strong>${address ? `<small>${esc(address)}</small>` : ""}</span><span class="companion-stop-label">${state}</span></li>`;
        })
        .join("");
}

export function renderCompanion() {
    const day = ensureSelectedDay();
    const { enabled, completed, total } = visitProgress(day);
    const next = nextUnvisitedStop(day);

    renderDaySelector(day);
    heading.textContent = day
        ? `Tu día en ruta: ${stringValue(day.title, "Día sin título") || "Día sin título"}`
        : "Tu día en ruta";

    const progressText = $("#companionProgressText");
    progressText.textContent = `${completed} de ${total} ${total === 1 ? "parada" : "paradas"}`;
    const progressBar = $("#companionProgressBar");
    progressBar.max = Math.max(total, 1);
    progressBar.value = completed;
    progressBar.setAttribute(
        "aria-label",
        `Progreso de visitas: ${completed} de ${total}`,
    );

    renderNextStop(day, next, total, completed);
    renderChecklist(day, enabled, next);
    updateNavigationUi();
    updateMapSummary();

    // Never replace this element's children after Leaflet owns it.
    if (!companionMap)
        $("#companionMap").textContent = day
            ? "El mapa del día se mostrará aquí."
            : "Añade un día para disponer del mapa en ruta.";
}

export function enterCompanion() {
    if (companionActive) return;
    companionActive = true;
    selectedDayId = resolveCompanionDay().day?.id || null;

    const topActions = top.querySelector(".top-actions");
    const navToggle = $("#navToggle");
    topActions?.classList.remove("nav-open");
    navToggle?.setAttribute("aria-expanded", "false");
    navToggle?.setAttribute("aria-label", "Abrir menú");

    document.body.classList.add("companion-mode");
    plannerView.hidden = true;
    plannerView.inert = true;
    top.inert = true;
    companionView.hidden = false;
    companionView.inert = false;
    locationStatus = geolocationApi() ? "idle" : "unavailable";
    updateLocationControls();
    renderCompanion();
    mapNeedsStopFit = true;
    revealCompanionMap();

    requestAnimationFrame(() => {
        if (companionActive && !companionView.hidden) heading.focus();
    });
}

export function exitCompanion() {
    if (!companionActive) return;
    companionActive = false;
    stopLocation();

    companionView.hidden = true;
    companionView.inert = true;
    plannerView.hidden = false;
    plannerView.inert = false;
    top.inert = false;
    document.body.classList.remove("companion-mode");

    render();
    invalidateMainMap();
    drawMap();
    enterButton.focus();
}

function handleCompanionClick(event) {
    if (event.target.closest("#companionLocationBtn")) {
        startLocation();
        return;
    }
    if (event.target.closest("#companionRecenterBtn")) {
        recenterCompanionMap();
        return;
    }
    const visitButton = event.target.closest(
        'button[data-companion-action="toggle-visit"]',
    );
    if (visitButton) {
        toggleVisit(visitButton.dataset.spotId, true);
        return;
    }
    if (event.target.closest('[data-companion-action="exit"], #companionExitBtn'))
        exitCompanion();
}

function handleCompanionChange(event) {
    if (
        event.target.matches(
            'input[type="checkbox"][data-companion-action="toggle-visit"]',
        )
    ) {
        toggleVisit(event.target.dataset.spotId, event.target.checked);
        return;
    }
    if (!event.target.matches("#companionDaySelect")) return;
    const day = store.state.find((candidate) => String(candidate.id) === event.target.value);
    if (!day) return;
    selectedDayId = day.id;
    renderCompanion();
    drawCompanionMap();
}

export function initCompanion() {
    if (initialized) return;
    initialized = true;
    enterButton.addEventListener("click", enterCompanion);
    companionView.addEventListener("click", handleCompanionClick);
    companionView.addEventListener("change", handleCompanionChange);
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            if (companionActive && locationIntent)
                stopLocation({ preserveIntent: true });
            return;
        }
        if (companionActive && locationIntent) startLocation();
    });
    locationStatus = geolocationApi() ? "idle" : "unavailable";
    updateLocationControls();
}

export function isCompanionActive() {
    return companionActive;
}
