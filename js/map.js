// Leaflet maps: the main #map (active day's route or the global preview) and the
// small #previewMap inside the add/edit dialog. Also owns real-distance routing
// (OSRM) with an in-memory cache. Depends on the Leaflet global `L` (loaded via a
// classic <script> before this deferred module runs).
//
// NOTE the circular import with render.js (refreshDayLoad): it's safe because
// the reference only fires at runtime inside the ensureRoutes() debounced
// callback, never during module top-level evaluation — the same pattern
// already used for the render.js/dialogs.js circular import.

import {
    store,
    save,
    dayBy,
    categoryMeta,
    categoryConnects,
    spotMatchesFilter,
    spotIsEnabled,
    routeTimeOverride,
} from "./store.js";
import { $, esc, safeColor } from "./dom.js";
import { DAY_COLORS } from "./constants.js";
import { fetchSpotImage } from "./images.js";
import { refreshDayLoad } from "./render.js";

const map = L.map("map", { zoomControl: false }).setView([20, 0], 2);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap",
}).addTo(map);
let routeLayer = L.layerGroup().addTo(map);
let legendControl = null;
// Rebuilt with the map layers. Lets itinerary/timeline UI point at the
// corresponding marker without putting transient hover state in the store.
const spotMarkers = new Map();
let highlightedSpotId = null;

function registerSpotMarker(spot, marker) {
    spotMarkers.set(String(spot.id), marker);
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

// In-memory only, keyed by `fromCoord|toCoord|profile`. Derived data: never
// persisted, rebuilt on load, survives the destructive render.
const routeCache = new Map();
let routeTimer = null;
// Bumped on every ensureRoutes() call; async legs resolving with a stale token
// are discarded so a late response can't paint the wrong day.
let routeToken = 0;

// Dialog preview-map instances (created lazily on first openPreview/setPreview).
let previewMap, previewLayer;

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
                    visibleSpots.indexOf(s) + 1,
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
function haversine(a, b) {
    const R = 6371,
        toRad = (d) => (d * Math.PI) / 180,
        dLat = toRad(b.lat - a.lat),
        dLng = toRad(b.lng - a.lng),
        lat1 = toRad(a.lat),
        lat2 = toRad(b.lat),
        h =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

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
    try {
        const server = ROUTING_SERVERS[profile] || ROUTING_SERVERS.driving;
        const r = await fetch(
            `${server}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`,
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
            km: haversine(from, to),
            min: null,
            approx: true,
        };
    }
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
        const leg = routeCache.get(
            keyFor(seq[i], seq[i + 1], store.routeProfile),
        );
        const override = routeTimeOverride(
            seq[i].id,
            seq[i + 1].id,
            store.routeProfile,
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
        if (!routeCache.has(key)) pending.push({ from, to, key });
    }
    if (!pending.length) return;
    const results = await Promise.all(
        pending.map(({ from, to }) => fetchLeg(from, to, profile)),
    );
    pending.forEach(({ key }, index) => routeCache.set(key, results[index]));
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
        return;
    }
    for (let i = 0; i < seq.length - 1; i++) {
        const leg = routeCache.get(
            keyFor(seq[i], seq[i + 1], store.routeProfile),
        );
        // Keep a direct segment visible while the street route loads or when
        // the routing service cannot be reached.
        const fallback = [
            [seq[i].lat, seq[i].lng],
            [seq[i + 1].lat, seq[i + 1].lng],
        ];
        L.polyline(leg?.points || fallback, style).addTo(routeLayer);
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
        const results = await Promise.all(
            pending.map(([from, to]) => fetchLeg(from, to, profile)),
        );
        // Stale-guard: a newer ensureRoutes() ran (or the day changed) while we
        // were awaiting — drop this result entirely.
        if (myToken !== routeToken || myActive !== store.active) return;
        pending.forEach(([from, to], i) =>
            routeCache.set(keyFor(from, to, profile), results[i]),
        );
        drawMap();
        refreshDayLoad();
    }, 450);
}

export function drawMap() {
    routeLayer.clearLayers();
    spotMarkers.clear();
    highlightedSpotId = null;
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
                    visibleSpots.indexOf(s) + 1,
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
            zoomControl: false,
            attributionControl: false,
        }).setView([lat, lng], zoom);
        L.tileLayer(
            "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        ).addTo(previewMap);
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

export function clearPreviewMarker() {
    previewLayer?.remove();
    previewLayer = null;
}

export function setPreview(loc) {
    store.selectedLocation = loc;
    initPreview(loc.lat, loc.lng, 14);
    addPreviewMarker(loc);
    $("#searchStatus").textContent =
        "Ubicación seleccionada: " + loc.display_name;
}
