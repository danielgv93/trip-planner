// A small, domain-neutral chooser: a titled list of options shown either at a
// pointer position (context menu) or centred over a backdrop (e.g. after a
// paste). Callers own what the options mean. Long option sets can go in
// `grid`: compact cells whose full name is shown in a caption on hover/focus.

let current = null;

const ARROW_KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"]);

export function closeChoiceMenu() {
    current?.close();
}

export function openChoiceMenu({ title, items, grid = [], anchor = null, onSelect, onClose = null }) {
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

    const choose = (item) => {
        // The finger that triggered a long press can lift right over an
        // option; ignore the click that lift may synthesize.
        if (Date.now() - openedAt < 350) return;
        close({ restoreFocus: false });
        onSelect(item.value);
    };

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
        button.addEventListener("click", () => choose(item));
        menu.append(button);
        return button;
    });

    let gridBox = null;
    if (grid.length) {
        gridBox = document.createElement("div");
        gridBox.className = "choice-menu-grid";
        gridBox.setAttribute("role", "group");
        const caption = document.createElement("div");
        caption.className = "choice-menu-caption";
        caption.setAttribute("aria-hidden", "true");
        const showCaption = (text) => {
            caption.textContent = text || "\u00a0";
        };
        showCaption("");
        for (const item of grid) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "choice-menu-cell";
            button.setAttribute("role", "menuitem");
            button.setAttribute("aria-label", item.label);
            const label = document.createElement("span");
            label.textContent = item.short;
            button.append(label);
            if (item.detail) {
                const detail = document.createElement("small");
                detail.textContent = item.detail;
                button.append(detail);
            }
            button.addEventListener("pointerenter", () => showCaption(item.label));
            button.addEventListener("focus", () => showCaption(item.label));
            button.addEventListener("click", () => choose(item));
            gridBox.append(button);
            buttons.push(button);
        }
        gridBox.addEventListener("pointerleave", () => {
            showCaption(gridBox.contains(document.activeElement) ? document.activeElement.getAttribute("aria-label") : "");
        });
        menu.append(gridBox, caption);
    }
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
        } else if (ARROW_KEYS.has(event.key)) {
            event.preventDefault();
            const index = buttons.indexOf(document.activeElement);
            const next = index < 0 ? 0 : (index + arrowStep(event.key, index) + buttons.length) % buttons.length;
            buttons[next]?.focus();
        }
    };
    // Inside the grid, up/down move a whole row; elsewhere every arrow steps
    // through the options in order.
    const arrowStep = (key, index) => {
        const forward = key === "ArrowDown" || key === "ArrowRight";
        const inGrid = gridBox?.contains(buttons[index]);
        if (!inGrid || key === "ArrowLeft" || key === "ArrowRight") return forward ? 1 : -1;
        const columns = getComputedStyle(gridBox).gridTemplateColumns.split(" ").length;
        const firstCell = items.length;
        const target = index + (forward ? columns : -columns);
        if (target < firstCell) return firstCell - 1 - index;
        if (target >= buttons.length) return buttons.length - index;
        return target - index;
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
