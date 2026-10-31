// Planner fixtures and single-item trip planning. Money is integer pence and
// time is minutes throughout; the client converts pounds at the edge.
//
// The four Leeds offers are synthetic sample data. Their sale totals are
// modelled for illustration, not observed sales, so a planner result is always
// labelled as sample and can never become a buy alert.
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
  classifyOpportunity,
  effectiveRules,
  hardFilters,
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
const fixture = (o) => Object.freeze({ ...o, sales: Object.freeze(o.sales), sample: true });
export const offers = Object.freeze([
  fixture({
    sku: "knit",
    name: "Cotton crew-neck jumper",
    variant: "Navy · Medium · New",
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
  }),
  fixture({
    sku: "baby",
    name: "Baby sleepsuits",
    variant: "Three-pack · 0 to 3 months · New",
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
  }),
  fixture({
    sku: "pot",
    name: "Terracotta planter",
    variant: "32 cm · Single · New",
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
  }),
  // Included so the sample shows a trip that clears the buying thresholds.
  // Like the others it is illustrative and can never become a buy alert.
  fixture({
    sku: "jacket",
    name: "Children's waterproof jacket",
    variant: "Navy · Age 5 to 6 · New",
    shop: "Sainsbury's",
    area: "Leeds",
    miles: 1.4,
    buy: 1000,
    sales: [2400, 2500, 2600, 2650],
    post: 300,
    pack: 35,
    weight: 0.45,
    stock: 4,
    handlingMinutes: 10,
  }),
]);

// Server-side profile. Money in pence: budget, target (per hour), fare
// (return public transport fare), perMile (car or van running cost), extra
// (parking or tolls per trip, car or van only) and feeFixed. carry is kg,
// quantity the most units for one trip, storage the units that fit at home.
// rules holds the member's stricter buying thresholds.
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
  LIMIT: "Budget, carrying or storage limit",
  LOSS: "Loses money",
  HOURLY: "Below hourly target",
  THRESHOLDS: "Outside your buying thresholds",
  FITS: "Fits your profile",
});

// Comparison carry limits. These are assumptions, not measurements: a car
// boot takes a comfortable 25 kg without lifting strain, and by public
// transport a shopper carries about two full shopping bags, 10 kg.
export const CAR_BOOT_KG = 25;
export const HAND_CARRY_KG = 10;

const VEHICLES = new Set(["Car", "Van"]);
const LIMIT_ORDER = ["quantity", "stock", "carry", "storage", "cash"];

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
export const sameArea = (a, b) =>
  String(a ?? "").trim().replace(/\s+/g, " ").toLowerCase() ===
  String(b ?? "").trim().replace(/\s+/g, " ").toLowerCase();
export const gbp = (pence) =>
  (pence < 0 ? "-£" : "£") + (Math.abs(pence) / 100).toFixed(2);
const pct = (share) => Math.round(share * 1000) / 10 + "%";

/**
 * One return journey from the area centre for this profile. The fare only
 * applies to public transport (journey() ignores it otherwise). The profile's
 * cost per mile, parking and tolls only apply to a car or van: walking,
 * cycling and public transport use the mode's own running cost of zero.
 */
export function journeyFor(profile, miles) {
  const vehicle = VEHICLES.has(profile.transport);
  return journey({
    mode: profile.transport,
    miles,
    fare: profile.transport === "Public transport" ? profile.fare : 0,
    perMile: vehicle ? profile.perMile : undefined,
    extra: vehicle ? profile.extra : 0,
  });
}

/**
 * Checks the agreed buying thresholds (or the member's stricter ones) that a
 * planner can measure: the price band and weight limit, profit per unit
 * after every variable cost and the unit's share of travel, and the return on
 * the purchase price. Evidence checks are left to the alert gate.
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
    if (returnOnCost === null)
      failures.push("Return on the purchase price unknown");
    else if (returnOnCost < rules.minReturn)
      failures.push(
        `Return of ${pct(returnOnCost)} is below ${pct(rules.minReturn)} of the purchase price`,
      );
  }
  return { unitProfit, returnOnCost, ok: failures.length === 0, failures };
}

/**
 * Alert, opportunity tier and threshold checks for a sample offer. The alert
 * is evaluated twice: once to classify the opportunity (classification reads
 * only the evidence and stock checks), then again with meetsThresholds and
 * the units so the result lists every failing check. Sample evidence always
 * fails the first check, so this can never be eligible.
 */
export function assessSample({ offer, economics, hourlyFloor, rules, now }) {
  const input = {
    evidenceClass: "sample",
    match: "none", // modelled sale totals are not completed-sale evidence
    contribution: economics.contribution,
    hourly: economics.hourly,
    hourlyFloor,
    offerObserved: null, // fixtures carry no observation date
    now,
    localStockConfirmed: false,
    availability: null,
    promotion: null,
    promotionEligible: false,
    shippingKnown: false, // parcel costs are illustrative, not quotes
    recentIndependentSales: null,
    daysToSell: null,
    cashNeededDays: null,
    displayPermitted: true, // synthetic data carries no third-party licence
    units: economics.units,
    trialUnits: rules.trialUnits,
    provenItem: false,
  };
  const opportunity = classifyOpportunity(
    {
      unitPrice: offer.buy,
      weightKg: offer.weight,
      economics,
      alert: evaluateAlert(input),
      independentSales: null,
      daysToSell: null,
      sourcingPressure: null,
      resaleWeeksOfSupply: null,
    },
    rules,
  );
  const alert = evaluateAlert({ ...input, meetsThresholds: opportunity.meetsThresholds });
  return { alert, opportunity, thresholds: buyingThresholds(offer, economics, rules) };
}

/**
 * The most units one trip can take: the smallest of the profile's maximum
 * units, the shelf stock, the carry limit by weight, home storage and the
 * cash constraint. Cash is checked against tripEconomics itself so the cap
 * always agrees with the cash-required figure shown (it includes the
 * journey). Unknown or zero weight fails closed at zero units.
 */
function unitLimits(offer, profile, route, economicsFor) {
  const perUnitCash = offer.buy + offer.pack + offer.post;
  const caps = {
    quantity: profile.quantity,
    stock: offer.stock,
    carry: offer.weight > 0 ? Math.floor(profile.carry / offer.weight + 1e-9) : 0,
    storage: profile.storage,
    cash:
      perUnitCash > 0
        ? Math.max(0, Math.floor((profile.budget - route.cost) / perUnitCash))
        : Number.MAX_SAFE_INTEGER,
  };
  const fit = Math.max(0, Math.min(...Object.values(caps)));
  let units = fit;
  while (units > 0 && economicsFor(units).cashRequired > profile.budget) units--;
  if (units < fit) caps.cash = units; // the cash check itself was binding
  const limit = LIMIT_ORDER.find((k) => caps[k] === units) || "cash";
  return { units, limit, caps };
}

/**
 * Plans one trip for one offer under the profile.
 *
 * Returns the offer fields, units and the constraint that bound them
 * (`limit`: quantity, stock, carry, storage or cash), the journey, the
 * tripEconomics result, the downside if nothing sells and if only half the
 * units sell, the buying-threshold checks, the profile-fit reason, the alert
 * (always ineligible: sample data), the opportunity tier and, unless
 * compare is false, the "What changes if I drive?" comparison.
 *
 * Reasons, first match wins: outside the area; no units fit; contribution
 * zero or below; below the hourly target; outside the buying thresholds;
 * otherwise it fits. A trip that loses money never reads as fitting.
 */
export function plan(offer, profile, { now = new Date().toISOString(), compare = true } = {}) {
  const rules = effectiveRules(profile.rules || {});
  const route = journeyFor(profile, offer.miles);
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
      returnsRate: profile.returnsRate,
      journeyCost: route.cost,
      journeyMinutes: route.minutes,
      overheadMinutes: SAMPLE_ASSUMPTIONS.overheadMinutes,
      handlingMinutes: offer.handlingMinutes,
      sellThrough,
    });
  const { units, limit, caps } = unitLimits(offer, profile, route, economicsFor);
  const economics = economicsFor(units);
  const halfSold = economicsFor(units, 0.5);
  const { alert, opportunity, thresholds } = assessSample({
    offer,
    economics,
    hourlyFloor: profile.target,
    rules,
    now,
  });
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
            : REASONS.FITS;
  const result = {
    sku: offer.sku,
    name: offer.name,
    variant: offer.variant,
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
    sample: true,
    salePrice,
    transport: profile.transport,
    carry: profile.carry,
    units,
    limit,
    caps,
    weightKg: Math.round(units * offer.weight * 100) / 100,
    journey: route,
    economics,
    downside: {
      nothingSells: economics.unsoldLoss,
      halfSellsUnits: halfSold.sold,
      halfSells: halfSold.contribution,
    },
    thresholds,
    reason,
    fits: reason === REASONS.FITS,
    alert,
    opportunity,
  };
  if (compare) result.compare = compareModes(offer, profile, result, { now });
  return result;
}

/**
 * The transport to compare with. Walkers, cyclists and public transport
 * users see the same trip by car (their cost per mile and parking, and a
 * carry limit of at least CAR_BOOT_KG). Drivers see it by public transport
 * (their fare, and a carry limit of at most HAND_CARRY_KG).
 */
export function alternativeProfile(profile) {
  if (VEHICLES.has(profile.transport)) {
    const carry = Math.min(profile.carry, HAND_CARRY_KG);
    return {
      profile: { ...profile, transport: "Public transport", carry },
      assumptions: [
        `You already travel by ${profile.transport.toLowerCase()}, so this compares the same trip by public transport.`,
        `By public transport the carry limit is the smaller of your ${profile.carry} kg and ${HAND_CARRY_KG} kg, about two full shopping bags. This is an assumption.`,
        profile.fare > 0
          ? `Public transport uses your return fare of ${gbp(profile.fare)}.`
          : "No public transport fare is set in your profile, so the journey shows as free. Enter your return fare for a fair comparison.",
        `Public transport time assumes ${TRANSPORT["Public transport"].mph} mph door to door, including waiting. No parking or tolls are charged.`,
        "Your cash, storage, unit and hourly limits stay the same.",
      ],
    };
  }
  const carry = Math.max(profile.carry, CAR_BOOT_KG);
  return {
    profile: { ...profile, transport: "Car", carry },
    assumptions: [
      `By car the journey costs your ${profile.perMile}p per mile plus ${gbp(profile.extra)} parking or tolls, both from your profile.`,
      `By car the carry limit is the larger of your ${profile.carry} kg and ${CAR_BOOT_KG} kg, a comfortable car-boot load. This is an assumption, not a measurement.`,
      `Driving time assumes ${TRANSPORT.Car.mph} mph door to door, including parking.`,
      "Your cash, storage, unit and hourly limits stay the same.",
    ],
  };
}

const COMPARED = ["units", "travelCost", "travelMinutes", "cashRequired", "contribution", "hourly"];

function modeSummary(p) {
  return {
    mode: p.transport,
    carry: p.carry,
    units: p.units,
    limit: p.limit,
    travelCost: p.economics.costs.travel,
    travelMinutes: p.units ? p.journey.minutes : 0,
    cashRequired: p.economics.cashRequired,
    contribution: p.economics.contribution,
    hourly: p.economics.hourly,
    reason: p.reason,
  };
}

/**
 * "What changes if I drive?": the same plan in the alternative mode, with
 * units, travel cost and minutes, cash required, contribution and earnings
 * per hour for both modes and the difference (alternative minus current;
 * null when either side has no earnings per hour). With no units there is no
 * trip, so travel cost and minutes are zero.
 */
export function compareModes(offer, profile, current, { now } = {}) {
  const alt = alternativeProfile(profile);
  const other = plan(offer, alt.profile, { now, compare: false });
  const a = modeSummary(current);
  const b = modeSummary(other);
  const difference = Object.fromEntries(
    COMPARED.map((k) => [
      k,
      Number.isFinite(a[k]) && Number.isFinite(b[k]) ? b[k] - a[k] : null,
    ]),
  );
  return {
    heading: "What changes if I drive?",
    current: a,
    alternative: b,
    difference,
    assumptions: alt.assumptions,
  };
}

const rankTrips = (a, b) =>
  Number(b.fits) - Number(a.fits) ||
  (b.economics.hourly ?? -Infinity) - (a.economics.hourly ?? -Infinity) ||
  b.economics.contribution - a.economics.contribution;

/** Every fixture planned and ranked: fitting trips first, then by hourly. */
export function planTrips(profile, { now = new Date().toISOString() } = {}) {
  return {
    sample: true,
    trips: offers.map((o) => plan(o, profile, { now })).sort(rankTrips),
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
 * Validates a member's threshold overrides. Unknown keys and invalid values
 * are rejected with 400; a null value means "no override". Whether a value
 * tightens or loosens is decided later by effectiveRules(), so a looser
 * value is accepted here but has no effect.
 */
export function readRules(value) {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) fail("rules must be an object of stricter thresholds");
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    const field = RULE_FIELDS[key];
    if (!field)
      fail(
        `rules.${key} is not a threshold you can set (allowed: ${Object.keys(RULE_FIELDS).join(", ")})`,
      );
    if (v === null) continue;
    out[key] = field.read(v, "rules." + key);
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
      .filter(([k, v]) => effective[k] !== v)
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
 * copy. Every field is required; transport must be one of MODES.
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
    fare: int(input.fare, "fare (pence)", 0, 100_000),
    perMile: int(input.perMile, "perMile (pence per mile)", 0, 1000),
    extra: int(input.extra, "extra (pence)", 0, 100_000),
    storage: int(input.storage, "storage (units)", 0, 100_000),
    feeRate: num(input.feeRate, "feeRate", 0, 0.5),
    feeFixed: int(input.feeFixed, "feeFixed (pence)", 0, 10_000),
    returnsRate: num(input.returnsRate, "returnsRate", 0, 0.5),
    rules: readRules(input.rules),
  };
}
