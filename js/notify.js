// Transient UI feedback: toasts and the styled confirm() replacement.

import { $ } from "./dom.js";

const confirmDialog = $("#confirmDialog");

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

$("#confirmCancel").onclick = $("#confirmClose").onclick = () =>
    confirmDialog.close();
