import { createApi } from "./api/create-api.js";
import { loadConfig } from "./config/runtime-config.js";
import { createDatabase } from "./infrastructure/postgres/database.js";
import { migrate } from "./infrastructure/postgres/run-migrations.js";
import { createMemoryTripEventBus, createPostgresTripEventBus } from "./realtime/trip-events.js";

const config = loadConfig();
let database;
if (config.cloudEnabled) {
    database = await createDatabase(config);
    try {
        await migrate(database);
        console.log(JSON.stringify({ event: "database_migrations_applied" }));
    } catch (error) {
        await database.close();
        throw error;
    }
} else {
    database = {
        health: async () => ({ ok: true, disabled: true }),
        query: async () => { throw new Error("Cloud deshabilitada"); },
        connect: async () => { throw new Error("Cloud deshabilitada"); },
        close: async () => {},
    };
}
const events = config.cloudEnabled
    ? createPostgresTripEventBus({ database, logger: console })
    : createMemoryTripEventBus();
if (config.cloudEnabled) await events.start();
const app = createApi({ database, config, events });

const server = app.listen(config.port, config.host, () => {
    console.log(JSON.stringify({ event: "server_started", host: config.host, port: config.port, cloudEnabled: config.cloudEnabled }));
});

let closing = false;
async function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(JSON.stringify({ event: "server_stopping", signal }));
    server.close(async () => {
        await events.close();
        await database.close();
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
