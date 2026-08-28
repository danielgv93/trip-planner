import { distanceMeters } from "../../core/geo.js";

const SERVERS = {
    walking: "https://routing.openstreetmap.de/routed-foot",
    driving: "https://routing.openstreetmap.de/routed-car",
    cycling: "https://routing.openstreetmap.de/routed-bike",
};
const FALLBACK_SPEED_KMH = { walking: 4.5, driving: 35, cycling: 15 };

function fallbackMinutes(from, to, profile) {
    const meters = distanceMeters(from, to);
    if (!Number.isFinite(meters)) return 0;
    return Math.max(1, Math.round((meters / 1000) / FALLBACK_SPEED_KMH[profile] * 60));
}

function fallbackMatrix(spots, profile) {
    return spots.map((from, fromIndex) => spots.map((to, toIndex) =>
        fromIndex === toIndex ? 0 : fallbackMinutes(from, to, profile),
    ));
}

export async function fetchTravelMatrix(spots, profile = "walking") {
    const fallback = fallbackMatrix(spots, profile);
    if (spots.length < 2) return { minutes: fallback, approximate: false };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
        const coordinates = spots.map((spot) => `${spot.lng},${spot.lat}`).join(";");
        const response = await fetch(
            `${SERVERS[profile] || SERVERS.walking}/table/v1/driving/${coordinates}?annotations=duration`,
            { signal: controller.signal },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (payload.code !== "Ok" || !Array.isArray(payload.durations)) throw new Error("Respuesta de rutas no válida");
        let approximate = false;
        const minutes = fallback.map((row, fromIndex) => row.map((fallbackValue, toIndex) => {
            const seconds = payload.durations?.[fromIndex]?.[toIndex];
            if (fromIndex === toIndex) return 0;
            if (!Number.isFinite(seconds)) {
                approximate = true;
                return fallbackValue;
            }
            return Math.max(1, Math.round(seconds / 60));
        }));
        return { minutes, approximate };
    } catch {
        return { minutes: fallback, approximate: true };
    } finally {
        clearTimeout(timeout);
    }
}
