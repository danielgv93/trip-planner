// Pure, presentation-ready diff for two portable plan documents. The same
// contract feeds GitHub's publish confirmation and the remote revision history.

function sameJson(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function changeGroup(tone, title, items) {
    const visible = items.slice(0, 4);
    const remaining = items.length - visible.length;
    return {
        tone,
        title,
        detail: `${visible.join(" · ")}${remaining > 0 ? ` · +${remaining} más` : ""}`,
    };
}

function collectionChanges(previousItems, nextItems, describe, comparable = (item) => item) {
    const previous = new Map(previousItems.map((item) => [item.id, item]));
    const next = new Map(nextItems.map((item) => [item.id, item]));
    return {
        added: [...next].filter(([id]) => !previous.has(id)).map(([, item]) => describe(item)),
        removed: [...previous].filter(([id]) => !next.has(id)).map(([, item]) => describe(item)),
        modified: [...next]
            .filter(([id, item]) => previous.has(id) && !sameJson(comparable(previous.get(id)), comparable(item)))
            .map(([id, item]) => ({ before: previous.get(id), after: item })),
    };
}

function previewValue(value, empty = "Sin indicar") {
    if (value === undefined || value === null || value === "") return empty;
    if (Array.isArray(value)) return value.length ? value.join(", ") : "Ninguna";
    if (typeof value === "boolean") return value ? "Sí" : "No";
    const text = String(value).replace(/\s+/g, " ").trim();
    return text.length > 54 ? `${text.slice(0, 51)}…` : text;
}

function fieldChanges(before, after, fields) {
    return fields.flatMap(({ label, read = (item) => item[label], format = previewValue }) => {
        const previous = read(before);
        const next = read(after);
        if (sameJson(previous, next)) return [];
        return [{ label, before: format(previous), after: format(next) }];
    });
}

function modifiedGroup(label, name, changes) {
    return { tone: "modify", title: `${label} · ${name}`, changes };
}

export function buildPlanChanges(previousPlan, nextPlan) {
    const previous = previousPlan || {};
    const next = nextPlan || {};
    const groups = [];
    const totals = { add: 0, modify: 0, remove: 0 };
    const addGroups = (label, changes) => {
        for (const [key, tone, action] of [
            ["added", "add", "Se añaden"],
            ["removed", "remove", "Se eliminan"],
        ]) {
            if (!changes[key].length) continue;
            totals[tone] += changes[key].length;
            groups.push(changeGroup(tone, `${label} · ${action}`, changes[key]));
        }
    };

    const dayItems = (plan) => (plan.days || []).map((day, index) => ({ ...day, position: index + 1 }));
    const dayComparable = ({ spots, collapsed, ...day }) => day;
    const dayChanges = collectionChanges(
        dayItems(previous),
        dayItems(next),
        (day) => day.title || day.date || "Día sin título",
        dayComparable,
    );
    addGroups("Días", dayChanges);
    const dayFields = [
        { label: "Título", read: (day) => day.title },
        { label: "Fecha", read: (day) => day.date },
        { label: "Posición", read: (day) => day.position },
        { label: "Hora de inicio", read: (day) => day.startTime },
    ];
    for (const { before, after } of dayChanges.modified) {
        totals.modify += 1;
        groups.push(modifiedGroup(
            "Día modificado",
            after.title || after.date || "Sin título",
            fieldChanges(before, after, dayFields),
        ));
    }

    const backlogGroupChanges = collectionChanges(
        previous.backlogGroups || [],
        next.backlogGroups || [],
        (group) => group.title || "Grupo sin nombre",
    );
    addGroups("Grupos de ideas", backlogGroupChanges);
    const backlogGroupFields = [
        { label: "Nombre", read: (group) => group.title },
        { label: "Plegado", read: (group) => group.collapsed === true },
    ];
    for (const { before, after } of backlogGroupChanges.modified) {
        totals.modify += 1;
        groups.push(modifiedGroup(
            "Grupo de ideas modificado",
            after.title || "Sin nombre",
            fieldChanges(before, after, backlogGroupFields),
        ));
    }

    const dayNames = new Map([
        ["backlog", "Ideas"],
        ...[...(previous.days || []), ...(next.days || [])]
            .map((day) => [day.id, day.title || day.date || "Día sin título"]),
    ]);
    const groupNames = new Map([
        ...((previous.backlogGroups || []).map((group) => [group.id, group.title])),
        ...((next.backlogGroups || []).map((group) => [group.id, group.title])),
    ]);
    const flattenSpots = (plan) => [
        ...(plan.backlog || []).map((spot, index) => ({ ...spot, dayId: "backlog", position: index + 1 })),
        ...(plan.days || []).flatMap((day) => (day.spots || []).map((spot, index) => ({
            ...spot,
            dayId: day.id,
            position: index + 1,
        }))),
    ];
    const spotChanges = collectionChanges(
        flattenSpots(previous),
        flattenSpots(next),
        (spot) => spot.name || "Parada sin nombre",
    );
    addGroups("Paradas", spotChanges);
    const spotFields = [
        { label: "Nombre", read: (spot) => spot.name },
        { label: "Tipo", read: (spot) => spot.kind, format: (value) => value === "waypoint" ? "Solo paso" : "Visita" },
        { label: "Día", read: (spot) => spot.dayId, format: (id) => dayNames.get(id) || "Día eliminado" },
        { label: "Grupo de ideas", read: (spot) => spot.backlogGroupId, format: (id) => groupNames.get(id) || previewValue(id) },
        { label: "Orden", read: (spot) => spot.position },
        { label: "Dirección", read: (spot) => spot.address },
        { label: "Nota", read: (spot) => spot.note },
        { label: "Etiquetas", read: (spot) => spot.tags || [] },
        { label: "Categoría", read: (spot) => spot.category },
        { label: "Coste", read: (spot) => spot.cost, format: (value) => value == null ? "Sin coste" : `${value} ${next.foreignCurrency || ""}`.trim() },
        { label: "Duración", read: (spot) => spot.visitMinutes, format: (value) => value == null ? "Sin estimación" : `${value} min` },
        { label: "Inicio planificado", read: (spot) => spot.plannedStart },
        { label: "Apertura", read: (spot) => spot.openingTime },
        { label: "Cierre", read: (spot) => spot.closingTime },
        { label: "Opcional", read: (spot) => spot.optional === true },
        { label: "Reserva fija", read: (spot) => spot.fixedStart === true },
        { label: "Posición fija", read: (spot) => spot.positionConstraint, format: (value) => ({ first: "Primera", last: "Última", locked: "Fija" }[value] || "Flexible") },
        { label: "Horario", read: (spot) => spot.scheduleNotApplicable === true, format: (value) => value ? "No aplicable" : "Aplicable" },
        { label: "Ubicación", read: (spot) => Number.isFinite(spot.lat) && Number.isFinite(spot.lng) ? `${spot.lat.toFixed(5)}, ${spot.lng.toFixed(5)}` : "" },
        { label: "Visible en el mapa", read: (spot) => spot.mapEnabled !== false },
    ];
    for (const { before, after } of spotChanges.modified) {
        totals.modify += 1;
        groups.push(modifiedGroup(
            "Parada modificada",
            after.name || "Sin nombre",
            fieldChanges(before, after, spotFields),
        ));
    }

    const categoryChanges = collectionChanges(
        previous.categories || [],
        next.categories || [],
        (category) => category.label || "Categoría sin nombre",
    );
    addGroups("Categorías", categoryChanges);
    const categoryFields = [
        { label: "Nombre", read: (category) => category.label },
        { label: "Color", read: (category) => category.color },
        { label: "Conecta la ruta", read: (category) => category.connects !== false },
        { label: "Tipo sugerido", read: (category) => category.defaultSpotKind, format: (value) => value === "waypoint" ? "Solo paso" : "Visita" },
    ];
    for (const { before, after } of categoryChanges.modified) {
        totals.modify += 1;
        groups.push(modifiedGroup(
            "Categoría modificada",
            after.label || "Sin nombre",
            fieldChanges(before, after, categoryFields),
        ));
    }

    const previousTags = new Set(previous.tags || []);
    const nextTags = new Set(next.tags || []);
    addGroups("Etiquetas", {
        added: [...nextTags].filter((tag) => !previousTags.has(tag)).map((tag) => `#${tag}`),
        removed: [...previousTags].filter((tag) => !nextTags.has(tag)).map((tag) => `#${tag}`),
        modified: [],
    });

    const routeProfiles = { walking: "A pie", driving: "En coche", cycling: "En bicicleta" };
    const routeTypes = { straight: "Líneas rectas", streets: "Por calles" };
    const settingFields = [
        { label: "Título del viaje", read: (plan) => plan.tripTitle },
        { label: "Moneda local", read: (plan) => plan.localCurrency },
        { label: "Moneda extranjera", read: (plan) => plan.foreignCurrency },
        { label: "Tipo de cambio", read: (plan) => plan.exchangeRate },
        { label: "Fecha del cambio", read: (plan) => plan.exchangeRateDate },
        { label: "Páginas de notas", read: (plan) => plan.tripNotePages, format: (value) => `${Array.isArray(value) ? value.length : 0} página(s)` },
        { label: "Modo de viaje", read: (plan) => plan.routeProfile, format: (value) => routeProfiles[value] || previewValue(value) },
        { label: "Tipo de ruta", read: (plan) => plan.routeVisualization, format: (value) => routeTypes[value] || previewValue(value) },
        { label: "Trayectos", read: (plan) => plan.travelLegs || {}, format: (value) => `${Object.keys(value || {}).length} configurados` },
        { label: "Recordatorios", read: (plan) => plan.reminders || [], format: (value) => `${value.length} configurados` },
    ];
    const changedSettings = fieldChanges(previous, next, settingFields);
    if (changedSettings.length) {
        totals.modify += changedSettings.length;
        groups.push(modifiedGroup("Ajustes modificados", "Viaje", changedSettings));
    }

    return {
        stats: [
            { tone: "add", label: "Añadidos", value: totals.add },
            { tone: "modify", label: "Modificados", value: totals.modify },
            { tone: "remove", label: "Eliminados", value: totals.remove },
        ],
        groups,
    };
}
