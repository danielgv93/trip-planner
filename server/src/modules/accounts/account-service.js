import { ApiError } from "../../http/api-error.js";
import { withTransaction } from "../../infrastructure/postgres/transaction.js";
import { passwordHash, secretHash, verifyPassword } from "../../security/session-security.js";

const AVATAR_PATTERN = /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+$/i;
export const AVATAR_MAX_BYTES = 500_000;
const AVATAR_MAX_DATA_URL_LENGTH = 666_700;

function avatarByteLength(dataUrl) {
    const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    return Math.floor(encoded.length * 3 / 4) - padding;
}

function validPassword(value) {
    return typeof value === "string" && value.length >= 10 && value.length <= 128;
}

export function createAccountService({ database, now = () => new Date() }) {
    return {
        async exportAccount(active) {
            const result = await database.query(`SELECT id, title, document, current_revision, archived_at, created_at, updated_at
                FROM trips WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY created_at`, [active.user_id]);
            return {
                version: 1,
                exportedAt: now().toISOString(),
                account: { email: active.email, displayName: active.display_name || "", avatarDataUrl: active.avatar_data_url || null },
                trips: result.rows,
            };
        },

        async updateProfile(active, profile) {
            const displayName = typeof profile?.displayName === "string" ? profile.displayName.trim() : "";
            const avatarDataUrl = profile?.avatarDataUrl === null ? null : profile?.avatarDataUrl;
            if (!displayName || displayName.length > 80) {
                throw new ApiError(400, "INVALID_PROFILE", "El nombre debe tener entre 1 y 80 caracteres");
            }
            if (avatarDataUrl !== null && (typeof avatarDataUrl !== "string" || avatarDataUrl.length > AVATAR_MAX_DATA_URL_LENGTH || !AVATAR_PATTERN.test(avatarDataUrl) || avatarByteLength(avatarDataUrl) > AVATAR_MAX_BYTES)) {
                throw new ApiError(400, "INVALID_AVATAR", "La foto de perfil no es válida o es demasiado grande");
            }
            const result = await database.query(`UPDATE users SET display_name = $2, avatar_data_url = $3
                WHERE id = $1 RETURNING id, email, display_name, avatar_data_url`, [active.user_id, displayName, avatarDataUrl]);
            const user = result.rows[0];
            return { id: user.id, email: user.email, displayName: user.display_name, avatarDataUrl: user.avatar_data_url };
        },

        async changePassword(active, input) {
            const currentPassword = typeof input?.currentPassword === "string" && input.currentPassword.length <= 128 ? input.currentPassword : "";
            if (!validPassword(input?.newPassword)) {
                throw new ApiError(400, "INVALID_PASSWORD", "La nueva contraseña debe tener entre 10 y 128 caracteres");
            }
            if (currentPassword === input.newPassword) {
                throw new ApiError(400, "PASSWORD_UNCHANGED", "La nueva contraseña debe ser diferente de la actual");
            }
            const result = await database.query("SELECT password_hash FROM users WHERE id = $1", [active.user_id]);
            if (!result.rows[0]?.password_hash || !(await verifyPassword(currentPassword, result.rows[0].password_hash))) {
                throw new ApiError(401, "INVALID_CREDENTIALS", "La contraseña actual no es correcta");
            }
            await database.query("UPDATE users SET password_hash = $2 WHERE id = $1", [active.user_id, await passwordHash(input.newPassword)]);
        },

        async deleteAccount(active, password) {
            const result = await database.query("SELECT password_hash FROM users WHERE id = $1", [active.user_id]);
            const passwordValue = typeof password === "string" && password.length <= 128 ? password : "";
            if (!result.rows[0]?.password_hash || !(await verifyPassword(passwordValue, result.rows[0].password_hash))) {
                throw new ApiError(401, "INVALID_CREDENTIALS", "La contraseña no es correcta");
            }
            await withTransaction(database, async (client) => {
                await client.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [active.user_id]);
                await client.query("UPDATE users SET deletion_requested_at = now() WHERE id = $1", [active.user_id]);
                await client.query("DELETE FROM users WHERE id = $1", [active.user_id]);
                await client.query(`INSERT INTO account_deletions(user_id_hash, requested_at, completed_at, status)
                    VALUES ($1, now(), now(), 'completed')`, [secretHash(active.user_id)]);
            });
        },
    };
}
