import { normalizePortablePlan } from "./portable-plan.js";
import { createTripEnvelope } from "./trip-envelope.js";

export const LEGACY_MIGRATION_MARKER = "legacy-single-trip-migrated-v1";

export async function migrateLegacyTrip({ repository, localStorage, createId, now = () => new Date().toISOString() }) {
    if (await repository.getPreference(LEGACY_MIGRATION_MARKER)) return { status: "already-migrated" };
    const raw = localStorage.getItem("trip-planner") || localStorage.getItem("japan-planner");
    if (!raw) {
        await repository.setPreference(LEGACY_MIGRATION_MARKER, true);
        return { status: "nothing-to-migrate" };
    }
    try {
        const parsed = JSON.parse(raw);
        const document = normalizePortablePlan(Array.isArray(parsed) ? { days: parsed } : parsed);
        const id = createId();
        const envelope = createTripEnvelope({
            id,
            document,
            updatedAt: now(),
            preferences: Array.isArray(parsed) ? {} : {
                backlogCollapsed: parsed.backlogCollapsed === true,
                basemap: parsed.basemap,
                workspaceSplit: parsed.workspaceSplit,
                itineraryDensity: parsed.itineraryDensity,
                activeTripNotePageId: parsed.activeTripNotePageId,
            },
        });
        await repository.putTrip(envelope);
        const verified = await repository.getTrip(id);
        if (!verified || verified.document.tripTitle !== envelope.document.tripTitle) throw new Error("MIGRATION_VERIFY_FAILED");
        await repository.setPreference(LEGACY_MIGRATION_MARKER, { id, migratedAt: now() });
        return { status: "migrated", id };
    } catch (error) {
        return { status: "failed", error };
    }
}
