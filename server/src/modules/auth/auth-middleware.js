import { parseCookies } from "../../security/session-security.js";

export function createAuthenticationMiddleware(authService) {
    return async (req, res, next) => {
        const token = parseCookies(req.headers.cookie).trip_session;
        res.locals.activeSession = req.method === "GET"
            ? await authService.readSession(token)
            : await authService.authorizeMutation({
                token,
                origin: req.headers.origin,
                csrfToken: req.headers["x-csrf-token"],
            });
        next();
    };
}
