import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const htmlUrl = new URL("../index.html", import.meta.url);
const viewUrl = new URL("../js/features/cloud/presence-view.js", import.meta.url);
const stylesUrl = new URL("../styles/features/cloud-library.css", import.meta.url);

test("la presencia global se muestra junto al asistente y no decora el encabezado", async () => {
    const [html, view, styles] = await Promise.all([
        readFile(htmlUrl, "utf8"),
        readFile(viewUrl, "utf8"),
        readFile(stylesUrl, "utf8"),
    ]);

    assert.doesNotMatch(html, /<header class="top"[^>]*data-presence-target/);
    assert.match(html, /id="llmChat"[\s\S]*id="collaborationPresence"/);
    assert.match(view, /if \(key === "plan:plan"\) continue;/);
    assert.match(styles, /\.collaboration-presence\s*\{[\s\S]*position: fixed;/);
});
