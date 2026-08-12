import { createApi } from "./api/create-api.js";
import { loadConfig } from "./config/runtime-config.js";
import { createDatabase } from "./infrastructure/postgres/database.js";

const config = loadConfig();
const database = config.cloudEnabled
    ? await createDatabase(config)
    : {
          health: async () => ({ ok: true, disabled: true }),
          query: async () => { throw new Error("Cloud deshabilitada"); },
          connect: async () => { throw new Error("Cloud deshabilitada"); },
          close: async () => {},
      };
const app = createApi({ database, config });

const server = app.listen(config.port, config.host, () => {
    console.log(JSON.stringify({ event: "server_started", host: config.host, port: config.port, cloudEnabled: config.cloudEnabled }));
});

let closing = false;
async function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(JSON.stringify({ event: "server_stopping", signal }));
    server.close(async () => {
        await database.close();
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
