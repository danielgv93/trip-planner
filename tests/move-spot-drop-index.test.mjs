import test from "node:test";
import assert from "node:assert/strict";

import { dropIndexBefore } from "../js/features/planner/move-spot.js";

// Rendered rows: [Kyoto → Hiroshima card], Shukkeien, Parque, Yokogawa, Hotel.
// The card folds both stations, so it is one row for two stops.
const spots = [
    { id: "kyoto", kind: "waypoint" },
    { id: "hiroshima", kind: "waypoint" },
    { id: "shukkeien" },
    { id: "parque" },
    { id: "yokogawa" },
    { id: "hotel", positionConstraint: "last" },
];
const travelLegs = {
    "kyoto>hiroshima": { mode: "train", embeddedEndpoints: ["from", "to"] },
};

test("dropIndexBefore resolves a drop after a folded travel card by stop, not by row", () => {
    // Shukkeien dropped between Parque and Yokogawa: it is row 2, but the
    // move must land before Yokogawa, which is index 3 once Shukkeien leaves.
    const at = dropIndexBefore(spots, travelLegs, "shukkeien", { spotId: "yokogawa" });
    assert.equal(at, 3);
    const rest = spots.filter((spot) => spot.id !== "shukkeien");
    assert.equal(rest[at].id, "yokogawa");
});

test("dropIndexBefore lands before the card's first folded stop", () => {
    assert.equal(
        dropIndexBefore(spots, travelLegs, "parque", { travelLegKey: "kyoto>hiroshima" }),
        0,
    );
    // A card folding only its arrival sits after the origin's own row.
    const arrivalOnly = { "kyoto>hiroshima": { mode: "train", embeddedEndpoints: ["to"] } };
    assert.equal(
        dropIndexBefore(spots, arrivalOnly, "parque", { travelLegKey: "kyoto>hiroshima" }),
        1,
    );
});

test("dropIndexBefore appends at the end of the day when nothing follows", () => {
    assert.equal(dropIndexBefore(spots, travelLegs, "shukkeien", null), 5);
    assert.equal(dropIndexBefore(spots, travelLegs, "shukkeien", { spotId: "missing" }), 5);
});
