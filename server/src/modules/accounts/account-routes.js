export function registerAccountRoutes(app, controller) {
    app.get("/api/account/export", controller.exportAccount);
    app.patch("/api/account/profile", controller.updateProfile);
    app.patch("/api/account/password", controller.changePassword);
    app.delete("/api/account", controller.deleteAccount);
}
