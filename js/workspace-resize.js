// Adjustable desktop split between the itinerary and map. The preference is
// local presentation state, expressed as a ratio so it survives viewport
// changes without becoming an awkward fixed pixel width.

import { store, save } from "./store.js";
import { invalidateMainMap } from "./map.js";

const workspace = document.querySelector(".workspace");
const handle = document.querySelector("#workspaceResizeHandle");
const desktop = matchMedia("(min-width: 961px)");
const HANDLE_WIDTH = 23;
const MIN_PLANNER = 450;
const MIN_MAP = 430;
const DEFAULT_SPLIT = 0.51;
const KEYBOARD_STEP = 24;

let resizeFrame = 0;
let dragging = false;
let observedWorkspaceWidth = workspace.clientWidth;

function bounds() {
    const available = workspace.clientWidth - HANDLE_WIDTH;
    return {
        available,
        min: Math.min(MIN_PLANNER, Math.max(0, available - MIN_MAP)),
        max: Math.max(MIN_PLANNER, available - MIN_MAP),
    };
}

function updateAccessibility(width, { min, max }) {
    handle.setAttribute("aria-valuemin", String(Math.round(min)));
    handle.setAttribute("aria-valuemax", String(Math.round(max)));
    handle.setAttribute("aria-valuenow", String(Math.round(width)));
    handle.setAttribute(
        "aria-valuetext",
        `${Math.round(width)} píxeles para el listado`,
    );
}

function repaintMap() {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(invalidateMainMap);
}

function applyWidth(requestedWidth) {
    const limits = bounds();
    const width = Math.min(limits.max, Math.max(limits.min, requestedWidth));
    workspace.style.setProperty("--planner-pane-width", `${width}px`);
    updateAccessibility(width, limits);
    repaintMap();
    return { width, available: limits.available };
}

function applyPreference() {
    if (!desktop.matches) {
        workspace.style.removeProperty("--planner-pane-width");
        repaintMap();
        return;
    }
    const { available } = bounds();
    applyWidth(available * (store.workspaceSplit ?? DEFAULT_SPLIT));
}

function commit(width, available) {
    store.workspaceSplit = available > 0 ? width / available : null;
    save();
}

handle.addEventListener("pointerdown", (event) => {
    if (!desktop.matches || event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("workspace-resizing");

    const move = (moveEvent) => {
        const left = workspace.getBoundingClientRect().left;
        applyWidth(moveEvent.clientX - left - HANDLE_WIDTH / 2);
    };
    const finish = (finishEvent) => {
        if (handle.hasPointerCapture(finishEvent.pointerId))
            handle.releasePointerCapture(finishEvent.pointerId);
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", finish);
        document.body.classList.remove("workspace-resizing");
        const plannerWidth = workspace.querySelector(".planner").getBoundingClientRect().width;
        commit(plannerWidth, bounds().available);
        dragging = false;
    };

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
});

handle.addEventListener("keydown", (event) => {
    if (!desktop.matches) return;
    const plannerWidth = workspace.querySelector(".planner").getBoundingClientRect().width;
    let requested = null;
    if (event.key === "ArrowLeft") requested = plannerWidth - KEYBOARD_STEP;
    if (event.key === "ArrowRight") requested = plannerWidth + KEYBOARD_STEP;
    if (event.key === "Home") requested = bounds().min;
    if (event.key === "End") requested = bounds().max;
    if (requested === null) return;
    event.preventDefault();
    const result = applyWidth(requested);
    commit(result.width, result.available);
});

handle.addEventListener("dblclick", () => {
    store.workspaceSplit = null;
    save();
    applyPreference();
});

desktop.addEventListener("change", applyPreference);
new ResizeObserver(([entry]) => {
    // Cards reflow vertically while their column changes width. Observing the
    // whole box without filtering would treat those height-only updates as a
    // viewport resize and reapply the previous split mid-drag.
    const width = entry.contentRect.width;
    if (dragging || Math.abs(width - observedWorkspaceWidth) < 0.5) return;
    observedWorkspaceWidth = width;
    applyPreference();
}).observe(workspace);
applyPreference();
