// Pure math for the scroll-linked pinned day header. The header morphs from its
// full height to a one-line bar over RANGE pixels of scroll. Its height is
// always handed back as a bottom margin, so the flow height of a day is the
// same for every progress value and nothing below the header moves.

// Scroll distance (px) over which the header morphs. Pure function of scroll.
export const RANGE = 48;
// Compact bar height (px). Mirrors `--day-head-compact-h` in
// styles/features/planner.css, which sticky-days.js reads at runtime.
export const COMPACT_HEIGHT = 42;

const round2 = (n) => Math.round(n * 100) / 100;

// 0..1 progress given how far the day top has passed the sticky stack.
export function stuckProgress(stackTop, dayTop, range = RANGE) {
    const passed = Number(stackTop) - Number(dayTop);
    if (!Number.isFinite(passed) || passed <= 0) return 0;
    const span = Number(range);
    if (!Number.isFinite(span) || span <= 0) return 1;
    return Math.min(1, passed / span);
}

// Interpolated header height. Headers already at or below the compact height
// are left alone.
export function morphHeight(fullHeight, compactHeight, progress) {
    const full = Number(fullHeight),
        compact = Number(compactHeight);
    if (!Number.isFinite(full)) return 0;
    if (!Number.isFinite(compact) || full <= compact) return round2(full);
    const p = Math.min(1, Math.max(0, Number(progress) || 0));
    return round2(full - p * (full - compact));
}

// Bottom margin that keeps full = height + margin.
export function morphMargin(fullHeight, height) {
    const full = Number(fullHeight),
        h = Number(height);
    if (!Number.isFinite(full) || !Number.isFinite(h)) return 0;
    return Math.max(0, round2(full - h));
}
