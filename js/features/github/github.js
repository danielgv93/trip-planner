// Optional, explicit synchronization of a portable plan stored in an existing
// GitHub repository file. This module owns UI and browser persistence; HTTP
// transport and target validation live in github-api.js.

import { store } from "../../core/store.js";
import { buildPlanChanges } from "../../core/plan-changes.js";
import { $ } from "../../shared/dom.js";
import { openModal } from "../../shared/modal.js";
import { parsePlanJson, serializePlan } from "../../core/plan-json.js";
import { applyImportedPlan } from "../planner/import-plan.js";
import { confirmAction, promptAction, toast } from "../../shared/notify.js";
import {
    GithubError,
    GITHUB_STORAGE_KEY,
    GITHUB_TOKEN_KEY,
    normalizeGithubTarget,
    searchGithubOwners,
    listGithubRepos,
    listGithubBranches,
    listGithubJsonFiles,
    getGithubFile,
    putGithubFile,
} from "./github-api.js";

export * from "./github-api.js";

export function loadGithubMetadata() {
    try {
        const value = JSON.parse(localStorage.getItem(GITHUB_STORAGE_KEY) || "null");
        if (![1, 2].includes(value?.version)) return null;
        return {
            version: 2,
            ...normalizeGithubTarget(value),
            sha: typeof value.sha === "string" ? value.sha : null,
            configuredAt: typeof value.configuredAt === "string"
                ? value.configuredAt
                : typeof value.connectedAt === "string" ? value.connectedAt : new Date().toISOString(),
            connectedAt: typeof value.connectedAt === "string" ? value.connectedAt : null,
        };
    } catch {
        return null;
    }
}

function saveGithubMetadata(connection) {
    try {
        localStorage.setItem(GITHUB_STORAGE_KEY, JSON.stringify({
            version: 2,
            owner: connection.owner,
            repo: connection.repo,
            path: connection.path,
            ref: connection.ref,
            sha: connection.sha || null,
            configuredAt: connection.configuredAt,
            connectedAt: connection.connectedAt || null,
        }));
    } catch {
        throw new GithubError("STORAGE");
    }
}

function removeGithubMetadata() {
    try {
        localStorage.removeItem(GITHUB_STORAGE_KEY);
    } catch {
        throw new GithubError("STORAGE");
    }
}

export function getGithubToken() {
    try {
        return sessionStorage.getItem(GITHUB_TOKEN_KEY) || "";
    } catch {
        return "";
    }
}

function setGithubToken(token) {
    try {
        if (token) sessionStorage.setItem(GITHUB_TOKEN_KEY, token);
        else sessionStorage.removeItem(GITHUB_TOKEN_KEY);
    } catch {
        throw new GithubError("STORAGE");
    }
}

function errorMessage(error) {
    const messages = {
        INVALID_OWNER: "El propietario de GitHub no es válido.",
        INVALID_REPO: "El nombre del repositorio no es válido.",
        INVALID_REF: "La rama o referencia no es válida.",
        INVALID_PATH: "La ruta del archivo no es válida.",
        AUTH: "GitHub rechazó el acceso. Revisa el token y sus permisos de Contents.",
        RATE_LIMIT: "Se ha alcanzado el límite de solicitudes de GitHub. Inténtalo más tarde.",
        NOT_FOUND: "No se encontró el archivo o no tienes permiso para acceder a él.",
        CONFLICT: "El archivo remoto ha cambiado. Recárgalo desde GitHub antes de publicar; puedes exportar tu plan local como copia de seguridad.",
        VALIDATION: "GitHub no pudo actualizar el archivo. Comprueba que la referencia sea una rama existente.",
        SERVER: "GitHub no está disponible en este momento.",
        NETWORK: "No se pudo conectar con GitHub. Comprueba tu conexión.",
        RESPONSE: "GitHub devolvió una respuesta que no se pudo interpretar.",
        NOT_FILE: "La ruta no corresponde a un archivo JSON compatible.",
        TOO_LARGE: "El archivo supera el límite de 1 MB del planificador.",
        DECODE: "No se pudo decodificar el archivo de GitHub.",
        STORAGE: "El navegador no permitió guardar la credencial de sesión.",
        PUBLISH_UNAVAILABLE: "La publicación no está disponible para esta conexión.",
        INVALID_JSON: "El archivo de GitHub no contiene JSON válido.",
        INVALID_PLAN: "El archivo de GitHub no parece un plan válido.",
    };
    return messages[error?.code || error?.message] || "No se pudo completar la operación con GitHub.";
}

const githubDialog = $("#githubDialog");
const githubForm = $("#githubForm");
const tokenInput = $("#githubToken");
const githubMenu = $("#githubMenu");
const githubMenuState = $("#githubMenuState");
const githubSettingsState = $("#githubSettingsState");
const githubSettingsTarget = $("#githubSettingsTarget");
const githubSettingsConfigureBtn = $("#githubSettingsConfigureBtn");
const githubSettingsDisconnectBtn = $("#githubSettingsDisconnectBtn");
const PLAN_SNAPSHOT_KEYS = [
    "version",
    "tripTitle",
    "localCurrency",
    "foreignCurrency",
    "exchangeRate",
    "exchangeRateDate",
    "tripNotePages",
    "days",
    "backlog",
    "backlogGroups",
    "tags",
    "categories",
    "routeProfile",
    "routeVisualization",
];

function sortJson(value) {
    if (Array.isArray(value)) return value.map(sortJson);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function canonicalPlan(plan) {
    const canonicalSpot = (spot) => ({
        ...spot,
        address: typeof spot.address === "string" ? spot.address : "",
        note: typeof spot.note === "string" ? spot.note : "",
        tags: Array.isArray(spot.tags) ? spot.tags : [],
        mapEnabled: spot.mapEnabled !== false,
    });
    return {
        ...plan,
        days: (plan.days || []).map((day) => ({
            ...day,
            spots: (day.spots || []).map(canonicalSpot),
        })),
        backlog: (plan.backlog || []).map(canonicalSpot),
        categories: (plan.categories || []).map((category) => ({
            ...category,
            connects: category.connects !== false,
        })),
    };
}

function planSnapshot(plan) {
    const canonical = canonicalPlan(plan);
    return JSON.stringify(sortJson(Object.fromEntries(
        PLAN_SNAPSHOT_KEYS.map((key) => [key, canonical[key]]),
    )));
}

function localPlanHasChanges() {
    return Boolean(
        store.githubRemoteSnapshot &&
        planSnapshot(serializePlan({ exportedAt: false })) !== store.githubRemoteSnapshot
    );
}

function buildChangesPreview() {
    const remote = JSON.parse(store.githubRemoteSnapshot);
    const local = JSON.parse(planSnapshot(serializePlan({ exportedAt: false })));
    return buildPlanChanges(remote, local);
}

function createGithubAutocomplete({ input, list, minimumLength = 0, load, select }) {
    let timer = null;
    let requestId = 0;
    let items = [];
    let activeIndex = -1;

    const hide = () => {
        requestId += 1;
        clearTimeout(timer);
        list.hidden = true;
        input.setAttribute("aria-expanded", "false");
        input.removeAttribute("aria-activedescendant");
        activeIndex = -1;
    };
    const showMessage = (message) => {
        list.replaceChildren();
        const status = document.createElement("div");
        status.className = "github-autocomplete-message";
        status.textContent = message;
        list.append(status);
        list.hidden = false;
        input.setAttribute("aria-expanded", "true");
    };
    const render = () => {
        list.replaceChildren();
        if (!items.length) {
            showMessage("Sin coincidencias.");
            return;
        }
        items.forEach((item, index) => {
            const option = document.createElement("button");
            option.type = "button";
            option.id = `${list.id}-option-${index}`;
            option.setAttribute("role", "option");
            option.setAttribute("aria-selected", String(index === activeIndex));
            option.tabIndex = -1;
            const label = document.createElement("strong");
            label.textContent = item.label;
            const detail = document.createElement("small");
            detail.textContent = item.detail;
            option.append(label, detail);
            option.addEventListener("mousedown", (event) => event.preventDefault());
            option.addEventListener("click", () => {
                input.value = item.value;
                select(item);
                hide();
            });
            list.append(option);
        });
        list.hidden = false;
        input.setAttribute("aria-expanded", "true");
    };
    const moveActive = (direction) => {
        if (!items.length || list.hidden) return;
        activeIndex = (activeIndex + direction + items.length) % items.length;
        const options = list.querySelectorAll('[role="option"]');
        options.forEach((option, index) => option.setAttribute("aria-selected", String(index === activeIndex)));
        const active = options[activeIndex];
        input.setAttribute("aria-activedescendant", active.id);
        active.scrollIntoView({ block: "nearest" });
    };
    const run = async () => {
        const query = input.value.trim();
        if (query.length < minimumLength) {
            hide();
            return;
        }
        const currentRequest = ++requestId;
        showMessage("Buscando en GitHub…");
        try {
            const result = await load(query);
            if (currentRequest !== requestId) return;
            items = result;
            activeIndex = -1;
            render();
        } catch {
            if (currentRequest !== requestId) return;
            items = [];
            showMessage("No se pudieron cargar las sugerencias.");
        }
    };
    const schedule = (delay = 380) => {
        requestId += 1;
        clearTimeout(timer);
        timer = setTimeout(run, delay);
    };

    input.addEventListener("input", () => schedule());
    input.addEventListener("focus", () => schedule(0));
    input.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            moveActive(event.key === "ArrowDown" ? 1 : -1);
        } else if (event.key === "Enter" && activeIndex >= 0) {
            event.preventDefault();
            const item = items[activeIndex];
            input.value = item.value;
            select(item);
            hide();
        } else if (event.key === "Escape") {
            hide();
        }
    });
    document.addEventListener("click", (event) => {
        if (!list.contains(event.target) && event.target !== input) hide();
    });
    return { hide, refresh: () => schedule(0) };
}

const ownerInput = $("#githubOwner");
const repoInput = $("#githubRepo");
const refInput = $("#githubRef");
const pathInput = $("#githubPath");
let repoAutocomplete;
const ownerAutocomplete = createGithubAutocomplete({
    input: ownerInput,
    list: $("#githubOwnerSuggestions"),
    minimumLength: 2,
    load: (query) => searchGithubOwners(query, tokenInput.value.trim() || getGithubToken()),
    select: (item) => {
        if (repoInput.dataset.owner && repoInput.dataset.owner !== item.value) repoInput.value = "";
        repoInput.dataset.owner = item.value;
    },
});
repoAutocomplete = createGithubAutocomplete({
    input: repoInput,
    list: $("#githubRepoSuggestions"),
    load: (query) => listGithubRepos(ownerInput.value, query, tokenInput.value.trim() || getGithubToken()),
    select: (item) => {
        repoInput.dataset.owner = ownerInput.value.trim();
        if (item.defaultBranch) refInput.value = item.defaultBranch;
    },
});
const refAutocomplete = createGithubAutocomplete({
    input: refInput,
    list: $("#githubRefSuggestions"),
    load: (query) => listGithubBranches(
        ownerInput.value,
        repoInput.value,
        query,
        tokenInput.value.trim() || getGithubToken(),
    ),
    select: () => {
        pathInput.value = "";
    },
});
const pathAutocomplete = createGithubAutocomplete({
    input: pathInput,
    list: $("#githubPathSuggestions"),
    load: (query) => listGithubJsonFiles(
        ownerInput.value,
        repoInput.value,
        refInput.value,
        query,
        tokenInput.value.trim() || getGithubToken(),
    ),
    select: () => {},
});

function fillTarget(connection) {
    if (!connection) return;
    $("#githubOwner").value = connection.owner;
    $("#githubRepo").value = connection.repo;
    $("#githubRepo").dataset.owner = connection.owner;
    $("#githubRef").value = connection.ref;
    $("#githubPath").value = connection.path;
}

function targetFromForm() {
    return normalizeGithubTarget({
        owner: $("#githubOwner").value,
        repo: $("#githubRepo").value,
        ref: $("#githubRef").value,
        path: $("#githubPath").value,
    });
}

function renderGithubStatus() {
    const connection = store.githubConnection;
    const tokenAvailable = Boolean(getGithubToken());
    const configureAction = githubMenu.querySelector('[data-github-action="configure"]');
    const connectAction = githubMenu.querySelector('[data-github-action="connect"]');
    const pullAction = githubMenu.querySelector('[data-github-action="pull"]');
    const disconnectAction = githubMenu.querySelector('[data-github-action="disconnect"]');
    configureAction.disabled = store.githubBusy;
    configureAction.setAttribute("aria-haspopup", "dialog");
    configureAction.setAttribute("aria-controls", store.accountSession ? "accountDialog" : "githubDialog");
    configureAction.querySelector("strong").textContent = store.accountSession ? "Abrir Integraciones" : "Configurar GitHub";
    configureAction.querySelector("small").textContent = store.accountSession
        ? "Configuración → Integraciones"
        : "Repositorio, rama, archivo y token";
    connectAction.disabled = store.githubBusy || !connection;
    connectAction.hidden = !connection || store.githubVerified;
    pullAction.disabled = store.githubBusy || !store.githubVerified || !connection?.sha;
    pullAction.hidden = !store.githubVerified;
    disconnectAction.disabled = store.githubBusy || !connection;
    disconnectAction.hidden = Boolean(store.accountSession) || !connection;
    const publishButton = githubMenu.querySelector('[data-github-action="publish"]');
    const hasChanges = localPlanHasChanges();
    const menuState = store.githubBusy
        ? "saving"
        : !connection
          ? "local"
          : store.githubVerified
            ? (hasChanges ? "pending" : "synced")
            : "configured";
    githubMenuState.dataset.state = menuState;
    githubMenuState.textContent = menuState === "saving"
        ? "Comunicando…"
        : menuState === "pending"
          ? "Cambios pendientes"
          : menuState === "synced"
            ? "Sincronizado"
            : menuState === "configured" ? "Configurado" : "Sin configurar";
    const tokenNeeded = !store.githubBusy && store.githubVerified && Boolean(connection?.sha) && hasChanges && !tokenAvailable;
    publishButton.disabled = store.githubBusy || !store.githubVerified || !connection?.sha || !hasChanges;
    publishButton.hidden = !store.githubVerified;
    publishButton.classList.toggle("github-needs-token", tokenNeeded);
    publishButton.dataset.needsToken = String(tokenNeeded);
    publishButton.querySelector(".github-menu-icon").textContent = tokenNeeded ? "!" : "↑";
    publishButton.querySelector("small").textContent = tokenNeeded
        ? "Falta un token con permiso de escritura"
        : store.githubVerified && !hasChanges
          ? "No hay cambios relevantes que publicar"
          : "Actualizar el archivo en GitHub";
    githubSettingsState.textContent = store.githubBusy
        ? "Comunicando…"
        : store.githubVerified
          ? "Conectado"
          : connection ? "Configurado" : "Sin configurar";
    githubSettingsState.dataset.state = store.githubBusy
        ? "pending"
        : store.githubVerified ? "synced" : connection ? "pending" : "local";
    githubSettingsTarget.hidden = !connection;
    $("#githubSettingsRepository").textContent = connection ? `${connection.owner}/${connection.repo}` : "";
    $("#githubSettingsBranch").textContent = connection?.ref || "";
    $("#githubSettingsPath").textContent = connection?.path || "";
    githubSettingsConfigureBtn.disabled = store.githubBusy;
    githubSettingsConfigureBtn.textContent = connection ? "Editar configuración" : "Configurar GitHub";
    githubSettingsDisconnectBtn.hidden = !connection;
    githubSettingsDisconnectBtn.disabled = store.githubBusy;
}

function setBusy(value) {
    store.githubBusy = value;
    renderGithubStatus();
}

async function readAndImport(candidate, candidateToken) {
    const result = await getGithubFile(candidate, candidateToken);
    let plan;
    try {
        plan = parsePlanJson(result.text);
    } catch (error) {
        throw new GithubError(error.message === "INVALID_JSON" ? "INVALID_JSON" : "INVALID_PLAN");
    }
    const accepted = await confirmAction({
        title: "Importar desde GitHub",
        message: `¿Importar ${candidate.owner}/${candidate.repo} · ${candidate.path}? Sustituirá la ruta guardada actualmente.`,
        confirmLabel: "Importar",
    });
    if (!accepted) return false;

    const connection = {
        version: 2,
        ...candidate,
        sha: result.sha,
        configuredAt: store.githubConnection?.configuredAt || new Date().toISOString(),
        connectedAt: new Date().toISOString(),
    };
    await applyImportedPlan(plan);
    store.githubRemoteSnapshot = planSnapshot(plan);
    saveGithubMetadata(connection);
    setGithubToken(candidateToken);
    store.githubConnection = connection;
    store.githubVerified = true;
    fillTarget(connection);
    toast("Plan importado desde GitHub.", "success");
    return true;
}

async function runRead(candidate, token) {
    if (store.githubBusy) return;
    setBusy(true);
    try {
        await readAndImport(candidate, token);
    } catch (error) {
        if (error.code === "AUTH") setGithubToken("");
        toast(errorMessage(error), "error", 5600);
    } finally {
        tokenInput.value = "";
        setBusy(false);
    }
}

function openGithubDialog({ focusToken = false } = {}) {
    fillTarget(store.githubConnection);
    tokenInput.value = "";
    tokenInput.placeholder = getGithubToken() ? "Token guardado en esta sesión" : "github_pat_…";
    tokenInput.closest("label")?.classList.toggle("github-token-required", focusToken);
    openModal(githubDialog);
    if (focusToken) requestAnimationFrame(() => tokenInput.focus());
}

githubDialog.addEventListener("close", () => {
    ownerAutocomplete.hide();
    repoAutocomplete.hide();
    refAutocomplete.hide();
    pathAutocomplete.hide();
    tokenInput.closest("label")?.classList.remove("github-token-required");
});
githubForm.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
        const candidate = targetFromForm();
        const previous = store.githubConnection;
        const sameTarget = previous && ["owner", "repo", "ref", "path"].every((key) => previous[key] === candidate[key]);
        const connection = {
            version: 2,
            ...candidate,
            sha: sameTarget ? previous.sha : null,
            configuredAt: sameTarget ? previous.configuredAt : new Date().toISOString(),
            connectedAt: sameTarget ? previous.connectedAt : null,
        };
        const candidateToken = tokenInput.value.trim();
        if (candidateToken) setGithubToken(candidateToken);
        saveGithubMetadata(connection);
        store.githubConnection = connection;
        if (!sameTarget) {
            store.githubVerified = false;
            store.githubRemoteSnapshot = null;
        }
        renderGithubStatus();
        githubDialog.close();
        toast("Configuración de GitHub guardada.", "success");
    } catch (error) {
        toast(errorMessage(error), "error");
    }
});

async function connectGithub({ silent = false } = {}) {
    const connection = store.githubConnection;
    if (store.githubBusy || !connection) return;
    setBusy(true);
    try {
        const result = await getGithubFile(connection, getGithubToken());
        let remotePlan;
        try {
            remotePlan = parsePlanJson(result.text);
        } catch (error) {
            throw new GithubError(error.message === "INVALID_JSON" ? "INVALID_JSON" : "INVALID_PLAN");
        }
        const updated = {
            ...connection,
            sha: result.sha,
            connectedAt: new Date().toISOString(),
        };
        saveGithubMetadata(updated);
        store.githubConnection = updated;
        store.githubVerified = true;
        store.githubRemoteSnapshot = planSnapshot(remotePlan);
        if (!silent) toast("Conexión con GitHub verificada.", "success");
    } catch (error) {
        store.githubVerified = false;
        if (error.code === "AUTH") setGithubToken("");
        if (!silent) toast(errorMessage(error), "error", 5600);
    } finally {
        setBusy(false);
    }
}

async function disconnectGithub() {
    const connection = store.githubConnection;
    if (store.githubBusy || !connection) return;
    const accepted = await confirmAction({
        title: "Desconectar GitHub",
        message: `¿Eliminar la configuración de ${connection.owner}/${connection.repo} y el token guardado en esta sesión? El plan local no cambiará.`,
        confirmLabel: "Desconectar",
    });
    if (!accepted || store.githubBusy) return;
    try {
        removeGithubMetadata();
        setGithubToken("");
        store.githubConnection = null;
        store.githubVerified = false;
        store.githubRemoteSnapshot = null;
        fillTarget({ owner: "", repo: "", ref: "main", path: "" });
        renderGithubStatus();
        toast("GitHub desconectado y configuración eliminada.", "success");
    } catch (error) {
        toast(errorMessage(error), "error");
    }
}

async function publishGithub() {
    const connection = store.githubConnection;
    const token = getGithubToken();
    if (store.githubBusy || !store.githubVerified || !connection?.sha || !token || !localPlanHasChanges()) return;
    const commitMessage = await promptAction({
        title: "Publicar cambios",
        message: `¿Publicar el plan actual en ${connection.owner}/${connection.repo}, rama ${connection.ref}, archivo ${connection.path}?`,
        confirmLabel: "Publicar",
        inputLabel: "Mensaje del commit (opcional)",
        inputPlaceholder: "Actualizar plan de viaje",
        preview: buildChangesPreview(),
    });
    if (commitMessage === null || store.githubBusy) return;
    setBusy(true);
    const previousSha = connection.sha;
    try {
        const plan = serializePlan();
        const json = JSON.stringify(plan, null, 2);
        const result = await putGithubFile(connection, token, json, previousSha, commitMessage);
        const updated = { ...connection, sha: result.sha, connectedAt: new Date().toISOString() };
        saveGithubMetadata(updated);
        store.githubConnection = updated;
        store.githubRemoteSnapshot = planSnapshot(plan);
        toast("Cambios publicados en GitHub.", "success");
    } catch (error) {
        if (error.code === "AUTH") setGithubToken("");
        toast(errorMessage(error), "error", 7000);
    } finally {
        setBusy(false);
    }
}

githubMenu.addEventListener("click", (event) => {
    const button = event.target.closest("[data-github-action]");
    if (!button || button.disabled) return;
    const action = button.dataset.githubAction;
    document.querySelector("#syncMenu").open = false;
    document.querySelector(".top-actions")?.classList.remove("nav-open");
    $("#navToggle")?.setAttribute("aria-expanded", "false");
    if (action === "configure" && store.accountSession)
        document.dispatchEvent(new CustomEvent("open-account-settings", { detail: { view: "integrations" } }));
    else if (action === "configure") openGithubDialog();
    else if (action === "connect") connectGithub();
    else if (action === "pull" && store.githubConnection) runRead(store.githubConnection, getGithubToken());
    else if (action === "publish" && button.dataset.needsToken === "true") openGithubDialog({ focusToken: true });
    else if (action === "publish") publishGithub();
    else if (action === "disconnect") disconnectGithub();
});

githubSettingsConfigureBtn.addEventListener("click", () => openGithubDialog());
githubSettingsDisconnectBtn.addEventListener("click", disconnectGithub);

store.githubConnection = loadGithubMetadata();
store.githubVerified = false;
fillTarget(store.githubConnection);
renderGithubStatus();
document.addEventListener("trip-save-state", renderGithubStatus);
document.addEventListener("cloud-session-changed", renderGithubStatus);
// Best-effort, one-shot verification on startup. A missing configuration or
// any remote error simply leaves the optional integration disconnected.
if (store.githubConnection) void connectGithub({ silent: true });
