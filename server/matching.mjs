// Offer matching and the sold sample. Pure functions: no database access.
//
// A buy decision rests on comparing one acquisition offer with completed
// sales of exactly the same thing. The rules here fail closed: a missing,
// unrecognised or different attribute sends a candidate to research, never to
// the sold sample, and only completed sales the operator has checked count.
import { KIND } from "./contract.mjs";
import { ALERT_RULES, ageDays } from "./alerts.mjs";
import { lowerMedian } from "./trip.mjs";

// Lower case, Unicode-normalised, dashes unified, spaces collapsed. Null for
// empty values so that "not stated" is never confused with a real value, and
// null for anything other than text or a finite number (an object, array or
// boolean is not an attribute value, and converting one could throw).
export function clean(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
  } else if (typeof value !== "string") return null;
  const text = String(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

/**
 * Canonical GTIN-14 for a barcode, or null when it is not a valid GS1 code.
 *
 * Accepts GTIN-8 (EAN-8), GTIN-12 (UPC-A), GTIN-13 (EAN-13) and GTIN-14.
 * Spaces and hyphens are treated as separators; any other non-digit makes the
 * value invalid rather than being silently dropped. The GS1 check digit must
 * be correct. The result is left-padded with zeros to 14 digits, so the UPC-A,
 * EAN-13 and GTIN-14 spellings of one product compare equal. An all-zero code
 * is rejected.
 */
export function normaliseBarcode(value) {
  // Only text or a whole number can be a barcode. Anything else (null, an
  // object, an array) is not one, and is never converted with String().
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
  } else if (typeof value !== "string") return null;
  const digits = String(value).trim().replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits) || ![8, 12, 13, 14].includes(digits.length))
    return null;
  const gtin = digits.padStart(14, "0");
  if (/^0+$/.test(gtin)) return null;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(gtin[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(gtin[13]) ? gtin : null;
}

/**
 * True for GS1 restricted circulation numbers: codes a retailer assigns in
 * store (for example variable-weight or price-embedded items). The same
 * number can mean different products at different retailers, so it never
 * establishes an exact match on its own. Checks the GTIN-13 part of a
 * canonical GTIN-14 for the prefixes 02, 04 and 2.
 */
export function isStoreBarcode(gtin) {
  if (!gtin || gtin.length !== 14) return false;
  const gtin13 = gtin.slice(1);
  return /^(02|04|2)/.test(gtin13);
}

const LETTER_SIZES = [
  ["xxxs", ["xxxs", "3xs", "extra extra extra small"]],
  ["xxs", ["xxs", "2xs", "xx-small", "extra extra small"]],
  ["xs", ["xs", "x-small", "x small", "extra small"]],
  ["s", ["s", "sm", "small"]],
  ["m", ["m", "md", "med", "medium"]],
  ["l", ["l", "lg", "large"]],
  ["xl", ["xl", "x-large", "x large", "extra large"]],
  ["xxl", ["xxl", "2xl", "xx-large", "extra extra large"]],
  ["xxxl", ["xxxl", "3xl", "xxx-large", "extra extra extra large"]],
];
const LETTER = new Map(
  LETTER_SIZES.flatMap(([canonical, forms]) => forms.map((f) => [f, canonical])),
);
// Measured sizes reduce to one unit per dimension so 320mm and 32cm agree.
const UNITS = [
  [/^(mm|millimetres?|millimeters?)$/, "cm", 0.1],
  [/^(cm|centimetres?|centimeters?)$/, "cm", 1],
  [/^(m|metres?|meters?)$/, "cm", 100],
  [/^(ml|millilitres?|milliliters?)$/, "ml", 1],
  [/^(cl|centilitres?|centiliters?)$/, "ml", 10],
  [/^(l|ltrs?|litres?|liters?)$/, "ml", 1000],
  [/^(g|gr|grams?|grammes?)$/, "g", 1],
  [/^(kg|kgs|kilos?|kilograms?)$/, "g", 1000],
  [/^(in|inch|inches|")$/, "in", 1],
  [/^(oz|ounces?)$/, "oz", 1],
];
// Values that say nothing about an attribute ("n/a" can mean not available
// as easily as not applicable). They read as not stated, so two of them never
// make a match.
const PLACEHOLDERS = new Set([
  "n/a", "na", "n.a.", "-", "--", "?", "unknown", "not known", "tbc", "tba",
  "null", "undefined", "not stated", "not specified", "unspecified",
]);
const MONTHS = /^(months?|mths?|mnths?|mos?|m)$/;
const YEARS = /^(years?|yrs?|y)$/;
const decimal = (text) => Number(text.replace(",", "."));
const tidy = (n) => String(Number(n.toFixed(3)));

/**
 * Canonical size. Examples: "32 cm" and "320mm" give "32cm"; "0-3 months",
 * "0–3 m" and "0 to 3 months" give "0-3 months"; "M" and "Medium" give "m";
 * "Size 10" gives "10". A lone "3m" is read as metres, not months: only a
 * range ("0-3 m") or a spelt-out unit ("3 months") is read as an age.
 * Anything unrecognised keeps its cleaned text, so it still has to be
 * identical on both sides to match.
 */
export function normaliseSize(value) {
  let s = clean(value);
  if (!s) return null;
  s = s.replace(/^(size|sz)\b\s*:?\s*/, "").trim();
  if (!s || PLACEHOLDERS.has(s)) return null;
  if (LETTER.has(s)) return LETTER.get(s);
  if (/^(newborn|new born|nb)$/.test(s)) return "newborn";
  const range = s.match(
    /^(\d+(?:[.,]\d+)?)\s*(?:-|to)\s*(\d+(?:[.,]\d+)?)\s*([a-z]+)$/,
  );
  if (range) {
    const [, from, to, unit] = range;
    if (MONTHS.test(unit)) return `${tidy(decimal(from))}-${tidy(decimal(to))} months`;
    if (YEARS.test(unit)) return `${tidy(decimal(from))}-${tidy(decimal(to))} years`;
  }
  const single = s.match(/^(\d+(?:[.,]\d+)?)\s*([a-z"]+)$/);
  if (single) {
    const [, amount, unit] = single;
    if (/^(months?|mths?|mnths?|mos?)$/.test(unit)) return `${tidy(decimal(amount))} months`;
    if (/^(years?|yrs?)$/.test(unit)) return `${tidy(decimal(amount))} years`;
    for (const [pattern, canonical, factor] of UNITS)
      if (pattern.test(unit)) return tidy(decimal(amount) * factor) + canonical;
  }
  return s
    .replace(/\b(uk|eu|us)\s+(?=\d)/g, "$1")
    .replace(/(\d)\s+(cm|mm|ml|l|g|kg|in)\b/g, "$1$2");
}

/**
 * Pack count as a whole number, or null when the source does not state it.
 * "3-pack", "pack of 3", "3 pack", "x3", "3 x", "3pk", "24 count" and "3"
 * give 3. "single" or "pack of 1" give 1: a single item counts as 1 only when
 * the source says so, never by default. Unrecognised text gives null.
 */
export function normalisePack(value) {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 1 && value <= 10000 ? value : null;
  const s = clean(value);
  if (!s) return null;
  if (/^(single|single item|single unit|single pack|individual|each|one)$/.test(s)) return 1;
  if (/^twin( ?pack)?$/.test(s)) return 2;
  if (/^triple( ?pack)?$/.test(s)) return 3;
  const forms = [
    /^(\d+)$/,
    /^(\d+) ?-? ?(?:pack|pk|pks|packs|count|ct|multipack|multi-pack)$/,
    /^(?:pack|set|box|multipack|multi-pack|bundle) of (\d+)$/,
    /^x ?(\d+)$/,
    /^(\d+) ?x$/,
  ];
  for (const form of forms) {
    const m = s.match(form);
    if (m) {
      const n = Number(m[1]);
      return Number.isSafeInteger(n) && n >= 1 && n <= 10000 ? n : null;
    }
  }
  return null;
}

/**
 * The canonical model value for a product that has no model or part number
 * (most food, for example). Source adapters never produce it from feed text;
 * it comes only from the operator: a manual sale or offer, or an
 * operator-confirmed offer attribute (estimate offerAttributes.model "none").
 *
 * In compare(), NO_MODEL on the offer means the operator has checked that the
 * product has no model number, so a candidate with the same barcode that
 * states no model (null or a placeholder such as "n/a") is treated as having
 * none. A model stated on either side against NO_MODEL on the other still
 * differs, and NO_MODEL on the candidate alone does not cover an offer whose
 * model is unstated: the offer is what is bought, so the confirmation belongs
 * to it.
 */
export const NO_MODEL = "none";
const NO_MODEL_FORMS = new Set(["none", "no model", "no model number", "no model no", "not applicable"]);

/**
 * Canonical model or part number: labels such as "Model:" removed and
 * spaces, hyphens and underscores dropped, so "SX-500" and "sx 500" agree.
 * Dots and slashes are kept because they change meaning ("v1.2" is not "v12").
 * "None", "No model" and "Not applicable" give NO_MODEL; placeholders such as
 * "n/a", "unknown" or "-" give null (not stated).
 */
export function normaliseModel(value) {
  let s = clean(value);
  if (!s) return null;
  s = s.replace(/^(model( no\.?| number)?|mpn|part( no\.?| number)?|ref)\s*:?\s*/, "").trim();
  if (!s || PLACEHOLDERS.has(s)) return null;
  if (NO_MODEL_FORMS.has(s)) return NO_MODEL;
  s = s.replace(/[\s_-]+/g, "");
  return s || null;
}

const CONDITIONS = [
  ["new", ["new", "brand new", "new sealed", "sealed", "factory sealed", "unopened", "new in box", "brand new in box", "bnib", "new in packaging", "bnip"]],
  ["new with tags", ["new with tags", "new with tag", "brand new with tags", "nwt", "bnwt"]],
  ["new without tags", ["new without tags", "new without tag", "brand new without tags", "nwot", "bnwot"]],
  ["new with box", ["new with box", "new with original box"]],
  ["new without box", ["new without box", "new no box", "new unboxed"]],
  ["new other", ["new other", "new other see details", "open box", "opened never used", "opened - never used", "opened but never used"]],
  ["new with defects", ["new with defects", "new with imperfections"]],
  ["used", ["used", "pre-owned", "preowned", "pre owned", "second hand", "secondhand", "second-hand", "worn"]],
  ["refurbished", ["refurbished", "refurb", "seller refurbished", "manufacturer refurbished", "certified refurbished", "renewed"]],
  ["for parts", ["for parts", "for parts or not working", "spares or repair", "spares/repair", "spares repair", "faulty", "not working"]],
];
const CONDITION = new Map(
  CONDITIONS.flatMap(([canonical, forms]) => forms.map((f) => [f, canonical])),
);
export const CONDITION_VOCABULARY = Object.freeze(CONDITIONS.map(([c]) => c));

/**
 * Canonical condition from a fixed vocabulary (CONDITION_VOCABULARY), or null
 * when the text is missing or not recognised. Brackets and trailing
 * punctuation are ignored ("New (other)" is "new other"). An unrecognised
 * condition is never guessed.
 */
export function normaliseCondition(value) {
  const s = clean(value);
  if (!s) return null;
  const key = s
    .replace(/[()[\]!.,:;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return CONDITION.get(key) ?? null;
}

/**
 * True when a record is an acquisition offer sold new by the retailer: kind
 * Retail offer, or an Open Prices observation (provider "openprices").
 */
export function isRetailOffer(row) {
  return Boolean(row) && (row.kind === KIND.RETAIL || row.provider === "openprices");
}

/**
 * Canonical match attributes { barcode, size, pack, model, condition }.
 *
 * Retailers sell new stock, so a retail offer (kind Retail offer, or an Open
 * Prices observation) with no stated condition is treated as "new". A stated
 * but unrecognised condition is left null, not defaulted. Condition is never
 * inferred for sales, listings or any other record: a sale without a stated
 * condition stays null and cannot match exactly.
 */
export function attributes(row = {}) {
  const stated = clean(row.condition);
  return {
    barcode: normaliseBarcode(row.barcode),
    size: normaliseSize(row.size),
    pack: normalisePack(row.pack),
    model: normaliseModel(row.model),
    condition: stated
      ? normaliseCondition(stated)
      : isRetailOffer(row)
        ? "new"
        : null,
  };
}

const ATTRIBUTE_LABELS = { size: "Size", pack: "Pack", model: "Model", condition: "Condition" };
const kindNoun = (row) =>
  row?.kind === KIND.SOLD
    ? "sale"
    : row?.kind === KIND.ASKING
      ? "listing"
      : isRetailOffer(row)
        ? "offer"
        : "record";

const STOPWORDS = new Set([
  "a", "an", "and", "the", "of", "for", "with", "in", "on", "to", "by", "x",
  "uk", "new", "free", "delivery", "&",
]);
// Lower-case word tokens of a title, without common filler words.
export function titleTokens(title) {
  const s = clean(title);
  if (!s) return new Set();
  return new Set(
    s
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
  );
}

/**
 * Titles are similar when they share at least two significant words and the
 * shared words make up at least half of the shorter title. Similarity only
 * ever sends a record to research; it never establishes a match.
 */
export function similarTitles(a, b) {
  const x = titleTokens(a);
  const y = titleTokens(b);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return shared >= 2 && shared / Math.min(x.size, y.size) >= 0.5;
}

/**
 * Compares an offer with a candidate record.
 *
 * Returns { status, reasons } where status is:
 *  "exact"    both barcodes are valid and equal, and size, pack, model and
 *             condition are stated on both and equal after normalisation
 *             (an offer model of NO_MODEL also covers a candidate that
 *             states no model: see NO_MODEL);
 *  "research" the same barcode with any attribute missing, unrecognised or
 *             different (one reason per attribute), a store-assigned barcode,
 *             or a different or missing barcode with a similar title;
 *  "none"     anything else.
 * A similar product always goes to research, never to the sold sample.
 */
export function compare(offer, candidate) {
  const a = attributes(offer);
  const b = attributes(candidate);
  const noun = kindNoun(candidate);
  if (a.barcode && b.barcode && a.barcode === b.barcode) {
    const reasons = [];
    // Operator-confirmed "no model" on the offer covers a candidate that
    // states no model; a model stated on the candidate still differs.
    const noModelCovered = a.model === NO_MODEL && b.model === null;
    if (noModelCovered) b.model = NO_MODEL;
    for (const key of ["size", "pack", "model", "condition"]) {
      const label = ATTRIBUTE_LABELS[key];
      if (a[key] === null || b[key] === null) {
        const side = a[key] === null ? offer : candidate;
        const whose = a[key] === null ? "offer" : noun;
        const raw = clean(side?.[key]);
        reasons.push(
          raw
            ? `${label} "${raw}" on the ${whose} is not recognised`
            : `${label} not stated for the ${whose}`,
        );
      } else if (a[key] !== b[key]) {
        reasons.push(`${label} differs: offer ${a[key]}, ${noun} ${b[key]}`);
      }
    }
    if (isStoreBarcode(a.barcode))
      reasons.push(
        "Store-assigned barcode: the same number can be a different product at another retailer",
      );
    return reasons.length
      ? { status: "research", reasons }
      : {
          status: "exact",
          reasons: [
            "Barcode, size, pack, model and condition match",
            ...(noModelCovered
              ? [`No model number: confirmed for the offer, and the ${noun} states none`]
              : []),
          ],
        };
  }
  const barcodeReason = !a.barcode
    ? "Offer barcode missing or invalid"
    : !b.barcode
      ? `Barcode missing or invalid on the ${noun}`
      : "Different barcode";
  if (similarTitles(offer?.title, candidate?.title))
    return {
      status: "research",
      reasons: [barcodeReason, "Similar product: check it is the same item before use"],
    };
  return { status: "none", reasons: [barcodeReason] };
}

export const rowKey = (row) => `${row.provider}|${row.source_id ?? row.sourceId}`;

// The manual sales importer keeps a listing id given without a seller name
// as "listing:<id>", so the listing stays traceable.
const LISTING_ONLY = /^listing:/;

/**
 * The canonical seller name of a record, or null when no seller is named.
 * A listing id alone ("listing:<id>") is not a seller: one seller can have
 * many listings, so listing ids never count as independent sellers.
 */
export function sellerName(value) {
  const name = clean(value);
  return name === null || LISTING_ONLY.test(name) ? null : name;
}

export const INDEPENDENCE_RULE =
  "Independent sellers are distinct named sellers. Sales with no seller name, including those recorded only by listing id, are not counted as independent.";

// Upper median: with an even count it takes the higher middle value, so an
// estimate of days to sell leans slow rather than fast.
function upperMedian(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

/**
 * Builds the sold sample for an offer from candidate rows.
 *
 * A row enters `used` only when ALL of these hold:
 *  - kind is Reported completed sale (asking prices are resale competition,
 *    retail offers and Amazon history are not sales);
 *  - compare(offer, row) is "exact";
 *  - it is dated, not in the future and no older than maxSaleAgeDays;
 *  - it carries a positive realised total (price, including buyer postage);
 *  - the operator has confirmed it ("provider|sourceId" in `confirmed`).
 * Every other row goes to `excluded` with the first reason that applies.
 *
 * independent counts distinct named sellers among used rows (see
 * sellerName). A sale with no seller name, including one recorded only by
 * its listing id, cannot show independence: such sales are not counted at
 * all, because each could be from a seller already counted. withoutSeller
 * says how many used sales that leaves out, and independenceRule says so in
 * words.
 * daysToSell is the upper median of whole days from listed to observed over
 * used rows that have both dates (null when none do).
 */
export function soldSample(
  offer,
  rows,
  { now = new Date().toISOString(), maxSaleAgeDays = ALERT_RULES.maxSaleAgeDays, confirmed } = {},
) {
  const checked = confirmed instanceof Set ? confirmed : new Set(confirmed ?? []);
  const used = [];
  const excluded = [];
  const seen = new Set();
  const offerKey = offer ? rowKey(offer) : null;
  for (const row of rows ?? []) {
    const key = rowKey(row);
    if (key === offerKey) continue;
    if (seen.has(key)) {
      excluded.push({ row, reason: "Duplicate record" });
      continue;
    }
    seen.add(key);
    const reason = exclusionReason(offer, row, { now, maxSaleAgeDays, checked, key });
    if (reason) excluded.push({ row, reason });
    else used.push(row);
  }
  const sellers = new Set(used.map((r) => sellerName(r.seller)).filter((s) => s !== null));
  const withoutSeller = used.filter((r) => sellerName(r.seller) === null).length;
  const dates = used
    .map((r) => r.observed)
    .sort((x, y) => Date.parse(x) - Date.parse(y));
  const durations = used
    .map((r) => (r.listed && r.observed ? ageDays(r.listed, r.observed) : null))
    .filter((d) => d !== null && d >= 0);
  return {
    used,
    excluded,
    count: used.length,
    independent: sellers.size,
    withoutSeller,
    independenceRule: INDEPENDENCE_RULE,
    lowerMedian: lowerMedian(used.map((r) => r.price)),
    newest: dates.length ? dates[dates.length - 1] : null,
    oldest: dates.length ? dates[0] : null,
    daysToSell: durations.length ? upperMedian(durations) : null,
  };
}

/**
 * Why a row cannot enter the sold sample, or null when it can. Checks run in
 * a fixed order so the most fundamental reason is shown first; confirmation
 * comes last so that only otherwise usable sales ask for it.
 */
export function exclusionReason(offer, row, { now, maxSaleAgeDays = ALERT_RULES.maxSaleAgeDays, checked, key = rowKey(row) }) {
  if (row.kind === KIND.ASKING) return "Active listing: resale competition, not a sale";
  if (row.kind !== KIND.SOLD) return "Not a completed sale";
  const match = compare(offer, row);
  if (match.status !== "exact")
    return "Not an exact match: " + match.reasons.join("; ");
  const age = row.observed ? ageDays(row.observed, now) : null;
  if (age === null) return "Sale date unknown";
  if (age < 0) return "Sale dated in the future";
  if (age > maxSaleAgeDays) return `Sold more than ${maxSaleAgeDays} days ago`;
  if (!Number.isSafeInteger(row.price) || row.price <= 0)
    return "No realised total including buyer postage";
  if (!checked?.has(key)) return "Not confirmed by the operator as the exact variant";
  return null;
}

/**
 * Resale competition for an offer: Active asking price rows with the same
 * valid barcode as the offer (exact matches included). Never touches the
 * sold sample.
 *
 * sellers counts distinct stated sellers plus one for every listing without a
 * seller id: for competition the cautious assumption is that an unknown
 * seller is a different seller. lowestAsking is the lowest asking price plus
 * buyer shipping where shipping is known; lowestAskingIncludesShipping is
 * false when the lowest figure excludes unknown shipping.
 */
export function competition(offer, rows) {
  const gtin = normaliseBarcode(offer?.barcode);
  const listings = gtin
    ? (rows ?? []).filter(
        (r) =>
          r.kind === KIND.ASKING &&
          normaliseBarcode(r.barcode) === gtin &&
          Number.isSafeInteger(r.price) &&
          r.price > 0,
      )
    : [];
  const named = new Set();
  let unnamed = 0;
  let lowest = null;
  for (const r of listings) {
    const seller = sellerName(r.seller);
    if (seller) named.add(seller);
    else unnamed++;
    const shippingKnown = Number.isSafeInteger(r.shipping) && r.shipping >= 0;
    const total = r.price + (shippingKnown ? r.shipping : 0);
    if (
      !lowest ||
      total < lowest.total ||
      (total === lowest.total && shippingKnown && !lowest.shippingKnown)
    )
      lowest = { total, shippingKnown };
  }
  return {
    activeListings: listings.length,
    sellers: named.size + unnamed,
    lowestAsking: lowest ? lowest.total : null,
    lowestAskingIncludesShipping: lowest ? lowest.shippingKnown : null,
  };
}

/**
 * Offer freshness against ALERT_RULES.maxOfferAgeDays: "fresh", "expired",
 * "future" (dated after now) or "unknown" (no usable date). Anything other
 * than fresh counts as expired for a buy decision.
 */
export function offerFreshness(observed, now, maxAgeDays = ALERT_RULES.maxOfferAgeDays) {
  const age = observed ? ageDays(observed, now) : null;
  const freshness =
    age === null ? "unknown" : age < 0 ? "future" : age > maxAgeDays ? "expired" : "fresh";
  return { ageDays: age, freshness, expired: freshness !== "fresh" };
}
