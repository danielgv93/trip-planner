import { sendJson } from "../../http/send-json.js";

export function createTripController(tripService) {
    return {
        async listTrips(req, res) {
            const trips = await tripService.listTrips({
                userId: res.locals.activeSession.user_id,
                archived: req.query.archived === "true",
            });
            sendJson(res, 200, { trips });
        },
        async createTrip(req, res) {
            const trip = await tripService.createTrip({ active: res.locals.activeSession, input: req.body || {} });
            sendJson(res, 201, { trip });
        },
        async getTrip(req, res) {
            const trip = await tripService.getTrip({ userId: res.locals.activeSession.user_id, tripId: req.params.tripId });
            sendJson(res, 200, { trip });
        },
        async mutateTrip(req, res) {
            const result = await tripService.mutateTrip({ active: res.locals.activeSession, tripId: req.params.tripId, input: req.body || {} });
            sendJson(res, 200, result);
        },
        async updateTrip(req, res) {
            const trip = await tripService.updateTrip({ active: res.locals.activeSession, tripId: req.params.tripId, input: req.body || {} });
            sendJson(res, 200, { trip });
        },
        async deleteTrip(req, res) {
            const deleted = await tripService.deleteTrip({ active: res.locals.activeSession, tripId: req.params.tripId });
            sendJson(res, 200, { ok: true, deleted });
        },
        async listRevisions(req, res) {
            const result = await tripService.listRevisions({
                userId: res.locals.activeSession.user_id,
                tripId: req.params.tripId,
                before: Number(req.query.before || Number.MAX_SAFE_INTEGER),
                limit: Math.min(100, Math.max(1, Number(req.query.limit || 30))),
            });
            sendJson(res, 200, result);
        },
        async getRevision(req, res) {
            const revision = await tripService.getRevision({
                userId: res.locals.activeSession.user_id,
                tripId: req.params.tripId,
                revision: Number(req.params.revision),
            });
            sendJson(res, 200, { revision });
        },
    };
}
