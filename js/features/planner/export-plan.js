import { serializePlan } from "../../core/plan-json.js";
import { store } from "../../core/store.js";
import { slug } from "../../shared/dom.js";

export function downloadPlanExport() {
    const data = JSON.stringify(serializePlan(), null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `ruta-${slug(store.tripTitle)}.json`;
    link.click();
    URL.revokeObjectURL(url);
}
