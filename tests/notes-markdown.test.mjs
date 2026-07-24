import test from "node:test";
import assert from "node:assert/strict";

import { extractNoteLinks, inlineMarkdown } from "../js/features/notes/markdown.js";

test("convierte URLs sueltas y enlaces Markdown en enlaces seguros", () => {
    const html = inlineMarkdown("Reserva: https://example.com/viaje?x=1&y=2. [Mapa](www.example.org/mapa)");

    assert.match(html, /href="https:\/\/example\.com\/viaje\?x=1&amp;y=2"/);
    assert.match(html, />https:\/\/example\.com\/viaje\?x=1&amp;y=2<\/a>\./);
    assert.match(html, /href="https:\/\/www\.example\.org\/mapa"[^>]*>Mapa<\/a>/);
});

test("no convierte enlaces dentro de código ni admite protocolos inseguros", () => {
    const html = inlineMarkdown("`https://example.com` [mal](javascript:alert(1))");

    assert.equal(html, "<code>https://example.com</code> [mal](javascript:alert(1))");
    assert.doesNotMatch(html, /href="javascript:/i);
});

test("extrae una sola vez los enlaces que se muestran junto al editor", () => {
    assert.deepEqual(
        extractNoteLinks("[Reserva](https://example.com/r) https://example.com/r www.example.org."),
        [
            { href: "https://example.com/r", label: "Reserva" },
            { href: "https://www.example.org", label: "www.example.org." },
        ],
    );
});

test("mantiene el orden de aparición de los enlaces en el editor", () => {
    assert.deepEqual(
        extractNoteLinks("https://first.example [Segundo](https://second.example)"),
        [
            { href: "https://first.example", label: "https://first.example" },
            { href: "https://second.example", label: "Segundo" },
        ],
    );
});
