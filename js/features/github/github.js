// Optional, explicit synchronization of a portable plan stored in an existing
// GitHub repository file. This module owns UI and browser persistence; HTTP
// transport and target validation live in github-api.js.

import { store } from "../../core/store.js";
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
const githubOpenBtn = $("#githubOpenBtn");
const githubMenu = $("#githubMenu");
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

function sameJson(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function changeGroup(tone, title, items) {
    const visible = items.slice(0, 4);
    const remaining = items.length - visible.length;
    return {
        tone,
        title,
        detail: `${visible.join(" · ")}${remaining > 0 ? ` · +${remaining} más` : ""}`,
    };
}

function collectionChanges(remoteItems, localItems, describe, comparable = (item) => item) {
    const remote = new Map(remoteItems.map((item) => [item.id, item]));
    const local = new Map(localItems.map((item) => [item.id, item]));
    return {
        added: [...local].filter(([id]) => !remote.has(id)).map(([, item]) => describe(item)),
        removed: [...remote].filter(([id]) => !local.has(id)).map(([, item]) => describe(item)),
        modified: [...local]
            .filter(([id, item]) => remote.has(id) && !sameJson(comparable(remote.get(id)), comparable(item)))
            .map(([id, item]) => ({ before: remote.get(id), after: item })),
    };
}

function previewValue(value, empty = "Sin indicar") {
    if (value === undefined || value === null || value === "") return empty;
    if (Array.isArray(value)) return value.length ? value.join(", ") : "Ninguna";
    if (typeof value === "boolean") return value ? "Sí" : "No";
    const text = String(value).replace(/\s+/g, " ").trim();
    return text.length > 54 ? `${text.slice(0, 51)}…` : text;
}

function fieldChanges(before, after, fields) {
    return fields.flatMap(({ label, read = (item) => item[label], format = previewValue }) => {
        const previous = read(before);
        const next = read(after);
        if (sameJson(previous, next)) return [];
        return [{ label, before: format(previous), after: format(next) }];
    });
}

function modifiedGroup(label, name, changes) {
    return {
        tone: "modify",
        title: `${label} · ${name}`,
        changes,
    };
}

function buildChangesPreview() {
    const remote = JSON.parse(store.githubRemoteSnapshot);
    const local = JSON.parse(planSnapshot(serializePlan({ exportedAt: false })));
    const groups = [];
    const totals = { add: 0, modify: 0, remove: 0 };
    const addGroups = (label, changes) => {
        for (const [key, tone, action] of [
            ["added", "add", "Se añaden"],
            ["removed", "remove", "Se eliminan"],
        ]) {
            if (!changes[key].length) continue;
            totals[tone] += changes[key].length;
            groups.push(changeGroup(tone, `${label} · ${action}`, changes[key]));
        }
    };

    const dayItems = (plan) => (plan.days || []).map((day, index) => ({ ...day, position: index + 1 }));
    const dayComparable = ({ spots, ...day }) => day;
    const dayChanges = collectionChanges(
        dayItems(remote),
        dayItems(local),
        (day) => day.title || day.date || "Día sin título",
        dayComparable,
    );
    addGroups("Días", dayChanges);
    const dayFields = [
        { label: "Título", read: (day) => day.title },
        { label: "Fecha", read: (day) => day.date },
        { label: "Posición", read: (day) => day.position },
        { label: "Plegado", read: (day) => day.collapsed === true },
    ];
    for (const { before, after } of dayChanges.modified) {
        totals.modify += 1;
        groups.push(modifiedGroup(
            "Día modificado",
            after.title || after.date || "Sin título",
            fieldChanges(before, after, dayFields),
        ));
    }

    const backlogGroupChanges = collectionChanges(
        remote.backlogGroups || [],
        local.backlogGroups || [],
        (group) => group.title || "Grupo sin nombre",
    );
    addGroups("Grupos del backlog", backlogGroupChanges);
    const backlogGroupFields = [
        { label: "Nombre", read: (group) => group.title },
        { label: "Plegado", read: (group) => group.collapsed === true },
    ];
    for (const { before, after } of backlogGroupChanges.modified) {
        totals.modify += 1;
        groups.push(modifiedGroup(
            "Grupo del backlog modificado",
            after.title || "Sin nombre",
            fieldChanges(before, after, backlogGroupFields),
        ));
    }

    const dayNames = new Map([
        ["backlog", "Ideas"],
        ...[...(remote.days || []), ...(local.days || [])]
            .map((day) => [day.id, day.title || day.date || "Día sin título"]),
    ]);
    const flattenSpots = (plan) => [
        ...(plan.backlog || []).map((spot, index) => ({ ...spot, dayId: "backlog", position: index + 1 })),
        ...(plan.days || []).flatMap((day) => (day.spots || []).map((spot, index) => ({
            ...spot,
            dayId: day.id,
            position: index + 1,
        }))),
    ];
    const spotChanges = collectionChanges(
        flattenSpots(remote),
        flattenSpots(local),
        (spot) => spot.name || "Parada sin nombre",
    );
    addGroups("Paradas", spotChanges);
    const spotFields = [
        { label: "Nombre", read: (spot) => spot.name },
        { label: "Tipo", read: (spot) => spot.kind, format: (value) => value === "waypoint" ? "Solo paso" : "Visita" },
        { label: "Día", read: (spot) => spot.dayId, format: (id) => dayNames.get(id) || "Día eliminado" },
        { label: "Grupo del backlog", read: (spot) => spot.backlogGroupId },
        { label: "Posición", read: (spot) => spot.position },
        { label: "Dirección", read: (spot) => spot.address },
        { label: "Nota", read: (spot) => spot.note },
        { label: "Etiquetas", read: (spot) => spot.tags || [] },
        { label: "Categoría", read: (spot) => spot.category },
        { label: "Coste", read: (spot) => spot.cost, format: (value) => value == null ? "Sin coste" : `${value} ${local.foreignCurrency}` },
        { label: "Duración", read: (spot) => spot.visitMinutes, format: (value) => value == null ? "Sin estimación" : `${value} min` },
        { label: "Inicio planificado", read: (spot) => spot.plannedStart },
        { label: "Apertura", read: (spot) => spot.openingTime },
        { label: "Cierre", read: (spot) => spot.closingTime },
        { label: "Opcional", read: (spot) => spot.optional, format: (value) => value ? "Sí" : "No" },
        { label: "Reserva fija", read: (spot) => spot.fixedStart, format: (value) => value ? "Sí" : "No" },
        { label: "Horario", read: (spot) => spot.scheduleNotApplicable, format: (value) => value ? "No aplicable" : "Aplicable" },
        { label: "Cierre", read: (spot) => spot.closingTime },
        { label: "Ubicación", read: (spot) => Number.isFinite(spot.lat) && Number.isFinite(spot.lng) ? `${spot.lat.toFixed(5)}, ${spot.lng.toFixed(5)}` : "", },
        { label: "Visible en el mapa", read: (spot) => spot.mapEnabled !== false },
    ];
    for (const { before, after } of spotChanges.modified) {
        totals.modify += 1;
        groups.push(modifiedGroup(
            "Parada modificada",
            after.name || "Sin nombre",
            fieldChanges(before, after, spotFields),
        ));
    }

    const categoryChanges = collectionChanges(
        remote.categories || [],
        local.categories || [],
        (category) => category.label || "Categoría sin nombre",
    );
    addGroups("Categorías", categoryChanges);
    const categoryFields = [
        { label: "Nombre", read: (category) => category.label },
        { label: "Color", read: (category) => category.color },
        { label: "Conecta la ruta", read: (category) => category.connects !== false },
        { label: "Tipo sugerido", read: (category) => category.defaultSpotKind, format: (value) => value === "waypoint" ? "Solo paso" : "Visita" },
    ];
    for (const { before, after } of categoryChanges.modified) {
        totals.modify += 1;
        groups.push(modifiedGroup(
            "Categoría modificada",
            after.label || "Sin nombre",
            fieldChanges(before, after, categoryFields),
        ));
    }

    const remoteTags = new Set(remote.tags || []);
    const localTags = new Set(local.tags || []);
    addGroups("Etiquetas", {
        added: [...localTags].filter((tag) => !remoteTags.has(tag)).map((tag) => `#${tag}`),
        removed: [...remoteTags].filter((tag) => !localTags.has(tag)).map((tag) => `#${tag}`),
        modified: [],
    });

    const routeProfiles = { walking: "A pie", driving: "En coche", cycling: "En bicicleta" };
    const routeTypes = { straight: "Líneas rectas", streets: "Por calles" };
    const settingFields = [
        { label: "Título del viaje", read: (plan) => plan.tripTitle },
        { label: "Moneda local", read: (plan) => plan.localCurrency },
        { label: "Moneda extranjera", read: (plan) => plan.foreignCurrency },
        { label: "Tipo de cambio", read: (plan) => plan.exchangeRate },
        { label: "Fecha del cambio", read: (plan) => plan.exchangeRateDate },
        {
            label: "Páginas de notas",
            read: (plan) => plan.tripNotePages,
            format: (value) => `${Array.isArray(value) ? value.length : 0} página(s)`,
        },
        { label: "Modo de viaje", read: (plan) => plan.routeProfile, format: (value) => routeProfiles[value] || previewValue(value) },
        { label: "Tipo de ruta", read: (plan) => plan.routeVisualization, format: (value) => routeTypes[value] || previewValue(value) },
        { label: "Trayectos", read: (plan) => plan.travelLegs || {}, format: (value) => `${Object.keys(value || {}).length} configurados` },
    ];
    const changedSettings = fieldChanges(remote, local, settingFields);
    if (changedSettings.length) {
        totals.modify += changedSettings.length;
        groups.push(modifiedGroup("Ajustes modificados", "Viaje", changedSettings));
    }

    return {
        stats: [
            { tone: "add", label: "Añadidos", value: totals.add },
            { tone: "modify", label: "Modificados", value: totals.modify },
            { tone: "remove", label: "Eliminados", value: totals.remove },
        ],
        groups,
    };
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
    githubMenu.querySelector('[data-github-action="configure"]').disabled = store.githubBusy;
    githubMenu.querySelector('[data-github-action="connect"]').disabled = store.githubBusy || !connection;
    githubMenu.querySelector('[data-github-action="pull"]').disabled = store.githubBusy || !store.githubVerified || !connection?.sha;
    const publishButton = githubMenu.querySelector('[data-github-action="publish"]');
    const hasChanges = localPlanHasChanges();
    const tokenNeeded = !store.githubBusy && store.githubVerified && Boolean(connection?.sha) && hasChanges && !tokenAvailable;
    publishButton.disabled = store.githubBusy || !store.githubVerified || !connection?.sha || !hasChanges;
    publishButton.classList.toggle("github-needs-token", tokenNeeded);
    publishButton.dataset.needsToken = String(tokenNeeded);
    publishButton.querySelector(".github-menu-icon").textContent = tokenNeeded ? "!" : "↑";
    publishButton.querySelector("small").textContent = tokenNeeded
        ? "Falta un token con permiso de escritura"
        : store.githubVerified && !hasChanges
          ? "No hay cambios relevantes que publicar"
          : "Actualizar el archivo en GitHub";
    githubOpenBtn.disabled = store.githubBusy;
    githubOpenBtn.classList.toggle("github-configured", Boolean(connection));
    githubOpenBtn.classList.toggle("github-connected", store.githubVerified);
    githubOpenBtn.title = store.githubBusy
        ? "Comunicando con GitHub…"
        : store.githubVerified
          ? `Conectado a ${connection.owner}/${connection.repo}`
          : connection
            ? `Configurado para ${connection.owner}/${connection.repo}`
            : "Configurar GitHub";
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
    applyImportedPlan(plan);
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

function closeGithubMenu({ restoreFocus = false } = {}) {
    if (githubMenu.hidden) return;
    githubMenu.hidden = true;
    githubOpenBtn.setAttribute("aria-expanded", "false");
    if (restoreFocus) githubOpenBtn.focus();
}

function openGithubDialog({ focusToken = false } = {}) {
    fillTarget(store.githubConnection);
    tokenInput.value = "";
    tokenInput.placeholder = getGithubToken() ? "Token guardado en esta sesión" : "github_pat_…";
    tokenInput.closest("label")?.classList.toggle("github-token-required", focusToken);
    openModal(githubDialog);
    if (focusToken) requestAnimationFrame(() => tokenInput.focus());
}

githubOpenBtn.onclick = (event) => {
    event.stopPropagation();
    const willOpen = githubMenu.hidden;
    closeGithubMenu();
    if (!willOpen) return;
    renderGithubStatus();
    githubMenu.hidden = false;
    githubOpenBtn.setAttribute("aria-expanded", "true");
    githubMenu.querySelector("button:not(:disabled)")?.focus();
};
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

async function connectGithub() {
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
        toast("Conexión con GitHub verificada.", "success");
    } catch (error) {
        store.githubVerified = false;
        if (error.code === "AUTH") setGithubToken("");
        toast(errorMessage(error), "error", 5600);
    } finally {
        setBusy(false);
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
    closeGithubMenu();
    document.querySelector(".top-actions")?.classList.remove("nav-open");
    $("#navToggle")?.setAttribute("aria-expanded", "false");
    if (action === "configure") openGithubDialog();
    else if (action === "connect") connectGithub();
    else if (action === "pull" && store.githubConnection) runRead(store.githubConnection, getGithubToken());
    else if (action === "publish" && button.dataset.needsToken === "true") openGithubDialog({ focusToken: true });
    else if (action === "publish") publishGithub();
});

document.addEventListener("click", (event) => {
    if (!event.target.closest(".github-control")) closeGithubMenu();
});
window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !githubMenu.hidden) closeGithubMenu({ restoreFocus: true });
});

store.githubConnection = loadGithubMetadata();
store.githubVerified = false;
fillTarget(store.githubConnection);
renderGithubStatus();
