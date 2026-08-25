import { spotIsEnabled, travelLeg } from "../../core/store.js";
import { foreignAmount, localAmount } from "./currency.js";

export function sumCosts(spots) {
    return spots.reduce(
        (total, spot) =>
            total +
            (spotIsEnabled(spot) &&
            Number.isFinite(spot?.cost) &&
            spot.cost > 0
                ? spot.cost
                : 0),
        0,
    );
}

export function sumTravelCosts(day) {
    const sequence = (day?.spots || []).filter(spotIsEnabled);
    let total = 0;
    for (let index = 1; index < sequence.length; index += 1) {
        const cost = travelLeg(sequence[index - 1].id, sequence[index].id)?.cost;
        if (Number.isFinite(cost) && cost > 0) total += cost;
    }
    return total;
}

export function formatCost(amount) {
    return foreignAmount(amount);
}

export function formatDualCost(amount) {
    return `${foreignAmount(amount)} · ${localAmount(amount)}`;
}
