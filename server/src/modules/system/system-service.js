export function createSystemService({ database, config, metrics }) {
    return {
        async health() {
            const databaseHealth = config.cloudEnabled ? await database.health() : { ok: true, disabled: true };
            return {
                ok: true,
                cloudEnabled: config.cloudEnabled,
                capabilities: {
                    liveCollaboration: {
                        enabled: Boolean(config.granularSyncEnabled),
                        protocolVersion: config.granularSyncEnabled
                            ? config.granularProtocolVersion
                            : null,
                    },
                },
                database: databaseHealth,
            };
        },
        metrics() {
            return metrics.snapshot();
        },
        updateQueueDepth(depth) {
            metrics.setQueueDepth(Math.min(100_000, Math.max(0, Number(depth) || 0)));
        },
    };
}
