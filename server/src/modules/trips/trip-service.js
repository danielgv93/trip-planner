import { canonicalPlanHash } from "../../../../js/core/plan-hash.js";
import {
    applyPlanOperation,
    deriveTargetKeys,
    PlanOperationError,
    validatePlanOperation,
} from "../../../../js/core/plan-operations.js";
import { summarizePlanRevision, validatePlanDocument } from "../../domain/plan-document.js";
import { ApiError } from "../../http/api-error.js";
import { withTransaction } from "../../infrastructure/postgres/transaction.js";
import { SlidingWindowLimiter } from "../../security/session-security.js";
import { readTripAccess, requireTripRole, OWNER_ONLY, WRITERS } from "./trip-access.js";

// Collaborators are shown on every library card, so the summary travels with
// the trip list. Avatars deliberately do not: a profile picture is up to 500 KB
// and a card list can hold hundreds of trips. The dialog fetches them per trip.
const MEMBER_SUMMARY = `COALESCE((
    SELECT json_agg(json_build_object('userId', u.id, 'displayName', u.display_name, 'role', mm.role)
        ORDER BY CASE mm.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.display_name)
    FROM trip_members mm JOIN users u ON u.id = mm.user_id
    WHERE mm.trip_id = t.id
), '[]'::json) AS members`;
const LAST_MODIFIED_BY = `CASE WHEN revision_actor.id IS NULL THEN NULL ELSE
    json_build_object('userId', revision_actor.id, 'displayName', revision_actor.display_name)
END AS last_modified_by`;

async function pruneRevisions(client, tripId) {
    await client.query(`DELETE FROM trip_revisions
        WHERE trip_id = $1
          AND revision NOT IN (
            SELECT revision FROM trip_revisions WHERE trip_id = $1 ORDER BY revision DESC LIMIT 100
          )
          AND revision <> (SELECT current_revision FROM trips WHERE id = $1)`, [tripId]);
    await client.query(`DELETE FROM trip_mutations
        WHERE ctid IN (
            SELECT tm.ctid FROM trip_mutations tm
            JOIN trips t ON t.id = tm.trip_id
            WHERE tm.trip_id = $1
              AND tm.created_at < now() - interval '30 days'
              AND tm.result_revision <> t.current_revision
            ORDER BY tm.created_at
            LIMIT 250
        )`, [tripId]);
    await client.query(`DELETE FROM trip_presence
        WHERE ctid IN (
            SELECT ctid FROM trip_presence
            WHERE expires_at <= now()
            ORDER BY expires_at
            LIMIT 500
        )`);
}

export function createTripService({ database, config, events, logger = console, metrics = null }) {
    const operationLimiter = new SlidingWindowLimiter({
        limit: config.operationRateLimit || 240,
        windowMs: config.operationRateWindowMs || 60_000,
    });
    async function announceRevision(tripId, { revision, hash, active }) {
        try {
            const published = await events?.publish(tripId, {
                type: "revision",
                revision,
                hash,
                actor: { userId: active.user_id, displayName: active.display_name },
            });
            if (published === false) logger.warn?.(JSON.stringify({ event: "trip_revision_notification_missed", tripId, revision }));
        } catch (error) {
            logger.error?.(JSON.stringify({ event: "trip_revision_notification_failed", tripId, revision, reason: error.code || error.name }));
        }
    }

    async function announceOperation(tripId, { revision, hash, operation, targetKeys, active }) {
        try {
            const published = await events?.publish(tripId, {
                type: "operation",
                revision,
                hash,
                clientMutationId: operation.clientMutationId,
                deviceId: operation.deviceId,
                kind: operation.kind,
                targetKeys,
                actor: { userId: active.user_id, displayName: active.display_name },
            });
            if (published === false) logger.warn?.(JSON.stringify({ event: "trip_operation_notification_missed", tripId, revision }));
        } catch (error) {
            logger.error?.(JSON.stringify({ event: "trip_operation_notification_failed", tripId, revision, reason: error.code || error.name }));
        }
    }

    function assertGranularEnabled() {
        if (!config.granularSyncEnabled) {
            throw new ApiError(404, "GRANULAR_SYNC_DISABLED", "La colaboración granular no está habilitada");
        }
    }

    function validateOperationInput(input) {
        if (Buffer.byteLength(JSON.stringify(input)) > config.operationBodyLimitBytes) {
            throw new ApiError(413, "OPERATION_TOO_LARGE", "La operación supera el tamaño permitido");
        }
        try {
            return validatePlanOperation(input);
        } catch (error) {
            if (error instanceof PlanOperationError) {
                throw new ApiError(400, error.code, error.message, error.details);
            }
            throw error;
        }
    }

    async function listTrips({ userId, archived }) {
        const result = await database.query(`SELECT t.id, t.title, t.created_at, t.updated_at, t.owner_id,
                m.role, m.archived_at, t.current_revision, t.document_hash, t.sync_protocol_version,
                (s.trip_id IS NOT NULL) AS shared, ${MEMBER_SUMMARY}, ${LAST_MODIFIED_BY}
            FROM trips t
            JOIN trip_members m ON m.trip_id = t.id AND m.user_id = $1
            LEFT JOIN trip_shares s ON s.trip_id = t.id
            LEFT JOIN trip_revisions latest_revision
                ON latest_revision.trip_id = t.id AND latest_revision.revision = t.current_revision
            LEFT JOIN users revision_actor ON revision_actor.id = latest_revision.actor_user_id
            WHERE t.deleted_at IS NULL
              AND (($2::boolean AND m.archived_at IS NOT NULL) OR (NOT $2::boolean AND m.archived_at IS NULL))
            ORDER BY t.updated_at DESC LIMIT 500`, [userId, archived]);
        return result.rows;
    }

    async function createTrip({ active, input }) {
        const document = validatePlanDocument(input.document, config);
        const hash = canonicalPlanHash(document);
        return withTransaction(database, async (client) => {
            const trip = await client.query(`INSERT INTO trips(owner_id, title, document, document_hash, current_revision, sync_protocol_version)
                VALUES ($1, $2, $3, $4, 1, $5) RETURNING id, title, current_revision, document_hash, created_at, updated_at, owner_id, sync_protocol_version`,
            [active.user_id, document.tripTitle, document, hash, config.granularSyncEnabled ? config.granularProtocolVersion : 0]);
            // The owner is a member like everybody else. Every access check goes
            // through `trip_members`, so skipping this row would lock the
            // creator out of the trip they just made.
            await client.query("INSERT INTO trip_members(trip_id, user_id, role) VALUES ($1, $2, 'owner')",
                [trip.rows[0].id, active.user_id]);
            await client.query(`INSERT INTO trip_revisions(trip_id, revision, document, document_hash, actor_user_id, device_id, origin, summary)
                VALUES ($1, 1, $2, $3, $4, $5, 'create', $6)`, [
                trip.rows[0].id, document, hash, active.user_id,
                typeof input.deviceId === "string" ? input.deviceId.slice(0, 100) : null,
                summarizePlanRevision(null, document),
            ]);
            return {
                ...trip.rows[0],
                role: "owner",
                archived_at: null,
                last_modified_by: { userId: active.user_id, displayName: active.display_name || "Viajero" },
            };
        });
    }

    async function getTrip({ userId, tripId }) {
        const access = await readTripAccess(database, tripId, userId);
        const result = await database.query(`SELECT t.id, t.title, t.document, t.document_hash, t.current_revision, t.sync_protocol_version,
                t.created_at, t.updated_at, t.owner_id, m.archived_at,
                (s.trip_id IS NOT NULL) AS shared, ${MEMBER_SUMMARY}, ${LAST_MODIFIED_BY}
            FROM trips t
            JOIN trip_members m ON m.trip_id = t.id AND m.user_id = $2
            LEFT JOIN trip_shares s ON s.trip_id = t.id
            LEFT JOIN trip_revisions latest_revision
                ON latest_revision.trip_id = t.id AND latest_revision.revision = t.current_revision
            LEFT JOIN users revision_actor ON revision_actor.id = latest_revision.actor_user_id
            WHERE t.id = $1 AND t.deleted_at IS NULL`, [tripId, userId]);
        if (!result.rowCount) throw new ApiError(404, "TRIP_NOT_FOUND", "Viaje no encontrado");
        return { ...result.rows[0], role: access.role };
    }

    async function mutateTrip({ active, tripId, input }) {
        if (!Number.isInteger(input.baseRevision) || input.baseRevision < 1 || typeof input.clientMutationId !== "string") {
            throw new ApiError(400, "INVALID_MUTATION", "Mutación no válida");
        }
        const document = validatePlanDocument(input.document, config);
        const hash = canonicalPlanHash(document);
        if (typeof input.hash === "string" && input.hash !== hash) {
            throw new ApiError(400, "HASH_MISMATCH", "El hash del documento no coincide");
        }
        const result = await withTransaction(database, async (client) => {
            await requireTripRole(client, tripId, active.user_id, WRITERS);
            // Replaying a mutation returns its original result regardless of who
            // asks: the key is the trip plus the client mutation id.
            const prior = await client.query(`SELECT result_revision, result_hash FROM trip_mutations
                WHERE trip_id = $1 AND client_mutation_id = $2`, [tripId, input.clientMutationId]);
            if (prior.rowCount) return { revision: Number(prior.rows[0].result_revision), hash: prior.rows[0].result_hash, idempotent: true };
            const currentResult = await client.query(`SELECT document, document_hash, current_revision FROM trips
                WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [tripId]);
            if (!currentResult.rowCount) throw new ApiError(404, "TRIP_NOT_FOUND", "Viaje no encontrado");
            const current = currentResult.rows[0];
            if (Number(current.current_revision) !== input.baseRevision) {
                throw new ApiError(409, "REVISION_CONFLICT", "Existe una versión más reciente", { currentRevision: Number(current.current_revision) });
            }
            let revision = Number(current.current_revision);
            if (current.document_hash !== hash) {
                revision += 1;
                const updated = await client.query(`UPDATE trips SET document = $1, document_hash = $2, title = $3,
                        current_revision = $4, updated_at = now()
                    WHERE id = $5 AND current_revision = $6 RETURNING id`,
                [document, hash, document.tripTitle, revision, tripId, input.baseRevision]);
                if (!updated.rowCount) throw new ApiError(409, "REVISION_CONFLICT", "Existe una versión más reciente");
                await client.query(`INSERT INTO trip_revisions(trip_id, revision, document, document_hash, actor_user_id, device_id, origin, summary)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
                    tripId, revision, document, hash, active.user_id,
                    typeof input.deviceId === "string" ? input.deviceId.slice(0, 100) : null,
                    input.origin === "restore" ? "restore" : "user",
                    summarizePlanRevision(current.document, document),
                ]);
                await pruneRevisions(client, tripId);
            }
            await client.query(`INSERT INTO trip_mutations(trip_id, client_mutation_id, actor_user_id, base_revision, result_revision, result_hash)
                VALUES ($1, $2, $3, $4, $5, $6)`, [tripId, input.clientMutationId, active.user_id, input.baseRevision, revision, hash]);
            return { revision, hash, idempotent: false, noOp: current.document_hash === hash };
        });
        if (!result.noOp && !result.idempotent) await announceRevision(tripId, { revision: result.revision, hash: result.hash, active });
        return result;
    }

    async function activateTripOperations({ active, tripId, input }) {
        assertGranularEnabled();
        if (input.legacyOutboxEmpty !== true || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
            throw new ApiError(400, "INVALID_ACTIVATION", "No se puede activar el protocolo todavía");
        }
        return withTransaction(database, async (client) => {
            await requireTripRole(client, tripId, active.user_id, WRITERS);
            const current = await client.query(`SELECT current_revision, sync_protocol_version FROM trips
                WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [tripId]);
            if (!current.rowCount) throw new ApiError(404, "TRIP_NOT_FOUND", "Viaje no encontrado");
            if (Number(current.rows[0].current_revision) !== input.expectedRevision) {
                throw new ApiError(409, "REVISION_CONFLICT", "Existe una versión más reciente", {
                    currentRevision: Number(current.rows[0].current_revision),
                });
            }
            if (Number(current.rows[0].sync_protocol_version) < config.granularProtocolVersion) {
                await client.query("UPDATE trips SET sync_protocol_version = $2 WHERE id = $1", [tripId, config.granularProtocolVersion]);
            }
            return { protocolVersion: config.granularProtocolVersion, revision: input.expectedRevision };
        });
    }

    async function mutateTripOperation({ active, tripId, input }) {
        const startedAt = Date.now();
        assertGranularEnabled();
        const operation = validateOperationInput(input);
        if (!operationLimiter.take(`${active.user_id}:${tripId}`)) {
            throw new ApiError(429, "OPERATION_RATE_LIMIT", "Demasiadas operaciones; vuelve a intentarlo en unos segundos", {
                retryAfterMs: config.operationRateWindowMs || 60_000,
            });
        }
        const outcome = await withTransaction(database, async (client) => {
            await requireTripRole(client, tripId, active.user_id, WRITERS);
            const currentResult = await client.query(`SELECT document, document_hash, current_revision, sync_protocol_version
                FROM trips WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [tripId]);
            if (!currentResult.rowCount) throw new ApiError(404, "TRIP_NOT_FOUND", "Viaje no encontrado");
            const current = currentResult.rows[0];
            if (Number(current.sync_protocol_version) < operation.protocolVersion) {
                throw new ApiError(409, "GRANULAR_TRIP_NOT_ENABLED", "Este viaje todavía usa sincronización compatible");
            }

            const prior = await client.query(`SELECT result_kind, result, result_revision, result_hash FROM trip_mutations
                WHERE trip_id = $1 AND client_mutation_id = $2`, [tripId, operation.clientMutationId]);
            if (prior.rowCount) {
                const previousBody = prior.rows[0].result || {
                    status: "accepted",
                    revision: Number(prior.rows[0].result_revision),
                    hash: prior.rows[0].result_hash,
                    clientMutationId: operation.clientMutationId,
                    noOp: false,
                };
                return {
                    statusCode: prior.rows[0].result_kind === "conflict" ? 409 : 200,
                    body: { ...previousBody, idempotent: true },
                    announce: false,
                };
            }

            const currentRevision = Number(current.current_revision);
            const targetKeys = deriveTargetKeys(operation, current.document);
            let applied;
            try {
                applied = applyPlanOperation(current.document, operation, { currentRevision });
            } catch (error) {
                if (!(error instanceof PlanOperationError)) throw error;
                if (["INVALID_OPERATION", "UNSUPPORTED_OPERATION_VERSION"].includes(error.code)) {
                    throw new ApiError(400, error.code, error.message, error.details);
                }
                const body = {
                    status: "conflict",
                    error: {
                        code: error.code,
                        message: error.message,
                        target: error.target,
                        currentRevision,
                        ...(error.details || {}),
                    },
                };
                await client.query(`INSERT INTO trip_mutations(
                        trip_id, client_mutation_id, actor_user_id, base_revision,
                        result_revision, result_hash, protocol_version, operation_kind,
                        target_keys, operation, result_kind, result
                    ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, 'conflict', $10)`, [
                    tripId, operation.clientMutationId, active.user_id, operation.baseRevision,
                    currentRevision, current.document_hash, operation.kind, JSON.stringify(targetKeys), operation, body,
                ]);
                return { statusCode: 409, body: { ...body, idempotent: false }, announce: false, targetKeys, conflictCode: error.code, rebased: operation.baseRevision < currentRevision };
            }

            if (applied.noOp) {
                const body = {
                    status: "no-op",
                    revision: currentRevision,
                    hash: current.document_hash,
                    clientMutationId: operation.clientMutationId,
                    noOp: true,
                    idempotent: false,
                    targetKeys,
                };
                await client.query(`INSERT INTO trip_mutations(
                        trip_id, client_mutation_id, actor_user_id, base_revision,
                        result_revision, result_hash, protocol_version, operation_kind,
                        target_keys, operation, result_kind, result
                    ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, 'no-op', $10)`, [
                    tripId, operation.clientMutationId, active.user_id, operation.baseRevision,
                    currentRevision, current.document_hash, operation.kind, JSON.stringify(targetKeys), operation, body,
                ]);
                return { statusCode: 200, body, announce: false, targetKeys, rebased: operation.baseRevision < currentRevision };
            }

            const document = validatePlanDocument(applied.document, config);
            const hash = canonicalPlanHash(document);
            const revision = currentRevision + 1;
            await client.query(`UPDATE trips SET document = $1, document_hash = $2, title = $3,
                    current_revision = $4, updated_at = now()
                WHERE id = $5`, [document, hash, document.tripTitle, revision, tripId]);
            await client.query(`INSERT INTO trip_revisions(
                    trip_id, revision, document, document_hash, actor_user_id, device_id,
                    origin, summary, protocol_version, client_mutation_id, operation_kind,
                    target_keys, operation
                ) VALUES ($1, $2, $3, $4, $5, $6, 'operation', $7, 1, $8, $9, $10, $11)`, [
                tripId, revision, document, hash, active.user_id, operation.deviceId,
                summarizePlanRevision(current.document, document), operation.clientMutationId,
                operation.kind, JSON.stringify(targetKeys), operation,
            ]);
            const body = {
                status: "accepted",
                revision,
                hash,
                clientMutationId: operation.clientMutationId,
                noOp: false,
                idempotent: false,
                targetKeys,
            };
            await client.query(`INSERT INTO trip_mutations(
                    trip_id, client_mutation_id, actor_user_id, base_revision,
                    result_revision, result_hash, protocol_version, operation_kind,
                    target_keys, operation, result_kind, result
                ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, 'accepted', $10)`, [
                tripId, operation.clientMutationId, active.user_id, operation.baseRevision,
                revision, hash, operation.kind, JSON.stringify(targetKeys), operation, body,
            ]);
            await pruneRevisions(client, tripId);
            return { statusCode: 200, body, announce: true, revision, hash, targetKeys, rebased: operation.baseRevision < currentRevision };
        });
        if (outcome.announce) {
            await announceOperation(tripId, {
                revision: outcome.revision,
                hash: outcome.hash,
                operation,
                targetKeys: outcome.targetKeys,
                active,
            });
        }
        const durationMs = Date.now() - startedAt;
        metrics?.observeOperation({
            durationMs,
            conflict: outcome.statusCode === 409,
            rebased: outcome.rebased === true && outcome.statusCode !== 409,
        });
        logger.info?.(JSON.stringify({
            event: "trip_operation",
            tripId,
            clientMutationId: operation.clientMutationId,
            kind: operation.kind,
            targetKeyCount: outcome.targetKeys?.length || 0,
            revision: Number(outcome.body?.revision || outcome.body?.error?.currentRevision) || null,
            result: outcome.statusCode === 409 ? "conflict" : outcome.body?.status,
            conflictCode: outcome.conflictCode || null,
            rebased: outcome.rebased === true,
            durationMs,
        }));
        return outcome;
    }

    async function catchUpOperations({ userId, tripId, after, limit }) {
        const startedAt = Date.now();
        assertGranularEnabled();
        if (!Number.isInteger(after) || after < 0) throw new ApiError(400, "INVALID_CURSOR", "Cursor no válido");
        const boundedLimit = Math.min(config.operationCatchupLimit, Math.max(1, Number(limit) || config.operationCatchupLimit));
        await readTripAccess(database, tripId, userId);
        const trip = await database.query(`SELECT current_revision, document_hash, sync_protocol_version
            FROM trips WHERE id = $1 AND deleted_at IS NULL`, [tripId]);
        if (!trip.rowCount) throw new ApiError(404, "TRIP_NOT_FOUND", "Viaje no encontrado");
        const currentRevision = Number(trip.rows[0].current_revision);
        const base = {
            currentRevision,
            hash: trip.rows[0].document_hash,
            nextCursor: Math.min(after, currentRevision),
        };
        const finish = (result) => {
            metrics?.observeCatchup({ operationCount: result.operations?.length || 0, snapshotFallback: result.snapshotRequired });
            logger.info?.(JSON.stringify({
                event: "trip_operation_catchup", tripId, after,
                operationCount: result.operations?.length || 0,
                snapshotRequired: result.snapshotRequired === true,
                durationMs: Date.now() - startedAt,
            }));
            return result;
        };
        if (Number(trip.rows[0].sync_protocol_version) < 1) return finish({ ...base, snapshotRequired: true, operations: [] });
        if (after >= currentRevision) return finish({ ...base, snapshotRequired: false, nextCursor: currentRevision, operations: [] });
        const revisions = await database.query(`SELECT r.revision, r.document_hash, r.protocol_version,
                r.client_mutation_id, r.operation_kind, r.target_keys, r.operation,
                r.device_id, r.actor_user_id, u.display_name AS actor_display_name
            FROM trip_revisions r
            LEFT JOIN users u ON u.id = r.actor_user_id
            WHERE r.trip_id = $1 AND r.revision > $2
            ORDER BY r.revision ASC LIMIT $3`, [tripId, after, boundedLimit + 1]);
        const rows = revisions.rows;
        let expected = after + 1;
        for (const row of rows) {
            if (Number(row.revision) !== expected || Number(row.protocol_version) !== 1 || !row.operation) {
                return finish({ ...base, snapshotRequired: true, operations: [] });
            }
            expected += 1;
        }
        if (!rows.length) return finish({ ...base, snapshotRequired: true, operations: [] });
        const selected = rows.slice(0, boundedLimit);
        return finish({
            ...base,
            snapshotRequired: false,
            nextCursor: Number(selected.at(-1).revision),
            hasMore: rows.length > boundedLimit || Number(selected.at(-1).revision) < currentRevision,
            operations: selected.map((row) => ({
                revision: Number(row.revision),
                hash: row.document_hash,
                clientMutationId: row.client_mutation_id,
                deviceId: row.device_id,
                kind: row.operation_kind,
                targetKeys: row.target_keys,
                operation: row.operation,
                actor: row.actor_user_id
                    ? { userId: row.actor_user_id, displayName: row.actor_display_name || "" }
                    : null,
            })),
        });
    }

    async function updateTrip({ active, tripId, input }) {
        const result = await withTransaction(database, async (client) => {
            const access = await readTripAccess(client, tripId, active.user_id);
            const currentResult = await client.query(`SELECT document, document_hash, current_revision FROM trips
                WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [tripId]);
            if (!currentResult.rowCount) throw new ApiError(404, "TRIP_NOT_FOUND", "Viaje no encontrado");
            const current = currentResult.rows[0];
            let document = current.document;
            let revision = Number(current.current_revision);
            let hash = current.document_hash;
            if (typeof input.title === "string" && input.title.trim()) {
                if (!WRITERS.includes(access.role)) {
                    throw new ApiError(403, "TRIP_FORBIDDEN", "No tienes permiso para hacer esto en este viaje");
                }
                document = validatePlanDocument({ ...document, tripTitle: input.title.trim().slice(0, 200) }, config);
                hash = canonicalPlanHash(document);
                if (hash !== current.document_hash) {
                    revision += 1;
                    await client.query(`INSERT INTO trip_revisions(trip_id, revision, document, document_hash, actor_user_id, origin, summary)
                        VALUES ($1, $2, $3, $4, $5, 'rename', $6)`, [tripId, revision, document, hash, active.user_id, summarizePlanRevision(current.document, document)]);
                    await client.query(`UPDATE trips SET document = $1, document_hash = $2, title = $3,
                        current_revision = $4, updated_at = now() WHERE id = $5`, [document, hash, document.tripTitle, revision, tripId]);
                    await pruneRevisions(client, tripId);
                }
            }
            // Archiving is scoped to the caller's own membership: a viewer may
            // tidy their library without touching anybody else's.
            let archivedAt = null;
            if (input.archived === true || input.archived === false) {
                const member = await client.query(`UPDATE trip_members SET archived_at = CASE WHEN $3 THEN now() ELSE NULL END
                    WHERE trip_id = $1 AND user_id = $2 RETURNING archived_at`, [tripId, active.user_id, input.archived === true]);
                archivedAt = member.rows[0]?.archived_at || null;
            } else {
                const member = await client.query("SELECT archived_at FROM trip_members WHERE trip_id = $1 AND user_id = $2",
                    [tripId, active.user_id]);
                archivedAt = member.rows[0]?.archived_at || null;
            }
            return { id: tripId, title: document.tripTitle, revision, hash, archivedAt, renamed: revision !== Number(current.current_revision) };
        });
        if (result.renamed) await announceRevision(tripId, { revision: result.revision, hash: result.hash, active });
        return result;
    }

    // Only the owner destroys a trip. A collaborator who wants out leaves it,
    // which removes their membership and nothing else.
    async function deleteTrip({ active, tripId }) {
        await requireTripRole(database, tripId, active.user_id, OWNER_ONLY);
        const result = await database.query(`UPDATE trips SET deleted_at = COALESCE(deleted_at, now()), updated_at = now()
            WHERE id = $1 AND owner_id = $2 RETURNING id`, [tripId, active.user_id]);
        if (result.rowCount) events?.publish(tripId, { type: "trip-deleted" });
        return result.rowCount > 0;
    }

    async function listRevisions({ userId, tripId, before, limit }) {
        await readTripAccess(database, tripId, userId);
        const result = await database.query(`SELECT r.revision, r.created_at, r.origin, r.device_id, r.summary,
                r.protocol_version, r.operation_kind, r.target_keys,
                r.document, previous.document AS previous_document,
                r.actor_user_id, u.display_name AS actor_display_name,
                (r.revision = t.current_revision) AS current
            FROM trip_revisions r
            JOIN trips t ON t.id = r.trip_id
            LEFT JOIN users u ON u.id = r.actor_user_id
            LEFT JOIN LATERAL (
                SELECT prior.document FROM trip_revisions prior
                WHERE prior.trip_id = r.trip_id AND prior.revision < r.revision
                ORDER BY prior.revision DESC LIMIT 1
            ) previous ON true
            WHERE r.trip_id = $1 AND r.revision < $2
            ORDER BY r.revision DESC LIMIT $3`, [tripId, before, limit + 1]);
        const rows = result.rows.slice(0, limit).map((row) => {
            const { document, previous_document: previousDocument, ...metadata } = row;
            return {
                ...metadata,
                summary: previousDocument || Number(row.revision) === 1
                    ? summarizePlanRevision(previousDocument, document)
                    : row.summary,
            };
        });
        return { revisions: rows, nextBefore: result.rows.length > limit ? rows.at(-1).revision : null };
    }

    async function getRevision({ userId, tripId, revision }) {
        if (!Number.isInteger(revision) || revision < 1) throw new ApiError(404, "NOT_FOUND", "Ruta no encontrada");
        await readTripAccess(database, tripId, userId);
        const result = await database.query(`SELECT r.revision, r.document, r.document_hash, r.created_at, r.origin, r.summary,
                r.protocol_version, r.operation_kind, r.target_keys,
                r.actor_user_id, u.display_name AS actor_display_name
            FROM trip_revisions r
            LEFT JOIN users u ON u.id = r.actor_user_id
            WHERE r.trip_id = $1 AND r.revision = $2`, [tripId, revision]);
        if (!result.rowCount) throw new ApiError(404, "REVISION_NOT_FOUND", "Revisión no encontrada");
        return result.rows[0];
    }

    return {
        activateTripOperations,
        catchUpOperations,
        createTrip,
        deleteTrip,
        getRevision,
        getTrip,
        listRevisions,
        listTrips,
        mutateTrip,
        mutateTripOperation,
        updateTrip,
    };
}
