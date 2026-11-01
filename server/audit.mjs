// Validation audit for the "Real buying alerts" gate: in the pilot locality
// (one London borough, still to be chosen), check 30 barcoded items against
// retailer and actual sold evidence.
//
// availability_checks are dated branch stock checks made by a person (in
// store, by phone or on the retailer's own branch stock page). They are the
// only evidence that confirms local stock: affiliate feeds and online
// catalogues never do, and a check only counts for the locality it was made
// in.
//
// validation_items are the audited items. An item passes only on stored
// evidence: the retailer offer in the database, the completed sales the
// operator confirmed as the exact variant, the estimate built from them
// (estimate.mjs estimateFromEvidence) and the display permission it reads.
// Figures the operator types (days to sell, independent sales, display
// permission, match decision) are their own reading: they never replace the
// evidence, and one that disagrees with it fails the item. Anything unknown
// fails closed.
//
// Each item keeps a copy of the offer fields the audit judged (provider,
// source id, price, observed date, retailer and barcode, in audited_offer),
// and is always judged on that copy, so a later feed import that changes the
// live offer never changes the result. A changed live offer is reported
// beside the item (evidence.offerChange), not folded into it.
//
// An item counts towards the 30 (isEvidenced) only with a recorded offer, at
// least one confirmed exact sale and a branch check in the audit locality,
// and stored evidence that read without an error and is not sample data.
//
// audit_signoffs records the operator's acceptance of a complete audit in a
// locality: when, and the passed and evidenced counts they accepted. A
// sign-off records that the operator reviewed the result; it does not make
// the figures proven. It needs a complete audit with at least
// AUDIT_RULES.minPassedToSignOff items passed, and bounties keep showing
// the pass count after it.
//
// estimate.mjs imports this module too (stockStatus, CHECK_VALID_DAYS,
// tableExists). The cycle is safe because neither module uses the other's
// exports at the top level, only inside functions.
import { addMissingColumns } from "./contract.mjs";
import { ALERT_RULES } from "./alerts.mjs";
import { normaliseBarcode } from "./matching.mjs";
import { HttpError, bool, fail, int, num, oneOf, text, transaction } from "./http.mjs";
import { ensureFunctions, estimateFromEvidence, findOffer, validateEstimateRequest } from "./estimate.mjs";

export const AUDIT_RULES = Object.freeze({
  // Items with stored evidence needed in the pilot locality (the PRD's 30).
  target: 30,
  // The fewest passed items a sign-off accepts. 1 is a floor, not a pass
  // rate: the bar is an open decision for Edem, so change it here once it is
  // agreed. Below it the sign-off is refused (409), and a standing sign-off
  // lapses.
  minPassedToSignOff: 1,
});
export const AUDIT_TARGET = AUDIT_RULES.target;
export const CHECK_METHODS = Object.freeze(["in_store", "phone", "retailer_branch_page"]);
export const MATCH_DECISIONS = Object.freeze(["exact", "research", "none"]);
// A stock check stays usable for this long. Shelves change quickly, so an
// older check no longer confirms stock for a trip.
export const CHECK_VALID_DAYS = 2;
// Estimate tiers that can produce a buy alert (opportunity.mjs).
export const PASSING_TIERS = Object.freeze(["Priority 1", "Priority 2"]);
const DAY = 86400000;
const MAX_SALES = 500;

const CHECKS_TABLE = `CREATE TABLE IF NOT EXISTS availability_checks (
 id INTEGER PRIMARY KEY,
 barcode TEXT NOT NULL,
 retailer TEXT NOT NULL COLLATE NOCASE,
 locality TEXT NOT NULL COLLATE NOCASE,
 checked_at TEXT NOT NULL,
 method TEXT NOT NULL,
 in_stock INTEGER NOT NULL,
 units_seen INTEGER,
 note TEXT,
 created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 branch TEXT,
 price_pence INTEGER
)`;
// branch is the shop as the person identified it (name and street or
// postcode, or an OpenStreetMap id); price_pence the shelf price for one
// unit seen on that check. Both are optional: older checks have neither.
const CHECK_COLUMNS = [
  "id", "barcode", "retailer", "locality", "checked_at", "method", "in_stock",
  "units_seen", "note", "created", "branch", "price_pence",
];
const CHECK_TYPES = { in_stock: "INTEGER", units_seen: "INTEGER", created: "TEXT", price_pence: "INTEGER" };
// The highest shelf price a check accepts, in pence (£100,000, the most an
// estimate accepts for any amount).
export const MAX_SHELF_PRICE_PENCE = 10_000_000;

// sales is a JSON array of { provider, sourceId }: the completed sales the
// operator confirmed as the exact variant. estimate_inputs is a JSON object
// of further estimate request fields (costs, rules, units and any later
// additions), so the audited tier is the one the operator saw in Research.
// audited_offer is a JSON copy of the offer fields the audit judged:
// { provider, sourceId, price, observed, retailer, barcode, copiedAt,
// migrated } (see offerCopyOf).
const ITEMS_TABLE = `CREATE TABLE IF NOT EXISTS validation_items (
 id INTEGER PRIMARY KEY,
 locality TEXT NOT NULL COLLATE NOCASE,
 barcode TEXT NOT NULL,
 title TEXT NOT NULL,
 retailer TEXT NOT NULL COLLATE NOCASE,
 offer_provider TEXT,
 offer_source_id TEXT,
 availability_check_id INTEGER REFERENCES availability_checks(id),
 promotion TEXT,
 promotion_eligible INTEGER,
 shipping INTEGER,
 days_to_sell INTEGER,
 independent_sales INTEGER,
 display_permitted INTEGER,
 match_decision TEXT,
 notes TEXT,
 sales TEXT,
 weight_kg REAL,
 estimate_inputs TEXT,
 audited_offer TEXT,
 created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(locality, barcode)
)`;
const ITEM_COLUMNS = [
  "id", "locality", "barcode", "title", "retailer", "offer_provider",
  "offer_source_id", "availability_check_id", "promotion",
  "promotion_eligible", "shipping", "days_to_sell", "independent_sales",
  "display_permitted", "match_decision", "notes", "sales", "weight_kg",
  "estimate_inputs", "audited_offer", "created", "updated",
];
const SIGNOFFS_TABLE = `CREATE TABLE IF NOT EXISTS audit_signoffs (
 id INTEGER PRIMARY KEY,
 locality TEXT NOT NULL COLLATE NOCASE,
 signed_at TEXT NOT NULL,
 target INTEGER NOT NULL,
 audited INTEGER NOT NULL,
 evidenced INTEGER NOT NULL,
 passed INTEGER NOT NULL,
 note TEXT
)`;
const SIGNOFF_COLUMNS = ["id", "locality", "signed_at", "target", "audited", "evidenced", "passed", "note"];
const SIGNOFF_TYPES = { target: "INTEGER", audited: "INTEGER", evidenced: "INTEGER", passed: "INTEGER" };

const ITEM_TYPES = {
  availability_check_id: "INTEGER",
  promotion_eligible: "INTEGER",
  shipping: "INTEGER",
  days_to_sell: "INTEGER",
  independent_sales: "INTEGER",
  display_permitted: "INTEGER",
  weight_kg: "REAL",
  created: "TEXT",
  updated: "TEXT",
};

// Idempotent. Older local databases gain any missing column in place.
export function schema(db) {
  db.exec(CHECKS_TABLE);
  addMissingColumns(db, "availability_checks", CHECK_COLUMNS, CHECK_TYPES);
  db.exec(ITEMS_TABLE);
  addMissingColumns(db, "validation_items", ITEM_COLUMNS, ITEM_TYPES);
  db.exec(SIGNOFFS_TABLE);
  addMissingColumns(db, "audit_signoffs", SIGNOFF_COLUMNS, SIGNOFF_TYPES);
  db.exec(`CREATE INDEX IF NOT EXISTS availability_checks_lookup
 ON availability_checks(barcode, retailer, checked_at);
CREATE INDEX IF NOT EXISTS validation_items_locality ON validation_items(locality);
CREATE INDEX IF NOT EXISTS audit_signoffs_locality ON audit_signoffs(locality, signed_at);
UPDATE validation_items SET created = COALESCE(created, CURRENT_TIMESTAMP) WHERE created IS NULL;
UPDATE validation_items SET updated = COALESCE(updated, created) WHERE updated IS NULL;`);
  copyMissingOffers(db);
}

// Items saved before the audit kept its own copy of the offer get one now,
// from the offer as it stands (the closest record left of what was judged),
// marked migrated. updated is left alone, so a standing sign-off does not
// lapse. An offer that can no longer be read gets no copy and its item keeps
// failing with that error. Needs the evidence tables, which db.mjs creates
// first.
function copyMissingOffers(db) {
  const rows = db
    .prepare(
      `SELECT id, offer_provider, offer_source_id FROM validation_items
 WHERE audited_offer IS NULL AND offer_provider IS NOT NULL AND offer_source_id IS NOT NULL`,
    )
    .all();
  if (!rows.length) return;
  const now = new Date().toISOString();
  const save = db.prepare("UPDATE validation_items SET audited_offer = ? WHERE id = ? AND audited_offer IS NULL");
  for (const row of rows) {
    let offer;
    try {
      offer = findOffer(db, row.offer_provider, row.offer_source_id, now);
    } catch (error) {
      if (error instanceof HttpError) continue;
      throw error;
    }
    save.run(JSON.stringify(offerCopyOf(offer, now, { migrated: true })), row.id);
  }
}

// A function declaration, so it is usable while the estimate.mjs cycle loads.
export function tableExists(db, name) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

const plain = (row) => (row ? { ...row } : null);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const trimmed = (value) => (typeof value === "string" ? value.trim() : "");
const same = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();

// Blank means not entered: missing, null, or text with nothing but spaces.
const isBlank = (value) => value === undefined || value === null || (typeof value === "string" && !value.trim());

// ISO timestamp in canonical UTC form, so stored values sort as text. A blank
// value is the server's time now.
function timestamp(value, name, now) {
  if (!Number.isFinite(Date.parse(now))) throw Error("now must be a date and time");
  if (isBlank(value)) return new Date(Date.parse(now)).toISOString();
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(at)) fail(`${name} must be a date and time`);
  // Allow for small clock differences between the browser and the API.
  if (at > Date.parse(now) + 5 * 60000) fail(`${name} cannot be in the future`);
  return new Date(at).toISOString();
}

const barcodeOf = (value, name = "barcode") => {
  if (value === undefined || value === null || value === "") fail(`${name} is required`);
  return (
    normaliseBarcode(value) ??
    fail(`${name} must be a valid 8, 12, 13 or 14 digit barcode with a correct check digit`)
  );
};
const optionalInt = (value, name, min, max) =>
  value === undefined || value === null || value === "" ? null : int(value, name, min, max);
const optionalBool = (value, name) =>
  value === undefined || value === null ? null : bool(value, name) ? 1 : 0;

// Dates and times for people, in UK time: "31 Oct 2026" and
// "31 Oct 2026, 21:20".
const LONDON_DAY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "numeric",
  month: "short",
  year: "numeric",
});
const LONDON_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const dayOf = (iso) => (Number.isFinite(Date.parse(iso)) ? LONDON_DAY.format(new Date(Date.parse(iso))) : "an unknown date");
const timeOf = (iso) => (Number.isFinite(Date.parse(iso)) ? LONDON_TIME.format(new Date(Date.parse(iso))) : "an unknown time");
const pounds = (pence) => (Number.isSafeInteger(pence) ? "£" + (pence / 100).toFixed(2) : "no price");
const seenText = (inStock, unitsSeen) =>
  !inStock ? "none found" : Number.isSafeInteger(unitsSeen) && unitsSeen > 0 ? `${unitsSeen} seen` : "stock seen";

/**
 * The newest other evidence of a shelf: a branch check for the same
 * barcode, retailer and locality (other than exceptId), or a member's stock
 * report on a bounty for the same item there (reports the operator marked
 * inaccurate are left out, as bounties leave them out). Returns
 * { kind: "check" | "report", id, at, inStock, unitsSeen } or null.
 */
export function newestShelfEvidence(db, { barcode, retailer, locality, exceptId = null }) {
  const gtin = normaliseBarcode(barcode);
  const shop = trimmed(retailer);
  const place = trimmed(locality);
  if (!gtin || !shop || !place || !tableExists(db, "availability_checks")) return null;
  const check = db
    .prepare(
      `SELECT id, checked_at, in_stock, units_seen FROM availability_checks
 WHERE barcode = ? AND retailer = ? AND locality = ? AND id IS NOT ?
 ORDER BY checked_at DESC, id DESC LIMIT 1`,
    )
    .get(gtin, shop, place, exceptId);
  let newest = check
    ? { kind: "check", id: check.id, at: check.checked_at, inStock: check.in_stock === 1, unitsSeen: check.units_seen ?? null }
    : null;
  if (tableExists(db, "stock_reports") && tableExists(db, "bounties")) {
    const report = db
      .prepare(
        `SELECT r.id, r.observed_at, r.units_seen FROM stock_reports r JOIN bounties b ON b.id = r.bounty_id
 WHERE b.barcode = ? AND lower(trim(b.retailer)) = lower(?) AND lower(trim(b.locality)) = lower(?)
 AND (r.verified IS NULL OR r.verified != 'inaccurate')
 ORDER BY r.observed_at DESC, r.id DESC LIMIT 1`,
      )
      .get(gtin, shop, place);
    if (report && (!newest || Date.parse(report.observed_at) > Date.parse(newest.at)))
      newest = {
        kind: "report",
        id: report.id,
        at: report.observed_at,
        inStock: report.units_seen > 0,
        unitsSeen: report.units_seen,
      };
  }
  return newest;
}

// ---------------------------------------------------------------------------
// Which branch a check covers. A locality is a town or borough, which can
// hold several branches of one retailer, so a check may also name the
// branch: the shop's name and street or postcode, or its OpenStreetMap id
// (the id Open Prices records for the shop where a price was seen).

// "node/123", "way:456", or an openstreetmap.org link to one.
const OSM_ID = /(?:^|[^a-z])(node|way|relation)\s*[/:]\s*(\d{1,15})(?!\d)/i;
// A full UK postcode: an outward code and an inward code ("NW1 7AA").
const POSTCODE = /(?:^|[^a-z0-9])([a-z]{1,2}\d[a-z\d]?)\s*(\d[a-z]{2})(?![a-z0-9])/i;
const spaced = (value) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLowerCase() : "");

/** An OpenStreetMap id in the form Open Prices stores ("node/123"), or null. */
export function osmIdOf(value) {
  const m = typeof value === "string" ? OSM_ID.exec(value) : null;
  return m ? `${m[1].toLowerCase()}/${m[2]}` : null;
}

/** A full UK postcode in value, upper case with one space ("NW1 7AA"), or null. */
export function postcodeOf(value) {
  const m = typeof value === "string" ? POSTCODE.exec(value) : null;
  return m ? `${m[1].toUpperCase()} ${m[2].toUpperCase()}` : null;
}

/**
 * The branch a check names, from its branch text: { text, osmId, postcode,
 * named }. named is false for a check that names no branch. A borough or
 * town name gives neither an OpenStreetMap id nor a postcode, so it can
 * never be matched to a shop.
 */
export function branchIdentity(value) {
  const text = typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ") : null;
  return { text, osmId: osmIdOf(text), postcode: postcodeOf(text), named: text !== null };
}

/**
 * Whether two checks name the same branch: both name one, and they have the
 * same OpenStreetMap id, or (without ids on both) the same postcode, or
 * (with neither) the same words. Anything else is not shown to be the same.
 */
export function sameBranch(a, b) {
  const x = branchIdentity(typeof a === "string" || a === null || a === undefined ? a : a.branch);
  const y = branchIdentity(typeof b === "string" || b === null || b === undefined ? b : b.branch);
  if (!x.named || !y.named) return false;
  if (x.osmId && y.osmId) return x.osmId === y.osmId;
  if (x.postcode && y.postcode) return x.postcode === y.postcode;
  if (x.osmId || y.osmId || x.postcode || y.postcode) return false;
  return spaced(x.text) === spaced(y.text);
}

/**
 * Whether an Open Prices shop ({ osm_id, store, place }) is the branch a
 * check names: the same OpenStreetMap id, or the same retailer and the same
 * full postcode. A check that names no branch, or names it only by a town
 * or borough, never matches.
 */
export function shopIsBranch(shop, check) {
  if (!shop || !check) return false;
  const named = branchIdentity(check.branch);
  if (!named.named) return false;
  const osm = osmIdOf(String(shop.osm_id ?? ""));
  if (named.osmId && osm) return named.osmId === osm;
  const postcode = postcodeOf(String(shop.place ?? ""));
  return Boolean(
    named.postcode && postcode && named.postcode === postcode && spaced(shop.store) !== "" && spaced(shop.store) === spaced(check.retailer),
  );
}

/**
 * Records a branch availability check.
 * input: { barcode, retailer, locality, checkedAt?, method, inStock,
 *          unitsSeen?, note?, branch?, pricePence? }. A blank or missing
 * checkedAt is stamped with the server's time now; a given one cannot be in
 * the future. branch is the shop as identified (name and street or
 * postcode, or an OpenStreetMap id such as node/123). pricePence is the
 * shelf price for one unit seen on this check, in whole pence, the price a
 * shopper pays without a loyalty card, membership or multibuy; the estimate
 * costs a trip to this branch at it (estimate.mjs priceAtBranch).
 *
 * Returns the stored row plus:
 *  checkedAtStamped  true when checkedAt was blank and the server time was
 *                    recorded
 *  newerEvidence     the newest other check or stock report for the same
 *                    barcode, retailer and locality when it is later than
 *                    this check ({ kind, id, at, inStock, unitsSeen }), else
 *                    null. The newer one still decides the shelf.
 *  olderWarning      that in words, for the person recording it, or null
 */
export function recordCheck(db, input = {}, { now = new Date().toISOString() } = {}) {
  if (!input || typeof input !== "object") fail("Send an availability check");
  const row = {
    barcode: barcodeOf(input.barcode),
    retailer: text(input.retailer, "retailer", 120),
    locality: text(input.locality, "locality", 120),
    checked_at: timestamp(input.checkedAt, "checkedAt", now),
    method: oneOf(input.method, "method", CHECK_METHODS),
    in_stock: bool(input.inStock, "inStock") ? 1 : 0,
    units_seen: optionalInt(input.unitsSeen, "unitsSeen", 0, 10000),
    note: text(input.note, "note", 500, { optional: true }),
    branch: text(input.branch, "branch", 200, { optional: true }),
    price_pence:
      isBlank(input.pricePence)
        ? null
        : Number.isSafeInteger(input.pricePence) && input.pricePence >= 1 && input.pricePence <= MAX_SHELF_PRICE_PENCE
          ? input.pricePence
          : fail(`pricePence must be the shelf price for one unit in whole pence, from 1 to ${MAX_SHELF_PRICE_PENCE}`),
  };
  if (!row.in_stock && row.units_seen) fail("unitsSeen must be 0 when no stock was found");
  if (row.in_stock && row.units_seen === 0) fail("unitsSeen must be at least 1 when stock was found");
  const result = db
    .prepare(
      `INSERT INTO availability_checks(barcode, retailer, locality, checked_at, method, in_stock, units_seen, note, branch, price_pence)
 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.barcode, row.retailer, row.locality, row.checked_at, row.method, row.in_stock, row.units_seen, row.note,
      row.branch, row.price_pence,
    );
  const stored = getCheck(db, Number(result.lastInsertRowid));
  const newest = newestShelfEvidence(db, { ...stored, exceptId: stored.id });
  const newer = newest && Date.parse(newest.at) > Date.parse(stored.checked_at) ? newest : null;
  return {
    ...stored,
    checkedAtStamped: isBlank(input.checkedAt),
    newerEvidence: newer,
    olderWarning: newer
      ? `This check is dated ${timeOf(stored.checked_at)}, earlier than the ${newer.kind === "report" ? "stock report" : "branch check"} at ${timeOf(newer.at)} (${seenText(newer.inStock, newer.unitsSeen)}), so the newer one still decides what bounties show for this shelf. If you checked just now, leave the time blank and the time you save is recorded.`
      : null,
  };
}

export const getCheck = (db, id) =>
  plain(db.prepare("SELECT * FROM availability_checks WHERE id = ?").get(id));

/**
 * The most recent check for a barcode at a retailer made at or after
 * sinceIso (and no later than options.until, default now), or null. Retailer
 * and locality compare without case. When options.locality is given the check
 * must be in that locality; without it any locality matches, so callers that
 * confirm stock for a trip use stockStatus, which requires one. Returns null
 * when the audit tables are absent. options.priced true reads only checks
 * that recorded a shelf price (price_pence).
 */
export function latestCheck(
  db,
  barcode,
  retailer,
  sinceIso,
  { locality = null, until = new Date().toISOString(), priced = false } = {},
) {
  const gtin = normaliseBarcode(barcode);
  const shop = trimmed(retailer);
  if (!gtin || !shop || !tableExists(db, "availability_checks")) return null;
  const since = Date.parse(sinceIso);
  const end = Date.parse(until);
  if (!Number.isFinite(since) || !Number.isFinite(end)) return null;
  const params = [gtin, shop, new Date(since).toISOString(), new Date(end).toISOString()];
  let sql = `SELECT * FROM availability_checks
 WHERE barcode = ? AND retailer = ? AND checked_at >= ? AND checked_at <= ?`;
  if (locality !== null && locality !== undefined && locality !== "") {
    // A locality that is not text cannot match any check.
    const place = trimmed(locality);
    if (!place) return null;
    sql += " AND locality = ?";
    params.push(place);
  }
  if (priced) sql += " AND price_pence IS NOT NULL";
  sql += " ORDER BY checked_at DESC, id DESC LIMIT 1";
  return plain(db.prepare(sql).get(...params));
}

/**
 * Every check for a barcode at a retailer in a locality made between
 * sinceIso and untilIso, newest first (at most limit). Retailer and
 * locality compare without case. [] when the audit tables are absent or a
 * value is missing.
 */
export function shelfChecks(db, { barcode, retailer, locality, since, until, limit = 200 }) {
  const gtin = normaliseBarcode(barcode);
  const shop = trimmed(retailer);
  const place = trimmed(locality);
  const from = Date.parse(since);
  const to = Date.parse(until);
  if (!gtin || !shop || !place || !Number.isFinite(from) || !Number.isFinite(to) || !tableExists(db, "availability_checks"))
    return [];
  return db
    .prepare(
      `SELECT * FROM availability_checks
 WHERE barcode = ? AND retailer = ? AND locality = ? AND checked_at >= ? AND checked_at <= ?
 ORDER BY checked_at DESC, id DESC LIMIT ?`,
    )
    .all(gtin, shop, place, new Date(from).toISOString(), new Date(to).toISOString(), limit)
    .map(plain);
}

/**
 * Stock confirmation for a trip: the latest check in the last
 * CHECK_VALID_DAYS days for this barcode at this retailer in this locality.
 * confirmed is true only when that check found stock; a later check that
 * found none overrides an earlier positive one.
 *
 * Returns { check, confirmed, availability, locality, reason }. A locality is
 * required: without one nothing is confirmed (a check in another town says
 * nothing about the branch the shopper will visit). reason says in words why
 * stock is not confirmed, and is null when it is.
 */
export function stockStatus(db, { barcode, retailer, locality = null, now = new Date().toISOString() } = {}) {
  const place = trimmed(locality);
  const unconfirmed = (reason, check = null) => ({
    check,
    confirmed: false,
    availability: check ? "out_of_stock" : "unknown",
    locality: place || null,
    reason,
  });
  if (!place)
    return unconfirmed(
      "No locality given: enter the locality you will shop in to use a branch stock check",
    );
  if (!trimmed(retailer)) return unconfirmed("Retailer unknown, so no branch stock check applies");
  if (!normaliseBarcode(barcode)) return unconfirmed("No valid barcode, so no branch stock check applies");
  const at = Date.parse(now);
  if (!Number.isFinite(at)) return unconfirmed("No valid time to judge the stock check against");
  const since = new Date(at - CHECK_VALID_DAYS * DAY).toISOString();
  const check = latestCheck(db, barcode, retailer, since, { locality: place, until: new Date(at).toISOString() });
  if (!check)
    return unconfirmed(
      `No availability check in ${place} at this retailer in the last ${CHECK_VALID_DAYS} days`,
    );
  if (check.in_stock !== 1)
    return unconfirmed(`The latest check in ${place} found none on the shelf`, check);
  return { check, confirmed: true, availability: "in_stock", locality: place, reason: null };
}

/** Checks for a barcode, newest first. */
export function listChecks(db, barcode, { limit = 50 } = {}) {
  const gtin = barcodeOf(barcode);
  return db
    .prepare("SELECT * FROM availability_checks WHERE barcode = ? ORDER BY checked_at DESC, id DESC LIMIT ?")
    .all(gtin, limit)
    .map(plain);
}

// The confirmed sales on an audit item: a list of { provider, sourceId },
// duplicates removed.
function saleKeys(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_SALES)
    fail(`sales must be a list of up to ${MAX_SALES} { provider, sourceId }`);
  const seen = new Set();
  const out = [];
  value.forEach((sale, i) => {
    if (!isObject(sale)) fail(`sales[${i}] must be { provider, sourceId }`);
    const provider = text(sale.provider, `sales[${i}].provider`, 60);
    const sourceId = text(
      Number.isSafeInteger(sale.sourceId) ? String(sale.sourceId) : sale.sourceId,
      `sales[${i}].sourceId`,
      200,
    );
    const key = provider + "|" + sourceId;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ provider, sourceId });
    }
  });
  return out;
}

// Estimate request fields the audit sets itself from the item.
const AUDIT_SETS = new Set(["offer", "sales", "locality", "now", "promotionEligible", "weightKg", "localStockConfirmed"]);

const MAX_INPUT_DEPTH = 5;
const MAX_INPUT_CHARS = 4000;
const tooLarge = () => fail(`estimateInputs is too large (up to ${MAX_INPUT_CHARS} characters)`);

// The JSON length of an estimateInputs value, refusing (400) anything nested
// deeper than MAX_INPUT_DEPTH, longer than MAX_INPUT_CHARS or holding
// something other than text, numbers, true or false, lists and objects. It
// stops as soon as a limit is passed, so a hostile value never reaches
// JSON.stringify (which would overflow the stack on deep nesting).
function inputLength(value, depth = 0) {
  if (depth > MAX_INPUT_DEPTH)
    fail(`estimateInputs is nested too deeply (up to ${MAX_INPUT_DEPTH} levels of lists and objects)`);
  if (value === null) return 4;
  if (typeof value === "string") return value.length + 2;
  if (typeof value === "number") return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value === "boolean") return 5;
  if (typeof value !== "object")
    fail("estimateInputs must hold only text, numbers, true or false, lists and objects");
  let length = 2;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      length += 1 + (value[i] === undefined ? 4 : inputLength(value[i], depth + 1));
      if (length > MAX_INPUT_CHARS) tooLarge();
    }
    return length;
  }
  for (const key in value) {
    if (!Object.hasOwn(value, key) || value[key] === undefined) continue;
    length += key.length + 4 + inputLength(value[key], depth + 1);
    if (length > MAX_INPUT_CHARS) tooLarge();
  }
  return length;
}

// Further estimate inputs as stored JSON, or null. Only plain own fields are
// kept; the estimate validates them when the item is saved. Size and depth
// are checked field by field first, so nothing hostile is stringified.
function estimateInputsOf(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) fail("estimateInputs must be an object of estimate request fields");
  inputLength(value);
  const kept = Object.fromEntries(Object.entries(value).filter(([key]) => !AUDIT_SETS.has(key)));
  // The parcel cost has one source: the item's shipping field.
  if (isObject(kept.costs)) {
    const { postage: _postage, ...costs } = kept.costs;
    kept.costs = costs;
  }
  if (!Object.keys(kept).length) return null;
  const json = JSON.stringify(kept);
  if (json.length > MAX_INPUT_CHARS) tooLarge();
  return json;
}

function parseJson(value, fallback) {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
const storedSales = (item) => {
  const list = Array.isArray(item.sales) ? item.sales : parseJson(item.sales, []);
  return Array.isArray(list) ? list.filter(isObject) : [];
};

// The offer fields an audit judges, copied from findOffer's offer when the
// item is saved: { provider, sourceId, price, observed, retailer, barcode
// (canonical), copiedAt, migrated }. migrated is true for a copy taken later
// from the offer as it then stood (copyMissingOffers).
function offerCopyOf(offer, copiedAt, { migrated = false } = {}) {
  return {
    provider: offer.provider,
    sourceId: String(offer.sourceId ?? offer.source_id),
    price: offer.price,
    observed: offer.observed ?? null,
    retailer: offer.retailer ?? null,
    barcode: offer.gtin,
    copiedAt,
    migrated,
  };
}

// The stored copy, or null when the item has none (no offer, or an offer
// that could not be read when it was migrated) or it does not hold the
// fields a judgement needs.
function storedOfferCopy(item) {
  const copy = isObject(item.audited_offer) ? item.audited_offer : parseJson(item.audited_offer, null);
  if (!isObject(copy)) return null;
  if (copy.provider !== item.offer_provider || String(copy.sourceId) !== String(item.offer_source_id)) return null;
  if (!Number.isSafeInteger(copy.price) || typeof copy.barcode !== "string") return null;
  return copy;
}

// A read-only view of db in which the recorded offer reads as the audit
// judged it. Every offer row the estimate reads (findOffer, and the price
// history, select the same offer columns with an origin) for the copy's
// provider and source id carries the copy's price, observed date, retailer
// and barcode; everything else reads live. SQL functions are registered on
// the real handle first, so the view never registers them again.
function offerAsAudited(db, copy) {
  ensureFunctions(db);
  const overlay = (row) =>
    isObject(row) &&
    (row.origin === "research" || row.origin === "observations") &&
    row.provider === copy.provider &&
    String(row.source_id) === String(copy.sourceId)
      ? { ...row, price: copy.price, observed: copy.observed, retailer: copy.retailer, barcode: copy.barcode }
      : row;
  const forward = (target, prop) => {
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  };
  const statement = (stmt) =>
    new Proxy(stmt, {
      get(target, prop) {
        if (prop === "get") return (...args) => overlay(target.get(...args));
        if (prop === "all") return (...args) => target.all(...args).map(overlay);
        return forward(target, prop);
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (...args) => statement(target.prepare(...args));
      if (prop === "function") return () => undefined;
      return forward(target, prop);
    },
  });
}

// How the live offer differs from the copy the item was judged on, or null
// when it does not: { changed: [field], then, now, note }. changed lists
// "price", "observed", "retailer", "barcode", or "unreadable" when the live
// offer can no longer be read as an offer. note says it in words, and is
// null when only the observed date moved (the same price seen again).
function offerChangeOf(copy, live, liveError) {
  const then = { price: copy.price, observed: copy.observed ?? null, retailer: copy.retailer ?? null, barcode: copy.barcode };
  if (liveError)
    return {
      changed: ["unreadable"],
      then,
      now: null,
      note: `The offer can no longer be read as it is now (${liveError}). This item is judged on the offer as it stood when it was audited.`,
    };
  const now = { price: live.price, observed: live.observed ?? null, retailer: live.retailer ?? null, barcode: live.gtin };
  const changed = [];
  if (now.price !== then.price) changed.push("price");
  if (Date.parse(now.observed ?? "") !== Date.parse(then.observed ?? "") && now.observed !== then.observed)
    changed.push("observed");
  if (!(now.retailer === then.retailer || same(now.retailer, then.retailer))) changed.push("retailer");
  if (now.barcode !== then.barcode) changed.push("barcode");
  if (!changed.length) return null;
  const parts = [];
  if (changed.includes("price")) parts.push(`${pounds(then.price)} then, ${pounds(now.price)} now`);
  if (changed.includes("retailer"))
    parts.push(`${then.retailer ?? "retailer unknown"} then, ${now.retailer ?? "retailer unknown"} now`);
  if (changed.includes("barcode")) parts.push(`barcode ${then.barcode} then, ${now.barcode} now`);
  return {
    changed,
    then,
    now,
    note: parts.length
      ? `The offer has changed since this item was audited: ${parts.join("; ")}. This item is judged on the offer as it stood then.`
      : null,
  };
}

// The estimate request for an audit item: the stored offer and confirmed
// sales, one unit, the item's weight and parcel cost (left out when unknown),
// the audit locality and the shopper's promotion eligibility, plus any stored
// estimate inputs.
function estimateRequest(item) {
  const extra = isObject(item.estimate_inputs)
    ? item.estimate_inputs
    : parseJson(item.estimate_inputs, {});
  const inputs = isObject(extra) ? extra : {};
  const costs = isObject(inputs.costs) ? inputs.costs : {};
  return {
    ...inputs,
    offer: { provider: item.offer_provider, sourceId: item.offer_source_id },
    sales: storedSales(item),
    units: inputs.units ?? 1,
    weightKg: typeof item.weight_kg === "number" && Number.isFinite(item.weight_kg) ? item.weight_kg : null,
    // An unknown parcel cost is left blank, never 0, so the estimate lists
    // it as not entered.
    costs: Number.isSafeInteger(item.shipping) ? { ...costs, postage: item.shipping } : costs,
    locality: item.locality,
    promotionEligible: item.promotion_eligible === 1,
  };
}

/**
 * Records or updates the audit entry for a barcode in a locality (one entry
 * per barcode per locality, so an item is never counted twice).
 *
 * input: { locality, barcode, title, retailer, offerProvider?, offerSourceId?,
 *   sales? ([{ provider, sourceId }]: completed sales confirmed as the exact
 *   variant), weightKg? (one unit, for the estimate tier), estimateInputs?
 *   (further estimate request fields, such as costs), availabilityCheckId?,
 *   promotion?, promotionEligible? (true when the price is available to the
 *   shopper: no promotion condition, or they qualify), shipping? (pence),
 *   daysToSell?, independentSales?, displayPermitted?, matchDecision?
 *   ("exact" | "research" | "none"), notes? }
 *
 * daysToSell, independentSales, displayPermitted and matchDecision are the
 * operator's own reading and are optional: the outcome uses the stored
 * evidence, and a reading that disagrees with it fails the item.
 *
 * A recorded offer must exist in the database (404 otherwise), be a usable
 * retail offer and be for the same barcode and retailer. A linked check must
 * exist and be for the same barcode, retailer and locality. Unknown values are
 * stored as null and fail the audit.
 */
export function recordItem(db, input = {}, { now = new Date().toISOString() } = {}) {
  if (!isObject(input)) fail("Send an audit item");
  const item = {
    locality: text(input.locality, "locality", 120),
    barcode: barcodeOf(input.barcode),
    title: text(input.title, "title", 200),
    retailer: text(input.retailer, "retailer", 120),
    offer_provider: text(input.offerProvider, "offerProvider", 60, { optional: true }),
    offer_source_id: text(
      typeof input.offerSourceId === "number" ? String(input.offerSourceId) : input.offerSourceId,
      "offerSourceId",
      200,
      { optional: true },
    ),
    availability_check_id: optionalInt(input.availabilityCheckId, "availabilityCheckId", 1, Number.MAX_SAFE_INTEGER),
    promotion: text(input.promotion, "promotion", 200, { optional: true }),
    promotion_eligible: optionalBool(input.promotionEligible, "promotionEligible"),
    shipping: optionalInt(input.shipping, "shipping", 0, 100000),
    days_to_sell: optionalInt(input.daysToSell, "daysToSell", 0, 3650),
    independent_sales: optionalInt(input.independentSales, "independentSales", 0, 100000),
    display_permitted: optionalBool(input.displayPermitted, "displayPermitted"),
    match_decision:
      input.matchDecision === undefined || input.matchDecision === null || input.matchDecision === ""
        ? null
        : oneOf(input.matchDecision, "matchDecision", MATCH_DECISIONS),
    notes: text(input.notes, "notes", 1000, { optional: true }),
    sales: saleKeys(input.sales),
    weight_kg:
      input.weightKg === undefined || input.weightKg === null || input.weightKg === ""
        ? null
        : num(input.weightKg, "weightKg", 0.001, 1000),
    estimate_inputs: estimateInputsOf(input.estimateInputs),
  };
  if (Boolean(item.offer_provider) !== Boolean(item.offer_source_id))
    fail("Give both offerProvider and offerSourceId, or neither");
  if (item.sales.length && !item.offer_provider)
    fail("Record the retailer offer the confirmed sales were matched to");
  const stamp = timestamp(undefined, "updated", now);
  item.audited_offer = null;
  if (item.offer_provider) {
    // Throws 404 for an offer that is not in the database and 400 for a
    // record that cannot be an offer.
    const offer = findOffer(db, item.offer_provider, item.offer_source_id, stamp);
    if (offer.gtin !== item.barcode) fail("That offer is for a different barcode");
    if (offer.retailer && !same(offer.retailer, item.retailer))
      fail(`That offer is from ${offer.retailer}, not ${item.retailer}`);
    // The item is judged on the offer as it stands now, its audit time.
    item.audited_offer = JSON.stringify(offerCopyOf(offer, stamp));
    try {
      validateEstimateRequest(estimateRequest(item));
    } catch (error) {
      if (error instanceof HttpError) fail("estimateInputs: " + error.message);
      throw error;
    }
  }
  if (item.availability_check_id !== null) {
    const check = getCheck(db, item.availability_check_id);
    if (!check) fail("That availability check does not exist", 404);
    if (check.barcode !== item.barcode) fail("That availability check is for a different barcode");
    if (!same(check.retailer, item.retailer)) fail("That availability check is for a different retailer");
    if (!same(check.locality, item.locality)) fail("That availability check is for a different locality");
  }
  const sales = JSON.stringify(item.sales);
  return transaction(db, () => {
    db.prepare(
      `INSERT INTO validation_items(locality, barcode, title, retailer, offer_provider, offer_source_id,
 availability_check_id, promotion, promotion_eligible, shipping, days_to_sell, independent_sales,
 display_permitted, match_decision, notes, sales, weight_kg, estimate_inputs, audited_offer, created, updated)
 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(locality, barcode) DO UPDATE SET title = excluded.title, retailer = excluded.retailer,
 offer_provider = excluded.offer_provider, offer_source_id = excluded.offer_source_id,
 availability_check_id = excluded.availability_check_id, promotion = excluded.promotion,
 promotion_eligible = excluded.promotion_eligible, shipping = excluded.shipping,
 days_to_sell = excluded.days_to_sell, independent_sales = excluded.independent_sales,
 display_permitted = excluded.display_permitted, match_decision = excluded.match_decision,
 notes = excluded.notes, sales = excluded.sales, weight_kg = excluded.weight_kg,
 estimate_inputs = excluded.estimate_inputs, audited_offer = excluded.audited_offer,
 updated = excluded.updated`,
    ).run(
      item.locality, item.barcode, item.title, item.retailer, item.offer_provider, item.offer_source_id,
      item.availability_check_id, item.promotion, item.promotion_eligible, item.shipping,
      item.days_to_sell, item.independent_sales, item.display_permitted, item.match_decision,
      item.notes, sales, item.weight_kg, item.estimate_inputs, item.audited_offer, stamp, stamp,
    );
    const row = db
      .prepare("SELECT * FROM validation_items WHERE locality = ? AND barcode = ?")
      .get(item.locality, item.barcode);
    return withOutcome(db, plain(row));
  });
}

// When the item was audited, as ISO: the evidence is judged as it stood
// then, so an item's outcome does not drift as its sales age.
function auditTime(item) {
  for (const value of [item.updated, item.created]) {
    const at = typeof value === "string" ? Date.parse(value.includes("T") ? value : value.replace(" ", "T") + "Z") : NaN;
    if (Number.isFinite(at)) return new Date(at).toISOString();
  }
  return null;
}

const checkOk = (estimate, id) => estimate.alert?.checks?.find((c) => c.id === id)?.ok === true;

/**
 * The stored evidence for an audit item, read from the database as it stood
 * at the audit time:
 * { evaluatedAt, stock, error, offer, sales, match, permission, tier,
 *   tierReasons, live, offerFresh, alert, missingInputs, priceAtBranch,
 *   warnings, offerCopy, offerChange }.
 * priceAtBranch is the estimate's priceAtBranch ({ confirmed, basis, price,
 * at, check, seen, reason }): whether the price applies at the branch the
 * stock check covers. When a branch check recorded the shelf price, offer
 * carries that price and check time (the price the trip pays).
 * missingInputs lists the required costs and times the stored estimate
 * inputs left blank (estimate.mjs), which keep the tier at Review.
 * stock is stockStatus for the item's barcode, retailer and locality. The
 * rest comes from estimateFromEvidence for the recorded offer and confirmed
 * sales; without a recorded offer they are null. error is set (and the
 * estimate fields null) when the evidence cannot be read: errorKind "offer"
 * when the offer is no longer a usable offer (for example it was removed),
 * "estimate" when the estimate refused the stored inputs.
 *
 * The offer's price, observed date, retailer and barcode come from the copy
 * stored with the item (offerCopy, see offerCopyOf), never from the live
 * row, so a later import cannot change the result; the offer's other fields
 * (title and attributes, promotion) are read live. The record itself must
 * still exist. offerChange (offerChangeOf) says how the live offer now
 * differs from the copy, or is null. An item with no copy is judged on the
 * live offer, and offerCopy is null.
 */
export function auditEvidence(db, item) {
  const at = auditTime(item) ?? new Date().toISOString();
  const copy = storedOfferCopy(item);
  const judged = copy ? offerAsAudited(db, copy) : db;
  const stock = stockStatus(db, { barcode: item.barcode, retailer: item.retailer, locality: item.locality, now: at });
  const base = {
    evaluatedAt: at,
    stock: {
      confirmed: stock.confirmed,
      availability: stock.availability,
      checkId: stock.check?.id ?? null,
      reason: stock.reason,
    },
    error: null,
    errorKind: null,
    offer: null,
    sales: null,
    match: null,
    permission: null,
    tier: null,
    tierReasons: [],
    live: null,
    offerFresh: null,
    alert: null,
    missingInputs: null,
    priceAtBranch: null,
    warnings: [],
    offerCopy: copy,
    offerChange: null,
  };
  if (!item.offer_provider || !item.offer_source_id) return base;
  let e;
  try {
    findOffer(judged, item.offer_provider, item.offer_source_id, at);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return { ...base, error: error.message, errorKind: "offer" };
  }
  let offerChange = null;
  if (copy) {
    let live = null;
    let liveError = null;
    try {
      live = findOffer(db, item.offer_provider, item.offer_source_id, at);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      liveError = error.message;
    }
    offerChange = offerChangeOf(copy, live, liveError);
  }
  try {
    // pinOffer: cost exactly the recorded offer. Otherwise an Open Prices
    // observation imported later for the same shop (dated by day, so often
    // before the audit time) would replace it and change the result.
    e = estimateFromEvidence(judged, estimateRequest(item), { now: at, pinOffer: true });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return { ...base, offerChange, error: error.message, errorKind: "estimate" };
  }
  const confirmed = storedSales(item);
  const usedKeys = new Set(e.sample.used.map((r) => `${r.provider}|${r.source_id}`));
  const excluded = new Map(e.sample.excluded.map(({ row, reason }) => [`${row.provider}|${row.source_id}`, reason]));
  const notUsed = confirmed
    .map((s) => ({ sale: `${s.provider}|${s.sourceId}`, provider: s.provider, sourceId: s.sourceId }))
    .filter(({ sale }) => !usedKeys.has(sale))
    .map((s) => ({
      ...s,
      reason: excluded.get(s.sale) ?? "Not a completed sale with this barcode in the database",
    }));
  return {
    ...base,
    offer: {
      provider: e.offer.provider,
      sourceId: e.offer.sourceId,
      title: e.offer.title,
      barcode: e.offer.gtin,
      retailer: e.offer.retailer,
      price: e.offer.price,
      unitCost: e.unitCost,
      observed: e.offer.observed,
      freshness: e.offer.freshness,
      ageDays: e.offer.ageDays,
      promotion: e.offer.promotion,
      sample: e.offer.sample,
      source: e.offer.source,
    },
    sales: {
      confirmed: confirmed.length,
      used: e.sample.count,
      independent: e.sample.independent,
      withoutSeller: e.sample.withoutSeller ?? null,
      independenceRule: e.sample.independenceRule ?? null,
      daysToSell: e.sample.daysToSell,
      lowerMedian: e.sample.lowerMedian,
      newest: e.sample.newest,
      oldest: e.sample.oldest,
      notUsed,
    },
    match: e.match,
    permission: { permitted: e.permission.permitted === true, basis: e.permission.basis },
    tier: e.opportunity.tier,
    tierReasons: e.opportunity.reasons,
    live: checkOk(e, "live-evidence"),
    offerFresh: checkOk(e, "offer-fresh"),
    alert: {
      eligible: e.alert.eligible,
      failing: e.alert.checks.filter((c) => !c.ok).map((c) => c.id),
    },
    missingInputs: Array.isArray(e.missingInputs) ? e.missingInputs : null,
    // Whether the price applies at the branch the stock check covers.
    priceAtBranch: isObject(e.priceAtBranch)
      ? {
          confirmed: e.priceAtBranch.confirmed === true,
          basis: e.priceAtBranch.basis ?? null,
          price: e.priceAtBranch.price ?? null,
          at: e.priceAtBranch.at ?? null,
          check: e.priceAtBranch.check ?? null,
          seen: e.priceAtBranch.seen ?? null,
          reason: e.priceAtBranch.reason ?? null,
        }
      : null,
    warnings: e.warnings,
    offerChange,
  };
}

function withOutcome(db, row) {
  const check = row.availability_check_id ? getCheck(db, row.availability_check_id) : null;
  const item = {
    ...row,
    sales: storedSales(row),
    estimate_inputs: parseJson(row.estimate_inputs, null),
    audited_offer: parseJson(row.audited_offer, null),
  };
  const evidence = auditEvidence(db, item);
  const judged = { ...item, check, evidence };
  const evidenceGapsFound = evidenceGaps(judged);
  return {
    ...judged,
    evidenced: evidenceGapsFound.length === 0,
    evidenceGaps: evidenceGapsFound,
    outcome: auditOutcome(judged),
  };
}

// Stable failure messages: progress() counts failures by this text.
export const AUDIT_FAILURES = Object.freeze({
  barcode: "Barcode missing or invalid",
  offer: "No retailer offer recorded",
  offerMissing: "Recorded offer is not a usable retailer offer in the database",
  estimateFailed: "The estimate could not be run on the stored evidence",
  offerMismatch: "Recorded offer is for a different barcode or retailer, or its retailer is unknown",
  noEvidence: "No stored evidence to check: record a retailer offer from the database",
  sample: "Sample or fixture data never counts towards the audit",
  offerStale: `Offer price not observed within ${ALERT_RULES.maxOfferAgeDays} days of the audit`,
  // Only for an item whose copy of the offer was taken after it was audited
  // (a migrated copy of an offer a later import changed).
  offerAfterAudit:
    "The offer was updated after this item was audited, so the price it was judged on is not stored: save the item again to audit the current offer",
  noCheck: "No branch availability check linked",
  checkMismatch: "Availability check is for a different item, retailer or locality",
  checkMethod: "Availability check method not recognised",
  noStock: "Availability check found no stock",
  staleCheck: `Availability check more than ${CHECK_VALID_DAYS} days from the audit`,
  laterNoStock: "A later availability check in this locality found no stock",
  priceAtBranch:
    "Price not confirmed at the branch checked: record the shelf price on the branch check, or use an Open Prices price from the shop the check names",
  promotion: "Promotion eligibility not confirmed",
  shipping: "Parcel cost unknown",
  daysToSell: "Days to sell unknown from the confirmed sales",
  independent: `Fewer than ${ALERT_RULES.minIndependentSales} independent recent sales in the stored evidence`,
  display: "Display permission not recorded for this source",
  matchUncertain: "Match not exact: uncertain matches fail",
  tier: "Estimate from the stored evidence does not reach Priority 1 or 2",
  daysToSellContradiction: "Recorded days to sell contradicts the stored evidence",
  independentContradiction: "Recorded independent sales contradict the stored evidence",
  displayContradiction: "Recorded display permission contradicts the stored evidence",
  matchContradiction: "Recorded match decision contradicts the stored evidence",
});

const recordedBool = (value) => (value === 1 ? true : value === 0 ? false : null);

/**
 * Audit outcome for one item: { passed, reasons, checks, contradictions }.
 * Every check must pass on positive evidence; a null or unknown field fails.
 * item uses the stored column names and carries its linked availability
 * check as item.check and its stored evidence (auditEvidence) as
 * item.evidence. Without item.evidence every evidence check fails.
 *
 * Each check is { id, ok, detail } and, where the operator may type their
 * own reading, also { recorded, evidence, contradiction }: recorded is what
 * they typed (null when left blank), evidence what the database and
 * estimate give. contradictions lists the checks where the two disagree,
 * as { id, label, recorded, evidence, reason }, reason being the failure
 * message it adds to reasons.
 */
export function auditOutcome(item = {}) {
  const F = AUDIT_FAILURES;
  const checks = [];
  const add = (id, ok, pass, failure, extra = {}) =>
    checks.push({ id, ok: ok === true, detail: ok === true ? pass : failure, ...extra });
  const ev = isObject(item.evidence) ? item.evidence : null;
  const read = Boolean(ev && ev.offer && !ev.error);
  const gtin = normaliseBarcode(item.barcode);
  add("barcode", gtin !== null, "Valid barcode", F.barcode);

  let offerFailure = null;
  if (!item.offer_provider || !item.offer_source_id) offerFailure = F.offer;
  else if (!read) offerFailure = ev?.errorKind === "estimate" ? F.estimateFailed : F.offerMissing;
  else if (ev.offer.barcode !== gtin || !ev.offer.retailer || !same(ev.offer.retailer, item.retailer))
    offerFailure = F.offerMismatch;
  add("offer", offerFailure === null, "Retailer offer found in the database", offerFailure, {
    evidence: read ? ev.offer : null,
    error: ev?.error ?? null,
  });
  // Checks that need the stored evidence fail with one shared reason when
  // there is none.
  const evidenceFailure = (failure) => (read ? failure : F.noEvidence);

  add("live-evidence", read && ev.live === true, "Imported evidence, not sample data", evidenceFailure(F.sample));
  add(
    "offer-fresh",
    read && ev.offerFresh === true,
    read && ev.priceAtBranch?.basis === "check"
      ? `Shelf price recorded on the branch check within ${ALERT_RULES.maxOfferAgeDays} days of the audit`
      : `Offer price observed within ${ALERT_RULES.maxOfferAgeDays} days of the audit`,
    evidenceFailure(read && ev.offer.freshness === "future" ? F.offerAfterAudit : F.offerStale),
    { evidence: read ? { observed: ev.offer.observed, ageDays: ev.offer.ageDays } : null },
  );

  const check = item.check ?? null;
  let availability = null;
  if (!check) availability = F.noCheck;
  else if (
    check.barcode !== gtin ||
    !same(check.retailer, item.retailer) ||
    !same(check.locality, item.locality)
  )
    availability = F.checkMismatch;
  else if (!CHECK_METHODS.includes(check.method)) availability = F.checkMethod;
  else if (check.in_stock !== 1) availability = F.noStock;
  else {
    const audited = Date.parse(ev?.evaluatedAt ?? item.updated ?? item.created);
    const gap = Math.abs(audited - Date.parse(check.checked_at));
    if (!Number.isFinite(gap) || gap > CHECK_VALID_DAYS * DAY) availability = F.staleCheck;
    else if (ev?.stock && ev.stock.confirmed !== true) availability = F.laterNoStock;
  }
  add("availability", availability === null, "Branch stock seen in a dated check in this locality", availability, {
    evidence: ev?.stock ?? null,
  });
  // The price must apply at the branch the stock check covers: a price seen
  // at another shop or online fails (estimate.mjs priceAtBranch).
  const branchPrice = read && isObject(ev.priceAtBranch) ? ev.priceAtBranch : null;
  add(
    "price-at-branch",
    branchPrice?.confirmed === true,
    branchPrice?.basis === "same-shop"
      ? "Price seen at the same shop the branch check names"
      : "Shelf price recorded on the branch check",
    evidenceFailure(F.priceAtBranch),
    { evidence: branchPrice, reason: branchPrice?.reason ?? null },
  );
  const offerPromotion = read ? ev.offer.promotion : null;
  add(
    "promotion",
    item.promotion_eligible === 1,
    item.promotion || offerPromotion ? "Promotion eligibility confirmed" : "Price available without a promotion condition",
    F.promotion,
    { evidence: offerPromotion },
  );
  add(
    "shipping",
    Number.isSafeInteger(item.shipping) && item.shipping > 0,
    "Parcel cost known",
    F.shipping,
  );

  // Fields the operator may also type. The evidence decides; a typed value
  // that differs from it fails the check as a contradiction.
  const contradictions = [];
  const compareField = ({ id, label, evidenceValue, recorded, ok, pass, failure, contradiction }) => {
    const disagrees = read && recorded !== null && recorded !== evidenceValue;
    if (disagrees) contradictions.push({ id, label, recorded, evidence: evidenceValue, reason: contradiction });
    const passed = read && ok && !disagrees;
    add(id, passed, pass, !read ? F.noEvidence : !ok ? failure : contradiction, {
      recorded,
      evidence: read ? evidenceValue : null,
      contradiction: disagrees,
    });
  };
  compareField({
    id: "days-to-sell",
    label: "Days to sell",
    evidenceValue: read ? ev.sales.daysToSell : null,
    recorded: Number.isSafeInteger(item.days_to_sell) ? item.days_to_sell : null,
    ok: read && Number.isSafeInteger(ev.sales.daysToSell) && ev.sales.daysToSell >= 0,
    pass: "Days to sell known from the confirmed sales",
    failure: F.daysToSell,
    contradiction: F.daysToSellContradiction,
  });
  compareField({
    id: "independent-sales",
    label: "Independent sales",
    evidenceValue: read ? ev.sales.independent : null,
    recorded: Number.isSafeInteger(item.independent_sales) ? item.independent_sales : null,
    ok: read && Number.isSafeInteger(ev.sales.independent) && ev.sales.independent >= ALERT_RULES.minIndependentSales,
    pass: "Enough independent recent sales in the stored evidence",
    failure: F.independent,
    contradiction: F.independentContradiction,
  });
  compareField({
    id: "display-permitted",
    label: "Display permitted",
    evidenceValue: read ? ev.permission.permitted : null,
    recorded: recordedBool(item.display_permitted),
    ok: read && ev.permission.permitted === true,
    pass: "Display permitted by a recorded permission",
    failure: F.display,
    contradiction: F.displayContradiction,
  });
  compareField({
    id: "match",
    label: "Match decision",
    evidenceValue: read ? ev.match : null,
    recorded: MATCH_DECISIONS.includes(item.match_decision) ? item.match_decision : null,
    ok: read && ev.match === "exact",
    pass: "Exact match on confirmed completed sales",
    failure: F.matchUncertain,
    contradiction: F.matchContradiction,
  });
  add(
    "estimate-tier",
    read && PASSING_TIERS.includes(ev.tier),
    "Estimate reaches " + (read ? ev.tier : "Priority 1 or 2"),
    evidenceFailure(F.tier),
    { evidence: read ? { tier: ev.tier, reasons: ev.tierReasons } : null },
  );

  const reasons = [];
  const note = (reason) => {
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  };
  for (const c of checks) if (!c.ok) note(c.detail);
  for (const c of contradictions) note(c.reason);
  return {
    passed: checks.every((c) => c.ok),
    reasons,
    checks,
    contradictions,
  };
}

/** Audited items in a locality with their evidence and outcomes, newest first. */
export function listItems(db, locality) {
  const place = text(locality, "locality", 120);
  return db
    .prepare("SELECT * FROM validation_items WHERE locality = ? ORDER BY updated DESC, id DESC")
    .all(place)
    .map((row) => withOutcome(db, plain(row)));
}

// Why an item does not count towards the audit, in fixed words (progress()
// counts them by this text). An item counts only with all of these.
export const EVIDENCE_GAPS = Object.freeze({
  offer: "No retailer offer from the database recorded",
  unread: "The stored evidence could not be read",
  sample: "Sample or fixture data",
  sale: "No confirmed exact sale in the stored evidence",
  check: "No branch check in the audit locality linked",
});

/**
 * Why an item does not count towards the audit's 30: a list of
 * EVIDENCE_GAPS texts, empty when it counts. It counts only with a recorded
 * offer, stored evidence that read without an error and is not sample data,
 * at least one confirmed exact sale the estimate used, and a linked branch
 * check for the same barcode, retailer and locality (whatever it found).
 * item uses the stored column names with item.evidence (auditEvidence) and
 * item.check (the linked check) attached; anything missing is a gap.
 */
export function evidenceGaps(item) {
  const G = EVIDENCE_GAPS;
  const gaps = [];
  const ev = isObject(item?.evidence) ? item.evidence : null;
  if (!item?.offer_provider || !item?.offer_source_id) gaps.push(G.offer);
  else if (!ev || !ev.offer || ev.error) gaps.push(G.unread);
  else {
    if (ev.live !== true) gaps.push(G.sample);
    const used = ev.sales?.used;
    if (!Number.isSafeInteger(used) || used < 1) gaps.push(G.sale);
  }
  const check = isObject(item?.check) ? item.check : null;
  const gtin = normaliseBarcode(item?.barcode);
  if (
    !check ||
    !gtin ||
    check.barcode !== gtin ||
    !same(check.retailer, item.retailer) ||
    !same(check.locality, item.locality)
  )
    gaps.push(G.check);
  return gaps;
}

/** Whether an item counts towards the audit's 30 (no evidenceGaps). */
export function isEvidenced(item) {
  return evidenceGaps(item).length === 0;
}

/**
 * The one line members see once an audit is signed off, for example
 * "Pilot audit in Camden signed off on 31 Oct 2026: 12 of 30 items passed."
 * signed is a signedOff record ({ locality, at, passed, evidenced }).
 */
export function signOffLine(signed, locality = signed?.locality) {
  return `Pilot audit in ${locality} signed off on ${dayOf(signed?.at)}: ${signed?.passed} of ${signed?.evidenced} items passed.`;
}

const signOffShape = (row) =>
  row
    ? {
        id: row.id,
        locality: row.locality,
        at: row.signed_at,
        target: row.target,
        audited: row.audited,
        evidenced: row.evidenced,
        passed: row.passed,
        note: row.note ?? null,
        summary: signOffLine({ at: row.signed_at, passed: row.passed, evidenced: row.evidenced }, row.locality),
      }
    : null;

function latestSignOff(db, place) {
  if (!tableExists(db, "audit_signoffs")) return null;
  return plain(
    db.prepare("SELECT * FROM audit_signoffs WHERE locality = ? ORDER BY signed_at DESC, id DESC LIMIT 1").get(place),
  );
}

// Why a sign-off of these counts would be refused, or null when it may be
// recorded: the audit must be complete and at least
// AUDIT_RULES.minPassedToSignOff items must have passed.
function signOffRefusal(counts) {
  if (!counts.complete)
    return `The audit in ${counts.locality} is not complete: ${counts.evidenced} of ${counts.target} items have been checked against stored evidence, so it cannot be signed off yet`;
  if (counts.passed < AUDIT_RULES.minPassedToSignOff)
    return `Only ${counts.passed} of ${counts.evidenced} items passed, so the audit cannot be signed off. At least ${AUDIT_RULES.minPassedToSignOff} must pass first`;
  return null;
}

// Why the latest sign-off no longer stands, or null while it does. It lapses
// when the audit is no longer complete, when the passed or evidenced count
// differs from what was accepted, when fewer items pass than a sign-off
// needs, or when an item was saved again after it. A feed import never
// lapses it by itself: items are judged on their stored copy of the offer.
function lapseReason(signed, counts, items) {
  if (!counts.complete)
    return `Only ${counts.evidenced} of ${counts.target} items now have stored evidence`;
  if (counts.passed !== signed.passed || counts.evidenced !== signed.evidenced)
    return `The result changed after the sign-off: ${signed.passed} of ${signed.evidenced} items passed then, ${counts.passed} of ${counts.evidenced} now`;
  if (counts.passed < AUDIT_RULES.minPassedToSignOff)
    return `Only ${counts.passed} of ${counts.evidenced} items passed, fewer than the ${AUDIT_RULES.minPassedToSignOff} a sign-off needs`;
  const at = Date.parse(signed.signed_at);
  const changed = items.filter((item) => Date.parse(auditTime(item) ?? "") > at).length;
  if (changed) return `${changed} item${changed === 1 ? " was" : "s were"} changed after the sign-off`;
  return null;
}

/**
 * Progress towards the gate in one locality:
 * { locality, target, minPassedToSignOff, audited, evidenced, passed,
 *   failed, withoutEvidence, withoutEvidenceReasons: { gap: count },
 *   remaining, complete, signOffBlocked, signedOff, signOffLapsed,
 *   failures: { reason: count } }.
 *
 * audited counts every recorded item; evidenced only those that count
 * towards the target (isEvidenced: a recorded offer, a confirmed exact sale,
 * a branch check in the locality, and evidence that read without an error
 * and is not sample data). withoutEvidenceReasons counts the
 * EVIDENCE_GAPS of the rest. complete is evidenced >= target, and remaining
 * the evidenced items still needed. passed counts items that pass every
 * check (each is also evidenced), failed the rest. signOffBlocked says why a
 * sign-off would be refused now, or is null.
 *
 * signedOff is the operator's sign-off ({ id, locality, at, target,
 * audited, evidenced, passed, note, summary }) while it still stands, else
 * null; summary is signOffLine, the line members keep seeing. signOffLapsed
 * is { at, passed, evidenced, reason } when the latest sign-off no longer
 * stands, else null.
 */
export function progress(db, locality) {
  const place = text(locality, "locality", 120);
  const items = listItems(db, place);
  const failures = {};
  const withoutEvidenceReasons = {};
  const tally = (counts, reason) => {
    counts[reason] = (Object.hasOwn(counts, reason) ? counts[reason] : 0) + 1;
  };
  let passed = 0;
  let evidenced = 0;
  for (const item of items) {
    if (item.outcome.passed) passed++;
    if (item.evidenced) evidenced++;
    for (const gap of item.evidenceGaps) tally(withoutEvidenceReasons, gap);
    for (const reason of item.outcome.reasons) tally(failures, reason);
  }
  const counts = {
    locality: place,
    target: AUDIT_RULES.target,
    minPassedToSignOff: AUDIT_RULES.minPassedToSignOff,
    audited: items.length,
    evidenced,
    passed,
    failed: items.length - passed,
    withoutEvidence: items.length - evidenced,
    withoutEvidenceReasons,
    remaining: Math.max(0, AUDIT_RULES.target - evidenced),
    complete: evidenced >= AUDIT_RULES.target,
  };
  const signed = latestSignOff(db, place);
  const lapsed = signed ? lapseReason(signed, counts, items) : null;
  return {
    ...counts,
    signOffBlocked: signOffRefusal(counts),
    signedOff: signed && !lapsed ? signOffShape(signed) : null,
    signOffLapsed: signed && lapsed ? { at: signed.signed_at, passed: signed.passed, evidenced: signed.evidenced, reason: lapsed } : null,
    failures,
  };
}

/**
 * Records the operator's sign-off of a complete audit in a locality and
 * returns { signedOff, progress, created }. A sign-off records that the
 * operator reviewed the result; members keep seeing the pass count
 * (signOffLine) on every card and alert in the locality.
 *
 * input: { locality, passed?, evidenced?, note? }. Refused with 409 unless
 * the audit is complete and at least AUDIT_RULES.minPassedToSignOff items
 * passed ("Only 0 of 30 items passed, so the audit cannot be signed off").
 * passed and evidenced, when given, are the counts the operator saw: if the
 * audit has changed since, the sign-off is refused (409) so they never
 * accept figures they did not see. A sign-off that still stands is returned
 * as it is (created false) rather than recorded twice. Each sign-off is
 * stored with its time and the passed, evidenced and audited counts.
 */
export function signOff(db, input = {}, { now = new Date().toISOString() } = {}) {
  if (!isObject(input)) fail("Send the locality to sign off");
  const place = text(input.locality, "locality", 120);
  const seenPassed = optionalInt(input.passed, "passed", 0, 100000);
  const seenEvidenced = optionalInt(input.evidenced, "evidenced", 0, 100000);
  const note = text(input.note, "note", 500, { optional: true });
  const stamp = timestamp(undefined, "signedAt", now);
  return transaction(db, () => {
    const current = progress(db, place);
    if (current.signOffBlocked) fail(current.signOffBlocked, 409);
    if ((seenPassed !== null && seenPassed !== current.passed) || (seenEvidenced !== null && seenEvidenced !== current.evidenced))
      fail(
        `The audit in ${place} changed since you looked: ${current.passed} of ${current.evidenced} items now pass. Check it again before signing off`,
        409,
      );
    if (current.signedOff) return { signedOff: current.signedOff, progress: current, created: false };
    db.prepare(
      `INSERT INTO audit_signoffs(locality, signed_at, target, audited, evidenced, passed, note)
 VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ).run(place, stamp, current.target, current.audited, current.evidenced, current.passed, note);
    const after = progress(db, place);
    return { signedOff: after.signedOff, progress: after, created: true };
  });
}
