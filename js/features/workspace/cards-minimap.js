// VS Code-style minimap of the day cards (desktop only).
//
// The page (window) is the scroller: the cards live in normal flow below the
// intro, so there is no inner scroll container. The "virtual scroll" the
// minimap works with is therefore derived from the cards region (#days):
//   scrollTop = stickyTop - daysRect.top   (content y at the top of the visible
//               cards viewport; negative while the region is below the page top)
//   clientH   = innerHeight - stickyTop - gap (visible cards viewport height)
//   scrollH   = #days height
// stickyTop is the navbar + tag bar + date strip offset, read from the minimap's
// own sticky `top` so it always matches the day headers' offset.
//
// Scrolling never changes the selected day; this module never touches
// `store.active`. Redraws: the planner dispatches "planner-rendered" at the end
// of every render(); a ResizeObserver on #days additionally catches height
// changes that bypass render() (fonts, timeline expand, divider moves). Scroll
// only repaints from a cached layout model, so it never measures every row.

import { store } from "../../core/store.js";
import { daysEl } from "../../shared/dom.js";
import {
    SCALE,
    MAX_WIDTH,
    minimapGeometry,
    scrollTopFromSlider,
    scrollTopFromPoint,
    contentYFromMinimap,
} from "./minimap-geometry.js";

const root = document.querySelector("#cardsMinimap");
const layout = root?.closest(".days-layout");
const clip = root?.querySelector(".cards-minimap-clip");
const canvas = root?.querySelector(".cards-minimap-canvas");
const slider = root?.querySelector(".cards-minimap-slider");
const label = root?.querySelector(".cards-minimap-label");
const labelText = label?.querySelector(".cards-minimap-label-text");

const BOTTOM_GAP = 8;
const PAD = 4; // horizontal padding inside the minimap
const HEAD_PX = 52; // real day header height (min-height); sticky compaction must not leak in
const INTERACTIVE_REVEAL = 0.6;
const COLOR_TOKENS = {
    card: "--card",
    line: "--line",
    accent: "--red",
    head: "--green",
    text: "--muted",
};

let reveal = 0;
// True when #days has no measurable cards: the minimap then hides and gives
// its column back instead of showing a slider over nothing.
let empty = false;
let model = null;
let colors = null;
let stickyTop = 0;
let frame = 0;
let refreshPending = false;
let dirty = true;
let dragging = false;
let grab = 0;
let lastKey = "";
let lastDpr = 0;
let lastHeight = -1;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function syncVisibility() {
    const shown = empty ? 0 : reveal;
    layout.style.setProperty("--minimap-reveal", String(shown));
    root.hidden = shown <= 0;
    clip.style.pointerEvents = shown > INTERACTIVE_REVEAL ? "auto" : "none";
    if (shown <= 0) hideLabel();
}

// Called by workspace-resize.js whenever the divider moves.
export function setMinimapReveal(value) {
    if (!root) return;
    const next = clamp(Number(value) || 0, 0, 1);
    if (next === reveal) return;
    const wasHidden = reveal <= 0;
    reveal = next;
    syncVisibility();
    if (reveal <= 0) {
        endDrag();
        hideLabel();
    } else if (wasHidden) scheduleRefresh();
    else schedulePaint();
}

// Re-measures the cards and repaints. Safe to call at any time.
export function refreshMinimap() {
    scheduleRefresh();
}

function readColors() {
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
    root.append(probe);
    const out = {};
    for (const [key, token] of Object.entries(COLOR_TOKENS)) {
        probe.style.color = `var(${token})`;
        out[key] = getComputedStyle(probe).color;
    }
    probe.remove();
    return out;
}

function buildModel() {
    const base = daysEl.getBoundingClientRect();
    const spotLength = (el) => {
        if (el.dataset.travelLeg)
            return [...el.querySelectorAll(".travel-card-stop-name")]
                .reduce((sum, n) => sum + n.textContent.trim().length, 0) || 10;
        return (el.dataset.spotName || "").length || 8;
    };
    const days = [];
    for (const el of daysEl.children) {
        if (!el.classList.contains("day")) continue;
        const rect = el.getBoundingClientRect();
        if (!rect.height) continue;
        const collapsed = el.classList.contains("collapsed");
        const rows = [];
        if (!collapsed)
            for (const row of el.querySelectorAll(".spots > .spot")) {
                const r = row.getBoundingClientRect();
                if (!r.height) continue;
                rows.push({
                    y: r.top - base.top,
                    h: r.height,
                    x: r.left - base.left,
                    w: r.width,
                    len: spotLength(row),
                    travel: Boolean(row.dataset.travelLeg),
                    disabled: row.classList.contains("spot-disabled"),
                });
            }
        days.push({
            id: el.dataset.day,
            backlog: el.classList.contains("backlog"),
            y: rect.top - base.top,
            h: rect.height,
            x: rect.left - base.left,
            w: rect.width,
            rows,
        });
    }
    model = { width: Math.max(1, base.width), height: base.height, days };
    if (empty !== (days.length === 0)) {
        empty = days.length === 0;
        if (empty) endDrag();
        syncVisibility();
    }
}

function metrics() {
    const top = parseFloat(getComputedStyle(root).top);
    stickyTop = Number.isFinite(top) ? top : 0;
    const clientH = Math.max(1, window.innerHeight - stickyTop - BOTTOM_GAP);
    const viewH = Math.max(1, Math.min(clientH, model ? model.height : clientH));
    const scrollTop = stickyTop - daysEl.getBoundingClientRect().top;
    return { clientH, viewH, scrollTop };
}

function currentGeometry() {
    if (!model) return null;
    const m = metrics();
    return {
        ...m,
        ...minimapGeometry({
            scrollTop: m.scrollTop,
            scrollH: model.height,
            clientH: m.clientH,
            viewH: m.viewH,
        }),
    };
}

function roundedRect(ctx, x, y, w, h, r) {
    if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, r);
    } else {
        ctx.beginPath();
        ctx.rect(x, y, w, h);
    }
}

function drawCanvas(g) {
    const dpr = window.devicePixelRatio || 1;
    const w = MAX_WIDTH;
    const h = Math.round(g.viewH);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(0, -g.off);
    const sx = (w - PAD * 2) / model.width;
    const visibleTop = g.off - 4;
    const visibleBottom = g.off + h + 4;
    for (const day of model.days) {
        const top = day.y * SCALE;
        const height = day.h * SCALE;
        if (top + height < visibleTop || top > visibleBottom) continue;
        const x = PAD + day.x * sx;
        const cw = day.w * sx;
        const active = store.active === day.id;
        roundedRect(ctx, x, top, cw, height, 1.5);
        ctx.fillStyle = colors.card;
        ctx.fill();
        ctx.lineWidth = active ? 1.5 : 1;
        ctx.strokeStyle = active ? colors.accent : colors.line;
        ctx.stroke();
        // Header bar: the app has no per-day color, so a neutral accent is used.
        ctx.globalAlpha = day.backlog ? 0.35 : 0.7;
        ctx.fillStyle = colors.head;
        ctx.fillRect(x + 1, top + 1, Math.max(0, cw - 2), Math.max(2, Math.min(HEAD_PX * SCALE, height) - 2));
        ctx.globalAlpha = 1;
        for (const row of day.rows) {
            const ry = row.y * SCALE;
            if (ry + row.h * SCALE < visibleTop || ry > visibleBottom) continue;
            const rh = row.h * SCALE;
            const bh = clamp(rh * 0.3, 1.5, 3);
            const by = ry + (rh - bh) / 2;
            const bx = PAD + row.x * sx + 4;
            const maxW = Math.max(2, cw - 12);
            ctx.globalAlpha = row.disabled ? 0.25 : row.travel ? 0.4 : 0.65;
            ctx.fillStyle = colors.text;
            ctx.fillRect(bx, by, 4, bh);
            ctx.fillRect(bx + 7, by, clamp(row.len * 1.6, 4, maxW - 7), bh);
        }
        ctx.globalAlpha = 1;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function paint() {
    frame = 0;
    if (reveal <= 0 || empty || !model) return;
    const g = currentGeometry();
    root.style.height = `${Math.round(g.viewH)}px`;
    const dpr = window.devicePixelRatio || 1;
    const key = `${Math.round(g.off * 2)}|${Math.round(g.viewH)}|${dpr}|${store.active}`;
    if (dirty || key !== lastKey || dpr !== lastDpr || g.viewH !== lastHeight) {
        drawCanvas(g);
        lastKey = key;
        lastDpr = dpr;
        lastHeight = g.viewH;
        dirty = false;
    }
    slider.style.height = `${g.sliderH}px`;
    slider.style.transform = `translateY(${g.sliderTop}px)`;
}

function schedulePaint() {
    if (!frame) frame = requestAnimationFrame(paint);
}

function scheduleRefresh() {
    if (refreshPending) return;
    refreshPending = true;
    requestAnimationFrame(() => {
        refreshPending = false;
        if (reveal <= 0) {
            dirty = true;
            return;
        }
        colors = readColors();
        buildModel();
        dirty = true;
        schedulePaint();
    });
}

// ---- Interaction -----------------------------------------------------------

function pointerY(event) {
    return event.clientY - clip.getBoundingClientRect().top;
}

function scrollToVirtual(target) {
    const g = currentGeometry();
    if (!g) return;
    window.scrollBy({ top: clamp(target, 0, g.maxScroll) - g.scrollTop, behavior: "instant" });
    schedulePaint();
}

function endDrag() {
    if (!dragging) return;
    dragging = false;
    root.classList.remove("is-dragging");
}

function hideLabel() {
    label.hidden = true;
}

function showLabel(y) {
    const g = currentGeometry();
    if (!g) return hideLabel();
    const cy = contentYFromMinimap(y, g.off);
    const day = model.days.find((d) => cy >= d.y && cy <= d.y + d.h) ||
        model.days.reduce((best, d) => {
            const dist = Math.min(Math.abs(cy - d.y), Math.abs(cy - d.y - d.h));
            return !best || dist < best.dist ? { d, dist } : best;
        }, null)?.d;
    if (!day) return hideLabel();
    // The day's own title identifies it better than its position; textContent
    // keeps the user-provided title safe.
    const index = store.state.findIndex((d) => d.id === day.id);
    const title = index >= 0 ? String(store.state[index].title || "").trim() : "";
    labelText.textContent = day.backlog
        ? "Backlog"
        : title || (index >= 0 ? `Día ${index + 1}` : "Día");
    label.style.top = `${y}px`;
    label.hidden = false;
    // Above the pointer by default; below it when there is no room on top.
    label.classList.toggle("is-below", y - label.offsetHeight - 10 < 0);
}

function wire() {
    clip.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || reveal <= INTERACTIVE_REVEAL) return;
        const g = currentGeometry();
        if (!g) return;
        event.preventDefault();
        const y = pointerY(event);
        if (y >= g.sliderTop && y <= g.sliderTop + g.sliderH) grab = y - g.sliderTop;
        else {
            scrollToVirtual(scrollTopFromPoint(y, g));
            grab = g.sliderH / 2;
        }
        dragging = true;
        root.classList.add("is-dragging");
        hideLabel();
        clip.setPointerCapture(event.pointerId);
    });
    clip.addEventListener("pointermove", (event) => {
        const y = pointerY(event);
        if (!dragging) return showLabel(y);
        const g = currentGeometry();
        if (g) scrollToVirtual(scrollTopFromSlider(y - grab, g));
    });
    const finish = (event) => {
        if (clip.hasPointerCapture(event.pointerId)) clip.releasePointerCapture(event.pointerId);
        endDrag();
    };
    clip.addEventListener("pointerup", finish);
    clip.addEventListener("pointercancel", finish);
    clip.addEventListener("pointerleave", hideLabel);
    clip.addEventListener(
        "wheel",
        (event) => {
            event.preventDefault();
            const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
            window.scrollBy({ top: event.deltaY * unit, behavior: "instant" });
        },
        { passive: false },
    );
}

if (root) {
    wire();
    window.addEventListener("scroll", schedulePaint, { passive: true });
    window.addEventListener("resize", scheduleRefresh, { passive: true });
    document.addEventListener("planner-rendered", scheduleRefresh);
    if (typeof ResizeObserver === "function") new ResizeObserver(scheduleRefresh).observe(daysEl);
    // Theme: the app follows the system scheme; a data-theme/class toggle is
    // covered too so colors are re-read whichever mechanism is used.
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", scheduleRefresh);
    new MutationObserver(scheduleRefresh).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "data-theme"],
    });
}
