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

function anchorHtml(label, href, auto = false) {
    const safe = safeHref(href.replaceAll("\uE000", ""));
    if (!safe) return escapeHtml(label);
    return `<a${auto ? ' data-autolink="true"' : ""} href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
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
        return `${token(anchorHtml(href, href, true))}${suffix}`;
    });

    let html = escapeHtml(text);
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    html = html.replace(/(^|\s)\*([^*\n]+)\*/g, "$1<em>$2</em>");
    html = html.replace(/(^|\s)_([^_\n]+)_/g, "$1<em>$2</em>");
    html = html.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
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

function plainHeadingText(value) {
    return value
        .replace(/\s+#+\s*$/, "")
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[*_~`]/g, "")
        .trim();
}

export function noteHeadings(source) {
    const headings = [];
    const lines = source.replace(/\r/g, "").split("\n");
    let offset = 0;
    let fenced = false;
    for (const line of lines) {
        if (/^```/.test(line)) { fenced = !fenced; offset += line.length + 1; continue; }
        if (fenced) { offset += line.length + 1; continue; }
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


// One block per source line preserves blank lines and Markdown on edit.
export function markdownToHtml(source) {
    const lines = source.replace(/\r/g, "").split("\n");
    const output = [];
    let list = null;
    let headingIndex = 0;
    const closeList = () => {
        if (list) output.push(`</${list}>`);
        list = null;
    };
    const block = (tag, prefix, text, attrs = "") =>
        `<${tag} data-prefix="${escapeHtml(prefix)}"${attrs}>${inlineMarkdown(text) || "<br>"}</${tag}>`;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fence = line.match(/^```([\w-]*)\s*(\uE000)?$/);
        const heading = line.match(/^(#{1,6}\s)(.*)$/);
        const bullet = line.match(/^(\s*[-*+]\s)(.*)$/);
        const ordered = line.match(/^(\s*\d+[.)]\s)(.*)$/);
        const quote = line.match(/^(>\s)(.*)$/);
        if (fence) {
            closeList();
            const code = [];
            while (i + 1 < lines.length && !/^```\s*\uE000?$/.test(lines[i + 1])) code.push(lines[++i]);
            const closed = i + 1 < lines.length;
            if (closed && lines[++i].includes("\uE000")) {
                if (code.length) code[code.length - 1] += "\uE000";
                else code.push("\uE000");
            }
            if (fence[2]) code.unshift("\uE000");
            output.push(`<pre data-language="${escapeHtml(fence[1])}" data-closed="${closed}"><code>${escapeHtml(code.join("\n")) || "<br>"}</code></pre>`);
        } else if (heading) {
            closeList();
            const level = heading[1].trim().length;
            const text = heading[2].replace(/\s+#+\s*$/, "");
            const headingId = plainHeadingText(text.replaceAll("\uE000", "")) ? ` id="trip-note-heading-${++headingIndex}"` : "";
            output.push(block(`h${level}`, heading[1], text, headingId));
        } else if (bullet || ordered) {
            const type = bullet ? "ul" : "ol";
            const match = bullet || ordered;
            if (list !== type) {
                closeList();
                const start = ordered ? ` start="${Number.parseInt(match[1], 10)}"` : "";
                output.push(`<${type}${start}>`);
                list = type;
            }
            output.push(block("li", match[1], match[2]));
        } else {
            closeList();
            if (/^(?:---+|\*\*\*+|___+)\uE000?$/.test(line)) {
                output.push(block("p", line.replaceAll("\uE000", ""), line.includes("\uE000") ? "\uE000" : "", ' class="trip-notes-rule"'));
            } else output.push(block(quote ? "blockquote" : "p", quote?.[1] || "", quote?.[2] ?? line));
        }
    }
    closeList();
    return output.join("");
}
