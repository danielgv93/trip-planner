import { canonicalPlanHash } from "./plan-hash.js";
import {
    applyPlanOperation,
    PLAN_OPERATION_PROTOCOL_VERSION,
    targetFingerprint,
} from "./plan-operations.js";
import { portablePlanFrom } from "./portable-plan.js";
import { randomUUID } from "./random-id.js";
import {
    applyPortablePlanState,
    persistLocalRecoverySnapshot,
    store,
} from "./store.js";

const dependencies = {
    getRepository: () => null,
    getDeviceId: () => "local-device",
    recordUndo: () => {},
    repaint: () => {},
    refreshLibrary: async () => {},
    scheduleDrain: () => {},
};

let commitTail = Promise.resolve();

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function activePreferences() {
    return {
        backlogCollapsed: store.backlogCollapsed,
        activeTripNotePageId: store.activeTripNotePageId,
        basemap: store.basemap,
        workspaceSplit: store.workspaceSplit,
        itineraryDensity: store.itineraryDensity,
    };
}

function operationEnvelope(intent, envelope) {
    const operation = {
        protocolVersion: PLAN_OPERATION_PROTOCOL_VERSION,
        clientMutationId: randomUUID(),
        deviceId: dependencies.getDeviceId(),
        baseRevision: Number(envelope?.remote?.baseRevision) || 0,
        kind: intent.kind,
        target: clone(intent.target),
        precondition: clone(intent.precondition || {}),
        payload: clone(intent.payload || {}),
    };
    if (operation.kind === "replace-plan" && !Number.isInteger(operation.precondition.expectedRevision)) {
        operation.precondition.expectedRevision = operation.baseRevision;
    }
    return operation;
}

function nextEnvelope(envelope, document, syncState, { includePreferences = true } = {}) {
    const user = store.accountSession?.user;
    const lastModifiedBy = user?.id && user?.displayName
        ? { userId: user.id, displayName: user.displayName }
        : envelope.remote?.lastModifiedBy || null;
    return {
        ...envelope,
        document,
        syncState,
        updatedAt: new Date().toISOString(),
        remote: { ...envelope.remote, lastModifiedBy },
        preferences: includePreferences
            ? { ...envelope.preferences, ...activePreferences() }
            : envelope.preferences,
    };
}

async function persistOperation(envelope, operation, applied, { includePreferences = true } = {}) {
    const repository = dependencies.getRepository();
    if (!repository) throw new Error("TRIP_REPOSITORY_UNAVAILABLE");
    const isCloud = Boolean(envelope.remote?.id);
    const granular = isCloud
        && operation.kind !== "replace-plan"
        && envelope.remote.protocolVersion >= PLAN_OPERATION_PROTOCOL_VERSION
        && !(await repository.hasLegacyOutbox(envelope.id));
    const updated = nextEnvelope(envelope, applied.document, isCloud ? "pending" : "local", { includePreferences });

    if (granular) {
        const targetEntity = operation.target.type === "plan"
            ? undefined
            : readTarget(applied.document, operation.target);
        const localLocation = operation.target.type === "day" || operation.target.type === "spot"
            ? targetLocation(applied.document, operation.target)
            : undefined;
        const desiredValue = operation.payload?.remove === true
            ? undefined
            : clone(operation.payload?.value ?? operation.payload?.entity ?? operation.payload);
        const result = await repository.commitOperation(updated, {
            operation,
            inverse: applied.inverse,
            localValue: targetEntity === undefined
                ? desiredValue
                : {
                    value: desiredValue,
                    entity: clone(targetEntity),
                    ...(localLocation ? { location: clone(localLocation) } : {}),
                },
        });
        return { ...result, mode: "granular", cloud: true };
    }
    if (isCloud) {
        await repository.commitTrip(updated, {
            type: "document",
            remoteId: updated.remote.id,
            baseRevision: updated.remote.baseRevision,
            clientMutationId: operation.clientMutationId,
            hash: canonicalPlanHash(updated.document),
            document: updated.document,
            origin: "operation-fallback",
        });
        return { envelope: updated, entry: null, mode: "snapshot", cloud: true };
    }
    await repository.putTrip(updated);
    return { envelope: updated, entry: null, mode: "local", cloud: false };
}

async function executeCommit(intentOrFactory, options) {
    const tripId = options.tripId || store.activeTripId;
    const isActive = tripId === store.activeTripId;
    if (isActive && store.readOnly) return { skipped: "read-only" };
    const repository = dependencies.getRepository();
    if (!repository || !tripId) throw new Error("TRIP_REPOSITORY_UNAVAILABLE");
    const envelope = await repository.getTrip(tripId);
    if (!envelope || envelope.pendingDeletion) throw new Error("TRIP_NOT_AVAILABLE");
    if ((isActive && store.readOnly) || envelope.remote?.role === "viewer") return { skipped: "read-only" };

    const current = isActive ? portablePlanFrom(store) : envelope.document;
    const intent = typeof intentOrFactory === "function"
        ? await intentOrFactory(clone(current))
        : intentOrFactory;
    const operation = operationEnvelope(intent, envelope);
    const applied = applyPlanOperation(current, operation, {
        currentRevision: Number(envelope.remote?.baseRevision) || 0,
    });
    if (applied.noOp) return { noOp: true, operation };

    if (isActive) {
        store.saveStatus = "saving";
        store.saveError = null;
        document.dispatchEvent(new CustomEvent("trip-save-state"));
    }
    try {
        const persisted = await persistOperation(envelope, operation, applied, { includePreferences: isActive });
        if (isActive && (store.readOnly || store.activeTripId !== tripId)) {
            throw new Error(store.readOnly ? "TRIP_BECAME_READ_ONLY" : "ACTIVE_TRIP_CHANGED");
        }
        if (isActive) {
            if (options.undo !== false) dependencies.recordUndo({ operation, inverse: applied.inverse, mode: persisted.mode });
            applyPortablePlanState(applied.document);
            persistLocalRecoverySnapshot({ described: true });
            store.saveStatus = "saved";
            store.saveError = null;
            dependencies.repaint(options.repaint || {});
        }
        await dependencies.refreshLibrary();
        if (isActive) document.dispatchEvent(new CustomEvent("trip-save-state"));
        if (persisted.cloud) {
            dependencies.scheduleDrain({ tripId, mode: persisted.mode });
        }
        return { ...persisted, operation, inverse: applied.inverse, noOp: false };
    } catch (error) {
        if (isActive) {
            store.saveStatus = "error";
            store.saveError = error;
            document.dispatchEvent(new CustomEvent("trip-save-state"));
        }
        throw error;
    }
}

export function configurePlanOperationCommit(overrides = {}) {
    Object.assign(dependencies, overrides);
}

export function commitPlanOperation(intentOrFactory, options = {}) {
    const result = commitTail.then(() => executeCommit(intentOrFactory, options));
    commitTail = result.catch(() => {});
    return result;
}

export async function waitForPlanOperationCommits() {
    await commitTail;
}

export function setFieldIntent(document, target, value, { remove = false } = {}) {
    const fingerprint = targetFingerprint(document, target);
    if (fingerprint === null) throw new Error("PLAN_OPERATION_TARGET_NOT_FOUND");
    const entity = readTarget(document, target);
    const hasField = Object.prototype.hasOwnProperty.call(entity, target.field);
    return {
        kind: "set-field",
        target,
        precondition: hasField ? { expectedValue: clone(entity[target.field]) } : { expectedAbsent: true },
        payload: remove ? { remove: true } : { value: clone(value) },
    };
}

export function commandIntent({ target, command, precondition = {}, payload = {} }) {
    return {
        kind: "command",
        target: clone(target),
        precondition: clone(precondition),
        payload: { ...clone(payload), command },
    };
}

export function updateFieldsIntent(document, target, fields, { remove = [] } = {}) {
    const entity = readTarget(document, target);
    if (!entity) throw new Error("PLAN_OPERATION_TARGET_NOT_FOUND");
    const expectedFields = {};
    const expectedAbsent = [];
    [...Object.keys(fields || {}), ...remove].forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(entity, field)) expectedFields[field] = clone(entity[field]);
        else expectedAbsent.push(field);
    });
    return commandIntent({
        target,
        command: "update-fields",
        precondition: {
            ...(Object.keys(expectedFields).length ? { expectedFields } : {}),
            ...(expectedAbsent.length ? { expectedAbsent } : {}),
        },
        payload: { fields: clone(fields || {}), remove: [...remove] },
    });
}

export function insertEntityIntent(target, entity, {
    containerId,
    beforeId = null,
    backlogGroupId,
} = {}) {
    return {
        kind: "insert-entity",
        target: clone(target),
        precondition: { absent: true },
        payload: {
            entity: clone(entity),
            beforeId,
            ...(containerId ? { containerId } : {}),
            ...(backlogGroupId ? { backlogGroupId } : {}),
        },
    };
}

export function deleteEntityIntent(document, target) {
    const fingerprint = targetFingerprint(document, target);
    return {
        kind: "delete-entity",
        target: clone(target),
        precondition: fingerprint ? { expectedFingerprint: fingerprint } : {},
        payload: {},
    };
}

export function moveEntityIntent(document, target, {
    containerId,
    beforeId = null,
    backlogGroupId,
} = {}) {
    const location = targetLocation(document, target);
    if (!location) throw new Error("PLAN_OPERATION_TARGET_NOT_FOUND");
    return {
        kind: "move-entity",
        target: clone(target),
        precondition: { expectedLocation: location },
        payload: {
            containerId,
            beforeId,
            ...(backlogGroupId ? { backlogGroupId } : {}),
        },
    };
}

export function replacePlanIntent(document, nextDocument, baseRevision) {
    return {
        kind: "replace-plan",
        target: { type: "plan", id: "plan" },
        precondition: Number.isInteger(baseRevision) ? { expectedRevision: baseRevision } : {},
        payload: { document: clone(nextDocument) },
    };
}

export function derivedPlanOperation(createIntent, options) {
    return commitPlanOperation((document) => createIntent(document), options);
}

// Undo and conflict resolution emit a fresh operation. Scalar, field-batch and
// move preconditions are deliberately rebuilt from the latest optimistic
// document so unrelated remote changes remain intact.
export function rebasePlanIntent(document, operation) {
    if (!operation) throw new Error("PLAN_OPERATION_MISSING");
    if (operation.kind === "set-field") {
        return setFieldIntent(
            document,
            operation.target,
            operation.payload?.value,
            { remove: operation.payload?.remove === true },
        );
    }
    if (operation.kind === "move-entity") {
        return moveEntityIntent(document, operation.target, operation.payload || {});
    }
    if (operation.kind === "insert-entity") {
        return insertEntityIntent(operation.target, operation.payload?.entity, operation.payload || {});
    }
    if (operation.kind === "delete-entity") {
        return deleteEntityIntent(document, operation.target);
    }
    if (operation.kind === "command" && operation.payload?.command === "update-fields") {
        return updateFieldsIntent(document, operation.target, operation.payload.fields || {}, {
            remove: operation.payload.remove || [],
        });
    }
    // Structural compound inverses keep their original revision guard. They
    // must surface as an explicit conflict instead of overwriting a document
    // that has advanced remotely.
    return clone(operation);
}

function readTarget(document, target) {
    if (target.type === "plan") return document;
    if (target.type === "day") return document.days.find((item) => item.id === target.id);
    if (target.type === "spot") {
        return [...document.backlog, ...document.days.flatMap((day) => day.spots)]
            .find((item) => item.id === target.id);
    }
    const sources = {
        "backlog-group": document.backlogGroups,
        category: document.categories,
        "note-page": document.tripNotePages,
        reminder: document.reminders,
    };
    if (sources[target.type]) return sources[target.type].find((item) => item.id === target.id);
    if (target.type === "travel-leg") return document.travelLegs[target.id];
    return undefined;
}

function targetLocation(document, target) {
    if (target.type === "day") {
        const index = document.days.findIndex((day) => day.id === target.id);
        return index < 0 ? null : { containerId: "days", beforeId: document.days[index + 1]?.id ?? null };
    }
    if (target.type === "spot") {
        const backlogIndex = document.backlog.findIndex((spot) => spot.id === target.id);
        if (backlogIndex >= 0) return { containerId: "backlog", beforeId: document.backlog[backlogIndex + 1]?.id ?? null };
        for (const day of document.days) {
            const index = day.spots.findIndex((spot) => spot.id === target.id);
            if (index >= 0) return { containerId: day.id, beforeId: day.spots[index + 1]?.id ?? null };
        }
    }
    return null;
}
