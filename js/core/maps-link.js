// Pure Google Maps link understanding. No DOM, no network: the planner pastes
// clipboard text in, and gets back either a place (name and/or coordinates) or a
// short link that has to be expanded by the server first.

const GOOGLE_TLD = "(?:com?\\.[a-z]{2}|[a-z]{2,3})";
const GOOGLE_HOST = new RegExp(`^(?:www\\.)?google\\.${GOOGLE_TLD}$`);
const MAPS_GOOGLE_HOST = new RegExp(`^maps\\.google\\.${GOOGLE_TLD}$`);
const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/i;
const NUMBER = "-?\\d+(?:\\.\\d+)?";
const COORDINATE_PAIR = new RegExp(`^\\s*(${NUMBER})\\s*,\\s*(${NUMBER})\\s*$`);
const PLACE_DATA = new RegExp(`!3d(${NUMBER})!4d(${NUMBER})`);
const VIEWPORT = new RegExp(`@(${NUMBER}),(${NUMBER})(?:[,/]|$)`);
const COORDINATE_PARAMS = ["q", "query", "ll", "destination", "daddr", "center"];
const NAME_PARAMS = ["q", "query"];

export function isValidCoordinate(lat, lng) {
    return (
        Number.isFinite(lat) &&
        Number.isFinite(lng) &&
        lat >= -90 &&
        lat <= 90 &&
        lng >= -180 &&
        lng <= 180
    );
}

function coordinatesFrom(latText, lngText) {
    const lat = Number(latText);
    const lng = Number(lngText);
    return isValidCoordinate(lat, lng) ? { lat, lng } : null;
}

function readUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:" ? url : null;
    } catch {
        return null;
    }
}

function decodeSegment(segment) {
    try {
        return decodeURIComponent(segment.replace(/\+/g, " ")).trim();
    } catch {
        return segment.replace(/\+/g, " ").trim();
    }
}

/** `https://maps.app.goo.gl/x` and `https://goo.gl/maps/x`: no data inside. */
export function isGoogleMapsShortLink(value) {
    const url = typeof value === "string" ? readUrl(value) : value;
    if (!url) return false;
    const host = url.hostname.toLowerCase();
    if (host === "maps.app.goo.gl") return url.pathname.length > 1;
    return host === "goo.gl" && /^\/maps(?:\/|$)/.test(url.pathname) && url.pathname.length > "/maps/".length;
}

export function isGoogleMapsUrl(value) {
    const url = typeof value === "string" ? readUrl(value) : value;
    if (!url) return false;
    const host = url.hostname.toLowerCase();
    if (isGoogleMapsShortLink(url)) return true;
    if (MAPS_GOOGLE_HOST.test(host)) return true;
    return GOOGLE_HOST.test(host) && /^\/maps(?:\/|$)/.test(url.pathname);
}

function coordinatesFromParams(params) {
    for (const key of COORDINATE_PARAMS) {
        const match = COORDINATE_PAIR.exec(params.get(key) || "");
        const found = match && coordinatesFrom(match[1], match[2]);
        if (found) return found;
    }
    return null;
}

function nameFromPath(pathname) {
    const place = /\/maps\/place\/([^/]+)/.exec(pathname);
    const search = /\/maps\/search\/([^/]+)/.exec(pathname);
    const segment = place?.[1] ?? search?.[1];
    if (!segment) return { name: "", coordinates: null };
    const decoded = decodeSegment(segment);
    const pair = COORDINATE_PAIR.exec(decoded);
    if (pair) return { name: "", coordinates: coordinatesFrom(pair[1], pair[2]) };
    return { name: decoded, coordinates: null };
}

/**
 * Reads a full (already expanded) Google Maps URL. Returns
 * `{ name, lat?, lng? }` or `null` when the URL carries neither a name nor
 * coordinates. `!3d!4d` is the place itself and wins over `@lat,lng`, which is
 * only the viewport centre.
 */
export function parseGoogleMapsUrl(value) {
    const url = typeof value === "string" ? readUrl(value.trim()) : value;
    if (!url || !isGoogleMapsUrl(url) || isGoogleMapsShortLink(url)) return null;

    const fromPath = nameFromPath(url.pathname);
    const data = PLACE_DATA.exec(`${url.pathname}${url.search}${url.hash}`);
    const viewport = VIEWPORT.exec(url.pathname);
    const coordinates =
        (data && coordinatesFrom(data[1], data[2])) ||
        fromPath.coordinates ||
        coordinatesFromParams(url.searchParams) ||
        (viewport && coordinatesFrom(viewport[1], viewport[2])) ||
        null;

    let name = fromPath.name;
    if (!name) {
        for (const key of NAME_PARAMS) {
            const candidate = (url.searchParams.get(key) || "").trim();
            if (candidate && !COORDINATE_PAIR.test(candidate)) {
                name = candidate;
                break;
            }
        }
    }

    if (!name && !coordinates) return null;
    return { name, ...(coordinates || {}) };
}

/**
 * Classifies clipboard text. Android's share sheet prepends the place name to
 * the link, so the first URL inside the text is used.
 *
 * - `{ type: "short", url }`: needs the server to expand it.
 * - `{ type: "place", place, url }`: ready to use.
 * - `null`: not a Google Maps link (or nothing useful inside it).
 */
export function classifyClipboardText(text) {
    if (typeof text !== "string" || text.length > 4000) return null;
    const match = URL_IN_TEXT.exec(text);
    if (!match) return null;
    const url = readUrl(match[0].replace(/[).,;]+$/, ""));
    if (!url || !isGoogleMapsUrl(url)) return null;
    if (isGoogleMapsShortLink(url)) return { type: "short", url: url.href };
    const place = parseGoogleMapsUrl(url);
    return place ? { type: "place", place, url: url.href } : null;
}
