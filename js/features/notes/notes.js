import { store, saveLocalPreferences } from "../../core/store.js";
import { activeTripNotePage } from "../../core/note-pages.js";
import { $, id } from "../../shared/dom.js";
import { openModal } from "../../shared/modal.js";
import { confirmAction, promptAction } from "../../shared/notify.js";
import { extractNoteLinks, noteHeadings } from "./markdown.js";
import { createNoteEditor } from "./editor.js";
import { createDraftAutosaveController } from "../../shared/draft-autosave.js";
import {
    deleteEntityIntent,
    derivedPlanOperation,
    insertEntityIntent,
    setFieldIntent,
} from "../../core/plan-operation-commit.js";

const notes = $("#tripNotes");
const toggle = $("#tripNotesToggle");
const dialog = $("#tripNotesDialog");
const summary = $("#tripNotesSummary");
const status = $("#tripNotesStatus");
const editorLinks = $("#tripNotesLinks");
const index = $("#tripNotesIndex");
const indexEmpty = $("#tripNotesIndexEmpty");
const tabs = $("#tripNotesTabs");
const addPageButton = $("#tripNotesAddPage");
const renamePageButton = $("#tripNotesRenamePage");
const deletePageButton = $("#tripNotesDeletePage");
let statusTimer;
let notesAutosave;

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
    const source = noteEditor.value;
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
}

function renderEditorLinks() {
    const links = extractNoteLinks(noteEditor.value);
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
    const heading = notes.querySelector(`#${CSS.escape(link.hash.slice(1))}`);
    if (!heading) return;
    heading.scrollIntoView({ block: "nearest" });
    notes.focus({ preventScroll: true });
    if (!store.readOnly) {
        const range = document.createRange();
        range.selectNodeContents(heading);
        range.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    }
}

async function selectPage(pageId, { focus = true } = {}) {
    await notesAutosave.flush("page-change");
    if (!store.tripNotePages.some((page) => page.id === pageId)) return;
    store.activeTripNotePageId = pageId;
    saveLocalPreferences();
    syncTripNotes();
    status.textContent = "";
    if (focus && !notes.hidden) notes.focus();
}

export function syncTripNotes() {
    const page = currentPage();
    store.activeTripNotePageId = page.id;
    noteEditor.setValue(page.content);
    notes.setAttribute("aria-label", `Notas: ${page.title}`);
    notes.dataset.presenceTarget = `note-page:${page.id}:content`;
    dialog.dataset.presenceTarget = `note-page:${page.id}`;
    summary.textContent = summaryText();
    renderTabs();
    renderIndex();
    renderEditorLinks();
    notesAutosave?.reset({ pageId: page.id, content: page.content });
}

toggle.addEventListener("click", () => {
    noteEditor.setValue(currentPage().content);
    openModal(dialog);
    if (!store.readOnly) notes.focus();
});

tabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[role=tab]");
    if (tab) selectPage(tab.dataset.pageId);
});

tabs.addEventListener("keydown", async (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const allTabs = [...tabs.querySelectorAll("[role=tab]")];
    const current = allTabs.indexOf(document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    let next = event.key === "Home" ? 0 : event.key === "End" ? allTabs.length - 1 : current;
    if (event.key === "ArrowLeft") next = (current - 1 + allTabs.length) % allTabs.length;
    if (event.key === "ArrowRight") next = (current + 1) % allTabs.length;
    await selectPage(allTabs[next].dataset.pageId, { focus: false });
    tabs.querySelector(`[data-page-id="${CSS.escape(allTabs[next].dataset.pageId)}"]`)?.focus();
});

addPageButton.addEventListener("click", async () => {
    if (store.readOnly) return;
    await notesAutosave.flush("page-action");
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
    await derivedPlanOperation(() => insertEntityIntent(
        { type: "note-page", id: page.id },
        page,
    ));
    store.activeTripNotePageId = page.id;
    saveLocalPreferences();
    syncTripNotes();
    notes.focus();
});

renamePageButton.addEventListener("click", async () => {
    if (store.readOnly) return;
    await notesAutosave.flush("page-action");
    const page = currentPage();
    const title = await promptAction({
        title: "Renombrar página",
        message: `Nombre actual: ${page.title}`,
        confirmLabel: "Guardar nombre",
        inputLabel: "Nuevo nombre",
        inputPlaceholder: page.title,
    });
    if (title === null) return;
    const nextTitle = title.trim().slice(0, 50) || page.title;
    await derivedPlanOperation((document) => setFieldIntent(
        document,
        { type: "note-page", id: page.id, field: "title" },
        nextTitle,
    ));
    syncTripNotes();
});

deletePageButton.addEventListener("click", async () => {
    if (store.readOnly) return;
    await notesAutosave.flush("page-action");
    if (store.tripNotePages.length === 1) return;
    const page = currentPage();
    const accepted = await confirmAction({
        title: "Eliminar página",
        message: `¿Eliminar “${page.title}” y todo su contenido?`,
        confirmLabel: "Eliminar página",
    });
    if (!accepted) return;
    const indexToDelete = store.tripNotePages.findIndex((item) => item.id === page.id);
    const nextPageId = store.tripNotePages.filter((item) => item.id !== page.id)
        [Math.min(indexToDelete, store.tripNotePages.length - 2)].id;
    await derivedPlanOperation((document) => deleteEntityIntent(
        document,
        { type: "note-page", id: page.id },
    ));
    store.activeTripNotePageId = nextPageId;
    saveLocalPreferences();
    syncTripNotes();
});

const noteEditor = createNoteEditor(notes, {
    readOnly: () => store.readOnly,
    onInput: () => { renderIndex(); renderEditorLinks(); },
});

notesAutosave = createDraftAutosaveController({
    root: notes,
    read: () => ({ pageId: currentPage().id, content: noteEditor.value }),
    disabled: () => store.readOnly,
    debounceMs: 450,
    commit: ({ pageId, content }) => derivedPlanOperation((document) => setFieldIntent(
        document,
        { type: "note-page", id: pageId, field: "content" },
        content,
    ), { undo: false }),
    onState: ({ state }) => {
        if (state === "dirty" || state === "saving") {
            clearTimeout(statusTimer);
            status.textContent = "Guardando…";
        }
        if (state === "error") status.textContent = "No se pudo guardar";
        if (state === "saved") {
            summary.textContent = summaryText();
            renderIndex();
            renderEditorLinks();
            status.textContent = "Guardado";
            clearTimeout(statusTimer);
            statusTimer = setTimeout(() => { status.textContent = ""; }, 900);
        }
    },
});

index.addEventListener("click", (event) => {
    const link = event.target.closest("a");
    if (!link) return;
    event.preventDefault();
    jumpToHeading(link);
});

syncTripNotes();
