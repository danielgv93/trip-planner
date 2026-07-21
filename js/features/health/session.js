import { store, routeTimeProfile, routeTimeOverride } from "../../core/store.js?v=26";

const results = new Map();

export const HEALTH_STATES = {
    solid: { label: "Sólido", icon: "✓" },
    tight: { label: "Justo", icon: "!" },
    impossible: { label: "Inviable", icon: "×" },
    unchecked: { label: "Sin comprobar", icon: "?" },
};

export function healthSignature(day, routeContext = {}) {
    const active = (day?.spots || []).filter((spot) => spot.mapEnabled !== false);
    return JSON.stringify({
        day: day?.id,
        startTime: day?.startTime || null,
        spots: active.map((spot) => ({
            id: spot.id,
            visitMinutes: spot.visitMinutes || null,
            lat: Number.isFinite(spot.lat) ? spot.lat : null,
            lng: Number.isFinite(spot.lng) ? spot.lng : null,
            openingTime: spot.openingTime || null,
            closingTime: spot.closingTime || null,
            plannedStart: spot.plannedStart || null,
            optional: spot.optional === true,
            fixedStart: spot.fixedStart === true,
            scheduleNotApplicable: spot.scheduleNotApplicable === true,
        })),
        routeContext,
    });
}

export function currentRouteContext(day) {
    const spots = (day?.spots || []).filter((spot) => spot.mapEnabled !== false);
    const legs = [];
    for (let index = 1; index < spots.length; index += 1) {
        const from = spots[index - 1], to = spots[index];
        const profile = routeTimeProfile(from.id, to.id);
        legs.push([from.id, to.id, profile, routeTimeOverride(from.id, to.id, profile)]);
    }
    return { legs, profile: store.routeProfile };
}

export function setHealthResult(day, result, routeContext = currentRouteContext(day)) {
    results.set(day.id, { ...result, checked: true, signature: healthSignature(day, routeContext), routeContext });
}

export function getHealthResult(day) {
    const result = results.get(day?.id);
    if (!result || result.signature !== healthSignature(day, currentRouteContext(day))) {
        if (result) results.delete(day.id);
        return { state: "unchecked", issues: [], metrics: null, checked: false };
    }
    return result;
}

export function clearHealthResults() { results.clear(); }

export function healthBadgeMarkup(day) {
    const state = getHealthResult(day).state;
    const meta = HEALTH_STATES[state] || HEALTH_STATES.unchecked;
    const id = String(day.id).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    return `<button class="health-badge is-${state}" type="button" data-health-day="${id}" aria-label="Estado del plan: ${meta.label}. Abrir centro de confianza"><span aria-hidden="true">${meta.icon}</span>${meta.label}</button>`;
}
