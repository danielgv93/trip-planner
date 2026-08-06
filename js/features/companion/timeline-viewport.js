// Pure conversions between a timeline's horizontal viewport and clock time.
// Keeping these independent from the DOM makes destructive renders able to
// restore the same visible time even when the timeline bounds have changed.

export function timelineViewportCenter({
    boundStart,
    boundEnd,
    scrollLeft,
    viewportWidth,
    trackWidth,
}) {
    const span = boundEnd - boundStart;
    if (
        !Number.isFinite(boundStart) ||
        !Number.isFinite(boundEnd) ||
        span <= 0 ||
        !Number.isFinite(scrollLeft) ||
        !Number.isFinite(viewportWidth) ||
        viewportWidth <= 0 ||
        !Number.isFinite(trackWidth) ||
        trackWidth <= 0
    ) return null;

    return boundStart + ((scrollLeft + viewportWidth / 2) / trackWidth) * span;
}

export function timelineScrollForCenter({
    boundStart,
    boundEnd,
    centerMinute,
    viewportWidth,
    trackWidth,
}) {
    const span = boundEnd - boundStart;
    if (
        !Number.isFinite(boundStart) ||
        !Number.isFinite(boundEnd) ||
        span <= 0 ||
        !Number.isFinite(centerMinute) ||
        !Number.isFinite(viewportWidth) ||
        viewportWidth <= 0 ||
        !Number.isFinite(trackWidth) ||
        trackWidth <= 0
    ) return 0;

    const centered = ((centerMinute - boundStart) / span) * trackWidth - viewportWidth / 2;
    return Math.max(0, Math.min(centered, Math.max(0, trackWidth - viewportWidth)));
}
