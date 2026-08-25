import { store } from "../../core/store.js";
import {
    isCanonicalDate,
    localDateString,
    normalizeReminder,
    presentReminder,
    resolveReminderDate,
    sortPresentedReminders,
} from "../../core/reminders.js";
import { $, esc, id } from "../../shared/dom.js";
import { openModal } from "../../shared/modal.js";
import { confirmAction, toast } from "../../shared/notify.js";
import { render } from "../planner/render.js";
import { createDraftAutosaveController } from "../../shared/draft-autosave.js";
import {
    deleteEntityIntent,
    derivedPlanOperation,
    insertEntityIntent,
    updateFieldsIntent,
} from "../../core/plan-operation-commit.js";
import {
    formatReminderDate as formatDate,
    reminderSpotById as spotById,
} from "./presentation.js";

const dashboardDialog = $("#remindersDialog");
const editorDialog = $("#reminderEditorDialog");
let visibleMonth = "";
let selectedDate = "";
let editingId = null;
let returnFocus = null;
let editorReturnFocus = null;
let renderedToday = localDateString();
let spotOptionIndex = -1;

const monthFormatter = new Intl.DateTimeFormat("es-ES", {
    month: "long",
    year: "numeric",
});

function monthKey(date) {
    return isCanonicalDate(date) ? date.slice(0, 7) : localDateString().slice(0, 7);
}

function moveMonth(key, delta) {
    const [year, month] = key.split("-").map(Number);
    const date = new Date(year, month - 1 + delta, 1, 12);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function reminderCard(item, { compact = false } = {}) {
    const linked = item.reminder.spotId ? spotById(item.reminder.spotId) : null;
    return `<article class="reminder-card is-${item.status}${compact ? " is-compact" : ""}" data-presence-target="reminder:${esc(item.reminder.id)}">
        <button type="button" data-reminder-edit="${esc(item.reminder.id)}" aria-label="Editar ${esc(item.reminder.title)}">
            <span class="reminder-card-state">${esc(item.countdown?.label || "Pendiente de fecha")}</span>
            <strong>${esc(item.reminder.title)}</strong>
            <small>${item.date ? esc(formatDate(item.date)) : "Asigna una fecha de referencia"}${linked ? ` · ${esc(linked.name)}` : ""}</small>
        </button>
    </article>`;
}

function renderDashboard(items) {
    const resolved = items.filter((item) => item.date);
    $("#remindersDashboard").innerHTML = resolved.length
        ? resolved.map((item) => reminderCard(item)).join("")
        : '<p class="reminders-inline-empty">No hay plazos con fecha calculada.</p>';
}

function renderDayList(items) {
    const matches = items.filter((item) => item.date === selectedDate);
    $("#remindersDayTitle").textContent = selectedDate
        ? formatDate(selectedDate)
        : "Selecciona un día";
    $("#remindersDayList").innerHTML = matches.length
        ? matches.map((item) => `<div class="reminders-day-item"><button type="button" data-reminder-edit="${esc(item.reminder.id)}"><strong>${esc(item.reminder.title)}</strong>${item.reminder.note ? `<span>${esc(item.reminder.note)}</span>` : ""}<small>${item.reminder.spotId && spotById(item.reminder.spotId) ? esc(spotById(item.reminder.spotId).name) : "Recordatorio general"}</small></button></div>`).join("")
        : '<p class="reminders-inline-empty">No hay recordatorios este día.</p>';
}

function renderCalendar(items) {
    if (!visibleMonth) visibleMonth = monthKey(items.find((item) => item.date)?.date);
    const [year, month] = visibleMonth.split("-").map(Number);
    const first = new Date(year, month - 1, 1, 12);
    const daysInMonth = new Date(year, month, 0, 12).getDate();
    const leading = (first.getDay() + 6) % 7;
    const counts = new Map();
    items.filter((item) => item.date?.startsWith(visibleMonth)).forEach((item) =>
        counts.set(item.date, (counts.get(item.date) || 0) + 1),
    );
    $("#remindersCalendarTitle").textContent = monthFormatter.format(first);
    const cells = [];
    for (let index = 0; index < leading; index += 1)
        cells.push('<span class="reminders-calendar-blank" aria-hidden="true"></span>');
    for (let day = 1; day <= daysInMonth; day += 1) {
        const date = `${visibleMonth}-${String(day).padStart(2, "0")}`;
        const count = counts.get(date) || 0;
        cells.push(`<button type="button" role="gridcell" data-reminder-date="${date}" class="${date === selectedDate ? "is-selected" : ""} ${date === renderedToday ? "is-today" : ""}" aria-label="${esc(formatDate(date))}${count ? `, ${count} ${count === 1 ? "recordatorio" : "recordatorios"}` : ""}"><span>${day}</span>${count ? `<i aria-hidden="true">${count}</i>` : ""}</button>`);
    }
    $("#remindersCalendar").innerHTML = cells.join("");
    renderDayList(items);
}

export function refreshRemindersView() {
    renderedToday = localDateString();
    const items = sortPresentedReminders(store.reminders, store.state, renderedToday);
    renderDashboard(items);
    renderCalendar(items);
    const pending = items.filter((item) => !item.date);
    $("#remindersPendingSection").hidden = !pending.length;
    $("#remindersPendingList").innerHTML = pending.map((item) => reminderCard(item, { compact: true })).join("");
    $("#remindersEmpty").hidden = store.reminders.length > 0;
}

export function openReminders({ date } = {}) {
    returnFocus = document.activeElement;
    const items = sortPresentedReminders(store.reminders, store.state, localDateString());
    if (isCanonicalDate(date)) {
        selectedDate = date;
        visibleMonth = monthKey(date);
    } else if (!visibleMonth) {
        const firstDate = items.find((item) => item.date)?.date || localDateString();
        visibleMonth = monthKey(firstDate);
        selectedDate = firstDate;
    }
    refreshRemindersView();
    openModal(dashboardDialog);
    requestAnimationFrame(() => $("#reminderCreateBtn").focus());
}

function spotChoices() {
    return [
        ...store.state.flatMap((day) => day.spots.map((spot) => ({
            id: spot.id,
            name: spot.name || "Parada sin nombre",
            context: `${day.date || "Sin fecha"} · ${day.title || "Día"}`,
        }))),
        ...store.backlog.map((spot) => ({
            id: spot.id,
            name: spot.name || "Parada sin nombre",
            context: "Ideas sin día",
        })),
    ];
}

function searchable(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es");
}

function setSpotSelection(spotId = "") {
    const choice = spotChoices().find((item) => item.id === spotId);
    $("#reminderSpot").value = choice?.id || "";
    $("#reminderSpotSearch").value = choice?.name || "";
    $("#reminderSpotClear").hidden = !choice;
}

function closeSpotOptions() {
    $("#reminderSpotOptions").hidden = true;
    $("#reminderSpotSearch").setAttribute("aria-expanded", "false");
    $("#reminderSpotSearch").removeAttribute("aria-activedescendant");
    spotOptionIndex = -1;
}

function renderSpotOptions(query = "") {
    const terms = searchable(query.trim()).split(/\s+/).filter(Boolean);
    const choices = spotChoices().filter((item) => {
        const haystack = searchable(`${item.name} ${item.context}`);
        return terms.every((term) => haystack.includes(term));
    });
    const options = $("#reminderSpotOptions");
    options.innerHTML = choices.length
        ? choices.map((item, index) => `<button id="reminder-spot-option-${index}" type="button" role="option" aria-selected="false" data-reminder-spot="${esc(item.id)}"><span><strong>${esc(item.name)}</strong><small>${esc(item.context)}</small></span><i aria-hidden="true">↵</i></button>`).join("")
        : '<p class="reminder-spot-empty">No hay paradas que coincidan.</p>';
    options.hidden = false;
    $("#reminderSpotSearch").setAttribute("aria-expanded", "true");
    spotOptionIndex = -1;
}

function populateSpotOptions(selected = "") {
    setSpotSelection(selected);
    closeSpotOptions();
}

function timingType() {
    return editorDialog.querySelector('input[name="reminderTimingType"]:checked')?.value || "fixed";
}

function anchorType() {
    return editorDialog.querySelector('input[name="reminderAnchorType"]:checked')?.value || "date";
}

function editorCandidate() {
    const spotId = $("#reminderSpot").value || undefined;
    const candidate = {
        id: editingId || id(),
        title: $("#reminderTitle").value,
        note: $("#reminderNote").value,
        ...(spotId ? { spotId } : {}),
        timing: timingType() === "fixed"
            ? { type: "fixed", date: $("#reminderFixedDate").value }
            : {
                  type: "offset",
                  amount: Number($("#reminderAmount").value),
                  unit: $("#reminderUnit").value,
                  anchor: anchorType() === "spot"
                      ? { type: "spot" }
                      : { type: "date", date: $("#reminderAnchorDate").value },
              },
    };
    return candidate;
}

function syncEditor() {
    const offset = timingType() === "offset";
    const spotAnchor = offset && anchorType() === "spot";
    $("#reminderFixedField").hidden = offset;
    $("#reminderOffsetFields").hidden = !offset;
    $("#reminderAnchorDateField").hidden = spotAnchor;
    const candidate = editorCandidate();
    const normalized = normalizeReminder(candidate);
    const date = normalized ? resolveReminderDate(normalized, store.state) : null;
    $("#reminderPreview").textContent = !offset
        ? date ? `Fecha: ${formatDate(date)}` : "Elige la fecha del recordatorio."
        : date ? `Se mostrará el ${formatDate(date)}.`
        : spotAnchor && !candidate.spotId ? "Selecciona una parada para usar su día."
        : spotAnchor ? "La parada debe estar asignada a un día con fecha."
        : "Completa la fecha objetivo y la antelación.";
    $("#reminderError").textContent = "";
}

export function openReminderEditor(reminderId, { spotId } = {}) {
    editorReturnFocus = document.activeElement;
    const reminder = store.reminders.find((item) => item.id === reminderId);
    editingId = reminder?.id || null;
    editorDialog.dataset.presenceTarget = reminder?.id
        ? `reminder:${reminder.id}`
        : spotId ? `spot:${spotId}` : "section:reminders";
    $("#reminderEditorTitle").textContent = reminder ? "Editar recordatorio" : "Nuevo recordatorio";
    $("#reminderTitle").value = reminder?.title || "";
    $("#reminderNote").value = reminder?.note || "";
    populateSpotOptions(reminder?.spotId || spotId || "");
    const offset = reminder?.timing?.type === "offset";
    editorDialog.querySelector(`input[name="reminderTimingType"][value="${offset ? "offset" : "fixed"}"]`).checked = true;
    $("#reminderFixedDate").value = !offset ? reminder?.timing?.date || selectedDate || "" : "";
    $("#reminderAmount").value = offset ? reminder.timing.amount : 1;
    $("#reminderUnit").value = offset ? reminder.timing.unit : "days";
    const anchor = offset ? reminder.timing.anchor?.type || "date" : "date";
    editorDialog.querySelector(`input[name="reminderAnchorType"][value="${anchor}"]`).checked = true;
    $("#reminderAnchorDate").value = offset && anchor === "date" ? reminder.timing.anchor.date : "";
    $("#reminderDeleteBtn").hidden = !reminder;
    syncEditor();
    reminderAutosave?.reset(editorCandidate());
    openModal(editorDialog);
    requestAnimationFrame(() => $("#reminderTitle").focus());
}

async function commitReminder(reminder, previousId, message) {
    if (previousId) {
        const fields = Object.fromEntries(Object.entries(reminder).filter(([key]) => key !== "id"));
        const existing = store.reminders.find((item) => item.id === previousId);
        const remove = ["note", "spotId", "pendingSpotAnchor"].filter((field) => !(field in reminder) && field in existing);
        await derivedPlanOperation((document) => updateFieldsIntent(
            document,
            { type: "reminder", id: previousId },
            fields,
            { remove },
        ));
    } else {
        await derivedPlanOperation(() => insertEntityIntent(
            { type: "reminder", id: reminder.id },
            reminder,
        ));
        editingId = reminder.id;
        $("#reminderDeleteBtn").hidden = false;
    }
    refreshRemindersView();
    document.dispatchEvent(new CustomEvent("reminders-changed"));
    toast(message, "info");
}

async function saveReminderEditor({ close = false } = {}) {
    const candidate = editorCandidate();
    const normalized = normalizeReminder(candidate);
    if (!candidate.title.trim()) {
        $("#reminderError").textContent = "Escribe un título para el recordatorio.";
        $("#reminderTitle").focus();
        return { status: "invalid" };
    }
    if (!normalized) {
        $("#reminderError").textContent = timingType() === "fixed"
            ? "Elige una fecha válida."
            : anchorType() === "spot" && !candidate.spotId
              ? "Selecciona una parada para usar su día."
              : "Revisa la antelación y la fecha objetivo.";
        return { status: "invalid" };
    }
    const previousId = editingId;
    await commitReminder(normalized, previousId, previousId ? "Recordatorio actualizado." : "Recordatorio creado.");
    if (close) editorDialog.close();
    return { status: "saved" };
}

$("#reminderForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveReminderEditor({ close: true });
});

const reminderAutosave = createDraftAutosaveController({
    root: $("#reminderForm"),
    read: editorCandidate,
    validate: (candidate) => {
        if (!candidate.title.trim()) return ["Escribe un título para el recordatorio."];
        return normalizeReminder(candidate) ? [] : ["Completa una fecha o antelación válida."];
    },
    disabled: () => store.readOnly || !editorDialog.open,
    debounceMs: 450,
    commit: () => saveReminderEditor(),
    onState: ({ state }) => {
        if (state === "dirty" || state === "saving") $("#reminderError").textContent = "Autoguardando…";
        else if (state === "saved") $("#reminderError").textContent = "Cambios autoguardados";
        else if (state === "invalid") $("#reminderError").textContent = "Completa los campos marcados; el borrador sigue abierto";
    },
});

editorDialog.addEventListener("click", async (event) => {
    if (!event.target.closest(".cancel")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const result = await reminderAutosave.flush("close");
    if (result.status !== "invalid") editorDialog.close();
}, true);

$("#reminderDeleteBtn").addEventListener("click", async () => {
    const reminder = store.reminders.find((item) => item.id === editingId);
    if (!reminder) return;
    const ok = await confirmAction({ title: "Eliminar recordatorio", message: `¿Eliminar “${reminder.title}”?`, confirmLabel: "Eliminar" });
    if (!ok) return;
    await derivedPlanOperation((document) => deleteEntityIntent(
        document,
        { type: "reminder", id: reminder.id },
    ));
    refreshRemindersView();
    document.dispatchEvent(new CustomEvent("reminders-changed"));
    toast("Recordatorio eliminado.", "info");
    editorDialog.close();
});

$("#remindersOpenBtn").addEventListener("click", () => openReminders());
$("#reminderCreateBtn").addEventListener("click", () => openReminderEditor());
$("#remindersPrevMonth").addEventListener("click", () => { visibleMonth = moveMonth(visibleMonth, -1); refreshRemindersView(); });
$("#remindersNextMonth").addEventListener("click", () => { visibleMonth = moveMonth(visibleMonth, 1); refreshRemindersView(); });
$("#remindersCalendar").addEventListener("click", (event) => {
    const date = event.target.closest("[data-reminder-date]")?.dataset.reminderDate;
    if (!date) return;
    selectedDate = date;
    refreshRemindersView();
});

document.addEventListener("click", (event) => {
    if (store.readOnly) return;
    const edit = event.target.closest("[data-reminder-edit]")?.dataset.reminderEdit;
    if (edit) { event.stopPropagation(); openReminderEditor(edit); return; }
    const create = event.target.closest("[data-reminder-create]");
    if (create) { event.stopPropagation(); openReminderEditor(null, { spotId: create.dataset.reminderCreate || undefined }); return; }
    if (event.target.closest("[data-reminders-open]")) { event.stopPropagation(); openReminders(); }
});

editorDialog.addEventListener("input", syncEditor);
editorDialog.addEventListener("change", syncEditor);
$("#reminderSpotSearch").addEventListener("focus", (event) => renderSpotOptions(event.currentTarget.value));
$("#reminderSpotSearch").addEventListener("input", (event) => {
    $("#reminderSpot").value = "";
    $("#reminderSpotClear").hidden = !event.currentTarget.value;
    renderSpotOptions(event.currentTarget.value);
});
$("#reminderSpotSearch").addEventListener("keydown", (event) => {
    if (event.key === "Escape") { closeSpotOptions(); return; }
    if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
    if ($("#reminderSpotOptions").hidden) renderSpotOptions(event.currentTarget.value);
    const options = [...$("#reminderSpotOptions").querySelectorAll("[role='option']")];
    if (event.key === "Enter") {
        event.preventDefault();
        options[Math.max(spotOptionIndex, 0)]?.click();
        return;
    }
    event.preventDefault();
    spotOptionIndex = event.key === "ArrowDown"
        ? Math.min(spotOptionIndex + 1, options.length - 1)
        : Math.max(spotOptionIndex - 1, 0);
    options.forEach((option, index) => option.setAttribute("aria-selected", String(index === spotOptionIndex)));
    const active = options[spotOptionIndex];
    if (active) {
        event.currentTarget.setAttribute("aria-activedescendant", active.id);
        active.scrollIntoView({ block: "nearest" });
    }
});
$("#reminderSpotOptions").addEventListener("click", (event) => {
    const option = event.target.closest("[data-reminder-spot]");
    if (!option) return;
    setSpotSelection(option.dataset.reminderSpot);
    closeSpotOptions();
    syncEditor();
    $("#reminderSpotSearch").focus();
});
$("#reminderSpotClear").addEventListener("click", () => {
    setSpotSelection();
    renderSpotOptions();
    syncEditor();
    $("#reminderSpotSearch").focus();
});
$("#reminderSpotSearch").addEventListener("blur", () => {
    window.setTimeout(() => {
        if (editorDialog.contains(document.activeElement) && $("#reminderSpotOptions").contains(document.activeElement)) return;
        const current = $("#reminderSpotSearch").value.trim();
        if (!$("#reminderSpot").value && current) {
            const exact = spotChoices().filter((item) => searchable(item.name) === searchable(current));
            setSpotSelection(exact.length === 1 ? exact[0].id : "");
        }
        closeSpotOptions();
    }, 0);
});
editorDialog.addEventListener("click", (event) => {
    if (!event.target.closest(".reminder-spot-combobox")) closeSpotOptions();
});
dashboardDialog.addEventListener("close", () => {
    const target = returnFocus;
    returnFocus = null;
    requestAnimationFrame(() => target?.isConnected && target.focus());
});
editorDialog.addEventListener("close", () => {
    const target = editorReturnFocus;
    editorReturnFocus = null;
    requestAnimationFrame(() => {
        if (target?.isConnected) target.focus();
        else if (dashboardDialog.open) $("#reminderCreateBtn").focus();
    });
});
[dashboardDialog, editorDialog].forEach((dialog) =>
    {
        dialog.addEventListener("cancel", (event) => {
            event.preventDefault();
            dialog.close();
        });
        dialog.addEventListener("keydown", (event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            dialog.close();
        });
    },
);
document.addEventListener("visibilitychange", () => {
    const today = localDateString();
    if (!document.hidden && today !== renderedToday) {
        renderedToday = today;
        if (dashboardDialog.open) refreshRemindersView();
        render({ persist: false });
    }
});
