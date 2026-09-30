// Keeps sticky day headers immediately below the responsive navbar and adds a
// subtle elevated state only while a header is pinned. The actual hand-off
// between days is handled by CSS sticky positioning and each article's bounds.

import { daysEl } from "../../shared/dom.js";
import { setDateStripCurrent } from "./date-strip.js";
import { COMPACT_HEIGHT, RANGE, morphHeight, morphMargin, stuckProgress } from "./sticky-compact.js";

const navbar = document.querySelector(".top"),
    tagBar = document.querySelector("#tagBar"),
    dateStrip = document.querySelector("#dateStrip"),
    stickyGap = 0;
let frame = 0;

// Compact height comes from CSS (`--day-head-compact-h`) so JS and styles share
// one source of truth; the exported constant is only a fallback.
function compactHeight() {
    const v = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--day-head-compact-h"),
    );
    return Number.isFinite(v) && v > 0 ? v : COMPACT_HEIGHT;
}

function clearMorph(head) {
    clearMorphStyle(head);
    head.classList.remove("is-stuck");
}

// Drops every morph artefact except the plain `is-stuck` toggle.
function clearMorphStyle(head) {
    head.classList.remove("is-morphing", "is-pinned-compact");
    head.style.removeProperty("height");
    head.style.removeProperty("margin-bottom");
    head.style.removeProperty("--stuck-p");
    delete head.dataset.stuckP;
}

// Full (p=0) height, cached per head only while the head is away from p=0. The
// cache is dropped whenever the head returns to p=0 (see `applyProgress`), so
// in-place updates, splitter resizes or title wrapping never reuse stale heights.
function fullHeightOf(head, key) {
    if (head.dataset.fullKey === key) return Number(head.dataset.fullH);
    clearMorph(head);
    const full = head.offsetHeight;
    head.dataset.fullH = String(full);
    head.dataset.fullKey = key;
    return full;
}

// Applies scroll progress `p` (0..1) to a head. Height + margin-bottom is
// constant for every p, so the flow never moves. Only writes on change.
function applyProgress(head, p, full, compact) {
    if (p <= 0) {
        if (head.dataset.stuckP !== undefined || head.classList.contains("is-stuck")) clearMorph(head);
        delete head.dataset.fullH;
        delete head.dataset.fullKey;
        return;
    }
    const value = p.toFixed(3);
    if (head.dataset.stuckP === value) return;
    head.dataset.stuckP = value;
    const height = morphHeight(full, compact, p),
        margin = morphMargin(full, height);
    head.classList.add("is-stuck");
    head.classList.toggle("is-morphing", p < 1);
    head.classList.toggle("is-pinned-compact", p >= 1);
    head.style.setProperty("--stuck-p", value);
    head.style.height = `${height}px`;
    head.style.marginBottom = margin ? `${margin}px` : "";
}

function update() {
    frame = 0;
    const navHeight = navbar.getBoundingClientRect().height,
        tagBarRect = tagBar.getBoundingClientRect(),
        // The tag bar is hidden while the date strip (which hosts the filter)
        // is shown, leaving navbar + strip as the only sticky stack.
        tagBarHeight = tagBar.hidden ? 0 : tagBarRect.height,
        // Zero while the strip is hidden (short trips), so heads stay put.
        stripHeight = dateStrip.hidden ? 0 : dateStrip.getBoundingClientRect().height,
        dayStickyTop = navHeight + tagBarHeight + stripHeight + stickyGap;
    // `--nav-height` aliases `--top-header-h`, which trip-header.js measures.
    document.documentElement.style.setProperty(
        "--tag-bar-height",
        `${tagBarHeight}px`,
    );
    document.documentElement.style.setProperty(
        "--date-strip-height",
        `${stripHeight}px`,
    );
    tagBar.classList.toggle("is-stuck", !tagBar.hidden && tagBarRect.top <= navHeight + 0.5);
    dateStrip.classList.toggle(
        "is-stuck",
        !dateStrip.hidden &&
            dateStrip.getBoundingClientRect().top <= navHeight + tagBarHeight + 0.5,
    );

    // The day in view is the last real day whose top has reached the sticky
    // stack; at the very bottom of the page the last day wins even if its
    // short body never reaches that line.
    let currentId = null;
    const atBottom =
        window.scrollY > 0 &&
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    daysEl.querySelectorAll(".day").forEach((day) => {
        if (day.dataset.day !== "backlog" && (atBottom || day.getBoundingClientRect().top <= dayStickyTop + 1))
            currentId = day.dataset.day;
    });
    setDateStripCurrent(currentId);

    // Read phase: every rect first, then the writes.
    const widthKey = String(window.innerWidth),
        compact = compactHeight(),
        heads = [];
    daysEl.querySelectorAll(".day").forEach((day) => {
        const head = day.querySelector(":scope > .day-head");
        if (!head) return;
        if (day.classList.contains("backlog")) {
            // Backlog heads keep their own pinned state without morphing.
            const r = day.getBoundingClientRect();
            head.classList.toggle("is-stuck", r.top <= dayStickyTop + 0.5 && r.bottom > dayStickyTop + 1);
            return;
        }
        const r = day.getBoundingClientRect(),
            p = r.bottom > dayStickyTop + 1 ? stuckProgress(dayStickyTop, r.top, RANGE) : 0;
        heads.push({
            head,
            p,
            collapsed: day.classList.contains("collapsed"),
            key: `${widthKey}|${day.classList.contains("collapsed") ? 1 : 0}`,
        });
    });
    // Write phase. The one-time full-height measurement happens only for heads
    // leaving p=0 (or whose cache key changed) and never moves the flow.
    heads.forEach(({ head, p, key, collapsed }) => {
        if (collapsed) {
            // Already a single line: plain pin, no morph, no inline geometry.
            if (head.dataset.stuckP !== undefined || head.style.height) clearMorph(head);
            delete head.dataset.fullH;
            delete head.dataset.fullKey;
            head.classList.toggle("is-stuck", p > 0);
            return;
        }
        if (p <= 0) {
            applyProgress(head, 0, 0, compact);
            return;
        }
        const stale = head.dataset.fullKey !== key;
        if (stale && head.dataset.stuckP) delete head.dataset.stuckP;
        applyProgress(head, p, fullHeightOf(head, key), compact);
    });
}

function scheduleUpdate() {
    if (!frame) frame = requestAnimationFrame(update);
}

window.addEventListener("scroll", scheduleUpdate, { passive: true });
window.addEventListener("resize", scheduleUpdate, { passive: true });
// Sticky offsets are measured, never assumed: each resize of a stacked element
// republishes its height immediately (the callback already runs at frame time).
const stackObserver = new ResizeObserver(update);
stackObserver.observe(navbar);
stackObserver.observe(tagBar);
stackObserver.observe(dateStrip);
new MutationObserver(scheduleUpdate).observe(dateStrip, { attributes: true, attributeFilter: ["hidden"] });
new MutationObserver(scheduleUpdate).observe(daysEl, { childList: true });
scheduleUpdate();
