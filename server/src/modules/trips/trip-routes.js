export function registerTripRoutes(app, controller) {
    app.get("/api/trips", controller.listTrips);
    app.post("/api/trips", controller.createTrip);
    app.get("/api/trips/:tripId/revisions", controller.listRevisions);
    app.get("/api/trips/:tripId/revisions/:revision", controller.getRevision);
    app.post("/api/trips/:tripId/mutations", controller.mutateTrip);
    app.get("/api/trips/:tripId", controller.getTrip);
    app.patch("/api/trips/:tripId", controller.updateTrip);
    app.delete("/api/trips/:tripId", controller.deleteTrip);
}
