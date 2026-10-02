// Which stops a proposal actually moves.
//
// Comparing slot by slot overstates it: bringing the sixth stop to the front
// shifts the other five down one slot, and all six used to read as "moved".
// The stops that keep their order relative to each other form the longest
// common subsequence of both orders; only the rest moved. That is also the
// fewest drags a traveller would need to turn one order into the other.

// Comparable identity per step: a stop visited twice (the return to the start)
// is a different occurrence from its first visit.
export function occurrenceKeys(steps) {
    const seen = new Map();
    return steps.map((step) => {
        const count = (seen.get(step.spotIndex) || 0) + 1;
        seen.set(step.spotIndex, count);
        return `${step.spotIndex}:${count}`;
    });
}

// The keys that stay. When several subsequences are equally long, `weight`
// decides which stops read as staying: anchored stops (appointments, fixed
// positions) should, so the one that moved is the one that could move.
export function stableKeys(beforeKeys, afterKeys, weight = () => 0) {
    const n = beforeKeys.length;
    const m = afterKeys.length;
    // best[i][j] = [length, weight] of the best subsequence of before[i..] and after[j..].
    const best = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => [0, 0]));
    const better = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1];
    for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
            let candidate = better(best[i + 1][j], best[i][j + 1]) ? best[i + 1][j] : best[i][j + 1];
            if (beforeKeys[i] === afterKeys[j]) {
                const next = best[i + 1][j + 1];
                const matched = [next[0] + 1, next[1] + weight(beforeKeys[i], i)];
                if (!better(candidate, matched)) candidate = matched;
            }
            best[i][j] = candidate;
        }
    }
    const kept = new Set();
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        const here = best[i][j];
        if (beforeKeys[i] === afterKeys[j]) {
            const next = best[i + 1][j + 1];
            if (here[0] === next[0] + 1 && here[1] === next[1] + weight(beforeKeys[i], i)) {
                kept.add(beforeKeys[i]);
                i += 1;
                j += 1;
                continue;
            }
        }
        const down = best[i + 1][j];
        if (down[0] === here[0] && down[1] === here[1]) i += 1;
        else j += 1;
    }
    return kept;
}

// Step-by-step comparison of two orders.
// Each after step gets { key, from, to, status } where status is "stay",
// "moved" or "added" (a step with no counterpart before, like the return to
// the start); each before step that is missing after is "dropped".
// `anchored(spotIndex)` marks stops that should win ties to stay.
export function reorderDiff(beforeSteps, afterSteps, { anchored = () => false } = {}) {
    const beforeKeys = occurrenceKeys(beforeSteps);
    const afterKeys = occurrenceKeys(afterSteps);
    const beforePosition = new Map(beforeKeys.map((key, index) => [key, index]));
    const afterPosition = new Map(afterKeys.map((key, index) => [key, index]));
    const total = beforeKeys.length;
    // Anchors dominate; among equals, the stop that came earlier stays, so a
    // swap reads as "the later stop moved in front".
    const stays = stableKeys(beforeKeys, afterKeys, (key, index) =>
        (anchored(beforeSteps[index].spotIndex) ? total + 1 : 0) + (total - index) / (total + 1));
    const after = afterKeys.map((key, index) => ({
        key,
        to: index,
        from: beforePosition.has(key) ? beforePosition.get(key) : null,
        status: stays.has(key) ? "stay" : beforePosition.has(key) ? "moved" : "added",
    }));
    const before = beforeKeys.map((key, index) => ({
        key,
        from: index,
        to: afterPosition.has(key) ? afterPosition.get(key) : null,
        status: stays.has(key) ? "stay" : afterPosition.has(key) ? "moved" : "dropped",
    }));
    return { before, after, movedCount: after.filter((entry) => entry.status === "moved").length };
}

// Where a moved stop lands, told against stops that stayed: those are the
// landmarks the traveller still recognises.
export function placementPhrase(diff, afterIndex, nameAt) {
    const stayAt = (index) => diff.after[index]?.status === "stay";
    let previous = afterIndex - 1;
    while (previous >= 0 && !stayAt(previous)) previous -= 1;
    let next = afterIndex + 1;
    while (next < diff.after.length && !stayAt(next)) next += 1;
    const hasPrevious = previous >= 0;
    const hasNext = next < diff.after.length;
    const last = diff.after.length - 1;
    if (afterIndex === 0) return hasNext ? `pasa al principio, antes de ${nameAt(next)}` : "pasa al principio";
    if (afterIndex === last) return hasPrevious ? `pasa al final, después de ${nameAt(previous)}` : "pasa al final";
    if (hasPrevious && hasNext) return `pasa entre ${nameAt(previous)} y ${nameAt(next)}`;
    if (hasNext) return `pasa antes de ${nameAt(next)}`;
    if (hasPrevious) return `pasa después de ${nameAt(previous)}`;
    return `pasa a la posición ${afterIndex + 1}`;
}
