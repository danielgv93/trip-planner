import test from "node:test";
import assert from "node:assert/strict";
import { moveImpacts, revertedOrder } from "../js/features/route-simulator/move-impact.js";
import { reorderDiff } from "../js/features/route-simulator/reorder.js";
import { simulateOrder } from "../js/features/route-simulator/optimizer.js";

const spotsNamed = (...names) => names.map((name, index) => ({ id: `s${index}`, name, visitMinutes: 0 }));
const stepsOf = (order) => order.map((spotIndex) => ({ spotIndex }));
const lineMatrix = (size) => Array.from({ length: size }, (_, from) =>
    Array.from({ length: size }, (_, to) => Math.abs(from - to) * 10));
const evaluator = (spots, matrix, options = { fixedStart: 540 }) => (order) => simulateOrder(spots, order, matrix, options);

test("undoing a move puts the stop back beside the stop it followed", () => {
    const diff = reorderDiff(stepsOf([0, 1, 2, 3, 4]), stepsOf([4, 0, 1, 2, 3]));
    assert.deepEqual(revertedOrder(diff, ["4:1"]), ["0:1", "1:1", "2:1", "3:1", "4:1"]);
});

test("a move is worth the minutes its undoing would add", () => {
    const spots = spotsNamed("A", "B", "C", "D");
    const diff = reorderDiff(stepsOf([0, 3, 1, 2]), stepsOf([0, 1, 2, 3]));
    const { byKey, groups } = moveImpacts(diff, { evaluate: evaluator(spots, lineMatrix(4)) });
    assert.deepEqual(byKey.get("3:1"), { kind: "minutes", minutes: 30 });
    assert.deepEqual(groups, []);
});

test("a move that saves a booking says so instead of counting minutes", () => {
    const spots = spotsNamed("A", "B", "Reserva", "D");
    spots[2] = { ...spots[2], fixedStart: true, plannedStart: "09:20" };
    const diff = reorderDiff(stepsOf([0, 1, 3, 2]), stepsOf([0, 1, 2, 3]), { anchored: (index) => index === 2 });
    const impact = moveImpacts(diff, { evaluate: evaluator(spots, lineMatrix(4)) }).byKey.get("3:1");
    assert.equal(impact.kind, "reservation");
    assert.equal(impact.spot.name, "Reserva");
    assert.equal(impact.planned, 560);
});

test("a move that cannot be undone without sliding a locked stop gets no figure", () => {
    const spots = spotsNamed("A", "B", "C", "D");
    const diff = reorderDiff(stepsOf([3, 0, 1, 2]), stepsOf([0, 1, 2, 3]));
    const impacts = moveImpacts(diff, { evaluate: evaluator(spots, lineMatrix(4)), lockedIndexes: [1] });
    assert.deepEqual(impacts.byKey.get("3:1"), { kind: "locked" });
});

// Stops 3 and 4 only pay off together; stop 5 (when present) saves alone.
function interlockedMatrix(size) {
    const matrix = Array.from({ length: size }, () => Array(size).fill(20));
    for (const [a, b] of [[0, 3], [3, 4], [4, 1], [1, 2], [0, 4], [2, 3], [3, 1], [2, 4], [2, 5], [3, 5], [4, 5]]) {
        if (a >= size || b >= size) continue;
        matrix[a][b] = 1;
        matrix[b][a] = 1;
    }
    for (let index = 0; index < size; index += 1) matrix[index][index] = 0;
    return matrix;
}

test("moves that only pay off together are reported as one group", () => {
    const spots = spotsNamed("A", "B", "C", "D", "E");
    const diff = reorderDiff(stepsOf([0, 1, 2, 3, 4]), stepsOf([0, 3, 4, 1, 2]));
    const { byKey, groups } = moveImpacts(diff, { evaluate: evaluator(spots, interlockedMatrix(5)) });
    assert.equal(byKey.get("3:1").minutes, 0);
    assert.equal(byKey.get("4:1").minutes, 0);
    assert.deepEqual(groups, [{ keys: ["3:1", "4:1"], kind: "minutes", minutes: 19 }]);
});

test("an independent saving does not hide a pair that works together", () => {
    const spots = spotsNamed("A", "B", "C", "D", "E", "F");
    const diff = reorderDiff(stepsOf([0, 5, 1, 2, 3, 4]), stepsOf([0, 3, 4, 1, 2, 5]));
    const { byKey, groups } = moveImpacts(diff, { evaluate: evaluator(spots, interlockedMatrix(6)) });
    assert.ok(byKey.get("5:1").minutes > 0);
    assert.deepEqual(groups.map((group) => group.keys), [["3:1", "4:1"]]);
});
