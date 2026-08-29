import { store, spotIsEnabled } from "../../core/store.js";
import { isWaypoint, spotPositionConstraint } from "../../core/itinerary.js";
import { timeToMinutes } from "../../core/time.js";
import { $, esc } from "../../shared/dom.js";
import { openModal } from "../../shared/modal.js";
import { confirmAction, toast } from "../../shared/notify.js";
import { derivedPlanOperation, replacePlanIntent } from "../../core/plan-operation-commit.js";
import { ensureRouteTravelTimes } from "../map/map.js";
import { downloadPlanExport } from "../planner/export-plan.js";
import {
    resolveTravelForLeg,
    travelProfilesForSpots,
} from "../timeline/travel-resolver.js";
import { fetchTravelMatrix } from "./travel-matrix.js";
import { establishedBaseline } from "./baseline.js";
import {
    brokenDepartureLegs,
    brokenVisitedStops,
    directedLegKey,
    departureLockedLegs,
    seedEstablishedLegs,
    simulatorLegKey,
    visitedLockedStops,
} from "./legs.js";
import { formatSimulationTime, optimizeRoute } from "./optimizer.js";
import { mountRouteMap, routeMapMarkup } from "./route-map.js";
import { applySimulationToDay, simulationDayFingerprint } from "./application.js";

const dialog = $("#routeSimulatorDialog");
const form = $("#routeSimulatorForm");
const daySelect = $("#routeSimulatorDay");
const spotsEl = $("#routeSimulatorSpots");
const resultEl = $("#routeSimulatorResult");
const runButton = $("#routeSimulatorRun");
const statusEl = $("#routeSimulatorStatus");
const backToResultButton = $("#routeSimulatorBackToResult");
const spotEditorEl = $("#routeSimulatorSpotEditor");
const RUN_HINT = "Respeta aperturas, cierres y citas; después reduce trayectos";
let calculationToken = 0;
let activeSimulation = null;
let activeSimulatorSpotId = null;
let unmountRouteMap = null;

// Configuring and reading the answer are sequential, not simultaneous: the
// traveller picks stops once and then lives in the result. Splitting the dialog
// in half for both meant each got a cramped column for the whole session, so
// only one phase holds the width at a time.
function setPhase(phase) {
    dialog.dataset.phase = phase;
    backToResultButton.hidden = phase !== "setup" || !activeSimulation;
}

function startLabel() {
    return $("#routeSimulatorFixedStart").checked
        ? `inicio ${$("#routeSimulatorStart").value || "sin definir"}`
        : "inicio libre";
}

function updateSummary() {
    const day = currentDay();
    const index = store.state.findIndex((entry) => entry === day);
    const count = spotsEl.querySelectorAll("[data-simulator-spot]:checked").length;
    $("#routeSimulatorSummaryTitle").textContent = `${count} ${count === 1 ? "parada simulada" : "paradas simuladas"}`;
    $("#routeSimulatorSummaryDetail").textContent = day
        ? `${dayLabel(day, index)} · ${startLabel()}`
        : startLabel();
}

function dayLabel(day, index) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(day.date || "")
        ? new Intl.DateTimeFormat("es-ES", { weekday: "short", day: "numeric", month: "short" }).format(new Date(`${day.date}T12:00:00`))
        : `Día ${index + 1}`;
    return `${date} · ${day.title || `Día ${index + 1}`}`;
}

function currentDay() {
    return store.state.find((day) => String(day.id) === daySelect.value) || null;
}

// A run needs two stops, so the button says so before it is pressed instead of
// letting the traveller click into an error message.
function syncRunButton() {
    if (runButton.classList.contains("is-loading")) return;
    const count = spotsEl.querySelectorAll("[data-simulator-spot]:checked").length;
    runButton.disabled = count < 2;
    runButton.querySelector("small").textContent = count < 2
        ? "Selecciona al menos dos paradas con ubicación"
        : RUN_HINT;
}

function selectionCount() {
    const count = spotsEl.querySelectorAll("[data-simulator-spot]:checked").length;
    $("#routeSimulatorSelectionCount").textContent = `${count} ${count === 1 ? "seleccionada" : "seleccionadas"}`;
    syncRunButton();
}

function syncSpotControls() {
    spotsEl.querySelectorAll(".route-simulator-spot").forEach((row) => {
        const selected = row.querySelector("[data-simulator-spot]")?.checked === true;
        row.querySelectorAll("[data-simulator-time], [data-simulator-position]").forEach((control) => {
            control.disabled = !selected;
        });
    });
    renderSpotEditor(activeSimulatorSpotId);
}

function enforceUniquePosition(changed) {
    const value = changed.value;
    if (value !== "first" && value !== "last") return;
    spotsEl.querySelectorAll("[data-simulator-position]").forEach((control) => {
        if (control === changed) return;
        if (control.value === value) control.value = "free";
    });
}

const POSITION_OPTIONS = Object.freeze([
    ["free", "Libre"],
    ["first", "Primera"],
    ["last", "Última"],
    ["fixed", "Fijar aquí"],
]);

// The itinerary already records anchored stops. Start the dialog from them
// instead of asking the traveller to declare the same thing twice.
function simulatorPosition(spot) {
    return { first: "first", last: "last", locked: "fixed" }[spotPositionConstraint(spot)] || "free";
}

function durationLabel(spot) {
    if (isWaypoint(spot)) return "Punto de paso · 0 min";
    if (Number.isInteger(spot.visitMinutes) && spot.visitMinutes > 0) return `${spot.visitMinutes} min de visita`;
    return "Sin duración · se usarán 0 min";
}

function scheduleLabel(spot) {
    if (isWaypoint(spot) || spot.scheduleNotApplicable === true) return "";
    if (spot.openingTime === "00:00" && spot.closingTime === "00:00") return "Todo el día";
    if (spot.openingTime && spot.closingTime) return `Horario ${spot.openingTime}–${spot.closingTime}`;
    if (spot.openingTime) return `Abre ${spot.openingTime}`;
    if (spot.closingTime) return `Cierra ${spot.closingTime}`;
    return "";
}

function spotTimingLabel(spot) {
    return [durationLabel(spot), scheduleLabel(spot)].filter(Boolean).join(" · ");
}

function renderSpotEditor(spotId) {
    const day = currentDay();
    const spot = day?.spots?.find((candidate) => String(candidate.id) === String(spotId));
    spotsEl.querySelectorAll("[data-simulator-edit]").forEach((button) => {
        const active = button.dataset.simulatorEdit === String(spot?.id);
        button.closest(".route-simulator-spot")?.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", String(active));
    });
    if (!spot) {
        activeSimulatorSpotId = null;
        spotEditorEl.innerHTML = `<div class="route-simulator-section-title"><span>03</span><div><strong>Ajusta una parada</strong><small>Elige una en el recorrido.</small></div></div>
            <div class="route-simulator-editor-empty"><span aria-hidden="true">↙</span><p><strong>Selecciona una parada</strong><small>Aquí podrás fijar su hora o conservarla en una posición concreta.</small></p></div>`;
        return;
    }
    activeSimulatorSpotId = String(spot.id);
    const row = spotsEl.querySelector(`[data-simulator-row="${CSS.escape(activeSimulatorSpotId)}"]`);
    const timeControl = row?.querySelector("[data-simulator-time]");
    const positionControl = row?.querySelector("[data-simulator-position]");
    const selected = row?.querySelector("[data-simulator-spot]")?.checked === true;
    if (!timeControl || !positionControl) {
        const issue = !(Number.isFinite(spot.lat) && Number.isFinite(spot.lng)) ? "No tiene ubicación" : "Está desactivada en el itinerario";
        spotEditorEl.innerHTML = `<div class="route-simulator-section-title"><span>03</span><div><strong>Ajusta una parada</strong><small>Solo dentro de esta simulación.</small></div></div>
            <div class="route-simulator-editor-heading"><span>No disponible</span><h4>${esc(spot.name || "Parada sin nombre")}</h4><p>${esc(issue)} y no puede participar en el cálculo.</p></div>`;
        return;
    }
    spotEditorEl.innerHTML = `<div class="route-simulator-section-title"><span>03</span><div><strong>Ajusta una parada</strong><small>Solo dentro de esta simulación.</small></div></div>
        <div class="route-simulator-editor-heading"><span>Parada seleccionada</span><h4>${esc(spot.name || "Parada sin nombre")}</h4><p>${esc(spotTimingLabel(spot))}</p></div>
        <div class="route-simulator-editor-fields${selected ? "" : " is-disabled"}">
            <label class="route-simulator-editor-time"><span>Inicio planificado</span><input type="time" data-simulator-editor-time value="${esc(timeControl.value)}"${selected ? "" : " disabled"} /></label>
            <fieldset${selected ? "" : " disabled"}><legend>Posición en la ruta</legend><div class="route-simulator-position-options">${POSITION_OPTIONS.map(([value, label]) => `<label><input type="radio" name="routeSimulatorEditorPosition" value="${value}"${positionControl.value === value ? " checked" : ""} /><span>${label}</span></label>`).join("")}</div></fieldset>
            ${selected ? "" : "<p>Activa esta parada para poder ajustar sus condiciones.</p>"}
        </div>`;
}

function resetRunButton() {
    runButton.classList.remove("is-loading");
    runButton.disabled = false;
    runButton.querySelector("strong").textContent = "Calcular mejor ruta";
    syncRunButton();
}

// Every path that rebuilds the stop list also discards the result panel, so it
// must discard the calculation still in flight with it. Without bumping the
// token, changing the day mid-calculation let the pending run finish and paint
// the previous day's route next to the new day's stops — a perfectly formed
// answer to a question the traveller had already stopped asking. The token then
// leaves the pending run to return early, so the button is restored here too.
function renderSpots() {
    const day = currentDay();
    calculationToken += 1;
    activeSimulation = null;
    resetRunButton();
    resultEl.innerHTML = "";
    $("#routeSimulatorError").textContent = "";
    statusEl.textContent = "";
    setPhase("setup");
    if (!day?.spots?.length) {
        spotsEl.innerHTML = '<div class="route-simulator-no-spots"><strong>Este día todavía no tiene paradas.</strong><p>Añade ubicaciones al itinerario para poder simular una ruta.</p></div>';
        renderSpotEditor(null);
        selectionCount();
        return;
    }
    const rows = day.spots.map((spot, index) => {
        const located = Number.isFinite(spot.lat) && Number.isFinite(spot.lng);
        const enabled = spotIsEnabled(spot);
        const available = located && enabled;
        const issue = !located ? "Sin ubicación" : !enabled ? "Parada desactivada" : "";
        const warning = !isWaypoint(spot) && !(Number.isInteger(spot.visitMinutes) && spot.visitMinutes > 0);
        const position = available ? simulatorPosition(spot) : "free";
        const name = spot.name || "Parada sin nombre";
        const controls = available
            ? `<input type="hidden" data-simulator-time="${esc(String(spot.id))}" value="${esc(spot.plannedStart || "")}" />
                <input type="hidden" data-simulator-position="${esc(String(spot.id))}" value="${esc(position)}" />`
            : "";
        const detail = available
            ? `<button class="route-simulator-spot-detail" type="button" data-simulator-edit="${esc(String(spot.id))}" aria-pressed="false">
                <span class="route-simulator-spot-index">${String(index + 1).padStart(2, "0")}</span>
                <span class="route-simulator-spot-copy"><strong>${esc(name)}</strong><small class="${warning ? "is-warning" : ""}">${esc(spotTimingLabel(spot))}</small></span>
                <span class="route-simulator-spot-open" aria-hidden="true">›</span>
            </button>`
            : `<div class="route-simulator-spot-detail"><span class="route-simulator-spot-index">${String(index + 1).padStart(2, "0")}</span><span class="route-simulator-spot-copy"><strong>${esc(name)}</strong><small>${esc(issue)}</small></span></div>`;
        return `<article class="route-simulator-spot${available ? "" : " is-unavailable"}" data-simulator-row="${esc(String(spot.id))}">
            <label class="route-simulator-spot-toggle"><input type="checkbox" data-simulator-spot value="${esc(String(spot.id))}" ${available ? "checked" : "disabled"} /><span class="sr-only">Incluir ${esc(name)}</span></label>
            ${detail}${controls}
        </article>`;
    }).join("");
    spotsEl.innerHTML = rows;
    const activeStillExists = day.spots.some((spot) => String(spot.id) === String(activeSimulatorSpotId));
    if (!activeStillExists) activeSimulatorSpotId = String(day.spots.find((spot) => Number.isFinite(spot.lat) && Number.isFinite(spot.lng) && spotIsEnabled(spot))?.id || day.spots[0]?.id || "");
    selectionCount();
    syncSpotControls();
}

function initializeDialog() {
    const activeDay = store.state.some((day) => day.id === store.active) ? store.active : store.state[0]?.id;
    daySelect.innerHTML = store.state.length
        ? store.state.map((day, index) => `<option value="${esc(String(day.id))}">${esc(dayLabel(day, index))}</option>`).join("")
        : '<option value="">No hay días</option>';
    daySelect.value = activeDay == null ? "" : String(activeDay);
    const day = currentDay();
    const hasStart = timeToMinutes(day?.startTime) !== null;
    $("#routeSimulatorFixedStart").checked = hasStart;
    $("#routeSimulatorStart").disabled = !hasStart;
    $("#routeSimulatorStart").value = hasStart ? day.startTime : "09:00";
    renderSpots();
}

function simulationSelection() {
    const day = currentDay();
    const empty = { day: null, spots: [], sourceSpots: [], firstSpotIndex: null, lastSpotIndex: null, fixedSpotIndexes: [] };
    if (!day) return empty;
    const selectedIds = new Set([...spotsEl.querySelectorAll("[data-simulator-spot]:checked")].map((input) => input.value));
    let firstSpotIndex = null;
    let lastSpotIndex = null;
    const fixedSpotIndexes = [];
    // sourceSpots stays untouched: it is the established plan the "Antes" side
    // renders. spots carries the dialog's what-if overrides for the optimizer.
    const sourceSpots = day.spots.filter((spot) => selectedIds.has(String(spot.id)));
    const spots = sourceSpots.map((spot, index) => {
        const input = spotsEl.querySelector(`[data-simulator-time="${CSS.escape(String(spot.id))}"]`);
        const position = spotsEl.querySelector(`[data-simulator-position="${CSS.escape(String(spot.id))}"]`)?.value;
        if (position === "first") firstSpotIndex = index;
        if (position === "last") lastSpotIndex = index;
        if (position === "fixed") fixedSpotIndexes.push(index);
        return { ...spot, plannedStart: input?.value || undefined };
    });
    return { day, spots, sourceSpots, firstSpotIndex, lastSpotIndex, fixedSpotIndexes };
}

function metricsMarkup(result) {
    const metrics = result.metrics;
    return `<dl class="route-simulator-metrics" aria-label="Resumen horario de la propuesta">
        <div><dt>Empieza</dt><dd>${esc(formatSimulationTime(result.start))}</dd></div>
        <div><dt>Termina</dt><dd>${esc(formatSimulationTime(result.finish))}</dd></div>
        <div><dt>En movimiento</dt><dd>${metrics.travel}<small>min</small></dd></div>
        <div><dt>En visitas</dt><dd>${metrics.visit}<small>min</small></dd></div>
    </dl>`;
}

function comparisonOccurrences(result) {
    const seen = new Map();
    return result.steps.map((step) => {
        const count = (seen.get(step.spotIndex) || 0) + 1;
        seen.set(step.spotIndex, count);
        return `${step.spotIndex}:${count}`;
    });
}

// True at every position holding a different stop than the other order holds
// there. Drives the ↕ badge on the reference column and on the step list.
function movedFlags(result, other) {
    const otherPositions = new Map(comparisonOccurrences(other).map((key, index) => [key, index]));
    return comparisonOccurrences(result).map((key, index) => otherPositions.get(key) !== index);
}

function stepStatus(step) {
    if (step.repeated) return "Regreso";
    if (step.outsideSchedule) return `Fuera de horario${step.outsideMinutes ? ` · ${step.outsideMinutes} min` : ""}`;
    if (step.late) return `+${step.late} min tarde`;
    return formatSimulationTime(step.start);
}

// The established order as a plain reference column. It used to sit beside a
// second list of the proposed order that repeated the step list below it line
// for line; the proposal now lives only in the editable timeline.
function beforeColumnMarkup(baseline, result) {
    const moved = movedFlags(baseline, result);
    const rows = baseline.steps.map((step, index) =>
        `<li class="${moved[index] ? "is-moved" : ""}"><b>${index + 1}</b><span><strong>${esc(step.spot.name || "Parada sin nombre")}</strong><small>${esc(stepStatus(step))}</small></span>${moved[index] ? '<i aria-label="Cambia de posición">↕</i>' : ""}</li>`).join("");
    return `<section class="route-simulator-route-col is-before">
        <header><span>Antes</span><strong>${baseline.metrics.travel} min de trayecto</strong></header>
        <p class="route-simulator-route-note">Tu itinerario tal y como está guardado: su orden, sus horas y las duraciones de trayecto que ya tienes.</p>
        <ol>${rows}</ol>
        <footer><span>Jornada <b>${baseline.finish - baseline.start} min</b></span><span>Conflictos <b>${baseline.metrics.scheduleConflictStops}</b></span></footer>
    </section>`;
}

// The headline claims time, so it must measure the time the traveller spends:
// the whole day, from the first departure to the last stop. Travel minutes are
// only one ingredient of it — announcing a saving from them alone contradicts a
// day that ends later.
function savingsMarkup(result, baseline) {
    const travelSaved = baseline.metrics.travel - result.metrics.travel;
    const elapsedBefore = baseline.finish - baseline.start;
    const elapsedNow = result.finish - result.start;
    const elapsedSaved = elapsedBefore - elapsedNow;
    const latenessSaved = baseline.metrics.totalLate - result.metrics.totalLate;
    const scheduleConflictsSaved = baseline.metrics.scheduleConflictStops - result.metrics.scheduleConflictStops;
    const state = elapsedSaved > 0 ? "saving" : elapsedSaved < 0 ? "cost" : "same";
    const headline = elapsedSaved > 0
        ? `${elapsedSaved} min ahorrados`
        : elapsedSaved < 0 ? `${Math.abs(elapsedSaved)} min más de jornada` : "Misma duración de jornada";
    const detail = elapsedSaved < 0 && scheduleConflictsSaved > 0
        ? `La propuesta alarga la jornada para evitar ${scheduleConflictsSaved} ${scheduleConflictsSaved === 1 ? "conflicto horario" : "conflictos horarios"}.`
        : elapsedSaved < 0 && latenessSaved > 0
            ? `La propuesta alarga la jornada para reducir el retraso acumulado en ${latenessSaved} min.`
        : scheduleConflictsSaved > 0 ? `Evita ${scheduleConflictsSaved} ${scheduleConflictsSaved === 1 ? "conflicto horario" : "conflictos horarios"}.`
            : latenessSaved > 0 ? `Reduce el retraso acumulado en ${latenessSaved} min.`
            : travelSaved > 0 ? `Reduce el tiempo de trayecto en ${travelSaved} min.`
            : travelSaved < 0 ? `Emplea ${Math.abs(travelSaved)} min más de trayecto.`
                : "El tiempo de trayecto no cambia.";
    const conclusion = scheduleConflictsSaved > 0 || latenessSaved > 0
        ? "Mejora el encaje del día"
        : elapsedSaved > 0 ? "La propuesta sí mejora la ruta"
            : elapsedSaved < 0 ? "La ruta actual sigue siendo más corta"
                : "No hay una mejora clara";
    return `<div class="route-simulator-savings is-${state}">
        <span class="route-simulator-verdict-mark" aria-hidden="true">${elapsedSaved > 0 ? "↓" : elapsedSaved < 0 ? "↑" : "="}</span>
        <div class="route-simulator-verdict-copy"><span>Conclusión</span><h4>${esc(conclusion)}</h4><strong>${esc(headline)}</strong><p>${esc(detail)}</p></div>
        <div class="route-simulator-duration-shift" aria-label="Comparación de la duración de la jornada"><span>Itinerario actual <b>${elapsedBefore} min</b></span><i aria-hidden="true">→</i><span>Propuesta <b>${elapsedNow} min</b></span></div>
    </div>`;
}

function resultSpotName(result, spotIndex) {
    return result.steps.find((step) => step.spotIndex === spotIndex)?.spot.name || "La parada fijada";
}

function renderResult(result, {
    approximate,
    missingDurations,
    firstSpotIndex,
    lastSpotIndex,
    fixedSpotIndexes,
    baseline,
    manualLegs,
    establishedLegs,
    departureLegs,
    visitedStops,
    preserveScroll = false,
}) {
    unmountRouteMap?.();
    unmountRouteMap = null;
    const previousScroll = resultEl.scrollTop;
    const delayed = result.metrics.lateStops > 0;
    const outsideHours = result.metrics.outsideStops > 0;
    const notices = [];
    if (missingDurations.length) notices.push(`<div class="route-simulator-notice is-warning"><span aria-hidden="true">!</span><p><strong>Duración asumida: 0 minutos</strong>${esc(missingDurations.join(", "))} no ${missingDurations.length === 1 ? "tiene" : "tienen"} duración definida.</p></div>`);
    if (approximate) notices.push('<div class="route-simulator-notice"><span aria-hidden="true">≈</span><p><strong>Ruta aproximada</strong>No se pudo medir algún trayecto por calles; se estimó por distancia geográfica.</p></div>');
    if (outsideHours) notices.push(`<div class="route-simulator-notice is-late"><span aria-hidden="true">!</span><p><strong>${result.metrics.outsideStops} ${result.metrics.outsideStops === 1 ? "parada queda" : "paradas quedan"} fuera de horario</strong>${result.metrics.totalOutside ? `La visita acumula ${result.metrics.totalOutside} minutos fuera de su ventana de apertura.` : "No se ha encontrado un orden que encaje en todas las ventanas de apertura."}</p></div>`);
    const brokenDepartures = brokenDepartureLegs(result, departureLegs);
    if (departureLegs.length) {
        const list = departureLegs
            .map((leg) => `${leg.fromName} → ${leg.toName}${leg.departureTime ? ` (sale ${leg.departureTime})` : ""}`)
            .join("; ");
        notices.push(`<div class="route-simulator-notice${brokenDepartures.length ? " is-warning" : ""}"><span aria-hidden="true">◷</span><p><strong>${departureLegs.length} ${departureLegs.length === 1 ? "tramo con hora de salida fija" : "tramos con hora de salida fija"}</strong>${brokenDepartures.length
            ? `No se ha podido conservar ${esc(brokenDepartures.map((leg) => `${leg.fromName} → ${leg.toName}`).join("; "))} en su posición original, porque choca con una parada que has fijado a mano. La simulación no reprograma un transporte con horario: revisa ese orden antes de fiarte de él.`
            : `${esc(list)}. La simulación no reprograma un transporte con horario, así que esas paradas conservan su posición y el ahorro se busca en el resto del día.`}</p></div>`);
    }
    const brokenVisited = brokenVisitedStops(result, visitedStops);
    if (visitedStops.length) {
        const names = visitedStops.map((stop) => stop.name).join(", ");
        notices.push(`<div class="route-simulator-notice${brokenVisited.length ? " is-warning" : ""}"><span aria-hidden="true">✓</span><p><strong>${visitedStops.length} ${visitedStops.length === 1 ? "parada ya visitada" : "paradas ya visitadas"}</strong>${brokenVisited.length
            ? `No se ha podido conservar ${esc(brokenVisited.map((stop) => stop.name).join(", "))} en su posición original, porque choca con una parada que has fijado a mano. Revisa ese orden: la simulación no puede deshacer una visita que ya has hecho.`
            : `${esc(names)} ${visitedStops.length === 1 ? "conserva su posición" : "conservan su posición"}: la simulación no reordena lo que ya has hecho y busca el ahorro en el resto del día.`}</p></div>`);
    }
    if (delayed) notices.push(`<div class="route-simulator-notice is-late"><span aria-hidden="true">!</span><p><strong>${result.metrics.lateStops} ${result.metrics.lateStops === 1 ? "cita queda" : "citas quedan"} con retraso</strong>El mejor orden encontrado acumula ${result.metrics.totalLate} minutos de retraso.</p></div>`);
    const fixedPositions = new Set(fixedSpotIndexes);
    const fixedSummary = [
        firstSpotIndex !== null ? `Salida fijada en ${result.steps[0].spot.name || "la primera parada"}.` : "",
        lastSpotIndex !== null ? `Llegada fijada en ${result.steps.at(-1).spot.name || "la última parada"}.` : "",
        ...fixedSpotIndexes.map((spotIndex) => `${resultSpotName(result, spotIndex)} se mantiene en la posición ${spotIndex + 1}.`),
    ].filter(Boolean).join(" ");
    const moved = movedFlags(result, baseline);
    const steps = result.steps.map((step, index) => {
        const appointment = step.repeated
            ? '<span class="route-simulator-time-pill is-fixed">Regreso</span>'
            : step.planned === null ? "" : `<span class="route-simulator-time-pill${step.late ? " is-late" : ""}">${step.late ? `+${step.late} min` : `Cita ${formatSimulationTime(step.planned)}`}</span>`;
        const fixedPosition = fixedPositions.has(step.spotIndex)
            ? `<span class="route-simulator-time-pill is-fixed">Posición ${step.spotIndex + 1} fijada</span>`
            : "";
        // The proposal is no longer listed twice, so the badge that used to live
        // on the duplicate "Ahora" card rides on the step itself.
        const movedPill = moved[index] ? '<span class="route-simulator-time-pill is-moved">↕ Cambia</span>' : "";
        const hours = step.repeated || !step.schedule
            ? ""
            : `<span class="route-simulator-time-pill is-hours${step.outsideSchedule ? " is-late" : ""}">${esc(scheduleLabel(step.spot))}</span>`;
        const previous = result.steps[index - 1];
        // Un retoque manual vale en ambos sentidos, así que se busca por la
        // clave sin sentido. Que el tramo venga del plan solo es cierto en el
        // sentido que el plan recorre: al revés, el minutaje es el medido.
        const manual = Boolean(previous) && manualLegs.has(simulatorLegKey(previous.spotIndex, step.spotIndex));
        const established = !manual && Boolean(previous)
            && establishedLegs.has(directedLegKey(previous.spotIndex, step.spotIndex));
        const departure = previous
            ? departureLegs.find((leg) => directedLegKey(leg.fromIndex, leg.toIndex) === directedLegKey(previous.spotIndex, step.spotIndex))
            : null;
        const origin = departure
            ? ` · sale ${departure.departureTime || "a hora fija"}`
            : manual ? " · manual" : established ? " · del plan" : "";
        const travel = index === 0 ? "" : `<div class="route-simulator-leg${manual ? " is-manual" : ""}${established && !departure ? " is-established" : ""}${departure ? " is-departure" : ""}"><i aria-hidden="true"></i><label><span>Trayecto ${esc(previous.spot.name || "Parada")} → ${esc(step.spot.name || "Parada")}${origin}</span><b><input type="number" min="0" max="1440" step="1" inputmode="numeric" value="${step.travel}" data-simulator-leg-from="${previous.spotIndex}" data-simulator-leg-to="${step.spotIndex}" aria-label="Minutos de trayecto de ${esc(previous.spot.name || "la parada anterior")} a ${esc(step.spot.name || "la parada siguiente")}" /> min</b></label></div>`;
        const secondary = [
            step.wait ? `${step.wait} min de espera` : "",
            step.outsideSchedule ? `${step.outsideMinutes ? `${step.outsideMinutes} ${step.outsideMinutes === 1 ? "minuto" : "minutos"}` : "Visita"} fuera de horario` : "",
            step.repeated ? "Fin de la ruta" : `${step.duration} min en la parada`,
        ].filter(Boolean).join(" · ");
        return `${travel}<article class="route-simulator-step${moved[index] ? " is-moved" : ""}"><span class="route-simulator-step-number">${index + 1}</span><div><div class="route-simulator-step-heading"><strong>${esc(step.spot.name || "Parada sin nombre")}</strong><span class="route-simulator-time-pills">${hours}${movedPill}${fixedPosition}${appointment}</span></div><p><b>${esc(formatSimulationTime(step.start))}</b>–${esc(formatSimulationTime(step.finish))}<span>${esc(secondary)}</span></p></div></article>`;
    }).join("");
    const manualSummary = manualLegs.size
        ? `<div class="route-simulator-manual-summary"><span aria-hidden="true">✎</span><p><strong>${manualLegs.size} ${manualLegs.size === 1 ? "trayecto personalizado" : "trayectos personalizados"}</strong>Se aplican en ambos sentidos y solo durante esta simulación.</p><button type="button" data-simulator-reset-legs>Restaurar tiempos</button></div>`
        : "";
    const method = `${fixedSummary ? `${esc(fixedSummary)} ` : ""}${result.exact ? "Se han comparado todos los órdenes posibles." : "Se ha usado una búsqueda optimizada por el número de paradas."}`;
    const review = notices.length
        ? notices.join("")
        : '<div class="route-simulator-review-clear"><span aria-hidden="true">✓</span><p><strong>Sin avisos pendientes</strong>La propuesta respeta las citas, los horarios y las restricciones indicadas.</p></div>';
    const readOnlyDecision = '<div class="route-simulator-readonly-result"><span aria-hidden="true">◇</span><p><strong>Resultado de solo lectura</strong>Puedes consultar la propuesta, pero no aplicarla a este viaje.</p></div>';
    resultEl.innerHTML = `<div class="route-simulator-result-story">
        <section class="route-simulator-conclusion" aria-labelledby="routeSimulatorConclusionTitle">
            <div class="route-simulator-story-heading"><span>01</span><div><small>Resultado</small><h4 id="routeSimulatorConclusionTitle">¿Merece la pena cambiar?</h4></div></div>
            ${savingsMarkup(result, baseline)}
            ${metricsMarkup(result)}
        </section>
        <section class="route-simulator-evidence" aria-labelledby="routeSimulatorEvidenceTitle">
            <div class="route-simulator-story-heading"><span>02</span><div><small>Evidencia visual</small><h4 id="routeSimulatorEvidenceTitle">Qué cambia respecto a tu plan</h4></div></div>
            <div class="route-simulator-evidence-layout">
                ${routeMapMarkup(baseline, result)}
                ${beforeColumnMarkup(baseline, result)}
            </div>
        </section>
        <div class="route-simulator-proposal-layout">
            <section class="route-simulator-route-col is-after" aria-labelledby="routeSimulatorProposalTitle">
                <div class="route-simulator-story-heading"><span>03</span><div><small>Recorrido propuesto · ${result.metrics.travel} min de trayecto</small><h4 id="routeSimulatorProposalTitle">Así quedaría el día</h4></div></div>
                <p class="route-simulator-route-note">Los horarios se leen de arriba abajo. Puedes corregir los minutos de cualquier trayecto y la propuesta se recalculará al momento.</p>
                ${manualSummary}
                <div class="route-simulator-timeline">${steps}</div>
            </section>
            <aside class="route-simulator-review" aria-labelledby="routeSimulatorReviewTitle">
                <div class="route-simulator-story-heading"><span>04</span><div><small>Antes de decidir</small><h4 id="routeSimulatorReviewTitle">Lo que debes revisar</h4></div></div>
                <div class="route-simulator-review-list">${review}</div>
                <p class="route-simulator-method">${method}</p>
            </aside>
        </div>
        <section class="route-simulator-result-actions" aria-labelledby="routeSimulatorDecisionTitle">
            <div class="route-simulator-decision-copy">
                <div class="route-simulator-story-heading"><span>05</span><div><small>Decisión final</small><h4 id="routeSimulatorDecisionTitle">La propuesta aún no ha cambiado tu viaje</h4></div></div>
                <p>Al aplicarla se actualizarán el orden, el inicio del día y los primeros horarios calculados. Las paradas no seleccionadas conservarán su posición relativa.</p>
                <small>Los tiempos de trayecto editados aquí son hipótesis y no se guardarán. Podrás deshacer el cambio como una sola acción.</small>
            </div>
            ${store.readOnly ? readOnlyDecision : '<button class="route-simulator-apply" type="button" data-simulator-apply><span aria-hidden="true">✓</span><span><strong>Aplicar simulación</strong><small>Revisar y confirmar cambios</small></span></button>'}
        </section>
    </div>`;
    resultEl.scrollTop = preserveScroll ? previousScroll : 0;
    unmountRouteMap = mountRouteMap(resultEl, baseline, result);
    // renderResult runs again on every edited leg. Announcing the whole panel
    // each time buried the change, so only this one-line summary is live.
    statusEl.textContent = `Ruta recalculada: ${result.steps.length} paradas, de ${formatSimulationTime(result.start)} a ${formatSimulationTime(result.finish)}, ${result.metrics.travel} minutos de trayecto.`;
}

function recalculateActiveSimulation({ preserveScroll = true } = {}) {
    if (!activeSimulation) return;
    const {
        spots,
        travelMinutes,
        fixedStart,
        firstSpotIndex,
        lastSpotIndex,
        fixedSpotIndexes,
        approximate,
        missingDurations,
        manualLegs,
        establishedLegs,
        departureLegs,
        visitedStops,
        baseline,
    } = activeSimulation;
    // The optimizer sees one set of locked positions; the result summary keeps
    // listing only the ones the traveller asked for, because the rest are the
    // simulator protecting a timetable it cannot reschedule and a past it cannot
    // undo.
    const lockedByDeparture = departureLegs.flatMap((leg) => [leg.fromIndex, leg.toIndex]);
    const lockedByVisit = visitedStops.map((stop) => stop.spotIndex);
    const result = optimizeRoute(spots, travelMinutes, {
        fixedStart,
        firstSpotIndex,
        lastSpotIndex,
        fixedSpotIndexes: [...new Set([...fixedSpotIndexes, ...lockedByDeparture, ...lockedByVisit])],
    });
    activeSimulation.result = result;
    renderResult(result, {
        approximate,
        missingDurations,
        firstSpotIndex,
        lastSpotIndex,
        fixedSpotIndexes,
        baseline,
        manualLegs,
        establishedLegs,
        departureLegs,
        visitedStops,
        preserveScroll,
    });
}

$("#routeSimulatorOpenBtn").addEventListener("click", () => {
    initializeDialog();
    openModal(dialog);
});
$("#routeSimulatorEdit").addEventListener("click", () => setPhase("setup"));
backToResultButton.addEventListener("click", () => setPhase("result"));
daySelect.addEventListener("change", () => {
    const day = currentDay();
    activeSimulatorSpotId = null;
    const hasStart = timeToMinutes(day?.startTime) !== null;
    $("#routeSimulatorFixedStart").checked = hasStart;
    $("#routeSimulatorStart").disabled = !hasStart;
    $("#routeSimulatorStart").value = hasStart ? day.startTime : "09:00";
    renderSpots();
});
$("#routeSimulatorFixedStart").addEventListener("change", (event) => {
    $("#routeSimulatorStart").disabled = !event.target.checked;
});
spotsEl.addEventListener("change", (event) => {
    if (event.target.matches("[data-simulator-spot]")) activeSimulatorSpotId = event.target.value;
    if (event.target.matches("[data-simulator-position]")) enforceUniquePosition(event.target);
    selectionCount();
    syncSpotControls();
});
spotsEl.addEventListener("click", (event) => {
    const editButton = event.target.closest?.("[data-simulator-edit]");
    if (!editButton) return;
    renderSpotEditor(editButton.dataset.simulatorEdit);
    if (matchMedia("(max-width: 760px)").matches) {
        const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
        requestAnimationFrame(() => spotEditorEl.scrollIntoView({ behavior, block: "start" }));
    }
});
spotEditorEl.addEventListener("change", (event) => {
    if (!activeSimulatorSpotId) return;
    const row = spotsEl.querySelector(`[data-simulator-row="${CSS.escape(activeSimulatorSpotId)}"]`);
    if (event.target.matches("[data-simulator-editor-time]")) {
        const control = row?.querySelector("[data-simulator-time]");
        if (control) control.value = event.target.value;
        return;
    }
    if (!event.target.matches('[name="routeSimulatorEditorPosition"]')) return;
    const control = row?.querySelector("[data-simulator-position]");
    if (!control) return;
    control.value = event.target.value;
    enforceUniquePosition(control);
});
$("#routeSimulatorSelectAll").addEventListener("click", () => {
    spotsEl.querySelectorAll("[data-simulator-spot]:not(:disabled)").forEach((input) => { input.checked = true; });
    selectionCount();
    syncSpotControls();
});
$("#routeSimulatorSelectNone").addEventListener("click", () => {
    spotsEl.querySelectorAll("[data-simulator-spot]").forEach((input) => { input.checked = false; });
    selectionCount();
    syncSpotControls();
});

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selection = simulationSelection();
    const { day, spots, sourceSpots, firstSpotIndex, lastSpotIndex, fixedSpotIndexes } = selection;
    const errorEl = $("#routeSimulatorError");
    errorEl.textContent = "";
    if (spots.length < 2) {
        errorEl.textContent = "Selecciona al menos dos paradas con ubicación para calcular una ruta.";
        return;
    }
    if (firstSpotIndex !== null && firstSpotIndex !== 0 && fixedSpotIndexes.includes(0)) {
        errorEl.textContent = "Hay dos paradas fijadas en la primera posición. Deja una de ellas como Libre.";
        return;
    }
    if (lastSpotIndex !== null && lastSpotIndex !== spots.length - 1 && fixedSpotIndexes.includes(spots.length - 1)) {
        errorEl.textContent = "Hay dos paradas fijadas en la última posición. Deja una de ellas como Libre.";
        return;
    }
    const fixed = $("#routeSimulatorFixedStart").checked;
    const fixedStart = fixed ? timeToMinutes($("#routeSimulatorStart").value) : null;
    if (fixed && fixedStart === null) {
        errorEl.textContent = "Indica una hora de inicio válida o desactiva la hora fija.";
        return;
    }
    const token = ++calculationToken;
    const dayFingerprint = simulationDayFingerprint(day);
    runButton.disabled = true;
    runButton.classList.add("is-loading");
    runButton.querySelector("strong").textContent = "Calculando rutas…";
    // The spinner belongs where the answer will be, so the panel takes the
    // width now rather than after the network settles.
    updateSummary();
    setPhase("result");
    unmountRouteMap?.();
    unmountRouteMap = null;
    resultEl.innerHTML = '<div class="route-simulator-loading"><span aria-hidden="true"></span><strong>Midiendo trayectos y comparando órdenes</strong><p>Las aperturas, cierres y citas tienen prioridad sobre el ahorro de tiempo.</p></div>';
    statusEl.textContent = "Calculando la mejor ruta…";
    const profile = ["walking", "driving", "cycling"].includes(store.routeProfile) ? store.routeProfile : "walking";
    // Warm the same route cache the planner reads before projecting the
    // established day, so "Antes" shows the hours the itinerary already shows
    // instead of a distance estimate.
    await Promise.all([...travelProfilesForSpots(sourceSpots)]
        .map((mode) => ensureRouteTravelTimes(sourceSpots, mode)));
    const matrix = await fetchTravelMatrix(spots, profile);
    if (token !== calculationToken) return;
    const travelMinutes = matrix.minutes.map((row) => [...row]);
    // Pinned once: the comparison reference must not drift when the traveller
    // edits a leg to explore a what-if.
    const baseline = establishedBaseline(day, sourceSpots, { profile, travelForLeg: resolveTravelForLeg });
    const establishedLegs = seedEstablishedLegs(travelMinutes, baseline);
    const departureLegs = departureLockedLegs(baseline);
    const visitedStops = visitedLockedStops(baseline);
    const missingDurations = spots.filter((spot) => !isWaypoint(spot) && !(Number.isInteger(spot.visitMinutes) && spot.visitMinutes > 0)).map((spot) => spot.name || "Parada sin nombre");
    activeSimulation = {
        dayId: day.id,
        dayFingerprint,
        selectedSpotIds: sourceSpots.map((spot) => String(spot.id)),
        spots,
        travelMinutes,
        originalTravelMinutes: travelMinutes.map((row) => [...row]),
        fixedStart,
        firstSpotIndex,
        lastSpotIndex,
        fixedSpotIndexes,
        approximate: matrix.approximate,
        missingDurations,
        manualLegs: new Map(),
        establishedLegs,
        departureLegs,
        visitedStops,
        baseline,
    };
    recalculateActiveSimulation({ preserveScroll: false });
    resetRunButton();
});

function applicationPreview(simulation) {
    const beforeIds = simulation.selectedSpotIds;
    const uniqueSteps = simulation.result.steps.filter((step, index, steps) =>
        steps.findIndex((candidate) => String(candidate.spot.id) === String(step.spot.id)) === index);
    const afterIds = uniqueSteps.map((step) => String(step.spot.id));
    const moved = afterIds.filter((id, index) => id !== beforeIds[index]).length;
    return {
        stats: [
            { value: afterIds.length, label: "paradas", tone: "modify" },
            { value: moved, label: "cambian de sitio", tone: "modify" },
            { value: formatSimulationTime(simulation.result.start), label: "inicio del día", tone: "modify" },
        ],
        groups: [
            {
                tone: "modify",
                title: "Orden y horarios del día",
                detail: "Se aplicarán el orden propuesto, la hora de inicio del día y el primer inicio calculado de cada parada seleccionada.",
            },
            {
                tone: "modify",
                title: "Paradas no seleccionadas",
                detail: "Conservarán su hueco, sus datos y su posición relativa en el itinerario.",
            },
            {
                tone: "remove",
                title: "Hipótesis de trayecto",
                detail: "Los minutos editados dentro del simulador no se guardarán en el plan.",
            },
        ],
    };
}

async function applyActiveSimulation() {
    const simulation = activeSimulation;
    if (!simulation?.result || store.readOnly) return;
    const confirmed = await confirmAction({
        title: "Aplicar esta simulación",
        message: "Se cambiarán el orden y los horarios del día. Podrás deshacerlo como una sola acción. Si quieres una copia del estado actual, expórtala antes de aplicar.",
        confirmLabel: "Aplicar cambios",
        preview: applicationPreview(simulation),
        secondaryLabel: "Exportar copia",
        onSecondary: downloadPlanExport,
    });
    if (!confirmed) return;
    const liveDay = store.state.find((day) => String(day.id) === String(simulation.dayId));
    if (simulation !== activeSimulation || simulationDayFingerprint(liveDay) !== simulation.dayFingerprint) {
        toast("El día cambió desde la simulación. Vuelve a calcular la ruta antes de aplicarla.", "error");
        return;
    }
    try {
        const committed = await derivedPlanOperation((document) => {
            const day = document.days.find((candidate) => String(candidate.id) === String(simulation.dayId));
            if (simulationDayFingerprint(day) !== simulation.dayFingerprint) {
                throw new Error("SIMULATION_RESULT_STALE");
            }
            const appliedDay = applySimulationToDay(day, simulation.selectedSpotIds, simulation.result);
            return replacePlanIntent(document, {
                ...document,
                days: document.days.map((candidate) => candidate === day ? appliedDay : candidate),
            });
        });
        if (committed?.skipped) {
            toast("Este viaje es de solo lectura y no se puede modificar.", "error");
            return;
        }
        dialog.close();
        toast("Simulación aplicada. Puedes deshacer el cambio desde el historial.", "success");
    } catch (error) {
        const stale = error?.message === "SIMULATION_RESULT_STALE"
            || error?.code === "REVISION_CONFLICT"
            || error?.code === "TARGET_CONFLICT";
        if (!stale) console.warn("No se pudo aplicar la simulación.", error);
        toast(stale
            ? "El itinerario cambió. Vuelve a calcular la ruta antes de aplicarla."
            : "No se pudo aplicar la simulación. El itinerario no se ha modificado.", "error");
    }
}

function applyManualLeg(input) {
    if (!input || !activeSimulation) return;
    // Number("") es 0 y pasa Number.isInteger: vaciar el campo fijaba el tramo en
    // cero minutos sin decir nada. Un number input tambien vacia su value cuando
    // lo escrito no es un numero, asi que este es el mismo caso.
    const raw = input.value.trim();
    const minutes = Number(raw);
    if (raw === "" || !Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
        input.setCustomValidity("Introduce un número entero entre 0 y 1440 minutos.");
        input.reportValidity();
        input.setAttribute("aria-invalid", "true");
        return;
    }
    input.setCustomValidity("");
    input.removeAttribute("aria-invalid");
    const from = Number(input.dataset.simulatorLegFrom);
    const to = Number(input.dataset.simulatorLegTo);
    activeSimulation.travelMinutes[from][to] = minutes;
    activeSimulation.travelMinutes[to][from] = minutes;
    activeSimulation.manualLegs.set(simulatorLegKey(from, to), minutes);
    recalculateActiveSimulation();
}

resultEl.addEventListener("change", (event) => {
    const input = event.target.closest?.("[data-simulator-leg-from][data-simulator-leg-to]");
    applyManualLeg(input);
});

resultEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !event.target.matches?.("[data-simulator-leg-from]")) return;
    event.preventDefault();
    applyManualLeg(event.target);
});

resultEl.addEventListener("click", (event) => {
    if (event.target.closest?.("[data-simulator-apply]")) {
        void applyActiveSimulation();
        return;
    }
    if (!event.target.closest?.("[data-simulator-reset-legs]") || !activeSimulation) return;
    activeSimulation.travelMinutes = activeSimulation.originalTravelMinutes.map((row) => [...row]);
    activeSimulation.manualLegs.clear();
    recalculateActiveSimulation();
});

dialog.addEventListener("close", () => {
    calculationToken += 1;
    activeSimulation = null;
    unmountRouteMap?.();
    unmountRouteMap = null;
});
