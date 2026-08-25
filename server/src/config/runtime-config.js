const truthy = new Set(["1", "true", "yes", "on"]);

function integer(env, key, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`Configuración inválida: ${key}`);
    }
    return value;
}

function origin(value) {
    try {
        return new URL(value).origin;
    } catch {
        throw new Error("Configuración inválida: APP_ORIGIN");
    }
}

export function loadConfig(env = process.env) {
    const nodeEnv = env.NODE_ENV || "development";
    const cloudEnabled = truthy.has(String(env.CLOUD_ENABLED || "false").toLowerCase());
    const config = {
        nodeEnv,
        production: nodeEnv === "production",
        cloudEnabled,
        granularSyncEnabled:
            cloudEnabled && truthy.has(String(env.GRANULAR_SYNC_ENABLED || "false").toLowerCase()),
        granularProtocolVersion: 1,
        port: integer(env, "PORT", 8787, { max: 65535 }),
        host: env.HOST || "127.0.0.1",
        appOrigin: origin(env.APP_ORIGIN || "http://localhost:8000"),
        databaseUrl: env.DATABASE_URL || "",
        databasePoolMax: integer(env, "DATABASE_POOL_MAX", 10, { max: 50 }),
        databaseIdleTimeoutMs: integer(env, "DATABASE_IDLE_TIMEOUT_MS", 30_000),
        databaseConnectionTimeoutMs: integer(env, "DATABASE_CONNECTION_TIMEOUT_MS", 5_000),
        statementTimeoutMs: integer(env, "DATABASE_STATEMENT_TIMEOUT_MS", 10_000),
        databaseSsl:
            env.DATABASE_SSL === undefined
                ? nodeEnv === "production"
                : truthy.has(String(env.DATABASE_SSL).toLowerCase()),
        bodyLimitBytes: integer(env, "BODY_LIMIT_BYTES", 1_048_576),
        operationBodyLimitBytes: integer(env, "OPERATION_BODY_LIMIT_BYTES", 65_536, { max: 262_144 }),
        operationCatchupLimit: integer(env, "OPERATION_CATCHUP_LIMIT", 100, { max: 500 }),
        operationRateLimit: integer(env, "OPERATION_RATE_LIMIT", 240, { min: 20, max: 5_000 }),
        operationRateWindowMs: integer(env, "OPERATION_RATE_WINDOW_MS", 60_000, { min: 10_000, max: 600_000 }),
        presenceTtlMs: integer(env, "PRESENCE_TTL_MS", 45_000, { min: 15_000, max: 120_000 }),
        presenceRateLimit: integer(env, "PRESENCE_RATE_LIMIT", 120, { min: 10, max: 2_000 }),
        presenceRateWindowMs: integer(env, "PRESENCE_RATE_WINDOW_MS", 60_000, { min: 10_000, max: 600_000 }),
        presenceCleanupLimit: integer(env, "PRESENCE_CLEANUP_LIMIT", 500, { min: 10, max: 5_000 }),
        sessionDays: integer(env, "SESSION_DAYS", 30, { max: 90 }),
        trustProxy: truthy.has(String(env.TRUST_PROXY || "false").toLowerCase()),
    };
    if (cloudEnabled && !config.databaseUrl) {
        throw new Error("DATABASE_URL es obligatoria cuando CLOUD_ENABLED=true");
    }
    return Object.freeze(config);
}
