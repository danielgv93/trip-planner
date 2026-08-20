import assert from "node:assert/strict";
import test from "node:test";
import { readTripAccess, requireTripRole, WRITERS } from "../src/modules/trips/trip-access.js";
import { createTripMemberService } from "../src/modules/trips/trip-member-service.js";
import { createTripEventBus } from "../src/realtime/trip-events.js";

const TRIP = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";

function fakeDatabase(handler) {
    const calls = [];
    return {
        calls,
        query: async (text, params) => {
            calls.push({ text, params });
            return (await handler(text, params)) || { rowCount: 0, rows: [] };
        },
    };
}

const accessRow = (role) => ({ rowCount: 1, rows: [{ owner_id: OWNER, role }] });

test("un identificador que no es uuid se rechaza sin consultar la base de datos", async () => {
    const database = fakeDatabase(() => ({ rowCount: 1, rows: [{ owner_id: OWNER, role: "owner" }] }));
    await assert.rejects(
        readTripAccess(database, "no-es-un-uuid", OWNER),
        (error) => error.status === 404 && error.code === "TRIP_NOT_FOUND",
    );
    assert.equal(database.calls.length, 0);
});

test("un viaje en el que no colaboras responde 404 y no 403", async () => {
    const database = fakeDatabase(() => ({ rowCount: 0, rows: [] }));
    await assert.rejects(
        readTripAccess(database, TRIP, MEMBER),
        (error) => error.status === 404,
    );
});

test("un lector no puede escribir aunque tenga acceso al viaje", async () => {
    const database = fakeDatabase(() => accessRow("viewer"));
    await assert.rejects(
        requireTripRole(database, TRIP, MEMBER, WRITERS),
        (error) => error.status === 403 && error.code === "TRIP_FORBIDDEN",
    );
    assert.deepEqual(await requireTripRole(database, TRIP, MEMBER, ["viewer"]), { ownerId: OWNER, role: "viewer" });
});

test("solo el propietario ve los correos de la lista de colaboradores", async () => {
    const rows = [
        { user_id: OWNER, role: "owner", created_at: "2026-01-01", display_name: "Ana", avatar_data_url: null, email: "ana@example.com" },
        { user_id: MEMBER, role: "editor", created_at: "2026-01-02", display_name: "Luis", avatar_data_url: null, email: "luis@example.com" },
    ];
    for (const [role, expectsEmail] of [["owner", true], ["editor", false], ["viewer", false]]) {
        const database = fakeDatabase((text) => text.includes("FROM trips t JOIN trip_members")
            ? accessRow(role)
            : { rowCount: rows.length, rows });
        const service = createTripMemberService({ database });
        const result = await service.listMembers({ userId: role === "owner" ? OWNER : MEMBER, tripId: TRIP });
        assert.equal(result.role, role);
        assert.equal(Object.hasOwn(result.members[0], "email"), expectsEmail);
    }
});

test("invitar exige un correo válido y el rol de propietario", async () => {
    const database = fakeDatabase(() => accessRow("editor"));
    const service = createTripMemberService({ database });
    await assert.rejects(
        service.inviteMember({ active: { user_id: MEMBER }, tripId: TRIP, input: { email: "sin-arroba" } }),
        (error) => error.code === "INVALID_EMAIL",
    );
    await assert.rejects(
        service.inviteMember({ active: { user_id: MEMBER }, tripId: TRIP, input: { email: "luis@example.com" } }),
        (error) => error.status === 403,
    );
});

test("el propietario no puede degradarse ni abandonar el viaje", async () => {
    const database = fakeDatabase(() => accessRow("owner"));
    const service = createTripMemberService({ database });
    await assert.rejects(
        service.updateMemberRole({ active: { user_id: OWNER }, tripId: TRIP, memberId: OWNER, input: { role: "editor" } }),
        (error) => error.code === "OWNER_ROLE_LOCKED",
    );
    await assert.rejects(
        service.leaveTrip({ active: { user_id: OWNER }, tripId: TRIP }),
        (error) => error.code === "OWNER_CANNOT_LEAVE",
    );
});

test("un rol inventado nunca llega a la base de datos", async () => {
    const database = fakeDatabase(() => accessRow("owner"));
    const service = createTripMemberService({ database });
    await assert.rejects(
        service.updateMemberRole({ active: { user_id: OWNER }, tripId: TRIP, memberId: MEMBER, input: { role: "owner" } }),
        (error) => error.code === "INVALID_ROLE",
    );
    assert.equal(database.calls.length, 0);
});

test("el bus entrega a cada viaje solo sus propios eventos y suelta al desuscribir", () => {
    const bus = createTripEventBus();
    const received = [];
    const stop = bus.subscribe(TRIP, (event) => received.push(event));
    bus.publish(TRIP, { type: "revision", revision: 2 });
    bus.publish("otro-viaje", { type: "revision", revision: 9 });
    stop();
    bus.publish(TRIP, { type: "revision", revision: 3 });
    assert.deepEqual(received, [{ type: "revision", revision: 2 }]);
    assert.equal(bus.listenerCount(TRIP), 0);
});
