import test from "node:test";
import assert from "node:assert/strict";

import {
    applicableTravelLeg,
    disconnectedTravelLegs,
    migrateLegacyTravelLegs,
    normalizeTravelLeg,
    parseTravelLegKey,
    travelLegKey,
} from "../js/core/travel-legs.js";
import {
    travelLegPresentation,
    visibleConsecutiveTravelLegs,
} from "../js/core/travel-leg-presentation.js";

test("normaliza metadatos seguros y extremos embebidos sin duplicados", () => {
    assert.deepEqual(normalizeTravelLeg({
        mode: "train",
        durationMinutes: 135,
        departureTime: "09:12",
        fixedDeparture: true,
        line: " Tokaido ",
        cost: 13320,
        embeddedEndpoints: ["from", "to", "from", "invalid"],
    }), {
        mode: "train",
        durationMinutes: 135,
        departureTime: "09:12",
        fixedDeparture: true,
        line: "Tokaido",
        cost: 13320,
        embeddedEndpoints: ["from", "to"],
    });
});

test("migra perfiles y overrides legacy y el formato nuevo prevalece", () => {
    const result = migrateLegacyTravelLegs(
        { "a>b": { mode: "train", line: "Nozomi", durationMinutes: 130 } },
        { "a>b": "walking", "b>c": "driving" },
        { "walking:a>b": 25, "driving:b>c": 40 },
        { spotIds: new Set(["a", "b", "c"]) },
    );
    assert.deepEqual(result["a>b"], { mode: "train", durationMinutes: 130, line: "Nozomi" });
    assert.deepEqual(result["b>c"], { mode: "driving", durationMinutes: 40 });
});

test("solo resuelve pares activos consecutivos y conserva desconectados", () => {
    const a = { id: "a" }, b = { id: "b" }, c = { id: "c" };
    const legs = { [travelLegKey("a", "b")]: { mode: "walking" }, [travelLegKey("a", "c")]: { mode: "bus", durationMinutes: 20 } };
    const day = { spots: [a, b, c] };
    assert.equal(applicableTravelLeg(legs, day, a, b), legs["a>b"]);
    assert.equal(applicableTravelLeg(legs, day, a, c), null);
    assert.deepEqual(disconnectedTravelLegs(legs, [day]), [["a>c", legs["a>c"]]]);
    assert.deepEqual(parseTravelLegKey("a>b"), { fromId: "a", toId: "b" });
});

test("clasifica duraciones automáticas, aproximadas y personalizadas", () => {
    assert.deepEqual(
        travelLegPresentation({ defaultMode: "walking", route: { minutes: 18 } }),
        {
            mode: "walking", modeLabel: "A pie", minutes: 18,
            status: "automatic", sourceLabel: "Duración estimada por ruta",
            actionLabel: "Personalizar",
        },
    );
    assert.equal(
        travelLegPresentation({ leg: { mode: "cycling" }, route: { minutes: 11, approximate: true } }).status,
        "approximate",
    );
    const custom = travelLegPresentation({
        leg: { mode: "driving", durationMinutes: 25 },
        route: { minutes: 17 },
    });
    assert.equal(custom.status, "custom");
    assert.equal(custom.minutes, 25);
    assert.equal(custom.sourceLabel, "Duración personalizada");
});

test("clasifica modos manuales completos, pendientes y rutas no disponibles", () => {
    assert.equal(
        travelLegPresentation({ leg: { mode: "train", durationMinutes: 90 } }).status,
        "manual",
    );
    const pending = travelLegPresentation({ leg: { mode: "bus" } });
    assert.equal(pending.status, "missing");
    assert.equal(pending.sourceLabel, "Duración pendiente");
    assert.equal(pending.actionLabel, "Completar");
    assert.equal(
        travelLegPresentation({ leg: { mode: "walking" } }).sourceLabel,
        "Estimación no disponible",
    );
});

test("los pares visibles respetan la secuencia activa real", () => {
    const a = { id: "a", tags: ["ver"] };
    const b = { id: "b", tags: [] };
    const c = { id: "c", tags: ["ver"] };
    const disabled = { id: "off", mapEnabled: false, tags: ["ver"] };
    const visible = (spot) => spot.tags.includes("ver");
    assert.deepEqual(
        visibleConsecutiveTravelLegs([a, b, c], { visible }),
        [],
    );
    assert.deepEqual(
        visibleConsecutiveTravelLegs([a, disabled, c], { visible }).map(({ from, to }) => `${from.id}>${to.id}`),
        ["a>c"],
    );
});
