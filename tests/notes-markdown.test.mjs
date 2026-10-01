import test from "node:test";
import assert from "node:assert/strict";

import { extractNoteLinks, inlineMarkdown, markdownToHtml, noteHeadings } from "../js/features/notes/markdown.js";

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


test("los prefijos vacíos crean títulos, listas y citas antes de escribir el contenido", () => {
    const html = markdownToHtml("## \n- \n1. \n> ");
    assert.match(html, /<h2 data-prefix="## "><br><\/h2>/);
    assert.match(html, /<ul><li data-prefix="- "><br><\/li><\/ul>/);
    assert.match(html, /<ol start="1"><li data-prefix="1\. "><br><\/li><\/ol>/);
    assert.match(html, /<blockquote data-prefix="&gt; "><br><\/blockquote>/);
});

test("el documento renderiza formato habitual y conserva líneas vacías", () => {
    const html = markdownToHtml("# Reservas\n\n**Hotel** y _billetes_\n- ~~Pendiente~~\n- `pasaporte`\n\n---");
    assert.match(html, /id="trip-note-heading-1">Reservas<\/h1>/);
    assert.match(html, /<p data-prefix=""><br><\/p>/);
    assert.match(html, /<strong>Hotel<\/strong> y <em>billetes<\/em>/);
    assert.match(html, /<s>Pendiente<\/s>/);
    assert.match(html, /<code>pasaporte<\/code>/);
    assert.match(html, /class="trip-notes-rule"/);
});

test("el código cercado no ejecuta HTML ni añade sus títulos al índice", () => {
    const source = "## Reservas\n```html\n# No es un título\n<img src=x onerror=alert(1)>\n```\n### Documentos";
    const html = markdownToHtml(source);
    assert.match(html, /<pre data-language="html" data-closed="true">/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /<img/);
    assert.deepEqual(noteHeadings(source).map(({ id, text }) => ({ id, text })), [
        { id: "trip-note-heading-1", text: "Reservas" },
        { id: "trip-note-heading-2", text: "Documentos" },
    ]);
});

test("una cerca de cierre junto al cursor nunca se interpreta como contenido de código", () => {
    const html = markdownToHtml("```\nconst ruta = 1;\n```\uE000");
    assert.match(html, /data-closed="true"/);
    assert.match(html, /<code>const ruta = 1;\uE000<\/code>/);
    assert.doesNotMatch(html, /<code>[^<]*```/);
});

test("el contenido importado y los prefijos de bloques se escapan", () => {
    const html = markdownToHtml('# <script>alert("x")</script>\n> [mal](javascript:alert(1))');
    assert.doesNotMatch(html, /<script|href="javascript:/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /data-prefix="&gt; "/);
});
