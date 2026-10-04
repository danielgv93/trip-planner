// Drop rail: while a stop is dragged in a day with many rows, a compact fixed
// panel shows the whole day in miniature and acts as an alternative drop
// target, so long-distance moves do not need autoscrolling. It only reports
// where the pointer would drop; dnd.js owns the actual move and commit.

import {
    insertionIndexFromMidpoints,
    outlineRowsMarkup,
    readDayOutline,
} from "./day-outline.js";

export const DROP_RAIL_MIN_ROWS = 8;

const MIN_ROW_H = 16,
    MAX_ROW_H = 28,
    EDGE_ZONE = 28,
    EDGE_SPEED = 10,
    GAP = 12,
    IDLE_TITLE = "Soltar en este día";

let rail = null,
    listEl = null,
    candidates = [], // { row, li } excluding the dragged row
    outlineEl = null,
    lineEl = null,
    headEl = null,
    scrollerEl = null,
    scrollSpeed = 0,
    scrollFrame = 0;

function stickyTop() {
    const css = getComputedStyle(document.documentElement);
    const px = (name) => parseFloat(css.getPropertyValue(name)) || 0;
    return px("--top-header-h") + px("--date-strip-height") + 8;
}

function position(count) {
    const vw = innerWidth,
        width = Math.min(260, vw * 0.44),
        top = Math.min(stickyTop(), innerHeight * 0.3),
        maxH = innerHeight - top - 12,
        listRect = listEl.getBoundingClientRect(),
        // Beside the day column when it fits, otherwise over the viewport edge.
        fits = listRect.right + GAP + width <= vw - 8,
        left = fits ? listRect.right + GAP : vw - width - 8;
    rail.style.maxHeight = `${maxH}px`;
    // Measure the real chrome so every row fits without internal scrolling.
    const chromeH = rail.offsetHeight - scrollerEl.clientHeight;
    const rowH = Math.max(
        MIN_ROW_H,
        Math.min(MAX_ROW_H, Math.floor((maxH - chromeH) / count)),
    );
    rail.style.setProperty("--day-outline-row-h", `${rowH}px`);
    rail.style.width = `${width}px`;
    rail.style.left = `${left}px`;
    rail.style.top = `${top}px`;
}

export function openDropRail({ listEl: list, dragEl }) {
    closeDropRail();
    if (!list) return;
    const rows = readDayOutline(list);
    if (rows.length < DROP_RAIL_MIN_ROWS) return;
    const source = rows.find((row) => row.element === dragEl);
    listEl = list;
    rail = document.createElement("aside");
    rail.className = "drop-rail";
    rail.setAttribute("aria-hidden", "true");
    rail.innerHTML =
        `<div class="drop-rail-head">${IDLE_TITLE}</div>` +
        '<div class="drop-rail-body"><ol class="day-outline">' +
        outlineRowsMarkup(rows, { sourceKey: source?.key }) +
        '</ol><div class="drop-rail-line" hidden></div></div>';
    document.body.append(rail);
    scrollerEl = rail.querySelector(".drop-rail-body");
    outlineEl = rail.querySelector(".day-outline");
    lineEl = rail.querySelector(".drop-rail-line");
    headEl = rail.querySelector(".drop-rail-head");
    const items = [...outlineEl.children];
    candidates = rows
        .map((row, i) => ({ row, li: items[i] }))
        .filter(({ row }) => row !== source);
    position(rows.length);
}

function stopAutoscroll() {
    scrollSpeed = 0;
    if (scrollFrame) cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
}

function autoscroll() {
    if (!scrollerEl || !scrollSpeed) {
        scrollFrame = 0;
        return;
    }
    scrollerEl.scrollTop += scrollSpeed;
    scrollFrame = requestAnimationFrame(autoscroll);
}

function hideIndicator() {
    if (lineEl) lineEl.hidden = true;
    if (headEl) {
        headEl.textContent = IDLE_TITLE;
        headEl.classList.remove("is-target");
    }
    stopAutoscroll();
}

// Returns null when the pointer is outside the rail, otherwise
// { before } where `before` is the real list row to insert before (null = end).
export function updateDropRail(clientX, clientY) {
    if (!rail) return null;
    const rect = rail.getBoundingClientRect();
    if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
    ) {
        hideIndicator();
        return null;
    }
    const body = scrollerEl.getBoundingClientRect();
    if (scrollerEl.scrollHeight > scrollerEl.clientHeight) {
        scrollSpeed =
            clientY < body.top + EDGE_ZONE
                ? -EDGE_SPEED
                : clientY > body.bottom - EDGE_ZONE
                  ? EDGE_SPEED
                  : 0;
        if (scrollSpeed && !scrollFrame) scrollFrame = requestAnimationFrame(autoscroll);
    } else stopAutoscroll();

    const mids = candidates.map(({ li }) => {
        const box = li.getBoundingClientRect();
        return box.top + box.height / 2;
    });
    const index = insertionIndexFromMidpoints(mids, clientY);
    const next = candidates[index] || null,
        prev = candidates[index - 1] || null;

    // Line sits at the top edge of the next row, or the bottom of the last.
    const bodyTop = scrollerEl.getBoundingClientRect().top;
    const y = next
        ? next.li.getBoundingClientRect().top
        : prev
          ? prev.li.getBoundingClientRect().bottom
          : bodyTop;
    const rel = y - bodyTop + scrollerEl.scrollTop;
    lineEl.style.transform = `translateY(${rel}px)`;
    lineEl.hidden = false;

    // The destination lives in the header, away from the ghost under the pointer.
    headEl.textContent = !prev
        ? "Al principio del día"
        : !next
          ? "Al final del día"
          : `Después de: ${prev.row.label || "parada"}`;
    headEl.classList.add("is-target");
    return { before: next ? next.row.element : null };
}

// The list the rail was opened for, so dnd.js can drop into it.
export function dropRailList() {
    return listEl;
}

export function closeDropRail() {
    stopAutoscroll();
    rail?.remove();
    rail = listEl = outlineEl = lineEl = headEl = scrollerEl = null;
    candidates = [];
}
