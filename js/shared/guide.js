const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
}

export function placeGuideCard({
    target,
    card,
    viewport,
    preferred = "bottom",
    gap = 14,
    margin = 16,
}) {
    const placements = {
        bottom: {
            top: target.bottom + gap,
            left: target.left + (target.width - card.width) / 2,
        },
        top: {
            top: target.top - card.height - gap,
            left: target.left + (target.width - card.width) / 2,
        },
        right: {
            top: target.top + (target.height - card.height) / 2,
            left: target.right + gap,
        },
        left: {
            top: target.top + (target.height - card.height) / 2,
            left: target.left - card.width - gap,
        },
    };
    const order = [preferred, "bottom", "top", "right", "left"]
        .filter((placement, index, all) => all.indexOf(placement) === index);
    const overflow = ({ top, left }) =>
        Math.max(0, margin - left) +
        Math.max(0, left + card.width + margin - viewport.width) +
        Math.max(0, margin - top) +
        Math.max(0, top + card.height + margin - viewport.height);
    const placement = order.reduce((best, candidate) =>
        overflow(placements[candidate]) < overflow(placements[best])
            ? candidate
            : best,
    );
    return {
        placement,
        top: clamp(placements[placement].top, margin, viewport.height - card.height - margin),
        left: clamp(placements[placement].left, margin, viewport.width - card.width - margin),
    };
}

function resolveTarget(step) {
    if (typeof step.target === "function") return step.target();
    if (step.target instanceof Element) return step.target;
    return document.querySelector(step.target);
}

function isUsableTarget(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

export class Guide {
    constructor({ steps, label = "Guía", onFinish } = {}) {
        this.steps = steps || [];
        this.label = label;
        this.onFinish = onFinish;
        this.index = -1;
        this.target = null;
        this.returnFocus = null;
        this.handleKeydown = this.handleKeydown.bind(this);
        this.reposition = this.reposition.bind(this);
        this.build();
    }

    build() {
        this.root = document.createElement("div");
        this.root.className = "guide";
        this.root.hidden = true;
        this.root.innerHTML = `
            <div class="guide-shade" data-guide-shade="top"></div>
            <div class="guide-shade" data-guide-shade="right"></div>
            <div class="guide-shade" data-guide-shade="bottom"></div>
            <div class="guide-shade" data-guide-shade="left"></div>
            <section class="guide-card" role="dialog" aria-modal="true" aria-labelledby="guideTitle" aria-describedby="guideText">
                <div class="guide-card-head">
                    <span class="guide-kicker"></span>
                    <button class="guide-close" type="button" aria-label="Cerrar guía">×</button>
                </div>
                <h2 id="guideTitle"></h2>
                <p id="guideText"></p>
                <div class="guide-progress" aria-hidden="true"></div>
                <div class="guide-actions">
                    <button class="guide-skip" type="button">Salir</button>
                    <span>
                        <button class="guide-back" type="button">Anterior</button>
                        <button class="guide-next" type="button">Siguiente</button>
                    </span>
                </div>
            </section>`;
        document.body.append(this.root);
        this.card = this.root.querySelector(".guide-card");
        this.kicker = this.root.querySelector(".guide-kicker");
        this.title = this.root.querySelector("h2");
        this.text = this.root.querySelector("p");
        this.progress = this.root.querySelector(".guide-progress");
        this.back = this.root.querySelector(".guide-back");
        this.next = this.root.querySelector(".guide-next");
        this.root.querySelector(".guide-close").onclick = () => this.stop("dismissed");
        this.root.querySelector(".guide-skip").onclick = () => this.stop("dismissed");
        this.back.onclick = () => this.show(this.index - 1, -1);
        this.next.onclick = () => {
            if (this.index >= this.steps.length - 1) this.stop("completed");
            else this.show(this.index + 1, 1);
        };
    }

    start(startAt = 0) {
        if (!this.steps.length || !this.root.hidden) return;
        this.returnFocus = document.activeElement;
        this.root.hidden = false;
        document.body.classList.add("guide-open");
        document.addEventListener("keydown", this.handleKeydown);
        window.addEventListener("resize", this.reposition);
        window.addEventListener("scroll", this.reposition, true);
        this.show(startAt, 1);
    }

    stop(reason = "dismissed") {
        if (this.root.hidden) return;
        this.target?.classList.remove("guide-target");
        this.target = null;
        this.root.hidden = true;
        document.body.classList.remove("guide-open");
        document.removeEventListener("keydown", this.handleKeydown);
        window.removeEventListener("resize", this.reposition);
        window.removeEventListener("scroll", this.reposition, true);
        if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
        this.onFinish?.({ reason, index: this.index });
    }

    async show(index, direction = 1) {
        let nextIndex = index;
        let target;
        while (nextIndex >= 0 && nextIndex < this.steps.length) {
            target = resolveTarget(this.steps[nextIndex]);
            if (isUsableTarget(target)) break;
            nextIndex += direction;
        }
        if (nextIndex < 0) return this.show(0, 1);
        if (nextIndex >= this.steps.length) return this.stop("completed");

        this.target?.classList.remove("guide-target");
        this.index = nextIndex;
        this.target = target;
        const step = this.steps[this.index];
        this.target.classList.add("guide-target");
        this.kicker.textContent = `${this.label} · ${this.index + 1} de ${this.steps.length}`;
        this.title.textContent = step.title;
        this.text.textContent = step.text;
        this.back.disabled = this.index === 0;
        this.next.textContent = this.index === this.steps.length - 1 ? "Terminar" : "Siguiente";
        this.progress.innerHTML = this.steps
            .map((_, dotIndex) => `<i class="${dotIndex === this.index ? "active" : ""}"></i>`)
            .join("");
        this.card.dataset.placement = step.placement || "bottom";
        const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
        this.target.scrollIntoView({
            behavior: reducedMotion ? "auto" : "smooth",
            block: "center",
            inline: "nearest",
        });
        await new Promise((resolve) => setTimeout(resolve, reducedMotion ? 0 : 280));
        if (this.index !== nextIndex || this.root.hidden) return;
        this.reposition();
        this.next.focus({ preventScroll: true });
    }

    reposition() {
        if (!this.target || this.root.hidden) return;
        const rawRect = this.target.getBoundingClientRect();
        const padding = 7;
        const rect = {
            top: clamp(rawRect.top - padding, 6, innerHeight - 6),
            right: clamp(rawRect.right + padding, 6, innerWidth - 6),
            bottom: clamp(rawRect.bottom + padding, 6, innerHeight - 6),
            left: clamp(rawRect.left - padding, 6, innerWidth - 6),
        };
        rect.width = Math.max(0, rect.right - rect.left);
        rect.height = Math.max(0, rect.bottom - rect.top);
        const shades = Object.fromEntries(
            [...this.root.querySelectorAll("[data-guide-shade]")]
                .map((shade) => [shade.dataset.guideShade, shade]),
        );
        Object.assign(shades.top.style, { top: "0px", left: "0px", width: "100vw", height: `${rect.top}px` });
        Object.assign(shades.bottom.style, { top: `${rect.bottom}px`, left: "0px", width: "100vw", height: `${Math.max(0, innerHeight - rect.bottom)}px` });
        Object.assign(shades.left.style, { top: `${rect.top}px`, left: "0px", width: `${rect.left}px`, height: `${rect.height}px` });
        Object.assign(shades.right.style, { top: `${rect.top}px`, left: `${rect.right}px`, width: `${Math.max(0, innerWidth - rect.right)}px`, height: `${rect.height}px` });

        const cardRect = this.card.getBoundingClientRect();
        const position = placeGuideCard({
            target: rect,
            card: cardRect,
            viewport: { width: innerWidth, height: innerHeight },
            preferred: this.steps[this.index].placement,
        });
        this.card.dataset.placement = position.placement;
        this.card.style.transform = `translate3d(${Math.round(position.left)}px, ${Math.round(position.top)}px, 0)`;
    }

    handleKeydown(event) {
        if (event.key === "Escape") {
            event.preventDefault();
            this.stop("dismissed");
        } else if (event.key === "ArrowRight") {
            event.preventDefault();
            this.next.click();
        } else if (event.key === "ArrowLeft" && !this.back.disabled) {
            event.preventDefault();
            this.back.click();
        } else if (event.key === "Tab") {
            const focusable = [...this.card.querySelectorAll(FOCUSABLE)];
            const first = focusable[0], last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    }
}
