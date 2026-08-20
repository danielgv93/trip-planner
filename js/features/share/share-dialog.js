// Owner-side control of the public link. Sharing lives in the cloud, so this
// dialog only makes sense for a trip that already has a remote copy; the
// library decides when to offer it.

import { store } from "../../core/store.js";
import { openModal } from "../../shared/modal.js";
import { toast } from "../../shared/notify.js";
import { readTripShare, shareTrip, unshareTrip } from "../cloud/coordinator.js";
import { publicShareUrl } from "./public-view.js";

const dialog = document.querySelector("#shareDialog");
const state = document.querySelector("#shareState");
const linkField = document.querySelector("#shareLinkField");
const linkInput = document.querySelector("#shareLink");
const copyButton = document.querySelector("#shareCopyBtn");
const publishButton = document.querySelector("#sharePublishBtn");
const revokeButton = document.querySelector("#shareRevokeBtn");
const status = document.querySelector("#shareStatus");

let remoteId = null;
let busy = false;

function paint(share) {
    const shared = Boolean(share?.shared && share.token);
    dialog.dataset.shared = String(shared);
    state.textContent = shared
        ? "Este viaje es público. Cualquiera con el enlace puede verlo, sin cuenta y sin poder editarlo."
        : "Este viaje es privado. Solo tú puedes verlo desde tu cuenta.";
    linkField.hidden = !shared;
    linkInput.value = shared ? publicShareUrl(share.token) : "";
    publishButton.hidden = shared;
    revokeButton.hidden = !shared;
    publishButton.disabled = busy;
    revokeButton.disabled = busy;
    copyButton.disabled = busy;
}

async function run(action, successMessage) {
    busy = true;
    status.textContent = "";
    publishButton.disabled = true;
    revokeButton.disabled = true;
    try {
        const share = await action(remoteId);
        busy = false;
        paint(share);
        status.textContent = successMessage;
    } catch {
        busy = false;
        status.textContent = "No se pudo cambiar la visibilidad. Comprueba tu conexión.";
        await refresh().catch(() => {});
    }
}

async function refresh() {
    paint(await readTripShare(remoteId));
}

export async function openShareDialog(id) {
    remoteId = id;
    busy = false;
    status.textContent = "";
    state.textContent = "Comprobando la visibilidad…";
    linkField.hidden = true;
    publishButton.hidden = true;
    revokeButton.hidden = true;
    openModal(dialog);
    try {
        await refresh();
    } catch {
        state.textContent = "No se pudo consultar la visibilidad de este viaje.";
        toast("No se pudo consultar la visibilidad del viaje.", "error");
    }
}

publishButton?.addEventListener("click", () => void run(shareTrip, "Enlace creado. Ya puedes compartirlo."));
revokeButton?.addEventListener("click", () => void run(
    unshareTrip,
    "El viaje vuelve a ser privado. El enlace anterior ya no funciona.",
));

copyButton?.addEventListener("click", async () => {
    if (!linkInput.value) return;
    try {
        await navigator.clipboard.writeText(linkInput.value);
        status.textContent = "Enlace copiado al portapapeles.";
    } catch {
        // Clipboard access is denied in plenty of contexts; selecting the text
        // still lets the owner copy it by hand.
        linkInput.select();
        status.textContent = "Copia el enlace seleccionado con Ctrl/Cmd + C.";
    }
});

// A trip that is not in the cloud has nowhere to publish from, and an expired
// session cannot mint a link.
export function canShareTrip(trip) {
    return Boolean(trip?.remote?.id) && Boolean(store.accountSession) && !trip.pendingDeletion;
}
