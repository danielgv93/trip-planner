// Session-only history for user-initiated plan mutations. History deliberately
// stays outside store/save(), so reloading starts with empty undo/redo stacks.

import { createUndoStack } from "../../core/undo-stack.js";
import { store, save } from "../../core/store.js?v=26";
import { clearHealthResults } from "../health/session.js";

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
    "tripNotes",
    "routeProfile",
    "routeVisualization",
    "routeTimeOverrides",
    "routeTimeProfiles",
    "travelLegs",
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
    SNAPSHOT_KEYS.forEach((key) => {
        store[key] = snapshot[key];
    });
    store.active =
        snapshot.active &&
        (snapshot.active === "backlog" ||
            store.state.some((day) => day.id === snapshot.active))
            ? snapshot.active
            : store.state[0]?.id || "backlog";
    save();
    restoreView();
}

const history = createUndoStack({ capture: capturePlan, restore: restorePlan });

export const pushUndo = history.pushUndo;
export const undo = history.undo;
export const redo = history.redo;
export const historyStatus = history.status;
export const subscribeHistory = history.subscribe;

export function configureHistoryView(callback) {
    restoreView = callback;
}
