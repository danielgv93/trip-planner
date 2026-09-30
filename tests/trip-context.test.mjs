import assert from "node:assert/strict";
import test from "node:test";
import { matchingSharedTrips, tripContext, tripWithRemoteContext } from "../js/features/library/trip-context.js";

const owner = { userId: "daniel", role: "owner", displayName: "Daniel" };
const editor = { userId: "karla", role: "editor", displayName: "Karla" };
const personal = { id: "personal", document: { tripTitle: "Japón 2026" }, remote: { id: "own-cloud", role: "owner", members: [{ ...editor, role: "owner" }] } };
const shared = { id: "shared-local", document: { tripTitle: "Japón 2026" }, remote: { id: "shared-cloud", role: "editor", members: [owner, editor] } };

test("la identidad distingue viaje personal, propietario compartiendo, editor y lector", () => {
    assert.equal(tripContext(personal).label, "Tu viaje personal · Sin colaboradores");
    assert.equal(tripContext({ remote: {} }).personal, true);
    assert.equal(tripContext(shared).label, "Compartido por Daniel · Puedes editar");
    assert.equal(tripContext({ ...shared, remote: { ...shared.remote, role: "viewer" } }).label, "Compartido por Daniel · Solo lectura");
    assert.equal(tripContext({ ...shared, remote: { ...shared.remote, role: "owner" } }).label, "Tu viaje · Compartido con Karla");
    assert.equal(tripContext({ remote: { id: "legacy" } }).personal, false);
    assert.equal(tripContext(null), null);
});

test("detecta la confusión del caso Karla, sin duplicar la copia descargada", () => {
    const remote = { id: "shared-cloud", title: "Japón 2026", role: "editor", members: [owner, editor] };
    assert.deepEqual(matchingSharedTrips(personal, [personal, shared], [remote]).map((trip) => trip.id), ["shared-local"]);
    const [match] = matchingSharedTrips(personal, [personal], [remote]);
    assert.equal(match.remoteOnly, true);
    assert.equal(match.remote.id, "shared-cloud");
});

test("no avisa dentro del compartido, por títulos distintos o por viajes inaccesibles", () => {
    assert.deepEqual(matchingSharedTrips(shared, [personal, shared]), []);
    for (const change of [{ archived: true }, { pendingDeletion: true }, { document: { tripTitle: "Japón 2027" } }]) {
        assert.deepEqual(matchingSharedTrips(personal, [{ ...shared, ...change }]), []);
    }
    assert.deepEqual(matchingSharedTrips(personal, [personal]), []);
    assert.deepEqual(matchingSharedTrips(null, [shared]), []);
    assert.deepEqual(matchingSharedTrips(personal, [], [{ id: "archived", title: "Japón 2026", role: "viewer", archived_at: "2026-09-30" }]), []);
});

test("normaliza mayúsculas, espacios y Unicode sin equiparar nombres diferentes", () => {
    const candidate = { ...shared, document: { tripTitle: "  JAPÓN   2026 " } };
    assert.equal(matchingSharedTrips(personal, [candidate]).length, 1);
    assert.equal(matchingSharedTrips(personal, [{ ...candidate, document: { tripTitle: "Japon 2026" } }]).length, 0);
});

test("ofrece todos los compartidos coincidentes y no convierte un público en colaborativo", () => {
    const remote = [
        { id: "viewer-cloud", title: "Japón 2026", role: "viewer", members: [owner, editor] },
        { id: "public-own", title: "Japón 2026", role: "owner", shared: true },
    ];
    assert.deepEqual(matchingSharedTrips(personal, [shared], remote).map((trip) => trip.id), ["shared-local", "viewer-cloud"]);
    assert.equal(tripContext(personal).personal, true);
});

test("un cambio de miembros en la biblioteca remota actualiza el contexto sin tocar el plan", () => {
    const updated = tripWithRemoteContext(personal, [{ id: "own-cloud", role: "owner", members: [{ ...editor, role: "owner" }, { ...owner, role: "editor" }] }]);
    assert.equal(tripContext(updated).label, "Tu viaje · Compartido con Daniel");
    assert.equal(updated.document, personal.document);
    assert.equal(tripContext(personal).personal, true);
    assert.deepEqual(matchingSharedTrips(updated, [shared]), []);
});
