// Validation and immutable application of assistant-proposed plan actions.
// Kept separate from provider transport and chat rendering.

import { normalizePlan } from "../../core/plan-json.js?v=33";
import { isTime } from "../../core/time.js";

const MAX_ACTIONS = 30;

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function cleanString(value, field, max = 500) {
    assert(typeof value === "string", `${field} debe ser texto.`);
    const result = value.trim();
    assert(result.length <= max, `${field} es demasiado largo.`);
    return result;
}

function optionalTime(value, field) {
    if (value === null || value === "") return null;
    assert(isTime(value), `${field} no tiene formato HH:MM.`);
    return value;
}

function findSpot(plan, spotId) {
    const backlogIndex = plan.backlog.findIndex((spot) => spot.id === spotId);
    if (backlogIndex >= 0) return { list: plan.backlog, index: backlogIndex, listId: "backlog" };
    for (const day of plan.days) {
        const index = day.spots.findIndex((spot) => spot.id === spotId);
        if (index >= 0) return { list: day.spots, index, listId: day.id };
    }
    return null;
}

function resolveDayId(plan, value, tempIds) {
    const dayId = tempIds.get(value) || value;
    assert(
        dayId === "backlog" || plan.days.some((day) => day.id === dayId),
        `No existe el día “${value}”.`,
    );
    return dayId;
}

function targetList(plan, dayId) {
    return dayId === "backlog"
        ? plan.backlog
        : plan.days.find((day) => day.id === dayId).spots;
}

function clampIndex(value, length) {
    return Number.isInteger(value) ? Math.max(0, Math.min(value, length)) : length;
}

function cleanTags(value) {
    assert(Array.isArray(value), "Las etiquetas deben ser una lista.");
    return [...new Set(value.map((tag) => cleanString(tag, "Etiqueta", 40)).filter(Boolean))].slice(0, 40);
}

function cleanSpotPatch(patch, plan, { requireName = false } = {}) {
    assert(patch && typeof patch === "object" && !Array.isArray(patch), "Los datos de la parada no son válidos.");
    const result = {};
    const stringFields = { name: 120, address: 300, note: 1200 };
    for (const [field, max] of Object.entries(stringFields)) {
        if (Object.hasOwn(patch, field)) result[field] = cleanString(patch[field], field, max);
    }
    if (requireName) assert(result.name, "La nueva parada necesita un nombre.");
    if (Object.hasOwn(patch, "tags")) {
        result.tags = cleanTags(patch.tags);
        plan.tags = [...new Set([...plan.tags, ...result.tags])];
    }
    if (Object.hasOwn(patch, "category")) {
        const category = cleanString(patch.category, "Categoría", 80);
        assert(!category || plan.categories.some((item) => item.id === category), `La categoría “${category}” no existe.`);
        result.category = category || null;
    }
    for (const field of ["lat", "lng", "cost"]) {
        if (!Object.hasOwn(patch, field)) continue;
        if (patch[field] === null || patch[field] === "") result[field] = null;
        else {
            assert(Number.isFinite(patch[field]), `${field} debe ser un número.`);
            if (field === "lat") assert(Math.abs(patch[field]) <= 90, "La latitud no es válida.");
            if (field === "lng") assert(Math.abs(patch[field]) <= 180, "La longitud no es válida.");
            if (field === "cost") assert(patch[field] >= 0, "El coste no puede ser negativo.");
            result[field] = patch[field];
        }
    }
    for (const field of ["openingTime", "closingTime", "plannedStart"]) {
        if (Object.hasOwn(patch, field)) result[field] = optionalTime(patch[field], field);
    }
    if (Object.hasOwn(patch, "visitMinutes")) {
        if (patch.visitMinutes === null || patch.visitMinutes === "") result.visitMinutes = null;
        else {
            assert(Number.isInteger(patch.visitMinutes) && patch.visitMinutes > 0, "La duración debe ser un número entero positivo.");
            result.visitMinutes = patch.visitMinutes;
        }
    }
    if (Object.hasOwn(patch, "mapEnabled")) {
        assert(typeof patch.mapEnabled === "boolean", "mapEnabled debe ser verdadero o falso.");
        result.mapEnabled = patch.mapEnabled;
    }
    return result;
}

function applyPatch(target, patch) {
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete target[key];
        else target[key] = value;
    }
}

function pruneRouteSettings(plan) {
    const spotIds = new Set([
        ...plan.backlog.map((spot) => spot.id),
        ...plan.days.flatMap((day) => day.spots.map((spot) => spot.id)),
    ]);
    const validRouteKey = (key) => {
        const route = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
        const [fromId, toId] = route.split(">");
        return spotIds.has(fromId) && spotIds.has(toId);
    };
    plan.routeTimeOverrides = Object.fromEntries(
        Object.entries(plan.routeTimeOverrides || {}).filter(([key]) => validRouteKey(key)),
    );
    plan.routeTimeProfiles = Object.fromEntries(
        Object.entries(plan.routeTimeProfiles || {}).filter(([key]) => validRouteKey(key)),
    );
}

export function buildProposedPlan(currentPlan, actions) {
    assert(Array.isArray(actions) && actions.length > 0, "No hay cambios que aplicar.");
    assert(actions.length <= MAX_ACTIONS, `La propuesta supera el máximo de ${MAX_ACTIONS} acciones.`);
    const plan = structuredClone(currentPlan);
    const tempIds = new Map();
    const summaries = [];

    actions.forEach((action, actionIndex) => {
        assert(action && typeof action === "object" && !Array.isArray(action), `La acción ${actionIndex + 1} no es válida.`);
        switch (action.type) {
            case "set_trip": {
                let changed = false;
                if (Object.hasOwn(action, "title")) {
                    plan.tripTitle = cleanString(action.title, "Título", 60);
                    summaries.push(`Cambiar el título a “${plan.tripTitle || "Sin título"}”`);
                    changed = true;
                }
                if (Object.hasOwn(action, "notes")) {
                    plan.tripNotes = cleanString(action.notes, "Notas", 5000);
                    summaries.push("Actualizar las notas del viaje");
                    changed = true;
                }
                if (Object.hasOwn(action, "routeProfile")) {
                    assert(["walking", "driving", "cycling"].includes(action.routeProfile), "El modo de ruta no es válido.");
                    plan.routeProfile = action.routeProfile;
                    summaries.push("Cambiar el modo de ruta");
                    changed = true;
                }
                if (Object.hasOwn(action, "routeVisualization")) {
                    assert(["straight", "streets"].includes(action.routeVisualization), "El trazado no es válido.");
                    plan.routeVisualization = action.routeVisualization;
                    summaries.push("Cambiar el tipo de trazado");
                    changed = true;
                }
                assert(changed, "La acción set_trip está vacía.");
                break;
            }
            case "add_day": {
                const tempId = cleanString(action.tempId, "tempId", 80);
                assert(tempId && !tempIds.has(tempId), "El tempId del día no es válido o está repetido.");
                const date = cleanString(action.date || "", "Fecha", 10);
                assert(/^\d{4}-\d{2}-\d{2}$/.test(date), "La fecha del nuevo día debe usar YYYY-MM-DD.");
                const day = { id: crypto.randomUUID(), date, title: cleanString(action.title || "", "Título del día", 120), spots: [] };
                tempIds.set(tempId, day.id);
                plan.days.splice(clampIndex(action.at, plan.days.length), 0, day);
                summaries.push(`Añadir el día “${day.title || date}”`);
                break;
            }
            case "update_day": {
                const day = plan.days.find((item) => item.id === action.dayId);
                assert(day, `No existe el día “${action.dayId}”.`);
                if (Object.hasOwn(action, "date")) {
                    const date = cleanString(action.date, "Fecha", 10);
                    assert(/^\d{4}-\d{2}-\d{2}$/.test(date), "La fecha debe usar YYYY-MM-DD.");
                    day.date = date;
                }
                if (Object.hasOwn(action, "title")) day.title = cleanString(action.title, "Título del día", 120);
                summaries.push(`Actualizar el día “${day.title || day.date}”`);
                break;
            }
            case "delete_day": {
                const index = plan.days.findIndex((day) => day.id === action.dayId);
                assert(index >= 0, `No existe el día “${action.dayId}”.`);
                const [day] = plan.days.splice(index, 1);
                plan.backlog.push(...day.spots.map((spot) => {
                    const copy = { ...spot };
                    delete copy.plannedStart;
                    return copy;
                }));
                summaries.push(`Eliminar “${day.title || day.date}” y mover sus paradas a ideas`);
                break;
            }
            case "reorder_days": {
                assert(Array.isArray(action.dayIds), "El nuevo orden de días no es válido.");
                assert(action.dayIds.length === plan.days.length, "El nuevo orden debe incluir todos los días.");
                const byId = new Map(plan.days.map((day) => [day.id, day]));
                assert(new Set(action.dayIds).size === plan.days.length && action.dayIds.every((dayId) => byId.has(dayId)), "El nuevo orden contiene días desconocidos o repetidos.");
                plan.days = action.dayIds.map((dayId) => byId.get(dayId));
                summaries.push("Reordenar los días del viaje");
                break;
            }
            case "add_spot": {
                const tempId = cleanString(action.tempId, "tempId", 80);
                assert(tempId && !tempIds.has(tempId), "El tempId de la parada no es válido o está repetido.");
                const dayId = resolveDayId(plan, action.dayId, tempIds);
                const spot = { id: crypto.randomUUID(), ...cleanSpotPatch(action.spot, plan, { requireName: true }) };
                tempIds.set(tempId, spot.id);
                const list = targetList(plan, dayId);
                list.splice(clampIndex(action.at, list.length), 0, spot);
                summaries.push(`Añadir “${spot.name}” a ${dayId === "backlog" ? "ideas pendientes" : "un día"}`);
                break;
            }
            case "update_spot": {
                const match = findSpot(plan, action.spotId);
                assert(match, `No existe la parada “${action.spotId}”.`);
                const patch = cleanSpotPatch(action.patch, plan);
                assert(Object.keys(patch).length, "La actualización de la parada está vacía.");
                applyPatch(match.list[match.index], patch);
                assert(match.list[match.index].name, "La parada no puede quedarse sin nombre.");
                summaries.push(`Actualizar “${match.list[match.index].name}”`);
                break;
            }
            case "move_spot": {
                const match = findSpot(plan, action.spotId);
                assert(match, `No existe la parada “${action.spotId}”.`);
                const dayId = resolveDayId(plan, action.dayId, tempIds);
                const [spot] = match.list.splice(match.index, 1);
                if (match.listId !== dayId) delete spot.plannedStart;
                if (dayId !== "backlog") delete spot.backlogGroupId;
                const list = targetList(plan, dayId);
                list.splice(clampIndex(action.at, list.length), 0, spot);
                summaries.push(`Mover “${spot.name}”`);
                break;
            }
            case "delete_spot": {
                const match = findSpot(plan, action.spotId);
                assert(match, `No existe la parada “${action.spotId}”.`);
                const [spot] = match.list.splice(match.index, 1);
                summaries.push(`Eliminar la parada “${spot.name}”`);
                break;
            }
            case "set_tags": {
                plan.tags = cleanTags(action.tags);
                const allowed = new Set(plan.tags);
                for (const spot of [...plan.backlog, ...plan.days.flatMap((day) => day.spots)]) {
                    spot.tags = (spot.tags || []).filter((tag) => allowed.has(tag));
                }
                summaries.push("Actualizar las etiquetas del planning");
                break;
            }
            default:
                throw new Error(`La acción “${action.type || "sin tipo"}” no está permitida.`);
        }
    });

    pruneRouteSettings(plan);
    return { plan: normalizePlan(plan), summaries };
}
