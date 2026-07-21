import { spotIsEnabled } from "../../core/store.js?v=26";

export function dayWorkload(day, travel = null) {
    const activity = (day?.spots || [])
        .filter(spotIsEnabled)
        .reduce(
            (total, spot) => total +
                (Number.isInteger(spot.visitMinutes) && spot.visitMinutes > 0
                    ? spot.visitMinutes
                    : 0),
            0,
        );
    return { activity, travel };
}
