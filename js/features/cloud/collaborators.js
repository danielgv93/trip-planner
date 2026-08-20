import { store } from "../../core/store.js";
import { openModal } from "../../shared/modal.js";
import { confirmAction, toast } from "../../shared/notify.js";
import {
    getCurrentUserId,
    inviteTripMember,
    leaveTrip,
    listTripMembers,
    removeTripMember,
    updateTripMemberRole,
} from "./coordinator.js";
import { MEMBER_ROLE_LABEL, memberAvatar } from "./member-avatar.js";

const dialog = document.querySelector("#collaboratorsDialog");
const list = document.querySelector("#collaboratorsList");
const state = document.querySelector("#collaboratorsState");
const status = document.querySelector("#collaboratorsStatus");
const inviteForm = document.querySelector("#collaboratorInviteForm");
const hint = document.querySelector("#collaboratorInviteHint");
const emailInput = document.querySelector("#collaboratorEmail");
const roleSelect = document.querySelector("#collaboratorRole");
const leaveButton = document.querySelector("#collaboratorLeaveBtn");

// The dialog always works on one trip, identified by both ids: the remote one
// for the API and the local one for everything that touches the device copy.
let target = { localId: null, remoteId: null, role: null };

// Only a trip that lives in the cloud can have anybody else in it.
export function canManageCollaborators(trip) {
    return Boolean(trip?.remote?.id) && Boolean(store.accountSession) && !trip.pendingDeletion;
}

function memberRow(member, { viewerRole }) {
    const item = document.createElement("li");
    item.className = "collaborator-row";
    item.dataset.userId = member.userId;

    const identity = document.createElement("div");
    identity.className = "collaborator-identity";
    identity.append(memberAvatar(member, { photo: member.avatarDataUrl }));

    const names = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = member.userId === getCurrentUserId() ? `${member.displayName} (tú)` : member.displayName;
    names.append(name);
    // The role already has its own badge on the right; repeating it here would
    // print it twice. Only the owner receives emails, and only for them is the
    // second line worth the space.
    if (member.email) {
        const detail = document.createElement("small");
        detail.textContent = member.email;
        names.append(detail);
    }
    identity.append(names);
    item.append(identity);

    const actions = document.createElement("div");
    actions.className = "collaborator-actions";
    if (member.role === "owner" || viewerRole !== "owner") {
        const badge = document.createElement("span");
        badge.className = "collaborator-role";
        badge.textContent = MEMBER_ROLE_LABEL[member.role] || member.role;
        actions.append(badge);
    } else {
        const select = document.createElement("select");
        select.dataset.memberRole = member.userId;
        select.setAttribute("aria-label", `Permisos de ${member.displayName}`);
        for (const [value, label] of [["editor", "Editar el viaje"], ["viewer", "Solo verlo"]]) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            option.selected = member.role === value;
            select.append(option);
        }
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "collaborator-remove";
        remove.dataset.memberRemove = member.userId;
        remove.setAttribute("aria-label", `Quitar a ${member.displayName} del viaje`);
        remove.textContent = "Quitar";
        actions.append(select, remove);
    }
    item.append(actions);
    return item;
}

async function loadMembers() {
    status.textContent = "";
    list.replaceChildren();
    state.hidden = false;
    state.textContent = "Cargando colaboradores…";
    inviteForm.hidden = true;
    leaveButton.hidden = true;
    try {
        const result = await listTripMembers(target.remoteId);
        target.role = result.role;
        list.replaceChildren(...result.members.map((member) => memberRow(member, { viewerRole: result.role })));
        state.hidden = true;
        const isOwner = result.role === "owner";
        inviteForm.hidden = !isOwner;
        leaveButton.hidden = isOwner;
        hint.textContent = isOwner
            ? "La persona tiene que tener ya una cuenta con ese correo. Quien edita puede cambiar el plan como tú; solo tú, como propietario, puedes eliminar el viaje o gestionar esta lista."
            : result.role === "editor"
                ? "Puedes cambiar el plan como el resto del equipo. Solo el propietario puede eliminar el viaje o gestionar esta lista."
                : "Puedes ver el viaje y su historial, pero no modificarlo. Solo el propietario puede cambiar tus permisos.";
    } catch (error) {
        state.textContent = error.code === "NETWORK" || error.code === "TIMEOUT"
            ? "Necesitas conexión para ver quién colabora en este viaje."
            : "No se pudo cargar la lista de colaboradores.";
    }
}

export async function openCollaboratorsDialog(trip) {
    target = { localId: trip.id, remoteId: trip.remote.id, role: trip.remote.role };
    emailInput.value = "";
    roleSelect.value = "editor";
    openModal(dialog);
    await loadMembers();
}

inviteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = emailInput.value.trim();
    if (!email) return;
    status.textContent = "Invitando…";
    try {
        const member = await inviteTripMember(target.remoteId, email, roleSelect.value);
        emailInput.value = "";
        await loadMembers();
        status.textContent = `${member.displayName} ya puede abrir este viaje.`;
    } catch (error) {
        status.textContent = error.code === "ACCOUNT_NOT_FOUND"
            ? "No hay ninguna cuenta registrada con ese correo."
            : error.message || "No se pudo enviar la invitación.";
    }
});

list.addEventListener("change", async (event) => {
    const select = event.target.closest("[data-member-role]");
    if (!select) return;
    try {
        await updateTripMemberRole(target.remoteId, select.dataset.memberRole, select.value);
        // The reload clears the status line, so the confirmation is written
        // after it and not before.
        await loadMembers();
        status.textContent = "Permisos actualizados.";
    } catch (error) {
        status.textContent = error.message || "No se pudieron cambiar los permisos.";
        await loadMembers();
    }
});

list.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-member-remove]");
    if (!button) return;
    const name = button.closest(".collaborator-row")?.querySelector("strong")?.textContent || "esta persona";
    const ok = await confirmAction({
        title: "Quitar del viaje",
        message: `${name} dejará de ver y editar este viaje. Los cambios que ya hizo se mantienen en el historial.`,
        confirmLabel: "Quitar",
    });
    if (!ok) return;
    try {
        await removeTripMember(target.remoteId, button.dataset.memberRemove);
        await loadMembers();
        status.textContent = "Ya no colabora en este viaje.";
    } catch (error) {
        status.textContent = error.message || "No se pudo quitar a esta persona.";
    }
});

leaveButton.addEventListener("click", async () => {
    const ok = await confirmAction({
        title: "Salir del viaje",
        message: "Dejarás de verlo y se borrará de este dispositivo. El propietario conserva el viaje y tus cambios en el historial.",
        confirmLabel: "Salir",
    });
    if (!ok) return;
    try {
        await leaveTrip(target.localId);
        dialog.close();
        toast("Has salido del viaje.", "success");
    } catch (error) {
        status.textContent = error.code === "OWNER_CANNOT_LEAVE"
            ? "Eres el propietario: elimina el viaje en su lugar."
            : "No se pudo salir del viaje.";
    }
});

// Somebody else changing the list while the dialog is open must not leave a
// stale roster on screen.
document.addEventListener("trip-members-changed", (event) => {
    if (dialog.open && event.detail?.tripId === target.localId) void loadMembers();
});
