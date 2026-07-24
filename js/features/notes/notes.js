import { store, save } from "../../core/store.js";
import { activeTripNotePage } from "../../core/note-pages.js";
import { $, id } from "../../shared/dom.js";
import { confirmAction, promptAction } from "../../shared/notify.js";
import { extractNoteLinks, inlineMarkdown } from "./markdown.js";

const notes = $("#tripNotes");
const toggle = $("#tripNotesToggle");
const dialog = $("#tripNotesDialog");
const summary = $("#tripNotesSummary");
const status = $("#tripNotesStatus");
const modeButton = $("#tripNotesMode");
const preview = $("#tripNotesPreview");
const editorLinks = $("#tripNotesLinks");
const index = $("#tripNotesIndex");
const indexEmpty = $("#tripNotesIndexEmpty");
const tabs = $("#tripNotesTabs");
const addPageButton = $("#tripNotesAddPage");
const renamePageButton = $("#tripNotesRenamePage");
const deletePageButton = $("#tripNotesDeletePage");
let statusTimer;

function currentPage() {
    return activeTripNotePage(store.tripNotePages, store.activeTripNotePageId);
}

function summaryText() {
    const page = currentPage();
    const clean = page.content.replace(/\s+/g, " ").trim();
    if (store.tripNotePages.length > 1) {
        return `${store.tripNotePages.length} páginas · ${page.title}${clean ? ` · ${clean}` : ""}`;
    }
    return clean || "Reservas, enlaces y recordatorios";
}

function plainHeadingText(value) {
    return value
        .replace(/\s+#+\s*$/, "")
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[*_~`]/g, "")
        .trim();
}

function noteHeadings(source) {
    const headings = [];
    const lines = source.replace(/\r/g, "").split("\n");
    let offset = 0;
    for (const line of lines) {
        const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
        if (match) {
            const text = plainHeadingText(match[2]);
            if (text) {
                headings.push({
                    id: `trip-note-heading-${headings.length + 1}`,
                    level: match[1].length,
                    text,
                    offset,
                });
            }
        }
        offset += line.length + 1;
    }
    return headings;
}

function markdownToHtml(source, headings = noteHeadings(source)) {
    if (!source.trim()) return '<p class="trip-notes-preview-empty">Todavía no hay notas en esta página.</p>';
    const lines = source.replace(/\r/g, "").split("\n");
    const output = [];
    let list = null;
    let headingIndex = 0;
    const closeList = () => {
        if (list) output.push(`</${list}>`);
        list = null;
    };
    for (const line of lines) {
        const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
        const bullet = line.match(/^\s*[-*]\s+(.+)$/);
        const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
        if (heading) {
            closeList();
            const level = heading[1].length;
            const item = headings[headingIndex++];
            const headingId = item?.id || `trip-note-heading-${headingIndex}`;
            output.push(`<h${level} id="${headingId}" tabindex="-1">${inlineMarkdown(heading[2].replace(/\s+#+\s*$/, ""))}</h${level}>`);
        } else if (bullet || ordered) {
            const type = bullet ? "ul" : "ol";
            if (list !== type) {
                closeList();
                output.push(`<${type}>`);
                list = type;
            }
            output.push(`<li>${inlineMarkdown((bullet || ordered)[1])}</li>`);
        } else {
            closeList();
            if (!line.trim()) continue;
            if (line.startsWith("> ")) output.push(`<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`);
            else output.push(`<p>${inlineMarkdown(line)}</p>`);
        }
    }
    closeList();
    return output.join("");
}

function renderTabs() {
    tabs.replaceChildren();
    for (const page of store.tripNotePages) {
        const button = document.createElement("button");
        const active = page.id === store.activeTripNotePageId;
        button.type = "button";
        button.setAttribute("role", "tab");
        button.dataset.pageId = page.id;
        button.textContent = page.title;
        button.title = page.title;
        button.setAttribute("aria-selected", String(active));
        button.setAttribute("aria-controls", "tripNotes");
        button.tabIndex = active ? 0 : -1;
        tabs.append(button);
    }
    deletePageButton.disabled = store.tripNotePages.length === 1;
}

function renderIndex() {
    const source = currentPage().content;
    const headings = noteHeadings(source);
    index.replaceChildren();
    indexEmpty.hidden = headings.length > 0;
    index.closest(".trip-notes-index").classList.toggle("is-empty", headings.length === 0);

    for (const heading of headings) {
        const link = document.createElement("a");
        link.href = `#${heading.id}`;
        link.textContent = heading.text;
        link.dataset.level = String(heading.level);
        link.dataset.offset = String(heading.offset);
        link.title = heading.text;
        index.append(link);
    }
    preview.innerHTML = markdownToHtml(source, headings);
}

function renderEditorLinks() {
    const links = extractNoteLinks(currentPage().content);
    editorLinks.replaceChildren();
    editorLinks.hidden = notes.hidden || links.length === 0;
    if (!links.length) return;

    const label = document.createElement("span");
    label.textContent = "Enlaces";
    editorLinks.append(label);
    for (const item of links) {
        const link = document.createElement("a");
        link.href = item.href;
        link.textContent = item.label;
        link.title = item.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        editorLinks.append(link);
    }
}

function jumpToHeading(link) {
    if (!notes.hidden) {
        const offset = Number(link.dataset.offset);
        const lineNumber = notes.value.slice(0, offset).split("\n").length - 1;
        const lineHeight = Number.parseFloat(getComputedStyle(notes).lineHeight) || 20;
        notes.focus();
        notes.setSelectionRange(offset, offset);
        notes.scrollTop = Math.max(0, lineNumber * lineHeight - notes.clientHeight * 0.2);
        return;
    }
    const heading = preview.querySelector(`#${CSS.escape(link.hash.slice(1))}`);
    if (!heading) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    preview.scrollTo({
        top: Math.max(0, heading.offsetTop - preview.offsetTop - 10),
        behavior: reducedMotion ? "auto" : "smooth",
    });
    heading.focus({ preventScroll: true });
}

function showMode(mode) {
    const writing = mode === "write";
    notes.hidden = !writing;
    preview.hidden = writing;
    renderEditorLinks();
    modeButton.setAttribute("aria-pressed", String(!writing));
    modeButton.textContent = writing ? "Previsualizar" : "Seguir editando";
    if (writing) notes.focus();
    else renderIndex();
}

function selectPage(pageId, { focus = true } = {}) {
    if (!store.tripNotePages.some((page) => page.id === pageId)) return;
    store.activeTripNotePageId = pageId;
    save();
    syncTripNotes();
    status.textContent = "";
    if (focus && !notes.hidden) notes.focus();
}

export function syncTripNotes() {
    const page = currentPage();
    store.activeTripNotePageId = page.id;
    notes.value = page.content;
    notes.setAttribute("aria-label", `Notas: ${page.title}`);
    summary.textContent = summaryText();
    renderTabs();
    renderIndex();
    renderEditorLinks();
}

toggle.addEventListener("click", () => {
    showMode("write");
    dialog.showModal();
    notes.focus();
});

dialog.querySelector(".close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
});

tabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[role=tab]");
    if (tab) selectPage(tab.dataset.pageId);
});

tabs.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const allTabs = [...tabs.querySelectorAll("[role=tab]")];
    const current = allTabs.indexOf(document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    let next = event.key === "Home" ? 0 : event.key === "End" ? allTabs.length - 1 : current;
    if (event.key === "ArrowLeft") next = (current - 1 + allTabs.length) % allTabs.length;
    if (event.key === "ArrowRight") next = (current + 1) % allTabs.length;
    selectPage(allTabs[next].dataset.pageId, { focus: false });
    tabs.querySelector(`[data-page-id="${CSS.escape(allTabs[next].dataset.pageId)}"]`)?.focus();
});

addPageButton.addEventListener("click", async () => {
    const title = await promptAction({
        title: "Nueva página",
        message: "Ponle un nombre corto para encontrarla fácilmente.",
        confirmLabel: "Crear página",
        inputLabel: "Nombre",
        inputPlaceholder: `Página ${store.tripNotePages.length + 1}`,
    });
    if (title === null) return;
    const page = {
        id: id(),
        title: title.trim().slice(0, 50) || `Página ${store.tripNotePages.length + 1}`,
        content: "",
    };
    store.tripNotePages.push(page);
    store.activeTripNotePageId = page.id;
    save();
    syncTripNotes();
    notes.focus();
});

renamePageButton.addEventListener("click", async () => {
    const page = currentPage();
    const title = await promptAction({
        title: "Renombrar página",
        message: `Nombre actual: ${page.title}`,
        confirmLabel: "Guardar nombre",
        inputLabel: "Nuevo nombre",
        inputPlaceholder: page.title,
    });
    if (title === null) return;
    page.title = title.trim().slice(0, 50) || page.title;
    save();
    syncTripNotes();
});

deletePageButton.addEventListener("click", async () => {
    if (store.tripNotePages.length === 1) return;
    const page = currentPage();
    const accepted = await confirmAction({
        title: "Eliminar página",
        message: `¿Eliminar “${page.title}” y todo su contenido?`,
        confirmLabel: "Eliminar página",
    });
    if (!accepted) return;
    const indexToDelete = store.tripNotePages.findIndex((item) => item.id === page.id);
    store.tripNotePages.splice(indexToDelete, 1);
    store.activeTripNotePageId =
        store.tripNotePages[Math.min(indexToDelete, store.tripNotePages.length - 1)].id;
    save();
    syncTripNotes();
});

notes.addEventListener("input", () => {
    currentPage().content = notes.value;
    summary.textContent = summaryText();
    renderIndex();
    renderEditorLinks();
    save();
    status.textContent = "Guardando…";
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
        status.textContent = "Guardado";
    }, 350);
});

notes.addEventListener("blur", () => {
    status.textContent = currentPage().content ? "Guardado" : "";
});

modeButton.addEventListener("click", () => {
    showMode(notes.hidden ? "write" : "preview");
});

index.addEventListener("click", (event) => {
    const link = event.target.closest("a");
    if (!link) return;
    event.preventDefault();
    jumpToHeading(link);
});

syncTripNotes();
