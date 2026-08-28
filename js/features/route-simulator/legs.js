// Pure leg bookkeeping for the route simulator: which travel durations the
// established plan already dictates, and which legs the optimizer is not allowed
// to reorder because they run on a timetable. Kept apart from the dialog so the
// rules that decide what the optimizer is told can be tested without a DOM.

// Undirected: a leg the traveller retimes by hand applies to both headings, and
// the dialog says so. Anything that describes what the plan or a timetable
// dictates is directed instead — see directedLegKey().
export function simulatorLegKey(fromIndex, toIndex) {
    return [fromIndex, toIndex].sort((left, right) => left - right).join(":");
}

// "Antes" is the invariable reference, so every leg the established day already
// travels enters the matrix with the exact duration that side projected for it:
// the configured duration, the cached official route, or the projection's own
// estimate when the plan holds neither. Re-resolving here instead would leave
// the unconfigured legs measured by two different engines — the projection's
// estimate on one side and the routing matrix on the other — and that gap alone
// can invent a saving the traveller will never experience. Pairs the day never
// travels keep the measured value, because the plan says nothing about them, and
// so do the legs of a visit already checked off: the projection zeroes those to
// anchor the stop at the hour it really happened, and seeding that 0 would tell
// the optimizer the pair is free and let it build the day around a teleport.
//
// Only the direction the day actually travels is seeded. The routing matrix is
// asymmetric on purpose — a one-way street, a hill walked up in forty minutes
// and down in ten — and the plan knows one duration for one heading, never for
// its reverse. Writing the return trip too would overwrite a measured value with
// an invented one, and since the optimizer's whole job is to try the reversed
// order, it would then choose that order on a number nobody measured.
// Returns the seeded legs, keyed by heading.
export function seedEstablishedLegs(travelMinutes, baseline) {
    const established = new Map();
    if (!baseline) return established;
    baseline.steps.forEach((step, position) => {
        if (position === 0) return;
        const from = baseline.steps[position - 1].spotIndex;
        const to = step.spotIndex;
        if (step.actual) return;
        if (from === to || !Number.isInteger(step.travel) || step.travel < 0) return;
        travelMinutes[from][to] = step.travel;
        established.set(directedLegKey(from, to), step.travel);
    });
    return established;
}

// A leg with a fixed departure is a commitment the traveller has already made: a
// booked train, a bus that leaves at one hour and no other. The optimizer cannot
// model it — its matrix knows durations, never timetables — so left free it
// would quietly propose catching the 09:40 train at 14:00. Both ends of such a
// leg stay pinned to their established positions, and the result says so out
// loud instead of hiding the limitation.
export function departureLockedLegs(baseline) {
    const legs = [];
    if (!baseline) return legs;
    baseline.steps.forEach((step, position) => {
        if (position === 0 || !step.fixedDeparture) return;
        const previous = baseline.steps[position - 1];
        legs.push({
            fromIndex: previous.spotIndex,
            toIndex: step.spotIndex,
            fromName: previous.spot.name || "Parada sin nombre",
            toName: step.spot.name || "Parada sin nombre",
            departureTime: step.departureTime,
        });
    });
    return legs;
}

// Directed: identifies one heading of one leg. Seeded plan durations and
// timetabled departures are both facts about travelling A to B, never B to A.
export function directedLegKey(fromIndex, toIndex) {
    return `${fromIndex}:${toIndex}`;
}

// Pinning is best effort: a traveller who also forces a first or last stop can
// pull one end of the chain apart. Rather than trust the constraint, check the
// order that actually came back.
export function brokenDepartureLegs(result, departureLegs) {
    const positions = result.steps.map((step) => step.spotIndex);
    return departureLegs.filter((leg) => {
        const at = positions.indexOf(leg.fromIndex);
        return at === -1 || positions[at + 1] !== leg.toIndex;
    });
}

// Una visita ya marcada como hecha no es una propuesta: es el pasado. El
// optimizador la puntúa como a cualquier otra parada y la mueve con gusto al
// final del día, así que el ahorro que anuncia exigiría viajar hacia atrás en el
// tiempo. "Antes" ya la ancla en la hora real; el simulador la ancla también en
// su posición y lo dice, en lugar de esconder la limitación.
export function visitedLockedStops(baseline) {
    const stops = [];
    if (!baseline) return stops;
    baseline.steps.forEach((step, position) => {
        if (step.actual !== true) return;
        stops.push({
            spotIndex: step.spotIndex,
            position,
            name: step.spot?.name || "Parada sin nombre",
        });
    });
    return stops;
}

// El anclaje es el mismo mejor esfuerzo que el de los tramos con salida fija:
// una primera o última parada forzada a mano puede desalojar a una visita ya
// hecha de su posición. En vez de confiar en la restricción, se comprueba el
// orden que ha vuelto de verdad.
export function brokenVisitedStops(result, visitedStops) {
    return visitedStops.filter((stop) => result.steps[stop.position]?.spotIndex !== stop.spotIndex);
}
