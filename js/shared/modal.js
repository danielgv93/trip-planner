// Shared behavior for every native dialog in the application. Feature modules
// own each modal's content and business actions; this module owns the common
// shell interactions so close buttons, cancel buttons, backdrops and scrolling
// behave consistently.

const initialized = new WeakSet();
const closeControlSelector = ".close, .cancel, [data-modal-close]";

function canScroll(element, modal, deltaY) {
    for (let current = element; current && current !== modal; current = current.parentElement) {
        const { overflowY } = getComputedStyle(current);
        if (!/(auto|scroll)/.test(overflowY) || current.scrollHeight <= current.clientHeight) continue;

        const atTop = current.scrollTop <= 0;
        const atBottom = current.scrollTop + current.clientHeight >= current.scrollHeight - 1;
        if ((deltaY < 0 && !atTop) || (deltaY > 0 && !atBottom)) return true;
    }
    return false;
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

    modal.addEventListener(
        "wheel",
        (event) => {
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
        },
        { passive: false },
    );
}

export function setupModals(root = document) {
    root.querySelectorAll("dialog").forEach(setupModal);
}

export function openModal(modal) {
    setupModal(modal);
    if (!modal.open) modal.showModal();
}

setupModals();
