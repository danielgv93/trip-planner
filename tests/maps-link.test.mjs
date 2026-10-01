import test from "node:test";
import assert from "node:assert/strict";
import {
    classifyClipboardText,
    isGoogleMapsShortLink,
    isGoogleMapsUrl,
    isValidCoordinate,
    parseGoogleMapsUrl,
} from "../js/core/maps-link.js";

test("reads the place name and viewport coordinates from a /place/ URL", () => {
    assert.deepEqual(
        parseGoogleMapsUrl("https://www.google.com/maps/place/Torre+Eiffel/@48.8583701,2.2944813,17z/"),
        { name: "Torre Eiffel", lat: 48.8583701, lng: 2.2944813 },
    );
});

test("decodes percent-encoded names and keeps accents", () => {
    const place = parseGoogleMapsUrl("https://www.google.com/maps/place/Sagrada+Fam%C3%ADlia/@41.4036,2.1744,17z");
    assert.equal(place.name, "Sagrada Família");
});

test("prefers !3d!4d (the place) over @ (the viewport centre)", () => {
    const place = parseGoogleMapsUrl(
        "https://www.google.com/maps/place/Louvre/@48.9,2.4,12z/data=!4m6!3m5!1s0x0:0x0!8m2!3d48.8606111!4d2.337644!16zL20",
    );
    assert.deepEqual(place, { name: "Louvre", lat: 48.8606111, lng: 2.337644 });
});

test("supports q, query and ll coordinate parameters", () => {
    assert.deepEqual(parseGoogleMapsUrl("https://maps.google.com/?q=35.6586,139.7454"), {
        name: "",
        lat: 35.6586,
        lng: 139.7454,
    });
    assert.deepEqual(parseGoogleMapsUrl("https://www.google.com/maps?query=-33.8568,151.2153"), {
        name: "",
        lat: -33.8568,
        lng: 151.2153,
    });
    assert.deepEqual(parseGoogleMapsUrl("https://www.google.com/maps?ll=40.4168,-3.7038&z=14"), {
        name: "",
        lat: 40.4168,
        lng: -3.7038,
    });
});

test("supports the search API form with a textual query", () => {
    assert.deepEqual(
        parseGoogleMapsUrl("https://www.google.com/maps/search/?api=1&query=Tokyo+Tower"),
        { name: "Tokyo Tower" },
    );
    assert.deepEqual(
        parseGoogleMapsUrl("https://www.google.com/maps/search/?api=1&query=35.6586%2C139.7454"),
        { name: "", lat: 35.6586, lng: 139.7454 },
    );
});

test("reads coordinates placed in the path", () => {
    assert.deepEqual(parseGoogleMapsUrl("https://www.google.com/maps/place/48.8584,2.2945"), {
        name: "",
        lat: 48.8584,
        lng: 2.2945,
    });
    assert.equal(parseGoogleMapsUrl("https://www.google.com/maps/search/Cafe+Central/").name, "Cafe Central");
});

test("accepts regional hosts and rejects unrelated ones", () => {
    for (const url of [
        "https://maps.google.es/?q=1,2",
        "https://www.google.co.uk/maps/place/Big+Ben/@51.5,-0.12,17z",
        "https://google.com.mx/maps/place/Zocalo",
    ]) assert.ok(isGoogleMapsUrl(url), url);
    for (const url of [
        "https://www.google.com/search?q=1,2",
        "https://evil.example/maps/place/Torre",
        "https://google.com.evil.example/maps/place/Torre",
        "https://maps.google.com.evil.example/?q=1,2",
        "ftp://maps.google.com/?q=1,2",
    ]) assert.equal(isGoogleMapsUrl(url), false, url);
});

test("recognises short links but never parses them as places", () => {
    assert.ok(isGoogleMapsShortLink("https://maps.app.goo.gl/AbCd123"));
    assert.ok(isGoogleMapsShortLink("https://goo.gl/maps/AbCd123"));
    assert.equal(isGoogleMapsShortLink("https://goo.gl/other/AbCd"), false);
    assert.equal(isGoogleMapsShortLink("https://maps.app.goo.gl/"), false);
    assert.equal(parseGoogleMapsUrl("https://maps.app.goo.gl/AbCd123"), null);
});

test("rejects out-of-range coordinates", () => {
    assert.equal(isValidCoordinate(91, 0), false);
    assert.equal(isValidCoordinate(0, 181), false);
    assert.equal(isValidCoordinate(-90, -180), true);
    assert.equal(parseGoogleMapsUrl("https://maps.google.com/?q=95.0,10.0"), null);
    // An invalid !3d!4d pair falls back to the viewport.
    assert.deepEqual(
        parseGoogleMapsUrl("https://www.google.com/maps/place/X/@10,20,5z/data=!3d99!4d200"),
        { name: "X", lat: 10, lng: 20 },
    );
});

test("classifies clipboard text", () => {
    assert.deepEqual(classifyClipboardText("https://maps.app.goo.gl/AbCd123"), {
        type: "short",
        url: "https://maps.app.goo.gl/AbCd123",
    });
    const shared = classifyClipboardText(
        "Torre Eiffel\nhttps://www.google.com/maps/place/Torre+Eiffel/@48.85,2.29,17z.",
    );
    assert.equal(shared.type, "place");
    assert.equal(shared.place.name, "Torre Eiffel");
    assert.equal(classifyClipboardText("hola, esto no es un enlace"), null);
    assert.equal(classifyClipboardText("https://example.com/maps/place/X"), null);
    assert.equal(classifyClipboardText("https://www.google.com/maps"), null);
    assert.equal(classifyClipboardText(42), null);
});
