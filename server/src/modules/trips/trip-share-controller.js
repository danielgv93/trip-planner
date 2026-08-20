import { sendJson } from "../../http/send-json.js";

export function createTripShareController(tripShareService) {
    return {
        async readShare(req, res) {
            const share = await tripShareService.readShare({
                userId: res.locals.activeSession.user_id,
                tripId: req.params.tripId,
            });
            sendJson(res, 200, { share });
        },
        async share(req, res) {
            const share = await tripShareService.share({
                userId: res.locals.activeSession.user_id,
                tripId: req.params.tripId,
            });
            sendJson(res, 200, { share });
        },
        async unshare(req, res) {
            const share = await tripShareService.unshare({
                userId: res.locals.activeSession.user_id,
                tripId: req.params.tripId,
            });
            sendJson(res, 200, { share });
        },
        async readPublicTrip(req, res) {
            const trip = await tripShareService.readPublicTrip({
                token: req.params.token,
                clientKey: req.ip,
            });
            sendJson(res, 200, { trip });
        },
    };
}
