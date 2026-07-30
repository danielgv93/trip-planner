// Pure opening-hours calculations shared by planner views and tests.

import { timeToMinutes } from "../../core/time.js";

export function openingHourSegments(openingTime, closingTime) {
    const opening = timeToMinutes(openingTime),
        closing = timeToMinutes(closingTime);
    if (opening === null || closing === null) return [];
    if (opening === closing)
        return [{ start: 0, width: 100, equal: true }];

    const percentage = (minutes) =>
        Math.min(100, Math.max(0, (minutes / 1440) * 100));
    if (opening < closing)
        return [
            {
                start: percentage(opening),
                width: percentage(closing - opening),
            },
        ];
    return [
        {
            start: percentage(opening),
            width: percentage(1440 - opening),
        },
        { start: 0, width: percentage(closing) },
    ];
}

export function scheduleIntervals(openingTime, closingTime) {
    const opening = timeToMinutes(openingTime),
        closing = timeToMinutes(closingTime);
    if (opening === 0 && closing === 0) return [[0, 1440]];
    // Equal endpoints are intentionally ambiguous in this data model. Show
    // their full rail, but do not pretend they overlap with other schedules.
    if (opening === null || closing === null || opening === closing) return [];
    return opening < closing
        ? [[opening, closing]]
        : [[opening, 1440], [0, closing]];
}

export function schedulesOverlap(firstOpening, firstClosing, secondOpening, secondClosing) {
    const first = scheduleIntervals(firstOpening, firstClosing),
        second = scheduleIntervals(secondOpening, secondClosing);
    return first.some(([start, end]) =>
        second.some(([otherStart, otherEnd]) => start < otherEnd && otherStart < end),
    );
}

export function scheduleOverlapSegments(
    firstOpening,
    firstClosing,
    secondOpening,
    secondClosing,
) {
    const first = scheduleIntervals(firstOpening, firstClosing),
        second = scheduleIntervals(secondOpening, secondClosing),
        percentage = (minutes) =>
            Math.min(100, Math.max(0, (minutes / 1440) * 100));
    return first.flatMap(([start, end]) =>
        second.flatMap(([otherStart, otherEnd]) => {
            const overlapStart = Math.max(start, otherStart),
                overlapEnd = Math.min(end, otherEnd);
            return overlapStart < overlapEnd
                ? [
                      {
                          start: percentage(overlapStart),
                          width: percentage(overlapEnd - overlapStart),
                      },
                  ]
                : [];
        }),
    );
}
