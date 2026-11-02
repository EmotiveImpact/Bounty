// Opportunity rules: buying thresholds, the five opportunity tiers and paid
// membership release order. Values are configuration, not facts; Edem has an
// open decision on the thresholds and the membership names, so everything
// here is data that can change without touching the logic.

// Buying thresholds (PRD "Opportunity rules"). Money in pence.
export const OPPORTUNITY_RULES = Object.freeze({
  minUnitPrice: 500, // £5 purchase price per unit
  maxUnitPrice: 5000, // £50
  maxWeightKg: 2, // a unit must weigh under 2 kg
  minUnitProfit: 500, // £5 estimated profit per unit after variable costs
  minReturn: 0.35, // profit per unit divided by purchase price per unit
  trialUnits: 3, // a first purchase of an item is a small trial batch
  // Units are rationed by demand: no more than the sales rate supports in
  // this many weeks once competing listings are served (an assumption still
  // to be confirmed by Edem).
  sellWindowWeeks: 2,
  // Priority 1 needs strong sold evidence, easy fulfilment and low pressure.
  strongIndependentSales: 6,
  maxDaysToSellPriority1: 14,
  maxResaleWeeksOfSupplyPriority1: 2,
  maxSourcingPressurePriority1: 0.5,
});

/**
 * Thresholds for one member. Members may tighten the agreed thresholds for
 * themselves but never loosen them, so each override only applies when it is
 * stricter than the default. Invalid overrides are ignored.
 */
export function effectiveRules(overrides = {}, base = OPPORTUNITY_RULES) {
  const valid = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const higher = (key) =>
    valid(overrides[key]) ? Math.max(base[key], overrides[key]) : base[key];
  const lower = (key) =>
    valid(overrides[key]) ? Math.min(base[key], overrides[key]) : base[key];
  return Object.freeze({
    ...base,
    minUnitPrice: higher("minUnitPrice"),
    maxUnitPrice: lower("maxUnitPrice"),
    maxWeightKg: lower("maxWeightKg"),
    minUnitProfit: higher("minUnitProfit"),
    minReturn: higher("minReturn"),
    trialUnits: lower("trialUnits"),
  });
}

export const TIERS = Object.freeze([
  "Priority 1",
  "Priority 2",
  "Watch",
  "Review",
  "Reject",
]);

// Checks from evaluateAlert that concern evidence quality. When any fails the
// opportunity goes to Review rather than being judged on its numbers.
const EVIDENCE_CHECKS = new Set([
  "live-evidence",
  "journey",
  "inputs-entered",
  "exact-match",
  "offer-fresh",
  "independent-sales",
  "days-to-sell",
  "shipping",
  // The price is not shown to apply at the branch the stock check covers.
  "price-at-branch",
]);
// Checks about branch stock. Unknown stock caps a tier at Priority 2.
const STOCK_CHECKS = new Set(["local-stock", "availability"]);

/**
 * Profit per unit and return on purchase price. Profit per unit is the trip
 * contribution divided by units, so it already carries fees, postage,
 * packaging, the returns allowance and the unit's share of travel.
 *
 * returnOnCost is rounded down to three decimals, never up, so a return of
 * 34.96% reads as 34.9% and fails a 35% minimum. Compare it with
 * meetsReturn(), which works in whole pence.
 */
export function unitReturns(economics) {
  if (!economics || !economics.units) return { unitProfit: null, returnOnCost: null };
  const unitProfit = Math.floor(economics.contribution / economics.units);
  const returnOnCost = economics.unitCost
    ? Math.floor((unitProfit / economics.unitCost) * 1000 + 1e-9) / 1000
    : null;
  return { unitProfit, returnOnCost };
}

/**
 * True when profit per unit is at least minReturn of the purchase price,
 * compared without rounding: 699p on a £20 unit is 34.95% and fails 35%.
 */
export function meetsReturn(unitProfit, unitCost, minReturn = OPPORTUNITY_RULES.minReturn) {
  if (!Number.isFinite(unitProfit) || !Number.isFinite(unitCost) || unitCost <= 0) return false;
  // Basis points keep the comparison in integers for thresholds such as 0.35.
  return unitProfit * 10000 >= Math.round(minReturn * 10000) * unitCost;
}

/**
 * Units the evidence supports selling within the sell window once competing
 * listings are served: floor(salesPerWeek × weeks) − competingListings, at
 * least 0. Null when the sales rate or competition is unknown, which the
 * buy-alert gate treats as a failure.
 */
export function demandUnits({ salesPerWeek, competingListings }, weeks = OPPORTUNITY_RULES.sellWindowWeeks) {
  if (!(typeof salesPerWeek === "number" && Number.isFinite(salesPerWeek) && salesPerWeek >= 0)) return null;
  if (!(Number.isSafeInteger(competingListings) && competingListings >= 0)) return null;
  return Math.max(0, Math.floor(salesPerWeek * weeks + 1e-9) - competingListings);
}

/**
 * Days until the last of `units` is expected to sell: the median days to
 * sell for one unit, or longer when the sales rate cannot absorb them all
 * sooner. Null when either figure is unknown.
 */
export function daysToSellAll({ units, daysToSell, salesPerWeek }) {
  if (!Number.isFinite(daysToSell) || daysToSell < 0) return null;
  if (!Number.isInteger(units) || units <= 1) return Math.ceil(daysToSell);
  if (!(Number.isFinite(salesPerWeek) && salesPerWeek > 0)) return null;
  return Math.max(Math.ceil(daysToSell), Math.ceil((units * 7) / salesPerWeek));
}

// Category rules apply on top of the buying thresholds (PRD "Opportunity
// rules"). Clothing needs size-specific demand and a higher returns
// allowance; food needs weight, packaging and shelf-life checks. The
// numbers are configuration and still to be confirmed by Edem.
export const CATEGORY_RULES = Object.freeze({
  general: Object.freeze({ id: "general", name: "General" }),
  clothing: Object.freeze({
    id: "clothing",
    name: "Clothing",
    minReturnsRate: 0.15, // returns allowance floor, as a share of the sale price
    needsSize: true,
  }),
  food: Object.freeze({
    id: "food",
    name: "Food",
    needsPackaging: true, // sealed, undamaged and allowed to be posted
    minShelfLifeDays: 30, // left on the best-before date after the expected sale
  }),
});
export const CATEGORY_IDS = Object.freeze(Object.keys(CATEGORY_RULES));

/** The category rule for an id; unknown or missing ids are general. */
export function categoryRule(id) {
  return CATEGORY_RULES[id] || CATEGORY_RULES.general;
}

/** The returns allowance to use: the category floor or the member's figure. */
export function categoryReturnsRate(category, returnsRate) {
  const floor = categoryRule(category).minReturnsRate || 0;
  const rate = Number.isFinite(returnsRate) ? returnsRate : 0;
  return Math.max(rate, floor);
}

/**
 * Category checks that fail closed. Returns the failures as reasons.
 *  category          "general" | "clothing" | "food"
 *  size              size attribute of the offer (clothing)
 *  returnsRate       returns allowance used in the economics
 *  packagingChecked  true once the packaging was checked (food)
 *  bestBefore        ISO date on the pack (food)
 *  daysToSell        expected days to sell, null when unknown
 *  now               ISO time of the decision
 */
export function categoryChecks(input = {}) {
  const rule = categoryRule(input.category);
  const failures = [];
  if (rule.needsSize && !(typeof input.size === "string" && input.size.trim()))
    failures.push("Clothing needs a size, because demand and sales are size-specific");
  if (rule.minReturnsRate && !(Number.isFinite(input.returnsRate) && input.returnsRate >= rule.minReturnsRate))
    failures.push(
      `Clothing needs a returns allowance of at least ${Math.round(rule.minReturnsRate * 100)}%`,
    );
  if (rule.needsPackaging && input.packagingChecked !== true)
    failures.push("Food packaging not checked as sealed, undamaged and fit to post");
  if (rule.minShelfLifeDays) {
    const left = Date.parse(input.bestBefore) - Date.parse(input.now);
    const days = Number.isFinite(left) ? Math.floor(left / 86400000) : null;
    if (days === null) failures.push("Best-before date not recorded");
    else if (!Number.isFinite(input.daysToSell))
      failures.push("Shelf life cannot be checked without a known time to sell");
    else if (days - input.daysToSell < rule.minShelfLifeDays)
      failures.push(
        `Less than ${rule.minShelfLifeDays} days left on the best-before date after the expected sale`,
      );
  }
  return failures;
}

/**
 * Highest purchase price per unit at which the item would meet both the
 * profit and return thresholds, all other costs unchanged. Buying a penny
 * cheaper raises profit by a penny because fees, postage and packaging do
 * not depend on the purchase price. Null when no price works.
 */
export function targetPrice(economics, rules = OPPORTUNITY_RULES) {
  const { unitProfit } = unitReturns(economics);
  if (unitProfit === null) return null;
  const headroom = unitProfit + economics.unitCost; // profit at a zero price
  const byProfit = headroom - rules.minUnitProfit;
  const bp = Math.round(rules.minReturn * 10000); // basis points, integer maths
  const byReturn = Math.floor((headroom * 10000) / (10000 + bp));
  const target = Math.min(byProfit, byReturn);
  return target >= rules.minUnitPrice ? target : null;
}

/**
 * Hard filters that do not depend on evidence: the purchase price band and
 * the weight limit. Unknown weight fails closed.
 */
export function hardFilters({ unitPrice, weightKg }, rules = OPPORTUNITY_RULES) {
  const reasons = [];
  if (!Number.isSafeInteger(unitPrice)) reasons.push("Purchase price unknown");
  else if (unitPrice < rules.minUnitPrice || unitPrice > rules.maxUnitPrice)
    reasons.push(
      `Purchase price outside £${rules.minUnitPrice / 100} to £${rules.maxUnitPrice / 100} per unit`,
    );
  if (!(typeof weightKg === "number" && Number.isFinite(weightKg) && weightKg > 0))
    reasons.push("Unit weight unknown");
  else if (weightKg >= rules.maxWeightKg)
    reasons.push(`Unit weighs ${rules.maxWeightKg} kg or more`);
  return reasons;
}

/**
 * Classifies an opportunity into one of the five tiers.
 *
 * input:
 *  unitPrice    purchase price per unit (pence)
 *  weightKg     weight of one unit
 *  economics    tripEconomics result, or null when no sale price is known
 *  alert        evaluateAlert result for the same trip
 *  independentSales, daysToSell   from the sold sample
 *  sourcingPressure  claimed or reported demand on the shelf relative to
 *               available units (0 to 1+), null when unknown
 *  resaleWeeksOfSupply  competing listings divided by sales per week, null
 *               when unknown
 *  availability latest branch availability ("in_stock", "out_of_stock",
 *               "unknown"); a check that found none is never Priority 2
 *  promotionUnconfirmed  true when the unit price is a promotion or loyalty
 *               price the member has not confirmed they qualify for and no
 *               regular price is known, so the real cost is unknown
 *  categoryFailures  categoryChecks(...) for the item; missing means the
 *               category rules were not run, which fails closed
 *
 * Returns { tier, reasons, unitProfit, returnOnCost, targetPrice,
 * meetsThresholds, trialUnits }. meetsThresholds is true only for Priority 1
 * and Priority 2, and the buy-alert gate requires it.
 */
export function classifyOpportunity(input, rules = OPPORTUNITY_RULES) {
  const { unitProfit, returnOnCost } = unitReturns(input.economics);
  const result = (tier, reasons, extra = {}) => ({
    tier,
    reasons,
    unitProfit,
    returnOnCost,
    targetPrice: null,
    meetsThresholds: tier === "Priority 1" || tier === "Priority 2",
    trialUnits: rules.trialUnits,
    ...extra,
  });

  const hard = hardFilters(input, rules);
  if (hard.length) return result("Reject", hard);

  const checks = input.alert?.checks || [];
  const failed = (ids) =>
    checks.filter((c) => ids.has(c.id) && !c.ok).map((c) => c.detail);
  const evidenceGaps = input.economics
    ? failed(EVIDENCE_CHECKS)
    : ["No completed-sale price for this exact variant"];
  if (!checks.length) evidenceGaps.push("Evidence checks were not run");
  if (input.promotionUnconfirmed === true)
    evidenceGaps.push("Price depends on a promotion you have not confirmed, and the regular price is unknown");
  if (Array.isArray(input.categoryFailures)) evidenceGaps.push(...input.categoryFailures);
  else evidenceGaps.push("Category rules were not checked");
  if (input.availability === "out_of_stock")
    evidenceGaps.push("Latest check found none on the shelf");
  if (evidenceGaps.length) return result("Review", evidenceGaps);

  const short = [];
  if (unitProfit < rules.minUnitProfit)
    short.push(`Profit per unit below £${rules.minUnitProfit / 100}`);
  if (!meetsReturn(unitProfit, input.economics.unitCost, rules.minReturn))
    short.push(`Return below ${Math.round(rules.minReturn * 1000) / 10}% of purchase price`);
  if (short.length) {
    const target = targetPrice(input.economics, rules);
    if (target === null)
      return result("Reject", [...short, "No purchase price in the band would meet the thresholds"]);
    return result("Watch", [...short, "Would qualify at a purchase price of £" + (target / 100).toFixed(2) + " or less"], {
      targetPrice: target,
    });
  }

  const priority2 = [];
  const stockGaps = failed(STOCK_CHECKS);
  if (stockGaps.length) priority2.push("Branch stock not confirmed");
  // Unknown values never count as strong (null would compare as 0).
  const atMost = (v, max) => typeof v === "number" && Number.isFinite(v) && v <= max;
  const atLeast = (v, min) => typeof v === "number" && Number.isFinite(v) && v >= min;
  if (!atLeast(input.independentSales, rules.strongIndependentSales))
    priority2.push("Fewer than " + rules.strongIndependentSales + " independent recent sales");
  if (!atMost(input.daysToSell, rules.maxDaysToSellPriority1))
    priority2.push("Expected to take more than " + rules.maxDaysToSellPriority1 + " days to sell, or unknown");
  if (!atMost(input.resaleWeeksOfSupply, rules.maxResaleWeeksOfSupplyPriority1))
    priority2.push("Resale competition high or unknown");
  if (!atMost(input.sourcingPressure, rules.maxSourcingPressurePriority1))
    priority2.push("Sourcing pressure high or unknown");
  if (priority2.length) return result("Priority 2", priority2);
  return result("Priority 1", ["Strong sold evidence, confirmed stock and low pressure"]);
}

// Early access tiers, in release order. Edem chose paid and earned early
// access from launch: a member can pay for a tier or earn it through
// reputation, and the app always shows the two separately. Names, the number
// of tiers, window lengths and point thresholds are still open, so they are
// data here. offsetMinutes is how long after a bounty opens a tier is
// alerted. earnPoints is the earned reputation that unlocks the tier (null:
// cannot be earned). The bounty exposure limit stops alerts once the
// stock-sized cap is used, so with little stock later tiers receive nothing.
export const MEMBERSHIP_TIERS = Object.freeze([
  { id: "diamond", name: "Diamond", offsetMinutes: 0, earnPoints: 500 },
  { id: "ruby", name: "Ruby", offsetMinutes: 90, earnPoints: 250 },
  { id: "sapphire", name: "Sapphire", offsetMinutes: 180, earnPoints: 120 },
  { id: "emerald", name: "Emerald", offsetMinutes: 270, earnPoints: 60 },
  { id: "amethyst", name: "Amethyst", offsetMinutes: 360, earnPoints: 25 },
  { id: "new", name: "New member", offsetMinutes: 450, earnPoints: 0 },
]);
export const PAID_TIER_IDS = Object.freeze(
  MEMBERSHIP_TIERS.filter((t) => t.id !== "new").map((t) => t.id),
);

/** The tier definition for an id, or null. */
export function membershipTier(id) {
  return MEMBERSHIP_TIERS.find((t) => t.id === id) || null;
}

/** The highest tier unlocked by earned reputation points. */
export function earnedTier(points) {
  const score = Number.isFinite(points) ? points : 0;
  return MEMBERSHIP_TIERS.find(
    (t) => t.earnPoints !== null && score >= t.earnPoints,
  );
}

/**
 * Release position for a member: the earlier of their paid tier (only while
 * paid membership is current) and their earned tier. Both are returned so
 * the interface can show paid status and earned status separately.
 */
export function accessTier({ paidTier, paidUntil, reputation, now }) {
  const current =
    paidTier && (!paidUntil || Date.parse(paidUntil) > Date.parse(now))
      ? membershipTier(paidTier)
      : null;
  const earned = earnedTier(reputation);
  const rank = (t) => MEMBERSHIP_TIERS.indexOf(t);
  const best = current && rank(current) < rank(earned) ? current : earned;
  return {
    tier: best,
    via: current && best === current ? "paid" : "earned",
    paid: current,
    earned,
  };
}
