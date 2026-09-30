// Sticky header behaviour tied to the trip hero (the large editable title):
// the compact title in the header only shows once the hero has scrolled away,
// and the measured header height feeds the sticky offsets of the planner.

import { $ } from "../../shared/dom.js";

const header = document.querySelector("header.top");
const hero = document.querySelector(".trip-hero");
const titleInput = $("#tripTitle");
const compactTitle = $("#tripCompactTitle");
const root = document.documentElement;

export function syncCompactTitle() {
    compactTitle.textContent = titleInput.value.trim() || "Viaje";
}

function publishHeaderHeight() {
    root.style.setProperty("--top-header-h", `${Math.round(header.getBoundingClientRect().height)}px`);
}

let heroObserver = null;
function observeHero() {
    heroObserver?.disconnect();
    // The hero counts as gone once it slides under the sticky header.
    const offset = Math.round(header.getBoundingClientRect().height);
    heroObserver = new IntersectionObserver(([entry]) => {
        header.dataset.heroVisible = String(entry.isIntersecting);
    }, { rootMargin: `-${offset}px 0px 0px 0px`, threshold: 0 });
    heroObserver.observe(hero);
}

// The compact title is only meaningful while the planner is visible. In
// companion mode `#plannerView` is hidden and the title input is inert, so the
// control is disabled (not focusable, no-op) until the planner is shown again.
const plannerView = document.querySelector("#plannerView");
function syncCompactTitleAvailability() {
    const available = !plannerView || !plannerView.hidden;
    compactTitle.disabled = !available;
    compactTitle.setAttribute("aria-disabled", String(!available));
    if (available) compactTitle.removeAttribute("tabindex");
    else compactTitle.tabIndex = -1;
}
if (plannerView) {
    new MutationObserver(syncCompactTitleAvailability).observe(plannerView, {
        attributes: true,
        attributeFilter: ["hidden"],
    });
}
syncCompactTitleAvailability();

compactTitle.addEventListener("click", () => {
    if (plannerView?.hidden) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    // Focusing on touch devices would pop the keyboard; only scroll there.
    if (!matchMedia("(pointer: coarse)").matches) titleInput.focus({ preventScroll: true });
});
titleInput.addEventListener("input", syncCompactTitle);

let lastHeight = -1;
new ResizeObserver(() => {
    publishHeaderHeight();
    const height = Math.round(header.getBoundingClientRect().height);
    if (height !== lastHeight) {
        lastHeight = height;
        observeHero();
    }
}).observe(header);

syncCompactTitle();
publishHeaderHeight();
observeHero();
