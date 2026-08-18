export function registerAuthRoutes(app, controller) {
    app.post("/api/auth/register", controller.register);
    app.post("/api/auth/login", controller.login);
    app.get("/api/session", controller.currentSession);
    app.post("/api/logout", controller.logout);
}
