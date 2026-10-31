// Validation audit for the "Real buying alerts" gate: in one UK locality,
// check 30 barcoded items against retailer and actual sold evidence.
//
// availability_checks are dated branch stock checks made by a person (in
// store, by phone or on the retailer's own branch stock page). They are the
// only evidence that confirms local stock: affiliate feeds and online
// catalogues never do.
//
// validation_items are the audited items. An item passes only when every
// field passes on positive evidence; anything unknown fails closed.
import { addMissingColumns } from "./contract.mjs";
import { ALERT_RULES } from "./alerts.mjs";
import { normaliseBarcode } from "./matching.mjs";
import { bool, fail, int, oneOf, text, transaction } from "./http.mjs";

export const AUDIT_TARGET = 30;
export const CHECK_METHODS = Object.freeze(["in_store", "phone", "retailer_branch_page"]);
export const MATCH_DECISIONS = Object.freeze(["exact", "research", "none"]);
// A stock check stays usable for this long. Shelves change quickly, so an
// older check no longer confirms stock for a trip.
export const CHECK_VALID_DAYS = 2;
const DAY = 86400000;

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
 created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;
const CHECK_COLUMNS = [
  "id", "barcode", "retailer", "locality", "checked_at", "method", "in_stock",
  "units_seen", "note", "created",
];
const CHECK_TYPES = { in_stock: "INTEGER", units_seen: "INTEGER", created: "TEXT" };

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
 created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(locality, barcode)
)`;
const ITEM_COLUMNS = [
  "id", "locality", "barcode", "title", "retailer", "offer_provider",
  "offer_source_id", "availability_check_id", "promotion",
  "promotion_eligible", "shipping", "days_to_sell", "independent_sales",
  "display_permitted", "match_decision", "notes", "created", "updated",
];
const ITEM_TYPES = {
  availability_check_id: "INTEGER",
  promotion_eligible: "INTEGER",
  shipping: "INTEGER",
  days_to_sell: "INTEGER",
  independent_sales: "INTEGER",
  display_permitted: "INTEGER",
  created: "TEXT",
  updated: "TEXT",
};

// Idempotent. Older local databases gain any missing column in place.
export function schema(db) {
  db.exec(CHECKS_TABLE);
  addMissingColumns(db, "availability_checks", CHECK_COLUMNS, CHECK_TYPES);
  db.exec(ITEMS_TABLE);
  addMissingColumns(db, "validation_items", ITEM_COLUMNS, ITEM_TYPES);
  db.exec(`CREATE INDEX IF NOT EXISTS availability_checks_lookup
 ON availability_checks(barcode, retailer, checked_at);
CREATE INDEX IF NOT EXISTS validation_items_locality ON validation_items(locality);
UPDATE validation_items SET created = COALESCE(created, CURRENT_TIMESTAMP) WHERE created IS NULL;
UPDATE validation_items SET updated = COALESCE(updated, created) WHERE updated IS NULL;`);
}

export const tableExists = (db, name) =>
  Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );

const plain = (row) => (row ? { ...row } : null);

// ISO timestamp in canonical UTC form, so stored values sort as text.
function timestamp(value, name, now) {
  if (!Number.isFinite(Date.parse(now))) throw Error("now must be a date and time");
  if (value === undefined || value === null || value === "")
    return new Date(Date.parse(now)).toISOString();
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

/**
 * Records a branch availability check.
 * input: { barcode, retailer, locality, checkedAt?, method, inStock,
 *          unitsSeen?, note? }. checkedAt defaults to now and cannot be in
 * the future. Returns the stored row.
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
  };
  if (!row.in_stock && row.units_seen) fail("unitsSeen must be 0 when no stock was found");
  if (row.in_stock && row.units_seen === 0) fail("unitsSeen must be at least 1 when stock was found");
  const result = db
    .prepare(
      `INSERT INTO availability_checks(barcode, retailer, locality, checked_at, method, in_stock, units_seen, note)
 VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.barcode, row.retailer, row.locality, row.checked_at, row.method, row.in_stock, row.units_seen, row.note);
  return getCheck(db, Number(result.lastInsertRowid));
}

export const getCheck = (db, id) =>
  plain(db.prepare("SELECT * FROM availability_checks WHERE id = ?").get(id));

/**
 * The most recent check for a barcode at a retailer made at or after
 * sinceIso (and no later than options.until, default now), or null. Retailer
 * and locality compare without case. When options.locality is given the check
 * must be in that locality. Returns null when the audit tables are absent.
 */
export function latestCheck(db, barcode, retailer, sinceIso, { locality = null, until = new Date().toISOString() } = {}) {
  const gtin = normaliseBarcode(barcode);
  if (!gtin || !retailer || !tableExists(db, "availability_checks")) return null;
  const since = Date.parse(sinceIso);
  const end = Date.parse(until);
  if (!Number.isFinite(since) || !Number.isFinite(end)) return null;
  const params = [gtin, String(retailer).trim(), new Date(since).toISOString(), new Date(end).toISOString()];
  let sql = `SELECT * FROM availability_checks
 WHERE barcode = ? AND retailer = ? AND checked_at >= ? AND checked_at <= ?`;
  if (locality) {
    sql += " AND locality = ?";
    params.push(String(locality).trim());
  }
  sql += " ORDER BY checked_at DESC, id DESC LIMIT 1";
  return plain(db.prepare(sql).get(...params));
}

/**
 * Stock confirmation for a trip: the latest check in the last
 * CHECK_VALID_DAYS days for this barcode at this retailer (and locality when
 * given). confirmed is true only when that check found stock; a later check
 * that found none overrides an earlier positive one.
 */
export function stockStatus(db, { barcode, retailer, locality = null, now = new Date().toISOString() }) {
  const since = new Date(Date.parse(now) - CHECK_VALID_DAYS * DAY).toISOString();
  const check = latestCheck(db, barcode, retailer, since, { locality, until: now });
  return {
    check,
    confirmed: check?.in_stock === 1,
    availability: check ? (check.in_stock === 1 ? "in_stock" : "out_of_stock") : "unknown",
  };
}

/** Checks for a barcode, newest first. */
export function listChecks(db, barcode, { limit = 50 } = {}) {
  const gtin = barcodeOf(barcode);
  return db
    .prepare("SELECT * FROM availability_checks WHERE barcode = ? ORDER BY checked_at DESC, id DESC LIMIT ?")
    .all(gtin, limit)
    .map(plain);
}

/**
 * Records or updates the audit entry for a barcode in a locality (one entry
 * per barcode per locality, so an item is never counted twice).
 *
 * input: { locality, barcode, title, retailer, offerProvider?, offerSourceId?,
 *   availabilityCheckId?, promotion?, promotionEligible? (true when the price
 *   is available to the shopper: no promotion condition, or they qualify),
 *   shipping? (pence), daysToSell?, independentSales?, displayPermitted?,
 *   matchDecision? ("exact" | "research" | "none"), notes? }
 * Unknown values are stored as null and fail the audit. A linked check must
 * exist and be for the same barcode, retailer and locality.
 */
export function recordItem(db, input = {}, { now = new Date().toISOString() } = {}) {
  if (!input || typeof input !== "object") fail("Send an audit item");
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
  };
  if (Boolean(item.offer_provider) !== Boolean(item.offer_source_id))
    fail("Give both offerProvider and offerSourceId, or neither");
  if (item.availability_check_id !== null) {
    const check = getCheck(db, item.availability_check_id);
    if (!check) fail("That availability check does not exist", 404);
    const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
    if (check.barcode !== item.barcode) fail("That availability check is for a different barcode");
    if (!same(check.retailer, item.retailer)) fail("That availability check is for a different retailer");
    if (!same(check.locality, item.locality)) fail("That availability check is for a different locality");
  }
  const stamp = timestamp(undefined, "updated", now);
  return transaction(db, () => {
    db.prepare(
      `INSERT INTO validation_items(locality, barcode, title, retailer, offer_provider, offer_source_id,
 availability_check_id, promotion, promotion_eligible, shipping, days_to_sell, independent_sales,
 display_permitted, match_decision, notes, created, updated)
 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(locality, barcode) DO UPDATE SET title = excluded.title, retailer = excluded.retailer,
 offer_provider = excluded.offer_provider, offer_source_id = excluded.offer_source_id,
 availability_check_id = excluded.availability_check_id, promotion = excluded.promotion,
 promotion_eligible = excluded.promotion_eligible, shipping = excluded.shipping,
 days_to_sell = excluded.days_to_sell, independent_sales = excluded.independent_sales,
 display_permitted = excluded.display_permitted, match_decision = excluded.match_decision,
 notes = excluded.notes, updated = excluded.updated`,
    ).run(
      item.locality, item.barcode, item.title, item.retailer, item.offer_provider, item.offer_source_id,
      item.availability_check_id, item.promotion, item.promotion_eligible, item.shipping,
      item.days_to_sell, item.independent_sales, item.display_permitted, item.match_decision,
      item.notes, stamp, stamp,
    );
    const row = db
      .prepare("SELECT * FROM validation_items WHERE locality = ? AND barcode = ?")
      .get(item.locality, item.barcode);
    return withOutcome(db, plain(row));
  });
}

function withOutcome(db, item) {
  const check = item.availability_check_id ? getCheck(db, item.availability_check_id) : null;
  return { ...item, check, outcome: auditOutcome({ ...item, check }) };
}

// Stable failure messages: progress() counts failures by this text.
export const AUDIT_FAILURES = Object.freeze({
  barcode: "Barcode missing or invalid",
  offer: "No retailer offer recorded",
  noCheck: "No branch availability check linked",
  checkMismatch: "Availability check is for a different item, retailer or locality",
  checkMethod: "Availability check method not recognised",
  noStock: "Availability check found no stock",
  staleCheck: `Availability check more than ${CHECK_VALID_DAYS} days from the audit`,
  promotion: "Promotion eligibility not confirmed",
  shipping: "Parcel cost unknown",
  daysToSell: "Days to sell unknown",
  independent: `Fewer than ${ALERT_RULES.minIndependentSales} independent recent sales`,
  display: "Display permission not confirmed",
  matchUnknown: "Match decision not recorded",
  matchUncertain: "Match not exact: uncertain matches fail",
});

/**
 * Audit outcome for one item: { passed, reasons, checks }. Every check must
 * pass on positive evidence; a null or unknown field fails. item uses the
 * stored column names and may carry its linked availability check as
 * item.check.
 */
export function auditOutcome(item = {}) {
  const checks = [];
  const add = (id, ok, pass, failure) =>
    checks.push({ id, ok: ok === true, detail: ok === true ? pass : failure });
  const F = AUDIT_FAILURES;
  const gtin = normaliseBarcode(item.barcode);
  add("barcode", gtin !== null, "Valid barcode", F.barcode);
  add(
    "offer",
    Boolean(item.offer_provider && item.offer_source_id),
    "Retailer offer recorded",
    F.offer,
  );
  const check = item.check ?? null;
  const same = (a, b) =>
    typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
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
    const gap = Math.abs(Date.parse(item.updated ?? item.created) - Date.parse(check.checked_at));
    if (!Number.isFinite(gap) || gap > CHECK_VALID_DAYS * DAY) availability = F.staleCheck;
  }
  add("availability", availability === null, "Branch stock seen in a dated check", availability);
  add(
    "promotion",
    item.promotion_eligible === 1,
    item.promotion ? "Promotion eligibility confirmed" : "Price available without a promotion condition",
    F.promotion,
  );
  add(
    "shipping",
    Number.isSafeInteger(item.shipping) && item.shipping > 0,
    "Parcel cost known",
    F.shipping,
  );
  add(
    "days-to-sell",
    Number.isSafeInteger(item.days_to_sell) && item.days_to_sell >= 0,
    "Days to sell known",
    F.daysToSell,
  );
  add(
    "independent-sales",
    Number.isSafeInteger(item.independent_sales) &&
      item.independent_sales >= ALERT_RULES.minIndependentSales,
    "Enough independent recent sales",
    F.independent,
  );
  add("display-permitted", item.display_permitted === 1, "Display permitted", F.display);
  add(
    "match",
    item.match_decision === "exact",
    "Exact match",
    item.match_decision ? F.matchUncertain : F.matchUnknown,
  );
  return {
    passed: checks.every((c) => c.ok),
    reasons: checks.filter((c) => !c.ok).map((c) => c.detail),
    checks,
  };
}

/** Audited items in a locality with their outcomes, newest first. */
export function listItems(db, locality) {
  const place = text(locality, "locality", 120);
  return db
    .prepare("SELECT * FROM validation_items WHERE locality = ? ORDER BY updated DESC, id DESC")
    .all(place)
    .map((row) => withOutcome(db, plain(row)));
}

/**
 * Progress toward the gate in one locality:
 * { locality, target, audited, passed, failed, remaining, complete,
 *   failures: { reason: count } }. remaining is items still to audit.
 */
export function progress(db, locality) {
  const items = listItems(db, locality);
  const failures = {};
  let passed = 0;
  for (const item of items) {
    if (item.outcome.passed) passed++;
    for (const reason of item.outcome.reasons) failures[reason] = (failures[reason] || 0) + 1;
  }
  return {
    locality: text(locality, "locality", 120),
    target: AUDIT_TARGET,
    audited: items.length,
    passed,
    failed: items.length - passed,
    remaining: Math.max(0, AUDIT_TARGET - items.length),
    complete: items.length >= AUDIT_TARGET,
    failures,
  };
}
