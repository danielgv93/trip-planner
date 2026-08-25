import test from "node:test";
import assert from "node:assert/strict";

import {
    createPortableMutationGuard,
    mutationInstrumentationMode,
} from "../js/core/mutation-instrumentation.js";

test("test y desarrollo fallan ante una mutación portable sin descriptor", () => {
    for (const mode of ["test", "development"]) {
        const guard = createPortableMutationGuard("antes", { mode });
        const result = guard.inspect("después");
        assert.equal(result.error.code, "UNINSTRUMENTED_PLAN_MUTATION");
        assert.equal(result.shouldThrow, true);
        assert.equal(result.legacyFallback, false);
    }
});

test("producción identifica el fallback legacy y un descriptor lo evita", () => {
    const guard = createPortableMutationGuard("antes", { mode: "production", allowLegacyFallback: true });
    assert.equal(guard.inspect("después").legacyFallback, true);
    assert.equal(guard.inspect("después", { described: true }).error, null);
    guard.checkpoint("después");
    assert.equal(guard.inspect("después").changed, false);
});

test("al cerrar el inventario producción también bloquea el fallback", () => {
    const guard = createPortableMutationGuard("antes", { mode: "production", allowLegacyFallback: false });
    const result = guard.inspect("después");
    assert.equal(result.legacyFallback, false);
    assert.equal(result.shouldThrow, true);
});

test("el entorno permite configuración explícita y reconoce localhost", () => {
    assert.equal(mutationInstrumentationMode({ TRIP_PLANNER_MUTATION_INSTRUMENTATION: "test" }), "test");
    assert.equal(mutationInstrumentationMode({ location: { hostname: "localhost" } }), "development");
    assert.equal(mutationInstrumentationMode({ location: { hostname: "planner.example" } }), "production");
});
