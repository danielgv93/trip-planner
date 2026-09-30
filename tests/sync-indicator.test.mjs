import test from "node:test";
import assert from "node:assert/strict";
import { syncIndicator } from "../js/features/cloud/sync-state.js";

test("syncIndicator maps persistence state to one glanceable category", () => {
    const cases = [
        [{}, "local"],
        [{ state: "saved" }, "local"],
        [{ state: "saving", hasRemote: true }, "saving"],
        [{ state: "synced", hasRemote: true }, "synced"],
        [{ state: "synced", hasRemote: true, liveConnection: "open" }, "live"],
        [{ state: "synced", hasRemote: true, liveConnection: "paused" }, "synced"],
        [{ state: "synced", hasRemote: true, liveConnection: "reconnecting" }, "pending"],
        [{ state: "synced", hasRemote: true, liveConnection: "open", livePullError: true }, "pending"],
        [{ state: "pending", hasRemote: true, liveConnection: "open" }, "pending"],
        [{ state: "offline" }, "pending"],
        [{ state: "error" }, "attention"],
        [{ state: "conflict", hasRemote: true }, "attention"],
        [{ state: "auth-required", hasRemote: true }, "attention"],
    ];
    for (const [input, expected] of cases) {
        const result = syncIndicator(input);
        assert.equal(result.state, expected, JSON.stringify(input));
        assert.match(result.label, /^Guardado: /);
    }
});
