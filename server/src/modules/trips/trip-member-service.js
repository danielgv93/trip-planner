import { ApiError } from "../../http/api-error.js";
import { withTransaction } from "../../infrastructure/postgres/transaction.js";
import { normalizeEmail, SlidingWindowLimiter } from "../../security/session-security.js";
import { ASSIGNABLE_ROLES, assertUserId, OWNER_ONLY, readTripAccess, requireTripRole } from "./trip-access.js";

export const TRIP_MEMBER_LIMIT = 20;

const MEMBER_ORDER = "ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.display_name";

export function createTripMemberService({ database, events }) {
    // Inviting by address inevitably tells the owner whether an account exists;
    // that is the flow they asked for. The limiter is what stops the endpoint
    // from becoming a bulk enumeration oracle.
    const inviteLimiter = new SlidingWindowLimiter({ limit: 20, windowMs: 3_600_000 });

    function announceMembers(tripId) {
        events?.publish(tripId, { type: "members" });
    }

    function presentMember(row, { includeEmail }) {
        return {
            userId: row.user_id,
            role: row.role,
            displayName: row.display_name,
            avatarDataUrl: row.avatar_data_url || null,
            // Only the owner manages the list, and only they need an email to
            // tell two collaborators with the same display name apart.
            ...(includeEmail ? { email: row.email } : {}),
            createdAt: row.created_at,
        };
    }

    async function listMembers({ userId, tripId }) {
        const access = await readTripAccess(database, tripId, userId);
        const result = await database.query(`SELECT m.user_id, m.role, m.created_at,
                u.display_name, u.avatar_data_url, u.email
            FROM trip_members m JOIN users u ON u.id = m.user_id
            WHERE m.trip_id = $1 ${MEMBER_ORDER}`, [tripId]);
        return {
            role: access.role,
            ownerId: access.ownerId,
            members: result.rows.map((row) => presentMember(row, { includeEmail: access.role === "owner" })),
        };
    }

    async function inviteMember({ active, tripId, input }) {
        const role = ASSIGNABLE_ROLES.includes(input?.role) ? input.role : "editor";
        const email = normalizeEmail(input?.email);
        if (!email || email.length > 320 || !email.includes("@")) {
            throw new ApiError(400, "INVALID_EMAIL", "Escribe un correo electrónico válido");
        }
        await requireTripRole(database, tripId, active.user_id, OWNER_ONLY);
        if (!inviteLimiter.take(active.user_id)) {
            throw new ApiError(429, "TOO_MANY_REQUESTS", "Demasiadas invitaciones seguidas. Inténtalo más tarde.");
        }
        const member = await withTransaction(database, async (client) => {
            const invitee = await client.query(`SELECT id, email, display_name, avatar_data_url FROM users
                WHERE email_normalized = $1 AND deletion_requested_at IS NULL`, [email]);
            if (!invitee.rowCount) {
                throw new ApiError(404, "ACCOUNT_NOT_FOUND", "No hay ninguna cuenta registrada con ese correo");
            }
            const user = invitee.rows[0];
            if (user.id === active.user_id) {
                throw new ApiError(409, "ALREADY_MEMBER", "Ya eres el propietario de este viaje");
            }
            const total = await client.query("SELECT count(*)::int AS total FROM trip_members WHERE trip_id = $1", [tripId]);
            if (total.rows[0].total >= TRIP_MEMBER_LIMIT) {
                throw new ApiError(409, "MEMBER_LIMIT", `Un viaje admite como máximo ${TRIP_MEMBER_LIMIT} personas`);
            }
            const inserted = await client.query(`INSERT INTO trip_members(trip_id, user_id, role, invited_by)
                VALUES ($1, $2, $3, $4) ON CONFLICT (trip_id, user_id) DO NOTHING
                RETURNING user_id, role, created_at`, [tripId, user.id, role, active.user_id]);
            if (!inserted.rowCount) {
                throw new ApiError(409, "ALREADY_MEMBER", "Esta persona ya colabora en el viaje");
            }
            return presentMember({
                ...inserted.rows[0],
                display_name: user.display_name,
                avatar_data_url: user.avatar_data_url,
                email: user.email,
            }, { includeEmail: true });
        });
        announceMembers(tripId);
        return member;
    }

    async function updateMemberRole({ active, tripId, memberId, input }) {
        assertUserId(memberId);
        if (!ASSIGNABLE_ROLES.includes(input?.role)) {
            throw new ApiError(400, "INVALID_ROLE", "El rol debe ser editor o lector");
        }
        await requireTripRole(database, tripId, active.user_id, OWNER_ONLY);
        // The owner row is the mirror of `trips.owner_id`; demoting it here
        // would leave the trip with no owner and nobody able to delete it.
        if (memberId === active.user_id) {
            throw new ApiError(409, "OWNER_ROLE_LOCKED", "El propietario no puede cambiar su propio rol");
        }
        const result = await database.query(`UPDATE trip_members SET role = $3
            WHERE trip_id = $1 AND user_id = $2 AND role <> 'owner'
            RETURNING user_id, role`, [tripId, memberId, input.role]);
        if (!result.rowCount) throw new ApiError(404, "MEMBER_NOT_FOUND", "Esta persona ya no colabora en el viaje");
        announceMembers(tripId);
        return { userId: result.rows[0].user_id, role: result.rows[0].role };
    }

    async function removeMember({ active, tripId, memberId }) {
        assertUserId(memberId);
        await requireTripRole(database, tripId, active.user_id, OWNER_ONLY);
        const result = await database.query(`DELETE FROM trip_members
            WHERE trip_id = $1 AND user_id = $2 AND role <> 'owner' RETURNING user_id`, [tripId, memberId]);
        if (!result.rowCount) throw new ApiError(404, "MEMBER_NOT_FOUND", "Esta persona ya no colabora en el viaje");
        events?.publish(tripId, { type: "access-revoked", userId: memberId });
        announceMembers(tripId);
        return { removed: true };
    }

    // The owner cannot leave: their membership mirrors `trips.owner_id` and the
    // trip would be left with no one able to delete it. They delete it instead.
    async function leaveTrip({ active, tripId }) {
        const access = await readTripAccess(database, tripId, active.user_id);
        if (access.role === "owner") {
            throw new ApiError(409, "OWNER_CANNOT_LEAVE", "Eres el propietario: elimina el viaje o traspásalo antes de salir");
        }
        await database.query("DELETE FROM trip_members WHERE trip_id = $1 AND user_id = $2", [tripId, active.user_id]);
        events?.publish(tripId, { type: "access-revoked", userId: active.user_id });
        announceMembers(tripId);
        return { left: true };
    }

    return { inviteMember, leaveTrip, listMembers, removeMember, updateMemberRole };
}
