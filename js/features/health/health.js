import { store, dayBy } from "../../core/store.js";
import { disconnectedTravelLegs, parseTravelLegKey } from "../../core/travel-legs.js";
import { $, esc } from "../../shared/dom.js";
import { openModal } from "../../shared/modal.js";
import { toast } from "../../shared/notify.js";
import { buildTimelineProjection } from "../timeline/timeline.js";
import { resolveTravelForLeg } from "../timeline/travel-resolver.js";
import { openDialog } from "../planner/dialogs.js";
import { render, openTravelLegDialog } from "../planner/render.js";
import {
    commandIntent,
    derivedPlanOperation,
    moveEntityIntent,
    setFieldIntent,
} from "../../core/plan-operation-commit.js";
import { diagnoseDay } from "./diagnostics.js";
import { generateSuggestions } from "./suggestions.js";
import { getHealthResult, HEALTH_STATES, healthSignature, setHealthResult } from "./session.js";

const dialog = $("#healthDialog");
const suggestionDialog = $("#healthSuggestionDialog");
const resultsEl = $("#healthResults");
let runToken = 0;
let busy = false;
let activeDayId = null;
let previewTrigger = null;

function healthDateLabel(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        return "Sin fecha";
    return new Intl.DateTimeFormat("es-ES", {
        weekday: "short",
        day: "numeric",
        month: "short",
    }).format(new Date(`${value}T12:00:00`));
}

function evaluate(day) {
    return diagnoseDay(day, buildTimelineProjection(day, { travelForLeg: resolveTravelForLeg }));
}

function actionMarkup(issue, day) {
    if (issue.type === "missing-travel-duration")
        return `<button class="health-action" type="button" data-health-action="edit-travel" data-day="${esc(day.id)}" data-from="${esc(issue.evidence.fromId)}" data-to="${esc(issue.spotId)}">Completar trayecto <span aria-hidden="true">→</span></button>`;
    if (issue.type.startsWith("missing-"))
        return `<button class="health-action" type="button" data-health-action="edit" data-day="${esc(day.id)}" data-spot="${esc(issue.spotId)}" data-focus="${esc(issue.evidence.field)}">Completar <span aria-hidden="true">→</span></button>`;
    return "";
}

function suggestionFlowMarkup(label, spots, order = spots.map((spot) => spot.id)) {
    const positions = new Map(spots.map((spot, index) => [spot.id, index]));
    const names = new Map(spots.map((spot) => [spot.id, spot.name || "Parada sin nombre"]));
    return `<div class="health-suggestion-flow"><span>${esc(label)}</span><ol>${order.map((id, index) => `<li${positions.get(id) === index ? "" : ' class="is-changed"'}><b>${index + 1}</b>${esc(names.get(id) || "Parada sin nombre")}</li>`).join("")}</ol></div>`;
}

function suggestionPreview(item, day) {
    const spot = item.payload.spotId
        ? day.spots.find((candidate) => candidate.id === item.payload.spotId)
        : null;
    if (item.kind === "start-earlier" || item.kind === "add-margin") {
        const before = day.startTime || "Automática";
        const reason = item.kind === "add-margin"
            ? "Adelanta el inicio para aumentar en 20 minutos el margen mínimo antes de un cierre."
            : "Adelanta el inicio hasta que la simulación reduce los conflictos o avisos actuales.";
        return {
            summary: `${reason} La hora de salida cambiará de ${before} a ${item.payload.startTime}.`,
            markup: `<p>${esc(reason)}</p><div class="health-suggestion-change"><span>Hora de salida</span><del>${esc(before)}</del><i aria-hidden="true">→</i><ins>${esc(item.payload.startTime)}</ins></div>`,
        };
    }
    if (item.kind === "remove-optional") {
        const name = spot?.name || "Parada sin nombre";
        return {
            summary: `Moverá la parada opcional ${name} de ${day.title || "este día"} al backlog. No se eliminará.`,
            markup: `<p>Moverá la parada opcional, pero no la eliminará.</p><div class="health-suggestion-change"><span>${esc(name)}</span><del>${esc(day.title || "Este día")}</del><i aria-hidden="true">→</i><ins>Backlog</ins></div>`,
        };
    }
    if (item.kind === "reorder") {
        const saved = item.payload.savedMinutes;
        const approximate = item.approximate ? " aproximadamente" : "";
        return {
            summary: `Reordenará las paradas como se muestra y reducirá el tiempo de trayecto${approximate} de ${item.payload.travelBefore} a ${item.payload.travelAfter} minutos.`,
            markup: `<p>Reduce los trayectos${item.approximate ? " estimados" : ""} de <strong>${item.payload.travelBefore} min</strong> a <strong>${item.payload.travelAfter} min</strong> (ahorro: ${saved} min).</p>${suggestionFlowMarkup("Ahora", day.spots)}${suggestionFlowMarkup("Propuesto", day.spots, item.payload.order)}`,
        };
    }
    if (item.kind === "move-day") {
        const receiver = dayBy(item.payload.toDay);
        const name = spot?.name || "Parada sin nombre";
        const fromPosition = Math.max(0, day.spots.findIndex((candidate) => candidate.id === item.payload.spotId)) + 1;
        const clearsReservation = Boolean(spot?.plannedStart || spot?.fixedStart);
        const note = clearsReservation ? " También quitará su hora planificada y la condición de reserva fija." : "";
        return {
            summary: `Moverá ${name} de ${day.title || "este día"}, posición ${fromPosition}, a ${receiver?.title || receiver?.date || "otro día"}, posición ${item.payload.at + 1}.${note}`,
            markup: `<p>Moverá la parada a otro día y comprobará que el día receptor no empeore.${clearsReservation ? " Se borrará su reserva horaria para evitar trasladar una hora inválida." : ""}</p><div class="health-suggestion-change"><span>Día</span><del>${esc(day.title || "Este día")}</del><i aria-hidden="true">→</i><ins>${esc(receiver?.title || receiver?.date || "Otro día")}</ins></div><div class="health-suggestion-change"><span>Posición</span><del>${fromPosition}</del><i aria-hidden="true">→</i><ins>${item.payload.at + 1}</ins></div>`,
        };
    }
    return { summary: item.label, markup: `<p>${esc(item.label)}</p>` };
}

function suggestionMarkup(item, day) {
    const preview = suggestionPreview(item, day);
    const data = `data-day="${esc(day.id)}" data-suggestion="${esc(item.id)}" data-signature="${esc(healthSignature(day, getHealthResult(day).routeContext))}"`;
    return `<div class="health-suggestion-card"><button class="health-suggestion-apply" type="button" data-health-action="suggestion" ${data} aria-label="${esc(`Aplicar: ${item.label}`)}"><span>${esc(item.label)}</span><small>${esc(item.impact)}</small></button><button class="health-suggestion-preview-button" type="button" data-health-action="suggestion-preview" ${data} aria-label="${esc(`Vista previa de ${item.label}. ${preview.summary}`)}"><span aria-hidden="true">◫</span> Vista previa</button></div>`;
}

function renderCenter(focusDayId) {
    const scopedDays = focusDayId ? store.state.filter((day) => day.id === focusDayId) : store.state;
    const states = scopedDays.map((day) => getHealthResult(day).state);
    const checked = scopedDays.filter((day) => getHealthResult(day).checked).length;
    $("#healthRunBtn").innerHTML = focusDayId
        ? '<span aria-hidden="true">↻</span> Comprobar este día'
        : '<span aria-hidden="true">↻</span> Comprobar ahora';
    $("#healthSummary").textContent = focusDayId
        ? (checked ? "Este día tiene un resultado vigente." : "Comprueba este día para revisar horarios, carga y trayectos.")
        : (checked
            ? `${checked} de ${store.state.length} días tienen un resultado vigente.`
            : "Comprueba el plan para revisar horarios, carga y trayectos.");
    const overviewStates = ["solid", "tight", "impossible", "incomplete", "unchecked"];
    $("#healthOverview").innerHTML = overviewStates.map((state) => {
        const meta = HEALTH_STATES[state];
        const count = states.filter((item) => item === state).length;
        return `<div class="health-overview-item is-${state}"><span class="health-overview-icon" aria-hidden="true">${meta.icon}</span><span><strong>${count}</strong><small>${meta.label}</small></span></div>`;
    }).join("");
    const allSpots = [...store.state.flatMap((day) => day.spots), ...store.backlog];
    const names = new Map(allSpots.map((spot) => [spot.id, spot.name || "Parada sin nombre"]));
    const disconnected = disconnectedTravelLegs(store.travelLegs, store.state);
    const disconnectedMarkup = !focusDayId && disconnected.length ? `<section class="health-disconnected"><div class="health-section-head"><span>Trayectos pendientes de reenlace</span><small>${disconnected.length}</small></div><ul class="health-issues">${disconnected.map(([key, leg]) => { const pair = parseTravelLegKey(key); return `<li class="is-missing"><span class="health-issue-icon" aria-hidden="true">↝</span><div class="health-issue-copy"><strong>${esc(names.get(pair.fromId) || pair.fromId)} → ${esc(names.get(pair.toId) || pair.toId)}</strong><small>${esc(leg.mode)} · extremos no consecutivos</small></div></li>`; }).join("")}</ul></section>` : "";
    resultsEl.innerHTML = disconnectedMarkup + scopedDays.map((day, dayIndex) => {
        const result = getHealthResult(day);
        const meta = HEALTH_STATES[result.state];
        const issues = result.issues.length
            ? `<div class="health-section-head"><span>Qué revisar</span><small>${result.issues.length} ${result.issues.length === 1 ? "incidencia" : "incidencias"}</small></div><ul class="health-issues">${result.issues.map((item) => { const icon = item.severity === "hard" ? "×" : item.severity === "warning" ? "!" : "+"; return `<li class="is-${item.severity}"><span class="health-issue-icon" aria-hidden="true">${icon}</span><div class="health-issue-copy"><strong>${esc(item.message)}</strong>${item.evidence?.minutes != null ? `<small>${item.evidence.minutes} min</small>` : ""}</div><div class="health-actions">${actionMarkup(item, day)}</div></li>`; }).join("")}</ul>`
            : `<p class="health-ok">${result.state === "solid" ? "No se detectan conflictos ni avisos." : `Pulsa ${focusDayId ? "Comprobar este día" : "Comprobar ahora"} para analizar este día.`}</p>`;
        const metrics = result.metrics ? `<dl class="health-metrics"><div><dt>Visitas</dt><dd>${result.metrics.activity}<small> min</small></dd></div><div><dt>Trayectos</dt><dd>${result.approximate ? "≈" : ""}${result.metrics.travel}<small> min</small></dd></div><div><dt>Caminata</dt><dd>${result.metrics.walking}<small> min</small></dd></div>${result.metrics.minMargin == null ? "" : `<div><dt>Margen mínimo</dt><dd>${result.metrics.minMargin}<small> min</small></dd></div>`}</dl>` : "";
        const suggestions = !["unchecked", "incomplete"].includes(result.state) ? generateSuggestions(day, result, evaluate, store.state) : [];
        const suggestionHtml = suggestions.length ? `<div class="health-suggestions"><div><span class="health-suggestion-icon" aria-hidden="true">✦</span><strong>Mejoras simuladas</strong><small>Revisa el cambio antes de aplicarlo.</small></div><div class="health-suggestion-list">${suggestions.map((item) => suggestionMarkup(item, day)).join("")}</div></div>` : "";
        const heading = `<div class="health-day-heading"><span class="health-date">${esc(healthDateLabel(day.date))}</span><h4>${esc(day.title || "Día sin título")}</h4></div><div class="health-day-controls"><span class="health-state"><span aria-hidden="true">${meta.icon}</span>${meta.label}</span>${focusDayId ? "" : '<span class="health-day-chevron" aria-hidden="true">⌄</span>'}</div>`;
        const body = `<div class="health-day-body"><div class="health-day-options"><div><strong>Hora de salida</strong><small>Fija el inicio de la simulación de este día.</small></div><label class="health-day-start"><input type="time" data-health-start="${esc(day.id)}" value="${esc(day.startTime || "")}" aria-label="Hora de inicio de ${esc(day.title || "este día")}" /></label></div>${metrics}${issues}${suggestionHtml}</div>`;
        if (focusDayId)
            return `<section class="health-day is-static is-${result.state}" data-health-result="${esc(day.id)}" tabindex="-1"><div class="health-day-summary">${heading}</div>${body}</section>`;
        return `<details class="health-day is-${result.state}" data-health-result="${esc(day.id)}"${dayIndex === 0 ? " open" : ""}><summary class="health-day-summary">${heading}</summary>${body}</details>`;
    }).join("");
    if (focusDayId) requestAnimationFrame(() => resultsEl
        .querySelector(`[data-health-result="${CSS.escape(focusDayId)}"]`)
        ?.focus({ preventScroll: true }));
}

export async function checkPlan({ focusDayId } = {}) {
    const token = ++runToken;
    busy = true;
    $("#healthRunBtn").disabled = true;
    const focusedDay = focusDayId ? dayBy(focusDayId) : null;
    const days = focusedDay ? [focusedDay] : [...store.state];
    for (let index = 0; index < days.length; index += 1) {
        if (token !== runToken) return;
        $("#healthProgress").textContent = focusDayId
            ? "Comprobando este día…"
            : `Comprobando ${index + 1} de ${days.length} días…`;
        setHealthResult(days[index], evaluate(days[index]));
    }
    if (token !== runToken) return;
    busy = false;
    $("#healthRunBtn").disabled = false;
    $("#healthProgress").textContent = days.length ? "Comprobación terminada." : "Añade un día para comprobar el plan.";
    render({ persist: false });
    renderCenter(focusDayId);
}

function openHealth(dayId, run = false) {
    activeDayId = dayBy(dayId)?.id || null;
    openModal(dialog);
    renderCenter(activeDayId);
    if (run && !busy) checkPlan({ focusDayId: activeDayId });
}

function currentSuggestion(day, id) {
    const result = getHealthResult(day);
    return generateSuggestions(day, result, evaluate, store.state).find((item) => item.id === id);
}

function resolveSuggestion(button) {
    const day = dayBy(button.dataset.day);
    if (!day || button.dataset.signature !== healthSignature(day, getHealthResult(day).routeContext)) {
        toast("El plan cambió. Vuelve a comprobarlo antes de aplicar la mejora.", "info");
        return null;
    }
    const item = currentSuggestion(day, button.dataset.suggestion);
    if (!item) {
        toast("La mejora ya no es aplicable. Vuelve a comprobar el plan.", "info");
        return null;
    }
    return { day, item };
}

function openSuggestionPreview(button) {
    const resolved = resolveSuggestion(button);
    if (!resolved) return;
    const { day, item } = resolved;
    const preview = suggestionPreview(item, day);
    previewTrigger = button;
    $("#healthSuggestionDialogTitle").textContent = item.label;
    $("#healthSuggestionDialogDay").textContent = `${healthDateLabel(day.date)} · ${day.title || "Día sin título"}`;
    $("#healthSuggestionPreview").innerHTML = `<p class="health-suggestion-preview-summary">${esc(preview.summary)}</p><div class="health-suggestion-preview-details">${preview.markup}</div><p class="health-suggestion-preview-note">La simulación no modifica el plan hasta que pulses “Aplicar mejora”. Después podrás deshacer el cambio.</p>`;
    openModal(suggestionDialog);
}

async function applySuggestion(button) {
    const resolved = resolveSuggestion(button);
    if (!resolved) return;
    const { day, item } = resolved;
    await derivedPlanOperation((document) => {
        if (item.kind === "start-earlier" || item.kind === "add-margin") {
            return setFieldIntent(document, { type: "day", id: day.id, field: "startTime" }, item.payload.startTime);
        }
        if (item.kind === "reorder") {
            const source = document.days.find((candidate) => candidate.id === day.id);
            return commandIntent({
                target: { type: "day", id: day.id },
                command: "reorder-day-spots",
                precondition: { expectedOrder: source.spots.map((spot) => spot.id) },
                payload: { order: item.payload.order },
            });
        }
        const containerId = item.kind === "remove-optional" ? "backlog" : item.payload.toDay;
        const destination = containerId === "backlog"
            ? document.backlog
            : document.days.find((candidate) => candidate.id === containerId)?.spots || [];
        const withoutMoving = destination.filter((spot) => spot.id !== item.payload.spotId);
        const beforeId = item.kind === "remove-optional"
            ? null
            : withoutMoving[Math.max(0, Math.min(item.payload.at, withoutMoving.length))]?.id ?? null;
        return moveEntityIntent(document, { type: "spot", id: item.payload.spotId }, { containerId, beforeId });
    });
    await checkPlan({ focusDayId: day.id });
    toast("Mejora aplicada. Puedes deshacerla desde la cabecera.", "success");
}

$("#healthCheckBtn").addEventListener("click", () => openHealth(undefined, true));
$("#healthRunBtn").addEventListener("click", () => checkPlan({ focusDayId: activeDayId }));
document.addEventListener("click", (event) => {
    const badge = event.target.closest("[data-health-day]");
    if (badge) { event.stopPropagation(); openHealth(badge.dataset.healthDay); }
});
resultsEl.addEventListener("change", async (event) => {
    const day = dayBy(event.target.dataset.healthStart);
    if (!day) return;
    const value = event.target.value;
    await derivedPlanOperation((document) => setFieldIntent(
        document,
        { type: "day", id: day.id, field: "startTime" },
        value || undefined,
        { remove: !value },
    ));
    renderCenter(day.id);
});
resultsEl.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-health-action]");
    if (!button) return;
    const action = button.dataset.healthAction;
    if (action === "edit") {
        const day = dayBy(button.dataset.day), spot = day?.spots.find((item) => item.id === button.dataset.spot);
        if (spot) {
            dialog.close();
            openDialog(day.id, spot, {
                focus: button.dataset.focus,
                onSave: () => openHealth(day.id, true),
            });
        }
        return;
    }
    if (action === "edit-travel") {
        dialog.close();
        openTravelLegDialog(button.dataset.day, button.dataset.from, button.dataset.to);
        return;
    }
    if (action === "suggestion-preview") {
        openSuggestionPreview(button);
        return;
    }
    if (action === "suggestion") await applySuggestion(button);
});

$("#healthSuggestionApply").addEventListener("click", async () => {
    const trigger = previewTrigger;
    suggestionDialog.close();
    if (trigger) await applySuggestion(trigger);
});

suggestionDialog.addEventListener("close", () => {
    const trigger = previewTrigger;
    previewTrigger = null;
    if (trigger?.isConnected && dialog.open)
        requestAnimationFrame(() => trigger.focus({ preventScroll: true }));
});
