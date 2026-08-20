import { store } from "../../core/store.js";
import { toast } from "../../shared/notify.js";
import { getTripRepository, updateEnvelope } from "../library/workspace.js";
import { dropRevokedTrip, getCloudClient, getCurrentUserId, refreshRemoteTrips } from "./coordinator.js";

// Only the trip that is open on screen gets a stream. Holding one connection
// per trip in the library would multiply sockets for no benefit: a trip nobody
// is looking at is refreshed by the existing focus/online reconciliation.
let source = null;
let streamedLocalId = null;
let streamedRemoteId = null;

function closeStream() {
    source?.close();
    source = null;
    streamedLocalId = null;
    streamedRemoteId = null;
}

async function pullRemoteRevision(localId) {
    const repository = getTripRepository();
    const envelope = await repository?.getTrip(localId);
    if (!envelope?.remote.id) return null;
    // A local edit still waiting in the outbox must win the race to the server.
    // Overwriting the document here would discard it without a trace, so the
    // pull is skipped and the existing conflict path takes over on the next
    // drain.
    if (await repository.getOutbox(localId)) return null;
    const response = await getCloudClient().getTrip(envelope.remote.id);
    if (Number(response.trip.current_revision) <= Number(envelope.remote.baseRevision)) return null;
    envelope.document = response.trip.document;
    envelope.remote.baseRevision = Number(response.trip.current_revision);
    envelope.remote.hash = response.trip.document_hash;
    envelope.remote.role = response.trip.role;
    envelope.remote.ownerId = response.trip.owner_id;
    envelope.remote.members = response.trip.members || [];
    envelope.syncState = "synced";
    await updateEnvelope(envelope);
    return envelope;
}

async function refreshMembership(localId) {
    const repository = getTripRepository();
    const envelope = await repository?.getTrip(localId);
    if (!envelope?.remote.id) return;
    const remote = (await refreshRemoteTrips().catch(() => []))
        .find((trip) => trip.id === envelope.remote.id);
    if (!remote) return;
    envelope.remote.role = remote.role;
    envelope.remote.ownerId = remote.owner_id;
    envelope.remote.members = remote.members || [];
    await updateEnvelope(envelope);
    document.dispatchEvent(new CustomEvent("trip-members-changed", { detail: { tripId: localId } }));
}

function attachHandlers(localId) {
    source.addEventListener("revision", async (event) => {
        const payload = JSON.parse(event.data);
        // Our own mutation comes back down the stream; applying it would be a
        // pointless round trip and a jarring repaint mid-edit.
        if (payload.actor?.userId && payload.actor.userId === getCurrentUserId()) return;
        try {
            const updated = await pullRemoteRevision(localId);
            if (updated) toast(`${payload.actor?.displayName || "Otro colaborador"} actualizó el viaje.`, "info");
        } catch {
            // The next focus or reconnection reconciles; a failed pull is not
            // worth interrupting the user for.
        }
    });

    source.addEventListener("members", () => void refreshMembership(localId));

    source.addEventListener("access-revoked", async (event) => {
        const payload = JSON.parse(event.data);
        if (payload.userId !== getCurrentUserId()) return void refreshMembership(localId);
        closeStream();
        await dropRevokedTrip(localId);
        toast("Ya no colaboras en este viaje.", "error");
    });

    source.addEventListener("trip-deleted", async () => {
        closeStream();
        await dropRevokedTrip(localId);
        toast("El propietario eliminó este viaje.", "error");
    });
}

export async function syncLiveTripStream() {
    const client = getCloudClient();
    const repository = getTripRepository();
    if (!client || !repository || !store.accountSession || store.accountSession.offline) return closeStream();
    const envelope = store.activeTripId ? await repository.getTrip(store.activeTripId) : null;
    const remoteId = envelope?.remote.id || null;
    if (!remoteId) return closeStream();
    if (remoteId === streamedRemoteId && source) return;
    closeStream();
    streamedLocalId = store.activeTripId;
    streamedRemoteId = remoteId;
    // The session cookie authenticates the stream, so no handshake of our own:
    // `withCredentials` is the only reason this reaches the API authenticated.
    source = new EventSource(client.tripEventsUrl(remoteId), { withCredentials: true });
    attachHandlers(streamedLocalId);
}

export function initializeLiveTripStream() {
    if (typeof EventSource !== "function") return;
    for (const event of ["active-trip-changed", "cloud-session-changed", "trip-library-changed"]) {
        document.addEventListener(event, () => void syncLiveTripStream());
    }
    void syncLiveTripStream();
}
