import {
    applyPresenceLeave,
    applyPresenceUpsert,
    presenceSnapshot,
    presenceTargetKey,
    pruneExpiredPresence,
    PRESENCE_FOCUS_DEBOUNCE_MS,
    PRESENCE_HEARTBEAT_MS,
} from "../../core/presence.js";
import { randomUUID } from "../../core/random-id.js";
import { store } from "../../core/store.js";
import { getTripRepository } from "../library/workspace.js";
import { getCloudClient } from "./coordinator.js";

export const presenceSessionId = randomUUID();
export { PRESENCE_HEARTBEAT_MS, PRESENCE_FOCUS_DEBOUNCE_MS };

const FIELD_BY_ID = {
    tripTitle: "tripTitle", routeProfile: "routeProfile", routeVisualization: "routeVisualization",
    placeName: "name", placeAddress: "address", placeNote: "note", placeCost: "cost",
    placeVisitMinutes: "visitMinutes", placeOpeningTime: "openingTime", placeClosingTime: "closingTime",
    placePlannedStart: "plannedStart", placeFixedStart: "fixedStart", placeOptional: "optional",
    placeScheduleNotApplicable: "scheduleNotApplicable", durationMinutes: "visitMinutes",
    durationOpeningTime: "openingTime", durationClosingTime: "closingTime",
    durationScheduleNotApplicable: "scheduleNotApplicable", travelMode: "mode",
    travelTimeMinutes: "durationMinutes", travelDepartureTime: "departureTime", travelLine: "line",
    travelCost: "cost", travelNote: "note", reminderTitle: "title", reminderNote: "note",
    reminderFixedDate: "timing", reminderAmount: "timing", reminderUnit: "timing",
    reminderAnchorDate: "timing", tripNotes: "content",
    foreignCurrency: "foreignCurrency", localCurrency: "localCurrency",
    placeIsWaypoint: "kind", durationIsWaypoint: "kind",
};
const GLOBAL_TARGETS = {
    tripTitle: "plan:plan:tripTitle",
    routeProfile: "plan:plan:routeProfile",
    routeVisualization: "plan:plan:routeVisualization",
};
const DIALOG_TARGETS = {
    tagDialog: "section:tags",
    categoryDialog: "section:categories",
    remindersDialog: "section:reminders",
    healthDialog: "section:health",
    healthSuggestionDialog: "section:health",
    budgetDialog: "section:budget",
    currencyDialog: "plan:plan",
};

let sequence = 0;
let remoteId = null;
let localTripId = null;
let desired = { state: "viewing", target: { type: "plan", id: "plan" } };
let currentTarget = "plan:plan";
let focusTimer = null;
let retryTimer = null;
let publishTail = Promise.resolve();
let initialized = false;

function emitPresence() {
    document.dispatchEvent(new CustomEvent("trip-presence-changed"));
}

export function currentPresenceTarget() {
    return currentTarget;
}

export function refreshPresenceTargetAttributes(root = document) {
    Object.entries(GLOBAL_TARGETS).forEach(([id, target]) => {
        const control = document.getElementById(id);
        if (control) control.dataset.presenceTarget = target;
    });
    Object.entries(DIALOG_TARGETS).forEach(([id, target]) => {
        const dialog = document.getElementById(id);
        if (dialog && !dialog.dataset.presenceTarget) dialog.dataset.presenceTarget = target;
    });
    root.querySelectorAll?.("dialog[data-presence-target]").forEach((dialog) => {
        const base = dialog.dataset.presenceTarget;
        dialog.querySelectorAll("input[id], textarea[id], select[id]").forEach((control) => {
            const field = FIELD_BY_ID[control.id];
            if (field) control.dataset.presenceTarget = `${base}:${field}`;
        });
    });
    document.querySelectorAll(".day[data-day] .date-box input[type='date']").forEach((control) => {
        control.dataset.presenceTarget = `day:${control.closest(".day").dataset.day}:date`;
    });
}

function targetFromElement(element) {
    refreshPresenceTargetAttributes(element?.closest?.("dialog") || document);
    const direct = element?.closest?.("[data-presence-target]")?.dataset.presenceTarget;
    if (!direct) return "plan:plan";
    return direct;
}

function targetObject(key) {
    const [type, id, field] = String(key).split(":");
    return { type, id, ...(field ? { field } : {}) };
}

function editingElement(element) {
    return !store.readOnly && Boolean(element?.matches?.("input, textarea, select, [contenteditable='true']") || element?.closest?.("dialog[data-presence-target]"));
}

function setDesiredFromElement(element) {
    const key = store.readOnly ? "plan:plan" : targetFromElement(element);
    currentTarget = key;
    desired = {
        state: editingElement(element) ? "editing" : "viewing",
        target: targetObject(key),
    };
    document.dispatchEvent(new CustomEvent("trip-presence-local-target", { detail: { targetKey: key } }));
    schedulePublish();
}

function schedulePublish(delay = PRESENCE_FOCUS_DEBOUNCE_MS) {
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => void publishDesired(), delay);
}

async function context() {
    const repository = getTripRepository();
    const envelope = store.activeTripId ? await repository?.getTrip(store.activeTripId) : null;
    if (
        !store.accountSession || store.accountSession.offline || !envelope?.remote.id ||
        Number(envelope.remote.protocolVersion) < 1 || store.liveTripConnectionState === "paused"
    ) return null;
    return { localId: envelope.id, remoteId: envelope.remote.id, role: envelope.remote.role };
}

async function publishNow() {
    const client = getCloudClient();
    const active = await context();
    if (!client || !active) {
        store.presenceConnectionState = "closed";
        return;
    }
    if (remoteId && remoteId !== active.remoteId) {
        const leaveSequence = ++sequence;
        await client.leaveTripPresence(remoteId, presenceSessionId, leaveSequence).catch(() => {});
    }
    remoteId = active.remoteId;
    localTripId = active.localId;
    const announcement = active.role === "viewer"
        ? { state: "viewing", target: { type: "plan", id: "plan" } }
        : desired;
    const nextSequence = ++sequence;
    try {
        await client.upsertTripPresence(remoteId, presenceSessionId, {
            sequence: nextSequence,
            state: announcement.state,
            target: announcement.target,
        });
        store.presenceConnectionState = "open";
        clearTimeout(retryTimer);
    } catch (error) {
        store.presenceConnectionState = "unavailable";
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => void publishDesired(), error?.details?.retryAfterMs || 5_000);
    }
    emitPresence();
}

function publishDesired() {
    const result = publishTail.then(publishNow);
    publishTail = result.catch(() => {});
    return result;
}

async function syncContext() {
    const active = await context();
    if (!active) {
        // Let an already-started presence update finish before announcing the
        // leave, otherwise that late update could make a paused user reappear.
        await publishTail.catch(() => {});
        if (remoteId) {
            const client = getCloudClient();
            await client?.leaveTripPresence(remoteId, presenceSessionId, ++sequence).catch(() => {});
        }
        remoteId = null;
        localTripId = null;
        store.presenceSessions = new Map();
        store.presenceConnectionState = "closed";
        emitPresence();
        return;
    }
    if (active.remoteId !== remoteId) {
        store.presenceSessions = new Map();
        try {
            const snapshot = await getCloudClient()?.getTripPresence(active.remoteId);
            if (store.activeTripId === active.localId) store.presenceSessions = presenceSnapshot(snapshot?.presences);
        } catch {
            store.presenceConnectionState = "unavailable";
        }
    }
    remoteId = active.remoteId;
    localTripId = active.localId;
    desired = { state: "viewing", target: { type: "plan", id: "plan" } };
    currentTarget = "plan:plan";
    await publishDesired();
    emitPresence();
}

function acceptSnapshot(event) {
    if (event.detail?.tripId !== localTripId) return;
    store.presenceSessions = presenceSnapshot(event.detail.presences);
    emitPresence();
}

function acceptUpsert(event) {
    if (event.detail?.tripId !== localTripId) return;
    if (applyPresenceUpsert(store.presenceSessions, event.detail.presence)) emitPresence();
}

function acceptLeave(event) {
    if (event.detail?.tripId !== localTripId) return;
    if (applyPresenceLeave(store.presenceSessions, event.detail)) emitPresence();
}

export function initializePresence() {
    if (initialized) return;
    initialized = true;
    document.addEventListener("focusin", (event) => setDesiredFromElement(event.target));
    document.addEventListener("focusout", () => {
        clearTimeout(focusTimer);
        focusTimer = setTimeout(() => setDesiredFromElement(document.activeElement), PRESENCE_FOCUS_DEBOUNCE_MS);
    });
    document.addEventListener("pointerdown", (event) => {
        const handle = event.target.closest?.(".handle, .day-handle");
        if (handle) setDesiredFromElement(handle.closest("[data-presence-target]"));
    }, { capture: true });
    for (const type of ["pointerup", "pointercancel"]) {
        document.addEventListener(type, () => setDesiredFromElement(document.activeElement), { capture: true });
    }
    document.addEventListener("trip-presence-snapshot", acceptSnapshot);
    document.addEventListener("trip-presence-upsert", acceptUpsert);
    document.addEventListener("trip-presence-leave", acceptLeave);
    for (const type of ["active-trip-changed", "cloud-session-changed"]) {
        document.addEventListener(type, () => void syncContext());
    }
    document.addEventListener("trip-live-state", (event) => {
        if (["open", "paused"].includes(event.detail?.state)) void syncContext();
    });
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            desired = { state: "viewing", target: { type: "plan", id: "plan" } };
            currentTarget = "plan:plan";
        } else setDesiredFromElement(document.activeElement);
        schedulePublish(0);
    });
    window.addEventListener("pagehide", () => {
        if (remoteId) void getCloudClient()?.leaveTripPresence(remoteId, presenceSessionId, ++sequence, { keepalive: true });
    });
    setInterval(() => {
        if (pruneExpiredPresence(store.presenceSessions)) emitPresence();
        if (remoteId && !document.hidden) void publishDesired();
    }, PRESENCE_HEARTBEAT_MS).unref?.();
    refreshPresenceTargetAttributes();
    void syncContext();
}
