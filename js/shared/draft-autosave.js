function fingerprint(value) {
    return JSON.stringify(value);
}

export function createDraftAutosaveController({
    root,
    read,
    validate = () => [],
    commit,
    debounceMs = 450,
    disabled = () => false,
    onState = () => {},
} = {}) {
    if (!root?.addEventListener || typeof read !== "function" || typeof commit !== "function") {
        throw new Error("INVALID_DRAFT_AUTOSAVE_CONFIG");
    }
    let timer = null;
    let destroyed = false;
    let invalidDraft = false;
    let lastCommitted = fingerprint(read());
    let tail = Promise.resolve();

    function inspect() {
        const draft = read();
        const errors = validate(draft);
        const normalizedErrors = Array.isArray(errors) ? errors : errors ? [errors] : [];
        invalidDraft = normalizedErrors.length > 0;
        return { draft, errors: normalizedErrors, signature: fingerprint(draft) };
    }

    async function flush(reason = "flush") {
        clearTimeout(timer);
        timer = null;
        if (destroyed || disabled()) return { status: "skipped" };
        const candidate = inspect();
        if (candidate.errors.length) {
            onState({ state: "invalid", errors: candidate.errors, draft: candidate.draft, reason });
            return { status: "invalid", errors: candidate.errors };
        }
        if (candidate.signature === lastCommitted) return { status: "unchanged" };
        onState({ state: "saving", draft: candidate.draft, reason });
        const task = tail.then(() => commit(candidate.draft, { reason }));
        tail = task.catch(() => {});
        try {
            const result = await task;
            lastCommitted = candidate.signature;
            invalidDraft = false;
            onState({ state: "saved", draft: candidate.draft, reason, result });
            return { status: "saved", result };
        } catch (error) {
            onState({ state: "error", draft: candidate.draft, reason, error });
            throw error;
        }
    }

    function schedule() {
        clearTimeout(timer);
        const candidate = inspect();
        if (candidate.errors.length) {
            onState({ state: "invalid", errors: candidate.errors, draft: candidate.draft, reason: "input" });
            return;
        }
        onState({ state: "dirty", draft: candidate.draft, reason: "input" });
        timer = setTimeout(() => void flush("debounce"), debounceMs);
    }

    const onInput = () => schedule();
    const onChange = () => void flush("change");
    const onFocusOut = () => void flush("blur");
    root.addEventListener("input", onInput);
    root.addEventListener("change", onChange);
    root.addEventListener("focusout", onFocusOut);

    return {
        flush,
        hasInvalidDraft: () => invalidDraft,
        reset(value = read()) {
            clearTimeout(timer);
            timer = null;
            invalidDraft = false;
            lastCommitted = fingerprint(value);
            onState({ state: "idle", draft: value, reason: "reset" });
        },
        async settle() {
            await tail;
        },
        destroy() {
            destroyed = true;
            clearTimeout(timer);
            root.removeEventListener("input", onInput);
            root.removeEventListener("change", onChange);
            root.removeEventListener("focusout", onFocusOut);
        },
    };
}
