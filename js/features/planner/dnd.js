// Custom pointer-events drag-and-drop — deliberately NOT native HTML5 DnD, whose
// OS drag image can't be styled. Instead we float a styled clone ("ghost") under
// the cursor and animate the remaining cards with a FLIP technique
// (captureRects() -> reorder DOM -> playFlip()). moveSpot() commits the result.
//
// This is a side-effect module: importing it wires the drag listeners on #days.

import { daysEl } from "../../shared/dom.js";
import { store } from "../../core/store.js?v=28";
import { moveDay, moveSpot, moveTravelCard, render } from "./render.js";
import { toast } from "../../shared/notify.js?v=4";

let dragEl = null,
    ghost = null,
    dragSpotId = null,
    dragTravelKey = null,
    grabDX = 0,
    grabDY = 0,
    startX = 0,
    startY = 0,
    dragging = false,
    dragPointerId = null,
    cardW = 0,
    settled = false,
    // Swallows the click that fires right after a drag so it isn't a tap.
    suppressClick = false;

let dayDragEl = null,
    dayGhost = null,
    dragDayId = null,
    dayGrabDX = 0,
    dayGrabDY = 0,
    dayStartX = 0,
    dayStartY = 0,
    dayDragging = false,
    dayPointerId = null,
    dayCardW = 0,
    daySettled = false;

export function isDragInProgress() {
    return dragging || dayDragging;
}

function insertionPoint(list, y) {
    const items = [...list.querySelectorAll(".spot:not(.dragging)")];
    return items.reduce(
        (closest, item) => {
            const box = item.getBoundingClientRect(),
                offset = y - box.top - box.height / 2;
            return offset < 0 && offset > closest.offset
                ? { offset, element: item }
                : closest;
        },
        { offset: Number.NEGATIVE_INFINITY, element: null },
    ).element;
}

function captureRects(elements) {
    const m = new Map();
    elements.forEach((el) => m.set(el, el.getBoundingClientRect()));
    return m;
}

function playFlip(first, elements, draggedElement) {
    const els = [...elements].filter((el) => el !== draggedElement);
    els.forEach((el) => {
        el.style.transition = "none";
        el.style.transform = "none";
    });
    const moved = [];
    els.forEach((el) => {
        const f = first.get(el);
        if (!f) return;
        const l = el.getBoundingClientRect(),
            dx = f.left - l.left,
            dy = f.top - l.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        el.style.transform = `translate(${dx}px,${dy}px)`;
        moved.push(el);
    });
    requestAnimationFrame(() =>
        moved.forEach((el) => {
            el.style.transition = "transform .24s cubic-bezier(.2,.8,.2,1)";
            el.style.transform = "none";
        }),
    );
}

function endCleanup() {
    ghost?.remove();
    ghost = null;
    dragEl?.classList.remove("dragging");
    daysEl.classList.remove("is-dragging");
    document
        .querySelectorAll(".spots")
        .forEach((x) => x.classList.remove("drag-over"));
    document.body.style.userSelect = "";
    document.body.style.webkitUserSelect = "";
    dragEl = null;
    dragging = false;
    dragSpotId = null;
    dragTravelKey = null;
    dragPointerId = null;
}

function onMove(e) {
    if (!dragEl || e.pointerId !== dragPointerId) return;
    if (!dragging) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) <= 5) return;
        ghost = dragEl.cloneNode(true);
        ghost.classList.add("spot-ghost");
        ghost.style.width = cardW + "px";
        document.body.append(ghost);
        dragEl.classList.add("dragging");
        daysEl.classList.add("is-dragging");
        document.body.style.userSelect = "none";
        document.body.style.webkitUserSelect = "none";
        getSelection()?.removeAllRanges();
        dragging = true;
    }
    e.preventDefault();
    ghost.style.transform = `translate(${e.clientX - grabDX}px,${e.clientY - grabDY}px) rotate(2.5deg) scale(1.04)`;
    if (e.clientY < 60) window.scrollBy(0, -12);
    else if (e.clientY > innerHeight - 60) window.scrollBy(0, 12);
    const under = document.elementFromPoint(e.clientX, e.clientY),
        list = under && under.closest(".spots");
    if (!list) return;
    document
        .querySelectorAll(".spots")
        .forEach((x) => x.classList.toggle("drag-over", x === list));
    const ref = insertionPoint(list, e.clientY);
    if (ref === dragEl) return;
    if (
        ref
            ? ref === dragEl.nextElementSibling
            : dragEl.parentElement === list &&
              list.lastElementChild === dragEl
    )
        return;
    const first = captureRects(daysEl.querySelectorAll(".spot"));
    if (ref) list.insertBefore(dragEl, ref);
    else list.appendChild(dragEl);
    playFlip(first, daysEl.querySelectorAll(".spot"), dragEl);
}

function onUp(e) {
    if (e.pointerId !== dragPointerId) return;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    if (!dragging) {
        dragEl = null;
        dragSpotId = null;
        dragTravelKey = null;
        dragPointerId = null;
        return;
    }
    suppressClick = true;
    const list = dragEl.parentElement,
        dayId = dragEl.closest(".day").dataset.day,
        backlogGroupId =
            dayId === "backlog" ? list.dataset.backlogGroup : undefined,
        index = [...list.querySelectorAll(".spot")].indexOf(dragEl),
        spotId = dragSpotId,
        travelKey = dragTravelKey,
        followingItem = [...list.querySelectorAll(".spot")]
            .slice(index + 1)
            .find((item) => item.dataset.spot || item.dataset.travelLeg),
        followingSpot = followingItem?.dataset.spot || followingItem?.dataset.travelLeg?.split(">")[0] || null;
    settled = false;
    const commit = () => {
        if (settled) return;
        settled = true;
        endCleanup();
        if (travelKey) moveTravelCard(travelKey, dayId, followingSpot);
        else moveSpot(spotId, dayId, index, backlogGroupId);
    };
    const r = dragEl.getBoundingClientRect();
    ghost.style.transition = "transform .18s cubic-bezier(.2,.8,.2,1)";
    ghost.style.transform = `translate(${r.left}px,${r.top}px) rotate(0deg) scale(1)`;
    ghost.addEventListener("transitionend", commit, { once: true });
    setTimeout(commit, 220);
}

function onCancel(e) {
    if (e?.pointerId !== undefined && e.pointerId !== dragPointerId) return;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    const wasDragging = dragging;
    endCleanup();
    if (wasDragging) render();
}

function dayInsertionPoint(y) {
    const items = [
        ...daysEl.querySelectorAll(".day:not(.backlog):not(.dragging)"),
    ];
    return items.reduce(
        (closest, item) => {
            const box = item.getBoundingClientRect(),
                offset = y - box.top - box.height / 2;
            return offset < 0 && offset > closest.offset
                ? { offset, element: item }
                : closest;
        },
        { offset: Number.NEGATIVE_INFINITY, element: null },
    ).element;
}

function endDayCleanup() {
    dayGhost?.remove();
    dayGhost = null;
    dayDragEl?.classList.remove("dragging");
    daysEl.classList.remove("is-day-dragging");
    document.body.style.userSelect = "";
    document.body.style.webkitUserSelect = "";
    dayDragEl = null;
    dragDayId = null;
    dayDragging = false;
    dayPointerId = null;
}

function onDayMove(e) {
    if (!dayDragEl || e.pointerId !== dayPointerId) return;
    if (!dayDragging) {
        if (
            Math.hypot(e.clientX - dayStartX, e.clientY - dayStartY) <= 5
        )
            return;
        dayGhost = dayDragEl.cloneNode(true);
        dayGhost.classList.add("day-ghost");
        dayGhost.style.width = dayCardW + "px";
        document.body.append(dayGhost);
        dayDragEl.classList.add("dragging");
        daysEl.classList.add("is-day-dragging");
        document.body.style.userSelect = "none";
        document.body.style.webkitUserSelect = "none";
        getSelection()?.removeAllRanges();
        dayDragging = true;
    }
    e.preventDefault();
    dayGhost.style.transform = `translate(${e.clientX - dayGrabDX}px,${e.clientY - dayGrabDY}px) rotate(1.5deg) scale(1.02)`;
    if (e.clientY < 60) window.scrollBy(0, -12);
    else if (e.clientY > innerHeight - 60) window.scrollBy(0, 12);

    const ref = dayInsertionPoint(e.clientY);
    if (
        ref
            ? ref === dayDragEl.nextElementSibling
            : daysEl.lastElementChild === dayDragEl
    )
        return;
    const first = captureRects(
        daysEl.querySelectorAll(".day:not(.backlog)"),
    );
    if (ref) daysEl.insertBefore(dayDragEl, ref);
    else daysEl.append(dayDragEl);
    playFlip(
        first,
        daysEl.querySelectorAll(".day:not(.backlog)"),
        dayDragEl,
    );
}

function onDayUp(e) {
    if (e.pointerId !== dayPointerId) return;
    window.removeEventListener("pointermove", onDayMove);
    window.removeEventListener("pointerup", onDayUp);
    window.removeEventListener("pointercancel", onDayCancel);
    if (!dayDragging) {
        dayDragEl = null;
        dragDayId = null;
        dayPointerId = null;
        return;
    }
    suppressClick = true;
    const index = [
            ...daysEl.querySelectorAll(".day:not(.backlog)"),
        ].indexOf(dayDragEl),
        dayId = dragDayId;
    daySettled = false;
    const commit = () => {
        if (daySettled) return;
        daySettled = true;
        endDayCleanup();
        moveDay(dayId, index);
    };
    const r = dayDragEl.getBoundingClientRect();
    dayGhost.style.transition = "transform .18s cubic-bezier(.2,.8,.2,1)";
    dayGhost.style.transform = `translate(${r.left}px,${r.top}px) rotate(0deg) scale(1)`;
    dayGhost.addEventListener("transitionend", commit, { once: true });
    setTimeout(commit, 220);
}

function onDayCancel(e) {
    if (e?.pointerId !== undefined && e.pointerId !== dayPointerId) return;
    window.removeEventListener("pointermove", onDayMove);
    window.removeEventListener("pointerup", onDayUp);
    window.removeEventListener("pointercancel", onDayCancel);
    const wasDragging = dayDragging;
    // Invalidate a pending transitionend/timeout commit after pointerup.
    daySettled = true;
    endDayCleanup();
    if (wasDragging) render({ persist: false });
}

daysEl.addEventListener("pointerdown", (e) => {
    if (store.previewMode) return;
    if (dayDragEl) return;
    const item = e.target.closest(".spot");
    if (!item) return;
    // Reordering under a filter would splice a filtered index into the
    // unfiltered array and corrupt hidden-spot order — block the drag before
    // any drag state (ghost, DOM reorder) is set up.
    if (store.activeTagFilter.size > 0) {
        toast("Limpia el filtro para reordenar las paradas.", "info");
        return;
    }
    suppressClick = false;
    // The schedule rail is an interactive, keyboard-focusable detail. Keep it
    // out of the drag start area so hover/focus feedback remains reliable.
    if (e.target.closest(".spot-actions, .travel-card-actions, .spot-hours, .spot-toggle")) return;
    if (e.button !== undefined && e.button !== 0) return;
    if (e.pointerType === "touch" && !e.target.closest(".handle")) return;
    const travelKey = item.dataset.travelLeg || null;
    if (travelKey && !e.target.closest(".travel-card-handle")) return;
    dragEl = item;
    dragSpotId = item.dataset.spot;
    dragTravelKey = travelKey;
    startX = e.clientX;
    startY = e.clientY;
    dragPointerId = e.pointerId;
    const rect = item.getBoundingClientRect();
    grabDX = e.clientX - rect.left;
    grabDY = e.clientY - rect.top;
    cardW = rect.width;
    dragging = false;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
});

daysEl.addEventListener("pointerdown", (e) => {
    if (store.previewMode || dragEl) return;
    const handle = e.target.closest(".day-handle");
    if (!handle || !daysEl.contains(handle)) return;
    if (e.button !== undefined && e.button !== 0) return;
    const item = handle.closest(".day:not(.backlog)");
    if (!item) return;
    suppressClick = false;
    dayDragEl = item;
    dragDayId = item.dataset.day;
    dayStartX = e.clientX;
    dayStartY = e.clientY;
    dayPointerId = e.pointerId;
    const rect = item.getBoundingClientRect();
    dayGrabDX = e.clientX - rect.left;
    dayGrabDY = e.clientY - rect.top;
    dayCardW = rect.width;
    dayDragging = false;
    window.addEventListener("pointermove", onDayMove);
    window.addEventListener("pointerup", onDayUp);
    window.addEventListener("pointercancel", onDayCancel);
});

window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dragging) onCancel();
    else if (e.key === "Escape" && dayDragging) onDayCancel();
});

window.addEventListener(
    "click",
    (e) => {
        if (suppressClick) {
            suppressClick = false;
            e.stopPropagation();
            e.preventDefault();
        }
    },
    true,
);
