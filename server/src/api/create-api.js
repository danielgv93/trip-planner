import express from "express";
import {
    createCorsPreflight,
    createErrorHandler,
    createRequestContext,
    requireCloud,
    routeNotFound,
} from "../http/api-middleware.js";
import { createAccountController } from "../modules/accounts/account-controller.js";
import { registerAccountRoutes } from "../modules/accounts/account-routes.js";
import { createAccountService } from "../modules/accounts/account-service.js";
import { createAuthController } from "../modules/auth/auth-controller.js";
import { createAuthenticationMiddleware } from "../modules/auth/auth-middleware.js";
import { registerAuthRoutes } from "../modules/auth/auth-routes.js";
import { createAuthService } from "../modules/auth/auth-service.js";
import { createSystemController } from "../modules/system/system-controller.js";
import { registerProtectedSystemRoutes, registerPublicSystemRoutes } from "../modules/system/system-routes.js";
import { createSystemService } from "../modules/system/system-service.js";
import { createTripController } from "../modules/trips/trip-controller.js";
import { registerPublicTripRoutes, registerTripRoutes } from "../modules/trips/trip-routes.js";
import { createTripShareController } from "../modules/trips/trip-share-controller.js";
import { createTripShareService } from "../modules/trips/trip-share-service.js";
import { createTripService } from "../modules/trips/trip-service.js";
import { createMetrics } from "../observability/request-metrics.js";

export function createApi({ database, config, logger = console, now = () => new Date(), metrics = createMetrics() }) {
    const app = express();
    const authService = createAuthService({ database, config, now });
    const authController = createAuthController({ authService, config });
    const systemController = createSystemController(createSystemService({ database, config, metrics }));
    const tripController = createTripController(createTripService({ database, config, now }));
    const tripShareController = createTripShareController(createTripShareService({ database }));
    const accountController = createAccountController({
        accountService: createAccountService({ database, now }),
        config,
    });

    app.disable("x-powered-by");
    app.use(createRequestContext({ config, metrics, logger }));
    app.use(express.json({ limit: config.bodyLimitBytes }));
    app.options("/{*path}", createCorsPreflight(config));

    registerPublicSystemRoutes(app, systemController);
    app.use(requireCloud(config));
    registerPublicTripRoutes(app, tripShareController);
    registerAuthRoutes(app, authController);
    app.use(createAuthenticationMiddleware(authService));
    registerProtectedSystemRoutes(app, systemController);
    registerTripRoutes(app, tripController, tripShareController);
    registerAccountRoutes(app, accountController);

    app.use(routeNotFound);
    app.use(createErrorHandler(logger));
    return app;
}
