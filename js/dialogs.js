// The add/edit place dialog (with Nominatim search + Wikipedia preview) and the
// tag / category manager dialogs. Wires its own listeners on module load.

import { store, save, dayBy } from "./store.js";
import { $, esc, slug, id } from "./dom.js";
import { toast, confirmAction } from "./notify.js";
import { render } from "./render.js";
import { drawMap, setPreview, openPreview } from "./map.js";
import { fetchSpotImage } from "./images.js";

const dialog = $("#placeDialog");
const tagDialog = $("#tagDialog");
const categoryDialog = $("#categoryDialog");

// { dayId, spot } target of the currently open place dialog. Only this module
// touches it, so it stays a module-local rather than living in the store.
let editing = null;
let searchTimer;
let imageTimer;
// Guards a slow response for an older name from overwriting a newer one.
let imageToken = 0;

// Native time inputs normally provide this shape, but stored/imported data may
// not. Keep only canonical 24-hour values before they reach the form or state.
export function normalizeTime(value) {
    return typeof value === "string" &&
        /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
        ? value
        : undefined;
}

function renderTagOptions(selected = []) {
    const el = $("#tagOptions");
    el.innerHTML = store.tags.length
        ? ""
        : '<small class="form-hint">Crea etiquetas desde el gestor para clasificarlas.</small>';
    store.tags.forEach((tag) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className =
            "tag-option " + (selected.includes(tag) ? "selected" : "");
        b.textContent = "#" + tag;
        b.onclick = () => b.classList.toggle("selected");
        el.append(b);
    });
}

function selectedTags() {
    return [...document.querySelectorAll("#tagOptions .selected")].map((x) =>
        x.textContent.slice(1),
    );
}

function renderCategoryOptions(selected = []) {
    const el = $("#categoryOptions");
    el.innerHTML = "";
    store.categories.forEach((c) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className =
            "category-option " + (selected.includes(c.id) ? "selected" : "");
        b.dataset.category = c.id;
        b.style.setProperty("--category-color", c.color);
        b.textContent = c.label;
        b.onclick = () => {
            const wasSelected = b.classList.contains("selected");
            el.querySelectorAll(".category-option").forEach((x) =>
                x.classList.remove("selected"),
            );
            if (!wasSelected) b.classList.add("selected");
        };
        el.append(b);
    });
}

function selectedCategory() {
    const el = $("#categoryOptions .selected");
    return el ? el.dataset.category : undefined;
}

export function openDialog(dayId, spot) {
    editing = { dayId, spot };
    store.selectedLocation =
        spot?.lat != null
            ? {
                  lat: spot.lat,
                  lng: spot.lng,
                  display_name: spot.address || spot.name,
              }
            : null;
    $("#dialogTitle").textContent = spot ? "Editar parada" : "Añadir una parada";
    $("#placeName").value = spot?.name || "";
    $("#placeAddress").value = spot?.address || "";
    $("#placeNote").value = spot?.note || "";
    $("#placeCost").value = Number.isFinite(spot?.cost) ? spot.cost : "";
    $("#placeCostCurrency").textContent = store.foreignCurrency;
    $("#placeOpeningTime").value = normalizeTime(spot?.openingTime) || "";
    $("#placeClosingTime").value = normalizeTime(spot?.closingTime) || "";
    $("#resetCost").hidden = !spot;
    renderTagOptions(spot?.tags || []);
    renderCategoryOptions(spot?.category ? [spot.category] : []);
    $("#suggestions").hidden = true;
    $("#searchStatus").textContent = store.selectedLocation
        ? "Ubicación actual: " + store.selectedLocation.display_name
        : "Escribe una zona o dirección para ver sugerencias.";
    dialog.showModal();
    openPreview(store.selectedLocation);
    $("#placeName").focus();
    updateSpotImage();
}

async function updateSpotImage() {
    const box = $("#spotImage"),
        name = $("#placeName").value.trim();
    if (name.length < 2) {
        box.hidden = true;
        box.innerHTML = "";
        return;
    }
    // Token guards against a slow response for an older name overwriting the
    // image of a newer one (same pattern as routeToken).
    const token = ++imageToken;
    box.hidden = false;
    box.innerHTML = '<div class="spot-image-status">Buscando imagen…</div>';
    const found = await fetchSpotImage(name);
    if (token !== imageToken) return;
    box.innerHTML = found
        ? `<img src="${esc(found.src)}" alt="${esc(name)}" loading="lazy" /><div class="spot-image-caption">Imagen: ${esc(found.title)} · Wikipedia</div>`
        : '<div class="spot-image-status">Sin imagen para este nombre.</div>';
}

async function searchPlaces(q) {
    if (q.length < 3) {
        $("#suggestions").hidden = true;
        $("#searchStatus").textContent =
            "Escribe al menos 3 caracteres para buscar.";
        return;
    }
    $("#searchStatus").textContent = "Buscando lugares…";
    try {
        const r = await fetch(
            "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=1&q=" +
                encodeURIComponent(q),
            { headers: { "Accept-Language": "es" } },
        );
        const results = await r.json(),
            box = $("#suggestions");
        box.innerHTML = "";
        results.forEach((place) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "suggestion";
            b.innerHTML = `<b>${esc(place.display_name.split(",").slice(0, 2).join(","))}</b><small>${esc(place.display_name)}</small>`;
            b.onclick = () => {
                $("#placeAddress").value = place.display_name;
                box.hidden = true;
                setPreview({
                    lat: +place.lat,
                    lng: +place.lon,
                    display_name: place.display_name,
                });
            };
            box.append(b);
        });
        box.hidden = !results.length;
        $("#searchStatus").textContent = results.length
            ? "Elige una sugerencia para ver el punto exacto."
            : "No se han encontrado resultados.";
    } catch {
        $("#searchStatus").textContent =
            "No se ha podido buscar ahora. Puedes guardar la parada manualmente.";
    }
}

$("#placeAddress").addEventListener("input", (e) => {
    store.selectedLocation = null;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => searchPlaces(e.target.value.trim()), 450);
});

$("#placeName").addEventListener("input", () => {
    clearTimeout(imageTimer);
    imageTimer = setTimeout(updateSpotImage, 500);
});

$("#resetCost").addEventListener("click", () => {
    $("#placeCost").value = "0";
    $("#placeCost").focus();
});

$("#placeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#placeName").value.trim(),
        address = $("#placeAddress").value.trim(),
        note = $("#placeNote").value.trim(),
        costValue = $("#placeCost").value.trim(),
        openingTime = normalizeTime($("#placeOpeningTime").value),
        closingTime = normalizeTime($("#placeClosingTime").value),
        parsedCost = Number(costValue),
        cost =
            costValue !== "" && Number.isFinite(parsedCost) && parsedCost > 0
                ? parsedCost
                : undefined,
        coordinates = store.selectedLocation || null,
        spotTags = selectedTags(),
        category = selectedCategory();
    const target =
        editing.dayId === "backlog" ? store.backlog : dayBy(editing.dayId).spots;
    let spot = editing.spot;
    if (spot) {
        Object.assign(spot, {
            name,
            address,
            note,
            tags: spotTags,
        });
        if (coordinates) Object.assign(spot, coordinates);
        else (delete spot.lat, delete spot.lng);
        if (category) spot.category = category;
        else delete spot.category;
    } else {
        spot = { id: id(), name, address, note, tags: spotTags };
        if (coordinates) Object.assign(spot, coordinates);
        if (category) spot.category = category;
        target.push(spot);
    }
    if (cost === undefined) delete spot.cost;
    else spot.cost = cost;
    if (openingTime === undefined) delete spot.openingTime;
    else spot.openingTime = openingTime;
    if (closingTime === undefined) delete spot.closingTime;
    else spot.closingTime = closingTime;
    store.active = editing.dayId;
    dialog.close();
    save();
    render();
    drawMap();
});

dialog.querySelector(".close").onclick = dialog.querySelector(
    ".cancel",
).onclick = () => dialog.close();

// A click whose target is the <dialog> itself happened on its backdrop, rather
// than on the dialog content. Keep clicks inside forms and managers untouched.
[dialog, tagDialog, categoryDialog].forEach((modal) => {
    modal.addEventListener("click", (event) => {
        if (event.target === modal) modal.close();
    });
});

function renderManagerTags() {
    const list = $("#managerTags");
    list.innerHTML = store.tags.length
        ? ""
        : '<p class="form-hint">Aún no hay etiquetas.</p>';
    store.tags.forEach((tag) => {
        const row = document.createElement("div");
        row.className = "manager-tag";
        row.innerHTML = `<span class="tag">#${esc(tag)}</span><button title="Borrar etiqueta">Eliminar</button>`;
        row.querySelector("button").onclick = () => {
            confirmAction({
                title: "Borrar etiqueta",
                message: `¿Borrar la etiqueta #${tag} de todas las paradas?`,
            }).then((ok) => {
                if (!ok) return;
                store.tags = store.tags.filter((t) => t !== tag);
                [...store.state.flatMap((d) => d.spots), ...store.backlog].forEach(
                    (s) =>
                        (s.tags = (s.tags || []).filter((t) => t !== tag)),
                );
                store.activeTagFilter.delete(tag);
                save();
                render();
                renderManagerTags();
                toast(`Etiqueta #${tag} eliminada.`, "info");
            });
        };
        list.append(row);
    });
}

$("#manageTags").onclick = () => {
    renderManagerTags();
    tagDialog.showModal();
};
tagDialog.querySelector(".close").onclick = () => tagDialog.close();
$("#addTag").onclick = () => {
    const value = $("#newTag").value.trim().replace(/^#/, "").toLowerCase();
    if (value && !store.tags.includes(value)) {
        store.tags.push(value);
        $("#newTag").value = "";
        save();
        render();
        renderManagerTags();
    }
};

function renderManagerCategories() {
    const list = $("#managerCategories");
    list.innerHTML = store.categories.length
        ? ""
        : '<p class="form-hint cat-empty">Aún no hay categorías. Añade la primera arriba.</p>';
    store.categories.forEach((c) => {
        const row = document.createElement("div");
        row.className = "manager-category";
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "manager-category-name";
        nameInput.value = c.label;
        let lastValid = c.label;
        nameInput.addEventListener("input", (e) => {
            c.label = e.target.value;
            save();
            render();
            drawMap();
        });
        nameInput.addEventListener("blur", (e) => {
            const trimmed = e.target.value.trim();
            if (!trimmed) {
                e.target.value = lastValid;
                c.label = lastValid;
                save();
                render();
                drawMap();
            } else {
                lastValid = trimmed;
            }
        });
        const colorInput = document.createElement("input");
        colorInput.type = "color";
        colorInput.className = "cat-swatch";
        colorInput.title = "Color de la categoría";
        colorInput.value = c.color;
        colorInput.addEventListener("input", (e) => {
            c.color = e.target.value;
            save();
            render();
            drawMap();
        });
        const connectToggle = document.createElement("label");
        connectToggle.className = "connect-toggle";
        const sw = document.createElement("span");
        sw.className = "switch";
        const swInput = document.createElement("input");
        swInput.type = "checkbox";
        swInput.checked = c.connects !== false;
        const slider = document.createElement("span");
        slider.className = "slider";
        const swIcon = document.createElement("span");
        swIcon.className = "connect-icon";
        swIcon.textContent = "🔗";
        swIcon.setAttribute("aria-hidden", "true");
        // Icon-only label: the tooltip + aria-label carry the meaning, and the 🔗
        // dims (see .is-off) when the category is a loose point.
        const syncConnect = () => {
            const on = swInput.checked;
            connectToggle.classList.toggle("is-off", !on);
            const msg = on
                ? "Nexo activo: esta categoría se une con la línea de la ruta. Toca para desconectar."
                : "Punto suelto: mantiene su número en el mapa pero no se conecta con líneas. Toca para conectar.";
            connectToggle.title = msg;
            swInput.setAttribute("aria-label", msg);
        };
        swInput.addEventListener("change", (e) => {
            c.connects = e.target.checked;
            syncConnect();
            save();
            drawMap();
        });
        sw.append(swInput, slider);
        connectToggle.append(sw, swIcon);
        syncConnect();
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "cat-del";
        delBtn.title = "Borrar categoría";
        delBtn.setAttribute("aria-label", "Borrar categoría");
        delBtn.textContent = "×";
        delBtn.onclick = () => {
            const n = [
                ...store.state.flatMap((d) => d.spots),
                ...store.backlog,
            ].filter((s) => s.category === c.id).length;
            confirmAction({
                title: "Borrar categoría",
                message: `¿Borrar la categoría "${c.label}"? ${n} parada(s) quedarán sin categoría.`,
            }).then((ok) => {
                if (!ok) return;
                store.categories = store.categories.filter((x) => x.id !== c.id);
                [
                    ...store.state.flatMap((d) => d.spots),
                    ...store.backlog,
                ].forEach((s) => {
                    if (s.category === c.id) delete s.category;
                });
                save();
                render();
                drawMap();
                renderManagerCategories();
                toast(`Categoría "${c.label}" eliminada.`, "info");
            });
        };
        const controls = document.createElement("div");
        controls.className = "cat-controls";
        controls.append(connectToggle, delBtn);
        row.append(colorInput, nameInput, controls);
        list.append(row);
    });
}

$("#manageCategories").onclick = () => {
    renderManagerCategories();
    categoryDialog.showModal();
};
categoryDialog.querySelector(".close").onclick = () => categoryDialog.close();
$("#addCategory").onclick = () => {
    const name = $("#newCategoryName").value.trim();
    if (!name) return;
    const color = $("#newCategoryColor").value;
    let catId = slug(name);
    if (store.categories.some((c) => c.id === catId))
        catId += "-" + Date.now().toString(36);
    store.categories.push({ id: catId, label: name, color, connects: true });
    $("#newCategoryName").value = "";
    save();
    render();
    drawMap();
    renderManagerCategories();
};
