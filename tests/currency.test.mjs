import test from "node:test";
import assert from "node:assert/strict";
import { portablePlanFrom } from "../js/core/portable-plan.js";

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { store, applyPortablePlanState, registerTripCommitter } = await import("../js/core/store.js");
const { refreshExchangeRate } = await import("../js/features/finance/currency.js");

let commits = 0;
registerTripCommitter(() => { commits += 1; });

test("actualizar el cambio funciona en lectura y no persiste una operación", async () => {
    store.foreignCurrency = "JPY";
    store.localCurrency = "EUR";
    store.readOnly = true;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ rates: { EUR: 0.006 }, date: "2026-09-30" }) });
    try {
        assert.equal(await refreshExchangeRate(), true);
        assert.equal(store.exchangeRate, 0.006);
        assert.equal(store.exchangeRateDate, "2026-09-30");
        assert.equal(commits, 0);
        applyPortablePlanState(portablePlanFrom(store));
        assert.equal(store.exchangeRate, 0.006);
        applyPortablePlanState({ ...portablePlanFrom(store), foreignCurrency: "USD" });
        assert.equal(store.exchangeRate, null);
        assert.equal(store.exchangeRateDate, "");
        store.localCurrency = "USD";
        assert.equal(await refreshExchangeRate(), true);
        assert.equal(store.exchangeRate, 1);
        assert.equal(commits, 0);
    } finally {
        globalThis.fetch = originalFetch;
        store.readOnly = false;
    }
});

test("una respuesta tardía no aplica el cambio de otras monedas", async () => {
    store.foreignCurrency = "JPY";
    store.localCurrency = "EUR";
    store.exchangeRate = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        store.foreignCurrency = "USD";
        return { ok: true, json: async () => ({ rates: { EUR: 0.006 } }) };
    };
    try {
        assert.equal(await refreshExchangeRate(), false);
        assert.equal(store.exchangeRate, null);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
