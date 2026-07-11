// Custom pointer-events drag-and-drop — deliberately NOT native HTML5 DnD, whose
// OS drag image can't be styled. Instead we float a styled clone ("ghost") under
// the cursor and animate the remaining cards with a FLIP technique
// (captureRects() -> reorder DOM -> playFlip()). moveSpot() commits the result.
//
// This is a side-effect module: importing it wires the drag listeners on #days.

import { daysEl } from "./dom.js";
import { store } from "./store.js";
import { moveSpot, render } from "./render.js";

let dragEl = null,
    ghost = null,
    dragSpotId = null,
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

function captureRects() {
    const m = new Map();
    daysEl
        .querySelectorAll(".spot")
        .forEach((el) => m.set(el, el.getBoundingClientRect()));
    return m;
}

function playFlip(first) {
    const els = [...daysEl.querySelectorAll(".spot")].filter(
        (el) => el !== dragEl,
    );
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
    dragPointerId = null;
}

function onMove(e) {
    if (!dragEl) return;
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
    const first = captureRects();
    if (ref) list.insertBefore(dragEl, ref);
    else list.appendChild(dragEl);
    playFlip(first);
}

function onUp(e) {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    if (!dragging) {
        dragEl = null;
        dragSpotId = null;
        return;
    }
    suppressClick = true;
    const list = dragEl.parentElement,
        dayId = dragEl.closest(".day").dataset.day,
        index = [...list.querySelectorAll(".spot")].indexOf(dragEl),
        spotId = dragSpotId;
    settled = false;
    const commit = () => {
        if (settled) return;
        settled = true;
        endCleanup();
        moveSpot(spotId, dayId, index);
    };
    const r = dragEl.getBoundingClientRect();
    ghost.style.transition = "transform .18s cubic-bezier(.2,.8,.2,1)";
    ghost.style.transform = `translate(${r.left}px,${r.top}px) rotate(0deg) scale(1)`;
    ghost.addEventListener("transitionend", commit, { once: true });
    setTimeout(commit, 220);
}

function onCancel() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    const wasDragging = dragging;
    endCleanup();
    if (wasDragging) render();
}

daysEl.addEventListener("pointerdown", (e) => {
    if (store.previewMode) return;
    suppressClick = false;
    const item = e.target.closest(".spot");
    if (!item) return;
    if (e.target.closest(".spot-actions")) return;
    if (e.button !== undefined && e.button !== 0) return;
    if (e.pointerType === "touch" && !e.target.closest(".handle")) return;
    dragEl = item;
    dragSpotId = item.dataset.spot;
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

window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dragging) onCancel();
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
