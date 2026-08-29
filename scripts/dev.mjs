import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, request as apiRequest } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverDirectory = join(root, "server");
const envFile = join(root, ".env");

const mimeTypes = new Map([
    [".css", "text/css; charset=utf-8"],
    [".html", "text/html; charset=utf-8"],
    [".ico", "image/x-icon"],
    [".jpeg", "image/jpeg"],
    [".jpg", "image/jpeg"],
    [".js", "text/javascript; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".png", "image/png"],
    [".svg", "image/svg+xml"],
    [".webp", "image/webp"],
]);

function envValue(name) {
    if (process.env[name]) return process.env[name];
    if (!existsSync(envFile)) return "";
    const line = readFileSync(envFile, "utf8")
        .split(/\r?\n/)
        .find((candidate) => candidate.match(/^\s*([^#=]+)=/)?.[1].trim() === name);
    if (!line) return "";
    return line.slice(line.indexOf("=") + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
}

function run(command, args, options = {}) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, { stdio: "inherit", ...options });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0) resolvePromise();
            else reject(new Error(`${command} terminó con ${signal || `código ${code}`}`));
        });
    });
}

function publicFile(pathname) {
    const decoded = decodeURIComponent(pathname);
    if (decoded === "/" || decoded === "/index.html") return join(root, "index.html");
    if (!/^\/(icons|js|styles)\//.test(decoded)) return null;

    const candidate = resolve(root, `.${normalize(decoded)}`);
    if (!candidate.startsWith(`${root}${sep}`)) return null;
    return candidate;
}

// The frontend always talks to its own origin, exactly as nginx does in the
// Docker stack, so the API needs no published port and no cross-origin request.
function proxyApi(request, response, apiPort) {
    const upstream = apiRequest({
        host: "127.0.0.1",
        port: apiPort,
        path: request.url,
        method: request.method,
        headers: request.headers,
    }, (apiResponse) => {
        response.writeHead(apiResponse.statusCode || 502, apiResponse.headers);
        // The collaboration stream is server-sent events: flush every chunk
        // instead of letting Nagle hold it back until the buffer fills.
        response.flushHeaders();
        response.socket?.setNoDelay(true);
        apiResponse.pipe(response);
    });

    upstream.setNoDelay(true);
    upstream.once("error", () => {
        if (!response.headersSent) {
            response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        }
        response.end("La API no está disponible");
    });
    response.once("close", () => upstream.destroy());
    request.pipe(upstream);
}

function startFrontend(port, apiPort) {
    const server = createServer((request, response) => {
        if (request.url?.startsWith("/api/")) {
            proxyApi(request, response, apiPort);
            return;
        }

        if (!request.url || !["GET", "HEAD"].includes(request.method || "")) {
            response.writeHead(405, { allow: "GET, HEAD" }).end();
            return;
        }

        let filename;
        try {
            filename = publicFile(new URL(request.url, "http://localhost").pathname);
        } catch {
            response.writeHead(400).end("Solicitud inválida");
            return;
        }

        try {
            if (!filename || !statSync(filename).isFile()) throw new Error("not found");
        } catch {
            response.writeHead(404).end("No encontrado");
            return;
        }

        response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": mimeTypes.get(extname(filename).toLowerCase()) || "application/octet-stream",
        });
        if (request.method === "HEAD") response.end();
        else createReadStream(filename).pipe(response);
    });

    return new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolvePromise(server));
    });
}

async function main() {
    if (!existsSync(envFile)) {
        throw new Error("Falta .env. Créalo primero con: cp .env.example .env");
    }
    if (!existsSync(join(serverDirectory, "node_modules"))) {
        throw new Error("Faltan las dependencias de la API. Ejecuta: npm install --prefix server");
    }

    const frontendPort = Number(envValue("FRONTEND_PORT") || 8000);
    if (!Number.isInteger(frontendPort) || frontendPort < 1 || frontendPort > 65_535) {
        throw new Error("FRONTEND_PORT debe ser un puerto válido");
    }

    const apiPort = Number(envValue("PORT") || 8787);
    if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65_535) {
        throw new Error("PORT debe ser un puerto válido");
    }

    console.log("Iniciando PostgreSQL…");
    // Only this flow needs PostgreSQL published on the host, so the database
    // port lives in the development overlay instead of the base stack.
    await run("docker", [
        "compose",
        "-f",
        "docker-compose.yaml",
        "-f",
        "docker-compose.dev.yaml",
        "up",
        "-d",
        "--wait",
        "db",
    ], { cwd: root });

    const frontend = await startFrontend(frontendPort, apiPort);
    const api = spawn(process.execPath, [
        "--watch",
        "--watch-preserve-output",
        "--env-file=../.env",
        "src/server.js",
    ], {
        cwd: serverDirectory,
        stdio: "inherit",
    });

    console.log(`Frontend: http://localhost:${frontendPort}`);
    console.log(`API:      http://localhost:${frontendPort}/api (proxy a 127.0.0.1:${apiPort})`);
    console.log("PostgreSQL está en Docker. Pulsa Ctrl+C para detener frontend y API.");

    let shuttingDown = false;
    const shutdown = (signal = "SIGTERM", exitCode = 0) => {
        if (shuttingDown) return;
        shuttingDown = true;
        frontend.close();
        if (!api.killed) api.kill(signal);
        process.exitCode = exitCode;
    };

    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    api.once("error", (error) => {
        console.error(`No se pudo iniciar la API: ${error.message}`);
        shutdown("SIGTERM", 1);
    });
    api.once("exit", (code, signal) => {
        if (!shuttingDown) {
            console.error(`La API terminó inesperadamente (${signal || `código ${code}`}).`);
            shutdown("SIGTERM", code || 1);
        }
    });
}

main().catch((error) => {
    console.error(`Error de desarrollo: ${error.message}`);
    process.exitCode = 1;
});
