// Membership plans. Everyone pays (no free version); every plan costs £1 for
// the first 7 days, then the full monthly price. The £1 start is meant to be
// used once per bank card (checked when payments are switched on), so a new
// email on the same card pays full price. Payments are not switched on yet: choosing a plan sets
// what the member sees while the app is tested, and nothing is charged.
//
// Money is integer pence. "opens" lists the screens and tools a plan adds;
// the client hides a screen behind an upgrade card when the member's plan
// does not open it. tipTier is the paid early-access position a plan gives
// (MEMBERSHIP_TIERS in opportunity.mjs), given to the scout profile linked
// to the account (applyPlanTier); areas is how many alert areas the plan
// covers (null: any). Scout levels earned from accurate tips are separate
// and are never bought.
import { fail, HttpError } from "./http.mjs";
import { applyPlanTier } from "./bounties.mjs";

export const PAYMENTS_ON = false;
export const INTRO_PENCE = 100;
export const INTRO_DAYS = 7;

export const FEATURES = Object.freeze({
  deals: "Deals near you",
  scan: "Scan: Buy, Think or Leave in the shop",
  stock: "Stock: what you bought and what sold",
  money: "Money: profit, goals and cash",
  tips: "Tips from other scouts",
  trip: "My trip: route, fuel and time, and whether it is worth it",
  research: "Research: the six-step check before you buy",
  taxExport: "Year-end export for your tax return",
});

export const PLANS = Object.freeze([
  {
    id: "starter",
    name: "Starter",
    pricePence: 399,
    forWho: "For side money: students, parents, anyone fitting it round life.",
    opens: ["deals", "scan", "stock", "money", "tips"],
    areas: 1,
    tipTiming: "Tips at the normal time",
    tipTier: "new",
  },
  {
    id: "plus",
    name: "Plus",
    pricePence: 999,
    forWho: "For regulars who plan trips and check finds properly.",
    opens: ["deals", "scan", "stock", "money", "tips", "trip", "research"],
    areas: 3,
    tipTiming: "Tip alerts 3 hours early",
    tipTier: "emerald",
  },
  {
    id: "fulltime",
    name: "Full-time",
    pricePence: 2499,
    forWho: "For full-time resellers who need the earliest tips and the paperwork.",
    opens: ["deals", "scan", "stock", "money", "tips", "trip", "research", "taxExport"],
    areas: null,
    tipTiming: "The earliest tip alerts",
    tipTier: "diamond",
  },
]);

export const planById = (id) => PLANS.find((p) => p.id === id) || null;

// Without member accounts (this machine, or a pilot behind the shared
// password) the one chosen plan is kept here.
const PLAN_TABLE = `CREATE TABLE IF NOT EXISTS membership_plan (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 plan TEXT,
 since TEXT
)`;

export function ensurePlanTable(db) {
  db.exec(PLAN_TABLE);
}

/** When the £1 start ends: INTRO_DAYS after the start, as an ISO time. */
export function introEnds(since) {
  const t = Date.parse(since);
  return Number.isNaN(t) ? null : new Date(t + INTRO_DAYS * 86400000).toISOString();
}

/** The member's plan as the client sees it, or null when none is chosen. */
export function describeChoice(row) {
  const plan = row?.plan ? planById(row.plan) : null;
  if (!plan) return null;
  return { id: plan.id, since: row.since, introEnds: introEnds(row.since) };
}

/**
 * GET /api/plans and POST /api/plans/choose. members is accounts() from
 * accounts.mjs, or null. With accounts on, the plan belongs to the signed-in
 * member and is kept in Postgres with the account; a signed-out visitor sees
 * the plans and no choice.
 */
export function routes(db, members = null, { now = () => new Date() } = {}) {
  ensurePlanTable(db);
  const local = {
    read: () => db.prepare("SELECT plan, since FROM membership_plan WHERE id = 1").get() || null,
    write: (plan, since) =>
      db
        .prepare(
          "INSERT INTO membership_plan (id, plan, since) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET plan = excluded.plan, since = excluded.since",
        )
        .run(plan, since),
  };

  async function current(req) {
    if (!members) return { signedIn: null, row: local.read() };
    const user = await members.user(req);
    if (!user) return { signedIn: false, row: null };
    return { signedIn: true, user, row: await members.plan(user.id) };
  }

  return [
    [
      "GET",
      "/api/plans",
      async ({ req }) => {
        const { signedIn, row } = await current(req);
        return {
          plans: PLANS,
          features: FEATURES,
          intro: { pence: INTRO_PENCE, days: INTRO_DAYS, oncePerCard: true },
          payments: PAYMENTS_ON,
          signedIn,
          current: describeChoice(row),
        };
      },
    ],
    [
      "POST",
      "/api/plans/choose",
      async ({ req, body }) => {
        const id = body?.plan;
        if (id !== null && !planById(id)) fail("plan must be starter, plus, fulltime or null");
        const since = id ? now().toISOString() : null;
        if (!members) {
          const before = local.read();
          // Moving between plans keeps the original start date.
          local.write(id, id && before?.plan ? before.since : since);
          return { current: describeChoice(local.read()) };
        }
        const user = await members.user(req);
        if (!user) throw new HttpError(401, "Sign in to choose a plan");
        const before = await members.plan(user.id);
        const row = await members.setPlan(user.id, id, id && before?.plan ? before.since : since);
        // The plan's tip timing reaches the linked scout profile now.
        applyPlanTier(db, user.email, id ? planById(id).tipTier : null, id ? planById(id).areas : 0);
        return { current: describeChoice(row) };
      },
    ],
  ];
}
