import {
    isCanonicalDate,
    localDateString,
    sortPresentedReminders,
} from "../../core/reminders.js";
import { store } from "../../core/store.js";
import { esc } from "../../shared/dom.js";

const dateFormatter = new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "long",
    year: "numeric",
});

function dateObject(date) {
    const [year, month, day] = date.split("-").map(Number);
    return new Date(year, month - 1, day, 12);
}

export function formatReminderDate(date) {
    return isCanonicalDate(date)
        ? dateFormatter.format(dateObject(date))
        : "Fecha pendiente";
}

export function reminderSpotById(spotId) {
    return [...store.state.flatMap((day) => day.spots), ...store.backlog]
        .find((spot) => spot.id === spotId);
}

export function remindersForSpot(spotId) {
    return sortPresentedReminders(
        store.reminders.filter((reminder) => reminder.spotId === spotId),
        store.state,
        localDateString(),
    );
}

function compactCountdownLabel(countdown) {
    if (!countdown) return "Pendiente";
    return countdown.days > 0 ? `${countdown.days}d` : countdown.label;
}

export function reminderStripMarkup(spotId) {
    const reminders = remindersForSpot(spotId);
    if (!reminders.length) return "";
    return `<span class="spot-reminders" aria-label="Fechas clave">${reminders.map((item) => {
        const fullCountdown = item.countdown?.label || "Pendiente";
        return `<button type="button" data-reminder-edit="${esc(item.reminder.id)}" aria-label="${esc(`${item.reminder.title}, ${fullCountdown}`)}"><span aria-hidden="true">◷</span><b>${esc(item.reminder.title)}</b><small class="reminder-countdown-full">${esc(fullCountdown)}</small><small class="reminder-countdown-compact" aria-hidden="true">${esc(compactCountdownLabel(item.countdown))}</small></button>`;
    }).join("")}</span>`;
}

export function reminderReadMarkup(spotId) {
    const reminders = remindersForSpot(spotId);
    const count = reminders.length
        ? `${reminders.length} ${reminders.length === 1 ? "aviso" : "avisos"}`
        : "Sin avisos";
    const list = reminders.length
        ? `<div class="place-reminder-list">${reminders.map((item) => `<button type="button" data-reminder-edit="${esc(item.reminder.id)}"><span><strong>${esc(item.reminder.title)}</strong><small>${item.date ? esc(formatReminderDate(item.date)) : "Pendiente de asignar la parada a un día"}</small></span><b>${esc(item.countdown?.label || "Pendiente")}</b></button>`).join("")}</div>`
        : "";
    return `<section class="place-read-card place-read-reminders"><div class="place-read-card-head"><span>Fechas clave</span><b>${count}</b></div>${list}<div class="place-reminder-actions"><button type="button" data-reminder-create="${esc(spotId)}">＋ Crear aviso</button><button type="button" data-reminders-open>Abrir calendario</button></div></section>`;
}
