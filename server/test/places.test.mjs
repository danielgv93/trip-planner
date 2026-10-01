import assert from "node:assert/strict";
import test from "node:test";

import { createMapsLinkResolver, isGoogleMapsDestination, isShortLink } from "../src/modules/places/maps-link-resolver.js";
import { createPlacesService } from "../src/modules/places/places-service.js";

function redirect(location, status = 302) {
    return { status, headers: new Headers(location ? { location } : {}), body: { cancel: async () => {} } };
}

function scripted(responses) {
    const calls = [];
    return {
        calls,
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            const next = responses.shift();
            if (!next) throw new Error("unexpected request");
            if (next instanceof Error) throw next;
            return next;
        },
    };
}

test("only the shortener hosts are classified as short links", () => {
    assert.ok(isShortLink(new URL("https://maps.app.goo.gl/AbC")));
    assert.ok(isShortLink(new URL("https://goo.gl/maps/AbC")));
    assert.equal(isShortLink(new URL("https://goo.gl/other/AbC")), false);
    assert.equal(isShortLink(new URL("https://maps.app.goo.gl.evil.test/AbC")), false);
    assert.equal(isGoogleMapsDestination(new URL("https://www.google.es/maps/place/X")), true);
    assert.equal(isGoogleMapsDestination(new URL("https://www.google.com/search?q=x")), false);
});

test("rejects inputs that are not strict Google Maps short links without any request", async () => {
    const { fetchImpl, calls } = scripted([]);
    const resolver = createMapsLinkResolver({ fetchImpl });
    for (const url of [
        undefined,
        42,
        "no es una url",
        "http://maps.app.goo.gl/AbC",
        "https://user:pw@maps.app.goo.gl/AbC",
        "https://maps.app.goo.gl:8443/AbC",
        "https://169.254.169.254/latest/meta-data",
        "https://localhost/maps",
        "https://www.google.com/maps/place/X",
        "https://goo.gl/other/AbC",
        "https://maps.app.goo.gl.evil.test/AbC",
        `https://maps.app.goo.gl/${"a".repeat(3000)}`,
    ]) {
        await assert.rejects(resolver.resolve(url), (error) => error.status === 400 && error.code === "INVALID_MAPS_LINK", String(url));
    }
    assert.equal(calls.length, 0);
});

test("follows a redirect manually and returns the final Maps URL without requesting it", async () => {
    const final = "https://www.google.com/maps/place/Torre+Eiffel/@48.85,2.29,17z";
    const { fetchImpl, calls } = scripted([redirect(final)]);
    const result = await createMapsLinkResolver({ fetchImpl }).resolve("https://maps.app.goo.gl/AbC");
    assert.equal(result, final);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.redirect, "manual");
});

test("follows a chain through goo.gl and unwraps the EU consent page", async () => {
    const final = "https://www.google.fr/maps/place/Louvre/@48.86,2.33,17z";
    const { fetchImpl, calls } = scripted([
        redirect("https://goo.gl/maps/Zz9"),
        redirect(`https://consent.google.com/ml?continue=${encodeURIComponent(final)}&gl=FR`),
    ]);
    const result = await createMapsLinkResolver({ fetchImpl }).resolve("https://maps.app.goo.gl/AbC");
    assert.equal(result, final);
    assert.deepEqual(calls.map((call) => call.url), ["https://maps.app.goo.gl/AbC", "https://goo.gl/maps/Zz9"]);
});

test("refuses a redirect to a foreign or internal host", async () => {
    for (const location of [
        "https://evil.example/maps/place/X",
        "http://www.google.com/maps/place/X",
        "https://169.254.169.254/",
        "https://www.google.com.evil.example/maps/place/X",
        "https://consent.google.com/ml?continue=https%3A%2F%2Fevil.example%2F",
        "https://www.google.com/search?q=x",
    ]) {
        const { fetchImpl } = scripted([redirect(location)]);
        await assert.rejects(
            createMapsLinkResolver({ fetchImpl }).resolve("https://maps.app.goo.gl/AbC"),
            (error) => error.status === 422 && error.code === "MAPS_LINK_UNRESOLVED",
            location,
        );
    }
});

test("enforces the hop limit", async () => {
    const { fetchImpl, calls } = scripted(Array.from({ length: 10 }, (_, index) => redirect(`https://goo.gl/maps/hop${index}`)));
    await assert.rejects(
        createMapsLinkResolver({ fetchImpl, maxHops: 3 }).resolve("https://maps.app.goo.gl/AbC"),
        (error) => error.code === "MAPS_LINK_UNRESOLVED",
    );
    assert.equal(calls.length, 4);
});

test("a non-redirect answer, a missing Location header or a network error is unresolved", async () => {
    for (const response of [{ status: 200, headers: new Headers(), body: null }, redirect(null), new Error("boom")]) {
        const { fetchImpl } = scripted([response]);
        await assert.rejects(
            createMapsLinkResolver({ fetchImpl }).resolve("https://maps.app.goo.gl/AbC"),
            (error) => error.code === "MAPS_LINK_UNRESOLVED",
        );
    }
});

test("aborts a request that exceeds the timeout", async () => {
    const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
    await assert.rejects(
        createMapsLinkResolver({ fetchImpl, timeoutMs: 20 }).resolve("https://maps.app.goo.gl/AbC"),
        (error) => error.code === "MAPS_LINK_UNRESOLVED",
    );
});

test("the service rate-limits per account", async () => {
    const resolver = { resolve: async () => "https://www.google.com/maps/place/X" };
    const service = createPlacesService({ config: { placesRateLimit: 2, placesRateWindowMs: 60_000 }, resolver });
    assert.deepEqual(await service.resolveMapsLink({ userId: "a", url: "x" }), { url: "https://www.google.com/maps/place/X" });
    await service.resolveMapsLink({ userId: "a", url: "x" });
    await assert.rejects(service.resolveMapsLink({ userId: "a", url: "x" }), (error) => error.status === 429);
    await service.resolveMapsLink({ userId: "b", url: "x" });
});
