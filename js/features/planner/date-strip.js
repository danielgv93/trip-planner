// Sticky horizontal strip with one pill per day, grouped by effective stage.
// It is rebuilt by render() (which is destructive) and only reads the plan: the
// current-day highlight is driven by sticky-days.js on scroll, and the workload
// dots are flipped by render.js's applyDayLoad so the load is computed once.
// While the strip is shown it also hosts the tag filter (a "Filtrar" button and
// popover) so navbar + one sticky row is all that sits above the days.

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
// A jump can target a day the page cannot scroll far enough to pin (the last
// days of a trip), so scroll position alone would highlight a neighbour. The
// clicked day stays highlighted until the user scrolls by hand.
let lockedDayId = null;
const releaseLock = () => { lockedDayId = null; };
for (const type of ["wheel", "touchstart", "keydown", "pointerdown"])
    window.addEventListener(type, releaseLock, { passive: true });

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
        : [...strip.querySelectorAll(key.tag !== undefined ? "[data-tag]" : "[data-day]")]
              .find((el) => el.dataset.tag === key.tag || el.dataset.day === key.day);
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

export function renderDateStrip(days, { onSelect, filter } = {}) {
    const strip = $("#dateStrip");
    if (!strip) return;
    const tagBar = $("#tagBar");
    const visible = shouldShowDateStrip(days.length);
    strip.hidden = !visible;
    // The strip replaces the standalone tag bar so only one row stays sticky.
    if (tagBar) tagBar.hidden = visible;
    if (!visible) {
        strip.replaceChildren();
        pills = new Map();
        filterOpen = false;
        return;
    }
    const scrollLeft = strip.querySelector(".date-strip-scroller")?.scrollLeft || 0;
    const focus = focusKey(strip);
    strip.innerHTML = `${filter ? filterMarkup(filter) : ""}<div class="date-strip-scroller">${groupDaysByStage(days)
        .map(({ stage, days: members }) => {
            const label = stage ? `${stage} · ${members.length}` : "";
            const items = members
                .map(({ day }) => {
                    const number = Number(day.date?.slice(8, 10)) || "·";
                    return `<button type="button" class="date-strip-pill${day.id === currentDayId ? " is-current" : ""}" data-day="${esc(String(day.id))}" data-base-label="${esc(pillLabel(day, stage))}" aria-label="${esc(pillLabel(day, stage))}"${day.id === currentDayId ? ' aria-current="true"' : ""}><span class="date-strip-weekday" aria-hidden="true">${esc(weekdayInitial(day.date) || "·")}</span><strong aria-hidden="true">${number}</strong><i class="date-strip-dot" aria-hidden="true"></i></button>`;
                })
                .join("");
            return `<div class="date-strip-group${stage ? "" : " is-unlabeled"}"><span class="date-strip-label" title="${esc(label)}">${esc(label)}</span><div class="date-strip-pills">${items}</div></div>`;
        })
        .join("")}</div>`;
    pills = new Map(
        [...strip.querySelectorAll(".date-strip-pill")].map((pill) => [pill.dataset.day, pill]),
    );
    // Rebuilding resets the scroller; put it back, then make sure the current
    // day is still on screen.
    const scroller = strip.querySelector(".date-strip-scroller");
    scroller.scrollLeft = scrollLeft;
    const current = pills.get(String(currentDayId));
    if (current) revealPill(scroller, current);
    restoreFocus(strip, focus);

    strip.onclick = (event) => {
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
        overloaded ? `${pill.dataset.baseLabel}, día muy cargado` : pill.dataset.baseLabel,
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
