import test from "node:test";
import assert from "node:assert/strict";

import { liveConnectionPresentation } from "../js/features/cloud/live-connection-presentation.js";

test("hides the live signal for a local-only trip", () => {
    assert.equal(liveConnectionPresentation(null, "open").hidden, true);
});

test("presents an open cloud stream as connected", () => {
    assert.deepEqual(liveConnectionPresentation("remote-1", "open"), {
        hidden: false,
        state: "open",
        label: "En vivo",
        description: "Colaboración en vivo conectada",
        actionLabel: "Pausar la colaboración en vivo",
    });
});

test("falls back to a paused signal for an unknown stream state", () => {
    assert.deepEqual(liveConnectionPresentation("remote-1", "unexpected"), {
        hidden: false,
        state: "closed",
        label: "Desconectado",
        description: "Colaboración en vivo desconectada",
        actionLabel: "Conectar la colaboración en vivo",
    });
});

test("presents a manual pause as an explicit reconnect action", () => {
    assert.deepEqual(liveConnectionPresentation("remote-1", "paused"), {
        hidden: false,
        state: "paused",
        label: "En pausa",
        description: "Colaboración en vivo pausada",
        actionLabel: "Reconectar la colaboración en vivo",
    });
});
