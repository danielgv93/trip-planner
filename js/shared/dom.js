// Stateless DOM and formatting helpers shared across modules.

import { UNCATEGORIZED } from "../core/constants.js";

export const $ = (s) => document.querySelector(s);

// Cached because it's the drag-and-drop and render root, referenced constantly.
export const daysEl = $("#days");

// HTML-escape every user string interpolated into innerHTML templates.
export function esc(x = "") {
    return x.replace(
        /[&<>'"]/g,
        (c) =>
            ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                "'": "&#39;",
                '"': "&quot;",
            })[c],
    );
}

export function slug(s) {
    return (
        (s || "viaje")
            .toLowerCase()
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "viaje"
    );
}

// Colors can arrive from imported JSON (not just the <input type=color> picker),
// so never trust them raw inside a style="" attribute — a value like
// `#000" onmouseover="…` would break out and inject markup. Accept only #hex,
// otherwise fall back to a safe color.
export function safeColor(color, fallback) {
    return /^#[0-9a-fA-F]{3,8}$/.test(color)
        ? color
        : fallback || UNCATEGORIZED.color;
}

export function fmt(date) {
    const d = new Date(date + "T12:00:00"),
        months = [
            "ene",
            "feb",
            "mar",
            "abr",
            "may",
            "jun",
            "jul",
            "ago",
            "sept",
            "oct",
            "nov",
            "dic",
        ];
    return { day: d.getDate(), month: months[d.getMonth()] };
}

export function id() {
    return crypto.randomUUID();
}
