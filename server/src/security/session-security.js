import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const PASSWORD_KEY_BYTES = 64;
const PASSWORD_OPTIONS = Object.freeze({ N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

export const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
export const secret = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const secretHash = (value) => createHash("sha256").update(String(value)).digest("hex");

export function safeEqualHash(value, expectedHash) {
    const actual = Buffer.from(secretHash(value));
    const expected = Buffer.from(String(expectedHash || ""));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function passwordHash(password) {
    const salt = randomBytes(16).toString("base64url");
    const derived = await scrypt(String(password), salt, PASSWORD_KEY_BYTES, PASSWORD_OPTIONS);
    return `scrypt$v1$${PASSWORD_OPTIONS.N}$${PASSWORD_OPTIONS.r}$${PASSWORD_OPTIONS.p}$${salt}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password, encoded) {
    const [algorithm, version, n, r, p, salt, expectedValue, ...rest] = String(encoded || "").split("$");
    if (algorithm !== "scrypt" || version !== "v1" || rest.length || !salt || !expectedValue) return false;
    const options = { N: Number(n), r: Number(r), p: Number(p), maxmem: PASSWORD_OPTIONS.maxmem };
    if (options.N !== PASSWORD_OPTIONS.N || options.r !== PASSWORD_OPTIONS.r || options.p !== PASSWORD_OPTIONS.p) return false;
    const expected = Buffer.from(expectedValue, "base64url");
    if (expected.length !== PASSWORD_KEY_BYTES) return false;
    const actual = await scrypt(String(password), salt, expected.length, options);
    return timingSafeEqual(actual, expected);
}

export function parseCookies(header = "") {
    return Object.fromEntries(header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
        const at = part.indexOf("=");
        return at < 0 ? [part, ""] : [part.slice(0, at), decodeURIComponent(part.slice(at + 1))];
    }));
}

export function sessionCookie(token, config, { clear = false } = {}) {
    const maxAge = clear ? 0 : config.sessionDays * 86_400;
    return [
        `trip_session=${clear ? "" : encodeURIComponent(token)}`,
        "Path=/api",
        "HttpOnly",
        "SameSite=Lax",
        config.production ? "Secure" : "",
        `Max-Age=${maxAge}`,
    ].filter(Boolean).join("; ");
}

export class SlidingWindowLimiter {
    constructor({ limit, windowMs }) {
        this.limit = limit;
        this.windowMs = windowMs;
        this.entries = new Map();
    }

    take(key, now = Date.now()) {
        const values = (this.entries.get(key) || []).filter((stamp) => now - stamp < this.windowMs);
        if (values.length >= this.limit) return false;
        values.push(now);
        this.entries.set(key, values);
        return true;
    }
}
