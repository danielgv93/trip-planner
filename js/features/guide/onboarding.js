import { Guide } from "../../shared/guide.js";

const SEEN_KEY = "trip-planner:intro-guide-seen";

const guide = new Guide({
    label: "Primeros pasos",
    steps: [
        {
            target: ".brand",
            title: "Tu viaje empieza aquí",
            text: "Ponle nombre al viaje y configura las monedas. El total abre el presupuesto completo.",
            placement: "bottom",
        },
        {
            target: "#spotSearchBtn",
            title: "Encuentra cualquier parada",
            text: "Busca por nombre, dirección, etiqueta o día. También puedes abrirlo con Ctrl o Cmd + K.",
            placement: "bottom",
        },
        {
            target: ".day[data-day]:not([data-day='backlog']) .day-head",
            title: "Organiza el viaje por días",
            text: "Pulsa un día para ver su ruta, cambia su fecha o nombre y arrástralo para reordenarlo. El backlog guarda ideas aún sin asignar.",
            placement: "right",
        },
        {
            target: ".day[data-day]:not([data-day='backlog']) .spot",
            title: "Cada parada tiene sus controles",
            text: "Arrastra para cambiar el orden, desactiva una parada sin borrarla y abre ··· para editarla, duplicarla o moverla. Añade tiempos para construir el timeline.",
            placement: "right",
        },
        {
            target: "#tagBar",
            title: "Filtra sin cambiar el plan",
            text: "Las etiquetas te ayudan a ver solo comida, reservas, compras u otros temas. Puedes combinar varias y limpiar el filtro después.",
            placement: "bottom",
        },
        {
            target: ".map-panel",
            title: "Mapa, ruta y notas en un mismo lugar",
            text: "Alterna entre línea recta y calles, elige cómo viajas o usa Vista completa para revisar todo el recorrido. Debajo del mapa puedes guardar reservas, enlaces y recordatorios en notas Markdown.",
            placement: "left",
        },
        {
            target: "#llmChatLauncher",
            title: "Pide ayuda al asistente",
            text: "El asistente puede resolver dudas y proponerte cambios validados en el itinerario. Importar, exportar, comprobar el plan y el modo En ruta están en la barra superior.",
            placement: "left",
        },
    ],
    onFinish: () => {
        try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* Storage may be unavailable. */ }
    },
});

// Give the initial destructive render and the lazy assistant launcher time to
// settle before welcoming a first-time visitor. The ? button always reopens it.
let seen = false;
try { seen = localStorage.getItem(SEEN_KEY) === "1"; } catch { /* Ignore storage failures. */ }
let welcomeTimer = seen ? null : window.setTimeout(() => guide.start(), 900);
document.querySelector("#guideBtn")?.addEventListener("click", () => {
    if (welcomeTimer !== null) window.clearTimeout(welcomeTimer);
    welcomeTimer = null;
    guide.start();
});

export { guide };
