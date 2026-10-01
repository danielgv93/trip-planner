export function registerPlacesRoutes(app, controller) {
    app.post("/api/places/resolve-link", controller.resolveMapsLink);
}
