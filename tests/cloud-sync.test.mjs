import test from "node:test";
import assert from "node:assert/strict";

import {
    CLOUD_AVAILABILITY_COPY,
    cloudAvailabilityAfterError,
    conflictResolutionEffects,
    nextRetryDelay,
    stateAfterFailure,
    stateFromOperationQueue,
    SYNC_COPY,
} from "../js/features/cloud/sync-state.js";
import { createMemoryStorage, createTripRepository } from "../js/core/trip-repository.js";
import { createTripEnvelope } from "../js/core/trip-envelope.js";

const plan = (title) => ({ tripTitle: title, days: [{ id: "d", date: "", title: "", spots: [] }] });

test("el autómata distingue red, autenticación, error y conflicto con copy español", () => {
    assert.equal(stateAfterFailure({ code: "NETWORK" }), "offline");
    assert.equal(stateAfterFailure({ status: 401 }), "auth-required");
    assert.equal(stateAfterFailure({ status: 409 }), "conflict");
    assert.equal(stateAfterFailure({ status: 500 }), "error");
    for (const state of ["local", "saving", "synced", "pending", "offline", "auth-required", "error", "conflict"]) {
        assert.equal(typeof SYNC_COPY[state], "string");
    }
});

test("el estado visible procede de la cola granular real y localiza conflictos", () => {
    const queued = [{ status: "queued" }];
    assert.equal(stateFromOperationQueue([], { fallback: "saved" }), "saved");
    assert.equal(stateFromOperationQueue(queued, { online: false }), "offline");
    assert.equal(stateFromOperationQueue(queued, { authenticated: false }), "auth-required");
    assert.equal(stateFromOperationQueue([{ status: "sending" }]), "saving");
    assert.equal(stateFromOperationQueue(queued), "pending");
    assert.equal(stateFromOperationQueue([{ status: "conflict" }, ...queued]), "localized-conflict");
    assert.match(SYNC_COPY["localized-conflict"], /localizado/i);
});

test("la disponibilidad cloud distingue una API caída de un error de usuario", () => {
    assert.equal(cloudAvailabilityAfterError({ code: "NETWORK" }), "unavailable");
    assert.equal(cloudAvailabilityAfterError({ code: "TIMEOUT" }), "unavailable");
    assert.equal(cloudAvailabilityAfterError({ code: "CLOUD_DISABLED", status: 404 }), "unavailable");
    assert.equal(cloudAvailabilityAfterError({ status: 500 }), "unavailable");
    assert.equal(cloudAvailabilityAfterError({ status: 401 }), "available");
    assert.match(CLOUD_AVAILABILITY_COPY.unavailable, /dispositivo/);
});

test("el backoff es creciente, acotado y determinista con azar inyectado", () => {
    assert.equal(nextRetryDelay(0, { random: () => 0 }), 750);
    assert.equal(nextRetryDelay(1, { random: () => 0 }), 1500);
    assert.equal(nextRetryDelay(99, { random: () => 0 }), 45000);
});

test("las tres resoluciones de conflicto preservan al menos una copia", () => {
    assert.deepEqual(conflictResolutionEffects("cloud"), { duplicateLocal: true, adoptRemote: true, enqueueLocal: false });
    assert.deepEqual(conflictResolutionEffects("local"), { duplicateLocal: false, adoptRemote: false, enqueueLocal: true });
    assert.deepEqual(conflictResolutionEffects("copy"), { duplicateLocal: true, adoptRemote: true, enqueueLocal: false });
    assert.throws(() => conflictResolutionEffects("merge"), /INVALID/);
});

test("la outbox conserva orden entre viajes y coalesce por viaje después de persistir", async () => {
    const repository = createTripRepository(createMemoryStorage());
    const first = createTripEnvelope({ id: "a", document: plan("A"), remoteId: "r-a", baseRevision: 1, syncState: "pending", updatedAt: "2026-01-01T00:00:00Z" });
    const second = createTripEnvelope({ id: "b", document: plan("B"), remoteId: "r-b", baseRevision: 1, syncState: "pending", updatedAt: "2026-01-01T00:00:01Z" });
    await repository.commitTrip(first, { clientMutationId: "m-a", type: "document", createdAt: "2026-01-01T00:00:00Z", document: first.document });
    await repository.commitTrip(second, { clientMutationId: "m-b", type: "document", createdAt: "2026-01-01T00:00:01Z", document: second.document });
    first.document.tripTitle = "A editado";
    await repository.commitTrip(first, { clientMutationId: "m-a-2", type: "document", createdAt: "2026-01-01T00:00:02Z", document: first.document });
    const outbox = await repository.listOutbox();
    assert.deepEqual(outbox.map((item) => item.tripId), ["a", "b"]);
    assert.equal(outbox[0].clientMutationId, "m-a");
    assert.equal(outbox[0].document.tripTitle, "A editado");
    assert.equal((await repository.getTrip("a")).document.tripTitle, "A editado");
});

test("una mutación de documento y un archivado pendiente se coalescen sin perder ninguno", async () => {
    const repository = createTripRepository(createMemoryStorage());
    const envelope = createTripEnvelope({ id: "a", document: plan("A"), remoteId: "remote", baseRevision: 4, syncState: "pending" });
    await repository.commitTrip(envelope, { type: "document", clientMutationId: "document-id", document: envelope.document, baseRevision: 4 });
    envelope.archived = true;
    await repository.commitTrip(envelope, { type: "metadata", clientMutationId: "archive-id", patch: { archived: true } });
    const pending = await repository.getOutbox("a");
    assert.equal(pending.type, "document");
    assert.equal(pending.clientMutationId, "document-id");
    assert.deepEqual(pending.patch, { archived: true });
    assert.equal(pending.document.tripTitle, "A");
});

test("confirmar una mutación elimina la outbox atómicamente", async () => {
    const repository = createTripRepository(createMemoryStorage());
    const envelope = createTripEnvelope({ id: "a", document: plan("A"), remoteId: "remote", baseRevision: 1, syncState: "pending" });
    const mutation = { type: "document", clientMutationId: "m-1", document: envelope.document, baseRevision: 1 };
    await repository.commitTrip(envelope, mutation);
    const result = await repository.confirmMutation({ tripId: "a", sent: mutation, revision: 2, remoteHash: "hash-2", nextClientMutationId: "m-2" });
    assert.equal(result.pending, false);
    assert.equal(await repository.getOutbox("a"), undefined);
    assert.equal((await repository.getTrip("a")).remote.baseRevision, 2);
});

test("una edición coalescida durante el envío conserva outbox con nueva idempotencia y base", async () => {
    const repository = createTripRepository(createMemoryStorage());
    const envelope = createTripEnvelope({ id: "a", document: plan("A"), remoteId: "remote", baseRevision: 1, syncState: "pending" });
    const sent = { type: "document", clientMutationId: "m-1", document: envelope.document, baseRevision: 1 };
    await repository.commitTrip(envelope, sent);
    envelope.document = plan("A más reciente");
    await repository.commitTrip(envelope, { ...sent, clientMutationId: "m-ignored", document: envelope.document });
    const result = await repository.confirmMutation({ tripId: "a", sent, revision: 2, remoteHash: "hash-2", nextClientMutationId: "m-2" });
    const pending = await repository.getOutbox("a");
    assert.equal(result.pending, true);
    assert.equal(pending.clientMutationId, "m-2");
    assert.equal(pending.baseRevision, 2);
    assert.equal(pending.document.tripTitle, "A más reciente");
    assert.equal((await repository.getTrip("a")).syncState, "pending");
});
