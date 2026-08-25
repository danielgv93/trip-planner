import { editorPreflightDecision } from "../cloud/live-sync-contracts.js";

let commitActiveEditor = null;

export function registerActiveEditor(commit) {
    commitActiveEditor = typeof commit === "function" ? commit : null;
    return () => {
        if (commitActiveEditor === commit) commitActiveEditor = null;
    };
}

export function clearActiveEditor() {
    commitActiveEditor = null;
}

export async function preflightActiveEditor({ readOnly = false } = {}) {
    const decision = editorPreflightDecision({ readOnly, hasActiveEditor: Boolean(commitActiveEditor) });
    if (decision.status !== "committed") return decision;
    const result = await commitActiveEditor();
    return result?.status ? result : editorPreflightDecision({ hasActiveEditor: true, valid: result !== false });
}
