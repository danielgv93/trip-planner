import { spotIsEnabled } from "../../core/store.js?v=26";
import { activityDuration } from "../../core/itinerary.js";

export function dayWorkload(day, travel = null) {
    const activity = (day?.spots || [])
        .filter(spotIsEnabled)
        .reduce(
            (total, spot) => total + activityDuration(spot),
            0,
        );
    return { activity, travel };
}
