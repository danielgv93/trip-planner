export function createMapViewportResetTracker() {
    let initialized = false;
    let activeDayId;

    return {
        shouldReset(nextActiveDayId) {
            const shouldReset = !initialized || nextActiveDayId !== activeDayId;
            initialized = true;
            activeDayId = nextActiveDayId;
            return shouldReset;
        },
    };
}
