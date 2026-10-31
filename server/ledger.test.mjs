import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryDb, serve } from "./test-support.mjs";
import {
  schema,
  createTrip,
  addEntry,
  closeTrip,
  getTrip,
  listTrips,
  reconcile,
  payoutPosition,
  verification,
  summary,
  metrics,
  migrateLegacyOutcomes,
  recordProof,
  relinkProof,
  proofUses,
  migrateToAutoincrement,
  pastDate,
  londonDate,
} from "./ledger.mjs";
import { londonDate as sharedLondonDate, transaction } from "./http.mjs";
import { storeProof, decodeBase64, deleteProofFile, prepareProof, MAX_PROOF_BYTES } from "./proofs.mjs";
import * as ledgerRoutes from "./routes-ledger.mjs";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const clock = { now: NOW };
const scratch = mkdtempSync(join(tmpdir(), "bounty-ledger-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// The outcomes table exactly as d456f87 created it (git show d456f87:server/db.mjs).
const D456F87_OUTCOMES =
  "CREATE TABLE IF NOT EXISTS outcomes(id INTEGER PRIMARY KEY,sku TEXT, received INTEGER, costs INTEGER, minutes INTEGER, created TEXT DEFAULT CURRENT_TIMESTAMP);";

// --- Proof fixtures -------------------------------------------------------
const segment = (marker, payload) => {
  const body = Buffer.from(payload, "latin1");
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
};
/** A small JPEG carrying Exif GPS coordinates and a comment. */
const jpegWithGps = (pixels = [1, 2, 3]) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, "JFIF\0\x01\x01"),
    segment(0xe1, "Exif\0\0GPSLatitude51.5074GPSLongitude-0.1278"),
    segment(0xfe, "shot at home"),
    segment(0xdb, "\0quant"),
    segment(0xda, "\x01\x01\0"),
    Buffer.from([...pixels, 0xff, 0xd9]),
  ]);
const pngChunk = (type, data) => {
  const body = Buffer.from(data, "latin1");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, Buffer.from(type, "latin1"), body, Buffer.alloc(4)]);
};
const png = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", "\0\0\0\x01\0\0\0\x01\x08\x02\0\0\0"),
    pngChunk("tEXt", "Comment\0GPS 51.5,-0.12"),
    pngChunk("IDAT", "pixels"),
    pngChunk("IEND", ""),
  ]);
const pdf = (body = "payout statement") =>
  Buffer.from("%PDF-1.4\n%" + body + "\n/Author (Jo Bloggs)\n%%EOF\n", "latin1");
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");

// --- Pure helpers -----------------------------------------------------------
const resaleTrip = (overrides = {}) => ({
  id: 1,
  label: "Test",
  source: "manual",
  kind: "resale",
  status: "open",
  predicted: null,
  ...overrides,
});
let nextId = 1;
const entry = (type, amount, occurred, extra = {}) => ({
  id: nextId++,
  type,
  amount,
  occurred,
  units: null,
  minutes: null,
  ...extra,
});

/** A typical part-sold trip: 3 bought, 2 sold, 1 of them paid out. */
function partSold({ payoutUnits = 1 } = {}) {
  return [
    entry("receipt", 3000, "2026-10-01", { units: 3 }),
    entry("expense", 450, "2026-10-01"),
    entry("sale", 2000, "2026-10-05", { units: 1 }),
    entry("payout", 1700, "2026-10-07", { units: payoutUnits }),
    entry("sale", 1800, "2026-10-08", { units: 1 }),
    entry("work", 0, "2026-10-08", { minutes: 120 }),
  ];
}

test("reconcile: realised contribution counts only payouts, never pending sales", () => {
  const r = reconcile(resaleTrip(), partSold());
  assert.equal(r.receipts, 3000);
  assert.equal(r.sales, 3800);
  assert.equal(r.payouts, 1700);
  assert.equal(r.expenses, 450);
  assert.equal(r.spend, 3450);
  assert.equal(r.realisedContribution, 1700 - 3000 - 450);
  assert.equal(r.realisedHourly, Math.round((-1750 * 60) / 120));
  assert.equal(r.unitsBought, 3);
  assert.equal(r.unitsSold, 2);
  assert.equal(r.unsoldUnits, 1);
  assert.equal(r.cashTiedUp, 3450 - 1700);
  assert.equal(r.timeToPayoutDays, 6);
  // Units on the payout separate the fee on the paid sale from the sale
  // still to be paid out.
  assert.equal(r.pendingBasis, "units");
  assert.equal(r.pendingPayout, 1800);
  assert.equal(r.impliedFees, 300);
  // Adding another recorded sale changes pending, not realised.
  const more = reconcile(resaleTrip(), [...partSold(), entry("sale", 1500, "2026-10-09", { units: 1 })]);
  assert.equal(more.realisedContribution, r.realisedContribution);
  assert.equal(more.pendingPayout, 1800 + 1500);
});

test("reconcile: a payout without units covers the sales dated up to it", () => {
  // partSold: sale 20.00 on 5 Oct, payout 17.00 on 7 Oct, sale 18.00 on 8 Oct.
  const r = reconcile(resaleTrip(), partSold({ payoutUnits: null }));
  assert.equal(r.pendingBasis, "dates");
  assert.equal(r.pendingPayout, 1800); // only the sale after the payout
  assert.equal(r.impliedFees, 300); // fees on the sale the payout covered, not on the pending one
  const none = reconcile(resaleTrip(), partSold().filter((e) => e.type !== "payout"));
  assert.equal(none.pendingBasis, "no payouts");
  assert.equal(none.pendingPayout, 3800);
  assert.equal(none.impliedFees, null);
  assert.equal(none.realisedContribution, -3450);
  // A closed trip has nothing pending: the gap is treated as fees.
  const closed = reconcile(resaleTrip({ status: "closed" }), partSold({ payoutUnits: null }));
  assert.equal(closed.pendingPayout, 0);
  assert.equal(closed.pendingBasis, null);
  assert.equal(closed.cashTiedUp, 0);
  assert.deepEqual(
    payoutPosition([entry("sale", 1000, "2026-10-02", { units: 2 }), entry("payout", 400, "2026-10-03", { units: 1 })]),
    { pending: 500, paid: 500, fees: 100, basis: "units" },
  );
});

test("payout position: marketplace fees on a fully paid-out sale are never pending (qa:Q13)", () => {
  // Receipt 24.00 for 2, one sold listing 50.00 for both, payout 43.00 with no units.
  const entries = [
    entry("receipt", 2400, "2026-10-20", { units: 2 }),
    entry("sale", 5000, "2026-10-22", { units: 2 }),
    entry("payout", 4300, "2026-10-26"),
  ];
  assert.deepEqual(payoutPosition(entries), { pending: 0, paid: 5000, fees: 700, basis: "dates" });
  const r = reconcile(resaleTrip(), entries);
  assert.equal(r.pendingPayout, 0);
  assert.equal(r.impliedFees, 700);
  assert.deepEqual(r.discrepancies, []);
  // Same day counts as covered.
  assert.equal(payoutPosition([entry("sale", 5000, "2026-10-22", { units: 1 }), entry("payout", 4300, "2026-10-22")]).pending, 0);
  // Pending and fees never overlap: every sale is either paid or pending.
  for (const list of [entries, partSold(), partSold({ payoutUnits: null })]) {
    const p = payoutPosition(list);
    assert.equal(p.paid + p.pending, list.filter((e) => e.type === "sale").reduce((t, e) => t + e.amount, 0));
    if (p.fees !== null) assert.ok(p.fees <= p.paid);
  }
  // Mixed: a payout with units pays the oldest sale; a later one without
  // units covers the rest up to its date.
  const mixed = payoutPosition([
    entry("sale", 2000, "2026-10-01", { units: 1 }),
    entry("sale", 3000, "2026-10-02", { units: 1 }),
    entry("payout", 1800, "2026-10-03", { units: 1 }),
    entry("sale", 2500, "2026-10-05", { units: 1 }),
    entry("payout", 2700, "2026-10-06"),
    entry("sale", 1000, "2026-10-08", { units: 1 }),
  ]);
  assert.deepEqual(mixed, { pending: 1000, paid: 7500, fees: 7500 - 4500, basis: "dates" });
  // A payout dated before every sale covers none of them.
  const early = payoutPosition([entry("payout", 900, "2026-10-01"), entry("sale", 1000, "2026-10-04", { units: 1 })]);
  assert.equal(early.pending, 1000);
  assert.equal(early.fees, null);
});

test("reconcile: checklist and refunds", () => {
  const r = reconcile(resaleTrip(), partSold());
  assert.equal(r.checklist.receipt, "present");
  assert.equal(r.checklist.soldListing, "present");
  assert.equal(r.checklist.payout, "present");
  assert.equal(r.checklist.expenses, "present");
  assert.equal(r.checklist.returns, "missing");
  assert.equal(r.checklist.work, "present");
  assert.equal(r.checklist.saving, "not applicable");
  assert.equal(r.checklist.complete, true);
  assert.equal(r.checklist.reconciled, true);
  const noWork = reconcile(resaleTrip(), partSold().filter((e) => e.type !== "work"));
  assert.equal(noWork.checklist.work, "missing");
  assert.equal(noWork.checklist.complete, false);
  assert.equal(noWork.realisedHourly, null);
  const refunded = reconcile(resaleTrip(), [...partSold(), entry("refund", 2000, "2026-10-10", { units: 1 })]);
  assert.equal(refunded.checklist.returns, "present");
  assert.equal(refunded.unitsReturned, 1);
  assert.equal(refunded.unsoldUnits, 2);
  assert.equal(refunded.realisedContribution, 1700 - 3000 - 450 - 2000);
});

test("reconcile: discrepancies", () => {
  const codes = (entries) => reconcile(resaleTrip(), entries).discrepancies.map((d) => d.code);
  assert.deepEqual(codes(partSold()), []);
  assert.deepEqual(codes([entry("receipt", 500, "2026-10-01", { units: 1 }), entry("payout", 900, "2026-10-03")]), [
    "payout-without-sale",
  ]);
  assert.ok(
    codes([
      entry("receipt", 500, "2026-10-01", { units: 1 }),
      entry("sale", 900, "2026-10-02", { units: 1 }),
      entry("payout", 1200, "2026-10-03"),
    ]).includes("payout-above-sales"),
  );
  assert.ok(codes([entry("sale", 900, "2026-10-02", { units: 1 })]).includes("sale-without-receipt"));
  assert.ok(
    codes([entry("receipt", 500, "2026-10-01", { units: 1 }), entry("sale", 1800, "2026-10-02", { units: 2 })]).includes(
      "sold-above-bought",
    ),
  );
  assert.ok(
    codes([
      entry("receipt", 500, "2026-10-01", { units: 2 }),
      entry("sale", 900, "2026-10-02", { units: 1 }),
      entry("refund", 900, "2026-10-04", { units: 2 }),
    ]).includes("returned-above-sold"),
  );
  assert.ok(
    codes([
      entry("receipt", 500, "2026-10-05", { units: 1 }),
      entry("sale", 900, "2026-10-02", { units: 1 }),
      entry("payout", 800, "2026-10-03", { units: 1 }),
    ]).includes("payout-before-receipt"),
  );
  assert.ok(
    codes([
      entry("receipt", 500, "2026-10-01", { units: 2 }),
      entry("sale", 900, "2026-10-02", { units: 1 }),
      entry("payout", 800, "2026-10-03", { units: 2 }),
    ]).includes("paid-above-sold"),
  );
  const flagged = reconcile(resaleTrip(), [entry("sale", 900, "2026-10-02", { units: 1 })]);
  assert.equal(flagged.checklist.reconciled, false);
});

test("reconcile: forecast compares realised with predicted", () => {
  const predicted = { units: 3, proceeds: 5400, contribution: 1500, cashRequired: 3450, activeMinutes: 90 };
  const r = reconcile(resaleTrip({ predicted, status: "closed" }), partSold());
  assert.equal(r.forecast.final, true);
  assert.equal(r.forecast.predictedContribution, 1500);
  assert.equal(r.forecast.contributionError, -1750 - 1500);
  assert.equal(r.forecast.predictedMinutes, 90);
  assert.equal(r.forecast.minutesError, 30);
  assert.equal(r.forecast.predictedHourly, 1000);
  assert.equal(r.forecast.cashSpent, 3450);
  assert.equal(reconcile(resaleTrip(), partSold()).forecast, null);
  const late = reconcile(resaleTrip({ predicted: { ...predicted, payoutBy: "2026-10-04" } }), partSold());
  assert.equal(late.forecast.payoutLateDays, 3);
});

test("verification needs a receipt proof and a payout proof, as two different files", () => {
  const entries = partSold();
  const receipt = entries.find((e) => e.type === "receipt");
  const payout = entries.find((e) => e.type === "payout");
  const proof = (entryId, sha256, label = "proof " + sha256) => ({ entry_id: entryId, sha256, label });
  const check = (proofs) => verification(resaleTrip(), entries, proofs);
  assert.equal(check([]).verified, false);
  assert.deepEqual(check([]).missing, [
    "Attach a proof to the purchase receipt (1 Oct 2026, £30.00).",
    "Attach a proof to the payout (7 Oct 2026, £17.00).",
  ]);
  assert.equal(check([proof(receipt.id, "a")]).verified, false);
  assert.equal(check([proof(null, "a"), proof(null, "b")]).verified, false); // trip-level proofs do not count
  const same = check([proof(receipt.id, "a", "Till receipt"), proof(payout.id, "a", "Till receipt")]);
  assert.equal(same.verified, false);
  assert.ok(same.missing.some((m) => /"Till receipt" is attached to more than one/.test(m)));
  assert.deepEqual(same.proofedEntries, []);
  const ok = check([proof(receipt.id, "a"), proof(payout.id, "b")]);
  assert.equal(ok.verified, true);
  assert.deepEqual(ok.proofedEntries, [receipt.id, payout.id].sort((x, y) => x - y));
  const noPayout = verification(resaleTrip(), entries.filter((e) => e.type !== "payout"), []);
  assert.ok(noPayout.missing.includes("Record the payout."));
  assert.equal(verification(resaleTrip({ kind: "household" }), entries, []).verified, false);
  assert.equal(verification(resaleTrip({ source: "legacy" }), entries, []).verified, false);
  const r = reconcile(resaleTrip(), entries, [proof(receipt.id, "a"), proof(payout.id, "b")]);
  assert.equal(r.verified, true);
  assert.deepEqual(r.verificationMissing, []);
});

test("verification: every payout needs its own proof, and only verified payouts count as verified cash (M1)", () => {
  const db = memoryDb(schema);
  const t = createTrip(db, { label: "Jumpers", source: "manual", kind: "resale" }, clock);
  const receipt = addEntry(db, t, { type: "receipt", amount: 3000, units: 3, occurred: "2026-10-05" }, clock);
  addEntry(db, t, { type: "sale", amount: 2600, units: 1, occurred: "2026-10-10" }, clock);
  const p1 = addEntry(db, t, { type: "payout", amount: 2200, occurred: "2026-10-12" }, clock);
  const p2 = addEntry(db, t, { type: "payout", amount: 30000, occurred: "2026-10-20", note: "typed, no proof" }, clock);
  const attach = (entryId, hash, label) =>
    recordProof(db, { tripId: t, entryId, label, sha256: hash.repeat(64), bytes: 10, mediaType: "image/png" }, clock);
  attach(receipt, "a", "receipt");
  attach(p1, "b", "payout A");
  let r = getTrip(db, t).reconciliation;
  assert.equal(r.verified, false);
  assert.ok(r.verificationMissing.includes("Attach a proof to the payout (20 Oct 2026, £300.00)."));
  assert.ok(r.verificationMissing.some((m) => /Payouts \(£322.00\) are above recorded sales/.test(m)));
  let s = summary(db, "2026-10");
  assert.equal(s.payouts, 32200);
  assert.equal(s.verifiedPayouts, 0);
  assert.equal(s.verifiedEarnings, 0);
  assert.equal(s.verifiedTrips, 0);
  // Attaching the same file to the second payout is refused.
  assert.throws(
    () => attach(p2, "b", "payout A"),
    (e) =>
      e.status === 409 &&
      e.message ===
        "This file is already the proof for this trip's payout (12 Oct 2026, £22.00): attach the document for this purchase or payout",
  );
  // A duplicate stored before that rule counts for neither payout.
  db.prepare(
    "INSERT INTO ledger_proofs (trip_id, entry_id, sha256, bytes, media_type, label, created) VALUES (?, ?, ?, 10, 'image/png', 'payout A', ?)",
  ).run(t, p2, "b".repeat(64), NOW.toISOString());
  r = getTrip(db, t).reconciliation;
  assert.equal(r.verified, false);
  assert.ok(r.verificationMissing.includes("Attach a proof to the payout (12 Oct 2026, £22.00)."));
  assert.ok(r.verificationMissing.some((m) => /"payout A" is attached to more than one/.test(m)));
  assert.deepEqual(r.proofedEntries, [receipt]);
  assert.equal(listTrips(db)[0].verified, false);
  assert.ok(listTrips(db)[0].verificationMissing.length > 0);
});

test("verification: records must reconcile, with a sale and no payout before the purchase (M2, P18)", () => {
  const db = memoryDb(schema);
  const attach = (tripId, entryId, hash) =>
    recordProof(db, { tripId, entryId, label: hash, sha256: hash.repeat(64), bytes: 10, mediaType: "image/png" }, clock);
  // M2: receipt on 20 Oct, payout dated 2 Oct, no sale, both proofed, closed.
  const mugs = createTrip(db, { label: "Mugs", source: "manual", kind: "resale" }, clock);
  attach(mugs, addEntry(db, mugs, { type: "receipt", amount: 1000, units: 2, occurred: "2026-10-20" }, clock), "c");
  attach(mugs, addEntry(db, mugs, { type: "payout", amount: 9000, occurred: "2026-10-02" }, clock), "d");
  closeTrip(db, mugs, clock);
  const r = getTrip(db, mugs).reconciliation;
  assert.equal(r.verified, false);
  assert.deepEqual(r.discrepancies.map((d) => d.code), ["payout-without-sale", "payout-before-receipt"]);
  assert.ok(r.verificationMissing.includes("Record the sold listing the payout is for."));
  assert.ok(r.verificationMissing.includes("Records do not reconcile: A payout is dated before the first purchase receipt."));
  const m = metrics(db);
  assert.equal(m.verifiedTrips, 0);
  assert.equal(m.cash.verifiedPayouts, 0);
  assert.equal(summary(db, "2026-10").verifiedEarnings, 0);

  // P18: receipt 10.00 and payout 500.00 with separate proofs, no sale.
  const big = createTrip(db, { label: "Big payout", source: "manual", kind: "resale" }, clock);
  attach(big, addEntry(db, big, { type: "receipt", amount: 1000, units: 1, occurred: "2026-10-01" }, clock), "e");
  attach(big, addEntry(db, big, { type: "payout", amount: 50000, occurred: "2026-10-05" }, clock), "f");
  assert.equal(getTrip(db, big).reconciliation.verified, false);
  assert.equal(summary(db, "2026-10").verifiedEarnings, 0);

  // Only one payout before the receipt is enough to flag it, even when a
  // later payout comes after the receipt.
  const split = [
    entry("sale", 900, "2026-10-04", { units: 1 }),
    entry("payout", 400, "2026-10-01", { units: 1 }),
    entry("receipt", 500, "2026-10-03", { units: 2 }),
    entry("sale", 900, "2026-10-04", { units: 1 }),
    entry("payout", 800, "2026-10-09", { units: 1 }),
  ];
  const codes = reconcile(resaleTrip(), split).discrepancies.map((d) => d.code);
  assert.ok(codes.includes("payout-before-receipt"));
  assert.ok(codes.includes("payout-before-sale"));

  // A fully reconciled, fully proofed trade is verified, and its payouts count.
  const good = createTrip(db, { label: "Good", source: "manual", kind: "resale" }, clock);
  attach(good, addEntry(db, good, { type: "receipt", amount: 1000, units: 1, occurred: "2026-10-01" }, clock), "g");
  addEntry(db, good, { type: "sale", amount: 2000, units: 1, occurred: "2026-10-02" }, clock);
  attach(good, addEntry(db, good, { type: "payout", amount: 1700, occurred: "2026-10-05" }, clock), "h");
  assert.equal(getTrip(db, good).reconciliation.verified, true);
  const s = summary(db, "2026-10");
  assert.equal(s.verifiedPayouts, 1700);
  assert.equal(s.verifiedEarnings, 700);
  assert.equal(s.verifiedTrips, 1);
  assert.equal(s.unverifiedTrips, 2);
});

test("one file proves one receipt or payout in the whole ledger: reuse on another trip is refused (R2M2, R2B6)", () => {
  const db = memoryDb(schema);
  const attach = (tripId, entryId, hash, label) =>
    recordProof(db, { tripId, entryId, label, sha256: hash.repeat(64), bytes: 10, mediaType: "image/png" }, clock);
  // The money reviewer's case: trip B is a copy of trip A with the same two files.
  const trips = [];
  for (const label of ["Jumpers trip A", "Jumpers trip B"]) {
    const t = createTrip(db, { label, source: "manual", kind: "resale" }, clock);
    const receipt = addEntry(db, t, { type: "receipt", amount: 3000, units: 3, occurred: "2026-10-05" }, clock);
    addEntry(db, t, { type: "sale", amount: 7800, units: 3, occurred: "2026-10-10" }, clock);
    const payout = addEntry(db, t, { type: "payout", amount: 6600, occurred: "2026-10-12" }, clock);
    trips.push({ t, receipt, payout });
  }
  const [a, b] = trips;
  attach(a.t, a.receipt, "a", "receipt.png");
  attach(a.t, a.payout, "b", "payout.png");
  const refused = (fn, text) =>
    assert.throws(fn, (e) => e.status === 409 && e.message === text, text);
  refused(
    () => attach(b.t, b.receipt, "a", "receipt.png"),
    "This file is already the proof for Jumpers trip A (purchase receipt, 5 Oct 2026, £30.00): attach the document for this purchase or payout",
  );
  refused(
    () => attach(b.t, b.payout, "b", "payout.png"),
    "This file is already the proof for Jumpers trip A (payout, 12 Oct 2026, £66.00): attach the document for this purchase or payout",
  );
  // Nor on any other entry of that trip, such as the sale.
  const sale = getTrip(db, b.t).entries.find((e) => e.type === "sale").id;
  assert.throws(() => attach(b.t, sale, "a", "receipt.png"), (e) => e.status === 409);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_proofs WHERE trip_id = ?").get(b.t).n, 0);
  // Kept as a whole-trip proof it is stored, but never counts.
  assert.equal(attach(b.t, null, "a", "receipt.png").created, true);
  assert.equal(getTrip(db, a.t).reconciliation.verified, true);
  assert.equal(getTrip(db, b.t).reconciliation.verified, false);
  let s = summary(db, "2026-10");
  assert.equal(s.verifiedTrips, 1);
  assert.equal(s.verifiedPayouts, 6600);
  assert.equal(s.verifiedEarnings, 3600);
  // B's own documents verify it.
  attach(b.t, b.receipt, "c", "receipt B.png");
  attach(b.t, b.payout, "d", "payout B.png");
  s = summary(db, "2026-10");
  assert.equal(s.verifiedTrips, 2);
  assert.equal(s.verifiedPayouts, 13200);

  // The same file again on the same entry is not a reuse: the record comes back.
  assert.equal(attach(a.t, a.receipt, "a", "receipt.png").created, false);
});

test("duplicates stored before the rule leave every entry using the file unverified, with a reason (R2M2, R2B6)", () => {
  const db = memoryDb(schema);
  const sneak = (tripId, entryId, hash, label) =>
    db
      .prepare(
        "INSERT INTO ledger_proofs (trip_id, entry_id, sha256, bytes, media_type, label, created) VALUES (?, ?, ?, 10, 'image/png', ?, ?)",
      )
      .run(tripId, entryId, hash.repeat(64), label, NOW.toISOString());
  // The bugs reviewer's case: one till receipt on two trips, each with its own payout proof.
  const ids = [];
  for (const [label, payoutFile] of [["Trip 1", "p"], ["Trip 2", "q"]]) {
    const t = createTrip(db, { label, source: "manual", kind: "resale" }, clock);
    const receipt = addEntry(db, t, { type: "receipt", amount: 1000, units: 1, occurred: "2026-10-26" }, clock);
    addEntry(db, t, { type: "sale", amount: 2500, units: 1, occurred: "2026-10-28" }, clock);
    const payout = addEntry(db, t, { type: "payout", amount: 2100, units: 1, occurred: "2026-10-30" }, clock);
    sneak(t, receipt, "r", "receipt.png");
    sneak(t, payout, payoutFile, "payout " + label);
    ids.push(t);
  }
  const [one, two] = ids.map((t) => getTrip(db, t).reconciliation);
  for (const r of [one, two]) {
    assert.equal(r.verified, false);
    assert.ok(r.verificationMissing.includes("Attach a proof to the purchase receipt (26 Oct 2026, £10.00)."));
  }
  assert.ok(
    one.verificationMissing.includes(
      'The file "receipt.png" is attached to more than one receipt or payout entry, so it counts for none of them: ' +
        'it is also on the purchase receipt (26 Oct 2026, £10.00) on "Trip 2". One document proves one purchase or ' +
        "one payout: keep it on the entry it records and attach the right document to the other.",
    ),
    one.verificationMissing.join("\n"),
  );
  assert.ok(two.verificationMissing.some((m) => /it is also on the purchase receipt \(26 Oct 2026, £10\.00\) on "Trip 1"/.test(m)));
  // Each payout proof is still its own: only the receipt is not counted.
  assert.equal(one.proofedEntries.length, 1);
  const listed = listTrips(db);
  assert.ok(listed.every((t) => t.verified === false));
  const s = summary(db, "2026-10");
  assert.equal(s.verifiedTrips, 0);
  assert.equal(s.verifiedPayouts, 0);
  assert.equal(s.verifiedEarnings, 0);
  for (const t of ids) closeTrip(db, t, clock);
  const m = metrics(db);
  assert.equal(m.verifiedTrips, 0);
  assert.equal(m.cash.verifiedPayouts, 0);
  // A pure call without the ledger-wide uses still sees only the trip itself.
  const detail = getTrip(db, ids[0]);
  assert.equal(verification(detail.trip, detail.entries, detail.proofs).verified, true);
  assert.equal(verification(detail.trip, detail.entries, detail.proofs, proofUses(db)).verified, false);
  // Removing the copy from trip 2 lets trip 1 count its receipt again.
  db.prepare("DELETE FROM ledger_proofs WHERE trip_id = ? AND sha256 = ?").run(ids[1], "r".repeat(64));
  assert.equal(getTrip(db, ids[0]).reconciliation.verified, true);
  assert.equal(getTrip(db, ids[1]).reconciliation.verified, false);
});

test("a proof cannot be moved onto an entry while its file proves another one (R2M2)", () => {
  const db = memoryDb(schema);
  const a = createTrip(db, { label: "Lamps", source: "manual", kind: "resale" }, clock);
  const b = createTrip(db, { label: "Mugs", source: "manual", kind: "resale" }, clock);
  const ra = addEntry(db, a, { type: "receipt", amount: 1200, units: 1, occurred: "2026-10-03" }, clock);
  const rb = addEntry(db, b, { type: "receipt", amount: 800, units: 2, occurred: "2026-10-04" }, clock);
  const pb = addEntry(db, b, { type: "payout", amount: 900, occurred: "2026-10-09" }, clock);
  const record = (tripId, entryId, hash) =>
    recordProof(db, { tripId, entryId, label: hash, sha256: hash.repeat(64), bytes: 10, mediaType: "image/png" }, clock).proof;
  record(a, ra, "e");
  const loose = record(b, null, "e"); // whole trip: allowed
  assert.throws(() => relinkProof(db, b, loose.id, { entryId: rb }), (e) => e.status === 409 && /already the proof for Lamps \(purchase receipt/.test(e.message));
  assert.equal(getTrip(db, b).proofs[0].entry_id, null);
  // Within one trip as well.
  const own = record(b, rb, "f");
  const copy = record(b, null, "f");
  assert.throws(
    () => relinkProof(db, b, copy.id, { entryId: pb }),
    (e) => e.status === 409 && /^This file is already the proof for this trip's purchase receipt \(4 Oct 2026, £8\.00\)/.test(e.message),
  );
  // Moving the file's only receipt or payout use is fine, and the copy then
  // merges with it rather than being refused.
  assert.equal(relinkProof(db, b, own.id, { entryId: pb }).proofs.find((p) => p.id === own.id).entry_id, pb);
  const merged = relinkProof(db, b, copy.id, { entryId: pb });
  assert.deepEqual(merged.proofs.filter((p) => p.sha256 === "f".repeat(64)).map((p) => p.id), [own.id]);
});

test("household savings never count as earnings or proceeds", () => {
  const trip = resaleTrip({ kind: "household" });
  const r = reconcile(trip, [
    entry("receipt", 2400, "2026-10-03", { units: 4 }),
    entry("saving", 900, "2026-10-03", { units: 4 }),
    entry("expense", 300, "2026-10-03"),
  ]);
  assert.equal(r.householdSavings, 900);
  assert.equal(r.netHouseholdSaving, 600);
  assert.equal(r.realisedContribution, null);
  assert.equal(r.pendingPayout, 0);
  assert.equal(r.unsoldUnits, null);
  assert.equal(r.checklist.complete, true);
  assert.equal(r.checklist.payout, "not applicable");

  const db = memoryDb(schema);
  const id = createTrip(db, { label: "Weekly shop", source: "manual", kind: "household" }, clock);
  addEntry(db, id, { type: "receipt", amount: 2400, units: 4, occurred: "2026-10-03" }, clock);
  addEntry(db, id, { type: "saving", amount: 900, occurred: "2026-10-03" }, clock);
  assert.throws(() => addEntry(db, id, { type: "payout", amount: 900, occurred: "2026-10-03" }, clock), /cannot take payout/);
  assert.throws(() => addEntry(db, id, { type: "sale", amount: 900, units: 1, occurred: "2026-10-03" }, clock), /cannot take sale/);
  const s = summary(db, "2026-10");
  assert.equal(s.householdSavings, 900);
  assert.equal(s.realisedEarnings, 0);
  assert.equal(s.potentialProceeds, 0);
  assert.equal(s.pendingPayouts, 0);
  assert.equal(s.cashTiedUp, 0);
  // A resale trip cannot record savings.
  const resale = createTrip(db, { label: "Resale", source: "manual", kind: "resale" }, clock);
  assert.throws(() => addEntry(db, resale, { type: "saving", amount: 100, occurred: "2026-10-03" }, clock), /cannot take saving/);
});

test("summary: cash basis by month and separate figures", () => {
  const db = memoryDb(schema);
  // Trip A: bought in September, paid out in October, closed.
  const a = createTrip(db, { label: "A", source: "manual", kind: "resale" }, clock);
  addEntry(db, a, { type: "receipt", amount: 2000, units: 2, occurred: "2026-09-28" }, clock);
  addEntry(db, a, { type: "sale", amount: 3000, units: 2, occurred: "2026-10-02" }, clock);
  addEntry(db, a, { type: "payout", amount: 2600, units: 2, occurred: "2026-10-04" }, clock);
  addEntry(db, a, { type: "expense", amount: 200, occurred: "2026-10-02" }, clock);
  addEntry(db, a, { type: "work", minutes: 60, occurred: "2026-10-02" }, clock);
  closeTrip(db, a, clock);
  // Trip B: open, part sold, not yet paid out, with a live-evidence prediction.
  const b = createTrip(
    db,
    {
      label: "B",
      source: "research",
      kind: "resale",
      predicted: { units: 3, proceeds: 4500, contribution: 1200, cashRequired: 3000, activeMinutes: 120, sample: false },
    },
    clock,
  );
  addEntry(db, b, { type: "receipt", amount: 3000, units: 3, occurred: "2026-10-20" }, clock);
  addEntry(db, b, { type: "sale", amount: 1500, units: 1, occurred: "2026-10-25" }, clock);
  // Trip C: open, paid out once, so its prediction no longer counts as potential.
  const c = createTrip(
    db,
    { label: "C", source: "research", kind: "resale", predicted: { units: 1, proceeds: 2000, contribution: 500, cashRequired: 1200, activeMinutes: 60, sample: false } },
    clock,
  );
  addEntry(db, c, { type: "receipt", amount: 1200, units: 1, occurred: "2026-10-10" }, clock);
  addEntry(db, c, { type: "sale", amount: 2000, units: 1, occurred: "2026-10-12" }, clock);
  addEntry(db, c, { type: "payout", amount: 1700, occurred: "2026-10-14" }, clock);
  // A closed trip with a prediction and no payout never counts as potential.
  const d = createTrip(
    db,
    { label: "D", source: "planner", kind: "resale", predicted: { units: 1, proceeds: 9000, contribution: 100, cashRequired: 100, activeMinutes: 10 } },
    clock,
  );
  closeTrip(db, d, clock);

  const sept = summary(db, "2026-09");
  assert.equal(sept.realisedEarnings, -2000);
  assert.equal(sept.realisedMinutes, 0);
  assert.equal(sept.realisedHourly, null);

  const oct = summary(db, "2026-10");
  assert.equal(oct.month, "2026-10");
  // Payouts 2600 + 1700, less receipts 3000 + 1200 and the 200 expense in October.
  assert.equal(oct.realisedEarnings, 2600 + 1700 - 3000 - 1200 - 200);
  assert.equal(oct.payouts, 4300);
  assert.equal(oct.realisedMinutes, 60);
  // Only trip A logged work time in October: its October money (payout 26.00
  // less the 2.00 expense) over its hour. B (-30.00) and C (+5.00) have no
  // work time, so they are left out rather than divided by A's hour.
  assert.equal(oct.realisedHourly, 2400);
  assert.deepEqual(oct.hourly, { trips: 1, minutes: 60, earnings: 2400, leftOutTrips: 2, leftOutEarnings: -3000 + 500 });
  // Current position of open trips only.
  // B's unpaid sale. C's payout has no units, so it covers C's earlier sale
  // and the 3.00 gap is fees, not money still to come.
  assert.equal(oct.pendingPayouts, 1500);
  assert.equal(oct.potentialProceeds, 4500 - 1500); // B only, less its recorded sale
  assert.equal(oct.cashTiedUp, 3000 + 0); // C recovered more than spent
  assert.equal(oct.unsoldUnits, 2);
  assert.equal(oct.householdSavings, 0);
  assert.deepEqual(oct.potentialProceedsLeftOut, { sample: 0, basisUnknown: 0, nothingBought: 0 });
  assert.equal(oct.verifiedPayouts, 0);
  assert.equal(oct.verifiedEarnings, 0);
  assert.equal(oct.unverifiedTrips, 3);
  assert.match(oct.basis, /Cash basis/);
  for (const key of [
    "realisedEarnings",
    "householdSavings",
    "pendingPayouts",
    "potentialProceeds",
    "cashTiedUp",
    "unsoldUnits",
    "realisedMinutes",
    "realisedHourly",
  ])
    assert.ok(key in oct, key);
  assert.throws(() => summary(db, "2026-13"), /month/);
});

test("summary reports how much realised cash is verified", () => {
  const db = memoryDb(schema);
  const dir = join(scratch, "summary-proofs");
  const a = createTrip(db, { label: "Verified", source: "manual", kind: "resale" }, clock);
  const receipt = addEntry(db, a, { type: "receipt", amount: 1000, units: 1, occurred: "2026-10-01" }, clock);
  addEntry(db, a, { type: "sale", amount: 2000, units: 1, occurred: "2026-10-02" }, clock);
  const payout = addEntry(db, a, { type: "payout", amount: 1800, units: 1, occurred: "2026-10-03" }, clock);
  for (const [entryId, file, type] of [
    [receipt, jpegWithGps(), "image/jpeg"],
    [payout, pdf(), "application/pdf"],
  ]) {
    const stored = storeProof(dir, file, type);
    recordProof(db, { tripId: a, entryId, label: "proof", sha256: stored.sha256, bytes: stored.bytes, mediaType: type }, clock);
  }
  const b = createTrip(db, { label: "Unverified", source: "manual", kind: "resale" }, clock);
  addEntry(db, b, { type: "receipt", amount: 500, units: 1, occurred: "2026-10-05" }, clock);
  addEntry(db, b, { type: "sale", amount: 900, units: 1, occurred: "2026-10-06" }, clock);
  addEntry(db, b, { type: "payout", amount: 800, units: 1, occurred: "2026-10-07" }, clock);
  const s = summary(db, "2026-10");
  assert.equal(s.payouts, 2600);
  assert.equal(s.verifiedPayouts, 1800);
  assert.equal(s.verifiedEarnings, 800);
  assert.equal(s.realisedEarnings, 800 + 300);
  assert.equal(s.verifiedTrips, 1);
  assert.equal(s.unverifiedTrips, 1);
  assert.equal(listTrips(db).find((trip) => trip.id === a).verified, true);
});

test("metrics: forecast error, cash recovery, time to payout, unsold and hourly", () => {
  const db = memoryDb(schema);
  const predicted = (contribution, activeMinutes) => ({
    units: 2,
    proceeds: 4000,
    contribution,
    cashRequired: 2000,
    activeMinutes,
    sample: false,
  });
  // Trip 1: receipts 2000, payout 3000, realised +1000; predicted 1500; 60 minutes against 90 predicted.
  const one = createTrip(db, { label: "1", source: "bounty", kind: "resale", predicted: predicted(1500, 90) }, clock);
  addEntry(db, one, { type: "receipt", amount: 2000, units: 2, occurred: "2026-10-01" }, clock);
  addEntry(db, one, { type: "sale", amount: 3400, units: 2, occurred: "2026-10-03" }, clock);
  addEntry(db, one, { type: "payout", amount: 3000, units: 2, occurred: "2026-10-05" }, clock);
  addEntry(db, one, { type: "work", minutes: 60, occurred: "2026-10-05" }, clock);
  closeTrip(db, one, clock);
  // Trip 2: receipts 2000, payout 1500, realised -500; predicted 500; one unit unsold; 120 minutes against 60.
  const two = createTrip(db, { label: "2", source: "research", kind: "resale", predicted: predicted(500, 60) }, clock);
  addEntry(db, two, { type: "receipt", amount: 2000, units: 2, occurred: "2026-10-01" }, clock);
  addEntry(db, two, { type: "sale", amount: 1700, units: 1, occurred: "2026-10-04" }, clock);
  addEntry(db, two, { type: "payout", amount: 1500, units: 1, occurred: "2026-10-11" }, clock);
  addEntry(db, two, { type: "work", minutes: 120, occurred: "2026-10-11" }, clock);
  closeTrip(db, two, clock);
  // Open trips and legacy totals are excluded.
  const open = createTrip(db, { label: "open", source: "manual", kind: "resale", predicted: predicted(9999, 1) }, clock);
  addEntry(db, open, { type: "receipt", amount: 100, units: 1, occurred: "2026-10-01" }, clock);

  const m = metrics(db);
  assert.equal(m.closedTrips, 2);
  assert.equal(m.forecast.trips, 2);
  // Errors: trip 1 1000 - 1500 = -500; trip 2 -500 - 500 = -1000.
  assert.equal(m.forecast.meanContributionError, -750);
  assert.equal(m.forecast.meanAbsoluteContributionError, 750);
  // Minutes: -30 and +60.
  assert.equal(m.forecast.meanMinutesError, 15);
  assert.equal(m.forecast.meanAbsoluteMinutesError, 45);
  assert.equal(m.cash.spend, 4000);
  assert.equal(m.cash.payouts, 4500);
  assert.equal(m.cash.recoveryRate, 4500 / 4000);
  assert.equal(m.cash.verifiedPayouts, 0);
  assert.equal(m.verifiedTrips, 0);
  // Time to payout: 4 and 10 days.
  assert.equal(m.medianTimeToPayoutDays, 7);
  assert.equal(m.unsoldUnits, 1);
  // Realised 500 over 180 minutes; predicted 2000 over 150 minutes.
  assert.equal(m.hourly.realised, Math.round((500 * 60) / 180));
  assert.equal(m.hourly.comparison.trips, 2);
  assert.equal(m.hourly.comparison.realised, Math.round((500 * 60) / 180));
  assert.equal(m.hourly.comparison.predicted, Math.round((2000 * 60) / 150));
  assert.deepEqual(m.forecast.leftOut, { sample: 0, basisUnknown: 0, notTaken: 0 });
});

test("sample and untaken trips never count in potential proceeds or forecast measures (M13, P21, qa:Q5)", () => {
  const db = memoryDb(schema);
  const prediction = (extra = {}) => ({ units: 4, proceeds: 10000, contribution: 2700, cashRequired: 5340, activeMinutes: 106, ...extra });
  // The Planner's sample jacket, tracked and nothing bought.
  const jacket = createTrip(db, { label: "Jacket (sample)", source: "planner", kind: "resale", predicted: prediction() }, clock);
  // A Planner trip is sample even if the client says otherwise.
  const insisted = createTrip(db, { label: "Planner", source: "planner", kind: "resale", predicted: prediction({ sample: false }) }, clock);
  // Research on sample data, flagged by the client.
  const researchSample = createTrip(db, { label: "Research sample", source: "research", kind: "resale", predicted: prediction({ sample: true }) }, clock);
  // Research that did not say what its evidence was.
  const unknown = createTrip(db, { label: "Old research", source: "research", kind: "resale", predicted: prediction() }, clock);
  // Live research, not bought yet.
  const notBought = createTrip(db, { label: "Live, not bought", source: "research", kind: "resale", predicted: prediction({ sample: false }) }, clock);
  for (const id of [jacket, insisted, researchSample, unknown]) addEntry(db, id, { type: "receipt", amount: 1000, units: 1, occurred: "2026-10-02" }, clock);
  const listed = new Map(listTrips(db).map((t) => [t.id, t]));
  assert.equal(listed.get(jacket).sample, true);
  assert.equal(listed.get(jacket).predictionBasis, "sample");
  assert.equal(listed.get(insisted).predicted.sample, true);
  assert.equal(listed.get(researchSample).sample, true);
  assert.equal(listed.get(unknown).predictionBasis, "unknown");
  assert.equal(listed.get(unknown).sample, false);
  assert.equal(listed.get(notBought).predictionBasis, "live");
  assert.equal(getTrip(db, jacket).reconciliation.forecast.basis, "sample");
  assert.equal(getTrip(db, jacket).reconciliation.forecast.counted, false);

  let s = summary(db, "2026-10");
  assert.equal(s.potentialProceeds, 0);
  assert.deepEqual(s.potentialProceedsLeftOut, { sample: 3, basisUnknown: 1, nothingBought: 1 });
  // Once bought, a live prediction counts, scaled to the units actually bought.
  addEntry(db, notBought, { type: "receipt", amount: 1000, units: 1, occurred: "2026-10-03" }, clock);
  s = summary(db, "2026-10");
  assert.equal(s.potentialProceeds, 10000 / 4);
  assert.equal(s.potentialProceedsLeftOut.nothingBought, 0);
  addEntry(db, notBought, { type: "receipt", amount: 3000, units: 5, occurred: "2026-10-03" }, clock);
  assert.equal(summary(db, "2026-10").potentialProceeds, 10000); // never above the prediction

  // Closed trips: only live, taken trips are measured.
  const finish = (id) => {
    addEntry(db, id, { type: "sale", amount: 6000, units: 1, occurred: "2026-10-05" }, clock);
    addEntry(db, id, { type: "payout", amount: 5000, units: 1, occurred: "2026-10-07" }, clock);
    addEntry(db, id, { type: "work", minutes: 120, occurred: "2026-10-07" }, clock);
    closeTrip(db, id, clock);
  };
  finish(jacket);
  finish(unknown);
  finish(notBought);
  const neverTaken = createTrip(db, { label: "Never went", source: "research", kind: "resale", predicted: prediction({ sample: false }) }, clock);
  closeTrip(db, neverTaken, clock);
  const m = metrics(db);
  assert.equal(m.closedTrips, 4);
  assert.equal(m.forecast.trips, 1);
  assert.deepEqual(m.forecast.leftOut, { sample: 1, basisUnknown: 1, notTaken: 1 });
  // notBought: receipts 4000, payout 5000, realised +1000 against 2700.
  assert.equal(m.forecast.meanContributionError, 1000 - 2700);
  assert.equal(m.hourly.comparison.trips, 1);
  assert.equal(m.hourly.comparison.predicted, Math.round((2700 * 60) / 106));
  // Realised measures still use every closed trip's real records.
  assert.equal(m.hourly.trips, 3);
  assert.equal(m.cash.payouts, 15000);
  // Bad flag values are refused.
  assert.throws(
    () => createTrip(db, { label: "x", source: "research", kind: "resale", predicted: prediction({ sample: "yes" }) }, clock),
    /predicted.sample/,
  );
});

test("potential proceeds stop at the first payout and predicted units must be at least 1", () => {
  const db = memoryDb(schema);
  const t = createTrip(
    db,
    { label: "Live", source: "research", kind: "resale", predicted: { units: 2, proceeds: 6000, contribution: 1500, cashRequired: 2000, activeMinutes: 60, sample: false } },
    clock,
  );
  addEntry(db, t, { type: "receipt", amount: 2000, units: 2, occurred: "2026-10-01" }, clock);
  addEntry(db, t, { type: "sale", amount: 2500, units: 1, occurred: "2026-10-03" }, clock);
  assert.equal(summary(db, "2026-10").potentialProceeds, 6000 - 2500);
  addEntry(db, t, { type: "payout", amount: 2100, units: 1, occurred: "2026-10-05" }, clock);
  // Proceeds still exceed sales, but a payout means the actual figures take over.
  assert.equal(summary(db, "2026-10").potentialProceeds, 0);
  assert.throws(
    () => createTrip(db, { label: "x", source: "research", kind: "resale", predicted: { units: 0, proceeds: 100, contribution: 10, cashRequired: 50, activeMinutes: 5 } }, clock),
    /predicted.units/,
  );
});

test("month hourly divides only the money of trips with work time by that time (R2Q1)", () => {
  const db = memoryDb(schema);
  const trip = (label, source = "manual") => createTrip(db, { label, source, kind: "resale" }, clock);
  // 2 h of work and +40.00 realised.
  const worked = trip("Worked");
  addEntry(db, worked, { type: "receipt", amount: 2000, units: 2, occurred: "2026-10-02" }, clock);
  addEntry(db, worked, { type: "sale", amount: 7000, units: 2, occurred: "2026-10-04" }, clock);
  addEntry(db, worked, { type: "payout", amount: 6000, occurred: "2026-10-08" }, clock);
  addEntry(db, worked, { type: "work", minutes: 120, occurred: "2026-10-08" }, clock);
  let s = summary(db, "2026-10");
  assert.equal(s.realisedHourly, 2000);
  // A manual trip at +19.00 and a research trip at -12.00, neither with work time.
  const manual = trip("Manual");
  addEntry(db, manual, { type: "receipt", amount: 1000, units: 1, occurred: "2026-10-10" }, clock);
  addEntry(db, manual, { type: "sale", amount: 3500, units: 1, occurred: "2026-10-12" }, clock);
  addEntry(db, manual, { type: "payout", amount: 2900, occurred: "2026-10-14" }, clock);
  const research = trip("Research", "research");
  addEntry(db, research, { type: "receipt", amount: 1200, units: 1, occurred: "2026-10-20" }, clock);
  s = summary(db, "2026-10");
  assert.equal(s.realisedEarnings, 4000 + 1900 - 1200);
  assert.equal(s.realisedHourly, 2000, "never 47.00 over 2 h");
  assert.deepEqual(s.hourly, { trips: 1, minutes: 120, earnings: 4000, leftOutTrips: 2, leftOutEarnings: 700 });
  assert.match(s.basis, /trips without work time is left out|trips without work time are left out|money from trips without work time is left out/);
  // The month figure agrees with the measures once the trips are closed.
  for (const t of [worked, manual, research]) closeTrip(db, t, clock);
  assert.equal(metrics(db).hourly.realised, 2000);
  assert.equal(metrics(db).hourly.trips, 1);
  // Time on a trip with no cash yet still counts as time spent this month.
  const listing = trip("Listing only");
  addEntry(db, listing, { type: "work", minutes: 120, occurred: "2026-10-25" }, clock);
  s = summary(db, "2026-10");
  assert.equal(s.realisedHourly, 1000);
  assert.deepEqual(s.hourly, { trips: 2, minutes: 240, earnings: 4000, leftOutTrips: 2, leftOutEarnings: 700 });

  // Not known when no trip with money has work time.
  const other = memoryDb(schema);
  const timeOnly = createTrip(other, { label: "Time only", source: "manual", kind: "resale" }, clock);
  addEntry(other, timeOnly, { type: "work", minutes: 60, occurred: "2026-10-05" }, clock);
  const cashOnly = createTrip(other, { label: "Cash only", source: "manual", kind: "resale" }, clock);
  addEntry(other, cashOnly, { type: "receipt", amount: 500, units: 1, occurred: "2026-10-05" }, clock);
  addEntry(other, cashOnly, { type: "sale", amount: 900, units: 1, occurred: "2026-10-06" }, clock);
  addEntry(other, cashOnly, { type: "payout", amount: 800, occurred: "2026-10-07" }, clock);
  s = summary(other, "2026-10");
  assert.equal(s.realisedHourly, null);
  assert.equal(s.realisedMinutes, 60);
  assert.deepEqual(s.hourly, { trips: 1, minutes: 60, earnings: 0, leftOutTrips: 1, leftOutEarnings: 300 });
  // A sale alone is not money yet, so a trip with only a sale and work time is not enough.
  addEntry(other, timeOnly, { type: "receipt", amount: 100, units: 1, occurred: "2026-09-30" }, clock);
  addEntry(other, timeOnly, { type: "sale", amount: 900, units: 1, occurred: "2026-10-06" }, clock);
  assert.equal(summary(other, "2026-10").realisedHourly, null);
  assert.equal(summary(memoryDb(schema), "2026-10").realisedHourly, null);
});

test("deleted entry and proof ids are never reused, so a stale delete cannot remove a replacement (R2B5)", async (t) => {
  const { call, proofDir, db } = await api(t);
  const trip = (await call("POST", "/api/ledger/trips", { label: "Stale tab", source: "manual", kind: "resale" })).body.id;
  const receipt = (await call("POST", `/api/ledger/trips/${trip}/entries`, { type: "receipt", amount: 1000, units: 1, occurred: "2026-10-30" })).body.id;
  const upload = (data, label, mediaType) =>
    call("POST", `/api/ledger/trips/${trip}/proofs`, { label, mediaType, data, entryId: receipt });
  const wrong = (await upload(png().toString("base64"), "wrong photo", "image/png")).body.proof;
  // Tab A removes the wrong photo and attaches the right one.
  assert.equal((await call("DELETE", `/api/ledger/trips/${trip}/proofs/${wrong.id}`, {})).body.removed.file, "deleted");
  const right = (await upload(jpegWithGps().toString("base64"), "receipt", "image/jpeg")).body.proof;
  assert.ok(right.id > wrong.id, "a new proof never takes a deleted proof's id");
  // Tab B, opened before, removes "the wrong photo" again.
  const stale = await call("DELETE", `/api/ledger/trips/${trip}/proofs/${wrong.id}`, {});
  assert.equal(stale.status, 404);
  assert.ok(existsSync(join(proofDir, right.sha256)), "the right receipt is kept");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_proofs").get().n, 1);
  // Entries: a retried delete of a removed payout does not reach its replacement.
  const entry = (amount) =>
    call("POST", `/api/ledger/trips/${trip}/entries`, { type: "payout", amount, occurred: "2026-10-31" });
  const first = (await entry(1500)).body.id;
  assert.equal((await call("DELETE", `/api/ledger/trips/${trip}/entries/${first}`, {})).status, 200);
  const second = (await entry(1600)).body.id;
  assert.ok(second > first);
  assert.equal((await call("DELETE", `/api/ledger/trips/${trip}/entries/${first}`, {})).status, 404);
  assert.deepEqual((await call("GET", `/api/ledger/trips/${trip}`)).body.entries.map((e) => e.amount), [1000, 1600]);
});

// The ledger tables exactly as 5d508b0 created them (git show 5d508b0:server/ledger.mjs).
const SCHEMA_5D508B0 = [
  "CREATE TABLE IF NOT EXISTS ledger_trips (id INTEGER PRIMARY KEY, label TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, reference TEXT, predicted TEXT, status TEXT NOT NULL DEFAULT 'open', created TEXT NOT NULL, closed_at TEXT)",
  "CREATE TABLE IF NOT EXISTS ledger_entries (id INTEGER PRIMARY KEY, trip_id INTEGER NOT NULL REFERENCES ledger_trips(id), type TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount >= 0), units INTEGER, reference TEXT, occurred TEXT NOT NULL, minutes INTEGER, note TEXT, created TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS ledger_proofs (id INTEGER PRIMARY KEY, trip_id INTEGER NOT NULL REFERENCES ledger_trips(id), entry_id INTEGER REFERENCES ledger_entries(id), sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, media_type TEXT NOT NULL, label TEXT NOT NULL, created TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS ledger_legacy_outcomes (outcome_id INTEGER PRIMARY KEY, trip_id INTEGER NOT NULL REFERENCES ledger_trips(id), migrated TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS ledger_entries_trip ON ledger_entries(trip_id)",
  "CREATE INDEX IF NOT EXISTS ledger_entries_occurred ON ledger_entries(occurred)",
  "CREATE INDEX IF NOT EXISTS ledger_proofs_trip ON ledger_proofs(trip_id)",
];

test("migration: tables from the previous schema get AUTOINCREMENT ids and keep every row, id and link (R2B5)", () => {
  const db = memoryDb((d) => {
    for (const sql of SCHEMA_5D508B0) d.exec(sql);
  });
  // Fill it the way the previous code did.
  const a = createTrip(db, { label: "Old A", source: "manual", kind: "resale" }, clock);
  const b = createTrip(db, { label: "Old B", source: "manual", kind: "household" }, clock);
  const ra = addEntry(db, a, { type: "receipt", amount: 3000, units: 3, occurred: "2026-10-05", reference: "R-1", note: "till" }, clock);
  addEntry(db, a, { type: "sale", amount: 7800, units: 3, occurred: "2026-10-10" }, clock);
  const pa = addEntry(db, a, { type: "payout", amount: 6600, units: 3, occurred: "2026-10-12" }, clock);
  addEntry(db, a, { type: "work", minutes: 90, occurred: "2026-10-12" }, clock);
  addEntry(db, b, { type: "saving", amount: 400, occurred: "2026-10-06" }, clock);
  const doomed = addEntry(db, a, { type: "expense", amount: 64000, occurred: "2026-10-12", note: "typo" }, clock);
  const insertProof = db.prepare(
    "INSERT INTO ledger_proofs (trip_id, entry_id, sha256, bytes, media_type, label, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insertProof.run(a, ra, "1".repeat(64), 100, "image/jpeg", "Till receipt", NOW.toISOString());
  insertProof.run(a, pa, "2".repeat(64), 200, "application/pdf", "Statement", NOW.toISOString());
  insertProof.run(a, null, "3".repeat(64), 300, "image/png", "Whole trip", NOW.toISOString());
  const doomedProof = Number(insertProof.run(b, null, "4".repeat(64), 1, "image/png", "Gone", NOW.toISOString()).lastInsertRowid);
  // The newest rows are deleted, so the old tables would hand their ids out again.
  db.prepare("DELETE FROM ledger_entries WHERE id = ?").run(doomed);
  db.prepare("DELETE FROM ledger_proofs WHERE id = ?").run(doomedProof);
  const before = {
    trips: db.prepare("SELECT * FROM ledger_trips ORDER BY id").all(),
    entries: db.prepare("SELECT * FROM ledger_entries ORDER BY id").all(),
    proofs: db.prepare("SELECT * FROM ledger_proofs ORDER BY id").all(),
    detail: getTrip(db, a),
  };
  assert.equal(before.detail.reconciliation.verified, true);

  // As openDb runs it: inside the schema transaction, foreign keys on.
  transaction(db, () => schema(db));
  const sql = (name) => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name).sql;
  assert.match(sql("ledger_entries"), /AUTOINCREMENT/);
  assert.match(sql("ledger_proofs"), /AUTOINCREMENT/);
  assert.match(sql("ledger_proofs"), /REFERENCES "?ledger_entries"?\(id\)/);
  assert.ok(!/rebuild/.test(sql("ledger_proofs")));
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%rebuild%'").all(), []);
  assert.deepEqual(db.prepare("SELECT * FROM ledger_trips ORDER BY id").all(), before.trips);
  assert.deepEqual(db.prepare("SELECT * FROM ledger_entries ORDER BY id").all(), before.entries);
  assert.deepEqual(db.prepare("SELECT * FROM ledger_proofs ORDER BY id").all(), before.proofs);
  assert.deepEqual(getTrip(db, a), before.detail);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  const fks = db.prepare("PRAGMA foreign_key_list(ledger_proofs)").all().map((f) => [f.from, f.table]).sort();
  assert.deepEqual(fks, [["entry_id", "ledger_entries"], ["trip_id", "ledger_trips"]]);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'ledger_%'").all().map((i) => i.name).sort();
  for (const name of ["ledger_entries_occurred", "ledger_entries_trip", "ledger_proofs_sha256", "ledger_proofs_trip"])
    assert.ok(indexes.includes(name), name);
  // Foreign keys still hold: a proof cannot point at a missing entry.
  assert.throws(() => insertProof.run(a, 99999, "5".repeat(64), 1, "image/png", "x", NOW.toISOString()), /FOREIGN KEY/);
  assert.throws(() => db.prepare("DELETE FROM ledger_entries WHERE id = ?").run(ra), /FOREIGN KEY/);
  // New rows continue after the highest id kept; deleted ones are never handed out again.
  const next = addEntry(db, a, { type: "expense", amount: 300, occurred: "2026-10-13" }, clock);
  assert.ok(next > Math.max(...before.entries.map((e) => e.id)));
  db.prepare("DELETE FROM ledger_entries WHERE id = ?").run(next);
  assert.ok(addEntry(db, a, { type: "expense", amount: 300, occurred: "2026-10-13" }, clock) > next);
  const p1 = recordProof(db, { tripId: b, entryId: null, label: "new", sha256: "6".repeat(64), bytes: 1, mediaType: "image/png" }, clock).proof.id;
  db.prepare("DELETE FROM ledger_proofs WHERE id = ?").run(p1);
  const p2 = recordProof(db, { tripId: b, entryId: null, label: "newer", sha256: "7".repeat(64), bytes: 1, mediaType: "image/png" }, clock).proof.id;
  assert.ok(p2 > p1);
  // Running it again changes nothing.
  assert.equal(migrateToAutoincrement(db), false);
  const count = db.prepare("SELECT COUNT(*) AS n FROM ledger_entries").get().n;
  schema(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries").get().n, count);
});

test("migration: only the proof table is rebuilt when entries already use AUTOINCREMENT", () => {
  const db = memoryDb((d) => {
    d.exec(SCHEMA_5D508B0[0]);
    d.exec(SCHEMA_5D508B0[1].replace("id INTEGER PRIMARY KEY,", "id INTEGER PRIMARY KEY AUTOINCREMENT,"));
    d.exec(SCHEMA_5D508B0[2]);
  });
  const a = createTrip(db, { label: "Half", source: "manual", kind: "resale" }, clock);
  const r = addEntry(db, a, { type: "receipt", amount: 100, units: 1, occurred: "2026-10-05" }, clock);
  db.prepare("INSERT INTO ledger_proofs (trip_id, entry_id, sha256, bytes, media_type, label, created) VALUES (?, ?, ?, 1, 'image/png', 'r', ?)").run(a, r, "8".repeat(64), NOW.toISOString());
  schema(db);
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ledger_proofs'").get().sql, /AUTOINCREMENT/);
  assert.equal(getTrip(db, a).proofs[0].entry_id, r);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("household savings in the summary are net of the trip's own costs (M14)", () => {
  const db = memoryDb(schema);
  const t = createTrip(db, { label: "Big shop", source: "manual", kind: "household" }, clock);
  addEntry(db, t, { type: "receipt", amount: 4000, occurred: "2026-10-10" }, clock);
  addEntry(db, t, { type: "saving", amount: 300, occurred: "2026-10-10" }, clock);
  addEntry(db, t, { type: "expense", amount: 550, occurred: "2026-10-10", note: "return bus fare" }, clock);
  assert.equal(getTrip(db, t).reconciliation.netHouseholdSaving, -250);
  const s = summary(db, "2026-10");
  assert.equal(s.householdSavings, -250);
  assert.equal(s.householdSavingsGross, 300);
  assert.equal(s.householdTripCosts, 550);
  assert.equal(s.realisedEarnings, 0);
  assert.equal(listTrips(db)[0].netHouseholdSaving, -250);
  // A second trip that saved more than it cost.
  const u = createTrip(db, { label: "Bulk buy", source: "manual", kind: "household" }, clock);
  addEntry(db, u, { type: "saving", amount: 1200, occurred: "2026-10-12" }, clock);
  addEntry(db, u, { type: "expense", amount: 200, occurred: "2026-10-12" }, clock);
  assert.equal(summary(db, "2026-10").householdSavings, -250 + 1000);
  // Each month counts its own dated entries.
  assert.equal(summary(db, "2026-09").householdSavings, 0);
});

test("discrepancies: sales before the purchase and payouts above the sales they cover", () => {
  const codes = (entries) => reconcile(resaleTrip(), entries).discrepancies.map((d) => d.code);
  assert.ok(
    codes([
      entry("sale", 900, "2026-10-01", { units: 1 }),
      entry("receipt", 500, "2026-10-03", { units: 1 }),
      entry("payout", 800, "2026-10-05", { units: 1 }),
    ]).includes("sale-before-receipt"),
  );
  // Two sold units at 25.00 each, a payout of 43.00 for one unit: above what it covers.
  const over = codes([
    entry("receipt", 2400, "2026-10-01", { units: 2 }),
    entry("sale", 5000, "2026-10-02", { units: 2 }),
    entry("payout", 4300, "2026-10-04", { units: 1 }),
  ]);
  assert.deepEqual(over, ["payout-above-paid-sales"]);
  // A payout with no units dated between two sales cannot pay the later one.
  assert.deepEqual(
    codes([
      entry("receipt", 2400, "2026-10-01", { units: 2 }),
      entry("sale", 2000, "2026-10-02", { units: 1 }),
      entry("payout", 3000, "2026-10-03"),
      entry("sale", 2000, "2026-10-05", { units: 1 }),
    ]),
    ["payout-above-paid-sales"],
  );
});

test("legacy outcomes migrate idempotently and keep the old table", () => {
  const db = memoryDb((d) => {
    d.exec(D456F87_OUTCOMES);
    d.prepare("INSERT INTO outcomes(sku, received, costs, minutes, created) VALUES (?, ?, ?, ?, ?)").run(
      "leeds-kettle",
      4500,
      3000,
      90,
      "2026-10-20 14:30:00",
    );
    d.prepare("INSERT INTO outcomes(sku, received, costs, minutes) VALUES (?, ?, ?, ?)").run("leeds-lamp", 0, 800, 30);
    // 23:30 UTC on 1 July is 2 July in the UK (British Summer Time).
    d.prepare("INSERT INTO outcomes(sku, received, costs, minutes, created) VALUES (?, ?, ?, ?, ?)").run(
      "leeds-late",
      700,
      200,
      15,
      "2026-07-01 23:30:00",
    );
  }, schema);
  schema(db); // second run must not duplicate
  migrateLegacyOutcomes(db);
  const trips = listTrips(db);
  assert.equal(trips.length, 3);
  assert.ok(trips.every((t) => t.source === "legacy" && t.legacy && t.status === "closed"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outcomes").get().n, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_legacy_outcomes").get().n, 3);
  const late = getTrip(db, trips.find((t) => t.reference === "leeds-late").id);
  assert.ok(late.entries.every((e) => e.occurred === "2026-07-02"));

  const kettle = trips.find((t) => t.reference === "leeds-kettle");
  const detail = getTrip(db, kettle.id);
  assert.deepEqual(
    detail.entries.map((e) => [e.type, e.amount, e.minutes, e.occurred]),
    [
      ["payout", 4500, null, "2026-10-20"],
      ["expense", 3000, null, "2026-10-20"],
      ["work", 0, 90, "2026-10-20"],
    ],
  );
  assert.equal(detail.trip.created, "2026-10-20T14:30:00.000Z");
  assert.equal(detail.reconciliation.realisedContribution, 1500);
  assert.equal(detail.reconciliation.legacy, true);
  assert.equal(detail.reconciliation.verified, false);
  assert.equal(detail.reconciliation.checklist.complete, false);
  assert.deepEqual(detail.reconciliation.discrepancies, []);
  // Zero proceeds create no payout entry.
  const lamp = getTrip(db, trips.find((t) => t.reference === "leeds-lamp").id);
  assert.deepEqual(lamp.entries.map((e) => e.type), ["expense", "work"]);
  // Legacy totals are read-only and excluded from forecast metrics.
  assert.throws(() => addEntry(db, kettle.id, { type: "receipt", amount: 100, units: 1, occurred: "2026-10-20" }, clock), (e) => e.status === 409);
  const m = metrics(db);
  assert.equal(m.legacyTrips, 3);
  assert.equal(m.closedTrips, 0);
  // A later outcome row is picked up on the next run, and only that one.
  db.prepare("INSERT INTO outcomes(sku, received, costs, minutes) VALUES (?, ?, ?, ?)").run("leeds-mug", 1200, 500, 20);
  schema(db);
  assert.equal(listTrips(db).length, 4);
  schema(db);
  assert.equal(listTrips(db).length, 4);
});

test("schema works without a legacy table and is idempotent", () => {
  const db = memoryDb(schema, schema);
  assert.equal(migrateLegacyOutcomes(db), 0);
  assert.deepEqual(listTrips(db), []);
});

test("entry validation", () => {
  const db = memoryDb(schema);
  const id = createTrip(db, { label: "V", source: "manual", kind: "resale" }, clock);
  const bad = (input, pattern) => assert.throws(() => addEntry(db, id, input, clock), pattern);
  bad({ type: "receipt", amount: 12.5, units: 1, occurred: "2026-10-01" }, /amount/);
  bad({ type: "receipt", amount: "1000", units: 1, occurred: "2026-10-01" }, /amount/);
  bad({ type: "receipt", amount: 0, units: 1, occurred: "2026-10-01" }, /amount/);
  bad({ type: "receipt", amount: -100, units: 1, occurred: "2026-10-01" }, /amount/);
  bad({ type: "receipt", amount: 1000, occurred: "2026-10-01" }, /units/);
  bad({ type: "receipt", amount: 1000, units: 1, occurred: "2026-11-01" }, /future/);
  bad({ type: "receipt", amount: 1000, units: 1, occurred: "2026-02-30" }, /calendar date/);
  bad({ type: "receipt", amount: 1000, units: 1, occurred: "1999-12-31" }, /on or after/);
  bad({ type: "expense", amount: 100, units: 2, occurred: "2026-10-01" }, /units do not apply/);
  bad({ type: "work", amount: 500, minutes: 30, occurred: "2026-10-01" }, /minutes, not money/);
  bad({ type: "work", occurred: "2026-10-01" }, /minutes/);
  bad({ type: "expense", amount: 100, minutes: 30, occurred: "2026-10-01" }, /work entries only/);
  bad({ type: "bonus", amount: 100, occurred: "2026-10-01" }, /type/);
  bad({ type: "payout", amount: 100, occurred: "2026-10-01", note: "x".repeat(501) }, /note/);
  // Dates are checked against today in the UK, not UTC: 00:30 BST on 2 July
  // is still 1 July in UTC. The ledger counts from the same today as every
  // other module (http.mjs).
  assert.equal(londonDate, sharedLondonDate);
  const lateEvening = new Date("2026-07-01T23:30:00.000Z");
  assert.equal(londonDate(lateEvening), "2026-07-02");
  assert.equal(pastDate("2026-07-02", "occurred", lateEvening), "2026-07-02");
  assert.throws(() => pastDate("2026-07-03", "occurred", lateEvening), /future/);
  // Today in the UK is allowed.
  assert.ok(addEntry(db, id, { type: "work", minutes: 30, occurred: "2026-10-31" }, clock) > 0);
  assert.ok(addEntry(db, id, { type: "payout", amount: 100, occurred: "2026-10-31" }, clock) > 0);
  // Trip validation.
  assert.throws(() => createTrip(db, { label: "x", source: "legacy", kind: "resale" }, clock), /source/);
  assert.throws(() => createTrip(db, { label: "x", source: "manual", kind: "shop" }, clock), /kind/);
  assert.throws(
    () => createTrip(db, { label: "x", source: "manual", kind: "household", predicted: { units: 1, proceeds: 1, contribution: 1, cashRequired: 1, activeMinutes: 1 } }, clock),
    /resale trips only/,
  );
  assert.throws(
    () => createTrip(db, { label: "x", source: "planner", kind: "resale", predicted: { units: 1, proceeds: 10.5, contribution: 1, cashRequired: 1, activeMinutes: 1 } }, clock),
    /proceeds/,
  );
  // Negative predicted contribution is allowed: it is a prediction, not a gate.
  assert.ok(
    createTrip(db, { label: "x", source: "planner", kind: "resale", predicted: { units: 1, proceeds: 100, contribution: -400, cashRequired: 500, activeMinutes: 30 } }, clock) > 0,
  );
  closeTrip(db, id, clock);
  assert.throws(() => addEntry(db, id, { type: "payout", amount: 100, occurred: "2026-10-31" }, clock), (e) => e.status === 409);
  assert.throws(() => closeTrip(db, id, clock), (e) => e.status === 409);
});

test("proof storage: magic bytes, size, private modes and metadata removal", () => {
  const dir = join(scratch, "store");
  // Wrong magic bytes for the declared type.
  assert.throws(() => storeProof(dir, png(), "image/jpeg"), /does not match/);
  assert.throws(() => storeProof(dir, Buffer.from("GIF89a...."), "image/png"), /does not match/);
  assert.throws(() => storeProof(dir, Buffer.from("<html>"), "application/pdf"), /does not match/);
  assert.throws(() => storeProof(dir, Buffer.from("GIF89a"), "image/gif"), /JPEG or PNG/);
  assert.throws(() => storeProof(dir, Buffer.alloc(0), "image/png"), /empty/);
  const oversize = Buffer.concat([pdf(), Buffer.alloc(MAX_PROOF_BYTES)]);
  assert.throws(() => storeProof(dir, oversize, "application/pdf"), /5 MB/);
  // Truncated JPEG: right magic, unreadable structure.
  assert.throws(() => storeProof(dir, Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00]), "image/jpeg"), /could not be read/);
  // Nothing was written by the rejected uploads.
  assert.throws(() => readdirSync(dir), /ENOENT/);

  const photo = jpegWithGps();
  const stored = storeProof(dir, photo, "image/jpeg");
  const file = join(dir, stored.sha256);
  const saved = readFileSync(file);
  assert.equal(stored.metadataRemoved, true);
  assert.ok(!saved.includes("GPSLatitude"), "location metadata removed");
  assert.ok(!saved.includes("shot at home"), "comment removed");
  assert.equal(sha(saved), stored.sha256, "hash is of the stored, cleaned file");
  assert.notEqual(sha(photo), stored.sha256);
  assert.equal(stored.bytes, saved.length);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  // The same content stored twice keeps one file.
  assert.equal(storeProof(dir, photo, "image/jpeg").sha256, stored.sha256);
  assert.equal(readdirSync(dir).length, 1);

  const cleanPng = storeProof(dir, png(), "image/png");
  assert.ok(!readFileSync(join(dir, cleanPng.sha256)).includes("GPS"));
  // PDFs are kept byte for byte, document properties included.
  const statement = pdf();
  const storedPdf = storeProof(dir, statement, "application/pdf");
  assert.equal(storedPdf.metadataRemoved, false);
  assert.equal(storedPdf.sha256, sha(statement));
  assert.ok(readFileSync(join(dir, storedPdf.sha256)).equals(statement));
  assert.equal(prepareProof(statement, "application/pdf").bytes, statement.length);

  // An existing directory or file with looser permissions is tightened (P3, P5).
  const loose = join(scratch, "loose");
  mkdirSync(loose, { recursive: true });
  chmodSync(loose, 0o755);
  const statement2 = pdf("loose file");
  writeFileSync(join(loose, sha(statement2)), statement2);
  chmodSync(join(loose, sha(statement2)), 0o644);
  storeProof(loose, statement2, "application/pdf");
  assert.equal(statSync(loose).mode & 0o777, 0o700);
  assert.equal(statSync(join(loose, sha(statement2))).mode & 0o777, 0o600);
  // Deleting a stored file by fingerprint stays inside the proof directory.
  assert.throws(() => deleteProofFile(loose, "../" + "a".repeat(61)), /fingerprint/);
  assert.throws(() => deleteProofFile(loose, "A".repeat(64)), /fingerprint/);
  assert.equal(deleteProofFile(loose, sha(statement2)), "deleted");
  assert.equal(deleteProofFile(loose, sha(statement2)), "missing");

  assert.throws(() => decodeBase64("not base64!"), /base64/);
  assert.throws(() => decodeBase64("abc"), /base64/);
  assert.throws(() => decodeBase64(""), /base64/);
  assert.throws(() => decodeBase64("A".repeat(Math.ceil(MAX_PROOF_BYTES / 3) * 4 + 4)), /5 MB/);
  assert.ok(decodeBase64(statement.toString("base64")).equals(statement));
});

// --- Routes ----------------------------------------------------------------
async function api(t) {
  const db = memoryDb(schema);
  const proofDir = join(scratch, "routes-" + Math.random().toString(36).slice(2));
  const server = await serve(db, [{ routes: (d) => ledgerRoutes.routes(d, { proofDir, now: () => NOW }) }]);
  t.after(() => server.close());
  return { ...server, db, proofDir };
}

test("routes: trips and entries", async (t) => {
  const { call } = await api(t);
  // The payload the research and planner tabs send.
  const created = await call("POST", "/api/ledger/trips", {
    label: "Kettle at Example Store",
    source: "research",
    kind: "resale",
    reference: "awin:1001",
    predicted: { units: 2, proceeds: 5000, contribution: 1400, cashRequired: 3000, activeMinutes: 95 },
  });
  assert.equal(created.status, 201);
  assert.ok(Number.isSafeInteger(created.body.id));
  const id = created.body.id;

  for (const body of [
    { label: "x", source: "legacy", kind: "resale" },
    { label: "", source: "manual", kind: "resale" },
    { label: "x", source: "manual", kind: "resale", predicted: { units: 1 } },
    [],
  ])
    assert.equal((await call("POST", "/api/ledger/trips", body)).status, 400, JSON.stringify(body));

  const entry = (body) => call("POST", `/api/ledger/trips/${id}/entries`, body);
  assert.equal((await entry({ type: "receipt", amount: 30.5, units: 2, occurred: "2026-10-30" })).status, 400);
  const future = await entry({ type: "receipt", amount: 3000, units: 2, occurred: "2026-11-01" });
  assert.equal(future.status, 400);
  assert.match(future.body.error, /future/);
  assert.equal((await entry({ type: "receipt", amount: 3000, units: 2, occurred: "31/10/2026" })).status, 400);
  assert.equal((await entry({ type: "saving", amount: 300, occurred: "2026-10-30" })).status, 400);

  const ok = await entry({ type: "receipt", amount: 3000, units: 2, occurred: "2026-10-30", reference: "RCPT-1" });
  assert.equal(ok.status, 201);
  assert.ok(ok.body.id);
  assert.equal(ok.body.reconciliation.receipts, 3000);
  await entry({ type: "sale", amount: 2600, units: 1, occurred: "2026-10-30", reference: "eBay 123" });

  const listed = await call("GET", "/api/ledger/trips");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.trips.length, 1);
  assert.equal(listed.body.trips[0].realisedContribution, -3000);
  assert.equal(listed.body.trips[0].pendingPayout, 2600);

  const detail = await call("GET", `/api/ledger/trips/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.entries.length, 2);
  assert.equal(detail.body.trip.predicted.contribution, 1400);
  assert.equal(detail.body.reconciliation.checklist.payout, "missing");
  assert.equal(detail.body.reconciliation.forecast.predictedProceeds, 5000);

  assert.equal((await call("GET", "/api/ledger/trips/999")).status, 404);
  assert.equal((await call("GET", "/api/ledger/trips/abc")).status, 400);
  assert.equal((await call("POST", "/api/ledger/trips/999/entries", { type: "payout", amount: 1, occurred: "2026-10-30" })).status, 404);

  // A mistaken entry can be removed while the trip is open.
  const typo = await entry({ type: "expense", amount: 64000, occurred: "2026-10-30", note: "typo" });
  assert.equal(typo.status, 201);
  const removed = await call("DELETE", `/api/ledger/trips/${id}/entries/${typo.body.id}`, {});
  assert.equal(removed.status, 200);
  assert.equal(removed.body.reconciliation.expenses, 0);
  assert.equal((await call("DELETE", `/api/ledger/trips/${id}/entries/${typo.body.id}`, {})).status, 404);

  const closed = await call("POST", `/api/ledger/trips/${id}/close`, {});
  assert.equal(closed.status, 200);
  assert.equal(closed.body.trip.status, "closed");
  assert.equal((await entry({ type: "payout", amount: 2300, units: 1, occurred: "2026-10-31" })).status, 409);
  assert.equal((await call("POST", `/api/ledger/trips/${id}/close`, {})).status, 409);
  const kept = detail.body.entries[0].id;
  assert.equal((await call("DELETE", `/api/ledger/trips/${id}/entries/${kept}`, {})).status, 409);
});

test("routes: proofs are stored privately and never returned", async (t) => {
  const { call, proofDir } = await api(t);
  const id = (await call("POST", "/api/ledger/trips", { label: "Proofed", source: "manual", kind: "resale" })).body.id;
  const other = (await call("POST", "/api/ledger/trips", { label: "Other", source: "manual", kind: "resale" })).body.id;
  const add = async (trip, body) => (await call("POST", `/api/ledger/trips/${trip}/entries`, body)).body.id;
  const receipt = await add(id, { type: "receipt", amount: 1000, units: 1, occurred: "2026-10-20" });
  await add(id, { type: "sale", amount: 2000, units: 1, occurred: "2026-10-22" });
  const payout = await add(id, { type: "payout", amount: 1750, units: 1, occurred: "2026-10-25" });
  const elsewhere = await add(other, { type: "receipt", amount: 500, units: 1, occurred: "2026-10-20" });

  const photo = jpegWithGps().toString("base64");
  const upload = (trip, body) => call("POST", `/api/ledger/trips/${trip}/proofs`, body);

  // Rejections write nothing.
  assert.equal((await upload(id, { label: "r", mediaType: "image/jpeg", data: png().toString("base64"), entryId: receipt })).status, 400);
  assert.equal((await upload(id, { label: "r", mediaType: "image/gif", data: photo, entryId: receipt })).status, 400);
  assert.equal((await upload(id, { label: "r", mediaType: "image/jpeg", data: "%%%", entryId: receipt })).status, 400);
  assert.equal((await upload(id, { label: "r", mediaType: "image/jpeg", data: photo, entryId: elsewhere })).status, 400);
  assert.equal((await upload(id, { mediaType: "image/jpeg", data: photo, entryId: receipt })).status, 400);
  assert.equal((await upload(999, { label: "r", mediaType: "image/jpeg", data: photo })).status, 404);
  assert.throws(() => readdirSync(proofDir), /ENOENT/);

  const first = await upload(id, { label: "Till receipt", mediaType: "image/jpeg", data: photo, entryId: receipt });
  assert.equal(first.status, 201);
  assert.deepEqual(Object.keys(first.body.proof).sort(), [
    "bytes",
    "created",
    "entry_id",
    "id",
    "label",
    "media_type",
    "metadataRemoved",
    "sha256",
    "trip_id",
  ]);
  assert.equal(first.body.proof.metadataRemoved, true);
  assert.equal(first.body.reconciliation.verified, false);
  const file = join(proofDir, first.body.proof.sha256);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(proofDir).mode & 0o777, 0o700);
  assert.ok(!readFileSync(file).includes("GPSLatitude"));

  // The same file again on the same entry is not duplicated.
  const again = await upload(id, { label: "Till receipt", mediaType: "image/jpeg", data: photo, entryId: receipt });
  assert.equal(again.status, 200);
  assert.equal(again.body.proofs.length, 1);

  const statement = pdf().toString("base64");
  const second = await upload(id, { label: "Payout statement", mediaType: "application/pdf", data: statement, entryId: payout });
  assert.equal(second.status, 201);
  assert.equal(second.body.proof.metadataRemoved, false);
  assert.equal(second.body.reconciliation.verified, true);

  // No response ever carries file contents.
  const detail = await call("GET", `/api/ledger/trips/${id}`);
  const trips = await call("GET", "/api/ledger/trips");
  for (const response of [first, again, second, detail, trips]) {
    const json = JSON.stringify(response.body);
    assert.ok(!json.includes(photo.slice(0, 40)), "no image data");
    assert.ok(!json.includes(statement.slice(0, 40)), "no PDF data");
    assert.ok(!json.includes("GPSLatitude"));
    assert.ok(!/"data"\s*:/.test(json));
  }
  assert.equal(detail.body.proofs.length, 2);
  assert.equal(trips.body.trips.find((trip) => trip.id === id).verified, true);

  // Removing the payout entry detaches its proof, so the trade is no longer verified.
  const afterDelete = await call("DELETE", `/api/ledger/trips/${id}/entries/${payout}`, {});
  assert.equal(afterDelete.status, 200);
  assert.equal(afterDelete.body.reconciliation.verified, false);
  assert.equal(afterDelete.body.proofs.length, 2);
  assert.equal(afterDelete.body.proofs.find((p) => p.id === second.body.proof.id).entry_id, null);

  // A file close to the 5 MB limit fits in the raised body limit.
  const large = Buffer.concat([pdf(), Buffer.alloc(MAX_PROOF_BYTES - 1024, 0x20)]);
  const big = await upload(id, { label: "Bank statement", mediaType: "application/pdf", data: large.toString("base64") });
  assert.equal(big.status, 201);
  assert.equal(big.body.proof.bytes, large.length);
  assert.equal(big.body.proof.entry_id, null);
  const tooBig = Buffer.concat([pdf(), Buffer.alloc(MAX_PROOF_BYTES, 0x20)]);
  assert.equal((await upload(id, { label: "Too big", mediaType: "application/pdf", data: tooBig.toString("base64") })).status, 400);
});

test("routes: a stored proof can be re-linked to an entry or removed (qa:Q12)", async (t) => {
  const { call, proofDir } = await api(t);
  const id = (await call("POST", "/api/ledger/trips", { label: "Relink", source: "manual", kind: "resale" })).body.id;
  const other = (await call("POST", "/api/ledger/trips", { label: "Other", source: "manual", kind: "resale" })).body.id;
  const add = async (trip, body) => (await call("POST", `/api/ledger/trips/${trip}/entries`, body)).body.id;
  const receipt = await add(id, { type: "receipt", amount: 1000, units: 1, occurred: "2026-10-20" });
  await add(id, { type: "sale", amount: 2000, units: 1, occurred: "2026-10-22" });
  const payout = await add(id, { type: "payout", amount: 1750, units: 1, occurred: "2026-10-25" });
  const elsewhere = await add(other, { type: "receipt", amount: 500, units: 1, occurred: "2026-10-20" });
  const upload = (trip, body) => call("POST", `/api/ledger/trips/${trip}/proofs`, body);
  const photo = jpegWithGps().toString("base64");
  const statement = pdf().toString("base64");

  // Stored against the whole trip by mistake: does not count.
  const till = (await upload(id, { label: "Till receipt", mediaType: "image/jpeg", data: photo })).body.proof;
  const paid = (await upload(id, { label: "Payout statement", mediaType: "application/pdf", data: statement, entryId: payout })).body.proof;
  assert.equal(till.entry_id, null);
  assert.equal((await call("GET", `/api/ledger/trips/${id}`)).body.reconciliation.verified, false);

  const relink = (proofId, body, trip = id) => call("PATCH", `/api/ledger/trips/${trip}/proofs/${proofId}`, body);
  const moved = await relink(till.id, { entryId: receipt });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.proofs.find((p) => p.id === till.id).entry_id, receipt);
  assert.equal(moved.body.reconciliation.verified, true);
  assert.deepEqual(moved.body.reconciliation.proofedEntries, [receipt, payout]);
  // Back to the whole trip.
  const back = await relink(till.id, { entryId: null });
  assert.equal(back.body.proofs.find((p) => p.id === till.id).entry_id, null);
  assert.equal(back.body.reconciliation.verified, false);
  // Refused: another trip's entry, a missing body field, unknown proof, proof on another trip.
  assert.equal((await relink(till.id, { entryId: elsewhere })).status, 400);
  assert.equal((await relink(till.id, {})).status, 400);
  assert.equal((await relink(9999, { entryId: receipt })).status, 404);
  assert.equal((await relink(till.id, { entryId: elsewhere }, other)).status, 404);
  // Moving onto an entry that already has the same file merges the two.
  await upload(id, { label: "Till receipt again", mediaType: "image/jpeg", data: photo, entryId: receipt });
  const merged = await relink(till.id, { entryId: receipt });
  assert.equal(merged.body.proofs.filter((p) => p.sha256 === till.sha256).length, 1);
  assert.equal(merged.body.reconciliation.verified, true);

  // The same statement cannot prove a receipt on the other trip as well.
  const reused = await upload(other, { label: "Statement copy", mediaType: "application/pdf", data: statement, entryId: elsewhere });
  assert.equal(reused.status, 409);
  assert.equal(
    reused.body.error,
    "This file is already the proof for Relink (payout, 25 Oct 2026, £17.50): attach the document for this purchase or payout",
  );
  assert.equal((await call("GET", `/api/ledger/trips/${other}`)).body.proofs.length, 0);
  // Kept with the other trip as a whole-trip proof it is stored, and never counts.
  const shared = (await upload(other, { label: "Statement copy", mediaType: "application/pdf", data: statement })).body.proof;
  assert.equal(shared.sha256, paid.sha256);
  assert.equal(shared.entry_id, null);
  // Moving that copy onto the other trip's receipt is refused the same way.
  const moveCopy = await relink(shared.id, { entryId: elsewhere }, other);
  assert.equal(moveCopy.status, 409);
  assert.match(moveCopy.body.error, /^This file is already the proof for Relink \(payout/);
  const remove = (trip, proofId) => call("DELETE", `/api/ledger/trips/${trip}/proofs/${proofId}`, {});
  assert.equal((await remove(other, paid.id)).status, 404); // not on that trip
  const first = await remove(id, paid.id);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.removed, { id: paid.id, file: "in use" });
  assert.equal(first.body.reconciliation.verified, false);
  assert.ok(first.body.proofs.every((p) => p.id !== paid.id));
  assert.ok(existsSync(join(proofDir, paid.sha256)), "file kept while another proof uses it");
  const last = await remove(other, shared.id);
  assert.deepEqual(last.body.removed, { id: shared.id, file: "deleted" });
  assert.ok(!existsSync(join(proofDir, paid.sha256)), "file deleted with its last proof");
  assert.equal((await remove(other, shared.id)).status, 404);
  // The receipt photo is untouched.
  assert.ok(existsSync(join(proofDir, till.sha256)));
  assert.equal((await call("DELETE", `/api/ledger/trips/${id}/proofs/abc`, {})).status, 400);
});

test("routes: sample trips are marked, and fees on a paid-out sale are not pending (qa:Q5, qa:Q13)", async (t) => {
  const { call } = await api(t);
  // The payload the Planner sends.
  const planner = (
    await call("POST", "/api/ledger/trips", {
      label: "Children's waterproof jacket (sample)",
      source: "planner",
      kind: "resale",
      reference: "jacket",
      predicted: { units: 4, proceeds: 10000, contribution: 2700, cashRequired: 5340, activeMinutes: 106 },
    })
  ).body.id;
  const detail = (await call("GET", `/api/ledger/trips/${planner}`)).body;
  assert.equal(detail.trip.sample, true);
  assert.equal(detail.trip.predictionBasis, "sample");
  assert.equal(detail.reconciliation.forecast.counted, false);
  const listed = (await call("GET", "/api/ledger/trips")).body.trips.find((trip) => trip.id === planner);
  assert.equal(listed.sample, true);

  // qa:Q13: receipt 24.00 for 2, sold 50.00 for 2, payout 43.00 with units left blank.
  const id = (await call("POST", "/api/ledger/trips", { label: "Fees", source: "manual", kind: "resale" })).body.id;
  const entry = (body) => call("POST", `/api/ledger/trips/${id}/entries`, body);
  await entry({ type: "receipt", amount: 2400, units: 2, occurred: "2026-10-20" });
  await entry({ type: "sale", amount: 5000, units: 2, occurred: "2026-10-22" });
  const paid = (await entry({ type: "payout", amount: 4300, occurred: "2026-10-26" })).body;
  assert.equal(paid.reconciliation.pendingPayout, 0);
  assert.equal(paid.reconciliation.impliedFees, 700);
  assert.equal(paid.reconciliation.pendingBasis, "dates");
  const month = (await call("GET", "/api/ledger/summary?month=2026-10")).body;
  assert.equal(month.pendingPayouts, 0);
  assert.equal(month.potentialProceeds, 0);
  assert.deepEqual(month.potentialProceedsLeftOut, { sample: 1, basisUnknown: 0, nothingBought: 0 });
  assert.equal((await call("GET", "/api/ledger/trips")).body.trips.find((trip) => trip.id === id).pendingPayout, 0);
});

test("routes: summary and metrics", async (t) => {
  const { call } = await api(t);
  const id = (await call("POST", "/api/ledger/trips", { label: "S", source: "manual", kind: "resale" })).body.id;
  await call("POST", `/api/ledger/trips/${id}/entries`, { type: "receipt", amount: 1000, units: 1, occurred: "2026-10-02" });
  await call("POST", `/api/ledger/trips/${id}/entries`, { type: "sale", amount: 1800, units: 1, occurred: "2026-10-03" });
  await call("POST", `/api/ledger/trips/${id}/entries`, { type: "payout", amount: 1500, units: 1, occurred: "2026-10-06" });
  const month = await call("GET", "/api/ledger/summary?month=2026-10");
  assert.equal(month.status, 200);
  assert.equal(month.body.month, "2026-10");
  assert.equal(month.body.realisedEarnings, 500);
  assert.equal(month.body.pendingPayouts, 0);
  assert.equal(month.body.verifiedPayouts, 0);
  // Without a month, the current UK month.
  assert.equal((await call("GET", "/api/ledger/summary")).body.month, "2026-10");
  // 23:30 UTC on 30 September is already 1 October in the UK.
  const late = memoryDb(schema);
  const lateServer = await serve(late, [
    { routes: (d) => ledgerRoutes.routes(d, { proofDir: join(scratch, "late"), now: () => new Date("2026-09-30T23:30:00Z") }) },
  ]);
  t.after(() => lateServer.close());
  assert.equal((await lateServer.call("GET", "/api/ledger/summary")).body.month, "2026-10");
  assert.equal((await call("GET", "/api/ledger/summary?month=2026-13")).status, 400);
  assert.equal((await call("GET", "/api/ledger/summary?month=October")).status, 400);
  await call("POST", `/api/ledger/trips/${id}/close`, {});
  const m = await call("GET", "/api/ledger/metrics");
  assert.equal(m.status, 200);
  assert.equal(m.body.closedTrips, 1);
  assert.equal(m.body.cash.recoveryRate, 1.5);
  assert.equal(m.body.medianTimeToPayoutDays, 4);
  assert.equal((await call("GET", "/api/outcomes")).status, 404);
});
