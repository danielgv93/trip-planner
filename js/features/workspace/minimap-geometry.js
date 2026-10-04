// Pure geometry for the itinerary minimap. No DOM access, so it is unit-tested
// in Node. "Scroll" here is the virtual scroll of the day-cards region:
//   scrollTop  = content-space y of the top of the visible cards viewport
//                (it may be < 0 while the region is still below the page top)
//   clientH    = height of the visible cards viewport
//   scrollH    = full height of the cards region
// The minimap draws the region at scale S and, like VS Code, offsets its own
// content when the scaled region is taller than the minimap itself.

export const SCALE = 0.12;
export const MAX_WIDTH = 78;
export const REVEAL_START = 0.45; // map fraction at which the minimap starts to appear
export const REVEAL_RANGE = 0.05; // fully revealed at REVEAL_START - REVEAL_RANGE
// Widest map fraction at which the minimap is fully revealed. The default
// workspace split sits exactly here so every user sees the minimap first.
export const FULL_REVEAL_MAP_FRACTION = REVEAL_START - REVEAL_RANGE;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function smoothstep(t) {
    const x = clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
}

// 0 while the map is wider than REVEAL_START of the workspace, 1 at
// FULL_REVEAL_MAP_FRACTION or narrower.
export function revealForMapFraction(fraction) {
    if (!Number.isFinite(fraction)) return 0;
    return smoothstep((REVEAL_START - fraction) / REVEAL_RANGE);
}

export function mapFraction(mapWidth, available) {
    return available > 0 ? mapWidth / available : 1;
}

export function minimapGeometry({ scrollTop, scrollH, clientH, viewH, scale = SCALE }) {
    const maxScroll = Math.max(1, scrollH - clientH);
    const contentMini = scrollH * scale;
    const sliderH = clientH * scale;
    const off = contentMini > viewH
        ? (clamp(scrollTop, 0, maxScroll) / maxScroll) * (contentMini - viewH)
        : 0;
    const k = contentMini > viewH ? (viewH - sliderH) / maxScroll : scale;
    return {
        maxScroll,
        contentMini,
        sliderH,
        off,
        k,
        sliderTop: scrollTop * scale - off,
    };
}

// Slider top (minimap px) -> virtual scrollTop, clamped to the scrollable range.
export function scrollTopFromSlider(sliderTop, geometry) {
    if (!(geometry.k > 0)) return 0;
    return clamp(sliderTop / geometry.k, 0, geometry.maxScroll);
}

// Clicking outside the slider centers the viewport on the clicked point.
export function scrollTopFromPoint(y, { off, clientH }, scale = SCALE) {
    return (y + off) / scale - clientH / 2;
}

// Minimap y -> content y, used to find the day under the pointer.
export function contentYFromMinimap(y, off, scale = SCALE) {
    return (y + off) / scale;
}
