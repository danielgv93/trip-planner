export const LIVE_COLLABORATION_PROTOCOL_VERSION = 1;

export function collaborationMode({
    clientProtocolVersion = 0,
    serverCapability,
    tripProtocolVersion = 0,
    hasLegacyOutbox = false,
} = {}) {
    const serverVersion = serverCapability?.enabled
        ? Number(serverCapability.protocolVersion) || 0
        : 0;
    if (
        hasLegacyOutbox ||
        clientProtocolVersion < LIVE_COLLABORATION_PROTOCOL_VERSION ||
        serverVersion < LIVE_COLLABORATION_PROTOCOL_VERSION ||
        tripProtocolVersion < LIVE_COLLABORATION_PROTOCOL_VERSION
    ) return "snapshot";
    return "granular";
}
