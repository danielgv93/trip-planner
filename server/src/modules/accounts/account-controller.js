import { sendJson } from "../../http/send-json.js";
import { sessionCookie } from "../../security/session-security.js";

export function createAccountController({ accountService, config }) {
    return {
        async exportAccount(req, res) {
            sendJson(res, 200, await accountService.exportAccount(res.locals.activeSession));
        },
        async updateProfile(req, res) {
            sendJson(res, 200, { user: await accountService.updateProfile(res.locals.activeSession, req.body) });
        },
        async changePassword(req, res) {
            await accountService.changePassword(res.locals.activeSession, req.body);
            sendJson(res, 200, { ok: true });
        },
        async deleteAccount(req, res) {
            await accountService.deleteAccount(res.locals.activeSession, req.body?.password);
            sendJson(res, 200, { ok: true }, { "set-cookie": sessionCookie("", config, { clear: true }) });
        },
    };
}
