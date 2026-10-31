// Planner, goals and basket routes. Every body is validated before use:
// profiles by readProfile (money in pence, transport one of MODES, stricter
// thresholds checked), goals by readGoals.
import { fail } from "./http.mjs";
import { offers, planTrips, readProfile } from "./catalog.mjs";
import { basketOptions, getGoals, saveGoals } from "./goals.mjs";

// The server clock decides dates such as "today" for payout timing.
const serverNow = () => new Date().toISOString();

export function routes(db) {
  return [
    // Ranked sample trips for the profile: fitting ones first, then by
    // earnings per hour. Never a buy alert.
    ["POST", "/api/plan", ({ body }) => planTrips(readProfile(body), { now: serverNow() })],
    ["GET", "/api/goals", () => getGoals(db)],
    ["PUT", "/api/goals", ({ body }) => saveGoals(db, body, { now: serverNow() })],
    // One shopping trip, one cash limit, using the saved goals.
    [
      "POST",
      "/api/baskets",
      ({ body }) => {
        if (!body || typeof body !== "object" || !("profile" in body))
          fail("Send { profile } with your planning profile");
        return basketOptions(offers, readProfile(body.profile), getGoals(db), {
          now: serverNow(),
        });
      },
    ],
  ];
}
