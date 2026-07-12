import { store, save } from "./store.js";
import { $, esc } from "./dom.js";

const notes = $("#tripNotes");
const toggle = $("#tripNotesToggle");
const dialog = $("#tripNotesDialog");
const summary = $("#tripNotesSummary");
const status = $("#tripNotesStatus");
const modeButton = $("#tripNotesMode");
const preview = $("#tripNotesPreview");
let statusTimer;

function summaryText() {
    const clean = store.tripNotes.replace(/\s+/g, " ").trim();
    return clean || "Reservas, enlaces y recordatorios";
}

function inlineMarkdown(value) {
    let html = esc(value);
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    html = html.replace(/(^|\s)\*([^*\n]+)\*/g, "$1<em>$2</em>");
    return html;
}

function markdownToHtml(source) {
    if (!source.trim()) return '<p class="trip-notes-preview-empty">Todavía no hay notas.</p>';
    const lines = source.replace(/\r/g, "").split("\n");
    const output = [];
    let list = null;
    const closeList = () => {
        if (list) output.push(`</${list}>`);
        list = null;
    };
    for (const line of lines) {
        const heading = line.match(/^(#{1,3})\s+(.+)$/);
        const bullet = line.match(/^\s*[-*]\s+(.+)$/);
        const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
        if (heading) {
            closeList();
            const level = heading[1].length;
            output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
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

function showMode(mode) {
    const writing = mode === "write";
    notes.hidden = !writing;
    preview.hidden = writing;
    modeButton.setAttribute("aria-pressed", String(!writing));
    modeButton.textContent = writing ? "Previsualizar" : "Seguir editando";
    if (writing) notes.focus();
    else preview.innerHTML = markdownToHtml(store.tripNotes);
}

export function syncTripNotes() {
    notes.value = store.tripNotes;
    summary.textContent = summaryText();
    preview.innerHTML = markdownToHtml(store.tripNotes);
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

notes.addEventListener("input", () => {
    store.tripNotes = notes.value;
    summary.textContent = summaryText();
    save();
    status.textContent = "Guardando…";
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
        status.textContent = "Guardado";
    }, 350);
});

notes.addEventListener("blur", () => {
    status.textContent = store.tripNotes ? "Guardado" : "";
});

modeButton.addEventListener("click", () => {
    showMode(notes.hidden ? "write" : "preview");
});

syncTripNotes();
