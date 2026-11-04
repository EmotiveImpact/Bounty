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
 price_pence INTEGER,
 branch_postcode TEXT
)`;
// branch is the shop as the person identified it (name and street or
// postcode, or an OpenStreetMap id); price_pence the shelf price for one
// unit seen on that check. Both are optional: older checks have neither.
// branch_postcode is the postcode Open Prices gives for the OpenStreetMap id
// the branch names, worked out when the check is recorded (null when the
// branch names no id, or Open Prices does not give one postcode for it), so
// a check naming a shop by its id and one naming it by its postcode are
// seen to be the same branch (sameBranch).
const CHECK_COLUMNS = [
  "id", "barcode", "retailer", "locality", "checked_at", "method", "in_stock",
  "units_seen", "note", "created", "branch", "price_pence", "branch_postcode",
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

// The branch a check names (a check row, or branch text): branchIdentity of
// its text, with the postcode Open Prices gives for its OpenStreetMap id
// (branch_postcode, recordCheck) when the text gives none. A postcode in the
// text that differs from that one leaves the postcode unknown, since the
// branch is then not identified by either.
function checkBranch(check) {
  const row = check !== null && typeof check === "object" ? check : { branch: check };
  const named = branchIdentity(row.branch);
  const resolved = typeof row.branch_postcode === "string" ? postcodeOf(row.branch_postcode) : null;
  if (named.osmId && resolved) named.postcode = named.postcode === null || named.postcode === resolved ? resolved : null;
  return named;
}

// Royal Mail's street abbreviations and a few more, so "Camden High St" and
// "Camden High Street" are the same words. Only whole words change, and the
// same way on both sides. "St" is always "street": "St Pancras" still
// matches "St. Pancras", and "Saint Pancras" fails closed.
const STREET_WORDS = new Map(
  Object.entries({
    st: "street", rd: "road", ave: "avenue", av: "avenue", ln: "lane", pl: "place", sq: "square",
    gdns: "gardens", cres: "crescent", ter: "terrace", terr: "terrace", ct: "court", dr: "drive",
    cl: "close", gr: "grove", gro: "grove", gn: "green", pk: "park", pde: "parade", hwy: "highway",
    bdwy: "broadway", bldgs: "buildings", ctr: "centre", cntr: "centre", center: "centre",
    gt: "great", upr: "upper", lwr: "lower", mt: "mount",
  }),
);
const wordsOf = (value) =>
  typeof value === "string"
    ? value
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/['’]/g, "")
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .map((w) => STREET_WORDS.get(w) ?? w)
    : [];

// The words of a branch, in the form sameBranch compares: lower case, no
// punctuation, street abbreviations written out, and a leading retailer
// name left out when there is more after it ("Home Bargains, Camden High
// St" and "Camden High Street" at Home Bargains).
function branchWords(text, retailer) {
  const words = wordsOf(text);
  const shop = wordsOf(retailer);
  if (shop.length && words.length > shop.length && shop.every((w, i) => words[i] === w)) return words.slice(shop.length).join(" ");
  return words.join(" ");
}

/**
 * Whether two checks name the same branch: both name one, and they have the
 * same OpenStreetMap id, or (without ids on both) the same postcode, or
 * (with neither) the same words. Anything else is not shown to be the same.
 *
 * a and b are check rows (or branch text). A row's postcode is the one in
 * its branch text, or else the one Open Prices gives for the OpenStreetMap
 * id it names (branch_postcode), so a check naming a shop by postcode and
 * one naming it by id match. Words compare without case, punctuation or
 * street abbreviations ("St" is "Street", "Rd" is "Road"), and without a
 * leading retailer name when both rows are at the same retailer. Two
 * different ids, or two different postcodes, never match.
 */
export function sameBranch(a, b) {
  const x = checkBranch(a);
  const y = checkBranch(b);
  if (!x.named || !y.named) return false;
  if (x.osmId && y.osmId) return x.osmId === y.osmId;
  if (x.postcode && y.postcode) return x.postcode === y.postcode;
  if (x.osmId || y.osmId || x.postcode || y.postcode) return false;
  const retailerOf = (row) => (row !== null && typeof row === "object" && typeof row.retailer === "string" ? row.retailer : null);
  const shop = retailerOf(a) !== null && spaced(retailerOf(a)) === spaced(retailerOf(b)) ? retailerOf(a) : null;
  return branchWords(x.text, shop) === branchWords(y.text, shop);
}

// Whether a check's branch names the Open Prices shop ({ osm_id, store,
// place }): the same OpenStreetMap id, or the same retailer and the same
// full postcode. Where the shop is does not come into it (shopIsBranch).
function namesShop(shop, check) {
  if (!shop || !check) return false;
  const named = checkBranch(check);
  if (!named.named) return false;
  const osm = osmIdOf(String(shop.osm_id ?? ""));
  if (named.osmId && osm) return named.osmId === osm;
  const postcode = postcodeOf(String(shop.place ?? ""));
  return Boolean(
    named.postcode && postcode && named.postcode === postcode && spaced(shop.store) !== "" && spaced(shop.store) === spaced(check.retailer),
  );
}

// ---------------------------------------------------------------------------
// Where an Open Prices shop is. An OpenStreetMap id or a postcode on a check
// identifies a shop, but the person can name a shop in another town by
// mistake (a Camden check that names the Preston shop, or the Croydon one),
// so the shop's own location, as Open Prices records it, must agree with the
// check's locality before a price seen there counts for a trip from that
// check.

// The postcode districts (outward codes) with any address in each London
// borough and the City of London. Source: the local authority of every
// postcode in the ONS Postcode Directory, as postcodes.io gives it for each
// outward code (November 2026), joined with the local authority areas in
// Wikipedia's postcode area articles. A district that has any address in a
// borough is listed for it, so a shop in a borough is never refused because
// of its district; the few non-geographic districts listed do no harm.
const LONDON_BOROUGH_DISTRICTS = {
  "Barking and Dagenham": "E6 IG11 RM5 RM6 RM7 RM8 RM9 RM10",
  Barnet: "EN4 EN5 HA7 HA8 N2 N3 N6 N10 N11 N12 N14 N20 NW2 NW3 NW4 NW7 NW9 NW11 WD6",
  Bexley: "BR5 DA1 DA5 DA6 DA7 DA8 DA14 DA15 DA16 DA17 DA18 SE2 SE9 SE18 SE28",
  Brent: "HA0 HA1 HA3 HA7 HA8 HA9 N8 NW2 NW6 NW8 NW9 NW10 NW26 W9 W10",
  Bromley: "BR1 BR2 BR3 BR4 BR5 BR6 BR7 BR8 CR6 DA14 SE9 SE12 SE19 SE20 SE26 TN14 TN16",
  Camden: "EC1M EC1N EC1R N1 N1C N6 N7 N19 NW1 NW1W NW2 NW3 NW5 NW6 NW8 W1T W9 WC1A WC1B WC1E WC1H WC1N WC1R WC1V WC1X WC2A WC2B WC2H",
  Croydon: "BR3 CR0 CR2 CR3 CR4 CR5 CR6 CR7 CR8 CR9 CR90 SE19 SE20 SE25 SW16",
  Ealing: "HA0 NW10 TW8 UB1 UB2 UB5 UB6 UB18 W2 W3 W4 W5 W7 W10 W11 W12 W13",
  Enfield: "EN1 EN2 EN3 EN4 EN6 EN7 EN8 EN9 N9 N11 N13 N14 N17 N18 N21 N22",
  Greenwich: "BR7 DA7 DA15 DA16 DA17 DA18 SE2 SE3 SE7 SE8 SE9 SE10 SE12 SE13 SE18 SE28",
  Hackney: "E1 E2 E5 E8 E9 E10 E15 E20 EC1V EC2A EC2M N1 N4 N5 N15 N16",
  "Hammersmith and Fulham": "NW10 SW6 SW10 W3 W4 W6 W10 W11 W12 W14",
  Haringey: "N2 N4 N6 N8 N10 N11 N13 N15 N17 N18 N22 N81",
  Harrow: "HA0 HA1 HA2 HA3 HA4 HA5 HA7 HA8 NW9 UB5 UB6 WD23",
  Havering: "CM13 CM14 RM1 RM2 RM3 RM4 RM5 RM6 RM7 RM9 RM11 RM12 RM13 RM14 RM15",
  Hillingdon: "HA4 HA5 HA6 TW6 TW14 TW19 UB1 UB2 UB3 UB4 UB5 UB7 UB8 UB9 UB10 UB11 WD3",
  Hounslow: "TW1 TW2 TW3 TW4 TW5 TW6 TW7 TW8 TW13 TW14 TW15 TW16 TW19 UB2 W3 W4 W5 W6",
  Islington: "E8 EC1A EC1M EC1P EC1R EC1V EC1Y EC2A EC2M EC2N EC2P EC2R EC2V EC2Y EC3A EC3P EC3R EC3V EC4A EC4M EC4N EC4P EC4R EC4V EC4Y N1 N1P N4 N5 N6 N7 N8 N15 N16 N19 NW5 W1A W1G W1J W1T W1W WC1A WC1B WC1H WC1N WC1V WC1X WC2A WC2B WC2H WC2N WC2R",
  "Kensington and Chelsea": "NW10 SW1W SW1X SW3 SW5 SW7 SW10 W2 W8 W9 W10 W11 W14",
  "Kingston upon Thames": "KT1 KT2 KT3 KT4 KT5 KT6 KT7 KT9 KT18 KT19 KT22 SW15 SW20 TW10",
  Lambeth: "CR4 SE1 SE5 SE11 SE19 SE21 SE24 SE27 SW2 SW3 SW4 SW8 SW9 SW12 SW16",
  Lewisham: "BR1 BR3 SE3 SE4 SE6 SE8 SE9 SE10 SE12 SE13 SE14 SE15 SE16 SE23 SE26",
  Merton: "CR0 CR4 CR7 KT3 KT4 SM3 SM4 SW16 SW17 SW18 SW19 SW20",
  Newham: "E3 E6 E7 E12 E13 E15 E16 E20 IG11 N81",
  Redbridge: "E7 E11 E12 E18 IG1 IG2 IG3 IG4 IG5 IG6 IG7 IG8 IG9 IG11 RM5 RM6 RM8 RM9",
  "Richmond upon Thames": "KT1 KT2 KT8 SW13 SW14 SW15 TW1 TW2 TW3 TW4 TW7 TW8 TW9 TW10 TW11 TW12 TW13 TW16",
  Southwark: "SE1 SE1P SE4 SE5 SE8 SE11 SE14 SE15 SE16 SE17 SE19 SE21 SE22 SE23 SE24 SE26",
  Sutton: "CR0 CR4 CR5 CR8 CR9 KT4 KT17 SM1 SM2 SM3 SM4 SM5 SM6 SM7",
  "Tower Hamlets": "E1 E1W E2 E3 E8 E9 E14 E15 E20 E22 E77 E98 EC2M EC3N",
  "Waltham Forest": "E4 E5 E7 E10 E11 E15 E17 E20 IG8 N17",
  Wandsworth: "SW1A SW1E SW1H SW1P SW1V SW1W SW1X SW1Y SW4 SW8 SW11 SW12 SW15 SW16 SW17 SW18 SW19",
  Westminster: "EC4A EC4Y NW1 NW6 NW8 SW1A SW1E SW1H SW1P SW1V SW1W SW1X SW1Y SW3 SW7 W1A W1B W1C W1D W1F W1G W1H W1J W1K W1S W1T W1U W1W W2 W9 W10 W11 WC2A WC2B WC2E WC2H WC2N WC2R",
  "City of London": "E1 EC1A EC1M EC1N EC1Y EC2A EC2M EC2N EC2P EC2R EC2V EC2Y EC3A EC3M EC3N EC3P EC3R EC3V EC4A EC4M EC4N EC4R EC4V EC4Y WC1V WC2A",
};
// The post towns outside the London post town that have any address in
// Greater London, each with those of its districts that do (same sources,
// every post town Wikipedia lists for a district, so CR8 is Purley and
// Kenley; a district the postcode directory places no postcode in use of in
// London is left out): a Romford check is in London, and an RM1 postcode is
// in Romford.
const LONDON_POST_TOWNS = {
  Ashford: "TW15",
  Banstead: "SM7",
  Barking: "IG11",
  Barnet: "EN4 EN5",
  Beckenham: "BR3",
  Belvedere: "DA17",
  Bexley: "DA5",
  Bexleyheath: "DA6 DA7",
  Borehamwood: "WD6",
  Brentford: "TW8",
  Brentwood: "CM13 CM14",
  Bromley: "BR1 BR2",
  "Buckhurst Hill": "IG9",
  Bushey: "WD23",
  Carshalton: "SM5",
  Caterham: "CR3",
  Chessington: "KT9",
  Chigwell: "IG7",
  Chislehurst: "BR7",
  Coulsdon: "CR5",
  Croydon: "CR0 CR9 CR90",
  Dagenham: "RM8 RM9 RM10",
  Dartford: "DA1",
  "East Molesey": "KT8",
  Edgware: "HA8",
  Enfield: "EN1 EN2 EN3",
  Epsom: "KT17 KT18 KT19",
  Erith: "DA8 DA18",
  Feltham: "TW13 TW14",
  Greenford: "UB5 UB6 UB18",
  Hampton: "TW12",
  Harrow: "HA1 HA2 HA3",
  Hayes: "UB3 UB4",
  Hornchurch: "RM11 RM12",
  Hounslow: "TW3 TW4 TW5 TW6",
  Ilford: "IG1 IG2 IG3 IG4 IG5 IG6",
  Isleworth: "TW7",
  Kenley: "CR8",
  Keston: "BR2",
  "Kingston upon Thames": "KT1 KT2",
  Leatherhead: "KT22",
  Mitcham: "CR4",
  Morden: "SM4",
  "New Malden": "KT3",
  Northolt: "UB5",
  Northwood: "HA6",
  Orpington: "BR5 BR6",
  Pinner: "HA5",
  "Potters Bar": "EN6",
  Purley: "CR8",
  Rainham: "RM13",
  Richmond: "TW9 TW10",
  Rickmansworth: "WD3",
  Romford: "RM1 RM2 RM3 RM4 RM5 RM6 RM7",
  Ruislip: "HA4",
  Sevenoaks: "TN14",
  Sidcup: "DA14 DA15",
  "South Croydon": "CR2",
  "South Ockendon": "RM15",
  Southall: "UB1 UB2 UB3",
  "Staines-upon-Thames": "TW19",
  Stanmore: "HA7",
  Surbiton: "KT5 KT6",
  Sutton: "SM1 SM2 SM3",
  Swanley: "BR8",
  Teddington: "TW11",
  "Thames Ditton": "KT7",
  "Thornton Heath": "CR7",
  Twickenham: "TW1 TW2",
  Upminster: "RM14",
  Uxbridge: "UB8 UB9 UB10 UB11",
  Wallington: "SM6",
  "Waltham Abbey": "EN9",
  "Waltham Cross": "EN7 EN8",
  Warlingham: "CR6",
  Welling: "DA16",
  Wembley: "HA0 HA9",
  "West Drayton": "UB7 UB8",
  "West Molesey": "KT8",
  "West Wickham": "BR4",
  Westerham: "TN16",
  Whyteleafe: "CR3",
  "Woodford Green": "IG8",
  "Worcester Park": "KT4",
};
// The postcode districts with postcodes in use both in and outside Greater
// London (ONS Postcode Directory, from doogal.co.uk, November 2026), and
// TW16, which the table above lists although none of its postcodes is in
// London. Each sector is "in" (every postcode in use is in Greater London),
// "out" (none is), or, on the boundary, the side with fewer postcodes in use
// followed by every postcode on that side ("out 4AF 4AG" in DA1: DA1 4AF
// and DA1 4AG are outside London, and any other DA1 4 postcode is in it).
// A shop in DA1 1 is in Dartford, outside London, though DA1 has Bexley
// addresses; one at DA1 4HS is in Crayford, in Bexley. A sector not listed
// for one of these districts does not place a shop either way.
const LONDON_BOUNDARY = {
  BR6: { 0: "in", 1: "in", 6: "in", 7: "out 7NZ 7PJ 7PL 7PN 7PP 7PR 7PS 7PT 7PU 7PW 7PX 7PY 7PZ 7QA 7QD 7QE 7QF 7QG 7QH 7QJ 7QQ", 8: "in", 9: "in" },
  BR8: { 6: "in", 7: "in 7QG 7QH 7QJ 7QL 7QN 7QP 7QQ 7QR 7QW", 8: "in 8EP", 9: "out" },
  CM13: { 1: "out", 2: "out", 3: "in 3JA" },
  CM14: { 4: "out", 5: "in 5NG", 9: "out" },
  CR3: { 0: "in 0DB 0DD 0DE 0DF 0DG 0DH 0DJ 0DL 0DN 0DP 0DQ 0DR 0DS 0DT 0DU 0DW 0DX 0EX", 1: "out 1NN 1NP 1NQ 1NR 1YE", 2: "out 2PX 2PZ 2XT", 3: "in 3AA 3AB 3AD 3AE 3AF 3AG 3AH 3AJ 3AL 3AN 3AP 3AQ 3AR 3AS 3BA 3BB 3BD 3BE 3BF 3BG 3BH 3BJ 3BP 3BQ 3BR 3BS 3BT 3BU 3BX 3BY 3BZ 3DA 3DB 3DD 3DE 3DF 3DG 3DH 3DJ 3DL 3DN 3DP 3DR 3DS 3DT 3DU 3EA 3ED 3EL 3EN 3EP 3EQ 3ES 3ET 3EU 3HA 3HB 3HD 3HE 3HF 3HG 3HH 3HJ 3HL 3HN 3HP 3HQ 3HR 3HS 3HU 3HX 3JA 3JB 3JD 3JE 3JF 3JG 3JH 3JJ 3JL 3JN 3JP 3QA 3TD 3YE 3YF 3YJ 3YL 3YP 3YR 3YS 3YT 3YU 3YX 3YY", 4: "out", 5: "in 5QQ 5QS 5QU", 6: "out", 7: "out", 9: "in 9PP 9PQ 9RA 9RB 9RG 9RH 9RJ 9RL" },
  CR5: { 1: "out 1LT 1LU 1LW 1LX 1LY 1LZ 1NN 1NP 1NQ 1NR 1NS 1NT 1NU 1NW 1NX 1NY 1NZ 1PL 1PN 1PS 1PT 1PU 1PW 1RN 1RP 1RR 1RS 1RX 1RY 1RZ 1SB 1TB 1YX", 2: "in", 3: "out 3BN 3DQ 3DX 3DZ 3EB 3EE 3EF 3EG 3EJ 3FD 3FF 3FG 3LA 3LB 3LD 3LE 3LG 3LH 3LL 3LN 3LP 3LQ 3LT 3LU 3LX 3NA 3NB 3ND 3NE 3NF 3NG 3NH 3NJ 3NL 3NN 3NP 3NQ 3NR 3NS 3NT 3NU 3NW 3NX 3PA 3PD 3PE 3PF 3PG 3PH 3PJ 3PL 3PN 3PP 3PQ 3PR 3PS 3PT 3PX 3QB 3QD 3QE 3QF 3QG 3QH 3QJ 3QL 3QN 3QP 3QQ 3QR 3QU 3QW 3QX 3QY 3QZ 3RA 3RB 3RD 3RE 3RG 3RH 3RL 3RN 3RP 3RQ 3RT 3RX 3RZ 3SA 3SB 3SD 3SE 3SF 3SG 3SH 3SJ 3SL 3SN 3SP 3SQ 3SR 3SS 3SU 3SX 3SY 3TA 3TB 3TD 3TE 3TF 3TG 3TL 3TN 3TP 3TQ 3TS 3TT 3TU 3TW 3TX 3TY 3TZ 3YD 3YE 3YF 3YG 3YQ 3YW 3ZR 3ZT", 9: "in" },
  CR6: { 0: "out", 9: "in 9AB 9AE 9AH 9AU 9AW 9BW 9FG 9PP 9PQ" },
  CR8: { 1: "in", 2: "in", 3: "in", 4: "in", 5: "out 5AT 5EQ 5ER 5FH 5FJ 5FL 5FN 5GF 5GG 5GH 5GJ 5GL 5GN 5GP 5YG", 9: "in" },
  DA1: { 1: "out", 2: "out", 3: "in 3LD 3NP 3NR 3NS 3NT 3NW 3NX 3NY 3NZ 3PA 3PB 3PD 3PE 3PF 3PG 3PH 3PJ 3PL 3PN 3PP 3PQ 3PR 3PS 3PT 3PU 3PW 3PY 3PZ 3QA 3QB 3QD 3QE 3QG 3QH 3QJ 3QQ 3QR 3QS 3QU 3QX 3QZ 3RA 3RB 3RD 3RF 3RG 3RH 3RJ 3RL 3RN 3RP 3RR 3RS 3RT 3RU 3RW", 4: "out 4AF 4AG 4AH 4AQ 4EQ 4JE 4UB 4UE 4UF 4UH 4WA 4WB 4WD 4WE 4WF 4WG 4WH 4WJ 4WL 4WN 4WP 4WQ 4WT 4WU 4WW 4WX 4WY 4WZ 4XQ 4XT 4YZ 4ZF 4ZN 4ZP 4ZQ 4ZR 4ZT 4ZU 4ZW 4ZX", 5: "in 5AA 5QH 5QJ 5QQ", 9: "out" },
  DA5: { 1: "in", 2: "in 2AJ 2AL 2AN 2AP 2AR 2AS 2AT 2AU 2AW 2AX 2AY 2AZ 2BA 2BB 2BE 2BH 2BQ 2BS 2BT 2BU 2BX 2BY 2BZ 2DA 2DB 2DD 2DE 2DF 2DH 2DJ 2DL 2DN 2DP 2DQ 2DR 2DS 2DT 2DU 2DW 2DY 2DZ 2FA 2FD 2JX 2JY 2LB 2LF 2WA 2WB 2WD 2WE 2WP 2WQ 2WY 2WZ 2ZR 2ZS 2ZT 2ZU 2ZW 2ZX 2ZZ", 3: "in", 9: "out" },
  DA14: { 4: "in", 5: "out 5AS 5AT 5FB", 6: "in" },
  DA17: { 5: "in", 6: "in", 9: "out" },
  E4: { 0: "in", 6: "in", 7: "out 7BF 7DF 7FA 7FF 7FG 7FH 7FN 7QL 7QN 7QP 7QR 7QS 7QT 7QU 7QW 7RA 7RB 7RD 7RE 7RF 7RG 7RH 7RJ 7RL 7RN 7RQ 7RW 7SA 7SB 7SD", 8: "in", 9: "in" },
  EN2: { 0: "in", 6: "in", 7: "in", 8: "out 8AT 8AU", 9: "in" },
  EN4: { 0: "out 0PH 0PJ 0PL", 8: "in", 9: "in" },
  EN5: { 1: "in", 2: "in", 3: "out 3GZ 3JE", 4: "out 4AA 4AP 4AW 4BF 4FA 4FB 4RA 4RB 4RD 4RE 4RG 4RH 4RJ 4RL 4RN 4RP 4RQ 4RR 4RS 4RT 4RU 4RW 4RX 4RY 4RZ 4SA 4SB 4SE 4SG 4SH 4SZ", 5: "in", 9: "in" },
  EN6: { 1: "out", 2: "out", 3: "out", 4: "out", 5: "in 5EZ 5QT 5QU 5RL", 9: "out" },
  EN7: { 3: "in", 5: "in 5HR 5HT", 6: "out" },
  EN8: { 0: "out", 1: "out", 7: "in 7ND 7NE 7RJ 7RP 7RR 7RS 7RU 7TD 7TE 7TG 7TQ 7TW 7TX", 8: "in 8EX 8EY 8EZ 8HJ 8HN 8HP 8HR 8HS 8HT 8HU 8HW 8HX 8HY 8HZ 8QT 8QU 8QX 8QY 8QZ 8RA 8RB 8RD 8RE 8RF 8RG 8RQ 8RY 8RZ", 9: "out" },
  EN9: { 1: "in 1AL", 2: "out", 3: "out" },
  HA5: { 1: "in", 2: "in", 3: "in", 4: "out 4AJ", 5: "in", 9: "in" },
  HA6: { 1: "in", 2: "out 2AR 2AS 2AT 2AU 2AW 2AX 2AY 2AZ 2BA 2BB 2BG 2BP 2BQ 2EB 2ED 2EE 2EF 2EG 2EH 2EJ 2EL 2EN 2EP 2EQ 2ER 2ET 2EU 2EW 2FF 2FG 2HH 2HJ 2HL 2HN 2HP 2HR 2HS 2HT 2HU 2HW 2HX 2HY 2HZ 2JA 2JB 2JD 2JE 2JF 2JG 2JH 2JQ 2LA 2LB 2LD 2LE 2LF 2LG 2LH 2LJ 2LL 2LN 2LP 2LQ 2LR 2LS 2LU 2LW 2LZ 2PQ", 3: "in 3AA 3AB 3AD 3AE 3AF 3AG 3AH 3AJ 3AL 3AN 3AQ 3AS 3BA 3BB 3BD 3BE 3BG 3BJ 3BQ 3DN 3DP 3DW 3FB 3FE 3FG 3GA 3JT 3JX 3JY 3LB 3LG 3LT 3LU 3LX 3LY 3LZ 3NB 3ND 3NE 3NG 3NH 3NJ 3NL 3NN 3NQ 3NR 3NS 3NT 3NU 3NW 3NX 3NY 3PR 3PS 3PT 3PU 3PX 3QA 3QB 3QD 3QE 3QF 3QG 3QH 3QJ 3QL 3QN 3QP 3QQ 3QR 3QS 3QT 3QU 3QW 3QX 3QY 3QZ 3RA 3RB 3RD 3RE 3RF 3RG 3RJ 3RL 3RN 3RR 3RT 3RU 3RY 3SA 3SB 3SD 3SE 3SF 3SJ 3SN 3SP 3SQ 3SS 3ST 3SU 3SX 3SY 3TA 3TD 3TE 3TF 3TG 3TL 3TN 3TP 3TQ 3TR 3TS 3TT 3TW 3UA 3WA 3WB 3WD 3WE 3WF 3WG 3WH 3WJ 3WL 3XA 3XN 3XP 3XQ 3XR 3ZG 3ZH 3ZJ 3ZL 3ZN 3ZQ", 9: "in" },
  HA7: { 1: "in", 2: "in", 3: "out 3HX 3HY", 4: "in", 9: "in" },
  IG7: { 4: "out 4BJ 4FB 4GH 4GJ 4GL 4GN 4GP 4GQ 4JX 4QA 4QB 4QD 4QE 4QF 4QG 4QH 4QJ 4QQ", 5: "in 5AG 5AQ 5BF 5BZ 5DT 5EE 5FX 5FZ 5GQ 5GR 5JG 5JH 5RQ 5RR 5WA 5WB 5WD 5WE 5WF 5WG 5WJ 5WL 5WN 5WP 5WQ 5WR 5WT 5WW 5WX 5WY 5XA 5XT 5YT 5ZY", 6: "in 6AE 6AT 6AU 6BB 6BU 6BW 6DT 6EA 6FZ 6GD 6GZ 6HL 6HN 6HP 6HR 6HS 6HT 6HU 6HW 6JY 6NG 6NH 6NQ 6SR 6WB 6WD 6WE 6WF 6WG 6WJ 6WN 6WP 6WQ 6WT" },
  IG8: { 0: "out 0GT 0SQ 0XX 0XZ 0YB 0YQ 0ZX", 1: "out", 7: "in", 8: "out 8AG 8AU 8AX 8AY 8AZ 8BA 8BB 8BD 8BE 8BG 8BQ 8EN 8PX 8WD 8ZA 8ZX", 9: "out 9DL 9DN 9WJ 9WL" },
  IG9: { 5: "in 5DL 5EY 5FZ 5GD 5GE 5GG 5GR 5GT 5GX 5HB 5HE 5HL 5HN 5HQ 5HW 5JB 5JD 5JF 5JG 5JH 5JJ 5JL 5JN 5JP 5JQ 5JR 5JW 5JY 5JZ 5LA 5NY 5PP 5RJ 5RZ 5SY 5TT 5WA 5WB 5WD 5WE 5WF 5WH 5WJ 5WN 5WQ 5WS 5WX 5WY 5WZ 5XA 5XZ 5YA 5YB 5YE 5YH 5YT 5YX 5YZ", 6: "in 6AT 6DD 6DE 6DG 6DQ 6ED 6ER 6ES 6ET 6EU 6EX 6EY 6EZ 6FB 6GR 6GZ 6HB 6JA 6JB 6JD 6JE 6JF 6JG 6LP 6WA 6WB 6WE 6XQ" },
  KT4: { 7: "in 7AA 7AB 7AE 7AT 7AW 7EL 7GN 7GQ 7GZ 7HX 7HY 7HZ 7JA 7JB 7JD 7JX 7JZ 7LB 7LD 7LE 7LF 7LG 7LH 7LJ 7LL 7LN 7LP 7LQ 7LR 7LS 7LT 7LU 7LW 7LX 7LY 7LZ 7NB 7ND 7NE 7NF 7NG 7NH 7NJ 7NL 7NN 7NP 7NQ 7NR 7NS 7NT 7NU 7NW 7NX 7NY 7NZ 7PA 7PB 7PD 7PE 7PF 7PG 7PH 7PJ 7PQ 7PX 7QA 7QB 7QG 7QH 7QJ 7QX 7RA 7RB 7RD 7RE 7RF 7RG 7RH 7RJ 7RL 7RN 7RP 7RQ 7RR 7RS 7RT 7RU 7RW 7RX 7RY 7RZ 7SA 7SB 7SD 7SE 7SF 7SG 7SH 7SJ 7SL 7SN 7SP 7SQ 7SR 7SS 7ST 7SU 7SW 7SX 7SY 7WA 7WB 7WD 7WE 7WF 7WL 7WN 7WP 7WQ 7WS 7WT 7WU 7WW 7WX 7WY 7WZ 7XA 7XD 7XF 7XT 7XZ 7YA 7YB 7YE 7YF 7YG 7YH 7YJ 7YL 7YN 7YP 7YQ 7YR 7YT 7YW 7YY", 8: "in", 9: "in" },
  KT6: { 4: "out 4ER 4ET", 5: "in 5AA 5AB 5AD 5AE 5AF 5AG 5AH 5AJ 5AL 5AN 5AP 5AQ 5AR 5AS 5AT 5AU 5AW 5AX 5AY 5BB 5BD 5BE 5BF 5BG 5BH 5BJ 5BL 5BN 5BP 5BQ 5BS 5BT 5BU 5BW 5BX 5BY 5BZ 5DA 5DB 5DD 5DE 5DF 5DG 5DL 5DN 5DP 5DT 5DU 5DW 5ES 5JL 5LJ 5LR 5LS 5LU 5LX 5NA 5NB 5ND 5NE 5NF 5NG 5NH 5NJ 5NL 5NN 5NP 5NR 5NS 5NT 5NU 5NW 5NX 5NY 5PF 5PG 5PH 5PJ 5PL 5PN 5PP 5PQ 5PR 5PS 5PT 5PU 5PW 5QA 5QF 5QP 5QW 5QZ 5RY 5WA 5WB 5WE 5WF 5WG 5WH 5WJ 5WL 5WN 5WP 5WQ 5WR 5WS 5WT 5WU 5WY 5WZ 5XT 5XY 5XZ 5YA 5YB 5YD 5YE 5YF 5YG 5YH 5YJ 5YL 5YP 5YQ 5YR 5YT 5YX 5YY 5YZ 5ZA 5ZD", 6: "out 6ND 6NZ 6PF 6PH 6QE 6RP 6SA", 7: "in" },
  KT7: { 0: "in 0DH 0FG 0FH 0FJ 0FN 0FQ 0FS 0FW 0FZ 0HG 0JU 0LD 0RF 0SB 0TZ 0UY 0WA 0WF 0WG 0WH 0WJ 0WL 0WN 0WP 0WQ 0WR 0WS 0WT 0WU 0WX 0WY 0WZ 0XD 0XJ 0YE 0YT 0YU 0YY 0YZ 0ZA 0ZF 0ZH 0ZR 0ZS 0ZT 0ZW 0ZY 0ZZ" },
  KT8: { 0: "out", 1: "out", 2: "out", 8: "out", 9: "in 9AN 9AP 9AR 9AS 9AT 9AU 9AX 9BD 9BN 9BP 9BS 9BU 9BW 9BX 9BY 9BZ 9DA 9DB 9DD 9DF" },
  KT9: { 1: "out 1BH 1UE 1UF 1UG 1UL", 2: "in", 9: "in" },
  KT17: { 1: "out", 2: "in 2DF 2JJ 2JL 2JW 2LP 2LR", 3: "in 3HL 3HN", 4: "out", 9: "out" },
  KT18: { 5: "out", 6: "out", 7: "in 7TR 7YP" },
  KT19: { 0: "out", 7: "out", 8: "out", 9: "in 9HN 9HW 9JA" },
  KT22: { 0: "in 0DP", 2: "out", 7: "out", 8: "out", 9: "out" },
  RM4: { 1: "in 1AN 1AQ 1AW 1BJ 1BQ 1BW 1BZ 1ED 1EN 1EQ 1EZ 1FA 1GD 1JB 1JW 1JX 1LA 1LB 1LD 1LE 1LH 1LY 1PA 1PB 1PD 1PE 1PH 1PJ 1PL 1PP 1PR 1PS 1PT 1PU 1PX 1PY 1QA 1QB 1QD 1QF 1QH 1QJ 1QL 1QP 1QR 1QS 1QT 1QX 1UY 1WA 1WB 1WD 1WJ 1WP 1WX 1WY 1WZ 1XE 1XF 1XN 1ZB" },
  RM14: { 1: "in", 2: "out 2XB", 3: "out 3BF 3BJ 3BN 3BP 3EB 3ED 3EE 3EF 3EG 3EN 3PD 3PJ 3PN 3PQ 3RE 3RH 3RJ 3RL 3RP 3RR 3RS 3RT 3RU 3RX 3SA 3SB 3SD 3SJ 3SL 3SP 3SR 3SS 3ST 3SU 3SW 3SX 3TA 3TB 3TD 3TE 3TF 3TH 3TJ 3TL 3TP 3TR 3TS 3TT 3TU 3TY 3XS", 9: "in" },
  RM15: { 4: "in 4UT 4UU 4UX 4WA 4XJ 4XR", 5: "out", 6: "out", 9: "out" },
  SM2: { 5: "out 5PA 5PD 5PJ 5PP 5PQ 5WX", 6: "in", 7: "out 7HJ 7HR 7HS 7HU 7JL 7JP 7JR 7JS 7JT 7JU 7JX 7JY 7JZ 7LA 7LB 7LF 7LG 7LH 7LJ 7LL 7LN 7LP 7LQ 7LR 7LS 7LT 7LU 7LW 7LX 7ND 7NE 7NF 7NG 7NH 7NQ" },
  SM3: { 2: "in", 8: "out 8AB 8AL 8BB 8DP 8QL", 9: "in" },
  SM5: { 1: "in", 2: "in", 3: "in", 4: "out 4HT", 9: "in" },
  SM7: { 1: "in 1PF 1PL 1PQ 1PS 1PW 1QE 1QG 1QH 1QL 1QN 1QR 1QT 1QW 1QX 1QZ 1RB 1RD 1RE 1RF", 2: "out", 3: "in 3BA 3BE 3DX 3HZ 3JA 3JF", 9: "out" },
  TN14: { 5: "out", 6: "out", 7: "in 7HR 7NQ 7NZ 7QA 7QB 7QD 7QE 7QF 7QG 7QH 7QJ 7QL 7QN 7QP 7QQ 7QR 7QS 7QT 7QU 7QX 7QY 7RA 7RB 7RD 7RE 7RF 7RG 7SF" },
  TN16: { 1: "in 1BW 1DF 1DW 1EY 1RZ 1ST 1UE 1WA 1WB 1WD 1WE 1WF 1WG 1WH 1WJ 1WL 1WN 1WP 1WQ 1WR 1WT 1WU 1WW 1WY 1WZ 1XA 1XB 1XF 1XH 1XL 1XP 1XQ 1XT 1XY 1XZ 1YA 1YB 1YF 1YL 1YN 1YQ 1YW 1YZ 1ZA 1ZL 1ZN 1ZQ 1ZS 1ZT 1ZY", 2: "in 2AW 2AZ 2BY 2DZ 2HL 2HN 2HP 2HR 2HS 2HT 2HU 2HW 2HX 2HY 2JA 2JB 2JD 2JE 2LF 2LY 2LZ 2NN 2NP 2NS 2NW 2PB 2WA 2WB 2WE 2WY 2WZ 2XA 2ZA 2ZN 2ZR 2ZS 2ZT 2ZU 2ZW 2ZX 2ZZ", 3: "in", 9: "in" },
  TW6: { 1: "in", 2: "in", 3: "out 3PF" },
  TW12: { 1: "in", 2: "out 2FZ", 3: "in", 9: "in" },
  TW14: { 0: "in", 8: "out 8FP 8RT 8RW", 9: "in" },
  TW15: { 1: "in 1AT 1AU 1AX 1AZ 1BA 1BF 1BL 1HX", 2: "out", 3: "out", 9: "out" },
  TW16: { 5: "out", 6: "out", 7: "out", 9: "out" },
  TW19: { 5: "out", 6: "in 6BP 6BW", 7: "in 7LE 7LQ 7LZ 7NH 7NL" },
  UB8: { 1: "out 1DH 1EG 1HP 1HZ 1NB", 2: "in", 3: "in", 9: "in" },
  UB9: { 4: "out", 5: "in 5AG 5BF 5BS 5DZ 5EP 5FA 5HN 5LX 5NX 5PD 5QB 5QD 5QE 5QF 5QG 5QH 5QJ 5QN 5QP 5QQ 5QR 5QS 5QT 5QZ 5UZ 5WA 5WB 5WD 5WE 5WF 5WG 5WH 5WJ 5WN 5XA 5XZ 5ZJ 5ZN 5ZQ 5ZR 5ZU 5ZX", 6: "out 6HZ" },
  WD3: { 0: "out", 1: "in 1PZ", 2: "in 2UR 2UT 2UU 2UW 2UX 2UY", 3: "out", 4: "out", 5: "out", 6: "out", 7: "out", 8: "in 8UE 8UF 8UR 8UT 8UU 8UW 8UX 8UZ 8XD", 9: "out" },
  WD6: { 1: "out", 2: "in 2RN 2RW", 3: "out", 4: "out", 5: "out", 9: "out" },
  WD23: { 1: "in 1JQ 1NT 1NX", 2: "out", 3: "out", 4: "out", 9: "out" },
};
// Postcode areas whose every address is in the London post town.
const LONDON_POSTCODE_AREAS = new Set(["E", "EC", "N", "NW", "SE", "SW", "W", "WC"]);
// London as a whole, and London named by a part with no fixed boundary.
const WHOLE_LONDON = /^(?:greater )?london$/;
const VAGUE_LONDON = /^(?:central|inner|outer|north|south|east|west|north east|north west|south east|south west) london$/;
// The short names a town Open Prices records by its long name goes by
// (OpenStreetMap uses the long name): a Newcastle check is in Newcastle upon
// Tyne. Only these, written out: Hull is Kingston upon Hull but "Kingston" is
// Kingston upon Thames, and "Newcastle" is never Newcastle-under-Lyme.
const TOWN_SHORT_NAMES = new Map([
  ["newcastle upon tyne", ["newcastle"]],
  ["kingston upon hull", ["hull"]],
  ["brighton and hove", ["brighton", "hove"]],
  ["southend on sea", ["southend"]],
  ["stoke on trent", ["stoke"]],
  ["kingston upon thames", ["kingston"]],
  ["richmond upon thames", ["richmond"]],
  ["staines upon thames", ["staines"]],
]);
// A locality that names a place made of towns names each of them.
const LOCALITY_TOWNS = new Map([["brighton and hove", ["brighton", "hove"]]]);

// A place name in plain form: lower case, "&" as "and", no apostrophes or
// other punctuation, single spaces. "Hammersmith & Fulham" is "hammersmith
// and fulham" and "Stoke-on-Trent" is "stoke on trent".
function placeName(value) {
  return typeof value === "string"
    ? value
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/['’.]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
    : "";
}

// Borough (plain form) -> its name as written; postcode district -> the
// boroughs (plain form) it has addresses in; outer post town (plain form)
// -> its name as written, its London districts, and the boroughs those are
// in; and district -> its outer post towns (plain form).
const BOROUGH_NAMES = new Map(Object.keys(LONDON_BOROUGH_DISTRICTS).map((name) => [placeName(name), name]));
const LONDON_BOROUGHS = new Set(BOROUGH_NAMES.keys());
const DISTRICT_BOROUGHS = new Map();
for (const [name, list] of Object.entries(LONDON_BOROUGH_DISTRICTS))
  for (const district of list.split(" ")) {
    if (!DISTRICT_BOROUGHS.has(district)) DISTRICT_BOROUGHS.set(district, new Set());
    DISTRICT_BOROUGHS.get(district).add(placeName(name));
  }
const POST_TOWN_NAMES = new Map(Object.keys(LONDON_POST_TOWNS).map((name) => [placeName(name), name]));
const POST_TOWN_BOROUGHS = new Map();
const DISTRICT_POST_TOWNS = new Map();
for (const [name, list] of Object.entries(LONDON_POST_TOWNS)) {
  const town = placeName(name);
  const boroughs = new Set();
  for (const district of list.split(" ")) {
    for (const borough of DISTRICT_BOROUGHS.get(district) ?? []) boroughs.add(borough);
    if (!DISTRICT_POST_TOWNS.has(district)) DISTRICT_POST_TOWNS.set(district, []);
    DISTRICT_POST_TOWNS.get(district).push(town);
  }
  POST_TOWN_BOROUGHS.set(town, boroughs);
}
// District -> sector -> "in", "out", or { side, codes } (LONDON_BOUNDARY).
const BOUNDARY_SECTORS = new Map(
  Object.entries(LONDON_BOUNDARY).map(([district, sectors]) => [
    district,
    new Map(
      Object.entries(sectors).map(([sector, value]) => {
        const [side, ...codes] = value.split(" ");
        return [sector, codes.length ? { side, codes: new Set(codes) } : side];
      }),
    ),
  ]),
);

// Where a full postcode is against Greater London: { district, boroughs,
// london }. boroughs is the set of boroughs (plain form) its district has
// addresses in, or null; london is "in" (in Greater London), "out", or null
// when the postcode directory does not place it (a sector it does not have,
// in a district on the boundary).
function londonPostcode(postcode) {
  const [district, inward] = postcode.split(" ");
  const boroughs = DISTRICT_BOROUGHS.get(district) ?? null;
  const sectors = BOUNDARY_SECTORS.get(district);
  let london;
  if (sectors) {
    const sector = sectors.get(inward[0]) ?? null;
    london = sector === null || typeof sector === "string" ? sector : sector.codes.has(inward) === (sector.side === "in") ? "in" : "out";
  } else london = boroughs !== null || LONDON_POSTCODE_AREAS.has(/^[A-Z]+/.exec(district)[0]) ? "in" : "out";
  return { district, boroughs, london };
}

// The London borough a place name names, in plain form, or null: "Camden",
// "London Borough of Camden", "Royal Borough of Greenwich", "City of
// Westminster", "Camden London". A name used elsewhere too ("Richmond",
// "Kingston") is not a borough unless written in full.
function boroughOf(name) {
  const plainName = placeName(name);
  if (LONDON_BOROUGHS.has(plainName)) return plainName;
  const bare = plainName
    .replace(/^(?:the )?(?:london borough of|royal borough of|borough of|city of) /, "")
    .replace(/ london$/, "");
  return LONDON_BOROUGHS.has(bare) ? bare : null;
}
// London as a whole, a part of it, or a borough.
const isLondon = (name) => WHOLE_LONDON.test(placeName(name)) || VAGUE_LONDON.test(placeName(name)) || boroughOf(name) !== null;

// The names a shop's town goes by, in plain form: its own, its short names,
// and without "City of" before it or "City" after it ("City of Edinburgh"
// is Edinburgh).
function townNames(name) {
  const plainName = placeName(name);
  if (!plainName) return [];
  const bare = plainName.replace(/^city of /, "").replace(/ city$/, "");
  return [...new Set([plainName, bare, ...(TOWN_SHORT_NAMES.get(plainName) ?? [])].filter(Boolean))];
}
// The names a locality part covers: itself, without "City of" or "City",
// and the towns it is made of.
const localityNames = (part) => [
  ...new Set([part, part.replace(/^city of /, "").replace(/ city$/, ""), ...(LOCALITY_TOWNS.get(part) ?? [])].filter(Boolean)),
];

// A locality's parts in plain form: "Preston, Lancashire" is ["preston",
// "lancashire"] and "Camden (London)" is ["camden", "london"].
const localityParts = (locality) =>
  typeof locality === "string"
    ? locality
        .split(/[,;/()|]+|\s[-\u2013]\s/)
        .map(placeName)
        .filter(Boolean)
    : [];

// The outer London post towns (plain form) that a set of locality names
// names: "romford", or "kingston upon thames" for "kingston".
const POST_TOWN_ALIASES = [...POST_TOWN_NAMES.keys()].map((town) => [town, townNames(town)]);
const postTownsNamed = (named) => POST_TOWN_ALIASES.filter(([, names]) => names.some((n) => named.has(n))).map(([town]) => town);

// Locality parts that say nothing of where in London a place is: the
// country, or a county Greater London took parts of ("Ilford, Essex").
const NEUTRAL_PARTS = new Set(["uk", "united kingdom", "england", "great britain", "britain", "gb", "middlesex", "surrey", "kent", "essex", "hertfordshire", "herts"]);

// A locality part that is an outer London post town followed by London
// with no comma ("Romford London", "Kingston London") names that post town,
// as "Romford, London" does, just as boroughOf reads "Croydon London" as
// Croydon. Any other part is returned as it is.
function postTownPart(part) {
  if (!part.endsWith(" london") || boroughOf(part) !== null) return part;
  const rest = part.slice(0, -" london".length);
  return postTownsNamed(new Set(localityNames(rest))).length ? rest : part;
}

// What a locality says of London, and the parts that name its place:
//  - "borough": it names one or more London boroughs ("Camden", "Camden,
//    London");
//  - "london": London as a whole ("London", "Greater London", "London, UK");
//  - "town" with parts the outer post towns it names, when London follows
//    one ("Romford, London" and "Romford London" are Romford);
//  - "vague": a part of London with no fixed boundary ("North London"), or
//    any other place followed by London ("Stratford, London", "Camden Town,
//    London"), which cannot be checked against a shop's postcode;
//  - "town" otherwise (a town anywhere, including an outer London post town
//    such as Romford).
function londonTarget(written) {
  const parts = written.map(postTownPart);
  const boroughs = new Set(parts.map(boroughOf).filter(Boolean));
  if (boroughs.size) return { kind: "borough", boroughs, parts };
  if (!parts.some((part) => WHOLE_LONDON.test(part) || VAGUE_LONDON.test(part))) return { kind: "town", boroughs, parts };
  const places = parts.filter((part) => !WHOLE_LONDON.test(part) && !NEUTRAL_PARTS.has(part));
  if (!places.length) return { kind: "london", boroughs, parts };
  if (places.every((part) => !VAGUE_LONDON.test(part) && postTownsNamed(new Set(localityNames(part))).length))
    return { kind: "town", boroughs, parts: places };
  return { kind: "vague", boroughs, parts };
}

// "A", "A or B", "A, B or C".
const orList = (names) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`);

/**
 * Whether an Open Prices shop ({ store, place, city }) is in a check's
 * locality, by what Open Prices records of where it is.
 *
 * A postcode is placed against Greater London by the postcode directory
 * (londonPostcode): a postcode in a district wholly in London is in it, and
 * in a district on the boundary (DA1, KT17, EN8 and so on) its sector, or on
 * a boundary sector the postcode itself, decides (DA1 1BX in Dartford is
 * outside London; DA1 4HS in Crayford is in Bexley).
 *
 * For a locality that names a London borough (or the City of London), a
 * postcode agrees when it is in London and its district has addresses in
 * that borough (LONDON_BOROUGH_DISTRICTS), and contradicts it when it is
 * outside London or its district has none, whatever the city says ("CR0"
 * is not in Camden, though Open Prices gives the city as London). A city
 * agrees when it names the borough, and contradicts it when it names
 * another borough, or an outer post town that does not serve the borough.
 * A city of London, an outer post town that serves the borough ("Romford"
 * for Havering), or any other name Open Prices records for a place ("Acton",
 * "Wood Green") says nothing, so the postcode decides.
 *
 * For "London" or "Greater London", a postcode in London, or a city of
 * London or a London borough, agrees, and a postcode outside London
 * contradicts it; any other city says nothing. A part of London with no
 * fixed boundary ("North London"), or another place followed by London
 * ("Stratford, London"), cannot be checked, so a London shop is never shown
 * to be in it, and a shop outside London contradicts it. "Romford, London"
 * and "Romford London" are Romford.
 *
 * For a town, the shop's city agrees when the locality names it or a short
 * name it goes by ("Newcastle" for Newcastle upon Tyne, "Hull" for Kingston
 * upon Hull, "Edinburgh" for City of Edinburgh). A city of London or a
 * London borough contradicts a town, except that for an outer London post
 * town ("Romford") a city of London, or a borough that serves it, says
 * nothing; for an outer post town another outer post town contradicts it.
 * Any other city ("Stirchley" on a Birmingham check) says nothing, since it
 * may be a part of the town: alone it leaves the shop unknown (cause
 * "town-not-shown"), never elsewhere. A postcode in that post town agrees,
 * a postcode in another outer post town contradicts it, and a postcode
 * wholly in London contradicts any town. Other postcodes say nothing, since
 * a postcode area covers several towns (PR is Preston, Chorley and
 * Southport).
 *
 * Other text in the place field (a town, or a street) can only agree.
 *
 * Returns { verdict, where, inLondon, locality, cause, detail }:
 *  - verdict "disagrees" when anything contradicts the locality, "agrees"
 *    when something agrees and nothing contradicts it, else "unknown";
 *  - where the place and city Open Prices records ("PR1 2AR, Preston"), or
 *    null;
 *  - inLondon true when the postcode is in Greater London, or (without one)
 *    the city is London or a London borough;
 *  - locality what the locality says of London: "borough", "london",
 *    "vague", "post town" (an outer London post town such as Romford) or
 *    "town";
 *  - cause, for a verdict other than "agrees": "elsewhere" (disagrees),
 *    "london-only" (placed in London, or an outer post town, but not in the
 *    borough or town), "not-shown" (placed by a city, or a postcode the
 *    directory does not place, that does not show it is in the borough or
 *    London), "town-not-shown" (a town locality and a city that is another
 *    name, with nothing else placing it), "vague" (a London shop and a
 *    locality such as "North London"), "postcode-only" (only a postcode
 *    that does not place it) or "unplaced" (nothing), else null;
 *  - detail, when the postcode alone contradicts the locality, or does not
 *    place the shop, why ("the CR0 postcode district is in Croydon, Merton
 *    or Sutton", "KT17 4ER is outside Greater London"), else null.
 */
export function shopInLocality(shop, locality) {
  const target = londonTarget(localityParts(locality));
  const named = new Set(target.parts.flatMap(localityNames));
  const namesTown = (name) => townNames(name).some((n) => named.has(n));
  // The outer London post towns the locality names ("Romford", "Kingston").
  const localTowns = postTownsNamed(named);
  const place = typeof shop?.place === "string" ? shop.place.trim() : "";
  const cityText = typeof shop?.city === "string" ? shop.city.trim() : "";
  const city = placeName(cityText);
  const postcode = postcodeOf(place);
  const pc = postcode ? londonPostcode(postcode) : null;
  const district = pc?.district ?? null;
  const londonArea = district !== null && LONDON_POSTCODE_AREAS.has(/^[A-Z]+/.exec(district)[0]);
  const town = placeName(place.replace(new RegExp(POSTCODE.source, "gi"), " "));
  const cityBorough = boroughOf(cityText);
  const cityLondon = city !== "" && isLondon(cityText);
  const cityTownBoroughs = POST_TOWN_BOROUGHS.get(city) ?? null;
  const inBorough = (boroughs) => boroughs !== null && [...boroughs].some((b) => target.boroughs.has(b));
  let agrees = false;
  let contradicts = false;
  let unplacedPostcode = false;
  // A town locality and a city that is another name (a suburb, or a town
  // the tables do not place): it neither shows the shop is in the town nor
  // that it is elsewhere.
  let cityNotShown = false;
  let detail = null;
  if (postcode) {
    const postTowns = DISTRICT_POST_TOWNS.get(district) ?? [];
    if (target.kind === "town") {
      if (postTowns.some(namesTown)) agrees = true;
      else if (postTowns.length && localTowns.length) {
        contradicts = true;
        detail = `the ${district} postcode district is in ${orList(postTowns.map((t) => POST_TOWN_NAMES.get(t)))}`;
      } else if (londonArea) {
        contradicts = true;
        detail = localTowns.length
          ? `${postcode} is not in ${orList(localTowns.map((t) => POST_TOWN_NAMES.get(t)))}`
          : `${postcode} is a London postcode`;
      }
    } else if (pc.london === "out") {
      contradicts = true;
      detail = `${postcode} is outside Greater London`;
    } else if (target.kind === "borough" && pc.boroughs !== null && !inBorough(pc.boroughs)) {
      contradicts = true;
      detail = `the ${district} postcode district is in ${orList([...pc.boroughs].map((b) => BOROUGH_NAMES.get(b)))}`;
    } else if (pc.london === null) {
      unplacedPostcode = true;
      detail = `the ${district} postcode district crosses the Greater London boundary`;
    } else if (target.kind === "london" || (target.kind === "borough" && pc.boroughs !== null)) agrees = true;
  }
  if (city) {
    // "agrees", "contradicts", or null when the city says nothing either way.
    let says = null;
    if (target.kind === "town") {
      if (namesTown(cityText)) says = "agrees";
      // For an outer London post town, a city of London, or a borough that
      // serves it, says nothing.
      else if (localTowns.length && ((cityLondon && !cityBorough) || localTowns.some((t) => POST_TOWN_BOROUGHS.get(t).has(cityBorough))))
        says = null;
      // A city of London or a London borough is not a town elsewhere, and
      // another outer post town is not an outer post town's area.
      else if (cityLondon || (localTowns.length && cityTownBoroughs !== null)) says = "contradicts";
      // Any other name ("Stirchley" on a Birmingham check) may be a part of
      // the town, so it does not show the shop is elsewhere.
      else cityNotShown = true;
    } else if (target.kind === "london") says = cityLondon ? "agrees" : null;
    else if (target.kind === "borough") {
      if (cityBorough && target.boroughs.has(cityBorough)) says = "agrees";
      else if (inBorough(cityTownBoroughs)) says = null;
      else if (cityBorough || cityTownBoroughs) says = "contradicts";
    }
    if (says === "agrees") agrees = true;
    if (says === "contradicts") {
      contradicts = true;
      detail = null;
    } else if (pc?.london === "out" && !cityLondon && !cityTownBoroughs) detail = null; // "PR1 2AR, Preston" shows it
  }
  if (
    town &&
    (target.kind === "town"
      ? namesTown(town)
      : target.kind === "london"
        ? isLondon(town)
        : target.kind === "borough" && target.boroughs.has(boroughOf(town)))
  )
    agrees = true;
  const where = [...new Set([place, cityText].filter(Boolean))].join(", ") || null;
  const inLondon = pc ? pc.london === "in" : cityLondon;
  const verdict = contradicts ? "disagrees" : agrees ? "agrees" : "unknown";
  let cause = null;
  if (verdict === "disagrees") cause = "elsewhere";
  else if (verdict === "unknown") {
    if (target.kind === "vague" && where) cause = "vague";
    else if (unplacedPostcode) cause = "not-shown";
    else if (cityNotShown) cause = "town-not-shown";
    else if ((target.kind === "borough" || localTowns.length) && (inLondon || cityTownBoroughs !== null)) cause = "london-only";
    else if (target.kind !== "town" && city) cause = "not-shown";
    else cause = where ? "postcode-only" : "unplaced";
  }
  return {
    verdict,
    where,
    inLondon,
    locality: target.kind === "town" && localTowns.length ? "post town" : target.kind,
    cause,
    detail: verdict === "disagrees" || cause === "not-shown" ? detail : null,
  };
}

// The city an Open Prices shop is recorded under, as written.
const shopCity = (shop) => (typeof shop?.city === "string" ? shop.city.trim() : "");

// Why a shop a check names does not count as its branch, as a clause for
// after "the shop the branch check names, but" (branchPlace). city is the
// city Open Prices records the shop under.
function placeClause(judged, locality, city) {
  switch (judged.cause) {
    case "elsewhere":
      return `Open Prices places it outside ${locality}${judged.detail ? ` (${judged.detail})` : ""}`;
    case "london-only":
    case "not-shown":
      return `Open Prices places it at ${judged.where}, which does not show it is in ${locality}${judged.detail ? ` (${judged.detail})` : ""}`;
    case "town-not-shown":
      return `Open Prices records it under ${city}, which does not show it is in ${locality}`;
    case "vague":
      return `${locality} is not a London borough, so Open Prices does not show the shop is there`;
    case "postcode-only":
      return `Open Prices gives only ${judged.where}, not which town it is in`;
    case "unplaced":
      return "Open Prices does not say which town it is in";
    default:
      return null;
  }
}

/**
 * Where an Open Prices shop ({ osm_id, store, place, city }) that a check's
 * branch names stands against the check's locality, for saying why a price
 * seen there does not count for the check: null when the branch does not
 * name the shop, else shopInLocality's result with text, a clause for after
 * "the shop the branch check names, but" ("Open Prices places it outside
 * Camden", "Open Prices records it under Stirchley, which does not show it
 * is in Birmingham", "Open Prices does not say which town it is in"), or
 * null when the shop is in the locality.
 */
export function branchPlace(shop, check) {
  if (!namesShop(shop, check)) return null;
  const judged = shopInLocality(shop, check.locality);
  return { ...judged, text: placeClause(judged, check.locality, shopCity(shop)) };
}

/**
 * Whether an Open Prices shop ({ osm_id, store, place, city }) is the branch
 * a check names: the check's branch names the shop (the same OpenStreetMap
 * id, or the same retailer and the same full postcode), and Open Prices
 * places the shop in the check's locality (shopInLocality). A check that
 * names no branch, or names it only by a town or borough, never matches. A
 * shop Open Prices places elsewhere ("node/111" on a Camden check, when
 * node/111 is in Preston, or "node/333" when it is at CR0 1AB) is not the
 * branch, and neither is one Open Prices does not place in the locality
 * (no location, only "London" for a borough check, or a locality such as
 * "Stratford, London" that has no boundary to check): the check names the
 * shop, but nothing shows it is where the check says, so the price stays
 * unconfirmed and only a shelf price recorded on the check costs the trip.
 * branchPlace says why, for a reason.
 */
export function shopIsBranch(shop, check) {
  return namesShop(shop, check) && shopInLocality(shop, check.locality).verdict === "agrees";
}

// The Open Prices shops a check's branch names (namesShop), one row per
// distinct { osm_id, store, place, city }. [] without the observations
// table or a named branch.
function shopsNamed(db, check) {
  const named = checkBranch(check);
  if (!named.named || (!named.osmId && !named.postcode) || !tableExists(db, "observations")) return [];
  const rows = [];
  if (named.osmId)
    rows.push(
      ...db.prepare("SELECT DISTINCT osm_id, store, place, city FROM observations WHERE lower(trim(osm_id)) = ?").all(named.osmId),
    );
  if (named.postcode)
    rows.push(
      ...db
        .prepare("SELECT DISTINCT osm_id, store, place, city FROM observations WHERE instr(replace(upper(place), ' ', ''), ?) > 0")
        .all(named.postcode.replace(" ", "")),
    );
  const seen = new Set();
  return rows.map(plain).filter((shop) => {
    const key = JSON.stringify([shop.osm_id, shop.store, shop.place, shop.city]);
    if (seen.has(key) || !namesShop(shop, check)) return false;
    seen.add(key);
    return true;
  });
}

// The postcode Open Prices gives for an OpenStreetMap id: the one postcode
// its observations record, or null when they give none or disagree.
function osmPostcode(db, osmId) {
  if (!osmId || !tableExists(db, "observations")) return null;
  const postcodes = new Set(
    db
      .prepare("SELECT DISTINCT place FROM observations WHERE lower(trim(osm_id)) = ? AND place IS NOT NULL")
      .all(osmId)
      .map((r) => postcodeOf(String(r.place)))
      .filter(Boolean),
  );
  return postcodes.size === 1 ? [...postcodes][0] : null;
}

// Rows from the checks table with branch_postcode worked out now where it
// was not stored: a check recorded before Open Prices knew its shop, or
// before the column existed. Nothing is written.
function withBranchPostcodes(db, rows) {
  const known = new Map();
  for (const row of rows) {
    if (!row || row.branch_postcode) continue;
    const osmId = osmIdOf(row.branch);
    if (!osmId) continue;
    if (!known.has(osmId)) known.set(osmId, osmPostcode(db, osmId));
    row.branch_postcode = known.get(osmId);
  }
  return rows;
}

// A warning for the person recording a check whose branch names a shop
// Open Prices places outside the check's locality, or does not place in it
// (shopInLocality): prices seen there will not count for this check. Null
// otherwise, including when Open Prices does not know the shop.
function branchWarningFor(db, row) {
  const shops = shopsNamed(db, row);
  if (!shops.length) return null;
  const judged = shops.map((shop) => ({ ...shopInLocality(shop, row.locality), city: shopCity(shop) }));
  const against = judged.find((j) => j.verdict === "disagrees");
  if (!against && judged.some((j) => j.verdict === "agrees")) return null;
  const branch = branchIdentity(row.branch).text;
  const tail =
    row.price_pence !== null
      ? " The shelf price recorded on this check still applies."
      : " To cost a trip from this check, record the shelf price on it.";
  if (against)
    return `Open Prices places the branch named (${branch}) at ${against.where}, which does not match the locality ${row.locality}${against.detail ? ` (${against.detail})` : ""}, so prices seen there do not count for this check. Check the branch and the locality.${against.inLondon && against.locality === "town" ? " For a shop in London, enter London or the London borough as the locality." : ""}${tail}`;
  // Nothing places the shop in the locality: say what Open Prices gives.
  const unknown = ["vague", "london-only", "not-shown", "town-not-shown", "postcode-only", "unplaced"]
    .map((cause) => judged.find((j) => j.cause === cause))
    .find(Boolean);
  if (unknown.cause === "town-not-shown")
    return `Open Prices records the branch named (${branch}) under ${unknown.city}, which does not show it is in ${row.locality}, so prices seen there do not count for this check.${tail}`;
  if (unknown.cause === "vague")
    return `Open Prices places the branch named (${branch}) at ${unknown.where}, but ${row.locality} is not a London borough, so that does not show the branch is there, and prices seen there do not count for this check. Enter the London borough, or London, as the locality.${tail}`;
  if (unknown.cause === "london-only" || unknown.cause === "not-shown")
    return `Open Prices places the branch named (${branch}) at ${unknown.where}, which does not show it is in ${row.locality}${unknown.detail ? ` (${unknown.detail})` : ""}, so prices seen there do not count for this check.${tail}`;
  return `Open Prices does not say which town the branch named (${branch}) is in${unknown.cause === "postcode-only" ? ` (it gives only ${unknown.where})` : ""}, so prices seen there do not count for this check in ${row.locality}.${tail}`;
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
 *  branchWarning     when the branch names a shop Open Prices places
 *                    outside this check's locality, or does not place in
 *                    it (shopInLocality: only in London for a borough
 *                    check, a London shop for "North London" or "Stratford,
 *                    London", a district name with no postcode such as
 *                    "Acton", a suburb name such as "Stirchley" for a town
 *                    check, or not at all), a plain warning that prices
 *                    seen there do not count for this check; null when no
 *                    shop is named, or when some of the Open Prices rows
 *                    for the shop place it in the locality and none places
 *                    it elsewhere
 *
 * The stored row's branch_postcode is the postcode Open Prices gives for
 * the OpenStreetMap id the branch names (null when it names none, or Open
 * Prices gives no single postcode for it), so sameBranch can match this
 * check with one that names the shop by its postcode.
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
  row.branch_postcode = osmPostcode(db, osmIdOf(row.branch));
  const result = db
    .prepare(
      `INSERT INTO availability_checks(barcode, retailer, locality, checked_at, method, in_stock, units_seen, note, branch, price_pence, branch_postcode)
 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.barcode, row.retailer, row.locality, row.checked_at, row.method, row.in_stock, row.units_seen, row.note,
      row.branch, row.price_pence, row.branch_postcode,
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
    branchWarning: branchWarningFor(db, stored),
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
 * that recorded a shelf price (price_pence). A check whose branch names an
 * OpenStreetMap id with no branch_postcode stored gets the one Open Prices
 * gives now (nothing is written), so sameBranch can use it.
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
  return withBranchPostcodes(db, [plain(db.prepare(sql).get(...params))])[0];
}

/**
 * Every check for a barcode at a retailer in a locality made between
 * sinceIso and untilIso, newest first (at most limit). Retailer and
 * locality compare without case. [] when the audit tables are absent or a
 * value is missing. branch_postcode is filled as latestCheck fills it.
 */
export function shelfChecks(db, { barcode, retailer, locality, since, until, limit = 200 }) {
  const gtin = normaliseBarcode(barcode);
  const shop = trimmed(retailer);
  const place = trimmed(locality);
  const from = Date.parse(since);
  const to = Date.parse(until);
  if (!gtin || !shop || !place || !Number.isFinite(from) || !Number.isFinite(to) || !tableExists(db, "availability_checks"))
    return [];
  const rows = db
    .prepare(
      `SELECT * FROM availability_checks
 WHERE barcode = ? AND retailer = ? AND locality = ? AND checked_at >= ? AND checked_at <= ?
 ORDER BY checked_at DESC, id DESC LIMIT ?`,
    )
    .all(gtin, shop, place, new Date(from).toISOString(), new Date(to).toISOString(), limit)
    .map(plain);
  return withBranchPostcodes(db, rows);
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
