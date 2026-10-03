// What each move in a proposal is worth, told as "without this change".
//
// Savings do not add up per stop: two moves can be worthless alone and only
// pay off together. So each move is measured by undoing it alone — the stop
// goes back next to the stops it sat beside, every other change stays — and
// re-simulating that order with the same legs and conditions. The verdict
// follows the same ranking as the headline: a lost booking, then the
// end-of-day limit, then a schedule conflict, and only then minutes.
// When moves only pay off together, they are reported as one group instead
// of a row of misleading near-zero figures.

const spotIndexOf = (key) => Number(key.split(":")[0]);

// The proposed order with `revertKeys` taken back to where they were. Each one
// is placed right after the stop it followed before, counting only stops that
// stayed or were already put back: those are the neighbours it returns to.
export function revertedOrder(diff, revertKeys) {
    const revert = new Set(revertKeys);
    const order = diff.after.map((entry) => entry.key).filter((key) => !revert.has(key));
    const anchors = new Set(diff.after.filter((entry) => entry.status === "stay").map((entry) => entry.key));
    const beforeKeys = diff.before.filter((entry) => entry.status !== "dropped").map((entry) => entry.key);
    beforeKeys.forEach((key, index) => {
        if (!revert.has(key)) return;
        let previous = index - 1;
        while (previous >= 0 && !anchors.has(beforeKeys[previous])) previous -= 1;
        const at = previous >= 0 ? order.indexOf(beforeKeys[previous]) + 1 : 0;
        order.splice(at, 0, key);
        anchors.add(key);
    });
    return order;
}

// Undoing a move must not slide a pinned, departure-bound or already visited
// stop off its slot: that order is one the traveller could not have.
function keepsLockedSlots(diff, orderKeys, lockedIndexes) {
    return lockedIndexes.every((spotIndex) => {
        const key = `${spotIndex}:1`;
        const now = diff.after.findIndex((entry) => entry.key === key);
        return now < 0 || orderKeys.indexOf(key) === now;
    });
}

function elapsed(result, fromNow) {
    return fromNow ? result.finish : result.finish - result.start;
}

const conflicted = (step) => !step.repeated && (step.late > 0 || step.outsideSchedule);

// Why the current order beats the reverted one, in the headline's order.
function verdict(reverted, current, fromNow) {
    const lateNow = new Set(current.steps.filter((step) => step.reserved && step.late > 0).map((step) => step.spotIndex));
    if (reverted.metrics.reservationLateStops > current.metrics.reservationLateStops) {
        const step = reverted.steps.find((candidate) => candidate.reserved && candidate.late > 0 && !lateNow.has(candidate.spotIndex));
        return { kind: "reservation", spot: step?.spot || null, planned: step?.planned ?? null };
    }
    if (reverted.metrics.overtime > current.metrics.overtime) return { kind: "limit" };
    if (reverted.metrics.scheduleConflictStops > current.metrics.scheduleConflictStops) {
        const conflictedNow = new Set(current.steps.filter(conflicted).map((step) => step.spotIndex));
        const step = reverted.steps.find((candidate) => conflicted(candidate) && !conflictedNow.has(candidate.spotIndex));
        return { kind: "conflict", spot: step?.spot || null };
    }
    return { kind: "minutes", minutes: elapsed(reverted, fromNow) - elapsed(current, fromNow) };
}

// `evaluate(spotIndexOrder)` simulates an order under the proposal's
// conditions. Returns { byKey: Map(key → impact), groups } where an impact is
// { kind: "reservation" | "limit" | "conflict" | "minutes" | "locked", ... }
// and each group is { keys, ...verdict } for moves that only pay off together.
// Stops in one of `chains` travel as a piece, so undoing a move takes back
// every moved stop of its chain: half a ferry ride is not an order to price.
export function moveImpacts(diff, { evaluate, lockedIndexes = [], chains = [], fromNow = false } = {}) {
    const byKey = new Map();
    const moved = diff.after.filter((entry) => entry.status === "moved").map((entry) => entry.key);
    if (!moved.length) return { byKey, groups: [] };
    const current = evaluate(diff.after.map((entry) => spotIndexOf(entry.key)));
    const chainOf = new Map(chains.flatMap((chain) => chain.map((spotIndex) => [spotIndex, chain])));
    const withChains = (keys) => [...new Set(keys.flatMap((key) => {
        const chain = chainOf.get(spotIndexOf(key));
        return chain ? moved.filter((other) => chain.includes(spotIndexOf(other))) : [key];
    }))];
    const measure = (keys) => {
        const order = revertedOrder(diff, withChains(keys));
        if (!keepsLockedSlots(diff, order, lockedIndexes)) return { kind: "locked" };
        return verdict(evaluate(order.map(spotIndexOf)), current, fromNow);
    };
    moved.forEach((key) => byKey.set(key, measure([key])));
    // Together they rescue something none rescues alone, or they save
    // clearly more than their separate figures add up to.
    const interlocked = (together, keys) => {
        if (together.kind === "locked") return false;
        if (together.kind !== "minutes") return true;
        const alone = keys.reduce((sum, key) => sum + byKey.get(key).minutes, 0);
        return together.minutes - alone >= Math.max(5, together.minutes * 0.25);
    };

    // Interdependence is looked for pair by pair: measuring every move at
    // once let an independent saving dilute a pair that only works together.
    // Pairs that interlock are merged, so a chain of them reads as one group.
    const minuteKeys = moved.filter((key) => byKey.get(key).kind === "minutes");
    const owner = new Map(minuteKeys.map((key) => [key, key]));
    const root = (key) => owner.get(key) === key ? key : root(owner.get(key));
    for (let left = 0; left < minuteKeys.length; left += 1) {
        for (let right = left + 1; right < minuteKeys.length; right += 1) {
            const pair = [minuteKeys[left], minuteKeys[right]];
            if (interlocked(measure(pair), pair)) owner.set(root(pair[1]), root(pair[0]));
        }
    }
    const members = new Map();
    minuteKeys.forEach((key) => members.set(root(key), [...(members.get(root(key)) || []), key]));
    const groups = [...members.values()]
        .filter((keys) => keys.length >= 2)
        .map((keys) => ({ keys, ...measure(keys) }))
        .filter((group) => group.kind !== "locked");
    return { byKey, groups };
}
