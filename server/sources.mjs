// Source adapters. Each adapter turns one upstream response or file into rows
// shaped like the research table in contract.mjs (or the observations table
// for Open Prices). Adapters are pure: they never touch the database or the
// network, except lookup(), which takes the fetch function as a parameter.
//
// Evidence classes stay distinct here: a feed or catalogue row is a retail
// offer, an eBay Browse row is an active asking price, a manual record is a
// reported completed sale. Nothing in this file turns one into another.
import { parse } from "csv-parse/sync";
import { KIND, LICENCE } from "./contract.mjs";
import { NO_MODEL, normaliseModel } from "./matching.mjs";

// The source register. provider is the key stored in research.provider,
// import_runs.provider and permissions.provider ("openprices" for the
// separate observations table). credential names an environment variable;
// its value is never returned, logged or stored.
export const SOURCES = Object.freeze([
  {
    provider: "openprices",
    name: "Open Prices",
    kind: KIND.RETAIL,
    licence: LICENCE.ODBL,
    mode: "public",
    scheduled: true,
    command: "npm run worker",
    upstream: "https://prices.openfoodfacts.org/api/docs",
  },
  {
    provider: "awin",
    name: "Awin product feed",
    kind: KIND.RETAIL,
    licence: LICENCE.FEED,
    mode: "file",
    command: "npm run research -- awin FILE.csv",
    upstream: "https://help.awin.com/developers/docs/product-feed-publisher-guide-intro",
  },
  {
    provider: "hobnight",
    name: "Hobnight",
    kind: KIND.RETAIL,
    licence: LICENCE.PROVIDER,
    mode: "credential",
    credential: "HOBNIGHT_API_KEY",
    ttlHours: 6,
    command: 'npm run research -- hobnight "QUERY or GTIN"',
    upstream: "https://hobnight.com/openapi.yaml",
  },
  {
    provider: "keepa",
    name: "Keepa",
    kind: KIND.AMAZON,
    licence: LICENCE.PROVIDER,
    mode: "credential",
    credential: "KEEPA_API_KEY",
    ttlHours: 24,
    command: "npm run research -- keepa ASIN",
    upstream: "https://github.com/keepacom/api_backend",
  },
  {
    provider: "ebay",
    name: "eBay Browse",
    kind: KIND.ASKING,
    licence: LICENCE.PROVIDER,
    mode: "credential",
    credential: "EBAY_ACCESS_TOKEN",
    ttlHours: 6,
    command: 'npm run research -- ebay "QUERY or GTIN"',
    upstream:
      "https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search",
  },
  {
    provider: "sales",
    name: "Manual completed sales",
    kind: KIND.SOLD,
    licence: LICENCE.SELF,
    mode: "file",
    command: "npm run research -- sales FILE.json",
    upstream: "https://www.ebay.co.uk/help/selling/selling-tools/terapeak-research?id=4853",
  },
]);
export const PROVIDERS = Object.freeze(SOURCES.map((s) => s.provider));
export const LOOKUP_PROVIDERS = Object.freeze(
  SOURCES.filter((s) => s.mode === "credential").map((s) => s.provider),
);
export const CREDENTIALS = Object.freeze(
  SOURCES.filter((s) => s.credential).map((s) => s.credential),
);
export const sourceFor = (provider) =>
  SOURCES.find((s) => s.provider === provider) || null;

const configured = (env, key) =>
  typeof env[key] === "string" && env[key].trim() !== "";

// Configuration status only. "Credential configured" means a value is set on
// the server, not that the provider accepted it.
export function status(env = process.env) {
  return SOURCES.map((s) => ({
    provider: s.provider,
    name: s.name,
    kind: s.kind,
    licence: s.licence,
    mode: s.mode,
    status:
      s.mode === "credential"
        ? configured(env, s.credential)
          ? "Credential configured"
          : "Needs " + s.credential
        : s.mode === "file"
          ? "Local import"
          : "Public API",
  }));
}

// Removes credential values and token-shaped fragments from text that may be
// logged or stored, such as an upstream error message.
export function redact(text, env = process.env) {
  let out = typeof text === "string" ? text : textOf(text);
  for (const key of CREDENTIALS) {
    const value = typeof env[key] === "string" ? env[key].trim() : "";
    if (value.length >= 6) out = out.split(value).join("[redacted]");
  }
  return out
    .replace(/([?&](?:key|access_token|token)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]");
}

// ---------------------------------------------------------------------------
// Value normalisers. Unknown values become null so that matching fails closed.

// Text of an upstream value that should be text: a string, or a finite
// number written as digits. Anything else (an object, an array, a boolean)
// is not text and gives "", so String() is never called on an object whose
// toString could throw.
function textOf(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return String(value);
  return "";
}

/** Trimmed string or null. Values that are not text or a number are null. */
export function clean(value, max = 500) {
  const s = textOf(value).trim().replace(/\s+/g, " ");
  return s ? s.slice(0, max) : null;
}

/** Match attribute: trimmed lower case, or null when the source does not say. */
export function attr(value) {
  const s = clean(value, 200);
  return s ? s.toLowerCase() : null;
}

/**
 * Decimal pounds (number or string such as "4.95") to integer pence.
 * Returns NaN for anything that is not a plain non-negative decimal, so a
 * malformed price is skipped rather than guessed.
 */
export function pence(value) {
  if (typeof value === "number")
    return Number.isFinite(value) && value >= 0
      ? Math.round(value * 100 + 1e-9)
      : NaN;
  if (typeof value !== "string") return NaN;
  const m = /^\s*(\d+)(?:\.(\d*))?\s*$/.exec(value);
  if (!m) return NaN;
  const frac = (m[2] || "").padEnd(3, "0");
  return Number(m[1]) * 100 + Math.round(Number(frac.slice(0, 3)) / 10);
}

/** Optional money: integer pence, or null when absent or malformed. */
const optionalPence = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const p = pence(value);
  return Number.isSafeInteger(p) && p >= 0 ? p : null;
};

/**
 * A GTIN (EAN-8, UPC-A, EAN-13 or GTIN-14) with a valid check digit, as a
 * digit string. Spaces and hyphens are removed. Anything else is null: a
 * mistyped barcode would otherwise match a different product.
 */
export function gtin(value) {
  const s = textOf(value).trim().replace(/[\s-]/g, "");
  if (!/^(\d{8}|\d{12,14})$/.test(s)) return null;
  let sum = 0;
  for (let i = s.length - 2, w = 3; i >= 0; i--, w = 4 - w)
    sum += Number(s[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(s[s.length - 1]) ? s : null;
}
const looksLikeGtin = (query) => /^(\d{8}|\d{12,14})$/.test(query);

/**
 * Source timestamp to ISO 8601. A calendar date stays YYYY-MM-DD. A date and
 * time without a zone (Awin's "2026-10-30 14:05:00") is read as UTC, which
 * can be up to an hour out during British Summer Time: well inside the
 * seven-day freshness rule. Unparseable values are null.
 */
export function isoTime(value) {
  const s = clean(value, 64);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s))
    return Number.isFinite(Date.parse(s + "T00:00:00Z")) &&
      new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s
      ? s
      : null;
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(s);
  const t = Date.parse(local ? local[1] + "T" + local[2] + "Z" : s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
const gbp = (value) => clean(value)?.toUpperCase() === "GBP";

/** Calendar date as YYYY-MM-DD when valid, else null. */
function calendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return null;
  const t = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value
    ? value
    : null;
}

/**
 * A model or part number from a feed or provider, or null. A feed's "N/A",
 * "none" or "-" is a placeholder rather than a statement that the product
 * has no model, so it stays unknown: only a manual sale or an
 * operator-confirmed attribute can say "no model" (matching.mjs NO_MODEL).
 */
export function feedModel(value) {
  const canonical = normaliseModel(clean(value, 200));
  return canonical === null || canonical === NO_MODEL ? null : attr(value);
}

/**
 * A pack count given as structured data: a whole number of items from 1 to
 * 10000 (Keepa packageQuantity, for example). Text such as "6 x 330ml" in a
 * title or size is never read as a pack, and 0 or -1 (Keepa's "not
 * available") is null.
 */
export function structuredPack(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 10000 ? String(value) : null;
}

// A row with every research column the adapters fill. Missing values are
// null, never empty strings.
function researchRow(fields) {
  return {
    source_id: null,
    kind: null,
    title: null,
    barcode: null,
    variant: null,
    size: null,
    pack: null,
    model: null,
    condition: null,
    price: NaN,
    shipping: null,
    observed: null,
    listed: null,
    retailer: null,
    location: null,
    availability: null,
    promotion: null,
    seller: null,
    url: null,
    licence: null,
    ...fields,
  };
}

// ---------------------------------------------------------------------------
// Awin product feed (decompressed CSV).

const AWIN_REQUIRED = ["aw_product_id", "product_name", "currency", "search_price"];

function awinAvailability(row) {
  const flag = clean(row.in_stock)?.toLowerCase();
  const fromFlag =
    flag === undefined || flag === null
      ? null
      : ["1", "yes", "true", "y", "in stock", "in_stock"].includes(flag)
        ? "in_stock"
        : ["0", "no", "false", "n", "out of stock", "out_of_stock"].includes(flag)
          ? "out_of_stock"
          : null;
  const qty = clean(row.stock_quantity);
  const fromQty =
    qty !== null && /^\d+$/.test(qty)
      ? Number(qty) > 0
        ? "in_stock"
        : "out_of_stock"
      : null;
  // When the flag and the quantity disagree, trust the cautious one.
  if (fromFlag === "out_of_stock" || fromQty === "out_of_stock")
    return "out_of_stock";
  return fromFlag || fromQty;
}

/**
 * Awin advertiser feed rows (GBP only) as retail offers. A feed describes an
 * online offer: location stays null because a feed never establishes branch
 * stock, and availability is the feed's own claim.
 */
export function awin(text) {
  const rows = parse(text, {
    bom: true,
    skip_empty_lines: true,
    trim: true,
    columns: (header) => {
      const names = header.map((h) => String(h).trim());
      const missing = AWIN_REQUIRED.filter((k) => !names.includes(k));
      if (missing.length)
        throw Error("Invalid Awin feed columns: missing " + missing.join(", "));
      return names;
    },
  });
  return rows
    .filter((r) => gbp(r.currency))
    .map((r) =>
      researchRow({
        source_id: clean(r.aw_product_id, 200),
        kind: KIND.RETAIL,
        title: clean(r.product_name),
        barcode:
          gtin(r.ean) || gtin(r.product_GTIN) || gtin(r.gtin) || gtin(r.upc),
        variant: clean(r.colour ?? r.color, 200),
        // Awin's feed columns have no pack count: pack stays unknown (null)
        // until an operator confirms it. A pack in the product name is
        // never read.
        size: attr(r["Fashion:size"] ?? r.size),
        model: feedModel(r.model_number) ?? feedModel(r.mpn) ?? feedModel(r.product_model),
        condition: attr(r.condition),
        price: pence(r.search_price),
        shipping: optionalPence(r.delivery_cost),
        observed: isoTime(r.last_updated),
        retailer: clean(r.merchant_name, 200),
        location: null,
        availability: awinAvailability(r),
        promotion: clean(r.promotional_text, 300),
        url: clean(r.merchant_deep_link || r.aw_deep_link, 2000),
        licence: LICENCE.FEED,
        // The retailer's claimed prices, from Awin's structured columns only:
        // product_price_old is the previous price (Awin leaves it empty unless
        // it is above the current price) and rrp_price the recommended retail
        // price. They are claims for display beside the price history, never
        // the cost: unlike Open Prices regular_price they are not a price
        // anyone pays now. Stored once the research table has these columns.
        was_price: claimedPence(r.product_price_old),
        rrp_price: claimedPence(r.rrp_price),
      }),
    );
}

/** A claimed price in pence when the source gives a positive amount, else null. */
export function claimedPence(value) {
  const p = optionalPence(value);
  return p !== null && p > 0 ? p : null;
}

// ---------------------------------------------------------------------------
// Hobnight supermarket catalogue (GET /api/products).

const HOBNIGHT_AVAILABILITY = new Set(["in_stock", "out_of_stock", "discontinued"]);

/**
 * Hobnight products (GBP, UK region) as retail offers. Online catalogue
 * evidence: the branch is unknown, so location is always null. Supermarket
 * catalogue items are sold new.
 */
export function hobnight(body) {
  if (!body || !Array.isArray(body.data)) throw Error("Unexpected Hobnight response");
  return body.data
    .filter(
      (r) =>
        r &&
        gbp(r.currency) &&
        (!r.supermarket?.region || r.supermarket.region === "uk"),
    )
    .map((r) =>
      researchRow({
        // Hobnight products state a size but no pack count or model.
        source_id: clean(r.id, 200),
        kind: KIND.RETAIL,
        title: clean(r.name),
        barcode: gtin(r.gtin),
        size: attr(r.size),
        condition: "new",
        price: pence(r.price),
        observed: isoTime(r.last_scraped_at),
        retailer: clean(r.supermarket?.name, 200),
        location: null,
        availability: HOBNIGHT_AVAILABILITY.has(r.availability)
          ? r.availability
          : null,
        url: clean(r.url, 2000),
        licence: LICENCE.PROVIDER,
      }),
    );
}

// ---------------------------------------------------------------------------
// Keepa product history (domain 2, Amazon.co.uk).

// Keepa time is minutes since 2011-01-01T00:00:00Z.
const KEEPA_EPOCH_MINUTES = 21564000;

/**
 * Keepa csv[0] (Amazon as seller) price points as Amazon offer history.
 * Each time point is its own record. A price of -1 means no Amazon offer at
 * that time and is skipped. Keepa's { error } body is raised as a failure.
 */
export function keepa(body) {
  if (body?.error)
    throw Error(
      "Keepa error: " +
        (clean(body.error.message, 300) || "unknown") +
        (body.error.type ? " (" + body.error.type + ")" : ""),
    );
  if (!body || !Array.isArray(body.products)) throw Error("Unexpected Keepa response");
  return body.products.flatMap((p) => {
    if (typeof p?.asin !== "string" || !p.asin) return [];
    const series = Array.isArray(p.csv?.[0]) ? p.csv[0] : [];
    const rows = [];
    for (let i = 0; i + 1 < series.length; i += 2) {
      const [time, price] = [series[i], series[i + 1]];
      if (!Number.isSafeInteger(time) || !Number.isSafeInteger(price) || price <= 0)
        continue;
      rows.push(
        researchRow({
          source_id: p.asin + "@" + time,
          kind: KIND.AMAZON,
          title: clean(p.title),
          barcode: gtin(p.eanList?.[0]) || gtin(p.upcList?.[0]),
          variant: clean(p.color, 200),
          size: attr(p.size),
          // Keepa's packageQuantity is a structured count of items in the
          // package (0 or -1 when Amazon does not give one).
          pack: structuredPack(p.packageQuantity),
          model: feedModel(p.model),
          condition: "new",
          price,
          observed: new Date((time + KEEPA_EPOCH_MINUTES) * 60000).toISOString(),
          retailer: "Amazon UK",
          location: null,
          url: "https://www.amazon.co.uk/dp/" + p.asin,
          licence: LICENCE.PROVIDER,
        }),
      );
    }
    return rows;
  });
}

// ---------------------------------------------------------------------------
// eBay Browse item_summary/search (active listings only).

/** Lowest GBP shipping cost the listing offers, or null when none is stated. */
function ebayShipping(options) {
  if (!Array.isArray(options)) return null;
  const costs = options
    .map((o) => o?.shippingCost)
    .filter((c) => c && gbp(c.currency))
    .map((c) => pence(c.value))
    .filter((p) => Number.isSafeInteger(p) && p >= 0);
  return costs.length ? Math.min(...costs) : null;
}

/**
 * eBay Browse results as active asking prices. These are what competing
 * sellers hope to get, never what buyers paid, so they are never sales.
 * price excludes shipping; shipping is the cheapest stated GBP option.
 * When the search was by GTIN, eBay matched the listings to that GTIN, so
 * the queried GTIN is recorded as the barcode unless the item states one.
 */
export function ebayBrowse(body, { gtin: queried = null } = {}) {
  if (!body || (!Array.isArray(body.itemSummaries) && body.total !== 0))
    throw Error("Unexpected eBay Browse response");
  return (body.itemSummaries || [])
    .filter(
      (r) =>
        r &&
        gbp(r.price?.currency) &&
        (!Array.isArray(r.buyingOptions) || r.buyingOptions.includes("FIXED_PRICE")),
    )
    .map((r) =>
      researchRow({
        source_id: clean(r.itemId, 200),
        kind: KIND.ASKING,
        title: clean(r.title),
        barcode: gtin(r.gtin) || gtin(queried),
        condition: attr(r.condition),
        price: pence(r.price.value),
        shipping: ebayShipping(r.shippingOptions),
        observed: isoTime(r.itemCreationDate),
        retailer: "eBay UK",
        location: null,
        seller: clean(r.seller?.username, 200),
        url: clean(r.itemWebUrl, 2000),
        licence: LICENCE.PROVIDER,
      }),
    );
}

// ---------------------------------------------------------------------------
// Manually researched completed sales (JSON array).

const text = (value) => (typeof value === "string" ? clean(value) : null);
const optionalText = (r, key, i) => {
  if (r[key] === undefined || r[key] === null || r[key] === "") return null;
  if (typeof r[key] !== "string" || !r[key].trim())
    throw Error(`Invalid manual sale at index ${i}: ${key} must be text`);
  return r[key];
};

/**
 * Validates a whole file of manually checked completed sales. Any invalid
 * record rejects the file, naming its index, so a partial import never hides
 * a mistake. totalPence is what the buyer actually paid including postage.
 */
export function sold(input, { now = new Date() } = {}) {
  if (!Array.isArray(input)) throw Error("Expected a JSON array of sales");
  const today = new Date(now).toISOString().slice(0, 10);
  const seen = new Set();
  return input.map((r, i) => {
    const bad = (reason) => {
      throw Error(`Invalid manual sale at index ${i}: ${reason}`);
    };
    if (!r || typeof r !== "object" || Array.isArray(r)) bad("not an object");
    const reference = text(r.reference);
    if (!reference) bad("reference is required");
    if (seen.has(reference)) bad("reference " + reference + " appears twice");
    seen.add(reference);
    const title = text(r.title);
    if (!title) bad("title is required");
    const variant = text(r.variant);
    if (!variant) bad("variant (the exact variant sold) is required");
    const barcode = typeof r.barcode === "string" ? gtin(r.barcode) : null;
    if (!barcode || barcode !== r.barcode.trim())
      bad("barcode must be an 8, 12, 13 or 14 digit GTIN with a valid check digit");
    const condition = attr(text(r.condition));
    if (!condition) bad("condition is required");
    if (r.currency !== "GBP") bad("currency must be GBP");
    if (!Number.isSafeInteger(r.totalPence) || r.totalPence <= 0)
      bad("totalPence must be a positive whole number of pence including buyer postage");
    const soldDate = calendarDate(r.soldDate);
    if (!soldDate) bad("soldDate must be a calendar date (YYYY-MM-DD)");
    if (soldDate > today) bad("soldDate is in the future");
    let listed = null;
    if (r.listedDate !== undefined && r.listedDate !== null && r.listedDate !== "") {
      listed = calendarDate(r.listedDate);
      if (!listed) bad("listedDate must be a calendar date (YYYY-MM-DD)");
      if (listed > soldDate) bad("listedDate is after soldDate");
    }
    let shipping = null;
    if (r.postagePence !== undefined && r.postagePence !== null) {
      if (
        !Number.isSafeInteger(r.postagePence) ||
        r.postagePence < 0 ||
        r.postagePence > r.totalPence
      )
        bad("postagePence must be a whole number from 0 to totalPence");
      shipping = r.postagePence;
    }
    const seller = optionalText(r, "seller", i);
    const listingId = optionalText(r, "listingId", i);
    const url = optionalText(r, "url", i);
    if (url && !/^https:\/\//.test(url.trim())) bad("url must start with https://");
    return researchRow({
      source_id: reference,
      kind: KIND.SOLD,
      title,
      barcode,
      variant,
      size: attr(optionalText(r, "size", i)),
      pack: attr(optionalText(r, "pack", i)),
      model: attr(optionalText(r, "model", i)),
      condition,
      price: r.totalPence,
      shipping,
      observed: soldDate,
      listed,
      retailer: "eBay UK",
      // A seller name counts independent sellers. A listing id alone is kept
      // with a prefix so it is never mistaken for a seller name.
      seller: clean(seller, 200) || (listingId ? "listing:" + clean(listingId, 200) : null),
      url: clean(url, 2000),
      licence: LICENCE.SELF,
    });
  });
}

// ---------------------------------------------------------------------------
// Open Prices (ODbL) observations for the observations table.

/**
 * One Open Prices /api/v1/prices page to observation rows. Keeps GB
 * locations priced in GBP, skips rows flagged as duplicates and non-positive
 * prices. day is the observation date; import times are added on save.
 */
export function openPrices(body) {
  if (!body || !Array.isArray(body.items)) throw Error("Unexpected Open Prices response");
  return body.items
    .filter(
      (r) =>
        r &&
        Number.isSafeInteger(r.id) &&
        gbp(r.currency) &&
        r.location?.osm_address_country_code === "GB" &&
        !r.duplicate_of &&
        pence(r.price) > 0,
    )
    .map((r) => {
      const loc = r.location || {};
      const product = r.product || {};
      const osmType = clean(loc.osm_type ?? r.location_osm_type);
      const osmId = loc.osm_id ?? r.location_osm_id;
      const quantity =
        clean(product.quantity, 100) ||
        (clean(product.product_quantity)
          ? clean(textOf(product.product_quantity) + " " + textOf(product.product_quantity_unit), 100)
          : null);
      return {
        id: r.id,
        title:
          clean(r.product_name) ||
          clean(product.product_name) ||
          clean(r.category_tag) ||
          clean(r.product_code) ||
          "Unlabelled item",
        store: clean(loc.osm_name || loc.osm_brand, 200),
        place: clean(loc.osm_address_postcode, 20),
        city: clean(loc.osm_address_city, 100),
        osm_id: osmType && clean(osmId, 40) ? osmType.toLowerCase() + "/" + clean(osmId, 40) : null,
        price: pence(r.price),
        regular_price: optionalPence(r.price_without_discount),
        discounted: r.price_is_discounted === true ? 1 : 0,
        discount_type: clean(r.discount_type, 100),
        day: calendarDate(r.date),
        unit: clean(r.price_per, 40),
        quantity,
        barcode: clean(r.product_code, 40),
        proof_id: clean(r.proof_id, 40),
        licence: LICENCE.ODBL,
      };
    });
}

// ---------------------------------------------------------------------------
// Credentialed lookups. Explicitly triggered from the research CLI only.

export class SourceError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
    // Network failures, rate limits and upstream faults may succeed later.
    this.transient = status === null || status === 429 || status >= 500;
  }
}

/**
 * The request a lookup sends, without sending it. Pure, for tests and for
 * checking request shapes against the published specifications.
 */
export function lookupRequest(provider, query, env = process.env) {
  const source = sourceFor(provider);
  if (!source || source.mode !== "credential")
    throw Error("Unknown lookup provider " + provider);
  if (!configured(env, source.credential)) throw Error("Missing " + source.credential);
  const key = env[source.credential].trim();
  const term = typeof query === "string" ? query.trim() : "";
  if (!term) throw Error("Supply a search term, GTIN or ASIN");
  const headers = { Accept: "application/json" };
  let url;
  if (provider === "keepa") {
    if (!/^[A-Z0-9]{10}$/.test(term)) throw Error("Supply a ten-character ASIN");
    url = new URL("https://api.keepa.com/product");
    url.search = new URLSearchParams({
      key,
      domain: "2",
      asin: term,
      history: "1",
      days: "90",
    }).toString();
  } else if (provider === "hobnight") {
    if (term.length > 200) throw Error("Hobnight search terms are limited to 200 characters");
    url = new URL("https://api.hobnight.com/api/products");
    url.searchParams.set("region", "uk");
    url.searchParams.set("per_page", "100");
    url.searchParams.set(looksLikeGtin(term) ? "gtin" : "q", term);
    headers.Authorization = "Bearer " + key;
  } else {
    if (term.length > 100) throw Error("eBay search terms are limited to 100 characters");
    url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
    // eBay documents that gtin must not be combined with q.
    url.searchParams.set(looksLikeGtin(term) ? "gtin" : "q", term);
    url.searchParams.set("limit", "200");
    url.searchParams.set("filter", "itemLocationCountry:GB");
    headers.Authorization = "Bearer " + key;
    headers["X-EBAY-C-MARKETPLACE-ID"] = "EBAY_GB";
  }
  return { url, headers, gtin: looksLikeGtin(term) ? term : null };
}

// Upstream error text: Keepa { error: { message, type } }, Hobnight
// { message }, eBay { errors: [{ message, longMessage }] }.
function upstreamDetail(body) {
  if (!body || typeof body !== "object") return null;
  if (typeof body.error === "string") return clean(body.error, 300);
  if (body.error && typeof body.error === "object") {
    const message = clean(body.error.message, 300) || "unknown error";
    return message + (body.error.type ? " (" + clean(body.error.type, 60) + ")" : "");
  }
  if (Array.isArray(body.errors) && body.errors.length)
    return clean(body.errors[0]?.longMessage, 300) || clean(body.errors[0]?.message, 300);
  return clean(body.message, 300);
}

/**
 * Runs one credentialed lookup and returns research rows. Errors name the
 * provider, HTTP status and upstream message, and never the token.
 */
export async function lookup(provider, query, env = process.env, request = fetch) {
  const { url, headers, gtin: queried } = lookupRequest(provider, query, env);
  const label = sourceFor(provider).name;
  let res;
  try {
    res = await request(url, {
      headers,
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
  } catch (error) {
    throw new SourceError(
      redact(label + " request failed: " + (error?.cause?.code || error?.message || error), env),
    );
  }
  const raw = await res.text();
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const detail = upstreamDetail(body);
    throw new SourceError(
      redact(label + " request failed (HTTP " + res.status + ")" + (detail ? ": " + detail : ""), env),
      res.status,
    );
  }
  if (body === null) throw new SourceError(label + " returned a response that is not JSON", res.status);
  if (provider === "hobnight") return hobnight(body);
  if (provider === "keepa") return keepa(body);
  return ebayBrowse(body, { gtin: queried });
}
