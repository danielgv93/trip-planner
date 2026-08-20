import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createApi } from "../src/api/create-api.js";
import { loadConfig } from "../src/config/runtime-config.js";
import { summarizePlanRevision, validatePlanDocument } from "../src/domain/plan-document.js";
import { AVATAR_MAX_BYTES, createAccountService } from "../src/modules/accounts/account-service.js";
import { createTripShareService } from "../src/modules/trips/trip-share-service.js";
import { passwordHash, SlidingWindowLimiter, secretHash, safeEqualHash, sessionCookie, verifyPassword } from "../src/security/session-security.js";

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
    assert.throws(() => loadConfig({ CLOUD_ENABLED: "true" }), /DATABASE_URL/);
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
    assert.deepEqual(summary, { titleChanged: true, daysDelta: 0, spotsDelta: 1 });
    assert.equal(JSON.stringify(summary).includes("privado"), false);
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
