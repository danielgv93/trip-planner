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
    brokenStopChains,
    brokenVisitedStops,
    directedLegKey,
    departureLockedLegs,
    linkedStopChains,
    seedEstablishedLegs,
    simulatorLegKey,
    visitedLockedStops,
} from "./legs.js";
import { formatSimulationTime, isReservationSpot, optimizeRoute, simulateOrder } from "./optimizer.js";
import { optimizeWithOptionalStops } from "./optional-stops.js";
import { mountRouteMap, routeMapMarkup } from "./route-map.js";
import { reorderDiff } from "./reorder.js";
import { moveImpacts } from "./move-impact.js";
import { mountReorderDiagram, reorderDiagramMarkup } from "./reorder-diagram.js";
import {
    applySimulationToDay,
    backlogCopiesOfDropped,
    lateReservations,
    overnightAppointments,
    simulationDayFingerprint,
} from "./application.js";

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
const fromNowRow = $("#routeSimulatorFromNowRow");
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

function localDateKey(now = new Date()) {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function currentMinutes(now = new Date()) {
    return now.getHours() * 60 + now.getMinutes();
}

// Only a day that is happening today can be planned "from now". On any other
// day the option would mean nothing, so it is not offered.
function syncFromNow(day) {
    const today = day?.date === localDateKey();
    fromNowRow.hidden = !today;
    // Opt-in: re-checking today's plan at 18:00 must not silently become a
    // plan for the evening.
    $("#routeSimulatorFromNow").checked = false;
    $("#routeSimulatorFromNowHint").textContent = today
        ? `Ahora son las ${formatSimulationTime(currentMinutes())}. Nada pendiente empezará antes.`
        : "";
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
    // A booking is a fact of the itinerary, not a what-if: applying keeps its
    // stored hour, so letting the dialog move it would simulate a day that
    // can never be applied.
    const reservation = isReservationSpot(spot);
    spotEditorEl.innerHTML = `<div class="route-simulator-section-title"><span>03</span><div><strong>Ajusta una parada</strong><small>Solo dentro de esta simulación.</small></div></div>
        <div class="route-simulator-editor-heading"><span>Parada seleccionada</span><h4>${esc(spot.name || "Parada sin nombre")}</h4><p>${esc(spotTimingLabel(spot))}</p></div>
        <div class="route-simulator-editor-fields${selected ? "" : " is-disabled"}">
            <label class="route-simulator-editor-time"><span>${reservation ? "Reserva con hora fija" : "Inicio planificado"}</span><input type="time" data-simulator-editor-time value="${esc(timeControl.value)}"${selected && !reservation ? "" : " disabled"} /></label>
            ${reservation ? "<p>La hora de una reserva solo se cambia desde el itinerario. La simulación la respeta como prioridad máxima.</p>" : ""}
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
                <span class="route-simulator-spot-copy"><strong>${esc(name)}${spot.optional === true ? '<span class="route-simulator-optional-tag">Opcional</span>' : ""}</strong><small class="${warning ? "is-warning" : ""}">${esc(spotTimingLabel(spot))}</small></span>
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
    // The limit and the optional-stop rule are what-ifs for one sitting, not
    // preferences: a limit typed for yesterday's day must not judge today's.
    $("#routeSimulatorLimitEnd").checked = false;
    $("#routeSimulatorEnd").disabled = true;
    $("#routeSimulatorEnd").value = "21:00";
    $("#routeSimulatorAllowDrop").checked = true;
    syncFromNow(day);
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

// The headline claims time, so it must measure the time the traveller spends:
// the whole day, from the first departure to the last stop. Travel minutes are
// only one ingredient of it — announcing a saving from them alone contradicts a
// day that ends later.
function savingsMarkup(result, baseline, { droppedNames = [], latestFinish = null, notBefore = null } = {}) {
    const travelSaved = baseline.metrics.travel - result.metrics.travel;
    const elapsedBefore = baseline.finish - baseline.start;
    const elapsedNow = result.finish - result.start;
    // Planned from now, the proposal starts hours after the stored day did,
    // so their lengths are not comparable: a 14:00 restart always looks
    // "shorter" than a day that began at 09:00. What still compares is when
    // each one ends.
    const fromNow = Number.isInteger(notBefore);
    const elapsedSaved = fromNow ? baseline.finish - result.finish : elapsedBefore - elapsedNow;
    const latenessSaved = baseline.metrics.totalLate - result.metrics.totalLate;
    const scheduleConflictsSaved = baseline.metrics.scheduleConflictStops - result.metrics.scheduleConflictStops;
    // The optimizer ranks bookings above everything else, so the verdict must
    // too: rescuing one is an improvement even if the day grows or an
    // estimate slips.
    const reservationsSaved = baseline.metrics.reservationLateStops - result.metrics.reservationLateStops;
    // "Antes" is the stored day and knows nothing of the limit the dialog
    // set, so its overtime is measured here against the same hour.
    const overtimeBefore = Number.isInteger(latestFinish) ? Math.max(0, baseline.finish - latestFinish) : 0;
    const overtimeSaved = overtimeBefore - result.metrics.overtime;
    const state = elapsedSaved > 0 ? "saving" : elapsedSaved < 0 ? "cost" : "same";
    const headline = fromNow
        ? elapsedSaved > 0 ? `Termina ${elapsedSaved} min antes`
            : elapsedSaved < 0 ? `Termina ${Math.abs(elapsedSaved)} min más tarde` : "Termina a la misma hora"
        : elapsedSaved > 0 ? `${elapsedSaved} min ahorrados`
            : elapsedSaved < 0 ? `${Math.abs(elapsedSaved)} min más de jornada` : "Misma duración de jornada";
    const reason = reservationsSaved > 0
        ? `Llega a tiempo a ${reservationsSaved} ${reservationsSaved === 1 ? "reserva" : "reservas"} que el itinerario actual no alcanza.`
        : overtimeSaved > 0
            ? result.metrics.overtime === 0
                ? `Termina dentro del límite de las ${formatSimulationTime(latestFinish)}.`
                : `Se pasa ${overtimeSaved} min menos del límite de las ${formatSimulationTime(latestFinish)}.`
        : elapsedSaved < 0 && scheduleConflictsSaved > 0
        ? `La propuesta alarga la jornada para evitar ${scheduleConflictsSaved} ${scheduleConflictsSaved === 1 ? "conflicto horario" : "conflictos horarios"}.`
        : elapsedSaved < 0 && latenessSaved > 0
            ? `La propuesta alarga la jornada para reducir el retraso acumulado en ${latenessSaved} min.`
        : scheduleConflictsSaved > 0 ? `Evita ${scheduleConflictsSaved} ${scheduleConflictsSaved === 1 ? "conflicto horario" : "conflictos horarios"}.`
            : latenessSaved > 0 ? `Reduce el retraso acumulado en ${latenessSaved} min.`
            : travelSaved > 0 ? `Reduce el tiempo de trayecto en ${travelSaved} min.`
            : travelSaved < 0 ? `Emplea ${Math.abs(travelSaved)} min más de trayecto.`
                : "El tiempo de trayecto no cambia.";
    // Part of any saving comes from not visiting something; say so instead of
    // presenting it as a better route.
    const detail = droppedNames.length
        ? `${reason} Deja fuera ${droppedNames.length === 1 ? "la parada opcional" : "las paradas opcionales"} ${droppedNames.join(", ")}.`
        : reason;
    const conclusion = reservationsSaved > 0 || overtimeSaved > 0 || scheduleConflictsSaved > 0 || latenessSaved > 0
        ? "Mejora el encaje del día"
        : elapsedSaved > 0 ? "La propuesta sí mejora la ruta"
            : elapsedSaved < 0 ? "La ruta actual sigue siendo más corta"
                : "No hay una mejora clara";
    return `<div class="route-simulator-savings is-${state}">
        <span class="route-simulator-verdict-mark" aria-hidden="true">${elapsedSaved > 0 ? "↓" : elapsedSaved < 0 ? "↑" : "="}</span>
        <div class="route-simulator-verdict-copy"><span>Conclusión</span><h4>${esc(conclusion)}</h4><strong>${esc(headline)}</strong><p>${esc(detail)}</p></div>
        ${fromNow
            ? `<div class="route-simulator-duration-shift" aria-label="Comparación de la hora de fin"><span>Itinerario actual termina <b>${esc(formatSimulationTime(baseline.finish))}</b></span><i aria-hidden="true">→</i><span>Propuesta termina <b>${esc(formatSimulationTime(result.finish))}</b></span></div>`
            : `<div class="route-simulator-duration-shift" aria-label="Comparación de la duración de la jornada"><span>Itinerario actual <b>${elapsedBefore} min</b></span><i aria-hidden="true">→</i><span>Propuesta <b>${elapsedNow} min</b></span></div>`}
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
    linkedChains = [],
    visitedStops,
    unsimulatedStops,
    blockedOvernight,
    droppedIndexes = [],
    droppableAlternative = [],
    latestFinish = null,
    notBefore = null,
    evaluateOrder = null,
    lockedIndexes = [],
    preserveScroll = false,
}) {
    unmountRouteMap?.();
    unmountRouteMap = null;
    const previousScroll = resultEl.scrollTop;
    // Late bookings get their own notice; this one counts only the estimates.
    const softLateStops = result.metrics.lateStops - result.metrics.reservationLateStops;
    const softLate = result.metrics.totalLate - result.metrics.totalReservationLate;
    const delayed = softLateStops > 0;
    const outsideHours = result.metrics.outsideStops > 0;
    const notices = [];
    const nameOf = (spotIndex) => baseline.steps.find((step) => step.spotIndex === spotIndex)?.spot.name || "Parada sin nombre";
    const droppedNames = droppedIndexes.map(nameOf);
    if (droppedNames.length) notices.push(`<div class="route-simulator-notice is-warning"><span aria-hidden="true">−</span><p><strong>${droppedNames.length === 1 ? "Se queda fuera 1 parada opcional" : `Se quedan fuera ${droppedNames.length} paradas opcionales`}</strong>${esc(droppedNames.join(", "))}. Con todas, el día no encaja. Al aplicar, ${droppedNames.length === 1 ? "pasará" : "pasarán"} al backlog: no se borra nada.<button type="button" data-simulator-keep-all>Mantener todas las paradas</button></p></div>`);
    if (droppableAlternative.length) {
        const names = droppableAlternative.map(nameOf);
        notices.push(`<div class="route-simulator-notice"><span aria-hidden="true">−</span><p><strong>El día encajaría mejor sin ${names.length === 1 ? "una parada opcional" : `${names.length} paradas opcionales`}</strong>Sin ${esc(names.join(", "))}, la propuesta resuelve conflictos que este orden no puede evitar.<button type="button" data-simulator-drop-optional>Dejar fuera ${esc(names.join(", "))}</button></p></div>`);
    }
    if (result.metrics.overtime > 0) notices.push(`<div class="route-simulator-notice is-late"><span aria-hidden="true">◷</span><p><strong>Termina ${result.metrics.overtime} min después del límite</strong>La propuesta acaba a las ${esc(formatSimulationTime(result.finish))} y el límite es a las ${esc(formatSimulationTime(latestFinish))}.${droppedNames.length || droppableAlternative.length ? "" : " Marca como opcionales las paradas prescindibles para que el simulador pueda dejarlas fuera."}</p></div>`);
    if (Number.isInteger(notBefore)) notices.push(`<div class="route-simulator-notice"><span aria-hidden="true">◴</span><p><strong>Planificada desde las ${esc(formatSimulationTime(notBefore))}</strong>Es hoy: ninguna parada pendiente empieza antes de la hora actual.</p></div>`);
    const lateBookings = lateReservations(result);
    if (lateBookings.length) notices.push(`<div class="route-simulator-notice is-late"><span aria-hidden="true">!</span><p><strong>${lateBookings.length} ${lateBookings.length === 1 ? "reserva no se alcanza" : "reservas no se alcanzan"} a tiempo</strong>${esc(lateBookings.map((step) => `${step.spot.name || "Parada sin nombre"} (+${step.late} min)`).join(", "))}. El mejor orden encontrado no llega a tiempo con las condiciones indicadas. Si aplicas la propuesta, la reserva conserva su hora y el itinerario mostrará el conflicto.</p></div>`);
    if (blockedOvernight.length) notices.push(`<div class="route-simulator-notice is-late"><span aria-hidden="true">☾</span><p><strong>La propuesta pasa de medianoche</strong>${esc(blockedOvernight.map((step) => step.spot.name || "Parada sin nombre").join(", "))} ${blockedOvernight.length === 1 ? "empezaría" : "empezarían"} al día siguiente, y esa hora no se puede guardar en este día. Ajusta la selección o la hora de salida para poder aplicarla.</p></div>`);
    if (unsimulatedStops.length) notices.push(`<div class="route-simulator-notice is-warning"><span aria-hidden="true">!</span><p><strong>${unsimulatedStops.length} ${unsimulatedStops.length === 1 ? "parada del día no entra" : "paradas del día no entran"} en el cálculo</strong>${esc(unsimulatedStops.join(", "))} ${unsimulatedStops.length === 1 ? "conserva" : "conservan"} su hueco en el itinerario, pero su visita y sus trayectos no se han contado. Al aplicar, el itinerario recalculará las horas con ${unsimulatedStops.length === 1 ? "ella" : "ellas"} y pueden quedar más tarde que en esta propuesta.</p></div>`);
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
    const brokenChains = brokenStopChains(result, linkedChains);
    if (linkedChains.length) {
        const list = linkedChains.map((chain) => chain.names.join(" → ")).join("; ");
        notices.push(`<div class="route-simulator-notice${brokenChains.length ? " is-warning" : ""}"><span aria-hidden="true">⇄</span><p><strong>${linkedChains.length} ${linkedChains.length === 1 ? "trayecto agrupado en una tarjeta" : "trayectos agrupados en una tarjeta"}</strong>${brokenChains.length
            ? `No se ha podido mantener juntas ${esc(brokenChains.map((chain) => chain.names.join(" → ")).join("; "))}, porque choca con una parada que has fijado a mano. Revisa ese orden antes de aplicarlo.`
            : `${esc(list)}. Esas paradas forman un solo trayecto: la simulación puede moverlas, pero siempre juntas y en el mismo orden.`}</p></div>`);
    }
    // A stop left out before a visited one moves it up one slot in the
    // proposal without breaking anything.
    const brokenVisited = brokenVisitedStops(result, visitedStops.map((stop) => ({
        ...stop,
        position: stop.position - droppedIndexes.filter((index) => index < stop.spotIndex).length,
    })));
    if (visitedStops.length) {
        const names = visitedStops.map((stop) => stop.name).join(", ");
        notices.push(`<div class="route-simulator-notice${brokenVisited.length ? " is-warning" : ""}"><span aria-hidden="true">✓</span><p><strong>${visitedStops.length} ${visitedStops.length === 1 ? "parada ya visitada" : "paradas ya visitadas"}</strong>${brokenVisited.length
            ? `No se ha podido conservar ${esc(brokenVisited.map((stop) => stop.name).join(", "))} en su posición original, porque choca con una parada que has fijado a mano. Revisa ese orden: la simulación no puede deshacer una visita que ya has hecho.`
            : `${esc(names)} ${visitedStops.length === 1 ? "conserva su posición" : "conservan su posición"}: la simulación no reordena lo que ya has hecho y busca el ahorro en el resto del día.`}</p></div>`);
    }
    if (delayed) notices.push(`<div class="route-simulator-notice is-late"><span aria-hidden="true">!</span><p><strong>${softLateStops} ${softLateStops === 1 ? "cita queda" : "citas quedan"} con retraso</strong>El mejor orden encontrado acumula ${softLate} minutos de retraso.</p></div>`);
    const fixedPositions = new Set(fixedSpotIndexes);
    const fixedSummary = [
        firstSpotIndex !== null ? `Salida fijada en ${result.steps[0].spot.name || "la primera parada"}.` : "",
        lastSpotIndex !== null ? `Llegada fijada en ${result.steps.at(-1).spot.name || "la última parada"}.` : "",
        ...fixedSpotIndexes.map((spotIndex) => `${resultSpotName(result, spotIndex)} se mantiene en la posición ${result.steps.findIndex((step) => step.spotIndex === spotIndex) + 1}.`),
    ].filter(Boolean).join(" ");
    // Appointments and pinned positions win ties: when two stops swap, the
    // one that could not have moved reads as the one that stayed.
    const anchoredIndexes = new Set([firstSpotIndex, lastSpotIndex, ...fixedSpotIndexes]
        .filter((index) => index !== null));
    const isAnchored = (step) => anchoredIndexes.has(step.spotIndex) || (step.planned !== null && step.planned !== undefined);
    const anchoredSpots = new Set(result.steps.filter(isAnchored).map((step) => step.spotIndex));
    const diff = reorderDiff(baseline.steps, result.steps, { anchored: (spotIndex) => anchoredSpots.has(spotIndex) });
    const impacts = evaluateOrder
        ? moveImpacts(diff, { evaluate: evaluateOrder, lockedIndexes, chains: linkedChains.map((chain) => chain.indexes), fromNow: Number.isInteger(notBefore) })
        : undefined;
    const steps = result.steps.map((step, index) => {
        const appointment = step.repeated
            ? '<span class="route-simulator-time-pill is-fixed">Regreso</span>'
            : step.planned === null ? "" : `<span class="route-simulator-time-pill${step.late ? " is-late" : ""}">${step.late ? `+${step.late} min` : `Cita ${formatSimulationTime(step.planned)}`}</span>`;
        const fixedPosition = fixedPositions.has(step.spotIndex) && !step.repeated
            ? `<span class="route-simulator-time-pill is-fixed">Posición ${index + 1} fijada</span>`
            : "";
        // Only stops that really moved carry the badge, with where they came
        // from; the ones merely shifted by a move keep their order and stay quiet.
        const shift = diff.after[index];
        const movedPill = shift.status === "moved"
            ? `<span class="route-simulator-time-pill is-moved">${shift.from > shift.to ? "↑" : "↓"} era ${shift.from + 1}.ª</span>`
            : "";
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
        return `${travel}<article class="route-simulator-step${shift.status === "moved" ? " is-moved" : ""}"><span class="route-simulator-step-number">${index + 1}</span><div><div class="route-simulator-step-heading"><strong>${esc(step.spot.name || "Parada sin nombre")}</strong><span class="route-simulator-time-pills">${hours}${movedPill}${fixedPosition}${appointment}</span></div><p><b>${esc(formatSimulationTime(step.start))}</b>–${esc(formatSimulationTime(step.finish))}<span>${esc(secondary)}</span></p></div></article>`;
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
            ${savingsMarkup(result, baseline, { droppedNames, latestFinish, notBefore })}
            ${metricsMarkup(result)}
        </section>
        <section class="route-simulator-evidence" aria-labelledby="routeSimulatorEvidenceTitle">
            <div class="route-simulator-story-heading"><span>02</span><div><small>Evidencia visual</small><h4 id="routeSimulatorEvidenceTitle">Qué cambia respecto a tu plan</h4></div></div>
            <div class="route-simulator-evidence-layout">
                ${reorderDiagramMarkup(baseline, result, diff, { isAnchored, impacts, fromNow: Number.isInteger(notBefore) })}
                ${routeMapMarkup(baseline, result)}
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
                <p>Al aplicarla se actualizarán el orden y el inicio del día. Solo las paradas con hora indicada guardan la hora calculada; las reservas conservan la suya y el itinerario recalculará las demás con sus propios trayectos, así que pueden variar algunos minutos respecto a esta propuesta. Las paradas no seleccionadas conservarán su posición relativa.</p>
                <small>Los tiempos de trayecto editados aquí son hipótesis y no se guardarán. Podrás deshacer el cambio como una sola acción.</small>
            </div>
            ${store.readOnly ? readOnlyDecision : `<button class="route-simulator-apply" type="button" data-simulator-apply${blockedOvernight.length ? " disabled" : ""}><span aria-hidden="true">✓</span><span><strong>Aplicar simulación</strong><small>${blockedOvernight.length ? "No aplicable: pasa de medianoche" : "Revisar y confirmar cambios"}</small></span></button>`}
        </section>
    </div>`;
    resultEl.scrollTop = preserveScroll ? previousScroll : 0;
    unmountRouteMap = mountRouteMap(resultEl, baseline, result);
    mountReorderDiagram(resultEl);
    // renderResult runs again on every edited leg. Announcing the whole panel
    // each time buried the change, so only this one-line summary is live.
    statusEl.textContent = `Ruta recalculada: ${result.steps.length} paradas, de ${formatSimulationTime(result.start)} a ${formatSimulationTime(result.finish)}, ${result.metrics.travel} minutos de trayecto.`;
}

// Indexes the optimizer may leave out: optional stops the traveller has not
// pinned, already visited or tied to a timetable.
// A stop that sits, in the stored day, before a stop locked to its position
// can never leave: the locked stop would slide one slot earlier.
function droppableOptionalIndexes(spots, day, { firstSpotIndex, lastSpotIndex, lockedIndexes }) {
    const locked = new Set(lockedIndexes);
    const dayIndex = new Map((day?.spots || []).map((spot, index) => [String(spot.id), index]));
    const lastLocked = (day?.spots || []).reduce((latest, spot, index) =>
        spotPositionConstraint(spot) === "locked" ? index : latest, -1);
    return spots.flatMap((spot, index) => spot.optional === true
        && index !== firstSpotIndex
        && index !== lastSpotIndex
        && !locked.has(index)
        && (dayIndex.get(String(spot.id)) ?? -1) > lastLocked
        ? [index]
        : []);
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
        departureLegs,
        linkedChains,
        visitedStops,
        latestFinish,
        notBefore,
        allowDrop,
    } = activeSimulation;
    // The optimizer sees one set of locked positions; the result summary keeps
    // listing only the ones the traveller asked for, because the rest are the
    // simulator protecting a timetable it cannot reschedule and a past it cannot
    // undo.
    const lockedByDeparture = departureLegs.flatMap((leg) => [leg.fromIndex, leg.toIndex]);
    const lockedByVisit = visitedStops.map((stop) => stop.spotIndex);
    const options = {
        fixedStart,
        firstSpotIndex,
        lastSpotIndex,
        fixedSpotIndexes: [...new Set([...fixedSpotIndexes, ...lockedByDeparture, ...lockedByVisit])],
        chains: linkedChains.map((chain) => chain.indexes),
        latestFinish,
        notBefore,
        pastSpotIndexes: lockedByVisit,
    };
    activeSimulation.optimizerOptions = options;
    const droppable = allowDrop
        ? droppableOptionalIndexes(spots, store.state.find((day) => String(day.id) === String(activeSimulation.dayId)), {
            firstSpotIndex,
            lastSpotIndex,
            // Leaving out one end of a travel card would split it.
            lockedIndexes: [...fixedSpotIndexes, ...lockedByDeparture, ...lockedByVisit, ...linkedChains.flatMap((chain) => chain.indexes)],
        })
        : [];
    if (droppable.length) {
        activeSimulation.outcome = optimizeWithOptionalStops(spots, travelMinutes, options, droppable);
    } else {
        const result = optimizeRoute(spots, travelMinutes, options);
        activeSimulation.outcome = { result, full: result, dropped: [] };
    }
    renderActiveSimulation({ preserveScroll });
}

// Switching between "leave the optional stops out" and "keep them all" only
// changes which of the two computed answers is shown and applied.
function renderActiveSimulation({ preserveScroll = true } = {}) {
    const simulation = activeSimulation;
    if (!simulation?.outcome) return;
    const { outcome, spots } = simulation;
    const showingFull = simulation.keepAll || !outcome.dropped.length;
    const result = showingFull ? outcome.full : outcome.result;
    const droppedIndexes = showingFull ? [] : outcome.dropped;
    simulation.result = result;
    simulation.droppedSpotIds = droppedIndexes.map((index) => String(spots[index].id));
    renderResult(result, {
        approximate: simulation.approximate,
        missingDurations: simulation.missingDurations,
        firstSpotIndex: simulation.firstSpotIndex,
        lastSpotIndex: simulation.lastSpotIndex,
        fixedSpotIndexes: simulation.fixedSpotIndexes,
        baseline: simulation.baseline,
        manualLegs: simulation.manualLegs,
        establishedLegs: simulation.establishedLegs,
        departureLegs: simulation.departureLegs,
        linkedChains: simulation.linkedChains,
        visitedStops: simulation.visitedStops,
        unsimulatedStops: simulation.unsimulatedStops,
        blockedOvernight: overnightAppointments(result),
        droppedIndexes,
        droppableAlternative: showingFull ? outcome.dropped : [],
        latestFinish: simulation.latestFinish,
        notBefore: simulation.notBefore,
        // Each move is priced by undoing it under the very legs and conditions
        // the optimizer just used, edited legs included.
        evaluateOrder: (order) => simulateOrder(simulation.spots, order, simulation.travelMinutes, simulation.optimizerOptions),
        lockedIndexes: [
            simulation.optimizerOptions.firstSpotIndex,
            simulation.optimizerOptions.lastSpotIndex,
            ...simulation.optimizerOptions.fixedSpotIndexes,
        ].filter(Number.isInteger),
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
    syncFromNow(day);
    renderSpots();
});
$("#routeSimulatorFixedStart").addEventListener("change", (event) => {
    $("#routeSimulatorStart").disabled = !event.target.checked;
});
$("#routeSimulatorLimitEnd").addEventListener("change", (event) => {
    $("#routeSimulatorEnd").disabled = !event.target.checked;
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
    const limited = $("#routeSimulatorLimitEnd").checked;
    const latestFinish = limited ? timeToMinutes($("#routeSimulatorEnd").value) : null;
    if (limited && latestFinish === null) {
        errorEl.textContent = "Indica una hora límite válida o desactiva el límite.";
        return;
    }
    if (latestFinish !== null && fixedStart !== null && latestFinish <= fixedStart) {
        errorEl.textContent = "La hora límite debe ser posterior a la hora de salida.";
        return;
    }
    const notBefore = !fromNowRow.hidden && $("#routeSimulatorFromNow").checked ? currentMinutes() : null;
    if (notBefore !== null && fixedStart !== null && fixedStart < notBefore) {
        errorEl.textContent = "La hora de salida fija ya ha pasado. Desactívala o desactiva «Planificar desde ahora».";
        return;
    }
    if (notBefore !== null && latestFinish !== null && latestFinish <= notBefore) {
        errorEl.textContent = "La hora límite ya ha pasado. Indica una posterior a la hora actual.";
        return;
    }
    const allowDrop = $("#routeSimulatorAllowDrop").checked;
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
    try {
        await calculateSimulation({ token, day, dayFingerprint, spots, sourceSpots, firstSpotIndex, lastSpotIndex, fixedSpotIndexes, fixedStart, latestFinish, notBefore, allowDrop });
    } catch (error) {
        if (token !== calculationToken) return;
        console.warn("No se pudo calcular la simulación.", error);
        activeSimulation = null;
        unmountRouteMap?.();
        unmountRouteMap = null;
        resultEl.innerHTML = "";
        statusEl.textContent = "";
        setPhase("setup");
        errorEl.textContent = "No se pudo calcular la ruta. Revisa las paradas seleccionadas e inténtalo de nuevo.";
    } finally {
        // A superseded run must not touch the button: the run that replaced it
        // owns the loading state now.
        if (token === calculationToken) resetRunButton();
    }
});

// Measures the day and runs the first optimization. Throws on any failure so
// the submit handler can restore the dialog instead of spinning forever.
async function calculateSimulation({ token, day, dayFingerprint, spots, sourceSpots, firstSpotIndex, lastSpotIndex, fixedSpotIndexes, fixedStart, latestFinish, notBefore, allowDrop }) {
    const profile = ["walking", "driving", "cycling"].includes(store.routeProfile) ? store.routeProfile : "walking";
    // Warm the same route cache the planner reads before projecting the
    // established day, so "Antes" shows the hours the itinerary already shows
    // instead of a distance estimate.
    await Promise.all([...travelProfilesForSpots(sourceSpots)]
        .map((mode) => ensureRouteTravelTimes(sourceSpots, mode)));
    const matrix = await fetchTravelMatrix(spots, profile);
    // Superseded: whoever bumped the token (a new run, a day change, closing
    // the dialog) already owns the button and the result panel.
    if (token !== calculationToken) return;
    const travelMinutes = matrix.minutes.map((row) => [...row]);
    // Pinned once: the comparison reference must not drift when the traveller
    // edits a leg to explore a what-if.
    const baseline = establishedBaseline(day, sourceSpots, { profile, travelForLeg: resolveTravelForLeg });
    const establishedLegs = seedEstablishedLegs(travelMinutes, baseline);
    const departureLegs = departureLockedLegs(baseline);
    const linkedChains = linkedStopChains(baseline);
    const visitedStops = visitedLockedStops(baseline);
    const missingDurations = spots.filter((spot) => !isWaypoint(spot) && !(Number.isInteger(spot.visitMinutes) && spot.visitMinutes > 0)).map((spot) => spot.name || "Parada sin nombre");
    // The timeline still projects every enabled stop the dialog left out, so
    // their visits and legs will move the applied hours. Say so up front.
    const selectedIds = new Set(sourceSpots.map((spot) => String(spot.id)));
    const unsimulatedStops = day.spots
        .filter((spot) => spotIsEnabled(spot) && !selectedIds.has(String(spot.id)))
        .map((spot) => spot.name || "Parada sin nombre");
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
        linkedChains,
        visitedStops,
        unsimulatedStops,
        latestFinish,
        notBefore,
        allowDrop,
        keepAll: false,
        outcome: null,
        droppedSpotIds: [],
        baseline,
    };
    recalculateActiveSimulation({ preserveScroll: false });
}

function applicationPreview(simulation) {
    const uniqueSteps = simulation.result.steps.filter((step, index, steps) =>
        steps.findIndex((candidate) => String(candidate.spot.id) === String(step.spot.id)) === index);
    const afterIds = uniqueSteps.map((step) => String(step.spot.id));
    // Same measure as the result panel: stops shifted by another one's move
    // keep their order and are not counted.
    const moved = reorderDiff(simulation.baseline.steps, simulation.result.steps).movedCount;
    const lateBookings = lateReservations(simulation.result);
    const warnings = [
        ...(lateBookings.length ? [{
            tone: "remove",
            title: lateBookings.length === 1 ? "Reserva no alcanzable" : "Reservas no alcanzables",
            detail: `${lateBookings.map((step) => step.spot.name || "Parada sin nombre").join(", ")} ${lateBookings.length === 1 ? "conserva su hora" : "conservan su hora"}, pero el orden propuesto llega tarde.`,
        }] : []),
        ...(simulation.droppedSpotIds.length ? [{
            tone: "remove",
            title: simulation.droppedSpotIds.length === 1 ? "Parada opcional al backlog" : "Paradas opcionales al backlog",
            detail: `${simulation.baseline.steps.filter((step) => simulation.droppedSpotIds.includes(String(step.spot.id))).map((step) => step.spot.name || "Parada sin nombre").join(", ")} ${simulation.droppedSpotIds.length === 1 ? "sale" : "salen"} del día y ${simulation.droppedSpotIds.length === 1 ? "queda" : "quedan"} en el backlog, sin borrarse.`,
        }] : []),
        ...(simulation.unsimulatedStops.length ? [{
            tone: "modify",
            title: "Horas sujetas a recálculo",
            detail: `${simulation.unsimulatedStops.join(", ")} no ${simulation.unsimulatedStops.length === 1 ? "entra" : "entran"} en el cálculo y desplazará${simulation.unsimulatedStops.length === 1 ? "" : "n"} las horas del itinerario.`,
        }] : []),
    ];
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
                detail: "Se aplicarán el orden propuesto y la hora de inicio del día. Solo las paradas con hora indicada guardan la hora calculada; las reservas conservan la suya.",
            },
            ...warnings,
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
            const droppedSpotIds = simulation.droppedSpotIds;
            const appliedDay = applySimulationToDay(day, simulation.selectedSpotIds, simulation.result, { droppedSpotIds });
            return replacePlanIntent(document, {
                ...document,
                days: document.days.map((candidate) => candidate === day ? appliedDay : candidate),
                backlog: [...(document.backlog || []), ...backlogCopiesOfDropped(day, droppedSpotIds)],
            });
        });
        if (committed?.skipped) {
            toast("Este viaje es de solo lectura y no se puede modificar.", "error");
            return;
        }
        dialog.close();
        const droppedCount = simulation.droppedSpotIds.length;
        toast(droppedCount
            ? `Simulación aplicada. ${droppedCount === 1 ? "Una parada opcional pasó" : `${droppedCount} paradas opcionales pasaron`} al backlog. Puedes deshacerlo desde el historial.`
            : "Simulación aplicada. Puedes deshacer el cambio desde el historial.", "success");
    } catch (error) {
        if (error?.message === "SIMULATION_RESULT_OVERNIGHT") {
            toast("La propuesta pasa de medianoche y no se puede guardar en este día.", "error");
            return;
        }
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
    const keepAll = event.target.closest?.("[data-simulator-keep-all]");
    const dropOptional = event.target.closest?.("[data-simulator-drop-optional]");
    if ((keepAll || dropOptional) && activeSimulation) {
        activeSimulation.keepAll = Boolean(keepAll);
        renderActiveSimulation();
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
