import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createApi } from "../src/api/create-api.js";
import { loadConfig } from "../src/config/runtime-config.js";
import { summarizePlanRevision, validatePlanDocument } from "../src/domain/plan-document.js";
import { AVATAR_MAX_BYTES, createAccountService } from "../src/modules/accounts/account-service.js";
import { createTripShareService } from "../src/modules/trips/trip-share-service.js";
import { createTripService } from "../src/modules/trips/trip-service.js";
import { passwordHash, SlidingWindowLimiter, secretHash, safeEqualHash, sessionCookie, verifyPassword } from "../src/security/session-security.js";
import { createMetrics } from "../src/observability/request-metrics.js";

const config = loadConfig({ CLOUD_ENABLED: "false", APP_ORIGIN: "http://localhost:8000" });

test("el perfil rechaza avatares cuyo contenido supera 500 KB", async () => {
    const database = { query: async () => ({ rows: [] }) };
    const service = createAccountService({ database });
    const oversized = `data:image/webp;base64,${Buffer.alloc(AVATAR_MAX_BYTES + 1).toString("base64")}`;
    await assert.rejects(
        service.updateProfile({ user_id: "u" }, { displayName: "Viajera", avatarDataUrl: oversized }),
        (error) => error?.code === "INVALID_AVATAR",
    );
});

test("el perfil admite un avatar de exactamente 500 KB", async () => {
    const avatarDataUrl = `data:image/webp;base64,${Buffer.alloc(AVATAR_MAX_BYTES).toString("base64")}`;
    const database = { query: async () => ({ rows: [{ id: "u", email: "viajera@example.com", display_name: "Viajera", avatar_data_url: avatarDataUrl }] }) };
    const service = createAccountService({ database });
    const profile = await service.updateProfile({ user_id: "u" }, { displayName: "Viajera", avatarDataUrl });
    assert.equal(profile.avatarDataUrl, avatarDataUrl);
});

test("cloud permanece deshabilitada por defecto y valida configuración peligrosa", () => {
    assert.equal(config.cloudEnabled, false);
    assert.equal(config.granularSyncEnabled, false);
    assert.throws(() => loadConfig({ CLOUD_ENABLED: "true" }), /DATABASE_URL/);
    const granular = loadConfig({
        CLOUD_ENABLED: "true",
        GRANULAR_SYNC_ENABLED: "true",
        DATABASE_URL: "postgres://test",
    });
    assert.equal(granular.granularSyncEnabled, true);
    assert.equal(granular.granularProtocolVersion, 1);
    assert.equal(granular.presenceTtlMs, 45_000);
    assert.equal(granular.operationRateLimit, 240);
});

test("las métricas colaborativas son acotadas y no aceptan contenido", () => {
    const metrics = createMetrics();
    metrics.observeOperation({ durationMs: 12, rebased: true });
    metrics.observeOperation({ durationMs: 20, conflict: true });
    metrics.observeCatchup({ operationCount: 4, snapshotFallback: true });
    metrics.observePresenceUpdate();
    metrics.setPresenceSessions(3);
    assert.deepEqual(metrics.snapshot(), {
        requests: 0, errors: 0, conflicts: 0, latencyAverageMs: 0, latencyMaxMs: 0,
        queueDepth: 0, operationConfirmations: 1, operationConflicts: 1,
        operationLatencyAverageMs: 16, operationLatencyMaxMs: 20,
        automaticRebases: 1, snapshotFallbacks: 1, catchupOperations: 4,
        presenceUpdates: 1, presenceSessions: 3,
    });
});

test("los documentos se validan, normalizan y limitan antes de persistir", () => {
    const normalized = validatePlanDocument({ days: [{ id: "d", spots: [] }] }, config);
    assert.equal(normalized.version, 28);
    assert.throws(() => validatePlanDocument({ days: "no" }, config), /documento/);
    assert.throws(() => validatePlanDocument({ version: 999, days: [] }, config), /Versión/);
});

test("hashes, cookies seguras y rate limiting no exponen el secreto", () => {
    const hash = secretHash("token");
    assert.equal(hash.includes("token"), false);
    assert.equal(safeEqualHash("token", hash), true);
    assert.equal(safeEqualHash("otro", hash), false);
    const cookie = sessionCookie("secret", { sessionDays: 1, production: true });
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Secure/);
    const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 100 });
    assert.equal(limiter.take("key", 0), true);
    assert.equal(limiter.take("key", 1), true);
    assert.equal(limiter.take("key", 2), false);
    assert.equal(limiter.take("key", 101), true);
});

test("las contraseñas usan scrypt con sal y se comparan sin guardar el secreto", async () => {
    const first = await passwordHash("contraseña-segura");
    const second = await passwordHash("contraseña-segura");
    assert.notEqual(first, second);
    assert.equal(first.includes("contraseña-segura"), false);
    assert.equal(await verifyPassword("contraseña-segura", first), true);
    assert.equal(await verifyPassword("incorrecta", first), false);
    assert.equal(await verifyPassword("contraseña-segura", "formato-invalido"), false);
});

test("el resumen de revisión es acotado y no contiene contenido del viaje", () => {
    const summary = summarizePlanRevision(
        { tripTitle: "Antes", days: [{ spots: [] }], backlog: [] },
        { tripTitle: "Después", days: [{ spots: [{ id: "secret", note: "privado" }] }], backlog: [] },
    );
    assert.deepEqual(summary, {
        titleChanged: true,
        daysDelta: 0,
        spotsDelta: 1,
        daysAdded: 0,
        daysRemoved: 0,
        daysChanged: 0,
        spotsAdded: 1,
        spotsRemoved: 0,
        spotsChanged: 0,
        backlogGroupsChanged: 0,
        categoriesChanged: 0,
        tagsChanged: 0,
        notePagesChanged: 0,
        remindersChanged: 0,
        travelLegsChanged: 0,
        settingsChanged: 0,
        structureChanged: true,
    });
    assert.equal(JSON.stringify(summary).includes("privado"), false);
});

test("el resumen detecta movimientos aunque no cambien los totales", () => {
    const first = { id: "d1", title: "Uno", spots: [{ id: "s1", name: "A" }] };
    const second = { id: "d2", title: "Dos", spots: [] };
    const summary = summarizePlanRevision(
        { tripTitle: "Viaje", days: [first, second], backlog: [] },
        { tripTitle: "Viaje", days: [second, { ...first, spots: [] }], backlog: [{ id: "s1", name: "A" }] },
    );
    assert.equal(summary.daysDelta, 0);
    assert.equal(summary.spotsDelta, 0);
    assert.equal(summary.daysChanged, 2);
    assert.equal(summary.spotsChanged, 1);
    assert.equal(summary.structureChanged, true);
});

test("el resumen detecta sustituciones con la misma cantidad de elementos", () => {
    const summary = summarizePlanRevision(
        { tripTitle: "Viaje", days: [{ id: "antes", spots: [{ id: "vieja" }] }], backlog: [] },
        { tripTitle: "Viaje", days: [{ id: "después", spots: [{ id: "nueva" }] }], backlog: [] },
    );
    assert.equal(summary.daysDelta, 0);
    assert.equal(summary.spotsDelta, 0);
    assert.equal(summary.structureChanged, true);
});

test("el resumen acotado distingue contenido y ajustes sin incluir sus valores", () => {
    const summary = summarizePlanRevision(
        {
            tripTitle: "Viaje", days: [], backlog: [],
            tripNotePages: [{ id: "nota", title: "Secreto", content: "antes" }],
            categories: [{ id: "comida", label: "Privada" }], reminders: [], routeProfile: "walking",
        },
        {
            tripTitle: "Viaje", days: [], backlog: [],
            tripNotePages: [{ id: "nota", title: "Secreto", content: "después" }],
            categories: [{ id: "comida", label: "Muy privada" }],
            reminders: [{ id: "r1", title: "No publicar" }], routeProfile: "driving",
        },
    );
    assert.equal(summary.notePagesChanged, 1);
    assert.equal(summary.categoriesChanged, 1);
    assert.equal(summary.remindersChanged, 1);
    assert.equal(summary.settingsChanged, 1);
    assert.equal(JSON.stringify(summary).includes("Secreto"), false);
    assert.equal(JSON.stringify(summary).includes("No publicar"), false);
});

test("el listado recalcula resúmenes antiguos sin exponer los documentos", async () => {
    const previous = { tripTitle: "Viaje", days: [{ id: "d1", spots: [{ id: "s1", name: "Antes" }] }], backlog: [] };
    const document = { tripTitle: "Viaje", days: [{ id: "d1", spots: [{ id: "s1", name: "Después" }] }], backlog: [] };
    const database = {
        async query(sql) {
            if (sql.includes("SELECT t.owner_id")) {
                return { rowCount: 1, rows: [{ owner_id: "owner", role: "viewer" }] };
            }
            return {
                rowCount: 1,
                rows: [{
                    revision: "2", created_at: new Date().toISOString(), origin: "user",
                    summary: { daysDelta: 0, spotsDelta: 0 }, document,
                    previous_document: previous, actor_user_id: "actor", actor_display_name: "Viajero", current: true,
                }],
            };
        },
    };
    const service = createTripService({ database, config: {}, events: null });
    const result = await service.listRevisions({
        userId: "viewer",
        tripId: "00000000-0000-4000-8000-000000000001",
        before: Number.MAX_SAFE_INTEGER,
        limit: 30,
    });
    assert.equal(result.revisions[0].summary.spotsChanged, 1);
    assert.equal(Object.hasOwn(result.revisions[0], "document"), false);
    assert.equal(Object.hasOwn(result.revisions[0], "previous_document"), false);
});

test("el listado de viajes incluye el autor de la revisión actual", async () => {
    let sql = "";
    const actor = { userId: "actor", displayName: "Ana" };
    const database = {
        async query(text) {
            sql = text;
            return { rows: [{ id: "trip", last_modified_by: actor }], rowCount: 1 };
        },
    };
    const service = createTripService({ database, config: {}, events: null });
    const trips = await service.listTrips({ userId: "viewer", archived: false });
    assert.deepEqual(trips[0].last_modified_by, actor);
    assert.match(sql, /latest_revision\.revision = t\.current_revision/);
    assert.match(sql, /revision_actor\.display_name/);
});

test("Express sirve salud, CORS y errores JSON con el contrato público", async () => {
    const logger = { info() {}, error() {} };
    const database = { health: async () => ({ ok: true }) };
    const app = createApi({ database, config, mailer: {}, logger });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
        const health = await fetch(`${baseUrl}/api/health`, { headers: { origin: config.appOrigin } });
        assert.equal(health.status, 200);
        assert.equal(health.headers.get("access-control-allow-origin"), config.appOrigin);
        assert.deepEqual(await health.json(), {
            ok: true,
            cloudEnabled: false,
            capabilities: {
                liveCollaboration: { enabled: false, protocolVersion: null },
            },
            database: { ok: true, disabled: true },
        });

        const invalid = await fetch(`${baseUrl}/api/auth/register`, {
            method: "POST",
            headers: { origin: config.appOrigin, "content-type": "application/json" },
            body: "{",
        });
        assert.equal(invalid.status, 400);
        assert.equal((await invalid.json()).error.code, "INVALID_JSON");

        const disabled = await fetch(`${baseUrl}/api/session`, { headers: { origin: config.appOrigin } });
        assert.equal(disabled.status, 404);
        assert.equal((await disabled.json()).error.code, "CLOUD_DISABLED");
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("un enlace público con token inválido no llega a la base de datos", async () => {
    let queries = 0;
    const database = { query: async () => { queries += 1; return { rows: [], rowCount: 0 }; } };
    const service = createTripShareService({ database });
    for (const token of ["", "corto", "con espacio", "../../etc", "a".repeat(200)]) {
        await assert.rejects(
            service.readPublicTrip({ token, clientKey: "1.1.1.1" }),
            (error) => error?.code === "SHARE_NOT_FOUND" && error.status === 404,
        );
    }
    assert.equal(queries, 0);
});

test("un token desconocido responde 404 sin distinguir viaje inexistente de enlace revocado", async () => {
    const database = { query: async () => ({ rows: [], rowCount: 0 }) };
    const service = createTripShareService({ database });
    await assert.rejects(
        service.readPublicTrip({ token: "a".repeat(32), clientKey: "1.1.1.1" }),
        (error) => error?.code === "SHARE_NOT_FOUND",
    );
});

test("la lectura pública devuelve el plan sin identificar a la cuenta propietaria", async () => {
    const row = { title: "Japón", document: { tripTitle: "Japón", days: [] }, updated_at: "2026-01-01T00:00:00.000Z", owner_id: "no-debe-salir" };
    const database = { query: async () => ({ rows: [row], rowCount: 1 }) };
    const service = createTripShareService({ database });
    const trip = await service.readPublicTrip({ token: "a".repeat(32), clientKey: "1.1.1.1" });
    assert.deepEqual(Object.keys(trip).sort(), ["document", "title", "updatedAt"]);
});

test("las acciones de compartir rechazan identificadores que no son uuid sin consultar", async () => {
    let queries = 0;
    const database = { query: async () => { queries += 1; return { rows: [], rowCount: 0 }; } };
    const service = createTripShareService({ database });
    for (const action of ["readShare", "share", "unshare"]) {
        await assert.rejects(
            service[action]({ userId: "u", tripId: "no-es-uuid" }),
            (error) => error?.code === "TRIP_NOT_FOUND",
        );
    }
    assert.equal(queries, 0);
});

test("compartir un viaje ajeno responde 404 en lugar de crear el enlace", async () => {
    const database = { query: async () => ({ rows: [], rowCount: 0 }) };
    const service = createTripShareService({ database });
    await assert.rejects(
        service.share({ userId: "otra-cuenta", tripId: "11111111-1111-4111-8111-111111111111" }),
        (error) => error?.code === "TRIP_NOT_FOUND" && error.status === 404,
    );
});
