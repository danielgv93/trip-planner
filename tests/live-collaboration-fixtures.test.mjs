import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const fixtureUrl = new URL("./fixtures/live-collaboration-v1.json", import.meta.url);

test("los fixtures v1 fijan sobres, resultados y target keys compatibles", async () => {
    const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));

    assert.equal(fixture.fixtureVersion, 1);
    assert.equal(fixture.operation.protocolVersion, 1);
    assert.equal(fixture.operation.clientMutationId, fixture.responses.accepted.clientMutationId);
    assert.deepEqual(fixture.responses.accepted.targetKeys, fixture.targetKeys);
    assert.deepEqual(fixture.responses.noOp.targetKeys, fixture.targetKeys);
    assert.equal(fixture.responses.conflict.error.code, "TARGET_CONFLICT");
});

test("el evento de operación contiene metadatos acotados y ningún valor sensible", async () => {
    const { event } = JSON.parse(await readFile(fixtureUrl, "utf8"));
    assert.deepEqual(Object.keys(event).sort(), [
        "actor",
        "clientMutationId",
        "deviceId",
        "hash",
        "kind",
        "revision",
        "targetKeys",
        "type",
    ]);
    assert.deepEqual(Object.keys(event.actor).sort(), ["displayName", "userId"]);
    const encoded = JSON.stringify(event).toLowerCase();
    for (const forbidden of ["document", "payload", "precondition", "email", "cookie", "token", "currentvalue", "value"]) {
        assert.equal(encoded.includes(`\"${forbidden}\"`), false, `el evento no debe incluir ${forbidden}`);
    }
});
