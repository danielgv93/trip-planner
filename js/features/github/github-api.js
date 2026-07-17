// GitHub HTTP transport and validation. This module has no planner or DOM
// dependencies, so its request behavior can be exercised independently.

export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_ACCEPT = "application/vnd.github+json";
export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_STORAGE_KEY = "trip-planner-github";
export const GITHUB_TOKEN_KEY = "trip-planner-github-token";
export const MAX_GITHUB_FILE_BYTES = 1_000_000;

export class GithubError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}

function cleanText(value) {
    return typeof value === "string" ? value.trim() : "";
}

export function normalizeGithubTarget(value) {
    const owner = cleanText(value?.owner);
    const repo = cleanText(value?.repo).replace(/\.git$/i, "");
    const ref = cleanText(value?.ref);
    const path = cleanText(value?.path);
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
        throw new GithubError("INVALID_OWNER");
    }
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) {
        throw new GithubError("INVALID_REPO");
    }
    if (!ref || ref.length > 255 || /[\0-\x1f\x7f?#]/.test(ref)) {
        throw new GithubError("INVALID_REF");
    }
    if (!path || path.length > 1000 || path.startsWith("/") || path.endsWith("/") || path.includes("\\")) {
        throw new GithubError("INVALID_PATH");
    }
    const segments = path.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[\0-\x1f\x7f]/.test(segment))) {
        throw new GithubError("INVALID_PATH");
    }
    return { owner, repo, ref, path: segments.join("/") };
}

function contentsUrl(connection) {
    const path = connection.path.split("/").map(encodeURIComponent).join("/");
    const params = new URLSearchParams({ ref: connection.ref });
    return `${GITHUB_API_BASE}/repos/${encodeURIComponent(connection.owner)}/${encodeURIComponent(connection.repo)}/contents/${path}?${params}`;
}

function githubHeaders(token, json = false) {
    const headers = {
        Accept: GITHUB_ACCEPT,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
    };
    if (json) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

function classifyResponse(response) {
    if (response.status === 401) return "AUTH";
    if (response.status === 403 && response.headers.get("X-RateLimit-Remaining") === "0") return "RATE_LIMIT";
    if (response.status === 403) return "AUTH";
    if (response.status === 404) return "NOT_FOUND";
    if (response.status === 409) return "CONFLICT";
    if (response.status === 422) return "VALIDATION";
    if (response.status >= 500) return "SERVER";
    return "REQUEST";
}

async function requestJson(url, options) {
    let response;
    try {
        response = await fetch(url, options);
    } catch {
        throw new GithubError("NETWORK");
    }
    if (!response.ok) throw new GithubError(classifyResponse(response));
    try {
        return await response.json();
    } catch {
        throw new GithubError("RESPONSE");
    }
}

export async function searchGithubOwners(query, token = "") {
    const normalized = cleanText(query);
    if (normalized.length < 2) return [];
    const params = new URLSearchParams({
        q: `${normalized} in:login`,
        per_page: "8",
    });
    let data;
    try {
        data = await requestJson(`${GITHUB_API_BASE}/search/users?${params}`, {
            headers: githubHeaders(token),
        });
    } catch (error) {
        if (!token) throw error;
        data = await requestJson(`${GITHUB_API_BASE}/search/users?${params}`, {
            headers: githubHeaders(""),
        });
    }
    if (!Array.isArray(data?.items)) throw new GithubError("RESPONSE");
    return data.items
        .filter((item) => typeof item?.login === "string")
        .slice(0, 8)
        .map((item) => ({
            value: item.login,
            label: item.login,
            detail: item.type === "Organization" ? "Organización" : "Usuario",
        }));
}

export async function listGithubRepos(owner, query = "", token = "") {
    const normalizedOwner = cleanText(owner);
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(normalizedOwner)) return [];
    const publicParams = new URLSearchParams({
        type: "all",
        sort: "pushed",
        direction: "desc",
        per_page: "100",
    });
    const requests = [
        requestJson(`${GITHUB_API_BASE}/users/${encodeURIComponent(normalizedOwner)}/repos?${publicParams}`, {
            headers: githubHeaders(""),
        }).catch(() => []),
    ];
    if (token) {
        const accessibleParams = new URLSearchParams({
            affiliation: "owner,collaborator,organization_member",
            sort: "pushed",
            direction: "desc",
            per_page: "100",
        });
        requests.push(
            requestJson(`${GITHUB_API_BASE}/user/repos?${accessibleParams}`, {
                headers: githubHeaders(token),
            }).catch(() => []),
        );
    }
    const responses = await Promise.all(requests);
    const byFullName = new Map();
    for (const repo of responses.flat()) {
        if (
            typeof repo?.name !== "string" ||
            typeof repo?.owner?.login !== "string" ||
            repo.owner.login.toLowerCase() !== normalizedOwner.toLowerCase()
        ) continue;
        byFullName.set(repo.full_name || `${repo.owner.login}/${repo.name}`, repo);
    }
    const normalizedQuery = cleanText(query).toLowerCase();
    return [...byFullName.values()]
        .filter((repo) => repo.name.toLowerCase().includes(normalizedQuery))
        .sort((a, b) => {
            const aStarts = a.name.toLowerCase().startsWith(normalizedQuery);
            const bStarts = b.name.toLowerCase().startsWith(normalizedQuery);
            return Number(bStarts) - Number(aStarts) || a.name.localeCompare(b.name);
        })
        .slice(0, 12)
        .map((repo) => ({
            value: repo.name,
            label: repo.name,
            detail: repo.private ? "Privado" : "Público",
            defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : "",
        }));
}

let branchesCache = null;
let filesCache = null;

function repositoryCoordinates(owner, repo) {
    const normalizedOwner = cleanText(owner);
    const normalizedRepo = cleanText(repo).replace(/\.git$/i, "");
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(normalizedOwner)) return null;
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(normalizedRepo)) return null;
    return { owner: normalizedOwner, repo: normalizedRepo };
}

export async function listGithubBranches(owner, repo, query = "", token = "") {
    const repository = repositoryCoordinates(owner, repo);
    if (!repository) return [];
    const cacheKey = `${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}`;
    if (!branchesCache || branchesCache.key !== cacheKey || branchesCache.token !== token) {
        const params = new URLSearchParams({ per_page: "100" });
        const data = await requestJson(
            `${GITHUB_API_BASE}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/branches?${params}`,
            { headers: githubHeaders(token) },
        );
        if (!Array.isArray(data)) throw new GithubError("RESPONSE");
        branchesCache = {
            key: cacheKey,
            token,
            names: data.filter((branch) => typeof branch?.name === "string").map((branch) => branch.name),
        };
    }
    const normalizedQuery = cleanText(query).toLowerCase();
    return branchesCache.names
        .filter((name) => name.toLowerCase().includes(normalizedQuery))
        .sort((a, b) => {
            const aStarts = a.toLowerCase().startsWith(normalizedQuery);
            const bStarts = b.toLowerCase().startsWith(normalizedQuery);
            return Number(bStarts) - Number(aStarts) || a.localeCompare(b);
        })
        .slice(0, 20)
        .map((name) => ({ value: name, label: name, detail: "Rama" }));
}

export async function listGithubJsonFiles(owner, repo, ref, query = "", token = "") {
    const repository = repositoryCoordinates(owner, repo);
    const normalizedRef = cleanText(ref);
    if (!repository || !normalizedRef) return [];
    const cacheKey = `${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}@${normalizedRef}`;
    if (!filesCache || filesCache.key !== cacheKey || filesCache.token !== token) {
        const params = new URLSearchParams({ recursive: "1" });
        const data = await requestJson(
            `${GITHUB_API_BASE}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/git/trees/${encodeURIComponent(normalizedRef)}?${params}`,
            { headers: githubHeaders(token) },
        );
        if (!Array.isArray(data?.tree)) throw new GithubError("RESPONSE");
        filesCache = {
            key: cacheKey,
            token,
            paths: data.tree
                .filter((item) => item?.type === "blob" && typeof item.path === "string" && item.path.toLowerCase().endsWith(".json"))
                .map((item) => item.path),
        };
    }
    const normalizedQuery = cleanText(query).toLowerCase();
    return filesCache.paths
        .filter((path) => path.toLowerCase().includes(normalizedQuery))
        .sort((a, b) => {
            const aStarts = a.toLowerCase().startsWith(normalizedQuery);
            const bStarts = b.toLowerCase().startsWith(normalizedQuery);
            return Number(bStarts) - Number(aStarts) || a.localeCompare(b);
        })
        .slice(0, 30)
        .map((path) => ({ value: path, label: path, detail: "Archivo JSON" }));
}

function base64ToUtf8(value) {
    try {
        const binary = atob(value.replace(/\s/g, ""));
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw new GithubError("DECODE");
    }
}

export function utf8ToBase64(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
}

export async function getGithubFile(connection, token = "") {
    const target = normalizeGithubTarget(connection);
    const data = await requestJson(contentsUrl(target), {
        headers: githubHeaders(token),
    });
    if (data?.type !== "file" || data?.encoding !== "base64" || typeof data.content !== "string" || typeof data.sha !== "string") {
        throw new GithubError("NOT_FILE");
    }
    if (!Number.isFinite(data.size) || data.size > MAX_GITHUB_FILE_BYTES) {
        throw new GithubError("TOO_LARGE");
    }
    return { text: base64ToUtf8(data.content), sha: data.sha };
}

export async function putGithubFile(connection, token, json, sha, message = "Actualizar plan de viaje") {
    if (!token || !sha) throw new GithubError("PUBLISH_UNAVAILABLE");
    const target = normalizeGithubTarget(connection);
    const data = await requestJson(contentsUrl(target).split("?")[0], {
        method: "PUT",
        headers: githubHeaders(token, true),
        body: JSON.stringify({
            message: cleanText(message) || "Actualizar plan de viaje",
            content: utf8ToBase64(json),
            sha,
            branch: target.ref,
        }),
    });
    if (typeof data?.content?.sha !== "string") throw new GithubError("RESPONSE");
    return { sha: data.content.sha };
}
