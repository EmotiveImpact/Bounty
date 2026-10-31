// Personal goals, payout timing and baskets. Money is integer pence, time is
// minutes, calendar dates are YYYY-MM-DD. "Today" is always the London
// calendar date (http.londonDate), never the UTC date, so a count does not
// change at midnight UTC during British Summer Time.
//
// A basket is one shopping trip with one cash limit: every item bought on the
// trip shares one journey, and the whole basket's cash required before payout
// must fit the profile's budget. Figures are estimates from sample data and
// never a buy alert.
import { addMissingColumns } from "./contract.mjs";
import { fail, isCalendarDate, londonDate } from "./http.mjs";
import { SAMPLE_ASSUMPTIONS, lowerMedian, tripEconomics } from "./trip.mjs";
import {
  OPPORTUNITY_RULES,
  daysToSellAll,
  effectiveRules,
  hardFilters,
  meetsReturn,
} from "./opportunity.mjs";
import {
  accessNeeds,
  assessSample,
  blankInputs,
  categoryTerms,
  checkedAndUncertainty,
  describeRules,
  fareMissing,
  journeyFor,
  loadLimit,
  offerDemand,
  sameArea,
  unitThresholdFailures,
} from "./catalog.mjs";
import { getTrip, listTrips } from "./ledger.mjs";

// One settings row (id 1). dispatch_days is a JSON array of weekday numbers,
// 0 Sunday to 6 Saturday. days_to_sell, delivery_days and payout_delay_days
// are the member's assumptions in calendar days.
export const GOALS_TABLE = `CREATE TABLE IF NOT EXISTS goals (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 target_type TEXT NOT NULL DEFAULT 'income',
 monthly_target INTEGER NOT NULL DEFAULT 0,
 dispatch_days TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
 storage_units INTEGER NOT NULL DEFAULT 10,
 cash_needed_by TEXT,
 days_to_sell INTEGER NOT NULL DEFAULT 7,
 delivery_days INTEGER NOT NULL DEFAULT 2,
 payout_delay_days INTEGER NOT NULL DEFAULT 2,
 updated TEXT
)`;
const GOAL_COLUMNS = [
  "target_type",
  "monthly_target",
  "dispatch_days",
  "storage_units",
  "cash_needed_by",
  "days_to_sell",
  "delivery_days",
  "payout_delay_days",
  "updated",
];
// Types for columns added to an older table. ALTER TABLE needs a constant
// default for NOT NULL columns.
const GOAL_TYPES = {
  target_type: "TEXT NOT NULL DEFAULT 'income'",
  monthly_target: "INTEGER NOT NULL DEFAULT 0",
  dispatch_days: "TEXT NOT NULL DEFAULT '[1,2,3,4,5]'",
  storage_units: "INTEGER NOT NULL DEFAULT 10",
  cash_needed_by: "TEXT",
  days_to_sell: "INTEGER NOT NULL DEFAULT 7",
  delivery_days: "INTEGER NOT NULL DEFAULT 2",
  payout_delay_days: "INTEGER NOT NULL DEFAULT 2",
  updated: "TEXT",
};

export const DEFAULT_GOALS = Object.freeze({
  targetType: "income",
  monthlyTarget: 0,
  dispatchDays: Object.freeze([1, 2, 3, 4, 5]),
  storageUnits: 10,
  cashNeededBy: null,
  daysToSell: 7,
  deliveryDays: 2,
  payoutDelayDays: 2,
});

// Named goals: what the money is for (a hobby, fuel, a bill such as car
// insurance), the amount in pence, an optional deadline and the date from
// which received cash counts.
export const GOAL_TARGETS_TABLE = `CREATE TABLE IF NOT EXISTS goal_targets (
 id INTEGER PRIMARY KEY,
 name TEXT NOT NULL,
 amount INTEGER NOT NULL CHECK (amount > 0),
 deadline TEXT,
 start TEXT NOT NULL,
 created TEXT NOT NULL
)`;

/** Creates the goals tables, adding any missing column to an older one. */
export function schema(db) {
  db.exec(GOALS_TABLE);
  addMissingColumns(db, "goals", GOAL_COLUMNS, GOAL_TYPES);
  db.exec(GOAL_TARGETS_TABLE);
}

// A stored list that is unreadable becomes empty, which fails closed: no
// dispatch days means a payout cannot be scheduled.
function parseDays(value) {
  try {
    const days = JSON.parse(value);
    return Array.isArray(days)
      ? [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
      : [];
  } catch {
    return [];
  }
}

/** The saved goals, or the defaults (updated null) when none are saved. */
export function getGoals(db) {
  const row = db.prepare("SELECT * FROM goals WHERE id = 1").get();
  if (!row) return { ...DEFAULT_GOALS, dispatchDays: [...DEFAULT_GOALS.dispatchDays], updated: null };
  return {
    targetType: row.target_type === "savings" ? "savings" : "income",
    monthlyTarget: row.monthly_target,
    dispatchDays: parseDays(row.dispatch_days),
    storageUnits: row.storage_units,
    cashNeededBy: row.cash_needed_by || null,
    daysToSell: row.days_to_sell,
    deliveryDays: row.delivery_days,
    payoutDelayDays: row.payout_delay_days,
    updated: row.updated || null,
  };
}

// Validators whose messages are plain sentences naming the field as the
// Goals tab labels it, never a raw field name.
const whole = (value, min, max, message) =>
  Number.isSafeInteger(value) && value >= min && value <= max ? value : fail(message);
const optionalDate = (value, message) =>
  value === undefined || value === null || value === ""
    ? null
    : isCalendarDate(value)
      ? value
      : fail(message);

/**
 * Validates goals. Every field is required (cashNeededBy may be null).
 * The date cash is needed must be a real date, today (in London) or later.
 */
export function readGoals(input, { today }) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("Send the goals as a JSON object.");
  const raw = input.dispatchDays;
  const daysMessage = "Dispatch days must be a list of weekdays, from 0 (Sunday) to 6 (Saturday).";
  if (!Array.isArray(raw) || raw.length > 7) fail(daysMessage);
  const days = raw.map((d) => whole(d, 0, 6, daysMessage));
  if (new Set(days).size !== days.length) fail("Each dispatch day can be chosen only once.");
  const cashNeededBy = optionalDate(
    input.cashNeededBy,
    "The date you need the cash back must be a real calendar date.",
  );
  if (cashNeededBy && cashNeededBy < today)
    fail("The date you need the cash back must be today or later.");
  if (!["income", "savings"].includes(input.targetType))
    fail("Goal type must be income from resale or household savings.");
  return {
    targetType: input.targetType,
    monthlyTarget: whole(input.monthlyTarget, 0, 10_000_000, "The monthly target must be between £0 and £100,000."),
    dispatchDays: days.sort((a, b) => a - b),
    storageUnits: whole(input.storageUnits, 0, 100_000, "Storage at home must be a whole number of units from 0 to 100,000."),
    cashNeededBy,
    daysToSell: whole(input.daysToSell, 0, 365, "Days to sell must be a whole number from 0 to 365."),
    deliveryDays: whole(input.deliveryDays, 0, 60, "Delivery days must be a whole number from 0 to 60."),
    payoutDelayDays: whole(input.payoutDelayDays, 0, 60, "Payout delay must be a whole number of days from 0 to 60."),
  };
}

/** Validates and saves the single goals row, returning what was stored. */
export function saveGoals(db, input, { now = new Date().toISOString() } = {}) {
  const g = readGoals(input, { today: londonDate(now) });
  db.prepare(
    `INSERT INTO goals (id, target_type, monthly_target, dispatch_days, storage_units,
       cash_needed_by, days_to_sell, delivery_days, payout_delay_days, updated)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET target_type = excluded.target_type,
       monthly_target = excluded.monthly_target, dispatch_days = excluded.dispatch_days,
       storage_units = excluded.storage_units, cash_needed_by = excluded.cash_needed_by,
       days_to_sell = excluded.days_to_sell, delivery_days = excluded.delivery_days,
       payout_delay_days = excluded.payout_delay_days, updated = excluded.updated`,
  ).run(
    g.targetType,
    g.monthlyTarget,
    JSON.stringify(g.dispatchDays),
    g.storageUnits,
    g.cashNeededBy,
    g.daysToSell,
    g.deliveryDays,
    g.payoutDelayDays,
    now,
  );
  return getGoals(db);
}

const DAY = 86400000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const time = (date) => Date.parse(date + "T00:00:00Z");
export const addDays = (date, days) => new Date(time(date) + days * DAY).toISOString().slice(0, 10);
const weekday = (date) => new Date(time(date)).getUTCDay();
const daysBetween = (from, to) => Math.round((time(to) - time(from)) / DAY);

// "8 Nov 2026" for a YYYY-MM-DD date, for notes a person reads.
const ukDay = (iso) =>
  typeof iso === "string" && /^\d{4}-\d{2}-\d{2}$/.test(iso)
    ? new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(
        new Date(iso + "T12:00:00Z"),
      )
    : String(iso);

/**
 * When the cash comes back. The item is assumed to sell daysToSell calendar
 * days after start, is posted on the first dispatch day on or after the sale,
 * arrives deliveryDays later and is paid out payoutDelayDays after delivery.
 * With no dispatch days the payout cannot be scheduled: date is null and the
 * note says why.
 *
 * Returns { sold, dispatch, delivered, date, note }.
 */
export function payoutDate({ start, daysToSell, dispatchDays, deliveryDays, payoutDelayDays }) {
  const unknown = (note) => ({ sold: null, dispatch: null, delivered: null, date: null, note });
  if (typeof start !== "string" || !DATE.test(start) || !Number.isFinite(time(start)))
    return unknown("Start date unknown, so a payout date cannot be scheduled.");
  if (![daysToSell, deliveryDays, payoutDelayDays].every((n) => Number.isInteger(n) && n >= 0))
    return unknown("Selling, delivery or payout assumptions missing, so a payout date cannot be scheduled.");
  const days = Array.isArray(dispatchDays) ? dispatchDays : [];
  if (!days.length)
    return unknown("No dispatch days are set, so a payout date cannot be scheduled.");
  const sold = addDays(start, daysToSell);
  let dispatch = sold;
  for (let i = 0; i < 7 && !days.includes(weekday(dispatch)); i++) dispatch = addDays(dispatch, 1);
  if (!days.includes(weekday(dispatch)))
    return unknown("Dispatch days are not valid weekdays, so a payout date cannot be scheduled.");
  const delivered = addDays(dispatch, deliveryDays);
  const date = addDays(delivered, payoutDelayDays);
  return {
    sold,
    dispatch,
    delivered,
    date,
    note: `Assumes a sale by ${ukDay(sold)}, posting on ${ukDay(dispatch)}, delivery by ${ukDay(delivered)} and payout on ${ukDay(date)}.`,
  };
}

/**
 * Compares the expected payout with the date the cash is needed.
 * status is "on time", "late" (daysLate > 0) or "unknown" (no payout date or
 * no date set).
 */
export function cashTiming({ payoutDate: payout, cashNeededBy }) {
  if (!cashNeededBy)
    return { status: "unknown", daysLate: null, note: "No date is set for when you need the cash back." };
  if (!payout)
    return {
      status: "unknown",
      daysLate: null,
      note: `The payout date is unknown, so it cannot be checked against ${ukDay(cashNeededBy)}.`,
    };
  const late = daysBetween(cashNeededBy, payout);
  if (late > 0)
    return {
      status: "late",
      daysLate: late,
      note: `Payout expected ${ukDay(payout)}, ${late} day${late === 1 ? "" : "s"} after you need the cash (${ukDay(cashNeededBy)}).`,
    };
  return {
    status: "on time",
    daysLate: 0,
    note: `Payout expected ${ukDay(payout)}, on or before ${ukDay(cashNeededBy)}.`,
  };
}

/**
 * Days until the last unit of every item sells: the largest
 * opportunity.daysToSellAll over the items, with the goals' days to sell as
 * the time for one unit. Null when an item has more than one unit and an
 * unknown sales rate. With no items it is the goals' figure for one unit.
 */
export function lastSaleDays(goals, items = []) {
  if (!items.length) return goals.daysToSell;
  const days = items.map((it) =>
    daysToSellAll({ units: it.units, daysToSell: goals.daysToSell, salesPerWeek: it.salesPerWeek }),
  );
  return days.some((d) => d === null) ? null : Math.max(...days);
}

/**
 * Payout timing for a trip decided at `now` under the saved goals. start is
 * today in London. items is the units bought, [{ units, salesPerWeek }]; the
 * payout waits for the last unit to sell (lastSaleDays), so several units
 * are never assumed to sell as fast as one. Without items it is the payout
 * for one unit.
 *
 * Returns { start, daysToSell (until the last unit sells, null when the
 * sales rate is unknown), daysToSellOneUnit (the goals' assumption), units,
 * payout (payoutDate()), payoutDays (days from today to the payout, null when
 * it cannot be scheduled), cashNeededBy, cashNeededDays (days from today to
 * the cash date, null without one), cash (cashTiming()) }. evaluateAlert
 * reads payoutDays and cashNeededDays.
 */
export function tripTiming(goals, { now = new Date().toISOString(), items = [] } = {}) {
  const start = londonDate(now);
  const daysToSell = lastSaleDays(goals, items);
  const units = items.reduce((total, it) => total + (Number.isInteger(it.units) ? it.units : 0), 0);
  const payout =
    daysToSell === null
      ? {
          sold: null,
          dispatch: null,
          delivered: null,
          date: null,
          note: "The sales rate is unknown, so the time to sell every unit cannot be worked out and a payout date cannot be scheduled.",
        }
      : payoutDate({
          start,
          daysToSell,
          dispatchDays: goals.dispatchDays,
          deliveryDays: goals.deliveryDays,
          payoutDelayDays: goals.payoutDelayDays,
        });
  return {
    start,
    daysToSell,
    daysToSellOneUnit: goals.daysToSell,
    units: items.length ? units : 1,
    payout,
    payoutDays: payout.date ? daysBetween(start, payout.date) : null,
    cashNeededBy: goals.cashNeededBy || null,
    cashNeededDays: goals.cashNeededBy ? daysBetween(start, goals.cashNeededBy) : null,
    cash: cashTiming({ payoutDate: payout.date, cashNeededBy: goals.cashNeededBy }),
  };
}

// ---------------------------------------------------------------------------
// Named goals with deadlines

const EARLIEST = "2000-01-01";

/**
 * Validates a named goal. The deadline, when set, is today (in London) or
 * later; the date cash counts from is not in the future.
 */
export function readTarget(input, { today }) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("Send the goal as a JSON object.");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || input.name.length > 80) fail("Say what the money is for, in up to 80 characters.");
  const amount = whole(input.amount, 1, 10_000_000, "The amount must be between £0.01 and £100,000.");
  const deadline = optionalDate(input.deadline, "The deadline must be a real calendar date.");
  const start = optionalDate(input.start, "The date to count cash from must be a real calendar date.") || today;
  if (start < EARLIEST) fail("The date to count cash from must be in 2000 or later.");
  if (start > today) fail("The date to count cash from cannot be in the future.");
  if (deadline && deadline < today) fail("The deadline must be today or later.");
  return { name, amount, deadline, start };
}

/** Saves a new named goal and returns its id. */
export function addTarget(db, input, { now = new Date().toISOString() } = {}) {
  const t = readTarget(input, { today: londonDate(now) });
  const result = db
    .prepare("INSERT INTO goal_targets (name, amount, deadline, start, created) VALUES (?, ?, ?, ?, ?)")
    .run(t.name, t.amount, t.deadline, t.start, now);
  return Number(result.lastInsertRowid);
}

/** Deletes a named goal. 404 when there is none with that id. */
export function deleteTarget(db, id) {
  const result = db.prepare("DELETE FROM goal_targets WHERE id = ?").run(id);
  if (!result.changes) fail("No goal with id " + id, 404);
  return { deleted: id };
}

// Dated cash movements on resale trips, read through the ledger's own API:
// payouts in, receipts, expenses and refunds out. Sales and predictions are
// not cash and never count. Household savings are not earnings.
function cashMovements(db) {
  const moves = [];
  for (const trip of listTrips(db)) {
    if (trip.kind !== "resale") continue;
    for (const e of getTrip(db, trip.id).entries) {
      if (e.type === "payout") moves.push({ date: e.occurred, payout: e.amount, cost: 0 });
      else if (["receipt", "expense", "refund"].includes(e.type))
        moves.push({ date: e.occurred, payout: 0, cost: e.amount });
    }
  }
  return moves;
}

export const TARGET_BASIS =
  "Counts only cash received: payouts dated from the goal's start to its deadline (or to today), less receipts, expenses and refunds dated in the same days. Pending payouts and potential proceeds never count. Goals are funded in deadline order, and cash already counted towards an earlier goal whose dates overlap is not counted again.";

/**
 * Named goals with progress, earliest deadline first (goals without a
 * deadline last). For each goal:
 *   payouts, costs   cash dated within [start, deadline or today]
 *   received         payouts less costs, at least 0
 *   counted          received less what earlier overlapping goals counted,
 *                    capped at the amount
 *   remaining        amount less counted
 *   status           "reached", "in progress", "missed" (deadline passed
 *                    short of the amount)
 *   daysLeft         days to the deadline, null without one
 * Returns { targets, basis }.
 */
export function goalTargets(db, { now = new Date().toISOString() } = {}) {
  const today = londonDate(now);
  const rows = db.prepare("SELECT * FROM goal_targets").all();
  const moves = rows.length ? cashMovements(db) : [];
  const order = (r) => [r.deadline || "9999-12-31", Number(r.id)];
  rows.sort((a, b) => {
    const [da, ia] = order(a);
    const [db2, ib] = order(b);
    return da < db2 ? -1 : da > db2 ? 1 : ia - ib;
  });
  const done = [];
  const targets = rows.map((r) => {
    const end = r.deadline && r.deadline < today ? r.deadline : r.deadline || today;
    const within = moves.filter((m) => m.date >= r.start && m.date <= end);
    const payouts = within.reduce((t, m) => t + m.payout, 0);
    const costs = within.reduce((t, m) => t + m.cost, 0);
    const received = Math.max(0, payouts - costs);
    const shared = done
      .filter((d) => d.start <= end && d.end >= r.start)
      .reduce((t, d) => t + d.counted, 0);
    const counted = Math.min(Number(r.amount), Math.max(0, received - shared));
    const passed = Boolean(r.deadline) && r.deadline < today;
    const status = counted >= r.amount ? "reached" : passed ? "missed" : "in progress";
    done.push({ start: r.start, end, counted });
    return {
      id: Number(r.id),
      name: r.name,
      amount: Number(r.amount),
      deadline: r.deadline || null,
      start: r.start,
      created: r.created,
      payouts,
      costs,
      received,
      shared: Math.min(shared, received),
      counted,
      remaining: Number(r.amount) - counted,
      status,
      daysLeft: r.deadline ? daysBetween(today, r.deadline) : null,
    };
  });
  return { targets, basis: TARGET_BASIS };
}

// Basket search bounds and the shared-journey approximation. A basket's one
// journey runs to the furthest shop in it; each extra shop visited adds 0.5
// mile to the one-way distance (so a mile on the return trip, costed and timed
// at the transport's rate) and 5 minutes for the extra stop. This is a cautious
// approximation, not a route plan: shops in one area are usually closer.
export const BASKET_SEARCH = Object.freeze({
  maxOffers: 8,
  maxBaskets: 200_000,
  extraShopMiles: 0.5,
  extraShopMinutes: 5,
  top: 5,
});
export const BASKET_APPROXIMATION =
  "One journey per basket: the distance to the furthest shop, plus 0.5 mile each way and 5 minutes for every extra shop visited. This is a cautious approximation, not a planned route.";

const shopKey = (shop) => String(shop).trim().toLowerCase();

/** The single shared journey for a set of offers bought on one trip. */
export function basketJourney(profile, chosen) {
  const furthestMiles = Math.max(...chosen.map((o) => o.miles));
  const shops = new Set(chosen.map((o) => shopKey(o.shop))).size;
  const extraShops = Math.max(0, shops - 1);
  const route = journeyFor(profile, furthestMiles + extraShops * BASKET_SEARCH.extraShopMiles);
  return {
    ...route,
    minutes: route.minutes + extraShops * BASKET_SEARCH.extraShopMinutes,
    furthestMiles,
    shops,
    extraShops,
  };
}

// Splits the journey cost across items in proportion to units, so the
// shares sum exactly to the journey cost (the remainder goes to the first
// items). Used for each item's profit per unit; basket totals use the
// journey once.
function shareTravel(cost, units) {
  const total = units.reduce((a, b) => a + b, 0);
  const shares = units.map((u) => Math.floor((cost * u) / total));
  let left = cost - shares.reduce((a, b) => a + b, 0);
  for (let i = 0; left > 0; i = (i + 1) % shares.length, left--) shares[i]++;
  return shares;
}

const COST_KEYS = ["stock", "packaging", "postage", "fees", "returns", "travel"];
const better = (a, b) => b.contribution - a.contribution || (b.hourly ?? -Infinity) - (a.hourly ?? -Infinity);

/**
 * Compares baskets under one cash constraint.
 *
 * Searches unit allocations across the offers in the profile's area (at most
 * eight offers, at most BASKET_SEARCH.maxBaskets allocations). An offer
 * failing any buying threshold (price band, weight, profit per unit or
 * return, with the member's stricter values) never enters a basket: it is
 * listed under `excluded` with rejected: true and the reason. Profit per
 * unit is checked first with no travel (the best any basket can give it),
 * then in every basket with the item's share of the one journey; a basket in
 * which any item falls below the thresholds is never shown, and an offer
 * that falls below them in every basket that fits is listed as rejected too.
 * Each item is bounded by its stock, the load limit, storage, the profile's
 * maximum units, the trial batch for a first purchase and the units its
 * sales rate supports in the sell window after competing listings
 * (opportunity.demandUnits); the whole basket must also fit: cash required
 * before payout (including the one shared journey) within the budget, total
 * weight within the load limit, and total units within storage and the
 * maximum units per trip. The load limit is loadLimit() for the transport,
 * as in the Planner. Storage is the smaller of the profile's storage and the
 * goals' storage. Baskets are ranked by contribution after the journey, then
 * earnings per hour.
 *
 * Returns the top five baskets and the best single-item trip (plus the
 * thresholds applied and any looser override ignored), each with
 * economics, the downside if nothing sells and if half sells, cash timing
 * (the payout waits for the last unit to sell at the item's sales rate), and
 * the reasons it falls short. At most one basket is marked recommended: the
 * best-ranked one with positive contribution, the hourly target met, every
 * item inside the buying thresholds and the trial batch, a public transport
 * fare entered when travelling by public transport and, when a cash date is
 * set, the payout on time. A basket with contribution of zero or below is
 * never recommended. `timing` at the top level is the payout for one unit.
 */
export function basketOptions(offers, profile, goals, { now = new Date().toISOString() } = {}) {
  const rules = effectiveRules(profile.rules || {});
  const storage = Math.min(profile.storage, goals.storageUnits);
  const unitCap = Math.min(profile.quantity, storage);
  const load = loadLimit(profile.transport, profile.carry);
  const carryGrams = Math.floor(load * 1000 + 1e-6);
  const excluded = [];
  const pool = [];
  for (const offer of offers) {
    const brief = { sku: offer.sku, name: offer.name, shop: offer.shop };
    if (!sameArea(profile.area, offer.area)) {
      excluded.push({ ...brief, reason: "Outside your area" });
      continue;
    }
    const hard = hardFilters({ unitPrice: offer.buy, weightKg: offer.weight }, rules);
    if (hard.length) {
      excluded.push({ ...brief, reason: hard.join("; "), rejected: true });
      continue;
    }
    const blank = blankInputs(offer);
    if (blank.length) {
      excluded.push({
        ...brief,
        reason: `Profit per unit cannot be checked until these are entered: ${blank.join(", ")}`,
        rejected: true,
      });
      continue;
    }
    const grams = Math.round(offer.weight * 1000);
    const demand = offerDemand(offer);
    const caps = {
      stock: offer.stock,
      carry: grams > 0 ? Math.floor(carryGrams / grams) : 0,
      units: unitCap,
      trial: offer.provenItem === true ? unitCap : rules.trialUnits,
      demand: demand ?? 0, // unknown demand fails closed at 0 units
    };
    const max = Math.min(...Object.values(caps));
    if (!(max >= 1)) {
      const zero = {
        stock: "no stock on the shelf",
        carry: "your load limit",
        units: "your storage or maximum units",
        trial: "the trial batch",
        demand:
          demand === null
            ? "the sales rate or competing listings are unknown"
            : `expected demand in ${OPPORTUNITY_RULES.sellWindowWeeks} weeks after competing listings`,
      };
      excluded.push({
        ...brief,
        reason: "No units fit: " + Object.keys(caps).filter((k) => !(caps[k] >= 1)).map((k) => zero[k]).join(", "),
      });
      continue;
    }
    const terms = categoryTerms(offer, profile, now);
    const salePrice = lowerMedian([...offer.sales]) ?? 0;
    const base = {
      unitCost: offer.buy,
      salePrice,
      postage: offer.post,
      packaging: offer.pack,
      feeRate: profile.feeRate,
      feeFixed: profile.feeFixed,
      returnsRate: terms.returnsRate,
      journeyMinutes: 0,
      overheadMinutes: 0,
      handlingMinutes: offer.handlingMinutes,
    };
    // Contribution and cash are linear in units once the journey is fixed,
    // so one unit with no journey gives the per-unit figures. Its profit per
    // unit is the most any basket can give the item, so failing the
    // thresholds here means failing them in every basket.
    const one = tripEconomics({ ...base, units: 1, journeyCost: 0 });
    const best = unitThresholdFailures(one.contribution, offer.buy, rules);
    if (best.length) {
      const travels = journeyFor(profile, offer.miles).cost > 0;
      excluded.push({
        ...brief,
        reason: best.join("; ") + (travels ? " (even before its share of the journey)" : ""),
        rejected: true,
      });
      continue;
    }
    pool.push({ offer, base, terms, grams, max, net: one.contribution, cash: one.cashRequired });
  }
  pool.sort((a, b) => b.net - a.net);
  for (const p of pool.splice(BASKET_SEARCH.maxOffers))
    excluded.push({
      sku: p.offer.sku,
      name: p.offer.name,
      shop: p.offer.shop,
      reason: `Only the ${BASKET_SEARCH.maxOffers} strongest offers are searched`,
    });

  const timing = tripTiming(goals, { now });

  // Journeys depend only on which offers are in the basket.
  const journeys = new Map();
  const journeyOf = (mask) => {
    if (!journeys.has(mask))
      journeys.set(mask, basketJourney(profile, pool.filter((_, i) => mask & (1 << i)).map((p) => p.offer)));
    return journeys.get(mask);
  };

  // For each offer: whether it cleared the thresholds itself in any basket
  // that fits the budget, and otherwise its best profit per unit there.
  const cleared = pool.map(() => false);
  const bestFailing = pool.map(() => null);

  const alloc = new Array(pool.length).fill(0);
  const top = [];
  let bestSingle = null;
  let searched = 0;
  let truncated = false;
  const consider = (mask) => {
    const route = journeyOf(mask);
    let net = 0;
    let cash = 0;
    let minutes = route.minutes + SAMPLE_ASSUMPTIONS.overheadMinutes;
    pool.forEach((p, i) => {
      net += alloc[i] * p.net;
      cash += alloc[i] * p.cash;
      minutes += alloc[i] * p.offer.handlingMinutes;
    });
    cash += route.cost;
    if (cash > profile.budget) return;
    // Every item must stay inside the buying thresholds with its share of
    // the one journey (shared as describeBasket shares it).
    const chosen = [];
    pool.forEach((_, i) => alloc[i] > 0 && chosen.push(i));
    if (route.cost > 0) {
      const shares = shareTravel(route.cost, chosen.map((i) => alloc[i]));
      const failing = chosen.filter((i, k) => {
        const unitProfit = Math.floor((alloc[i] * pool[i].net - shares[k]) / alloc[i]);
        const ok = unitProfit >= rules.minUnitProfit && meetsReturn(unitProfit, pool[i].offer.buy, rules.minReturn);
        if (ok) cleared[i] = true;
        else if (bestFailing[i] === null || unitProfit > bestFailing[i]) bestFailing[i] = unitProfit;
        return !ok;
      });
      if (failing.length) return;
    } else for (const i of chosen) cleared[i] = true;
    const contribution = net - route.cost;
    const candidate = {
      alloc: [...alloc],
      mask,
      contribution,
      hourly: Math.round((contribution * 60) / minutes),
    };
    top.push(candidate);
    top.sort(better);
    if (top.length > BASKET_SEARCH.top) top.pop();
    if (chosen.length === 1 && (!bestSingle || better(candidate, bestSingle) < 0)) bestSingle = candidate;
  };
  const visit = (i, cash, grams, units, mask) => {
    if (truncated) return;
    if (i === pool.length) {
      if (!units) return;
      if (++searched > BASKET_SEARCH.maxBaskets) {
        truncated = true;
        searched--;
        return;
      }
      consider(mask);
      return;
    }
    const p = pool[i];
    for (let u = 0; u <= p.max; u++) {
      const c = cash + u * p.cash;
      const g = grams + u * p.grams;
      const n = units + u;
      // Lower bounds: the journey only adds cash, so these prunes are safe.
      if (c > profile.budget || g > carryGrams || n > unitCap) break;
      alloc[i] = u;
      visit(i + 1, c, g, n, u ? mask | (1 << i) : mask);
    }
    alloc[i] = 0;
  };
  visit(0, 0, 0, 0, 0);
  pool.forEach((p, i) => {
    if (cleared[i] || bestFailing[i] === null) return;
    excluded.push({
      sku: p.offer.sku,
      name: p.offer.name,
      shop: p.offer.shop,
      reason:
        unitThresholdFailures(bestFailing[i], p.offer.buy, rules, { atMost: true }).join("; ") +
        ` (with its share of the journey, in every basket ${truncated ? "searched" : "that fits"})`,
      rejected: true,
    });
  });

  const describe = (candidate) =>
    describeBasket(candidate, {
      pool,
      profile,
      goals,
      rules,
      now,
      route: journeyOf(candidate.mask),
      storage,
    });
  const baskets = top.map(describe);
  const single = bestSingle ? describe(bestSingle) : null;
  const pick = [...baskets, single].find((b) => b && b.reasons.length === 0 && b.economics.contribution > 0);
  for (const b of [...baskets, single]) if (b && pick && b.id === pick.id) b.recommended = true;

  return {
    sample: true,
    constraints: {
      budget: profile.budget,
      carry: load,
      carryEntered: profile.carry,
      storage,
      profileStorage: profile.storage,
      goalsStorage: goals.storageUnits,
      quantity: profile.quantity,
      unitCap,
      trialUnits: rules.trialUnits,
      sellWindowWeeks: OPPORTUNITY_RULES.sellWindowWeeks,
      hourlyTarget: profile.target,
      transport: profile.transport,
      fareMissing: fareMissing(profile),
      area: profile.area,
    },
    approximation: BASKET_APPROXIMATION,
    baskets,
    bestSingle: single,
    recommended: pick ? pick.id : null,
    excluded,
    searched,
    truncated,
    timing: basketTiming(timing),
    rules: describeRules(profile.rules || {}),
  };
}

// The timing fields a basket carries.
const basketTiming = (t) => ({
  payout: t.payout,
  cash: t.cash,
  payoutDays: t.payoutDays,
  daysToSell: t.daysToSell,
  daysToSellOneUnit: t.daysToSellOneUnit,
  units: t.units,
  cashNeededBy: t.cashNeededBy,
});

/**
 * Why a payout misses the cash date, in plain words with no raw dates: late
 * by a number of days, or not schedulable (with the reason).
 */
export function cashDateReason(timing) {
  if (timing.cash.status === "late") {
    const n = timing.cash.daysLate;
    return `Payout expected ${n} day${n === 1 ? "" : "s"} after you need the cash`;
  }
  return timing.payout.date
    ? "The payout cannot be checked against the date you need the cash"
    : `No payout date can be scheduled, so the date you need the cash cannot be met. ${timing.payout.note}`;
}

/** Full figures for one allocation, built only for the baskets returned. */
function describeBasket(candidate, { pool, profile, goals, rules, now, route, storage }) {
  const chosen = pool
    .map((p, i) => ({ p, units: candidate.alloc[i] }))
    .filter((x) => x.units > 0);
  const shares = shareTravel(route.cost, chosen.map((x) => x.units));
  // The basket's cash is back once the last unit of every item has sold.
  const sale = ({ p, units }) => ({ units, salesPerWeek: p.offer.salesPerWeek ?? null });
  const timing = tripTiming(goals, { now, items: chosen.map(sale) });
  const perItem = chosen.map(({ p, units }, k) => {
    const inputs = { ...p.base, units, journeyCost: shares[k] };
    return { full: tripEconomics(inputs), half: tripEconomics({ ...inputs, sellThrough: 0.5 }) };
  });
  const items = chosen.map(({ p, units }, k) => {
    const economics = perItem[k].full;
    const { opportunity, thresholds } = assessSample({
      offer: p.offer,
      economics,
      hourlyFloor: profile.target,
      rules,
      now,
      timing: tripTiming(goals, { now, items: [sale({ p, units })] }),
      categoryFailures: p.terms.failures,
      journeyKnown: !fareMissing(profile),
    });
    return {
      sku: p.offer.sku,
      name: p.offer.name,
      variant: p.offer.variant,
      shop: p.offer.shop,
      units,
      maxUnits: p.max,
      provenItem: p.offer.provenItem === true,
      weightKg: Math.round(units * p.offer.weight * 100) / 100,
      travelShare: shares[k],
      cashRequired: economics.cashRequired,
      contribution: economics.contribution,
      unitProfit: thresholds.unitProfit,
      returnOnCost: thresholds.returnOnCost,
      returnsRate: p.terms.returnsRate,
      halfSellsContribution: perItem[k].half.contribution,
      thresholds,
      opportunity,
      accessNeeds: accessNeeds(p.offer, profile),
      ...checkedAndUncertainty(p.offer),
    };
  });
  const sum = (pick) => perItem.reduce((total, e) => total + pick(e.full), 0);
  const costs = Object.fromEntries(COST_KEYS.map((key) => [key, sum((e) => e.costs[key])]));
  const units = sum((e) => e.units);
  const proceeds = sum((e) => e.proceeds);
  const totalCosts = COST_KEYS.reduce((total, key) => total + costs[key], 0);
  const contribution = proceeds - totalCosts;
  const cashRequired = sum((e) => e.cashRequired);
  const activeMinutes =
    route.minutes +
    SAMPLE_ASSUMPTIONS.overheadMinutes +
    chosen.reduce((total, x) => total + x.units * x.p.offer.handlingMinutes, 0);
  const hourly = activeMinutes ? Math.round((contribution * 60) / activeMinutes) : null;
  const unsoldLoss = -(costs.stock + costs.packaging + costs.travel);
  const halfSells = perItem.reduce((total, e) => total + e.half.contribution, 0);

  const reasons = [];
  if (!(contribution > 0)) reasons.push("Loses money");
  if (!(hourly >= profile.target)) reasons.push("Below hourly target");
  for (const it of items) {
    for (const failure of it.thresholds.failures) reasons.push(`${it.name}: ${failure}`);
    if (it.units > rules.trialUnits && !it.provenItem)
      reasons.push(`${it.name}: more than the trial batch of ${rules.trialUnits} for a first purchase`);
  }
  if (fareMissing(profile))
    reasons.push("Public transport fare not entered, so the journey is costed as free");
  if (goals.cashNeededBy && timing.cash.status !== "on time") reasons.push(cashDateReason(timing));

  return {
    id: items.map((it) => `${it.sku}:${it.units}`).join(","),
    items,
    shops: [...new Set(items.map((it) => it.shop))],
    journey: route,
    units,
    storage: { used: units, limit: storage },
    weightKg: Math.round(items.reduce((sum, it) => sum + it.weightKg, 0) * 100) / 100,
    economics: {
      units,
      proceeds,
      costs,
      totalCosts,
      contribution,
      cashRequired,
      journeyPerUnit: units ? Math.round(route.cost / units) : 0,
      activeMinutes,
      activeHours: Math.round((activeMinutes / 60) * 100) / 100,
      hourly,
      unsoldLoss,
    },
    downside: { nothingSells: unsoldLoss, halfSells },
    timing: basketTiming(timing),
    reasons,
    recommended: false,
  };
}
