import test from "node:test";
import assert from "node:assert/strict";

import { publicShareToken, publicShareUrl, SHARE_PARAM } from "../js/features/share/share-url.js";

test("el token de compartir se lee del parámetro de consulta y se limpia", () => {
    assert.equal(SHARE_PARAM, "viaje");
    assert.equal(publicShareToken("?viaje=abc123"), "abc123");
    assert.equal(publicShareToken("?viaje=%20abc123%20"), "abc123");
    assert.equal(publicShareToken("?viaje="), null);
    assert.equal(publicShareToken("?viaje=%20%20"), null);
    assert.equal(publicShareToken("?otra=abc123"), null);
    assert.equal(publicShareToken(""), null);
});

test("el enlace público conserva el origen y la ruta de la aplicación", () => {
    assert.equal(
        publicShareUrl("abc123", { origin: "https://viajes.example", pathname: "/" }),
        "https://viajes.example/?viaje=abc123",
    );
    assert.equal(
        publicShareUrl("abc123", { origin: "https://viajes.example", pathname: "/index.html" }),
        "https://viajes.example/index.html?viaje=abc123",
    );
});

test("el enlace descarta la consulta anterior en lugar de acumular tokens", () => {
    const url = publicShareUrl("nuevo", { origin: "https://viajes.example", pathname: "/" });
    assert.equal(publicShareToken(new URL(url).search), "nuevo");
    assert.equal(new URL(url).searchParams.getAll(SHARE_PARAM).length, 1);
});
