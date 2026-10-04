// Shared miniature of a day: one compact line per itinerary row. It knows
// nothing about dragging, so the drop rail and a future persistent minimap can
// both reuse it. The pure helpers avoid importing shared/dom.js (which touches
// `document` at load time) so they stay unit-testable in Node.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" };

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (c) => ESCAPES[c]);
}

// Mirrors exactly `:scope > .spot`: stops and travel cards, in DOM order.
// Stops folded into a travel card are not rows, and neither are connectors.
export function readDayOutline(listEl) {
    if (!listEl) return [];
    return [...listEl.querySelectorAll(":scope > .spot")].map((element) => {
        const travelLegKey = element.dataset.travelLeg || null;
        const spotId = travelLegKey ? null : element.dataset.spot || null;
        const numberEl = element.querySelector(".number");
        const number =
            numberEl && !numberEl.classList.contains("number-placeholder")
                ? numberEl.textContent.trim()
                : "";
        const label = travelLegKey
            ? [...element.querySelectorAll(".travel-card-stop-name")]
                  .map((node) => node.textContent.trim())
                  .filter(Boolean)
                  .join(" → ")
            : element.dataset.spotName || "";
        return {
            key: travelLegKey ? `travel-leg:${travelLegKey}` : `spot:${spotId}`,
            spotId,
            travelLegKey,
            number,
            label,
            kind: travelLegKey ? "travel" : "spot",
            anchored: Boolean(element.dataset.positionConstraint),
            disabled: element.classList.contains("spot-disabled"),
            element,
        };
    });
}

export function outlineRowsMarkup(rows, { sourceKey = null } = {}) {
    return rows
        .map((row, index) => {
            const classes = ["day-outline-row"];
            if (row.kind === "travel") classes.push("is-travel");
            if (row.anchored) classes.push("is-anchored");
            if (row.disabled) classes.push("is-disabled");
            if (sourceKey && row.key === sourceKey) classes.push("is-source");
            const badge =
                row.kind === "travel"
                    ? '<span class="day-outline-number day-outline-travel" aria-hidden="true">→</span>'
                    : `<span class="day-outline-number">${escapeHtml(row.number)}</span>`;
            return `<li class="${classes.join(" ")}" data-outline-index="${index}">${badge}<span class="day-outline-label">${escapeHtml(row.label)}</span></li>`;
        })
        .join("");
}

// Index of the first midpoint below the pointer; midpoints.length = after all.
export function insertionIndexFromMidpoints(midpoints, y) {
    const index = midpoints.findIndex((midpoint) => midpoint > y);
    return index === -1 ? midpoints.length : index;
}
