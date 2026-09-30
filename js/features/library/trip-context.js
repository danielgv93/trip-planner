// Presentation only: names never identify a trip or imply shared ancestry.
export function tripContext(trip) {
    if (!trip) return null;
    const remote = trip.remote || {};
    const members = Array.isArray(remote.members) ? remote.members : [];
    const owner = members.find((member) => member.role === "owner");
    if (["editor", "viewer"].includes(remote.role)) {
        return {
            personal: false,
            label: `Compartido por ${owner?.displayName || "otra persona"} · ${remote.role === "viewer" ? "Solo lectura" : "Puedes editar"}`,
        };
    }
    if (remote.id && remote.role !== "owner") {
        return { personal: false, label: "Viaje en la nube · Colaboradores sin confirmar" };
    }
    const others = members.filter((member) => member.role !== "owner");
    if (remote.id && others.length) {
        const names = others.slice(0, 2).map((member) => member.displayName).join(", ");
        const rest = others.length > 2 ? ` y ${others.length - 2} más` : "";
        return { personal: false, label: `Tu viaje · Compartido con ${names}${rest}` };
    }
    return { personal: true, label: "Tu viaje personal · Sin colaboradores" };
}

function titleKey(title) {
    return String(title || "").normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("es");
}

export function tripWithRemoteContext(trip, remoteTrips = []) {
    if (!trip?.remote?.id) return trip;
    const remote = remoteTrips.find((candidate) => candidate.id === trip.remote.id);
    if (!remote) return trip;
    return { ...trip, remote: {
        ...trip.remote,
        role: remote.role || trip.remote.role,
        members: Array.isArray(remote.members) ? remote.members : trip.remote.members,
    } };
}

export function matchingSharedTrips(active, localTrips = [], remoteTrips = []) {
    active = tripWithRemoteContext(active, remoteTrips);
    if (!tripContext(active)?.personal || active.pendingDeletion || !titleKey(active.document?.tripTitle)) return [];
    const downloaded = new Set(localTrips.map((trip) => trip.remote?.id).filter(Boolean));
    const candidates = [
        ...localTrips.map((trip) => ({ ...tripWithRemoteContext(trip, remoteTrips), title: trip.document?.tripTitle, remoteOnly: false })),
        ...remoteTrips.filter((trip) => !downloaded.has(trip.id)).map((trip) => ({
            ...trip,
            archived: Boolean(trip.archived_at),
            remoteOnly: true,
            remote: { id: trip.id, role: trip.role, members: trip.members },
        })),
    ];
    return candidates.filter((trip) => trip.id !== active.id && !trip.archived && !trip.pendingDeletion
        && ["editor", "viewer"].includes(trip.remote?.role)
        && titleKey(trip.title) === titleKey(active.document.tripTitle));
}
