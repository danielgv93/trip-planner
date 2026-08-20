import { readTripAccess } from "./trip-access.js";

const HEARTBEAT_MS = 25_000;

export function createTripStreamController({ database, events }) {
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

            const send = (event) => {
                res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            };
            const unsubscribe = events.subscribe(tripId, send);
            // Comment frames keep proxies and mobile radios from dropping an
            // idle connection, and surface a dead socket to `close` promptly.
            const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
            heartbeat.unref?.();

            req.on("close", () => {
                clearInterval(heartbeat);
                unsubscribe();
                res.end();
            });
        },
    };
}
