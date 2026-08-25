const COPY = {
    open: {
        label: "En vivo",
        description: "Colaboración en vivo conectada",
        actionLabel: "Pausar la colaboración en vivo",
    },
    connecting: {
        label: "Conectando",
        description: "Conectando la colaboración en vivo",
        actionLabel: "Pausar la conexión en vivo",
    },
    reconnecting: {
        label: "Reconectando",
        description: "Reconectando la colaboración en vivo",
        actionLabel: "Pausar la conexión en vivo",
    },
    error: {
        label: "Sin conexión",
        description: "Colaboración en vivo sin conexión; se reintentará",
        actionLabel: "Reintentar la conexión en vivo",
    },
    closed: {
        label: "Desconectado",
        description: "Colaboración en vivo desconectada",
        actionLabel: "Conectar la colaboración en vivo",
    },
    paused: {
        label: "En pausa",
        description: "Colaboración en vivo pausada",
        actionLabel: "Reconectar la colaboración en vivo",
    },
};

export function liveConnectionPresentation(remoteId, state) {
    if (!remoteId) return { hidden: true, state: "closed", ...COPY.closed };
    const normalizedState = Object.hasOwn(COPY, state) ? state : "closed";
    return { hidden: false, state: normalizedState, ...COPY[normalizedState] };
}
