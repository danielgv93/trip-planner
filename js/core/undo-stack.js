// Small, domain-neutral undo/redo engine. The caller owns the shape of a
// snapshot and how it is restored; this module only guarantees independent,
// bounded history entries and standard redo invalidation.

export const UNDO_LIMIT = 20;

const cloneValue =
    typeof structuredClone === "function"
        ? (value) => structuredClone(value)
        : (value) => JSON.parse(JSON.stringify(value));

export function createUndoStack({ capture, restore, limit = UNDO_LIMIT }) {
    const undoStack = [];
    const redoStack = [];
    const listeners = new Set();

    function snapshot() {
        return cloneValue(capture());
    }

    function pushBounded(stack, value) {
        stack.push(value);
        if (stack.length > limit) stack.shift();
    }

    function status() {
        return {
            canUndo: undoStack.length > 0,
            canRedo: redoStack.length > 0,
            undoCount: undoStack.length,
            redoCount: redoStack.length,
        };
    }

    function notify() {
        const current = status();
        listeners.forEach((listener) => listener(current));
    }

    function pushUndo() {
        pushBounded(undoStack, snapshot());
        redoStack.length = 0;
        notify();
    }

    function undo() {
        if (!undoStack.length) return false;
        pushBounded(redoStack, snapshot());
        restore(undoStack.pop());
        notify();
        return true;
    }

    function redo() {
        if (!redoStack.length) return false;
        pushBounded(undoStack, snapshot());
        restore(redoStack.pop());
        notify();
        return true;
    }

    function subscribe(listener) {
        listeners.add(listener);
        listener(status());
        return () => listeners.delete(listener);
    }

    function clear() {
        undoStack.length = 0;
        redoStack.length = 0;
        notify();
    }

    return { pushUndo, undo, redo, status, subscribe, clear };
}

// Cloud history stores semantic forward/inverse operations instead of whole
// documents. Applying an entry is asynchronous because it passes through the
// same durable operation boundary as every other collaborative edit.
export function createIntentUndoStack({ apply, limit = UNDO_LIMIT }) {
    const undoStack = [];
    const redoStack = [];
    const listeners = new Set();

    function pushBounded(stack, value) {
        stack.push(cloneValue(value));
        if (stack.length > limit) stack.shift();
    }

    function status() {
        return {
            canUndo: undoStack.length > 0,
            canRedo: redoStack.length > 0,
            undoCount: undoStack.length,
            redoCount: redoStack.length,
        };
    }

    function notify() {
        const current = status();
        listeners.forEach((listener) => listener(current));
    }

    function record(entry) {
        if (!entry?.operation || !entry?.inverse) return false;
        pushBounded(undoStack, entry);
        redoStack.length = 0;
        notify();
        return true;
    }

    async function transfer(from, to, direction) {
        if (!from.length) return false;
        const entry = from.pop();
        notify();
        try {
            await apply(cloneValue(direction === "undo" ? entry.inverse : entry.operation), direction);
            pushBounded(to, entry);
            notify();
            return true;
        } catch (error) {
            from.push(entry);
            notify();
            throw error;
        }
    }

    const undo = () => transfer(undoStack, redoStack, "undo");
    const redo = () => transfer(redoStack, undoStack, "redo");
    function subscribe(listener) {
        listeners.add(listener);
        listener(status());
        return () => listeners.delete(listener);
    }
    function clear() {
        undoStack.length = 0;
        redoStack.length = 0;
        notify();
    }

    return { record, undo, redo, status, subscribe, clear };
}
