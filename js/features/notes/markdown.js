function escapeHtml(value = "") {
    return value.replace(
        /[&<>'"]/g,
        (character) =>
            ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                "'": "&#39;",
                '"': "&quot;",
            })[character],
    );
}

function trimUrlEnd(value) {
    let url = value.replace(/[.,;:!?]+$/g, "");
    while (url.endsWith(")") && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length) {
        url = url.slice(0, -1);
    }
    return url;
}

function safeHref(value) {
    const href = value.startsWith("www.") ? `https://${value}` : value;
    return /^(?:https?:\/\/|mailto:)/i.test(href) ? href : "";
}

function anchorHtml(label, href) {
    const safe = safeHref(href);
    if (!safe) return escapeHtml(label);
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

export function inlineMarkdown(value) {
    const tokens = [];
    const token = (html) => {
        const marker = `\u0000${tokens.length}\u0000`;
        tokens.push(html);
        return marker;
    };

    let text = value.replace(/`([^`]+)`/g, (_, code) => token(`<code>${escapeHtml(code)}</code>`));
    text = text.replace(
        /\[([^\]]+)\]\(((?:https?:\/\/|mailto:|www\.)[^\s)]+)\)/gi,
        (_, label, href) => token(anchorHtml(label, href)),
    );
    text = text.replace(/(?:https?:\/\/|www\.)[^\s<>"'\u0000]+/gi, (candidate) => {
        const href = trimUrlEnd(candidate);
        const suffix = candidate.slice(href.length);
        return `${token(anchorHtml(href, href))}${suffix}`;
    });

    let html = escapeHtml(text);
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    html = html.replace(/(^|\s)\*([^*\n]+)\*/g, "$1<em>$2</em>");
    return html.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
}

export function extractNoteLinks(source) {
    const links = [];
    const seen = new Set();
    const add = (label, rawHref) => {
        const href = safeHref(trimUrlEnd(rawHref));
        if (!href || seen.has(href)) return;
        seen.add(href);
        links.push({ href, label: label || rawHref });
    };

    const remaining = source.replace(/`[^`]*`/g, (code) => " ".repeat(code.length));
    const linkPattern =
        /\[([^\]]+)\]\(((?:https?:\/\/|mailto:|www\.)[^\s)]+)\)|((?:https?:\/\/|www\.)[^\s<>"']+)/gi;
    for (const match of remaining.matchAll(linkPattern)) {
        if (match[1]) add(match[1], match[2]);
        else add(match[3], match[3]);
    }
    return links;
}
