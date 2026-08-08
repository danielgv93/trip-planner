const CACHE_VERSION = 1;

function availableStorage() {
    if (typeof window === "undefined") return null;
    try {
        return window.localStorage || null;
    } catch {
        return null;
    }
}

// Reusable cache for asynchronous request-like work. It always caches resolved
// values in memory and can optionally persist selected values in Web Storage.
// Concurrent loads for the same key share a single promise.
export function createRequestCache({
    storageKey = null,
    storage = availableStorage(),
    now = () => Date.now(),
    ttlMs = Infinity,
    maxEntries = Infinity,
    maxBytes = Infinity,
    shouldPersist = () => true,
} = {}) {
    const memory = new Map();
    const savedAt = new Map();
    const requests = new Map();
    let generation = 0;

    function removeStoredValue() {
        if (!storageKey) return;
        try {
            storage?.removeItem(storageKey);
        } catch {
            // Storage is an optional optimization and must never break callers.
        }
    }

    function serializedPayload() {
        const candidates = [...savedAt]
            .filter(([key, timestamp]) => {
                const value = memory.get(key);
                return (
                    typeof key === "string" &&
                    Number.isFinite(timestamp) &&
                    now() - timestamp <= ttlMs &&
                    shouldPersist(value)
                );
            })
            .sort((a, b) => b[1] - a[1])
            .slice(0, maxEntries);
        const entries = [];
        for (const [key, timestamp] of candidates) {
            const candidate = JSON.stringify({
                version: CACHE_VERSION,
                entries: [...entries, [key, timestamp, memory.get(key)]],
            });
            if (candidate.length > maxBytes) continue;
            entries.push([key, timestamp, memory.get(key)]);
        }
        return JSON.stringify({ version: CACHE_VERSION, entries });
    }

    function persist() {
        if (!storage || !storageKey) return;
        try {
            storage.setItem(storageKey, serializedPayload());
        } catch {
            // Quota and security failures leave the in-memory cache operational.
        }
    }

    function hydrate() {
        if (!storage || !storageKey) return;
        let raw;
        try {
            raw = storage.getItem(storageKey);
        } catch {
            return;
        }
        if (!raw) return;
        try {
            const parsed = JSON.parse(raw);
            if (parsed?.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) {
                removeStoredValue();
                return;
            }
            const cutoff = now() - ttlMs;
            for (const entry of parsed.entries.slice(0, maxEntries)) {
                if (!Array.isArray(entry) || entry.length !== 3) continue;
                const [key, timestamp, value] = entry;
                if (
                    typeof key !== "string" ||
                    !Number.isFinite(timestamp) ||
                    timestamp < cutoff ||
                    !shouldPersist(value)
                )
                    continue;
                memory.set(key, value);
                savedAt.set(key, timestamp);
            }
            if (savedAt.size !== parsed.entries.length) persist();
        } catch {
            removeStoredValue();
        }
    }

    const api = {
        get size() {
            return memory.size;
        },
        get(key) {
            return memory.get(key);
        },
        has(key) {
            return memory.has(key);
        },
        set(key, value) {
            memory.set(key, value);
            if (storageKey && shouldPersist(value)) {
                savedAt.set(key, now());
                persist();
            } else if (savedAt.delete(key)) {
                persist();
            }
            return api;
        },
        getOrLoad(key, load) {
            if (memory.has(key)) return Promise.resolve(memory.get(key));
            if (requests.has(key)) return requests.get(key);
            const requestGeneration = generation;
            const request = Promise.resolve()
                .then(() => load())
                .then((value) => {
                    if (requestGeneration === generation) api.set(key, value);
                    return value;
                })
                .finally(() => {
                    if (requests.get(key) === request) requests.delete(key);
                });
            requests.set(key, request);
            return request;
        },
        delete(key) {
            const removed = memory.delete(key);
            if (savedAt.delete(key)) persist();
            return removed;
        },
        clear() {
            generation += 1;
            memory.clear();
            savedAt.clear();
            requests.clear();
            removeStoredValue();
        },
    };

    hydrate();
    return api;
}
