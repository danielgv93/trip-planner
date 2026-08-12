import { sendJson } from "../../http/send-json.js";

export function createSystemController(systemService) {
    return {
        async health(req, res) {
            sendJson(res, 200, await systemService.health());
        },
        metrics(req, res) {
            sendJson(res, 200, systemService.metrics());
        },
        updateQueueDepth(req, res) {
            systemService.updateQueueDepth(req.body?.depth);
            sendJson(res, 202, { ok: true });
        },
    };
}
