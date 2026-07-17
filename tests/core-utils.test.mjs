import test from "node:test";
import assert from "node:assert/strict";

import { distanceMeters, locatedPoint, validCoordinatePair } from "../js/core/geo.js";
import { isTime, minutesToTime, timeToMinutes } from "../js/core/time.js";

test("las horas canónicas se validan y convierten", () => {
    assert.equal(isTime("09:05"), true);
    assert.equal(isTime("9:05"), false);
    assert.equal(isTime("24:00"), false);
    assert.equal(timeToMinutes("23:59"), 1439);
    assert.equal(timeToMinutes("no"), null);
    assert.equal(minutesToTime(65), "01:05");
    assert.equal(minutesToTime(1500, { wrap: true }), "01:00");
});

test("las coordenadas y distancias comparten una única implementación", () => {
    assert.equal(validCoordinatePair(40.4168, -3.7038), true);
    assert.equal(validCoordinatePair(91, 0), false);
    assert.equal(locatedPoint({ lat: 35.6762, lng: 139.6503 }), true);
    assert.equal(distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 0 }), 0);
    assert.equal(distanceMeters({ lat: 100, lng: 0 }, { lat: 0, lng: 0 }), null);
    const madridToTokyo = distanceMeters(
        { lat: 40.4168, lng: -3.7038 },
        { lat: 35.6762, lng: 139.6503 },
    );
    assert.ok(madridToTokyo > 10_000_000 && madridToTokyo < 11_000_000);
});
