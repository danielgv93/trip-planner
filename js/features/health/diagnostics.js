import { spotIsEnabled } from "../../core/store.js?v=26";
import { isWaypoint } from "../../core/itinerary.js";

export const HEALTH_THRESHOLDS = Object.freeze({
    lowMargin: 30,
    walkingTotal: 120,
    walkingLeg: 45,
    workload: 600,
});

function issue(type, severity, spot, message, evidence = {}) {
    return { id: `${type}:${spot?.id || "day"}`, type, severity, spotId: spot?.id, message, evidence };
}

export function diagnoseDay(day, projection) {
    const spots = (day?.spots || []).filter(spotIsEnabled);
    if (!spots.length) return {
        state: "incomplete",
        issues: [issue("empty", "missing", null, "Añade al menos una parada activa para comprobar este día.")],
        metrics: { activity: 0, travel: 0, walking: 0, minMargin: null },
        approximate: false,
    };

    const issues = [];
    const items = projection?.items || [];
    for (const spot of spots) {
        const waypoint = isWaypoint(spot);
        if (!waypoint && !(Number.isInteger(spot.visitMinutes) && spot.visitMinutes > 0))
            issues.push(issue("missing-duration", "missing", spot, `Falta la duración de ${spot.name || "esta parada"}.`, { field: "duration" }));
        if (!Number.isFinite(spot.lat) || !Number.isFinite(spot.lng))
            issues.push(issue("missing-location", "missing", spot, `Falta una ubicación válida para ${spot.name || "esta parada"}.`, { field: "location" }));
        const completeSchedule = !waypoint && spot.scheduleNotApplicable !== true && Boolean(spot.openingTime && spot.closingTime);
        const fixedSchedule = spot.fixedStart === true && Boolean(spot.plannedStart);
        if (!waypoint && !completeSchedule && !fixedSchedule && spot.scheduleNotApplicable !== true)
            issues.push(issue("missing-schedule", "missing", spot, `Falta el horario completo de ${spot.name || "esta parada"}.`, { field: fixedSchedule ? "reservation" : "schedule" }));
        if (completeSchedule && spot.openingTime >= spot.closingTime && !(spot.openingTime === "00:00" && spot.closingTime === "00:00"))
            issues.push(issue("ambiguous-schedule", "warning", spot, `El horario nocturno o de 24 horas de ${spot.name || "esta parada"} es ambiguo.`));
    }

    for (const item of items) {
        if (item.travelMissingDuration)
            issues.push(issue("missing-travel-duration", "missing", item.spot, `Falta la duración del trayecto hasta ${item.spot.name}.`, { field: "travel", fromId: item.fromSpot?.id }));
        for (const conflict of item.conflicts || []) {
            const messages = {
                "outside-hours": `${item.spot.name} queda fuera de su horario.`,
                "late-reservation": `Llegarías ${conflict.minutes} min tarde a la reserva de ${item.spot.name}.`,
                "travel-overlap": `El trayecto invade ${conflict.minutes} min el inicio de ${item.spot.name}.`,
                "visit-overlap": `La visita de ${item.spot.name} se solapa con otra parada.`,
                "missed-departure": `Perderías la salida hacia ${item.spot.name} por ${conflict.minutes} min.`,
            };
            issues.push(issue(conflict.type, "hard", item.spot, messages[conflict.type], conflict));
        }
    }

    const margins = items.map((item) => item.margin).filter(Number.isFinite);
    const minMargin = margins.length ? Math.min(...margins) : null;
    if (minMargin !== null && minMargin >= 0 && minMargin <= HEALTH_THRESHOLDS.lowMargin)
        issues.push(issue("low-margin", "warning", null, `El margen mínimo es de ${minMargin} min (el aviso comienza en 30 min).`, { minutes: minMargin }));
    const travel = items.reduce((sum, item) => sum + (item.travel || 0), 0);
    const walking = items.filter((item) => item.travelProfile === "walking").reduce((sum, item) => sum + (item.travel || 0), 0);
    const longestWalk = Math.max(0, ...items.filter((item) => item.travelProfile === "walking").map((item) => item.travel || 0));
    const activity = items.reduce((sum, item) => sum + (item.duration || 0), 0);
    if (walking > HEALTH_THRESHOLDS.walkingTotal)
        issues.push(issue("walking-total", "warning", null, `El día acumula ${walking} min andando (más de 120 min).`, { minutes: walking }));
    if (longestWalk > HEALTH_THRESHOLDS.walkingLeg)
        issues.push(issue("walking-leg", "warning", null, `Hay un tramo a pie de ${longestWalk} min (más de 45 min).`, { minutes: longestWalk }));
    if (activity + travel > HEALTH_THRESHOLDS.workload)
        issues.push(issue("workload", "warning", null, `La carga total es de ${activity + travel} min (más de 600 min).`, { minutes: activity + travel }));
    const approximate = items.some((item) => item.travelSource === "estimated");
    if (approximate)
        issues.push(issue("estimated-route", "warning", null, "Uno o más trayectos usan una estimación geográfica.", { approximate: true }));

    const state = issues.some((item) => item.severity === "hard")
        ? "impossible"
        : issues.some((item) => item.severity === "missing")
          ? "incomplete"
          : issues.some((item) => item.severity === "warning")
            ? "tight"
            : "solid";
    return { state, issues, metrics: { activity, travel, walking, minMargin }, approximate };
}

export function stateRank(state) {
    return { impossible: 0, unchecked: 1, incomplete: 1, tight: 2, solid: 3 }[state] ?? 0;
}
