import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function sourceFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map((entry) => {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return entry.name.endsWith(".js") ? [full] : [];
    }));
    return nested.flat();
}

function executableSource(value) {
    return value
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
}

test("ningún productor de features persiste un cambio portable mediante save()", async () => {
    const files = [
        ...await sourceFiles(path.join(root, "js/features")),
        ...await sourceFiles(path.join(root, "js/app")),
    ];
    const offenders = [];
    for (const file of files) {
        const source = executableSource(await readFile(file, "utf8"));
        if (/\bsave\s*\(/.test(source)) offenders.push(path.relative(root, file));
    }
    assert.deepEqual(offenders, []);
});

test("la persistencia local queda acotada a preferencias no portables conocidas", async () => {
    const files = await sourceFiles(path.join(root, "js/features"));
    const callers = [];
    for (const file of files) {
        const source = executableSource(await readFile(file, "utf8"));
        if (/\bsaveLocalPreferences\s*\(/.test(source)) callers.push(path.relative(root, file));
    }
    assert.deepEqual(callers.sort(), [
        "js/features/map/basemap.js",
        "js/features/notes/notes.js",
        "js/features/planner/actions.js",
        "js/features/planner/history.js",
        "js/features/planner/render.js",
        "js/features/workspace/workspace-resize.js",
    ]);
});

test("el fallback de save sin descriptor está retirado tras completar el inventario", async () => {
    const source = await readFile(path.join(root, "js/core/store.js"), "utf8");
    assert.match(source, /allowLegacyFallback:\s*false/);
});

test("guardar preferencias no cambia la fecha ni el autor del contenido", async () => {
    const source = executableSource(
        await readFile(path.join(root, "js/features/library/workspace.js"), "utf8"),
    );
    const body = source.match(
        /async function commitActivePreferences\(\)\s*\{([\s\S]*?)\n\}/,
    )?.[1] || "";

    assert.doesNotMatch(body, /\.updatedAt\s*=/);
    assert.doesNotMatch(body, /\.lastModifiedBy\s*=/);
});
