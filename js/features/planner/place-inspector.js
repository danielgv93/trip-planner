import { spotKind, spotPositionConstraint } from "../../core/itinerary.js";
import { minutesToTime } from "../../core/time.js";

export const PLACE_FOCUS_TARGETS = Object.freeze({
    duration: { group: "schedule", selector: "#placeVisitMinutes" },
    location: { group: "location", selector: "#placeAddress" },
    schedule: { group: "schedule", selector: "#placeOpeningTime" },
    reservation: { group: "schedule", selector: "#placePlannedStart" },
    cost: { group: "additional", selector: "#placeCost" },
    note: { group: "additional", selector: "#placeNote" },
    position: { group: "additional", selector: "#placePositionConstraint input:checked" },
});

function text(value) {
    return typeof value === "string" ? value.trim() : "";
}

function positiveNumber(value) {
    const number = value === "" || value === null || value === undefined ? NaN : Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

function positiveInteger(value) {
    const number = positiveNumber(value);
    return Number.isInteger(number) ? number : null;
}

function canonicalTime(value) {
    return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
        ? value
        : "";
}

export function normalizePlaceDraft(draft = {}) {
    const lat = Number(draft.lat);
    const lng = Number(draft.lng);
    const hasCoordinates = Number.isFinite(lat) && Number.isFinite(lng);
    const category = text(draft.category);
    const positionConstraint = spotPositionConstraint(draft) || "";
    return {
        name: text(draft.name),
        address: text(draft.address),
        note: text(draft.note),
        tags: [...new Set((Array.isArray(draft.tags) ? draft.tags : []).map(text).filter(Boolean))].sort(),
        category,
        kind: spotKind(draft),
        lat: hasCoordinates ? lat : null,
        lng: hasCoordinates ? lng : null,
        cost: positiveNumber(draft.cost),
        visitMinutes: positiveInteger(draft.visitMinutes),
        openingTime: canonicalTime(draft.openingTime),
        closingTime: canonicalTime(draft.closingTime),
        plannedStart: canonicalTime(draft.plannedStart),
        fixedStart: draft.fixedStart === true,
        optional: positionConstraint ? false : draft.optional === true,
        scheduleNotApplicable: draft.scheduleNotApplicable === true,
        positionConstraint,
        mapEnabled: draft.mapEnabled !== false,
    };
}

export function placeDraftChanged(initial, current) {
    return JSON.stringify(normalizePlaceDraft(initial)) !== JSON.stringify(normalizePlaceDraft(current));
}

function durationLabel(minutes) {
    if (!Number.isInteger(minutes) || minutes <= 0) return "Sin duración";
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function positionLabel(value) {
    return {
        first: "Primera",
        locked: "Posición fija",
        last: "Última",
    }[value] || "Flexible";
}

export function buildPlaceSummary(
    spot = {},
    { categories = [], currency = "", timelineItem = null } = {},
) {
    const kind = spotKind(spot);
    const waypoint = kind === "waypoint";
    const category = categories.find((item) => item.id === spot.category);
    const hasCoordinates = Number.isFinite(spot.lat) && Number.isFinite(spot.lng);
    const openingTime = canonicalTime(spot.openingTime);
    const closingTime = canonicalTime(spot.closingTime);
    const plannedStart = canonicalTime(spot.plannedStart);
    const projectedStart = Number.isFinite(timelineItem?.start)
        ? minutesToTime(timelineItem.start, { wrap: true })
        : "";
    const projectedEnd = Number.isFinite(timelineItem?.end)
        ? minutesToTime(timelineItem.end, { wrap: true })
        : "";
    const duration = positiveInteger(spot.visitMinutes);
    const cost = positiveNumber(spot.cost);
    const constraint = spotPositionConstraint(spot) || "";
    const schedule = spot.scheduleNotApplicable === true
        ? "Sin horario aplicable"
        : openingTime && closingTime
          ? `${openingTime}–${closingTime}`
          : openingTime
            ? `Abre a las ${openingTime}`
            : closingTime
              ? `Cierra a las ${closingTime}`
              : "Sin horario";
    return {
        identity: {
            name: text(spot.name) || "Parada sin nombre",
            kind,
            kindLabel: waypoint ? "Punto de paso" : "Actividad",
            category: category ? { id: category.id, label: category.label, color: category.color } : null,
            tags: Array.isArray(spot.tags) ? spot.tags.filter((tag) => typeof tag === "string" && tag.trim()) : [],
        },
        enabled: spot.mapEnabled !== false,
        enabledLabel: spot.mapEnabled !== false ? "Activa" : "Desactivada",
        location: {
            address: text(spot.address),
            hasCoordinates,
            coordinates: hasCoordinates ? `${spot.lat.toFixed(5)}, ${spot.lng.toFixed(5)}` : "",
            status: hasCoordinates ? "Ubicación confirmada" : "Falta la ubicación",
        },
        temporal: {
            schedule,
            duration: waypoint ? "No aplicable" : durationLabel(duration),
            plannedStart,
            projectedStart,
            projectedEnd,
            fixedStart: spot.fixedStart === true && Boolean(plannedStart),
            optional: spot.optional === true,
            summary: waypoint
                ? `${plannedStart || projectedStart || "Hora sin definir"} · paso`
                : [plannedStart || projectedStart, duration ? durationLabel(duration) : "", projectedEnd ? `salida ${projectedEnd}` : ""]
                      .filter(Boolean)
                      .join(" · ") || "Sin planificación",
        },
        cost: cost === null ? null : { value: cost, label: `${cost.toLocaleString("es-ES")} ${currency}`.trim() },
        position: { value: constraint, label: positionLabel(constraint) },
        note: text(spot.note),
    };
}

export function findTimelineItem(projection, spotId) {
    return Array.isArray(projection?.items)
        ? projection.items.find((item) => item?.spot?.id === spotId) || null
        : null;
}
