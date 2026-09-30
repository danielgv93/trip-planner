// Keeps sticky day headers immediately below the responsive navbar and adds a
// subtle elevated state only while a header is pinned. The actual hand-off
// between days is handled by CSS sticky positioning and each article's bounds.

import { daysEl } from "../../shared/dom.js";
import { setDateStripCurrent } from "./date-strip.js";

const navbar = document.querySelector(".top"),
    tagBar = document.querySelector("#tagBar"),
    dateStrip = document.querySelector("#dateStrip"),
    stickyGap = 0;
let frame = 0;

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
    document.documentElement.style.setProperty(
        "--nav-height",
        `${navHeight}px`,
    );
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
new ResizeObserver(scheduleUpdate).observe(dateStrip);
new MutationObserver(scheduleUpdate).observe(dateStrip, { attributes: true, attributeFilter: ["hidden"] });
new MutationObserver(scheduleUpdate).observe(daysEl, { childList: true });
scheduleUpdate();
