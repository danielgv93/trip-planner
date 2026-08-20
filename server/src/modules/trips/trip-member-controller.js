import { sendJson } from "../../http/send-json.js";

export function createTripMemberController(tripMemberService) {
    return {
        async listMembers(req, res) {
            const result = await tripMemberService.listMembers({
                userId: res.locals.activeSession.user_id,
                tripId: req.params.tripId,
            });
            sendJson(res, 200, result);
        },
        async inviteMember(req, res) {
            const member = await tripMemberService.inviteMember({
                active: res.locals.activeSession,
                tripId: req.params.tripId,
                input: req.body || {},
            });
            sendJson(res, 201, { member });
        },
        async updateMemberRole(req, res) {
            const member = await tripMemberService.updateMemberRole({
                active: res.locals.activeSession,
                tripId: req.params.tripId,
                memberId: req.params.memberId,
                input: req.body || {},
            });
            sendJson(res, 200, { member });
        },
        async removeMember(req, res) {
            const result = await tripMemberService.removeMember({
                active: res.locals.activeSession,
                tripId: req.params.tripId,
                memberId: req.params.memberId,
            });
            sendJson(res, 200, result);
        },
        async leaveTrip(req, res) {
            const result = await tripMemberService.leaveTrip({
                active: res.locals.activeSession,
                tripId: req.params.tripId,
            });
            sendJson(res, 200, result);
        },
    };
}
