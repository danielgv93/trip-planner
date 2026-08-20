import { parsePortablePlanJson } from "../../core/portable-plan.js";
import { store } from "../../core/store.js";
import { openModal } from "../../shared/modal.js";
import { confirmAction, promptAction, toast } from "../../shared/notify.js";
import { drawMap, syncRouteVisualizationControl } from "../map/map.js";
import { syncTripNotes } from "../notes/notes.js";
import { applyTitle, render } from "../planner/render.js";
import {
    archiveTrip,
    createTrip,
    deleteTrip,
    duplicateTrip,
    getTripRepository,
    importAsNewTrip,
    renameTrip,
    switchTrip,
    waitForActiveCommit,
} from "./workspace.js";
import {
    drainOutbox,
    getRemoteLibrary,
    leaveTrip,
    openRemoteTrip,
    uploadLocalTrip,
} from "../cloud/coordinator.js";
import { cloudSaveActionState } from "../cloud/global-action-state.js";
import { canManageCollaborators, openCollaboratorsDialog } from "../cloud/collaborators.js";
import { memberAvatar } from "../cloud/member-avatar.js";
import { canShareTrip, openShareDialog } from "../share/share-dialog.js";
import { SYNC_COPY } from "../cloud/sync-state.js";

const dialog = document.querySelector("#libraryDialog");
const list = document.querySelector("#libraryList");
const emptyState = document.querySelector("#libraryEmpty");
const cardMenu = document.querySelector("#libraryCardMenu");
const searchInput = document.querySelector("#librarySearch");
const saveCloudButton = document.querySelector("#saveCloudBtn");
let showArchived = false;
let searchTerm = "";
let uploadingTripId = null;
let menuTrigger = null;

const stampFormatter = new Intl.DateTimeFormat("es-ES", { dateStyle: "medium", timeStyle: "short" });
const dayFormatter = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short" });
const relativeFormatter = new Intl.RelativeTimeFormat("es-ES", { numeric: "auto" });
const RELATIVE_STEPS = [
    ["minute", 60_000, 60],
    ["hour", 3_600_000, 24],
    ["day", 86_400_000, 7],
    ["week", 604_800_000, 4.35],
];

function repaintActiveTrip() {
    document.body.classList.toggle("compact-itinerary", store.itineraryDensity === "compact");
    document.body.classList.remove("preview-mode");
    const preview = document.querySelector("#previewBtn");
    if (preview) {
        preview.textContent = "Vista completa";
        preview.classList.remove("active");
        preview.setAttribute("aria-pressed", "false");
    }
    for (const [selector, value] of [
        ["#routeProfile", store.routeProfile],
        ["#routeVisualization", store.routeVisualization],
        ["#basemapSelect", store.basemap],
        ["#localCurrency", store.localCurrency],
        ["#foreignCurrency", store.foreignCurrency],
    ]) {
        const control = document.querySelector(selector);
        if (control) control.value = value;
    }
    syncRouteVisualizationControl();
    applyTitle();
    syncTripNotes();
    render({ persist: false });
    drawMap();
}

// Only real problems earn the amber tone; a local-only trip is a normal state,
// not a warning.
const SYNC_TONE = {
    local: "offline",
    saved: "offline",
    saving: "offline",
    offline: "offline",
    synced: "synced",
};

// Search must ignore accents so "japon" still matches "Japón".
function foldText(value) {
    return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function relativeUpdated(value) {
    const stamp = new Date(value);
    if (Number.isNaN(stamp.getTime())) return { label: "Sin fecha", title: "" };
    const elapsed = Date.now() - stamp.getTime();
    if (elapsed < 60_000) return { label: "Ahora mismo", title: stampFormatter.format(stamp) };
    for (const [unit, ms, limit] of RELATIVE_STEPS) {
        const amount = elapsed / ms;
        if (amount < limit) return { label: relativeFormatter.format(-Math.round(amount), unit), title: stampFormatter.format(stamp) };
    }
    return { label: stampFormatter.format(stamp), title: stampFormatter.format(stamp) };
}

// Card metadata comes straight from the portable document, so remote-only trips
// (which are not downloaded yet) simply have no summary to show.
function planSummary(document_) {
    const days = Array.isArray(document_?.days) ? document_.days : [];
    const stops = days.reduce((total, day) => total + (Array.isArray(day.spots) ? day.spots.length : 0), 0);
    const dates = days.map((day) => day.date).filter(Boolean).sort();
    return { days: days.length, stops, from: dates[0], to: dates.at(-1) };
}

function dateRangeLabel({ from, to }) {
    if (!from) return "";
    const start = new Date(`${from}T12:00:00`);
    const end = new Date(`${to || from}T12:00:00`);
    if (Number.isNaN(start.getTime())) return "";
    if (from === to) return dayFormatter.format(start);
    return `${dayFormatter.format(start)} – ${dayFormatter.format(end)}`;
}

function chip(text, tone, icon) {
    const element = document.createElement("span");
    element.className = "library-chip";
    element.dataset.tone = tone;
    const mark = document.createElement("i");
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = icon;
    const label = document.createElement("span");
    label.textContent = text;
    element.append(mark, label);
    return element;
}

// The people row only appears once somebody else is involved: a solo trip has
// nothing to say about collaboration, and the card is already dense.
const VISIBLE_AVATARS = 4;

function peopleRow(trip) {
    const members = Array.isArray(trip.members) ? trip.members : [];
    if (members.length < 2) return null;
    const row = document.createElement("div");
    row.className = "library-card-people";
    const stack = document.createElement("span");
    stack.className = "member-stack";
    for (const member of members.slice(0, VISIBLE_AVATARS)) stack.append(memberAvatar(member));
    if (members.length > VISIBLE_AVATARS) {
        const rest = document.createElement("span");
        rest.className = "member-avatar member-avatar-rest";
        rest.textContent = `+${members.length - VISIBLE_AVATARS}`;
        stack.append(rest);
    }
    const caption = document.createElement("small");
    const others = members.length - 1;
    const owner = members.find((member) => member.role === "owner");
    caption.textContent = trip.role === "owner"
        ? `Tuyo · ${others} ${others === 1 ? "colaborador" : "colaboradores"}`
        : `De ${owner?.displayName || "otra persona"} · ${trip.role === "viewer" ? "solo lectura" : "puedes editar"}`;
    row.append(stack, caption);
    return row;
}

function statBlock(value, label) {
    const element = document.createElement("span");
    element.className = "library-stat";
    const amount = document.createElement("strong");
    amount.textContent = String(value);
    const caption = document.createElement("small");
    caption.textContent = label;
    element.append(amount, caption);
    return element;
}

function menuItem(label, action, id, tone = "") {
    const element = document.createElement("button");
    element.type = "button";
    element.role = "menuitem";
    element.dataset.libraryAction = action;
    element.dataset.tripId = id;
    if (tone) element.dataset.tone = tone;
    element.textContent = label;
    return element;
}

function closeCardMenu({ restoreFocus = false } = {}) {
    const trigger = menuTrigger;
    menuTrigger = null;
    if (typeof cardMenu.hidePopover === "function" && cardMenu.matches(":popover-open")) cardMenu.hidePopover();
    cardMenu.removeAttribute("data-open");
    if (restoreFocus && trigger?.isConnected) trigger.focus();
}

function openCardMenu(trigger, trip) {
    const id = trip.id;
    const local = store.tripLibrary.find((entry) => entry.id === id);
    // A trip with no remote copy has no roles yet: its creator is its owner.
    const role = local?.remote.id ? local.remote.role : "owner";
    const canEdit = role !== "viewer";
    cardMenu.replaceChildren(
        ...(canEdit ? [menuItem("Renombrar", "rename", id)] : []),
        menuItem("Duplicar", "duplicate", id),
        ...(canManageCollaborators(local) ? [menuItem("Colaboradores", "collaborators", id)] : []),
        ...(canShareTrip(local) ? [menuItem("Compartir", "share", id)] : []),
        menuItem(showArchived ? "Restaurar" : "Archivar", "archive", id),
        role === "owner"
            ? menuItem("Eliminar", "delete", id, "danger")
            : menuItem("Salir del viaje", "leave", id, "danger"),
    );
    cardMenu.dataset.tripId = id;
    menuTrigger = trigger;
    if (typeof cardMenu.showPopover === "function") cardMenu.showPopover();
    else cardMenu.dataset.open = "true";
    const anchor = trigger.getBoundingClientRect();
    const menu = cardMenu.getBoundingClientRect();
    const top = Math.min(anchor.bottom + 6, window.innerHeight - menu.height - 10);
    const left = Math.min(anchor.right - menu.width, window.innerWidth - menu.width - 10);
    cardMenu.style.top = `${Math.max(10, top)}px`;
    cardMenu.style.left = `${Math.max(10, left)}px`;
    cardMenu.querySelector("button")?.focus();
}

function libraryEntries() {
    const localByRemote = new Map(store.tripLibrary.filter((trip) => trip.remote.id).map((trip) => [trip.remote.id, trip]));
    const sharedRemoteIds = new Set(getRemoteLibrary().filter((trip) => trip.shared).map((trip) => trip.id));
    const local = store.tripLibrary.map((trip) => ({
        id: trip.id,
        remoteOnly: false,
        shared: Boolean(trip.remote.id && sharedRemoteIds.has(trip.remote.id)),
        archived: trip.archived === true,
        pendingDeletion: trip.pendingDeletion === true,
        title: trip.document.tripTitle,
        updatedAt: trip.updatedAt,
        syncState: trip.syncState,
        role: trip.remote.id ? trip.remote.role : null,
        ownerId: trip.remote.ownerId,
        members: trip.remote.members,
        summary: planSummary(trip.document),
    }));
    const remoteOnly = getRemoteLibrary()
        .filter((trip) => !localByRemote.has(trip.id))
        .map((trip) => ({
            id: trip.id,
            remoteOnly: true,
            shared: Boolean(trip.shared),
            archived: Boolean(trip.archived_at),
            pendingDeletion: false,
            title: trip.title,
            updatedAt: trip.updated_at,
            syncState: "synced",
            role: trip.role,
            ownerId: trip.owner_id,
            members: trip.members || [],
            summary: null,
        }));
    return [...local, ...remoteOnly];
}

function buildCard(trip) {
    const isActive = !trip.remoteOnly && trip.id === store.activeTripId;
    const card = document.createElement("article");
    card.className = "library-card";
    card.role = "listitem";
    if (isActive) card.dataset.active = "true";
    if (trip.pendingDeletion) card.dataset.disabled = "true";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "library-card-open";
    open.dataset.libraryAction = isActive ? "focus" : trip.remoteOnly ? "open-remote" : "open";
    open.dataset.tripId = trip.id;
    open.disabled = trip.pendingDeletion;
    open.setAttribute("aria-label", `${isActive ? "Volver a" : "Abrir"} ${trip.title}`);

    const title = document.createElement("h4");
    title.textContent = trip.title;
    const updated = relativeUpdated(trip.updatedAt);
    const stamp = document.createElement("time");
    stamp.textContent = `Editado ${updated.label.toLowerCase()}`;
    if (updated.title) stamp.title = updated.title;
    open.append(title, stamp);

    if (isActive) {
        const badge = document.createElement("span");
        badge.className = "library-card-badge";
        badge.textContent = "Abierto ahora";
        open.append(badge);
    }

    const body = document.createElement("div");
    body.className = "library-card-body";
    if (trip.summary && trip.summary.days) {
        const stats = document.createElement("div");
        stats.className = "library-card-stats";
        stats.append(statBlock(trip.summary.days, trip.summary.days === 1 ? "día" : "días"));
        stats.append(statBlock(trip.summary.stops, trip.summary.stops === 1 ? "parada" : "paradas"));
        const range = dateRangeLabel(trip.summary);
        if (range) {
            const dates = document.createElement("span");
            dates.className = "library-stat library-stat-range";
            const value = document.createElement("strong");
            value.textContent = range;
            const caption = document.createElement("small");
            caption.textContent = "fechas";
            dates.append(value, caption);
            stats.append(dates);
        }
        body.append(stats);
    }

    const chips = document.createElement("div");
    chips.className = "library-card-chips";
    if (trip.remoteOnly) chips.append(chip("En la nube · necesita conexión", "cloud", "☁"));
    else {
        const tone = SYNC_TONE[trip.syncState] || "pending";
        chips.append(chip(SYNC_COPY[trip.syncState] || trip.syncState, tone, tone === "synced" ? "☁" : "⌁"));
        // "Solo en este dispositivo" already says it works offline; the extra
        // chip only adds information once the trip also lives in the cloud.
        if (tone !== "offline") chips.append(chip("Disponible sin conexión", "offline", "⌁"));
    }
    if (trip.shared) chips.append(chip("Público · cualquiera con el enlace", "shared", "◎"));
    if (trip.pendingDeletion) chips.append(chip("Eliminación pendiente · no editable", "warn", "△"));
    body.append(chips);

    const people = peopleRow(trip);
    if (people) body.append(people);

    card.append(open, body);

    if (!trip.remoteOnly && !trip.pendingDeletion) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "library-card-more";
        more.dataset.libraryMenu = trip.id;
        more.setAttribute("aria-haspopup", "menu");
        more.setAttribute("aria-label", `Más acciones para ${trip.title}`);
        more.textContent = "⋯";
        card.append(more);
    }
    return card;
}

function renderLibrary() {
    closeCardMenu();
    const entries = libraryEntries();
    const activeCount = entries.filter((trip) => !trip.archived).length;
    const archivedCount = entries.length - activeCount;
    document.querySelector("#libraryActiveCount").textContent = String(activeCount);
    document.querySelector("#libraryArchivedCount").textContent = String(archivedCount);
    document.querySelector("#libraryActiveBtn").setAttribute("aria-selected", String(!showArchived));
    document.querySelector("#libraryActiveBtn").tabIndex = showArchived ? -1 : 0;
    document.querySelector("#libraryArchivedBtn").setAttribute("aria-selected", String(showArchived));
    document.querySelector("#libraryArchivedBtn").tabIndex = showArchived ? 0 : -1;

    const needle = foldText(searchTerm);
    const visible = entries
        .filter((trip) => trip.archived === showArchived)
        .filter((trip) => !needle || foldText(trip.title).includes(needle))
        .sort((a, b) => {
            if (a.id === store.activeTripId && !a.remoteOnly) return -1;
            if (b.id === store.activeTripId && !b.remoteOnly) return 1;
            return new Date(b.updatedAt) - new Date(a.updatedAt);
        });

    list.replaceChildren(...visible.map(buildCard));

    const total = showArchived ? archivedCount : activeCount;
    const summary = document.querySelector("#libraryHeadSummary");
    const scopeCopy = showArchived
        ? total === 1 ? "1 viaje archivado" : `${total} viajes archivados`
        : total === 1 ? "1 viaje activo" : `${total} viajes activos`;
    summary.textContent = needle
        ? `${visible.length} de ${total} ${total === 1 ? "viaje" : "viajes"} coinciden con la búsqueda`
        : scopeCopy;

    emptyState.hidden = visible.length > 0;
    document.querySelector("#libraryEmptyTitle").textContent = needle
        ? "Ningún viaje coincide"
        : showArchived
          ? "No tienes viajes archivados"
          : "Aún no tienes viajes aquí";
    document.querySelector("#libraryEmptyHint").textContent = needle
        ? "Prueba con otro nombre o borra la búsqueda."
        : showArchived
          ? "Los viajes que archives se guardarán en esta sección."
          : "Crea uno nuevo o importa un plan que ya tengas guardado.";
    document.querySelector("#libraryEmptyAction").hidden = Boolean(needle) || showArchived;
}

function renderGlobalCloudAction() {
    const state = cloudSaveActionState({
        activeTripId: store.activeTripId,
        trips: store.tripLibrary,
        accountSession: store.accountSession,
        cloudAvailability: store.cloudAvailability,
        uploadingTripId,
    });
    saveCloudButton.hidden = !state.visible;
    saveCloudButton.disabled = state.disabled;
    saveCloudButton.setAttribute("aria-label", state.label);
    saveCloudButton.title = `${state.title}${state.title ? " · " : ""}Ctrl/Cmd + S`;
    saveCloudButton.querySelector(".save-cloud-label").textContent = state.label;
}

document.querySelector("#libraryBtn").addEventListener("click", () => {
    searchTerm = "";
    searchInput.value = "";
    renderLibrary();
    openModal(dialog);
});

document.querySelector("#libraryCreateBtn").addEventListener("click", async () => {
    const title = await promptAction({ title: "Nuevo viaje", message: "Ponle un nombre. Podrás cambiarlo después.", inputLabel: "Nombre", confirmLabel: "Crear", inputPlaceholder: "Mi próximo viaje" });
    if (title === null) return;
    await createTrip(title || "Nuevo viaje");
    repaintActiveTrip();
    renderLibrary();
});

for (const tab of document.querySelectorAll("[data-library-scope]")) {
    tab.addEventListener("click", () => {
        const next = tab.dataset.libraryScope === "archived";
        if (next === showArchived) return;
        showArchived = next;
        renderLibrary();
    });
}

// Roving focus so the two scope tabs behave like a real tablist.
document.querySelector(".library-scope").addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    showArchived = !showArchived;
    renderLibrary();
    document.querySelector(`[data-library-scope="${showArchived ? "archived" : "active"}"]`).focus();
});

searchInput.addEventListener("input", () => {
    searchTerm = searchInput.value;
    renderLibrary();
});

document.querySelector("#libraryEmptyAction").addEventListener("click", () => document.querySelector("#libraryCreateBtn").click());

document.querySelector("#libraryImportBtn").addEventListener("click", () => document.querySelector("#libraryImportFile").click());
document.querySelector("#libraryImportFile").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
        const plan = parsePortablePlanJson(await file.text());
        await importAsNewTrip(plan);
        renderLibrary();
        toast("Viaje importado como una copia independiente.", "success");
    } catch {
        toast("Ese archivo no parece un plan válido.", "error");
    } finally {
        event.target.value = "";
    }
});

async function runLibraryAction(action, id) {
    try {
        if (action === "focus") {
            dialog.close();
            return;
        }
        if (action === "open") {
            await switchTrip(id);
            repaintActiveTrip();
            dialog.close();
        } else if (action === "open-remote") {
            await openRemoteTrip(id);
            repaintActiveTrip();
            dialog.close();
        } else if (action === "rename") {
            const current = store.tripLibrary.find((trip) => trip.id === id);
            const title = await promptAction({ title: "Renombrar viaje", message: "El título cambiará también dentro del plan.", inputLabel: "Nombre", inputPlaceholder: current.document.tripTitle, confirmLabel: "Guardar" });
            if (title !== null) await renameTrip(id, title || current.document.tripTitle);
            if (id === store.activeTripId) applyTitle();
        } else if (action === "collaborators") {
            const local = store.tripLibrary.find((trip) => trip.id === id);
            if (canManageCollaborators(local)) await openCollaboratorsDialog(local);
        } else if (action === "leave") {
            const ok = await confirmAction({
                title: "Salir del viaje",
                message: "Dejarás de verlo y se borrará de este dispositivo. El propietario conserva el viaje y tus cambios en el historial.",
                confirmLabel: "Salir",
            });
            if (ok) {
                await leaveTrip(id);
                toast("Has salido del viaje.", "success");
            }
        } else if (action === "share") {
            const local = store.tripLibrary.find((trip) => trip.id === id);
            if (canShareTrip(local)) await openShareDialog(local.remote.id);
        } else if (action === "duplicate") {
            await duplicateTrip(id);
            toast("Copia independiente creada.", "success");
        } else if (action === "archive") {
            await archiveTrip(id, !showArchived);
        } else if (action === "delete") {
            const ok = await confirmAction({ title: "Eliminar viaje", message: "Se eliminará de este dispositivo y, si corresponde, de la nube. Esta acción no se puede deshacer.", confirmLabel: "Eliminar" });
            if (ok) await deleteTrip(id);
        }
        renderLibrary();
    } catch (error) {
        toast(error.message === "TRIP_NOT_AVAILABLE" ? "Este viaje no está disponible." : "No se pudo completar la acción.", "error");
    }
}

list.addEventListener("click", (event) => {
    const menuTrigger = event.target.closest("[data-library-menu]");
    if (menuTrigger) {
        openCardMenu(menuTrigger, { id: menuTrigger.dataset.libraryMenu });
        return;
    }
    const control = event.target.closest("[data-library-action]");
    if (control) void runLibraryAction(control.dataset.libraryAction, control.dataset.tripId);
});

cardMenu.addEventListener("click", (event) => {
    const control = event.target.closest("[data-library-action]");
    if (!control) return;
    closeCardMenu();
    void runLibraryAction(control.dataset.libraryAction, control.dataset.tripId);
});

// Captured on the document so Escape dismisses the menu instead of the dialog
// underneath, wherever the focus happens to be.
document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !menuTrigger) return;
    event.preventDefault();
    event.stopPropagation();
    closeCardMenu({ restoreFocus: true });
}, true);

cardMenu.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const items = [...cardMenu.querySelectorAll("button")];
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = (items.indexOf(document.activeElement) + step + items.length) % items.length;
    items[next]?.focus();
});

// The menu is positioned against the trigger, so any scroll would detach it.
list.addEventListener("scroll", closeCardMenu, { passive: true });
dialog.addEventListener("close", closeCardMenu);

async function saveActiveToCloud() {
    await waitForActiveCommit();
    const activeTripId = store.activeTripId;
    const activeTrip = store.tripLibrary.find((trip) => trip.id === activeTripId);
    const action = cloudSaveActionState({
        activeTripId,
        trips: store.tripLibrary,
        accountSession: store.accountSession,
        cloudAvailability: store.cloudAvailability,
        uploadingTripId,
    });
    if (!activeTrip || action.disabled || activeTrip.pendingDeletion) return false;
    uploadingTripId = activeTripId;
    renderGlobalCloudAction();
    try {
        if (activeTrip.remote.id) {
            await drainOutbox();
            const stillPending = (await getTripRepository().listOutbox())
                .some((item) => item.tripId === activeTripId);
            if (stillPending) throw new Error("CLOUD_SAVE_PENDING");
        } else {
            await uploadLocalTrip(activeTripId);
        }
        toast("Viaje guardado en tu cuenta.", "success");
        return true;
    } catch {
        toast("No se pudo guardar el viaje en la nube. Sigue disponible en este dispositivo.", "error");
        return false;
    } finally {
        if (uploadingTripId === activeTripId) uploadingTripId = null;
        renderGlobalCloudAction();
    }
}

saveCloudButton.addEventListener("click", () => void saveActiveToCloud());

document.addEventListener("keydown", (event) => {
    if (typeof event.key !== "string" || event.key.toLowerCase() !== "s" || (!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey) return;
    event.preventDefault();
    void saveActiveToCloud();
});

document.addEventListener("trip-library-changed", () => {
    renderLibrary();
    renderGlobalCloudAction();
});
document.addEventListener("remote-trip-library", renderLibrary);
document.addEventListener("active-trip-changed", () => {
    repaintActiveTrip();
    renderGlobalCloudAction();
});
document.addEventListener("cloud-session-changed", renderGlobalCloudAction);
document.addEventListener("trip-sync-needed", renderGlobalCloudAction);
renderGlobalCloudAction();

export { renderLibrary, repaintActiveTrip };
