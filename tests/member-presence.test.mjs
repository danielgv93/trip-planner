import test from "node:test";
import assert from "node:assert/strict";
import { memberPresenceState } from "../js/features/cloud/member-presence.js";

const now = Date.parse("2026-09-30T12:00:00Z");
const connected = { connectionState: "open", liveState: "open", now };
const session = (userId, expiresAt) => ({ userId, expiresAt });

test("un usuario sigue en línea mientras conserve alguna sesión vigente", () => {
    const sessions = new Map([
        ["expired", session("karla", "2026-09-30T11:59:00Z")],
        ["active", session("karla", "2026-09-30T12:01:00Z")],
    ]);
    assert.equal(memberPresenceState("karla", { ...connected, sessions }), "online");
    sessions.delete("active");
    assert.equal(memberPresenceState("karla", { ...connected, sessions }), "offline");
    assert.equal(memberPresenceState("daniel", { ...connected, sessions }), "offline");
});

test("la sesión propia confirmada aparece en línea aunque no haya recibido su eco", () => {
    assert.equal(memberPresenceState("karla", { ...connected, currentUserId: "karla" }), "online");
});

test("una conexión perdida, pausada o no disponible no afirma que alguien esté desconectado", () => {
    const sessions = new Map([["active", session("karla", "2026-09-30T12:01:00Z")]]);
    for (const change of [{ online: false }, { connectionState: "unavailable" }, { liveState: "reconnecting" }, { liveState: "paused" }]) {
        assert.equal(memberPresenceState("karla", { ...connected, sessions, ...change }), "unknown");
    }
    assert.equal(memberPresenceState("karla"), "unknown");
});
