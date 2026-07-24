export const DEFAULT_NOTE_PAGE_ID = "notes-general";

export function defaultTripNotePages(content = "") {
    return [{
        id: DEFAULT_NOTE_PAGE_ID,
        title: "General",
        content: typeof content === "string" ? content : "",
    }];
}

export function normalizeTripNotePages(value, { legacyNotes = "", strict = false } = {}) {
    if (!Array.isArray(value) || value.length === 0) {
        return defaultTripNotePages(legacyNotes);
    }

    const seen = new Set();
    const pages = [];
    for (const [index, page] of value.entries()) {
        const valid =
            page &&
            typeof page === "object" &&
            !Array.isArray(page) &&
            typeof page.id === "string" &&
            page.id &&
            typeof page.title === "string" &&
            typeof page.content === "string" &&
            !seen.has(page.id);
        if (!valid) {
            if (strict) throw new Error("INVALID_PLAN");
            continue;
        }
        seen.add(page.id);
        pages.push({
            id: page.id,
            title: page.title.trim().slice(0, 50) || `Página ${index + 1}`,
            content: page.content.slice(0, 5000),
        });
    }

    return pages.length ? pages : defaultTripNotePages(legacyNotes);
}

export function activeTripNotePage(pages, activeId) {
    return pages.find((page) => page.id === activeId) || pages[0];
}
