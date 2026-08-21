// Vertical budget for the sticky map/notes aside.
//
// The aside is `position: sticky`, so whatever falls past the bottom of the
// viewport is unreachable: scrolling moves the page, not the pinned panel. A
// budget measured from the sticky offset is therefore only correct once the
// panel has actually pinned; before that the panel still sits at its flow
// position under the intro, and the notes entry point gets cut off.
//
// So the budget is measured from the panel's flow position, which is the worst
// case, and the map gives up the difference. Predictable beats clever here: a
// budget recomputed while scrolling would resize the Leaflet viewport on every
// frame.

const workspace = document.querySelector(".workspace");
const intro = document.querySelector(".intro");
const navbar = document.querySelector("header.top");
const root = document.documentElement;
const desktop = matchMedia("(min-width: 961px)");

const STICKY_GAP = 20;
const BOTTOM_GAP = 20;
// Bar + a still-usable map + foot + the notes row. Below this the panel cannot
// hold its own content, and pinning it would hide the notes for good.
const MIN_PANE = 400;

let frame = 0;

function stickyOffset() {
    const nav = parseFloat(
        getComputedStyle(root).getPropertyValue("--nav-height"),
    );
    return (Number.isFinite(nav) ? nav : 0) + STICKY_GAP;
}

function update() {
    if (!desktop.matches) {
        root.style.removeProperty("--sticky-pane-height");
        document.body.classList.remove("sticky-pane-unpinned");
        return;
    }
    // The workspace is not sticky, so its box is its flow position at any
    // scroll offset. The panel starts at the top of that grid row.
    const flowTop = workspace.getBoundingClientRect().top + window.scrollY;
    const available =
        window.innerHeight - Math.max(stickyOffset(), flowTop) - BOTTOM_GAP;
    document.body.classList.toggle("sticky-pane-unpinned", available < MIN_PANE);
    root.style.setProperty(
        "--sticky-pane-height",
        `${Math.round(Math.max(available, MIN_PANE))}px`,
    );
}

function scheduleUpdate() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
}

window.addEventListener("resize", scheduleUpdate, { passive: true });
desktop.addEventListener("change", scheduleUpdate);
// The flow position moves when the copy above the workspace rewraps — a
// narrower window, a longer trip title, or a late webfont swap.
if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(intro);
    observer.observe(navbar);
}
document.fonts?.ready.then(scheduleUpdate);
update();
