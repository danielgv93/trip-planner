// Wikipedia/Wikimedia is keyless and CORS-friendly (origin=*), so it works from
// file:// like Nominatim/OSRM — unlike Google Images, which needs an API key and
// blocks cross-origin scraping. We fetch a representative photo of the place by
// name (es first, then en for international landmarks). Preview-only: never saved
// to the spot, cached in-memory by name so retyping doesn't refetch.

const imageCache = new Map();

export async function fetchSpotImage(name) {
    const q = name.trim();
    if (q.length < 2) return null;
    if (imageCache.has(q)) return imageCache.get(q);
    let networkOk = false;
    for (const lang of ["es", "en"]) {
        try {
            const r = await fetch(
                `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrlimit=1&gsrsearch=${encodeURIComponent(q)}&prop=pageimages&piprop=thumbnail&pithumbsize=480`,
            );
            if (!r.ok) continue;
            networkOk = true;
            const data = await r.json(),
                pages = data?.query?.pages;
            if (!pages) continue;
            const page = Object.values(pages)[0],
                thumb = page?.thumbnail?.source;
            if (thumb) {
                const found = { src: thumb, title: page.title };
                imageCache.set(q, found);
                return found;
            }
        } catch {}
    }
    // Only remember a genuine "no image" (a request succeeded but had no
    // thumbnail). A network failure stays uncached so it retries.
    if (networkOk) imageCache.set(q, null);
    return null;
}
