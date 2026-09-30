import { store } from "../../core/store.js";
import { getRemoteLibrary } from "../cloud/coordinator.js";
import { canManageCollaborators, openCollaboratorsDialog } from "../cloud/collaborators.js";
import { openLibraryTrip } from "./library.js";
import { matchingSharedTrips, tripContext, tripWithRemoteContext } from "./trip-context.js";
import { toast } from "../../shared/notify.js";
import { publicShareToken } from "../share/share-url.js";
import { memberAvatar, MEMBER_ROLE_LABEL } from "../cloud/member-avatar.js";
import { memberPresenceState, MEMBER_PRESENCE_LABEL } from "../cloud/member-presence.js";

const identity = document.querySelector("#tripIdentity");
const membersButton = document.querySelector("#tripIdentityMembers");
const warning = document.querySelector("#tripNameWarning");
let openedId = null;
let dismissed = false;
let memberKey = "";
let presenceTripId = null;

const personalIcon = '<circle cx="12" cy="8" r="3"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>';
const sharedIcon = '<circle cx="9" cy="8" r="3"/><path d="M2 21v-2a7 7 0 0 1 14 0v2M16 5a3 3 0 0 1 0 6M19 21v-2a7 7 0 0 0-3-5"/>';

function activeTrip() {
    return tripWithRemoteContext(store.tripLibrary.find((trip) => trip.id === store.activeTripId), getRemoteLibrary());
}

function renderMemberPresence() {
    const members = activeTrip()?.remote?.members || [];
    for (const avatar of membersButton.querySelectorAll(".member-avatar[data-user-id]")) {
        const member = members.find((entry) => entry.userId === avatar.dataset.userId);
        if (!member) continue;
        const state = memberPresenceState(member.userId, {
            sessions: store.presenceSessions,
            currentUserId: store.accountSession?.user?.id,
            connectionState: presenceTripId === store.activeTripId ? store.presenceConnectionState : "closed",
            liveState: store.liveTripConnectionState,
            online: navigator.onLine,
        });
        avatar.dataset.presence = state;
        avatar.title = `${member.displayName} · ${MEMBER_ROLE_LABEL[member.role]} · ${MEMBER_PRESENCE_LABEL[state]}`;
        avatar.setAttribute("role", "img");
        avatar.setAttribute("aria-label", avatar.title);
    }
}

function renderIdentity() {
    // Public bootstrap never opens the repository or accesses device data.
    if (publicShareToken(location.search)) return;
    if (openedId !== store.activeTripId) {
        openedId = store.activeTripId;
        dismissed = false;
    }
    const active = activeTrip();
    const context = tripContext(active);
    identity.hidden = !context;
    const personal = context?.personal;
    const confirmed = personal || ["owner", "editor", "viewer"].includes(active?.remote?.role);
    const badge = personal ? "Personal" : confirmed ? "Compartido" : "En la nube";
    identity.dataset.kind = personal ? "personal" : "shared";
    identity.title = context?.label || "";
    identity.setAttribute("aria-label", context?.label || "");
    document.querySelector("#tripIdentityLabel").textContent = badge;
    // These SVG fragments are static, never imported/user strings.
    document.querySelector("#tripIdentityIcon").innerHTML = personal ? personalIcon : sharedIcon;
    const owner = active?.remote?.members?.find((member) => member.role === "owner");
    const ownerLabel = document.querySelector("#tripIdentityOwner");
    ownerLabel.hidden = !["editor", "viewer"].includes(active?.remote?.role);
    ownerLabel.textContent = `De ${owner?.displayName || "otra persona"}`;
    const permission = document.querySelector("#tripIdentityPermission");
    permission.hidden = ownerLabel.hidden;
    permission.innerHTML = active?.remote?.role === "viewer"
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 4 5 5M4 15 15 4a3.5 3.5 0 0 1 5 5L9 20l-6 1 1-6Z"/></svg>';
    permission.title = active?.remote?.role === "viewer" ? "Solo lectura" : "Puedes editar";
    permission.setAttribute("aria-label", permission.title);
    membersButton.hidden = !canManageCollaborators(active);
    const nextMemberKey = JSON.stringify(active?.remote?.members || []);
    if (nextMemberKey !== memberKey || !membersButton.childNodes.length) {
        memberKey = nextMemberKey;
        membersButton.replaceChildren();
        const members = active?.remote?.members || [];
        for (const member of members.slice(0, 3)) membersButton.append(memberAvatar(member));
        if (!members.length || personal) membersButton.textContent = "+";
        if (members.length > 3) {
            const rest = document.createElement("span");
            rest.className = "trip-identity-more";
            rest.textContent = `+${members.length - 3}`;
            membersButton.append(rest);
        }
    }
    membersButton.setAttribute("aria-label", personal ? "Gestionar colaboradores" : "Ver miembros del viaje");
    membersButton.title = personal ? "Añadir colaboradores" : "Ver miembros";
    renderMemberPresence();
    const persistenceContext = document.querySelector("#tripPersistenceContext");
    persistenceContext.hidden = !context;
    persistenceContext.textContent = personal ? "Viaje personal" : ownerLabel.hidden ? badge : `Compartido · ${owner?.displayName || "otra persona"}`;
    persistenceContext.dataset.kind = personal ? "personal" : "shared";
    persistenceContext.title = context?.label || "";

    const matches = dismissed ? [] : matchingSharedTrips(active, store.tripLibrary, getRemoteLibrary());
    warning.hidden = !matches.length;
    const targets = document.querySelector("#tripNameWarningTargets");
    // Preserve keyboard focus while autosave and live events refresh metadata.
    const key = JSON.stringify(matches.map((trip) => [trip.id, trip.remoteOnly, trip.title, tripContext(trip).label]));
    if (targets.dataset.matches === key) return;
    targets.dataset.matches = key;
    targets.replaceChildren();
    if (!matches.length) return;
    document.querySelector("#tripNameWarningMessage").textContent = "Mismo nombre, otro viaje";
    warning.title = "Estás en tu viaje personal. Los cambios aquí no llegan al viaje compartido.";
    warning.setAttribute("aria-description", warning.title);
    for (const trip of matches) {
        const button = document.createElement("button");
        button.type = "button";
        const owner = trip.remote?.members?.find((member) => member.role === "owner");
        if (owner) button.append(memberAvatar(owner));
        const label = document.createElement("span");
        label.textContent = `Abrir compartido${owner ? ` · ${owner.displayName}` : ""}`;
        const arrow = document.createElement("span");
        arrow.textContent = "↗";
        arrow.setAttribute("aria-hidden", "true");
        button.append(label, arrow);
        button.title = `«${trip.title}» · ${tripContext(trip).label}`;
        button.setAttribute("aria-label", `Abrir «${trip.title}». ${tripContext(trip).label}`);
        button.addEventListener("click", async () => {
            button.disabled = true;
            try { await openLibraryTrip(trip.id, { remoteOnly: trip.remoteOnly }); }
            catch { toast("No se pudo abrir el viaje compartido. Comprueba la conexión y tus permisos.", "error"); }
            finally { button.disabled = false; }
        });
        targets.append(button);
    }
}

membersButton.addEventListener("click", () => {
    const active = activeTrip();
    if (canManageCollaborators(active)) void openCollaboratorsDialog(active);
});
document.querySelector("#tripNameWarningDismiss").addEventListener("click", () => {
    dismissed = true;
    warning.hidden = true;
});
for (const event of ["trip-library-changed", "remote-trip-library", "active-trip-changed", "cloud-session-changed", "trip-members-changed"]) {
    document.addEventListener(event, renderIdentity);
}
renderIdentity();
document.addEventListener("trip-presence-changed", () => {
    presenceTripId = store.activeTripId;
    renderMemberPresence();
});
document.addEventListener("trip-live-state", renderMemberPresence);
window.addEventListener("online", renderMemberPresence);
window.addEventListener("offline", renderMemberPresence);
