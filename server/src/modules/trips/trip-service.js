import { canonicalPlanHash } from "../../../../js/core/plan-hash.js";
import { summarizePlanRevision, validatePlanDocument } from "../../domain/plan-document.js";
import { ApiError } from "../../http/api-error.js";
import { withTransaction } from "../../infrastructure/postgres/transaction.js";
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

async function pruneRevisions(client, tripId) {
    await client.query(`DELETE FROM trip_revisions
        WHERE trip_id = $1
          AND revision NOT IN (
            SELECT revision FROM trip_revisions WHERE trip_id = $1 ORDER BY revision DESC LIMIT 100
          )
          AND revision <> (SELECT current_revision FROM trips WHERE id = $1)`, [tripId]);
}

export function createTripService({ database, config, events }) {
    function announceRevision(tripId, { revision, hash, active }) {
        events?.publish(tripId, {
            type: "revision",
            revision,
            hash,
            actor: { userId: active.user_id, displayName: active.display_name },
        });
    }

    async function listTrips({ userId, archived }) {
        const result = await database.query(`SELECT t.id, t.title, t.created_at, t.updated_at, t.owner_id,
                m.role, m.archived_at, t.current_revision, t.document_hash,
                (s.trip_id IS NOT NULL) AS shared, ${MEMBER_SUMMARY}
            FROM trips t
            JOIN trip_members m ON m.trip_id = t.id AND m.user_id = $1
            LEFT JOIN trip_shares s ON s.trip_id = t.id
            WHERE t.deleted_at IS NULL
              AND (($2::boolean AND m.archived_at IS NOT NULL) OR (NOT $2::boolean AND m.archived_at IS NULL))
            ORDER BY t.updated_at DESC LIMIT 500`, [userId, archived]);
        return result.rows;
    }

    async function createTrip({ active, input }) {
        const document = validatePlanDocument(input.document, config);
        const hash = canonicalPlanHash(document);
        return withTransaction(database, async (client) => {
            const trip = await client.query(`INSERT INTO trips(owner_id, title, document, document_hash, current_revision)
                VALUES ($1, $2, $3, $4, 1) RETURNING id, title, current_revision, document_hash, created_at, updated_at, owner_id`,
            [active.user_id, document.tripTitle, document, hash]);
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
            return { ...trip.rows[0], role: "owner", archived_at: null };
        });
    }

    async function getTrip({ userId, tripId }) {
        const access = await readTripAccess(database, tripId, userId);
        const result = await database.query(`SELECT t.id, t.title, t.document, t.document_hash, t.current_revision,
                t.created_at, t.updated_at, t.owner_id, m.archived_at,
                (s.trip_id IS NOT NULL) AS shared, ${MEMBER_SUMMARY}
            FROM trips t
            JOIN trip_members m ON m.trip_id = t.id AND m.user_id = $2
            LEFT JOIN trip_shares s ON s.trip_id = t.id
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
        if (!result.noOp && !result.idempotent) announceRevision(tripId, { revision: result.revision, hash: result.hash, active });
        return result;
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
        if (result.renamed) announceRevision(tripId, { revision: result.revision, hash: result.hash, active });
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
                r.actor_user_id, u.display_name AS actor_display_name
            FROM trip_revisions r
            LEFT JOIN users u ON u.id = r.actor_user_id
            WHERE r.trip_id = $1 AND r.revision = $2`, [tripId, revision]);
        if (!result.rowCount) throw new ApiError(404, "REVISION_NOT_FOUND", "Revisión no encontrada");
        return result.rows[0];
    }

    return { createTrip, deleteTrip, getRevision, getTrip, listRevisions, listTrips, mutateTrip, updateTrip };
}
