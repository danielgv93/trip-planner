// Show/hide toggle for password inputs. Delegated so it also covers fields
// rendered after load; the button lives inside `.password-field` next to its
// input, which is the element whose type we flip.

function toggle(button) {
    const input = button.closest(".password-field")?.querySelector("input");
    if (!input) return;
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    button.setAttribute("aria-pressed", String(reveal));
    const label = reveal ? "Ocultar contraseña" : "Mostrar contraseña";
    button.setAttribute("aria-label", label);
    button.title = label;
}

document.addEventListener("click", (event) => {
    const button = event.target.closest(".password-reveal");
    if (button) toggle(button);
});

// A reset (logout, successful submit) restores the value, so hide it again.
document.addEventListener("reset", (event) => {
    event.target.querySelectorAll?.(".password-reveal[aria-pressed='true']").forEach(toggle);
});
