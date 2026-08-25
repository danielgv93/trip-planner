// Shared behavior for every native dialog in the application. Feature modules
// own each modal's content and business actions; this module owns the common
// shell interactions so close buttons, cancel buttons, backdrops and scrolling
// behave consistently.

const initialized = new WeakSet();
const closeControlSelector = ".close, .cancel, [data-modal-close]";
const openModals = [];

function canScroll(element, modal, deltaY) {
    if (element !== modal && !modal.contains(element)) return false;

    for (let current = element; current; current = current.parentElement) {
        const { overflowY } = getComputedStyle(current);
        if (/(auto|scroll)/.test(overflowY) && current.scrollHeight > current.clientHeight) {
            const atTop = current.scrollTop <= 0;
            const atBottom = current.scrollTop + current.clientHeight >= current.scrollHeight - 1;
            if ((deltaY < 0 && !atTop) || (deltaY > 0 && !atBottom)) return true;
        }
        if (current === modal) break;
    }
    return false;
}

function activeModal() {
    while (openModals.length && !openModals.at(-1).open) openModals.pop();
    return openModals.at(-1) || [...document.querySelectorAll("dialog[open]")].at(-1) || null;
}

function keepModalInViewport(modal) {
    // Some WebViews still lay out modal dialogs as absolute elements despite
    // the shared fixed-position rule. Compensate only in that case; `translate`
    // composes with feature animations that use `transform`.
    const isFixed = getComputedStyle(modal).position === "fixed";
    modal.style.translate = isFixed ? "" : `${window.scrollX}px ${window.scrollY}px`;
}

function blockBackgroundScroll(event) {
    const modal = activeModal();
    if (!modal) return;

    const bounds = modal.getBoundingClientRect();
    const isOverContent =
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right &&
        event.clientY >= bounds.top &&
        event.clientY <= bounds.bottom;
    const isVerticalGesture = Math.abs(event.deltaY) >= Math.abs(event.deltaX);

    if (!isOverContent || (isVerticalGesture && !canScroll(event.target, modal, event.deltaY))) {
        event.preventDefault();
    }
}

export function setupModal(modal) {
    if (initialized.has(modal)) return;
    initialized.add(modal);

    modal.addEventListener("click", (event) => {
        const closeControl = event.target.closest?.(closeControlSelector);
        if (closeControl && modal.contains(closeControl)) {
            event.preventDefault();
            modal.close();
            return;
        }

        // Native dialog backdrop clicks are retargeted to the dialog itself.
        if (event.target === modal) modal.close();
    });

    modal.addEventListener("close", () => {
        const index = openModals.lastIndexOf(modal);
        if (index !== -1) openModals.splice(index, 1);
        modal.style.translate = "";
    });
}

export function setupModals(root = document) {
    root.querySelectorAll("dialog").forEach(setupModal);
}

export function openModal(modal) {
    setupModal(modal);
    if (!modal.open) {
        modal.showModal();
        openModals.push(modal);
        keepModalInViewport(modal);
    }
}

document.addEventListener("wheel", blockBackgroundScroll, { capture: true, passive: false });
window.addEventListener("scroll", () => {
    const modal = activeModal();
    if (modal) keepModalInViewport(modal);
}, { passive: true });
setupModals();
