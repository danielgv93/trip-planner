import { ApiError } from "../../http/api-error.js";
import { withTransaction } from "../../infrastructure/postgres/transaction.js";
import {
    normalizeEmail,
    passwordHash,
    safeEqualHash,
    secret,
    secretHash,
    SlidingWindowLimiter,
    verifyPassword,
} from "../../security/session-security.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVALID_CREDENTIALS = "El correo o la contraseña no son correctos";

function validCredentials(rawEmail, password) {
    const email = normalizeEmail(rawEmail);
    return {
        email,
        valid: EMAIL_PATTERN.test(email)
            && email.length <= 254
            && typeof password === "string"
            && password.length >= 10
            && password.length <= 128,
    };
}

export function createAuthService({ database, config, now = () => new Date() }) {
    const emailLimiter = new SlidingWindowLimiter({ limit: 10, windowMs: 15 * 60_000 });
    const ipLimiter = new SlidingWindowLimiter({ limit: 20, windowMs: 15 * 60_000 });
    const dummyPasswordHash = passwordHash(secret());

    async function createSession(client, user, deviceLabel) {
        const sessionToken = secret();
        const csrfToken = secret();
        const expiresAt = new Date(now().getTime() + config.sessionDays * 86_400_000);
        await client.query(`INSERT INTO sessions(user_id, token_hash, csrf_hash, device_label, expires_at)
            VALUES ($1, $2, $3, $4, $5)`, [
            user.id,
            secretHash(sessionToken),
            secretHash(csrfToken),
            typeof deviceLabel === "string" ? deviceLabel.slice(0, 100) : null,
            expiresAt,
        ]);
        return { user: { id: user.id, email: user.email, displayName: user.display_name || "", avatarDataUrl: user.avatar_data_url || null }, sessionToken, csrfToken, expiresAt };
    }

    async function readSession(token, { required = true } = {}) {
        if (!token) {
            if (required) throw new ApiError(401, "AUTH_REQUIRED", "Inicia sesión para continuar");
            return null;
        }
        const result = await database.query(`SELECT s.id, s.user_id, s.csrf_hash, s.expires_at,
                u.email, u.display_name, u.avatar_data_url, u.deletion_requested_at
            FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
              AND u.deletion_requested_at IS NULL`, [secretHash(token)]);
        const active = result.rows[0];
        if (!active) {
            if (required) throw new ApiError(401, "AUTH_REQUIRED", "La sesión ha caducado");
            return null;
        }
        await database.query("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [active.id]);
        return active;
    }

    async function authorizeMutation({ token, origin, csrfToken }) {
        if (!origin || origin !== config.appOrigin) {
            throw new ApiError(403, "INVALID_ORIGIN", "Origen no permitido");
        }
        const active = await readSession(token);
        if (!safeEqualHash(csrfToken, active.csrf_hash)) {
            throw new ApiError(403, "INVALID_CSRF", "Protección de sesión inválida");
        }
        return active;
    }

    async function register({ email: rawEmail, password, deviceLabel, ip }) {
        const credentials = validCredentials(rawEmail, password);
        if (!credentials.valid) {
            throw new ApiError(400, "INVALID_ACCOUNT", "Introduce un correo válido y una contraseña de 10 a 128 caracteres");
        }
        if (!emailLimiter.take(secretHash(credentials.email)) || !ipLimiter.take(secretHash(ip))) {
            throw new ApiError(429, "RATE_LIMITED", "Demasiados intentos. Espera unos minutos");
        }
        const derivedPassword = await passwordHash(password);
        return withTransaction(database, async (client) => {
            try {
                const userResult = await client.query(`INSERT INTO users(email, email_normalized, password_hash, display_name)
                    VALUES ($1, $1, $2, $3) RETURNING id, email, display_name, avatar_data_url`, [credentials.email, derivedPassword, credentials.email.split("@")[0]]);
                return createSession(client, userResult.rows[0], deviceLabel);
            } catch (error) {
                if (error.code === "23505") throw new ApiError(409, "ACCOUNT_EXISTS", "Ya existe una cuenta con ese correo");
                throw error;
            }
        });
    }

    async function login({ email: rawEmail, password, deviceLabel, ip }) {
        const email = normalizeEmail(rawEmail);
        if (!emailLimiter.take(secretHash(email)) || !ipLimiter.take(secretHash(ip))) {
            throw new ApiError(429, "RATE_LIMITED", "Demasiados intentos. Espera unos minutos");
        }
        const result = await database.query(`SELECT id, email, display_name, avatar_data_url, password_hash FROM users
            WHERE email_normalized = $1 AND deletion_requested_at IS NULL`, [email]);
        const user = result.rows[0];
        const passwordValue = typeof password === "string" && password.length <= 128 ? password : "";
        const matches = await verifyPassword(passwordValue, user?.password_hash || await dummyPasswordHash);
        if (!user?.password_hash || !matches) {
            throw new ApiError(401, "INVALID_CREDENTIALS", INVALID_CREDENTIALS);
        }
        return withTransaction(database, (client) => createSession(client, user, deviceLabel));
    }

    async function refreshSession(token) {
        const active = await readSession(token, { required: false });
        if (!active) return { authenticated: false };
        const csrfToken = secret();
        await database.query("UPDATE sessions SET csrf_hash = $1 WHERE id = $2", [secretHash(csrfToken), active.id]);
        return {
            authenticated: true,
            user: { id: active.user_id, email: active.email, displayName: active.display_name || "", avatarDataUrl: active.avatar_data_url || null },
            csrfToken,
            expiresAt: active.expires_at,
        };
    }

    async function logout(credentials) {
        const active = await authorizeMutation(credentials);
        await database.query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [active.id]);
    }

    return { authorizeMutation, login, logout, readSession, refreshSession, register };
}
