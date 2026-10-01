// Adds a stop from outside the itinerary list: a right click / long press on the
// map, or a pasted Google Maps link. Both ask where the stop should go through
// the shared chooser, then either create it straight away (when the place is
// already named) or open the create dialog prefilled so it can be named.

import { classifyClipboardText, isValidCoordinate } from "../../core/maps-link.js";
import { dayBy, store } from "../../core/store.js";
import { fmt } from "../../shared/dom.js";
import { openChoiceMenu } from "../../shared/choice-menu.js";
import { toast } from "../../shared/notify.js";
import { getCloudClient } from "../cloud/coordinator.js";
import { reverseGeocode } from "../map/reverse-geocode.js";
import { createSpotAt } from "./commands.js";
import { openDialog, suggestPlaceDetails } from "./dialogs.js";

const SHORT_LINK_ERROR =
    "No se pudo leer ese enlace corto. Ábrelo en el navegador y copia la URL completa.";

// Read-only visitors, viewers and the full-trip preview never mutate the plan.
const canEdit = () => !store.readOnly && !store.previewMode;

function targetItems(verb) {
    const days = store.state.map((day) => {
        const date = day.date ? fmt(day.date) : null;
        return {
            value: day.id,
            label: `${verb} ${day.title || "día"}`,
            detail: date ? `${date.day} ${date.month}` : "",
        };
    });
    return [...days, { value: "backlog", label: "Añadir a ideas", tone: "ideas" }];
}

function targetLabel(targetId) {
    return targetId === "backlog" ? "ideas" : dayBy(targetId)?.title || "el día";
}

/**
 * Opens the chooser and then adds `place` ({ name?, address?, lat?, lng? }) to
 * the selected day (at its end) or to the ideas backlog.
 *
 * `createDirectly` creates the stop without the dialog when it has a name.
 */
function chooseTargetFor(place, { title, verb, anchor = null, createDirectly = false }) {
    if (!canEdit()) return;
    if (!store.state.length) {
        toast("Añade primero un día para poder guardar paradas.", "info");
        return;
    }
    openChoiceMenu({
        title,
        anchor,
        items: targetItems(verb),
        onSelect: (targetId) => void addPlaceTo(targetId, place, { createDirectly }),
    });
}

async function addPlaceTo(targetId, place, { createDirectly }) {
    if (!canEdit()) return;
    const hasCoordinates = isValidCoordinate(place.lat, place.lng);
    const location = hasCoordinates ? { lat: place.lat, lng: place.lng } : null;
    if (createDirectly && place.name) {
        const insertedAt = await createSpotAt(targetId, {
            name: place.name,
            address: place.address || "",
            ...(location || {}),
        });
        if (insertedAt !== null) toast(`“${place.name}” añadida a ${targetLabel(targetId)}.`, "info");
        return;
    }
    const token = openDialog(targetId, undefined, {
        name: place.name || "",
        address: place.address || "",
        location,
    });
    if (hasCoordinates && !place.name && !place.address) {
        const found = await reverseGeocode(place.lat, place.lng);
        if (found) suggestPlaceDetails(token, found);
    }
}

// The map module only reports where the user asked for a stop; this module owns
// everything that touches the plan.
document.addEventListener("map:add-place-request", (event) => {
    const { lat, lng, x, y } = event.detail || {};
    if (!isValidCoordinate(lat, lng)) return;
    chooseTargetFor(
        { lat, lng },
        { title: "Nueva parada en este punto", verb: "Añadir aquí a", anchor: { x, y } },
    );
});

function isEditableTarget(target) {
    return target instanceof Element && Boolean(
        target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"),
    ) || Boolean(target?.isContentEditable);
}

async function expandShortLink(url) {
    const client = getCloudClient();
    if (!client) throw new Error("cloud-unavailable");
    const { url: expanded } = await client.resolveMapsLink(url);
    const result = classifyClipboardText(expanded);
    if (result?.type !== "place") throw new Error("unreadable");
    return result.place;
}

async function handlePastedLink(link) {
    let place = link.place;
    if (link.type === "short") {
        toast("Leyendo el enlace de Google Maps…", "info", 1800);
        try {
            place = await expandShortLink(link.url);
        } catch {
            toast(SHORT_LINK_ERROR, "error", 6000);
            return;
        }
    }
    chooseTargetFor(place, {
        title: place.name ? `Añadir “${place.name}”` : "Añadir lugar de Google Maps",
        verb: "Añadir a",
        createDirectly: true,
    });
}

document.addEventListener("paste", (event) => {
    if (event.defaultPrevented || !canEdit()) return;
    if (isEditableTarget(event.target) || isEditableTarget(document.activeElement)) return;
    if (document.querySelector("dialog[open]")) return;
    const link = classifyClipboardText(event.clipboardData?.getData("text/plain") || "");
    if (!link) return;
    event.preventDefault();
    void handlePastedLink(link);
});
