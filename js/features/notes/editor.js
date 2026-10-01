import { markdownToHtml } from "./markdown.js";

// The document stays portable Markdown; the DOM is only its editable projection.
const CARET = "\uE000";
const LIMIT = 5000;

function inlineSource(node) {
    if (node.nodeType === 3) return node.data.replace(/\u00a0/g, " ").replaceAll("\u200B", "");
    const text = [...node.childNodes].map(inlineSource).join("");
    if (["STRONG", "B", "EM", "I", "S", "DEL", "CODE"].includes(node.nodeName)
        && !text.replaceAll(CARET, "")) return text;
    switch (node.nodeName) {
        case "BR": return node.dataset.softBreak ? "\n" : "";
        case "STRONG": case "B": return `**${text}**`;
        case "EM": case "I": return `*${text}*`;
        case "S": case "DEL": return `~~${text}~~`;
        case "CODE": return `\`${text}\``;
        case "A": return node.dataset.autolink ? text : `[${text}](${node.getAttribute("href")})`;
        case "DIV": case "P": return `\n${text}`;
        default: return text;
    }
}

export function editorSource(root) {
    const blocks = [];
    function visit(node) {
        if (node.nodeType === 3) { blocks.push(node.data.replaceAll("\u200B", "")); return; }
        if (node.matches("ul, ol")) { [...node.children].forEach(visit); return; }
        if (node.matches("pre")) {
            blocks.push(`\`\`\`${node.dataset.language || ""}\n${node.textContent.replaceAll("\u200B", "")}${node.dataset.closed === "true" ? "\n```" : ""}`);
            return;
        }
        const prefix = node.dataset.prefix ?? (node.matches("li") ? "- " : "");
        blocks.push(prefix + [...node.childNodes].map(inlineSource).join(""));
    }
    [...root.childNodes].forEach(visit);
    return blocks.join("\n");
}

function pathTo(root, node) {
    const path = [];
    while (node !== root) {
        path.unshift([...node.parentNode.childNodes].indexOf(node));
        node = node.parentNode;
    }
    return path;
}

export function createNoteEditor(root, { readOnly = () => false, onInput = () => {} } = {}) {
    let source = "";
    let composing = false;
    let undo = [];
    let redo = [];

    function selectedSource() {
        const selection = window.getSelection();
        if (!selection.rangeCount || !root.contains(selection.anchorNode)) return source;
        const range = selection.getRangeAt(0);
        const clone = root.cloneNode(true);
        const path = pathTo(root, range.endContainer);
        const container = path.reduce((node, index) => node.childNodes[index], clone);
        const bookmark = document.createRange();
        bookmark.setStart(container, range.endOffset);
        bookmark.collapse(true);
        bookmark.insertNode(document.createTextNode(CARET));
        return editorSource(clone);
    }

    function paint(value) {
        const scrollTop = root.scrollTop;
        root.innerHTML = markdownToHtml(value);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            const offset = node.data.indexOf(CARET);
            if (offset < 0) continue;
            node.replaceData(offset, 1, "\u200B");
            const range = document.createRange();
            if (!node.parentElement.textContent.replaceAll("\u200B", "") && !node.parentElement.querySelector("br")) {
                node.parentElement.append(document.createElement("br"));
            }
            range.setStart(node, offset + 1);
            range.collapse(true);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            break;
        }
        root.scrollTop = scrollTop;
    }

    function remember() {
        undo.push(selectedSource());
        if (undo.length > 100) undo.shift();
        redo = [];
    }

    function update(value = selectedSource()) {
        const next = value.replaceAll(CARET, "");
        if (next.length > LIMIT) { paint(source + CARET); return; }
        source = next;
        paint(value);
        onInput(source);
    }

    function removeCaretPadding() {
        const selection = window.getSelection();
        if (!selection.rangeCount) return;
        const range = selection.getRangeAt(0);
        const points = [
            [range.startContainer, range.startOffset],
            [range.endContainer, range.endOffset],
        ].map(([node, offset]) => [node, node.nodeType === 3
            ? node.data.slice(0, offset).replaceAll("\u200B", "").length : offset]);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) node.data = node.data.replaceAll("\u200B", "");
        range.setStart(...points[0]);
        range.setEnd(...points[1]);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    function insert(text) {
        const selection = window.getSelection();
        if (!selection.rangeCount || !root.contains(selection.anchorNode)) return;
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        update();
        root.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function history(backwards) {
        const from = backwards ? undo : redo;
        const to = backwards ? redo : undo;
        if (!from.length) return;
        to.push(selectedSource());
        update(from.pop());
        root.dispatchEvent(new Event("input", { bubbles: true }));
    }

    root.addEventListener("beforeinput", (event) => {
        if (readOnly()) { event.preventDefault(); return; }
        if (["insertParagraph", "insertLineBreak"].includes(event.inputType)) {
            handleEditingKey({ key: "Enter", shiftKey: event.inputType === "insertLineBreak", preventDefault: () => event.preventDefault() });
            return;
        }
        if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
            event.preventDefault();
            history(event.inputType === "historyUndo");
        } else if (!composing) {
            remember();
            if (event.inputType.startsWith("delete")) removeCaretPadding();
        }
    });
    root.addEventListener("input", () => {
        if (readOnly()) { paint(source); return; }
        if (!composing) update();
    });
    root.addEventListener("compositionstart", () => { remember(); removeCaretPadding(); composing = true; });
    root.addEventListener("compositionend", () => {
        composing = false;
        if (!readOnly()) {
            update();
            root.dispatchEvent(new Event("input", { bubbles: true }));
        }
    });
    root.addEventListener("paste", (event) => {
        event.preventDefault();
        if (readOnly()) return;
        remember();
        insert(event.clipboardData.getData("text/plain").replaceAll(CARET, ""));
    });
    root.addEventListener("drop", (event) => event.preventDefault());
    function handleEditingKey(event) {
        if (readOnly() || composing) return;
        if ((event.metaKey || event.ctrlKey) && ["z", "y"].includes(event.key.toLowerCase())) {
            event.preventDefault();
            history(event.key.toLowerCase() === "z" && !event.shiftKey);
            return;
        }
        const selection = window.getSelection();
        if (!selection.rangeCount) return;
        const node = selection.anchorNode;
        const block = (node.nodeType === 1 ? node : node.parentElement).closest("[data-prefix], pre");
        if (!block || !root.contains(block)) return;
        const range = selection.getRangeAt(0);
        const before = range.cloneRange();
        before.selectNodeContents(block);
        before.setEnd(range.startContainer, range.startOffset);
        if (event.key === "Backspace" && selection.isCollapsed && !before.toString().replaceAll("\u200B", "") && block.dataset.prefix) {
            event.preventDefault();
            remember();
            block.dataset.prefix = "";
            update();
            root.dispatchEvent(new Event("input", { bubbles: true }));
        }
        if (event.key !== "Enter") return;
        event.preventDefault();
        remember();
        if (block.matches("pre")) {
            if (selection.isCollapsed && block.textContent.replaceAll("\u200B", "").endsWith("\n")
                && before.toString().replaceAll("\u200B", "") === block.textContent.replaceAll("\u200B", "")) {
                block.textContent = block.textContent.replaceAll("\u200B", "").slice(0, -1);
                block.dataset.closed = "true";
                const paragraph = document.createElement("p");
                paragraph.dataset.prefix = "";
                paragraph.textContent = CARET;
                block.after(paragraph);
                update(editorSource(root));
                root.dispatchEvent(new Event("input", { bubbles: true }));
            } else insert("\n");
            return;
        }
        if (event.shiftKey) { insert("\n"); return; }
        if (block.dataset.prefix && !block.textContent.replaceAll("\u200B", "").trim()) {
            block.dataset.prefix = "";
            update();
            root.dispatchEvent(new Event("input", { bubbles: true }));
            return;
        }
        let prefix = block.dataset.prefix || "";
        if (/^#{1,6} /.test(prefix)) prefix = "";
        prefix = prefix.replace(/(\d+)([.)]\s)/, (_, number, ending) => `${Number(number) + 1}${ending}`);
        // Split the inline DOM as well, so Enter inside bold/code keeps each
        // side formatted instead of putting a newline inside its delimiters.
        if (selection.isCollapsed) {
            const after = range.cloneRange();
            after.selectNodeContents(block);
            after.setStart(range.endContainer, range.endOffset);
            const first = document.createElement("p");
            first.dataset.prefix = block.dataset.prefix || "";
            first.append(before.cloneContents());
            const second = document.createElement("p");
            second.dataset.prefix = prefix;
            second.append(document.createTextNode(CARET), after.cloneContents());
            block.replaceWith(first, second);
            update(editorSource(root));
            root.dispatchEvent(new Event("input", { bubbles: true }));
        } else insert(`\n${prefix}`);
    }
    root.addEventListener("keydown", handleEditingKey);
    root.addEventListener("click", (event) => {
        const link = event.target.closest("a");
        if (link && !readOnly() && !event.metaKey && !event.ctrlKey) event.preventDefault();
    });
    return {
        get value() { return source; },
        setValue(value) {
            root.contentEditable = String(!readOnly());
            root.setAttribute("aria-readonly", String(readOnly()));
            if (value === source && root.childNodes.length) return;
            source = value;
            undo = [];
            redo = [];
            paint(value);
        },
    };
}
