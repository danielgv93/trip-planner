export class UninstrumentedPlanMutationError extends Error {
    constructor() {
        super("Una mutación portable llegó a save() sin descriptor de operación.");
        this.name = "UninstrumentedPlanMutationError";
        this.code = "UNINSTRUMENTED_PLAN_MUTATION";
    }
}

export function mutationInstrumentationMode(globalValue = globalThis) {
    const configured = globalValue?.TRIP_PLANNER_MUTATION_INSTRUMENTATION;
    if (["test", "development", "production"].includes(configured)) return configured;
    if (globalValue?.process?.env?.NODE_ENV === "test") return "test";
    if (globalValue?.process?.env?.NODE_ENV === "development") return "development";
    if (["localhost", "127.0.0.1"].includes(globalValue?.location?.hostname)) return "development";
    return "production";
}

export function createPortableMutationGuard(initialFingerprint, {
    mode = "production",
    allowLegacyFallback = false,
} = {}) {
    let checkpoint = initialFingerprint;
    let currentMode = mode;

    return {
        inspect(fingerprint, { described = false } = {}) {
            const changed = fingerprint !== checkpoint;
            const error = changed && !described ? new UninstrumentedPlanMutationError() : null;
            const legacyFallback = Boolean(error && currentMode === "production" && allowLegacyFallback);
            return {
                changed,
                error,
                legacyFallback,
                shouldThrow: Boolean(error && !legacyFallback),
            };
        },
        checkpoint(fingerprint) {
            checkpoint = fingerprint;
        },
        configure(mode) {
            if (!["test", "development", "production"].includes(mode)) {
                throw new Error("INVALID_MUTATION_INSTRUMENTATION_MODE");
            }
            currentMode = mode;
        },
        mode: () => currentMode,
    };
}
