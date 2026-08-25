import { randomUUID } from "../../core/random-id.js";
import {
    insertEntityIntent,
    moveEntityIntent,
    rebasePlanIntent,
    setFieldIntent,
    updateFieldsIntent,
} from "../../core/plan-operation-commit.js";

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

export function conflictLocalValue(entry) {
    return entry?.localValue && typeof entry.localValue === "object"
        && Object.prototype.hasOwnProperty.call(entry.localValue, "value")
        ? entry.localValue.value
        : entry?.localValue;
}

export function conflictRemoteValue(entry) {
    const conflict = entry?.conflict || {};
    return conflict.currentValue ?? conflict.details?.currentValue
        ?? conflict.currentLocation ?? conflict.details?.currentLocation;
}

export function canCombineConflict(entry) {
    return entry?.operation?.kind === "set-field"
        && typeof conflictLocalValue(entry) === "string"
        && typeof conflictRemoteValue(entry) === "string";
}

export function canRecreateConflict(entry) {
    return ["ENTITY_DELETED", "ANCHOR_MISSING"].includes(entry?.conflict?.code)
        && Boolean(entry?.localValue?.entity)
        && entry.operation?.target?.type !== "plan";
}

function anchorStillExists(document, location) {
    if (!location?.beforeId) return true;
    if (location.containerId === "days") return document.days.some((day) => day.id === location.beforeId);
    if (location.containerId === "backlog") return document.backlog.some((spot) => spot.id === location.beforeId);
    return document.days.find((day) => day.id === location.containerId)
        ?.spots.some((spot) => spot.id === location.beforeId) === true;
}

function recreateIntent(document, entry, createId) {
    const entity = clone(entry.localValue.entity);
    const target = clone(entry.operation.target);
    const nextId = createId();
    target.id = nextId;
    if (entity && typeof entity === "object" && target.type !== "travel-leg") entity.id = nextId;
    // A deleted day may have left its former stops in the backlog. Recreating
    // it is an explicit copy, so every nested identity must also be new.
    if (target.type === "day" && Array.isArray(entity.spots)) {
        entity.spots = entity.spots.map((spot) => ({ ...spot, id: createId() }));
    }
    const location = clone(entry.localValue.location || {});
    if (!anchorStillExists(document, location)) location.beforeId = null;
    return insertEntityIntent(target, entity, {
        containerId: location.containerId,
        beforeId: location.beforeId ?? null,
        backlogGroupId: entity?.backlogGroupId,
    });
}

export function conflictResolutionIntent(document, entry, action, {
    mergedValue,
    createId = randomUUID,
} = {}) {
    const operation = entry?.operation;
    if (!operation) throw new Error("CONFLICT_OPERATION_MISSING");
    if (action === "combine") {
        if (!canCombineConflict(entry)) throw new Error("CONFLICT_NOT_COMBINABLE");
        return setFieldIntent(document, operation.target, mergedValue);
    }
    if (action === "recreate") return recreateIntent(document, entry, createId);
    if (action !== "local") throw new Error("INVALID_CONFLICT_RESOLUTION");
    if (operation.kind === "command" && operation.payload?.command === "update-fields") {
        return updateFieldsIntent(document, operation.target, operation.payload.fields || {}, {
            remove: operation.payload.remove || [],
        });
    }
    if (operation.kind === "move-entity") {
        const payload = clone(operation.payload || {});
        if (!anchorStillExists(document, payload)) payload.beforeId = null;
        return moveEntityIntent(document, operation.target, payload);
    }
    return rebasePlanIntent(document, operation);
}

export function conflictCopyText(entry) {
    const recoverable = entry?.localValue?.entity ?? conflictLocalValue(entry);
    return typeof recoverable === "string" ? recoverable : JSON.stringify(recoverable, null, 2);
}
