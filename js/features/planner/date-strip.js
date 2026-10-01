// Sticky horizontal strip with one pill per day, grouped by effective stage.
// It is rebuilt by render() (which is destructive) and only reads the plan: the
// current-day highlight is driven by sticky-days.js on scroll, and the workload
// dots are flipped by render.js's applyDayLoad so the load is computed once.
// While the strip is shown it also hosts the tag filter (a "Filtrar" button and
// popover) so navbar + one sticky row is all that sits above the days.
// Pills can also be dragged sideways (mouse right away, touch after a long
// press so a plain swipe still scrolls the strip) or moved with Alt+←/→ to
// reorder days without scrolling through the whole itinerary.

import { $, esc } from "../../shared/dom.js";
import {
    groupDaysByStage,
    shouldShowDateStrip,
    weekdayInitial,
    weekdayLong,
} from "../../core/day-stages.js";

let currentDayId = null;
// Pills of the last build, keyed by day id, so load marks and the current-day
// highlight are O(1) lookups instead of a document-wide query per day.
let pills = new Map();
let filterOpen = false;
// Horizontal offset tracked from scroll events. render() calls
// renderDateStrip() while #days is half rebuilt, so reading scrollLeft there
// would force a layout of the shortened page and clamp window.scrollY (the page
// jumped up after adding a day). Layout reads wait for settleDateStrip().
let stripScrollLeft = 0;
let pendingSettle = null;
// A jump can target a day the page cannot scroll far enough to pin (the last
// days of a trip), so scroll position alone would highlight a neighbour. The
// clicked day stays highlighted until the user scrolls by hand.
let lockedDayId = null;
const releaseLock = () => { lockedDayId = null; };
for (const type of ["wheel", "touchstart", "keydown", "pointerdown"])
    window.addEventListener(type, releaseLock, { passive: true });

const LONG_PRESS_MS = 280;
const DRAG_THRESHOLD = 6;
const EDGE_SCROLL = 36;
// Pointer reorder in progress (or pending a long press); null when idle.
let reorder = null;
// The click that ends a drag must not also jump to the day.
let suppressClick = false;

function orderedPills(strip) {
    return [...strip.querySelectorAll(".date-strip-pill")];
}

function clearDropMarks(strip) {
    strip.querySelectorAll(".drop-before, .drop-after").forEach((pill) =>
        pill.classList.remove("drop-before", "drop-after"));
}

// Index the dragged day would take once removed and reinserted (moveDay's
// contract): the number of other pills whose centre lies left of the pointer.
function dropIndex(strip, dragged, clientX) {
    const others = orderedPills(strip).filter((pill) => pill !== dragged);
    let index = 0;
    for (const pill of others) {
        const rect = pill.getBoundingClientRect();
        if (clientX > rect.left + rect.width / 2) index += 1;
    }
    clearDropMarks(strip);
    if (others[index]) others[index].classList.add("drop-before");
    else others[index - 1]?.classList.add("drop-after");
    return index;
}

// One floating tooltip with the day's title, shared by every pill. It lives on
// <body> because the scroller's overflow-x also clips vertically.
let tip = null;
let tipPill = null;

function placeTip() {
    if (!tip || !tipPill) return;
    if (!tipPill.isConnected) return hideTip();
    const rect = tipPill.getBoundingClientRect(),
        width = tip.offsetWidth,
        left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(rect.bottom + 6)}px)`;
}

function showTip(pill) {
    if (!tip) {
        tip = document.createElement("div");
        tip.className = "date-strip-tip";
        tip.setAttribute("aria-hidden", "true");
        document.body.append(tip);
    }
    tipPill = pill;
    tip.innerHTML = `<strong>${esc(pill.dataset.title || "Día sin nombre")}</strong><small>${esc(pill.dataset.date || "")}</small>`;
    tip.hidden = false;
    placeTip();
}

function hideTip() {
    tipPill = null;
    if (tip) tip.hidden = true;
}

window.addEventListener("scroll", () => { if (!reorder?.dragging) hideTip(); }, { passive: true });

function paintReorder() {
    const { strip, pill, scroller, startX, startScroll, clientX } = reorder;
    const offset = clientX - startX + scroller.scrollLeft - startScroll;
    pill.style.transform = `translateX(${offset}px)`;
    reorder.target = dropIndex(strip, pill, clientX);
    if (tipPill === pill) placeTip();
}

// Keeps scrolling the strip while the pointer rests near either edge.
function edgeScroll() {
    if (!reorder?.dragging) return;
    const { scroller, clientX } = reorder;
    const box = scroller.getBoundingClientRect();
    const step = clientX < box.left + EDGE_SCROLL
        ? -Math.ceil((box.left + EDGE_SCROLL - clientX) / 4)
        : clientX > box.right - EDGE_SCROLL
          ? Math.ceil((clientX - (box.right - EDGE_SCROLL)) / 4)
          : 0;
    if (step) {
        scroller.scrollLeft += step;
        paintReorder();
    }
    reorder.frame = requestAnimationFrame(edgeScroll);
}

function beginReorder() {
    const { strip, pill } = reorder;
    reorder.dragging = true;
    clearTimeout(reorder.timer);
    strip.classList.add("is-reordering");
    pill.classList.add("is-dragging");
    // A pointer released while a touch long press was pending is gone.
    try { pill.setPointerCapture?.(reorder.pointerId); } catch {}
    navigator.vibrate?.(8);
    // Name the day being carried, also on touch where there is no hover.
    showTip(pill);
    paintReorder();
    reorder.frame = requestAnimationFrame(edgeScroll);
}

function endReorder({ commit }) {
    if (!reorder) return;
    const { strip, pill, dragging, from, target, onMove, timer, frame } = reorder;
    reorder = null;
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    window.removeEventListener("pointermove", onReorderMove);
    window.removeEventListener("pointerup", onReorderUp);
    window.removeEventListener("pointercancel", onReorderCancel);
    window.removeEventListener("keydown", onReorderKey, true);
    window.removeEventListener("touchmove", blockTouchScroll);
    if (!dragging) return;
    if (!pill.matches(":hover")) hideTip();
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    strip.classList.remove("is-reordering");
    pill.classList.remove("is-dragging");
    pill.style.transform = "";
    clearDropMarks(strip);
    if (commit && pill.isConnected && target !== from) onMove(pill.dataset.day, target);
}

function onReorderMove(event) {
    if (!reorder || event.pointerId !== reorder.pointerId) return;
    // A render while dragging (e.g. a collaborator's edit) replaced the pill.
    if (!reorder.pill.isConnected) return endReorder({ commit: false });
    reorder.clientX = event.clientX;
    const dx = event.clientX - reorder.startX,
        dy = event.clientY - reorder.startY;
    if (!reorder.dragging) {
        if (reorder.touch) {
            // Moving before the long press fires means the user is scrolling.
            if (Math.hypot(dx, dy) > DRAG_THRESHOLD) endReorder({ commit: false });
            return;
        }
        if (Math.abs(dx) < DRAG_THRESHOLD) return;
        beginReorder();
        return;
    }
    paintReorder();
}

function onReorderUp(event) {
    if (reorder && event.pointerId === reorder.pointerId) endReorder({ commit: true });
}

function onReorderCancel(event) {
    if (reorder && event.pointerId === reorder.pointerId) endReorder({ commit: false });
}

function onReorderKey(event) {
    if (event.key !== "Escape" || !reorder?.dragging) return;
    event.preventDefault();
    event.stopPropagation();
    endReorder({ commit: false });
}

function blockTouchScroll(event) {
    if (reorder?.dragging && event.cancelable) event.preventDefault();
}

function startReorder(event, strip, onMove) {
    const pill = event.target.closest(".date-strip-pill");
    if (!pill || !onMove || reorder) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const scroller = pill.closest(".date-strip-scroller");
    reorder = {
        strip,
        pill,
        scroller,
        onMove,
        pointerId: event.pointerId,
        touch: event.pointerType === "touch",
        startX: event.clientX,
        startY: event.clientY,
        clientX: event.clientX,
        startScroll: scroller.scrollLeft,
        from: orderedPills(strip).indexOf(pill),
        target: null,
        dragging: false,
        timer: null,
        frame: 0,
    };
    reorder.target = reorder.from;
    if (reorder.touch) reorder.timer = setTimeout(() => {
        if (reorder?.pill === pill && pill.isConnected) beginReorder();
    }, LONG_PRESS_MS);
    window.addEventListener("pointermove", onReorderMove);
    window.addEventListener("pointerup", onReorderUp);
    window.addEventListener("pointercancel", onReorderCancel);
    window.addEventListener("keydown", onReorderKey, true);
    window.addEventListener("touchmove", blockTouchScroll, { passive: false });
}

function pillLabel(day, stage) {
    const number = Number(day.date?.slice(8, 10)) || "";
    const parts = [`${weekdayLong(day.date)} ${number}`.trim() || "Día"];
    if (stage) parts.push(stage);
    return parts.join(", ");
}

function revealPill(scroller, pill, margin = 24) {
    const box = scroller.getBoundingClientRect(),
        rect = pill.getBoundingClientRect();
    if (rect.left < box.left + margin) scroller.scrollLeft -= box.left + margin - rect.left;
    else if (rect.right > box.right - margin) scroller.scrollLeft += rect.right - (box.right - margin);
}

function filterLabel(active) {
    if (active.size === 0) return "Filtrar";
    if (active.size === 1) return `#${[...active][0]}`;
    return `${active.size} filtros`;
}

function filterMarkup(filter) {
    const { tags = [], active = new Set() } = filter;
    const chips = tags.length
        ? tags
              .map((tag) => `<button type="button" class="tag${active.has(tag) ? " selected" : ""}" data-tag="${esc(tag)}" aria-pressed="${active.has(tag)}">#${esc(tag)}</button>`)
              .join("")
        : '<span class="date-strip-filter-empty">Aún no hay etiquetas.</span>';
    const hint = active.size ? `Filtrar por etiqueta, ${active.size === 1 ? "1 activa" : `${active.size} activas`}` : "Filtrar por etiqueta";
    return `<div class="date-strip-filter"><button type="button" class="date-strip-filter-button${active.size ? " is-active" : ""}" aria-expanded="${filterOpen}" aria-controls="dateStripFilterPanel" aria-label="${esc(hint)}" title="${esc(hint)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg><span>${esc(filterLabel(active))}</span></button>${active.size ? '<button type="button" class="date-strip-filter-clear" aria-label="Quitar filtros" title="Quitar filtros">×</button>' : ""}<div id="dateStripFilterPanel" class="date-strip-filter-panel" role="group" aria-label="Etiquetas" ${filterOpen ? "" : "hidden"}>${chips}</div></div>`;
}

function setFilterOpen(strip, open, { returnFocus = false } = {}) {
    filterOpen = open;
    const button = strip.querySelector(".date-strip-filter-button"),
        panel = strip.querySelector(".date-strip-filter-panel");
    if (!button || !panel) return;
    button.setAttribute("aria-expanded", String(open));
    panel.hidden = !open;
    if (!open && returnFocus) button.focus();
}

// Identifies the focused control so it survives the innerHTML rebuild.
function focusKey(strip) {
    const el = document.activeElement;
    if (!el || !strip.contains(el)) return null;
    if (el.dataset.tag !== undefined) return { tag: el.dataset.tag };
    if (el.dataset.day !== undefined) return { day: el.dataset.day };
    if (el.classList.contains("date-strip-filter-button")) return { button: true };
    return null;
}

function restoreFocus(strip, key) {
    if (!key) return;
    const target = key.button
        ? strip.querySelector(".date-strip-filter-button")
        : key.tag !== undefined
          ? [...strip.querySelectorAll("[data-tag]")].find((el) => el.dataset.tag === key.tag)
          : pills.get(key.day);
    target?.focus({ preventScroll: true });
}

document.addEventListener("pointerdown", (event) => {
    const strip = $("#dateStrip");
    if (filterOpen && strip && !event.target.closest?.(".date-strip-filter")) setFilterOpen(strip, false);
});
document.addEventListener("keydown", (event) => {
    const strip = $("#dateStrip");
    if (event.key !== "Escape" || !filterOpen || !strip) return;
    // Leave Escape to other handlers (open dialogs, day menus) that claimed it.
    if (event.defaultPrevented || document.querySelector("dialog[open]")) return;
    event.preventDefault();
    setFilterOpen(strip, false, { returnFocus: true });
});

document.addEventListener("focusout", (event) => {
    const strip = $("#dateStrip"),
        filter = event.target.closest?.(".date-strip-filter");
    // Keyboard users tabbing past the chips should not leave the panel open.
    if (!filterOpen || !strip || !filter) return;
    if (event.relatedTarget && filter.contains(event.relatedTarget)) return;
    // Focus lost to a destructive rebuild (relatedTarget null) is restored by render.
    if (!event.relatedTarget) return;
    setFilterOpen(strip, false);
});

// Runs once render() has appended every day: rebuilding reset the scroller, so
// put it back, keep the current day on screen and restore focus.
export function settleDateStrip() {
    if (!pendingSettle) return;
    const { strip, scroller, focus } = pendingSettle;
    pendingSettle = null;
    if (!scroller.isConnected) return;
    scroller.scrollLeft = stripScrollLeft;
    const current = pills.get(String(currentDayId));
    if (current) revealPill(scroller, current);
    restoreFocus(strip, focus);
}

export function renderDateStrip(days, { onSelect, onMove, filter } = {}) {
    const strip = $("#dateStrip");
    if (!strip) return;
    const tagBar = $("#tagBar");
    const visible = shouldShowDateStrip(days.length);
    strip.hidden = !visible;
    // The strip replaces the standalone tag bar so only one row stays sticky.
    if (tagBar) tagBar.hidden = visible;
    // The rebuild below replaces the pill being dragged.
    endReorder({ commit: false });
    hideTip();
    if (!visible) {
        strip.replaceChildren();
        pills = new Map();
        filterOpen = false;
        pendingSettle = null;
        stripScrollLeft = 0;
        return;
    }
    const focus = focusKey(strip);
    strip.classList.toggle("can-reorder", Boolean(onMove));
    const reorderHint = onMove ? ". Arrastra o usa Alt y flechas para mover el día" : "";
    strip.innerHTML = `${filter ? filterMarkup(filter) : ""}<div class="date-strip-scroller">${groupDaysByStage(days)
        .map(({ stage, days: members }) => {
            const label = stage ? `${stage} · ${members.length}` : "";
            const items = members
                .map(({ day, index }) => {
                    const number = Number(day.date?.slice(8, 10)) || "·";
                    const date = pillLabel(day, stage),
                        title = day.title?.trim() || "",
                        base = title ? `${date}. ${title}` : date;
                    return `<button type="button" class="date-strip-pill${day.id === currentDayId ? " is-current" : ""}" data-day="${esc(String(day.id))}" data-index="${index}" data-title="${esc(title)}" data-date="${esc(date)}" data-base-label="${esc(base)}" data-hint="${esc(reorderHint)}" aria-label="${esc(base + reorderHint)}"${onMove ? ' aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"' : ""}${day.id === currentDayId ? ' aria-current="true"' : ""}><span class="date-strip-weekday" aria-hidden="true">${esc(weekdayInitial(day.date) || "·")}</span><strong aria-hidden="true">${number}</strong><i class="date-strip-dot" aria-hidden="true"></i></button>`;
                })
                .join("");
            return `<div class="date-strip-group${stage ? "" : " is-unlabeled"}"><span class="date-strip-label" title="${esc(label)}">${esc(label)}</span><div class="date-strip-pills">${items}</div></div>`;
        })
        .join("")}</div>`;
    pills = new Map(
        [...strip.querySelectorAll(".date-strip-pill")].map((pill) => [pill.dataset.day, pill]),
    );
    const scroller = strip.querySelector(".date-strip-scroller");
    scroller.onscroll = () => { stripScrollLeft = scroller.scrollLeft; };
    pendingSettle = { strip, scroller, focus };

    strip.onpointerdown = (event) => startReorder(event, strip, onMove);
    strip.onpointerover = (event) => {
        const pill = event.target.closest(".date-strip-pill");
        if (pill && event.pointerType === "mouse" && !reorder?.dragging) showTip(pill);
    };
    strip.onpointerout = (event) => {
        const pill = event.target.closest(".date-strip-pill");
        if (pill && !pill.contains(event.relatedTarget) && !reorder?.dragging) hideTip();
    };
    strip.onfocusin = (event) => {
        const pill = event.target.closest(".date-strip-pill");
        if (pill?.matches(":focus-visible")) showTip(pill);
    };
    strip.onfocusout = (event) => {
        if (event.target.closest(".date-strip-pill") === tipPill) hideTip();
    };
    // The long press that starts a touch drag must not open the context menu.
    strip.oncontextmenu = (event) => {
        if (reorder && event.target.closest(".date-strip-pill")) event.preventDefault();
    };
    strip.onkeydown = (event) => {
        const pill = event.target.closest(".date-strip-pill");
        if (!pill || !onMove || !event.altKey) return;
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const index = Number(pill.dataset.index),
            target = index + (event.key === "ArrowLeft" ? -1 : 1);
        if (target < 0 || target >= days.length) return;
        onMove(pill.dataset.day, target);
    };
    strip.onclick = (event) => {
        if (suppressClick) return;
        const pill = event.target.closest(".date-strip-pill");
        if (pill) return onSelect?.(pill.dataset.day);
        if (event.target.closest(".date-strip-filter-button"))
            return setFilterOpen(strip, !filterOpen);
        if (event.target.closest(".date-strip-filter-clear")) return filter?.onClear?.();
        const chip = event.target.closest("[data-tag]");
        if (chip) filter?.onToggle?.(chip.dataset.tag);
    };
}

export function markDateStripLoad(dayId, overloaded) {
    const pill = pills.get(String(dayId));
    if (!pill) return;
    pill.classList.toggle("is-over", overloaded);
    pill.setAttribute(
        "aria-label",
        `${pill.dataset.baseLabel}${overloaded ? ", día muy cargado" : ""}${pill.dataset.hint || ""}`,
    );
}

// Highlights the day currently under the sticky headers and keeps its pill
// visible by scrolling only the strip itself (never the page).
export function lockDateStripCurrent(dayId) {
    lockedDayId = dayId;
    setDateStripCurrent(dayId, { force: true });
}

export function setDateStripCurrent(dayId, { force = false } = {}) {
    if (lockedDayId && !force) dayId = lockedDayId;
    // Scroll frames call this constantly: do nothing unless the day changed.
    if (dayId === currentDayId && !force) return;
    const previous = pills.get(String(currentDayId));
    currentDayId = dayId;
    if (previous) {
        previous.classList.remove("is-current");
        previous.removeAttribute("aria-current");
    }
    const current = pills.get(String(dayId));
    if (!current) return;
    current.classList.add("is-current");
    current.setAttribute("aria-current", "true");
    const scroller = current.closest(".date-strip-scroller");
    if (scroller) revealPill(scroller, current);
}
