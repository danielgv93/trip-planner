// "Antes" and "Propuesta" side by side, each stop joined to where it lands.
// Stops that keep their relative order get a quiet straight-ish thread; the
// ones that actually move get a bold curve, so the eye finds them first.

import { esc } from "../../shared/dom.js";
import { formatSimulationTime } from "./optimizer.js";
import { placementPhrase } from "./reorder.js";

// Row height and connector width in px. The lists use the same row height
// (--rs-reorder-row) so every thread starts and ends on its row's centre.
const ROW = 46;
const LINK_WIDTH = 120;

const ordinal = (index) => `${index + 1}.ª`;
const nameOf = (step) => step?.spot?.name || "Parada sin nombre";

function linkPath(from, to) {
    const y1 = from * ROW + ROW / 2;
    const y2 = to * ROW + ROW / 2;
    const bend = LINK_WIDTH * 0.5;
    return `M6 ${y1} C ${bend} ${y1}, ${LINK_WIDTH - bend} ${y2}, ${LINK_WIDTH - 6} ${y2}`;
}

function linksMarkup(diff) {
    const rows = Math.max(diff.before.length, diff.after.length);
    const links = diff.after.filter((entry) => entry.status === "stay" || entry.status === "moved");
    // Moved threads are drawn last so they sit above the quiet ones.
    const ordered = [...links.filter((entry) => entry.status === "stay"), ...links.filter((entry) => entry.status === "moved")];
    const paths = ordered.map((entry) => {
        const y1 = entry.from * ROW + ROW / 2;
        const y2 = entry.to * ROW + ROW / 2;
        return `<g class="route-simulator-reorder-link is-${entry.status}" data-reorder-key="${esc(entry.key)}">
            <path class="route-simulator-reorder-hit" d="${linkPath(entry.from, entry.to)}" /><path d="${linkPath(entry.from, entry.to)}" />
            <circle cx="6" cy="${y1}" r="3" /><circle cx="${LINK_WIDTH - 6}" cy="${y2}" r="${entry.status === "moved" ? 4.5 : 3}" />
        </g>`;
    }).join("");
    const dropped = diff.before.filter((entry) => entry.status === "dropped").map((entry) => {
        const y = entry.from * ROW + ROW / 2;
        return `<g class="route-simulator-reorder-link is-dropped" data-reorder-key="${esc(entry.key)}"><path class="route-simulator-reorder-hit" d="M6 ${y} H ${LINK_WIDTH * 0.42}" /><path d="M6 ${y} H ${LINK_WIDTH * 0.42}" /><circle cx="6" cy="${y}" r="3" /><path class="route-simulator-reorder-cross" d="M${LINK_WIDTH * 0.42 - 4} ${y - 4} l8 8 m0 -8 l-8 8" /></g>`;
    }).join("");
    return `<svg class="route-simulator-reorder-links" width="${LINK_WIDTH}" height="${rows * ROW}" viewBox="0 0 ${LINK_WIDTH} ${rows * ROW}" preserveAspectRatio="none" aria-hidden="true" focusable="false">${dropped}${paths}</svg>`;
}

// Each move is worth what undoing it alone would cost (see move-impact.js).
function impactClause(impact, fromNow) {
    const name = impact.spot?.name || "una parada";
    if (impact.kind === "reservation") return `llegarías tarde a la reserva de ${name}${Number.isInteger(impact.planned) ? ` (${formatSimulationTime(impact.planned)})` : ""}`;
    if (impact.kind === "limit") return "terminarías después de la hora límite";
    if (impact.kind === "conflict") return `${name} quedaría fuera de horario o con retraso`;
    return fromNow ? `terminarías ${impact.minutes} min más tarde` : `la jornada duraría ${impact.minutes} min más`;
}

function impactSentence(impact, fromNow) {
    if (!impact || impact.kind === "locked") return "";
    if (impact.kind === "minutes" && impact.minutes <= 0) {
        return impact.minutes === 0
            ? "Por sí solo apenas cambia la duración del día."
            : `Por sí solo ${fromNow ? "retrasa el final" : "alarga la jornada"} ${Math.abs(impact.minutes)} min.`;
    }
    return `Sin este cambio, ${impactClause(impact, fromNow)}.`;
}

function impactBadge(impact) {
    if (!impact || impact.kind === "locked") return "";
    const [tone, label] = impact.kind === "reservation" ? ["is-key", "Reserva"]
        : impact.kind === "limit" ? ["is-key", "Hora límite"]
            : impact.kind === "conflict" ? ["is-key", "Horario"]
                : impact.minutes > 0 ? ["is-saving", `−${impact.minutes} min`]
                    : impact.minutes < 0 ? ["is-cost", `+${Math.abs(impact.minutes)} min`]
                        : ["is-neutral", "≈ 0 min"];
    return `<em class="route-simulator-reorder-impact ${tone}">${esc(label)}</em>`;
}

function shiftLabel(entry) {
    const delta = entry.from - entry.to;
    return `${delta > 0 ? "↑" : "↓"} era ${ordinal(entry.from)}`;
}

export function reorderDiagramMarkup(baseline, result, diff, {
    isAnchored = () => false,
    impacts = { byKey: new Map(), groups: [] },
    fromNow = false,
} = {}) {
    const groupOf = new Map(impacts.groups.flatMap((group) => group.keys.map((key) => [key, group])));
    const groupBadge = (group) => `<em class="route-simulator-reorder-impact is-group" title="Este cambio solo compensa junto con otros">${esc(group.kind === "minutes" ? `⇅ −${group.minutes} min` : "⇅ en conjunto")}</em>`;
    const beforeRows = diff.before.map((entry) => {
        const step = baseline.steps[entry.from];
        const note = entry.status === "dropped" ? "Al backlog"
            : entry.status === "moved" ? `pasa a ${ordinal(entry.to)}`
                : formatSimulationTime(step.start);
        return `<li class="is-${entry.status}" data-reorder-key="${esc(entry.key)}"${entry.status === "stay" ? "" : ' tabindex="0"'}><b>${entry.from + 1}</b><span><strong>${esc(nameOf(step))}</strong><small>${esc(note)}</small></span></li>`;
    }).join("");
    const afterRows = diff.after.map((entry) => {
        const step = result.steps[entry.to];
        const anchored = !step.repeated && isAnchored(step);
        const note = entry.status === "added" ? "Regreso al inicio"
            : entry.status === "moved" ? shiftLabel(entry)
                : `${formatSimulationTime(step.start)}${anchored ? " · fija" : ""}`;
        const badge = entry.status !== "moved" ? ""
            : groupOf.has(entry.key) ? groupBadge(groupOf.get(entry.key)) : impactBadge(impacts.byKey.get(entry.key));
        return `<li class="is-${entry.status}" data-reorder-key="${esc(entry.key)}"${entry.status === "moved" ? ' tabindex="0"' : ""}><b>${entry.to + 1}</b><span><strong>${esc(nameOf(step))}</strong><small>${esc(note)}${badge}</small></span></li>`;
    }).join("");

    const moved = diff.after.filter((entry) => entry.status === "moved");
    const stays = diff.after.filter((entry) => entry.status === "stay").length;
    const dropped = diff.before.filter((entry) => entry.status === "dropped");
    const counts = [
        `<span class="is-moved"><b>${moved.length}</b> ${moved.length === 1 ? "se mueve" : "se mueven"}</span>`,
        `<span class="is-stay"><b>${stays}</b> ${stays === 1 ? "mantiene" : "mantienen"} su orden</span>`,
        dropped.length ? `<span class="is-dropped"><b>${dropped.length}</b> ${dropped.length === 1 ? "sale" : "salen"} del día</span>` : "",
    ].join("");
    const nameAt = (index) => nameOf(result.steps[index]);
    const keyName = (key) => nameAt(diff.after.find((entry) => entry.key === key).to);
    const listNames = (names) => names.length > 1 ? `${names.slice(0, -1).join(", ")} y ${names.at(-1)}` : names[0] || "";
    const moveImpactSentence = (entry) => {
        const group = groupOf.get(entry.key);
        if (!group) return impactSentence(impacts.byKey.get(entry.key), fromNow);
        const others = group.keys.filter((key) => key !== entry.key);
        return `Funciona junto con ${listNames(others.map(keyName))}: sin ${others.length === 1 ? "ninguno de los dos" : "ninguno de ellos"}, ${impactClause(group, fromNow)}.`;
    };
    // One card per change. Screen readers get them as a plain list; pointing
    // at a change on the board shows the same card as a tooltip, so the board
    // carries the explanation without a second list taking room under it.
    const card = (key, tone, mark, name, badge, body, why, foot) =>
        `<li class="is-${tone}" data-reorder-key="${esc(key)}"><div class="route-simulator-reorder-tip-head"><i aria-hidden="true">${mark}</i><strong>${esc(name)}</strong>${badge}</div><p>${esc(body)}</p>${why ? `<p class="route-simulator-reorder-why">${esc(why)}</p>` : ""}<small>${esc(foot)}</small></li>`;
    const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
    const cards = [
        ...moved.map((entry) => card(
            entry.key,
            "moved",
            entry.from > entry.to ? "↑" : "↓",
            nameAt(entry.to),
            groupOf.has(entry.key) ? groupBadge(groupOf.get(entry.key)) : impactBadge(impacts.byKey.get(entry.key)),
            `${capitalize(placementPhrase(diff, entry.to, nameAt))}.`,
            moveImpactSentence(entry),
            `Era la ${ordinal(entry.from)} → ahora la ${ordinal(entry.to)}`,
        )),
        ...dropped.map((entry) => card(
            entry.key,
            "dropped",
            "−",
            nameOf(baseline.steps[entry.from]),
            "",
            "Sale del día y pasa al backlog: no se borra.",
            "",
            `Era la ${ordinal(entry.from)} · opcional`,
        )),
    ].join("");
    const empty = !moved.length && !dropped.length
        ? '<p class="route-simulator-reorder-empty">El orden de las paradas no cambia: la propuesta solo ajusta horas.</p>'
        : "";

    return `<section class="route-simulator-reorder" style="--rs-reorder-row: ${ROW}px; --rs-reorder-link: ${LINK_WIDTH}px" aria-label="Cambios de orden">
        <div class="route-simulator-reorder-counts">${counts}</div>
        <div class="route-simulator-reorder-board" data-reorder-board>
            <header><span>Antes <small>${baseline.metrics.travel} min de trayecto</small></span><span></span><span>Propuesta <small>${result.metrics.travel} min de trayecto</small></span></header>
            <ol class="is-before" aria-label="Orden actual">${beforeRows}</ol>
            ${linksMarkup(diff)}
            <ol class="is-after" aria-label="Orden propuesto">${afterRows}</ol>
        </div>
        ${cards ? `<ul class="sr-only" data-reorder-cards aria-label="Paradas que cambian">${cards}</ul><div class="route-simulator-reorder-tip" role="tooltip" hidden></div>` : empty}
        ${moved.length ? '<p class="route-simulator-reorder-note">Pasa el cursor por un cambio para ver por qué se mueve. Cada cifra es lo que costaría deshacer solo ese cambio, así que no tienen por qué sumar el total.</p>' : ""}
    </section>`;
}

// Pointing at a stop anywhere (either list or its thread) lights it up
// everywhere, dims the rest and, for a change, shows its card beside the
// pointer. Keyboard focus on a changed row shows the card under that row.
export function mountReorderDiagram(root) {
    const section = root.querySelector(".route-simulator-reorder");
    if (!section) return;
    const tip = section.querySelector(".route-simulator-reorder-tip");
    const cards = new Map([...section.querySelectorAll("[data-reorder-cards] > li")]
        .map((item) => [item.dataset.reorderKey, item]));
    let current = null;
    const place = (x, y) => {
        // The card may spill over the map beside the board: covering the
        // map is cheaper than covering the rows the card is explaining.
        const bounds = section.getBoundingClientRect();
        const room = (section.closest(".route-simulator-result-story") || section).getBoundingClientRect();
        const width = tip.offsetWidth;
        const height = tip.offsetHeight;
        let left = x - bounds.left + 18;
        if (bounds.left + left + width > room.right) left = x - bounds.left - width - 18;
        let top = y - bounds.top + 16;
        if (top + height > section.scrollHeight) top = y - bounds.top - height - 12;
        tip.style.left = `${Math.max(0, left)}px`;
        tip.style.top = `${Math.max(0, top)}px`;
    };
    const show = (key) => {
        if (key === current) return;
        current = key;
        section.classList.toggle("has-focus", Boolean(key));
        section.querySelectorAll("[data-reorder-board] [data-reorder-key]").forEach((element) => {
            element.classList.toggle("is-focus", element.dataset.reorderKey === key);
        });
        if (!tip) return;
        const item = key ? cards.get(key) : null;
        tip.hidden = !item;
        if (!item) return;
        tip.className = `route-simulator-reorder-tip ${item.className}`;
        tip.innerHTML = item.innerHTML;
    };
    const keyFrom = (event) => event.target.closest?.("[data-reorder-board] [data-reorder-key]")?.dataset.reorderKey || null;
    section.addEventListener("pointermove", (event) => {
        show(keyFrom(event));
        if (tip && !tip.hidden) place(event.clientX, event.clientY);
    });
    section.addEventListener("pointerleave", () => show(null));
    section.addEventListener("focusin", (event) => {
        show(keyFrom(event));
        if (!tip || tip.hidden) return;
        const row = event.target.getBoundingClientRect();
        place(row.left + row.width / 2 - 16, row.bottom - 8);
    });
    section.addEventListener("focusout", () => show(null));
}
