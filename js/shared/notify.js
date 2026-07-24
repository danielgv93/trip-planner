// Transient UI feedback: toasts and the styled confirm() replacement.

import { $ } from "./dom.js";

const confirmDialog = $("#confirmDialog");

function renderChangePreview(preview) {
    const root = $("#confirmPreview");
    root.replaceChildren();
    root.hidden = !preview;
    if (!preview) return;

    const stats = document.createElement("div");
    stats.className = "change-preview-stats";
    for (const stat of preview.stats || []) {
        const item = document.createElement("span");
        item.className = "change-preview-stat";
        item.dataset.tone = stat.tone;
        const value = document.createElement("strong");
        value.textContent = String(stat.value);
        const label = document.createElement("small");
        label.textContent = stat.label;
        item.append(value, label);
        stats.append(item);
    }

    const list = document.createElement("div");
    list.className = "change-preview-list";
    const marks = { add: "+", modify: "~", remove: "−" };
    for (const group of preview.groups || []) {
        const item = document.createElement("div");
        item.className = "change-preview-group";
        item.dataset.tone = group.tone;
        const mark = document.createElement("span");
        mark.className = "change-preview-mark";
        mark.textContent = marks[group.tone] || "·";
        mark.setAttribute("aria-hidden", "true");
        const copy = document.createElement("span");
        copy.className = "change-preview-copy";
        const title = document.createElement("strong");
        title.textContent = group.title;
        copy.append(title);
        if (group.changes?.length) {
            const details = document.createElement("span");
            details.className = "change-preview-details";
            for (const change of group.changes) {
                const row = document.createElement("small");
                row.className = "change-preview-detail";
                const label = document.createElement("b");
                label.textContent = `${change.label}:`;
                const before = document.createElement("span");
                before.className = "change-preview-before";
                before.textContent = change.before;
                const arrow = document.createElement("span");
                arrow.className = "change-preview-arrow";
                arrow.textContent = "→";
                arrow.setAttribute("aria-label", "cambia a");
                const after = document.createElement("span");
                after.className = "change-preview-after";
                after.textContent = change.after;
                row.append(label, before, arrow, after);
                details.append(row);
            }
            copy.append(details);
        } else {
            const detail = document.createElement("small");
            detail.className = "change-preview-summary";
            detail.textContent = group.detail;
            copy.append(detail);
        }
        item.append(mark, copy);
        list.append(item);
    }
    root.append(stats, list);
}

export function toast(message, type = "info", ms = 3400) {
    const el = document.createElement("div");
    el.className = "toast toast-" + type;
    el.setAttribute("role", "status");
    el.textContent = message;
    $("#toasts").append(el);
    requestAnimationFrame(() => el.classList.add("show"));
    const remove = () => {
        clearTimeout(timer);
        el.classList.remove("show");
        el.addEventListener("transitionend", () => el.remove(), {
            once: true,
        });
    };
    const timer = setTimeout(remove, ms);
    el.addEventListener("click", remove);
}

// Styled replacement for the native confirm(): resolves to true only when the
// user presses the confirm button; ESC, backdrop, cancel and the × all resolve
// to false.
export function confirmAction({ title, message, confirmLabel = "Eliminar" }) {
    return new Promise((resolve) => {
        renderChangePreview(null);
        $("#confirmInputField").hidden = true;
        $("#confirmInput").value = "";
        $("#confirmTitle").textContent = title;
        $("#confirmMsg").textContent = message;
        $("#confirmOk").textContent = confirmLabel;
        let result = false;
        $("#confirmOk").onclick = () => {
            result = true;
            confirmDialog.close();
        };
        confirmDialog.onclose = () => {
            $("#confirmOk").onclick = null;
            confirmDialog.onclose = null;
            resolve(result);
        };
        confirmDialog.showModal();
    });
}

// Confirmation variant with a single optional text value. Cancel/ESC/backdrop
// resolve to null; confirming an empty field resolves to an empty string so the
// caller can apply its own default.
export function promptAction({
    title,
    message,
    confirmLabel,
    inputLabel,
    inputPlaceholder = "",
    preview = null,
}) {
    return new Promise((resolve) => {
        const field = $("#confirmInputField");
        const input = $("#confirmInput");
        field.hidden = false;
        $("#confirmInputLabel").textContent = inputLabel;
        input.value = "";
        input.placeholder = inputPlaceholder;
        renderChangePreview(preview);
        $("#confirmTitle").textContent = title;
        $("#confirmMsg").textContent = message;
        $("#confirmOk").textContent = confirmLabel;
        let result = null;
        $("#confirmOk").onclick = () => {
            result = input.value.trim();
            confirmDialog.close();
        };
        input.onkeydown = (event) => {
            if (event.key !== "Enter" || event.isComposing) return;
            event.preventDefault();
            $("#confirmOk").click();
        };
        confirmDialog.onclose = () => {
            $("#confirmOk").onclick = null;
            input.onkeydown = null;
            confirmDialog.onclose = null;
            field.hidden = true;
            renderChangePreview(null);
            resolve(result);
        };
        confirmDialog.showModal();
        input.focus();
    });
}

$("#confirmCancel").onclick = $("#confirmClose").onclick = () =>
    confirmDialog.close();
confirmDialog.addEventListener("click", (event) => {
    if (event.target === confirmDialog) confirmDialog.close();
});
