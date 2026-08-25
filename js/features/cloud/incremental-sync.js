export function createIncrementalTripSync({
    repository,
    client,
    onEnvelope = async () => {},
} = {}) {
    const flights = new Map();

    async function applySnapshot(localId, envelope, reason) {
        const response = await client.getTrip(envelope.remote.id);
        const remote = response.trip;
        const rebased = await repository.rebaseOperations({
            tripId: localId,
            remoteDocument: remote.document,
            revision: Number(remote.current_revision),
            remoteHash: remote.document_hash,
        });
        rebased.envelope.remote.lastModifiedBy = remote.last_modified_by || null;
        await onEnvelope(rebased.envelope, {
            mode: "snapshot",
            reason,
            targetKeys: [],
            conflicts: rebased.conflicts,
        });
        return { status: "snapshot", revision: Number(remote.current_revision), conflicts: rebased.conflicts };
    }

    async function execute(localId, state) {
        const targetKeys = new Set();
        const applied = [];
        while (true) {
            const envelope = await repository.getTrip(localId);
            if (!envelope?.remote.id) return { status: "unavailable", applied };
            if (Number(envelope.remote.protocolVersion) < 1) return applySnapshot(localId, envelope, "legacy");
            const after = Number(envelope.remote.baseRevision) || 0;
            if (state.targetRevision && after >= state.targetRevision) {
                if (applied.length) {
                    envelope.remote.lastModifiedBy = applied.at(-1)?.actor || envelope.remote.lastModifiedBy;
                    await onEnvelope(envelope, { mode: "operations", targetKeys: [...targetKeys], applied });
                }
                return { status: applied.length ? "applied" : "up-to-date", revision: after, applied, targetKeys: [...targetKeys] };
            }
            const batch = await client.catchUpTripOperations(envelope.remote.id, { after, limit: 100 });
            if (batch.snapshotRequired) return applySnapshot(localId, envelope, "server-required");
            if (!batch.operations?.length) {
                if (applied.length) {
                    const latest = await repository.getTrip(localId);
                    latest.remote.lastModifiedBy = applied.at(-1)?.actor || latest.remote.lastModifiedBy;
                    await onEnvelope(latest, { mode: "operations", targetKeys: [...targetKeys], applied });
                }
                return { status: applied.length ? "applied" : "up-to-date", revision: Number(batch.currentRevision), applied, targetKeys: [...targetKeys] };
            }
            for (const remote of batch.operations) {
                const result = await repository.applyRemoteOperation({ tripId: localId, remote });
                if (result.status === "overlap") return applySnapshot(localId, result.envelope, "overlap");
                (remote.targetKeys || result.targetKeys || []).forEach((key) => targetKeys.add(key));
                applied.push({ ...remote, effect: result.status });
            }
            const latest = await repository.getTrip(localId);
            if (!batch.hasMore && Number(latest.remote.baseRevision) >= Math.max(Number(batch.currentRevision) || 0, state.targetRevision || 0)) {
                latest.remote.lastModifiedBy = applied.at(-1)?.actor || latest.remote.lastModifiedBy;
                await onEnvelope(latest, { mode: "operations", targetKeys: [...targetKeys], applied });
                return { status: "applied", revision: Number(latest.remote.baseRevision), applied, targetKeys: [...targetKeys] };
            }
        }
    }

    function sync(localId, targetRevision = 0) {
        const existing = flights.get(localId);
        if (existing) {
            existing.targetRevision = Math.max(existing.targetRevision, Number(targetRevision) || 0);
            return existing.promise;
        }
        const state = { targetRevision: Number(targetRevision) || 0, promise: null };
        state.promise = execute(localId, state).finally(() => flights.delete(localId));
        flights.set(localId, state);
        return state.promise;
    }

    return { sync, isSyncing: (localId) => flights.has(localId) };
}
