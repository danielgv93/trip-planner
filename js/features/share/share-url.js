// Pure share-link URL rules, kept free of browser and store imports so they can
// be exercised by `node --test`.

export const SHARE_PARAM = "viaje";

// The token travels as a query parameter rather than a path segment: the app is
// served as a static index.html with relative script URLs, so a deeper path
// would resolve every asset against the wrong base.
export function publicShareToken(search = "") {
    const token = new URLSearchParams(search).get(SHARE_PARAM);
    return token && token.trim() ? token.trim() : null;
}

export function publicShareUrl(token, { origin, pathname = "/" } = {}) {
    const url = new URL(pathname, origin);
    url.searchParams.set(SHARE_PARAM, token);
    return url.toString();
}
