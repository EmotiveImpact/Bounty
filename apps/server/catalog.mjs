// Planner fixtures and single-item trip planning. Money is integer pence and
// time is minutes throughout; the client converts pounds at the edge.
//
// The five London offers are synthetic sample data. Their sale totals, sales
// rates and competing listings are modelled for illustration, not observed,
// so a planner result is always labelled as sample and can never become a buy
// alert.
//
// A blank public transport fare is a missing input, never a free journey,
// and never a reason on its own to hide an item. By public transport with no
// fare entered (and travel not ticked as free), every figure after travel
// (cash required, contribution, profit per unit, earnings per hour, the
// downside and the after-travel threshold verdict) is null, and the same
// figures before travel (the journey left out, not costed at nothing) are
// given separately under `beforeTravel` and always labelled "before your
// fare". An offer inside every threshold before travel is still shortlisted
// (thresholds.fareNeeded) and put in baskets, ranked on profit per unit
// before travel, with the note FARE_NEEDED; one that fails even before its
// fare is rejected as before.
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
  demandUnits,
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
    area: "London",
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
    area: "London",
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
    area: "London",
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
    area: "London",
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
  // A second offer inside every threshold for the default profile, so the
  // basket plan in Goals can show two different items bought on one trip
  // under one cash limit. Illustrative like the others, never a buy alert.
  fixture({
    sku: "bottle",
    name: "Insulated steel water bottle",
    variant: "500 ml · Blue · New",
    category: "general",
    size: null,
    shop: "Tesco",
    area: "London",
    miles: 1.1,
    buy: 800,
    sales: [2000, 2100, 2150, 2200],
    post: 270,
    pack: 40,
    weight: 0.4,
    stock: 6,
    handlingMinutes: 6,
    salesPerWeek: 2,
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
  area: "London",
  budget: 10000,
  target: 1200,
  transport: "Walk",
  carry: 5,
  quantity: 4,
  fare: null, // not entered, as the Planner starts
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
  // Everything known passes, but the public transport fare is blank: never
  // "fits", because the fare can only lower the figures.
  FARE: "Fits before your fare is added",
  FITS: "Fits your profile",
});

// The note an offer carries while its public transport fare is blank: it is
// inside the thresholds before travel, and the travel cost is still to be
// added before the verdict after travel is known.
export const FARE_NEEDED =
  "Travel cost still to be added: enter your return fare to check this trip against your thresholds after travel";
// What an after-travel figure reads in an alert check while the fare is blank.
export const FARE_UNKNOWN = "not known until you enter your fare";
// What the blank fare itself (the travel cost) reads.
export const FARE_NOT_KNOWN = "not known yet";
// The label every before-travel figure carries.
export const BEFORE_FARE = "before your fare";

// Load limits by transport. These are assumptions, not measurements: a car
// boot takes a comfortable 25 kg without lifting strain, and by public
// transport a shopper carries about two full shopping bags, 10 kg. The same
// rule applies to the member's own transport and to the comparison, so "What
// changes if I drive?" always matches what the Car plan then shows.
export const CAR_BOOT_KG = 25;
export const HAND_CARRY_KG = 10;

// Quantity: a first purchase is capped at the trial batch
// (OPPORTUNITY_RULES.trialUnits) and at the units the sales rate supports in
// the sell window (OPPORTUNITY_RULES.sellWindowWeeks) after competing
// listings, worked out by opportunity.demandUnits like every other area.

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
 * applies to public transport (journey() ignores it otherwise). A fare that
 * was not entered costs nothing here, which is only ever the best case:
 * when fareMissing() is true no figure built on this cost is shown (see
 * unknownJourney()). The profile's cost per mile, parking and tolls only
 * apply to a car or van: walking, cycling and public transport use the
 * mode's own running cost of zero.
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
 * The tripEconomics result with every figure that depends on the journey
 * cost set to null, for a public transport trip whose fare is blank: travel,
 * total costs, contribution (all units and per unit), cash required, travel
 * per unit, earnings per hour, the loss if nothing sells and the break-even
 * sale price. Units, proceeds, the other costs and the working time do not
 * depend on the fare and are kept. journeyKnown is false.
 */
export function unknownJourney(economics) {
  return {
    ...economics,
    costs: { ...economics.costs, travel: null },
    totalCosts: null,
    contribution: null,
    unitContribution: null,
    cashRequired: null,
    journeyPerUnit: null,
    hourly: null,
    unsoldLoss: null,
    breakEvenSale: null,
    journeyKnown: false,
  };
}

/**
 * The figures that depend on the journey, worked out with the journey left
 * out, for a public transport trip whose fare is blank: contribution, profit
 * per unit and its return, cash required, earnings per hour, the loss if
 * nothing sells, the half-sold contribution and the break-even sale price.
 * A fare only lowers contribution, profit and earnings per hour, so each is
 * the best the trip can do; for the same units it adds exactly the fare to
 * the cash and the loss (if the fare leaves too little cash, fewer units fit
 * once it is entered). Each is shown only labelled "before your fare"
 * (BEFORE_FARE), or the cash "plus your fare", never as the trip's figure.
 * economics is the tripEconomics result with no journey cost, halfSold the
 * same with half the units sold.
 */
export function beforeTravelFigures(economics, halfSold = null) {
  const { unitProfit, returnOnCost } = unitReturns(economics);
  return {
    contribution: economics.contribution,
    unitProfit,
    returnOnCost,
    cashRequired: economics.cashRequired,
    hourly: economics.hourly,
    unsoldLoss: economics.unsoldLoss,
    halfSells: halfSold ? halfSold.contribution : null,
    breakEvenSale: economics.breakEvenSale,
  };
}

/**
 * Units the offer's sales rate supports in the sell window once competing
 * listings are served (opportunity.demandUnits over
 * OPPORTUNITY_RULES.sellWindowWeeks). Null when the sales rate or the
 * competition is unknown; the quantity caps then fail closed at 0 units.
 */
export const offerDemand = (offer) =>
  demandUnits(
    { salesPerWeek: offer.salesPerWeek, competingListings: offer.competingListings },
    OPPORTUNITY_RULES.sellWindowWeeks,
  );

// Costs and times every offer must carry. A blank is never counted as zero:
// it is listed by blankInputs() and the profit per unit is not checked.
const REQUIRED_INPUTS = Object.freeze([
  ["buy", "purchase price"],
  ["post", "parcel cost"],
  ["pack", "packaging cost"],
  ["handlingMinutes", "handling time"],
]);
const entered = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Plain labels of the offer's required costs and times that are blank. */
export function blankInputs(offer) {
  return REQUIRED_INPUTS.filter(([key]) => !entered(offer[key])).map(([, label]) => label);
}

/**
 * Required costs and times left blank for this offer and profile: the
 * offer's own blanks and, by public transport, a fare that was not entered.
 * This is the evaluateAlert missingInputs list; [] when everything is in.
 */
export const missingInputs = (offer, profile) => [
  ...blankInputs(offer),
  ...(fareMissing(profile) ? ["public transport fare"] : []),
];

// What stopped any unit fitting, in plain words.
const LIMIT_TEXT = Object.freeze({
  trial: "the trial batch for a first purchase",
  quantity: "your maximum units",
  demand: "expected demand after competing listings",
  stock: "the stock on the shelf",
  carry: "your load limit",
  storage: "your storage at home",
  cash: "your available cash",
});

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
 * The profit and return thresholds for one unit: profit per unit (pence,
 * after every variable cost and the unit's share of travel) against the
 * minimum, and the return on the purchase price, compared in whole pence by
 * meetsReturn so 34.95% fails 35%. Returns the failures in plain words;
 * atMost words them as a best case ("of at most £4.10").
 */
export function unitThresholdFailures(unitProfit, unitCost, rules = OPPORTUNITY_RULES, { atMost = false } = {}) {
  const failures = [];
  const of = atMost ? "of at most " : "of ";
  if (unitProfit < rules.minUnitProfit)
    failures.push(`Profit per unit ${of}${gbp(unitProfit)} is below ${gbp(rules.minUnitProfit)}`);
  if (!(unitCost > 0)) failures.push("Return on the purchase price unknown");
  else if (!meetsReturn(unitProfit, unitCost, rules.minReturn)) {
    const share = Math.floor((unitProfit / unitCost) * 1000 + 1e-9) / 1000;
    failures.push(`Return ${of}${pct(share)} is below ${pct(rules.minReturn)} of the purchase price`);
  }
  return failures;
}

/**
 * Checks the agreed buying thresholds (or the member's stricter ones) that a
 * planner can measure: the price band and weight limit, profit per unit
 * after every variable cost and the unit's share of travel, and the return on
 * the purchase price. A required cost or time left blank is never counted as
 * zero, so the profit is then not checked and the offer fails. Evidence
 * checks are left to the alert gate.
 *
 * fareMissing: the public transport fare is blank, so economics is the trip
 * with the journey left out. The verdict after travel is then never ok
 * (unitProfit and returnOnCost, the after-travel figures, are null): an
 * offer that fails even before its fare fails with "at most" figures and
 * says so; one inside every threshold before travel is still shortlisted,
 * with fareNeeded true and the note FARE_NEEDED as its only entry in
 * failures. beforeTravel ({ unitProfit, returnOnCost, ok }) holds the
 * before-travel figures and verdict while the fare is blank, and is null
 * once the journey is known.
 */
export function buyingThresholds(offer, economics, rules = OPPORTUNITY_RULES, { fareMissing = false } = {}) {
  const failures = hardFilters({ unitPrice: offer.buy, weightKg: offer.weight }, rules);
  const best = unitReturns(economics);
  const blank = blankInputs(offer);
  let fareNeeded = false;
  if (blank.length)
    failures.push(
      `Profit per unit cannot be checked until these are entered: ${[...blank, ...(fareMissing ? ["public transport fare"] : [])].join(", ")}`,
    );
  else if (best.unitProfit === null) failures.push("Profit per unit unknown until at least one unit fits");
  else if (fareMissing) {
    const worst = unitThresholdFailures(best.unitProfit, economics.unitCost, rules, { atMost: true });
    if (worst.length) failures.push(...worst.map((f) => f + ", even before your public transport fare"));
    else if (!failures.length) {
      // Only the fare is missing: never a pass after travel and never a
      // measured failure. The offer is shortlisted on what is known.
      fareNeeded = true;
      failures.push(FARE_NEEDED);
    }
  } else failures.push(...unitThresholdFailures(best.unitProfit, economics.unitCost, rules));
  const measured = !blank.length && best.unitProfit !== null;
  return {
    unitProfit: fareMissing ? null : best.unitProfit,
    returnOnCost: fareMissing ? null : best.returnOnCost,
    ok: failures.length === 0,
    failures,
    fareNeeded,
    beforeTravel: fareMissing
      ? {
          unitProfit: measured ? best.unitProfit : null,
          returnOnCost: measured ? best.returnOnCost : null,
          ok: fareNeeded,
        }
      : null,
  };
}

/**
 * True when an offer belongs on the shortlist (or in a basket): inside every
 * buying threshold after its share of travel or, while the public transport
 * fare is blank, inside every one before travel. A blank fare never hides an
 * item; a blank cost, a failed threshold or no unit fitting still does.
 */
export const shortlisted = (thresholds) => thresholds.ok || thresholds.fareNeeded === true;

// Wording for checks that fail on sample data, so the lists match the
// figures shown next to them: the planner shows illustrative parcel costs
// and a payout date from the member's own assumptions.
const SAMPLE_DETAILS = Object.freeze({
  shipping: () => "Parcel cost is an illustrative sample figure, not a quote",
  "price-at-branch": () => "Illustrative sample price, not a shelf price seen at a branch",
  "days-to-sell": (detail) =>
    detail === "Days to sell unknown"
      ? "No sold evidence for days to sell; the payout date uses your Goals assumption"
      : detail,
});
// While a public transport fare is blank, the checks that need the journey
// cost say so in the same words as the figures.
const FARE_DETAILS = Object.freeze({
  "positive-contribution": () => "Contribution is " + FARE_UNKNOWN,
  "hourly-floor": () => "Earnings per hour are " + FARE_UNKNOWN,
  journey: () =>
    "Public transport fare not entered, so the travel cost is " +
    FARE_NOT_KNOWN +
    " and profit and earnings per hour after travel are " +
    FARE_UNKNOWN,
});
function sampleWording(alert, { fareMissing = false } = {}) {
  const details = fareMissing ? { ...SAMPLE_DETAILS, ...FARE_DETAILS } : SAMPLE_DETAILS;
  const checks = alert.checks.map((c) =>
    !c.ok && Object.hasOwn(details, c.id) ? { ...c, detail: details[c.id](c.detail) } : c,
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
 *
 * journeyKnown is false only when a public transport fare was not entered.
 * economics may then be unknownJourney() (contribution and earnings per
 * hour null), and bestCase is the same trip with the journey left out, used
 * for the before-travel verdict (thresholds.beforeTravel): whether the offer
 * fails even before its fare or is shortlisted waiting for it. Profit per
 * unit and the return after travel are then null, never 0.
 */
export function assessSample({
  offer,
  economics,
  bestCase = economics,
  hourlyFloor,
  rules,
  now,
  timing = null,
  categoryFailures,
  journeyKnown = false,
}) {
  const fareMissing = !journeyKnown;
  const input = {
    evidenceClass: "sample",
    match: "none", // modelled sale totals are not completed-sale evidence
    contribution: economics.contribution,
    hourly: economics.hourly,
    hourlyFloor,
    // Required costs and times left blank; the journey is unknown only when
    // a public transport fare was not entered.
    missingInputs: [...blankInputs(offer), ...(journeyKnown ? [] : ["public transport fare"])],
    // The journey is worked out from the profile; it is unknown only when a
    // public transport fare was not entered.
    journeyKnown,
    offerObserved: offer.priceChecked ?? null,
    now,
    localStockConfirmed: false,
    availability: "unknown", // no branch check has been made
    priceAtBranch: false, // a sample price was never seen at a branch
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
    // Modelled demand in the sell window (null when the rate or competition
    // is unknown, which fails the demand check).
    demandUnits: offerDemand(offer),
    sellWindowWeeks: OPPORTUNITY_RULES.sellWindowWeeks,
  };
  const classified = classifyOpportunity(
    {
      unitPrice: offer.buy,
      weightKg: offer.weight,
      economics,
      alert: sampleWording(evaluateAlert(input), { fareMissing }),
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
  // With the journey cost unknown there is no profit per unit to report
  // (the classification would otherwise divide a null contribution).
  const opportunity = Number.isFinite(economics.contribution)
    ? classified
    : { ...classified, unitProfit: null, returnOnCost: null, targetPrice: null };
  const alert = sampleWording(evaluateAlert({ ...input, meetsThresholds: opportunity.meetsThresholds }), { fareMissing });
  return { alert, opportunity, thresholds: buyingThresholds(offer, bestCase, rules, { fareMissing }) };
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
    demand: offerDemand(offer) ?? 0, // unknown demand fails closed at 0 units
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
 *
 * With a blank public transport fare (fareMissing), the loss, hourly and
 * threshold reasons are judged before travel (the journey left out),
 * because a fare only lowers the figures; the economics, journey cost and
 * downside figures that depend on the fare are null, never 0, and
 * thresholds.ok is false. `beforeTravel` (beforeTravelFigures, null once
 * the journey is known or when no unit fits) holds the same figures before
 * travel, `travelNote` says the travel cost is still to be added, and an
 * offer inside every threshold before travel is still shortlisted
 * (thresholds.fareNeeded) with the reason REASONS.FARE.
 *
 * timing is null, a goals.tripTiming() result, or a function
 * ({ units, salesPerWeek }) => tripTiming result, so the payout date can
 * allow for the time the sales rate needs to sell every unit planned
 * (opportunity.daysToSellAll). The route passes the function.
 */
export function plan(
  offer,
  profile,
  { now = new Date().toISOString(), compare = true, timing: timingOption = null } = {},
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
  // With a blank fare the journey is left out (journeyFor costs a missing
  // fare at nothing) to find the most units the other limits allow and the
  // figures before travel; every figure after travel is then unknown
  // (unknownJourney). With no units there is no journey, so nothing depends
  // on the fare.
  const noFare = fareMissing(profile);
  const { units, limit, caps, afterTrial } = unitLimits(offer, profile, load, rules, route, economicsFor);
  const bestCase = economicsFor(units);
  const fareUnknown = noFare && units > 0;
  const economics = fareUnknown ? unknownJourney(bestCase) : bestCase;
  const halfSold = economicsFor(units, 0.5);
  const timing =
    typeof timingOption === "function"
      ? timingOption({ units, salesPerWeek: offer.salesPerWeek ?? null })
      : timingOption;
  const { alert, opportunity, thresholds } = assessSample({
    offer,
    economics,
    bestCase,
    hourlyFloor: profile.target,
    rules,
    now,
    timing,
    categoryFailures: terms.failures,
    journeyKnown: !noFare,
  });
  const cashDateMissed = Boolean(timing?.cash && timing.cashNeededBy && timing.cash.status !== "on time");
  // A fare can only lower the contribution, so a best case that loses
  // money, misses the hourly target or fails a threshold fails with any
  // fare; otherwise a blank fare leaves the trip waiting for it.
  const reason = !sameArea(profile.area, offer.area)
    ? REASONS.AREA
    : !units
      ? REASONS.LIMIT
      : !(bestCase.contribution > 0)
        ? REASONS.LOSS
        : !(bestCase.hourly >= profile.target)
          ? REASONS.HOURLY
          : !thresholds.ok && !thresholds.fareNeeded
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
    sellWindowWeeks: OPPORTUNITY_RULES.sellWindowWeeks,
    demandUnits: offerDemand(offer),
    weightKg: kg(units * offer.weight),
    journey: fareUnknown ? { ...route, cost: null } : route,
    fareMissing: noFare,
    economics,
    beforeTravel: fareUnknown ? beforeTravelFigures(bestCase, halfSold) : null,
    travelNote: fareUnknown ? FARE_NEEDED : null,
    downside: {
      nothingSells: economics.unsoldLoss,
      halfSellsUnits: halfSold.sold,
      halfSells: fareUnknown ? null : halfSold.contribution,
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
  if (compare) result.compare = compareModes(offer, profile, result, { now, timing: timingOption });
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
          ? `No public transport fare is entered in your profile, so the public transport fare is ${FARE_NOT_KNOWN}: its cash required, contribution and earnings per hour are shown ${BEFORE_FARE}, and the figures after travel are ${FARE_UNKNOWN}. Enter your return fare (or tick that your travel is free) to compare after travel.`
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
      ...(fareMissing(profile)
        ? [
            `No public transport fare is entered in your profile, so your public transport fare is ${FARE_NOT_KNOWN}: your cash required, contribution and earnings per hour by public transport, and the differences, are shown ${BEFORE_FARE}. The figures after travel are ${FARE_UNKNOWN}.`,
          ]
        : []),
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

/**
 * One side of the comparison. With no units there is no trip. beforeTravel
 * is the side's cash required, contribution and earnings per hour before its
 * fare while a public transport fare is blank (null otherwise).
 */
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
    beforeTravel: p.beforeTravel
      ? {
          cashRequired: p.beforeTravel.cashRequired,
          contribution: p.beforeTravel.contribution,
          hourly: p.beforeTravel.hourly,
        }
      : null,
    reason: p.reason,
    fits: p.fits,
  };
}

// The comparison rows that depend on a public transport fare and can be
// compared before it: the travel cost itself is simply not known yet.
const COMPARED_BEFORE_TRAVEL = ["cashRequired", "contribution", "hourly"];

/**
 * "What changes if I drive?": the same plan in the alternative mode, with
 * units, total load, mileage, travel cost and parking, minutes, cash
 * required, contribution and earnings per hour for both modes and the
 * difference (alternative minus current; null when either side has no
 * figure). timeSaved is current travel minutes minus the alternative's.
 *
 * While one side's public transport fare is blank its after-travel figures
 * and their differences are null; differenceBeforeTravel then gives the
 * cash, contribution and hourly differences using that side's figures
 * before its fare (null where both sides are known, or either has no trip),
 * always shown labelled "before your fare".
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
  const pending = Boolean(a.beforeTravel || b.beforeTravel);
  const known = (s, k) => (s.beforeTravel ? s.beforeTravel[k] : s[k]);
  const differenceBeforeTravel = Object.fromEntries(
    COMPARED_BEFORE_TRAVEL.map((k) => [
      k,
      pending && Number.isFinite(known(a, k)) && Number.isFinite(known(b, k)) ? known(b, k) - known(a, k) : null,
    ]),
  );
  return {
    heading: "What changes if I drive?",
    current: a,
    alternative: b,
    difference,
    differenceBeforeTravel,
    timeSaved: a.units && b.units ? a.travelMinutes - b.travelMinutes : null,
    assumptions: alt.assumptions,
  };
}

/**
 * Shortlist order. Trips whose travel cost is known come first, in today's
 * order: fitting trips first, then earnings per hour, then contribution.
 * Trips waiting for a public transport fare follow, because their figures
 * are only the best the trip can do and must not outrank a measured one:
 * those that fit the profile before the fare first, then profit per unit
 * before the fare, then contribution before it.
 */
export const rankTrips = (a, b) => {
  const pa = Boolean(a.beforeTravel);
  const pb = Boolean(b.beforeTravel);
  if (pa !== pb) return Number(pa) - Number(pb);
  if (pa)
    return (
      Number(b.reason === REASONS.FARE) - Number(a.reason === REASONS.FARE) ||
      (b.beforeTravel.unitProfit ?? -Infinity) - (a.beforeTravel.unitProfit ?? -Infinity) ||
      (b.beforeTravel.contribution ?? -Infinity) - (a.beforeTravel.contribution ?? -Infinity)
    );
  return (
    Number(b.fits) - Number(a.fits) ||
    (b.economics.hourly ?? -Infinity) - (a.economics.hourly ?? -Infinity) ||
    b.economics.contribution - a.economics.contribution
  );
};

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
 * Why a planned trip is not shortlisted, in plain words: the price or
 * weight limits, no units fitting (so profit per unit cannot be checked),
 * a blank cost, or the profit and return thresholds at the units planned
 * (with a blank public transport fare, a failure even before the fare).
 */
function notShortlisted(t) {
  if (t.hardFilters.length) return t.hardFilters;
  if (!t.units && !blankInputs(t).length) {
    const unknownDemand = t.limit === "demand" && t.demandUnits === null;
    return [
      `No units fit: stopped by ${unknownDemand ? "an unknown sales rate or competition" : LIMIT_TEXT[t.limit]}, so profit per unit cannot be checked`,
    ];
  }
  return t.thresholds.failures;
}

/**
 * Every fixture planned. An offer failing any buying threshold (price band,
 * weight, profit per unit or return, with the member's stricter values)
 * never reaches the shortlist, and neither does one where no unit fits, so
 * its profit per unit cannot be checked: they are listed under `rejected`
 * with the reasons (tier Reject when a threshold fails). The shortlist
 * (`trips`) is ranked by rankTrips. `drive` lists the offers that do not
 * fit now but fit by the alternative transport (`extra`; never one outside
 * the price or weight limits), the shortlisted trips that fit now but not
 * by it (`lost`) and those that fit now and, by public transport with no
 * fare entered, fit only before the fare (`fareNeeded`). `currentFareMissing`
 * and `alternativeFareMissing` say which side has no fare.
 *
 * A blank public transport fare never hides an offer on its own: one inside
 * every threshold before travel is shortlisted (thresholds.fareNeeded, with
 * `beforeTravel` figures and `travelNote`), ranked after any trip whose
 * travel is known, and `ranking` says the order is before travel. One that
 * fails even before its fare is rejected with that failure.
 */
export function planTrips(profile, { now = new Date().toISOString(), timing = null } = {}) {
  const planned = offers.map((o) => plan(o, profile, { now, timing }));
  const trips = planned.filter((t) => shortlisted(t.thresholds)).sort(rankTrips);
  const rejected = planned
    .filter((t) => !shortlisted(t.thresholds))
    .map((t) => ({
      ...brief(t),
      units: t.units,
      unitProfit: t.thresholds.unitProfit,
      returnOnCost: t.thresholds.returnOnCost,
      reasons: notShortlisted(t),
      // Never true here: an offer waiting only for its fare is shortlisted.
      fareNeeded: t.thresholds.fareNeeded,
      // Reject when a threshold is measured and fails; a blank input or no
      // units fitting keeps the evidence tier (Review for sample data).
      tier: t.hardFilters.length
        ? "Reject"
        : blankInputs(t).length || !t.units
          ? t.opportunity.tier
          : "Reject",
      accessNeeds: t.accessNeeds,
    }));
  const side = (t) => ({
    ...brief(t),
    units: t.compare.alternative.units,
    loadKg: t.compare.alternative.loadKg,
    contribution: t.compare.alternative.contribution,
    hourly: t.compare.alternative.hourly,
    beforeTravel: t.compare.alternative.beforeTravel,
    reason: t.compare.alternative.reason,
  });
  const altProfile = alternativeProfile(profile).profile;
  const waitsForFare = (t) => t.compare.alternative.reason === REASONS.FARE;
  const waiting = trips.filter((t) => t.beforeTravel).length;
  return {
    sample: true,
    trips,
    rejected,
    // How the shortlist is ordered: "after travel" when every trip's travel
    // cost is known, "before travel" when none is (a blank public transport
    // fare), "known first" when some are.
    ranking: !waiting ? "after travel" : waiting === trips.length ? "before travel" : "known first",
    drive: {
      heading: "What changes if I drive?",
      current: profile.transport,
      alternative: altProfile.transport,
      currentFareMissing: fareMissing(profile),
      alternativeFareMissing: fareMissing(altProfile),
      extra: planned
        .filter((t) => !t.hardFilters.length && !t.fits && t.compare.alternative.fits)
        .map(side),
      lost: trips.filter((t) => t.fits && !t.compare.alternative.fits && !waitsForFare(t)).map(side),
      fareNeeded: trips.filter((t) => t.fits && waitsForFare(t)).map(side),
    },
    // The payout for one unit; each trip carries its own for its units.
    timing: typeof timing === "function" ? timing({ units: 1, salesPerWeek: null }) : timing,
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
    read: (v, n) => int(v, n + " (in pence)", 0, 1_000_000),
  },
  maxUnitPrice: {
    label: "Maximum purchase price per unit",
    stricter: "lower",
    read: (v, n) => int(v, n + " (in pence)", 0, 1_000_000),
  },
  maxWeightKg: {
    label: "Maximum weight per unit",
    stricter: "lower",
    read: (v, n) => num(v, n + " (in kg)", 0, 1000),
  },
  minUnitProfit: {
    label: "Minimum profit per unit",
    stricter: "higher",
    read: (v, n) => int(v, n + " (in pence)", 0, 1_000_000),
  },
  minReturn: {
    label: "Minimum return on the purchase price",
    stricter: "higher",
    read: (v, n) => num(v, n + " (as a share, 0.35 is 35%)", 0, 100),
  },
  trialUnits: {
    label: "Trial batch for a first purchase",
    stricter: "lower",
    read: (v, n) => int(v, n + " (in units)", 1, 1000),
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
  if (!isObject(value)) fail("Send your stricter thresholds as an object");
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (!Object.hasOwn(RULE_FIELDS, key))
      fail(
        `"${key}" is not a threshold you can set. You can set: ${Object.values(RULE_FIELDS).map((f) => f.label.toLowerCase()).join(", ")}`,
      );
    if (v === null) continue;
    out[key] = RULE_FIELDS[key].read(v, RULE_FIELDS[key].label);
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
 * be null, meaning not entered: by public transport every figure after
 * travel is then unknown, and offers are shortlisted and put in baskets on
 * their figures before travel until a fare (0 for free travel) is sent.
 * Error messages name each field as the Planner labels it.
 */
export function readProfile(input) {
  if (!isObject(input)) fail("Send the profile as a JSON object");
  return {
    area: text(input.area, "Local area", 100),
    budget: int(input.budget, "Available cash (in pence)", 0, 10_000_000),
    target: int(input.target, "Hourly target (in pence an hour)", 0, 1_000_000),
    transport: oneOf(input.transport, "Transport", MODES),
    carry: num(input.carry, "Carry limit (in kg)", 0, 1000),
    quantity: int(input.quantity, "Maximum units per trip", 1, 1000),
    fare:
      input.fare === null
        ? null
        : int(input.fare, "Public transport fare (in pence, or empty if not entered)", 0, 100_000),
    perMile: int(input.perMile, "Car or van cost per mile (in pence)", 0, 1000),
    extra: int(input.extra, "Parking or tolls (in pence)", 0, 100_000),
    storage: int(input.storage, "Storage at home (in units)", 0, 100_000),
    feeRate: num(input.feeRate, "Marketplace fee (as a share, 0.13 is 13%)", 0, 0.5),
    feeFixed: int(input.feeFixed, "Fixed fee per item sold (in pence)", 0, 10_000),
    returnsRate: num(input.returnsRate, "Returns allowance (as a share, 0.05 is 5%)", 0, 0.5),
    rules: readRules(input.rules),
  };
}
