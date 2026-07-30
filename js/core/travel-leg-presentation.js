import { AUTOMATIC_TRAVEL_MODES } from "./travel-legs.js";

export const TRAVEL_MODE_LABELS = Object.freeze({
    walking: "A pie",
    driving: "En coche",
    cycling: "En bicicleta",
    bus: "Autobús",
    train: "Tren",
    metro: "Metro",
    ferry: "Ferry",
    flight: "Avión",
    other: "Otro",
});

export function travelLegPresentation({
    leg = null,
    defaultMode = "walking",
    route = null,
} = {}) {
    const mode = leg?.mode || defaultMode;
    const automatic = AUTOMATIC_TRAVEL_MODES.includes(mode);
    const customMinutes = Number.isInteger(leg?.durationMinutes) && leg.durationMinutes > 0
        ? leg.durationMinutes
        : null;
    const routeMinutes = Number.isInteger(route?.minutes) && route.minutes > 0
        ? route.minutes
        : null;

    let status;
    let minutes;
    let sourceLabel;
    if (customMinutes !== null) {
        status = automatic ? "custom" : "manual";
        minutes = customMinutes;
        sourceLabel = automatic ? "Duración personalizada" : "Duración manual";
    } else if (!automatic) {
        status = "missing";
        minutes = null;
        sourceLabel = "Duración pendiente";
    } else if (routeMinutes !== null) {
        status = route?.approximate ? "approximate" : "automatic";
        minutes = routeMinutes;
        sourceLabel = route?.approximate
            ? "Duración aproximada"
            : "Duración estimada por ruta";
    } else {
        status = "missing";
        minutes = null;
        sourceLabel = "Estimación no disponible";
    }

    return {
        mode,
        modeLabel: TRAVEL_MODE_LABELS[mode] || TRAVEL_MODE_LABELS.other,
        minutes,
        status,
        sourceLabel,
        actionLabel: status === "missing" ? "Completar" : status === "automatic" || status === "approximate" ? "Personalizar" : "Editar",
    };
}

// Adjacency is resolved over all enabled stops. Visibility is only a final
// presentation condition, so a tag filter can never join non-consecutive stops.
export function visibleConsecutiveTravelLegs(
    spots,
    {
        enabled = (spot) => spot?.mapEnabled !== false,
        visible = () => true,
    } = {},
) {
    const sequence = Array.isArray(spots) ? spots.filter(enabled) : [];
    const pairs = [];
    for (let index = 0; index < sequence.length - 1; index += 1) {
        const from = sequence[index];
        const to = sequence[index + 1];
        if (visible(from) && visible(to)) pairs.push({ from, to });
    }
    return pairs;
}
