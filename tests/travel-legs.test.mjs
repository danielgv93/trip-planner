import test from "node:test";
import assert from "node:assert/strict";

import {
    applicableTravelLeg,
    disconnectedTravelLegs,
    migrateLegacyTravelLegs,
    normalizeTravelLeg,
    parseTravelLegKey,
    travelLegKey,
} from "../js/core/travel-legs.js";

test("normaliza metadatos seguros y extremos embebidos sin duplicados", () => {
    assert.deepEqual(normalizeTravelLeg({
        mode: "train",
        durationMinutes: 135,
        departureTime: "09:12",
        fixedDeparture: true,
        line: " Tokaido ",
        cost: 13320,
        embeddedEndpoints: ["from", "to", "from", "invalid"],
    }), {
        mode: "train",
        durationMinutes: 135,
        departureTime: "09:12",
        fixedDeparture: true,
        line: "Tokaido",
        cost: 13320,
        embeddedEndpoints: ["from", "to"],
    });
});

test("migra perfiles y overrides legacy y el formato nuevo prevalece", () => {
    const result = migrateLegacyTravelLegs(
        { "a>b": { mode: "train", line: "Nozomi", durationMinutes: 130 } },
        { "a>b": "walking", "b>c": "driving" },
        { "walking:a>b": 25, "driving:b>c": 40 },
        { spotIds: new Set(["a", "b", "c"]) },
    );
    assert.deepEqual(result["a>b"], { mode: "train", durationMinutes: 130, line: "Nozomi" });
    assert.deepEqual(result["b>c"], { mode: "driving", durationMinutes: 40 });
});

test("solo resuelve pares activos consecutivos y conserva desconectados", () => {
    const a = { id: "a" }, b = { id: "b" }, c = { id: "c" };
    const legs = { [travelLegKey("a", "b")]: { mode: "walking" }, [travelLegKey("a", "c")]: { mode: "bus", durationMinutes: 20 } };
    const day = { spots: [a, b, c] };
    assert.equal(applicableTravelLeg(legs, day, a, b), legs["a>b"]);
    assert.equal(applicableTravelLeg(legs, day, a, c), null);
    assert.deepEqual(disconnectedTravelLegs(legs, [day]), [["a>c", legs["a>c"]]]);
    assert.deepEqual(parseTravelLegKey("a>b"), { fromId: "a", toId: "b" });
});
