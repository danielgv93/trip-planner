import test from "node:test";
import assert from "node:assert/strict";

import {
    normalizeGithubTarget,
    utf8ToBase64,
} from "../js/features/github/github-api.js";

test("los destinos de GitHub se normalizan sin aceptar rutas ambiguas", () => {
    assert.deepEqual(
        normalizeGithubTarget({ owner: "openai", repo: "codex.git", ref: "main", path: "plans/trip.json" }),
        { owner: "openai", repo: "codex", ref: "main", path: "plans/trip.json" },
    );
    assert.throws(
        () => normalizeGithubTarget({ owner: "openai", repo: "codex", ref: "main", path: "../trip.json" }),
        /INVALID_PATH/,
    );
});

test("la codificación de publicación conserva UTF-8", () => {
    const encoded = utf8ToBase64("Viaje a Japón 🗺️");
    assert.equal(Buffer.from(encoded, "base64").toString("utf8"), "Viaje a Japón 🗺️");
});
