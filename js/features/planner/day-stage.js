import { store } from "../../core/store.js";
import { STAGE_MAX_LENGTH, effectiveStage, normalizeStage, stageNames } from "../../core/day-stages.js";
import { derivedPlanOperation, setFieldIntent } from "../../core/plan-operation-commit.js";
import { promptAction } from "../../shared/notify.js";

// "Cambiar etapa…" flow. The stage is a real, undoable plan field; clearing the
// input removes it, which brings back the display-only title-prefix fallback.
export async function editDayStage(day) {
    if (store.readOnly) return;
    const current = normalizeStage(day.stage);
    const answer = await promptAction({
        title: "Etapa del día",
        message: "Agrupa los días consecutivos por etapa, por ejemplo una ciudad. Déjalo vacío para quitarla.",
        inputLabel: "Etapa",
        inputPlaceholder: effectiveStage(day) || "Kioto",
        inputValue: current || "",
        suggestions: stageNames(store.state),
        confirmLabel: "Guardar",
    });
    if (answer === null) return;
    const next = normalizeStage(answer.slice(0, STAGE_MAX_LENGTH * 2));
    if (next === current) return;
    await derivedPlanOperation((document) => setFieldIntent(
        document,
        { type: "day", id: day.id, field: "stage" },
        next,
        { remove: !next },
    ));
}
