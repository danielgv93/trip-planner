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

// Atomically relocates a travel card whose two waypoint endpoints are embedded.
// The directed leg remains keyed by the same stable endpoint ids.
export function relocateTravelCard(plan, key, toDay, beforeSpotId = null) {
    if (toDay === "backlog") return null;
    const [fromId, destinationId, extra] = String(key).split(">");
    if (!fromId || !destinationId || extra) return null;
    const leg = plan.travelLegs?.[key];
    if (
        !leg?.embeddedEndpoints?.includes("from") ||
        !leg.embeddedEndpoints.includes("to")
    )
        return null;

    const sourceDay = plan.state.find((day) => {
        const index = day.spots.findIndex(
            (spot) => String(spot.id) === fromId,
        );
        return (
            index >= 0 &&
            String(day.spots[index + 1]?.id) === destinationId
        );
    });
    const targetDay = plan.state.find((day) => String(day.id) === String(toDay));
    if (!sourceDay || !targetDay) return null;

    const sourceIndex = sourceDay.spots.findIndex(
        (spot) => String(spot.id) === fromId,
    );
    const endpoints = sourceDay.spots.splice(sourceIndex, 2);
    if (sourceDay !== targetDay) {
        endpoints.forEach((spot) => {
            delete spot.plannedStart;
            delete spot.fixedStart;
        });
    }
    let targetIndex = beforeSpotId
        ? targetDay.spots.findIndex(
              (spot) => String(spot.id) === String(beforeSpotId),
          )
        : targetDay.spots.length;
    if (targetIndex < 0) targetIndex = targetDay.spots.length;
    targetDay.spots.splice(targetIndex, 0, ...endpoints);
    return { endpoints, fromDay: sourceDay.id, toDay: targetDay.id };
}
