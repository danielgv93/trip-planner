// The add/edit place dialog (with Nominatim search) and the tag / category
// manager dialogs. Wires its own listeners on module load.

import { store, save, dayBy } from "../../core/store.js?v=28";
import { $, esc, slug, id } from "../../shared/dom.js";
import { toast, confirmAction } from "../../shared/notify.js?v=4";
import { render } from "./render.js";
import { pushUndo } from "./history.js";
import { categoryDefaultSpotKind, spotKind } from "../../core/itinerary.js";
import {
    drawMap,
    setPreview,
    openPreview,
    clearPreviewMarker,
} from "../map/map.js";

const dialog = $("#placeDialog");
const tagDialog = $("#tagDialog");
const categoryDialog = $("#categoryDialog");

// { dayId, spot } target of the currently open place dialog. Only this module
// touches it, so it stays a module-local rather than living in the store.
let editing = null;
let kindTouched = false;
let searchTimer;
let searchController;

// Google Maps exposes copied coordinates as "latitude, longitude". Recognize
// that exact shape locally so choosing a point does not depend on geocoding.
function parseCoordinates(value) {
    const number = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
    const match = value.match(
        new RegExp(`^\\s*(${number})\\s*,\\s*(${number})\\s*$`),
    );
    if (!match) return null;

    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return { error: true };
    }
    return {
        lat,
        lng,
        display_name: `Coordenadas (${lat.toFixed(6)}, ${lng.toFixed(6)})`,
    };
}

function preferredPlaceName(place) {
    const names =
        place?.namedetails && typeof place.namedetails === "object"
            ? place.namedetails
            : {};
    const preferredKeys = [
        "name:es",
        "official_name:es",
        "name:en",
        "official_name:en",
        "int_name",
        "name:ja-Latn",
        "name",
    ];
    const preferred = preferredKeys
        .map((key) => names[key])
        .find((name) => typeof name === "string" && name.trim());
    return preferred || place.display_name?.split(",")[0] || "Lugar";
}

function localizedDisplayName(place) {
    const preferredName = preferredPlaceName(place);
    const parts = String(place.display_name || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    if (!parts.length) return preferredName;
    parts[0] = preferredName;
    return parts.join(", ");
}

function cancelPendingSearch() {
    clearTimeout(searchTimer);
    searchController?.abort();
    searchController = undefined;
}

// Native time inputs normally provide this shape, but stored/imported data may
// not. Keep only canonical 24-hour values before they reach the form or state.
export function normalizeTime(value) {
    return typeof value === "string" &&
        /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
        ? value
        : undefined;
}

function renderTagOptions(selected = []) {
    const el = $("#tagOptions");
    el.innerHTML = store.tags.length
        ? ""
        : '<small class="form-hint">Crea etiquetas desde el gestor para clasificarlas.</small>';
    store.tags.forEach((tag) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className =
            "tag-option " + (selected.includes(tag) ? "selected" : "");
        b.textContent = "#" + tag;
        b.onclick = () => b.classList.toggle("selected");
        el.append(b);
    });
}

function selectedTags() {
    return [...document.querySelectorAll("#tagOptions .selected")].map((x) =>
        x.textContent.slice(1),
    );
}

function renderCategoryOptions(selected = []) {
    const el = $("#categoryOptions");
    el.innerHTML = "";
    store.categories.forEach((c) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className =
            "category-option " + (selected.includes(c.id) ? "selected" : "");
        b.dataset.category = c.id;
        b.style.setProperty("--category-color", c.color);
        b.textContent = c.label;
        b.onclick = () => {
            const wasSelected = b.classList.contains("selected");
            el.querySelectorAll(".category-option").forEach((x) =>
                x.classList.remove("selected"),
            );
            if (!wasSelected) b.classList.add("selected");
            if (!editing?.spot && !kindTouched && !wasSelected) {
                const category = store.categories.find((item) => item.id === c.id);
                setPlaceKind(categoryDefaultSpotKind(category));
            }
        };
        el.append(b);
    });
}

function setPlaceKind(kind) {
    const resolved = kind === "waypoint" ? "waypoint" : "activity";
    const waypoint = resolved === "waypoint";
    $("#placeIsWaypoint").checked = waypoint;
    dialog.classList.toggle("is-waypoint", waypoint);
    dialog.querySelectorAll("[data-activity-only]").forEach((field) => {
        field.hidden = waypoint;
        field.disabled = waypoint;
    });
    const state = dialog.querySelector(".spot-kind-state");
    state.textContent = waypoint
        ? "Se tratará como un hito de duración cero. Los datos de visita se conservarán por si cambias de opción."
        : "";
}

$("#placeIsWaypoint").addEventListener("change", (event) => {
    kindTouched = true;
    setPlaceKind(event.target.checked ? "waypoint" : "activity");
});

function selectedCategory() {
    const el = $("#categoryOptions .selected");
    return el ? el.dataset.category : undefined;
}

export function openDialog(dayId, spot, prefill = {}) {
    cancelPendingSearch();
    editing = {
        dayId,
        spot,
        backlogGroupId: prefill.backlogGroupId,
        onSave: typeof prefill.onSave === "function" ? prefill.onSave : null,
    };
    kindTouched = Boolean(spot);
    setPlaceKind(spotKind(spot));
    store.selectedLocation =
        Number.isFinite(spot?.lat) && Number.isFinite(spot?.lng)
            ? {
                  lat: spot.lat,
                  lng: spot.lng,
                  display_name: spot.address || spot.name,
              }
            : null;
    $("#dialogTitle").textContent = spot ? "Editar parada" : "Añadir una parada";
    $("#placeName").value = spot
        ? spot.name || ""
        : typeof prefill?.name === "string"
          ? prefill.name
          : "";
    $("#placeAddress").value = spot?.address || "";
    $("#placeNote").value = spot?.note || "";
    $("#placeCost").value = Number.isFinite(spot?.cost) ? spot.cost : "";
    $("#placeCostCurrency").textContent = store.foreignCurrency;
    $("#placeOpeningTime").value = normalizeTime(spot?.openingTime) || "";
    $("#placeClosingTime").value = normalizeTime(spot?.closingTime) || "";
    $("#placeVisitMinutes").value =
        Number.isInteger(spot?.visitMinutes) && spot.visitMinutes > 0
            ? spot.visitMinutes
            : "";
    $("#placePlannedStart").value = normalizeTime(spot?.plannedStart) || "";
    $("#placeFixedStart").checked = spot?.fixedStart === true;
    $("#placeOptional").checked = spot?.optional === true;
    $("#placeScheduleNotApplicable").checked = spot?.scheduleNotApplicable === true;
    $("#placeDetails").open = !!spot;
    $("#resetCost").hidden = !spot;
    renderTagOptions(spot?.tags || []);
    renderCategoryOptions(spot?.category ? [spot.category] : []);
    $("#suggestions").hidden = true;
    $("#searchStatus").textContent = store.selectedLocation
        ? "Ubicación actual: " + store.selectedLocation.display_name
        : "Busca un lugar o pega coordenadas en formato latitud, longitud.";
    dialog.showModal();
    openPreview(store.selectedLocation);
    const focusTargets = {
        duration: "#placeVisitMinutes",
        location: "#placeAddress",
        schedule: "#placeOpeningTime",
        reservation: "#placePlannedStart",
    };
    const focusTarget = focusTargets[prefill.focus];
    if (focusTarget) {
        $("#placeDetails").open = true;
        $(focusTarget).focus();
    } else $("#placeName").focus();
    const prefilledName =
        !spot &&
        typeof prefill?.name === "string" &&
        prefill.name.trim();
    if (prefilledName) queueSearch(prefilledName, { clearsLocation: false });
}

async function searchPlaces(q) {
    searchController?.abort();
    const controller = new AbortController();
    searchController = controller;

    if (q.length < 3) {
        $("#suggestions").hidden = true;
        $("#searchStatus").textContent =
            "Escribe al menos 3 caracteres para buscar.";
        searchController = undefined;
        return;
    }
    $("#searchStatus").textContent = "Buscando lugares…";
    try {
        const r = await fetch(
            "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=1&namedetails=1&accept-language=es,en&q=" +
                encodeURIComponent(q),
            {
                headers: { "Accept-Language": "es, en;q=0.9" },
                signal: controller.signal,
            },
        );
        if (!r.ok) throw new Error(`Nominatim respondió con ${r.status}`);
        const response = await r.json();
        if (controller !== searchController) return;
        const results = Array.isArray(response) ? response.slice(0, 5) : [],
            box = $("#suggestions");
        box.innerHTML = "";
        results.forEach((place) => {
            const displayName = localizedDisplayName(place);
            const b = document.createElement("button");
            b.type = "button";
            b.className = "suggestion";
            b.innerHTML = `<b>${esc(preferredPlaceName(place))}</b><small>${esc(displayName)}</small>`;
            b.onclick = () => {
                $("#placeAddress").value = displayName;
                box.hidden = true;
                setPreview({
                    lat: +place.lat,
                    lng: +place.lon,
                    display_name: displayName,
                });
            };
            box.append(b);
        });
        box.hidden = !results.length;
        $("#searchStatus").textContent = results.length
            ? "Elige una sugerencia para ver el punto exacto."
            : "No se han encontrado resultados.";
    } catch (error) {
        if (error?.name === "AbortError" || controller !== searchController)
            return;
        $("#searchStatus").textContent =
            "No se ha podido buscar ahora. Puedes guardar la parada manualmente.";
    } finally {
        if (controller === searchController) searchController = undefined;
    }
}

function queueSearch(query, { clearsLocation }) {
    clearTimeout(searchTimer);
    searchController?.abort();
    searchController = undefined;
    if (clearsLocation) {
        store.selectedLocation = null;
        clearPreviewMarker();
    }
    searchTimer = setTimeout(() => searchPlaces(query), 450);
}

$("#placeName").addEventListener("input", (e) => {
    queueSearch(e.target.value.trim(), { clearsLocation: false });
});

$("#placeAddress").addEventListener("input", (e) => {
    const query = e.target.value.trim();
    const coordinates = parseCoordinates(query);
    if (!coordinates) {
        queueSearch(query, { clearsLocation: true });
        return;
    }

    cancelPendingSearch();
    $("#suggestions").hidden = true;
    store.selectedLocation = null;
    clearPreviewMarker();
    if (coordinates.error) {
        $("#searchStatus").textContent =
            "Coordenadas no válidas: la latitud debe estar entre −90 y 90 y la longitud entre −180 y 180.";
        return;
    }
    setPreview(coordinates);
});

$("#resetCost").addEventListener("click", () => {
    $("#placeCost").value = "0";
    $("#placeCost").focus();
});

$("#placeScheduleNotApplicable").addEventListener("change", (event) => {
    if (!event.target.checked) return;
    $("#placeOpeningTime").value = "";
    $("#placeClosingTime").value = "";
});
[$("#placeOpeningTime"), $("#placeClosingTime")].forEach((input) =>
    input.addEventListener("input", () => {
        if (input.value) $("#placeScheduleNotApplicable").checked = false;
    }),
);

$("#placeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#placeName").value.trim(),
        address = $("#placeAddress").value.trim(),
        note = $("#placeNote").value.trim(),
        costValue = $("#placeCost").value.trim(),
        openingTime = normalizeTime($("#placeOpeningTime").value),
        closingTime = normalizeTime($("#placeClosingTime").value),
        plannedStart = normalizeTime($("#placePlannedStart").value),
        parsedCost = Number(costValue),
        cost =
            costValue !== "" && Number.isFinite(parsedCost) && parsedCost > 0
                ? parsedCost
                : undefined,
        visitMinutesValue = $("#placeVisitMinutes").value.trim(),
        parsedVisitMinutes = Number(visitMinutesValue),
        visitMinutes =
            visitMinutesValue !== "" &&
            Number.isInteger(parsedVisitMinutes) &&
            parsedVisitMinutes > 0
                ? parsedVisitMinutes
                : undefined,
        coordinates = store.selectedLocation || null,
        spotTags = selectedTags(),
        category = selectedCategory(),
        fixedStart = $("#placeFixedStart").checked,
        optional = $("#placeOptional").checked,
        scheduleNotApplicable = $("#placeScheduleNotApplicable").checked;
    const kind = $("#placeIsWaypoint").checked ? "waypoint" : "activity";
    if (fixedStart && !plannedStart) {
        toast("Añade una hora planificada antes de marcar la reserva como fija.", "error");
        $("#placePlannedStart").focus();
        return;
    }
    const target =
        editing.dayId === "backlog" ? store.backlog : dayBy(editing.dayId).spots;
    let spot = editing.spot;
    pushUndo();
    if (spot) {
        Object.assign(spot, {
            name,
            address,
            note,
            tags: spotTags,
            kind,
        });
        if (coordinates)
            Object.assign(spot, {
                lat: coordinates.lat,
                lng: coordinates.lng,
            });
        else (delete spot.lat, delete spot.lng);
        if (category) spot.category = category;
        else delete spot.category;
    } else {
        spot = { id: id(), name, address, note, tags: spotTags, kind };
        if (editing.dayId === "backlog" && editing.backlogGroupId)
            spot.backlogGroupId = editing.backlogGroupId;
        if (coordinates)
            Object.assign(spot, {
                lat: coordinates.lat,
                lng: coordinates.lng,
            });
        if (category) spot.category = category;
        target.push(spot);
    }
    if (cost === undefined) delete spot.cost;
    else spot.cost = cost;
    if (visitMinutes === undefined) delete spot.visitMinutes;
    else spot.visitMinutes = visitMinutes;
    if (openingTime === undefined) delete spot.openingTime;
    else spot.openingTime = openingTime;
    if (closingTime === undefined) delete spot.closingTime;
    else spot.closingTime = closingTime;
    if (plannedStart === undefined) delete spot.plannedStart;
    else spot.plannedStart = plannedStart;
    if (fixedStart) spot.fixedStart = true; else delete spot.fixedStart;
    if (optional) spot.optional = true; else delete spot.optional;
    if (scheduleNotApplicable) spot.scheduleNotApplicable = true; else delete spot.scheduleNotApplicable;
    const onSave = editing.onSave;
    store.active = editing.dayId;
    dialog.close();
    save();
    render();
    drawMap();
    onSave?.();
});

dialog.querySelector(".close").onclick = dialog.querySelector(
    ".cancel",
).onclick = () => dialog.close();
dialog.addEventListener("close", cancelPendingSearch);

// A click whose target is the <dialog> itself happened on its backdrop, rather
// than on the dialog content. Keep clicks inside forms and managers untouched.
[dialog, tagDialog, categoryDialog].forEach((modal) => {
    modal.addEventListener("click", (event) => {
        if (event.target === modal) modal.close();
    });
});

function renderManagerTags() {
    const list = $("#managerTags");
    list.innerHTML = store.tags.length
        ? ""
        : '<p class="form-hint manager-empty">Aún no hay etiquetas. Añade la primera arriba.</p>';
    store.tags.forEach((tag) => {
        const row = document.createElement("div");
        row.className = "manager-tag";

        const prefix = document.createElement("span");
        prefix.className = "manager-tag-prefix";
        prefix.textContent = "#";
        prefix.setAttribute("aria-hidden", "true");

        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "manager-tag-name";
        nameInput.value = tag;
        nameInput.setAttribute("aria-label", `Nombre de la etiqueta ${tag}`);
        let currentTag = tag;
        const commitRename = () => {
            const nextTag = nameInput.value
                .trim()
                .replace(/^#/, "")
                .toLowerCase();
            if (!nextTag) {
                nameInput.value = currentTag;
                toast("El nombre de la etiqueta no puede estar vacío.", "error");
                return;
            }
            if (
                nextTag !== currentTag &&
                store.tags.some((existing) => existing === nextTag)
            ) {
                nameInput.value = currentTag;
                toast(`La etiqueta #${nextTag} ya existe.`, "error");
                return;
            }
            nameInput.value = nextTag;
            if (nextTag === currentTag) return;

            const previousTag = currentTag;
            pushUndo();
            const index = store.tags.indexOf(previousTag);
            if (index !== -1) store.tags[index] = nextTag;
            [...store.state.flatMap((d) => d.spots), ...store.backlog].forEach(
                (spot) => {
                    if (!(spot.tags || []).includes(previousTag)) return;
                    spot.tags = [
                        ...new Set(
                            (spot.tags || []).map((spotTag) =>
                                spotTag === previousTag ? nextTag : spotTag,
                            ),
                        ),
                    ];
                },
            );
            if (store.activeTagFilter.delete(previousTag))
                store.activeTagFilter.add(nextTag);
            currentTag = nextTag;
            nameInput.setAttribute(
                "aria-label",
                `Nombre de la etiqueta ${nextTag}`,
            );
            delBtn.setAttribute("aria-label", `Borrar etiqueta ${nextTag}`);
            save();
            render();
            drawMap();
            toast(`Etiqueta #${previousTag} renombrada a #${nextTag}.`, "info");
        };
        nameInput.addEventListener("blur", commitRename);
        nameInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") nameInput.blur();
            if (event.key === "Escape") {
                nameInput.value = currentTag;
                nameInput.blur();
            }
        });

        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "cat-del";
        delBtn.title = "Borrar etiqueta";
        delBtn.setAttribute("aria-label", `Borrar etiqueta ${tag}`);
        delBtn.textContent = "×";
        delBtn.onclick = () => {
            confirmAction({
                title: "Borrar etiqueta",
                message: `¿Borrar la etiqueta #${currentTag} de todas las paradas?`,
            }).then((ok) => {
                if (!ok) return;
                pushUndo();
                store.tags = store.tags.filter((t) => t !== currentTag);
                [...store.state.flatMap((d) => d.spots), ...store.backlog].forEach(
                    (s) =>
                        (s.tags = (s.tags || []).filter(
                            (t) => t !== currentTag,
                        )),
                );
                store.activeTagFilter.delete(currentTag);
                save();
                render();
                drawMap();
                renderManagerTags();
                toast(`Etiqueta #${currentTag} eliminada.`, "info");
            });
        };
        row.append(prefix, nameInput, delBtn);
        list.append(row);
    });
}

$("#manageTags").onclick = () => {
    renderManagerTags();
    tagDialog.showModal();
};
tagDialog.querySelector(".close").onclick = () => tagDialog.close();
$("#addTag").onclick = () => {
    const value = $("#newTag").value.trim().replace(/^#/, "").toLowerCase();
    if (value && !store.tags.includes(value)) {
        pushUndo();
        store.tags.push(value);
        $("#newTag").value = "";
        save();
        render();
        renderManagerTags();
    }
};

function renderManagerCategories() {
    const list = $("#managerCategories");
    list.innerHTML = store.categories.length
        ? ""
        : '<p class="form-hint manager-empty">Aún no hay categorías. Añade la primera arriba.</p>';
    store.categories.forEach((c) => {
        const row = document.createElement("div");
        row.className = "manager-category";
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "manager-category-name";
        nameInput.value = c.label;
        let lastValid = c.label;
        nameInput.addEventListener("input", (e) => {
            c.label = e.target.value;
            save();
            render();
            drawMap();
        });
        nameInput.addEventListener("blur", (e) => {
            const trimmed = e.target.value.trim();
            if (!trimmed) {
                e.target.value = lastValid;
                c.label = lastValid;
                save();
                render();
                drawMap();
            } else {
                lastValid = trimmed;
            }
        });
        const colorInput = document.createElement("input");
        colorInput.type = "color";
        colorInput.className = "cat-swatch";
        colorInput.title = "Color de la categoría";
        colorInput.value = c.color;
        colorInput.addEventListener("input", (e) => {
            c.color = e.target.value;
            save();
            render();
            drawMap();
        });
        const connectToggle = document.createElement("label");
        connectToggle.className = "connect-toggle";
        const sw = document.createElement("span");
        sw.className = "switch";
        const swInput = document.createElement("input");
        swInput.type = "checkbox";
        swInput.checked = c.connects !== false;
        const slider = document.createElement("span");
        slider.className = "slider";
        const swIcon = document.createElement("span");
        swIcon.className = "connect-icon";
        swIcon.textContent = "🔗";
        swIcon.setAttribute("aria-hidden", "true");
        // Icon-only label: the tooltip + aria-label carry the meaning, and the 🔗
        // dims (see .is-off) when the category is a loose point.
        const syncConnect = () => {
            const on = swInput.checked;
            connectToggle.classList.toggle("is-off", !on);
            const msg = on
                ? "Nexo activo: esta categoría se une con la línea de la ruta. Toca para desconectar."
                : "Punto suelto: mantiene su número en el mapa pero no se conecta con líneas. Toca para conectar.";
            connectToggle.title = msg;
            swInput.setAttribute("aria-label", msg);
        };
        swInput.addEventListener("change", (e) => {
            c.connects = e.target.checked;
            syncConnect();
            save();
            drawMap();
        });
        sw.append(swInput, slider);
        connectToggle.append(sw, swIcon);
        syncConnect();
        const kindSelect = document.createElement("select");
        kindSelect.className = "category-kind-select";
        kindSelect.title = "Tipo sugerido para nuevas paradas";
        kindSelect.setAttribute("aria-label", `Tipo sugerido de ${c.label}`);
        kindSelect.innerHTML = '<option value="activity">Visita</option><option value="waypoint">Solo paso</option>';
        kindSelect.value = categoryDefaultSpotKind(c);
        kindSelect.addEventListener("change", (event) => {
            c.defaultSpotKind = event.target.value === "waypoint" ? "waypoint" : "activity";
            save();
        });
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "cat-del";
        delBtn.title = "Borrar categoría";
        delBtn.setAttribute("aria-label", "Borrar categoría");
        delBtn.textContent = "×";
        delBtn.onclick = () => {
            const n = [
                ...store.state.flatMap((d) => d.spots),
                ...store.backlog,
            ].filter((s) => s.category === c.id).length;
            confirmAction({
                title: "Borrar categoría",
                message: `¿Borrar la categoría "${c.label}"? ${n} parada(s) quedarán sin categoría.`,
            }).then((ok) => {
                if (!ok) return;
                store.categories = store.categories.filter((x) => x.id !== c.id);
                [
                    ...store.state.flatMap((d) => d.spots),
                    ...store.backlog,
                ].forEach((s) => {
                    if (s.category === c.id) delete s.category;
                });
                save();
                render();
                drawMap();
                renderManagerCategories();
                toast(`Categoría "${c.label}" eliminada.`, "info");
            });
        };
        const controls = document.createElement("div");
        controls.className = "cat-controls";
        controls.append(kindSelect, connectToggle, delBtn);
        row.append(colorInput, nameInput, controls);
        list.append(row);
    });
}

$("#manageCategories").onclick = () => {
    renderManagerCategories();
    categoryDialog.showModal();
};
categoryDialog.querySelector(".close").onclick = () => categoryDialog.close();
$("#addCategory").onclick = () => {
    const name = $("#newCategoryName").value.trim();
    if (!name) return;
    const color = $("#newCategoryColor").value;
    let catId = slug(name);
    if (store.categories.some((c) => c.id === catId))
        catId += "-" + Date.now().toString(36);
    store.categories.push({ id: catId, label: name, color, connects: true, defaultSpotKind: $("#newCategoryKind").value === "waypoint" ? "waypoint" : "activity" });
    $("#newCategoryName").value = "";
    save();
    render();
    drawMap();
    renderManagerCategories();
};
