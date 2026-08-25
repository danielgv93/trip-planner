import test from "node:test";
import assert from "node:assert/strict";

import {
    collaborationMode,
    LIVE_COLLABORATION_PROTOCOL_VERSION,
} from "../js/features/cloud/protocol-capability.js";

const enabled = { enabled: true, protocolVersion: 1 };

test("granularidad exige cliente, servidor y viaje v1 sin outbox legacy", () => {
    assert.equal(collaborationMode({
        clientProtocolVersion: LIVE_COLLABORATION_PROTOCOL_VERSION,
        serverCapability: enabled,
        tripProtocolVersion: 1,
    }), "granular");
    assert.equal(collaborationMode({
        clientProtocolVersion: 1,
        serverCapability: enabled,
        tripProtocolVersion: 1,
        hasLegacyOutbox: true,
    }), "snapshot");
});

test("cualquier combinación legacy cae de forma segura al snapshot", () => {
    assert.equal(collaborationMode({ serverCapability: enabled, tripProtocolVersion: 1 }), "snapshot");
    assert.equal(collaborationMode({ clientProtocolVersion: 1, tripProtocolVersion: 1 }), "snapshot");
    assert.equal(collaborationMode({ clientProtocolVersion: 1, serverCapability: enabled }), "snapshot");
    assert.equal(collaborationMode(), "snapshot");
});
