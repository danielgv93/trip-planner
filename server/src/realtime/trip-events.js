import { EventEmitter } from "node:events";

// One process, one bus. The compose deployment runs a single api container, so
// an in-process emitter delivers every event to every connected collaborator.
// This module is the seam: the day the api runs on more than one instance, swap
// the emitter for Postgres LISTEN/NOTIFY here and nothing outside changes.
export function createTripEventBus() {
    const emitter = new EventEmitter();
    // Every open stream adds a listener; the default warning threshold of 10
    // would fire for a perfectly healthy group of collaborators.
    emitter.setMaxListeners(0);
    return {
        publish(tripId, event) {
            emitter.emit(String(tripId), event);
        },
        subscribe(tripId, listener) {
            const channel = String(tripId);
            emitter.on(channel, listener);
            return () => emitter.off(channel, listener);
        },
        listenerCount: (tripId) => emitter.listenerCount(String(tripId)),
    };
}
