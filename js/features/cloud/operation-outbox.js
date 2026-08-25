export function createOperationOutboxDrain({ repository, publish, onState = () => {} }) {
    const flights = new Map();

    async function executeTrip(tripId) {
        const summary = { tripId, confirmed: 0, conflicts: 0, pending: 0, terminalError: null };
        while (true) {
            const entry = await repository.claimNextOperation(tripId);
            if (!entry) break;
            onState({ tripId, state: "sending", entry });
            try {
                const result = await publish(entry);
                if (result?.status === "conflict") {
                    await repository.markOperationConflict({
                        tripId,
                        localSequence: entry.localSequence,
                        conflict: result.error,
                    });
                    summary.conflicts += 1;
                    onState({ tripId, state: "conflict", entry, result });
                    continue;
                }
                await repository.confirmOperation({
                    tripId,
                    localSequence: entry.localSequence,
                    clientMutationId: entry.operation.clientMutationId,
                    revision: result.revision,
                    remoteHash: result.hash,
                });
                summary.confirmed += 1;
                onState({ tripId, state: "confirmed", entry, result });
            } catch (error) {
                if (error?.status === 409 || error?.code === "TARGET_CONFLICT") {
                    await repository.markOperationConflict({
                        tripId,
                        localSequence: entry.localSequence,
                        conflict: error.details || { code: error.code },
                    });
                    summary.conflicts += 1;
                    onState({ tripId, state: "conflict", entry, error });
                    continue;
                }
                await repository.retryOperation(tripId, entry.localSequence);
                summary.terminalError = error;
                onState({ tripId, state: "pending", entry, error });
                break;
            }
        }
        summary.pending = (await repository.listOperations(tripId))
            .filter((entry) => entry.status !== "conflict").length;
        return summary;
    }

    function drainTrip(tripId) {
        if (flights.has(tripId)) return flights.get(tripId);
        const flight = executeTrip(tripId).finally(() => flights.delete(tripId));
        flights.set(tripId, flight);
        return flight;
    }

    async function drainAll() {
        const queued = await repository.listOperations();
        const tripIds = [...new Set(queued
            .filter((entry) => entry.status !== "conflict")
            .map((entry) => entry.tripId))];
        return Promise.all(tripIds.map(drainTrip));
    }

    return {
        drainAll,
        drainTrip,
        isDraining: (tripId) => flights.has(tripId),
    };
}
