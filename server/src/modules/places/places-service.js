import { ApiError } from "../../http/api-error.js";
import { SlidingWindowLimiter } from "../../security/session-security.js";
import { createMapsLinkResolver } from "./maps-link-resolver.js";

export function createPlacesService({ config = {}, resolver = createMapsLinkResolver() } = {}) {
    const limiter = new SlidingWindowLimiter({
        limit: config.placesRateLimit || 30,
        windowMs: config.placesRateWindowMs || 60_000,
    });

    return {
        async resolveMapsLink({ userId, url }) {
            if (!limiter.take(String(userId))) {
                throw new ApiError(429, "PLACES_RATE_LIMIT", "Demasiadas consultas; vuelve a intentarlo en unos segundos", {
                    retryAfterMs: config.placesRateWindowMs || 60_000,
                });
            }
            return { url: await resolver.resolve(url) };
        },
    };
}
