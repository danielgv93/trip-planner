// Shared basemap switch for every Leaflet map in the app. OpenFreeMap Liberty
// uses vector labels with Latin/English names alongside the local name when
// available, without requiring an API key.

import { store, saveLocalPreferences } from "../../core/store.js";
import { $ } from "../../shared/dom.js";

function clearOpenFreeMapAttribution(map) {
    const control = map.attributionControl;
    if (!control?._attributions) return;
    for (const attribution of Object.keys(control._attributions)) {
        if (attribution.includes("openfreemap.org"))
            control.removeAttribution(attribution);
    }
}

const BASEMAPS = {
    liberty: {
        style: "https://tiles.openfreemap.org/styles/liberty",
    },
    osm: {
        url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        options: {
            attribution: "© OpenStreetMap",
            maxZoom: 19,
        },
    },
};

const maps = new Set();

function rasterFallbackLayer() {
    return L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
        {
            attribution: "© OpenStreetMap contributors · © CARTO",
            subdomains: "abcd",
            maxZoom: 20,
        },
    );
}

function supportsVectorBasemap() {
    if (typeof L.maplibreGL !== "function") return false;
    if (typeof globalThis.maplibregl?.supported !== "function") return true;
    try {
        return globalThis.maplibregl.supported();
    } catch {
        return false;
    }
}

function layerFor(kind) {
    const config = BASEMAPS[kind] || BASEMAPS.liberty;
    if (config.style && supportsVectorBasemap())
        return L.maplibreGL({ style: config.style });
    // WebGL or the vector renderer may be unavailable or temporarily blocked.
    if (config.style) return rasterFallbackLayer();
    return L.tileLayer(config.url, config.options);
}

function applyBasemap(record) {
    if (record.kind === "liberty") clearOpenFreeMapAttribution(record.map);
    record.layer?.remove();
    const layer = layerFor(store.basemap);
    try {
        record.layer = layer.addTo(record.map);
    } catch (error) {
        // MapLibre creates its WebGL context while the Leaflet layer is added.
        // A blocked/lost context must not abort the whole application startup.
        layer.remove?.();
        console.warn(
            "No se pudo iniciar el mapa vectorial; se usará el mapa raster.",
            error,
        );
        record.layer = rasterFallbackLayer().addTo(record.map);
    }
    record.kind = store.basemap;
    record.layer.bringToBack?.();
}

export function registerBasemapMap(map) {
    const record = { map, layer: null, kind: null };
    maps.add(record);
    applyBasemap(record);
    return record;
}

const select = $("#basemapSelect");
if (select) {
    select.value = store.basemap;
    select.addEventListener("change", (event) => {
        store.basemap = BASEMAPS[event.target.value]
            ? event.target.value
            : "liberty";
        saveLocalPreferences();
        for (const record of maps) applyBasemap(record);
    });
}
