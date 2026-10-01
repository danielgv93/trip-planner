import { readFileSync } from "node:fs";

const fixtureUrl = new URL("./test-trip-14-days.json", import.meta.url);
const source = readFileSync(fixtureUrl, "utf8");

// Returns a fresh, mutable copy of the 14-day test trip on every call so tests
// never leak mutations into each other. Test-only data: never ship it in the app.
export function loadTestTrip() {
    return JSON.parse(source);
}

export const TEST_TRIP_JSON = source;
