import test from "node:test";
import assert from "node:assert/strict";

import { cloudSaveActionState } from "../js/features/cloud/global-action-state.js";

const trip = (id, remoteId = null) => ({ id, remote: { id: remoteId }, pendingDeletion: false });

test("la acción cloud permanece visible y representa únicamente el viaje activo", () => {
    const trips = [trip("local"), trip("remote", "remote-id")];
    assert.equal(cloudSaveActionState({ activeTripId: "local", trips }).visible, true);
    assert.equal(cloudSaveActionState({ activeTripId: "remote", trips }).visible, true);
    assert.equal(cloudSaveActionState({ activeTripId: "missing", trips }).visible, true);
    assert.equal(cloudSaveActionState({ activeTripId: "missing", trips }).disabled, true);
});

test("la acción global refleja sesión, disponibilidad y subida en curso", () => {
    const trips = [trip("active")];
    const signedOut = cloudSaveActionState({ activeTripId: "active", trips, cloudAvailability: "available" });
    assert.equal(signedOut.visible, true);
    assert.equal(signedOut.disabled, true);
    assert.match(signedOut.title, /Inicia sesión/);

    const unavailable = cloudSaveActionState({ activeTripId: "active", trips, cloudAvailability: "unavailable" });
    assert.match(unavailable.title, /no está disponible/);

    const signedIn = cloudSaveActionState({ activeTripId: "active", trips, accountSession: { authenticated: true } });
    assert.match(signedIn.title, /viaje activo/);

    const uploading = cloudSaveActionState({ activeTripId: "active", trips, uploadingTripId: "active" });
    assert.equal(uploading.disabled, true);
    assert.equal(uploading.label, "Guardando…");
});

test("un viaje pendiente de borrado nunca se puede subir", () => {
    const pending = trip("active");
    pending.pendingDeletion = true;
    const state = cloudSaveActionState({ activeTripId: "active", trips: [pending] });
    assert.equal(state.visible, true);
    assert.equal(state.disabled, true);
});

test("un viaje remoto sólo se puede guardar cuando tiene cambios pendientes", () => {
    const saved = { ...trip("active", "remote-id"), syncState: "synced" };
    const pending = { ...saved, syncState: "pending" };
    const context = { activeTripId: "active", accountSession: { authenticated: true }, cloudAvailability: "available" };
    assert.equal(cloudSaveActionState({ ...context, trips: [saved] }).disabled, true);
    assert.equal(cloudSaveActionState({ ...context, trips: [pending] }).disabled, false);
});
