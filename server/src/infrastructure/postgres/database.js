export async function createDatabase(config) {
    const { Pool } = await import("pg");
    const pool = new Pool({
        connectionString: config.databaseUrl,
        max: config.databasePoolMax,
        idleTimeoutMillis: config.databaseIdleTimeoutMs,
        connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
        statement_timeout: config.statementTimeoutMs,
        application_name: "trip-planner-api",
        ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
    });
    pool.on("error", (error) => {
        console.error(JSON.stringify({ event: "database_pool_error", message: error.message }));
    });
    return {
        query: (text, values) => pool.query(text, values),
        connect: () => pool.connect(),
        async health() {
            const startedAt = Date.now();
            await pool.query("SELECT 1");
            return { ok: true, latencyMs: Date.now() - startedAt };
        },
        close: () => pool.end(),
    };
}
