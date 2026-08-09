import { minutesToTime, timeToMinutes } from "../../core/time.js";
import {
    dayPositionConstraintViolation,
    spotPositionConstraint,
} from "../../core/itinerary.js";
import { stateRank } from "./diagnostics.js";

function cloneDay(day) { return structuredClone(day); }
function suggestion(kind, dayId, payload, label, impact, approximate = false) {
    return { id: `${kind}:${dayId}:${JSON.stringify(payload)}`, kind, dayId, payload, label, impact, approximate };
}

export function generateSuggestions(day, baseline, evaluate, allDays = []) {
    const suggestions = [];
    const targetIssues = new Set(baseline.issues.map((item) => item.type));
    const improves = (candidate) => {
        const result = evaluate(candidate);
        return result.state !== "impossible" &&
            (stateRank(result.state) > stateRank(baseline.state) ||
             result.issues.filter((item) => targetIssues.has(item.type)).length < baseline.issues.filter((item) => targetIssues.has(item.type)).length);
    };

    const originalStart = timeToMinutes(day.startTime) ?? 540;
    if (baseline.issues.some((item) => item.type === "low-margin")) {
        const marginCandidate = cloneDay(day);
        marginCandidate.startTime = minutesToTime(originalStart - 20);
        const marginResult = evaluate(marginCandidate);
        if (marginResult.state !== "impossible" &&
            (marginResult.metrics?.minMargin ?? -Infinity) >= (baseline.metrics?.minMargin ?? 0) + 20)
            suggestions.push(suggestion("add-margin", day.id, { startTime: marginCandidate.startTime }, "Añadir 20 minutos de margen", `Salir a las ${marginCandidate.startTime}`));
    }
    for (let delta = 5; delta <= 120; delta += 5) {
        const candidate = cloneDay(day);
        candidate.startTime = minutesToTime(originalStart - delta);
        if (improves(candidate)) {
            suggestions.push(suggestion("start-earlier", day.id, { startTime: candidate.startTime }, `Salir antes, a las ${candidate.startTime}`, `${delta} min antes`));
            break;
        }
    }

    for (const spot of day.spots.filter((item) => item.optional === true && item.mapEnabled !== false && !spotPositionConstraint(item))) {
        const candidate = cloneDay(day);
        candidate.spots = candidate.spots.filter((item) => item.id !== spot.id);
        if (!dayPositionConstraintViolation(day.spots, candidate.spots) && improves(candidate))
            suggestions.push(suggestion("remove-optional", day.id, { spotId: spot.id }, `Quitar la parada opcional “${spot.name}”`, "Se moverá al backlog"));
    }

    if (day.spots.length > 2) {
        let best = null;
        for (let from = 0; from < day.spots.length; from += 1) for (let to = 0; to < day.spots.length; to += 1) {
            if (from === to) continue;
            const candidate = cloneDay(day);
            const [spot] = candidate.spots.splice(from, 1);
            candidate.spots.splice(to, 0, spot);
            const fixedBefore = day.spots.filter((item) => item.fixedStart).map((item) => item.id).join("|");
            const fixedAfter = candidate.spots.filter((item) => item.fixedStart).map((item) => item.id).join("|");
            if (fixedBefore !== fixedAfter) continue;
            if (dayPositionConstraintViolation(day.spots, candidate.spots)) continue;
            const result = evaluate(candidate);
            const saved = (baseline.metrics?.travel || 0) - (result.metrics?.travel || 0);
            if (saved >= 10 && result.state !== "impossible" && stateRank(result.state) >= stateRank(baseline.state) && (!best || saved > best.saved))
                best = { order: candidate.spots.map((item) => item.id), saved, approximate: baseline.approximate || result.approximate };
        }
        if (best) suggestions.push(suggestion("reorder", day.id, {
            order: best.order,
            savedMinutes: best.saved,
            travelBefore: baseline.metrics?.travel || 0,
            travelAfter: (baseline.metrics?.travel || 0) - best.saved,
        }, `Cambiar el orden ahorra ${best.saved} minutos`, `${best.approximate ? "≈" : ""}${best.saved} min`, best.approximate));
    }

    const problematic = baseline.issues.map((item) => item.spotId).filter(Boolean);
    for (const spotId of [...new Set(problematic)].slice(0, 1)) {
        const spot = day.spots.find((item) => item.id === spotId);
        if (!spot || spotPositionConstraint(spot)) continue;
        for (const receiver of allDays) {
            if (receiver.id === day.id) continue;
            const sourceCandidate = cloneDay(day);
            sourceCandidate.spots = sourceCandidate.spots.filter((item) => item.id !== spotId);
            if (dayPositionConstraintViolation(day.spots, sourceCandidate.spots)) continue;
            for (let at = 0; at <= receiver.spots.length; at += 1) {
                const receiverCandidate = cloneDay(receiver);
                receiverCandidate.spots.splice(at, 0, { ...structuredClone(spot), plannedStart: undefined, fixedStart: undefined });
                if (dayPositionConstraintViolation(receiver.spots, receiverCandidate.spots)) continue;
                const receiverResult = evaluate(receiverCandidate);
                const receiverBaseline = evaluate(receiver);
                if (receiverResult.state === "impossible" || stateRank(receiverResult.state) < stateRank(receiverBaseline.state)) continue;
                if (improves(sourceCandidate)) {
                    const weekday = new Intl.DateTimeFormat("es-ES", { weekday: "long" }).format(new Date(`${receiver.date}T12:00:00`));
                    suggestions.push(suggestion("move-day", day.id, { spotId, toDay: receiver.id, at }, `Mover “${spot.name}” al ${weekday}, ${receiver.title || receiver.date}`, `Posición ${at + 1}`));
                    return suggestions;
                }
            }
        }
    }
    return suggestions;
}
