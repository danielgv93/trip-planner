export function cloudSaveActionState({
    activeTripId,
    trips = [],
    accountSession = null,
    cloudAvailability = "checking",
    uploadingTripId = null,
} = {}) {
    const activeTrip = trips.find((trip) => trip.id === activeTripId);
    if (!activeTrip || activeTrip.pendingDeletion) {
        return { visible: true, disabled: true, label: "Guardar en la nube", title: "No hay ningún viaje que se pueda guardar" };
    }
    if (uploadingTripId === activeTripId) {
        return { visible: true, disabled: true, label: "Guardando…", title: "Guardando el viaje activo en la nube" };
    }
    if (!accountSession) {
        return {
            visible: true,
            disabled: true,
            label: "Guardar en la nube",
            title: cloudAvailability === "unavailable"
                ? "La nube no está disponible ahora; el viaje sigue guardado en este dispositivo"
                : "Inicia sesión para guardar el viaje activo en la nube",
        };
    }
    if (cloudAvailability === "unavailable") {
        return {
            visible: true,
            disabled: true,
            label: "Guardar en la nube",
            title: "La nube no está disponible ahora; el viaje sigue guardado en este dispositivo",
        };
    }
    if (activeTrip.remote?.id && !["pending", "offline", "error"].includes(activeTrip.syncState)) {
        return {
            visible: true,
            disabled: true,
            label: "Guardar en la nube",
            title: "No hay cambios pendientes de guardar",
        };
    }
    return {
        visible: true,
        disabled: false,
        label: "Guardar en la nube",
        title: "Guardar el viaje activo en la nube",
    };
}
