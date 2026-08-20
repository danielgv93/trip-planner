export function registerTripRoutes(app, controller, shareController, memberController, streamController) {
    app.get("/api/trips", controller.listTrips);
    app.post("/api/trips", controller.createTrip);
    app.get("/api/trips/:tripId/revisions", controller.listRevisions);
    app.get("/api/trips/:tripId/revisions/:revision", controller.getRevision);
    app.post("/api/trips/:tripId/mutations", controller.mutateTrip);
    app.get("/api/trips/:tripId/events", streamController.streamTrip);
    app.get("/api/trips/:tripId/share", shareController.readShare);
    app.post("/api/trips/:tripId/share", shareController.share);
    app.delete("/api/trips/:tripId/share", shareController.unshare);
    app.get("/api/trips/:tripId/members", memberController.listMembers);
    app.post("/api/trips/:tripId/members", memberController.inviteMember);
    // Registered before the `:memberId` routes so that leaving is never parsed
    // as removing a collaborator whose id happens to be the literal "me".
    app.delete("/api/trips/:tripId/members/me", memberController.leaveTrip);
    app.patch("/api/trips/:tripId/members/:memberId", memberController.updateMemberRole);
    app.delete("/api/trips/:tripId/members/:memberId", memberController.removeMember);
    app.get("/api/trips/:tripId", controller.getTrip);
    app.patch("/api/trips/:tripId", controller.updateTrip);
    app.delete("/api/trips/:tripId", controller.deleteTrip);
}

// Registered before the authentication middleware: this is the only trip route
// an anonymous visitor may reach, and it is read-only by construction.
export function registerPublicTripRoutes(app, shareController) {
    app.get("/api/public/trips/:token", shareController.readPublicTrip);
}
