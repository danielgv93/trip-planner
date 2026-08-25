// Session-only history for user-initiated plan mutations. History deliberately
// stays outside store/save(), so reloading starts with empty undo/redo stacks.

import { createIntentUndoStack, createUndoStack } from "../../core/undo-stack.js";
import { store, saveLocalPreferences } from "../../core/store.js";
import { portablePlanFrom } from "../../core/portable-plan.js";
import { clearHealthResults } from "../health/session.js";
import {
    derivedPlanOperation,
    rebasePlanIntent,
    replacePlanIntent,
} from "../../core/plan-operation-commit.js";

const SNAPSHOT_KEYS = [
    "state",
    "backlog",
    "backlogCollapsed",
    "backlogGroups",
    "tags",
    "categories",
    "tripTitle",
    "localCurrency",
    "foreignCurrency",
    "exchangeRate",
    "exchangeRateDate",
    "tripNotePages",
    "activeTripNotePageId",
    "routeProfile",
    "routeVisualization",
    "routeTimeOverrides",
    "routeTimeProfiles",
    "travelLegs",
    "reminders",
];

let restoreView = () => {};

function capturePlan() {
    return Object.fromEntries([
        ...SNAPSHOT_KEYS.map((key) => [key, store[key]]),
        ["active", store.active],
    ]);
}

function restorePlan(snapshot) {
    clearHealthResults();
    const nextDocument = portablePlanFrom({
        ...snapshot,
        days: snapshot.state,
    });
    void derivedPlanOperation((document) => replacePlanIntent(document, nextDocument), { undo: false })
        .then(() => {
            store.backlogCollapsed = snapshot.backlogCollapsed;
            if (store.tripNotePages.some((page) => page.id === snapshot.activeTripNotePageId)) {
                store.activeTripNotePageId = snapshot.activeTripNotePageId;
            }
            store.active = snapshot.active && (
                snapshot.active === "backlog" || store.state.some((day) => day.id === snapshot.active)
            ) ? snapshot.active : store.state[0]?.id || "backlog";
            saveLocalPreferences();
            restoreView();
        });
}

const snapshotHistory = createUndoStack({ capture: capturePlan, restore: restorePlan });
const intentHistory = createIntentUndoStack({
    apply: (operation) => derivedPlanOperation(
        (document) => rebasePlanIntent(document, operation),
        { undo: false },
    ),
});
const listeners = new Set();
let mode = "snapshot";

function combinedStatus() {
    return mode === "intent" ? intentHistory.status() : snapshotHistory.status();
}

function notify() {
    const status = combinedStatus();
    listeners.forEach((listener) => listener(status));
}

snapshotHistory.subscribe(notify);
intentHistory.subscribe(notify);

export function recordPlanOperation(detail = {}) {
    if (detail.mode === "granular" && detail.inverse) {
        mode = "intent";
        intentHistory.record({ operation: detail.operation, inverse: detail.inverse });
    } else {
        mode = "snapshot";
        snapshotHistory.pushUndo();
    }
    notify();
}

// Kept as the explicit local-snapshot API for non-collaborative trips.
export function pushUndo() {
    mode = "snapshot";
    snapshotHistory.pushUndo();
}

export function undo() {
    return mode === "intent" ? intentHistory.undo() : snapshotHistory.undo();
}

export function redo() {
    return mode === "intent" ? intentHistory.redo() : snapshotHistory.redo();
}

export const historyStatus = combinedStatus;
export function subscribeHistory(listener) {
    listeners.add(listener);
    listener(combinedStatus());
    return () => listeners.delete(listener);
}

export function clearHistory() {
    snapshotHistory.clear();
    intentHistory.clear();
    mode = "snapshot";
    notify();
}

export function configureHistoryView(callback) {
    restoreView = callback;
}
