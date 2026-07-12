import { store, clearTagFilter, dayBy } from "./store.js";
import { $, esc } from "./dom.js";
import { render } from "./render.js";
import { drawMap } from "./map.js";

const root = $("#spotSearch"),
    input = $("#spotSearchInput"),
    resultsEl = $("#spotSearchResults"),
    trigger = $("#spotSearchBtn");
let results = [], activeIndex = 0, previouslyFocused;

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

function paint() {
    const query = normalized(input.value);
    results = allSpots()
        .map((item) => ({ ...item, score: score(item.spot.name, query) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.spot.name.localeCompare(b.spot.name, "es"))
        .slice(0, 8);
    activeIndex = Math.min(activeIndex, Math.max(0, results.length - 1));
    if (!results.length) {
        resultsEl.innerHTML = `<div class="spotlight-empty">${query ? "No hay paradas parecidas" : "Aún no hay paradas en el viaje"}</div>`;
        input.removeAttribute("aria-activedescendant");
        return;
    }
    resultsEl.innerHTML = results.map(({ spot, dayTitle }, index) =>
        `<button id="spot-search-result-${index}" class="spotlight-result${index === activeIndex ? " active" : ""}" type="button" role="option" aria-selected="${index === activeIndex}" data-index="${index}"><span class="spotlight-result-icon" aria-hidden="true">⌖</span><span><strong>${esc(spot.name || "Parada sin nombre")}</strong><small>${esc(dayTitle)}${spot.address ? ` · ${esc(spot.address)}` : ""}</small></span><span class="spotlight-arrow" aria-hidden="true">↵</span></button>`,
    ).join("");
    input.setAttribute("aria-activedescendant", `spot-search-result-${activeIndex}`);
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
    clearTagFilter();
    if (match.dayId === "backlog") store.backlogCollapsed = false;
    else {
        const day = dayBy(match.dayId);
        if (day) day.collapsed = false;
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
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        root.hidden ? openSearch() : closeSearch();
    } else if (event.key === "Escape" && !root.hidden) {
        event.preventDefault();
        closeSearch();
    }
});
