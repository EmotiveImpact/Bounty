// Planner fixtures and single-item trip planning. Money is integer pence and
// time is minutes throughout; the client converts pounds at the edge.
//
// The four Leeds offers are synthetic sample data. Their sale totals, sales
// rates and competing listings are modelled for illustration, not observed,
// so a planner result is always labelled as sample and can never become a buy
// alert.
import {
  MODES,
  SAMPLE_ASSUMPTIONS,
  TRANSPORT,
  journey,
  lowerMedian,
  tripEconomics,
} from "./trip.mjs";
import { evaluateAlert } from "./alerts.mjs";
import {
  OPPORTUNITY_RULES,
  categoryChecks,
  categoryReturnsRate,
  classifyOpportunity,
  effectiveRules,
  hardFilters,
  meetsReturn,
  unitReturns,
} from "./opportunity.mjs";
import { fail, int, num, oneOf, text } from "./http.mjs";

// Fixture fields:
//  miles            one way from the centre of `area` to the shop
//  buy              shelf price per unit
//  sales            modelled sale totals per unit including buyer postage
//                   (illustrative, not completed-sale evidence)
//  post, pack       parcel cost and packaging per unit
//  weight           kg per unit
//  stock            units assumed on the shelf
//  handlingMinutes  listing, packing and dispatch time per unit
//  category, size   category rules (opportunity.mjs CATEGORY_RULES) and the
//                   size the demand applies to
//  salesPerWeek     modelled completed sales of this variant per week
//  competingListings  modelled active listings of the same variant
//  priceChecked, stockChecked  when the price and the branch stock were last
//                   checked; null for every fixture (never checked)
//  storageNeeds     null, or what storing the item at home needs beyond a
//                   shelf or cupboard
const fixture = (o) =>
  Object.freeze({
    priceChecked: null,
    stockChecked: null,
    storageNeeds: null,
    ...o,
    sales: Object.freeze(o.sales),
    sample: true,
  });
export const offers = Object.freeze([
  fixture({
    sku: "knit",
    name: "Cotton crew-neck jumper",
    variant: "Navy · Medium · New",
    category: "clothing",
    size: "Medium",
    shop: "Morrisons",
    area: "Leeds",
    miles: 1.2,
    buy: 600,
    sales: [1550, 1600, 1650, 1690, 1700],
    post: 270,
    pack: 35,
    weight: 0.32,
    stock: 6,
    handlingMinutes: 9,
    salesPerWeek: 2.5,
    competingListings: 3,
  }),
  fixture({
    sku: "baby",
    name: "Baby sleepsuits",
    variant: "Three-pack · 0 to 3 months · New",
    category: "clothing",
    size: "0 to 3 months",
    shop: "Asda",
    area: "Leeds",
    miles: 1.6,
    buy: 450,
    sales: [1250, 1300, 1350, 1400],
    post: 245,
    pack: 25,
    weight: 0.24,
    stock: 8,
    handlingMinutes: 7,
    salesPerWeek: 3,
    competingListings: 4,
  }),
  fixture({
    sku: "pot",
    name: "Terracotta planter",
    variant: "32 cm · Single · New",
    category: "general",
    size: null,
    shop: "B&Q",
    area: "Leeds",
    miles: 2.5,
    buy: 1200,
    sales: [3400, 3500, 3800],
    post: 790,
    pack: 180,
    weight: 10,
    stock: 3,
    handlingMinutes: 16,
    salesPerWeek: 1,
    competingListings: 0,
    storageNeeds: "Bulky: needs floor space rather than a shelf",
  }),
  // Included so the sample shows a trip that clears the buying thresholds,
  // including the 15% returns allowance clothing needs. Like the others it is
  // illustrative and can never become a buy alert.
  fixture({
    sku: "jacket",
    name: "Children's waterproof jacket",
    variant: "Navy · Age 5 to 6 · New",
    category: "clothing",
    size: "Age 5 to 6",
    shop: "Sainsbury's",
    area: "Leeds",
    miles: 1.4,
    buy: 1000,
    sales: [2800, 2900, 3000, 3100],
    post: 300,
    pack: 35,
    weight: 0.45,
    stock: 4,
    handlingMinutes: 10,
    salesPerWeek: 3,
    competingListings: 1,
  }),
]);

// Server-side profile. Money in pence: budget, target (per hour), fare
// (return public transport fare; null when not entered), perMile (car or van
// running cost), extra (parking or tolls per trip, car or van only) and
// feeFixed. carry is kg, quantity the most units for one trip, storage the
// units that fit at home. rules holds the member's stricter buying
// thresholds.
export const defaults = Object.freeze({
  area: "Leeds",
  budget: 10000,
  target: 1200,
  transport: "Walk",
  carry: 5,
  quantity: 4,
  fare: 0,
  perMile: 45,
  extra: 0,
  storage: 10,
  feeRate: SAMPLE_ASSUMPTIONS.feeRate,
  feeFixed: SAMPLE_ASSUMPTIONS.feeFixed,
  returnsRate: SAMPLE_ASSUMPTIONS.returnsRate,
  rules: Object.freeze({}),
});

export const REASONS = Object.freeze({
  AREA: "Outside your area",
  LIMIT: "No units fit your limits",
  LOSS: "Loses money",
  HOURLY: "Below hourly target",
  THRESHOLDS: "Outside your buying thresholds",
  CASH_DATE: "Not paid out by the date you need the cash",
  FARE: "Enter your public transport fare",
  FITS: "Fits your profile",
});

// Load limits by transport. These are assumptions, not measurements: a car
// boot takes a comfortable 25 kg without lifting strain, and by public
// transport a shopper carries about two full shopping bags, 10 kg. The same
// rule applies to the member's own transport and to the comparison, so "What
// changes if I drive?" always matches what the Car plan then shows.
export const CAR_BOOT_KG = 25;
export const HAND_CARRY_KG = 10;

// Quantity assumptions. A first purchase is capped at the trial batch
// (OPPORTUNITY_RULES.trialUnits) and at the units the sales rate supports in
// the sell window after competing listings, as bounties.distributionCap
// works it out. The sell window is an assumption still to be confirmed.
export const QUANTITY_RULES = Object.freeze({ sellWindowWeeks: 2 });

// Access needs (PRD journey 3). The labels are the PRD's; the thresholds are
// assumptions and an open decision, so they are data here.
export const ACCESS_NEEDS = Object.freeze([
  Object.freeze({ id: "widely-accessible", label: "Widely accessible" }),
  Object.freeze({ id: "vehicle-required", label: "Vehicle required" }),
  Object.freeze({ id: "heavy-handling", label: "Heavy handling" }),
  Object.freeze({ id: "limited-stock", label: "Limited local stock" }),
  Object.freeze({ id: "specialist-storage", label: "Specialist storage" }),
]);
export const ACCESS_RULES = Object.freeze({
  heavyUnitKg: 5, // one unit at or above this is heavy handling for anyone
  limitedStockUnits: 4, // this many or fewer on the shelf is limited stock
});

const VEHICLES = new Set(["Car", "Van"]);
const LIMIT_ORDER = ["trial", "quantity", "demand", "stock", "carry", "storage", "cash"];

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
export const sameArea = (a, b) =>
  String(a ?? "").trim().replace(/\s+/g, " ").toLowerCase() ===
  String(b ?? "").trim().replace(/\s+/g, " ").toLowerCase();
export const gbp = (pence) =>
  (pence < 0 ? "-£" : "£") + (Math.abs(pence) / 100).toFixed(2);
const pct = (share) => Math.round(share * 1000) / 10 + "%";
const kg = (value) => Math.round(value * 100) / 100;

/**
 * The load one trip can take by this transport: the larger of the member's
 * carry limit and a car boot by car or van, the smaller of it and two
 * shopping bags by public transport, and the member's own limit on foot or
 * by bicycle.
 */
export function loadLimit(transport, carry) {
  if (VEHICLES.has(transport)) return Math.max(carry, CAR_BOOT_KG);
  if (transport === "Public transport") return Math.min(carry, HAND_CARRY_KG);
  return carry;
}

/** True when the member travels by public transport and has not entered a fare. */
export const fareMissing = (profile) =>
  profile.transport === "Public transport" && !Number.isSafeInteger(profile.fare);

/**
 * One return journey from the area centre for this profile. The fare only
 * applies to public transport (journey() ignores it otherwise); a fare that
 * was not entered costs nothing here, and fareMissing() says so. The
 * profile's cost per mile, parking and tolls only apply to a car or van:
 * walking, cycling and public transport use the mode's own running cost of
 * zero.
 */
export function journeyFor(profile, miles) {
  const vehicle = VEHICLES.has(profile.transport);
  return journey({
    mode: profile.transport,
    miles,
    fare: profile.transport === "Public transport" ? profile.fare ?? 0 : 0,
    perMile: vehicle ? profile.perMile : undefined,
    extra: vehicle ? profile.extra : 0,
  });
}

/**
 * Units the sales rate supports in the sell window once competing listings
 * are served: floor(salesPerWeek × weeks) − competingListings, at least 0.
 * Unknown sales or competition fails closed at 0 units.
 */
export function demandUnits(offer, weeks = QUANTITY_RULES.sellWindowWeeks) {
  const rate = offer.salesPerWeek;
  const competing = offer.competingListings;
  if (!(typeof rate === "number" && Number.isFinite(rate) && rate >= 0)) return 0;
  if (!(Number.isSafeInteger(competing) && competing >= 0)) return 0;
  return Math.max(0, Math.floor(rate * weeks + 1e-9) - competing);
}

/**
 * The returns allowance an offer is costed with and its category checks:
 * clothing uses at least the category floor, and every failure is a reason
 * the item needs review.
 */
export function categoryTerms(offer, profile, now) {
  const returnsRate = categoryReturnsRate(offer.category, profile.returnsRate);
  const failures = categoryChecks({
    category: offer.category,
    size: offer.size,
    returnsRate,
    packagingChecked: offer.packagingChecked === true,
    bestBefore: offer.bestBefore ?? null,
    daysToSell: null, // fixtures carry no sold timing
    now,
  });
  return { category: offer.category || "general", returnsRate, failures };
}

/**
 * Access needs for one offer and this member, as PRD journey 3 labels them.
 * Each entry is { id, label, detail }. "Widely accessible" appears only when
 * no other need applies.
 */
export function accessNeeds(offer, profile) {
  const needs = [];
  const add = (id, detail) =>
    needs.push({ id, label: ACCESS_NEEDS.find((n) => n.id === id).label, detail });
  const weight = offer.weight;
  const known = typeof weight === "number" && Number.isFinite(weight) && weight > 0;
  if (!known) add("heavy-handling", "Unit weight unknown, so the load cannot be checked");
  else {
    if (weight > profile.carry)
      add(
        "vehicle-required",
        `One unit weighs ${weight} kg, more than your ${profile.carry} kg carry limit, so it needs a car or van`,
      );
    if (weight >= ACCESS_RULES.heavyUnitKg || weight > profile.carry)
      add("heavy-handling", `One unit weighs ${weight} kg`);
  }
  if (!(Number.isSafeInteger(offer.stock) && offer.stock > ACCESS_RULES.limitedStockUnits))
    add(
      "limited-stock",
      Number.isSafeInteger(offer.stock)
        ? `${offer.stock} on the shelf${offer.stockChecked ? "" : " (assumed, not checked)"}`
        : "Shelf stock unknown",
    );
  if (offer.storageNeeds) add("specialist-storage", offer.storageNeeds);
  if (!needs.length) add("widely-accessible", "Light, plentiful and stored on a shelf");
  return needs;
}

/** When the price and the stock were last checked, and the main uncertainty. */
export function checkedAndUncertainty(offer) {
  const checked = { price: offer.priceChecked ?? null, stock: offer.stockChecked ?? null };
  const mainUncertainty = offer.sample
    ? "Sample figures: the price, stock and sale prices are modelled, never observed"
    : !checked.price
      ? "The price has never been checked"
      : !checked.stock
        ? "Branch stock has never been checked"
        : "Sale prices are not completed-sale evidence";
  return { checked, mainUncertainty };
}

/**
 * Checks the agreed buying thresholds (or the member's stricter ones) that a
 * planner can measure: the price band and weight limit, profit per unit
 * after every variable cost and the unit's share of travel, and the return on
 * the purchase price (compared in whole pence by meetsReturn, so 34.95%
 * fails 35%). Evidence checks are left to the alert gate.
 */
export function buyingThresholds(offer, economics, rules = OPPORTUNITY_RULES) {
  const failures = hardFilters({ unitPrice: offer.buy, weightKg: offer.weight }, rules);
  const { unitProfit, returnOnCost } = unitReturns(economics);
  if (unitProfit === null) {
    failures.push("Profit per unit unknown until at least one unit fits");
  } else {
    if (unitProfit < rules.minUnitProfit)
      failures.push(
        `Profit per unit of ${gbp(unitProfit)} is below ${gbp(rules.minUnitProfit)}`,
      );
    if (returnOnCost === null) failures.push("Return on the purchase price unknown");
    else if (!meetsReturn(unitProfit, economics.unitCost, rules.minReturn))
      failures.push(
        `Return of ${pct(returnOnCost)} is below ${pct(rules.minReturn)} of the purchase price`,
      );
  }
  return { unitProfit, returnOnCost, ok: failures.length === 0, failures };
}

// Wording for checks that fail on sample data, so the lists match the
// figures shown next to them: the planner shows illustrative parcel costs
// and a payout date from the member's own assumptions.
const SAMPLE_DETAILS = Object.freeze({
  shipping: () => "Parcel cost is an illustrative sample figure, not a quote",
  "days-to-sell": (detail) =>
    detail === "Days to sell unknown"
      ? "No sold evidence for days to sell; the payout date uses your Goals assumption"
      : detail,
});
function sampleWording(alert) {
  const checks = alert.checks.map((c) =>
    !c.ok && Object.hasOwn(SAMPLE_DETAILS, c.id) ? { ...c, detail: SAMPLE_DETAILS[c.id](c.detail) } : c,
  );
  return { ...alert, checks, reasons: checks.filter((c) => !c.ok).map((c) => c.detail) };
}

/**
 * Alert, opportunity tier and threshold checks for a sample offer. The alert
 * is evaluated twice: once to classify the opportunity (classification reads
 * only the evidence and stock checks), then again with meetsThresholds and
 * the units so the result lists every failing check. Sample evidence always
 * fails the first check, so this can never be eligible.
 *
 * timing is tripTiming() from goals.mjs (payoutDays, cashNeededDays) or
 * null; categoryFailures comes from categoryTerms().
 */
export function assessSample({ offer, economics, hourlyFloor, rules, now, timing = null, categoryFailures, journeyKnown = false }) {
  const input = {
    evidenceClass: "sample",
    match: "none", // modelled sale totals are not completed-sale evidence
    contribution: economics.contribution,
    hourly: economics.hourly,
    hourlyFloor,
    // The journey is worked out from the profile; it is unknown only when a
    // public transport fare was not entered.
    journeyKnown,
    offerObserved: offer.priceChecked ?? null,
    now,
    localStockConfirmed: false,
    availability: "unknown", // no branch check has been made
    promotion: null,
    promotionEligible: false,
    shippingKnown: false, // parcel costs are illustrative, not quotes
    recentIndependentSales: null,
    daysToSell: null,
    cashNeededDays: timing?.cashNeededDays ?? null,
    payoutDays: timing?.payoutDays ?? null,
    displayPermitted: true, // synthetic data carries no third-party licence
    units: economics.units,
    trialUnits: rules.trialUnits,
    provenItem: offer.provenItem === true, // never true for a fixture
  };
  const opportunity = classifyOpportunity(
    {
      unitPrice: offer.buy,
      weightKg: offer.weight,
      economics,
      alert: sampleWording(evaluateAlert(input)),
      independentSales: null,
      daysToSell: null,
      sourcingPressure: null,
      resaleWeeksOfSupply: null,
      availability: "unknown",
      promotionUnconfirmed: false,
      categoryFailures,
    },
    rules,
  );
  const alert = sampleWording(evaluateAlert({ ...input, meetsThresholds: opportunity.meetsThresholds }));
  return { alert, opportunity, thresholds: buyingThresholds(offer, economics, rules) };
}

/**
 * The most units one trip can take: the smallest of the trial batch, the
 * profile's maximum units, the demand the sales rate supports, the shelf
 * stock, the load limit by weight, home storage and the cash constraint.
 * Cash is checked against tripEconomics itself so the cap always agrees with
 * the cash-required figure shown (it includes the journey). Unknown or zero
 * weight fails closed at zero units. afterTrial is what the other limits
 * would allow once a verified trade lifts the trial batch.
 */
function unitLimits(offer, profile, load, rules, route, economicsFor) {
  const perUnitCash = offer.buy + offer.pack + offer.post;
  const caps = {
    trial: offer.provenItem === true ? Number.MAX_SAFE_INTEGER : rules.trialUnits,
    quantity: profile.quantity,
    demand: demandUnits(offer),
    stock: offer.stock,
    carry: offer.weight > 0 ? Math.floor(load / offer.weight + 1e-9) : 0,
    storage: profile.storage,
    cash:
      perUnitCash > 0
        ? Math.max(0, Math.floor((profile.budget - route.cost) / perUnitCash))
        : Number.MAX_SAFE_INTEGER,
  };
  const fitting = (keys) => {
    let units = Math.max(0, Math.min(...keys.map((k) => caps[k])));
    while (units > 0 && economicsFor(units).cashRequired > profile.budget) units--;
    return units;
  };
  const keys = Object.keys(caps);
  const fit = Math.max(0, Math.min(...Object.values(caps)));
  const afterTrial = fitting(keys.filter((k) => k !== "trial"));
  const units = fitting(keys);
  if (units < fit) caps.cash = units; // the cash check itself was binding
  const limit = LIMIT_ORDER.find((k) => caps[k] === units) || "cash";
  return { units, limit, caps, afterTrial };
}

/**
 * Plans one trip for one offer under the profile.
 *
 * Returns the offer fields, units and the constraint that bound them
 * (`limit`: trial, quantity, demand, stock, carry, storage or cash), the load
 * limit used (`carry`), the journey, the tripEconomics result, the downside
 * if nothing sells and if only half the units sell, the buying-threshold
 * checks, hard-filter failures, category terms, access needs, when the price
 * and stock were checked and the main uncertainty, the payout timing, the
 * profile-fit reason, the alert (always ineligible: sample data), the
 * opportunity tier and, unless compare is false, the "What changes if I
 * drive?" comparison.
 *
 * Reasons, first match wins: outside the area; no units fit; contribution
 * zero or below; below the hourly target; outside the buying thresholds;
 * payout after the cash date (when one is set); public transport fare not
 * entered; otherwise it fits. A trip that loses money never reads as
 * fitting, and units never exceed the trial batch for an unproven item.
 */
export function plan(
  offer,
  profile,
  { now = new Date().toISOString(), compare = true, timing = null } = {},
) {
  const rules = effectiveRules(profile.rules || {});
  const load = loadLimit(profile.transport, profile.carry);
  const route = journeyFor(profile, offer.miles);
  const terms = categoryTerms(offer, profile, now);
  const salePrice = lowerMedian([...offer.sales]);
  const economicsFor = (units, sellThrough = 1) =>
    tripEconomics({
      units,
      unitCost: offer.buy,
      // No modelled sale means no proceeds: the trip then reads as a loss.
      salePrice: salePrice ?? 0,
      postage: offer.post,
      packaging: offer.pack,
      feeRate: profile.feeRate,
      feeFixed: profile.feeFixed,
      returnsRate: terms.returnsRate,
      journeyCost: route.cost,
      journeyMinutes: route.minutes,
      overheadMinutes: SAMPLE_ASSUMPTIONS.overheadMinutes,
      handlingMinutes: offer.handlingMinutes,
      sellThrough,
    });
  const { units, limit, caps, afterTrial } = unitLimits(offer, profile, load, rules, route, economicsFor);
  const economics = economicsFor(units);
  const halfSold = economicsFor(units, 0.5);
  const { alert, opportunity, thresholds } = assessSample({
    offer,
    economics,
    hourlyFloor: profile.target,
    rules,
    now,
    timing,
    categoryFailures: terms.failures,
    journeyKnown: !fareMissing(profile),
  });
  const noFare = fareMissing(profile);
  const cashDateMissed = Boolean(timing?.cash && timing.cashNeededBy && timing.cash.status !== "on time");
  const reason = !sameArea(profile.area, offer.area)
    ? REASONS.AREA
    : !units
      ? REASONS.LIMIT
      : !(economics.contribution > 0)
        ? REASONS.LOSS
        : !(economics.hourly >= profile.target)
          ? REASONS.HOURLY
          : !thresholds.ok
            ? REASONS.THRESHOLDS
            : cashDateMissed
              ? REASONS.CASH_DATE
              : noFare
                ? REASONS.FARE
                : REASONS.FITS;
  const result = {
    sku: offer.sku,
    name: offer.name,
    variant: offer.variant,
    category: terms.category,
    size: offer.size ?? null,
    shop: offer.shop,
    area: offer.area,
    miles: offer.miles,
    buy: offer.buy,
    post: offer.post,
    pack: offer.pack,
    weight: offer.weight,
    stock: offer.stock,
    handlingMinutes: offer.handlingMinutes,
    sales: [...offer.sales],
    salesPerWeek: offer.salesPerWeek ?? null,
    competingListings: offer.competingListings ?? null,
    sample: true,
    salePrice,
    returnsRate: terms.returnsRate,
    categoryFailures: terms.failures,
    transport: profile.transport,
    carry: load,
    carryEntered: profile.carry,
    units,
    limit,
    caps,
    trialUnits: rules.trialUnits,
    afterTrial,
    sellWindowWeeks: QUANTITY_RULES.sellWindowWeeks,
    weightKg: kg(units * offer.weight),
    journey: route,
    fareMissing: noFare,
    economics,
    downside: {
      nothingSells: economics.unsoldLoss,
      halfSellsUnits: halfSold.sold,
      halfSells: halfSold.contribution,
    },
    thresholds,
    hardFilters: hardFilters({ unitPrice: offer.buy, weightKg: offer.weight }, rules),
    accessNeeds: accessNeeds(offer, profile),
    ...checkedAndUncertainty(offer),
    timing,
    reason,
    fits: reason === REASONS.FITS,
    alert,
    opportunity,
  };
  if (compare) result.compare = compareModes(offer, profile, result, { now, timing });
  return result;
}

/**
 * The transport to compare with. Walkers, cyclists and public transport
 * users see the same trip by car (their cost per mile and parking). Drivers
 * see it by public transport (their fare). The load limit then follows
 * loadLimit(), exactly as it would if the member switched transport.
 */
export function alternativeProfile(profile) {
  if (VEHICLES.has(profile.transport)) {
    return {
      profile: { ...profile, transport: "Public transport" },
      assumptions: [
        `You already travel by ${profile.transport.toLowerCase()}, so this compares the same trip by public transport.`,
        `By public transport the load limit is the smaller of your ${profile.carry} kg and ${HAND_CARRY_KG} kg, about two full shopping bags. This is an assumption, and the Planner uses it whenever you choose public transport.`,
        !Number.isSafeInteger(profile.fare)
          ? "No public transport fare is entered in your profile, so the journey shows as free. Enter your return fare for a fair comparison."
          : profile.fare > 0
            ? `Public transport uses your return fare of ${gbp(profile.fare)}.`
            : "Public transport uses the free fare you entered.",
        `Public transport time assumes ${TRANSPORT["Public transport"].mph} mph door to door, including waiting. No parking or tolls are charged.`,
        "Your cash, storage, unit, trial batch and hourly limits stay the same.",
      ],
    };
  }
  return {
    profile: { ...profile, transport: "Car" },
    assumptions: [
      `By car the journey costs your ${profile.perMile}p per mile plus ${gbp(profile.extra)} parking or tolls, both from your profile.`,
      `By car the load limit is the larger of your ${profile.carry} kg and ${CAR_BOOT_KG} kg, a comfortable car-boot load. This is an assumption, not a measurement, and the Planner uses it whenever you choose a car or van.`,
      `Driving time assumes ${TRANSPORT.Car.mph} mph door to door, including parking.`,
      "Your cash, storage, unit, trial batch and hourly limits stay the same.",
    ],
  };
}

const COMPARED = [
  "units",
  "loadKg",
  "miles",
  "travelCost",
  "parking",
  "travelMinutes",
  "cashRequired",
  "contribution",
  "hourly",
];

/** One side of the comparison. With no units there is no trip. */
function modeSummary(p, profile) {
  const trip = p.units > 0;
  return {
    mode: p.transport,
    carry: p.carry,
    units: p.units,
    limit: p.limit,
    loadKg: p.weightKg,
    miles: trip ? p.journey.miles : 0,
    travelCost: p.economics.costs.travel,
    parking: trip && VEHICLES.has(p.transport) ? profile.extra : 0,
    travelMinutes: trip ? p.journey.minutes : 0,
    cashRequired: p.economics.cashRequired,
    contribution: p.economics.contribution,
    hourly: p.economics.hourly,
    fareMissing: p.fareMissing,
    reason: p.reason,
    fits: p.fits,
  };
}

/**
 * "What changes if I drive?": the same plan in the alternative mode, with
 * units, total load, mileage, travel cost and parking, minutes, cash
 * required, contribution and earnings per hour for both modes and the
 * difference (alternative minus current; null when either side has no
 * figure). timeSaved is current travel minutes minus the alternative's.
 */
export function compareModes(offer, profile, current, { now, timing = null } = {}) {
  const alt = alternativeProfile(profile);
  const other = plan(offer, alt.profile, { now, timing, compare: false });
  const a = modeSummary(current, profile);
  const b = modeSummary(other, alt.profile);
  const difference = Object.fromEntries(
    COMPARED.map((k) => [
      k,
      Number.isFinite(a[k]) && Number.isFinite(b[k]) ? kg(b[k] - a[k]) : null,
    ]),
  );
  return {
    heading: "What changes if I drive?",
    current: a,
    alternative: b,
    difference,
    timeSaved: a.units && b.units ? a.travelMinutes - b.travelMinutes : null,
    assumptions: alt.assumptions,
  };
}

const rankTrips = (a, b) =>
  Number(b.fits) - Number(a.fits) ||
  (b.economics.hourly ?? -Infinity) - (a.economics.hourly ?? -Infinity) ||
  b.economics.contribution - a.economics.contribution;

const brief = (t) => ({
  sku: t.sku,
  name: t.name,
  variant: t.variant,
  shop: t.shop,
  area: t.area,
  miles: t.miles,
  buy: t.buy,
  weight: t.weight,
  sample: true,
});

/**
 * Every fixture planned. Offers that fail a hard filter (price band or
 * weight) never reach the shortlist: they are listed under `rejected` with
 * the reasons. The shortlist (`trips`) ranks fitting trips first, then by
 * earnings per hour. `drive` lists the shortlisted trips that only fit by
 * the alternative transport (`extra`) and those that fit now but not by it
 * (`lost`).
 */
export function planTrips(profile, { now = new Date().toISOString(), timing = null } = {}) {
  const planned = offers.map((o) => plan(o, profile, { now, timing }));
  const trips = planned.filter((t) => !t.hardFilters.length).sort(rankTrips);
  const rejected = planned
    .filter((t) => t.hardFilters.length)
    .map((t) => ({ ...brief(t), reasons: t.hardFilters, tier: t.opportunity.tier, accessNeeds: t.accessNeeds }));
  const side = (t) => ({
    ...brief(t),
    units: t.compare.alternative.units,
    loadKg: t.compare.alternative.loadKg,
    contribution: t.compare.alternative.contribution,
    hourly: t.compare.alternative.hourly,
    reason: t.compare.alternative.reason,
  });
  const alternative = alternativeProfile(profile).profile.transport;
  return {
    sample: true,
    trips,
    rejected,
    drive: {
      heading: "What changes if I drive?",
      current: profile.transport,
      alternative,
      extra: trips.filter((t) => !t.fits && t.compare.alternative.fits).map(side),
      lost: trips.filter((t) => t.fits && !t.compare.alternative.fits).map(side),
    },
    timing,
    accessNeeds: ACCESS_NEEDS,
    rules: describeRules(profile.rules),
  };
}

// Thresholds a member may tighten for themselves. stricter says which way is
// tighter; effectiveRules() ignores any value that would loosen the agreed
// rule. Money in pence, minReturn as a share of the purchase price.
export const RULE_FIELDS = Object.freeze({
  minUnitPrice: {
    label: "Minimum purchase price per unit",
    stricter: "higher",
    read: (v, n) => int(v, n + " (pence)", 0, 1_000_000),
  },
  maxUnitPrice: {
    label: "Maximum purchase price per unit",
    stricter: "lower",
    read: (v, n) => int(v, n + " (pence)", 0, 1_000_000),
  },
  maxWeightKg: {
    label: "Maximum weight per unit",
    stricter: "lower",
    read: (v, n) => num(v, n + " (kg)", 0, 1000),
  },
  minUnitProfit: {
    label: "Minimum profit per unit",
    stricter: "higher",
    read: (v, n) => int(v, n + " (pence)", 0, 1_000_000),
  },
  minReturn: {
    label: "Minimum return on the purchase price",
    stricter: "higher",
    read: (v, n) => num(v, n + " (share, 0.35 is 35%)", 0, 100),
  },
  trialUnits: {
    label: "Trial batch for a first purchase",
    stricter: "lower",
    read: (v, n) => int(v, n + " (units)", 1, 1000),
  },
});

/**
 * Validates a member's threshold overrides. Unknown keys (including names
 * such as toString or __proto__) and invalid values are rejected with 400; a
 * null value means "no override". Whether a value tightens or loosens is
 * decided later by effectiveRules(), so a looser value is accepted here but
 * has no effect.
 */
export function readRules(value) {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) fail("rules must be an object of stricter thresholds");
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (!Object.hasOwn(RULE_FIELDS, key))
      fail(
        `rules.${key} is not a threshold you can set (allowed: ${Object.keys(RULE_FIELDS).join(", ")})`,
      );
    if (v === null) continue;
    out[key] = RULE_FIELDS[key].read(v, "rules." + key);
  }
  return out;
}

/**
 * The agreed thresholds, the member's overrides, the thresholds that apply
 * and any override ignored because it would loosen an agreed rule.
 */
export function describeRules(overrides = {}) {
  const effective = effectiveRules(overrides);
  const pick = (r) => Object.fromEntries(Object.keys(RULE_FIELDS).map((k) => [k, r[k]]));
  return {
    agreed: pick(OPPORTUNITY_RULES),
    overrides: { ...overrides },
    effective: pick(effective),
    ignored: Object.entries(overrides)
      .filter(([k, v]) => Object.hasOwn(RULE_FIELDS, k) && effective[k] !== v)
      .map(([key, value]) => ({
        key,
        label: RULE_FIELDS[key].label,
        value,
        applied: effective[key],
      })),
  };
}

/**
 * Validates a whole planning profile (money in pence) and returns a clean
 * copy. Every field is required; transport must be one of MODES. fare may
 * be null, meaning not entered: public transport is then costed as free and
 * the trip is never called fitting until a fare (0 for free travel) is sent.
 */
export function readProfile(input) {
  if (!isObject(input)) fail("Send the profile as a JSON object");
  return {
    area: text(input.area, "area", 100),
    budget: int(input.budget, "budget (pence)", 0, 10_000_000),
    target: int(input.target, "target (pence per hour)", 0, 1_000_000),
    transport: oneOf(input.transport, "transport", MODES),
    carry: num(input.carry, "carry (kg)", 0, 1000),
    quantity: int(input.quantity, "quantity", 1, 1000),
    fare: input.fare === null ? null : int(input.fare, "fare (pence, or null if not entered)", 0, 100_000),
    perMile: int(input.perMile, "perMile (pence per mile)", 0, 1000),
    extra: int(input.extra, "extra (pence)", 0, 100_000),
    storage: int(input.storage, "storage (units)", 0, 100_000),
    feeRate: num(input.feeRate, "feeRate", 0, 0.5),
    feeFixed: int(input.feeFixed, "feeFixed (pence)", 0, 10_000),
    returnsRate: num(input.returnsRate, "returnsRate", 0, 0.5),
    rules: readRules(input.rules),
  };
}
