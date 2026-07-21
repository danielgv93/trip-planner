export function relocateSpot(plan, spotId, toDay, at, backlogGroupId) {
    let source = plan.backlog;
    let sourceIndex = source.findIndex((spot) => spot.id === spotId);
    let fromDay = "backlog";
    if (sourceIndex === -1) {
        const sourceDay = plan.state.find((day) => day.spots.some((spot) => spot.id === spotId));
        if (!sourceDay) return null;
        source = sourceDay.spots;
        sourceIndex = source.findIndex((spot) => spot.id === spotId);
        fromDay = sourceDay.id;
    }
    const target = toDay === "backlog" ? plan.backlog : plan.state.find((day) => day.id === toDay)?.spots;
    if (!target) return null;
    const [spot] = source.splice(sourceIndex, 1);
    if (fromDay !== toDay) { delete spot.plannedStart; delete spot.fixedStart; }
    if (toDay === "backlog") {
        if (backlogGroupId && plan.backlogGroups.some((group) => group.id === backlogGroupId)) spot.backlogGroupId = backlogGroupId;
        else delete spot.backlogGroupId;
        const indexes = target.map((candidate, index) => ({ candidate, index })).filter(({ candidate }) => backlogGroupId ? candidate.backlogGroupId === backlogGroupId : !plan.backlogGroups.some((group) => group.id === candidate.backlogGroupId));
        const targetIndex = at < indexes.length ? indexes[Math.max(0, at)].index : indexes.length ? indexes.at(-1).index + 1 : target.length;
        target.splice(targetIndex, 0, spot);
    } else {
        delete spot.backlogGroupId;
        target.splice(Math.max(0, Math.min(at, target.length)), 0, spot);
    }
    return { spot, fromDay, toDay };
}
