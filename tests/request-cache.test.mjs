import test from "node:test";
import assert from "node:assert/strict";

import { createRequestCache } from "../js/shared/request-cache.js";

test("getOrLoad reutiliza valores y deduplica cargas simultáneas", async () => {
    const cache = createRequestCache();
    let loads = 0;
    let resolveLoad;
    const load = () => {
        loads += 1;
        return new Promise((resolve) => {
            resolveLoad = resolve;
        });
    };

    const first = cache.getOrLoad("same", load);
    const second = cache.getOrLoad("same", load);
    await Promise.resolve();
    assert.equal(loads, 1);
    assert.equal(first, second);

    resolveLoad({ ok: true });
    assert.deepEqual(await first, { ok: true });
    assert.deepEqual(await cache.getOrLoad("same", load), { ok: true });
    assert.equal(loads, 1);
});

test("una carga rechazada se puede reintentar y no queda cacheada", async () => {
    const cache = createRequestCache();
    let loads = 0;
    const load = async () => {
        loads += 1;
        if (loads === 1) throw new Error("temporary");
        return "recovered";
    };

    await assert.rejects(cache.getOrLoad("retry", load), /temporary/);
    assert.equal(cache.has("retry"), false);
    assert.equal(await cache.getOrLoad("retry", load), "recovered");
    assert.equal(loads, 2);
});

test("delete y clear invalidan valores sin depender de persistencia", () => {
    const cache = createRequestCache();
    cache.set("one", 1).set("two", 2);
    assert.equal(cache.size, 2);
    assert.equal(cache.delete("one"), true);
    assert.equal(cache.has("one"), false);
    cache.clear();
    assert.equal(cache.size, 0);
});
