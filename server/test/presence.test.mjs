import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import {
    normalizePresenceInput,
    normalizePresenceTarget,
} from "../src/modules/trips/presence-contract.js";
import { createTripPresenceService } from "../src/modules/trips/trip-presence-service.js";
import { createTripStreamController } from "../src/modules/trips/trip-stream-controller.js";
import { createTripEventBus, normalizeTripEventPacket } from "../src/realtime/trip-events.js";

const TRIP = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const config = {
    presenceTtlMs: 45_000,
    presenceRateLimit: 2,
    presenceRateWindowMs: 60_000,
    presenceCleanupLimit: 50,
};

function row(overrides = {}) {
    return {
        presence_session_id: SESSION,
        user_id: USER,
        display_name: "Ana",
        role: "editor",
        state: "editing",
        target_type: "spot",
        target_id: "spot-a",
        target_field: "name",
        sequence: 1,
        expires_at: new Date(Date.now() + 45_000).toISOString(),
        ...overrides,
    };
}

function databaseFor(handler) {
    const calls = [];
    return {
        calls,
        async query(text, params) {
            calls.push({ text, params });
            if (text.includes("FROM trips t JOIN trip_members")) {
                return { rowCount: 1, rows: [{ owner_id: USER, role: handler.role || "editor" }] };
            }
            if (text.startsWith("DELETE FROM trip_presence\n            WHERE ctid")) return { rowCount: 0, rows: [] };
            return handler(text, params);
        },
    };
}

test("el contrato de presencia solo admite ids técnicos y viewer solo viewing del viaje", () => {
    assert.deepEqual(normalizePresenceTarget({ type: "spot", id: "spot-a", field: "name" }), {
        type: "spot", id: "spot-a", field: "name",
    });
    assert.throws(() => normalizePresenceTarget({ type: "spot", id: "texto con espacios" }), /Objetivo/);
    assert.throws(() => normalizePresenceTarget({ type: "spot", id: "spot-a", field: "email" }), /Campo/);
    assert.deepEqual(normalizePresenceInput({
        sequence: 1, state: "viewing", target: { type: "plan", id: "plan" },
    }, { role: "viewer" }).state, "viewing");
    assert.throws(() => normalizePresenceInput({
        sequence: 2, state: "editing", target: { type: "spot", id: "spot-a" },
    }, { role: "viewer" }), (error) => error.status === 403);
});

test("upsert deriva identidad y rol, renueva TTL y publica solo presencia pública", async () => {
    const events = createTripEventBus();
    const received = [];
    events.subscribe(TRIP, (event) => received.push(event));
    const database = databaseFor((text) => {
        if (text.startsWith("INSERT INTO trip_presence")) return { rowCount: 1, rows: [row()] };
        throw new Error(`SQL inesperado: ${text}`);
    });
    const logs = [];
    const service = createTripPresenceService({ database, events, config, logger: { warn() {}, info: (line) => logs.push(line) } });
    const result = await service.upsert({
        active: { user_id: USER, display_name: "Ana", email: "no-publicar@example.com" },
        tripId: TRIP,
        presenceSessionId: SESSION,
        input: { sequence: 1, state: "editing", target: { type: "spot", id: "spot-a", field: "name" }, document: "no" },
    });
    assert.equal(result.accepted, true);
    assert.equal(result.presence.displayName, "Ana");
    assert.equal(result.presence.role, "editor");
    assert.equal(JSON.stringify(received).includes("no-publicar"), false);
    assert.equal(received[0].type, "presence-upsert");
    assert.equal(logs.join("").includes("no-publicar"), false);
    assert.equal(logs.join("").includes("document"), false);
    assert.match(logs[0], /trip_presence_upsert/);
});

test("snapshot omite expiradas por SQL y salida usa secuencia monotónica", async () => {
    const published = [];
    const database = databaseFor((text) => {
        if (text.startsWith("SELECT p.presence_session_id")) return { rowCount: 1, rows: [row()] };
        if (text.startsWith("DELETE FROM trip_presence\n            WHERE trip_id")) return { rowCount: 1, rows: [row()] };
        throw new Error(`SQL inesperado: ${text}`);
    });
    const service = createTripPresenceService({
        database,
        events: { publish: async (_tripId, event) => published.push(event) },
        config,
        logger: { warn() {} },
    });
    const snapshot = await service.snapshot({ userId: USER, tripId: TRIP });
    assert.equal(snapshot.presences.length, 1);
    assert.match(database.calls.find((call) => call.text.includes("ORDER BY p.updated_at")).text, /expires_at > now/);
    const left = await service.leave({
        active: { user_id: USER }, tripId: TRIP, presenceSessionId: SESSION, input: { sequence: 2 },
    });
    assert.equal(left.removed, true);
    assert.deepEqual(published[0], { type: "presence-leave", presenceSessionId: SESSION, userId: USER, sequence: 2 });
});

test("rate limit es independiente y reintentable", async () => {
    const database = databaseFor((text) => {
        if (text.startsWith("INSERT INTO trip_presence")) return { rowCount: 1, rows: [row()] };
        throw new Error(`SQL inesperado: ${text}`);
    });
    const service = createTripPresenceService({ database, events: null, config, logger: { warn() {} } });
    const base = { active: { user_id: USER, display_name: "Ana" }, tripId: TRIP, presenceSessionId: SESSION };
    await service.upsert({ ...base, input: { sequence: 1, state: "editing", target: { type: "spot", id: "spot-a" } } });
    await service.upsert({ ...base, input: { sequence: 2, state: "editing", target: { type: "spot", id: "spot-a" } } });
    await assert.rejects(
        service.upsert({ ...base, input: { sequence: 3, state: "editing", target: { type: "spot", id: "spot-a" } } }),
        (error) => error.status === 429 && error.details.retryAfterMs === 60_000,
    );
});

test("el evento y SSE entregan snapshot seguido de deltas sin borrador, email ni documento", async () => {
    const packet = normalizeTripEventPacket(TRIP, {
        type: "presence-upsert",
        presence: {
            presenceSessionId: SESSION, userId: USER, displayName: "Ana", role: "editor",
            state: "editing", target: { type: "spot", id: "spot-a", field: "name" },
            sequence: 4, expiresAt: new Date(Date.now() + 45_000).toISOString(),
            email: "no@example.com", draft: "secreto", document: { no: true },
        },
    });
    assert.equal(JSON.stringify(packet).includes("secreto"), false);
    assert.equal(JSON.stringify(packet).includes("no@example"), false);

    const events = createTripEventBus();
    const database = databaseFor(() => ({ rowCount: 0, rows: [] }));
    const presenceService = { snapshot: async () => ({ presences: [packet.event.presence], serverTime: new Date().toISOString(), ttlMs: 45_000 }) };
    const controller = createTripStreamController({ database, events, presenceService });
    const req = Object.assign(new EventEmitter(), { params: { tripId: TRIP } });
    const chunks = [];
    const res = {
        locals: { activeSession: { user_id: USER } },
        status() { return this; }, set() { return this; }, flushHeaders() {},
        write(chunk) { chunks.push(chunk); }, end() {},
    };
    await controller.streamTrip(req, res);
    events.publish(TRIP, { type: "presence-leave", presenceSessionId: SESSION, userId: USER, sequence: 5 });
    const output = chunks.join("");
    assert.match(output, /event: presence-snapshot/);
    assert.match(output, /event: presence-leave/);
    assert.ok(output.indexOf("presence-snapshot") < output.indexOf("presence-leave"));
    req.emit("close");
});
