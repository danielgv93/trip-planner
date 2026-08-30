import { store, clearTagFilter, setDayCollapsed } from "../../core/store.js";
import { $, esc } from "../../shared/dom.js";
import { render } from "./render.js";
import { drawMap } from "../map/map.js";

const root = $("#spotSearch"),
    input = $("#spotSearchInput"),
    resultsEl = $("#spotSearchResults"),
    trigger = $("#spotSearchBtn");
let results = [], activeIndex = 0, previouslyFocused;

// Keep commands pointed at the existing UI controls so every action continues
// to use its owning feature's validation, dialogs and side effects.
const commands = [
    { label: "Exportar plan", detail: "Descargar una copia JSON", icon: "↓", selector: "#exportBtn", keywords: "exportar descargar copia json archivo" },
    { label: "Importar plan", detail: "Cargar un archivo JSON", icon: "↑", selector: "#importBtn", keywords: "importar cargar subir json archivo" },
    { label: "Fechas clave", detail: "Abrir recordatorios y plazos", icon: "◷", selector: "#remindersOpenBtn", keywords: "fechas clave recordatorios avisos calendario plazos reservas pagos" },
    { label: "Mis viajes", detail: "Abrir la biblioteca de viajes", icon: "▣", selector: "#libraryBtn", keywords: "mis viajes biblioteca planes" },
    { label: "Historial", detail: "Ver versiones guardadas", icon: "↺", selector: "#historyOpenBtn", keywords: "historial versiones cambios restaurar" },
    { label: "Notas del viaje", detail: "Abrir el cuaderno de notas", icon: "✎", selector: "#tripNotesToggle", keywords: "notas cuaderno apuntes" },
    { label: "Presupuesto", detail: "Ver el desglose de gastos", icon: "€", selector: "#tripBudgetTotal", keywords: "presupuesto gastos costes dinero total" },
    { label: "Configurar divisas", detail: "Cambiar monedas y conversión", icon: "⇄", selector: "#currencyConfigBtn", keywords: "divisas monedas cambio conversion eur usd jpy" },
    { label: "Vista completa", detail: "Alternar la vista de todo el viaje", icon: "◎", selector: "#previewBtn", keywords: "vista completa mapa viaje editar plan" },
    { label: "Comprobar plan", detail: "Revisar horarios y viabilidad", icon: "✓", selector: "#healthCheckBtn", keywords: "comprobar revisar salud plan horarios viabilidad" },
    { label: "En ruta", detail: "Abrir el modo de acompañamiento", icon: "➜", selector: "#companionEnterBtn", keywords: "en ruta acompañamiento viaje navegacion" },
    { label: "Gestionar etiquetas", detail: "Crear, editar o eliminar etiquetas", icon: "#", selector: "#manageTags", keywords: "gestionar etiquetas tags filtros" },
    { label: "Gestionar categorías", detail: "Configurar tipos de parada", icon: "◈", selector: "#manageCategories", keywords: "gestionar categorias tipos colores" },
    { label: "Añadir un día", detail: "Crear otro día en el itinerario", icon: "+", selector: "#addDay", keywords: "anadir agregar crear nuevo dia itinerario" },
];

function normalized(value) {
    return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase("es")
        .trim();
}

function editDistance(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let diagonal = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const previous = row[j];
            row[j] = Math.min(
                row[j] + 1,
                row[j - 1] + 1,
                diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
            diagonal = previous;
        }
    }
    return row[b.length];
}

function score(name, query) {
    const candidate = normalized(name);
    if (!query) return 1;
    if (candidate === query) return 100;
    if (candidate.startsWith(query)) return 80 - candidate.length / 100;
    const position = candidate.indexOf(query);
    if (position >= 0) return 60 - position - candidate.length / 100;
    const words = candidate.split(/\s+/),
        fragments = [candidate.slice(0, query.length), ...words.map((word) => word.slice(0, query.length))];
    const distance = Math.min(...fragments.map((fragment) => editDistance(fragment, query)));
    const allowance = query.length >= 7 ? 3 : query.length >= 4 ? 2 : 1;
    return distance <= allowance ? 35 - distance : 0;
}

function allSpots() {
    return [
        ...store.backlog.map((spot) => ({ spot, dayId: "backlog", dayTitle: "Backlog" })),
        ...store.state.flatMap((day) =>
            day.spots.map((spot) => ({ spot, dayId: day.id, dayTitle: day.title })),
        ),
    ];
}

function availableCommands() {
    return commands.filter((command) => {
        const target = document.querySelector(command.selector);
        return target && !target.disabled;
    });
}

function paint() {
    const query = normalized(input.value);
    const commandResults = availableCommands().map((command) => {
        const matchScore = score(`${command.label} ${command.keywords}`, query);
        return {
            type: "command",
            command,
            score: matchScore > 0 && query ? matchScore + 6 : matchScore,
        };
    });
    const spotResults = allSpots().map((item) => ({
        type: "spot",
        ...item,
        score: score(item.spot.name, query),
    }));
    results = [...commandResults, ...spotResults]
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || resultLabel(a).localeCompare(resultLabel(b), "es"))
        .slice(0, 10);
    activeIndex = Math.min(activeIndex, Math.max(0, results.length - 1));
    if (!results.length) {
        resultsEl.innerHTML = `<div class="spotlight-empty">${query ? "No hay paradas ni acciones parecidas" : "No hay resultados disponibles"}</div>`;
        input.removeAttribute("aria-activedescendant");
        return;
    }
    resultsEl.innerHTML = results.map((result, index) => {
        const active = index === activeIndex;
        if (result.type === "command") {
            const { command } = result;
            return `<button id="spot-search-result-${index}" class="spotlight-result spotlight-command${active ? " active" : ""}" type="button" role="option" aria-selected="${active}" data-index="${index}"><span class="spotlight-result-icon" aria-hidden="true">${esc(command.icon)}</span><span><strong>${esc(command.label)}</strong><small><b>Acción</b> · ${esc(command.detail)}</small></span><span class="spotlight-arrow" aria-hidden="true">↵</span></button>`;
        }
        const { spot, dayTitle } = result;
        return `<button id="spot-search-result-${index}" class="spotlight-result${active ? " active" : ""}" type="button" role="option" aria-selected="${active}" data-index="${index}"><span class="spotlight-result-icon" aria-hidden="true">⌖</span><span><strong>${esc(spot.name || "Parada sin nombre")}</strong><small>${esc(dayTitle)}${spot.address ? ` · ${esc(spot.address)}` : ""}</small></span><span class="spotlight-arrow" aria-hidden="true">↵</span></button>`;
    }).join("");
    input.setAttribute("aria-activedescendant", `spot-search-result-${activeIndex}`);
}

function resultLabel(result) {
    return result.type === "command" ? result.command.label : result.spot.name || "";
}

function openSearch() {
    if (!root.hidden) return;
    previouslyFocused = document.activeElement;
    document.querySelector(".top-actions")?.classList.remove("nav-open");
    $("#navToggle")?.setAttribute("aria-expanded", "false");
    root.hidden = false;
    document.body.classList.add("spotlight-open");
    input.value = "";
    activeIndex = 0;
    paint();
    requestAnimationFrame(() => input.focus());
}

function closeSearch({ restoreFocus = true } = {}) {
    if (root.hidden) return;
    root.hidden = true;
    document.body.classList.remove("spotlight-open");
    if (restoreFocus) previouslyFocused?.focus?.();
}

function choose(index) {
    const match = results[index];
    if (!match) return;
    closeSearch({ restoreFocus: false });
    if (match.type === "command") {
        document.querySelector(match.command.selector)?.click();
        return;
    }
    clearTagFilter();
    if (match.dayId === "backlog") {
        store.backlogCollapsed = false;
        const group = store.backlogGroups.find(
            (candidate) => candidate.id === match.spot.backlogGroupId,
        );
        if (group) group.collapsed = false;
    }
    else {
        setDayCollapsed(match.dayId, false);
    }
    store.active = match.dayId;
    render({ persist: false });
    drawMap();
    requestAnimationFrame(() => {
        const card = document.querySelector(`.spot[data-spot="${CSS.escape(match.spot.id)}"]`);
        if (!card) return;
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.remove("spot-search-highlight");
        requestAnimationFrame(() => card.classList.add("spot-search-highlight"));
        card.addEventListener("animationend", () => card.classList.remove("spot-search-highlight"), { once: true });
    });
}

trigger.addEventListener("click", openSearch);
root.addEventListener("click", (event) => {
    if (event.target.closest("[data-search-close]")) closeSearch();
    const result = event.target.closest(".spotlight-result");
    if (result) choose(Number(result.dataset.index));
});
input.addEventListener("input", () => { activeIndex = 0; paint(); });
input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!results.length) return;
        activeIndex = (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
        paint();
        resultsEl.querySelector(".active")?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
        event.preventDefault();
        choose(activeIndex);
    }
});
document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && typeof event.key === "string" && event.key.toLowerCase() === "k") {
        event.preventDefault();
        root.hidden ? openSearch() : closeSearch();
    } else if (event.key === "Escape" && !root.hidden) {
        event.preventDefault();
        closeSearch();
    }
});
