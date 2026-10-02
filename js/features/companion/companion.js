// Runtime-only switch and derived rendering for the focused on-trip view. It
// deliberately does not change planner selection, filters, preview state,
// URLs, or browser history. Only explicit visit toggles persist trip data.

import { $, esc } from "../../shared/dom.js";
import {
    store,
    spotIsEnabled,
    travelLeg,
} from "../../core/store.js";
import { render } from "../planner/render.js";
import {
    drawMap,
    invalidateMainMap,
} from "../map/map.js";
import { resolveTravelForLeg } from "../timeline/travel-resolver.js";
import { registerBasemapMap } from "../map/basemap.js";
import { derivedPlanOperation, setFieldIntent } from "../../core/plan-operation-commit.js";
import { timeToMinutes, minutesToTime } from "../../core/time.js";
import {
    buildDayForecast,
    formatDurationMinutes,
    visitLegs,
    departureCue,
} from "./day-forecast.js";
import {
    localDateKey,
    normalizeDegrees,
    haversineMeters,
    initialBearingDegrees,
    cardinalLabel,
    formatApproxDistance,
    orientationHeadingFromEvent,
    preferredHeading,
    directionsUrl,
    TRAVEL_MODE_ICONS,
} from "./navigation.js";
import { TRAVEL_MODE_LABELS } from "../../core/travel-leg-presentation.js";

export {
    localDateKey,
    normalizeDegrees,
    haversineMeters,
    initialBearingDegrees,
    cardinalLabel,
    formatApproxDistance,
    orientationHeadingFromEvent,
    preferredHeading,
};
export { buildTimelineProjection } from "../timeline/timeline.js";

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
let mappedDayId = null;
let mapNeedsStopFit = true;
let didInitialCenter = false;
let wakeLock = null;
let wakeLockIntent = false;
let wakeLockStatus = "idle";
let wakeLockRequestToken = 0;
let minuteClock = null;
let lastRenderedMinute = null;
let companionMarkers = new Map();
let expandedNoteKey = null;
let lastVisitChange = null;
let undoTimer = null;
let dockObserver = null;
let heroVisible = true;
let mapReturnFocus = null;

const UNDO_WINDOW_MS = 12000;

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
const WAKE_LOCK_COPY = {
    idle: "La pantalla puede apagarse.",
    requesting: "Manteniendo la pantalla activa…",
    active: "Pantalla activa durante la ruta.",
    paused: "Pantalla activa en pausa mientras la pestaña está oculta.",
    unavailable: "Este navegador no permite mantener la pantalla activa.",
    error: "No se pudo mantener la pantalla activa.",
};

const COMPANION_DEFAULT_VIEW = [20, 0];

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

function wakeLockApi() {
    try {
        const api = navigator.wakeLock;
        return api && typeof api.request === "function" ? api : null;
    } catch {
        return null;
    }
}

function updateWakeLockControls() {
    const status = $("#companionWakeStatus");
    const button = $("#companionWakeBtn");
    const available = Boolean(wakeLockApi());
    const active = wakeLockStatus === "active";
    status.textContent = WAKE_LOCK_COPY[wakeLockStatus];
    status.dataset.state = wakeLockStatus;
    button.disabled = !available || wakeLockStatus === "requesting";
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
    const label = !available
        ? "Pantalla activa no disponible"
        : active
          ? "Permitir que la pantalla se apague"
          : "Mantener la pantalla activa";
    button.setAttribute("aria-label", label);
    button.title = label;
}

function setWakeLockStatus(status) {
    if (!Object.hasOwn(WAKE_LOCK_COPY, status)) status = "error";
    wakeLockStatus = status;
    updateWakeLockControls();
}

export async function requestCompanionWakeLock() {
    const api = wakeLockApi();
    if (!api) {
        wakeLockIntent = false;
        setWakeLockStatus("unavailable");
        return false;
    }
    if (!companionActive || document.hidden) return false;
    wakeLockIntent = true;
    if (wakeLock) return true;

    const token = ++wakeLockRequestToken;
    setWakeLockStatus("requesting");
    try {
        const sentinel = await api.request("screen");
        if (
            token !== wakeLockRequestToken ||
            !wakeLockIntent ||
            !companionActive ||
            document.hidden
        ) {
            await sentinel.release();
            return false;
        }
        wakeLock = sentinel;
        sentinel.addEventListener("release", () => {
            if (wakeLock !== sentinel) return;
            wakeLock = null;
            if (!wakeLockIntent) setWakeLockStatus("idle");
            else if (document.hidden) setWakeLockStatus("paused");
            else {
                wakeLockIntent = false;
                setWakeLockStatus("error");
            }
        });
        setWakeLockStatus("active");
        return true;
    } catch {
        if (token !== wakeLockRequestToken) return false;
        wakeLock = null;
        wakeLockIntent = false;
        setWakeLockStatus("error");
        return false;
    }
}

export async function releaseCompanionWakeLock({ preserveIntent = false } = {}) {
    wakeLockRequestToken += 1;
    if (!preserveIntent) wakeLockIntent = false;
    const sentinel = wakeLock;
    wakeLock = null;
    if (sentinel) {
        try {
            await sentinel.release();
        } catch {
            // Releasing an already-released sentinel is harmless for this UI.
        }
    }
    setWakeLockStatus(preserveIntent ? "paused" : "idle");
}

function updateLocationControls() {
    const status = $("#companionLocationStatus");
    const button = $("#companionLocationBtn");
    const available = Boolean(geolocationApi());
    status.textContent = LOCATION_COPY[locationStatus];
    status.dataset.state = locationStatus;

    const pending = locationStatus === "requesting";
    const active = locationStatus === "active";
    button.disabled = !available || pending;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
    const label = !available
        ? "Ubicación no disponible"
        : active
          ? "Desactivar ubicación"
          : locationStatus === "idle"
            ? "Activar ubicación"
            : "Reintentar ubicación";
    const icon = !available
        ? "×"
        : active || locationStatus === "idle"
            ? "⌖"
            : "↻";
    const iconNode = document.createElement("span");
    iconNode.className = "companion-tool-icon";
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

export function validVisitedAt(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function spotName(spot) {
    return stringValue(spot?.name).trim() || "Parada sin nombre";
}

function clockLabel(minutes) {
    return minutesToTime(minutes, { wrap: true });
}

function visitedClock(spot) {
    if (!validVisitedAt(spot?.visitedAt)) return "";
    const date = new Date(spot.visitedAt);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// Travel mode of the leg that reaches a stop, so "Cómo llegar" opens Maps in
// the mode the plan expects (walking, transit, driving...).
function incomingMode(spot) {
    const day = selectedDay();
    const enabled = enabledStops(day);
    const index = enabled.indexOf(spot);
    if (index <= 0) return null;
    const from = enabled[index - 1];
    return travelLeg(from.id, spot.id)?.mode || resolveTravelForLeg(from, spot)?.profile || null;
}

export function enabledStops(day) {
    return Array.isArray(day?.spots) ? day.spots.filter(spotIsEnabled) : [];
}

function visitStops(day) {
    const enabled = enabledStops(day);
    return enabled.filter((spot, index) => {
        const incoming = index > 0 ? travelLeg(enabled[index - 1].id, spot.id) : null;
        const outgoing = index < enabled.length - 1 ? travelLeg(spot.id, enabled[index + 1].id) : null;
        return !incoming?.embeddedEndpoints?.includes("to") && !outgoing?.embeddedEndpoints?.includes("from");
    });
}

export function visitProgress(day) {
    const enabled = visitStops(day);
    const visited = enabled.filter((spot) => validVisitedAt(spot.visitedAt));
    return { enabled, visited, completed: visited.length, total: enabled.length };
}

export function nextUnvisitedStop(day) {
    return (
        visitStops(day).find((spot) => !validVisitedAt(spot.visitedAt)) || null
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
    registerBasemapMap(companionMap);
    companionStopLayer = L.layerGroup().addTo(companionMap);
    companionPositionLayer = L.layerGroup().addTo(companionMap);
    // The map card changes size with the sticky desktop layout, rotations and
    // the mobile dock; Leaflet only repaints missing tiles when told.
    if (typeof ResizeObserver === "function") {
        new ResizeObserver(() => {
            if (companionActive && companionMap)
                companionMap.invalidateSize({ pan: false, animate: false });
        }).observe(mapElement);
    }
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

function stopPopup(spot, state, number) {
    const name = esc(spotName(spot));
    const detail = stringValue(spot.address || spot.note).trim();
    const label =
        state === "visited"
            ? `Visitada${visitedClock(spot) ? ` a las ${visitedClock(spot)}` : ""}`
            : state === "next"
              ? "Siguiente parada"
              : "Pendiente";
    const link = directionsUrl(spot, incomingMode(spot));
    const spotId = esc(String(spot.id));
    const actions = [
        link
            ? `<a class="companion-popup-link" href="${esc(link)}" target="_blank" rel="noopener">Cómo llegar <span aria-hidden="true">↗</span></a>`
            : "",
        state !== "visited" && !store.readOnly
            ? `<button class="companion-popup-visit" type="button" data-companion-action="toggle-visit" data-spot-id="${spotId}"><span aria-hidden="true">✓</span> Visitada</button>`
            : "",
    ].join("");
    return `<div class="companion-popup"><small class="companion-map-popup-state">${number}. ${label}</small><b>${name}</b>${detail ? `<small>${esc(detail)}</small>` : ""}${actions ? `<div class="companion-popup-actions">${actions}</div>` : ""}</div>`;
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
    if (!companionMap || !companionPosition || didInitialCenter || !mapContainerIsVisible()) return;
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

// Straight-line distance to the next stop, only while location is active.
// Being close highlights the visit button as a gentle nudge.
function updateNavigationUi() {
    const next = nextLocatedStop();
    const distanceNode = $("#companionDistance");
    const visitButton = $("#companionNextStop .companion-visit-action");
    const distance = next && companionPosition
        ? haversineMeters(companionPosition.lat, companionPosition.lng, next.lat, next.lng)
        : null;
    if (distanceNode) {
        distanceNode.hidden = !Number.isFinite(distance);
        distanceNode.textContent = Number.isFinite(distance)
            ? `a ${formatApproxDistance(distance)}`
            : "";
    }
    const isNear = Number.isFinite(distance) &&
        distance <= 100 &&
        companionPosition.accuracy <= 100;
    visitButton?.classList.toggle("is-near", isNear);
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
    updateNavigationUi();
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
        updateNavigationUi();
        setLocationStatus("error");
        return false;
    }
}

export function stopLocation({ preserveIntent = false } = {}) {
    clearLocationWatch();
    if (!preserveIntent) locationIntent = false;
    clearCompanionPosition({ resetCenter: !preserveIntent });
    updateNavigationUi();
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

function fitCompanionStops() {
    if (!ensureCompanionMap()) return;
    const points = enabledStops(selectedDay())
        .filter(locatedSpot)
        .map((spot) => [spot.lat, spot.lng]);
    if (companionPosition) points.push([companionPosition.lat, companionPosition.lng]);
    fitStopPoints(points);
    didInitialCenter = true;
}

export function drawCompanionMap() {
    // Fitting a hidden (0×0) map zooms it out to the world; the sheet redraws
    // and reframes the day when it opens.
    if (!ensureCompanionMap() || !mapContainerIsVisible()) return false;

    const day = selectedDay();
    const dayChanged = mappedDayId !== day?.id;
    if (dayChanged) {
        mappedDayId = day?.id || null;
        mapNeedsStopFit = true;
        // The next stop belongs to the newly selected day, so the previous
        // position/stop framing is no longer useful even if location is active.
        didInitialCenter = false;
    }

    companionStopLayer.clearLayers();
    companionMarkers = new Map();
    const enabled = enabledStops(day);
    const next = nextUnvisitedStop(day);
    const located = enabled.filter(locatedSpot);
    const points = located.map((spot) => [spot.lat, spot.lng]);

    // Direct, synchronous segments communicate order and progress without
    // sharing the main map's OSRM requests, cache, instance, or route layers:
    // walked legs are solid, the leg towards the next stop is highlighted.
    located.slice(1).forEach((spot, index) => {
        const from = located[index];
        const done = validVisitedAt(spot.visitedAt);
        const active = spot === next;
        L.polyline([[from.lat, from.lng], [spot.lat, spot.lng]], {
            color: done ? "#386f66" : active ? "#b4352d" : "#6c7479",
            weight: done || active ? 4 : 2.5,
            opacity: done ? 0.75 : active ? 0.9 : 0.55,
            dashArray: done ? null : active ? "8 8" : "4 8",
            interactive: false,
        }).addTo(companionStopLayer);
    });

    located.forEach((spot) => {
        const visited = validVisitedAt(spot.visitedAt);
        const state = visited ? "visited" : spot === next ? "next" : "remaining";
        const number = enabled.indexOf(spot) + 1;
        const marker = L.marker([spot.lat, spot.lng], {
            icon: stopMarkerIcon(number, state),
            title: spotName(spot),
            zIndexOffset: state === "next" ? 1000 : visited ? -100 : 0,
        })
            .addTo(companionStopLayer)
            .bindPopup(stopPopup(spot, state, number));
        companionMarkers.set(String(spot.id), marker);
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

function announce(message) {
    $("#companionVisitStatus").textContent = message;
}

function clearUndo() {
    clearTimeout(undoTimer);
    undoTimer = null;
    lastVisitChange = null;
}

export function toggleVisit(spotId, checked) {
    const day = selectedDay();
    const spot = day?.spots.find((candidate) => String(candidate.id) === spotId);
    if (!spot || !spotIsEnabled(spot)) return false;
    const name = spotName(spot);

    const visitedAt = checked ? new Date().toISOString() : undefined;
    void derivedPlanOperation((document) => setFieldIntent(
        document,
        { type: "spot", id: spotId, field: "visitedAt" },
        visitedAt,
        { remove: !checked },
    )).then(() => {
        clearUndo();
        if (checked) {
            lastVisitChange = { spotId, name };
            undoTimer = setTimeout(() => {
                if (lastVisitChange?.spotId !== spotId) return;
                lastVisitChange = null;
                if (companionActive) renderCompanion();
            }, UNDO_WINDOW_MS);
        }
        renderCompanion();
        // Completing a stop changes the navigation target. Frame the user and
        // the new next stop together instead of leaving the map on the old one.
        didInitialCenter = false;
        if (companionMap) drawCompanionMap();
        const updatedDay = selectedDay();
        const { completed, total } = visitProgress(updatedDay);
        const next = nextUnvisitedStop(updatedDay);
        const mutation = checked
            ? `${name} marcada como visitada.`
            : `${name} vuelve a estar pendiente.`;
        const nextMessage = next
            ? ` Siguiente parada: ${spotName(next)}.`
            : total ? " Día completado." : "";
        announce(`${mutation} Progreso: ${completed} de ${total}.${nextMessage}`);
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
    if (!date) return title;
    const formattedDate = formatCompanionDate(date);
    const dateLabel = date === localDateKey() ? `Hoy · ${formattedDate}` : formattedDate;
    return `${dateLabel} · ${title}`;
}

export function formatCompanionDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
    if (!match) return stringValue(value);
    const [, year, month, day] = match;
    const date = new Date(Number(year), Number(month) - 1, Number(day), 12);
    if (
        date.getFullYear() !== Number(year) ||
        date.getMonth() !== Number(month) - 1 ||
        date.getDate() !== Number(day)
    )
        return value;
    return new Intl.DateTimeFormat("es-ES", {
        weekday: "short",
        day: "numeric",
        month: "short",
    })
        .format(date)
        .replace(/\.$/, "");
}


function dayContextNotice(day) {
    if (!day || day.date === localDateKey()) return "";
    const selectedDate = esc(formatCompanionDate(day.date) || "este día");
    const today = store.state.find((candidate) => candidate.date === localDateKey());
    if (!today)
        return `<p class="companion-today-notice">No hay un día planificado para hoy. Estás viendo ${selectedDate}.</p>`;
    const todayTitle = esc(
        stringValue(today.title, "Día sin título").trim() || "Día sin título",
    );
    return `<p class="companion-today-notice">Estás viendo ${selectedDate}. El itinerario de hoy es «${todayTitle}».</p>`;
}

function renderDaySelector(day) {
    const select = $("#companionDaySelect");
    select.replaceChildren();
    const index = store.state.indexOf(day);
    $("#companionPrevDay").disabled = index <= 0;
    $("#companionNextDay").disabled = index === -1 || index >= store.state.length - 1;
    $("#companionDayPosition").textContent = index === -1
        ? "Elegir día"
        : `Día ${index + 1} de ${store.state.length}`;

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

function dayForecast(day) {
    const stops = new Set(visitStops(day));
    return buildDayForecast(day, {
        travelForLeg: resolveTravelForLeg,
        isVisitStop: (spot) => stops.has(spot),
    });
}

function legSummary(leg) {
    if (!leg) return "";
    const icon = TRAVEL_MODE_ICONS[leg.mode] || TRAVEL_MODE_ICONS.other;
    const label = leg.line || TRAVEL_MODE_LABELS[leg.mode] || TRAVEL_MODE_LABELS.other;
    const minutes = leg.minutes > 0 && !leg.missingDuration
        ? ` ${leg.approximate ? "~" : ""}${formatDurationMinutes(leg.minutes)}`
        : "";
    const departure = leg.departureTime ? `, sale ${leg.departureTime}` : "";
    return `<span class="companion-leg"><span aria-hidden="true">${icon}</span> ${esc(label)}${esc(minutes)}${esc(departure)}</span>`;
}

// Notes the traveller wrote for this moment (platform, entrance, what to
// order). Long ones collapse to a few lines; the open one survives the
// once-per-minute repaint.
function noteMarkup(value, label, key) {
    const text = stringValue(value).trim();
    if (!text) return "";
    const expanded = expandedNoteKey === key;
    return `<button class="companion-note${expanded ? " is-expanded" : ""}" type="button" data-companion-action="toggle-note" data-note-key="${esc(key)}" aria-expanded="${expanded}"><span class="companion-note-label">${esc(label)}</span><span class="companion-note-text">${esc(text)}</span></button>`;
}

function undoMarkup() {
    if (!lastVisitChange) return "";
    return `<div class="companion-undo" role="status"><span><span aria-hidden="true">✓</span> ${esc(lastVisitChange.name)} hecha</span><button type="button" data-companion-action="undo-visit" data-spot-id="${esc(lastVisitChange.spotId)}">Deshacer</button></div>`;
}

function nextDayAfter(day) {
    const index = store.state.indexOf(day);
    return index === -1 ? null : store.state[index + 1] || null;
}

// One line, only when something is really at risk: a stop-specific problem
// first (closing, reservation, departure), otherwise a meaningful delay.
function heroAlert(forecast, next) {
    const warning = forecast.warnings.find(
        (candidate) => candidate.spot === next && candidate.type !== "tight",
    );
    if (warning) return warning.message;
    if (forecast.pace.status === "late")
        return `Vas con ${formatDurationMinutes(forecast.pace.minutes)} de retraso.`;
    return "";
}

function renderNextStop(day, forecast, progress) {
    const card = $("#companionNextStop");
    const next = forecast?.current?.spot || nextUnvisitedStop(day);
    const notice = dayContextNotice(day);
    const complete = Boolean(day && progress.total > 0 && !next);
    card.classList.toggle("is-complete", complete);
    card.classList.toggle("is-empty", !day || progress.total === 0);

    if (!day) {
        card.innerHTML = `<h3 id="companionNextTitle">Todavía no hay días planificados</h3><p>Añade un día y sus paradas desde el planificador.</p><div class="companion-next-actions"><button class="companion-secondary-action" type="button" data-companion-action="exit">Volver al plan</button></div>`;
        return;
    }

    if (progress.total === 0) {
        card.innerHTML = `${notice}<h3 id="companionNextTitle">No hay paradas para este día</h3><p>Puedes añadirlas o activarlas desde el planificador.</p>`;
        return;
    }

    if (complete) {
        const tomorrow = nextDayAfter(day);
        const action = tomorrow
            ? `<div class="companion-next-actions"><button class="companion-secondary-action" type="button" data-companion-action="select-day" data-day-id="${esc(String(tomorrow.id))}">Ver ${esc(stringValue(tomorrow.title).trim() || "el día siguiente")} <span aria-hidden="true">→</span></button></div>`
            : "";
        card.innerHTML = `${undoMarkup()}${notice}<span class="companion-kicker">Día completado</span><h3 id="companionNextTitle">¡Todo visto por hoy!</h3><p>${progress.total} de ${progress.total} paradas hechas.</p>${action}`;
        return;
    }

    const item = forecast.liveItem(next);
    const isToday = day.date === localDateKey();
    const now = localMinutes();
    const inProgress = isToday && item && !item.waypoint && now >= item.start && now < item.end;
    const position = progress.enabled.indexOf(next) + 1;
    const name = esc(spotName(next));
    const leg = visitLegs(forecast.live.items, (spot) => progress.enabled.includes(spot)).get(next);
    const alert = heroAlert(forecast, next);
    const link = directionsUrl(next, incomingMode(next));
    const spotId = esc(String(next.id));
    const cue = item
        ? departureCue({
            start: item.start,
            end: item.end,
            legMinutes: leg && !leg.missingDuration ? leg.minutes : 0,
            departureTime: leg?.departureTime,
            now,
            isToday,
            waypoint: item.waypoint,
        })
        : null;
    const cueMarkup = cue
        ? `<p class="companion-cue">${cue.lead ? `<span>${esc(cue.lead)}</span> ` : ""}${cue.time ? `<span class="companion-time">${esc(cue.time)}</span>` : ""}${cue.relative ? ` <span class="companion-cue-relative">· ${esc(cue.relative)}</span>` : ""}</p>`
        : "";
    const meta = [
        legSummary(leg),
        '<span id="companionDistance" class="companion-distance" hidden></span>',
    ].filter(Boolean).join("");
    const notes = [
        leg?.note ? noteMarkup(leg.note, "Tramo", `leg-${next.id}`) : "",
        noteMarkup(next.note, "Nota", `spot-${next.id}`),
    ].join("");
    const directions = link
        ? `<a class="companion-directions" href="${esc(link)}" target="_blank" rel="noopener" aria-label="Cómo llegar a ${name} en Google Maps; se abre en una pestaña nueva"><span aria-hidden="true">➜</span> Cómo llegar</a>`
        : "";
    const done = store.readOnly
        ? ""
        : `<button class="companion-visit-action" type="button" data-companion-action="toggle-visit" data-spot-id="${spotId}"><span aria-hidden="true">✓</span> Hecho</button>`;

    card.innerHTML = `${undoMarkup()}${notice}<span class="companion-kicker">${inProgress ? "Ahora" : "Siguiente"} · ${position} de ${progress.total}</span><h3 id="companionNextTitle">${name}</h3>${cueMarkup}<p class="companion-next-meta">${meta}</p>${notes}${alert ? `<p class="companion-alert" role="note"><span aria-hidden="true">!</span> ${esc(alert)}</p>` : ""}<div class="companion-next-actions">${directions}${done}</div>`;
}

function renderChecklist(day, forecast, progress) {
    const list = $("#companionChecklist");
    const stops = progress.enabled;
    if (!day || !stops.length) {
        list.innerHTML = "";
        list.hidden = true;
        return;
    }
    list.hidden = false;
    const next = forecast.current?.spot || null;
    const readOnly = store.readOnly;
    list.innerHTML = stops.map((spot) => {
        const name = esc(spotName(spot));
        const visited = validVisitedAt(spot.visitedAt);
        const state = visited ? "is-visited" : spot === next ? "is-next" : "is-remaining";
        const item = forecast.liveItem(spot);
        const time = visited ? visitedClock(spot) : item ? clockLabel(item.start) : "";
        const reservation = spot.fixedStart && spot.plannedStart && !visited
            ? '<small>reserva</small>'
            : "";
        const spotId = esc(String(spot.id));
        return `<li class="companion-stop ${state}"><label><input type="checkbox" data-companion-action="toggle-visit" data-spot-id="${spotId}" ${visited ? "checked" : ""} ${readOnly ? "disabled" : ""} aria-label="${visited ? "Desmarcar" : "Marcar"} ${name} como hecha"><span class="companion-stop-mark" aria-hidden="true">${visited ? "✓" : ""}</span><span class="companion-stop-time">${time}</span><span class="companion-stop-name">${name}${reservation}</span></label></li>`;
    }).join("");
}

function renderDock(day, forecast) {
    const dock = $("#companionDock");
    const next = forecast?.current?.spot || null;
    if (!day || !next) {
        dock.hidden = true;
        dock.innerHTML = "";
        updateDockVisibility();
        return;
    }
    const link = directionsUrl(next, incomingMode(next));
    const spotId = esc(String(next.id));
    const name = esc(spotName(next));
    dock.hidden = false;
    dock.innerHTML = `<button class="companion-dock-copy" type="button" data-companion-action="scroll-hero"><small>Siguiente</small><strong>${name}</strong></button>${link ? `<a class="companion-dock-go" href="${esc(link)}" target="_blank" rel="noopener" aria-label="Cómo llegar a ${name}; se abre en una pestaña nueva"><span aria-hidden="true">➜</span></a>` : ""}${store.readOnly ? "" : `<button class="companion-dock-done" type="button" data-companion-action="toggle-visit" data-spot-id="${spotId}" aria-label="Marcar ${name} como hecha"><span aria-hidden="true">✓</span></button>`}`;
    updateDockVisibility();
}

function updateDockVisibility() {
    const dock = $("#companionDock");
    const visible = companionActive && !dock.hidden && !heroVisible && $("#companionMapSheet").hidden;
    dock.classList.toggle("is-visible", visible);
    document.body.classList.toggle("companion-dock-visible", visible);
}

function observeHero() {
    dockObserver?.disconnect();
    if (typeof IntersectionObserver !== "function") return;
    dockObserver = new IntersectionObserver(([entry]) => {
        heroVisible = entry.isIntersecting;
        updateDockVisibility();
    }, { threshold: 0.05 });
    dockObserver.observe($("#companionNextStop"));
}

// The sheet covers the whole view, so keyboard and screen reader users must
// not wander into the hidden day behind it.
function setBehindSheetInert(inert) {
    const sheet = $("#companionMapSheet");
    for (const child of companionView.children)
        if (child !== sheet) child.inert = inert;
}

function openMapSheet(trigger = null) {
    const sheet = $("#companionMapSheet");
    if (!sheet.hidden) return;
    mapReturnFocus = trigger;
    sheet.hidden = false;
    setBehindSheetInert(true);
    document.body.classList.add("companion-map-open");
    updateDockVisibility();
    revealCompanionMap();
    requestAnimationFrame(() => $("#companionMapClose").focus({ preventScroll: true }));
}

function closeMapSheet() {
    const sheet = $("#companionMapSheet");
    if (sheet.hidden) return;
    sheet.hidden = true;
    setBehindSheetInert(false);
    document.body.classList.remove("companion-map-open");
    updateDockVisibility();
    (mapReturnFocus?.isConnected ? mapReturnFocus : $("#companionMapBtn")).focus({ preventScroll: true });
    mapReturnFocus = null;
}

// Re-rendering replaces the hero and route markup; keep keyboard users on the
// control they were using (or its successor for the same stop).
function focusKey() {
    const active = document.activeElement;
    if (!active || !companionView.contains(active)) return null;
    if (active.id) return { id: active.id };
    if (active.dataset?.companionAction)
        return { action: active.dataset.companionAction, spotId: active.dataset.spotId || "" };
    return null;
}

function restoreFocus(key) {
    if (!key) return;
    const current = document.activeElement;
    if (current && current !== document.body && companionView.contains(current)) return;
    // An undone visit makes its stop current again: land on its visit button.
    const action = key.action === "undo-visit" ? "toggle-visit" : key.action;
    const target = key.id
        ? document.getElementById(key.id)
        : [...companionView.querySelectorAll(`[data-companion-action="${action}"]`)]
            .find((candidate) => (candidate.dataset.spotId || "") === key.spotId);
    target?.focus({ preventScroll: true });
}

export function renderCompanion() {
    const focus = focusKey();
    const day = ensureSelectedDay();
    const progress = visitProgress(day);
    const forecast = day ? dayForecast(day) : null;
    lastRenderedMinute = localMinutes();

    renderDaySelector(day);
    const isToday = day?.date === localDateKey();
    $("#companionEyebrow").textContent = day?.date
        ? `${isToday ? "Hoy · " : ""}${formatCompanionDate(day.date)}`
        : "Modo en ruta";
    heading.textContent = day
        ? stringValue(day.title, "Día sin título").trim() || "Día sin título"
        : "Tu día en ruta";
    $("#companionProgressText").textContent = progress.total
        ? `${progress.completed} de ${progress.total}`
        : "";
    $("#companionRouteHead").hidden = !progress.total;

    renderNextStop(day, forecast, progress);
    renderChecklist(day, forecast, progress);
    renderDock(day, forecast);
    updateNavigationUi();
    updateMapSummary();

    // Never replace this element's children after Leaflet owns it.
    if (!companionMap)
        $("#companionMap").textContent = day
            ? "El mapa del día se mostrará aquí."
            : "Añade un día para disponer del mapa en ruta.";
    restoreFocus(focus);
}

function selectCompanionDay(dayId) {
    const day = store.state.find((candidate) => String(candidate.id) === String(dayId));
    if (!day) return;
    selectedDayId = day.id;
    clearUndo();
    renderCompanion();
    if (companionMap) drawCompanionMap();
}

function stepDay(offset) {
    const index = store.state.findIndex((day) => day.id === selectedDayId);
    const target = store.state[index + offset];
    if (target) selectCompanionDay(target.id);
}

// Times and "ahora" depend on the clock, so repaint once per minute.
function tickClock() {
    if (!companionActive || document.hidden) return;
    if (localMinutes() !== lastRenderedMinute) renderCompanion();
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
    wakeLockStatus = wakeLockApi() ? "idle" : "unavailable";
    updateLocationControls();
    updateWakeLockControls();
    heroVisible = true;
    renderCompanion();
    observeHero();
    clearInterval(minuteClock);
    minuteClock = setInterval(tickClock, 15000);
    mapNeedsStopFit = true;

    requestAnimationFrame(() => {
        if (companionActive && !companionView.hidden) heading.focus();
    });
}

export function exitCompanion() {
    if (!companionActive) return;
    closeMapSheet();
    companionActive = false;
    clearInterval(minuteClock);
    minuteClock = null;
    clearUndo();
    dockObserver?.disconnect();
    dockObserver = null;
    updateDockVisibility();
    stopLocation();
    releaseCompanionWakeLock();

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
    if (event.target.closest("#companionWakeBtn")) {
        if (wakeLockIntent) releaseCompanionWakeLock();
        else requestCompanionWakeLock();
        return;
    }
    if (event.target.closest("#companionLocationBtn")) {
        if (locationIntent) stopLocation();
        else startLocation();
        return;
    }
    if (event.target.closest("#companionMapBtn")) {
        openMapSheet(event.target.closest("#companionMapBtn"));
        return;
    }
    if (event.target.closest("#companionMapClose")) {
        closeMapSheet();
        return;
    }
    if (event.target.closest("#companionRecenterBtn")) {
        recenterCompanionMap();
        return;
    }
    if (event.target.closest("#companionFitBtn")) {
        fitCompanionStops();
        return;
    }
    if (event.target.closest("#companionPrevDay")) {
        stepDay(-1);
        return;
    }
    if (event.target.closest("#companionNextDay")) {
        stepDay(1);
        return;
    }
    const action = event.target.closest("[data-companion-action]");
    if (!action) {
        if (event.target.closest("#companionExitBtn")) exitCompanion();
        return;
    }
    switch (action.dataset.companionAction) {
        case "toggle-visit":
            // Checkboxes report through "change"; buttons are explicit visits.
            if (action.matches("button")) toggleVisit(action.dataset.spotId, true);
            break;
        case "toggle-note":
            expandedNoteKey = expandedNoteKey === action.dataset.noteKey ? null : action.dataset.noteKey;
            action.classList.toggle("is-expanded", expandedNoteKey === action.dataset.noteKey);
            action.setAttribute("aria-expanded", String(expandedNoteKey === action.dataset.noteKey));
            break;
        case "undo-visit":
            toggleVisit(action.dataset.spotId, false);
            break;
        case "select-day":
            selectCompanionDay(action.dataset.dayId);
            requestAnimationFrame(() => heading.focus({ preventScroll: true }));
            window.scrollTo({ top: 0, behavior: reducedMotionPreferred() ? "auto" : "smooth" });
            break;
        case "scroll-hero":
            $("#companionNextStop").scrollIntoView({ behavior: reducedMotionPreferred() ? "auto" : "smooth", block: "start" });
            break;
        case "exit":
            exitCompanion();
            break;
    }
}

function handleCompanionKeydown(event) {
    if (event.key === "Escape" && !$("#companionMapSheet").hidden) {
        event.preventDefault();
        closeMapSheet();
    }
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
    selectCompanionDay(event.target.value);
}

export function initCompanion() {
    if (initialized) return;
    initialized = true;
    enterButton.addEventListener("click", enterCompanion);
    companionView.addEventListener("click", handleCompanionClick);
    companionView.addEventListener("change", handleCompanionChange);
    companionView.addEventListener("keydown", handleCompanionKeydown);
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            if (companionActive && locationIntent)
                stopLocation({ preserveIntent: true });
            if (companionActive && wakeLockIntent)
                releaseCompanionWakeLock({ preserveIntent: true });
            return;
        }
        if (companionActive) tickClock();
        if (companionActive && locationIntent) startLocation();
        if (companionActive && wakeLockIntent) requestCompanionWakeLock();
    });
    locationStatus = geolocationApi() ? "idle" : "unavailable";
    wakeLockStatus = wakeLockApi() ? "idle" : "unavailable";
    updateLocationControls();
    updateWakeLockControls();
}

export function isCompanionActive() {
    return companionActive;
}
