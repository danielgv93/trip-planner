import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
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

test("el commit de operaciones pertenece a core y ninguna feature importa el dueño antiguo", async () => {
    await access(path.join(root, "js/core/plan-operation-commit.js"));
    const files = await sourceFiles(path.join(root, "js"));
    const offenders = [];
    for (const file of files) {
        const source = await readFile(file, "utf8");
        if (/planner\/plan-operation-commit\.js|from ["']\.\/plan-operation-commit\.js["']/.test(source)) {
            offenders.push(path.relative(root, file));
        }
    }
    assert.deepEqual(offenders, []);
});

test("timeline, finanzas y recordatorios exponen módulos consumibles sin cargar sus controladores", async () => {
    const render = await readFile(
        path.join(root, "js/features/planner/render.js"),
        "utf8",
    );
    const budget = await readFile(
        path.join(root, "js/features/finance/budget.js"),
        "utf8",
    );
    const dnd = await readFile(
        path.join(root, "js/features/planner/dnd.js"),
        "utf8",
    );

    assert.match(render, /\.\.\/timeline\/timeline\.js/);
    assert.match(render, /from ["']\.\/timeline-editor\.js["']/);
    assert.ok(
        render.split("\n").length < 1600,
        "render.js debe seguir siendo una fachada acotada",
    );
    assert.doesNotMatch(render, /\.\.\/companion\/timeline\.js/);
    assert.match(render, /\.\.\/reminders\/presentation\.js/);
    assert.doesNotMatch(render, /\.\.\/reminders\/reminders\.js/);
    assert.match(budget, /from ["']\.\/totals\.js["']/);
    assert.doesNotMatch(budget, /planner\/render\.js/);
    assert.match(dnd, /from ["']\.\/commands\.js["']/);
});
