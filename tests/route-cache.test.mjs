import test from "node:test";
import assert from "node:assert/strict";

import {
    createRouteCache,
    ROUTE_CACHE_STORAGE_KEY,
} from "../js/features/map/route-cache.js";

class MemoryStorage {
    values = new Map();

    getItem(key) {
        return this.values.get(key) ?? null;
    }

    setItem(key, value) {
        this.values.set(key, String(value));
    }

    removeItem(key) {
        this.values.delete(key);
    }
}

const officialLeg = {
    km: 2.4,
    min: 18,
    approx: false,
    points: [
        [40.4168, -3.7038],
        [40.42, -3.69],
    ],
};

test("persiste respuestas oficiales de OSRM entre instancias", () => {
    const storage = new MemoryStorage();
    const first = createRouteCache({ storage, now: () => 1_000 });
    first.set("madrid|retiro|walking", officialLeg);

    const restored = createRouteCache({ storage, now: () => 2_000 });
    assert.deepEqual(restored.get("madrid|retiro|walking"), officialLeg);
});

test("no persiste aproximaciones producidas por fallos de red", () => {
    const storage = new MemoryStorage();
    const cache = createRouteCache({ storage, now: () => 1_000 });
    cache.set("offline", { km: 2, min: null, approx: true });

    assert.equal(cache.has("offline"), true);
    assert.equal(
        createRouteCache({ storage, now: () => 2_000 }).has("offline"),
        false,
    );
});

test("descarta rutas caducadas y documentos de caché inválidos", () => {
    const storage = new MemoryStorage();
    const cache = createRouteCache({
        storage,
        now: () => 1_000,
        ttlMs: 100,
    });
    cache.set("expired", officialLeg);

    const expired = createRouteCache({
        storage,
        now: () => 1_101,
        ttlMs: 100,
    });
    assert.equal(expired.has("expired"), false);

    storage.setItem(ROUTE_CACHE_STORAGE_KEY, "{not json");
    const invalid = createRouteCache({ storage });
    assert.equal(invalid.has("expired"), false);
    assert.equal(storage.getItem(ROUTE_CACHE_STORAGE_KEY), null);
});

test("respeta el límite de entradas persistidas conservando las recientes", () => {
    const storage = new MemoryStorage();
    let timestamp = 0;
    const cache = createRouteCache({
        storage,
        now: () => ++timestamp,
        maxEntries: 2,
    });
    cache.set("one", officialLeg);
    cache.set("two", officialLeg);
    cache.set("three", officialLeg);

    const restored = createRouteCache({
        storage,
        now: () => timestamp,
        maxEntries: 2,
    });
    assert.equal(restored.has("one"), false);
    assert.equal(restored.has("two"), true);
    assert.equal(restored.has("three"), true);
});
