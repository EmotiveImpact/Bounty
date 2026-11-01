// Outcome ledger: what actually happened on a trip, kept apart from what was
// predicted. A trip holds dated entries (receipts, sales, payouts, expenses,
// refunds, work time and household savings) and private proof metadata.
// reconcile() checks the records against each other, summary() reports one
// month and metrics() compares closed trips with their predictions.
//
// Money is integer pence and time is minutes. Only payouts are realised
// income: a recorded sale is not cash until the marketplace pays it out, and a
// prediction is never cash at all. Household savings (the saving against the
// usual price on things bought for the home) are never earnings or proceeds.
import { bool, fail, int, isoDate, londonDate, oneOf, text, transaction } from "./http.mjs";
import { removesMetadata } from "./proofs.mjs";

export const TRIP_SOURCES = Object.freeze(["planner", "research", "bounty", "manual"]);
export const TRIP_KINDS = Object.freeze(["resale", "household"]);
export const ENTRY_TYPES = Object.freeze([
  "receipt",
  "sale",
  "payout",
  "expense",
  "refund",
  "work",
  "saving",
]);

// Which entries each kind of trip takes.
//   receipt  purchase receipt: what you paid for the stock (units bought)
//   sale     sold listing: what the buyer paid, including buyer-paid postage
//   payout   money the marketplace actually paid you
//   expense  travel, postage labels, packaging or fees charged separately
//   refund   money you paid back to a buyer. units: how many units the buyer
//            sent back, which go back into stock and can be sold again; none
//            (null) when the buyer kept the item, so no stock comes back.
//            addEntry takes itemReturned (true or false) to say which, and,
//            when the item came back, optionally returnedOn: the date it
//            came back, when that differs from the date the money went out
//            (kept in ledger_refund_returns).
//   work     elapsed working time in minutes (no money)
//   saving   household only: the saving against the usual price
export const ENTRY_TYPES_BY_KIND = Object.freeze({
  resale: Object.freeze(["receipt", "sale", "payout", "expense", "refund", "work"]),
  household: Object.freeze(["receipt", "saving", "expense", "work"]),
});

const MAX_UNITS = 10000;
const MAX_PENCE = 1e9;
const MAX_WORK_MINUTES = 10080; // one week in a single entry
const EARLIEST_DATE = "2000-01-01";

const TRIPS_TABLE = `CREATE TABLE IF NOT EXISTS ledger_trips (
 id INTEGER PRIMARY KEY,
 label TEXT NOT NULL,
 source TEXT NOT NULL,
 kind TEXT NOT NULL,
 reference TEXT,
 predicted TEXT,
 status TEXT NOT NULL DEFAULT 'open',
 created TEXT NOT NULL,
 closed_at TEXT
)`;
// Entries and proofs can be deleted, so their ids use AUTOINCREMENT: an id is
// never given to a new row after its row was deleted, and a stale tab or a
// retried DELETE can only ever reach the row it meant (or nothing).
const ENTRY_COLUMNS = "id, trip_id, type, amount, units, reference, occurred, minutes, note, created";
const entriesTable = (name) => `CREATE TABLE IF NOT EXISTS ${name} (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 trip_id INTEGER NOT NULL REFERENCES ledger_trips(id),
 type TEXT NOT NULL,
 amount INTEGER NOT NULL CHECK (amount >= 0),
 units INTEGER,
 reference TEXT,
 occurred TEXT NOT NULL,
 minutes INTEGER,
 note TEXT,
 created TEXT NOT NULL
)`;
// Metadata only. The files live in the private proof directory (proofs.mjs).
const PROOF_COLUMNS = "id, trip_id, entry_id, sha256, bytes, media_type, label, created";
const proofsTable = (name, entries = "ledger_entries") => `CREATE TABLE IF NOT EXISTS ${name} (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 trip_id INTEGER NOT NULL REFERENCES ledger_trips(id),
 entry_id INTEGER REFERENCES ${entries}(id),
 sha256 TEXT NOT NULL,
 bytes INTEGER NOT NULL,
 media_type TEXT NOT NULL,
 label TEXT NOT NULL,
 created TEXT NOT NULL
)`;
// The date a returned item came back, for refunds where it came back on a
// different day from the refund itself (the stock walk uses it; the refund's
// own date stays the date the money went out). A table of its own rather than
// a new ledger_entries column: older databases gain it in place with nothing
// rebuilt and every existing entry row exactly as it was. One row per refund
// entry at most; a refund without a row came back on its own date.
const RETURNS_TABLE = `CREATE TABLE IF NOT EXISTS ledger_refund_returns (
 entry_id INTEGER PRIMARY KEY REFERENCES ledger_entries(id),
 returned_on TEXT NOT NULL
)`;
// Which rows of the old outcomes table have been copied into trips, so that
// running the migration again never duplicates them.
const LEGACY_TABLE = `CREATE TABLE IF NOT EXISTS ledger_legacy_outcomes (
 outcome_id INTEGER PRIMARY KEY,
 trip_id INTEGER NOT NULL REFERENCES ledger_trips(id),
 migrated TEXT NOT NULL
)`;

/**
 * Creates the ledger tables (idempotent), rebuilds entry and proof tables
 * made before their ids used AUTOINCREMENT, and migrates legacy outcomes.
 */
export function schema(db, { now = new Date() } = {}) {
  transaction(db, () => {
    db.exec(TRIPS_TABLE);
    db.exec(entriesTable("ledger_entries"));
    db.exec(proofsTable("ledger_proofs"));
    db.exec(LEGACY_TABLE);
    migrateToAutoincrement(db);
    // After the rebuild above (which only ever runs on databases made before
    // this table existed), so the rebuild never has to carry its rows.
    db.exec(RETURNS_TABLE);
    db.exec("CREATE INDEX IF NOT EXISTS ledger_entries_trip ON ledger_entries(trip_id)");
    db.exec("CREATE INDEX IF NOT EXISTS ledger_entries_occurred ON ledger_entries(occurred)");
    db.exec("CREATE INDEX IF NOT EXISTS ledger_proofs_trip ON ledger_proofs(trip_id)");
    db.exec("CREATE INDEX IF NOT EXISTS ledger_proofs_sha256 ON ledger_proofs(sha256)");
    migrateLegacyOutcomes(db, now);
  });
}

const usesAutoincrement = (db, table) =>
  /\bAUTOINCREMENT\b/i.test(
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql || "",
  );

/**
 * Rebuilds ledger_entries and ledger_proofs with AUTOINCREMENT ids when they
 * were created without it (before this change SQLite could give a new row the
 * id of the newest row just deleted). Every row keeps its id, its trip and
 * its entry link, and no proof file is touched. Runs inside the schema
 * transaction, so a failure leaves the old tables as they were. The new
 * tables are filled before the old ones are dropped, and proofs (which
 * reference entries) are rebuilt whenever entries are, so foreign keys hold
 * throughout. Returns true when anything was rebuilt.
 */
export function migrateToAutoincrement(db) {
  const entries = !usesAutoincrement(db, "ledger_entries");
  const proofs = entries || !usesAutoincrement(db, "ledger_proofs");
  if (!proofs) return false;
  transaction(db, () => {
    if (entries) {
      db.exec("DROP TABLE IF EXISTS ledger_entries_rebuild");
      db.exec(entriesTable("ledger_entries_rebuild"));
      db.exec(
        `INSERT INTO ledger_entries_rebuild (${ENTRY_COLUMNS}) SELECT ${ENTRY_COLUMNS} FROM ledger_entries ORDER BY id`,
      );
    }
    db.exec("DROP TABLE IF EXISTS ledger_proofs_rebuild");
    db.exec(proofsTable("ledger_proofs_rebuild", entries ? "ledger_entries_rebuild" : "ledger_entries"));
    db.exec(
      `INSERT INTO ledger_proofs_rebuild (${PROOF_COLUMNS}) SELECT ${PROOF_COLUMNS} FROM ledger_proofs ORDER BY id`,
    );
    db.exec("DROP TABLE ledger_proofs");
    if (entries) {
      db.exec("DROP TABLE ledger_entries");
      // Renaming also points the rebuilt proofs' entry link at ledger_entries.
      db.exec("ALTER TABLE ledger_entries_rebuild RENAME TO ledger_entries");
    }
    db.exec("ALTER TABLE ledger_proofs_rebuild RENAME TO ledger_proofs");
    // Ids deleted before the upgrade above the highest remaining id were
    // never recorded, so new ids start well clear of them: a stale tab or a
    // retried DELETE from before the upgrade still finds nothing.
    for (const table of entries ? ["ledger_entries", "ledger_proofs"] : ["ledger_proofs"]) {
      const next = (db.prepare(`SELECT MAX(id) AS id FROM ${table}`).get().id ?? 0) + ID_REUSE_MARGIN;
      const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table);
      if (seq) db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = ?").run(Math.max(seq.seq, next), table);
      else db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(table, next);
    }
  });
  return true;
}

// How far past the highest surviving id new rows start after the upgrade.
const ID_REUSE_MARGIN = 1000;

// ---------------------------------------------------------------------------
// Dates

const DAY_MS = 86400000;

// Today's calendar date in the UK (YYYY-MM-DD), the date a user would write.
// Re-exported from http.mjs so every module counts days from the same today.
export { londonDate };

const dayNumber = (date) => Date.parse(date + "T00:00:00Z") / DAY_MS;
const daysBetween = (from, to) => Math.round(dayNumber(to) - dayNumber(from));

/** A real calendar date, not before 2000 and not after today in the UK. */
export function pastDate(value, name, now = new Date()) {
  const date = isoDate(value, name);
  if (date < EARLIEST_DATE) fail(`${name} must be on or after ${EARLIEST_DATE}`);
  if (date > londonDate(now)) fail(`${name} cannot be in the future`);
  return date;
}

/** A month as YYYY-MM. */
export function monthParam(value, name = "month") {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value))
    fail(`${name} must be a month (YYYY-MM)`);
  return value;
}

// ---------------------------------------------------------------------------
// Legacy outcomes (the free-form outcome form before the ledger)

/**
 * Copies rows of the legacy outcomes table (id, sku, received, costs,
 * minutes, created) into closed resale trips with source "legacy": a payout
 * entry for "actual proceeds", an expense entry for "total actual costs" and
 * a work entry for the minutes. These are totals as the user typed them, with
 * no receipt or sold listing, so they can never be fully reconciled or
 * verified. The outcomes table is left in place. Returns the number migrated.
 */
export function migrateLegacyOutcomes(db, now = new Date()) {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'outcomes'")
    .get();
  if (!table) return 0;
  const columns = new Set(
    db.prepare("PRAGMA table_info(outcomes)").all().map((c) => c.name),
  );
  if (!["id", "received", "costs", "minutes"].every((c) => columns.has(c))) return 0;
  const rows = db
    .prepare(
      `SELECT * FROM outcomes o WHERE NOT EXISTS
       (SELECT 1 FROM ledger_legacy_outcomes m WHERE m.outcome_id = o.id) ORDER BY o.id`,
    )
    .all();
  if (!rows.length) return 0;
  const stamp = now.toISOString();
  const today = londonDate(now);
  const insertTrip = db.prepare(
    `INSERT INTO ledger_trips (label, source, kind, reference, predicted, status, created, closed_at)
     VALUES (?, 'legacy', 'resale', ?, NULL, 'closed', ?, ?)`,
  );
  const insertEntry = db.prepare(
    `INSERT INTO ledger_entries (trip_id, type, amount, units, reference, occurred, minutes, note, created)
     VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
  );
  const mark = db.prepare(
    "INSERT INTO ledger_legacy_outcomes (outcome_id, trip_id, migrated) VALUES (?, ?, ?)",
  );
  const whole = (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 && n <= MAX_PENCE ? n : 0;
  };
  transaction(db, () => {
    for (const row of rows) {
      const created = legacyTimestamp(row.created) || stamp;
      // The UK calendar day of the old timestamp, never after today.
      const day = londonDate(created);
      const occurred = day <= today ? day : today;
      const sku = typeof row.sku === "string" && row.sku.trim() ? row.sku.trim().slice(0, 120) : null;
      const trip = Number(
        insertTrip.run(
          "Legacy outcome #" + row.id + (sku ? ": " + sku : ""),
          sku,
          created,
          created,
        ).lastInsertRowid,
      );
      const note = "Legacy total from outcome #" + row.id + ", entered before the ledger existed";
      const received = whole(row.received);
      const costs = whole(row.costs);
      const minutes = whole(row.minutes);
      if (received) insertEntry.run(trip, "payout", received, occurred, null, note + " (actual proceeds)", stamp);
      if (costs) insertEntry.run(trip, "expense", costs, occurred, null, note + " (total actual costs)", stamp);
      if (minutes) insertEntry.run(trip, "work", 0, occurred, minutes, note + " (active minutes)", stamp);
      mark.run(row.id, trip, stamp);
    }
  });
  return rows.length;
}

/** "YYYY-MM-DD HH:MM:SS" (SQLite CURRENT_TIMESTAMP, UTC) to ISO, else null. */
function legacyTimestamp(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(value);
  if (!match) return null;
  const iso = match[1] + "T" + match[2] + ".000Z";
  const parsed = new Date(iso);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === iso ? iso : null;
}

// ---------------------------------------------------------------------------
// Reading

/**
 * Where a trip's prediction came from:
 *   "sample"  sample or illustrative figures. Every Planner trip is sample
 *             (the Planner runs on fixtures), and any trip tracked with
 *             predicted.sample true.
 *   "live"    the tab that tracked it said the prediction used live evidence
 *             (predicted.sample false).
 *   "unknown" a prediction stored without saying either, such as trips tracked
 *             before the flag existed. Treated like sample: not counted.
 *   null      no prediction.
 * Only "live" predictions count in potential proceeds and the forecast
 * measures.
 */
export function predictionBasis(trip) {
  if (!trip.predicted) return null;
  if (trip.source === "planner" || trip.predicted.sample === true) return "sample";
  return trip.predicted.sample === false ? "live" : "unknown";
}

function tripView(row) {
  const trip = {
    id: Number(row.id),
    label: row.label,
    source: row.source,
    kind: row.kind,
    reference: row.reference ?? null,
    predicted: row.predicted ? JSON.parse(row.predicted) : null,
    status: row.status,
    created: row.created,
    closed_at: row.closed_at ?? null,
    legacy: row.source === "legacy",
  };
  trip.predictionBasis = predictionBasis(trip);
  trip.sample = trip.predictionBasis === "sample";
  return trip;
}
function entryView(row) {
  return {
    id: Number(row.id),
    trip_id: Number(row.trip_id),
    type: row.type,
    amount: Number(row.amount),
    units: row.units === null ? null : Number(row.units),
    reference: row.reference ?? null,
    occurred: row.occurred,
    minutes: row.minutes === null ? null : Number(row.minutes),
    note: row.note ?? null,
    created: row.created,
    // Refunds only: true when the buyer sent the item back (units returned
    // to stock), false when the buyer kept it. Null on other entries.
    itemReturned: row.type === "refund" ? returnsStock(row) : null,
    // Refunds where the item came back only: the date it came back, when it
    // was given; null means it is taken to have come back on the refund's
    // own date.
    returnedOn: returnsStock(row) ? row.returned_on ?? null : null,
  };
}

// Databases whose schema() has created ledger_refund_returns. A database
// opened without the ledger schema (only ever in tests of the migration)
// reads every refund as coming back on its own date.
const returnsReady = new WeakSet();
function hasReturnsTable(db) {
  if (returnsReady.has(db)) return true;
  const found = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_refund_returns'").get(),
  );
  if (found) returnsReady.add(db);
  return found;
}
/** Entry rows, with returned_on for refunds that give it, oldest first. */
function entryRows(db, tripId = null) {
  const where = tripId === null ? "" : "WHERE e.trip_id = ?";
  const sql = hasReturnsTable(db)
    ? `SELECT e.*, r.returned_on FROM ledger_entries e LEFT JOIN ledger_refund_returns r ON r.entry_id = e.id ${where} ORDER BY e.occurred, e.id`
    : `SELECT e.* FROM ledger_entries e ${where} ORDER BY e.occurred, e.id`;
  const query = db.prepare(sql);
  return tripId === null ? query.all() : query.all(tripId);
}
/** Proof metadata as the API returns it. Never includes file contents. */
function proofView(row) {
  return {
    id: Number(row.id),
    trip_id: Number(row.trip_id),
    entry_id: row.entry_id === null ? null : Number(row.entry_id),
    sha256: row.sha256,
    bytes: Number(row.bytes),
    media_type: row.media_type,
    label: row.label,
    created: row.created,
    metadataRemoved: removesMetadata(row.media_type),
  };
}

const groupBy = (rows, key) => {
  const map = new Map();
  for (const row of rows) {
    const list = map.get(row[key]);
    if (list) list.push(row);
    else map.set(row[key], [row]);
  }
  return map;
};

/** Every trip with its entries and proofs, oldest entries first. */
function loadAll(db) {
  const trips = db.prepare("SELECT * FROM ledger_trips ORDER BY id DESC").all().map(tripView);
  const entries = groupBy(entryRows(db).map(entryView), "trip_id");
  const proofs = groupBy(
    db.prepare("SELECT * FROM ledger_proofs ORDER BY id").all().map(proofView),
    "trip_id",
  );
  const uses = proofUses(db);
  return trips.map((trip) => ({
    trip,
    entries: entries.get(trip.id) || [],
    proofs: proofs.get(trip.id) || [],
    uses,
  }));
}

function requireTrip(db, id) {
  const row = db.prepare("SELECT * FROM ledger_trips WHERE id = ?").get(id);
  if (!row) fail("No ledger trip with id " + id, 404);
  return tripView(row);
}

/** One trip with its entries, proof metadata and reconciliation. */
export function getTrip(db, id) {
  const trip = requireTrip(db, id);
  const entries = entryRows(db, id).map(entryView);
  const proofs = db
    .prepare("SELECT * FROM ledger_proofs WHERE trip_id = ? ORDER BY id")
    .all(id)
    .map(proofView);
  return { trip, entries, proofs, reconciliation: reconcile(trip, entries, proofs, proofUses(db)) };
}

/** All trips, newest first, each with its headline reconciliation figures. */
export function listTrips(db) {
  return loadAll(db).map(({ trip, entries, proofs, uses }) => {
    const r = reconcile(trip, entries, proofs, uses);
    return {
      ...trip,
      entries: entries.length,
      proofs: proofs.length,
      realisedContribution: r.realisedContribution,
      householdSavings: r.householdSavings,
      netHouseholdSaving: r.netHouseholdSaving,
      pendingPayout: r.pendingPayout,
      unsoldUnits: r.unsoldUnits,
      complete: r.checklist.complete,
      discrepancies: r.discrepancies.length,
      verified: r.verified,
      verificationMissing: r.verificationMissing,
    };
  });
}

// ---------------------------------------------------------------------------
// Reconciliation

const pounds = (pence) => "£" + (pence / 100).toFixed(2);
// Entries that move cash: payouts in; receipts, expenses and refunds out.
const CASH_TYPES = Object.freeze(["payout", "receipt", "expense", "refund"]);
const sumOf = (entries, type, field = "amount") =>
  entries.filter((e) => e.type === type).reduce((total, e) => total + (e[field] ?? 0), 0);
const byDate = (a, b) => (a.occurred === b.occurred ? a.id - b.id : a.occurred < b.occurred ? -1 : 1);
const earliest = (entries, type) =>
  entries.filter((e) => e.type === type).map((e) => e.occurred).sort()[0] ?? null;
const shortDate = (date) =>
  new Date(date + "T12:00:00Z").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

/**
 * Splits recorded sales into paid out and still to be paid out.
 *
 * Payouts are applied in date order. A payout that says how many units it
 * covers pays that many sold units of the sales dated on or before it,
 * oldest sales first. A payout with no unit count is taken to cover every
 * sale dated on or before it, because a marketplace pays a sale out after it
 * happens. The gap between the sales covered and the payouts is fees the
 * marketplace kept; only sales no payout covers are pending, so the same
 * money is never both pending and fees.
 *
 * Refunds where the buyer sent the item back (round five, fix b): a sale
 * refunded before it was paid out is not paid out, so its refunded units are
 * no longer pending (see payoutWalk for which sale a refund applies to). A
 * refund where the buyer kept the item changes nothing here: the sale stands
 * and the ledger cannot tell which sale or how much of it the refund was.
 *
 * basis: "units" when every payout gives its units, "dates" when any payout
 * was matched by date, "no payouts" when there is none yet (every recorded
 * sale not refunded is pending). Returns { pending, paid, fees, basis } where
 * paid is the value of the sales covered and fees is null when it cannot be
 * worked out (no sales, or payouts above the sales they cover).
 */
export function payoutPosition(entries) {
  const { pending, paid, fees, basis } = payoutWalk(entries);
  return { pending, paid, fees, basis };
}

const sameReference = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.trim() !== "" && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * payoutPosition() with the units refunded before they were paid out:
 * { pending, paid, fees, basis, refundedUnpaid, refundedUnpaidUnits }.
 *
 * Each sold unit is unpaid, paid, or refunded before it was paid. Payouts and
 * refunds where the item came back are taken in date order; on one day,
 * payouts before refunds, so a refund on the day of a payout is never taken
 * to have stopped that payout. A refund applies to sales dated on or before
 * it, by one rule:
 *   - units already paid out and not yet refunded, first. A refund of a sale
 *     that was paid out cancels nothing still to come, and taking that
 *     reading first means a payout still to come is never hidden on a guess;
 *   - only units no reading leaves paid are taken as refunded before they
 *     were paid: the cheapest unpaid units first (hiding the least money
 *     still to come), oldest first among equals. They are no longer pending.
 * When the refund's reference (the order number) matches sales, the rule is
 * applied to those sales first, then to every earlier sale for any units
 * they cannot take. One order can hold several items, each recorded as a
 * sale under the same order number, so a reference narrows the candidates
 * without choosing among them (round five, fix b, second pass).
 * A payout with units pays unpaid units first; if it covers more units than
 * are unpaid, it pays units refunded before payout too (the marketplace paid
 * them after all), so they never take a later sale's place. Its units never
 * reach a sale dated after it. A payout with no units covers every sale up to
 * its date, refunded ones included, as before.
 * Refunds where the buyer kept the item are not followed: see payoutPosition.
 */
export function payoutWalk(entries) {
  const sales = entries
    .filter((e) => e.type === "sale")
    .sort(byDate)
    .map((e) => {
      const units = Math.max(1, e.units ?? 1);
      // left: unpaid; cancelled: refunded before it was paid out; paidOpen:
      // paid out and not refunded.
      return { entry: e, units, left: units, cancelled: 0, paidOpen: 0 };
    });
  const payouts = entries.filter((e) => e.type === "payout").sort(byDate);
  const salesTotal = sales.reduce((t, s) => t + s.entry.amount, 0);
  const payoutTotal = payouts.reduce((t, e) => t + e.amount, 0);
  const hasUnits = (e) => Number.isSafeInteger(e.units) && e.units > 0;
  const rank = (e) => (e.type === "payout" ? 0 : 1);
  const events = [...payouts, ...entries.filter(returnsStock)].sort((a, b) =>
    a.occurred !== b.occurred ? (a.occurred < b.occurred ? -1 : 1) : rank(a) - rank(b) || a.id - b.id,
  );
  const upTo = (date) => sales.filter((s) => s.entry.occurred <= date);
  const take = (sale, from, to, wanted) => {
    const n = Math.min(sale[from], wanted);
    sale[from] -= n;
    if (to) sale[to] += n;
    return n;
  };
  // Applies a refund's units to the candidate sales: units already paid out
  // and not refunded first (cancelling nothing still to come), then the
  // cheapest unpaid units, oldest first among equals. Returns the units left.
  const refundFrom = (candidates, units) => {
    for (const sale of candidates) units -= take(sale, "paidOpen", null, units);
    const cheapestFirst = [...candidates].sort(
      (a, b) => a.entry.amount / a.units - b.entry.amount / b.units || byDate(a.entry, b.entry),
    );
    for (const sale of cheapestFirst) units -= take(sale, "left", "cancelled", units);
    return units;
  };
  for (const e of events) {
    const earlier = upTo(e.occurred);
    if (e.type === "payout") {
      if (hasUnits(e)) {
        let units = e.units;
        for (const sale of earlier) units -= take(sale, "left", "paidOpen", units);
        // Paid and already refunded: neither pending nor open to a refund.
        for (const sale of earlier) units -= take(sale, "cancelled", null, units);
      } else {
        for (const sale of earlier) {
          sale.paidOpen += sale.left;
          sale.left = 0;
          sale.cancelled = 0;
        }
      }
      continue;
    }
    // The sales the refund names first: one order can hold several items,
    // each recorded as a sale under the same order number, so a reference
    // narrows the candidates and the same rule picks among them. Whatever the
    // named sales cannot take falls to every earlier sale, by the same rule.
    const named = earlier.filter((s) => sameReference(s.entry.reference, e.reference));
    refundFrom(earlier, refundFrom(named, Number(e.units)));
  }
  const valueOf = (field) => sales.reduce((t, s) => t + Math.round((s.entry.amount * s[field]) / s.units), 0);
  const pending = valueOf("left");
  const refundedUnpaid = valueOf("cancelled");
  const refundedUnpaidUnits = sales.reduce((t, s) => t + s.cancelled, 0);
  if (!payouts.length)
    return { pending, paid: 0, fees: null, basis: "no payouts", refundedUnpaid, refundedUnpaidUnits };
  const paid = salesTotal - pending - refundedUnpaid;
  const gap = paid - payoutTotal;
  return {
    pending,
    paid,
    fees: sales.length && gap >= 0 ? gap : null,
    basis: payouts.every(hasUnits) ? "units" : "dates",
    refundedUnpaid,
    refundedUnpaidUnits,
  };
}

/**
 * True for a refund whose units came back into stock (the buyer returned the
 * item). A refund without units is one where the buyer kept the item.
 */
export function returnsStock(entry) {
  return entry.type === "refund" && entry.units !== null && entry.units !== undefined && Number(entry.units) > 0;
}

const unitsText = (n) => (n === 0 ? "none" : n === 1 ? "1 unit" : n.toLocaleString("en-GB") + " units");

/**
 * Follows a trip's stock in date order. Receipts add units; a sale takes its
 * units from the stock on hand at that point; a refund where the buyer sent
 * the item back puts its units back into stock, so they can be sold again, on
 * the date the item came back (returnedOn) when the refund gives one and on
 * the refund's own date otherwise; a refund where the buyer kept the item
 * moves no stock.
 *
 * Entries carry a date, not a time, so within one day their order is not
 * known (round five, fix b). Each day's receipts come first (a purchase
 * recorded after a sale on the same day still covers it, as the
 * sale-before-receipt check allows). The day's sales and returns are then
 * flagged only when no order of them keeps both the stock on hand and the
 * units sold and not yet sent back from going below zero (dayOrder: every
 * order is tried, except on a day with movements in so many sizes that it
 * is judged on its totals). When no
 * order works, the movements that fit in the best order are applied and the
 * first sale left over (or, with no sale left, the first return) is flagged.
 *
 * Returns { onHand, short, shortSales, overReturned }: short is the first
 * sale that needed more units than could have been in stock at that point,
 * as { entry, units, onHand }, and shortSales how many sales did;
 * overReturned is the first return of more units than could have been sold
 * and not already returned by then, as { entry, units, out }.
 */
export function stockWalk(entries) {
  const moves = entries
    .filter((e) => e.type === "receipt" || e.type === "sale" || returnsStock(e))
    .map((e) => ({
      entry: e,
      kind: e.type === "refund" ? "return" : e.type,
      units: Number(e.units ?? 0),
      date: e.type === "refund" && e.returnedOn ? e.returnedOn : e.occurred,
    }))
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.entry.id - b.entry.id));
  // out: units sold and not yet sent back.
  const state = { onHand: 0, out: 0, short: null, shortSales: 0, overReturned: null };
  for (let i = 0; i < moves.length; ) {
    let j = i;
    while (j < moves.length && moves[j].date === moves[i].date) j += 1;
    const day = moves.slice(i, j);
    for (const m of day) if (m.kind === "receipt") state.onHand += m.units;
    settleDay(
      day.filter((m) => m.kind !== "receipt"),
      state,
    );
    i = j;
  }
  return { onHand: state.onHand, short: state.short, shortSales: state.shortSales, overReturned: state.overReturned };
}

/** Applies one day's sales and returns (in entry order) to the stock state. */
function settleDay(moves, state) {
  let rest = moves;
  while (rest.length) {
    const placed = new Set(dayOrder(rest, state.onHand, state.out));
    for (const m of placed) {
      const sign = m.kind === "sale" ? 1 : -1;
      state.onHand -= sign * m.units;
      state.out += sign * m.units;
    }
    rest = rest.filter((m) => !placed.has(m));
    if (!rest.length) return;
    // No order fits what is left: a sale had too few in stock (or, with no
    // sale left, a return brought back more than was out). Flag it, apply it
    // as far as it can go, and carry on with the rest of the day.
    const m = rest.find((x) => x.kind === "sale") ?? rest[0];
    if (m.kind === "sale") {
      state.shortSales += 1;
      state.short ??= { entry: m.entry, units: m.units, onHand: state.onHand };
      state.onHand = Math.max(0, state.onHand - m.units);
      state.out += m.units;
    } else {
      state.overReturned ??= { entry: m.entry, units: m.units, out: state.out };
      state.out = Math.max(0, state.out - m.units);
      state.onHand += m.units;
    }
    rest = rest.filter((x) => x !== m);
  }
}

// Above this many sales and returns on one day for one trip, subsets are not
// all tried: movements of the same kind and size are counted instead (see
// dayOrder).
const MAX_ORDERED_MOVES = 12;
// Above this many combinations of those counts, the day is judged on its
// totals (see dayOrder).
const MAX_COUNT_STATES = 1 << 16;

/**
 * The most of one day's sales and returns that some order can apply while
 * the stock on hand (onHand) and the units out (out) never go below zero:
 * all of them when such an order exists. Every subset an order can reach is
 * tried, so nothing is flagged that some order of the day would explain.
 * With more than MAX_ORDERED_MOVES movements, movements of the same kind and
 * size are interchangeable, so every combination of how many of each have
 * gone is tried instead (countedOrder; exact too, round five, fix b, third
 * pass). Only when there are more than MAX_COUNT_STATES such combinations is
 * the day judged on its totals: it is accepted when no movement is bigger
 * than the stock on hand and out together (which no movement on the day
 * changes, so a bigger one can never go; with nothing on hand or out, no
 * movement can go at all) and its totals allow it (sales no more than the
 * stock plus the day's returns, returns no more than the units out plus the
 * day's sales). Otherwise it is placed greedily, so the flag names a
 * movement.
 */
function dayOrder(moves, onHand, out) {
  const n = moves.length;
  const delta = moves.map((m) => (m.kind === "sale" ? m.units : -m.units));
  // d: units sold less units returned so far today.
  const fits = (i, d) => (moves[i].kind === "sale" ? moves[i].units <= onHand - d : moves[i].units <= out + d);
  if (n > MAX_ORDERED_MOVES) {
    const counted = countedOrder(moves, onHand, out);
    if (counted) return counted;
    const sold = moves.filter((m) => m.kind === "sale").reduce((t, m) => t + m.units, 0);
    const back = moves.filter((m) => m.kind !== "sale").reduce((t, m) => t + m.units, 0);
    // No movement bigger than the stock on hand and out together (so with
    // nothing on hand or out, no movement of a unit or more can go).
    const within = moves.every((m) => m.units <= onHand + out);
    if (within && sold <= onHand + back && back <= out + sold) return moves;
    const placed = [];
    const left = new Set(moves.keys());
    let d = 0;
    for (let progress = true; progress; ) {
      progress = false;
      for (const i of left)
        if (fits(i, d)) {
          placed.push(moves[i]);
          left.delete(i);
          d += delta[i];
          progress = true;
          break;
        }
    }
    return placed;
  }
  const size = 1 << n;
  const reached = new Uint8Array(size);
  const dOf = new Int32Array(size);
  reached[0] = 1;
  let best = 0;
  let bestCount = 0;
  for (let mask = 0; mask < size; mask++) {
    if (!reached[mask]) continue;
    let count = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) count += 1;
    if (count > bestCount) {
      best = mask;
      bestCount = count;
    }
    for (let i = 0; i < n; i++) {
      const next = mask | (1 << i);
      if (next === mask || reached[next] || !fits(i, dOf[mask])) continue;
      reached[next] = 1;
      dOf[next] = dOf[mask] + delta[i];
    }
  }
  return moves.filter((_, i) => best & (1 << i));
}

/**
 * dayOrder for many movements: sales and returns of the same size are
 * interchangeable, so a state is how many of each kind and size have gone
 * (the stock on hand and out follow from it), and every state some order
 * can reach is tried. Returns the most movements some order can apply (the
 * first ones of each kind and size, in entry order), or null when there are
 * more than MAX_COUNT_STATES states.
 */
function countedOrder(moves, onHand, out) {
  const groups = new Map();
  for (const m of moves) {
    const key = m.kind + ":" + m.units;
    if (!groups.has(key)) groups.set(key, { sign: m.kind === "sale" ? 1 : -1, units: m.units, list: [] });
    groups.get(key).list.push(m);
  }
  const g = [...groups.values()];
  // A state's index in mixed radix: one more of group k adds stride[k], so
  // every state comes after the states it is reached from.
  const stride = [];
  let size = 1;
  for (const x of g) {
    stride.push(size);
    size *= x.list.length + 1;
    if (size > MAX_COUNT_STATES) return null;
  }
  const used = (state, k) => Math.floor(state / stride[k]) % (g[k].list.length + 1);
  const reached = new Uint8Array(size);
  reached[0] = 1;
  let best = 0;
  let bestCount = 0;
  for (let state = 0; state < size; state++) {
    if (!reached[state]) continue;
    // d: units sold less units returned so far today.
    let d = 0;
    let count = 0;
    for (let k = 0; k < g.length; k++) {
      const u = used(state, k);
      count += u;
      d += g[k].sign * g[k].units * u;
    }
    if (count > bestCount) {
      best = state;
      bestCount = count;
    }
    for (let k = 0; k < g.length; k++) {
      if (used(state, k) === g[k].list.length) continue;
      const fit = g[k].sign > 0 ? g[k].units <= onHand - d : g[k].units <= out + d;
      if (fit) reached[state + stride[k]] = 1;
    }
  }
  const placed = new Set();
  for (let k = 0; k < g.length; k++) for (const m of g[k].list.slice(0, used(best, k))) placed.add(m);
  return moves.filter((m) => placed.has(m));
}

/**
 * Checks a resale trip's records against each other. Legacy totals have no
 * receipt or sold listing by construction, which the legacy flag explains, so
 * they are not checked. Stock is followed in date order (stockWalk), so a
 * unit a buyer sent back can be sold again, while a sale with too few units
 * in stock at that point, or after a refund where the buyer kept the item,
 * is flagged. Within one day no order of entries is assumed: a day's sales
 * and returns are flagged only when no order of them adds up. Advice in a
 * message is only what the trip still allows: an entry cannot be edited,
 * only removed and recorded again while the trip is open, and a closed trip
 * cannot change at all. Returns [{ code, message }].
 */
export function findDiscrepancies(trip, entries) {
  const discrepancies = [];
  if (trip.kind !== "resale" || trip.source === "legacy") return discrepancies;
  const flag = (code, message) => discrepancies.push({ code, message });
  const has = (type) => entries.some((e) => e.type === type);
  const sales = sumOf(entries, "sale");
  const payouts = sumOf(entries, "payout");
  const unitsSold = sumOf(entries, "sale", "units");
  const stock = stockWalk(entries);
  const position = payoutPosition(entries);
  const unitsPaidOut = sumOf(entries, "payout", "units");
  const firstReceipt = earliest(entries, "receipt");
  const firstSale = earliest(entries, "sale");
  const firstPayout = earliest(entries, "payout");
  const payoutBeforeSale = firstPayout && firstSale && firstPayout < firstSale;

  if (has("payout") && !has("sale"))
    flag("payout-without-sale", "A payout is recorded without a sold listing.");
  else if (payouts > sales)
    flag(
      "payout-above-sales",
      `Payouts (${pounds(payouts)}) are above recorded sales (${pounds(sales)}). Record every sold listing.`,
    );
  else if (has("payout") && payouts > position.paid && !payoutBeforeSale)
    flag(
      "payout-above-paid-sales",
      `Payouts (${pounds(payouts)}) are above the sold listings they cover (${pounds(position.paid)}). ` +
        "Check the date and units on each payout.",
    );
  if (has("sale") && !has("receipt"))
    flag("sale-without-receipt", "A sale is recorded without a purchase receipt.");
  if (stock.short) {
    const { entry, units, onHand } = stock.short;
    const more = stock.shortSales - 1;
    // A return recorded after the short sale, with no date the item came
    // back: the item may have come back before its refund was paid. An entry
    // cannot be edited, so the way to give that date is to remove the refund
    // and record it again, which only an open trip allows.
    const laterReturn = entries.some((e) => returnsStock(e) && !e.returnedOn && e.occurred > entry.occurred);
    const advice =
      trip.status === "closed"
        ? " The trip is closed, so its entries cannot change."
        : " Check the units, or record the purchase or the return the stock came from." +
          (laterReturn
            ? " If an item a buyer sent back came back before its refund was paid, remove that refund and record it again with the date the item came back."
            : "");
    flag(
      "sold-above-bought",
      `The sale on ${shortDate(entry.occurred)} is for ${unitsText(units)}, but ` +
        (onHand === 0 ? "none was" : `only ${unitsText(onHand)} ${onHand === 1 ? "was" : "were"}`) +
        " in stock at that point (units bought, less units sold, plus units buyers sent back)." +
        (more > 0 ? ` ${more === 1 ? "1 later sale" : more + " later sales"} also had too few in stock.` : "") +
        advice,
    );
  }
  if (position.basis === "units" && unitsPaidOut > unitsSold)
    flag("paid-above-sold", `Payouts cover more units (${unitsPaidOut}) than were sold (${unitsSold}).`);
  if (stock.overReturned) {
    const { entry, units, out } = stock.overReturned;
    flag(
      "returned-above-sold",
      `The refund on ${shortDate(entry.occurred)}` +
        (entry.returnedOn ? ` (item back on ${shortDate(entry.returnedOn)})` : "") +
        ` says ${unitsText(units)} came back, but ` +
        (out === 0 ? "no units had" : `only ${unitsText(out)} had`) +
        " been sold and not already returned by then.",
    );
  }
  if (firstReceipt && firstPayout && firstPayout < firstReceipt)
    flag("payout-before-receipt", "A payout is dated before the first purchase receipt.");
  if (firstReceipt && firstSale && firstSale < firstReceipt)
    flag("sale-before-receipt", "A sold listing is dated before the first purchase receipt.");
  if (payoutBeforeSale)
    flag("payout-before-sale", "A payout is dated before the first sold listing.");
  return discrepancies;
}

const PROOF_KIND = Object.freeze({ receipt: "purchase receipt", payout: "payout" });

/** One receipt or payout entry a file is attached to, as a proof use. */
const proofUse = (row) => ({
  entryId: Number(row.entry_id),
  tripId: Number(row.trip_id),
  tripLabel: row.trip_label ?? null,
  type: row.type,
  occurred: row.occurred,
  amount: Number(row.amount),
});

/** Adds a use to a Map sha256 -> uses, once per entry. */
function addUse(uses, sha256, use) {
  const list = uses.get(sha256);
  if (!list) uses.set(sha256, [use]);
  else if (!list.some((u) => u.entryId === use.entryId)) list.push(use);
}

/**
 * Every receipt or payout entry each stored file is attached to, across the
 * whole ledger: Map sha256 -> [{ entryId, tripId, tripLabel, type, occurred,
 * amount }]. Pass it to verification() so a file counts for one entry in the
 * whole ledger, not one per trip.
 */
export function proofUses(db) {
  const uses = new Map();
  const rows = db
    .prepare(
      `SELECT p.sha256, p.entry_id, p.trip_id, t.label AS trip_label, e.type, e.occurred, e.amount
       FROM ledger_proofs p
       JOIN ledger_entries e ON e.id = p.entry_id AND e.trip_id = p.trip_id
       JOIN ledger_trips t ON t.id = p.trip_id
       WHERE e.type IN ('receipt', 'payout')
       ORDER BY p.entry_id, p.id`,
    )
    .all();
  for (const row of rows) addUse(uses, row.sha256, proofUse(row));
  return uses;
}

/** The same map built from one trip's own records (for pure calls). */
function tripUses(trip, entries, proofs) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const uses = new Map();
  for (const p of proofs) {
    const e = p.entry_id === null ? null : byId.get(p.entry_id);
    if (!e || !PROOF_KIND[e.type]) continue;
    addUse(uses, p.sha256, proofUse({ ...e, entry_id: e.id, trip_id: trip.id, trip_label: trip.label }));
  }
  return uses;
}

/** Where a proof use is, in words, seen from the trip tripId. */
function useWhere(use, tripId) {
  const what = `${PROOF_KIND[use.type]} (${shortDate(use.occurred)}, ${pounds(use.amount)})`;
  return use.tripId === tripId ? `the ${what} on this trip` : `the ${what} on "${use.tripLabel}"`;
}

/**
 * The receipt or payout entry, other than entryId, that a file is already
 * the proof for, anywhere in the ledger; null when there is none or when the
 * proof goes on the whole trip (entryId null). excludeProofId leaves out the
 * proof record being moved.
 */
export function proofConflict(db, { sha256, entryId, excludeProofId = null }) {
  if (entryId === null || entryId === undefined) return null;
  const row = db
    .prepare(
      `SELECT p.sha256, p.entry_id, p.trip_id, t.label AS trip_label, e.type, e.occurred, e.amount
       FROM ledger_proofs p
       JOIN ledger_entries e ON e.id = p.entry_id AND e.trip_id = p.trip_id
       JOIN ledger_trips t ON t.id = p.trip_id
       WHERE p.sha256 = ? AND p.entry_id != ? AND p.id IS NOT ? AND e.type IN ('receipt', 'payout')
       ORDER BY p.id LIMIT 1`,
    )
    .get(sha256, entryId, excludeProofId);
  return row ? proofUse(row) : null;
}

/**
 * Refuses (409) a file that is already the proof for another receipt or
 * payout entry: one document proves one purchase or one payout.
 */
function refuseReusedProof(db, { tripId, entryId, sha256, excludeProofId = null }) {
  const use = proofConflict(db, { sha256, entryId, excludeProofId });
  if (!use) return;
  const where =
    use.tripId === tripId
      ? `this trip's ${PROOF_KIND[use.type]} (${shortDate(use.occurred)}, ${pounds(use.amount)})`
      : `${use.tripLabel} (${PROOF_KIND[use.type]}, ${shortDate(use.occurred)}, ${pounds(use.amount)})`;
  fail(`This file is already the proof for ${where}: attach the document for this purchase or payout`, 409);
}

/** Number of proof records, on any trip, that refer to a stored file. */
export function proofFileUses(db, sha256) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM ledger_proofs WHERE sha256 = ?").get(sha256).n);
}

/**
 * The PRD rule: a verified trade needs the purchase receipt and the payout
 * record, which together prove realised profit. So a resale trade is verified
 * only when all of these hold:
 *   - at least one purchase receipt, one sold listing and one payout;
 *   - every receipt entry and every payout entry has its own proof attached
 *     to that entry. A whole-trip proof never counts, and one file proves one
 *     entry in the whole ledger: a file attached to more than one receipt or
 *     payout entry, on this trip or any other, counts for none of them, and
 *     every trip using it says so. New attachments of such a file are refused
 *     (recordProof, relinkProof); this catches duplicates made before that.
 *   - the records reconcile: findDiscrepancies() finds nothing, so no payout
 *     or sale is dated before the purchase and the amounts and units agree.
 * Work time is not needed: it only makes earnings per hour known.
 * Household trips and legacy totals are never verified.
 * uses is proofUses(db) for the whole ledger; left out, only this trip's
 * proofs are compared (pure calls and tests).
 * Returns { verified, missing, proofedEntries } where missing gives every
 * reason the trade is not verified, in words, and proofedEntries lists the
 * receipt and payout entry ids whose proof counts.
 */
export function verification(trip, entries, proofs = [], uses = null) {
  if (trip.kind !== "resale")
    return {
      verified: false,
      missing: ["Only resale trades are verified. Household savings are your own record."],
      proofedEntries: [],
    };
  if (trip.source === "legacy")
    return {
      verified: false,
      missing: ["Legacy totals have no purchase receipt or payout record to verify."],
      proofedEntries: [],
    };
  const receipts = entries.filter((e) => e.type === "receipt").sort(byDate);
  const payouts = entries.filter((e) => e.type === "payout").sort(byDate);
  const needsProof = new Set([...receipts, ...payouts].map((e) => e.id));
  // Which receipt or payout entries, in the whole ledger, each file is on.
  const ledger = uses || tripUses(trip, entries, proofs);
  const proofed = new Set();
  const shared = new Map(); // sha256 -> { label, others }
  for (const p of proofs) {
    if (p.entry_id === null || !needsProof.has(p.entry_id)) continue;
    const others = (ledger.get(p.sha256) || []).filter((u) => u.entryId !== p.entry_id);
    if (!others.length) proofed.add(p.entry_id);
    else if (!shared.has(p.sha256)) shared.set(p.sha256, { label: p.label, others });
  }

  const missing = [];
  if (!receipts.length) missing.push("Record the purchase receipt.");
  if (!entries.some((e) => e.type === "sale")) missing.push("Record the sold listing the payout is for.");
  if (!payouts.length) missing.push("Record the payout.");
  const describe = (e) => shortDate(e.occurred) + ", " + pounds(e.amount);
  for (const e of receipts)
    if (!proofed.has(e.id)) missing.push(`Attach a proof to the purchase receipt (${describe(e)}).`);
  for (const e of payouts)
    if (!proofed.has(e.id)) missing.push(`Attach a proof to the payout (${describe(e)}).`);
  for (const { label, others } of shared.values())
    missing.push(
      `The file "${label}" is attached to more than one receipt or payout entry, so it counts for none ` +
        `of them: it is also on ${others.map((u) => useWhere(u, trip.id)).join(" and ")}. ` +
        "One document proves one purchase or one payout: keep it on the entry it records and attach the " +
        "right document to the other.",
    );
  for (const d of findDiscrepancies(trip, entries)) missing.push("Records do not reconcile: " + d.message);
  return {
    verified: missing.length === 0,
    missing,
    proofedEntries: [...proofed].sort((a, b) => a - b),
  };
}

/**
 * Reconciles one trip's records. Pure: pass the trip, its entries, its
 * proof metadata and, for verification across the whole ledger, proofUses(db).
 *
 * Resale trips:
 *   realisedContribution = payouts - receipts - expenses - refunds. Only
 *     payouts count as income; sales and predictions do not.
 *   pendingPayout = recorded sales not yet paid out, on open trips only. It
 *     is never realised. See payoutPosition() for how fees are told apart
 *     from money still to come. On a closed trip nothing is pending.
 *   impliedFees = the gap between paid sales and payouts (see payoutPosition).
 *   unsoldUnits = units bought - units sold + units buyers sent back,
 *     floored at 0. A refund where the buyer kept the item returns no stock.
 *   cashTiedUp = spend not yet recovered by payouts on an open trip.
 *   realisedHourly = the whole trip's realised contribution over all its
 *     work time, whatever month each entry falls in (null with no work time).
 *     On a trip that is not completed yet it is the figure so far. Null when
 *     purchaseMissing: what the stock cost is not known, so neither is what
 *     the time earned.
 *   purchaseMissing = the trip sold stock (a sale, payout or refund) with no
 *     purchase recorded for all of it (purchaseMissing(); never for legacy
 *     totals, which record their costs as a total). The month's and the
 *     measures' earnings per hour count such a trip at its recorded result
 *     only where that lowers the figure, and name it either way.
 *   refundedUnpaid / refundedUnpaidUnits = sales refunded, with the item
 *     sent back, before they were paid out: not pending, because a refunded
 *     sale is not paid out (payoutWalk).
 *   completedOn = the date the trip was completed (completedOn()), or null
 *     while it is still open and not finished. The month summary's earnings
 *     per hour count a trip in the month it was completed.
 *   forecast.basis / forecast.counted: where the prediction came from (see
 *     predictionBasis) and whether it counts in the prediction accuracy
 *     measures (live evidence, and something recorded on the trip).
 * Household trips: saving entries count only as householdSavings, never as
 *   earnings or proceeds; netHouseholdSaving deducts the trip's expenses.
 */
export function reconcile(trip, entries, proofs = [], uses = null) {
  const resale = trip.kind === "resale";
  const open = trip.status !== "closed";
  const has = (type) => entries.some((e) => e.type === type);
  const receipts = sumOf(entries, "receipt");
  const sales = sumOf(entries, "sale");
  const payouts = sumOf(entries, "payout");
  const expenses = sumOf(entries, "expense");
  const refunds = sumOf(entries, "refund");
  const savings = sumOf(entries, "saving");
  const minutes = sumOf(entries, "work", "minutes");
  const unitsBought = sumOf(entries, "receipt", "units");
  const unitsSold = sumOf(entries, "sale", "units");
  const unitsReturned = sumOf(entries, "refund", "units");
  const spend = receipts + expenses + refunds;

  const realisedContribution = resale ? payouts - spend : null;
  const noPurchase = resale && purchaseMissing(entries, trip);
  const realisedHourly =
    resale && minutes > 0 && !noPurchase ? Math.round((realisedContribution * 60) / minutes) : null;
  const position = resale
    ? payoutWalk(entries)
    : { pending: 0, fees: null, basis: null, refundedUnpaid: 0, refundedUnpaidUnits: 0 };
  const pendingPayout = open ? position.pending : 0;
  const impliedFees = position.fees;
  const unsoldUnits = resale ? Math.max(0, unitsBought - unitsSold + unitsReturned) : null;
  const cashTiedUp = resale && open ? Math.max(0, spend - payouts) : 0;

  const firstReceipt = entries.filter((e) => e.type === "receipt").map((e) => e.occurred).sort()[0];
  const lastPayout = entries.filter((e) => e.type === "payout").map((e) => e.occurred).sort().at(-1);
  const payoutSpan = firstReceipt && lastPayout ? daysBetween(firstReceipt, lastPayout) : null;
  const timeToPayoutDays = payoutSpan !== null && payoutSpan >= 0 ? payoutSpan : null;

  const present = (type) => (has(type) ? "present" : "missing");
  const na = "not applicable";
  const checklist = resale
    ? {
        receipt: present("receipt"),
        soldListing: present("sale"),
        payout: present("payout"),
        expenses: present("expense"),
        returns: present("refund"),
        work: present("work"),
        saving: na,
        required: ["receipt", "soldListing", "payout", "work"],
      }
    : {
        receipt: present("receipt"),
        soldListing: na,
        payout: na,
        expenses: present("expense"),
        returns: na,
        work: present("work"),
        saving: present("saving"),
        required: ["receipt", "saving"],
      };
  checklist.complete = checklist.required.every((key) => checklist[key] === "present");

  const discrepancies = findDiscrepancies(trip, entries);
  checklist.reconciled = checklist.complete && discrepancies.length === 0;

  const { verified, missing, proofedEntries } = verification(trip, entries, proofs, uses);

  let forecast = null;
  if (resale && trip.predicted) {
    const p = trip.predicted;
    const predictedHourly =
      p.activeMinutes > 0 ? Math.round((p.contribution * 60) / p.activeMinutes) : null;
    const basis = predictionBasis(trip);
    forecast = {
      basis,
      // Counts in the prediction accuracy measures once the trip is closed.
      counted: basis === "live" && entries.length > 0,
      final: !open,
      predictedUnits: p.units,
      predictedProceeds: p.proceeds,
      predictedContribution: p.contribution,
      predictedCashRequired: p.cashRequired,
      predictedMinutes: p.activeMinutes,
      predictedHourly,
      payoutBy: p.payoutBy ?? null,
      // Positive means more than predicted, negative means less.
      contributionError: realisedContribution - p.contribution,
      minutesError: minutes > 0 ? minutes - p.activeMinutes : null,
      cashSpent: receipts + expenses,
      payoutLateDays:
        p.payoutBy && lastPayout && lastPayout > p.payoutBy ? daysBetween(p.payoutBy, lastPayout) : null,
    };
  }

  return {
    kind: trip.kind,
    status: trip.status,
    legacy: trip.source === "legacy",
    receipts,
    sales,
    payouts,
    expenses,
    refunds,
    minutes,
    spend,
    unitsBought,
    unitsSold,
    unitsReturned,
    unsoldUnits,
    realisedContribution,
    realisedHourly,
    purchaseMissing: noPurchase,
    pendingPayout,
    pendingBasis: open ? position.basis : null,
    refundedUnpaid: resale ? position.refundedUnpaid : 0,
    refundedUnpaidUnits: resale ? position.refundedUnpaidUnits : 0,
    impliedFees,
    cashTiedUp,
    householdSavings: resale ? 0 : savings,
    netHouseholdSaving: resale ? null : savings - expenses,
    checklist,
    discrepancies,
    verified,
    verificationMissing: missing,
    proofedEntries,
    forecast,
    timeToPayoutDays,
    completedOn: resale
      ? completedOn(trip, entries, { unitsBought, unsoldUnits, pending: position.pending, payouts })
      : null,
  };
}

/**
 * When a resale trip was completed, as a date, or null while it is not:
 *   - a closed trip was completed on the date of its last entry (closed trips
 *     take no new entries, so the date never moves). A closed trip with no
 *     entries has no date.
 *   - an open trip is completed once everything bought has been sold and
 *     every sale paid out: stock was bought, no unit is left unsold, a payout
 *     is recorded and no sale is waiting for one. It is then completed on the
 *     date of its last entry. A new entry that leaves something to come (more
 *     stock, a returned unit, an unpaid sale) makes it open again.
 * The month summary counts a trip's earnings per hour, over its whole life,
 * in the month it was completed, and leaves out trips not completed.
 * figures: { unitsBought, unsoldUnits, pending, payouts } from reconcile().
 */
export function completedOn(trip, entries, { unitsBought, unsoldUnits, pending, payouts }) {
  if (trip.kind !== "resale" || !entries.length) return null;
  const last = entries.reduce((date, e) => (e.occurred > date ? e.occurred : date), entries[0].occurred);
  if (trip.status === "closed") return last;
  const finished = unitsBought > 0 && unsoldUnits === 0 && payouts > 0 && pending === 0;
  return finished ? last : null;
}

/**
 * True for resale entries that sold stock (a sale, a payout or a refund)
 * with no purchase recorded for all of it: no purchase receipt at all, or
 * more units sold, less units buyers sent back, than were bought. What the
 * stock cost is then not known, so the trip's own earnings per hour are not
 * known, and its recorded result is the most it can have earned: the month's
 * and the measures' figures count it only where that lowers them, and name
 * it either way (countWhereLower; round five, fix b).
 * Not for:
 *   - a trip that sold nothing (time and expenses only, such as a wasted
 *     journey): its cost is known, and leaving it out would overstate;
 *   - legacy totals (pass the trip): their "total actual costs" are recorded
 *     as one expense, the stock included, so their cost is known.
 */
export function purchaseMissing(entries, trip = null) {
  if (trip?.source === "legacy") return false;
  const sold = entries.some((e) => e.type === "sale" || e.type === "payout" || e.type === "refund");
  if (!sold) return false;
  if (!entries.some((e) => e.type === "receipt")) return true;
  const net = sumOf(entries, "sale", "units") - sumOf(entries.filter(returnsStock), "refund", "units");
  return net > sumOf(entries, "receipt", "units");
}

/**
 * Which trips that sold stock with no purchase recorded (purchaseMissing)
 * earnings per hour count. Their recorded result is the most they can have
 * earned, since what their stock cost is not known: counted, a gain could
 * overstate the figure; left out, a weak result would raise it. So each is
 * counted at its recorded result only where that lowers the figure, and the
 * rest are left out (round five, fix b, second pass). The lowest earners per
 * hour go first, so the figure ends as low as any choice of them could make
 * it. With no measured trip there is no figure to lower: all are left out,
 * and so is any with no work time (as trips without work time are).
 *   base: { minutes, earnings } of the measured trips.
 *   trips: [{ minutes, earnings, ... }].
 * Returns { counted, leftOut }, each a list of the given trips.
 */
export function countWhereLower(base, trips) {
  const counted = [];
  const leftOut = trips.filter((t) => !(t.minutes > 0));
  let { minutes, earnings } = base;
  const timed = trips.filter((t) => t.minutes > 0).sort((a, b) => a.earnings / a.minutes - b.earnings / b.minutes);
  for (const [i, t] of timed.entries()) {
    // Lower than the figure so far: t.earnings / t.minutes < earnings / minutes.
    if (!(minutes > 0) || t.earnings * minutes >= earnings * t.minutes) {
      leftOut.push(...timed.slice(i));
      break;
    }
    counted.push(t);
    minutes += t.minutes;
    earnings += t.earnings;
  }
  return { counted, leftOut };
}

// ---------------------------------------------------------------------------
// Writing

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const absent = (value) => value === undefined || value === null || value === "";

/**
 * Validates the predictions stored with a trip (all integer pence/minutes).
 * sample: true when the prediction came from sample or illustrative figures,
 * false when it came from live evidence; left out, it is stored as null and
 * the prediction is not counted (see predictionBasis). Planner predictions are
 * always stored as sample.
 */
function predictedInput(value, source) {
  if (absent(value)) return null;
  if (!isObject(value)) fail("predicted must be an object");
  const sample = absent(value.sample) ? null : bool(value.sample, "predicted.sample");
  return {
    units: int(value.units, "predicted.units", 1, MAX_UNITS),
    proceeds: int(value.proceeds, "predicted.proceeds (pence)", 0, MAX_PENCE),
    contribution: int(value.contribution, "predicted.contribution (pence)", -MAX_PENCE, MAX_PENCE),
    cashRequired: int(value.cashRequired, "predicted.cashRequired (pence)", 0, MAX_PENCE),
    activeMinutes: int(value.activeMinutes, "predicted.activeMinutes", 0, 100000),
    payoutBy: isoDate(value.payoutBy, "predicted.payoutBy", { optional: true }),
    sample: source === "planner" ? true : sample,
  };
}

/**
 * Creates an open trip. Predictions are stored for forecast error only and
 * never count as realised cash. Returns the new id.
 */
export function createTrip(db, input, { now = new Date() } = {}) {
  if (!isObject(input)) fail("Send a JSON object");
  const label = text(input.label, "label", 120);
  const source = oneOf(input.source, "source", TRIP_SOURCES);
  const kind = oneOf(input.kind, "kind", TRIP_KINDS);
  const reference = text(input.reference, "reference", 120, { optional: true });
  const predicted = predictedInput(input.predicted, source);
  if (predicted && kind !== "resale")
    fail("Predictions apply to resale trips only. Household savings are recorded as they happen.");
  const result = db
    .prepare(
      `INSERT INTO ledger_trips (label, source, kind, reference, predicted, status, created)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(label, source, kind, reference, predicted ? JSON.stringify(predicted) : null, now.toISOString());
  return Number(result.lastInsertRowid);
}

/**
 * Units: required on resale receipts (bought), sales (sold) and refunds where
 * the buyer sent the item back (units returned to stock); optional on payouts
 * (units the payout covers, which lets the ledger tell fees from payouts
 * still to come) and on household receipts and savings. Not used on expenses,
 * work or refunds where the buyer kept the item.
 */
function unitsInput(value, type, kind, itemReturned = null) {
  if (type === "refund" && itemReturned === false) {
    if (!absent(value))
      fail("Leave units empty when the buyer keeps the item: no stock comes back. Units are for items sent back to you.");
    return null;
  }
  if (type === "refund" && kind === "resale" && absent(value))
    fail(
      "Say how many units the buyer sent back, as a whole number from 1 to " + MAX_UNITS +
        ", or say that the buyer kept the item",
    );
  const required = kind === "resale" && ["receipt", "sale", "refund"].includes(type);
  const optional =
    (kind === "resale" && type === "payout") ||
    (kind === "household" && ["receipt", "saving"].includes(type));
  if (required) return int(value, "units", 1, MAX_UNITS);
  if (optional) return absent(value) ? null : int(value, "units", 1, MAX_UNITS);
  if (!absent(value)) fail("units do not apply to " + type + " entries");
  return null;
}

/**
 * Adds a dated entry to an open trip. Amounts are integer pence: at least 1p
 * for money entries and none for work, which records minutes instead. Dates
 * must be real calendar dates, not in the future. A refund says whether the
 * buyer sent the item back: itemReturned true (or left out, as before) with
 * the units that came back, which return to stock and can be sold again, or
 * itemReturned false with no units when the buyer kept the item. A refund
 * where the item came back may give returnedOn, the date it came back (a
 * real date, not before 2000 and not in the future), when that was not the
 * day the money went out: the stock walk uses it, the money keeps the
 * refund's date. Returns the new id.
 */
export function addEntry(db, tripId, input, { now = new Date() } = {}) {
  const trip = requireTrip(db, tripId);
  if (trip.legacy)
    fail("Legacy totals cannot take new entries. Create a new trip for new activity.", 409);
  if (trip.status === "closed") fail("This trip is closed. Add entries to an open trip.", 409);
  if (!isObject(input)) fail("Send a JSON object");
  const type = oneOf(input.type, "type", ENTRY_TYPES);
  const allowed = ENTRY_TYPES_BY_KIND[trip.kind];
  if (!allowed.includes(type))
    fail(`A ${trip.kind} trip cannot take ${type} entries. Allowed: ${allowed.join(", ")}`);
  let amount;
  let minutes = null;
  if (type === "work") {
    if (!absent(input.amount) && input.amount !== 0)
      fail("Work entries record minutes, not money: leave the amount empty");
    amount = 0;
    minutes = int(input.minutes, "minutes", 1, MAX_WORK_MINUTES);
  } else {
    amount = int(input.amount, "amount (whole pence)", 1, MAX_PENCE);
    if (!absent(input.minutes)) fail("minutes apply to work entries only");
  }
  let itemReturned = null;
  if (!absent(input.itemReturned)) {
    if (type !== "refund") fail("Whether the buyer sent the item back applies to refund entries only.");
    itemReturned = bool(input.itemReturned, "Whether the buyer sent the item back");
  }
  const units = unitsInput(input.units, type, trip.kind, itemReturned);
  const reference = text(input.reference, "reference", 120, { optional: true });
  const occurred = pastDate(input.occurred, "date", now);
  const note = text(input.note, "note", 500, { optional: true });
  let returnedOn = null;
  if (!absent(input.returnedOn)) {
    if (type !== "refund")
      fail("The date the item came back applies to refund entries only: the day an item a buyer sent back reached you.");
    if (itemReturned === false)
      fail("Leave the date the item came back empty when the buyer kept the item: nothing came back.");
    returnedOn = pastDate(input.returnedOn, "The date the item came back", now);
  }
  return transaction(db, () => {
    const result = db
      .prepare(
        `INSERT INTO ledger_entries (trip_id, type, amount, units, reference, occurred, minutes, note, created)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(trip.id, type, amount, units, reference, occurred, minutes, note, now.toISOString());
    const id = Number(result.lastInsertRowid);
    if (returnedOn)
      db.prepare("INSERT INTO ledger_refund_returns (entry_id, returned_on) VALUES (?, ?)").run(id, returnedOn);
    return id;
  });
}

/**
 * Removes a mistaken entry from an open trip. A proof attached to it stays
 * stored but becomes a whole-trip proof, so it no longer counts towards
 * verification until it is linked to another entry (relinkProof) or removed
 * (removeProof). Closed trips and legacy totals cannot be changed.
 */
export function deleteEntry(db, tripId, entryId) {
  const trip = requireTrip(db, tripId);
  if (trip.legacy) fail("Legacy totals cannot be changed.", 409);
  if (trip.status === "closed") fail("This trip is closed. Entries can only be removed from open trips.", 409);
  const entry = db.prepare("SELECT id FROM ledger_entries WHERE id = ? AND trip_id = ?").get(entryId, trip.id);
  if (!entry) fail("No entry " + entryId + " on this trip", 404);
  transaction(db, () => {
    db.prepare("UPDATE ledger_proofs SET entry_id = NULL WHERE entry_id = ?").run(entryId);
    if (hasReturnsTable(db)) db.prepare("DELETE FROM ledger_refund_returns WHERE entry_id = ?").run(entryId);
    db.prepare("DELETE FROM ledger_entries WHERE id = ?").run(entryId);
  });
  return getTrip(db, trip.id);
}

/** Closes an open trip. Closed trips feed the forecast metrics. */
export function closeTrip(db, tripId, { now = new Date() } = {}) {
  const trip = requireTrip(db, tripId);
  if (trip.status === "closed") fail("This trip is already closed", 409);
  db.prepare("UPDATE ledger_trips SET status = 'closed', closed_at = ? WHERE id = ?").run(
    now.toISOString(),
    trip.id,
  );
  return getTrip(db, trip.id);
}

/**
 * Validates where a proof will attach before any file is written: the trip
 * must exist and not be legacy totals, and an entry id must belong to it.
 * Returns { trip, entryId, label }.
 */
export function proofTarget(db, tripId, input) {
  const trip = requireTrip(db, tripId);
  if (trip.legacy)
    fail("Legacy totals cannot be verified. Create a new trip with the receipt and payout.", 409);
  if (!isObject(input)) fail("Send a JSON object");
  const label = text(input.label, "label", 120);
  return { trip, entryId: entryOnTrip(db, trip, input.entryId), label };
}

/** An entry id that belongs to the trip, or null (whole trip) when absent. */
function entryOnTrip(db, trip, value) {
  if (absent(value)) return null;
  const entryId = int(value, "entryId", 1, Number.MAX_SAFE_INTEGER);
  const entry = db
    .prepare("SELECT id FROM ledger_entries WHERE id = ? AND trip_id = ?")
    .get(entryId, trip.id);
  if (!entry) fail("entryId must be an entry on this trip");
  return entryId;
}

function requireProof(db, tripId, proofId) {
  const trip = requireTrip(db, tripId);
  const row = db.prepare("SELECT * FROM ledger_proofs WHERE id = ? AND trip_id = ?").get(proofId, trip.id);
  if (!row) fail("No proof " + proofId + " on this trip", 404);
  return { trip, row };
}

/**
 * Moves a stored proof to another entry on the same trip, or to the whole
 * trip with entryId null (which does not count towards verification). When
 * the same file is already attached to that entry, the duplicate record is
 * removed instead. Moving a file onto an entry is refused (409) while it is
 * the proof for another receipt or payout entry anywhere in the ledger.
 * Works on open and closed trips, since proofs are evidence about the
 * records rather than records themselves. Returns the trip detail.
 */
export function relinkProof(db, tripId, proofId, input) {
  const { trip, row } = requireProof(db, tripId, proofId);
  if (!isObject(input) || !("entryId" in input))
    fail("Send entryId: an entry on this trip, or null for the whole trip");
  const entryId = entryOnTrip(db, trip, input.entryId);
  transaction(db, () => {
    refuseReusedProof(db, { tripId: trip.id, entryId, sha256: row.sha256, excludeProofId: row.id });
    const duplicate = db
      .prepare("SELECT id FROM ledger_proofs WHERE trip_id = ? AND entry_id IS ? AND sha256 = ? AND id != ?")
      .get(trip.id, entryId, row.sha256, row.id);
    if (duplicate) db.prepare("DELETE FROM ledger_proofs WHERE id = ?").run(row.id);
    else db.prepare("UPDATE ledger_proofs SET entry_id = ? WHERE id = ?").run(entryId, row.id);
  });
  return getTrip(db, trip.id);
}

/**
 * Removes a proof record. Returns { sha256, fileUnused } where fileUnused is
 * true when no other proof record (on any trip) refers to the same stored
 * file, so the caller may delete the file itself.
 */
export function removeProof(db, tripId, proofId) {
  const { row } = requireProof(db, tripId, proofId);
  return transaction(db, () => {
    db.prepare("DELETE FROM ledger_proofs WHERE id = ?").run(row.id);
    return { sha256: row.sha256, fileUnused: proofFileUses(db, row.sha256) === 0 };
  });
}

/**
 * Records proof metadata after the file is stored. The same content attached
 * to the same entry again returns the existing record instead of a copy.
 * A file that is already the proof for another receipt or payout entry,
 * on this trip or any other, is refused with 409 when it is attached to an
 * entry: one document proves one purchase or one payout. (Kept on the whole
 * trip, entryId null, it is stored but never counts.) Returns
 * { proof, created }.
 */
export function recordProof(db, { tripId, entryId, label, sha256, bytes, mediaType }, { now = new Date() } = {}) {
  return transaction(db, () => {
    const existing = db
      .prepare("SELECT * FROM ledger_proofs WHERE trip_id = ? AND entry_id IS ? AND sha256 = ?")
      .get(tripId, entryId, sha256);
    if (existing) return { proof: proofView(existing), created: false };
    refuseReusedProof(db, { tripId, entryId, sha256 });
    const result = db
      .prepare(
        `INSERT INTO ledger_proofs (trip_id, entry_id, sha256, bytes, media_type, label, created)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(tripId, entryId, sha256, bytes, mediaType, label, now.toISOString());
    const row = db.prepare("SELECT * FROM ledger_proofs WHERE id = ?").get(result.lastInsertRowid);
    return { proof: proofView(row), created: true };
  });
}

/**
 * Checks, before a file is written, that it may be attached where asked
 * (409 when it is already the proof for another receipt or payout entry).
 * recordProof checks again inside its transaction.
 */
export function checkProofTarget(db, { tripId, entryId, sha256 }) {
  refuseReusedProof(db, { tripId, entryId, sha256 });
}

// ---------------------------------------------------------------------------
// Monthly summary and metrics

/**
 * One month on a cash basis, per the ledger contract in docs/ARCHITECTURE.md.
 *
 * Month figures (entries dated in the month):
 *   realisedEarnings = resale payouts minus resale receipts, expenses and
 *     refunds dated in the month. Stock bought in one month and paid out in
 *     the next shows as a cost in the first month and income in the second.
 *   householdSavings = household saving entries minus household trip
 *     expenses (travel, parking) dated in the month, so a trip that cost more
 *     than it saved lowers the figure. Never earnings. This is the figure a
 *     savings goal counts. householdSavingsGross and householdTripCosts are
 *     its two parts.
 *   realisedMinutes = resale work minutes dated in the month.
 * Earnings per hour (a set of whole trips, not the month's cash):
 *   realisedHourly = earnings per hour on the resale trips completed in the
 *     month (completedOn() in the month: closed, or open with everything
 *     bought sold and paid out, dated by the trip's last entry). Each counts
 *     with all its payouts less all its receipts, expenses and refunds over
 *     all its work time, whatever month each entry falls in, so stock bought
 *     and worked on in one month and paid out in the next gives one figure,
 *     in the month the trip was completed, and none in the month before.
 *     Money is never divided by another trip's hours, nor one month's payout
 *     by one month's minutes. Null ("not known") when no trip with work time
 *     was completed in the month.
 *     hourly = { trips, minutes, earnings, leftOutTrips, leftOutEarnings,
 *     stillOpen, completedLater }: trips, minutes and earnings are what was
 *     measured (whole-trip figures); leftOutTrips and leftOutEarnings are the
 *     trips completed in the month with money but no work time; stillOpen
 *     counts trips with entries dated in the month that are not completed
 *     (left out until they are); completedLater counts trips with entries
 *     dated in the month that were completed in a later month (counted
 *     there).
 *     hourlyNoPurchase = { trips, earnings, open, openNoWork, countedTrips,
 *     countedEarnings }: trips completed in the month that sold stock with no
 *     purchase recorded for all of it (purchaseMissing()). Their recorded
 *     result is the most they can have earned, so each is counted only where
 *     it lowers the figure (countWhereLower): countedTrips and
 *     countedEarnings are those counted, and they are in hourly too. trips
 *     and earnings are those left out, and open how many of those are still
 *     open (a closed trip takes no new entries, so its purchase can no longer
 *     be added). openNoWork is how many of the open ones have no work time:
 *     they stay out until their work time is recorded too, as every trip
 *     without work time does (round five, fix b, third pass). Kept out of
 *     hourly so its shape is unchanged.
 *   payouts / verifiedPayouts / verifiedEarnings = the same cash figures, in
 *     total and for verified trades only (see verification(): every receipt
 *     and payout has its own proof, a sale is recorded and the records
 *     reconcile).
 * Current position (open resale trips, whatever their dates):
 *   pendingPayouts = recorded sales no payout covers yet and not refunded
 *     before they were paid out (payoutPosition).
 *   potentialProceeds = predicted proceeds on open trips whose prediction
 *     came from live evidence, that have a purchase receipt and no payout
 *     yet. The prediction is scaled to the units actually bought, and sales
 *     already recorded are taken off (those are under pendingPayouts), so the
 *     two figures never count the same money. An estimate only.
 *     potentialProceedsLeftOut counts the open trips with a prediction that
 *     were left out: sample predictions, predictions whose evidence basis was
 *     not recorded, and trips where nothing has been bought yet.
 *   cashTiedUp = spend not yet recovered by payouts.
 *   unsoldUnits = units bought and not yet sold.
 */
export function summary(db, month) {
  monthParam(month);
  const inMonth = (e) => e.occurred.slice(0, 7) === month;
  const totals = {
    realisedEarnings: 0,
    householdSavingsGross: 0,
    householdTripCosts: 0,
    pendingPayouts: 0,
    potentialProceeds: 0,
    cashTiedUp: 0,
    unsoldUnits: 0,
    realisedMinutes: 0,
    payouts: 0,
    verifiedPayouts: 0,
    verifiedEarnings: 0,
    openTrips: 0,
    verifiedTrips: 0,
    unverifiedTrips: 0,
  };
  const leftOut = { sample: 0, basisUnknown: 0, nothingBought: 0 };
  const hourly = {
    trips: 0,
    minutes: 0,
    earnings: 0,
    leftOutTrips: 0,
    leftOutEarnings: 0,
    stillOpen: 0,
    completedLater: 0,
  };
  // Completed this month after selling stock with no purchase recorded
  // (purchaseMissing): counted only where they lower the figure (countWhereLower).
  const noPurchaseTrips = [];
  for (const { trip, entries, proofs, uses } of loadAll(db)) {
    const monthEntries = entries.filter(inMonth);
    if (trip.kind === "household") {
      totals.householdSavingsGross += sumOf(monthEntries, "saving");
      totals.householdTripCosts += sumOf(monthEntries, "expense");
      continue;
    }
    const r = reconcile(trip, entries, proofs, uses);
    const payouts = sumOf(monthEntries, "payout");
    const costs =
      sumOf(monthEntries, "receipt") + sumOf(monthEntries, "expense") + sumOf(monthEntries, "refund");
    const minutes = sumOf(monthEntries, "work", "minutes");
    totals.realisedEarnings += payouts - costs;
    totals.payouts += payouts;
    totals.realisedMinutes += minutes;
    // Earnings per hour: whole trips completed this month, with every entry
    // they have, whatever its month. A trip completes on its last entry, so
    // no trip has entries after the month it was completed in. A trip that
    // sold stock with no purchase recorded is set aside, whatever its time,
    // and counted below only where it lowers the figure.
    if (r.completedOn && inMonth({ occurred: r.completedOn })) {
      if (r.purchaseMissing) {
        noPurchaseTrips.push({ minutes: r.minutes, earnings: r.realisedContribution, open: trip.status === "open" });
      } else if (r.minutes > 0) {
        hourly.trips += 1;
        hourly.minutes += r.minutes;
        hourly.earnings += r.realisedContribution;
      } else if (entries.some((e) => CASH_TYPES.includes(e.type))) {
        hourly.leftOutTrips += 1;
        hourly.leftOutEarnings += r.realisedContribution;
      }
    } else if (monthEntries.length) {
      hourly[r.completedOn ? "completedLater" : "stillOpen"] += 1;
    }
    if (monthEntries.length) totals[r.verified ? "verifiedTrips" : "unverifiedTrips"] += 1;
    if (r.verified) {
      totals.verifiedPayouts += payouts;
      totals.verifiedEarnings += payouts - costs;
    }
    if (trip.status === "open") {
      totals.openTrips += 1;
      totals.pendingPayouts += r.pendingPayout;
      totals.cashTiedUp += r.cashTiedUp;
      totals.unsoldUnits += r.unsoldUnits;
      // Once a payout arrives the trip's actual figures replace the estimate.
      if (trip.predicted && r.payouts === 0) {
        const p = trip.predicted;
        if (trip.predictionBasis === "sample") leftOut.sample += 1;
        else if (trip.predictionBasis !== "live") leftOut.basisUnknown += 1;
        else if (!entries.some((e) => e.type === "receipt")) leftOut.nothingBought += 1;
        else {
          const units = Math.min(r.unitsBought, p.units);
          totals.potentialProceeds += Math.max(0, Math.floor((p.proceeds * units) / p.units) - r.sales);
        }
      }
    }
  }
  const np = countWhereLower(hourly, noPurchaseTrips);
  for (const t of np.counted) {
    hourly.trips += 1;
    hourly.minutes += t.minutes;
    hourly.earnings += t.earnings;
  }
  const total = (list) => list.reduce((sum, t) => sum + t.earnings, 0);
  return {
    month,
    realisedEarnings: totals.realisedEarnings,
    householdSavings: totals.householdSavingsGross - totals.householdTripCosts,
    householdSavingsGross: totals.householdSavingsGross,
    householdTripCosts: totals.householdTripCosts,
    pendingPayouts: totals.pendingPayouts,
    potentialProceeds: totals.potentialProceeds,
    potentialProceedsLeftOut: leftOut,
    cashTiedUp: totals.cashTiedUp,
    unsoldUnits: totals.unsoldUnits,
    realisedMinutes: totals.realisedMinutes,
    realisedHourly: hourly.trips > 0 ? Math.round((hourly.earnings * 60) / hourly.minutes) : null,
    hourly,
    hourlyNoPurchase: {
      trips: np.leftOut.length,
      earnings: total(np.leftOut),
      open: np.leftOut.filter((t) => t.open).length,
      openNoWork: np.leftOut.filter((t) => t.open && !(t.minutes > 0)).length,
      countedTrips: np.counted.length,
      countedEarnings: total(np.counted),
    },
    payouts: totals.payouts,
    verifiedPayouts: totals.verifiedPayouts,
    verifiedEarnings: totals.verifiedEarnings,
    verifiedTrips: totals.verifiedTrips,
    unverifiedTrips: totals.unverifiedTrips,
    openTrips: totals.openTrips,
    basis:
      "Cash basis: payouts dated in the month minus receipts, expenses and refunds dated in the month. " +
      "Household savings are savings dated in the month less household trip expenses dated in the month. " +
      "Pending payouts, potential proceeds, cash tied up and unsold units are the current position of open resale trips. " +
      "Potential proceeds count only live-evidence predictions on trips with a purchase receipt. " +
      "Realised hourly covers only the trips completed in the month (closed, or open with everything bought sold and paid out), " +
      "each with all its payouts, costs and work time, whatever month they fall in. " +
      "Trips still open are left out, and money from trips without work time is left out. " +
      "Trips that sold stock with no purchase recorded for it are left out too, because what the stock cost is not known, " +
      "except where counting them at their recorded result lowers the figure.",
  };
}

const mean = (values) =>
  values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
/** Median; with an even count, the mean of the two middle values. */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Measures over closed resale trips (legacy totals are excluded and counted
 * separately because they cannot be reconciled):
 *   forecast: mean absolute and mean contribution error (realised minus
 *     predicted, so negative means it earned less than predicted) and the
 *     same for minutes (actual minus predicted), over trips whose prediction
 *     came from live evidence and that have something recorded. leftOut
 *     counts the closed trips with a prediction that were not measured:
 *     sample predictions, predictions whose evidence basis was not recorded
 *     and trips closed with nothing recorded (never taken).
 *   cash: recovery rate = payouts / spend (receipts, expenses and refunds),
 *     with the payouts of verified trades.
 *   medianTimeToPayoutDays: first receipt to last payout.
 *   unsoldUnits: units left unsold when the trips were closed.
 *   hourly: realised earnings per hour over closed trips with work recorded,
 *     each with all its payouts, costs and work time whatever their dates
 *     (the same whole-trip basis as the month summary), and a like-for-like
 *     comparison with predicted hourly on the measured trips that have both.
 *     Closed trips that sold stock with no purchase recorded for it count in
 *     realised only where their recorded result lowers it (countWhereLower):
 *     noPurchaseCountedTrips and noPurchaseCountedEarnings are those counted
 *     (in trips too), noPurchaseTrips and noPurchaseEarnings those left out.
 *     The comparison leaves them all out: their realised figure is not known.
 */
export function metrics(db) {
  const all = loadAll(db);
  const legacyTrips = all.filter(({ trip }) => trip.legacy).length;
  const closed = all
    .filter(({ trip }) => trip.kind === "resale" && trip.status === "closed" && !trip.legacy)
    .map(({ trip, entries, proofs, uses }) => ({ trip, r: reconcile(trip, entries, proofs, uses) }));
  const leftOut = { sample: 0, basisUnknown: 0, notTaken: 0 };
  const predicted = closed.filter(({ trip, r }) => {
    if (!trip.predicted) return false;
    if (r.forecast.counted) return true;
    if (r.forecast.basis === "sample") leftOut.sample += 1;
    else if (r.forecast.basis !== "live") leftOut.basisUnknown += 1;
    else leftOut.notTaken += 1;
    return false;
  });
  const contributionErrors = predicted.map(({ r }) => r.forecast.contributionError);
  const minutesErrors = predicted
    .map(({ r }) => r.forecast.minutesError)
    .filter((value) => value !== null);
  const spend = closed.reduce((t, { r }) => t + r.spend, 0);
  const payouts = closed.reduce((t, { r }) => t + r.payouts, 0);
  const verified = closed.filter(({ r }) => r.verified);
  const verifiedPayouts = verified.reduce((t, { r }) => t + r.payouts, 0);
  const payoutDays = closed.map(({ r }) => r.timeToPayoutDays).filter((d) => d !== null);
  // Earnings per hour fail closed: a trip that sold stock with no purchase
  // recorded for it (purchaseMissing) counts only where it lowers the figure.
  const measured = closed.filter(({ r }) => r.minutes > 0 && !r.purchaseMissing);
  const np = countWhereLower(
    {
      minutes: measured.reduce((t, { r }) => t + r.minutes, 0),
      earnings: measured.reduce((t, { r }) => t + r.realisedContribution, 0),
    },
    closed.filter(({ r }) => r.purchaseMissing).map(({ r }) => ({ minutes: r.minutes, earnings: r.realisedContribution })),
  );
  const worked = [...measured.map(({ r }) => ({ minutes: r.minutes, earnings: r.realisedContribution })), ...np.counted];
  const earningsOf = (list) => list.reduce((t, x) => t + x.earnings, 0);
  const hourlyOf = (contribution, minutes) =>
    minutes > 0 ? Math.round((contribution * 60) / minutes) : null;
  const comparable = predicted.filter(
    ({ trip, r }) => r.minutes > 0 && !r.purchaseMissing && trip.predicted.activeMinutes > 0,
  );
  return {
    closedTrips: closed.length,
    verifiedTrips: verified.length,
    legacyTrips,
    forecast: {
      trips: predicted.length,
      meanAbsoluteContributionError: mean(contributionErrors.map(Math.abs)),
      meanContributionError: mean(contributionErrors),
      minutesTrips: minutesErrors.length,
      meanAbsoluteMinutesError: mean(minutesErrors.map(Math.abs)),
      meanMinutesError: mean(minutesErrors),
      leftOut,
    },
    cash: {
      spend,
      payouts,
      verifiedPayouts,
      recoveryRate: spend > 0 ? payouts / spend : null,
    },
    payoutTrips: payoutDays.length,
    medianTimeToPayoutDays: median(payoutDays),
    unsoldUnits: closed.reduce((t, { r }) => t + r.unsoldUnits, 0),
    hourly: {
      trips: worked.length,
      realised: hourlyOf(
        earningsOf(worked),
        worked.reduce((t, x) => t + x.minutes, 0),
      ),
      noPurchaseTrips: np.leftOut.length,
      noPurchaseEarnings: earningsOf(np.leftOut),
      noPurchaseCountedTrips: np.counted.length,
      noPurchaseCountedEarnings: earningsOf(np.counted),
      comparison: {
        trips: comparable.length,
        realised: hourlyOf(
          comparable.reduce((t, { r }) => t + r.realisedContribution, 0),
          comparable.reduce((t, { r }) => t + r.minutes, 0),
        ),
        predicted: hourlyOf(
          comparable.reduce((t, { trip }) => t + trip.predicted.contribution, 0),
          comparable.reduce((t, { trip }) => t + trip.predicted.activeMinutes, 0),
        ),
      },
    },
  };
}

