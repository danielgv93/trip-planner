import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryStorage, createTripRepository } from "../js/core/trip-repository.js";
import { createTripEnvelope } from "../js/core/trip-envelope.js";
import { createUndoStack } from "../js/core/undo-stack.js";

const doc = (title) => ({ tripTitle: title, days: [{ id: `${title}-day`, date: "", title, spots: [] }] });

test("duplicar, importar y eliminar no mezclan documentos ni preferencias", async () => {
    const repository = createTripRepository(createMemoryStorage());
    await repository.putTrip(createTripEnvelope({ id: "one", document: doc("Uno"), preferences: { basemap: "osm" } }));
    await repository.putTrip(createTripEnvelope({ id: "import", document: doc("Importado"), preferences: { basemap: "liberty" } }));
    const copy = await repository.duplicateTrip("one", { newId: "copy" });
    copy.document.days[0].title = "Cambiado";
    copy.preferences.basemap = "liberty";
    await repository.putTrip(copy);
    assert.equal((await repository.getTrip("one")).document.days[0].title, "Uno");
    assert.equal((await repository.getTrip("one")).preferences.basemap, "osm");
    await repository.markForDeletion("import");
    assert.equal(await repository.getTrip("import"), null);
    assert.ok(await repository.getTrip("one"));
});
test("cada cambio de viaje puede limpiar su historial de sesión sin tocar documentos", () => {
    let active = { value: 1 };
    const history = createUndoStack({ capture: () => active, restore: (value) => { active = value; } });
    history.pushUndo();
    active = { value: 2 };
    assert.equal(history.status().canUndo, true);
    history.clear();
    assert.deepEqual(history.status(), { canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 });
    assert.deepEqual(active, { value: 2 });
});
