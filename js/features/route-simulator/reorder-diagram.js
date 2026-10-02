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
            <path d="${linkPath(entry.from, entry.to)}" />
            <circle cx="6" cy="${y1}" r="3" /><circle cx="${LINK_WIDTH - 6}" cy="${y2}" r="${entry.status === "moved" ? 4.5 : 3}" />
        </g>`;
    }).join("");
    const dropped = diff.before.filter((entry) => entry.status === "dropped").map((entry) => {
        const y = entry.from * ROW + ROW / 2;
        return `<g class="route-simulator-reorder-link is-dropped" data-reorder-key="${esc(entry.key)}"><path d="M6 ${y} H ${LINK_WIDTH * 0.42}" /><circle cx="6" cy="${y}" r="3" /><path class="route-simulator-reorder-cross" d="M${LINK_WIDTH * 0.42 - 4} ${y - 4} l8 8 m0 -8 l-8 8" /></g>`;
    }).join("");
    return `<svg class="route-simulator-reorder-links" width="${LINK_WIDTH}" height="${rows * ROW}" viewBox="0 0 ${LINK_WIDTH} ${rows * ROW}" preserveAspectRatio="none" aria-hidden="true" focusable="false">${dropped}${paths}</svg>`;
}

function shiftLabel(entry) {
    const delta = entry.from - entry.to;
    return `${delta > 0 ? "↑" : "↓"} era ${ordinal(entry.from)}`;
}

export function reorderDiagramMarkup(baseline, result, diff, { isAnchored = () => false } = {}) {
    const beforeRows = diff.before.map((entry) => {
        const step = baseline.steps[entry.from];
        const note = entry.status === "dropped" ? "Al backlog"
            : entry.status === "moved" ? `pasa a ${ordinal(entry.to)}`
                : formatSimulationTime(step.start);
        return `<li class="is-${entry.status}" data-reorder-key="${esc(entry.key)}"><b>${entry.from + 1}</b><span><strong>${esc(nameOf(step))}</strong><small>${esc(note)}</small></span></li>`;
    }).join("");
    const afterRows = diff.after.map((entry) => {
        const step = result.steps[entry.to];
        const anchored = !step.repeated && isAnchored(step);
        const note = entry.status === "added" ? "Regreso al inicio"
            : entry.status === "moved" ? shiftLabel(entry)
                : `${formatSimulationTime(step.start)}${anchored ? " · fija" : ""}`;
        return `<li class="is-${entry.status}" data-reorder-key="${esc(entry.key)}"><b>${entry.to + 1}</b><span><strong>${esc(nameOf(step))}</strong><small>${esc(note)}</small></span></li>`;
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
    const moves = [
        ...moved.map((entry) => `<li class="is-moved" data-reorder-key="${esc(entry.key)}" tabindex="0"><i aria-hidden="true">${entry.from > entry.to ? "↑" : "↓"}</i><p><strong>${esc(nameAt(entry.to))}</strong> ${esc(placementPhrase(diff, entry.to, nameAt))}.<small>Era la ${esc(ordinal(entry.from))}, ahora la ${esc(ordinal(entry.to))}</small></p></li>`),
        ...dropped.map((entry) => `<li class="is-dropped" data-reorder-key="${esc(entry.key)}" tabindex="0"><i aria-hidden="true">−</i><p><strong>${esc(nameOf(baseline.steps[entry.from]))}</strong> sale del día y pasa al backlog.<small>Era la ${esc(ordinal(entry.from))} · opcional</small></p></li>`),
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
        ${moves ? `<ul class="route-simulator-reorder-moves" data-reorder-board aria-label="Paradas que cambian">${moves}</ul>` : empty}
    </section>`;
}

// Pointing at a stop anywhere (either list, a thread or a sentence) lights up
// that stop everywhere and dims the rest.
export function mountReorderDiagram(root) {
    const section = root.querySelector(".route-simulator-reorder");
    if (!section) return;
    const focus = (key) => {
        section.classList.toggle("has-focus", Boolean(key));
        section.querySelectorAll("[data-reorder-key]").forEach((element) => {
            element.classList.toggle("is-focus", element.dataset.reorderKey === key);
        });
    };
    const keyFrom = (event) => event.target.closest?.("[data-reorder-key]")?.dataset.reorderKey || null;
    section.addEventListener("pointerover", (event) => focus(keyFrom(event)));
    section.addEventListener("pointerleave", () => focus(null));
    section.addEventListener("focusin", (event) => focus(keyFrom(event)));
    section.addEventListener("focusout", () => focus(null));
}
