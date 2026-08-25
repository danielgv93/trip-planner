import { positionConstraintInsertionIndex } from "../../core/itinerary.js";
import { targetFingerprint } from "../../core/plan-operations.js";
import {
    commandIntent,
    derivedPlanOperation,
    insertEntityIntent,
    moveEntityIntent,
} from "../../core/plan-operation-commit.js";
import { randomUUID } from "../../core/random-id.js";
import { dayBy, store } from "../../core/store.js";
import { travelLegKey } from "../../core/travel-legs.js";
import { toast } from "../../shared/notify.js";
import { relocateTravelCard, relocationConstraintViolation } from "./move-spot.js";

let repaint = () => {};

export function configurePlannerCommands({ repaint: nextRepaint } = {}) {
    if (typeof nextRepaint === "function") repaint = nextRepaint;
}

export function duplicateDay(dayId) {
    if (dayId === "backlog") return;
    const index = store.state.findIndex((day) => day.id === dayId);
    if (index === -1) return;
    const day = store.state[index];
    const spotIdMap = new Map();
    const clone = {
        id: randomUUID(),
        date: day.date,
        title: `${day.title} (copia)`,
        spots: day.spots.map((spot) => {
            const nextId = randomUUID();
            spotIdMap.set(String(spot.id), nextId);
            return { ...spot, id: nextId, tags: [...(spot.tags || [])] };
        }),
    };
    const duplicatedLegs = {};
    Object.entries(store.travelLegs).forEach(([key, leg]) => {
        const [fromId, toId] = key.split(">");
        if (spotIdMap.has(fromId) && spotIdMap.has(toId)) {
            duplicatedLegs[travelLegKey(
                spotIdMap.get(fromId),
                spotIdMap.get(toId),
            )] = structuredClone(leg);
        }
    });
    void derivedPlanOperation((document) => commandIntent({
        target: { type: "day", id: dayId },
        command: "duplicate-day",
        precondition: {
            expectedFingerprint: targetFingerprint(document, {
                type: "day",
                id: dayId,
            }),
        },
        payload: { entity: clone, travelLegs: duplicatedLegs },
    })).then(() => toast(`“${clone.title}” añadido.`, "info"));
}

export function duplicateSpot(spotId, listId) {
    const list = listId === "backlog" ? store.backlog : dayBy(listId)?.spots;
    const index = list?.findIndex((spot) => spot.id === spotId) ?? -1;
    if (index === -1) return;
    const clone = {
        ...list[index],
        id: randomUUID(),
        tags: [...(list[index].tags || [])],
    };
    delete clone.positionConstraint;
    const insertAt = listId === "backlog"
        ? index + 1
        : positionConstraintInsertionIndex(list, clone, index + 1);
    if (insertAt === null) {
        toast("No hay una posición compatible con los anclajes actuales.", "info");
        return;
    }
    const beforeId = list[insertAt]?.id ?? null;
    void derivedPlanOperation(() => insertEntityIntent(
        { type: "spot", id: clone.id },
        clone,
        {
            containerId: listId,
            beforeId,
            backlogGroupId: clone.backlogGroupId,
        },
    )).then(() => toast(`“${clone.name || "Parada"}” duplicada.`, "info"));
}

export function moveSpot(spotId, toDay, at, backlogGroupId) {
    const violation = relocationConstraintViolation(store, spotId, toDay, at);
    if (violation) {
        toast(violation, "info");
        repaint({ persist: false });
        return false;
    }
    const destination = toDay === "backlog" ? store.backlog : dayBy(toDay)?.spots;
    const withoutMoving = destination?.filter((spot) => spot.id !== spotId) || [];
    let beforeId = null;
    if (toDay === "backlog" && backlogGroupId) {
        const groupedIndexes = withoutMoving
            .map((spot, index) => ({ spot, index }))
            .filter(({ spot }) => spot.backlogGroupId === backlogGroupId);
        const bounded = Math.max(0, Math.min(at, groupedIndexes.length));
        beforeId = bounded < groupedIndexes.length
            ? groupedIndexes[bounded].spot.id
            : groupedIndexes.length
              ? withoutMoving[groupedIndexes.at(-1).index + 1]?.id ?? null
              : null;
    } else {
        beforeId = withoutMoving[
            Math.max(0, Math.min(at, withoutMoving.length))
        ]?.id ?? null;
    }
    store.active = toDay;
    void derivedPlanOperation((document) => moveEntityIntent(
        document,
        { type: "spot", id: spotId },
        { containerId: toDay, beforeId, backlogGroupId },
    ));
    return true;
}

export function moveTravelCard(key, toDay, beforeSpotId = null) {
    if (toDay === "backlog") {
        toast("Una tarjeta de viaje debe permanecer dentro de un día.", "info");
        repaint({ persist: false });
        return false;
    }
    const targetDay = dayBy(toDay);
    if (!targetDay) {
        repaint({ persist: false });
        return false;
    }
    const preview = {
        state: structuredClone(store.state),
        backlog: structuredClone(store.backlog),
        travelLegs: structuredClone(store.travelLegs),
    };
    if (!relocateTravelCard(preview, key, toDay, beforeSpotId)) {
        toast("El viaje no puede cruzar ni mover una parada anclada.", "info");
        repaint({ persist: false });
        return false;
    }
    store.active = targetDay.id;
    const endpoints = key.split(">");
    const sourceDay = store.state.find((day) =>
        day.spots.some((spot) => endpoints.includes(String(spot.id))),
    );
    void derivedPlanOperation(() => commandIntent({
        target: { type: "travel-leg", id: key },
        command: "move-travel-card",
        precondition: { expectedContainerId: sourceDay?.id },
        payload: { containerId: toDay, beforeId: beforeSpotId },
    })).then(() => toast(
        "Viaje movido con sus puntos de origen y destino.",
        "success",
    ));
    return true;
}

export function moveDay(dayId, at) {
    const from = store.state.findIndex((day) => day.id === dayId);
    if (from === -1) return;
    const targetIndex = Math.max(0, Math.min(at, store.state.length - 1));
    if (from === targetIndex) return;
    const withoutMoving = store.state.filter((day) => day.id !== dayId);
    const beforeId = withoutMoving[
        Math.max(0, Math.min(at, withoutMoving.length))
    ]?.id ?? null;
    void derivedPlanOperation((document) => moveEntityIntent(
        document,
        { type: "day", id: dayId },
        { containerId: "days", beforeId },
    ));
}
