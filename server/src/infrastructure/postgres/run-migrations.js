import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "../../config/runtime-config.js";
import { createDatabase } from "./database.js";

export async function migrate(database, migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../migrations")) {
    await database.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
    for (const name of files) {
        const applied = await database.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
        if (applied.rowCount) continue;
        const client = await database.connect();
        try {
            await client.query("BEGIN");
            await client.query(await readFile(join(migrationsDir, name), "utf8"));
            await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [name]);
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const config = loadConfig();
    const database = await createDatabase(config);
    try {
        await migrate(database);
        console.log("Migraciones aplicadas.");
    } finally {
        await database.close();
    }
}
