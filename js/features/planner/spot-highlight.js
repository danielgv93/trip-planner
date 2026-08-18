const HIGHLIGHT_CLASS = "is-map-highlighted";
let highlightedSpotId = null;

function spotElements(spotId) {
    const selector = `[data-spot="${CSS.escape(spotId)}"], [data-timeline-spot="${CSS.escape(spotId)}"]`;
    return document.querySelectorAll(selector);
}

function setHighlight(spotId, highlighted) {
    spotElements(spotId).forEach((element) => {
        element.classList.toggle(HIGHLIGHT_CLASS, highlighted);
    });
}

export function highlightItinerarySpot(spotId, highlighted = true) {
    const id = spotId === null || spotId === undefined ? null : String(spotId);
    if (highlightedSpotId && (!highlighted || highlightedSpotId !== id)) {
        setHighlight(highlightedSpotId, false);
        highlightedSpotId = null;
    }
    if (!id || !highlighted) return;
    setHighlight(id, true);
    highlightedSpotId = id;
}
