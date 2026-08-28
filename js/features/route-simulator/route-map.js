// Comparison map for the established and proposed stop orders. The basemap is
// the same shared Leaflet basemap used elsewhere in the app; the routes stay as
// straight lines because this view compares order, while the measured street
// minutes live in the step list underneath.

import { esc } from "../../shared/dom.js";
import { registerBasemapMap, unregisterBasemapMap } from "../map/basemap.js";

export const MAP_VIEW = Object.freeze({ width: 500, height: 380, padding: 26 });
// How far the canvas may stretch away from a landscape frame. A day laid out
// north to south inside a wide box collapses into a stripe down the middle, so
// the box takes the shape of the day instead — within limits, because an
// unclamped ratio would hand a single street a canvas taller than the dialog.
const MIN_RATIO = 0.6;
const MAX_RATIO = 1.1;
const EARTH_KM = 6371;
const SCALE_STEPS = Object.freeze([0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500]);

export function isLocated(spot) {
    return Number.isFinite(spot?.lat) && Number.isFinite(spot?.lng);
}

function mercator(spot) {
    const lat = Math.max(-85, Math.min(85, spot.lat));
    return {
        x: (spot.lng * Math.PI) / 180,
        y: Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
    };
}

// Fits every stop into the view box at a single scale, so the drawing keeps the
// shape of the day instead of stretching one axis to fill the canvas.
export function projectRoute(spots, view = MAP_VIEW) {
    const located = (Array.isArray(spots) ? spots : []).filter(isLocated);
    if (!located.length) return null;
    const points = located.map(mercator);
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const lats = located.map((spot) => spot.lat);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    // One stop, or stops sitting on a perfectly straight meridian or parallel,
    // have no extent on an axis. Take the scale from the axis that does have
    // one; when neither does, any finite scale draws the same single point, so
    // 1 keeps the projection defined instead of dividing by zero.
    const fits = [
        spanX > 0 ? (view.width - view.padding * 2) / spanX : null,
        spanY > 0 ? (view.height - view.padding * 2) / spanY : null,
    ].filter((fit) => fit !== null);
    const scale = fits.length ? Math.min(...fits) : 1;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    return {
        width: view.width,
        height: view.height,
        scale,
        // One unit of x spans EARTH_KM * cos(lat) on the ground, so the scale
        // bar has to be read at the middle latitude of the drawing to mean
        // anything. Mercator is conformal, so the same factor holds on y.
        kmPerPixel: (EARTH_KM * Math.cos((centerLat * Math.PI) / 180)) / scale,
        at(spot) {
            const point = mercator(spot);
            return {
                // SVG y grows downward, mercator y grows northward.
                x: view.width / 2 + (point.x - centerX) * scale,
                y: view.height / 2 - (point.y - centerY) * scale,
            };
        },
    };
}

// The view box is chosen before anything is projected, from the extent of the
// stops themselves, so the drawing fills the frame it is given.
export function viewForSpots(spots, { width = MAP_VIEW.width, padding = MAP_VIEW.padding } = {}) {
    const located = (Array.isArray(spots) ? spots : []).filter(isLocated);
    const inner = width - padding * 2;
    if (located.length < 2) return { width, height: Math.round(inner * MIN_RATIO) + padding * 2, padding };
    const points = located.map(mercator);
    const spanX = Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x));
    const spanY = Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y));
    const ratio = spanX > 0 ? spanY / spanX : MAX_RATIO;
    const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
    return { width, height: Math.round(inner * clamped) + padding * 2, padding };
}

function polylinePoints(steps, projection) {
    return steps
        .filter((step) => isLocated(step.spot))
        .map((step) => {
            const point = projection.at(step.spot);
            return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
        })
        .join(" ");
}

// Two-digit labels in a dense cluster need a smaller disc than a four-stop day.
function nodeRadius(count) {
    return count > 12 ? 9.5 : count > 8 ? 10.5 : 12;
}

// Stops metres apart on the ground land on top of each other on a 500px canvas,
// and a hidden number makes the drawing lie about the order it claims to show.
// The discs are therefore pushed apart until they stop overlapping, and each one
// that had to move keeps a leader back to the coordinate it really belongs to.
export function separateNodes(nodes, radius, view) {
    const minDistance = radius * 2 + 2;
    const margin = radius + 2;
    for (let pass = 0; pass < 60; pass++) {
        let moved = false;
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i];
                const b = nodes[j];
                let dx = b.x - a.x;
                let dy = b.y - a.y;
                let distance = Math.hypot(dx, dy);
                if (distance >= minDistance) continue;
                // Stops on identical coordinates give no direction to push
                // along. Pick a fixed axis so the pass stays deterministic
                // instead of dividing by zero.
                if (distance === 0) {
                    dx = 1;
                    dy = 0;
                    distance = 1;
                }
                const push = (minDistance - distance) / 2;
                a.x -= (dx / distance) * push;
                a.y -= (dy / distance) * push;
                b.x += (dx / distance) * push;
                b.y += (dy / distance) * push;
                moved = true;
            }
        }
        if (!moved) break;
    }
    for (const node of nodes) {
        node.x = Math.min(view.width - margin, Math.max(margin, node.x));
        node.y = Math.min(view.height - margin, Math.max(margin, node.y));
        node.displaced = Math.hypot(node.x - node.anchorX, node.y - node.anchorY) > radius * 0.5;
    }
    return nodes;
}

// One node per stop, numbered by its place in the proposed order. A stop the
// route returns to keeps its first number and gains a ring, because two labels
// stacked on the same coordinates read as neither.
export function routeNodes(steps, projection) {
    const nodes = new Map();
    steps.forEach((step, index) => {
        if (!isLocated(step.spot)) return;
        const key = String(step.spot.id);
        const seen = nodes.get(key);
        if (seen) {
            seen.revisited = true;
            return;
        }
        const point = projection.at(step.spot);
        nodes.set(key, {
            label: index + 1,
            name: step.spot.name || "Parada sin nombre",
            x: point.x,
            y: point.y,
            anchorX: point.x,
            anchorY: point.y,
            revisited: false,
            displaced: false,
        });
    });
    return [...nodes.values()];
}

function nodesMarkup(steps, projection, view) {
    const nodes = routeNodes(steps, projection);
    const radius = nodeRadius(nodes.length);
    separateNodes(nodes, radius, view);
    const fontSize = radius >= 12 ? 11 : radius >= 10.5 ? 10 : 9;
    return nodes
        .map((node) => {
            const x = node.x.toFixed(1);
            const y = node.y.toFixed(1);
            const leader = node.displaced
                ? `<line class="route-simulator-map-leader" x1="${node.anchorX.toFixed(1)}" y1="${node.anchorY.toFixed(1)}" x2="${x}" y2="${y}" /><circle class="route-simulator-map-anchor" cx="${node.anchorX.toFixed(1)}" cy="${node.anchorY.toFixed(1)}" r="2.5" />`
                : "";
            return `<g class="route-simulator-map-node${node.revisited ? " is-revisited" : ""}">
            ${leader}<circle cx="${x}" cy="${y}" r="${radius}" />
            <text x="${x}" y="${y}" dy="0.35em" style="font-size:${fontSize}px">${node.label}</text>
            <title>${esc(`${node.label}. ${node.name}`)}</title>
        </g>`;
        })
        .join("");
}

function scaleBarMarkup(projection, view) {
    const target = (view.width - view.padding * 2) * 0.24 * projection.kmPerPixel;
    // Nearest step, not the first one at or above the target: rounding 2.4 km
    // up to 5 produced a bar half the width of the drawing.
    const km = SCALE_STEPS.reduce((best, step) =>
        Math.abs(step - target) < Math.abs(best - target) ? step : best, SCALE_STEPS[0]);
    const length = km / projection.kmPerPixel;
    if (!Number.isFinite(length) || length <= 0 || length > view.width - 20) return "";
    const x = 14;
    const y = view.height - 14;
    const end = (x + length).toFixed(1);
    return `<g class="route-simulator-map-scale" aria-hidden="true">
        <line x1="${x}" y1="${y}" x2="${end}" y2="${y}" />
        <line x1="${x}" y1="${y - 4}" x2="${x}" y2="${y + 4}" />
        <line x1="${end}" y1="${y - 4}" x2="${end}" y2="${y + 4}" />
        <text x="${x}" y="${y - 7}">${km < 1 ? `${Math.round(km * 1000)} m` : `${km} km`}</text>
    </g>`;
}

export function routeMapMarkup(baseline, result, options = {}) {
    if (!result?.steps?.length) return "";
    const beforeSteps = baseline?.steps || [];
    const spots = [...result.steps, ...beforeSteps].map((step) => step.spot);
    const view = viewForSpots(spots, options);
    const distinct = new Set(
        result.steps.filter((step) => isLocated(step.spot)).map((step) => String(step.spot.id)),
    ).size;
    if (distinct < 2) return "";
    return `<figure class="route-simulator-map">
        <div class="route-simulator-map-canvas" data-route-simulator-map style="aspect-ratio:${view.width}/${view.height}" role="img" aria-label="Mapa comparado del orden actual y del orden propuesto"></div>
        <figcaption>
            <span class="is-before"><i aria-hidden="true"></i> Orden actual</span>
            <span class="is-after"><i aria-hidden="true"></i> Orden propuesto</span>
            <small>Trazado en línea recta: compara el orden de las paradas, no el recorrido por calles.</small>
        </figcaption>
    </figure>`;
}

function latLngs(steps) {
    return (steps || [])
        .filter((step) => isLocated(step.spot))
        .map((step) => [step.spot.lat, step.spot.lng]);
}

function comparisonIcon(label, revisited) {
    return L.divIcon({
        className: "",
        html: `<span class="route-simulator-map-marker${revisited ? " is-revisited" : ""}">${label}</span>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
    });
}

export function mountRouteMap(root, baseline, result) {
    const container = root?.querySelector?.("[data-route-simulator-map]");
    if (!container || typeof L?.map !== "function") return () => {};

    const before = latLngs(baseline?.steps);
    const after = latLngs(result?.steps);
    if (after.length < 2) return () => {};

    const map = L.map(container, {
        zoomControl: false,
        scrollWheelZoom: false,
        attributionControl: true,
    });
    const basemap = registerBasemapMap(map);
    L.control.zoom({ position: "bottomright" }).addTo(map);

    L.polyline(before, {
        color: "#d99d95",
        weight: 8,
        opacity: 0.72,
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
    }).addTo(map);
    L.polyline(after, {
        color: "#2c6156",
        weight: 3.5,
        opacity: 1,
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
    }).addTo(map);

    const seen = new Set();
    result.steps.forEach((step, index) => {
        if (!isLocated(step.spot)) return;
        const key = String(step.spot.id);
        if (seen.has(key)) return;
        seen.add(key);
        const revisited = result.steps.slice(index + 1)
            .some((candidate) => String(candidate.spot?.id) === key);
        L.marker([step.spot.lat, step.spot.lng], {
            icon: comparisonIcon(index + 1, revisited),
            keyboard: true,
            title: step.spot.name || "Parada sin nombre",
            zIndexOffset: 500,
        }).addTo(map);
    });

    const bounds = L.latLngBounds([...before, ...after]);
    const frame = requestAnimationFrame(() => {
        map.invalidateSize({ pan: false, animate: false });
        if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15, animate: false });
    });

    return () => {
        cancelAnimationFrame(frame);
        unregisterBasemapMap(basemap);
        map.remove();
    };
}
