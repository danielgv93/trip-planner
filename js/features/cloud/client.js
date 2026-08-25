export class CloudError extends Error {
    constructor(code, message, { status = 0, details, retryable = false } = {}) {
        super(message);
        this.name = "CloudError";
        this.code = code;
        this.status = status;
        this.details = details;
        this.retryable = retryable;
    }
}

export function createCloudClient({ baseUrl = "", timeoutMs = 12_000, csrfToken = () => null } = {}) {
    async function request(path, { method = "GET", body, signal, keepalive = false } = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        signal?.addEventListener("abort", () => controller.abort(), { once: true });
        const headers = { accept: "application/json" };
        if (body !== undefined) headers["content-type"] = "application/json";
        if (method !== "GET" && method !== "HEAD" && csrfToken()) headers["x-csrf-token"] = csrfToken();
        try {
            const response = await fetch(`${baseUrl}${path}`, {
                method,
                headers,
                credentials: "include",
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal,
                keepalive,
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                const code = payload.error?.code || `HTTP_${response.status}`;
                throw new CloudError(code, payload.error?.message || "No se pudo completar la solicitud", {
                    status: response.status,
                    details: payload.error?.details ?? payload.error,
                    retryable: response.status >= 500 || response.status === 429,
                });
            }
            return payload;
        } catch (error) {
            if (error instanceof CloudError) throw error;
            if (error.name === "AbortError") throw new CloudError("TIMEOUT", "La nube tardó demasiado en responder", { retryable: true });
            throw new CloudError("NETWORK", "Sin conexión con la nube", { retryable: true });
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        health: () => request("/api/health"),
        register: (email, password, deviceLabel) => request("/api/auth/register", { method: "POST", body: { email, password, deviceLabel } }),
        login: (email, password, deviceLabel) => request("/api/auth/login", { method: "POST", body: { email, password, deviceLabel } }),
        session: () => request("/api/session"),
        logout: () => request("/api/logout", { method: "POST" }),
        listTrips: (archived = false) => request(`/api/trips?archived=${archived}`),
        createTrip: (document, deviceId) => request("/api/trips", { method: "POST", body: { document, deviceId } }),
        getTrip: (id) => request(`/api/trips/${encodeURIComponent(id)}`),
        patchTrip: (id, patch) => request(`/api/trips/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),
        deleteTrip: (id) => request(`/api/trips/${encodeURIComponent(id)}`, { method: "DELETE" }),
        mutateTrip: (id, mutation) => request(`/api/trips/${encodeURIComponent(id)}/mutations`, { method: "POST", body: mutation }),
        activateTripOperations: (id, activation) => request(`/api/v1/trips/${encodeURIComponent(id)}/operations/activate`, { method: "POST", body: activation }),
        mutateTripOperation: (id, operation) => request(`/api/v1/trips/${encodeURIComponent(id)}/operations`, { method: "POST", body: operation }),
        catchUpTripOperations: (id, { after = 0, limit = 100 } = {}) => request(`/api/v1/trips/${encodeURIComponent(id)}/operations?after=${encodeURIComponent(after)}&limit=${encodeURIComponent(limit)}`),
        getTripPresence: (id) => request(`/api/v1/trips/${encodeURIComponent(id)}/presence`),
        upsertTripPresence: (id, sessionId, presence) => request(`/api/v1/trips/${encodeURIComponent(id)}/presence/${encodeURIComponent(sessionId)}`, { method: "PUT", body: presence }),
        leaveTripPresence: (id, sessionId, sequence, { keepalive = false } = {}) => request(`/api/v1/trips/${encodeURIComponent(id)}/presence/${encodeURIComponent(sessionId)}`, { method: "DELETE", body: { sequence }, keepalive }),
        listTripMembers: (id) => request(`/api/trips/${encodeURIComponent(id)}/members`),
        inviteTripMember: (id, email, role) => request(`/api/trips/${encodeURIComponent(id)}/members`, { method: "POST", body: { email, role } }),
        updateTripMemberRole: (id, memberId, role) => request(`/api/trips/${encodeURIComponent(id)}/members/${encodeURIComponent(memberId)}`, { method: "PATCH", body: { role } }),
        removeTripMember: (id, memberId) => request(`/api/trips/${encodeURIComponent(id)}/members/${encodeURIComponent(memberId)}`, { method: "DELETE" }),
        leaveTrip: (id) => request(`/api/trips/${encodeURIComponent(id)}/members/me`, { method: "DELETE" }),
        tripEventsUrl: (id) => `${baseUrl}/api/trips/${encodeURIComponent(id)}/events`,
        getTripShare: (id) => request(`/api/trips/${encodeURIComponent(id)}/share`),
        shareTrip: (id) => request(`/api/trips/${encodeURIComponent(id)}/share`, { method: "POST" }),
        unshareTrip: (id) => request(`/api/trips/${encodeURIComponent(id)}/share`, { method: "DELETE" }),
        getPublicTrip: (token) => request(`/api/public/trips/${encodeURIComponent(token)}`),
        listRevisions: (id, { before, limit = 30 } = {}) => request(`/api/trips/${encodeURIComponent(id)}/revisions?limit=${limit}${before ? `&before=${before}` : ""}`),
        getRevision: (id, revision) => request(`/api/trips/${encodeURIComponent(id)}/revisions/${revision}`),
        exportAccount: () => request("/api/account/export"),
        updateProfile: (profile) => request("/api/account/profile", { method: "PATCH", body: profile }),
        changePassword: (currentPassword, newPassword) => request("/api/account/password", { method: "PATCH", body: { currentPassword, newPassword } }),
        deleteAccount: (password) => request("/api/account", { method: "DELETE", body: { password } }),
        reportQueueDepth: (depth) => request("/api/metrics/queue-depth", { method: "POST", body: { depth } }),
    };
}
