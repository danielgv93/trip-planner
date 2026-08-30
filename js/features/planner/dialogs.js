// The add/edit place dialog (with Nominatim search) and the tag / category
// manager dialogs. Wires its own listeners on module load.

import { store, dayBy } from "../../core/store.js";
import { $, esc, safeColor, slug, id } from "../../shared/dom.js";
import { openModal } from "../../shared/modal.js";
import { toast, confirmAction } from "../../shared/notify.js";
import { categoryDefaultSpotKind, dayPositionConstraintViolation, positionConstraintInsertionIndex, spotKind, spotPositionConstraint } from "../../core/itinerary.js";
import { buildTimelineProjection } from "../timeline/timeline.js";
import {
    PLACE_FOCUS_TARGETS,
    buildPlaceSummary,
    findTimelineItem,
    normalizePlaceDraft,
    placeDraftChanged,
} from "./place-inspector.js";
import {
    setPreview,
    openPreview,
    openReadPreview,
    clearPreviewMarker,
} from "../map/map.js";
import { reminderReadMarkup } from "../reminders/presentation.js";
import { registerActiveEditor } from "./active-editor.js";
import { createDraftAutosaveController } from "../../shared/draft-autosave.js";
import { targetFingerprint } from "../../core/plan-operations.js";
import {
    commandIntent,
    derivedPlanOperation,
    insertEntityIntent,
    setFieldIntent,
    updateFieldsIntent,
} from "../../core/plan-operation-commit.js";

const dialog = $("#placeDialog");
const tagDialog = $("#tagDialog");
const categoryDialog = $("#categoryDialog");

// { dayId, spot } target of the currently open place dialog. Only this module
// touches it, so it stays a module-local rather than living in the store.
let editing = null;
let kindTouched = false;
let placeMode = "read";
let initialDraft = null;
let returnFocus = null;
let searchTimer;
let searchController;
let unregisterActiveEditor = null;
let placeAutosave = null;

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

const clearableTimeInputs = [
    ...document.querySelectorAll(".clearable-time-input"),
];

function syncClearableTimeInput(container) {
    const input = container.querySelector('input[type="time"]');
    container.querySelector(".clear-time-input").hidden = !input.value;
}

function syncClearableTimeInputs() {
    clearableTimeInputs.forEach(syncClearableTimeInput);
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
        b.setAttribute("aria-pressed", selected.includes(tag) ? "true" : "false");
        b.onclick = () => {
            b.classList.toggle("selected");
            b.setAttribute("aria-pressed", b.classList.contains("selected") ? "true" : "false");
            updatePlaceEditorState();
        };
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
        b.style.setProperty("--category-color", safeColor(c.color));
        b.textContent = c.label;
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", selected.includes(c.id) ? "true" : "false");
        b.onclick = () => {
            const wasSelected = b.classList.contains("selected");
            el.querySelectorAll(".category-option").forEach((x) =>
                x.classList.remove("selected"),
            );
            if (!wasSelected) b.classList.add("selected");
            el.querySelectorAll(".category-option").forEach((option) =>
                option.setAttribute("aria-checked", option.classList.contains("selected") ? "true" : "false"),
            );
            if (!editing?.spot && !kindTouched && !wasSelected) {
                const category = store.categories.find((item) => item.id === c.id);
                setPlaceKind(categoryDefaultSpotKind(category));
            }
            updatePlaceEditorState();
        };
        el.append(b);
    });
}

function setPlaceKind(kind) {
    const resolved = kind === "waypoint" ? "waypoint" : "activity";
    const waypoint = resolved === "waypoint";
    $("#placeIsWaypoint").checked = waypoint;
    dialog.querySelector('input[name="placeKind"][value="activity"]').checked = !waypoint;
    dialog.classList.toggle("is-waypoint", waypoint);
    dialog.querySelectorAll("[data-activity-only]").forEach((field) => {
        field.hidden = waypoint;
        field.disabled = waypoint;
    });
    const state = dialog.querySelector(".spot-kind-state");
    state.textContent = waypoint
        ? "Punto de paso: conserva llegada, ubicación y ruta. Los datos de visita se mantienen mientras editas."
        : "Actividad: puede incluir duración, horario y reserva.";
    $("#placeDialogStatus").textContent = state.textContent;
    updateGroupSummaries();
}

dialog.querySelectorAll('input[name="placeKind"]').forEach((input) =>
    input.addEventListener("change", (event) => {
        if (!event.target.checked) return;
        kindTouched = true;
        setPlaceKind(event.target.value);
        updatePlaceEditorState();
    }),
);

function selectedCategory() {
    const el = $("#categoryOptions .selected");
    return el ? el.dataset.category : undefined;
}

function positionConstraintValue() {
    return dialog.querySelector('input[name="placePositionConstraint"]:checked')?.value || "";
}

function setPositionConstraint(value) {
    const resolved = spotPositionConstraint({ positionConstraint: value }) || "";
    const input = dialog.querySelector(`input[name="placePositionConstraint"][value="${resolved}"]`);
    if (input) input.checked = true;
}

function focusPositionConstraint() {
    dialog.querySelector('input[name="placePositionConstraint"]:checked')?.focus();
}

function syncPositionConstraint() {
    const control = $("#placePositionConstraint");
    const backlog = editing?.dayId === "backlog";
    control.disabled = backlog;
    if (backlog) setPositionConstraint("");
    const constrained = !backlog && Boolean(positionConstraintValue());
    const optional = $("#placeOptional");
    if (constrained) optional.checked = false;
    optional.disabled = constrained;
    $("#placePositionConstraintHint").textContent = backlog
        ? "Mueve la parada a un día para poder anclarla."
        : constrained
          ? "Esta parada será obligatoria y no podrá moverse de día ni al backlog."
          : "Las mejoras y los movimientos podrán cambiar su posición.";
}

$("#placePositionConstraint").addEventListener("change", syncPositionConstraint);

function placeFormDraft() {
    const location = store.selectedLocation;
    return {
        name: $("#placeName").value, address: $("#placeAddress").value, note: $("#placeNote").value,
        tags: selectedTags(), category: selectedCategory(),
        kind: $("#placeIsWaypoint").checked ? "waypoint" : "activity",
        lat: location?.lat, lng: location?.lng, cost: $("#placeCost").value,
        visitMinutes: $("#placeVisitMinutes").value, openingTime: $("#placeOpeningTime").value,
        closingTime: $("#placeClosingTime").value, plannedStart: $("#placePlannedStart").value,
        fixedStart: $("#placeFixedStart").checked, optional: $("#placeOptional").checked,
        scheduleNotApplicable: $("#placeScheduleNotApplicable").checked,
        positionConstraint: positionConstraintValue(), mapEnabled: editing?.spot?.mapEnabled !== false,
    };
}

function openPlaceGroup(name) {
    dialog.querySelectorAll(".place-editor-group").forEach((group) => {
        group.open = group.dataset.placeGroup === name;
    });
}

function updateGroupSummaries() {
    if (!editing) return;
    const draft = normalizePlaceDraft(placeFormDraft());
    $("#placeLocationSummary").textContent = store.selectedLocation
        ? `Ubicación confirmada · ${Number(store.selectedLocation.lat).toFixed(4)}, ${Number(store.selectedLocation.lng).toFixed(4)}`
        : draft.address || "Añadir ubicación";
    const schedule = [];
    if (draft.kind === "waypoint") schedule.push(draft.plannedStart ? `Llegada ${draft.plannedStart}` : "Añadir llegada");
    else {
        if (draft.scheduleNotApplicable) schedule.push("Sin horario aplicable");
        else if (draft.openingTime || draft.closingTime) schedule.push([draft.openingTime, draft.closingTime].filter(Boolean).join("–"));
        if (draft.visitMinutes) schedule.push(`${draft.visitMinutes} min`);
        if (draft.plannedStart) schedule.push(`${draft.fixedStart ? "Reserva" : "Inicio"} ${draft.plannedStart}`);
    }
    $("#placeScheduleSummary").textContent = schedule.join(" · ") || "Añadir horario o duración";
    const additional = [];
    if (draft.tags.length) additional.push(`${draft.tags.length} etiqueta${draft.tags.length === 1 ? "" : "s"}`);
    if (draft.cost) additional.push(`${draft.cost} ${store.foreignCurrency}`);
    if (draft.note) additional.push("Con nota");
    if (draft.positionConstraint) additional.push({ first: "Primera", locked: "Posición fija", last: "Última" }[draft.positionConstraint]);
    $("#placeAdditionalSummary").textContent = additional.filter(Boolean).join(" · ") || "Añadir coste, etiquetas o nota";
}

function clearPlaceErrors() {
    dialog.querySelectorAll(".place-field-error").forEach((error) => (error.textContent = ""));
    dialog.querySelectorAll("[aria-invalid]").forEach((control) => control.removeAttribute("aria-invalid"));
}

function placeValidation({ reveal = false, focus = true } = {}) {
    clearPlaceErrors();
    const errors = [];
    const add = (selector, group, errorId, message) => errors.push({ selector, group, errorId, message });
    if (!$("#placeName").value.trim()) add("#placeName", "essential", "placeNameError", "Escribe un nombre para guardar la parada.");
    const duration = $("#placeVisitMinutes").value.trim();
    if (duration && (!Number.isInteger(Number(duration)) || Number(duration) <= 0)) add("#placeVisitMinutes", "schedule", "placeVisitMinutesError", "La duración debe ser un número entero positivo.");
    const cost = $("#placeCost").value.trim();
    if (cost && (!Number.isFinite(Number(cost)) || Number(cost) < 0)) add("#placeCost", "additional", "placeCostError", "El coste debe ser cero o un número positivo.");
    if ($("#placeFixedStart").checked && !$("#placePlannedStart").value) add("#placePlannedStart", "schedule", "placePlannedStartError", "Añade una hora antes de fijar la reserva.");
    if (reveal && errors.length) {
        errors.forEach(({ selector, errorId, message }) => { $(selector).setAttribute("aria-invalid", "true"); $("#" + errorId).textContent = message; });
        if (focus) {
            openPlaceGroup(errors[0].group);
            $(errors[0].selector).focus();
        }
    }
    return errors;
}

function updatePlaceEditorState() {
    if (!editing || placeMode === "read") return;
    updateGroupSummaries();
    const dirty = initialDraft ? placeDraftChanged(initialDraft, placeFormDraft()) : false;
    const errors = placeValidation({ reveal: true, focus: false });
    $("#placeSaveButton").disabled = !dirty || errors.length > 0;
    $("#placeSaveButton").title = !dirty ? "Completa la nueva parada" : errors.length ? "Corrige los campos indicados" : "Añadir parada";
    dialog.classList.toggle("is-dirty", dirty);
}

function renderPlaceReadPanel(spot) {
    const day = editing?.dayId === "backlog" ? null : dayBy(editing?.dayId);
    const projection = day ? buildTimelineProjection(day) : null;
    const summary = buildPlaceSummary(spot, { categories: store.categories, currency: store.foreignCurrency, timelineItem: findTimelineItem(projection, spot?.id) });
    const category = summary.identity.category
        ? `<span class="place-read-chip is-category" style="--category-color:${safeColor(summary.identity.category.color)}">${esc(summary.identity.category.label)}</span>`
        : '<span class="place-read-empty">Sin categoría</span>';
    const tags = summary.identity.tags.length ? summary.identity.tags.map((tag) => `<span class="place-read-chip">#${esc(tag)}</span>`).join("") : '<span class="place-read-empty">Sin etiquetas</span>';
    const temporalStart = summary.temporal.plannedStart || summary.temporal.projectedStart;
    const temporalItems = [
        temporalStart
            ? {
                  label: summary.identity.kind === "waypoint"
                      ? summary.temporal.plannedStart ? "Llegada planificada" : "Llegada estimada"
                      : summary.temporal.fixedStart ? "Reserva" : summary.temporal.plannedStart ? "Inicio planificado" : "Inicio estimado",
                  value: temporalStart,
              }
            : null,
        summary.identity.kind !== "waypoint" && summary.temporal.duration !== "Sin duración"
            ? { label: "Duración", value: summary.temporal.duration }
            : null,
        summary.identity.kind !== "waypoint" && summary.temporal.projectedEnd
            ? { label: "Salida prevista", value: summary.temporal.projectedEnd }
            : null,
    ].filter(Boolean);
    const temporalPlan = temporalItems.length
        ? `<div class="place-read-plan" style="--plan-columns:${temporalItems.length}">${temporalItems.map((item) => `<span><small>${esc(item.label)}</small><b>${esc(item.value)}</b></span>`).join("")}</div>`
        : '<p class="place-read-plan-empty">Todavía no hay una hora ni una duración planificadas.</p>';
    $("#placeReadPanel").innerHTML = `<div class="place-read-hero"><span class="place-read-kicker">${esc(summary.identity.kindLabel)}</span><h4>${esc(summary.identity.name)}</h4><div class="place-read-chips">${category}${tags}<span class="place-read-chip ${summary.enabled ? "" : "is-off"}">${esc(summary.enabledLabel)}</span></div></div>
    <section class="place-read-card place-read-location"><div class="place-read-card-head"><span>Ubicación</span><b>${esc(summary.location.status)}</b></div><div class="place-read-location-layout ${summary.location.coordinates ? "" : "is-mapless"}"><div class="place-read-location-copy"><p>${esc(summary.location.address || "Todavía no hay una dirección guardada.")}</p>${summary.location.coordinates ? `<small>${esc(summary.location.coordinates)}</small>` : ""}<button type="button" data-read-edit="location">${summary.location.hasCoordinates ? "Editar ubicación" : "Añadir ubicación"}</button></div>${summary.location.coordinates ? `<div id="placeReadMap" class="place-read-map" role="img" aria-label="Miniatura del mapa de ${esc(summary.identity.name)}"></div>` : ""}</div></section>
    <section class="place-read-card place-read-schedule"><div class="place-read-card-head"><span>Plan y horarios</span><b>${summary.temporal.fixedStart ? "Reserva fija" : esc(summary.temporal.schedule)}</b></div>${temporalPlan}<button type="button" data-read-edit="schedule">Editar planificación</button></section>
    <section class="place-read-card"><div class="place-read-card-head"><span>Información adicional</span><b>${esc(summary.position.label)}</b></div><div class="place-read-rows"><span>Coste <b>${esc(summary.cost?.label || "Sin coste")}</b></span><span>Nota <b>${summary.note ? "Añadida" : "Sin nota"}</b></span></div>${summary.note ? `<p class="place-read-note">${esc(summary.note)}</p>` : ""}<button type="button" data-read-edit="additional">Editar información</button></section>${reminderReadMarkup(spot.id)}`;
    if (summary.location.hasCoordinates)
        requestAnimationFrame(() => openReadPreview(spot));
}

document.addEventListener("reminders-changed", () => {
    if (dialog.open && placeMode === "read" && editing?.spot)
        renderPlaceReadPanel(editing.spot);
});

document.addEventListener("trip-remote-plan-applied", (event) => {
    if (!dialog.open || !editing?.spot) return;
    const spotKey = `spot:${editing.spot.id}`;
    if (!(event.detail?.targetKeys || []).some((key) => key === spotKey || key.startsWith(`${spotKey}:`))) return;
    const current = editing.dayId === "backlog"
        ? store.backlog.find((spot) => spot.id === editing.spot.id)
        : dayBy(editing.dayId)?.spots.find((spot) => spot.id === editing.spot.id);
    if (!current) {
        $("#placeDialogStatus").textContent = "Otro colaborador eliminó esta parada; puedes copiar tu borrador antes de cerrar";
        return;
    }
    editing.spot = current;
    if (placeMode === "read") populatePlaceForm(current, {});
    else $("#placeDialogStatus").textContent = "Hay cambios remotos; tu borrador local se conserva";
});

function setPlaceMode(mode, { focus = true } = {}) {
    // Single choke point for every route into the editor (the footer button,
    // the read-panel shortcuts, and openDialog itself), so a public visitor
    // keeps the read card and never reaches an editable form.
    if (store.readOnly && mode !== "read") return;
    unregisterActiveEditor?.();
    unregisterActiveEditor = null;
    placeMode = mode;
    const read = mode === "read";
    $("#placeReadPanel").hidden = !read; $("#placeForm").hidden = read;
    $("#placeReadActions").hidden = !read; $("#placeEditActions").hidden = read;
    $("#dialogTitle").textContent = read ? "Parada" : mode === "create" ? "Añadir una parada" : "Editar parada";
    $("#placeDialogEyebrow").textContent = read ? "Ficha de parada" : mode === "create" ? "Nueva parada" : "Edición de parada";
    $("#placeSaveButton").textContent = mode === "create" ? "Añadir parada" : "Autoguardado activo";
    $("#placeSaveButton").hidden = mode === "edit";
    $("#placeDiscardButton").textContent = mode === "edit" ? "Cerrar" : "Descartar";
    dialog.dataset.mode = mode;
    $("#placeDialogStatus").textContent = read ? "Modo lectura" : mode === "create" ? "Modo creación" : "Modo edición";
    if (read) { renderPlaceReadPanel(editing.spot); if (focus) $("#placeEditButton").focus(); }
    else {
        unregisterActiveEditor = registerActiveEditor(() => commitPlaceEditor({ stayOpen: true }));
        openPlaceGroup("essential");
        initialDraft = mode === "create" ? normalizePlaceDraft({}) : normalizePlaceDraft(placeFormDraft());
        placeAutosave?.reset(placeFormDraft());
        updatePlaceEditorState();
        if (focus) $("#placeName").focus();
    }
}

async function confirmDiscardIfNeeded() {
    if (placeMode === "edit" && placeAutosave) {
        const result = await placeAutosave.flush("close");
        if (result.status !== "invalid") return true;
        return confirmAction({ title: "Descartar borrador inválido", message: "Hay valores que no se pueden autoguardar. ¿Quieres cerrar y descartarlos?" });
    }
    if (placeMode === "read" || !initialDraft || !placeDraftChanged(initialDraft, placeFormDraft())) return true;
    return confirmAction({ title: "Descartar cambios", message: "Hay cambios sin guardar. ¿Quieres descartarlos?" });
}

async function requestPlaceClose({ discardToRead = false } = {}) {
    if (!(await confirmDiscardIfNeeded())) return;
    if (discardToRead && editing?.spot) { populatePlaceForm(editing.spot, {}); setPlaceMode("read"); return; }
    dialog.close();
}

function populatePlaceForm(spot, prefill) {
    kindTouched = Boolean(spot); setPlaceKind(spotKind(spot));
    store.selectedLocation = Number.isFinite(spot?.lat) && Number.isFinite(spot?.lng) ? { lat: spot.lat, lng: spot.lng, display_name: spot.address || spot.name } : null;
    $("#placeName").value = spot ? spot.name || "" : typeof prefill?.name === "string" ? prefill.name : "";
    $("#placeAddress").value = spot?.address || ""; $("#placeNote").value = spot?.note || "";
    $("#placeCost").value = Number.isFinite(spot?.cost) ? spot.cost : ""; $("#placeCostCurrency").textContent = store.foreignCurrency;
    $("#placeOpeningTime").value = normalizeTime(spot?.openingTime) || ""; $("#placeClosingTime").value = normalizeTime(spot?.closingTime) || "";
    $("#placeVisitMinutes").value = Number.isInteger(spot?.visitMinutes) && spot.visitMinutes > 0 ? spot.visitMinutes : "";
    $("#placePlannedStart").value = normalizeTime(spot?.plannedStart) || ""; $("#placeFixedStart").checked = spot?.fixedStart === true;
    $("#placeOptional").checked = spot?.optional === true; $("#placeScheduleNotApplicable").checked = spot?.scheduleNotApplicable === true;
    setPositionConstraint(spotPositionConstraint(spot)); syncPositionConstraint(); syncClearableTimeInputs();
    renderTagOptions(spot?.tags || []); renderCategoryOptions(spot?.category ? [spot.category] : []);
    $("#suggestions").hidden = true;
    $("#searchStatus").textContent = store.selectedLocation ? "Ubicación actual: " + store.selectedLocation.display_name : "Busca un lugar o pega coordenadas en formato latitud, longitud.";
    updateGroupSummaries(); initialDraft = normalizePlaceDraft(placeFormDraft());
}

export function openDialog(dayId, spot, prefill = {}) {
    cancelPendingSearch();
    returnFocus = document.activeElement;
    editing = { dayId, spot, backlogGroupId: prefill.backlogGroupId, onSave: typeof prefill.onSave === "function" ? prefill.onSave : null };
    dialog.dataset.presenceTarget = spot?.id ? `spot:${spot.id}` : dayId === "backlog" ? "backlog:all" : `day:${dayId}`;
    populatePlaceForm(spot, prefill);
    const focusTarget = PLACE_FOCUS_TARGETS[prefill.focus];
    const mode = spot && !focusTarget ? "read" : spot ? "edit" : "create";
    setPlaceMode(mode, { focus: false });
    openModal(dialog);
    if (focusTarget) {
        openPlaceGroup(focusTarget.group);
    }
    requestAnimationFrame(() => {
        const control = focusTarget
            ? dialog.querySelector(focusTarget.selector)
            : mode === "read"
              ? $("#placeEditButton")
              : $("#placeName");
        control?.focus({ preventScroll: true });
    });
    const prefilledName = !spot && typeof prefill?.name === "string" && prefill.name.trim();
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
                updatePlaceEditorState();
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
    updatePlaceEditorState();
});

$("#resetCost").addEventListener("click", () => {
    $("#placeCost").value = "";
    $("#placeCost").focus();
    updatePlaceEditorState();
});

dialog.querySelectorAll(".place-editor-group").forEach((group) =>
    group.addEventListener("toggle", () => {
        if (!group.open) return;
        dialog.querySelectorAll(".place-editor-group").forEach((other) => {
            if (other !== group) other.open = false;
        });
        if (group.dataset.placeGroup === "location")
            requestAnimationFrame(() => openPreview(store.selectedLocation));
    }),
);

dialog.querySelectorAll("[data-duration]").forEach((button) =>
    button.addEventListener("click", () => {
        $("#placeVisitMinutes").value = button.dataset.duration;
        $("#placeVisitMinutes").focus();
        updatePlaceEditorState();
    }),
);

$("#placeEditButton").addEventListener("click", () => setPlaceMode("edit"));
$("#placeDiscardButton").addEventListener("click", () => requestPlaceClose({ discardToRead: true }));
$("#placeReadPanel").addEventListener("click", (event) => {
    const button = event.target.closest("[data-read-edit]");
    if (!button) return;
    setPlaceMode("edit", { focus: false });
    openPlaceGroup(button.dataset.readEdit);
    const selector = button.dataset.readEdit === "location" ? "#placeAddress" : button.dataset.readEdit === "schedule" ? "#placePlannedStart" : "#placeCost";
    requestAnimationFrame(() => $(selector).focus());
});

$("#placeForm").addEventListener("input", updatePlaceEditorState);
$("#placeForm").addEventListener("change", updatePlaceEditorState);
document.addEventListener("place-preview-change", updatePlaceEditorState);

dialog.addEventListener("click", (event) => {
    if (!(event.target === dialog || event.target.closest?.(".close"))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    requestPlaceClose();
}, true);
dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    requestPlaceClose();
});
dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    requestPlaceClose();
});

clearableTimeInputs.forEach((container) => {
    const input = container.querySelector('input[type="time"]');
    const clearButton = container.querySelector(".clear-time-input");
    input.addEventListener("input", () => syncClearableTimeInput(container));
    clearButton.addEventListener("click", () => {
        input.value = "";
        const uncheckId = clearButton.dataset.uncheck;
        if (uncheckId)
            document.getElementById(uncheckId).checked = false;
        syncClearableTimeInput(container);
        input.focus();
        updatePlaceEditorState();
    });
});

$("#placeScheduleNotApplicable").addEventListener("change", (event) => {
    if (!event.target.checked) return;
    $("#placeOpeningTime").value = "";
    $("#placeClosingTime").value = "";
    syncClearableTimeInputs();
    updatePlaceEditorState();
});
[$("#placeOpeningTime"), $("#placeClosingTime")].forEach((input) =>
    input.addEventListener("input", () => {
        if (input.value) $("#placeScheduleNotApplicable").checked = false;
    }),
);

async function commitPlaceEditor({ stayOpen = false } = {}) {
    if (!editing || placeMode === "read") return { status: "none" };
    if (placeValidation({ reveal: true }).length) return { status: "invalid", reason: "validation" };
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
    const positionConstraint = editing.dayId === "backlog"
        ? null
        : spotPositionConstraint({ positionConstraint: positionConstraintValue() });
    if (fixedStart && !plannedStart) {
        toast("Añade una hora planificada antes de marcar la reserva como fija.", "error");
        $("#placePlannedStart").focus();
        return { status: "invalid", reason: "validation" };
    }
    const target =
        editing.dayId === "backlog" ? store.backlog : dayBy(editing.dayId).spots;
    let spot = editing.spot;
    if (
        ["first", "last"].includes(positionConstraint) &&
        target.some((candidate) => candidate !== spot && spotPositionConstraint(candidate) === positionConstraint)
    ) {
        toast(`Este día ya tiene una ${positionConstraint === "first" ? "primera" : "última"} parada anclada.`, "error");
        focusPositionConstraint();
        return { status: "invalid", reason: "position-constraint" };
    }
    if (spot && editing.dayId !== "backlog") {
        const before = target.map((candidate) => candidate === spot
            ? { ...candidate, positionConstraint: undefined }
            : candidate);
        const candidate = target.map((item) => item === spot
            ? { ...item, ...(positionConstraint ? { positionConstraint } : {}) }
            : item);
        if (!positionConstraint) delete candidate[target.indexOf(spot)].positionConstraint;
        const candidateIndex = candidate.findIndex((item) => item.id === spot.id);
        if (positionConstraint === "first" && candidateIndex > 0)
            candidate.unshift(...candidate.splice(candidateIndex, 1));
        else if (positionConstraint === "last" && candidateIndex < candidate.length - 1)
            candidate.push(...candidate.splice(candidateIndex, 1));
        const violation = dayPositionConstraintViolation(before, candidate);
        if (violation) {
            toast(violation, "error");
            focusPositionConstraint();
            return { status: "invalid", reason: "position-constraint" };
        }
    }
    const newSpotInsertAt = (spot || editing.dayId === "backlog")
        ? target.length
        : positionConstraintInsertionIndex(
              target,
              { id: "__new__", name, ...(positionConstraint ? { positionConstraint } : {}) },
              positionConstraint === "first" ? 0 : target.length,
          );
    if (!spot && newSpotInsertAt === null) {
        toast("No hay una posición compatible con los anclajes actuales.", "error");
        return { status: "invalid", reason: "position-constraint" };
    }
    const spotId = spot?.id || id();
    const nextSpot = {
        ...(spot || {}),
        id: spotId,
        name,
        address,
        note,
        tags: spotTags,
        kind,
    };
    if (editing.dayId === "backlog" && editing.backlogGroupId) nextSpot.backlogGroupId = editing.backlogGroupId;
    if (coordinates) Object.assign(nextSpot, { lat: coordinates.lat, lng: coordinates.lng });
    else { delete nextSpot.lat; delete nextSpot.lng; }
    if (category) nextSpot.category = category; else delete nextSpot.category;
    const optionalFields = {
        cost,
        visitMinutes,
        openingTime,
        closingTime,
        plannedStart,
        fixedStart: fixedStart || undefined,
        optional: optional || undefined,
        positionConstraint: positionConstraint || undefined,
        scheduleNotApplicable: scheduleNotApplicable || undefined,
    };
    Object.entries(optionalFields).forEach(([key, value]) => {
        if (value === undefined) delete nextSpot[key];
        else nextSpot[key] = value;
    });
    if (spot) {
        const fields = Object.fromEntries(Object.entries(nextSpot).filter(([key, value]) =>
            key !== "id" && JSON.stringify(spot[key]) !== JSON.stringify(value),
        ));
        const remove = Object.keys(spot).filter((key) => key !== "id" && !(key in nextSpot));
        if (!Object.keys(fields).length && !remove.length) return { status: "unchanged", spotId };
        await derivedPlanOperation((document) => updateFieldsIntent(
            document,
            { type: "spot", id: spotId },
            fields,
            { remove },
        ));
    } else {
        const beforeId = target[newSpotInsertAt]?.id ?? null;
        await derivedPlanOperation(() => insertEntityIntent(
            { type: "spot", id: spotId },
            nextSpot,
            {
                containerId: editing.dayId,
                beforeId,
                backlogGroupId: editing.backlogGroupId,
            },
        ));
    }
    const onSave = editing.onSave;
    store.active = editing.dayId;
    const committedTarget = editing.dayId === "backlog" ? store.backlog : dayBy(editing.dayId).spots;
    spot = committedTarget.find((candidate) => candidate.id === spotId);
    editing.spot = spot;
    if (stayOpen) {
        initialDraft = normalizePlaceDraft(placeFormDraft());
        dialog.classList.remove("is-dirty");
        $("#placeDialogStatus").textContent = "Cambios autoguardados";
        return { status: "committed", spotId: spot.id };
    }
    populatePlaceForm(spot, {});
    if (onSave) {
        dialog.close();
        onSave();
    } else setPlaceMode("read");
    return { status: "committed", spotId: spot.id };
}

$("#placeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    await commitPlaceEditor();
});

placeAutosave = createDraftAutosaveController({
    root: $("#placeForm"),
    read: placeFormDraft,
    validate: () => placeValidation({ reveal: true, focus: false }).map((error) => error.message),
    disabled: () => store.readOnly || placeMode !== "edit" || !editing?.spot,
    debounceMs: 450,
    commit: () => commitPlaceEditor({ stayOpen: true }),
    onState: ({ state }) => {
        if (placeMode !== "edit") return;
        if (state === "dirty" || state === "saving") $("#placeDialogStatus").textContent = "Autoguardando…";
        else if (state === "saved") $("#placeDialogStatus").textContent = "Cambios autoguardados";
        else if (state === "invalid") $("#placeDialogStatus").textContent = "Corrige los campos marcados; el borrador sigue aquí";
        else if (state === "error") $("#placeDialogStatus").textContent = "No se pudo autoguardar; se reintentará al salir del campo";
    },
});

dialog.addEventListener("close", () => {
    unregisterActiveEditor?.();
    unregisterActiveEditor = null;
    cancelPendingSearch();
    dialog.classList.remove("is-dirty");
    placeAutosave?.reset({});
    const focusTarget = returnFocus;
    returnFocus = null;
    if (focusTarget?.isConnected) requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }));
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
            void derivedPlanOperation(() => commandIntent({
                target: { type: "plan", id: "plan" },
                command: "rename-tag",
                payload: { from: previousTag, to: nextTag },
            })).then(() => {
                if (store.activeTagFilter.delete(previousTag)) store.activeTagFilter.add(nextTag);
                currentTag = nextTag;
                nameInput.setAttribute("aria-label", `Nombre de la etiqueta ${nextTag}`);
                delBtn.setAttribute("aria-label", `Borrar etiqueta ${nextTag}`);
                toast(`Etiqueta #${previousTag} renombrada a #${nextTag}.`, "info");
            });
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
                void derivedPlanOperation(() => commandIntent({
                    target: { type: "plan", id: "plan" },
                    command: "delete-tag",
                    payload: { tag: currentTag },
                })).then(() => {
                    store.activeTagFilter.delete(currentTag);
                    renderManagerTags();
                    toast(`Etiqueta #${currentTag} eliminada.`, "info");
                });
            });
        };
        row.append(prefix, nameInput, delBtn);
        list.append(row);
    });
}

$("#manageTags").onclick = () => {
    renderManagerTags();
    openModal(tagDialog);
};
$("#addTag").onclick = () => {
    const value = $("#newTag").value.trim().replace(/^#/, "").toLowerCase();
    if (value && !store.tags.includes(value)) {
        $("#newTag").value = "";
        void derivedPlanOperation(() => insertEntityIntent(
            { type: "tag", id: value },
            value,
        )).then(renderManagerTags);
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
        row.dataset.presenceTarget = `category:${c.id}`;
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "manager-category-name";
        nameInput.value = c.label;
        nameInput.dataset.presenceTarget = `category:${c.id}:label`;
        let lastValid = c.label;
        nameInput.addEventListener("input", (e) => {
            const value = e.target.value;
            void derivedPlanOperation((document) => setFieldIntent(
                document,
                { type: "category", id: c.id, field: "label" },
                value,
            ), { undo: false });
        });
        nameInput.addEventListener("blur", (e) => {
            const trimmed = e.target.value.trim();
            if (!trimmed) {
                e.target.value = lastValid;
                void derivedPlanOperation((document) => setFieldIntent(
                    document,
                    { type: "category", id: c.id, field: "label" },
                    lastValid,
                ), { undo: false });
            } else {
                lastValid = trimmed;
            }
        });
        const colorInput = document.createElement("input");
        colorInput.type = "color";
        colorInput.className = "cat-swatch";
        colorInput.title = "Color de la categoría";
        colorInput.value = c.color;
        colorInput.dataset.presenceTarget = `category:${c.id}:color`;
        colorInput.addEventListener("input", (e) => {
            const value = e.target.value;
            void derivedPlanOperation((document) => setFieldIntent(
                document,
                { type: "category", id: c.id, field: "color" },
                value,
            ), { undo: false });
        });
        const connectToggle = document.createElement("label");
        connectToggle.className = "connect-toggle";
        const sw = document.createElement("span");
        sw.className = "switch";
        const swInput = document.createElement("input");
        swInput.type = "checkbox";
        swInput.checked = c.connects !== false;
        swInput.dataset.presenceTarget = `category:${c.id}:connects`;
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
            const value = e.target.checked;
            syncConnect();
            void derivedPlanOperation((document) => setFieldIntent(
                document,
                { type: "category", id: c.id, field: "connects" },
                value,
            ));
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
        kindSelect.dataset.presenceTarget = `category:${c.id}:defaultSpotKind`;
        kindSelect.addEventListener("change", (event) => {
            const value = event.target.value === "waypoint" ? "waypoint" : "activity";
            void derivedPlanOperation((document) => setFieldIntent(
                document,
                { type: "category", id: c.id, field: "defaultSpotKind" },
                value,
            ));
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
                void derivedPlanOperation((document) => commandIntent({
                    target: { type: "category", id: c.id },
                    command: "delete-category",
                    precondition: { expectedFingerprint: targetFingerprint(document, { type: "category", id: c.id }) },
                })).then(() => {
                    renderManagerCategories();
                    toast(`Categoría "${c.label}" eliminada.`, "info");
                });
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
    openModal(categoryDialog);
};
$("#addCategory").onclick = () => {
    const name = $("#newCategoryName").value.trim();
    if (!name) return;
    const color = $("#newCategoryColor").value;
    let catId = slug(name);
    if (store.categories.some((c) => c.id === catId))
        catId += "-" + Date.now().toString(36);
    const category = { id: catId, label: name, color, connects: true, defaultSpotKind: $("#newCategoryKind").value === "waypoint" ? "waypoint" : "activity" };
    $("#newCategoryName").value = "";
    void derivedPlanOperation(() => insertEntityIntent(
        { type: "category", id: catId },
        category,
    )).then(renderManagerCategories);
};
