import test from "node:test";
import assert from "node:assert/strict";

import { relocateTravelCard } from "../js/features/planner/move-spot.js?v=2";

function plan() {
    return {
        state: [
            {
                id: "d1",
                spots: [
                    { id: "a", kind: "activity" },
                    { id: "from", kind: "waypoint", plannedStart: "09:00", fixedStart: true },
                    { id: "to", kind: "waypoint" },
                    { id: "b", kind: "activity" },
                ],
            },
            { id: "d2", spots: [{ id: "c", kind: "activity" }] },
        ],
        backlog: [],
        travelLegs: {
            "from>to": {
                mode: "train",
                embeddedEndpoints: ["from", "to"],
            },
        },
    };
}

test("relocateTravelCard moves both embedded endpoints atomically", () => {
    const value = plan();
    const result = relocateTravelCard(value, "from>to", "d2", "c");

    assert.deepEqual(value.state[0].spots.map(({ id }) => id), ["a", "b"]);
    assert.deepEqual(value.state[1].spots.map(({ id }) => id), ["from", "to", "c"]);
    assert.equal(result.fromDay, "d1");
    assert.equal(value.state[1].spots[0].plannedStart, undefined);
    assert.equal(value.state[1].spots[0].fixedStart, undefined);
    assert.ok(value.travelLegs["from>to"]);
});

test("relocateTravelCard refuses backlog and non-embedded legs without mutation", () => {
    const value = plan();
    const before = structuredClone(value);
    assert.equal(relocateTravelCard(value, "from>to", "backlog"), null);
    assert.deepEqual(value, before);

    value.travelLegs["from>to"].embeddedEndpoints = ["from"];
    const oneEmbedded = structuredClone(value);
    assert.equal(relocateTravelCard(value, "from>to", "d2"), null);
    assert.deepEqual(value, oneEmbedded);
});

test("relocateTravelCard can reorder the card within its current day", () => {
    const value = plan();
    const result = relocateTravelCard(value, "from>to", "d1", null);

    assert.ok(result);
    assert.deepEqual(value.state[0].spots.map(({ id }) => id), ["a", "b", "from", "to"]);
    assert.equal(value.state[0].spots[2].plannedStart, "09:00");
});
