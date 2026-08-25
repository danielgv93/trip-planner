import test from "node:test";
import assert from "node:assert/strict";

import { createCloudClient } from "../js/features/cloud/client.js";

test("el cliente publica, activa y recupera operaciones por las rutas versionadas", async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };
    try {
        const client = createCloudClient({ baseUrl: "https://api.example", csrfToken: () => "csrf" });
        await client.activateTripOperations("trip/id", { expectedRevision: 2, legacyOutboxEmpty: true });
        await client.mutateTripOperation("trip/id", { kind: "set-field" });
        await client.catchUpTripOperations("trip/id", { after: 2, limit: 50 });
        await client.getTripPresence("trip/id");
        await client.upsertTripPresence("trip/id", "session/id", { sequence: 1, state: "viewing" });
        await client.leaveTripPresence("trip/id", "session/id", 2, { keepalive: true });
        assert.deepEqual(calls.map((call) => [call.options.method, call.url]), [
            ["POST", "https://api.example/api/v1/trips/trip%2Fid/operations/activate"],
            ["POST", "https://api.example/api/v1/trips/trip%2Fid/operations"],
            ["GET", "https://api.example/api/v1/trips/trip%2Fid/operations?after=2&limit=50"],
            ["GET", "https://api.example/api/v1/trips/trip%2Fid/presence"],
            ["PUT", "https://api.example/api/v1/trips/trip%2Fid/presence/session%2Fid"],
            ["DELETE", "https://api.example/api/v1/trips/trip%2Fid/presence/session%2Fid"],
        ]);
        assert.equal(calls[0].options.headers["x-csrf-token"], "csrf");
        assert.equal(calls.at(-1).options.keepalive, true);
        assert.deepEqual(JSON.parse(calls.at(-1).options.body), { sequence: 2 });
    } finally {
        globalThis.fetch = originalFetch;
    }
});
