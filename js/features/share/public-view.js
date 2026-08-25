// Anonymous read-only viewing of a trip published through a share link.
//
// This is a separate bootstrap from the normal one on purpose: a visitor
// arriving from somebody else's link must never open the local trip
// repository, create a starter trip, or reach the cloud session. The plan is
// fetched, dropped into the store, and the store is sealed with
// `store.readOnly`, which stops `save()` at its only choke point.

import { normalizePlan } from "../../core/plan-json.js";
import { replacePlanState, store } from "../../core/store.js";
import { createCloudClient } from "../cloud/client.js";
import { cloudClientConfig } from "../cloud/config.js";
import { drawMap } from "../map/map.js";
import { syncTripNotes } from "../notes/notes.js";
import { applyTitle, render } from "../planner/render.js";
import { publicShareToken as parseShareToken, publicShareUrl as buildShareUrl } from "./share-url.js";

export const publicShareToken = (search = location.search) => parseShareToken(search);
export const publicShareUrl = (token, base = location) =>
    buildShareUrl(token, { origin: base.origin, pathname: base.pathname });

function showError(message) {
    const error = document.querySelector("#publicViewError");
    const detail = document.querySelector("#publicViewErrorDetail");
    if (detail) detail.textContent = message;
    if (error) error.hidden = false;
    document.body.classList.add("public-view-failed");
}

export async function bootstrapPublicView(token) {
    // The read-only seal and the hiding class go up before the first byte
    // arrives, so no interaction is possible while the plan loads.
    store.readOnly = true;
    // `read-only-plan` carries the editing lockdown shared with a collaborator
    // in the "lector" role; `public-view` adds what is specific to an anonymous
    // visitor — no library, no account, no assistant.
    document.body.classList.add("public-view", "read-only-plan");
    // Native read-only state, not just hidden controls: assistive technology
    // should announce these fields as unmodifiable too.
    for (const selector of ["#tripTitle", "#tripNotes"]) {
        const field = document.querySelector(selector);
        if (field) field.readOnly = true;
    }
    const client = createCloudClient(cloudClientConfig());
    let trip;
    try {
        trip = (await client.getPublicTrip(token)).trip;
    } catch (error) {
        showError(error.code === "SHARE_NOT_FOUND"
            ? "El enlace no existe o su autor dejó de compartir el viaje."
            : "No se pudo cargar el viaje compartido. Vuelve a intentarlo más tarde.");
        return { loaded: false };
    }
    replacePlanState(normalizePlan(trip.document), { persisted: true });
    // `replacePlanState` resets the flag, so the full-trip view is forced after
    // it: a visitor has no way back to an editing view.
    store.previewMode = true;
    document.body.classList.add("preview-mode");
    document.title = `${store.tripTitle} · Planificador de ruta`;
    applyTitle();
    syncTripNotes();
    render({ persist: false });
    drawMap();
    return { loaded: true, updatedAt: trip.updatedAt };
}
