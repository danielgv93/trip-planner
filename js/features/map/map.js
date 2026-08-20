// Leaflet maps: the main #map (active day's route or the global preview) and the
// small #previewMap inside the add/edit dialog. Also owns real-distance routing
// (OSRM) with a bounded persistent cache. Depends on the Leaflet global `L` (loaded via a
// classic <script> before this deferred module runs).
//
import {
    store,
    save,
    dayBy,
    categoryMeta,
    categoryConnects,
    spotMatchesFilter,
    spotIsEnabled,
    routeTimeOverride,
    travelLeg,
} from "../../core/store.js";
import { AUTOMATIC_TRAVEL_MODES, travelLegKey } from "../../core/travel-legs.js";
import { $, esc, safeColor } from "../../shared/dom.js";
import { DAY_COLORS } from "../../core/constants.js";
import { distanceMeters } from "../../core/geo.js";
import { fetchSpotImage } from "./images.js";
import { registerBasemapMap } from "./basemap.js";
import { createRouteCache } from "./route-cache.js";
import { highlightItinerarySpot } from "../planner/spot-highlight.js";

const usesCoarsePointer = window.matchMedia("(pointer: coarse)").matches;
const map = L.map("map", {
    dragging: !usesCoarsePointer,
    zoomControl: false,
}).setView([20, 0], 2);
L.control.zoom({ position: "bottomright" }).addTo(map);
registerBasemapMap(map);
let routeLayer = L.layerGroup().addTo(map);
let legendControl = null;
// Rebuilt with the map layers. Lets itinerary/timeline UI point at the
// corresponding marker without putting transient hover state in the store.
const spotMarkers = new Map();
let highlightedSpotId = null;
// Same idea for the drawn route: the geometry of every consecutive pair, keyed
// by travelLegKey(). The highlight is painted as an extra polyline on its own
// layer instead of restyling the base line, so straight and street routes (and
// manual legs, which are drawn differently) all work through one code path.
const legGeometry = new Map();
const legHighlightLayer = L.layerGroup().addTo(map);
let highlightedLegKey = null;

function registerLegGeometry(fromSpot, toSpot, points, color) {
    if (!points?.length) return;
    legGeometry.set(travelLegKey(fromSpot.id, toSpot.id), { points, color });
}

export function highlightMapLeg(fromId, toId, highlighted = true) {
    const key = fromId === null || fromId === undefined
        ? null
        : travelLegKey(fromId, toId);
    if (highlightedLegKey && (!highlighted || highlightedLegKey !== key)) {
        legHighlightLayer.clearLayers();
        highlightedLegKey = null;
    }

    if (!key || !highlighted || highlightedLegKey === key) return;
    const geometry = legGeometry.get(key);
    if (!geometry) return;
    L.polyline(geometry.points, {
        color: geometry.color,
        weight: 9,
        opacity: 0.34,
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
    }).addTo(legHighlightLayer);
    L.polyline(geometry.points, {
        color: geometry.color,
        weight: 4,
        opacity: 1,
        interactive: false,
    }).addTo(legHighlightLayer);
    highlightedLegKey = key;
}

function registerSpotMarker(spot, marker) {
    const id = String(spot.id);
    spotMarkers.set(id, marker);
    // Mirror image of highlightMapSpot(): pointing at a marker lights up the
    // itinerary stop. Leaflet's mouseover/mouseout are pointer-only, so touch
    // devices are unaffected.
    marker.on("mouseover", () => highlightItinerarySpot(id, true));
    marker.on("mouseout", () => highlightItinerarySpot(id, false));
}

export function highlightMapSpot(spotId, highlighted = true) {
    const id = String(spotId);
    if (!highlighted && highlightedSpotId !== id) return;

    if (highlightedSpotId && highlightedSpotId !== id) {
        const previous = spotMarkers.get(highlightedSpotId);
        previous?.setZIndexOffset(0);
        previous?.getElement()?.classList.remove("is-spot-highlighted");
        highlightedSpotId = null;
    }

    const marker = spotMarkers.get(id);
    if (!marker) return;
    marker.setZIndexOffset(highlighted ? 1000 : 0);
    marker.getElement()?.classList.toggle("is-spot-highlighted", highlighted);
    highlightedSpotId = highlighted ? id : null;
}

export function invalidateMainMap() {
    map.invalidateSize({ pan: false, animate: false });
}

// Keyed by `fromCoord|toCoord|profile`. Successful OSRM responses survive page
// reloads in a bounded device-local cache; approximate fallbacks stay in memory.
// Persistence is resolved at read/write time rather than at import time, so a
// public visitor — whose `readOnly` flag is set after this module evaluates —
// gets the in-memory cache without leaving anything on their device.
const routeCache = createRouteCache({
    storage: {
        getItem: (key) => (store.readOnly ? null : localStorage.getItem(key)),
        setItem: (key, value) => {
            if (!store.readOnly) localStorage.setItem(key, value);
        },
        removeItem: (key) => {
            if (!store.readOnly) localStorage.removeItem(key);
        },
    },
});
let routeCacheRevision = 0;

export function routeTravelRevision() { return routeCacheRevision; }
let routeTimer = null;
// Bumped on every ensureRoutes() call; a late response can warm the shared
// cache, but a stale token prevents it from painting the wrong day.
let routeToken = 0;

// Dialog preview-map instances (created lazily on first openPreview/setPreview).
let previewMap, previewLayer;
let readPreviewMap, readPreviewNode;

function encodedCoordinates(spot) {
    if (!Number.isFinite(spot?.lat) || !Number.isFinite(spot?.lng)) return null;
    return encodeURIComponent(`${spot.lat},${spot.lng}`);
}

export function mapsLinkFor(spot) {
    const coordinates = encodedCoordinates(spot);
    return coordinates
        ? `https://www.google.com/maps/search/?api=1&query=${coordinates}`
        : null;
}

export function dayDirectionsLink(spots) {
    const located = spots.map(encodedCoordinates).filter(Boolean);
    if (located.length < 2) return null;
    const params = [
        `origin=${located[0]}`,
        `destination=${located.at(-1)}`,
    ];
    if (located.length > 2)
        params.push(`waypoints=${located.slice(1, -1).join("%7C")}`);
    return `https://www.google.com/maps/dir/?api=1&${params.join("&")}`;
}

// Routing profile selector: cache is keyed by profile, so switching back to a
// previously-used mode reuses cached legs (no refetch).
$("#routeProfile").value = store.routeProfile;
$("#routeProfile").addEventListener("change", (e) => {
    store.routeProfile = e.target.value;
    save();
    drawMap();
});

export function syncRouteVisualizationControl() {
    $("#routeProfile").hidden = store.routeVisualization !== "streets";
}

$("#routeVisualization").value = store.routeVisualization;
syncRouteVisualizationControl();
$("#routeVisualization").addEventListener("change", (e) => {
    store.routeVisualization = e.target.value;
    syncRouteVisualizationControl();
    save();
    drawMap();
});

function icon(n, color) {
    return L.divIcon({
        className: "",
        html: `<div class="pin" style="background:${safeColor(color, "#d44d43")}"><span>${n}</span></div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 30],
        popupAnchor: [0, -29],
    });
}

function markerLabel(spots, spot) {
    const index = spots.indexOf(spot);
    const incoming = index > 0 ? travelLeg(spots[index - 1].id, spot.id) : null;
    const outgoing = index < spots.length - 1 ? travelLeg(spot.id, spots[index + 1].id) : null;
    if (incoming?.embeddedEndpoints?.includes("to")) return "◆";
    if (outgoing?.embeddedEndpoints?.includes("from")) return "●";
    return spots.slice(0, index + 1).filter((candidate, candidateIndex, sequence) => {
        const before = candidateIndex > 0 ? travelLeg(sequence[candidateIndex - 1].id, candidate.id) : null;
        const after = candidateIndex < sequence.length - 1 ? travelLeg(candidate.id, sequence[candidateIndex + 1].id) : null;
        return !before?.embeddedEndpoints?.includes("to") && !after?.embeddedEndpoints?.includes("from");
    }).length;
}

function removeLegend() {
    if (legendControl) {
        legendControl.remove();
        legendControl = null;
    }
}

function renderLegend(items) {
    if (!legendControl) {
        legendControl = L.control({ position: "topright" });
        legendControl.onAdd = () => {
            const div = L.DomUtil.create("div", "map-legend");
            L.DomEvent.disableClickPropagation(div);
            return div;
        };
        legendControl.addTo(map);
    }
    legendControl.getContainer().innerHTML = items
        .map(
            (it) =>
                `<span class="legend-item"><i style="background:${it.color}"></i>${esc(it.title)}</span>`,
        )
        .join("");
}

function drawGlobalMap() {
    $("#mapTitle").textContent = store.tripTitle || "Ruta completa del viaje";
    const allPoints = [],
        legendItems = [];
    let totalLocated = 0,
        totalSpots = 0;
    store.state.forEach((day, i) => {
        const visibleSpots = day.spots
            .filter(spotMatchesFilter)
            .filter(spotIsEnabled);
        totalSpots += visibleSpots.length;
        const located = visibleSpots.filter(
            (s) => Number.isFinite(s.lat) && Number.isFinite(s.lng),
        );
        totalLocated += located.length;
        if (!located.length) return;
        const color = DAY_COLORS[i % DAY_COLORS.length],
            points = located.map((s) => [s.lat, s.lng]),
            linePoints = located
                .filter((s) => categoryConnects(s.category))
                .map((s) => [s.lat, s.lng]);
        if (linePoints.length > 1)
            L.polyline(linePoints, {
                color,
                weight: 3,
                opacity: 0.9,
                dashArray: "7 7",
            }).addTo(routeLayer);
        located.forEach((s) => {
            const marker = L.marker([s.lat, s.lng], {
                icon: icon(
                    markerLabel(visibleSpots, s),
                    categoryMeta(s.category).color,
                ),
            })
                .addTo(routeLayer)
                .bindPopup(
                    `<b>${esc(day.title)}</b><br>${esc(s.name)}<br><small>${esc(s.note || s.address || "")}</small>`,
                );
            registerSpotMarker(s, marker);
        });
        allPoints.push(...points);
        legendItems.push({ title: day.title, color });
    });
    $("#mapSummary").innerHTML =
        `<b>${totalLocated}</b> de ${totalSpots} paradas ubicadas en ${store.state.length} ${store.state.length === 1 ? "día" : "días"}`;
    if (allPoints.length)
        map.fitBounds(allPoints, {
            padding: [45, 45],
            maxZoom: 14,
        });
    else map.setView([20, 0], 2);
    renderLegend(legendItems);
}

// ---- Routing (real distance/time between consecutive stops) ----
// Great-circle distance in km. Used as the offline/error fallback so a leg
// always has *some* number even when OSRM is unreachable.
function keyFor(from, to, profile) {
    return `${from.lat},${from.lng}|${to.lat},${to.lng}|${profile}`;
}

// Each public instance is preprocessed for one transport mode. The profile
// segment in OSRM's URL does not select that dataset at query time.
const ROUTING_SERVERS = {
    driving: "https://routing.openstreetmap.de/routed-car",
    cycling: "https://routing.openstreetmap.de/routed-bike",
    walking: "https://routing.openstreetmap.de/routed-foot",
};

// Same "needs network, degrades gracefully offline" posture as the Nominatim
// geocoding. Raw km/min are cached; formatting happens on paint.
async function fetchLeg(from, to, profile) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
        const server = ROUTING_SERVERS[profile] || ROUTING_SERVERS.driving;
        const r = await fetch(
            `${server}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`,
            { signal: controller.signal },
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (data.code !== "Ok" || !data.routes?.length)
            throw new Error("no route");
        const route = data.routes[0];
        return {
            km: route.distance / 1000,
            min: route.duration / 60,
            approx: false,
            points: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
        };
    } catch {
        return {
            km: distanceMeters(from, to) / 1000,
            min: null,
            approx: true,
        };
    } finally {
        clearTimeout(timeout);
    }
}

// Map rendering, timeline cards and the health check can request the same leg
// at the same time. Share that work and cache it as soon as it settles.
function fetchLegOnce(from, to, profile) {
    const key = keyFor(from, to, profile);
    return routeCache.getOrLoad(key, async () => {
        const leg = await fetchLeg(from, to, profile);
        routeCacheRevision += 1;
        return leg;
    });
}

// The routing legs MUST follow the drawn polyline, not "all located spots": a
// category with connects:false keeps its pin but the line (and therefore the
// route) skips it.
function connectingLocated(spots) {
    return spots.filter(
        (s) =>
            spotIsEnabled(s) &&
            Number.isFinite(s.lat) &&
            Number.isFinite(s.lng) &&
            categoryConnects(s.category),
    );
}

// Read-only synchronous walk of the day's connecting sequence against the
// in-memory route cache. Mirrors the leg loop in drawMap()/ensureRoutes() but
// never fetches or writes: it powers the day-head workload summary, which
// must stay a cheap render-time read. Returns null unless every leg of the
// sequence is cached with a measured (non-haversine) duration, and null when
// there are fewer than two connecting located stops (nothing to measure).
export function cachedDayTravelMinutes(day) {
    const seq = connectingLocated(day?.spots || []);
    if (seq.length < 2) return null;
    let total = 0;
    for (let i = 0; i < seq.length - 1; i++) {
        const configured = travelLeg(seq[i].id, seq[i + 1].id);
        if (Number.isInteger(configured?.durationMinutes)) {
            total += configured.durationMinutes;
            continue;
        }
        const profile = AUTOMATIC_TRAVEL_MODES.includes(configured?.mode) ? configured.mode : store.routeProfile;
        const leg = routeCache.get(
            keyFor(seq[i], seq[i + 1], profile),
        );
        const override = routeTimeOverride(
            seq[i].id,
            seq[i + 1].id,
            profile,
        );
        if (override !== null) {
            total += override;
            continue;
        }
        if (!leg || leg.min == null) return null;
        total += leg.min;
    }
    return total;
}

export function cachedRouteTravelMinutes(from, to, profile = "walking") {
    if (!from || !to) return null;
    const leg = routeCache.get(keyFor(from, to, profile));
    return leg?.min == null ? null : Math.max(1, Math.round(leg.min));
}

// Fetches the official OSRM duration for consecutive enabled stops used by a
// timeline. Unlike ensureRoutes(), this is independent of the active map and
// can therefore hydrate a timeline belonging to any visible day card.
export async function ensureRouteTravelTimes(spots, profile = "walking") {
    const sequence = Array.isArray(spots) ? spots.filter(spotIsEnabled) : [];
    const pending = [];
    for (let i = 0; i < sequence.length - 1; i++) {
        const from = sequence[i],
            to = sequence[i + 1];
        if (
            !Number.isFinite(from?.lat) ||
            !Number.isFinite(from?.lng) ||
            !Number.isFinite(to?.lat) ||
            !Number.isFinite(to?.lng)
        )
            continue;
        const key = keyFor(from, to, profile);
        if (!routeCache.has(key)) pending.push(fetchLegOnce(from, to, profile));
    }
    if (!pending.length) return;
    await Promise.all(pending);
}

function fmtKm(km) {
    return km >= 10 ? Math.round(km) : Math.round(km * 10) / 10;
}

function legLabel(leg) {
    return leg.approx
        ? `≈ ${fmtKm(leg.km)} km (aprox.)`
        : store.routeVisualization === "straight"
          ? `${fmtKm(leg.km)} km`
        : `${fmtKm(leg.km)} km · ${Math.round(leg.min)} min`;
}

function drawRouteLine(seq) {
    if (seq.length < 2) return;
    const style = {
        color: "#d44d43",
        weight: 3,
        opacity: 0.9,
        dashArray: "7 7",
    };
    if (store.routeVisualization === "straight") {
        L.polyline(seq.map((s) => [s.lat, s.lng]), style).addTo(routeLayer);
        for (let i = 0; i < seq.length - 1; i++)
            registerLegGeometry(seq[i], seq[i + 1], [
                [seq[i].lat, seq[i].lng],
                [seq[i + 1].lat, seq[i + 1].lng],
            ], style.color);
        return;
    }
    for (let i = 0; i < seq.length - 1; i++) {
        const configured = travelLeg(seq[i].id, seq[i + 1].id);
        const profile = AUTOMATIC_TRAVEL_MODES.includes(configured?.mode) ? configured.mode : store.routeProfile;
        const leg = routeCache.get(
            keyFor(seq[i], seq[i + 1], profile),
        );
        // Keep a direct segment visible while the street route loads or when
        // the routing service cannot be reached.
        const fallback = [
            [seq[i].lat, seq[i].lng],
            [seq[i + 1].lat, seq[i + 1].lng],
        ];
        const manual = configured && !AUTOMATIC_TRAVEL_MODES.includes(configured.mode);
        const points = manual ? fallback : leg?.points || fallback;
        const color = manual ? "#3f7d9c" : style.color;
        L.polyline(points, manual ? { ...style, color, dashArray: "3 8" } : style).addTo(routeLayer);
        registerLegGeometry(seq[i], seq[i + 1], points, color);
    }
}

// Fetch (debounced) any uncached legs of the active day. Runs on every drawMap()
// but only hits the network for legs it hasn't seen yet.
function ensureRoutes() {
    // Every invocation invalidates in-flight batches (day switch, edit…).
    const myToken = ++routeToken,
        myActive = store.active,
        profile = store.routeProfile;
    if (store.previewMode || store.active === "backlog") return;
    const day = dayBy(store.active);
    if (!day) return;
    const visibleSpots = day.spots
        .filter(spotMatchesFilter)
        .filter(spotIsEnabled);
    const seq = connectingLocated(visibleSpots);
    if (seq.length < 2) return;
    const pending = [];
    for (let i = 0; i < seq.length - 1; i++) {
        const from = seq[i],
            to = seq[i + 1];
        if (!routeCache.has(keyFor(from, to, profile)))
            pending.push([from, to]);
    }
    if (!pending.length) return;
    // Coalesce rapid mutations (drag reorder, edits) into one batch, matching the
    // 450 ms geocoding debounce.
    clearTimeout(routeTimer);
    routeTimer = setTimeout(async () => {
        await Promise.all(
            pending.map(([from, to]) => fetchLegOnce(from, to, profile)),
        );
        // Stale-guard: keep the reusable cache entries, but do not repaint a
        // route that is no longer active.
        if (myToken !== routeToken || myActive !== store.active) return;
        drawMap();
        document.dispatchEvent(new CustomEvent("trip:route-times-updated"));
    }, 450);
}

export function drawMap() {
    routeLayer.clearLayers();
    spotMarkers.clear();
    highlightedSpotId = null;
    legGeometry.clear();
    legHighlightLayer.clearLayers();
    highlightedLegKey = null;
    highlightItinerarySpot(null, false);
    if (store.previewMode) return drawGlobalMap();
    removeLegend();
    const day =
        store.active === "backlog"
            ? { title: "Backlog de paradas", spots: store.backlog }
            : dayBy(store.active);
    if (!day) {
        $("#mapTitle").textContent = "Ruta del día";
        $("#mapSummary").textContent = "Añade un día para empezar";
        return;
    }
    $("#mapTitle").textContent = day.title;
    const visibleSpots = day.spots
        .filter(spotMatchesFilter)
        .filter(spotIsEnabled);
    const located = visibleSpots.filter(
        (s) => Number.isFinite(s.lat) && Number.isFinite(s.lng),
    );
    // Read cached legs synchronously (destructive render: paint what we know now;
    // async results update the cache and repaint later). legLabels maps each
    // destination spot id -> its incoming-leg label.
    const legLabels = {};
    let summaryExtra = "";
    if (store.active !== "backlog") {
        const seq = connectingLocated(visibleSpots),
            cachedLegs = [];
        for (let i = 0; i < seq.length - 1; i++) {
            const leg = routeCache.get(
                keyFor(seq[i], seq[i + 1], store.routeProfile),
            );
            if (leg) {
                legLabels[seq[i + 1].id] = legLabel(leg);
                cachedLegs.push(leg);
            }
        }
        if (cachedLegs.length) {
            const totalKm = cachedLegs.reduce((a, l) => a + l.km, 0),
                // Any measured leg without a duration (Haversine fallback) drops
                // the time from the day total.
                anyNoDuration = cachedLegs.some((l) => l.min == null);
            summaryExtra =
                store.routeVisualization === "straight" || anyNoDuration
                ? ` · Total: ${fmtKm(totalKm)} km`
                : ` · Total: ${fmtKm(totalKm)} km · ${Math.round(
                      cachedLegs.reduce((a, l) => a + l.min, 0),
                  )} min`;
        }
    }
    const directionsLink =
        store.active === "backlog" ? null : dayDirectionsLink(visibleSpots);
    const directionsAction = directionsLink
        ? ` <a class="day-directions-link" href="${directionsLink}" target="_blank" rel="noopener" aria-label="Abrir indicaciones para todo el día en Google Maps">Abrir ruta del día ↗</a>`
        : "";
    $("#mapSummary").innerHTML =
        `<b>${located.length}</b> de ${visibleSpots.length} paradas ubicadas${summaryExtra}${directionsAction}`;
    const points = located.map((s) => [s.lat, s.lng]);
    if (points.length) {
        if (store.active !== "backlog") {
            const linePoints = located.filter((s) =>
                categoryConnects(s.category),
            );
            drawRouteLine(linePoints);
        }
        located.forEach((s) => {
            // Leg label is app-generated numbers (safe); name/note stay esc()'d.
            const legPart = legLabels[s.id]
                ? `<br><small class="leg-label">${legLabels[s.id]}</small>`
                : "";
            // Base popup content. The photo (if any) is prepended on first open
            // via setContent — NOT by appending a node, because Leaflet
            // regenerates string-based popup content on every popup.update() and
            // would wipe an injected child.
            const baseHtml = `<b>${esc(s.name)}</b><br><small>${esc(s.note || s.address || "")}</small>${legPart}`;
            const marker = L.marker([s.lat, s.lng], {
                icon: icon(
                    markerLabel(visibleSpots, s),
                    categoryMeta(s.category).color,
                ),
            })
                .addTo(routeLayer)
                .bindPopup(baseHtml);
            registerSpotMarker(s, marker);
            // Fill the popup with the spot's Wikipedia photo the first time it
            // opens (fetchSpotImage caches by name, so reopening is instant).
            // Markers are rebuilt every drawMap(), so imgDone is per-marker.
            let imgDone = false;
            marker.on("popupopen", async (e) => {
                if (imgDone) return;
                const found = await fetchSpotImage(s.name);
                if (!found || imgDone) return;
                imgDone = true;
                e.popup.setContent(
                    `<div class="popup-image"><img src="${esc(found.src)}" alt="${esc(s.name)}" /></div>${baseHtml}`,
                );
            });
        });
        map.fitBounds(points, { padding: [45, 45], maxZoom: 14 });
    } else map.setView([20, 0], 2);
    // Fetch any legs we don't have yet; resolves into the cache + repaint.
    ensureRoutes();
}

function initPreview(lat = 20, lng = 0, zoom = 2) {
    if (!previewMap) {
        previewMap = L.map("previewMap", {
            dragging: !usesCoarsePointer,
            scrollWheelZoom: false,
            zoomControl: false,
        }).setView([lat, lng], zoom);
        registerBasemapMap(previewMap);
        L.control.zoom({ position: "bottomright" }).addTo(previewMap);
        previewMap.on("click", ({ latlng }) => {
            const lat = +latlng.lat.toFixed(6);
            const lng = +latlng.lng.toFixed(6);
            setPreview({
                lat,
                lng,
                display_name: `Punto elegido en el mapa (${lat.toFixed(5)}, ${lng.toFixed(5)})`,
            });
        });
    }
    previewMap.setView([lat, lng], zoom);
    previewLayer?.remove();
    previewLayer = null;
    setTimeout(() => previewMap.invalidateSize(), 50);
}

function addPreviewMarker(loc) {
    previewLayer = L.marker([loc.lat, loc.lng], { draggable: true }).addTo(
        previewMap,
    );
    previewLayer.on("dragend", ({ target }) => {
        const point = target.getLatLng();
        const lat = +point.lat.toFixed(6);
        const lng = +point.lng.toFixed(6);
        setPreview({
            lat,
            lng,
            display_name: `Punto elegido en el mapa (${lat.toFixed(5)}, ${lng.toFixed(5)})`,
        });
    });
}

// The map is always available in the dialog. Existing spots open on their
// current coordinates; new ones start around the active route on the main map.
export function openPreview(loc) {
    $("#previewWrap").hidden = false;
    if (loc) {
        initPreview(loc.lat, loc.lng, 14);
        addPreviewMarker(loc);
    } else {
        const center = map.getCenter();
        initPreview(
            center.lat,
            center.lng,
            Math.min(Math.max(map.getZoom(), 2), 14),
        );
    }
}

export function openReadPreview(spot) {
    const node = $("#placeReadMap");
    if (!node || !Number.isFinite(spot?.lat) || !Number.isFinite(spot?.lng))
        return;
    if (readPreviewNode !== node) {
        readPreviewMap?.remove();
        readPreviewNode = node;
        readPreviewMap = L.map(node, {
            dragging: false,
            touchZoom: false,
            scrollWheelZoom: false,
            doubleClickZoom: false,
            boxZoom: false,
            keyboard: false,
            zoomControl: false,
            attributionControl: false,
        });
        L.tileLayer(
            "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
            { maxZoom: 19 },
        ).addTo(readPreviewMap);
    }
    readPreviewMap.setView([spot.lat, spot.lng], 14, { animate: false });
    readPreviewMap.eachLayer((layer) => {
        if (layer instanceof L.Marker || layer instanceof L.CircleMarker)
            layer.remove();
    });
    L.circleMarker([spot.lat, spot.lng], {
        radius: 7,
        weight: 3,
        color: "#fff",
        fillColor: "#c55347",
        fillOpacity: 1,
    }).addTo(readPreviewMap);
    setTimeout(() => readPreviewMap?.invalidateSize({ animate: false }), 0);
}

export function clearPreviewMarker() {
    previewLayer?.remove();
    previewLayer = null;
}

export function setPreview(loc) {
    store.selectedLocation = loc;
    $("#searchStatus").textContent =
        "Ubicación seleccionada: " + loc.display_name;
    document.dispatchEvent(new CustomEvent("place-preview-change"));
    if ($("#previewWrap").hidden) return;
    initPreview(loc.lat, loc.lng, 14);
    addPreviewMarker(loc);
}
