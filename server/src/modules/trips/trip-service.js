import { canonicalPlanHash } from "../../../../js/core/plan-hash.js";
import { summarizePlanRevision, validatePlanDocument } from "../../domain/plan-document.js";
import { ApiError } from "../../http/api-error.js";
import { withTransaction } from "../../infrastructure/postgres/transaction.js";

async function pruneRevisions(client, tripId) {
    await client.query(`DELETE FROM trip_revisions
        WHERE trip_id = $1
          AND revision NOT IN (
            SELECT revision FROM trip_revisions WHERE trip_id = $1 ORDER BY revision DESC LIMIT 100
          )
          AND revision <> (SELECT current_revision FROM trips WHERE id = $1)`, [tripId]);
}

export function createTripService({ database, config, now = () => new Date() }) {
    async function listTrips({ userId, archived }) {
        const result = await database.query(`SELECT id, title, created_at, updated_at, archived_at, current_revision, document_hash
            FROM trips WHERE owner_id = $1 AND deleted_at IS NULL
              AND (($2::boolean AND archived_at IS NOT NULL) OR (NOT $2::boolean AND archived_at IS NULL))
            ORDER BY updated_at DESC LIMIT 500`, [userId, archived]);
        return result.rows;
    }

    async function createTrip({ active, input }) {
        const document = validatePlanDocument(input.document, config);
        const hash = canonicalPlanHash(document);
        return withTransaction(database, async (client) => {
            const trip = await client.query(`INSERT INTO trips(owner_id, title, document, document_hash, current_revision)
                VALUES ($1, $2, $3, $4, 1) RETURNING id, title, current_revision, document_hash, created_at, updated_at`,
            [active.user_id, document.tripTitle, document, hash]);
            await client.query(`INSERT INTO trip_revisions(trip_id, revision, document, document_hash, actor_user_id, device_id, origin, summary)
                VALUES ($1, 1, $2, $3, $4, $5, 'create', $6)`, [
                trip.rows[0].id, document, hash, active.user_id,
                typeof input.deviceId === "string" ? input.deviceId.slice(0, 100) : null,
                summarizePlanRevision(null, document),
            ]);
            return trip.rows[0];
        });
    }

    async function getTrip({ userId, tripId }) {
        const result = await database.query(`SELECT id, title, document, document_hash, current_revision, archived_at, created_at, updated_at
            FROM trips WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`, [tripId, userId]);
        if (!result.rowCount) throw new ApiError(404, "TRIP_NOT_FOUND", "Viaje no encontrado");
        return result.rows[0];
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
        return withTransaction(database, async (client) => {
            const prior = await client.query(`SELECT result_revision, result_hash FROM trip_mutations
                WHERE trip_id = $1 AND client_mutation_id = $2 AND owner_id = $3`, [tripId, input.clientMutationId, active.user_id]);
            if (prior.rowCount) return { revision: Number(prior.rows[0].result_revision), hash: prior.rows[0].result_hash, idempotent: true };
            const currentResult = await client.query(`SELECT document, document_hash, current_revision FROM trips
                WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL FOR UPDATE`, [tripId, active.user_id]);
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
                    WHERE id = $5 AND owner_id = $6 AND current_revision = $7 RETURNING id`,
                [document, hash, document.tripTitle, revision, tripId, active.user_id, input.baseRevision]);
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
            await client.query(`INSERT INTO trip_mutations(trip_id, client_mutation_id, owner_id, base_revision, result_revision, result_hash)
                VALUES ($1, $2, $3, $4, $5, $6)`, [tripId, input.clientMutationId, active.user_id, input.baseRevision, revision, hash]);
            return { revision, hash, idempotent: false, noOp: current.document_hash === hash };
        });
    }

    async function updateTrip({ active, tripId, input }) {
        return withTransaction(database, async (client) => {
            const currentResult = await client.query(`SELECT document, document_hash, current_revision, archived_at FROM trips
                WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL FOR UPDATE`, [tripId, active.user_id]);
            if (!currentResult.rowCount) throw new ApiError(404, "TRIP_NOT_FOUND", "Viaje no encontrado");
            const current = currentResult.rows[0];
            let document = current.document;
            let revision = Number(current.current_revision);
            let hash = current.document_hash;
            if (typeof input.title === "string" && input.title.trim()) {
                document = validatePlanDocument({ ...document, tripTitle: input.title.trim().slice(0, 200) }, config);
                hash = canonicalPlanHash(document);
                if (hash !== current.document_hash) {
                    revision += 1;
                    await client.query(`INSERT INTO trip_revisions(trip_id, revision, document, document_hash, actor_user_id, origin, summary)
                        VALUES ($1, $2, $3, $4, $5, 'rename', $6)`, [tripId, revision, document, hash, active.user_id, summarizePlanRevision(current.document, document)]);
                }
            }
            const archivedAt = input.archived === true ? now() : input.archived === false ? null : current.archived_at;
            await client.query(`UPDATE trips SET document = $1, document_hash = $2, title = $3, current_revision = $4,
                archived_at = $5, updated_at = now() WHERE id = $6 AND owner_id = $7`,
            [document, hash, document.tripTitle, revision, archivedAt, tripId, active.user_id]);
            if (revision !== Number(current.current_revision)) await pruneRevisions(client, tripId);
            return { id: tripId, title: document.tripTitle, revision, hash, archivedAt };
        });
    }

    async function deleteTrip({ userId, tripId }) {
        const result = await database.query(`UPDATE trips SET deleted_at = COALESCE(deleted_at, now()), updated_at = now()
            WHERE id = $1 AND owner_id = $2 RETURNING id`, [tripId, userId]);
        return result.rowCount > 0;
    }

    async function listRevisions({ userId, tripId, before, limit }) {
        const result = await database.query(`SELECT r.revision, r.created_at, r.origin, r.device_id, r.summary,
                (r.revision = t.current_revision) AS current
            FROM trip_revisions r JOIN trips t ON t.id = r.trip_id
            WHERE r.trip_id = $1 AND t.owner_id = $2 AND t.deleted_at IS NULL AND r.revision < $3
            ORDER BY r.revision DESC LIMIT $4`, [tripId, userId, before, limit + 1]);
        const rows = result.rows.slice(0, limit);
        return { revisions: rows, nextBefore: result.rows.length > limit ? rows.at(-1).revision : null };
    }

    async function getRevision({ userId, tripId, revision }) {
        if (!Number.isInteger(revision) || revision < 1) throw new ApiError(404, "NOT_FOUND", "Ruta no encontrada");
        const result = await database.query(`SELECT r.revision, r.document, r.document_hash, r.created_at, r.origin, r.summary
            FROM trip_revisions r JOIN trips t ON t.id = r.trip_id
            WHERE r.trip_id = $1 AND r.revision = $2 AND t.owner_id = $3 AND t.deleted_at IS NULL`,
        [tripId, revision, userId]);
        if (!result.rowCount) throw new ApiError(404, "REVISION_NOT_FOUND", "Revisión no encontrada");
        return result.rows[0];
    }

    return { createTrip, deleteTrip, getRevision, getTrip, listRevisions, listTrips, mutateTrip, updateTrip };
}
