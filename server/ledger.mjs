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
import { fail, int, isoDate, oneOf, text, transaction } from "./http.mjs";
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
//   refund   money you paid back to a buyer for a return (units returned)
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
const ENTRIES_TABLE = `CREATE TABLE IF NOT EXISTS ledger_entries (
 id INTEGER PRIMARY KEY,
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
const PROOFS_TABLE = `CREATE TABLE IF NOT EXISTS ledger_proofs (
 id INTEGER PRIMARY KEY,
 trip_id INTEGER NOT NULL REFERENCES ledger_trips(id),
 entry_id INTEGER REFERENCES ledger_entries(id),
 sha256 TEXT NOT NULL,
 bytes INTEGER NOT NULL,
 media_type TEXT NOT NULL,
 label TEXT NOT NULL,
 created TEXT NOT NULL
)`;
// Which rows of the old outcomes table have been copied into trips, so that
// running the migration again never duplicates them.
const LEGACY_TABLE = `CREATE TABLE IF NOT EXISTS ledger_legacy_outcomes (
 outcome_id INTEGER PRIMARY KEY,
 trip_id INTEGER NOT NULL REFERENCES ledger_trips(id),
 migrated TEXT NOT NULL
)`;

/** Creates the ledger tables (idempotent) and migrates legacy outcomes. */
export function schema(db, { now = new Date() } = {}) {
  db.exec(TRIPS_TABLE);
  db.exec(ENTRIES_TABLE);
  db.exec(PROOFS_TABLE);
  db.exec(LEGACY_TABLE);
  db.exec("CREATE INDEX IF NOT EXISTS ledger_entries_trip ON ledger_entries(trip_id)");
  db.exec("CREATE INDEX IF NOT EXISTS ledger_entries_occurred ON ledger_entries(occurred)");
  db.exec("CREATE INDEX IF NOT EXISTS ledger_proofs_trip ON ledger_proofs(trip_id)");
  migrateLegacyOutcomes(db, now);
}

// ---------------------------------------------------------------------------
// Dates

const DAY_MS = 86400000;
const londonFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's calendar date in the UK (YYYY-MM-DD), the date a user would write. */
export const londonDate = (now = new Date()) => londonFormat.format(now);

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
      const occurred = created.slice(0, 10) <= today ? created.slice(0, 10) : today;
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

function tripView(row) {
  return {
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
  };
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
  const entries = groupBy(
    db.prepare("SELECT * FROM ledger_entries ORDER BY occurred, id").all().map(entryView),
    "trip_id",
  );
  const proofs = groupBy(
    db.prepare("SELECT * FROM ledger_proofs ORDER BY id").all().map(proofView),
    "trip_id",
  );
  return trips.map((trip) => ({
    trip,
    entries: entries.get(trip.id) || [],
    proofs: proofs.get(trip.id) || [],
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
  const entries = db
    .prepare("SELECT * FROM ledger_entries WHERE trip_id = ? ORDER BY occurred, id")
    .all(id)
    .map(entryView);
  const proofs = db
    .prepare("SELECT * FROM ledger_proofs WHERE trip_id = ? ORDER BY id")
    .all(id)
    .map(proofView);
  return { trip, entries, proofs, reconciliation: reconcile(trip, entries, proofs) };
}

/** All trips, newest first, each with its headline reconciliation figures. */
export function listTrips(db) {
  return loadAll(db).map(({ trip, entries, proofs }) => {
    const r = reconcile(trip, entries, proofs);
    return {
      ...trip,
      entries: entries.length,
      proofs: proofs.length,
      realisedContribution: r.realisedContribution,
      householdSavings: r.householdSavings,
      pendingPayout: r.pendingPayout,
      unsoldUnits: r.unsoldUnits,
      complete: r.checklist.complete,
      discrepancies: r.discrepancies.length,
      verified: r.verified,
    };
  });
}

// ---------------------------------------------------------------------------
// Reconciliation

const pounds = (pence) => "£" + (pence / 100).toFixed(2);
const sumOf = (entries, type, field = "amount") =>
  entries.filter((e) => e.type === type).reduce((total, e) => total + (e[field] ?? 0), 0);

/**
 * A trade is verified only when it has a purchase receipt entry with an
 * attached proof AND a payout entry with an attached proof, and those are two
 * different files. Household trips and legacy totals are never verified.
 * Returns { verified, missing } where missing lists what verification needs.
 */
export function verification(trip, entries, proofs = []) {
  if (trip.kind !== "resale")
    return { verified: false, missing: ["Only resale trades are verified. Household savings are your own record."] };
  if (trip.source === "legacy")
    return { verified: false, missing: ["Legacy totals have no purchase receipt or payout record to verify."] };
  const typeOf = new Map(entries.map((e) => [e.id, e.type]));
  const hashes = (type) =>
    new Set(proofs.filter((p) => p.entry_id !== null && typeOf.get(p.entry_id) === type).map((p) => p.sha256));
  const missing = [];
  const receiptProofs = hashes("receipt");
  const payoutProofs = hashes("payout");
  if (!entries.some((e) => e.type === "receipt")) missing.push("Record the purchase receipt.");
  else if (!receiptProofs.size) missing.push("Attach a proof to the purchase receipt entry.");
  if (!entries.some((e) => e.type === "payout")) missing.push("Record the payout.");
  else if (!payoutProofs.size) missing.push("Attach a proof to the payout entry.");
  if (
    !missing.length &&
    ![...receiptProofs].some((r) => [...payoutProofs].some((p) => p !== r))
  )
    missing.push("The receipt and payout proofs are the same file. Attach each document separately.");
  return { verified: missing.length === 0, missing };
}

/**
 * Splits recorded sales into paid and still to be paid out.
 *
 * When every payout entry says how many units it covers, sale units are
 * matched to payouts in date order: the gap on paid units is fees the
 * marketplace kept, and only sales of unpaid units are pending (basis
 * "units"). When any payout leaves units out, pending is recorded sales minus
 * payouts floored at 0, an upper bound that still includes fees (basis
 * "amount"). With no payout yet, every recorded sale is pending (basis
 * "no payouts"). Returns { pending, fees, basis }.
 */
export function payoutPosition(entries) {
  const sales = entries
    .filter((e) => e.type === "sale")
    .sort((a, b) => (a.occurred === b.occurred ? a.id - b.id : a.occurred < b.occurred ? -1 : 1));
  const payouts = entries.filter((e) => e.type === "payout");
  const salesTotal = sales.reduce((t, e) => t + e.amount, 0);
  const payoutTotal = payouts.reduce((t, e) => t + e.amount, 0);
  if (!payouts.length) return { pending: salesTotal, fees: null, basis: "no payouts" };
  if (payouts.every((e) => Number.isSafeInteger(e.units) && e.units > 0)) {
    let unpaid = payouts.reduce((t, e) => t + e.units, 0);
    let paidAmount = 0;
    let pending = 0;
    for (const sale of sales) {
      const units = Math.max(1, sale.units ?? 1);
      const covered = Math.min(units, unpaid);
      unpaid -= covered;
      const coveredAmount = Math.round((sale.amount * covered) / units);
      paidAmount += coveredAmount;
      pending += sale.amount - coveredAmount;
    }
    const gap = paidAmount - payoutTotal;
    return { pending, fees: sales.length && gap >= 0 ? gap : null, basis: "units" };
  }
  const gap = salesTotal - payoutTotal;
  return { pending: Math.max(0, gap), fees: salesTotal > 0 && gap >= 0 ? gap : null, basis: "amount" };
}

/**
 * Reconciles one trip's records. Pure: pass the trip, its entries and its
 * proof metadata.
 *
 * Resale trips:
 *   realisedContribution = payouts - receipts - expenses - refunds. Only
 *     payouts count as income; sales and predictions do not.
 *   pendingPayout = recorded sales not yet paid out, on open trips only. It
 *     is never realised. See payoutPosition() for how fees are told apart
 *     from money still to come. On a closed trip nothing is pending.
 *   impliedFees = the gap between paid sales and payouts (see payoutPosition).
 *   unsoldUnits = units bought - units sold + units returned, floored at 0.
 *   cashTiedUp = spend not yet recovered by payouts on an open trip.
 * Household trips: saving entries count only as householdSavings, never as
 *   earnings or proceeds; netHouseholdSaving deducts the trip's expenses.
 */
export function reconcile(trip, entries, proofs = []) {
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
  const realisedHourly =
    resale && minutes > 0 ? Math.round((realisedContribution * 60) / minutes) : null;
  const position = resale ? payoutPosition(entries) : { pending: 0, fees: null, basis: null };
  const pendingPayout = open ? position.pending : 0;
  const impliedFees = position.fees;
  const unitsPaidOut = sumOf(entries, "payout", "units");
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

  const discrepancies = [];
  const flag = (code, message) => discrepancies.push({ code, message });
  // Legacy totals have no receipt or sold listing by construction; that is
  // explained by the legacy flag rather than listed as something to fix.
  if (resale && trip.source !== "legacy") {
    if (has("payout") && !has("sale"))
      flag("payout-without-sale", "A payout is recorded without a sold listing.");
    else if (payouts > sales)
      flag(
        "payout-above-sales",
        `Payouts (${pounds(payouts)}) are above recorded sales (${pounds(sales)}). Record every sold listing.`,
      );
    if (has("sale") && !has("receipt"))
      flag("sale-without-receipt", "A sale is recorded without a purchase receipt.");
    if (unitsSold > unitsBought)
      flag("sold-above-bought", `More units sold (${unitsSold}) than bought (${unitsBought}).`);
    if (position.basis === "units" && unitsPaidOut > unitsSold)
      flag("paid-above-sold", `Payouts cover more units (${unitsPaidOut}) than were sold (${unitsSold}).`);
    if (unitsReturned > unitsSold)
      flag("returned-above-sold", `More units returned (${unitsReturned}) than sold (${unitsSold}).`);
    if (payoutSpan !== null && payoutSpan < 0)
      flag("payout-before-receipt", "The last payout is dated before the first purchase receipt.");
  }
  checklist.reconciled = checklist.complete && discrepancies.length === 0;

  const { verified, missing } = verification(trip, entries, proofs);

  let forecast = null;
  if (resale && trip.predicted) {
    const p = trip.predicted;
    const predictedHourly =
      p.activeMinutes > 0 ? Math.round((p.contribution * 60) / p.activeMinutes) : null;
    forecast = {
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
    pendingPayout,
    pendingBasis: open ? position.basis : null,
    impliedFees,
    cashTiedUp,
    householdSavings: resale ? 0 : savings,
    netHouseholdSaving: resale ? null : savings - expenses,
    checklist,
    discrepancies,
    verified,
    verificationMissing: missing,
    forecast,
    timeToPayoutDays,
  };
}

// ---------------------------------------------------------------------------
// Writing

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const absent = (value) => value === undefined || value === null || value === "";

/** Validates the predictions stored with a trip (all integer pence/minutes). */
function predictedInput(value) {
  if (absent(value)) return null;
  if (!isObject(value)) fail("predicted must be an object");
  return {
    units: int(value.units, "predicted.units", 1, MAX_UNITS),
    proceeds: int(value.proceeds, "predicted.proceeds (pence)", 0, MAX_PENCE),
    contribution: int(value.contribution, "predicted.contribution (pence)", -MAX_PENCE, MAX_PENCE),
    cashRequired: int(value.cashRequired, "predicted.cashRequired (pence)", 0, MAX_PENCE),
    activeMinutes: int(value.activeMinutes, "predicted.activeMinutes", 0, 100000),
    payoutBy: isoDate(value.payoutBy, "predicted.payoutBy", { optional: true }),
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
  const predicted = predictedInput(input.predicted);
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
 * Units: required on resale receipts (bought), sales (sold) and refunds
 * (returned); optional on payouts (units the payout covers, which lets the
 * ledger tell fees from payouts still to come) and on household receipts and
 * savings. Not used on expenses or work.
 */
function unitsInput(value, type, kind) {
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
 * must be real calendar dates, not in the future. Returns the new id.
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
  const units = unitsInput(input.units, type, trip.kind);
  const reference = text(input.reference, "reference", 120, { optional: true });
  const occurred = pastDate(input.occurred, "date", now);
  const note = text(input.note, "note", 500, { optional: true });
  const result = db
    .prepare(
      `INSERT INTO ledger_entries (trip_id, type, amount, units, reference, occurred, minutes, note, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(trip.id, type, amount, units, reference, occurred, minutes, note, now.toISOString());
  return Number(result.lastInsertRowid);
}

/**
 * Removes a mistaken entry from an open trip. A proof attached to it stays
 * stored but becomes a whole-trip proof, so it no longer counts towards
 * verification. Closed trips and legacy totals cannot be changed.
 */
export function deleteEntry(db, tripId, entryId) {
  const trip = requireTrip(db, tripId);
  if (trip.legacy) fail("Legacy totals cannot be changed.", 409);
  if (trip.status === "closed") fail("This trip is closed. Entries can only be removed from open trips.", 409);
  const entry = db.prepare("SELECT id FROM ledger_entries WHERE id = ? AND trip_id = ?").get(entryId, trip.id);
  if (!entry) fail("No entry " + entryId + " on this trip", 404);
  transaction(db, () => {
    db.prepare("UPDATE ledger_proofs SET entry_id = NULL WHERE entry_id = ?").run(entryId);
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
  let entryId = null;
  if (!absent(input.entryId)) {
    entryId = int(input.entryId, "entryId", 1, Number.MAX_SAFE_INTEGER);
    const entry = db
      .prepare("SELECT id FROM ledger_entries WHERE id = ? AND trip_id = ?")
      .get(entryId, trip.id);
    if (!entry) fail("entryId must be an entry on this trip");
  }
  return { trip, entryId, label };
}

/**
 * Records proof metadata after the file is stored. The same content attached
 * to the same entry again returns the existing record instead of a copy.
 * Returns { proof, created }.
 */
export function recordProof(db, { tripId, entryId, label, sha256, bytes, mediaType }, { now = new Date() } = {}) {
  const existing = db
    .prepare("SELECT * FROM ledger_proofs WHERE trip_id = ? AND entry_id IS ? AND sha256 = ?")
    .get(tripId, entryId, sha256);
  if (existing) return { proof: proofView(existing), created: false };
  const result = db
    .prepare(
      `INSERT INTO ledger_proofs (trip_id, entry_id, sha256, bytes, media_type, label, created)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(tripId, entryId, sha256, bytes, mediaType, label, now.toISOString());
  const row = db.prepare("SELECT * FROM ledger_proofs WHERE id = ?").get(result.lastInsertRowid);
  return { proof: proofView(row), created: true };
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
 *   householdSavings = saving entries dated in the month. Never earnings.
 *   realisedMinutes = resale work minutes dated in the month;
 *     realisedHourly = realisedEarnings per hour of that time (null without).
 *   payouts / verifiedPayouts / verifiedEarnings = the same cash figures, in
 *     total and for verified trades only (receipt and payout proofs attached).
 * Current position (open resale trips, whatever their dates):
 *   pendingPayouts = recorded sales not yet paid out (may include fees).
 *   potentialProceeds = predicted proceeds on open trips with no payout yet,
 *     less sales already recorded on them (those are under pendingPayouts),
 *     so the two figures never count the same money. An estimate only.
 *   cashTiedUp = spend not yet recovered by payouts.
 *   unsoldUnits = units bought and not yet sold.
 */
export function summary(db, month) {
  monthParam(month);
  const inMonth = (e) => e.occurred.slice(0, 7) === month;
  const totals = {
    realisedEarnings: 0,
    householdSavings: 0,
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
  for (const { trip, entries, proofs } of loadAll(db)) {
    const monthEntries = entries.filter(inMonth);
    if (trip.kind === "household") {
      totals.householdSavings += sumOf(monthEntries, "saving");
      continue;
    }
    const r = reconcile(trip, entries, proofs);
    const payouts = sumOf(monthEntries, "payout");
    const costs =
      sumOf(monthEntries, "receipt") + sumOf(monthEntries, "expense") + sumOf(monthEntries, "refund");
    totals.realisedEarnings += payouts - costs;
    totals.payouts += payouts;
    totals.realisedMinutes += sumOf(monthEntries, "work", "minutes");
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
      if (trip.predicted && r.payouts === 0)
        totals.potentialProceeds += Math.max(0, trip.predicted.proceeds - r.sales);
    }
  }
  return {
    month,
    realisedEarnings: totals.realisedEarnings,
    householdSavings: totals.householdSavings,
    pendingPayouts: totals.pendingPayouts,
    potentialProceeds: totals.potentialProceeds,
    cashTiedUp: totals.cashTiedUp,
    unsoldUnits: totals.unsoldUnits,
    realisedMinutes: totals.realisedMinutes,
    realisedHourly:
      totals.realisedMinutes > 0
        ? Math.round((totals.realisedEarnings * 60) / totals.realisedMinutes)
        : null,
    payouts: totals.payouts,
    verifiedPayouts: totals.verifiedPayouts,
    verifiedEarnings: totals.verifiedEarnings,
    verifiedTrips: totals.verifiedTrips,
    unverifiedTrips: totals.unverifiedTrips,
    openTrips: totals.openTrips,
    basis:
      "Cash basis: payouts dated in the month minus receipts, expenses and refunds dated in the month. " +
      "Pending payouts, potential proceeds, cash tied up and unsold units are the current position of open resale trips.",
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
 *     same for minutes (actual minus predicted), over trips with predictions.
 *   cash: recovery rate = payouts / spend (receipts, expenses and refunds),
 *     with the verified share of payouts.
 *   medianTimeToPayoutDays: first receipt to last payout.
 *   unsoldUnits: units left unsold when the trips were closed.
 *   hourly: realised earnings per hour over trips with work recorded, and a
 *     like-for-like comparison with predicted hourly on trips that have both.
 */
export function metrics(db) {
  const all = loadAll(db);
  const legacyTrips = all.filter(({ trip }) => trip.legacy).length;
  const closed = all
    .filter(({ trip }) => trip.kind === "resale" && trip.status === "closed" && !trip.legacy)
    .map(({ trip, entries, proofs }) => ({ trip, r: reconcile(trip, entries, proofs) }));
  const predicted = closed.filter(({ trip }) => trip.predicted);
  const contributionErrors = predicted.map(({ r }) => r.forecast.contributionError);
  const minutesErrors = predicted
    .map(({ r }) => r.forecast.minutesError)
    .filter((value) => value !== null);
  const spend = closed.reduce((t, { r }) => t + r.spend, 0);
  const payouts = closed.reduce((t, { r }) => t + r.payouts, 0);
  const verified = closed.filter(({ r }) => r.verified);
  const verifiedPayouts = verified.reduce((t, { r }) => t + r.payouts, 0);
  const payoutDays = closed.map(({ r }) => r.timeToPayoutDays).filter((d) => d !== null);
  const worked = closed.filter(({ r }) => r.minutes > 0);
  const hourlyOf = (contribution, minutes) =>
    minutes > 0 ? Math.round((contribution * 60) / minutes) : null;
  const comparable = predicted.filter(({ trip, r }) => r.minutes > 0 && trip.predicted.activeMinutes > 0);
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
        worked.reduce((t, { r }) => t + r.realisedContribution, 0),
        worked.reduce((t, { r }) => t + r.minutes, 0),
      ),
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

