import { sendJson } from "../../http/send-json.js";

export function createPlacesController(placesService) {
    return {
        async resolveMapsLink(req, res) {
            const result = await placesService.resolveMapsLink({
                userId: res.locals.activeSession.user_id,
                url: req.body?.url,
            });
            sendJson(res, 200, result);
        },
    };
}
