// Keeps sticky day headers immediately below the responsive navbar and adds a
// subtle elevated state only while a header is pinned. The actual hand-off
// between days is handled by CSS sticky positioning and each article's bounds.

import { daysEl } from "../../shared/dom.js";

const navbar = document.querySelector(".top"),
    tagBar = document.querySelector("#tagBar"),
    stickyGap = 0;
let frame = 0;

function update() {
    frame = 0;
    const navHeight = navbar.getBoundingClientRect().height,
        tagBarRect = tagBar.getBoundingClientRect(),
        dayStickyTop = navHeight + tagBarRect.height + stickyGap;
    document.documentElement.style.setProperty(
        "--nav-height",
        `${navHeight}px`,
    );
    document.documentElement.style.setProperty(
        "--tag-bar-height",
        `${tagBarRect.height}px`,
    );
    tagBar.classList.toggle("is-stuck", tagBarRect.top <= navHeight + 0.5);

    daysEl.querySelectorAll(".day").forEach((day) => {
        const head = day.querySelector(":scope > .day-head"),
            dayRect = day.getBoundingClientRect(),
            pinned =
                dayRect.top <= dayStickyTop + 0.5 &&
                dayRect.bottom > dayStickyTop + 1;
        head?.classList.toggle("is-stuck", pinned);
    });
}

function scheduleUpdate() {
    if (!frame) frame = requestAnimationFrame(update);
}

window.addEventListener("scroll", scheduleUpdate, { passive: true });
window.addEventListener("resize", scheduleUpdate, { passive: true });
new ResizeObserver(scheduleUpdate).observe(navbar);
new ResizeObserver(scheduleUpdate).observe(tagBar);
new MutationObserver(scheduleUpdate).observe(daysEl, { childList: true });
scheduleUpdate();
