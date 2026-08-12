export function registerPublicSystemRoutes(app, controller) {
    app.get("/api/health", controller.health);
    app.get("/api/metrics", controller.metrics);
}

export function registerProtectedSystemRoutes(app, controller) {
    app.post("/api/metrics/queue-depth", controller.updateQueueDepth);
}
