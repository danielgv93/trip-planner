import { ApiError } from "../../http/api-error.js";

// Expands Google Maps short links server-side (the browser cannot: CORS hides
// the redirect). It is an SSRF-sensitive surface, so the rules are strict:
//   * only the two shortener hosts are ever REQUESTED;
//   * every redirect target is validated against the Google Maps host list
//     before it is followed or returned;
//   * redirects are followed by hand with a hop limit, and bodies are never read.

const GOOGLE_TLD = "(?:com?\\.[a-z]{2}|[a-z]{2,3})";
const GOOGLE_HOST = new RegExp(`^(?:www\\.)?google\\.${GOOGLE_TLD}$`);
const MAPS_GOOGLE_HOST = new RegExp(`^maps\\.google\\.${GOOGLE_TLD}$`);
const MAX_URL_LENGTH = 2048;

function parseHttps(value) {
    if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return null;
    let url;
    try {
        url = new URL(value.trim());
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.port && url.port !== "443") return null;
    return url;
}

/** The only hosts this service will ever send a request to. */
export function isShortLink(url) {
    const host = url.hostname.toLowerCase();
    if (host === "maps.app.goo.gl") return url.pathname.length > 1;
    return host === "goo.gl" && /^\/maps\/.+/.test(url.pathname);
}

/** Hosts a redirect may legitimately land on (never requested, only returned). */
export function isGoogleMapsDestination(url) {
    const host = url.hostname.toLowerCase();
    if (isShortLink(url)) return true;
    if (MAPS_GOOGLE_HOST.test(host)) return true;
    if (GOOGLE_HOST.test(host)) return /^\/maps(?:\/|$)/.test(url.pathname) || url.pathname === "/";
    return false;
}

// In the EU, Google can bounce through consent.google.com/ml?continue=<maps url>.
function unwrapConsent(url) {
    if (url.hostname.toLowerCase() !== "consent.google.com") return url;
    const target = parseHttps(url.searchParams.get("continue"));
    return target && isGoogleMapsDestination(target) ? target : null;
}

const invalid = () => new ApiError(400, "INVALID_MAPS_LINK", "Enlace de Google Maps no válido");
const unresolved = () => new ApiError(422, "MAPS_LINK_UNRESOLVED", "No se pudo resolver el enlace");

export function createMapsLinkResolver({ fetchImpl = fetch, maxHops = 5, timeoutMs = 4_000 } = {}) {
    async function resolve(input) {
        let current = parseHttps(input);
        if (!current || !isShortLink(current)) throw invalid();

        for (let hop = 0; hop <= maxHops; hop += 1) {
            // A resolved (non-shortener) destination is returned without a request.
            if (!isShortLink(current)) return current.href;

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            let response;
            try {
                response = await fetchImpl(current.href, {
                    method: "GET",
                    redirect: "manual",
                    signal: controller.signal,
                    headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (compatible; TripPlanner/1.0)" },
                });
            } catch {
                throw unresolved();
            } finally {
                clearTimeout(timer);
            }
            // Never download the body: only the redirect header matters.
            try { await response.body?.cancel(); } catch { /* already closed */ }

            if (response.status < 300 || response.status > 399) throw unresolved();
            const location = response.headers.get("location");
            if (!location) throw unresolved();
            let next;
            try {
                next = new URL(location, current);
            } catch {
                throw unresolved();
            }
            if (next.protocol !== "https:" || next.username || next.password) throw unresolved();
            const unwrapped = unwrapConsent(next);
            if (!unwrapped || !isGoogleMapsDestination(unwrapped)) throw unresolved();
            current = unwrapped;
        }
        throw unresolved();
    }

    return { resolve };
}
