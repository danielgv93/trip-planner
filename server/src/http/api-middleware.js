import { randomUUID } from "node:crypto";
import { ApiError } from "./api-error.js";
import { sendJson } from "./send-json.js";

export function createRequestContext({ config, metrics, logger }) {
    return (req, res, next) => {
        const requestId = req.headers["x-request-id"] || randomUUID();
        const startedAt = Date.now();
        res.setHeader("x-request-id", requestId);
        res.setHeader("cache-control", "no-store");
        if (req.headers.origin === config.appOrigin) {
            res.setHeader("access-control-allow-origin", config.appOrigin);
            res.setHeader("access-control-allow-credentials", "true");
            res.setHeader("vary", "Origin");
        }
        res.once("finish", () => {
            const durationMs = Date.now() - startedAt;
            metrics.observeRequest({ status: res.statusCode, durationMs });
            logger.info(JSON.stringify({
                event: "request",
                requestId,
                method: req.method,
                path: req.path,
                status: res.statusCode,
                durationMs,
            }));
        });
        req.requestId = requestId;
        next();
    };
}

export function createCorsPreflight(config) {
    return (req, res) => {
        assertRequestOrigin(req, config);
        res.status(204).set({
            "access-control-allow-origin": config.appOrigin,
            "access-control-allow-credentials": "true",
            "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
            "access-control-allow-headers": "content-type, x-csrf-token, x-request-id",
            "access-control-max-age": "600",
            vary: "Origin",
        }).end();
    };
}

export function assertRequestOrigin(req, config) {
    if (!req.headers.origin || req.headers.origin !== config.appOrigin) {
        throw new ApiError(403, "INVALID_ORIGIN", "Origen no permitido");
    }
}

export function requireCloud(config) {
    return (req, res, next) => {
        if (!config.cloudEnabled) throw new ApiError(404, "CLOUD_DISABLED", "La nube no está habilitada");
        next();
    };
}

export function routeNotFound() {
    throw new ApiError(404, "NOT_FOUND", "Ruta no encontrada");
}

export function createErrorHandler(logger) {
    return (error, req, res, next) => {
        if (res.headersSent) return next(error);
        let normalized = error;
        if (error?.type === "entity.too.large") {
            normalized = new ApiError(413, "BODY_TOO_LARGE", "Solicitud demasiado grande");
        } else if (error instanceof SyntaxError && error.status === 400 && Object.hasOwn(error, "body")) {
            normalized = new ApiError(400, "INVALID_JSON", "JSON inválido");
        }
        const status = normalized instanceof ApiError ? normalized.status : 500;
        const code = normalized instanceof ApiError ? normalized.code : "INTERNAL_ERROR";
        logger.error(JSON.stringify({ event: "request_error", requestId: req.requestId, status, code, message: normalized.message }));
        sendJson(res, status, {
            error: {
                code,
                message: status === 500 ? "Error interno" : normalized.message,
                details: normalized.details,
            },
        });
    };
}
