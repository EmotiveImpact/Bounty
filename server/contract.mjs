// Shared evidence contract. Every module that reads or writes evidence uses
// these names. Money is integer pence; dates are ISO 8601 strings (UTC).

// Evidence classes. They answer different questions and are never pooled:
// a retail offer is what it costs to acquire, an asking price is what a
// competitor hopes to get, and a completed sale is what a buyer actually paid.
export const KIND = Object.freeze({
  RETAIL: "Retail offer",
  AMAZON: "Amazon offer history",
  ASKING: "Active asking price",
  SOLD: "Reported completed sale",
});
export const KINDS = Object.freeze(Object.values(KIND));

// Licence or terms that govern a record. Display to members needs an explicit
// permission row (see PERMISSIONS_TABLE) except where noted.
export const LICENCE = Object.freeze({
  ODBL: "ODbL", // Open Prices: attribution and share-alike; stored separately
  FEED: "Licensed feed", // Awin: programme terms decide display rights
  PROVIDER: "Provider terms", // Hobnight, Keepa, eBay Browse
  SELF: "Self-reported", // Manually researched sales: private research only
});

// Licensed feed, provider and self-reported evidence. Open Prices (ODbL) rows
// live in `observations`, never in this table.
//
// price      Retail: offer price per unit. Asking: item price excluding
//            separately charged shipping. Sold: realised total INCLUDING
//            buyer-paid postage.
// shipping   Retail: delivery charge; Asking: buyer shipping; Sold: the
//            postage component of price when known. Null when unknown.
// observed   Source date of the observation (not the import time).
// listed     Sold only: when the sold listing started, for days-to-sell.
// seller     Asking: seller id. Sold: the seller's name, used to count
//            independent sales. Only a named seller counts; a listing id
//            ("listing:<id>") is not a seller. Null means independence is
//            unknown.
// location   Branch or postcode when the source states one. Null means the
//            branch is unknown, which never establishes local stock.
// availability  As reported by the source; never treated as verified stock.
// promotion  Promotion or loyalty condition attached to the price, if any.
// size/pack/model/condition  Normalised lower-case match attributes; null when
//            the source does not say. Matching fails closed on nulls.
// was_price, rrp_price  Retail only: a previous price or recommended retail
//            price the source claims (Awin product_price_old, rrp_price), in
//            pence. Shown as a claimed price for comparison and never used
//            as the cost of stock.
export const RESEARCH_TABLE = `CREATE TABLE IF NOT EXISTS research (
 provider TEXT NOT NULL,
 source_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 title TEXT NOT NULL,
 barcode TEXT,
 variant TEXT,
 size TEXT,
 pack TEXT,
 model TEXT,
 condition TEXT,
 price INTEGER NOT NULL,
 shipping INTEGER,
 observed TEXT,
 listed TEXT,
 retailer TEXT,
 location TEXT,
 availability TEXT,
 promotion TEXT,
 seller TEXT,
 url TEXT,
 licence TEXT,
 was_price INTEGER,
 rrp_price INTEGER,
 imported TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 first_imported TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(provider, source_id)
)`;
export const RESEARCH_COLUMNS = Object.freeze([
  "provider", "source_id", "kind", "title", "barcode", "variant", "size",
  "pack", "model", "condition", "price", "shipping", "observed", "listed",
  "retailer", "location", "availability", "promotion", "seller", "url",
  "licence", "was_price", "rrp_price", "imported", "first_imported",
]);

// Open Prices (ODbL) observations. Kept apart from licensed feed data.
// id is the Open Prices price id. day is the observation date; imported and
// first_imported are local import times. regular_price is the undiscounted
// price when the observation was a promotion.
export const OBSERVATIONS_TABLE = `CREATE TABLE IF NOT EXISTS observations (
 id INTEGER PRIMARY KEY,
 title TEXT,
 store TEXT,
 place TEXT,
 city TEXT,
 osm_id TEXT,
 price INTEGER,
 regular_price INTEGER,
 discounted INTEGER NOT NULL DEFAULT 0,
 discount_type TEXT,
 day TEXT,
 unit TEXT,
 quantity TEXT,
 barcode TEXT,
 proof_id TEXT,
 licence TEXT NOT NULL DEFAULT 'ODbL',
 imported TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 first_imported TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;
export const OBSERVATION_COLUMNS = Object.freeze([
  "id", "title", "store", "place", "city", "osm_id", "price", "regular_price",
  "discounted", "discount_type", "day", "unit", "quantity", "barcode",
  "proof_id", "licence", "imported", "first_imported",
]);

// Display permission recorded by the operator per provider and programme
// (merchant or advertiser for feeds; '' for a whole provider). Absence means
// display is not permitted.
export const PERMISSIONS_TABLE = `CREATE TABLE IF NOT EXISTS permissions (
 provider TEXT NOT NULL,
 programme TEXT NOT NULL DEFAULT '',
 display INTEGER NOT NULL DEFAULT 0,
 note TEXT,
 updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(provider, programme)
)`;

// Adds any contract column missing from an older database. Column order in
// SQLite does not matter for named queries.
export function addMissingColumns(db, table, columns, types = {}) {
  const present = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name),
  );
  for (const column of columns) {
    if (present.has(column)) continue;
    const type = types[column] || "TEXT";
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
export const OBSERVATION_TYPES = Object.freeze({
  price: "INTEGER",
  regular_price: "INTEGER",
  discounted: "INTEGER NOT NULL DEFAULT 0",
  licence: "TEXT NOT NULL DEFAULT 'ODbL'",
  // SQLite cannot add a column with a non-constant default; backfilled below.
  imported: "TEXT",
  first_imported: "TEXT",
});
export const RESEARCH_TYPES = Object.freeze({
  price: "INTEGER",
  shipping: "INTEGER",
  was_price: "INTEGER",
  rrp_price: "INTEGER",
  imported: "TEXT",
  first_imported: "TEXT",
});
