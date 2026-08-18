import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { cloudClientConfig } from "../js/features/cloud/config.js";

function withCloudEnvironment({ configured = {}, apiBase = "" }, callback) {
    const previousDocument = globalThis.document;
    const previousConfig = globalThis.TRIP_PLANNER_CLOUD;
    globalThis.TRIP_PLANNER_CLOUD = configured;
    globalThis.document = {
        querySelector: () => ({ dataset: { apiBase } }),
    };
    try {
        callback();
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
        if (previousConfig === undefined) delete globalThis.TRIP_PLANNER_CLOUD;
        else globalThis.TRIP_PLANNER_CLOUD = previousConfig;
    }
}

test("cloud usa el mismo origen sin depender de un flag de visibilidad", () => {
    withCloudEnvironment({}, () => {
        assert.deepEqual(cloudClientConfig(), { baseUrl: "", timeoutMs: 12_000 });
        assert.equal(Object.hasOwn(cloudClientConfig(), "enabled"), false);
    });
});

test("cloud admite una URL alternativa y la configuración global prevalece", () => {
    withCloudEnvironment({ apiBase: "http://meta.test" }, () => {
        assert.equal(cloudClientConfig().baseUrl, "http://meta.test");
    });
    withCloudEnvironment({ configured: { baseUrl: "http://runtime.test", timeoutMs: 2500 }, apiBase: "http://meta.test" }, () => {
        assert.deepEqual(cloudClientConfig(), { baseUrl: "http://runtime.test", timeoutMs: 2500 });
    });
});

test("el desarrollo local dirige la API al puerto 8787", async () => {
    const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
    assert.match(html, /name="trip-planner-cloud"[^>]+data-api-base="http:\/\/localhost:8787"/);
});
