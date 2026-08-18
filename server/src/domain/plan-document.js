import { normalizePortablePlan, PLAN_VERSION } from "../../../js/core/portable-plan.js";
import { ApiError } from "../http/api-error.js";

function documentDepth(value, depth = 0) {
    if (depth > 40) return depth;
    if (!value || typeof value !== "object") return depth;
    return Math.max(depth, ...Object.values(value).map((child) => documentDepth(child, depth + 1)));
}

export function validatePlanDocument(value, config) {
    if (Buffer.byteLength(JSON.stringify(value)) > config.bodyLimitBytes) {
        throw new ApiError(413, "DOCUMENT_TOO_LARGE", "El viaje supera el tamaño permitido");
    }
    if (documentDepth(value) > 40) {
        throw new ApiError(400, "DOCUMENT_TOO_DEEP", "El viaje tiene demasiados niveles");
    }
    if (value?.version !== undefined && (!Number.isInteger(value.version) || value.version > PLAN_VERSION)) {
        throw new ApiError(400, "UNSUPPORTED_PLAN_VERSION", "Versión de viaje no compatible");
    }
    try {
        return normalizePortablePlan(value);
    } catch {
        throw new ApiError(400, "INVALID_PLAN", "El documento del viaje no es válido");
    }
}

export function summarizePlanRevision(previous, next) {
    const previousDays = previous?.days || [];
    const nextDays = next.days || [];
    const previousSpots = previousDays.reduce((count, day) => count + day.spots.length, 0) + (previous?.backlog?.length || 0);
    const nextSpots = nextDays.reduce((count, day) => count + day.spots.length, 0) + (next.backlog?.length || 0);
    return {
        titleChanged: previous?.tripTitle !== next.tripTitle,
        daysDelta: nextDays.length - previousDays.length,
        spotsDelta: nextSpots - previousSpots,
    };
}
