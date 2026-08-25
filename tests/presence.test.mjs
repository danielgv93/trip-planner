import test from "node:test";
import assert from "node:assert/strict";

import {
    applyPresenceLeave,
    applyPresenceUpsert,
    presenceSnapshot,
    presenceTargetKey,
    pruneExpiredPresence,
    PRESENCE_FOCUS_DEBOUNCE_MS,
    PRESENCE_HEARTBEAT_MS,
    REMOTE_HIGHLIGHT_MS,
} from "../js/core/presence.js";

function presence(session, sequence = 1, expiresAt = Date.now() + 45_000) {
    return {
        presenceSessionId: session,
        userId: "same-account",
        displayName: "Ana",
        role: "editor",
        state: "editing",
        target: { type: "spot", id: "spot-a", field: "name" },
        sequence,
        expiresAt: new Date(expiresAt).toISOString(),
    };
}

test("snapshot conserva dos pestañas de la misma cuenta como sesiones distintas", () => {
    const map = presenceSnapshot([presence("tab-a"), presence("tab-b")]);
    assert.equal(map.size, 2);
    assert.equal(presenceTargetKey(map.get("tab-a").target), "spot:spot-a:name");
});

test("deltas monotónicos ignoran heartbeats y salidas obsoletas", () => {
    const map = presenceSnapshot([presence("tab-a", 4)]);
    assert.equal(applyPresenceUpsert(map, presence("tab-a", 3)), false);
    assert.equal(map.get("tab-a").sequence, 4);
    assert.equal(applyPresenceLeave(map, { presenceSessionId: "tab-a", sequence: 4 }), false);
    assert.equal(applyPresenceLeave(map, { presenceSessionId: "tab-a", sequence: 5 }), true);
    assert.equal(map.size, 0);
});

test("expiración local elimina sesiones aunque no llegue pagehide ni leave", () => {
    const now = Date.now();
    const map = presenceSnapshot([
        presence("expired", 1, now + 10),
        presence("active", 1, now + 10_000),
    ], now);
    assert.equal(pruneExpiredPresence(map, now + 20), 1);
    assert.deepEqual([...map.keys()], ["active"]);
});

test("snapshot descarta entradas inválidas o ya caducadas", () => {
    const map = presenceSnapshot([
        presence("expired", 1, Date.now() - 1),
        { ...presence("invalid"), state: "draft-with-content" },
        presence("valid"),
    ]);
    assert.deepEqual([...map.keys()], ["valid"]);
});

test("los tiempos agrupan foco y ráfagas sin acercarse al TTL del servidor", () => {
    assert.ok(PRESENCE_FOCUS_DEBOUNCE_MS < 200);
    assert.ok(REMOTE_HIGHLIGHT_MS > 2_000);
    assert.ok(PRESENCE_HEARTBEAT_MS < 45_000 / 2);
});
