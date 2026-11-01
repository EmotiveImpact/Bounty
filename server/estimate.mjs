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
import { ALERT_RULES, ageDays, evaluateAlert } from "./alerts.mjs";
import { SAMPLE_ASSUMPTIONS, tripEconomics } from "./trip.mjs";
import {
  CATEGORY_IDS,
  CATEGORY_RULES,
  OPPORTUNITY_RULES,
  categoryChecks,
  categoryReturnsRate,
  categoryRule,
  classifyOpportunity,
  daysToSellAll,
  demandUnits,
  effectiveRules,
} from "./opportunity.mjs";
import { cachedLookup, displayPermitted } from "./evidence.mjs";
import { accessNeeds, defaults as profileDefaults, gbp } from "./catalog.mjs";
import { bool, fail, int, isoDate, londonDate, num, oneOf, text } from "./http.mjs";
import {
  CONDITION_VOCABULARY,
  compare,
  competition,
  exclusionReason,
  isRetailOffer,
  normaliseBarcode,
  normaliseCondition,
  normaliseModel,
  normalisePack,
  normaliseSize,
  offerFreshness,
  rowKey,
  similarTitles,
  soldSample,
  titleTokens,
} from "./matching.mjs";
import {
  CHECK_VALID_DAYS,
  branchIdentity,
  sameBranch,
  shelfChecks,
  shopIsBranch,
  stockStatus,
  tableExists,
} from "./audit.mjs";
import { DEFAULT_GOALS, addDays, getGoals, payoutDate } from "./goals.mjs";

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
 * licence or source id naming sample, fixture or demo), and for records from
 * a retailer or merchant named "Example ...", the made-up shops in the
 * repository's own sample feeds, wherever the file was imported from. Such
 * data is shown with a Sample label and can never produce a buy alert.
 */
export function isSampleRecord(row) {
  if (!row) return false;
  const marked = /\b(sample|fixture|demo)\b/i;
  const example = /^\s*example\b/i;
  return (
    marked.test(String(row.provider ?? "")) ||
    marked.test(String(row.licence ?? "")) ||
    /^(sample|fixture|demo)\b/i.test(String(row.source_id ?? row.sourceId ?? "")) ||
    example.test(String(row.retailer ?? "")) ||
    example.test(String(row.merchant ?? row.merchant_name ?? ""))
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

// Title words that clearly name clothing or food. Only a clear word suggests
// a category; anything else is general, and the person can change it in the
// estimate. Words that are often something else ("top", "polo") are left out.
const CLOTHING_WORDS =
  /\b(jumpers?|sweaters?|cardigans?|hoodies?|sweatshirts?|t-?shirts?|shirts?|blouses?|dress(es)?|skirts?|jeans|trousers|shorts|leggings|joggers|jackets?|coats?|gilets?|fleeces?|socks|pyjamas|underwear|bras?|boxers|knickers|swimsuits?|bikinis?|onesies?|babygrows?|dungarees|tights)\b/;
const FOOD_WORDS =
  /\b(honey|chocolates?|biscuits?|cookies?|crisps|sweets|flapjacks?|cereals?|granola|muesli|porridge|oats|coffee|teabags?|tea|jam|marmalade|syrup|sauces?|ketchup|mayonnaise|pasta|noodles|rice|nuts|peanuts|almonds|raisins|cakes?|snacks?|crackers|spreads?|peanut butter|olive oil|vinegar|spices?|gravy|stock cubes|soups?|beans|tinned|canned|juice|cordial|squash|protein bars?|cereal bars?|sugar|flour)\b/;

// A quantity by weight or volume (340 g, 1.5kg, 500 ml, 2 l). It suggests
// food only from a food catalogue (suggestCategory): kettles, flasks and
// toiletries state volumes too. "4G" and "5G" (mobile networks) are not
// weights.
const FOOD_QUANTITY = /(?<![\w.])(\d+(?:[.,]\d+)?)\s?(kg|g|ml|cl|l)(?![a-z0-9])/i;
const NETWORK = /^[2-6]G$/;
const foodQuantity = (value) => {
  const found = String(value ?? "").match(FOOD_QUANTITY);
  return found && !NETWORK.test(found[0]) ? found[0] : null;
};

// Sources that catalogue groceries, where a weight or volume usually means
// food: Hobnight is a supermarket catalogue. (Open Prices is food whatever
// the size, below.)
const FOOD_CATALOGUES = Object.freeze({ hobnight: "Hobnight" });
export const QUANTITY_HINT = "The size gives a quantity: choose Food if this is food";

/**
 * The category an offer suggests: { id, basis, hint? }. Clothing when a
 * title word clearly names clothing. Food when a title word names food, when
 * the offer is an Open Prices observation (Open Prices comes from Open Food
 * Facts, a food database), or when a food catalogue source (Hobnight) gives
 * a quantity (g, kg, ml, cl, l) in the size or title. A quantity alone from
 * any other source is not a food signal (a 1.7 l kettle, a 500 ml flask, a
 * 250 ml shampoo): it suggests General with hint QUANTITY_HINT. Otherwise
 * general. The estimate keeps the suggested category's rules unless the
 * request names another category and, when that drops any of the suggested
 * rules, gives a reason (categoryDecision). Choosing Food for a General
 * suggestion is stricter, so it needs no reason.
 */
export function suggestCategory(offer) {
  const title = String(offer?.title ?? "").toLowerCase();
  const clothing = title.match(CLOTHING_WORDS);
  if (clothing) return { id: "clothing", basis: `The title mentions "${clothing[0]}"` };
  const food = title.match(FOOD_WORDS);
  if (food) return { id: "food", basis: `The title mentions "${food[0]}"` };
  if (offer?.provider === OPEN_PRICES || offer?.origin === "observations")
    return { id: "food", basis: "Open Prices records come from Open Food Facts, a food database" };
  const sized = foodQuantity(offer?.size);
  const titled = foodQuantity(offer?.title);
  const provider = String(offer?.provider ?? "").toLowerCase();
  const name = Object.hasOwn(FOOD_CATALOGUES, provider) ? FOOD_CATALOGUES[provider] : null;
  if (name && (sized || titled)) {
    return {
      id: "food",
      basis: sized
        ? `${name} is a supermarket catalogue and the size "${String(offer.size).trim()}" is a food quantity`
        : `${name} is a supermarket catalogue and the title gives a food quantity ("${titled}")`,
    };
  }
  const general = { id: "general", basis: "The title does not clearly name clothing or food" };
  return sized || titled ? { ...general, hint: QUANTITY_HINT } : general;
}

// What each category's rules check, in plain words, so a downgrade can name
// what it drops.
function ruleChecks(id) {
  const rule = CATEGORY_RULES[id] ?? CATEGORY_RULES.general;
  const out = [];
  if (rule.minReturnsRate)
    out.push(`the ${Math.round(rule.minReturnsRate * 1000) / 10}% returns allowance`);
  if (rule.needsSize) out.push("the size check");
  if (rule.needsPackaging) out.push("the sealed packaging check");
  if (rule.minShelfLifeDays) out.push(`the ${rule.minShelfLifeDays}-day best-before check`);
  return out;
}
const andList = (items) =>
  items.length <= 1 ? items.join("") : items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Which category's rules apply. requested is the request's category (null
 * when none was named); reason the request's categoryReason.
 *
 * A category that drops any rule of the suggested one (General for an item
 * the title or source suggests is clothing or food, or one of those for the
 * other) is looser. A looser choice applies only with a reason; without one
 * the suggested rules stay. Either way the warning names what was dropped.
 *
 * Returns { chosen, suggested, applied, reason, warning, dropped, basis }:
 * chosen the requested id or null, suggested the suggested id, applied the
 * id whose rules are used, reason the trimmed text or null, warning the text
 * or null, dropped the plain-word checks a looser choice removes.
 */
export function categoryDecision(suggestion, requested = null, reason = null) {
  const suggested = suggestion?.id && CATEGORY_RULES[suggestion.id] ? suggestion.id : "general";
  const basis = suggestion?.basis ?? "The source suggests it";
  const given = typeof reason === "string" && reason.trim() ? reason.trim() : null;
  const target = requested ?? suggested;
  const keep = new Set(ruleChecks(target));
  const dropped = target === suggested ? [] : ruleChecks(suggested).filter((c) => !keep.has(c));
  const name = (id) => (CATEGORY_RULES[id] ?? CATEGORY_RULES.general).name;
  if (!dropped.length)
    return { chosen: requested, suggested, applied: target, reason: given, warning: null, dropped, basis };
  if (!given)
    return {
      chosen: requested,
      suggested,
      applied: suggested,
      reason: null,
      warning: `${basis}, which suggests ${name(suggested).toLowerCase()}. You chose ${name(target)}, which would drop ${andList(dropped)}, so the ${name(suggested).toLowerCase()} rules still apply. Give a reason to cost it as ${name(target)}`,
      dropped,
      basis,
    };
  return {
    chosen: requested,
    suggested,
    applied: target,
    reason: given,
    warning: `Costed as ${name(target)} although ${lowerFirst(basis)}, which suggests ${name(suggested).toLowerCase()}: ${andList(dropped)} ${dropped.length === 1 ? "is" : "are"} dropped. Your reason: ${given}`,
    dropped,
    basis,
  };
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
    // Prices the retailer claims in a feed (Awin product_price_old and
    // rrp_price). Shown as claims only: nobody pays them now, so they are
    // never the regular price the stock is costed at.
    wasPrice: Number.isSafeInteger(row.was_price) && row.was_price > 0 ? row.was_price : null,
    rrpPrice: Number.isSafeInteger(row.rrp_price) && row.rrp_price > 0 ? row.rrp_price : null,
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
    suggestedCategory: suggestCategory(offer),
  };
}

// ---------------------------------------------------------------------------
// Offer attributes the operator confirms after looking at the item.
//
// Imported offers often leave pack or model blank (Awin has no pack column,
// Open Prices has neither), and compare() needs both sides stated, so an
// imported offer could never reach an exact match. The person can confirm a
// blank attribute after looking at the shelf, packaging or product page. A
// confirmation only fills a blank: it never replaces what the source stored.

export const OFFER_ATTRIBUTE_KEYS = Object.freeze(["size", "pack", "model", "condition"]);
const ATTRIBUTE_NORMALISERS = Object.freeze({
  size: normaliseSize,
  pack: normalisePack,
  model: normaliseModel,
  condition: normaliseCondition,
});
const ATTRIBUTE_HINTS = Object.freeze({
  size: "a size such as M, 10 or 28cm",
  pack: "a pack count such as 1, single or 3-pack",
  model: "a model or part number",
  condition: "one of " + CONDITION_VOCABULARY.join(", "),
});
const ATTRIBUTE_NAMES = Object.freeze({ size: "Size", pack: "Pack", model: "Model", condition: "Condition" });
const stated = (value) =>
  value !== null && value !== undefined && String(value).trim() !== "";

/**
 * Validated operator-confirmed attributes { size?, pack?, model?, condition? }
 * as trimmed text. Each value must be recognised by the matching module's
 * normaliser, so a confirmation can never be something compare() ignores.
 * Empty or null values are left out.
 */
export function validateOfferAttributes(value, name = "offerAttributes") {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) fail(`${name} must be an object of { size, pack, model, condition }`);
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!Object.hasOwn(ATTRIBUTE_NORMALISERS, key))
      fail(`${name} can only set: ${OFFER_ATTRIBUTE_KEYS.join(", ")}`);
    if (raw === undefined || raw === null || raw === "") continue;
    if (!(typeof raw === "string" || (key === "pack" && Number.isSafeInteger(raw))))
      fail(`${name}.${key} must be text`);
    const entered = String(raw).trim();
    if (!entered) continue;
    if (entered.length > 100) fail(`${name}.${key} must be up to 100 characters`);
    if (ATTRIBUTE_NORMALISERS[key](entered) === null)
      fail(`${name}.${key} "${entered}" is not recognised: enter ${ATTRIBUTE_HINTS[key]}`);
    out[key] = entered;
  }
  return out;
}

/**
 * Applies operator-confirmed attributes to an offer. Only attributes the
 * source left blank are filled; a confirmation that disagrees with a stored
 * value is ignored and reported. Returns { offer, applied, ignored } where
 * offer gains attributeSource ({ size, pack, model, condition } each
 * "source", "operator", "assumed" (a retail offer's unstated condition is
 * taken as new) or null) and operatorConfirmed (the keys filled).
 */
export function applyOfferAttributes(offer, confirmed = {}) {
  const next = { ...offer };
  const applied = {};
  const ignored = [];
  const attributeSource = {};
  for (const key of OFFER_ATTRIBUTE_KEYS) {
    const has = stated(offer[key]);
    attributeSource[key] = has ? "source" : null;
    if (!Object.hasOwn(confirmed, key)) continue;
    if (has) {
      const normalise = ATTRIBUTE_NORMALISERS[key];
      if (normalise(offer[key]) !== normalise(confirmed[key]))
        ignored.push({
          key,
          value: confirmed[key],
          stored: offer[key],
          reason: `${ATTRIBUTE_NAMES[key]} you confirmed (${confirmed[key]}) differs from the source (${offer[key]}): the source value is kept`,
        });
      continue;
    }
    next[key] = confirmed[key];
    applied[key] = confirmed[key];
    attributeSource[key] = "operator";
  }
  if (attributeSource.condition === null && isRetailOffer(offer)) attributeSource.condition = "assumed";
  return {
    offer: { ...next, attributeSource, operatorConfirmed: Object.keys(applied) },
    applied,
    ignored,
  };
}

const RESEARCH_OFFER_COLUMNS = `'research' AS origin, provider, source_id, title, barcode, variant,
 size, pack, model, condition, price, NULL AS regular_price, shipping, observed, imported, retailer,
 location, availability, promotion, url, licence, NULL AS unit, NULL AS discounted, NULL AS place,
 NULL AS city, was_price, rrp_price`;
const OBSERVATION_OFFER_COLUMNS = `'observations' AS origin, '${OPEN_PRICES}' AS provider,
 CAST(id AS TEXT) AS source_id, COALESCE(title, 'Unlabelled item') AS title, barcode,
 NULL AS variant, quantity AS size, NULL AS pack, NULL AS model, NULL AS condition, price,
 regular_price, NULL AS shipping, day AS observed, imported, store AS retailer, NULL AS location,
 NULL AS availability, discount_type AS promotion, NULL AS url, licence, unit, discounted, place, city,
 NULL AS was_price, NULL AS rrp_price`;
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

// Shop names and places compare without case or extra spaces.
const shopText = (value) =>
  value === null || value === undefined ? "" : String(value).trim().replace(/\s+/g, " ").toLowerCase();
// Open Prices order: the later day first, then the higher price id on the
// same day (Open Prices numbers prices as they are added). No day is oldest.
const observationOrder = (a, b) =>
  String(a.day ?? "").localeCompare(String(b.day ?? "")) || Number(a.id) - Number(b.id);

/**
 * The current shelf price at the shop of an Open Prices observation: the
 * newest per-item observation of the same barcode at the same shop dated at
 * or after it (R3M3). The same shop is the same OpenStreetMap id, or the
 * same retailer (store) and place, both stated (compared without case).
 * Newest is the latest day, then the highest price id on that day.
 * Observations dated after today in London, priced per kilogram or litre or
 * without a positive price are left out.
 *
 * sourceId is the Open Prices price id (text or number). Returns null when
 * it is not a per-item Open Prices observation with a valid barcode, else
 * { sourceId, price, regularPrice, promotion, observed, newer, chosen, offer }:
 * price, regularPrice (or null), promotion (observationPromotion) and
 * observed (YYYY-MM-DD) of the newest observation, newer true when that is
 * a later observation than sourceId, chosen { sourceId, price, observed } of
 * sourceId itself, and offer the newest observation as findOffer shapes it.
 * With nothing newer, the result describes sourceId itself (newer false).
 *
 * The bounty checks call this to read the current same-shop price; the
 * estimate costs at it (estimateFromEvidence, candidatesFor).
 */
export function currentShopPrice(db, sourceId, { now = new Date().toISOString() } = {}) {
  if (!/^\d{1,15}$/.test(String(sourceId ?? "")) || !tableExists(db, "observations")) return null;
  ensureFunctions(db);
  const columns = `${OBSERVATION_OFFER_COLUMNS}, id, osm_id, store, place, day`;
  const chosen = plain(db.prepare(`SELECT ${columns} FROM observations WHERE id = ? AND ${PER_ITEM}`).get(Number(sourceId)));
  const gtin = chosen ? normaliseBarcode(chosen.barcode) : null;
  if (!chosen || !gtin || !(Number.isSafeInteger(chosen.price) && chosen.price > 0)) return null;
  const osm = shopText(chosen.osm_id);
  const store = shopText(chosen.store);
  const place = shopText(chosen.place);
  const today = Number.isFinite(Date.parse(now)) ? londonDate(now) : null;
  const sameShop = (r) =>
    (osm !== "" && shopText(r.osm_id) === osm) ||
    (store !== "" && place !== "" && shopText(r.store) === store && shopText(r.place) === place);
  const core = gtin.replace(/^0+/, "");
  const digits = "ltrim(replace(replace(trim(barcode), ' ', ''), '-', ''), '0')";
  const later = db
    .prepare(
      `SELECT ${columns} FROM observations
 WHERE barcode IS NOT NULL AND ${digits} = ? AND price > 0 AND ${PER_ITEM} AND id != ?
 ORDER BY day DESC NULLS LAST, id DESC LIMIT 500`,
    )
    .all(core, chosen.id)
    .map(plain)
    .filter(
      (r) =>
        normaliseBarcode(r.barcode) === gtin &&
        Number.isSafeInteger(r.price) &&
        sameShop(r) &&
        observationOrder(r, chosen) > 0 &&
        (r.day === null || today === null || String(r.day) <= today),
    );
  const newest = later.reduce((best, r) => (observationOrder(r, best) > 0 ? r : best), chosen);
  const offer = toOffer(newest, now);
  return {
    sourceId: String(newest.id),
    price: newest.price,
    regularPrice: offer.regularPrice,
    promotion: offer.promotion,
    observed: newest.day ?? null,
    newer: newest.id !== chosen.id,
    chosen: { sourceId: String(chosen.id), price: chosen.price, observed: chosen.day ?? null },
    offer,
  };
}

/**
 * The offer the figures use for (provider, sourceId): findOffer's, except
 * that an Open Prices observation with a newer one at the same shop is
 * replaced by the newest (currentShopPrice), so the trip is costed at the
 * current shelf price, never at an older and possibly lower one. Returns
 * { offer, shopPrice } where shopPrice is null, or { chosen, used, change }
 * when the newer observation is used: chosen and used are { sourceId,
 * price, observed } and change is "rose", "fell" or "same". options.pin
 * true keeps the chosen observation (for a record judged as it stood, such
 * as an audited item).
 */
export function currentOffer(db, provider, sourceId, now = new Date().toISOString(), { pin = false } = {}) {
  const chosen = findOffer(db, provider, sourceId, now);
  if (pin || chosen.provider !== OPEN_PRICES) return { offer: chosen, shopPrice: null };
  const current = currentShopPrice(db, chosen.sourceId, { now });
  if (!current?.newer) return { offer: chosen, shopPrice: null };
  const used = { sourceId: current.sourceId, price: current.price, observed: current.observed };
  const change = used.price > current.chosen.price ? "rose" : used.price < current.chosen.price ? "fell" : "same";
  return {
    offer: { ...current.offer, chosenOffer: current.chosen },
    shopPrice: { chosen: current.chosen, used, change },
  };
}

// ---------------------------------------------------------------------------
// The price at the branch (round 5, finding 1). Stock is confirmed by a check
// at a branch, so the price the trip is costed at must be shown to apply at
// that branch too: a price seen at a shop in Preston says nothing about the
// shelf in Camden, and an online feed or catalogue price says nothing about
// any shelf.

// How far back a shelf price on an earlier branch check is looked for, only
// to say that one exists but is too old (the price itself must be from the
// last ALERT_RULES.maxOfferAgeDays days).
const SHELF_PRICE_LOOKBACK_DAYS = 90;
const ONLINE_PRICES = Object.freeze({
  awin: "the Awin affiliate feed",
  hobnight: "the Hobnight online catalogue",
  keepa: "Keepa's Amazon price history",
});

// Where an offer's price was seen, in words, with the Open Prices shop
// ({ osm_id, store, place, city }) when it is one.
function priceSeen(db, offer) {
  const online = Object.hasOwn(ONLINE_PRICES, offer.provider) ? ONLINE_PRICES[offer.provider] : null;
  let shop = null;
  if (offer.provider === OPEN_PRICES && tableExists(db, "observations") && /^\d{1,15}$/.test(String(offer.sourceId)))
    shop = plain(
      db.prepare("SELECT osm_id, store, place, city FROM observations WHERE id = ?").get(Number(offer.sourceId)),
    );
  const parts = shop
    ? [shop.store, shop.place, shop.city]
    : [offer.retailer, offer.location];
  const where = [...new Set(parts.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim()))].join(", ");
  return { price: offer.price, observed: offer.observed ?? null, online, shop, where: where || offer.source };
}

/**
 * Whether the acquisition price applies at the branch the stock evidence
 * covers. stock is stockStatus's result for the trip's locality; its check
 * (the latest in the locality from the last CHECK_VALID_DAYS days, whatever
 * it found) is the branch. The price applies there when:
 *
 *  - "check": that check recorded the shelf price, or an earlier check at
 *    the same retailer in the same locality from the last
 *    ALERT_RULES.maxOfferAgeDays days did and is at the same branch (the
 *    stock check names no branch, or both name the same one: sameBranch).
 *    The trip is costed at that shelf price and its check time is the
 *    price's date. A newer check without a price changes nothing about it.
 *  - "same-shop": the offer is an Open Prices observation from the shop the
 *    check names (the same OpenStreetMap id, or the same retailer and
 *    postcode: shopIsBranch). When the stock check names no branch, an
 *    earlier check in the locality from the last maxOfferAgeDays days that
 *    names the shop counts. A town or borough name never matches.
 *
 * When both apply the newer price is used (the later UK day; on the same
 * day the higher price). An online feed or catalogue price (Awin, Hobnight,
 * Keepa) never applies to a branch by itself, and anything else fails
 * closed with a reason that names where the price was seen and where stock
 * was checked.
 *
 * Returns { confirmed, basis: "check" | "same-shop" | null, price, at,
 * check, stockCheck, seen: { price, observed, where, online }, reason }:
 * price and at are the price that applies and when it was seen; check is
 * the priced check used ({ id, checkedAt, branch, locality, price }) or
 * null; stockCheck the check that covers the branch ({ id, checkedAt,
 * branch, locality }) or null; reason null when confirmed.
 */
export function priceAtBranch(db, { offer, stock, now = new Date().toISOString() }) {
  const seen = priceSeen(db, offer);
  const check = stock?.check ?? null;
  const place = stock?.locality ?? null;
  const priceText = seen.online
    ? `The ${gbp(seen.price)} price is an online price from ${seen.online}`
    : `The ${gbp(seen.price)} price was seen at ${seen.where}`;
  const base = {
    confirmed: false,
    basis: null,
    price: null,
    at: null,
    check: null,
    stockCheck: check
      ? { id: check.id, checkedAt: check.checked_at, branch: check.branch ?? null, locality: check.locality }
      : null,
    seen: { price: seen.price, observed: seen.observed, where: seen.where, online: seen.online !== null },
  };
  if (!check)
    return {
      ...base,
      reason: place
        ? `${priceText}, and no branch check in ${place} from the last ${CHECK_VALID_DAYS} days shows it applies there: record the shelf price on a branch check there`
        : `${priceText}, and no locality is entered, so no branch check shows it applies where you will shop`,
    };
  const at = Date.parse(now);
  const named = branchIdentity(check.branch).named;
  // "not at the branch checked in Camden", or for an online price "not a
  // shelf price at the branch checked in Camden".
  const branchText = `${seen.online ? "a shelf price at " : "at "}the branch checked in ${check.locality}${named ? ` (${branchIdentity(check.branch).text})` : ""}`;
  const shelf = shelfChecks(db, {
    barcode: check.barcode,
    retailer: check.retailer,
    locality: check.locality,
    since: new Date(at - SHELF_PRICE_LOOKBACK_DAYS * DAY).toISOString(),
    until: new Date(at).toISOString(),
  });
  const fresh = (c) => ageDays(c.checked_at, now) !== null && ageDays(c.checked_at, now) <= ALERT_RULES.maxOfferAgeDays;
  const sameShelf = (c) => c.id === check.id || !named || sameBranch(check, c);
  const priced = shelf.find((c) => Number.isSafeInteger(c.price_pence) && c.price_pence > 0 && sameShelf(c)) ?? null;
  const usable = priced && fresh(priced) ? priced : null;
  // An Open Prices shop is the branch when the stock check names it, or (a
  // check that names no branch covering the whole locality) when a recent
  // check in the locality names it.
  const namers = named ? [check] : shelf.filter((c) => branchIdentity(c.branch).named && fresh(c));
  const shopCheck = seen.shop ? (namers.find((c) => shopIsBranch(seen.shop, c)) ?? null) : null;
  let basis = usable ? "check" : shopCheck ? "same-shop" : null;
  if (usable && shopCheck && typeof seen.observed === "string") {
    const checkDay = londonDate(usable.checked_at);
    const shopDay = seen.observed.slice(0, 10);
    if (shopDay > checkDay || (shopDay === checkDay && seen.price > usable.price_pence)) basis = "same-shop";
  }
  if (basis === "check")
    return {
      ...base,
      confirmed: true,
      basis,
      price: usable.price_pence,
      at: usable.checked_at,
      check: {
        id: usable.id,
        checkedAt: usable.checked_at,
        branch: usable.branch ?? null,
        locality: usable.locality,
        price: usable.price_pence,
      },
      reason: null,
    };
  if (basis === "same-shop")
    return { ...base, confirmed: true, basis, price: seen.price, at: seen.observed, reason: null };
  if (priced)
    return {
      ...base,
      reason: `The shelf price on the branch check in ${check.locality} (${gbp(priced.price_pence)}, ${ukTime(priced.checked_at)}) is more than ${ALERT_RULES.maxOfferAgeDays} days old, and ${lowerFirst(priceText)}, not ${branchText}: record the shelf price on a branch check there`,
    };
  return { ...base, reason: `${priceText}, not ${branchText}: record the shelf price on a branch check there` };
}

/**
 * The offer as a trip to the branch pays for it, when the price there came
 * from a branch check (priceAtBranch basis "check"): the shelf price, dated
 * at the check. The shelf price is recorded as what a shopper pays without
 * a loyalty card or multibuy, so it carries no promotion, except that a
 * shelf price no higher than a promotional price the offer lists may be
 * that promotion, so its condition (and a higher regular price) stays and
 * eligibility must still be confirmed. seenOffer keeps the price as the
 * offer listed it, and shelfPrice the check it came from.
 */
function branchPricedOffer(offer, branch, now) {
  const where = branch.check.branch ? `${branch.check.branch}, ${branch.check.locality}` : branch.check.locality;
  const promotional = Boolean(offer.promotion) && branch.price <= offer.price;
  return {
    ...offer,
    price: branch.price,
    regularPrice: promotional && offer.regularPrice > branch.price ? offer.regularPrice : null,
    wasPrice: null,
    rrpPrice: null,
    promotion: promotional ? offer.promotion : null,
    observed: branch.at,
    location: where,
    ...offerFreshness(branch.at, now),
    shelfPrice: { ...branch.check },
    seenOffer: {
      sourceId: offer.sourceId,
      price: offer.price,
      regularPrice: offer.regularPrice ?? null,
      promotion: offer.promotion ?? null,
      observed: offer.observed ?? null,
      where: branch.seen.where,
      online: branch.seen.online,
      ageDays: offer.ageDays ?? null,
      freshness: offer.freshness ?? null,
    },
  };
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
 * offerAttributes: operator-confirmed attributes (validateOfferAttributes)
 *   fill only what the source left blank; offerAttributes in the result lists
 *   the ones applied and the ones ignored because the source states a value.
 * offer is the one the estimate costs (currentOffer): a newer Open Prices
 *   price at the same shop replaces the chosen one, and shopPrice says so.
 */
export function candidatesFor(
  db,
  { provider, sourceId, now = new Date().toISOString(), offerAttributes = {} },
) {
  ensureFunctions(db);
  // The same offer the estimate costs: a newer Open Prices price at the same
  // shop replaces the chosen one (currentOffer).
  const resolved = currentOffer(db, provider, sourceId, now);
  const attributes = applyOfferAttributes(resolved.offer, validateOfferAttributes(offerAttributes));
  const offer = attributes.offer;
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
  // Listings count as competition only while recent (matching.competition);
  // none recorded and no lookup on record means competition is not known.
  const lookup = askingLookup(db, offer.gtin, now);
  const listed = competition(offer, rows, { now, lookup });
  const known = demandFor({ rate: null, competition: listed, lookup }).competingListings;
  return {
    offer,
    sales,
    listings,
    other,
    competition: { ...listed, lookup, competingListings: known },
    offerAttributes: { applied: attributes.applied, ignored: attributes.ignored },
    shopPrice: resolved.shopPrice,
  };
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
    // Own keys only: "toString", "constructor" or "__proto__" must be a 400,
    // never a call to something inherited from Object.prototype.
    if (!Object.hasOwn(RULE_INPUTS, key)) fail(`rules can only set: ${RULE_KEYS.join(", ")}`);
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
    // Category rules (opportunity.mjs CATEGORY_RULES). Missing means the
    // category the offer suggests (suggestCategory).
    category: optional(request.category, (v) => oneOf(v, "category", CATEGORY_IDS)) ?? null,
    // Why a looser category than the suggested one is right (categoryDecision).
    categoryReason:
      optional(request.categoryReason, (v) =>
        typeof v === "string" && !v.trim() ? null : text(v, "categoryReason", 300),
      ) ?? null,
    // The member's carry limit in kilograms, for the access needs. Missing
    // means the default profile's limit.
    carryKg:
      optional(request.carryKg, (v) => num(v, "carryKg", 0, 1000)) ?? null,
    packagingChecked:
      optional(request.packagingChecked, (v) => bool(v, "packagingChecked")) ?? false,
    bestBefore: isoDate(request.bestBefore, "bestBefore", { optional: true }),
    offerAttributes: validateOfferAttributes(request.offerAttributes),
    now: now ?? null,
  };
}

// Calendar days from one date (YYYY-MM-DD) to another. Counts start from
// today's date in London (londonDate), never the UTC date.
const calendarDays = (from, to) =>
  Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / DAY);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A calendar date for people: "8 Nov 2026". Never the raw YYYY-MM-DD. */
export function ukDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date ?? ""));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "an unknown date";
}
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

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
 * is unknown (no confirmed sales) or the count is unknown (null). Pass the
 * count demandFor settled on: 0 only when an asking-price lookup found no
 * listings, because an empty list can mean nobody looked. Listings of any
 * variant with the same barcode count, which errs towards more competition.
 */
export function resaleWeeksOfSupply(activeListings, rate) {
  if (!Number.isFinite(rate) || rate <= 0) return null;
  // The caller passes a count only when competition is known: 0 is a
  // lookup that found none, never "nobody looked" (that is null).
  if (!Number.isSafeInteger(activeListings) || activeListings < 0) return null;
  return Math.round((activeListings / rate) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Time until payment.

/** The saved goals, or the defaults when the goals table is absent. */
function savedGoals(db) {
  if (tableExists(db, "goals")) return getGoals(db);
  return { ...DEFAULT_GOALS, dispatchDays: [...DEFAULT_GOALS.dispatchDays], updated: null };
}

/**
 * When the cash from this trip comes back, from goals.payoutDate: the trip
 * is today in London (londonDate, the decision date) and every unit is
 * listed the same day. One unit sells after the sold sample's days to sell;
 * several units take as long as the sales rate needs to absorb them all
 * (opportunity.daysToSellAll), so the last unit is not assumed to sell as
 * fast as the first. Posting, delivery and payout follow the saved goals
 * (dispatch days, delivery days, payout delay).
 *
 * input: now, daysToSell (median for one unit), goals, units (default 1),
 * salesPerWeek (confirmed sales rate; needed for more than one unit),
 * cashNeededBy (a date) or cashNeededDays (calendar days from today).
 *
 * Returns { start, sold, dispatch, delivered, date, note, days, units,
 * unitPayouts, cashDate, unitsByCashDate, goals, cashNeededBy,
 * cashNeededDays, timing }. sold to date describe the last unit; days counts
 * calendar days from today to its payout, the same way cashNeededDays counts
 * to the cash date, so a payout on the cash date is on time. unitPayouts is
 * the payout date of each unit in turn (null when it cannot be scheduled);
 * unitsByCashDate how many are paid out by the cash date (null without one).
 * timing is { status: "on time" | "late" | "unknown", daysLate, note }.
 * Notes write dates as "8 Nov 2026".
 */
export function payoutSchedule({
  now,
  daysToSell,
  goals,
  cashNeededBy = null,
  cashNeededDays = null,
  units = 1,
  salesPerWeek = null,
}) {
  const start = londonDate(now);
  const n = Number.isInteger(units) && units >= 1 ? units : 1;
  const sellIn = (k) =>
    Number.isInteger(daysToSell) ? daysToSellAll({ units: k, daysToSell, salesPerWeek }) : null;
  const plan = (days) =>
    payoutDate({
      start,
      daysToSell: days,
      dispatchDays: goals.dispatchDays,
      deliveryDays: goals.deliveryDays,
      payoutDelayDays: goals.payoutDelayDays,
    });
  const unknown = (note) => ({ sold: null, dispatch: null, delivered: null, date: null, note });
  const lastSells = sellIn(n);
  let schedule;
  if (!Number.isInteger(daysToSell))
    schedule = unknown("Days to sell are unknown from the confirmed sales, so a payout date cannot be scheduled.");
  else if (lastSells === null)
    schedule = unknown(
      `The confirmed sales rate is unknown, so the payout for all ${n} units cannot be scheduled.`,
    );
  else {
    const p = plan(lastSells);
    schedule = p.date
      ? {
          ...p,
          note: `Assumes ${n === 1 ? "a sale" : `the last of ${n} units sells`} by ${ukDate(p.sold)}, posting on ${ukDate(p.dispatch)}, delivery by ${ukDate(p.delivered)} and payout on ${ukDate(p.date)}.`,
        }
      : p;
  }
  const days = schedule.date ? calendarDays(start, schedule.date) : null;
  const unitPayouts = Array.from({ length: n }, (_, i) => {
    const d = sellIn(i + 1);
    return d === null ? null : plan(d).date;
  });
  const cashDate = cashNeededBy
    ? cashNeededBy
    : Number.isFinite(cashNeededDays)
      ? addDays(start, cashNeededDays)
      : null;
  const unitsByCashDate = cashDate ? unitPayouts.filter((d) => d !== null && d <= cashDate).length : null;
  const lastUnit = n === 1 ? "Payout" : `Payout of the last of ${n} units`;
  let timing;
  if (!cashDate)
    timing = { status: "unknown", daysLate: null, note: "No date is set for when you need the cash back." };
  else if (!schedule.date)
    timing = {
      status: "unknown",
      daysLate: null,
      note: `The payout date is unknown, so it cannot be checked against ${ukDate(cashDate)}, when you need the cash.`,
    };
  else {
    const late = calendarDays(cashDate, schedule.date);
    timing =
      late > 0
        ? {
            status: "late",
            daysLate: late,
            note: `${lastUnit} expected ${ukDate(schedule.date)}, ${plural(late, "day")} after you need the cash (${ukDate(cashDate)}).`,
          }
        : {
            status: "on time",
            daysLate: 0,
            note: `${lastUnit} expected ${ukDate(schedule.date)}, on or before ${ukDate(cashDate)}, when you need the cash.`,
          };
  }
  return {
    start,
    ...schedule,
    days,
    units: n,
    unitPayouts,
    cashDate,
    unitsByCashDate,
    goals: {
      daysToSell: Number.isInteger(daysToSell) ? daysToSell : null,
      daysToSellAll: lastSells,
      salesPerWeek: Number.isFinite(salesPerWeek) ? Math.round(salesPerWeek * 100) / 100 : null,
      daysToSellSource: "confirmed sold sample",
      dispatchDays: [...goals.dispatchDays],
      deliveryDays: goals.deliveryDays,
      payoutDelayDays: goals.payoutDelayDays,
      saved: Boolean(goals.updated),
    },
    cashNeededBy: cashNeededBy || null,
    cashNeededDays: Number.isFinite(cashNeededDays) ? cashNeededDays : null,
    timing,
  };
}

// ---------------------------------------------------------------------------
// The three prices, side by side, each with its evidence class and date.

const MAX_HISTORY_POINTS = 30;

// Open Prices observations of a barcode, per item only, newest first.
function observationsFor(db, gtin) {
  if (!gtin || !tableExists(db, "observations")) return [];
  const core = gtin.replace(/^0+/, "");
  const digits = "ltrim(replace(replace(trim(barcode), ' ', ''), '-', ''), '0')";
  return db
    .prepare(
      `SELECT ${OBSERVATION_OFFER_COLUMNS} FROM observations
 WHERE barcode IS NOT NULL AND ${digits} = ? AND price > 0 AND ${PER_ITEM}
 ORDER BY day DESC NULLS LAST, id DESC LIMIT 500`,
    )
    .all(core)
    .map(plain)
    .filter((r) => normaliseBarcode(r.barcode) === gtin);
}

const historyPoint = (row, evidenceClass, chosen) => ({
  evidenceClass,
  provider: row.provider,
  sourceId: String(row.source_id),
  price: row.price,
  observed: row.observed ?? null,
  retailer: row.retailer ?? null,
  promotion: row.promotion ?? null,
  chosen,
});
const priceRange = (points) => {
  const prices = points.map((p) => p.price);
  const dates = points.map((p) => p.observed).filter(Boolean).sort();
  return {
    count: points.length,
    lowest: prices.length ? Math.min(...prices) : null,
    highest: prices.length ? Math.max(...prices) : null,
    oldest: dates[0] ?? null,
    newest: dates[dates.length - 1] ?? null,
  };
};

/**
 * Three prices for one barcode, kept apart because they answer different
 * questions:
 *  claimed   the retailer's claimed price when the source records one:
 *            an Awin previous price (was_price), else an Awin recommended
 *            retail price (rrp_price), else the Open Prices price without the
 *            discount. kind is "previous", "rrp" or "regular". A feed's claim
 *            is display only and never the cost. Null when no source states one
 *  observed  the acquisition price over time: dated Retail offers and
 *            per-item Open Prices observations of the same barcode (the
 *            chosen offer included), plus Amazon offer history kept
 *            separately as research context only
 *  sold      completed resale prices from the confirmed sold sample, with
 *            the count of exact-variant sales not (yet) in it
 * Points are newest first, at most 30 per list; each has its evidence class
 * and its source date. Future-dated points are left out.
 */
export function priceComparison(db, offer, rows, sample, now) {
  const notFuture = (r) => !r.observed || Date.parse(r.observed) <= Date.parse(now);
  const claim = (price, kind, basis) => ({
    evidenceClass: KIND.RETAIL,
    kind,
    price,
    observed: offer.observed,
    basis,
  });
  const claimed = offer.wasPrice
    ? claim(offer.wasPrice, "previous", "Previous price claimed by the retailer in the Awin feed")
    : offer.rrpPrice
      ? claim(offer.rrpPrice, "rrp", "Recommended retail price in the Awin feed")
      : Number.isSafeInteger(offer.regularPrice) && offer.regularPrice > offer.price
        ? claim(
            offer.regularPrice,
            "regular",
            offer.provider === OPEN_PRICES
              ? "Price without the discount, recorded with this Open Prices observation"
              : "Regular price recorded by the source",
          )
        : null;
  const chosenKey = `${offer.provider}|${offer.source_id}`;
  const retail = [
    ...rows.filter((r) => r.kind === KIND.RETAIL && normaliseBarcode(r.barcode) === offer.gtin),
    ...observationsFor(db, offer.gtin),
  ];
  const seen = new Set();
  const retailPoints = [{ ...offer }, ...retail]
    .filter((r) => {
      const k = `${r.origin === "observations" ? OPEN_PRICES : r.provider}|${r.source_id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return notFuture(r) && Number.isSafeInteger(r.price) && r.price > 0;
    })
    .map((r) => {
      const provider = r.origin === "observations" ? OPEN_PRICES : r.provider;
      return historyPoint({ ...r, provider }, KIND.RETAIL, `${provider}|${r.source_id}` === chosenKey);
    })
    .sort((a, b) => String(b.observed ?? "").localeCompare(String(a.observed ?? "")));
  const amazonPoints = rows
    .filter((r) => r.kind === KIND.AMAZON && normaliseBarcode(r.barcode) === offer.gtin && notFuture(r))
    .map((r) => historyPoint(r, KIND.AMAZON, false))
    .sort((a, b) => String(b.observed ?? "").localeCompare(String(a.observed ?? "")));
  const exactUnused = rows.filter(
    (r) =>
      r.kind === KIND.SOLD &&
      compare(offer, r).status === "exact" &&
      !sample.used.some((u) => rowKey(u) === rowKey(r)),
  ).length;
  const soldPrices = sample.used.map((r) => r.price);
  return {
    claimed,
    observed: {
      evidenceClass: KIND.RETAIL,
      points: retailPoints.slice(0, MAX_HISTORY_POINTS),
      ...priceRange(retailPoints),
      amazon: {
        evidenceClass: KIND.AMAZON,
        note: "Amazon as seller: research context only, not a local offer and not a sale",
        points: amazonPoints.slice(0, MAX_HISTORY_POINTS),
        ...priceRange(amazonPoints),
      },
    },
    sold: {
      evidenceClass: KIND.SOLD,
      count: sample.count,
      lowerMedian: sample.lowerMedian,
      lowest: soldPrices.length ? Math.min(...soldPrices) : null,
      highest: soldPrices.length ? Math.max(...soldPrices) : null,
      oldest: sample.oldest,
      newest: sample.newest,
      exactNotInSample: exactUnused,
      note: "Realised totals including buyer postage, from sales you confirmed as the exact variant",
    },
  };
}

// ---------------------------------------------------------------------------
// The journey must be entered: a blank cost or time is never a free, instant
// trip. Zero is accepted when entered, for example when walking.

export const JOURNEY_CHECK_ID = "journey";

/**
 * Adds the journey check to an evaluateAlert result unless the gate already
 * has one, recomputing eligible and reasons. The trip fails closed when the
 * return journey cost or time was left blank.
 */
export function withJourneyCheck(alert, journey) {
  if (alert.checks.some((c) => c.id === JOURNEY_CHECK_ID)) return alert;
  const check = {
    id: JOURNEY_CHECK_ID,
    ok: journey.known === true,
    detail: journey.known
      ? "Return journey cost and time entered"
      : "Journey cost or time not entered, so travel is left out of profit and earnings per hour",
  };
  const at = alert.checks.findIndex((c) => c.id === "hourly-floor");
  const checks = [...alert.checks];
  checks.splice(at === -1 ? checks.length : at + 1, 0, check);
  return {
    ...alert,
    eligible: checks.every((c) => c.ok),
    reasons: checks.filter((c) => !c.ok).map((c) => c.detail),
    checks,
  };
}

// ---------------------------------------------------------------------------
// Required costs and times. A blank is never zero: 0 counts only when typed.
// Each entry is [request cost key, plain label]. A blank money input leaves
// the contribution unknown to the gate; any blank leaves earnings per hour
// unknown. The fee, fixed fee, returns and in-store time fall back to stated
// sample assumptions instead (never zero), so they are not listed.
export const REQUIRED_INPUTS = Object.freeze([
  ["postage", "parcel cost"],
  ["packaging", "packaging cost"],
  ["journeyCost", "return journey cost"],
  ["journeyMinutes", "journey time"],
  ["handlingMinutes", "handling time"],
]);
const MONEY_INPUTS = new Set(["postage", "packaging", "journeyCost"]);

/** Plain labels of the required inputs the request left blank, in form order. */
export function missingInputsOf(defaulted = []) {
  const blank = new Set(defaulted);
  return REQUIRED_INPUTS.filter(([key]) => blank.has(key)).map(([, label]) => label);
}

// Ways a barcode may have been typed into an asking-price lookup: the
// 14-digit GTIN and its shorter forms without leading zeros.
const barcodeQueries = (gtin) =>
  [...new Set([14, 13, 12, 8].filter((n) => /^0*$/.test(gtin.slice(0, 14 - n))).map((n) => gtin.slice(14 - n)))];

/**
 * The latest eBay asking-price lookup for the barcode still inside its time
 * to live (evidence.mjs lookup cache), { provider, fetched } or null. With no
 * lookup on record, an empty list of asking prices means nobody looked, so
 * competition is unknown rather than zero.
 */
export function askingLookup(db, gtin, now) {
  if (typeof gtin !== "string" || !/^\d{14}$/.test(gtin) || !tableExists(db, "lookup_cache")) return null;
  let best = null;
  for (const query of barcodeQueries(gtin)) {
    const hit = cachedLookup(db, "ebay", query, { now });
    if (hit && (!best || hit.fetched > best.fetched)) best = { provider: "ebay", fetched: hit.fetched };
  }
  return best;
}

/**
 * Units the evidence supports selling within the sell window, with the
 * figures behind it: { units, salesPerWeek, competingListings,
 * sellWindowWeeks, note }. Competing listings are known when listings are
 * recorded, or when none are and an asking-price lookup on record found
 * none. A null count (the listings on record are too old, or nobody looked)
 * leaves demand unknown, which fails the buy-alert gate.
 */
export function demandFor({ rate, competition: resale, lookup }) {
  const weeks = OPPORTUNITY_RULES.sellWindowWeeks;
  const listings = resale?.activeListings;
  const competingListings =
    Number.isSafeInteger(listings) && listings > 0 ? listings : listings === 0 && lookup ? 0 : null;
  const units = demandUnits({ salesPerWeek: rate, competingListings }, weeks);
  const shownRate = rate === null ? null : Math.round(rate * 100) / 100;
  const note =
    rate === null
      ? "No confirmed sales, so demand is not known"
      : competingListings === null
        ? listings === 0
          ? "Competition not known: no competing listings are recorded and no asking-price lookup for this barcode is on record, so nobody may have looked. Run an eBay asking-price lookup (see Sources)"
          : `Competition not known. ${resale?.note ?? "The competing listings on record are too old to count: run an asking-price lookup before sharing"}`
        : `About ${plural(units, "unit")} can sell within ${weeks} weeks at ${shownRate} confirmed sales a week, ${
            competingListings === 0
              ? "with no competing listings found by the latest asking-price lookup"
              : `after allowing for ${plural(competingListings, "competing listing")}`
          }`;
  return { units, salesPerWeek: shownRate, competingListings, sellWindowWeeks: weeks, note };
}

const LONDON_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
/** A date and time for people in UK time: "31 Oct 2026, 21:22". */
export const ukTime = (value) =>
  Number.isFinite(Date.parse(value)) ? LONDON_TIME.format(new Date(Date.parse(value))) : "an unknown time";

/**
 * Units on the branch shelf now, counted the way a bounty card counts them
 * (bounties.mjs shelfUnitsNow) so Research and the card agree (R3Q6). The
 * bounty tables are read directly, each behind a tableExists guard, because
 * importing bounties.mjs here would close an import cycle.
 *
 * The count is the newer of the availability check given (stockStatus's
 * check) and the latest stock report from the last CHECK_VALID_DAYS days on
 * a live (not sample) bounty for the same barcode, retailer and locality
 * that the operator did not mark inaccurate, less the units members marked
 * as bought through those bounties after that count. A check that found
 * none counts 0; one that found stock without a count leaves units null.
 *
 * Returns { units, seen, source: "stock check" | "stock report" | null, at,
 * boughtSince, report, note }: seen is the count before purchases, at its
 * time (ISO), report the newest such report ({ at, unitsSeen, verified }) or
 * null, note the count in words or null.
 */
export function branchShelf(db, { barcode, retailer, locality, check = null, now = new Date().toISOString() }) {
  const gtin = normaliseBarcode(barcode);
  const at = Date.parse(now);
  const shop = shopText(retailer);
  const place = shopText(locality);
  const checkAt = Date.parse(check?.checked_at);
  const checkUnits = !check
    ? null
    : check.in_stock !== 1
      ? 0
      : Number.isSafeInteger(check.units_seen) && check.units_seen > 0
        ? check.units_seen
        : null;
  let ids = [];
  if (gtin && shop && place && Number.isFinite(at) && tableExists(db, "bounties")) {
    ensureFunctions(db);
    ids = db
      .prepare("SELECT id, retailer, locality FROM bounties WHERE sample = 0 AND bounty_gtin(barcode) = ?")
      .all(gtin)
      .filter((b) => shopText(b.retailer) === shop && shopText(b.locality) === place)
      .map((b) => b.id);
  }
  const marks = ids.map(() => "?").join(", ");
  let report = null;
  if (ids.length && tableExists(db, "stock_reports")) {
    const since = at - CHECK_VALID_DAYS * DAY;
    report =
      db
        .prepare(
          `SELECT units_seen, observed_at, verified FROM stock_reports
 WHERE bounty_id IN (${marks}) AND (verified IS NULL OR verified != 'inaccurate')`,
        )
        .all(...ids)
        .filter((r) => {
          const t = Date.parse(r.observed_at);
          return Number.isFinite(t) && t >= since && t <= at && Number.isSafeInteger(r.units_seen);
        })
        .sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))
        .map((r) => ({ at: r.observed_at, unitsSeen: r.units_seen, verified: r.verified ?? null }))[0] ?? null;
  }
  let seen = null;
  let source = null;
  let countAt = null;
  if (report && (!Number.isFinite(checkAt) || Date.parse(report.at) >= checkAt)) {
    seen = report.unitsSeen;
    source = "stock report";
    countAt = report.at;
  } else if (Number.isFinite(checkAt)) {
    seen = checkUnits;
    source = "stock check";
    countAt = new Date(checkAt).toISOString();
  }
  let boughtSince = 0;
  if (seen !== null && ids.length && tableExists(db, "claims")) {
    const from = Date.parse(countAt);
    boughtSince = db
      .prepare(`SELECT units, ended_at FROM claims WHERE bounty_id IN (${marks}) AND status = 'completed'`)
      .all(...ids)
      .filter((c) => {
        const t = Date.parse(c.ended_at);
        return Number.isFinite(t) && t > from && t <= at && Number.isSafeInteger(c.units) && c.units > 0;
      })
      .reduce((n, c) => n + c.units, 0);
  }
  const units = seen === null ? null : Math.max(0, seen - boughtSince);
  const what = source === "stock report" ? "a member's stock report" : "the branch check";
  const note =
    seen === null
      ? null
      : boughtSince > 0
        ? `${plural(seen, "unit")} seen in ${what} at ${ukTime(countAt)}, less ${plural(boughtSince, "unit")} members have bought through bounties since, leaves about ${units}`
        : `${plural(seen, "unit")} seen in ${what} at ${ukTime(countAt)}`;
  return { units, seen, source, at: countAt, boughtSince, report, note };
}

/**
 * The one thing most likely to make the estimate wrong, in plain words,
 * checked in order of how badly it would mislead.
 */
function mainUncertainty({ sampleData, economics, match, offer, missing, stock, demand, sample, units = 1, branchPrice = null }) {
  if (sampleData) return "Sample figures: illustrative only, never observed evidence";
  if (!economics)
    return match === "research"
      ? "No confirmed completed sale of this exact item yet, so what buyers pay is not known"
      : "No completed sales recorded for this item, so what buyers pay is not known";
  if (offer.expired)
    return offer.freshness === "unknown"
      ? "The offer price has no observation date, so it may have changed"
      : `The offer price was last seen ${plural(offer.ageDays ?? 0, "day")} ago and may have changed`;
  if (missing.length) return `${andList(missing)} not entered, so profit and earnings per hour are not known`.replace(/^./, (c) => c.toUpperCase());
  if (!stock.confirmed && stock.check?.in_stock === 1 && stock.shelf?.units === 0)
    return "The shelf may be empty: members have bought the units seen, or reported none, since the latest branch check";
  if (stock.availability === "out_of_stock") return "The latest branch check found none on the shelf";
  if (!stock.confirmed) return "Branch stock has not been confirmed by a recent check in this locality";
  // The branch is checked, but the price was seen somewhere else.
  if (branchPrice && !branchPrice.confirmed) return branchPrice.reason.replace(/: record .*$/, "");
  if (Number.isSafeInteger(stock.shelf?.units) && stock.shelf.units < units)
    return `Only about ${plural(stock.shelf.units, "unit")} likely left on the shelf for the ${plural(units, "unit")} planned`;
  if (demand.units === null) return demand.note;
  if (sample.independent < ALERT_RULES.minIndependentSales)
    return `Only ${plural(sample.independent, "independent seller")} in the confirmed sales`;
  return `Whether buyers still pay about ${gbp(sample.lowerMedian)}: the estimate rests on ${plural(sample.count, "confirmed sale")}`;
}

/**
 * estimateFromEvidence(db, request, options?) per docs/ARCHITECTURE.md.
 *
 * options.now overrides request.now; the HTTP route passes the server clock
 * so a client cannot make an expired offer look fresh. options.lookup (an
 * asking-price lookup { provider, fetched } or null) overrides the lookup
 * read from the cache (askingLookup). options.pinOffer true costs the
 * chosen offer exactly as stored, even when a newer Open Prices price at the
 * same shop exists (for judging a record as it stood, such as an audit
 * item); otherwise the newest same-shop price is used (currentOffer).
 *
 * Request additions beyond the architecture contract:
 *  weightKg  weight of one unit in kilograms; null or missing means unknown,
 *            which rejects the opportunity ("Unit weight unknown").
 *  rules     the member's own threshold overrides (RULE_KEYS). They pass
 *            through effectiveRules, so they can only tighten.
 *  offerAttributes  { size, pack, model, condition } the operator confirmed
 *            after looking at the item; they fill only what the source left
 *            blank (applyOfferAttributes) and are marked operator-confirmed.
 *  category  "general" | "clothing" | "food"; missing means the offer's
 *            suggested category. Clothing raises the returns allowance to its
 *            floor and needs a size; food needs packagingChecked and a
 *            bestBefore date with enough shelf life after the last unit sells.
 *  categoryReason  why a category looser than the suggested one is right.
 *            Without it the suggested category's rules stay (categoryDecision).
 *  packagingChecked, bestBefore  food checks (categoryChecks).
 *  carryKg   the member's carry limit for the access needs (default profile
 *            limit when missing).
 *  costs     postage, packaging, journeyCost, journeyMinutes and
 *            handlingMinutes must be entered (0 is allowed when entered). A
 *            blank one is listed in missingInputs and fails the gate's
 *            inputs-entered check (the tier goes to Review); a blank money
 *            input leaves the contribution unknown to the gate and any blank
 *            leaves earnings per hour unknown. A blank journey also fails the
 *            journey check.
 *
 * Returns { offer, sample, competition, match, economics, opportunity,
 * alert } plus thresholds, stock (the availability check used), permission,
 * unitCost, cashNeededDays, payout (payoutSchedule), demand (demandFor),
 * prices (priceComparison), category (categoryDecision plus the rule, the
 * returns rate and the failures), journey, missingInputs, access
 * ({ needs, carryKg, carrySource }), checked ({ price, stock }),
 * mainUncertainty, offerAttributes, shopPrice, inputs, assumptions and
 * warnings. economics is null unless at least one confirmed exact sale
 * qualifies. competition carries the lookup used and the known
 * competingListings.
 *
 * offer is the offer the figures use: for an Open Prices observation with a
 * newer one at the same shop it is the newest (currentOffer), with
 * offer.chosenOffer and shopPrice ({ chosen, used, change }) saying so and a
 * warning naming both prices when they differ. When the branch check
 * recorded the shelf price (priceAtBranch basis "check") the offer carries
 * that price, dated at the check, with no promotion, plus shelfPrice (the
 * check) and seenOffer (the price as the source listed it); prices compares
 * the offers as listed. priceAtBranch says whether the price applies at the
 * branch the stock check covers, and the gate's price-at-branch check fails
 * with its reason when it does not. stock is stockStatus's result
 * plus shelf (branchShelf): units members bought through bounties since the
 * count are subtracted, a newer stock report sets the count as on the bounty
 * card, and a count that has fallen to none leaves stock unconfirmed.
 *
 * opportunity is classifyOpportunity(...) from opportunity.mjs (tier,
 * reasons, unitProfit, returnOnCost, targetPrice, meetsThresholds,
 * trialUnits) with the measures it was given: salesPerWeek,
 * resaleWeeksOfSupply, sourcingPressure (always null here: nobody is
 * heading to the shelf at research time, so it is unknown and the best tier
 * an estimate can reach is Priority 2) and provenItem.
 *
 * The alert always comes from evaluateAlert, run twice with the same
 * missingInputs, demandUnits and sellWindowWeeks: a screening pass supplies
 * the evidence and stock checks that classifyOpportunity reads, then the
 * final pass adds meetsThresholds from the classification, units and the
 * trial batch size from the effective rules. provenItem is false because
 * there is no link to verified ledger trades yet, so every item is held to a
 * trial batch.
 */
export function estimateFromEvidence(db, request, options = {}) {
  const input = validateEstimateRequest(request);
  const now = options.now ?? input.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) fail("now must be a date and time");
  ensureFunctions(db);
  // An Open Prices observation with a newer one at the same shop is costed
  // at the newest (currentOffer): the trip pays today's shelf price.
  const resolved = currentOffer(db, input.offer.provider, input.offer.sourceId, now, {
    pin: options.pinOffer === true,
  });
  const attributes = applyOfferAttributes(resolved.offer, input.offerAttributes);
  // The offer as its source listed it, at the shop where it was seen.
  const seenOffer = attributes.offer;
  const checked = stockStatus(db, {
    barcode: seenOffer.gtin,
    retailer: seenOffer.retailer,
    locality: input.locality,
    now,
  });
  // The price must apply at the branch the stock check covers (round 5): a
  // shelf price recorded on the branch check costs the trip, dated at the
  // check; otherwise only an Open Prices price from that same shop applies.
  const branchPrice = priceAtBranch(db, { offer: seenOffer, stock: checked, now });
  const offer = branchPrice.basis === "check" ? branchPricedOffer(seenOffer, branchPrice, now) : seenOffer;
  const rows = findCandidates(db, seenOffer);
  const confirmed = new Set(input.sales.map((s) => `${s.provider}|${s.sourceId}`));
  const sample = soldSample(offer, rows, { now, confirmed });
  const lookup = options.lookup !== undefined ? options.lookup : askingLookup(db, offer.gtin, now);
  const listed = competition(offer, rows, { now, lookup });
  const rate = salesPerWeek(sample.count);
  const demand = demandFor({ rate, competition: listed, lookup });
  const resale = { ...listed, lookup: lookup ?? null, competingListings: demand.competingListings };
  const warnings = [];
  const assumptions = [];

  // A promotion or loyalty price the shopper has not confirmed they qualify
  // for is not their cost: use the regular price when the source gives one.
  // Without one the real cost is unknown, and the tier goes to Review.
  let unitCost = offer.price;
  let promotionUnconfirmed = false;
  let costedAtRegularPrice = false;
  if (offer.promotion && !input.promotionEligible) {
    if (offer.regularPrice && offer.regularPrice > offer.price) {
      unitCost = offer.regularPrice;
      costedAtRegularPrice = true;
      assumptions.push(
        "Promotion eligibility not confirmed, so stock is costed at the regular price",
      );
    } else {
      promotionUnconfirmed = true;
      warnings.push(
        "This is a promotion or loyalty price and eligibility is not confirmed: you may pay more",
      );
    }
  }

  // Category rules: the suggested category's rules stay unless a looser
  // choice comes with a reason. The returns allowance floor applies to the
  // economics.
  const suggestion = offer.suggestedCategory;
  const decision = categoryDecision(suggestion, input.category, input.categoryReason);
  const categoryId = decision.applied;
  const rule = categoryRule(categoryId);
  const returnsRate = categoryReturnsRate(categoryId, input.costs.returnsRate);
  const costs = { ...input.costs, returnsRate };

  const journeyMissing = ["journeyCost", "journeyMinutes"].filter((k) => input.defaulted.includes(k));
  const journey = {
    known: journeyMissing.length === 0,
    missing: journeyMissing,
    costKnown: !journeyMissing.includes("journeyCost"),
    minutesKnown: !journeyMissing.includes("journeyMinutes"),
  };
  const missingInputs = missingInputsOf(input.defaulted);
  const moneyKnown = !input.defaulted.some((k) => MONEY_INPUTS.has(k));

  const economics =
    sample.count > 0
      ? tripEconomics({
          units: input.units,
          unitCost,
          salePrice: sample.lowerMedian,
          ...costs,
        })
      : null;

  const soldCandidates = rows.filter((r) => r.kind === KIND.SOLD);
  const match =
    sample.count > 0
      ? "exact"
      : soldCandidates.some((r) => compare(offer, r).status !== "none")
        ? "research"
        : "none";

  // The shelf as a bounty card counts it: a newer stock report and units
  // members have bought through bounties since change the count (R3Q6). A
  // count that has fallen to none no longer confirms stock. availability
  // stays what the check found (a bounty reads "out_of_stock" as a check
  // that found none and words its notices that way).
  const shelf = branchShelf(db, {
    barcode: offer.gtin,
    retailer: offer.retailer,
    locality: input.locality,
    check: checked.check,
    now,
  });
  const emptied =
    checked.confirmed && shelf.units === 0
      ? shelf.boughtSince > 0
        ? `Members have bought ${plural(shelf.boughtSince, "unit")} through bounties since ${shelf.source === "stock report" ? "a member's stock report" : "the branch check"} at ${ukTime(shelf.at)}, which saw ${shelf.seen}, so the shelf may be empty: record a new check`
        : `A member reported none on the shelf at ${ukTime(shelf.at)}, after the latest branch check${shelf.report?.verified === "accurate" ? "" : " (not verified yet)"}: record a new check`
      : null;
  const stock = emptied
    ? { ...checked, confirmed: false, reason: emptied, shelf }
    : { ...checked, shelf };
  const permission = displayPermission(db, offer);
  const sampleData = offer.sample || sample.used.some(isSampleRecord);
  // Calendar days from today in London to the cash date.
  const cashNeededDays = input.cashNeededBy
    ? calendarDays(londonDate(now), input.cashNeededBy)
    : input.cashNeededDays;
  const payout = payoutSchedule({
    now,
    daysToSell: sample.daysToSell,
    goals: savedGoals(db),
    cashNeededBy: input.cashNeededBy,
    cashNeededDays,
    units: input.units,
    salesPerWeek: rate,
  });

  // Food keeps its shelf life until the last unit is expected to sell.
  const categoryFailures = categoryChecks({
    category: categoryId,
    size: offer.size,
    returnsRate,
    packagingChecked: input.packagingChecked,
    bestBefore: input.bestBefore,
    daysToSell: payout.goals.daysToSellAll,
    now,
  });

  const alertInput = {
    evidenceClass: sampleData ? "sample" : "live",
    match,
    // A blank cost leaves the contribution unknown; any blank cost or time
    // leaves earnings per hour unknown. Both fail closed.
    contribution: economics && moneyKnown ? economics.contribution : null,
    hourly: economics && missingInputs.length === 0 ? economics.hourly : null,
    hourlyFloor: input.hourlyFloor,
    missingInputs,
    journeyKnown: journey.known,
    offerObserved: offer.observed,
    now,
    localStockConfirmed: stock.confirmed,
    availability: stock.availability,
    // The price applies at the branch the stock check covers (priceAtBranch).
    priceAtBranch: branchPrice.confirmed,
    priceAtBranchBasis: branchPrice.basis,
    priceAtBranchReason: branchPrice.reason,
    // Units likely left on the shelf (the newest count less units bought
    // through bounties since); the gate fails when more are planned.
    shelfUnits: stock.confirmed && Number.isSafeInteger(stock.shelf?.units) ? stock.shelf.units : null,
    promotion: offer.promotion,
    promotionEligible: input.promotionEligible,
    costedAtRegularPrice,
    shippingKnown: input.costs.postage > 0,
    recentIndependentSales: sample.independent,
    daysToSell: sample.daysToSell,
    cashNeededDays,
    payoutDays: payout.days,
    displayPermitted: permission.permitted,
    demandUnits: demand.units,
    sellWindowWeeks: demand.sellWindowWeeks,
  };
  // Screening pass: classifyOpportunity reads only its evidence and stock
  // checks. Its buying-thresholds and trial-batch results are discarded.
  const screening = withJourneyCheck(evaluateAlert(alertInput), journey);
  const thresholds = thresholdsFor(input.rules);
  // Weeks of supply use the same competing-listings count as demand, so a
  // count nobody checked never reads as low competition.
  const weeksOfSupply = resaleWeeksOfSupply(demand.competingListings, rate);
  // The purchase price per unit is the price the stock is costed at: the
  // offer price, or the regular price when a promotion's eligibility is not
  // confirmed. The same figure is the base of the return on purchase price.
  let classification = classifyOpportunity(
    {
      unitPrice: unitCost,
      weightKg: input.weightKg,
      economics,
      alert: screening,
      independentSales: sample.independent,
      daysToSell: sample.daysToSell,
      resaleWeeksOfSupply: weeksOfSupply,
      sourcingPressure: null,
      availability: stock.availability,
      promotionUnconfirmed,
      categoryFailures,
    },
    thresholds.rules,
  );
  // Without the journey the profit is overstated, so the numbers cannot be
  // judged yet: Review, unless a hard filter already rejects the item.
  const journeyReason = screening.checks.find((c) => c.id === JOURNEY_CHECK_ID && !c.ok)?.detail;
  if (journeyReason && classification.tier !== "Reject" && !classification.reasons.includes(journeyReason))
    classification = {
      ...classification,
      tier: "Review",
      reasons: [journeyReason, ...(classification.tier === "Review" ? classification.reasons : [])],
      targetPrice: null,
      meetsThresholds: false,
    };
  const opportunity = {
    ...classification,
    unitPrice: unitCost,
    weightKg: input.weightKg,
    salesPerWeek: rate === null ? null : Math.round(rate * 100) / 100,
    resaleWeeksOfSupply: weeksOfSupply,
    sourcingPressure: null,
    provenItem: false,
  };
  const alert = withJourneyCheck(
    evaluateAlert({
      ...alertInput,
      meetsThresholds: classification.meetsThresholds,
      units: input.units,
      trialUnits: thresholds.rules.trialUnits,
      provenItem: false,
    }),
    journey,
  );

  if (sampleData) warnings.push("Sample data: illustrative only and never a buy alert");
  // A newer Open Prices price at the same shop is what the trip pays (R3M3),
  // unless the branch check recorded the shelf price, which then decides.
  const shopPrice = resolved.shopPrice;
  const seenText = branchPrice.seen.online
    ? `the ${gbp(branchPrice.seen.price)} online price from ${branchPrice.seen.where}`
    : `the ${gbp(branchPrice.seen.price)} seen at ${branchPrice.seen.where}`;
  if (branchPrice.basis === "check") {
    const shelfText = `${gbp(branchPrice.price)}, recorded on the branch check in ${branchPrice.check.locality} at ${ukTime(branchPrice.at)}`;
    if (branchPrice.price !== branchPrice.seen.price)
      warnings.push(`The shelf price at the branch is ${shelfText}. Figures use ${gbp(branchPrice.price)}, not ${seenText}`);
    else assumptions.push(`Costed at the shelf price at the branch, ${shelfText}, the same as ${seenText}`);
  } else if (shopPrice && shopPrice.change !== "same")
    warnings.push(
      `A newer price at this shop is ${gbp(shopPrice.used.price)} (${ukDate(shopPrice.used.observed)}). Figures use ${gbp(shopPrice.used.price)}, not the ${gbp(shopPrice.chosen.price)} you chose (${ukDate(shopPrice.chosen.observed)})`,
    );
  else if (shopPrice)
    assumptions.push(
      `A newer Open Prices observation at this shop (${ukDate(shopPrice.used.observed)}) gives the same ${gbp(shopPrice.used.price)}, so the figures use its date`,
    );
  if (decision.warning) warnings.push(decision.warning);
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
  // Where the price was seen and where stock was checked, when the price is
  // not shown to apply at that branch.
  if (!branchPrice.confirmed) warnings.push(branchPrice.reason);
  // stockStatus says in words why stock is not confirmed (no locality, no
  // recent check in the locality, or a check that found none).
  if (!stock.confirmed)
    warnings.push(
      stock.reason ??
        `Branch stock is not confirmed: record an availability check from the last ${CHECK_VALID_DAYS} days`,
    );
  else if (shelf.boughtSince > 0)
    warnings.push(
      `Members have bought ${plural(shelf.boughtSince, "unit")} through bounties since ${shelf.source === "stock report" ? "the stock report" : "the branch check"} at ${ukTime(shelf.at)}, so about ${plural(shelf.units, "unit")} of the ${shelf.seen} seen ${shelf.units === 1 ? "is" : "are"} left`,
    );
  if (stock.confirmed && shelf.source === "stock report" && shelf.report && shelf.report.verified !== "accurate")
    warnings.push(
      `A member reported ${shelf.report.unitsSeen} on the shelf at ${ukTime(shelf.report.at)}, after the latest branch check (not verified yet): the shelf count uses it, as the bounty does`,
    );
  if (stock.confirmed && Number.isSafeInteger(shelf.units) && shelf.units < input.units)
    warnings.push(
      `Only about ${plural(shelf.units, "unit")} likely left on the shelf, fewer than the ${plural(input.units, "unit")} planned: figures for ${plural(input.units, "unit")} overstate what this trip can earn, so plan for no more than ${shelf.units}`,
    );
  if (input.defaulted.includes("postage"))
    warnings.push("No parcel cost entered: profit cannot be judged until you enter what you pay to post one unit");
  else if (input.costs.postage <= 0)
    warnings.push("Parcel cost entered as 0: contribution leaves out postage, so the parcel cost is treated as unknown");
  if (input.defaulted.includes("packaging"))
    warnings.push(
      "No packaging cost entered: profit cannot be judged until you enter it. Enter 0 only if your packaging truly costs nothing",
    );
  if (!journey.costKnown)
    warnings.push(
      "No return journey cost entered: profit leaves out travel. Enter 0 only if the trip costs nothing, for example walking",
    );
  if (!journey.minutesKnown)
    warnings.push("No journey time entered: earnings per hour leave out travel time");
  if (input.defaulted.includes("handlingMinutes"))
    warnings.push(
      "No handling time entered: earnings per hour cannot be judged until you enter the minutes for listing, packing and dispatch",
    );
  else if (input.costs.handlingMinutes <= 0)
    warnings.push("Handling time entered as 0: earnings per hour leave out listing, packing and dispatch");
  for (const x of attributes.ignored) warnings.push(x.reason);
  if (economics && sample.count < ALERT_RULES.minIndependentSales)
    warnings.push(
      `Only ${sample.count} confirmed sale${sample.count === 1 ? "" : "s"}: the sale estimate is weak`,
    );
  if (economics && input.units > sample.count)
    warnings.push(
      `You plan ${input.units} units but there are ${sample.count} confirmed recent sales: they may not all sell`,
    );
  if (economics && demand.units !== null && input.units > demand.units)
    warnings.push(
      `${demand.note}, fewer than the ${plural(input.units, "unit")} planned: buy no more than the sales rate supports`,
    );
  if (economics)
    assumptions.push(
      "Every unit sells at the lower median confirmed sale; the loss if nothing sells is shown separately",
    );
  if (input.defaulted.some((k) => ["feeRate", "feeFixed", "returnsRate", "overheadMinutes"].includes(k)))
    assumptions.push("Sample fee, returns and in-store time assumptions fill the values you left out");
  if (returnsRate > input.costs.returnsRate)
    assumptions.push(
      `${rule.name} returns allowance raised to ${Math.round(returnsRate * 1000) / 10}%, the minimum for the category`,
    );
  if (decision.dropped.length)
    assumptions.push(
      decision.applied === decision.suggested
        ? `Costed under the ${rule.name.toLowerCase()} rules the source suggests, because no reason was given for ${categoryRule(decision.chosen).name}`
        : `Costed under the ${rule.name.toLowerCase()} rules you chose instead of the suggested ${categoryRule(decision.suggested).name.toLowerCase()} rules, for the reason you gave`,
    );
  const confirmedKeys = Object.keys(attributes.applied);
  if (confirmedKeys.length)
    assumptions.push(
      "You confirmed " +
        confirmedKeys.map((k) => ATTRIBUTE_NAMES[k].toLowerCase() + " " + attributes.applied[k]).join(", ") +
        " after looking at the item: the source left " +
        (confirmedKeys.length === 1 ? "it" : "them") +
        " blank",
    );
  if (payout.units > 1 && payout.goals.daysToSellAll !== null)
    assumptions.push(
      `At ${payout.goals.salesPerWeek} confirmed sales a week, the last of ${payout.units} units is expected to sell after ${plural(payout.goals.daysToSellAll, "day")}, not after the ${plural(sample.daysToSell, "day")} one sale takes`,
    );
  if (payout.cashDate && payout.unitsByCashDate !== null)
    assumptions.push(
      `${payout.unitsByCashDate} of ${plural(payout.units, "unit")} expected to have paid out by ${ukDate(payout.cashDate)}, the date you need the cash`,
    );
  assumptions.push(
    `Branch stock comes only from an availability check recorded in the last ${CHECK_VALID_DAYS} days, never from a feed or catalogue`,
    "The price counts for the trip only when a branch check recorded the shelf price, or the offer is an Open Prices price from the shop the check names; a price from another shop or online never does",
    "Profit per unit is the contribution divided by units, so it already carries fees, postage, packaging, the returns allowance and the unit's share of travel",
    "Sourcing pressure is unknown at research time, so a research estimate can reach Priority 2 at best",
    `Resale competition uses the confirmed sales spread over ${ALERT_RULES.maxSaleAgeDays} days as the sales rate, which understates demand and so overstates competition`,
    `Units are limited to what the sales rate supports in ${demand.sellWindowWeeks} weeks after competing listings`,
    "No verified trade is linked from the ledger yet, so every item is treated as unproven and held to the trial batch",
    `Payout timing assumes the trip is today (${ukDate(payout.start)}, London time) and each unit is listed the same day, then uses ${
      payout.goals.saved ? "your saved Goals" : "the default Goals settings"
    } for dispatch days, delivery and payout delay`,
  );

  const carryKg = input.carryKg ?? profileDefaults.carry;
  const access = {
    needs: accessNeeds(
      {
        weight: input.weightKg,
        // Units left after purchases since the count, as the bounty card has it.
        stock: shelf.units,
        stockChecked: shelf.at ?? stock.check?.checked_at ?? null,
        storageNeeds: null,
      },
      { carry: carryKg },
    ),
    carryKg,
    carrySource: input.carryKg === null ? "default" : "request",
  };

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
    // True when the offer or any used sale is sample data: never a buy
    // alert, and a trip tracked from it is a sample trip in the ledger.
    sampleData,
    payout,
    demand,
    // Retail offers as their sources listed them (the shelf price on a
    // branch check is reported under priceAtBranch).
    prices: priceComparison(db, seenOffer, rows, sample, now),
    category: {
      chosen: decision.chosen,
      suggested: decision.suggested,
      applied: decision.applied,
      reason: decision.reason,
      warning: decision.warning,
      dropped: decision.dropped,
      id: rule.id,
      name: rule.name,
      suggestion,
      rule,
      returnsRate,
      returnsRaised: returnsRate > input.costs.returnsRate,
      failures: categoryFailures,
      packagingChecked: input.packagingChecked,
      bestBefore: input.bestBefore,
    },
    journey,
    missingInputs,
    access,
    checked: { price: offer.observed ?? null, stock: stock.check?.checked_at ?? null, locality: stock.locality ?? null },
    mainUncertainty: mainUncertainty({
      sampleData,
      economics,
      match,
      offer,
      missing: missingInputs,
      stock,
      demand,
      sample,
      units: input.units,
      branchPrice,
    }),
    // Whether the price applies at the branch the stock check covers, and
    // why (priceAtBranch); the gate's price-at-branch check reads it.
    priceAtBranch: branchPrice,
    offerAttributes: { applied: attributes.applied, ignored: attributes.ignored },
    // Set when a newer Open Prices price at the same shop replaced the
    // chosen observation (currentOffer): { chosen, used, change }.
    shopPrice,
    inputs,
    assumptions,
    warnings,
  };
}
