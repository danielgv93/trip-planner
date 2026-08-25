import { sendJson } from "../../http/send-json.js";

export function createTripPresenceController(service) {
    return {
        async snapshot(req, res) {
            sendJson(res, 200, await service.snapshot({
                userId: res.locals.activeSession.user_id,
                tripId: req.params.tripId,
            }));
        },
        async upsert(req, res) {
            sendJson(res, 200, await service.upsert({
                active: res.locals.activeSession,
                tripId: req.params.tripId,
                presenceSessionId: req.params.presenceSessionId,
                input: req.body || {},
            }));
        },
        async leave(req, res) {
            sendJson(res, 200, await service.leave({
                active: res.locals.activeSession,
                tripId: req.params.tripId,
                presenceSessionId: req.params.presenceSessionId,
                input: req.body || {},
            }));
        },
    };
}
