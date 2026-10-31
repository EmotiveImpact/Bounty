// Research estimate: one acquisition offer, the operator-confirmed sold
// sample, resale competition, trip economics, the opportunity tier and the
// buy-alert gate.
//
// Evidence classes stay apart throughout. The offer price is the acquisition
// cost; the sale estimate comes only from confirmed completed sales; asking
// prices are reported as competition and never change the sale price.
// Branch stock comes only from a recorded availability check: the offer's
// feed or catalogue never establishes it.
import { KIND, LICENCE } from "./contract.mjs";
import { ALERT_RULES, evaluateAlert } from "./alerts.mjs";
import { SAMPLE_ASSUMPTIONS, tripEconomics } from "./trip.mjs";
import { OPPORTUNITY_RULES, classifyOpportunity, effectiveRules } from "./opportunity.mjs";
import { displayPermitted } from "./evidence.mjs";
import { bool, fail, int, isoDate, num, text } from "./http.mjs";
import {
  compare,
  competition,
  exclusionReason,
  normaliseBarcode,
  offerFreshness,
  rowKey,
  similarTitles,
  soldSample,
  titleTokens,
} from "./matching.mjs";
import { CHECK_VALID_DAYS, stockStatus, tableExists } from "./audit.mjs";

const DAY = 86400000;
export const OPEN_PRICES = "openprices";
const MAX_PENCE = 10_000_000; // £100,000
const MAX_MINUTES = 24 * 60;

const plain = (row) => (row ? { ...row } : null);

// Registers bounty_gtin(value) on a connection so SQL can compare canonical
// barcodes. Registered once per database handle.
const registered = new WeakSet();
export function ensureFunctions(db) {
  if (registered.has(db)) return;
  db.function("bounty_gtin", { deterministic: true }, (value) => normaliseBarcode(value));
  registered.add(db);
}

/**
 * True for records the importer marked as sample or fixture data (provider,
 * licence or source id naming sample, fixture or demo). Such data is shown
 * with a Sample label and can never produce a buy alert.
 */
export function isSampleRecord(row) {
  if (!row) return false;
  const marked = /\b(sample|fixture|demo)\b/i;
  return (
    marked.test(String(row.provider ?? "")) ||
    marked.test(String(row.licence ?? "")) ||
    /^(sample|fixture|demo)\b/i.test(String(row.source_id ?? row.sourceId ?? ""))
  );
}

/** How a provider's offers were obtained and what they say about stock. */
export function sourceType(provider) {
  switch (provider) {
    case OPEN_PRICES:
      return {
        label: "Open Prices observation (ODbL)",
        stockNote:
          "A dated shopper observation of a past shelf price. It does not show current branch stock.",
      };
    case "awin":
      return {
        label: "Awin affiliate feed",
        stockNote: "Affiliate feed: branch stock not established.",
      };
    case "hobnight":
      return {
        label: "Hobnight online catalogue",
        stockNote: "Online catalogue: branch stock not established.",
      };
    default:
      return {
        label: String(provider),
        stockNote: "This source does not establish branch stock.",
      };
  }
}

// Label for an Open Prices price marked as discounted without a discount
// type. Open Prices often leaves discount_type null on discounted prices; the
// price is still conditional, so it must be treated as a promotion and the
// shopper must confirm they qualify before it can count as their cost.
export const UNSTATED_DISCOUNT = "Discounted price (type not stated)";

/**
 * Promotion text for an Open Prices observation: its discount_type when
 * stated, UNSTATED_DISCOUNT when the price is marked discounted (1) with no
 * type, otherwise null.
 */
export function observationPromotion({ discount_type, discounted }) {
  const type = discount_type === null || discount_type === undefined ? "" : String(discount_type).trim();
  if (type) return type;
  return discounted === 1 || discounted === true ? UNSTATED_DISCOUNT : null;
}

// Shapes a research Retail offer row or an Open Prices observation into one
// offer object. Open Prices: day is the observation date, store the retailer,
// place and city the location, quantity the size and discount_type the
// promotion (see observationPromotion). Licence ODbL.
function toOffer(row, now) {
  const openPrices = row.origin === "observations";
  const retailer =
    row.retailer && String(row.retailer).trim() && row.retailer !== "Retailer unknown"
      ? String(row.retailer).trim()
      : null;
  const offer = {
    origin: openPrices ? "observations" : "research",
    provider: openPrices ? OPEN_PRICES : row.provider,
    source_id: String(row.source_id),
    sourceId: String(row.source_id),
    kind: KIND.RETAIL,
    title: row.title || "Unlabelled item",
    barcode: row.barcode ?? null,
    variant: row.variant ?? null,
    size: row.size ?? null,
    pack: row.pack ?? null,
    model: row.model ?? null,
    condition: row.condition ?? null,
    price: row.price,
    regularPrice:
      Number.isSafeInteger(row.regular_price) && row.regular_price > 0 ? row.regular_price : null,
    shipping: row.shipping ?? null,
    observed: row.observed ?? null,
    imported: row.imported ?? null,
    retailer,
    location: openPrices
      ? [row.place, row.city].filter((v) => v && String(v).trim()).join(", ") || null
      : (row.location ?? null),
    availability: row.availability ?? null,
    promotion: openPrices
      ? observationPromotion({ discount_type: row.promotion, discounted: row.discounted })
      : (row.promotion ?? null),
    url: openPrices ? `https://prices.openfoodfacts.org/prices/${row.source_id}` : (row.url ?? null),
    licence: openPrices ? LICENCE.ODBL : (row.licence ?? null),
    unit: row.unit ?? null,
  };
  const type = sourceType(offer.provider);
  return {
    ...offer,
    gtin: normaliseBarcode(offer.barcode),
    ...offerFreshness(offer.observed, now),
    source: type.label,
    stockNote: type.stockNote,
    branchStockEstablished: false,
    sample: isSampleRecord(offer),
  };
}

const RESEARCH_OFFER_COLUMNS = `'research' AS origin, provider, source_id, title, barcode, variant,
 size, pack, model, condition, price, NULL AS regular_price, shipping, observed, imported, retailer,
 location, availability, promotion, url, licence, NULL AS unit, NULL AS discounted, NULL AS place,
 NULL AS city`;
const OBSERVATION_OFFER_COLUMNS = `'observations' AS origin, '${OPEN_PRICES}' AS provider,
 CAST(id AS TEXT) AS source_id, COALESCE(title, 'Unlabelled item') AS title, barcode,
 NULL AS variant, quantity AS size, NULL AS pack, NULL AS model, NULL AS condition, price,
 regular_price, NULL AS shipping, day AS observed, imported, store AS retailer, NULL AS location,
 NULL AS availability, discount_type AS promotion, NULL AS url, licence, unit, discounted, place, city`;
// Open Prices prices quoted per kilogram or litre are not per item, so they
// cannot be an acquisition cost per unit.
const PER_ITEM = "(unit IS NULL OR upper(trim(unit)) IN ('', 'UNIT', 'UNKNOWN'))";

const escapeLike = (value) => value.replace(/[\\%_]/g, (c) => "\\" + c);

/**
 * Barcoded acquisition offers, newest observation first: Retail offer rows
 * from research and per-item Open Prices observations, each with a valid
 * barcode and a positive price. q matches the title, or the canonical barcode
 * when q is itself a valid barcode. Returns { rows, total, limit, offset }.
 */
export function listOffers(db, { q = null, limit = 50, offset = 0, now = new Date().toISOString() } = {}) {
  ensureFunctions(db);
  const parts = [];
  const params = [];
  const gtin = q ? normaliseBarcode(q) : null;
  const filter = q
    ? gtin
      ? { sql: " AND bounty_gtin(barcode) = ?", value: gtin }
      : { sql: " AND lower(title) LIKE ? ESCAPE '\\'", value: "%" + escapeLike(q.toLowerCase()) + "%" }
    : null;
  if (tableExists(db, "research")) {
    parts.push(
      `SELECT ${RESEARCH_OFFER_COLUMNS} FROM research
 WHERE kind = ? AND price > 0 AND bounty_gtin(barcode) IS NOT NULL${filter ? filter.sql : ""}`,
    );
    params.push(KIND.RETAIL);
    if (filter) params.push(filter.value);
  }
  if (tableExists(db, "observations")) {
    parts.push(
      `SELECT ${OBSERVATION_OFFER_COLUMNS} FROM observations
 WHERE price > 0 AND ${PER_ITEM} AND bounty_gtin(barcode) IS NOT NULL${
   filter ? filter.sql.replace("lower(title)", "lower(COALESCE(title, ''))") : ""
 }`,
    );
    if (filter) params.push(filter.value);
  }
  if (!parts.length) return { rows: [], total: 0, limit, offset };
  const union = parts.join("\nUNION ALL\n");
  const total = db.prepare(`SELECT COUNT(*) AS n FROM (${union})`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT * FROM (${union}) ORDER BY observed DESC NULLS LAST, provider, source_id LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset)
    .map((row) => toOffer(row, now));
  return { rows, total, limit, offset };
}

/**
 * Finds the acquisition offer for (provider, sourceId). Provider "openprices"
 * reads the Open Prices observation with that price id; anything else reads
 * the research row, which must be a Retail offer. Fails with 404 for an
 * unknown offer and 400 for a record that cannot be an offer (wrong kind, no
 * valid barcode, no positive price, or an Open Prices price per kilogram).
 */
export function findOffer(db, provider, sourceId, now = new Date().toISOString()) {
  let row = null;
  if (provider === OPEN_PRICES) {
    if (!/^\d{1,15}$/.test(String(sourceId)) || !tableExists(db, "observations"))
      fail("Offer not found", 404);
    row = db
      .prepare(`SELECT ${OBSERVATION_OFFER_COLUMNS} FROM observations WHERE id = ?`)
      .get(Number(sourceId));
    if (!row) fail("Offer not found", 404);
    if (row.unit && !["", "UNIT", "UNKNOWN"].includes(String(row.unit).trim().toUpperCase()))
      fail("This Open Prices price is per " + String(row.unit).toLowerCase() + ", not per item");
  } else {
    if (!tableExists(db, "research")) fail("Offer not found", 404);
    const found = db
      .prepare(`SELECT ${RESEARCH_OFFER_COLUMNS}, kind FROM research WHERE provider = ? AND source_id = ?`)
      .get(provider, String(sourceId));
    if (!found) fail("Offer not found", 404);
    if (found.kind !== KIND.RETAIL)
      fail(`That record is ${found.kind.toLowerCase()} evidence, not a retail offer`);
    row = found;
  }
  const offer = toOffer(plain(row), now);
  if (!offer.gtin) fail("The offer has no valid barcode, so it cannot be matched to sales");
  if (!Number.isSafeInteger(offer.price) || offer.price <= 0) fail("The offer has no price");
  return offer;
}

/**
 * Candidate evidence for an offer from the research table: every row whose
 * canonical barcode equals the offer's (any kind, so other classes can be
 * shown and excluded with a reason), plus completed sales and asking prices
 * with a different or missing barcode and a similar title, which can only
 * ever be research. The offer itself is left out.
 */
export function findCandidates(db, offer) {
  if (!tableExists(db, "research") || !offer?.gtin) return [];
  const core = offer.gtin.replace(/^0+/, "");
  const digits = "ltrim(replace(replace(trim(barcode), ' ', ''), '-', ''), '0')";
  const same = db
    .prepare(
      `SELECT * FROM research WHERE barcode IS NOT NULL AND ${digits} = ?
 AND NOT (provider = ? AND source_id = ?)`,
    )
    .all(core, offer.provider, offer.source_id)
    .map(plain)
    .filter((r) => normaliseBarcode(r.barcode) === offer.gtin);
  const tokens = [...titleTokens(offer.title)].slice(0, 8);
  let similar = [];
  if (tokens.length >= 2) {
    const likes = tokens.map(() => "lower(title) LIKE ? ESCAPE '\\'").join(" OR ");
    similar = db
      .prepare(
        `SELECT * FROM research WHERE kind IN (?, ?)
 AND (barcode IS NULL OR ${digits} != ?) AND (${likes})
 ORDER BY observed DESC NULLS LAST LIMIT 2000`,
      )
      .all(KIND.SOLD, KIND.ASKING, core, ...tokens.map((t) => "%" + escapeLike(t) + "%"))
      .map(plain)
      .filter(
        (r) =>
          normaliseBarcode(r.barcode) !== offer.gtin && similarTitles(offer.title, r.title),
      );
  }
  return [...same, ...similar];
}

/**
 * Candidate sales and competition for the research view.
 * sales: completed sales with compare status and reasons, plus confirmable
 *   (true only for an exact, dated, recent sale with a realised total) and
 *   blocker (why it cannot be used, ignoring confirmation).
 * listings: active asking prices, shown as resale competition only.
 * other: retail offers and Amazon history with the same barcode (not sales).
 */
export function candidatesFor(db, { provider, sourceId, now = new Date().toISOString() }) {
  ensureFunctions(db);
  const offer = findOffer(db, provider, sourceId, now);
  const rows = findCandidates(db, offer);
  const describe = (row) => ({ row, sample: isSampleRecord(row), ...compare(offer, row) });
  const sales = rows
    .filter((r) => r.kind === KIND.SOLD)
    .map((row) => {
      const blocker = exclusionReason(offer, row, {
        now,
        checked: new Set([rowKey(row)]),
      });
      return { ...describe(row), confirmable: blocker === null, blocker };
    });
  const listings = rows.filter((r) => r.kind === KIND.ASKING).map(describe);
  const other = rows
    .filter((r) => r.kind !== KIND.SOLD && r.kind !== KIND.ASKING)
    .map(describe);
  return { offer, sales, listings, other, competition: competition(offer, rows) };
}

/**
 * Display permission for an offer: { permitted, basis }. The decision is
 * displayPermitted(db, provider, programme) from evidence.mjs, the one rule
 * the whole app uses (a programme-specific row for the offer's retailer
 * wins, then the provider-wide row, else not permitted, except that Open
 * Prices is permitted under the ODbL unless a row says otherwise). basis is
 * only a description for the interface. Without a permissions table nothing
 * is permitted.
 */
export function displayPermission(db, offer) {
  if (!tableExists(db, "permissions"))
    return { permitted: false, basis: "Display permissions are not set up, so display is not permitted" };
  const permitted = displayPermitted(db, offer.provider, offer.retailer ?? "");
  const scope = offer.provider + (offer.retailer ? " (" + offer.retailer + ")" : "");
  if (!permitted)
    return {
      permitted,
      basis: `Not permitted for ${scope}: no display permission is recorded, or it was refused. Review it in Sources`,
    };
  return {
    permitted,
    basis:
      offer.provider === OPEN_PRICES
        ? "Open Prices data is ODbL: shown with attribution unless a permission in Sources says otherwise"
        : `Permitted for ${scope} by a display permission recorded in Sources`,
  };
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sourceIdOf = (value, name) =>
  text(Number.isSafeInteger(value) ? String(value) : value, name, 200);
const optional = (value, check) =>
  value === undefined || value === null ? undefined : check(value);

// Threshold overrides a member may send, with the validator for each. Money
// is pence, weight kilograms, the return a share of the purchase price (0.5
// is 50%). These only bound what can be sent; effectiveRules then keeps an
// override only when it is stricter than OPPORTUNITY_RULES.
const RULE_INPUTS = Object.freeze({
  minUnitPrice: (v, name) => int(v, name, 0, MAX_PENCE),
  maxUnitPrice: (v, name) => int(v, name, 0, MAX_PENCE),
  maxWeightKg: (v, name) => num(v, name, 0, 1000),
  minUnitProfit: (v, name) => int(v, name, 0, MAX_PENCE),
  minReturn: (v, name) => num(v, name, 0, 10),
  trialUnits: (v, name) => int(v, name, 1, 100),
});
export const RULE_KEYS = Object.freeze(Object.keys(RULE_INPUTS));
const RULE_LABELS = Object.freeze({
  minUnitPrice: "lowest purchase price",
  maxUnitPrice: "highest purchase price",
  maxWeightKg: "unit weight limit",
  minUnitProfit: "lowest profit per unit",
  minReturn: "lowest return",
  trialUnits: "trial batch size",
});

/** Validated threshold overrides (null or missing values are left out). */
export function validateRules(rules) {
  if (rules === undefined || rules === null) return {};
  if (!isObject(rules)) fail("rules must be an object of threshold overrides");
  const out = {};
  for (const [key, value] of Object.entries(rules)) {
    if (!RULE_INPUTS[key]) fail(`rules can only set: ${RULE_KEYS.join(", ")}`);
    if (value === undefined || value === null) continue;
    out[key] = RULE_INPUTS[key](value, `rules.${key}`);
  }
  return out;
}

/**
 * The thresholds in force for a request: { rules, defaults, tightened,
 * ignored }. rules is effectiveRules(overrides). tightened lists overrides
 * that made a threshold stricter; ignored lists overrides that would have
 * loosened one and were therefore not applied (members may tighten the
 * agreed thresholds but never loosen them). An override equal to the
 * default is neither.
 */
export function thresholdsFor(overrides = {}) {
  const rules = effectiveRules(overrides);
  const tightened = [];
  const ignored = [];
  for (const key of RULE_KEYS) {
    if (overrides[key] === undefined) continue;
    if (rules[key] !== OPPORTUNITY_RULES[key]) tightened.push(key);
    else if (overrides[key] !== OPPORTUNITY_RULES[key]) ignored.push(key);
  }
  return { rules, defaults: OPPORTUNITY_RULES, tightened, ignored };
}

/**
 * Validates an estimate request and returns it normalised, with defaults
 * applied. Throws a 400 naming the first bad field. Money is integer pence,
 * time whole minutes, rates a share between 0 and 0.5.
 */
export function validateEstimateRequest(request) {
  if (!isObject(request)) fail("Send an estimate request");
  if (!isObject(request.offer)) fail("offer is required: { provider, sourceId }");
  const offer = {
    provider: text(request.offer.provider, "offer.provider", 60),
    sourceId: sourceIdOf(request.offer.sourceId, "offer.sourceId"),
  };
  const salesIn = request.sales ?? [];
  if (!Array.isArray(salesIn) || salesIn.length > 500)
    fail("sales must be a list of up to 500 { provider, sourceId }");
  const sales = salesIn.map((s, i) => {
    if (!isObject(s)) fail(`sales[${i}] must be { provider, sourceId }`);
    return {
      provider: text(s.provider, `sales[${i}].provider`, 60),
      sourceId: sourceIdOf(s.sourceId, `sales[${i}].sourceId`),
    };
  });
  const units = request.units === undefined ? 1 : int(request.units, "units", 1, 100);
  const c = request.costs ?? {};
  if (!isObject(c)) fail("costs must be an object");
  const pence = (key) => optional(c[key], (v) => int(v, `costs.${key}`, 0, MAX_PENCE));
  const minutes = (key) => optional(c[key], (v) => int(v, `costs.${key}`, 0, MAX_MINUTES));
  const rate = (key) => optional(c[key], (v) => num(v, `costs.${key}`, 0, 0.5));
  const given = {
    postage: pence("postage"),
    packaging: pence("packaging"),
    feeRate: rate("feeRate"),
    feeFixed: pence("feeFixed"),
    returnsRate: rate("returnsRate"),
    journeyCost: pence("journeyCost"),
    journeyMinutes: minutes("journeyMinutes"),
    overheadMinutes: minutes("overheadMinutes"),
    handlingMinutes: minutes("handlingMinutes"),
  };
  const defaults = {
    postage: 0,
    packaging: 0,
    feeRate: SAMPLE_ASSUMPTIONS.feeRate,
    feeFixed: SAMPLE_ASSUMPTIONS.feeFixed,
    returnsRate: SAMPLE_ASSUMPTIONS.returnsRate,
    journeyCost: 0,
    journeyMinutes: 0,
    overheadMinutes: SAMPLE_ASSUMPTIONS.overheadMinutes,
    handlingMinutes: 0,
  };
  const costs = {};
  const defaulted = [];
  for (const key of Object.keys(defaults)) {
    costs[key] = given[key] ?? defaults[key];
    if (given[key] === undefined) defaulted.push(key);
  }
  const now = optional(request.now, (v) =>
    typeof v === "string" && Number.isFinite(Date.parse(v))
      ? new Date(Date.parse(v)).toISOString()
      : fail("now must be a date and time"),
  );
  // Weight of one unit in kilograms. Unknown weight is allowed in the
  // request but rejects the opportunity (it fails the weight filter closed).
  const weightKg =
    optional(request.weightKg, (v) =>
      typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1000
        ? v
        : fail("weightKg must be a number of kilograms above 0 and up to 1000"),
    ) ?? null;
  return {
    offer,
    sales,
    units,
    costs,
    defaulted,
    weightKg,
    rules: validateRules(request.rules),
    hourlyFloor: optional(request.hourlyFloor, (v) => int(v, "hourlyFloor", 0, 100000)) ?? null,
    localStockConfirmed:
      optional(request.localStockConfirmed, (v) => bool(v, "localStockConfirmed")) ?? false,
    promotionEligible:
      optional(request.promotionEligible, (v) => bool(v, "promotionEligible")) ?? false,
    cashNeededDays:
      optional(request.cashNeededDays, (v) => int(v, "cashNeededDays", 0, 3650)) ?? null,
    cashNeededBy: isoDate(request.cashNeededBy, "cashNeededBy", { optional: true }),
    locality: text(request.locality, "locality", 120, { optional: true }),
    now: now ?? null,
  };
}

// Whole days from now until the start of a calendar date; negative once the
// date has begun. Rounds down so the cash date is never stretched.
const daysUntil = (date, now) =>
  Math.floor((Date.parse(date + "T00:00:00Z") - Date.parse(now)) / DAY);

/**
 * Approximate sales per week of the exact variant: the confirmed sample
 * count spread evenly over the sale window (maxSaleAgeDays / 7 weeks). Null
 * when there are no confirmed sales.
 *
 * This leans cautious. The sample holds only sales the operator researched
 * and confirmed, so it is a floor on real demand, and spreading them over
 * the whole window ignores any recent burst. Both understate the rate, which
 * overstates weeks of supply (competition looks higher, never lower).
 */
export function salesPerWeek(count, maxSaleAgeDays = ALERT_RULES.maxSaleAgeDays) {
  const weeks = maxSaleAgeDays / 7;
  if (!Number.isFinite(count) || count <= 0 || !(weeks > 0)) return null;
  return count / weeks;
}

/**
 * Resale weeks of supply: active asking-price listings with the offer's
 * barcode divided by salesPerWeek, to two decimals. Null when the sales rate
 * is unknown (no confirmed sales). Also null when no active listing is
 * recorded: an empty list can mean nobody looked, so it never counts as low
 * competition. Listings of any variant with the same barcode count, which
 * again errs towards more competition.
 */
export function resaleWeeksOfSupply(activeListings, rate) {
  if (!Number.isFinite(rate) || rate <= 0) return null;
  if (!Number.isSafeInteger(activeListings) || activeListings <= 0) return null;
  return Math.round((activeListings / rate) * 100) / 100;
}

/**
 * estimateFromEvidence(db, request, options?) per docs/ARCHITECTURE.md.
 *
 * options.now overrides request.now; the HTTP route passes the server clock
 * so a client cannot make an expired offer look fresh.
 *
 * Request additions beyond the architecture contract:
 *  weightKg  weight of one unit in kilograms; null or missing means unknown,
 *            which rejects the opportunity ("Unit weight unknown").
 *  rules     the member's own threshold overrides (RULE_KEYS). They pass
 *            through effectiveRules, so they can only tighten.
 *
 * Returns { offer, sample, competition, match, economics, opportunity,
 * alert } plus thresholds, stock (the availability check used), permission,
 * unitCost, cashNeededDays, inputs, assumptions and warnings. economics is
 * null unless at least one confirmed exact sale qualifies.
 *
 * opportunity is classifyOpportunity(...) from opportunity.mjs (tier,
 * reasons, unitProfit, returnOnCost, targetPrice, meetsThresholds,
 * trialUnits) with the measures it was given: salesPerWeek,
 * resaleWeeksOfSupply, sourcingPressure (always null here: nobody is
 * heading to the shelf at research time, so it is unknown and the best tier
 * an estimate can reach is Priority 2) and provenItem.
 *
 * The alert always comes from evaluateAlert, run twice: a screening pass
 * supplies the evidence and stock checks that classifyOpportunity reads,
 * then the final pass adds meetsThresholds from the classification, units
 * and the trial batch size from the effective rules. provenItem is false
 * because there is no link to verified ledger trades yet, so every item is
 * held to a trial batch.
 */
export function estimateFromEvidence(db, request, options = {}) {
  const input = validateEstimateRequest(request);
  const now = options.now ?? input.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) fail("now must be a date and time");
  ensureFunctions(db);
  const offer = findOffer(db, input.offer.provider, input.offer.sourceId, now);
  const rows = findCandidates(db, offer);
  const confirmed = new Set(input.sales.map((s) => `${s.provider}|${s.sourceId}`));
  const sample = soldSample(offer, rows, { now, confirmed });
  const resale = competition(offer, rows);
  const warnings = [];
  const assumptions = [];

  // A promotion or loyalty price the shopper has not confirmed they qualify
  // for is not their cost: use the regular price when the source gives one.
  let unitCost = offer.price;
  if (offer.promotion && !input.promotionEligible) {
    if (offer.regularPrice && offer.regularPrice > offer.price) {
      unitCost = offer.regularPrice;
      assumptions.push(
        "Promotion eligibility not confirmed, so stock is costed at the regular price",
      );
    } else {
      warnings.push(
        "This is a promotion or loyalty price and eligibility is not confirmed: you may pay more",
      );
    }
  }

  const economics =
    sample.count > 0
      ? tripEconomics({
          units: input.units,
          unitCost,
          salePrice: sample.lowerMedian,
          ...input.costs,
        })
      : null;

  const soldCandidates = rows.filter((r) => r.kind === KIND.SOLD);
  const match =
    sample.count > 0
      ? "exact"
      : soldCandidates.some((r) => compare(offer, r).status !== "none")
        ? "research"
        : "none";

  const stock = stockStatus(db, {
    barcode: offer.gtin,
    retailer: offer.retailer,
    locality: input.locality,
    now,
  });
  const permission = displayPermission(db, offer);
  const sampleData = offer.sample || sample.used.some(isSampleRecord);
  const cashNeededDays = input.cashNeededBy
    ? daysUntil(input.cashNeededBy, now)
    : input.cashNeededDays;

  const alertInput = {
    evidenceClass: sampleData ? "sample" : "live",
    match,
    contribution: economics ? economics.contribution : null,
    hourly: economics ? economics.hourly : null,
    hourlyFloor: input.hourlyFloor,
    offerObserved: offer.observed,
    now,
    localStockConfirmed: stock.confirmed,
    availability: stock.availability,
    promotion: offer.promotion,
    promotionEligible: input.promotionEligible,
    shippingKnown: input.costs.postage > 0,
    recentIndependentSales: sample.independent,
    daysToSell: sample.daysToSell,
    cashNeededDays,
    displayPermitted: permission.permitted,
  };
  // Screening pass: classifyOpportunity reads only its evidence and stock
  // checks. Its buying-thresholds and trial-batch results are discarded.
  const screening = evaluateAlert(alertInput);
  const thresholds = thresholdsFor(input.rules);
  const rate = salesPerWeek(sample.count);
  const weeksOfSupply = resaleWeeksOfSupply(resale.activeListings, rate);
  // The purchase price per unit is the price the stock is costed at: the
  // offer price, or the regular price when a promotion's eligibility is not
  // confirmed. The same figure is the base of the return on purchase price.
  const classification = classifyOpportunity(
    {
      unitPrice: unitCost,
      weightKg: input.weightKg,
      economics,
      alert: screening,
      independentSales: sample.independent,
      daysToSell: sample.daysToSell,
      resaleWeeksOfSupply: weeksOfSupply,
      sourcingPressure: null,
    },
    thresholds.rules,
  );
  const opportunity = {
    ...classification,
    unitPrice: unitCost,
    weightKg: input.weightKg,
    salesPerWeek: rate === null ? null : Math.round(rate * 100) / 100,
    resaleWeeksOfSupply: weeksOfSupply,
    sourcingPressure: null,
    provenItem: false,
  };
  const alert = evaluateAlert({
    ...alertInput,
    meetsThresholds: classification.meetsThresholds,
    units: input.units,
    trialUnits: thresholds.rules.trialUnits,
    provenItem: false,
  });

  if (sampleData) warnings.push("Sample data: illustrative only and never a buy alert");
  if (input.weightKg === null)
    warnings.push("Unit weight not entered: an item of unknown weight is rejected by the buying thresholds");
  if (thresholds.ignored.length)
    warnings.push(
      "Not applied because looser than the agreed thresholds, which you can tighten but never loosen: " +
        thresholds.ignored.map((k) => RULE_LABELS[k]).join(", "),
    );
  if (input.units > thresholds.rules.trialUnits)
    warnings.push(
      `A first purchase is a trial batch of at most ${thresholds.rules.trialUnits} units until a verified trade (purchase receipt and payout record) exists for the item`,
    );
  if (offer.expired)
    warnings.push(
      offer.freshness === "unknown"
        ? "The offer has no observation date"
        : `The offer price was observed ${offer.ageDays} days ago and has expired`,
    );
  if (!stock.confirmed)
    warnings.push(
      input.localStockConfirmed
        ? `Branch stock is not confirmed: record an availability check from the last ${CHECK_VALID_DAYS} days`
        : `No availability check in the last ${CHECK_VALID_DAYS} days found stock at this retailer`,
    );
  if (input.costs.postage <= 0)
    warnings.push("No parcel cost entered: contribution leaves out postage");
  if (input.costs.handlingMinutes <= 0)
    warnings.push("No handling time entered: earnings per hour leave out listing, packing and dispatch");
  if (economics && sample.count < ALERT_RULES.minIndependentSales)
    warnings.push(
      `Only ${sample.count} confirmed sale${sample.count === 1 ? "" : "s"}: the sale estimate is weak`,
    );
  if (economics && input.units > sample.count)
    warnings.push(
      `You plan ${input.units} units but there are ${sample.count} confirmed recent sales: they may not all sell`,
    );
  if (economics)
    assumptions.push(
      "Every unit sells at the lower median confirmed sale; the loss if nothing sells is shown separately",
    );
  if (input.defaulted.some((k) => ["feeRate", "feeFixed", "returnsRate", "overheadMinutes"].includes(k)))
    assumptions.push("Sample fee, returns and in-store time assumptions fill the values you left out");
  assumptions.push(
    `Branch stock comes only from an availability check recorded in the last ${CHECK_VALID_DAYS} days, never from a feed or catalogue`,
    "Profit per unit is the contribution divided by units, so it already carries fees, postage, packaging, the returns allowance and the unit's share of travel",
    "Sourcing pressure is unknown at research time, so a research estimate can reach Priority 2 at best",
    `Resale competition uses the confirmed sales spread over ${ALERT_RULES.maxSaleAgeDays} days as the sales rate, which understates demand and so overstates competition`,
    "No verified trade is linked from the ledger yet, so every item is treated as unproven and held to the trial batch",
  );

  const { now: _now, ...inputs } = input;
  return {
    offer,
    sample,
    competition: resale,
    match,
    economics,
    opportunity,
    alert,
    thresholds,
    stock,
    permission,
    unitCost,
    cashNeededDays,
    inputs,
    assumptions,
    warnings,
  };
}
