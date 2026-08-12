import test from "node:test";
import assert from "node:assert/strict";

import {
    createMemoryStorage,
    createTripRepository,
} from "../js/core/trip-repository.js";
import { createTripEnvelope } from "../js/core/trip-envelope.js";
import { migrateLegacyTrip } from "../js/core/legacy-trip-migration.js";

function document(title = "Viaje") {
    return {
        tripTitle: title,
        days: [{ id: "day-1", date: "2026-08-12", title: "Día", spots: [] }],
    };
}

test("el repositorio lista, escribe, duplica y archiva viajes aislados", async () => {
    const repository = createTripRepository(createMemoryStorage());
    await repository.putTrip(createTripEnvelope({ id: "one", document: document("Uno") }));
    const duplicate = await repository.duplicateTrip("one", { newId: "two" });
    assert.equal(duplicate.document.tripTitle, "Uno (copia)");
    assert.equal(duplicate.remote.id, null);
    duplicate.document.days[0].title = "Solo copia";
    await repository.putTrip(duplicate);
    assert.equal((await repository.getTrip("one")).document.days[0].title, "Día");
    await repository.setArchived("one", true);
    assert.deepEqual((await repository.listTrips()).map((trip) => trip.id), ["two"]);
    assert.equal((await repository.listTrips({ includeArchived: true })).length, 2);
});
test("el commit del documento y su outbox es atómico y coalesce conservando idempotencia", async () => {
    const repository = createTripRepository(createMemoryStorage());
    const first = createTripEnvelope({ id: "one", document: document(), remoteId: "remote", baseRevision: 1, syncState: "pending" });
    await repository.commitTrip(first, { type: "document", clientMutationId: "mutation-1", document: first.document });
    const second = createTripEnvelope({ ...first, document: document("Editado") });
    await repository.commitTrip(second, { type: "document", clientMutationId: "mutation-2", document: second.document });
    const pending = await repository.getOutbox("one");
    assert.equal(pending.clientMutationId, "mutation-1");
    assert.equal(pending.document.tripTitle, "Editado");
    assert.equal((await repository.getTrip("one")).document.tripTitle, "Editado");
});

test("el borrado local elimina y el borrado remoto crea un tombstone no editable", async () => {
    const repository = createTripRepository(createMemoryStorage());
    await repository.putTrip(createTripEnvelope({ id: "local", document: document() }));
    await repository.markForDeletion("local");
    assert.equal(await repository.getTrip("local"), null);

    await repository.putTrip(createTripEnvelope({ id: "cloud", document: document(), remoteId: "remote", baseRevision: 2, syncState: "synced" }));
    const tombstone = await repository.markForDeletion("cloud");
    assert.equal(tombstone.pendingDeletion, true);
    assert.equal((await repository.getOutbox("cloud")).type, "delete");
});

test("la migración legacy copia, verifica y marca sin borrar el origen", async () => {
    const repository = createTripRepository(createMemoryStorage());
    const memory = new Map([["trip-planner", JSON.stringify({
        ...document("Legado"),
        basemap: "osm",
        workspaceSplit: 0.42,
    })]]);
    const localStorage = {
        getItem: (key) => memory.get(key) ?? null,
        setItem: (key, value) => memory.set(key, String(value)),
    };
    const result = await migrateLegacyTrip({ repository, localStorage, createId: () => "migrated" });
    assert.equal(result.status, "migrated");
    assert.equal((await repository.getTrip("migrated")).preferences.basemap, "osm");
    assert.ok(localStorage.getItem("trip-planner"));
    assert.equal((await migrateLegacyTrip({ repository, localStorage, createId: () => "duplicate" })).status, "already-migrated");
    assert.equal(await repository.getTrip("duplicate"), null);
});

test("una migración fallida conserva el guardado legacy y no escribe el marcador", async () => {
    const repository = createTripRepository(createMemoryStorage());
    const localStorage = { getItem: () => "{", setItem() {} };
    const result = await migrateLegacyTrip({ repository, localStorage, createId: () => "bad" });
    assert.equal(result.status, "failed");
    assert.equal(await repository.getPreference("legacy-single-trip-migrated-v1"), undefined);
});
