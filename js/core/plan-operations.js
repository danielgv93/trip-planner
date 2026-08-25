import { dayPositionConstraintViolation } from "./itinerary.js";
import { normalizePortablePlan } from "./portable-plan.js";
import { unlinkSpotReminders } from "./reminders.js";
import { parseTravelLegKey } from "./travel-legs.js";

export const PLAN_OPERATION_PROTOCOL_VERSION = 1;

export const PLAN_OPERATION_KINDS = Object.freeze([
    "set-field",
    "insert-entity",
    "delete-entity",
    "move-entity",
    "command",
    "replace-plan",
]);

const TARGET_FIELDS = Object.freeze({
    plan: new Set([
        "tripTitle", "localCurrency", "foreignCurrency", "exchangeRate",
        "exchangeRateDate", "routeProfile", "routeVisualization",
    ]),
    day: new Set(["date", "title", "startTime", "collapsed"]),
    spot: new Set([
        "name", "address", "note", "tags", "category", "lat", "lng",
        "cost", "visitMinutes", "openingTime", "closingTime", "plannedStart",
        "optional", "fixedStart", "scheduleNotApplicable", "visitedAt",
        "mapEnabled", "kind", "positionConstraint", "backlogGroupId",
    ]),
    "backlog-group": new Set(["title", "collapsed"]),
    category: new Set(["label", "color", "connects", "defaultSpotKind"]),
    tag: new Set(),
    "note-page": new Set(["title", "content"]),
    reminder: new Set(["title", "note", "spotId", "timing", "pendingSpotAnchor"]),
    "travel-leg": new Set([
        "mode", "durationMinutes", "departureTime", "fixedDeparture", "line",
        "note", "cost", "embeddedEndpoints",
    ]),
});

const TARGET_TYPES = new Set(Object.keys(TARGET_FIELDS));
const INSERT_TYPES = new Set([
    "day", "spot", "backlog-group", "category", "tag", "note-page",
    "reminder", "travel-leg",
]);
const SAFE_DELETE_TYPES = new Set(["note-page", "reminder", "travel-leg"]);
const MOVE_TYPES = new Set(["day", "spot"]);
const COMMANDS = new Set([
    "delete-day",
    "delete-spot",
    "rename-tag",
    "delete-tag",
    "delete-category",
    "delete-backlog-group",
    "move-travel-card",
    "update-fields",
    "reorder-day-spots",
    "delete-travel-card",
    "duplicate-day",
    "update-timeline",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
}

export function valueFingerprint(value) {
    const input = stable(value);
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export class PlanOperationError extends Error {
    constructor(code, message, { target = null, details = null } = {}) {
        super(message);
        this.name = "PlanOperationError";
        this.code = code;
        this.target = target;
        this.details = details;
    }
}

function fail(code, message, operation, details) {
    throw new PlanOperationError(code, message, {
        target: operation?.target ? clone(operation.target) : null,
        details,
    });
}

function boundedString(value, max = 160) {
    return typeof value === "string" && value.length > 0 && value.length <= max;
}

function validateTarget(target, operation) {
    if (!isRecord(target) || !TARGET_TYPES.has(target.type) || !boundedString(target.id))
        fail("INVALID_OPERATION", "Objetivo de operación no válido.", operation);
    if (target.field !== undefined && !TARGET_FIELDS[target.type]?.has(target.field))
        fail("INVALID_OPERATION", "Campo de operación no permitido.", operation);
    return { type: target.type, id: target.id, ...(target.field ? { field: target.field } : {}) };
}

export function validatePlanOperation(value) {
    if (!isRecord(value) || value.protocolVersion !== PLAN_OPERATION_PROTOCOL_VERSION)
        fail("UNSUPPORTED_OPERATION_VERSION", "Versión de operación no compatible.", value);
    if (!UUID_PATTERN.test(String(value.clientMutationId)) || !boundedString(value.deviceId, 128))
        fail("INVALID_OPERATION", "Identidad de operación no válida.", value);
    if (!Number.isInteger(value.baseRevision) || value.baseRevision < 0)
        fail("INVALID_OPERATION", "Revisión base no válida.", value);
    if (!PLAN_OPERATION_KINDS.includes(value.kind))
        fail("INVALID_OPERATION", "Tipo de operación no permitido.", value);
    const operation = {
        protocolVersion: PLAN_OPERATION_PROTOCOL_VERSION,
        clientMutationId: value.clientMutationId,
        deviceId: value.deviceId,
        baseRevision: value.baseRevision,
        kind: value.kind,
        target: validateTarget(value.target, value),
        precondition: isRecord(value.precondition) ? clone(value.precondition) : {},
        payload: isRecord(value.payload) ? clone(value.payload) : {},
    };

    if (operation.kind === "set-field" && !operation.target.field)
        fail("INVALID_OPERATION", "Una operación escalar necesita campo.", operation);
    if (operation.kind === "insert-entity" && !INSERT_TYPES.has(operation.target.type))
        fail("INVALID_OPERATION", "Esta entidad no admite inserción.", operation);
    if (operation.kind === "delete-entity" && !SAFE_DELETE_TYPES.has(operation.target.type))
        fail("INVALID_OPERATION", "Esta eliminación requiere un comando de dominio.", operation);
    if (operation.kind === "move-entity" && !MOVE_TYPES.has(operation.target.type))
        fail("INVALID_OPERATION", "Esta entidad no admite movimiento directo.", operation);
    if (operation.kind === "command" && !COMMANDS.has(operation.payload.command))
        fail("INVALID_OPERATION", "Comando de dominio no permitido.", operation);
    if (operation.kind === "replace-plan" && !Number.isInteger(operation.precondition.expectedRevision))
        fail("INVALID_OPERATION", "El reemplazo necesita la revisión completa esperada.", operation);
    return operation;
}

function allSpotLocations(document) {
    return [
        ...(document.backlog || []).map((entity, index) => ({ entity, index, containerId: "backlog", collection: document.backlog })),
        ...(document.days || []).flatMap((day) => day.spots.map((entity, index) => ({ entity, index, containerId: day.id, collection: day.spots, day }))),
    ];
}

function findTarget(document, target) {
    if (target.type === "plan") return { entity: document, containerId: "plan" };
    if (target.type === "day") {
        const index = document.days.findIndex((item) => item.id === target.id);
        return index < 0 ? null : { entity: document.days[index], collection: document.days, index, containerId: "days" };
    }
    if (target.type === "spot") return allSpotLocations(document).find(({ entity }) => entity.id === target.id) || null;
    const sources = {
        "backlog-group": document.backlogGroups,
        category: document.categories,
        "note-page": document.tripNotePages,
        reminder: document.reminders,
    };
    if (sources[target.type]) {
        const collection = sources[target.type];
        const index = collection.findIndex((item) => item.id === target.id);
        return index < 0 ? null : { entity: collection[index], collection, index, containerId: target.type };
    }
    if (target.type === "travel-leg") {
        return hasOwn(document.travelLegs, target.id)
            ? { entity: document.travelLegs[target.id], record: document.travelLegs, key: target.id, containerId: "travel-legs" }
            : null;
    }
    return null;
}

export function targetFingerprint(documentValue, target) {
    const document = normalizePortablePlan(documentValue);
    const located = findTarget(document, target);
    return located ? valueFingerprint(located.entity) : null;
}

function targetKey(target) {
    return `${target.type}:${target.id}`;
}

export function deriveTargetKeys(operationValue, document) {
    const operation = validatePlanOperation(operationValue);
    const keys = new Set([targetKey(operation.target)]);
    if (operation.target.field) keys.add(`${targetKey(operation.target)}:${operation.target.field}`);
    const located = document ? findTarget(document, operation.target) : null;
    if (located?.containerId && operation.target.type === "spot") {
        keys.add(located.containerId === "backlog" ? "backlog:all" : `day:${located.containerId}`);
        if (located.entity.backlogGroupId) keys.add(`backlog-group:${located.entity.backlogGroupId}`);
    }
    if (operation.kind === "move-entity" && boundedString(operation.payload.containerId))
        keys.add(operation.payload.containerId === "backlog" ? "backlog:all" : `day:${operation.payload.containerId}`);
    if (operation.kind === "command" && operation.payload.command === "update-fields") {
        Object.keys(operation.payload.fields || {}).forEach((field) => keys.add(`${targetKey(operation.target)}:${field}`));
        (operation.payload.remove || []).forEach((field) => keys.add(`${targetKey(operation.target)}:${field}`));
    }
    if (operation.kind === "command" && operation.payload.command === "update-timeline") {
        Object.keys(operation.payload.starts || {}).forEach((id) => keys.add(`spot:${id}:plannedStart`));
    }
    return [...keys].sort();
}

function operationFrom(base, overrides) {
    return {
        protocolVersion: PLAN_OPERATION_PROTOCOL_VERSION,
        clientMutationId: base.clientMutationId,
        deviceId: base.deviceId,
        baseRevision: base.baseRevision,
        ...overrides,
    };
}

function readExpected(precondition) {
    if (hasOwn(precondition, "expectedValue")) return { has: true, value: precondition.expectedValue };
    return { has: false, value: undefined };
}

function applySetField(document, operation) {
    const located = findTarget(document, operation.target);
    if (!located) fail("ENTITY_DELETED", "La entidad ya no existe.", operation);
    const field = operation.target.field;
    const current = located.entity[field];
    const removes = operation.payload.remove === true;
    const desired = removes ? undefined : operation.payload.value;
    if ((removes && !hasOwn(located.entity, field)) || (!removes && equal(current, desired)))
        return { noOp: true, inverse: null };
    const expected = readExpected(operation.precondition);
    if (operation.precondition.expectedAbsent === true && hasOwn(located.entity, field))
        fail("TARGET_CONFLICT", "El campo cambió en otra sesión.", operation, { currentValue: clone(current) });
    if (expected.has && !equal(current, expected.value))
        fail("TARGET_CONFLICT", "El campo cambió en otra sesión.", operation, { currentValue: clone(current) });
    if (operation.precondition.expectedHash && valueFingerprint(current) !== operation.precondition.expectedHash)
        fail("TARGET_CONFLICT", "El campo cambió en otra sesión.", operation, { currentValue: clone(current) });
    if (removes) delete located.entity[field];
    else located.entity[field] = clone(desired);
    const inverse = operationFrom(operation, {
        kind: "set-field",
        target: clone(operation.target),
        precondition: desired === undefined
            ? { expectedAbsent: true }
            : { expectedValue: clone(desired) },
        payload: current === undefined ? { remove: true } : { value: clone(current) },
    });
    return { noOp: false, inverse };
}

function collectionForInsert(document, operation) {
    const { type } = operation.target;
    if (type === "day") return { collection: document.days, containerId: "days" };
    if (type === "spot") {
        const containerId = operation.payload.containerId;
        if (containerId === "backlog") return { collection: document.backlog, containerId };
        const day = document.days.find((candidate) => candidate.id === containerId);
        if (!day) fail("ANCHOR_MISSING", "El destino ya no existe.", operation);
        return { collection: day.spots, containerId, day };
    }
    const sources = {
        "backlog-group": document.backlogGroups,
        category: document.categories,
        "note-page": document.tripNotePages,
        reminder: document.reminders,
    };
    return sources[type] ? { collection: sources[type], containerId: type } : null;
}

function insertionIndex(collection, beforeId, operation) {
    if (beforeId === null || beforeId === undefined) return collection.length;
    const index = collection.findIndex((item) => item?.id === beforeId || item === beforeId);
    if (index < 0) fail("ANCHOR_MISSING", "El ancla de inserción ya no existe.", operation);
    return index;
}

function applyInsert(document, operation) {
    const entity = clone(operation.payload.entity);
    if (operation.target.type === "tag") {
        if (typeof entity !== "string" || entity !== operation.target.id)
            fail("INVALID_OPERATION", "Etiqueta insertada no válida.", operation);
        if (document.tags.includes(entity)) return { noOp: true, inverse: null };
        document.tags.splice(insertionIndex(document.tags, operation.payload.beforeId, operation), 0, entity);
        return {
            noOp: false,
            inverse: operationFrom(operation, {
                kind: "command",
                target: { type: "plan", id: "plan" },
                precondition: {},
                payload: { command: "delete-tag", tag: entity, expectedFingerprint: valueFingerprint(entity) },
            }),
        };
    }
    if (!isRecord(entity) || (operation.target.type !== "travel-leg" && entity.id !== operation.target.id))
        fail("INVALID_OPERATION", "Entidad insertada no válida.", operation);
    const existing = findTarget(document, operation.target);
    if (existing) {
        const candidate = clone(document);
        const candidateLocation = findTarget(candidate, operation.target);
        if (candidateLocation.record) candidateLocation.record[candidateLocation.key] = clone(entity);
        else candidateLocation.collection[candidateLocation.index] = clone(entity);
        const canonicalEntity = findTarget(normalizePortablePlan(candidate), operation.target)?.entity;
        if (equal(existing.entity, canonicalEntity)) return { noOp: true, inverse: null };
        fail("DUPLICATE_ENTITY", "Ya existe una entidad con ese id.", operation);
    }
    if (operation.target.type === "travel-leg") {
        if (!parseTravelLegKey(operation.target.id)) fail("INVALID_OPERATION", "Trayecto no válido.", operation);
        document.travelLegs[operation.target.id] = entity;
    } else {
        const destination = collectionForInsert(document, operation);
        if (!destination) fail("INVALID_OPERATION", "Colección no válida.", operation);
        destination.collection.splice(insertionIndex(destination.collection, operation.payload.beforeId, operation), 0, entity);
        if (operation.target.type === "spot") {
            if (destination.containerId === "backlog") {
                delete entity.positionConstraint;
                if (operation.payload.backlogGroupId) entity.backlogGroupId = operation.payload.backlogGroupId;
            } else delete entity.backlogGroupId;
            if (destination.day && dayPositionConstraintViolation(destination.collection.filter((item) => item !== entity), destination.collection))
                fail("CONSTRAINT_VIOLATION", "La inserción incumple los anclajes del día.", operation);
        }
    }
    return {
        noOp: false,
        inverse: operationFrom(operation, {
            kind: "delete-entity",
            target: clone(operation.target),
            precondition: { expectedFingerprint: valueFingerprint(entity) },
            payload: {},
        }),
    };
}

function applyDelete(document, operation) {
    const located = findTarget(document, operation.target);
    if (!located) return { noOp: true, inverse: null };
    if (operation.precondition.expectedFingerprint && valueFingerprint(located.entity) !== operation.precondition.expectedFingerprint)
        fail("TARGET_CONFLICT", "La entidad cambió en otra sesión.", operation, { currentFingerprint: valueFingerprint(located.entity) });
    const beforeId = located.collection?.[located.index + 1]?.id ?? null;
    if (located.record) delete located.record[located.key];
    else located.collection.splice(located.index, 1);
    return {
        noOp: false,
        inverse: operationFrom(operation, {
            kind: "insert-entity",
            target: clone(operation.target),
            precondition: { absent: true },
            payload: { entity: clone(located.entity), beforeId, containerId: located.containerId },
        }),
    };
}

function locationDescriptor(location) {
    return {
        containerId: location.containerId,
        beforeId: location.collection[location.index + 1]?.id ?? null,
    };
}

function destinationForMove(document, operation) {
    if (operation.target.type === "day") return { collection: document.days, containerId: "days" };
    return collectionForInsert(document, operation);
}

function applyMove(document, operation) {
    const located = findTarget(document, operation.target);
    if (!located) fail("ENTITY_DELETED", "La entidad movida ya no existe.", operation);
    const destination = destinationForMove(document, operation);
    if (!destination) fail("ANCHOR_MISSING", "El destino ya no existe.", operation);
    const current = locationDescriptor(located);
    const desired = { containerId: destination.containerId, beforeId: operation.payload.beforeId ?? null };
    if (equal(current, desired)) return { noOp: true, inverse: null };
    if (operation.precondition.expectedLocation && !equal(current, operation.precondition.expectedLocation))
        fail("MOVE_CONFLICT", "La entidad se movió en otra sesión.", operation, { currentLocation: current });

    const sourceBefore = [...located.collection];
    const [entity] = located.collection.splice(located.index, 1);
    const beforeId = operation.payload.beforeId ?? null;
    if (beforeId === entity.id) fail("INVALID_OPERATION", "Una entidad no puede anclarse a sí misma.", operation);
    const index = insertionIndex(destination.collection, beforeId, operation);
    destination.collection.splice(index, 0, entity);
    if (operation.target.type === "spot") {
        if (located.containerId !== destination.containerId) {
            delete entity.plannedStart;
            delete entity.fixedStart;
        }
        if (destination.containerId === "backlog") {
            delete entity.positionConstraint;
            if (operation.payload.backlogGroupId) entity.backlogGroupId = operation.payload.backlogGroupId;
            else delete entity.backlogGroupId;
        } else delete entity.backlogGroupId;
        const sourceViolation = located.day && dayPositionConstraintViolation(sourceBefore, located.collection);
        const destinationBefore = destination.collection === located.collection
            ? sourceBefore
            : destination.collection.filter((item) => item !== entity);
        const destinationViolation = destination.day && dayPositionConstraintViolation(destinationBefore, destination.collection);
        if (sourceViolation || destinationViolation)
            fail("CONSTRAINT_VIOLATION", sourceViolation || destinationViolation, operation);
    }
    return {
        noOp: false,
        inverse: operationFrom(operation, {
            kind: "move-entity",
            target: clone(operation.target),
            precondition: { expectedLocation: desired },
            payload: { containerId: current.containerId, beforeId: current.beforeId },
        }),
    };
}

function requireFingerprint(entity, operation) {
    const expected = operation.precondition.expectedFingerprint || operation.payload.expectedFingerprint;
    if (expected && valueFingerprint(entity) !== expected)
        fail("TARGET_CONFLICT", "La entidad cambió en otra sesión.", operation, { currentFingerprint: valueFingerprint(entity) });
}

function applyCommand(document, operation) {
    const before = clone(document);
    const command = operation.payload.command;
    const located = findTarget(document, operation.target);
    if (["delete-day", "delete-spot", "delete-category", "delete-backlog-group"].includes(command) && !located)
        return { noOp: true, inverse: null };
    if (located) requireFingerprint(located.entity, operation);

    if (command === "update-fields") {
        if (!located) fail("ENTITY_DELETED", "La entidad ya no existe.", operation);
        const fields = isRecord(operation.payload.fields) ? operation.payload.fields : {};
        const remove = Array.isArray(operation.payload.remove) ? operation.payload.remove : [];
        const allowed = TARGET_FIELDS[operation.target.type];
        if ([...Object.keys(fields), ...remove].some((field) => !allowed?.has(field)))
            fail("INVALID_OPERATION", "La actualización contiene campos no permitidos.", operation);
        const expected = isRecord(operation.precondition.expectedFields)
            ? operation.precondition.expectedFields
            : {};
        for (const [field, value] of Object.entries(expected)) {
            if (!equal(located.entity[field], value))
                fail("TARGET_CONFLICT", "Un campo cambió en otra sesión.", operation, { field, currentValue: clone(located.entity[field]) });
        }
        for (const field of operation.precondition.expectedAbsent || []) {
            if (hasOwn(located.entity, field))
                fail("TARGET_CONFLICT", "Un campo cambió en otra sesión.", operation, { field, currentValue: clone(located.entity[field]) });
        }
        Object.entries(fields).forEach(([field, value]) => { located.entity[field] = clone(value); });
        remove.forEach((field) => { delete located.entity[field]; });
        if (operation.target.type === "spot" && located.containerId !== "backlog") {
            const constraint = located.entity.positionConstraint;
            if (constraint === "first" && located.index > 0) {
                located.collection.splice(located.index, 1);
                located.collection.unshift(located.entity);
            } else if (constraint === "last" && located.index < located.collection.length - 1) {
                located.collection.splice(located.index, 1);
                located.collection.push(located.entity);
            }
            if (dayPositionConstraintViolation(before.days.find((day) => day.id === located.containerId)?.spots || [], located.collection))
                fail("CONSTRAINT_VIOLATION", "La actualización incumple los anclajes del día.", operation);
        }
    } else if (command === "update-timeline") {
        if (operation.target.type !== "day" || !located) fail("ENTITY_DELETED", "El día ya no existe.", operation);
        const currentOrder = located.entity.spots.map((spot) => spot.id);
        if (Array.isArray(operation.precondition.expectedOrder) && !equal(currentOrder, operation.precondition.expectedOrder))
            fail("MOVE_CONFLICT", "El timeline cambió en otra sesión.", operation, { currentOrder });
        const starts = isRecord(operation.payload.starts) ? operation.payload.starts : {};
        for (const [spotId, expected] of Object.entries(operation.precondition.expectedStarts || {})) {
            const spot = located.entity.spots.find((candidate) => candidate.id === spotId);
            if (!spot || !equal(spot.plannedStart ?? null, expected))
                fail("TARGET_CONFLICT", "La hora planificada cambió en otra sesión.", operation, { spotId, currentValue: clone(spot?.plannedStart) });
        }
        Object.entries(starts).forEach(([spotId, value]) => {
            const spot = located.entity.spots.find((candidate) => candidate.id === spotId);
            if (!spot) fail("ENTITY_DELETED", "Una parada del timeline ya no existe.", operation);
            if (value === null) delete spot.plannedStart;
            else spot.plannedStart = value;
        });
        const order = operation.payload.order || currentOrder;
        if (!Array.isArray(order) || order.length !== currentOrder.length || new Set(order).size !== order.length || order.some((id) => !currentOrder.includes(id)))
            fail("INVALID_OPERATION", "El orden del timeline no es válido.", operation);
        located.entity.spots = order.map((id) => located.entity.spots.find((spot) => spot.id === id));
        if (dayPositionConstraintViolation(before.days.find((day) => day.id === operation.target.id).spots, located.entity.spots))
            fail("CONSTRAINT_VIOLATION", "El timeline incumple los anclajes del día.", operation);
    } else if (command === "reorder-day-spots") {
        if (operation.target.type !== "day" || !located) fail("ENTITY_DELETED", "El día ya no existe.", operation);
        const order = operation.payload.order;
        const currentOrder = located.entity.spots.map((spot) => spot.id);
        if (!Array.isArray(order) || order.length !== currentOrder.length || new Set(order).size !== order.length || order.some((id) => !currentOrder.includes(id)))
            fail("INVALID_OPERATION", "El orden de paradas no es válido.", operation);
        if (Array.isArray(operation.precondition.expectedOrder) && !equal(currentOrder, operation.precondition.expectedOrder))
            fail("MOVE_CONFLICT", "El día se reordenó en otra sesión.", operation, { currentOrder });
        located.entity.spots = order.map((id) => located.entity.spots.find((spot) => spot.id === id));
        if (dayPositionConstraintViolation(before.days.find((day) => day.id === operation.target.id).spots, located.entity.spots))
            fail("CONSTRAINT_VIOLATION", "El orden incumple los anclajes del día.", operation);
    } else if (command === "delete-travel-card") {
        if (operation.target.type !== "travel-leg" || !located) return { noOp: true, inverse: null };
        const key = operation.target.id;
        const pair = parseTravelLegKey(key);
        const endpoints = located.entity.embeddedEndpoints || [];
        delete document.travelLegs[key];
        [["from", pair?.fromId], ["to", pair?.toId]].forEach(([role, spotId]) => {
            if (!spotId || !endpoints.includes(role)) return;
            const endpoint = allSpotLocations(document).find(({ entity }) => entity.id === spotId);
            if (!endpoint || endpoint.entity.kind !== "waypoint") return;
            const shared = Object.keys(document.travelLegs).some((candidate) => {
                const candidatePair = parseTravelLegKey(candidate);
                return candidatePair?.fromId === spotId || candidatePair?.toId === spotId;
            });
            if (!shared) {
                document.reminders = unlinkSpotReminders(document.reminders, spotId, document.days);
                endpoint.collection.splice(endpoint.index, 1);
            }
        });
    } else if (command === "duplicate-day") {
        if (operation.target.type !== "day" || !located) fail("ENTITY_DELETED", "El día original ya no existe.", operation);
        const entity = clone(operation.payload.entity);
        if (!isRecord(entity) || !boundedString(entity.id) || findTarget(document, { type: "day", id: entity.id }))
            fail("DUPLICATE_ENTITY", "El día duplicado ya existe.", operation);
        const allIds = new Set(allSpotLocations(document).map(({ entity: spot }) => spot.id));
        if (!Array.isArray(entity.spots) || entity.spots.some((spot) => !boundedString(spot?.id) || allIds.has(spot.id)))
            fail("DUPLICATE_ENTITY", "Una parada duplicada ya existe.", operation);
        document.days.splice(located.index + 1, 0, entity);
        const legs = isRecord(operation.payload.travelLegs) ? operation.payload.travelLegs : {};
        Object.entries(legs).forEach(([key, leg]) => {
            if (document.travelLegs[key] || !parseTravelLegKey(key))
                fail("DUPLICATE_ENTITY", "Un trayecto duplicado ya existe.", operation);
            document.travelLegs[key] = clone(leg);
        });
    } else if (command === "delete-day") {
        if (operation.target.type !== "day") fail("INVALID_OPERATION", "Objetivo de día requerido.", operation);
        document.backlog.push(...located.entity.spots.map((spot) => {
            const moved = clone(spot);
            delete moved.positionConstraint;
            return moved;
        }));
        document.days.splice(located.index, 1);
    } else if (command === "delete-spot") {
        if (operation.target.type !== "spot") fail("INVALID_OPERATION", "Objetivo de parada requerido.", operation);
        document.reminders = unlinkSpotReminders(document.reminders, located.entity.id, document.days);
        located.collection.splice(located.index, 1);
        Object.keys(document.travelLegs).forEach((key) => {
            const pair = parseTravelLegKey(key);
            if (pair?.fromId === operation.target.id || pair?.toId === operation.target.id)
                delete document.travelLegs[key];
        });
    } else if (command === "rename-tag") {
        const from = operation.payload.from;
        const to = operation.payload.to;
        if (!boundedString(from) || !boundedString(to)) fail("INVALID_OPERATION", "Etiquetas no válidas.", operation);
        if (!document.tags.includes(from)) return document.tags.includes(to) ? { noOp: true, inverse: null } : fail("ENTITY_DELETED", "La etiqueta ya no existe.", operation);
        if (document.tags.includes(to)) fail("DUPLICATE_ENTITY", "La etiqueta de destino ya existe.", operation);
        document.tags[document.tags.indexOf(from)] = to;
        allSpotLocations(document).forEach(({ entity }) => {
            entity.tags = entity.tags.map((tag) => tag === from ? to : tag);
        });
    } else if (command === "delete-tag") {
        const tag = operation.payload.tag;
        if (!document.tags.includes(tag)) return { noOp: true, inverse: null };
        document.tags = document.tags.filter((candidate) => candidate !== tag);
        allSpotLocations(document).forEach(({ entity }) => {
            entity.tags = entity.tags.filter((candidate) => candidate !== tag);
        });
    } else if (command === "delete-category") {
        if (operation.target.type !== "category") fail("INVALID_OPERATION", "Objetivo de categoría requerido.", operation);
        document.categories.splice(located.index, 1);
        allSpotLocations(document).forEach(({ entity }) => {
            if (entity.category === operation.target.id) delete entity.category;
        });
    } else if (command === "delete-backlog-group") {
        if (operation.target.type !== "backlog-group") fail("INVALID_OPERATION", "Objetivo de grupo requerido.", operation);
        document.backlogGroups.splice(located.index, 1);
        document.backlog.forEach((spot) => {
            if (spot.backlogGroupId === operation.target.id) delete spot.backlogGroupId;
        });
    } else if (command === "move-travel-card") {
        applyMoveTravelCard(document, operation);
    }
    if (equal(before, document)) return { noOp: true, inverse: null };
    if (command === "update-fields") {
        const beforeTarget = findTarget(before, operation.target)?.entity;
        const afterTarget = findTarget(document, operation.target)?.entity;
        const touched = [...new Set([
            ...Object.keys(operation.payload.fields || {}),
            ...(operation.payload.remove || []),
        ])];
        const fields = {};
        const remove = [];
        const expectedFields = {};
        const expectedAbsent = [];
        touched.forEach((field) => {
            if (hasOwn(beforeTarget, field)) fields[field] = clone(beforeTarget[field]);
            else remove.push(field);
            if (hasOwn(afterTarget, field)) expectedFields[field] = clone(afterTarget[field]);
            else expectedAbsent.push(field);
        });
        return {
            noOp: false,
            inverse: operationFrom(operation, {
                kind: "command",
                target: clone(operation.target),
                precondition: {
                    ...(Object.keys(expectedFields).length ? { expectedFields } : {}),
                    ...(expectedAbsent.length ? { expectedAbsent } : {}),
                },
                payload: { command: "update-fields", fields, remove },
            }),
        };
    }
    return {
        noOp: false,
        inverse: operationFrom(operation, {
            kind: "replace-plan",
            target: { type: "plan", id: "plan" },
            precondition: { expectedRevision: operation.baseRevision + 1 },
            payload: { document: before },
        }),
    };
}

function applyMoveTravelCard(document, operation) {
    const key = operation.target.id;
    const leg = document.travelLegs[key];
    const pair = parseTravelLegKey(key);
    if (!leg || !pair || !Array.isArray(leg.embeddedEndpoints) || !leg.embeddedEndpoints.length)
        fail("ENTITY_DELETED", "La tarjeta de viaje ya no existe.", operation);
    const destination = document.days.find((day) => day.id === operation.payload.containerId);
    if (!destination) fail("ANCHOR_MISSING", "El día de destino ya no existe.", operation);
    const endpointIds = leg.embeddedEndpoints.map((role) => role === "from" ? pair.fromId : pair.toId);
    const locations = endpointIds.map((id) => allSpotLocations(document).find(({ entity }) => entity.id === id));
    if (locations.some((location) => !location || location.containerId === "backlog"))
        fail("ENTITY_DELETED", "Un extremo embebido ya no existe en un día.", operation);
    const currentDayIds = [...new Set(locations.map((location) => location.containerId))];
    if (currentDayIds.length !== 1) fail("MOVE_CONFLICT", "Los extremos ya no comparten día.", operation);
    if (operation.precondition.expectedContainerId && operation.precondition.expectedContainerId !== currentDayIds[0])
        fail("MOVE_CONFLICT", "La tarjeta se movió en otra sesión.", operation);
    const originals = new Map();
    locations.forEach((location) => {
        if (!originals.has(location.collection)) originals.set(location.collection, [...location.collection]);
    });
    const entities = endpointIds.map((id) => {
        const location = allSpotLocations(document).find(({ entity }) => entity.id === id);
        location.collection.splice(location.index, 1);
        return location.entity;
    });
    let index = insertionIndex(destination.spots, operation.payload.beforeId ?? null, operation);
    destination.spots.splice(index, 0, ...entities);
    for (const [collection, before] of originals) {
        if (dayPositionConstraintViolation(before, collection))
            fail("CONSTRAINT_VIOLATION", "El viaje no puede cruzar una parada anclada.", operation);
    }
    const destinationBefore = originals.get(destination.spots) || destination.spots.filter((spot) => !endpointIds.includes(spot.id));
    if (dayPositionConstraintViolation(destinationBefore, destination.spots))
        fail("CONSTRAINT_VIOLATION", "El viaje no puede cruzar una parada anclada.", operation);
}

function applyReplace(document, operation, currentRevision) {
    if (operation.precondition.expectedRevision !== currentRevision)
        fail("REVISION_CONFLICT", "La revisión completa cambió.", operation, { currentRevision });
    const next = normalizePortablePlan(operation.payload.document);
    if (equal(document, next)) return { document, noOp: true, inverse: null };
    return {
        document: next,
        noOp: false,
        inverse: operationFrom(operation, {
            kind: "replace-plan",
            target: { type: "plan", id: "plan" },
            precondition: { expectedRevision: currentRevision + 1 },
            payload: { document: clone(document) },
        }),
    };
}

export function applyPlanOperation(documentValue, operationValue, { currentRevision = operationValue?.baseRevision } = {}) {
    const operation = validatePlanOperation(operationValue);
    const original = normalizePortablePlan(documentValue);
    let document = clone(original);
    const targetKeys = deriveTargetKeys(operation, original);
    let result;
    if (operation.kind === "set-field") result = applySetField(document, operation);
    else if (operation.kind === "insert-entity") result = applyInsert(document, operation);
    else if (operation.kind === "delete-entity") result = applyDelete(document, operation);
    else if (operation.kind === "move-entity") result = applyMove(document, operation);
    else if (operation.kind === "command") result = applyCommand(document, operation);
    else result = applyReplace(document, operation, currentRevision);

    if (result.document) document = result.document;
    if (!result.noOp) {
        try {
            document = normalizePortablePlan(document);
        } catch {
            fail("CONSTRAINT_VIOLATION", "La operación produce un plan no válido.", operation);
        }
    }
    return {
        document: result.noOp ? original : document,
        operation,
        inverse: result.inverse,
        targetKeys,
        noOp: result.noOp,
    };
}
