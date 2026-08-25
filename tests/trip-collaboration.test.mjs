import assert from "node:assert/strict";
import test from "node:test";
import { createTripEnvelope, normalizeTripEnvelope } from "../js/core/trip-envelope.js";
import { memberHue, memberInitials } from "../js/features/cloud/member-avatar.js";

const document_ = { days: [] };

test("el sobre conserva rol, propietario y colaboradores al normalizar", () => {
    const envelope = createTripEnvelope({
        id: "local-1",
        document: document_,
        remoteId: "remote-1",
        role: "editor",
        ownerId: "owner-1",
        members: [{ userId: "owner-1", role: "owner", displayName: "Ana" }],
        lastModifiedBy: { userId: "editor-1", displayName: "Luis" },
    });
    assert.equal(envelope.remote.role, "editor");
    assert.equal(envelope.remote.ownerId, "owner-1");
    assert.deepEqual(envelope.remote.lastModifiedBy, { userId: "editor-1", displayName: "Luis" });
    assert.deepEqual(normalizeTripEnvelope(envelope).remote, envelope.remote);
});

test("un sobre guardado antes de la colaboración sigue cargando sin rol", () => {
    const legacy = createTripEnvelope({ id: "local-2", document: document_, remoteId: "remote-2" });
    delete legacy.remote.role;
    delete legacy.remote.ownerId;
    delete legacy.remote.members;
    delete legacy.remote.lastModifiedBy;
    const normalized = normalizeTripEnvelope(legacy);
    assert.equal(normalized.remote.role, null);
    assert.deepEqual(normalized.remote.members, []);
    assert.equal(normalized.remote.lastModifiedBy, null);
});

test("un autor incompleto no se conserva como atribución", () => {
    const envelope = createTripEnvelope({ id: "local-actor", document: document_, lastModifiedBy: { displayName: "Sin id" } });
    assert.equal(envelope.remote.lastModifiedBy, null);
});

test("un rol inventado no se acepta como permiso", () => {
    const envelope = createTripEnvelope({ id: "local-3", document: document_, role: "admin" });
    assert.equal(envelope.remote.role, null);
});

test("los colaboradores con forma inválida se descartan en lugar de romper la tarjeta", () => {
    const envelope = createTripEnvelope({
        id: "local-4",
        document: document_,
        members: [{ userId: "u1", role: "editor", displayName: "Luis" }, { role: "editor" }, { userId: "u2", role: "jefe" }],
    });
    assert.deepEqual(envelope.remote.members, [{ userId: "u1", role: "editor", displayName: "Luis" }]);
});

test("las iniciales resumen el nombre visible sin romperse con acentos ni emoji", () => {
    assert.equal(memberInitials("Ana Torres"), "AT");
    assert.equal(memberInitials("ana maría lópez"), "AL");
    assert.equal(memberInitials("Íñigo"), "ÍÑ");
    assert.equal(memberInitials("  "), "?");
    assert.equal(memberInitials("🐙pulpo"), "🐙P");
});

test("el color de un colaborador es estable y acotado al círculo cromático", () => {
    assert.equal(memberHue("usuario-1"), memberHue("usuario-1"));
    assert.notEqual(memberHue("usuario-1"), memberHue("usuario-2"));
    for (const id of ["a", "usuario-1", "33333333-3333-4333-8333-333333333333"]) {
        const hue = memberHue(id);
        assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360, `hue fuera de rango: ${hue}`);
    }
});
