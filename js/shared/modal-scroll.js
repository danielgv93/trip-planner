// Keep wheel gestures inside a native dialog from reaching the page without
// changing the document's layout or scroll state. A gesture is allowed only
// while an internal scroll container can consume it in the requested direction.

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

document.querySelectorAll("dialog").forEach((modal) => {
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
});
