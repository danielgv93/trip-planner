import {
    dayPositionConstraintViolation,
    spotPositionConstraint,
} from "../../core/itinerary.js";

function locateSpot(plan, spotId) {
    const backlogIndex = plan.backlog.findIndex((spot) => spot.id === spotId);
    if (backlogIndex >= 0)
        return { list: plan.backlog, index: backlogIndex, dayId: "backlog" };
    const day = plan.state.find((candidate) => candidate.spots.some((spot) => spot.id === spotId));
    if (!day) return null;
    return { list: day.spots, index: day.spots.findIndex((spot) => spot.id === spotId), dayId: day.id };
}

export function relocationConstraintViolation(plan, spotId, toDay, at) {
    const source = locateSpot(plan, spotId);
    const target = toDay === "backlog"
        ? plan.backlog
        : plan.state.find((day) => day.id === toDay)?.spots;
    if (!source || !target) return "No se encontró el destino del movimiento.";
    const spot = source.list[source.index];
    if (spotPositionConstraint(spot) && source.dayId !== toDay)
        return "Esta parada está anclada al día. Hazla flexible antes de moverla.";

    const sourceBefore = [...source.list];
    const sourceAfter = sourceBefore.filter((candidate) => candidate.id !== spotId);
    const targetBefore = target === source.list ? sourceBefore : [...target];
    const targetAfter = target === source.list ? sourceAfter : [...target];
    targetAfter.splice(Math.max(0, Math.min(at, targetAfter.length)), 0, spot);

    if (source.dayId !== "backlog") {
        const sourceViolation = dayPositionConstraintViolation(
            sourceBefore,
            target === source.list ? targetAfter : sourceAfter,
        );
        if (sourceViolation) return sourceViolation;
    }
    if (toDay !== "backlog" && target !== source.list) {
        const targetViolation = dayPositionConstraintViolation(targetBefore, targetAfter);
        if (targetViolation) return targetViolation;
    }
    return null;
}

export function relocateSpot(plan, spotId, toDay, at, backlogGroupId) {
    if (relocationConstraintViolation(plan, spotId, toDay, at)) return null;
    const located = locateSpot(plan, spotId);
    if (!located) return null;
    const source = located.list;
    const sourceIndex = located.index;
    const fromDay = located.dayId;
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
    const endpoints = sourceDay.spots.slice(sourceIndex, sourceIndex + 2);
    if (endpoints.some(spotPositionConstraint)) return null;

    const sourceBefore = [...sourceDay.spots];
    const sourceAfter = sourceBefore.filter(
        (spot) => !endpoints.some((endpoint) => endpoint.id === spot.id),
    );
    const targetBefore = targetDay === sourceDay ? sourceBefore : [...targetDay.spots];
    const targetAfter = targetDay === sourceDay ? sourceAfter : [...targetDay.spots];
    let previewIndex = beforeSpotId
        ? targetAfter.findIndex((spot) => String(spot.id) === String(beforeSpotId))
        : targetAfter.length;
    if (previewIndex < 0) previewIndex = targetAfter.length;
    targetAfter.splice(previewIndex, 0, ...endpoints);
    const sourceViolation = dayPositionConstraintViolation(
        sourceBefore,
        targetDay === sourceDay ? targetAfter : sourceAfter,
    );
    if (sourceViolation) return null;
    if (targetDay !== sourceDay && dayPositionConstraintViolation(targetBefore, targetAfter))
        return null;

    sourceDay.spots.splice(sourceIndex, 2);
    if (sourceDay !== targetDay) {
        endpoints.forEach((spot) => {
            delete spot.plannedStart;
            delete spot.fixedStart;
        });
    }
    targetDay.spots.splice(previewIndex, 0, ...endpoints);
    return { endpoints, fromDay: sourceDay.id, toDay: targetDay.id };
}
