import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createApi } from "../src/api/create-api.js";
import { loadConfig } from "../src/config/runtime-config.js";
import { createDatabase } from "../src/infrastructure/postgres/database.js";
import { migrate } from "../src/infrastructure/postgres/run-migrations.js";
import { secretHash } from "../src/security/session-security.js";
import { createPostgresTripEventBus } from "../src/realtime/trip-events.js";
import { reconciliationDecision } from "../../js/features/cloud/live-sync-contracts.js";
import { targetFingerprint } from "../../js/core/plan-operations.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("dos buses PostgreSQL comparten eventos entre procesos lógicos y aíslan viajes", { skip: !databaseUrl }, async () => {
    await withServer(async ({ database }) => {
        const logger = { info() {}, warn() {}, error() {} };
        const first = createPostgresTripEventBus({ database, logger, retryBaseMs: 10, retryMaxMs: 50 });
        const second = createPostgresTripEventBus({ database, logger, retryBaseMs: 10, retryMaxMs: 50 });
        await Promise.all([first.start(), second.start()]);
        const tripId = randomUUID();
        const otherTripId = randomUUID();
        const received = [];
        const stop = second.subscribe(tripId, (event) => received.push(event));
        try {
            await first.publish(otherTripId, { type: "revision", revision: 9, hash: "other" });
            await first.publish(tripId, { type: "revision", revision: 2, hash: "expected" });
            const sessionId = randomUUID();
            await first.publish(tripId, {
                type: "presence-upsert",
                presence: {
                    presenceSessionId: sessionId,
                    userId: randomUUID(),
                    displayName: "Proceso A",
                    role: "editor",
                    state: "editing",
                    target: { type: "spot", id: "spot-a", field: "name" },
                    sequence: 1,
                    expiresAt: new Date(Date.now() + 45_000).toISOString(),
                },
            });
            await Promise.race([
                new Promise((resolve) => {
                    const poll = () => received.length >= 2 ? resolve() : setTimeout(poll, 5);
                    poll();
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("NOTIFY_TIMEOUT")), 2_000)),
            ]);
            assert.equal(received[0].type, "revision");
            assert.equal(received[1].type, "presence-upsert");
            assert.equal(received[1].presence.presenceSessionId, sessionId);
        } finally {
            stop();
            await Promise.all([first.close(), second.close()]);
        }
    });
});

async function withServer(callback) {
    const config = loadConfig({
        NODE_ENV: "test",
        CLOUD_ENABLED: "true",
        GRANULAR_SYNC_ENABLED: "true",
        DATABASE_URL: databaseUrl,
        APP_ORIGIN: "http://test.local",
    });
    const database = await createDatabase(config);
    await database.query("DROP TABLE IF EXISTS account_deletions, trip_shares, trip_presence, trip_members, trip_mutations, trip_revisions, trips, sessions, login_tokens, users, schema_migrations CASCADE");
    await migrate(database);
    const logger = { info() {}, error() {} };
    const events = createPostgresTripEventBus({ database, logger: { ...logger, warn() {} } });
    await events.start();
    const server = createServer(createApi({ database, config, logger, events }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    async function request(path, { method = "GET", body, cookie, csrf } = {}) {
        const response = await fetch(`${baseUrl}${path}`, {
            method,
            headers: {
                origin: config.appOrigin,
                ...(body === undefined ? {} : { "content-type": "application/json" }),
                ...(cookie ? { cookie } : {}),
                ...(csrf ? { "x-csrf-token": csrf } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { response, body: await response.json(), cookie: response.headers.get("set-cookie") };
    }
    async function authenticate(path, email, password = "contraseña-segura") {
        const result = await request(path, { method: "POST", body: { email, password, deviceLabel: "prueba" } });
        return { ...result, csrf: result.body.csrfToken, sessionCookie: result.cookie?.split(";")[0] };
    }
    const register = (email, password) => authenticate("/api/auth/register", email, password);
    const login = (email, password) => authenticate("/api/auth/login", email, password);
    try {
        await callback({ database, request, register, login, baseUrl, config });
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await events.close();
        await database.close();
    }
}

test("dos clientes completan guardar → evento → GET → repintado sin reload", { skip: !databaseUrl }, async () => {
    await withServer(async ({ request, register, baseUrl, config }) => {
        const owner = await register("flujo-owner@example.com");
        const receiver = await register("flujo-receiver@example.com");
        const auth = (user) => ({ cookie: user.sessionCookie, csrf: user.csrf });
        const original = { tripTitle: "Antes", days: [{ id: "day", date: "2026-08-25", title: "Día", spots: [{ id: "spot", name: "Antes" }] }] };
        const created = await request("/api/trips", { method: "POST", body: { document: original }, ...auth(owner) });
        const tripId = created.body.trip.id;
        await request(`/api/trips/${tripId}/members`, {
            method: "POST",
            body: { email: "flujo-receiver@example.com", role: "editor" },
            ...auth(owner),
        });

        const abort = new AbortController();
        const stream = await fetch(`${baseUrl}/api/trips/${tripId}/events`, {
            headers: { origin: config.appOrigin, cookie: receiver.sessionCookie },
            signal: abort.signal,
        });
        assert.equal(stream.status, 200);
        const reader = stream.body.getReader();
        const decoder = new TextDecoder();
        let frames = "";
        try {
            // Consume the initial retry frame before the sender mutates.
            frames += decoder.decode((await reader.read()).value, { stream: true });
            const changed = { ...original, tripTitle: "Después", days: [{ ...original.days[0], spots: [{ id: "spot", name: "Guardada" }] }] };
            const mutation = await request(`/api/trips/${tripId}/mutations`, {
                method: "POST",
                body: { baseRevision: 1, clientMutationId: randomUUID(), document: changed },
                ...auth(owner),
            });
            assert.equal(mutation.response.status, 200);
            while (!frames.includes("event: revision")) {
                const chunk = await Promise.race([
                    reader.read(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("SSE_TIMEOUT")), 2_000)),
                ]);
                if (chunk.done) break;
                frames += decoder.decode(chunk.value, { stream: true });
            }
            assert.match(frames, new RegExp(`id: ${mutation.body.revision}\\nevent: revision`));

            const remote = await request(`/api/trips/${tripId}`, { cookie: receiver.sessionCookie });
            assert.equal(reconciliationDecision({ baseRevision: 1, remoteRevision: remote.body.trip.current_revision }), "apply-remote");
            let receiverDocument = original;
            let repaints = 0;
            receiverDocument = remote.body.trip.document;
            repaints += 1;
            assert.equal(receiverDocument.days[0].spots[0].name, "Guardada");
            assert.equal(repaints, 1);
        } finally {
            abort.abort();
            await reader.cancel().catch(() => {});
        }
    });
});

test("dos ediciones independientes revelan el conflicto global del protocolo snapshot", { skip: !databaseUrl }, async () => {
    await withServer(async ({ request, register }) => {
        const owner = await register("granular-owner@example.com");
        const editor = await register("granular-editor@example.com");
        const auth = (user) => ({ cookie: user.sessionCookie, csrf: user.csrf });
        const original = {
            tripTitle: "Viaje compartido",
            days: [{
                id: "day-independent",
                date: "2026-08-25",
                title: "Día",
                spots: [
                    { id: "spot-a", name: "Museo", cost: 10 },
                    { id: "spot-b", name: "Cena", cost: 20 },
                ],
            }],
        };
        const created = await request("/api/trips", {
            method: "POST",
            body: { document: original },
            ...auth(owner),
        });
        const tripId = created.body.trip.id;
        await request(`/api/trips/${tripId}/members`, {
            method: "POST",
            body: { email: "granular-editor@example.com", role: "editor" },
            ...auth(owner),
        });

        const ownerDocument = structuredClone(original);
        ownerDocument.days[0].spots[0].cost = 15;
        const editorDocument = structuredClone(original);
        editorDocument.days[0].spots[1].cost = 25;
        const [first, second] = await Promise.all([
            request(`/api/trips/${tripId}/mutations`, {
                method: "POST",
                body: { baseRevision: 1, clientMutationId: randomUUID(), document: ownerDocument },
                ...auth(owner),
            }),
            request(`/api/trips/${tripId}/mutations`, {
                method: "POST",
                body: { baseRevision: 1, clientMutationId: randomUUID(), document: editorDocument },
                ...auth(editor),
            }),
        ]);

        // Acceptance criterion for the granular protocol: this assertion will
        // be replaced by two 200 responses and a document containing 15 + 25.
        assert.deepEqual([first.response.status, second.response.status].sort(), [200, 409]);
        const remote = await request(`/api/trips/${tripId}`, { cookie: owner.sessionCookie });
        const costs = remote.body.trip.document.days[0].spots.map((spot) => spot.cost);
        assert.ok(
            costs[0] === 15 && costs[1] === 20 || costs[0] === 10 && costs[1] === 25,
            "el protocolo snapshot conserva solo una de las ediciones independientes",
        );
    });
});

test("operaciones granulares rebasan cambios independientes y localizan colisiones", { skip: !databaseUrl }, async () => {
    await withServer(async ({ request, register }) => {
        const owner = await register("operations-owner@example.com");
        const editor = await register("operations-editor@example.com");
        const viewer = await register("operations-viewer@example.com");
        const stranger = await register("operations-stranger@example.com");
        const auth = (user) => ({ cookie: user.sessionCookie, csrf: user.csrf });
        const original = {
            tripTitle: "Operaciones",
            days: [
                { id: "day-1", date: "2026-08-25", title: "Uno", spots: [
                    { id: "spot-a", name: "A", cost: 10 },
                    { id: "spot-b", name: "B", cost: 20 },
                ] },
                { id: "day-2", date: "2026-08-26", title: "Dos", spots: [] },
            ],
        };
        const created = await request("/api/trips", { method: "POST", body: { document: original }, ...auth(owner) });
        const tripId = created.body.trip.id;
        for (const [email, role] of [["operations-editor@example.com", "editor"], ["operations-viewer@example.com", "viewer"]]) {
            await request(`/api/trips/${tripId}/members`, { method: "POST", body: { email, role }, ...auth(owner) });
        }
        const envelope = (target, precondition, payload, baseRevision = 1, kind = "set-field") => ({
            protocolVersion: 1,
            clientMutationId: randomUUID(),
            deviceId: "integration-device",
            baseRevision,
            kind,
            target,
            precondition,
            payload,
        });
        const publish = (user, op) => request(`/api/v1/trips/${tripId}/operations`, {
            method: "POST", body: op, ...auth(user),
        });

        const independent = [
            { user: owner, op: envelope({ type: "spot", id: "spot-a", field: "cost" }, { expectedValue: 10 }, { value: 15 }) },
            { user: editor, op: envelope({ type: "spot", id: "spot-b", field: "cost" }, { expectedValue: 20 }, { value: 25 }) },
        ];
        const independentResults = await Promise.all(independent.map(({ user, op }) => publish(user, op)));
        assert.deepEqual(
            independentResults.map((result) => result.response.status),
            [200, 200],
            JSON.stringify(independentResults.map((result) => result.body)),
        );
        assert.deepEqual(independentResults.map((result) => result.body.revision).sort(), [2, 3]);
        let remote = await request(`/api/trips/${tripId}`, { cookie: owner.sessionCookie });
        assert.deepEqual(remote.body.trip.document.days[0].spots.map((spot) => spot.cost), [15, 25]);

        const sameField = [
            { user: owner, op: envelope({ type: "spot", id: "spot-a", field: "cost" }, { expectedValue: 15 }, { value: 16 }, 3) },
            { user: editor, op: envelope({ type: "spot", id: "spot-a", field: "cost" }, { expectedValue: 15 }, { value: 17 }, 3) },
        ];
        const sameResults = await Promise.all(sameField.map(({ user, op }) => publish(user, op)));
        assert.deepEqual(sameResults.map((result) => result.response.status).sort(), [200, 409]);
        const acceptedIndex = sameResults.findIndex((result) => result.response.status === 200);
        const conflictIndex = acceptedIndex === 0 ? 1 : 0;
        assert.equal(sameResults[conflictIndex].body.error.code, "TARGET_CONFLICT");
        assert.equal(Object.hasOwn(sameResults[conflictIndex].body, "document"), false);
        const conflictReplay = await publish(owner, sameField[conflictIndex].op);
        assert.equal(conflictReplay.response.status, 409);
        assert.equal(conflictReplay.body.idempotent, true);
        const acceptedReplay = await publish(
            sameField[acceptedIndex].user === owner ? editor : owner,
            sameField[acceptedIndex].op,
        );
        assert.equal(acceptedReplay.response.status, 200);
        assert.equal(acceptedReplay.body.idempotent, true);
        assert.equal(acceptedReplay.body.revision, sameResults[acceptedIndex].body.revision);

        remote = await request(`/api/trips/${tripId}`, { cookie: owner.sessionCookie });
        const currentCost = remote.body.trip.document.days[0].spots[0].cost;
        const noOp = await publish(owner, envelope(
            { type: "spot", id: "spot-a", field: "cost" },
            { expectedValue: 999 },
            { value: currentCost },
            1,
        ));
        assert.equal(noOp.body.status, "no-op");
        assert.equal(noOp.body.revision, 4);

        const moves = [
            { user: owner, op: envelope(
                { type: "spot", id: "spot-b" },
                { expectedLocation: { containerId: "day-1", beforeId: null } },
                { containerId: "day-2", beforeId: null },
                4,
                "move-entity",
            ) },
            { user: editor, op: envelope(
                { type: "spot", id: "spot-b" },
                { expectedLocation: { containerId: "day-1", beforeId: null } },
                { containerId: "backlog", beforeId: null },
                4,
                "move-entity",
            ) },
        ];
        const moveResults = await Promise.all(moves.map(({ user, op }) => publish(user, op)));
        assert.deepEqual(moveResults.map((result) => result.response.status).sort(), [200, 409]);
        assert.equal(moveResults.find((result) => result.response.status === 409).body.error.code, "MOVE_CONFLICT");

        remote = await request(`/api/trips/${tripId}`, { cookie: owner.sessionCookie });
        const remoteDocument = remote.body.trip.document;
        const deleteSpot = envelope(
            { type: "spot", id: "spot-a" },
            { expectedFingerprint: targetFingerprint(remoteDocument, { type: "spot", id: "spot-a" }) },
            { command: "delete-spot" },
            5,
            "command",
        );
        const editSpot = envelope(
            { type: "spot", id: "spot-a", field: "cost" },
            { expectedValue: currentCost },
            { value: currentCost + 1 },
            5,
        );
        const deleteVsEdit = await Promise.all([publish(owner, deleteSpot), publish(editor, editSpot)]);
        assert.deepEqual(deleteVsEdit.map((result) => result.response.status).sort(), [200, 409]);
        assert.ok(["ENTITY_DELETED", "TARGET_CONFLICT"].includes(
            deleteVsEdit.find((result) => result.response.status === 409).body.error.code,
        ));

        const catchUp = await request(`/api/v1/trips/${tripId}/operations?after=1&limit=100`, { cookie: viewer.sessionCookie });
        assert.equal(catchUp.response.status, 200);
        assert.equal(catchUp.body.snapshotRequired, false);
        assert.deepEqual(catchUp.body.operations.map((entry) => entry.revision), [2, 3, 4, 5, 6]);
        assert.equal(JSON.stringify(catchUp.body.operations).includes("document"), false);
        assert.equal((await request(`/api/v1/trips/${tripId}/operations?after=0`, { cookie: viewer.sessionCookie })).body.snapshotRequired, true);

        const unauthorizedOp = envelope({ type: "plan", id: "plan", field: "tripTitle" }, { expectedValue: "Operaciones" }, { value: "No" }, 6);
        assert.equal((await publish(viewer, unauthorizedOp)).response.status, 403);
        assert.equal((await publish(stranger, unauthorizedOp)).response.status, 404);
        assert.equal((await request(`/api/v1/trips/${tripId}/operations?after=1`, { cookie: stranger.sessionCookie })).response.status, 404);
    });
});

test("Postgres integra cuentas, sesiones, concurrencia, idempotencia y aislamiento", { skip: !databaseUrl }, async () => {
    await withServer(async ({ database, request, register, login }) => {
        const registeredA = await register("Viajera-A@Example.com");
        assert.equal(registeredA.response.status, 200);
        const storedUser = (await database.query("SELECT email_normalized, password_hash FROM users WHERE id = $1", [registeredA.body.user.id])).rows[0];
        assert.equal(storedUser.email_normalized, "viajera-a@example.com");
        assert.equal(storedUser.password_hash.includes("contraseña-segura"), false);

        const duplicate = await register("viajera-a@example.com");
        assert.equal(duplicate.response.status, 409);
        const incorrect = await login("viajera-a@example.com", "contraseña-incorrecta");
        assert.equal(incorrect.response.status, 401);
        assert.equal(incorrect.body.error.code, "INVALID_CREDENTIALS");

        const userA = await login("viajera-a@example.com");
        assert.equal(userA.response.status, 200);
        assert.match(userA.cookie, /HttpOnly/);
        assert.match(userA.cookie, /SameSite=Lax/);

        const avatarDataUrl = `data:image/png;base64,${Buffer.from("avatar").toString("base64")}`;
        const updatedProfile = await request("/api/account/profile", {
            method: "PATCH",
            body: { displayName: "Viajera A", avatarDataUrl },
            cookie: userA.sessionCookie,
            csrf: userA.csrf,
        });
        assert.equal(updatedProfile.response.status, 200);
        assert.equal(updatedProfile.body.user.displayName, "Viajera A");
        assert.equal(updatedProfile.body.user.avatarDataUrl, avatarDataUrl);

        const wrongPasswordChange = await request("/api/account/password", {
            method: "PATCH",
            body: { currentPassword: "contraseña-incorrecta", newPassword: "contraseña-renovada" },
            cookie: userA.sessionCookie,
            csrf: userA.csrf,
        });
        assert.equal(wrongPasswordChange.response.status, 401);
        const changedPassword = await request("/api/account/password", {
            method: "PATCH",
            body: { currentPassword: "contraseña-segura", newPassword: "contraseña-renovada" },
            cookie: userA.sessionCookie,
            csrf: userA.csrf,
        });
        assert.equal(changedPassword.response.status, 200);
        assert.equal((await login("viajera-a@example.com", "contraseña-segura")).response.status, 401);
        assert.equal((await login("viajera-a@example.com", "contraseña-renovada")).response.status, 200);

        const plan = { tripTitle: "A", days: [{ id: "d", date: "2026-08-12", title: "Día", spots: [] }] };
        const withoutCsrf = await request("/api/trips", { method: "POST", body: { document: plan }, cookie: userA.sessionCookie });
        assert.equal(withoutCsrf.response.status, 403);
        const created = await request("/api/trips", { method: "POST", body: { document: plan }, cookie: userA.sessionCookie, csrf: userA.csrf });
        assert.equal(created.response.status, 201);
        const tripId = created.body.trip.id;

        const mutationA = { baseRevision: 1, clientMutationId: randomUUID(), document: { ...plan, tripTitle: "A1" } };
        const mutationB = { baseRevision: 1, clientMutationId: randomUUID(), document: { ...plan, tripTitle: "A2" } };
        const concurrent = await Promise.all([
            request(`/api/trips/${tripId}/mutations`, { method: "POST", body: mutationA, cookie: userA.sessionCookie, csrf: userA.csrf }),
            request(`/api/trips/${tripId}/mutations`, { method: "POST", body: mutationB, cookie: userA.sessionCookie, csrf: userA.csrf }),
        ]);
        assert.deepEqual(concurrent.map((result) => result.response.status).sort(), [200, 409]);
        const winner = concurrent.find((result) => result.response.status === 200);
        const winnerMutation = concurrent[0] === winner ? mutationA : mutationB;
        const retry = await request(`/api/trips/${tripId}/mutations`, { method: "POST", body: winnerMutation, cookie: userA.sessionCookie, csrf: userA.csrf });
        assert.equal(retry.body.idempotent, true);
        assert.equal(retry.body.revision, winner.body.revision);

        const current = await request(`/api/trips/${tripId}`, { cookie: userA.sessionCookie });
        const noOp = await request(`/api/trips/${tripId}/mutations`, {
            method: "POST",
            body: { baseRevision: Number(current.body.trip.current_revision), clientMutationId: randomUUID(), document: current.body.trip.document },
            cookie: userA.sessionCookie,
            csrf: userA.csrf,
        });
        assert.equal(noOp.body.noOp, true);
        assert.equal(noOp.body.revision, Number(current.body.trip.current_revision));

        const invalid = await request(`/api/trips/${tripId}/mutations`, { method: "POST", body: { baseRevision: noOp.body.revision, clientMutationId: randomUUID(), document: {} }, cookie: userA.sessionCookie, csrf: userA.csrf });
        assert.equal(invalid.response.status, 400);

        const revisions = await request(`/api/trips/${tripId}/revisions`, { cookie: userA.sessionCookie });
        assert.ok(revisions.body.revisions.length >= 2);
        assert.equal(Object.hasOwn(revisions.body.revisions[0], "document"), false);

        const userB = await register("viajera-b@example.com");
        assert.equal((await request(`/api/trips/${tripId}`, { cookie: userB.sessionCookie })).response.status, 404);
        assert.equal((await request(`/api/trips/${tripId}`, { method: "PATCH", body: { title: "Robado" }, cookie: userB.sessionCookie, csrf: userB.csrf })).response.status, 404);
        assert.equal((await request(`/api/trips/${tripId}/mutations`, { method: "POST", body: { ...mutationA, clientMutationId: randomUUID(), baseRevision: noOp.body.revision }, cookie: userB.sessionCookie, csrf: userB.csrf })).response.status, 404);
        // Isolation is now uniform: a stranger gets the same 404 on every route
        // instead of an empty-but-successful answer that confirmed the id.
        assert.equal((await request(`/api/trips/${tripId}`, { method: "DELETE", cookie: userB.sessionCookie, csrf: userB.csrf })).response.status, 404);
        assert.equal((await request(`/api/trips/${tripId}/revisions`, { cookie: userB.sessionCookie })).response.status, 404);
        assert.equal((await request("/api/trips", { cookie: userB.sessionCookie })).body.trips.length, 0);
        assert.equal((await request(`/api/trips/${tripId}/share`, { cookie: userB.sessionCookie })).response.status, 404);
        assert.equal((await request(`/api/trips/${tripId}/share`, { method: "POST", cookie: userB.sessionCookie, csrf: userB.csrf })).response.status, 404);
        assert.equal((await database.query("SELECT count(*)::int AS count FROM trip_shares")).rows[0].count, 0);

        assert.equal((await request(`/api/trips/${tripId}/share`, { cookie: userA.sessionCookie })).body.share.shared, false);
        assert.equal((await request("/api/public/trips/inventado-pero-suficientemente-largo")).response.status, 404);
        const published = await request(`/api/trips/${tripId}/share`, { method: "POST", cookie: userA.sessionCookie, csrf: userA.csrf });
        assert.equal(published.response.status, 200);
        const shareToken = published.body.share.token;
        assert.match(shareToken, /^[A-Za-z0-9_-]{32,}$/);
        // Publishing twice must not rotate a link the owner already sent.
        assert.equal((await request(`/api/trips/${tripId}/share`, { method: "POST", cookie: userA.sessionCookie, csrf: userA.csrf })).body.share.token, shareToken);
        assert.equal((await request(`/api/trips/${tripId}/share`, { cookie: userA.sessionCookie })).body.share.token, shareToken);
        assert.equal((await request("/api/trips", { cookie: userA.sessionCookie })).body.trips[0].shared, true);

        // An anonymous reader: no cookie, no CSRF, and no write of any kind.
        const anonymous = await request(`/api/public/trips/${shareToken}`);
        assert.equal(anonymous.response.status, 200);
        assert.equal(anonymous.body.trip.title, (await request(`/api/trips/${tripId}`, { cookie: userA.sessionCookie })).body.trip.title);
        assert.ok(Array.isArray(anonymous.body.trip.document.days));
        assert.equal(Object.hasOwn(anonymous.body.trip, "id"), false);
        assert.equal(Object.hasOwn(anonymous.body.trip, "owner_id"), false);
        // Only GET is public: any other verb falls through to the authentication
        // middleware instead of reaching the share route.
        assert.equal((await request(`/api/public/trips/${shareToken}`, { method: "DELETE" })).response.status, 401);
        assert.equal((await request(`/api/trips/${tripId}`, { method: "PATCH", body: { title: "Robado" } })).response.status, 401);

        const revoked = await request(`/api/trips/${tripId}/share`, { method: "DELETE", cookie: userA.sessionCookie, csrf: userA.csrf });
        assert.equal(revoked.body.share.shared, false);
        assert.equal((await request(`/api/public/trips/${shareToken}`)).response.status, 404);
        // Publishing again mints a different link; the revoked one stays dead.
        const republished = await request(`/api/trips/${tripId}/share`, { method: "POST", cookie: userA.sessionCookie, csrf: userA.csrf });
        assert.notEqual(republished.body.share.token, shareToken);
        assert.equal((await request(`/api/public/trips/${shareToken}`)).response.status, 404);
        assert.equal((await request(`/api/public/trips/${republished.body.share.token}`)).response.status, 200);
        await request(`/api/trips/${tripId}/share`, { method: "DELETE", cookie: userA.sessionCookie, csrf: userA.csrf });

        await database.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE token_hash = $1", [secretHash(userB.sessionCookie.split("=")[1])]);
        assert.equal((await request("/api/session", { cookie: userB.sessionCookie })).body.authenticated, false);

        const accountExport = await request("/api/account/export", { cookie: userA.sessionCookie });
        const serialized = JSON.stringify(accountExport.body);
        assert.equal(serialized.includes("token_hash"), false);
        assert.equal(serialized.includes("csrf"), false);
        assert.equal(serialized.includes("session"), false);

        let retentionRevision = noOp.body.revision;
        for (let index = 0; index < 105; index += 1) {
            const retained = await request(`/api/trips/${tripId}/mutations`, {
                method: "POST",
                body: {
                    baseRevision: retentionRevision,
                    clientMutationId: randomUUID(),
                    document: { ...current.body.trip.document, tripTitle: `Retención ${index}` },
                },
                cookie: userA.sessionCookie,
                csrf: userA.csrf,
            });
            assert.equal(retained.response.status, 200);
            retentionRevision = retained.body.revision;
        }
        assert.equal((await database.query("SELECT count(*)::int AS count FROM trip_revisions WHERE trip_id = $1", [tripId])).rows[0].count, 100);
        assert.equal((await database.query("SELECT 1 FROM trip_revisions WHERE trip_id = $1 AND revision = $2", [tripId, retentionRevision])).rowCount, 1);

        await database.query(`UPDATE trip_mutations SET created_at = now() - interval '31 days'
            WHERE trip_id = $1 AND result_revision < $2`, [tripId, retentionRevision]);
        const expiredPresenceId = randomUUID();
        const livePresenceId = randomUUID();
        await database.query(`INSERT INTO trip_presence(
                trip_id, presence_session_id, user_id, role, state,
                target_type, target_id, sequence, expires_at
            ) VALUES
                ($1::uuid, $2, $3, 'owner', 'viewing', 'trip', $1::text, 1, now() - interval '1 second'),
                ($1::uuid, $4, $3, 'owner', 'viewing', 'trip', $1::text, 1, now() + interval '1 minute')`,
        [tripId, expiredPresenceId, userA.body.user.id, livePresenceId]);
        const cleanupMutation = await request(`/api/trips/${tripId}/mutations`, {
            method: "POST",
            body: {
                baseRevision: retentionRevision,
                clientMutationId: randomUUID(),
                document: { ...current.body.trip.document, tripTitle: "Retención final" },
            },
            cookie: userA.sessionCookie,
            csrf: userA.csrf,
        });
        retentionRevision = cleanupMutation.body.revision;
        assert.equal((await database.query(`SELECT count(*)::int AS count FROM trip_mutations tm
            JOIN trips t ON t.id = tm.trip_id
            WHERE tm.trip_id = $1 AND tm.created_at < now() - interval '30 days'
              AND tm.result_revision <> t.current_revision`, [tripId])).rows[0].count, 0);
        assert.equal((await database.query("SELECT count(*)::int AS count FROM trip_presence WHERE trip_id = $1", [tripId])).rows[0].count, 1);
        assert.equal((await database.query("SELECT 1 FROM trip_presence WHERE presence_session_id = $1", [livePresenceId])).rowCount, 1);
        assert.equal((await database.query("SELECT 1 FROM trip_revisions WHERE trip_id = $1 AND revision = $2", [tripId, retentionRevision])).rowCount, 1);

        const weakDelete = await request("/api/account", { method: "DELETE", body: { password: "contraseña-incorrecta" }, cookie: userA.sessionCookie, csrf: userA.csrf });
        assert.equal(weakDelete.response.status, 401);
        const deletedAccount = await request("/api/account", { method: "DELETE", body: { password: "contraseña-renovada" }, cookie: userA.sessionCookie, csrf: userA.csrf });
        assert.equal(deletedAccount.response.status, 200);
        assert.equal((await request("/api/session", { cookie: userA.sessionCookie })).body.authenticated, false);
        assert.equal((await database.query("SELECT count(*)::int AS count FROM account_deletions WHERE status = 'completed'")).rows[0].count, 1);
        assert.equal((await database.query("SELECT count(*)::int AS count FROM trips WHERE owner_id = $1", [userA.body.user.id])).rows[0].count, 0);
    });
});

test("la colaboración reparte permisos, historial y salida sin tocar la propiedad", { skip: !databaseUrl }, async () => {
    await withServer(async ({ database, request, register }) => {
        const owner = await register("propietaria@example.com");
        const editor = await register("editor@example.com");
        const viewer = await register("lectora@example.com");
        const stranger = await register("ajena@example.com");
        const auth = (user) => ({ cookie: user.sessionCookie, csrf: user.csrf });

        const plan = { tripTitle: "Ruta compartida", days: [{ id: "d", date: "2026-08-12", title: "Día", spots: [] }] };
        const created = await request("/api/trips", { method: "POST", body: { document: plan }, ...auth(owner) });
        const tripId = created.body.trip.id;
        assert.equal(created.body.trip.role, "owner");
        assert.equal(created.body.trip.sync_protocol_version, 1);
        assert.equal((await request(`/api/trips/${tripId}/events`)).response.status, 401);
        assert.equal((await request(`/api/trips/${tripId}/events`, { cookie: stranger.sessionCookie })).response.status, 404);

        // A trip you do not collaborate on is indistinguishable from one that
        // does not exist: never a 403 that would confirm the id.
        assert.equal((await request(`/api/trips/${tripId}`, { cookie: stranger.sessionCookie })).response.status, 404);
        assert.equal((await request(`/api/trips/${tripId}/members`, { cookie: stranger.sessionCookie })).response.status, 404);

        assert.equal((await request(`/api/trips/${tripId}/members`, {
            method: "POST", body: { email: "editor@example.com" }, ...auth(editor),
        })).response.status, 404);
        assert.equal((await request(`/api/trips/${tripId}/members`, {
            method: "POST", body: { email: "nadie@example.com" }, ...auth(owner),
        })).body.error.code, "ACCOUNT_NOT_FOUND");

        const invitedEditor = await request(`/api/trips/${tripId}/members`, {
            method: "POST", body: { email: "Editor@Example.com", role: "editor" }, ...auth(owner),
        });
        assert.equal(invitedEditor.response.status, 201);
        assert.equal(invitedEditor.body.member.role, "editor");
        assert.equal((await request(`/api/trips/${tripId}/members`, {
            method: "POST", body: { email: "editor@example.com" }, ...auth(owner),
        })).body.error.code, "ALREADY_MEMBER");
        await request(`/api/trips/${tripId}/members`, {
            method: "POST", body: { email: "lectora@example.com", role: "viewer" }, ...auth(owner),
        });

        const ownerPresenceA = randomUUID();
        const ownerPresenceB = randomUUID();
        const viewerPresence = randomUUID();
        const presencePath = (sessionId) => `/api/v1/trips/${tripId}/presence/${sessionId}`;
        for (const [sessionId, sequence] of [[ownerPresenceA, 1], [ownerPresenceB, 1]]) {
            const announced = await request(presencePath(sessionId), {
                method: "PUT",
                body: { sequence, state: "editing", target: { type: "spot", id: "spot-a", field: "name" } },
                ...auth(owner),
            });
            assert.equal(announced.response.status, 200);
            assert.equal(announced.body.presence.userId, owner.body.user.id);
            assert.equal(Object.hasOwn(announced.body.presence, "email"), false);
        }
        assert.equal((await request(presencePath(viewerPresence), {
            method: "PUT",
            body: { sequence: 1, state: "editing", target: { type: "spot", id: "spot-a" } },
            ...auth(viewer),
        })).response.status, 403);
        assert.equal((await request(presencePath(viewerPresence), {
            method: "PUT",
            body: { sequence: 2, state: "viewing", target: { type: "plan", id: "plan" } },
            ...auth(viewer),
        })).response.status, 200);
        assert.equal((await request(`/api/v1/trips/${tripId}/presence`, { cookie: stranger.sessionCookie })).response.status, 404);
        let presenceSnapshot = await request(`/api/v1/trips/${tripId}/presence`, { cookie: editor.sessionCookie });
        assert.equal(presenceSnapshot.body.presences.length, 3);
        assert.equal(presenceSnapshot.body.presences.filter((item) => item.userId === owner.body.user.id).length, 2);
        const leftPresence = await request(presencePath(ownerPresenceA), {
            method: "DELETE", body: { sequence: 2 }, ...auth(owner),
        });
        assert.equal(leftPresence.body.removed, true);
        await database.query("UPDATE trip_presence SET expires_at = now() - interval '1 second' WHERE presence_session_id = $1", [ownerPresenceB]);
        presenceSnapshot = await request(`/api/v1/trips/${tripId}/presence`, { cookie: editor.sessionCookie });
        assert.deepEqual(presenceSnapshot.body.presences.map((item) => item.presenceSessionId), [viewerPresence]);

        // The trip now appears in everybody's library, with the role each holds.
        const editorLibrary = await request("/api/trips", { cookie: editor.sessionCookie });
        assert.equal(editorLibrary.body.trips[0].id, tripId);
        assert.equal(editorLibrary.body.trips[0].role, "editor");
        assert.equal(editorLibrary.body.trips[0].members.length, 3);
        assert.equal(editorLibrary.body.trips[0].members[0].role, "owner");
        // Card payloads never carry avatars: they would weigh megabytes.
        assert.equal(JSON.stringify(editorLibrary.body.trips).includes("avatar"), false);

        const editorMutation = await request(`/api/trips/${tripId}/mutations`, {
            method: "POST",
            body: { baseRevision: 1, clientMutationId: randomUUID(), document: { ...plan, tripTitle: "Editado por el equipo" } },
            ...auth(editor),
        });
        assert.equal(editorMutation.response.status, 200);
        const viewerMutation = await request(`/api/trips/${tripId}/mutations`, {
            method: "POST",
            body: { baseRevision: editorMutation.body.revision, clientMutationId: randomUUID(), document: { ...plan, tripTitle: "No" } },
            ...auth(viewer),
        });
        assert.equal(viewerMutation.response.status, 403);
        assert.equal(viewerMutation.body.error.code, "TRIP_FORBIDDEN");
        assert.equal((await request(`/api/trips/${tripId}/share`, { method: "POST", ...auth(editor) })).response.status, 403);

        // Blame: the history says who wrote each revision, for every member.
        const history = await request(`/api/trips/${tripId}/revisions`, { cookie: viewer.sessionCookie });
        assert.equal(history.response.status, 200);
        assert.equal(history.body.revisions[0].actor_user_id, editor.body.user.id);
        assert.equal(history.body.revisions[0].actor_display_name, "editor");
        assert.equal(history.body.revisions[0].protocol_version, null);
        assert.equal(history.body.revisions[0].operation_kind, null);
        assert.deepEqual(history.body.revisions[0].target_keys, []);
        assert.equal(history.body.revisions.at(-1).actor_user_id, owner.body.user.id);

        // Archiving is per collaborator and must not hide the trip from anybody.
        await request(`/api/trips/${tripId}`, { method: "PATCH", body: { archived: true }, ...auth(viewer) });
        assert.equal((await request("/api/trips", { cookie: viewer.sessionCookie })).body.trips.length, 0);
        assert.equal((await request("/api/trips?archived=true", { cookie: viewer.sessionCookie })).body.trips.length, 1);
        assert.equal((await request("/api/trips", { cookie: owner.sessionCookie })).body.trips.length, 1);

        // Only the owner deletes; a collaborator only removes themselves.
        assert.equal((await request(`/api/trips/${tripId}`, { method: "DELETE", ...auth(editor) })).response.status, 403);
        assert.equal((await request(`/api/trips/${tripId}/members/me`, { method: "DELETE", ...auth(owner) })).body.error.code, "OWNER_CANNOT_LEAVE");
        assert.equal((await request(`/api/trips/${tripId}/members/me`, { method: "DELETE", ...auth(viewer) })).response.status, 200);
        assert.equal((await request(`/api/trips/${tripId}`, { cookie: viewer.sessionCookie })).response.status, 404);
        // Leaving removes access, never the work already recorded.
        assert.equal((await database.query("SELECT count(*)::int AS count FROM trip_revisions WHERE trip_id = $1", [tripId])).rows[0].count, 2);

        const demoted = await request(`/api/trips/${tripId}/members/${editor.body.user.id}`, {
            method: "PATCH", body: { role: "viewer" }, ...auth(owner),
        });
        assert.equal(demoted.body.member.role, "viewer");
        assert.equal((await request(`/api/trips/${tripId}/mutations`, {
            method: "POST",
            body: { baseRevision: editorMutation.body.revision, clientMutationId: randomUUID(), document: plan },
            ...auth(editor),
        })).response.status, 403);

        assert.equal((await request(`/api/trips/${tripId}/members/${editor.body.user.id}`, { method: "DELETE", ...auth(owner) })).response.status, 200);
        assert.equal((await request(`/api/trips/${tripId}`, { cookie: editor.sessionCookie })).response.status, 404);
        assert.equal((await request(`/api/trips/${tripId}`, { method: "DELETE", ...auth(owner) })).response.status, 200);
    });
});

test("las migraciones avanzan desde cada versión aditiva soportada", { skip: !databaseUrl }, async () => {
    const config = loadConfig({ NODE_ENV: "test", CLOUD_ENABLED: "true", DATABASE_URL: databaseUrl, APP_ORIGIN: "http://test.local" });
    const database = await createDatabase(config);
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
    try {
        const files = ["001_accounts.sql", "002_trips.sql", "003_account_deletions.sql", "004_password_auth.sql",
            "005_account_profiles.sql", "006_avatar_size_limit.sql", "007_trip_shares.sql",
            "008_trip_collaboration.sql", "009_live_collaboration.sql"];
        for (const startingVersion of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
            await database.query("DROP TABLE IF EXISTS account_deletions, trip_shares, trip_presence, trip_members, trip_mutations, trip_revisions, trips, sessions, login_tokens, users, schema_migrations CASCADE");
            await database.query(`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
            for (const name of files.slice(0, startingVersion)) {
                await database.query(await readFile(join(migrationsDir, name), "utf8"));
                await database.query("INSERT INTO schema_migrations(name) VALUES ($1)", [name]);
            }
            let legacyTripId = null;
            if (startingVersion === 8) {
                const user = await database.query(`INSERT INTO users(email, email_normalized, display_name)
                    VALUES ('legacy@example.com', 'legacy@example.com', 'Legacy') RETURNING id`);
                const legacyDocument = { version: 28, tripTitle: "Legacy", days: [] };
                const trip = await database.query(`INSERT INTO trips(owner_id, title, document, document_hash, current_revision)
                    VALUES ($1, 'Legacy', $2, 'legacy-hash', 1) RETURNING id`, [user.rows[0].id, legacyDocument]);
                legacyTripId = trip.rows[0].id;
                await database.query("INSERT INTO trip_members(trip_id, user_id, role) VALUES ($1, $2, 'owner')", [legacyTripId, user.rows[0].id]);
                await database.query(`INSERT INTO trip_revisions(trip_id, revision, document, document_hash, actor_user_id)
                    VALUES ($1, 1, $2, 'legacy-hash', $3)`, [legacyTripId, legacyDocument, user.rows[0].id]);
            }
            await migrate(database, migrationsDir);
            const names = (await database.query("SELECT name FROM schema_migrations ORDER BY name")).rows.map((row) => row.name);
            assert.deepEqual(names, files);
            assert.equal((await database.query("SELECT to_regclass('trips') AS name")).rows[0].name, "trips");
            assert.equal((await database.query("SELECT to_regclass('account_deletions') AS name")).rows[0].name, "account_deletions");
            assert.equal((await database.query("SELECT display_name FROM users LIMIT 1")).fields[0].name, "display_name");
            assert.equal((await database.query("SELECT to_regclass('trip_shares') AS name")).rows[0].name, "trip_shares");
            assert.equal((await database.query("SELECT to_regclass('trip_members') AS name")).rows[0].name, "trip_members");
            assert.equal((await database.query("SELECT to_regclass('trip_presence') AS name")).rows[0].name, "trip_presence");
            assert.equal((await database.query("SELECT sync_protocol_version FROM trips LIMIT 1")).fields[0].name, "sync_protocol_version");
            // Every pre-existing trip must survive the split with its owner
            // still able to reach it, which is what the backfilled row grants.
            assert.equal((await database.query(`SELECT count(*)::int AS count FROM trips t
                LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = t.owner_id AND m.role = 'owner'
                WHERE m.trip_id IS NULL`)).rows[0].count, 0);
            if (legacyTripId) {
                const legacy = (await database.query(`SELECT t.title, t.sync_protocol_version,
                        r.protocol_version, r.operation_kind, r.operation, r.target_keys
                    FROM trips t JOIN trip_revisions r ON r.trip_id = t.id AND r.revision = 1
                    WHERE t.id = $1`, [legacyTripId])).rows[0];
                assert.equal(legacy.title, "Legacy");
                assert.equal(legacy.sync_protocol_version, 0);
                assert.equal(legacy.protocol_version, null);
                assert.equal(legacy.operation_kind, null);
                assert.equal(legacy.operation, null);
                assert.deepEqual(legacy.target_keys, []);
            }
        }
    } finally {
        await database.close();
    }
});
