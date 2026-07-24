import { store, save, dayBy, routeTimeProfile, routeTimeOverride, travelLeg } from "../../core/store.js?v=26";
import { AUTOMATIC_TRAVEL_MODES, disconnectedTravelLegs, parseTravelLegKey } from "../../core/travel-legs.js";
import { $, esc } from "../../shared/dom.js";
import { toast } from "../../shared/notify.js?v=3";
import { buildTimelineProjection } from "../companion/timeline.js";
import { cachedRouteTravelMinutes, drawMap } from "../map/map.js";
import { openDialog } from "../planner/dialogs.js?v=1";
import { pushUndo } from "../planner/history.js";
import { relocateSpot } from "../planner/move-spot.js";
import { render, openTravelLegDialog } from "../planner/render.js";
import { diagnoseDay } from "./diagnostics.js";
import { generateSuggestions } from "./suggestions.js";
import { getHealthResult, HEALTH_STATES, healthSignature, setHealthResult } from "./session.js";

const dialog = $("#healthDialog");
const resultsEl = $("#healthResults");
let runToken = 0;
let busy = false;

function healthDateLabel(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        return "Sin fecha";
    return new Intl.DateTimeFormat("es-ES", {
        weekday: "short",
        day: "numeric",
        month: "short",
    }).format(new Date(`${value}T12:00:00`));
}

function travelForLeg(from, to) {
    const configured = travelLeg(from.id, to.id);
    const profile = AUTOMATIC_TRAVEL_MODES.includes(configured?.mode) ? configured.mode : routeTimeProfile(from.id, to.id);
    const officialMinutes = AUTOMATIC_TRAVEL_MODES.includes(profile) ? cachedRouteTravelMinutes(from, to, profile) : null;
    const override = configured?.durationMinutes ?? routeTimeOverride(from.id, to.id, profile);
    return { minutes: override ?? officialMinutes, officialMinutes, overridden: override != null, profile, mode: configured?.mode || profile, departureTime: configured?.departureTime, fixedDeparture: configured?.fixedDeparture, line: configured?.line, cost: configured?.cost, embeddedEndpoints: configured?.embeddedEndpoints };
}

function evaluate(day) {
    return diagnoseDay(day, buildTimelineProjection(day, { travelForLeg }));
}

function actionMarkup(issue, day) {
    if (issue.type === "missing-travel-duration")
        return `<button class="health-action" type="button" data-health-action="edit-travel" data-day="${esc(day.id)}" data-from="${esc(issue.evidence.fromId)}" data-to="${esc(issue.spotId)}">Completar trayecto <span aria-hidden="true">→</span></button>`;
    if (issue.type.startsWith("missing-"))
        return `<button class="health-action" type="button" data-health-action="edit" data-day="${esc(day.id)}" data-spot="${esc(issue.spotId)}" data-focus="${esc(issue.evidence.field)}">Completar <span aria-hidden="true">→</span></button>`;
    return "";
}

function renderCenter(focusDayId) {
    const states = store.state.map((day) => getHealthResult(day).state);
    const checked = store.state.filter((day) => getHealthResult(day).checked).length;
    $("#healthSummary").textContent = checked
        ? `${checked} de ${store.state.length} días tienen un resultado vigente.`
        : "Comprueba el plan para revisar horarios, carga y trayectos.";
    const overviewStates = ["solid", "tight", "impossible", "incomplete", "unchecked"];
    $("#healthOverview").innerHTML = overviewStates.map((state) => {
        const meta = HEALTH_STATES[state];
        const count = states.filter((item) => item === state).length;
        return `<div class="health-overview-item is-${state}"><span class="health-overview-icon" aria-hidden="true">${meta.icon}</span><span><strong>${count}</strong><small>${meta.label}</small></span></div>`;
    }).join("");
    const allSpots = [...store.state.flatMap((day) => day.spots), ...store.backlog];
    const names = new Map(allSpots.map((spot) => [spot.id, spot.name || "Parada sin nombre"]));
    const disconnected = disconnectedTravelLegs(store.travelLegs, store.state);
    const disconnectedMarkup = disconnected.length ? `<section class="health-disconnected"><div class="health-section-head"><span>Trayectos pendientes de reenlace</span><small>${disconnected.length}</small></div><ul class="health-issues">${disconnected.map(([key, leg]) => { const pair = parseTravelLegKey(key); return `<li class="is-missing"><span class="health-issue-icon" aria-hidden="true">↝</span><div class="health-issue-copy"><strong>${esc(names.get(pair.fromId) || pair.fromId)} → ${esc(names.get(pair.toId) || pair.toId)}</strong><small>${esc(leg.mode)} · extremos no consecutivos</small></div></li>`; }).join("")}</ul></section>` : "";
    resultsEl.innerHTML = disconnectedMarkup + store.state.map((day, dayIndex) => {
        const result = getHealthResult(day);
        const meta = HEALTH_STATES[result.state];
        const issues = result.issues.length
            ? `<div class="health-section-head"><span>Qué revisar</span><small>${result.issues.length} ${result.issues.length === 1 ? "incidencia" : "incidencias"}</small></div><ul class="health-issues">${result.issues.map((item) => { const icon = item.severity === "hard" ? "×" : item.severity === "warning" ? "!" : "+"; return `<li class="is-${item.severity}"><span class="health-issue-icon" aria-hidden="true">${icon}</span><div class="health-issue-copy"><strong>${esc(item.message)}</strong>${item.evidence?.minutes != null ? `<small>${item.evidence.minutes} min</small>` : ""}</div><div class="health-actions">${actionMarkup(item, day)}</div></li>`; }).join("")}</ul>`
            : `<p class="health-ok">${result.state === "solid" ? "No se detectan conflictos ni avisos." : "Pulsa Comprobar ahora para analizar este día."}</p>`;
        const metrics = result.metrics ? `<dl class="health-metrics"><div><dt>Visitas</dt><dd>${result.metrics.activity}<small> min</small></dd></div><div><dt>Trayectos</dt><dd>${result.approximate ? "≈" : ""}${result.metrics.travel}<small> min</small></dd></div><div><dt>Caminata</dt><dd>${result.metrics.walking}<small> min</small></dd></div>${result.metrics.minMargin == null ? "" : `<div><dt>Margen mínimo</dt><dd>${result.metrics.minMargin}<small> min</small></dd></div>`}</dl>` : "";
        const suggestions = !["unchecked", "incomplete"].includes(result.state) ? generateSuggestions(day, result, evaluate, store.state) : [];
        const suggestionHtml = suggestions.length ? `<div class="health-suggestions"><div><span class="health-suggestion-icon" aria-hidden="true">✦</span><strong>Mejoras simuladas</strong></div><div class="health-suggestion-list">${suggestions.map((item) => `<button type="button" data-health-action="suggestion" data-day="${esc(day.id)}" data-suggestion="${esc(item.id)}" data-signature="${esc(healthSignature(day, result.routeContext))}"><span>${esc(item.label)}</span><small>${esc(item.impact)}</small></button>`).join("")}</div></div>` : "";
        const opened = focusDayId ? day.id === focusDayId : dayIndex === 0;
        return `<details class="health-day is-${result.state}" data-health-result="${esc(day.id)}"${opened ? " open" : ""}><summary><div class="health-day-heading"><span class="health-date">${esc(healthDateLabel(day.date))}</span><h4>${esc(day.title || "Día sin título")}</h4></div><div class="health-day-controls"><span class="health-state"><span aria-hidden="true">${meta.icon}</span>${meta.label}</span><span class="health-day-chevron" aria-hidden="true">⌄</span></div></summary><div class="health-day-body"><div class="health-day-options"><div><strong>Hora de salida</strong><small>Fija el inicio de la simulación de este día.</small></div><label class="health-day-start"><input type="time" data-health-start="${esc(day.id)}" value="${esc(day.startTime || "")}" aria-label="Hora de inicio de ${esc(day.title || "este día")}" /></label></div>${metrics}${issues}${suggestionHtml}</div></details>`;
    }).join("");
    if (focusDayId) requestAnimationFrame(() => resultsEl.querySelector(`[data-health-result="${CSS.escape(focusDayId)}"] summary`)?.focus());
}

export async function checkPlan({ focusDayId } = {}) {
    const token = ++runToken;
    busy = true;
    $("#healthRunBtn").disabled = true;
    const days = [...store.state];
    for (let index = 0; index < days.length; index += 1) {
        if (token !== runToken) return;
        $("#healthProgress").textContent = `Comprobando ${index + 1} de ${days.length} días…`;
        setHealthResult(days[index], evaluate(days[index]));
    }
    if (token !== runToken) return;
    busy = false;
    $("#healthRunBtn").disabled = false;
    $("#healthProgress").textContent = store.state.length ? "Comprobación terminada." : "Añade un día para comprobar el plan.";
    render({ persist: false });
    renderCenter(focusDayId);
}

function openHealth(dayId, run = false) {
    if (!dialog.open) dialog.showModal();
    renderCenter(dayId);
    if (run && !busy) checkPlan({ focusDayId: dayId });
}

function currentSuggestion(day, id) {
    const result = getHealthResult(day);
    return generateSuggestions(day, result, evaluate, store.state).find((item) => item.id === id);
}

async function applySuggestion(button) {
    const day = dayBy(button.dataset.day);
    if (!day || button.dataset.signature !== healthSignature(day, getHealthResult(day).routeContext)) {
        toast("El plan cambió. Vuelve a comprobarlo antes de aplicar la mejora.", "info");
        return;
    }
    const item = currentSuggestion(day, button.dataset.suggestion);
    if (!item) { toast("La mejora ya no es aplicable. Vuelve a comprobar el plan.", "info"); return; }
    pushUndo();
    if (item.kind === "start-earlier" || item.kind === "add-margin") day.startTime = item.payload.startTime;
    else if (item.kind === "remove-optional") relocateSpot(store, item.payload.spotId, "backlog", store.backlog.length);
    else if (item.kind === "reorder") day.spots = item.payload.order.map((id) => day.spots.find((spot) => spot.id === id));
    else if (item.kind === "move-day") relocateSpot(store, item.payload.spotId, item.payload.toDay, item.payload.at);
    save(); render(); drawMap();
    await checkPlan({ focusDayId: day.id });
    toast("Mejora aplicada. Puedes deshacerla desde la cabecera.", "success");
}

$("#healthCheckBtn").addEventListener("click", () => openHealth(undefined, true));
$("#healthRunBtn").addEventListener("click", () => checkPlan());
dialog.querySelector(".close").addEventListener("click", () => dialog.close());
document.addEventListener("click", (event) => {
    const badge = event.target.closest("[data-health-day]");
    if (badge) { event.stopPropagation(); openHealth(badge.dataset.healthDay); }
});
resultsEl.addEventListener("change", async (event) => {
    const day = dayBy(event.target.dataset.healthStart);
    if (!day) return;
    pushUndo();
    if (event.target.value) day.startTime = event.target.value; else delete day.startTime;
    save(); render(); drawMap(); renderCenter(day.id);
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
    if (action === "suggestion") await applySuggestion(button);
});
