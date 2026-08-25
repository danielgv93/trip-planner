export function cloudSaveActionState({
    activeTripId,
    trips = [],
    accountSession = null,
    cloudAvailability = "checking",
    uploadingTripId = null,
} = {}) {
    const activeTrip = trips.find((trip) => trip.id === activeTripId);
    if (!activeTrip || activeTrip.pendingDeletion) {
        return { visible: true, disabled: true, label: "Subir a la nube", title: "No hay ningún viaje que se pueda subir" };
    }
    if (activeTrip.remote?.id) {
        return { visible: false, disabled: true, label: "Sincronización automática", title: "Los cambios se sincronizan automáticamente" };
    }
    if (uploadingTripId === activeTripId) {
        return { visible: true, disabled: true, label: "Subiendo…", title: "Subiendo el viaje activo a la nube" };
    }
    if (!accountSession) {
        return {
            visible: true,
            disabled: true,
            label: "Subir a la nube",
            title: cloudAvailability === "unavailable"
                ? "La nube no está disponible ahora; el viaje sigue guardado en este dispositivo"
                : "Inicia sesión para subir el viaje activo a la nube",
        };
    }
    if (cloudAvailability === "unavailable") {
        return {
            visible: true,
            disabled: true,
            label: "Subir a la nube",
            title: "La nube no está disponible ahora; el viaje sigue guardado en este dispositivo",
        };
    }
    return {
        visible: true,
        disabled: false,
        label: "Subir a la nube",
        title: "Subir el viaje activo a la nube",
    };
}
