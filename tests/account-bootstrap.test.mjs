import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("la cuenta empieza comprobando la sesión sin mostrar un inicio de sesión falso", async () => {
    const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
    const accountButton = html.split("\n").find((line) => line.includes('id="accountBtn"'));

    assert.ok(accountButton);
    assert.match(accountButton, /data-session="checking"/);
    assert.match(accountButton, /aria-busy="true"/);
    assert.match(accountButton, /disabled/);
    assert.doesNotMatch(accountButton, />Iniciar sesión</);
});
