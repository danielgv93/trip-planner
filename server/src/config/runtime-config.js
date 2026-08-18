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
        sessionDays: integer(env, "SESSION_DAYS", 30, { max: 90 }),
        trustProxy: truthy.has(String(env.TRUST_PROXY || "false").toLowerCase()),
    };
    if (cloudEnabled && !config.databaseUrl) {
        throw new Error("DATABASE_URL es obligatoria cuando CLOUD_ENABLED=true");
    }
    return Object.freeze(config);
}
