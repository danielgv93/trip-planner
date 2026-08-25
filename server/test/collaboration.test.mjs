import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { readTripAccess, requireTripRole, WRITERS } from "../src/modules/trips/trip-access.js";
import { createTripMemberService } from "../src/modules/trips/trip-member-service.js";
import { createTripStreamController } from "../src/modules/trips/trip-stream-controller.js";
import { createPostgresTripEventBus, createTripEventBus, MAX_NOTIFY_BYTES, normalizeTripEventPacket } from "../src/realtime/trip-events.js";

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

test("el payload de revisión solo contiene metadatos permitidos y cabe holgadamente en NOTIFY", () => {
    const packet = normalizeTripEventPacket(TRIP, {
        type: "revision",
        revision: 42,
        hash: "abc123",
        actor: { userId: OWNER, displayName: "Ana" },
        document: { secret: "nunca" },
        token: "nunca",
    });
    assert.deepEqual(Object.keys(packet.event).sort(), ["actor", "hash", "revision", "type"]);
    assert.equal(JSON.stringify(packet).includes("nunca"), false);
    assert.ok(Buffer.byteLength(JSON.stringify(packet)) < MAX_NOTIFY_BYTES / 10);
    assert.throws(() => normalizeTripEventPacket(TRIP, { type: "revision", revision: 2, hash: "x".repeat(201) }), /INVALID/);
});

test("el evento de operación publica solo ids técnicos, targets y actor acotado", () => {
    const packet = normalizeTripEventPacket(TRIP, {
        type: "operation",
        revision: 43,
        hash: "hash-43",
        clientMutationId: "44444444-4444-4444-8444-444444444444",
        deviceId: "device-1",
        kind: "set-field",
        targetKeys: ["day:day-1", "spot:spot-a", "spot:spot-a:cost"],
        actor: { userId: OWNER, displayName: "Ana" },
        payload: { value: "nunca" },
        document: { secret: "nunca" },
        email: "nunca@example.com",
    });
    assert.deepEqual(Object.keys(packet.event).sort(), [
        "actor", "clientMutationId", "deviceId", "hash", "kind",
        "revision", "targetKeys", "type",
    ]);
    assert.equal(JSON.stringify(packet).includes("nunca"), false);
    assert.throws(() => normalizeTripEventPacket(TRIP, {
        ...packet.event,
        targetKeys: ["contenido introducido por usuario"],
    }), /INVALID/);
});

test("SSE conserva cabeceras, cursor y deja de entregar al revocar acceso", async () => {
    const events = createTripEventBus();
    const database = fakeDatabase(() => accessRow("editor"));
    const controller = createTripStreamController({ database, events });
    const req = Object.assign(new EventEmitter(), { params: { tripId: TRIP } });
    const chunks = [];
    const res = {
        locals: { activeSession: { user_id: MEMBER } },
        statusCode: 0,
        ended: false,
        status(code) { this.statusCode = code; return this; },
        set(headers) { this.headers = headers; return this; },
        flushHeaders() { this.flushed = true; },
        write(chunk) { chunks.push(chunk); },
        end() { this.ended = true; },
    };
    await controller.streamTrip(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["x-accel-buffering"], "no");
    events.publish(TRIP, { type: "revision", revision: 7, hash: "h" });
    assert.match(chunks.join(""), /id: 7\nevent: revision/);
    events.publish(TRIP, {
        type: "operation",
        revision: 8,
        hash: "h2",
        clientMutationId: "44444444-4444-4444-8444-444444444444",
        deviceId: "device-1",
        kind: "set-field",
        targetKeys: ["spot:spot-a:cost"],
    });
    assert.match(chunks.join(""), /id: 8\nevent: operation/);
    events.publish(TRIP, { type: "access-revoked", userId: MEMBER });
    assert.equal(res.ended, true);
    assert.equal(events.listenerCount(TRIP), 0);
    const before = chunks.length;
    events.publish(TRIP, { type: "revision", revision: 8, hash: "h2" });
    assert.equal(chunks.length, before);
});

test("SSE responde como no encontrado a quien no pertenece al viaje", async () => {
    const controller = createTripStreamController({ database: fakeDatabase(() => ({ rowCount: 0, rows: [] })), events: createTripEventBus() });
    const req = Object.assign(new EventEmitter(), { params: { tripId: TRIP } });
    await assert.rejects(
        controller.streamTrip(req, { locals: { activeSession: { user_id: MEMBER } } }),
        (error) => error.status === 404,
    );
});

test("el listener PostgreSQL reintenta con espera acotada y cierra su conexión dedicada", async () => {
    const clients = [];
    const database = {
        async connect() {
            const client = new EventEmitter();
            client.queries = [];
            client.query = async (text) => client.queries.push(text);
            client.release = (destroyed = false) => { client.released = true; client.destroyed = destroyed; };
            clients.push(client);
            return client;
        },
        query: async () => ({ rows: [] }),
    };
    const bus = createPostgresTripEventBus({
        database,
        logger: { info() {}, warn() {}, error() {} },
        retryBaseMs: 5,
        retryMaxMs: 5,
    });
    await bus.start();
    assert.match(clients[0].queries[0], /LISTEN trip_planner_events/);
    clients[0].emit("error", Object.assign(new Error("lost"), { code: "CONNECTION_LOST" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(clients.length, 2);
    assert.equal(clients[0].destroyed, true);
    await bus.close();
    assert.equal(clients[1].released, true);
    assert.match(clients[1].queries.at(-1), /UNLISTEN trip_planner_events/);
});

test("un fallo de NOTIFY se informa sin convertir la confirmación persistente en excepción", async () => {
    const errors = [];
    const bus = createPostgresTripEventBus({
        database: { query: async () => { throw Object.assign(new Error("notify down"), { code: "CONNECTION_LOST" }); } },
        logger: { info() {}, warn() {}, error: (line) => errors.push(line) },
    });
    const published = await bus.publish(TRIP, { type: "revision", revision: 7, hash: "hash-7" });
    assert.equal(published, false);
    assert.match(errors[0], /trip_event_publish_failed/);
});
