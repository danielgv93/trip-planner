import test from "node:test";
import assert from "node:assert/strict";

import {
    PLAN_VERSION,
    normalizePortablePlan,
    parsePortablePlanJson,
    portablePlanFrom,
} from "../js/core/portable-plan.js";
import {
    canonicalPlanHash,
    canonicalPlanJson,
    sha256,
} from "../js/core/plan-hash.js";
import {
    LOCAL_TRIP_VERSION,
    createTripEnvelope,
    normalizeTripEnvelope,
} from "../js/core/trip-envelope.js";

function legacyPlan() {
    return {
        tripTitle: "Ruta antigua",
        tripNotes: "Billetes en la mochila",
        days: [{
            id: "day-1",
            date: "2026-08-12",
            title: "Llegada",
            spots: [
                { id: "spot-1", name: "Estación" },
                { id: "spot-2", name: "Hotel", kind: "waypoint" },
            ],
        }],
        routeTimeProfiles: { "spot-1>spot-2": "walking" },
        routeTimeOverrides: { "walking:spot-1>spot-2": 12 },
    };
}

test("el códec portable puro normaliza planes legacy sin estado del navegador", () => {
    const normalized = normalizePortablePlan(legacyPlan());
    assert.equal(normalized.version, PLAN_VERSION);
    assert.equal(normalized.tripNotePages[0].content, "Billetes en la mochila");
    assert.deepEqual(normalized.travelLegs["spot-1>spot-2"], {
        mode: "walking",
        durationMinutes: 12,
    });
    assert.equal(Object.hasOwn(normalized, "activeTripNotePageId"), false);
    assert.equal(Object.hasOwn(normalized, "backlogCollapsed"), false);
});
test("parsePortablePlanJson distingue JSON inválido de documento inválido", () => {
    assert.throws(() => parsePortablePlanJson("{"), /INVALID_JSON/);
    assert.throws(() => parsePortablePlanJson("{}"), /INVALID_PLAN/);
});

test("portablePlanFrom selecciona únicamente campos exportables", () => {
    const state = legacyPlan().days.map((day) => ({ ...day, collapsed: true }));
    const source = {
        ...normalizePortablePlan(legacyPlan()),
        state,
        ownerId: "user-secret",
        session: "session-secret",
        activeTripId: "local-id",
        remoteRevision: 19,
        outbox: [{ clientMutationId: "mutation-secret" }],
        basemap: "osm",
        workspaceSplit: 0.4,
        activeTagFilter: new Set(["privado"]),
        undoHistory: [{ secret: true }],
    };
    const portable = portablePlanFrom(source);
    for (const field of [
        "ownerId", "session", "activeTripId", "remoteRevision", "outbox",
        "basemap", "workspaceSplit", "activeTagFilter", "undoHistory",
    ]) {
        assert.equal(Object.hasOwn(portable, field), false, field);
    }
    assert.equal(Object.hasOwn(portable.days[0], "collapsed"), false);
    assert.equal(Object.hasOwn(normalizePortablePlan({ ...legacyPlan(), days: state }).days[0], "collapsed"), false);
});

test("el hash SHA-256 es estándar y el hash canónico ignora exportedAt y orden de claves", () => {
    assert.equal(
        sha256("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const first = { ...legacyPlan(), exportedAt: "2026-01-01T00:00:00.000Z" };
    const second = {
        days: legacyPlan().days,
        routeTimeOverrides: legacyPlan().routeTimeOverrides,
        routeTimeProfiles: legacyPlan().routeTimeProfiles,
        tripNotes: legacyPlan().tripNotes,
        tripTitle: legacyPlan().tripTitle,
        exportedAt: "2030-01-01T00:00:00.000Z",
    };
    assert.equal(canonicalPlanJson(first), canonicalPlanJson(second));
    assert.equal(canonicalPlanHash(first), canonicalPlanHash(second));
});

test("el envoltorio local versionado mantiene identidad y preferencias fuera del documento", () => {
    const envelope = createTripEnvelope({
        id: "local-trip",
        document: legacyPlan(),
        remoteId: "remote-trip",
        baseRevision: 7,
        remoteHash: canonicalPlanHash(legacyPlan()),
        syncState: "pending",
        preferences: { basemap: "osm", itineraryDensity: "compact" },
    });
    assert.equal(envelope.version, LOCAL_TRIP_VERSION);
    assert.equal(envelope.remote.baseRevision, 7);
    assert.equal(envelope.document.remote, undefined);
    assert.equal(envelope.document.preferences, undefined);
    assert.deepEqual(normalizeTripEnvelope(envelope), envelope);
});

test("normalizar entradas cloud no permite que sus metadatos entren al documento", () => {
    const normalized = normalizePortablePlan({
        ...legacyPlan(),
        ownerId: "owner",
        session: "session",
        revision: 42,
        syncState: "synced",
        preferences: { basemap: "osm" },
        outbox: [{ id: "mutation" }],
    });
    assert.deepEqual(
        Object.keys(normalized).filter((key) => [
            "ownerId", "session", "revision", "syncState", "preferences", "outbox",
        ].includes(key)),
        [],
    );
});
