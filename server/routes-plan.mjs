// Planner, goals and basket routes. Every body is validated before use:
// profiles by readProfile (money in pence, transport one of MODES, stricter
// thresholds checked), goals by readGoals, named goals by readTarget.
import { fail, int, reply } from "./http.mjs";
import { offers, planTrips, readProfile } from "./catalog.mjs";
import {
  addTarget,
  basketOptions,
  deleteTarget,
  getGoals,
  goalTargets,
  saveGoals,
  tripTiming,
} from "./goals.mjs";

// The server clock decides dates such as "today" for payout timing.
const serverNow = () => new Date().toISOString();

function idParam(value) {
  if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) fail("id must be a whole number");
  return int(Number(value), "id", 1, Number.MAX_SAFE_INTEGER);
}

export function routes(db) {
  return [
    // Ranked sample trips for the profile: fitting ones first, then by
    // earnings per hour, with payout timing from the saved goals. Offers
    // failing a hard filter are listed separately. Never a buy alert.
    [
      "POST",
      "/api/plan",
      ({ body }) => {
        const now = serverNow();
        return planTrips(readProfile(body), { now, timing: tripTiming(getGoals(db), { now }) });
      },
    ],
    ["GET", "/api/goals", () => getGoals(db)],
    ["PUT", "/api/goals", ({ body }) => saveGoals(db, body, { now: serverNow() })],
    // Named goals (what the money is for), counting only cash received.
    ["GET", "/api/goals/targets", () => goalTargets(db, { now: serverNow() })],
    [
      "POST",
      "/api/goals/targets",
      ({ body }) => {
        const now = serverNow();
        const id = addTarget(db, body, { now });
        return reply(201, { id, ...goalTargets(db, { now }) });
      },
    ],
    [
      "DELETE",
      "/api/goals/targets/:id",
      ({ params }) => {
        deleteTarget(db, idParam(params.id));
        return goalTargets(db, { now: serverNow() });
      },
    ],
    // One shopping trip, one cash limit, using the saved goals.
    [
      "POST",
      "/api/baskets",
      ({ body }) => {
        if (!body || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(body, "profile"))
          fail("Send { profile } with your planning profile");
        return basketOptions(offers, readProfile(body.profile), getGoals(db), {
          now: serverNow(),
        });
      },
    ],
  ];
}
