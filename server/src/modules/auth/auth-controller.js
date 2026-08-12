import { ApiError } from "../../http/api-error.js";
import { sendJson } from "../../http/send-json.js";
import { parseCookies, sessionCookie } from "../../security/session-security.js";

function assertOrigin(req, config) {
    if (!req.headers.origin || req.headers.origin !== config.appOrigin) {
        throw new ApiError(403, "INVALID_ORIGIN", "Origen no permitido");
    }
}

function clientIp(req, config) {
    const forwarded = config.trustProxy ? req.headers["x-forwarded-for"] : "";
    return String(forwarded || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
}

function credentials(req) {
    return {
        token: parseCookies(req.headers.cookie).trip_session,
        origin: req.headers.origin,
        csrfToken: req.headers["x-csrf-token"],
    };
}

export function createAuthController({ authService, config }) {
    function sessionResponse(res, created) {
        sendJson(res, 200, {
            user: created.user,
            csrfToken: created.csrfToken,
            expiresAt: created.expiresAt.toISOString(),
        }, { "set-cookie": sessionCookie(created.sessionToken, config) });
    }

    return {
        async register(req, res) {
            assertOrigin(req, config);
            const created = await authService.register({ ...req.body, ip: clientIp(req, config) });
            sessionResponse(res, created);
        },

        async login(req, res) {
            assertOrigin(req, config);
            const created = await authService.login({ ...req.body, ip: clientIp(req, config) });
            sessionResponse(res, created);
        },

        async currentSession(req, res) {
            const token = parseCookies(req.headers.cookie).trip_session;
            sendJson(res, 200, await authService.refreshSession(token));
        },

        async logout(req, res) {
            await authService.logout(credentials(req));
            sendJson(res, 200, { ok: true }, { "set-cookie": sessionCookie("", config, { clear: true }) });
        },
    };
}
