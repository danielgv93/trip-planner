// A small, domain-neutral chooser: a titled list of options shown either at a
// pointer position (context menu) or centred over a backdrop (e.g. after a
// paste). Callers own what the options mean.

let current = null;

export function closeChoiceMenu() {
    current?.close();
}

export function openChoiceMenu({ title, items, anchor = null, onSelect, onClose = null }) {
    closeChoiceMenu();
    const previousFocus = document.activeElement;
    const openedAt = Date.now();
    const root = document.createElement("div");
    root.className = anchor ? "choice-menu-root" : "choice-menu-root is-centered";
    const menu = document.createElement("div");
    menu.className = "choice-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", title);
    const heading = document.createElement("div");
    heading.className = "choice-menu-title";
    heading.textContent = title;
    menu.append(heading);

    const buttons = items.map((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "choice-menu-item";
        button.setAttribute("role", "menuitem");
        if (item.tone) button.dataset.tone = item.tone;
        const label = document.createElement("span");
        label.className = "choice-menu-label";
        label.textContent = item.label;
        button.append(label);
        if (item.detail) {
            const detail = document.createElement("small");
            detail.textContent = item.detail;
            button.append(detail);
        }
        button.addEventListener("click", () => {
            // The finger that triggered a long press can lift right over an
            // option; ignore the click that lift may synthesize.
            if (Date.now() - openedAt < 350) return;
            close({ restoreFocus: false });
            onSelect(item.value);
        });
        menu.append(button);
        return button;
    });
    root.append(menu);
    document.body.append(root);

    if (anchor) {
        const margin = 8;
        const { innerWidth, innerHeight } = window;
        const box = menu.getBoundingClientRect();
        const left = Math.max(margin, Math.min(anchor.x, innerWidth - box.width - margin));
        const top = Math.max(margin, Math.min(anchor.y, innerHeight - box.height - margin));
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    }

    const onPointerDown = (event) => {
        if (!menu.contains(event.target)) close();
    };
    const onKeyDown = (event) => {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const index = buttons.indexOf(document.activeElement);
            const step = event.key === "ArrowDown" ? 1 : -1;
            buttons[(index + step + buttons.length) % buttons.length]?.focus();
        }
    };
    const onViewportChange = () => close();
    // Capture so the first outside click only dismisses the menu.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("blur", onViewportChange);

    function close({ restoreFocus = true } = {}) {
        if (current !== handle) return;
        current = null;
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("keydown", onKeyDown, true);
        window.removeEventListener("resize", onViewportChange);
        window.removeEventListener("blur", onViewportChange);
        root.remove();
        if (restoreFocus && previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
        onClose?.();
    }

    const handle = { close };
    current = handle;
    buttons[0]?.focus({ preventScroll: true });
    return handle;
}
