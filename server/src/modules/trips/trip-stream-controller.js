import { readTripAccess } from "./trip-access.js";

const HEARTBEAT_MS = 25_000;

export function createTripStreamController({ database, events, presenceService = null }) {
    return {
        // Server-sent events instead of a WebSocket: the payloads only ever flow
        // server to client, the session cookie authenticates the request without
        // a second handshake, and the browser reconnects on its own.
        async streamTrip(req, res) {
            const userId = res.locals.activeSession.user_id;
            const tripId = req.params.tripId;
            await readTripAccess(database, tripId, userId);

            res.status(200).set({
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-store",
                connection: "keep-alive",
                // nginx buffers proxied responses by default, which would hold
                // every event until the stream closed. This disables it for the
                // route without touching the shared proxy configuration.
                "x-accel-buffering": "no",
            });
            res.flushHeaders?.();
            res.write("retry: 5000\n\n");

            let unsubscribe = () => {};
            let heartbeat = null;
            let closed = false;
            let snapshotSent = false;
            const buffered = [];
            const cleanup = () => {
                if (closed) return;
                closed = true;
                clearInterval(heartbeat);
                unsubscribe();
                res.end();
            };
            const writeEvent = (event) => {
                const cursor = ["revision", "operation"].includes(event.type) && Number.isInteger(Number(event.revision))
                    ? `id: ${Number(event.revision)}\n`
                    : "";
                res.write(`${cursor}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                if (event.type === "trip-deleted" || (event.type === "access-revoked" && event.userId === userId)) cleanup();
            };
            const send = (event) => {
                if (!snapshotSent && event.type.startsWith("presence-")) buffered.push(event);
                else writeEvent(event);
            };
            unsubscribe = events.subscribe(tripId, send);
            if (presenceService) {
                const snapshot = await presenceService.snapshot({ userId, tripId });
                writeEvent({ type: "presence-snapshot", ...snapshot });
            }
            snapshotSent = true;
            buffered.splice(0).forEach(writeEvent);
            // Comment frames keep proxies and mobile radios from dropping an
            // idle connection, and surface a dead socket to `close` promptly.
            heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
            heartbeat.unref?.();

            req.on("close", cleanup);
        },
    };
}
