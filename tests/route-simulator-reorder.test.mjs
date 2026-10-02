import test from "node:test";
import assert from "node:assert/strict";
import { placementPhrase, reorderDiff } from "../js/features/route-simulator/reorder.js";

const steps = (...indexes) => indexes.map((spotIndex) => ({ spotIndex }));
const statuses = (diff) => diff.after.map((entry) => `${entry.key.split(":")[0]}:${entry.status}`);

test("bringing the last stop to the front moves only that stop", () => {
    const diff = reorderDiff(steps(0, 1, 2, 3, 4, 5), steps(5, 0, 1, 2, 3, 4));
    assert.equal(diff.movedCount, 1);
    assert.deepEqual(statuses(diff), ["5:moved", "0:stay", "1:stay", "2:stay", "3:stay", "4:stay"]);
    assert.deepEqual({ from: diff.after[0].from, to: diff.after[0].to }, { from: 5, to: 0 });
});

test("an unchanged order moves nothing", () => {
    assert.equal(reorderDiff(steps(0, 1, 2), steps(0, 1, 2)).movedCount, 0);
});

test("a plain swap keeps the earlier stop and moves the later one", () => {
    const diff = reorderDiff(steps(0, 1), steps(1, 0));
    assert.deepEqual(statuses(diff), ["1:moved", "0:stay"]);
});

test("an anchored stop wins the tie and stays", () => {
    const diff = reorderDiff(steps(0, 1), steps(1, 0), { anchored: (spotIndex) => spotIndex === 1 });
    assert.deepEqual(statuses(diff), ["1:stay", "0:moved"]);
});

test("dropped stops are not moves and do not shift the rest", () => {
    const diff = reorderDiff(steps(0, 1, 2, 3), steps(0, 2, 3));
    assert.equal(diff.movedCount, 0);
    assert.equal(diff.before[1].status, "dropped");
});

test("a return to the start is an added step, not a move", () => {
    const diff = reorderDiff(steps(0, 1, 2), steps(0, 2, 1, 0));
    assert.equal(diff.after[3].status, "added");
    assert.equal(diff.movedCount, 1);
});

test("placement is told against stops that stayed", () => {
    const names = ["Sensō-ji", "Kappabashi", "Akihabara", "Ueno"];
    const diff = reorderDiff(steps(0, 1, 2, 3), steps(3, 0, 1, 2));
    const nameAt = (index) => names[diff.after[index].key.split(":")[0]];
    assert.equal(placementPhrase(diff, 0, nameAt), "pasa al principio, antes de Sensō-ji");
    const middle = reorderDiff(steps(0, 1, 2, 3), steps(0, 2, 3, 1));
    const middleName = (index) => names[middle.after[index].key.split(":")[0]];
    assert.equal(placementPhrase(middle, 3, middleName), "pasa al final, después de Ueno");
    const between = reorderDiff(steps(0, 1, 2, 3), steps(0, 2, 1, 3));
    const betweenName = (index) => names[between.after[index].key.split(":")[0]];
    assert.equal(placementPhrase(between, 1, betweenName), "pasa entre Sensō-ji y Kappabashi");
});
