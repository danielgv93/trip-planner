// Static seed data and design tokens. No state, no side effects — pure exports.

export const sample = [
    {
        id: "d1",
        date: "2026-12-03",
        title: "Tokio · Shibuya y Shinjuku",
        spots: [
            {
                id: "s1",
                name: "Meiji Jingu",
                address: "Meiji Jingu, Tokyo",
                note: "Llegar temprano",
                lat: 35.6764,
                lng: 139.6993,
            },
            {
                id: "s2",
                name: "Takeshita Street",
                address: "Harajuku, Tokyo",
                note: "Paseo y tiendas",
                lat: 35.6715,
                lng: 139.7036,
            },
            {
                id: "s3",
                name: "Shibuya Sky",
                address: "Shibuya Sky, Tokyo",
                note: "Atardecer — reservar",
                lat: 35.6585,
                lng: 139.7021,
            },
            {
                id: "s4",
                name: "Omoide Yokocho",
                address: "Shinjuku, Tokyo",
                note: "Cena",
                lat: 35.6938,
                lng: 139.6995,
            },
        ],
    },
    {
        id: "d2",
        date: "2026-12-04",
        title: "Tokio · Asakusa y Akihabara",
        spots: [
            {
                id: "s5",
                name: "Sensō-ji",
                address: "Sensoji, Tokyo",
                note: "Templo y Nakamise-dori",
                lat: 35.7148,
                lng: 139.7967,
            },
            {
                id: "s6",
                name: "Kappabashi",
                address: "Kappabashi, Tokyo",
                note: "Cuchillos y menaje",
                lat: 35.7141,
                lng: 139.7895,
            },
            {
                id: "s7",
                name: "Akihabara",
                address: "Akihabara, Tokyo",
                note: "Arcades y tiendas",
                lat: 35.6984,
                lng: 139.773,
            },
        ],
    },
    {
        id: "d3",
        date: "2026-12-05",
        title: "Kyoto · Higashiyama",
        spots: [
            {
                id: "s8",
                name: "Kiyomizu-dera",
                address: "Kiyomizu-dera, Kyoto",
                note: "Primera hora",
                lat: 34.9949,
                lng: 135.785,
            },
            {
                id: "s9",
                name: "Ninenzaka",
                address: "Ninenzaka, Kyoto",
                note: "Paseo y fotos",
                lat: 34.9989,
                lng: 135.7828,
            },
            {
                id: "s10",
                name: "Gion",
                address: "Gion, Kyoto",
                note: "Paseo nocturno",
                lat: 35.0037,
                lng: 135.7762,
            },
        ],
    },
];

export const DEFAULT_CATEGORIES = [
    { id: "food", label: "Comida", color: "#d9822b" },
    { id: "hotel", label: "Alojamiento", color: "#3f7d9c" },
    { id: "sight", label: "Punto de interés", color: "#4c9a5b" },
    { id: "museum", label: "Museo", color: "#8a5fbf" },
    { id: "transport", label: "Transporte", color: "#c74e88" },
    { id: "other", label: "Otro", color: "#6b6b6b" },
];

export const UNCATEGORIZED = { label: "Sin categoría", color: "#9aa0a6" };

export const DEFAULT_TITLE = "Japón, invierno 2026";

export const DAY_COLORS = [
    "#d44d43",
    "#3f7d9c",
    "#4c9a5b",
    "#b8862c",
    "#8a5fbf",
    "#c74e88",
    "#4aa3a3",
    "#a3612e",
];
