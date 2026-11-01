// The Deals list: every offer as a find, with no buying profile needed.
// Money is integer pence.
//
// A deal is judged on what one unit makes: the completed-sale estimate (the
// lower median of completed sales, never asking prices) less the shop price,
// marketplace fees, the returns allowance, postage and packaging. Travel is
// an added layer: it is shown beside the deal when the member has said how
// they travel, and it never hides, blocks or reorders a deal. Nothing here
// is a buy alert: the Planner and the alert gate still decide that.
import { MODES, SAMPLE_ASSUMPTIONS, lowerMedian, tripEconomics } from "./trip.mjs";
import { OPPORTUNITY_RULES, categoryReturnsRate, hardFilters } from "./opportunity.mjs";
import { blankInputs, fareMissing, journeyFor, offers as sampleOffers, unitThresholdFailures } from "./catalog.mjs";
import { fail } from "./http.mjs";

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * Optional extras a member may send for sharper numbers. Every field is
 * optional; an empty or missing body means "no setup", which uses the
 * cautious sample selling assumptions and no travel.
 *
 * transport  one of MODES; when absent the deal carries no travel cost
 * fare       return public transport fare in pence, or null when not entered
 * fareFree   true when the member's public transport is free
 * perMile    car or van cost per mile in pence
 * extra      parking or tolls in pence
 * feeRate, feeFixed, returnsRate  the member's own selling assumptions
 */
export function readDealOptions(input) {
  if (input === undefined || input === null) return {};
  if (!isObject(input)) fail("Send the options as a JSON object");
  const out = {};
  const num = (key, label, min, max, whole = false) => {
    if (input[key] === undefined || input[key] === null) return;
    const v = input[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (whole && !Number.isSafeInteger(v)))
      fail(`${label} must be a number from ${min} to ${max}`);
    out[key] = v;
  };
  if (input.transport !== undefined && input.transport !== null) {
    if (!MODES.includes(input.transport)) fail("Transport must be one of " + MODES.join(", "));
    out.transport = input.transport;
  }
  num("fare", "Public transport fare (in pence)", 0, 100_000, true);
  if (input.fareFree !== undefined && typeof input.fareFree !== "boolean") fail("fareFree must be true or false");
  out.fareFree = input.fareFree === true;
  num("perMile", "Car or van cost per mile (in pence)", 0, 1000, true);
  num("extra", "Parking or tolls (in pence)", 0, 100_000, true);
  num("feeRate", "Marketplace fee (as a share)", 0, 0.5);
  num("feeFixed", "Fixed fee per item sold (in pence)", 0, 10_000, true);
  num("returnsRate", "Returns allowance (as a share)", 0, 0.5);
  return out;
}

/**
 * Travel for one return trip to the shop, or a plain "not added" when the
 * member has not said how they travel. A public transport trip with no fare
 * has an unknown cost (never free); a ticked free fare costs nothing.
 */
export function dealTravel(offer, options) {
  const miles = Number.isFinite(offer.miles) ? offer.miles : null;
  if (!options.transport || miles === null) return { added: false, mode: null, miles, cost: null, minutes: null };
  const fare = options.fareFree ? 0 : Number.isSafeInteger(options.fare) ? options.fare : null;
  const profile = {
    transport: options.transport,
    fare,
    perMile: options.perMile ?? 45,
    extra: options.extra ?? 0,
  };
  const j = journeyFor(profile, miles);
  return {
    added: true,
    mode: options.transport,
    miles,
    cost: fareMissing(profile) ? null : j.cost,
    minutes: j.minutes,
  };
}

/** One offer as a deal. */
export function dealFor(offer, options = {}, rules = OPPORTUNITY_RULES) {
  const completed = Array.isArray(offer.sales) ? offer.sales.filter((s) => Number.isSafeInteger(s) && s > 0) : [];
  const salePrice = lowerMedian(completed);
  const feeRate = options.feeRate ?? SAMPLE_ASSUMPTIONS.feeRate;
  const feeFixed = options.feeFixed ?? SAMPLE_ASSUMPTIONS.feeFixed;
  const returnsRate = categoryReturnsRate(offer.category, options.returnsRate ?? SAMPLE_ASSUMPTIONS.returnsRate);
  const blanks = blankInputs(offer);
  const known = salePrice !== null && blanks.length === 0;
  // One unit, no journey: travel is a separate layer below.
  const e = known
    ? tripEconomics({
        units: 1,
        unitCost: offer.buy,
        salePrice,
        postage: offer.post,
        packaging: offer.pack,
        feeRate,
        feeFixed,
        returnsRate,
        journeyCost: 0,
      })
    : null;
  const unitProfit = e ? e.contribution : null;
  const notes = [];
  if (salePrice === null) notes.push("No completed sales yet, so the sale price is not known");
  if (blanks.length) notes.push("Not known until these are entered: " + blanks.join(", "));
  notes.push(...hardFilters({ unitPrice: offer.buy, weightKg: offer.weight }, rules));
  if (unitProfit !== null) notes.push(...unitThresholdFailures(unitProfit, offer.buy, rules));
  return {
    sku: offer.sku,
    name: offer.name,
    variant: offer.variant ?? null,
    category: offer.category || "general",
    shop: offer.shop,
    area: offer.area ?? null,
    miles: Number.isFinite(offer.miles) ? offer.miles : null,
    buy: offer.buy,
    salePrice,
    sales: [...completed].sort((a, b) => a - b),
    costs: e
      ? {
          fees: e.costs.fees,
          returns: e.costs.returns,
          postage: e.costs.postage,
          packaging: e.costs.packaging,
        }
      : null,
    feeRate,
    feeFixed,
    returnsRate,
    unitProfit,
    returnOnCost: unitProfit !== null && offer.buy > 0 ? Math.floor((unitProfit / offer.buy) * 1000) / 1000 : null,
    underSale: salePrice !== null && salePrice > offer.buy ? Math.floor((1 - offer.buy / salePrice) * 100) : null,
    weight: offer.weight ?? null,
    stock: Number.isSafeInteger(offer.stock) ? offer.stock : null,
    competingListings: Number.isSafeInteger(offer.competingListings) ? offer.competingListings : null,
    storageNeeds: offer.storageNeeds ?? null,
    meetsThresholds: unitProfit !== null && notes.length === 0,
    notes,
    travel: dealTravel(offer, options),
    sample: offer.sample === true,
  };
}

/**
 * Every offer as a deal, biggest profit a unit first; a deal whose profit is
 * not known sorts last. Travel never changes the order.
 */
export function listDeals(options = {}, { offers = sampleOffers } = {}) {
  const deals = offers.map((o) => dealFor(o, options));
  deals.sort((a, b) => (b.unitProfit ?? -Infinity) - (a.unitProfit ?? -Infinity) || a.name.localeCompare(b.name));
  return {
    deals,
    assumptions: {
      feeRate: options.feeRate ?? SAMPLE_ASSUMPTIONS.feeRate,
      feeFixed: options.feeFixed ?? SAMPLE_ASSUMPTIONS.feeFixed,
      returnsRate: options.returnsRate ?? SAMPLE_ASSUMPTIONS.returnsRate,
      ownFees: options.feeRate !== undefined || options.feeFixed !== undefined || options.returnsRate !== undefined,
    },
    rules: {
      minUnitProfit: OPPORTUNITY_RULES.minUnitProfit,
      minReturn: OPPORTUNITY_RULES.minReturn,
    },
  };
}
