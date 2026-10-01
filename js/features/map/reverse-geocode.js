// Best-effort reverse geocoding through Nominatim, the same service used for
// place search. It never throws: callers fall back to an unnamed point.

export async function reverseGeocode(lat, lng, { timeoutMs = 3_000, fetchImpl = fetch } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(
            `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=es,en&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`,
            { signal: controller.signal, headers: { "Accept-Language": "es, en;q=0.9" } },
        );
        if (!response.ok) return null;
        const data = await response.json();
        const name = typeof data?.name === "string" ? data.name.trim() : "";
        const address = typeof data?.display_name === "string" ? data.display_name.trim() : "";
        return name || address ? { name, address } : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}
