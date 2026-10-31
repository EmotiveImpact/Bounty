// Personal goals, payout timing and baskets. Money is integer pence, time is
// minutes, calendar dates are YYYY-MM-DD in UTC.
//
// A basket is one shopping trip with one cash limit: every item bought on the
// trip shares one journey, and the whole basket's cash required before payout
// must fit the profile's budget. Figures are estimates from sample data and
// never a buy alert.
import { addMissingColumns } from "./contract.mjs";
import { fail, int, isoDate, oneOf } from "./http.mjs";
import { SAMPLE_ASSUMPTIONS, lowerMedian, tripEconomics } from "./trip.mjs";
import { effectiveRules } from "./opportunity.mjs";
import { assessSample, describeRules, journeyFor, sameArea } from "./catalog.mjs";

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

/** Creates the goals table, adding any missing column to an older one. */
export function schema(db) {
  db.exec(GOALS_TABLE);
  addMissingColumns(db, "goals", GOAL_COLUMNS, GOAL_TYPES);
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

/**
 * Validates goals. Every field is required (cashNeededBy may be null).
 * The date cash is needed must be a real date, today or later.
 */
export function readGoals(input, { today }) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("Send the goals as a JSON object");
  const raw = input.dispatchDays;
  if (!Array.isArray(raw) || raw.length > 7)
    fail("dispatchDays must be a list of weekday numbers from 0 (Sunday) to 6 (Saturday)");
  const days = raw.map((d, i) => int(d, `dispatchDays[${i}]`, 0, 6));
  if (new Set(days).size !== days.length) fail("dispatchDays must not repeat a day");
  const cashNeededBy = isoDate(input.cashNeededBy, "cashNeededBy", { optional: true });
  if (cashNeededBy && cashNeededBy < today)
    fail("cashNeededBy must be today or later");
  return {
    targetType: oneOf(input.targetType, "targetType", ["income", "savings"]),
    monthlyTarget: int(input.monthlyTarget, "monthlyTarget (pence)", 0, 10_000_000),
    dispatchDays: days.sort((a, b) => a - b),
    storageUnits: int(input.storageUnits, "storageUnits", 0, 100_000),
    cashNeededBy,
    daysToSell: int(input.daysToSell, "daysToSell", 0, 365),
    deliveryDays: int(input.deliveryDays, "deliveryDays", 0, 60),
    payoutDelayDays: int(input.payoutDelayDays, "payoutDelayDays", 0, 60),
  };
}

/** Validates and saves the single goals row, returning what was stored. */
export function saveGoals(db, input, { now = new Date().toISOString() } = {}) {
  const g = readGoals(input, { today: now.slice(0, 10) });
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
    note: `Assumes a sale by ${sold}, posting on ${dispatch}, delivery by ${delivered} and payout on ${date}.`,
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
      note: `The payout date is unknown, so it cannot be checked against ${cashNeededBy}.`,
    };
  const late = daysBetween(cashNeededBy, payout);
  if (late > 0)
    return {
      status: "late",
      daysLate: late,
      note: `Payout expected ${payout}, ${late} day${late === 1 ? "" : "s"} after you need the cash (${cashNeededBy}).`,
    };
  return {
    status: "on time",
    daysLate: 0,
    note: `Payout expected ${payout}, on or before ${cashNeededBy}.`,
  };
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
 * eight offers, at most BASKET_SEARCH.maxBaskets allocations). Each item is
 * bounded by its stock, the carry limit, storage and the profile's maximum
 * units; the whole basket must also fit: cash required before payout
 * (including the one shared journey) within the budget, total weight within
 * the carry limit, and total units within storage and the maximum units per
 * trip. Storage is the smaller of the profile's storage and the goals'
 * storage. Baskets are ranked by contribution, then earnings per hour.
 *
 * Returns the top five baskets and the best single-item trip (plus the
 * thresholds applied and any looser override ignored), each with
 * economics, the downside if nothing sells and if half sells, cash timing,
 * and the reasons it falls short. At most one basket is marked recommended:
 * the best-ranked one with positive contribution, the hourly target met,
 * every item inside the buying thresholds and, when a cash date is set, the
 * payout on time. A basket with contribution of zero or below is never
 * recommended.
 */
export function basketOptions(offers, profile, goals, { now = new Date().toISOString() } = {}) {
  const rules = effectiveRules(profile.rules || {});
  const storage = Math.min(profile.storage, goals.storageUnits);
  const unitCap = Math.min(profile.quantity, storage);
  const carryGrams = Math.floor(profile.carry * 1000 + 1e-6);
  const excluded = [];
  const pool = [];
  for (const offer of offers) {
    const brief = { sku: offer.sku, name: offer.name, shop: offer.shop };
    if (!sameArea(profile.area, offer.area)) {
      excluded.push({ ...brief, reason: "Outside your area" });
      continue;
    }
    const grams = Math.round(offer.weight * 1000);
    const max = Math.min(offer.stock, grams > 0 ? Math.floor(carryGrams / grams) : 0, unitCap);
    if (!(max >= 1)) {
      excluded.push({ ...brief, reason: "No units fit your carrying, storage or unit limits" });
      continue;
    }
    const salePrice = lowerMedian([...offer.sales]) ?? 0;
    const base = {
      unitCost: offer.buy,
      salePrice,
      postage: offer.post,
      packaging: offer.pack,
      feeRate: profile.feeRate,
      feeFixed: profile.feeFixed,
      returnsRate: profile.returnsRate,
      journeyMinutes: 0,
      overheadMinutes: 0,
      handlingMinutes: offer.handlingMinutes,
    };
    // Contribution and cash are linear in units once the journey is fixed,
    // so one unit with no journey gives the per-unit figures.
    const one = tripEconomics({ ...base, units: 1, journeyCost: 0 });
    pool.push({ offer, base, grams, max, net: one.contribution, cash: one.cashRequired });
  }
  pool.sort((a, b) => b.net - a.net);
  for (const p of pool.splice(BASKET_SEARCH.maxOffers))
    excluded.push({
      sku: p.offer.sku,
      name: p.offer.name,
      shop: p.offer.shop,
      reason: `Only the ${BASKET_SEARCH.maxOffers} strongest offers are searched`,
    });

  const payout = payoutDate({
    start: now.slice(0, 10),
    daysToSell: goals.daysToSell,
    dispatchDays: goals.dispatchDays,
    deliveryDays: goals.deliveryDays,
    payoutDelayDays: goals.payoutDelayDays,
  });
  const timing = cashTiming({ payoutDate: payout.date, cashNeededBy: goals.cashNeededBy });

  // Journeys depend only on which offers are in the basket.
  const journeys = new Map();
  const journeyOf = (mask) => {
    if (!journeys.has(mask))
      journeys.set(mask, basketJourney(profile, pool.filter((_, i) => mask & (1 << i)).map((p) => p.offer)));
    return journeys.get(mask);
  };

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
    const items = alloc.filter((u) => u > 0).length;
    if (items === 1 && (!bestSingle || better(candidate, bestSingle) < 0)) bestSingle = candidate;
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

  const describe = (candidate) =>
    describeBasket(candidate, { pool, profile, goals, rules, now, route: journeyOf(candidate.mask), payout, timing });
  const baskets = top.map(describe);
  const single = bestSingle ? describe(bestSingle) : null;
  const pick = [...baskets, single].find((b) => b && b.reasons.length === 0 && b.economics.contribution > 0);
  for (const b of [...baskets, single]) if (b && pick && b.id === pick.id) b.recommended = true;

  return {
    sample: true,
    constraints: {
      budget: profile.budget,
      carry: profile.carry,
      storage,
      profileStorage: profile.storage,
      goalsStorage: goals.storageUnits,
      quantity: profile.quantity,
      unitCap,
      hourlyTarget: profile.target,
      transport: profile.transport,
      area: profile.area,
    },
    approximation: BASKET_APPROXIMATION,
    baskets,
    bestSingle: single,
    recommended: pick ? pick.id : null,
    excluded,
    searched,
    truncated,
    timing: { payout, cash: timing },
    rules: describeRules(profile.rules || {}),
  };
}

/** Full figures for one allocation, built only for the baskets returned. */
function describeBasket(candidate, { pool, profile, goals, rules, now, route, payout, timing }) {
  const chosen = pool
    .map((p, i) => ({ p, units: candidate.alloc[i] }))
    .filter((x) => x.units > 0);
  const shares = shareTravel(route.cost, chosen.map((x) => x.units));
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
    });
    return {
      sku: p.offer.sku,
      name: p.offer.name,
      variant: p.offer.variant,
      shop: p.offer.shop,
      units,
      weightKg: Math.round(units * p.offer.weight * 100) / 100,
      travelShare: shares[k],
      cashRequired: economics.cashRequired,
      contribution: economics.contribution,
      unitProfit: thresholds.unitProfit,
      returnOnCost: thresholds.returnOnCost,
      halfSellsContribution: perItem[k].half.contribution,
      thresholds,
      opportunity,
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
  for (const it of items)
    for (const failure of it.thresholds.failures) reasons.push(`${it.name}: ${failure}`);
  if (goals.cashNeededBy && timing.status !== "on time") reasons.push(timing.note);

  return {
    id: items.map((it) => `${it.sku}:${it.units}`).join(","),
    items,
    shops: [...new Set(items.map((it) => it.shop))],
    journey: route,
    units,
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
    timing: { payout, cash: timing },
    reasons,
    recommended: false,
  };
}
