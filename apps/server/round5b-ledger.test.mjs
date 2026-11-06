// Round five, ledger follow-up (fix b), from the verifier's report on fc02d8a:
//   1. A sale refunded, with the item sent back, before it was paid out is
//      not pending: a payout with units is never matched to it in place of
//      the resale (R5). A genuine pending payout is still reported.
//   2. One day's entries carry no order, so a day's sales and returns are
//      flagged only when no order of them adds up (R2), and a refund can give
//      the date the item came back (R3). A genuine oversale is still flagged.
//   3. Earnings per hour leave out a trip that sold stock with no purchase
//      recorded, and name it as left out (L6).
// Second pass, from the verifier's report on the first:
//   D1 a refund under an order number that several sales share is matched
//      among them by the same rule, not to the first of them;
//   D2 legacy totals record their costs, so they keep counting;
//   D3 a no-purchase trip counts where its recorded result lowers earnings
//      per hour, and is left out only where it would raise them;
//   D5 the rules that keep a real pending payout shown each have a test;
//   and above 12 movements in a day the totals rule needs stock on hand or out.
// Third pass, from the verifier's report on the second:
//   E1 an open trip left out for stock with no purchase recorded is counted
//      apart when it has no work time (openNoWork), so the interface can ask
//      for its work time too (the wording itself is in e2e/ledger.e2e.mjs);
//   above 12 movements in a day every count of each kind and size is tried
//      (S2), and only a day in too many sizes falls back to its totals, which
//      never accept a movement bigger than all stock;
//   and tests for rules no test pinned: the order search itself (S3), which
//   entry is flagged when no order works (S6), payouts without units (P13)
//   and the measures' comparison (E14).
// Fix 5, from the last verifier's report:
//   the R3 flag gives only advice the trip allows: no entry can be edited, so
//   an open trip is told to remove the refund and record it again with the
//   date the item came back, and a closed trip is told its entries cannot
//   change; and every message for the date the item came back, or whether
//   the buyer sent the item back, names it in words, not by its field name.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryDb, serve } from "./test-support.mjs";
import { schema, createTrip, addEntry, getTrip, listTrips, reconcile, stockWalk, summary } from "./ledger.mjs";
import * as ledger from "./ledger.mjs";
import { transaction } from "./http.mjs";
import * as ledgerRoutes from "./routes-ledger.mjs";

const OCTOBER_END = new Date("2026-10-31T12:00:00.000Z");
const scratch = mkdtempSync(join(tmpdir(), "bounty-round5b-ledger-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

async function api(t, now = OCTOBER_END, setup = null) {
  const db = memoryDb(...(setup ? [setup] : []), schema);
  const proofDir = join(scratch, "routes-" + Math.random().toString(36).slice(2));
  const server = await serve(db, [{ routes: (d) => ledgerRoutes.routes(d, { proofDir, now: () => now }) }]);
  t.after(() => server.close());
  const call = server.call;
  /** A resale trip with the given entries (each must be accepted), optionally closed. */
  const trip = async (label, entries, { close = false } = {}) => {
    const id = (await call("POST", "/api/ledger/trips", { label, source: "manual", kind: "resale" })).body.id;
    const ids = [];
    for (const body of entries) {
      const r = await call("POST", `/api/ledger/trips/${id}/entries`, body);
      assert.equal(r.status, 201, JSON.stringify(body) + " " + JSON.stringify(r.body));
      ids.push(r.body.id);
    }
    if (close) assert.equal((await call("POST", `/api/ledger/trips/${id}/close`, {})).status, 200);
    return { id, ids };
  };
  const detail = async (id) => (await call("GET", `/api/ledger/trips/${id}`)).body;
  const month = async (m) => (await call("GET", `/api/ledger/summary?month=${m}`)).body;
  const pdf = (body) => Buffer.from("%PDF-1.4\n%" + body + "\n%%EOF\n", "latin1").toString("base64");
  const proof = async (id, entryId, label) => {
    const r = await call("POST", `/api/ledger/trips/${id}/proofs`, { label, mediaType: "application/pdf", data: pdf(label), entryId });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  };
  return { db, call, trip, detail, month, proof };
}

// The verifier's entries (f5.mjs).
const RC = { type: "receipt", amount: 1000, units: 1, occurred: "2026-10-01" };
const S = (d, units = 1) => ({ type: "sale", amount: 2500, units, occurred: d });
const P = (d, units = 1) => ({ type: "payout", amount: 2200, units, occurred: d });
const RET = (d, units = 1, extra = {}) => ({ type: "refund", amount: 2500, units, itemReturned: true, occurred: d, ...extra });
const KEPT = (d) => ({ type: "refund", amount: 2500, itemReturned: false, occurred: d });
const WORK = (d, minutes) => ({ type: "work", minutes, occurred: d });
const codes = (d) => d.reconciliation.discrepancies.map((x) => x.code);

// --- 1. Refunded before payout --------------------------------------------

test("R5 routes: a sale refunded with the item sent back before any payout is not pending, so the trip completes", async (t) => {
  const { trip, detail, month } = await api(t);
  // Sale 3 Oct, refund with return 5 Oct before any payout, resale 8 Oct,
  // payout of 1 unit 10 Oct, 20 minutes of work.
  const { id } = await trip("Netted", [RC, S("2026-10-03"), RET("2026-10-05"), S("2026-10-08"), P("2026-10-10", 1), WORK("2026-10-10", 20)]);
  const r = (await detail(id)).reconciliation;
  assert.deepEqual(r.discrepancies, []);
  assert.equal(r.unsoldUnits, 0);
  assert.equal(r.pendingPayout, 0, "the payout is the resale's: the refunded sale is never paid out");
  assert.equal(r.refundedUnpaid, 2500);
  assert.equal(r.refundedUnpaidUnits, 1);
  assert.equal(r.impliedFees, 300, "fees on the resale the payout covered");
  assert.equal(r.completedOn, "2026-10-10");
  // The refund still counts as money out: earnings are never overstated.
  assert.equal(r.realisedContribution, 2200 - 1000 - 2500);
  const oct = await month("2026-10");
  assert.equal(oct.pendingPayouts, 0);
  assert.equal(oct.hourly.trips, 1);
  assert.equal(oct.hourly.stillOpen, 0);
  assert.equal(oct.realisedHourly, Math.round(((2200 - 1000 - 2500) * 60) / 20));
});

test("R5 control routes: a genuine pending payout is still reported", async (t) => {
  const { trip, detail, month, call } = await api(t);
  // The refund is for a sale already paid out, so the resale's payout is
  // still to come: nothing is cancelled.
  const paidFirst = await trip("Paid, refunded, resold", [RC, S("2026-10-03"), P("2026-10-04", 1), RET("2026-10-05"), S("2026-10-08")]);
  let r = (await detail(paidFirst.id)).reconciliation;
  assert.equal(r.pendingPayout, 2500);
  assert.equal(r.refundedUnpaid, 0);
  assert.equal(r.completedOn, null);
  // A refund on the day of a payout is never taken to have stopped it.
  const sameDay = await trip("Payout and refund the same day", [RC, S("2026-10-03"), P("2026-10-05", 1), RET("2026-10-05"), S("2026-10-08")]);
  assert.equal((await detail(sameDay.id)).reconciliation.pendingPayout, 2500);
  // A payout covering more units than are unpaid pays the refunded unit
  // (the marketplace paid it after all), never a sale dated after it.
  const later = await trip("Paid after the refund", [
    { ...RC, units: 2 },
    S("2026-10-03"),
    S("2026-10-06"),
    RET("2026-10-07"),
    P("2026-10-08", 2),
    S("2026-10-12"),
  ]);
  r = (await detail(later.id)).reconciliation;
  assert.equal(r.pendingPayout, 2500, "the 12 Oct sale is still to be paid out");
  assert.equal(r.refundedUnpaid, 0);
  // Two unpaid sales and one refund: only one unit is cancelled, the
  // cheaper, so the most money still to come stays shown.
  const two = await trip("Two unpaid, one refunded", [
    { ...RC, units: 2 },
    { type: "sale", amount: 3000, units: 1, occurred: "2026-10-03" },
    { type: "sale", amount: 2000, units: 1, occurred: "2026-10-04" },
    RET("2026-10-05"),
  ]);
  r = (await detail(two.id)).reconciliation;
  assert.equal(r.pendingPayout, 3000);
  assert.equal(r.refundedUnpaid, 2000);
  // The refund's reference names the sale it refunds: that sale, not the cheaper one.
  const named = await trip("Refund names its sale", [
    { ...RC, units: 2 },
    { type: "sale", amount: 3000, units: 1, occurred: "2026-10-03", reference: "ORDER-1" },
    { type: "sale", amount: 2000, units: 1, occurred: "2026-10-04", reference: "ORDER-2" },
    RET("2026-10-05", 1, { reference: "order-1" }),
  ]);
  r = (await detail(named.id)).reconciliation;
  assert.equal(r.pendingPayout, 2000);
  assert.equal(r.refundedUnpaid, 3000);
  // A refund where the buyer kept the item cancels nothing: the sale stands.
  const kept = await trip("Kept before payout", [RC, S("2026-10-03"), KEPT("2026-10-05")]);
  r = (await detail(kept.id)).reconciliation;
  assert.equal(r.pendingPayout, 2500);
  assert.equal(r.refundedUnpaid, 0);
  const oct = await month("2026-10");
  assert.equal(oct.pendingPayouts, 2500 + 2500 + 2500 + 3000 + 2000 + 2500);
  const listed = (await call("GET", "/api/ledger/trips")).body.trips;
  assert.equal(listed.find((x) => x.id === paidFirst.id).pendingPayout, 2500);
});

test("D1 routes: a refund under an order number several sales share is matched among them, so the trade verifies and nothing still to come is hidden", async (t) => {
  const { trip, detail, proof, month } = await api(t);
  // The verifier's case: one order, ORDER-9, of two items recorded as two
  // sales; item 2 comes back and is refunded under ORDER-9, as the refund hint
  // asks; it is sold again; each payout gives its units.
  const order = [
    { type: "receipt", amount: 2000, units: 2, occurred: "2026-10-01" },
    { type: "sale", amount: 3000, units: 1, occurred: "2026-10-03", reference: "ORDER-9", note: "item 1" },
    { type: "sale", amount: 2000, units: 1, occurred: "2026-10-03", reference: "ORDER-9", note: "item 2" },
    { type: "refund", amount: 2000, units: 1, itemReturned: true, occurred: "2026-10-06", reference: "ORDER-9", note: "item 2 back" },
  ];
  const { id, ids } = await trip("Two-item order", [
    ...order,
    { type: "sale", amount: 2000, units: 1, occurred: "2026-10-08", reference: "ORDER-12" },
    { type: "payout", amount: 2700, units: 1, occurred: "2026-10-10" },
    { type: "payout", amount: 1800, units: 1, occurred: "2026-10-12" },
    WORK("2026-10-12", 40),
  ]);
  await proof(id, ids[0], "D1 receipt");
  await proof(id, ids[5], "D1 payout one");
  await proof(id, ids[6], "D1 payout two");
  let r = (await detail(id)).reconciliation;
  assert.deepEqual(r.discrepancies, [], "never payout-above-paid-sales");
  assert.equal(r.verified, true, JSON.stringify(r.verificationMissing));
  assert.equal(r.pendingPayout, 0);
  assert.equal(r.refundedUnpaid, 2000, "item 2, the cheaper of the order's two unpaid items");
  assert.equal(r.impliedFees, 500);
  assert.equal(r.completedOn, "2026-10-12");
  // Before any payout: item 1's £30 is still to come and stays pending.
  const early = await trip("Two-item order, no payout yet", order);
  r = (await detail(early.id)).reconciliation;
  assert.equal(r.pendingPayout, 3000, "never only £20");
  assert.equal(r.refundedUnpaid, 2000);
  // Among the order's sales, paid units first: item 1 paid out, then a refund
  // under ORDER-9 cancels nothing, so item 2 is still to come.
  const paid = await trip("Item 1 paid, then a refund under the order", [
    ...order.slice(0, 3),
    { type: "payout", amount: 2700, units: 1, occurred: "2026-10-04" },
    order[3],
  ]);
  r = (await detail(paid.id)).reconciliation;
  assert.equal(r.pendingPayout, 2000);
  assert.equal(r.refundedUnpaid, 0);
  // A listing id shared by two sales and the refund (verifier A1): matched
  // among those sales, so no false discrepancy.
  const listing = await trip("Listing id", [
    { type: "receipt", amount: 2000, units: 2, occurred: "2026-10-01" },
    { type: "sale", amount: 3000, units: 1, occurred: "2026-10-03", reference: "LISTING-77" },
    { type: "sale", amount: 2000, units: 1, occurred: "2026-10-05", reference: "LISTING-77" },
    { type: "refund", amount: 2000, units: 1, itemReturned: true, occurred: "2026-10-06", reference: " listing-77 " },
    { type: "payout", amount: 2700, units: 1, occurred: "2026-10-10" },
  ]);
  r = (await detail(listing.id)).reconciliation;
  assert.deepEqual(r.discrepancies, []);
  assert.equal(r.pendingPayout, 0);
  assert.equal(r.refundedUnpaid, 2000);
  assert.equal(r.impliedFees, 300);
  // More units refunded than the named sales can take: the rest falls to the
  // other sales by the same rule (here the only one left, ORDER-5).
  const spill = await trip("Refund wider than its order", [
    { type: "receipt", amount: 2000, units: 2, occurred: "2026-10-01" },
    { type: "sale", amount: 3000, units: 1, occurred: "2026-10-03", reference: "ORDER-4" },
    { type: "sale", amount: 2000, units: 1, occurred: "2026-10-03", reference: "ORDER-5" },
    { type: "refund", amount: 5000, units: 2, itemReturned: true, occurred: "2026-10-06", reference: "ORDER-4" },
  ]);
  r = (await detail(spill.id)).reconciliation;
  assert.equal(r.pendingPayout, 0);
  assert.equal(r.refundedUnpaidUnits, 2);
  const oct = await month("2026-10");
  assert.equal(oct.pendingPayouts, 3000 + 2000);
});

test("pending guard routes: a refund never hides a payout still to come", async (t) => {
  const { trip, detail, month } = await api(t);
  const RC2 = { ...RC, amount: 2000, units: 2 };
  // Paid units first (verifier M6): A paid out, B unpaid, then a refund. If
  // it was for A, B's £25 is still to come; taking it as A's hides nothing.
  const paidFirst = await trip("A paid, B unpaid, refund", [RC2, S("2026-10-03"), P("2026-10-04"), S("2026-10-05"), RET("2026-10-06")]);
  let r = (await detail(paidFirst.id)).reconciliation;
  assert.equal(r.pendingPayout, 2500);
  assert.equal(r.refundedUnpaid, 0);
  // Payouts before refunds on one day (verifier M2): the refund is recorded
  // before the payout of the same day. The payout pays the 3 Oct sale; the
  // refund is then for that paid sale, so the 4 Oct sale is still to come.
  const sameDay = await trip("Refund recorded before a same-day payout", [RC2, S("2026-10-03"), S("2026-10-04"), RET("2026-10-05"), P("2026-10-05")]);
  r = (await detail(sameDay.id)).reconciliation;
  assert.equal(r.pendingPayout, 2500);
  assert.equal(r.refundedUnpaid, 0);
  // Only sales dated on or before the refund (verifier M23): a refund on
  // 5 Oct cannot be for the cheaper resale of 8 Oct, which is still to come.
  const later = await trip("Refund before a cheaper resale", [
    RC,
    { type: "sale", amount: 3000, units: 1, occurred: "2026-10-03" },
    { type: "refund", amount: 3000, units: 1, itemReturned: true, occurred: "2026-10-05" },
    { type: "sale", amount: 2000, units: 1, occurred: "2026-10-08" },
  ]);
  r = (await detail(later.id)).reconciliation;
  assert.equal(r.pendingPayout, 2000);
  assert.equal(r.refundedUnpaid, 3000);
  assert.equal((await month("2026-10")).pendingPayouts, 2500 + 2500 + 2000);
});

test("P13 routes: a payout without units covers every sale up to its date, refunded ones included", async (t) => {
  const { trip, detail } = await api(t);
  // The verifier's P13: R5 with a payout that gives no units. Such a payout
  // cannot say which sales it paid, so it is taken to cover every sale up to
  // its date, the refunded one too: nothing is pending or set aside as
  // refunded before payout, and the gap shows as fees (an upper bound: the
  // refunded sale may never have been paid). A payout bigger than the sales
  // left after the refund is then never a false discrepancy.
  const { id } = await trip("R5, payout without units", [RC, S("2026-10-03"), RET("2026-10-05"), S("2026-10-08"), { type: "payout", amount: 2200, occurred: "2026-10-10" }]);
  let r = (await detail(id)).reconciliation;
  assert.equal(r.pendingPayout, 0);
  assert.equal(r.pendingBasis, "dates");
  assert.equal(r.refundedUnpaid, 0);
  assert.equal(r.refundedUnpaidUnits, 0);
  assert.equal(r.impliedFees, 5000 - 2200);
  assert.deepEqual(r.discrepancies, []);
  // The marketplace paid the refunded sale anyway (the seller funded the
  // refund) and no resale yet: £22 against the one sale, with no discrepancy.
  const paidAnyway = await trip("Refunded sale paid anyway", [RC, S("2026-10-03"), RET("2026-10-05"), { type: "payout", amount: 2200, occurred: "2026-10-06" }]);
  r = (await detail(paidAnyway.id)).reconciliation;
  assert.deepEqual(r.discrepancies, []);
  assert.equal(r.impliedFees, 300);
  assert.equal(r.refundedUnpaid, 0);
});

// --- 2. Order within a day and the date the item came back -----------------

test("R2 routes: a same-day resale recorded before its refund is not flagged, and the trade can be verified", async (t) => {
  const { trip, detail, proof } = await api(t);
  const { id, ids } = await trip("Same day out of order", [RC, S("2026-10-03"), S("2026-10-05"), RET("2026-10-05"), P("2026-10-06", 2)]);
  let d = await detail(id);
  assert.deepEqual(d.reconciliation.discrepancies, []);
  assert.equal(d.reconciliation.unsoldUnits, 0);
  assert.equal(d.reconciliation.pendingPayout, 0);
  await proof(id, ids[0], "R2 receipt");
  await proof(id, ids[4], "R2 payout");
  d = await detail(id);
  assert.equal(d.reconciliation.verified, true, JSON.stringify(d.reconciliation.verificationMissing));
});

test("R2 routes: a day only some order other than first-come explains is not flagged", async (t) => {
  const { trip, detail, proof } = await api(t);
  // The verifier's S3: 2 on hand; on one day, in entry order, a sale of 1, a
  // sale of 2 and a return of 2. The sale of 2, its return, then the sale of
  // 1 works. Placing the first entry that fits takes the sale of 1 first and
  // gets stuck, which would be a false flag on a valid trade.
  const { id, ids } = await trip("Only a search finds the order", [
    { ...RC, amount: 2000, units: 2 },
    S("2026-10-05"),
    { type: "sale", amount: 5000, units: 2, occurred: "2026-10-05" },
    RET("2026-10-05", 2, { amount: 5000 }),
    P("2026-10-07", 1),
  ]);
  let d = await detail(id);
  assert.deepEqual(d.reconciliation.discrepancies, []);
  assert.equal(d.reconciliation.unsoldUnits, 1);
  await proof(id, ids[0], "S3 receipt");
  await proof(id, ids[4], "S3 payout");
  d = await detail(id);
  assert.equal(d.reconciliation.verified, true, JSON.stringify(d.reconciliation.verificationMissing));
});

test("R3 routes: a resale before the refund is flagged until the date the item came back is given", async (t) => {
  const { trip, detail, call, db } = await api(t);
  // The verifier's case exactly: item back and resold on 6 Oct, refund paid on 7 Oct.
  const plain = await trip("Refund later", [RC, S("2026-10-03"), S("2026-10-06"), RET("2026-10-07"), P("2026-10-08", 2)]);
  let d = await detail(plain.id);
  assert.deepEqual(codes(d), ["sold-above-bought"], "the records say the stock came back on the 7th");
  assert.match(
    d.reconciliation.discrepancies[0].message,
    /^The sale on 6 Oct 2026 is for 1 unit, but none was in stock at that point .* remove that refund and record it again with the date the item came back\.$/,
  );
  // The same trip with the date the item came back reconciles.
  const dated = await trip("Refund later, date given", [
    RC,
    S("2026-10-03"),
    S("2026-10-06"),
    RET("2026-10-07", 1, { returnedOn: "2026-10-06" }),
    P("2026-10-08", 2),
  ]);
  d = await detail(dated.id);
  assert.deepEqual(d.reconciliation.discrepancies, []);
  assert.equal(d.reconciliation.pendingPayout, 0);
  const refund = d.entries.find((e) => e.id === dated.ids[3]);
  assert.equal(refund.returnedOn, "2026-10-06");
  assert.equal(refund.occurred, "2026-10-07", "the money keeps the refund's date");
  assert.equal(d.entries.find((e) => e.type === "sale").returnedOn, null);
  // A date the item came back after the resale is used too: stock was not back yet.
  const lateBack = await trip("Back after the resale", [RC, S("2026-10-03"), RET("2026-10-05", 1, { returnedOn: "2026-10-09" }), S("2026-10-07")]);
  assert.deepEqual(codes(await detail(lateBack.id)), ["sold-above-bought"]);

  // Validation.
  const post = (body) => call("POST", `/api/ledger/trips/${plain.id}/entries`, { amount: 500, occurred: "2026-10-09", ...body });
  let res = await post({ type: "refund", itemReturned: false, returnedOn: "2026-10-08" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Leave the date the item came back empty when the buyer kept the item/);
  res = await post({ type: "sale", units: 1, returnedOn: "2026-10-08" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /^The date the item came back applies to refund entries only/);
  res = await post({ type: "refund", units: 1, returnedOn: "2026-11-01" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /^The date the item came back cannot be in the future/);
  for (const bad of ["2026-02-30", "8 Oct", 20261008, "1999-12-31"]) {
    res = await post({ type: "refund", units: 1, returnedOn: bad });
    assert.equal(res.status, 400, String(bad));
    assert.match(res.body.error, /^The date the item came back must be /);
  }
  // Left out, or empty, as before: no date stored.
  res = await post({ type: "refund", units: 1, itemReturned: true, returnedOn: "" });
  assert.equal(res.status, 201);
  assert.equal(res.body.entries.find((e) => e.id === res.body.id).returnedOn, null);
  // Removing the refund removes its date with it.
  assert.equal((await call("DELETE", `/api/ledger/trips/${dated.id}/entries/${dated.ids[3]}`, {})).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_refund_returns WHERE entry_id = ?").get(dated.ids[3]).n, 0);
});

test("R3 advice routes: an open trip is told to remove the refund and record it again with the date the item came back, and a closed trip that its entries cannot change", async (t) => {
  const { trip, detail, call } = await api(t);
  const R3 = [RC, S("2026-10-03"), S("2026-10-06"), RET("2026-10-07"), P("2026-10-08", 2)];
  const facts =
    "The sale on 6 Oct 2026 is for 1 unit, but none was in stock at that point " +
    "(units bought, less units sold, plus units buyers sent back).";
  // Open: no entry can be edited (there is no route for it), so the date the
  // item came back is given by removing the refund and recording it again.
  const open = await trip("Resold before the refund", R3);
  let d = await detail(open.id);
  assert.deepEqual(d.reconciliation.discrepancies, [
    {
      code: "sold-above-bought",
      message:
        facts +
        " Check the units, or record the purchase or the return the stock came from." +
        " If an item a buyer sent back came back before its refund was paid, remove that refund and record it again with the date the item came back.",
    },
  ]);
  assert.equal((await call("PATCH", `/api/ledger/trips/${open.id}/entries/${open.ids[3]}`, { returnedOn: "2026-10-06" })).status, 405, "no entry can be edited");
  // Doing what it says clears the flag.
  assert.equal((await call("DELETE", `/api/ledger/trips/${open.id}/entries/${open.ids[3]}`, {})).status, 200);
  assert.equal((await call("POST", `/api/ledger/trips/${open.id}/entries`, RET("2026-10-07", 1, { returnedOn: "2026-10-06" }))).status, 201);
  d = await detail(open.id);
  assert.deepEqual(d.reconciliation.discrepancies, []);

  // Closed: nothing can change, so it is told so and given no advice to change anything.
  const closed = await trip("Resold before the refund, closed", R3, { close: true });
  d = await detail(closed.id);
  const closedMessage = facts + " The trip is closed, so its entries cannot change.";
  assert.deepEqual(d.reconciliation.discrepancies, [{ code: "sold-above-bought", message: closedMessage }]);
  assert.ok(d.reconciliation.verificationMissing.includes("Records do not reconcile: " + closedMessage), JSON.stringify(d.reconciliation.verificationMissing));
  assert.equal((await call("DELETE", `/api/ledger/trips/${closed.id}/entries/${closed.ids[3]}`, {})).status, 409, "a closed trip's entries cannot be removed");
  assert.equal((await call("POST", `/api/ledger/trips/${closed.id}/entries`, RC)).status, 409, "nor added to");

  // With no later refund to redate, an open trip keeps the advice to check
  // its units or record what is missing, and a closed one is told it is closed.
  const kept = [RC, S("2026-10-03"), KEPT("2026-10-05"), S("2026-10-05")];
  const keptFacts = facts.replace("6 Oct", "5 Oct");
  d = await detail((await trip("Genuine oversale, open", kept)).id);
  assert.equal(d.reconciliation.discrepancies[0].message, keptFacts + " Check the units, or record the purchase or the return the stock came from.");
  d = await detail((await trip("Genuine oversale, closed", kept, { close: true })).id);
  assert.equal(d.reconciliation.discrepancies[0].message, keptFacts + " The trip is closed, so its entries cannot change.");
});

test("plain words routes: every message for the date the item came back, or whether the buyer sent it back, names it in words", async (t) => {
  const { trip, call } = await api(t);
  const { id } = await trip("Checks", [RC, S("2026-10-03")]);
  const post = (body) => call("POST", `/api/ledger/trips/${id}/entries`, { amount: 500, occurred: "2026-10-09", ...body });
  const refused = async (body, message) => {
    const res = await post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error, message, JSON.stringify(body));
    assert.doesNotMatch(res.body.error, /returnedOn|itemReturned|returned_on/, "no field names");
  };
  const back = (returnedOn) => ({ type: "refund", units: 1, itemReturned: true, returnedOn });
  // The verifier's case: a date back before 2000.
  await refused(back("1999-12-31"), "The date the item came back must be on or after 2000-01-01");
  await refused(back("2026-11-01"), "The date the item came back cannot be in the future");
  for (const bad of ["2026-02-30", "6 Oct", 20261006])
    await refused(back(bad), "The date the item came back must be a calendar date (YYYY-MM-DD)");
  await refused(
    { type: "sale", units: 1, returnedOn: "2026-10-08" },
    "The date the item came back applies to refund entries only: the day an item a buyer sent back reached you.",
  );
  await refused(
    { type: "refund", itemReturned: false, returnedOn: "2026-10-08" },
    "Leave the date the item came back empty when the buyer kept the item: nothing came back.",
  );
  // The other new refund messages from round five.
  await refused({ type: "expense", itemReturned: false }, "Whether the buyer sent the item back applies to refund entries only.");
  await refused({ type: "refund", units: 1, itemReturned: "no" }, "Whether the buyer sent the item back must be true or false");
  await refused(
    { type: "refund", itemReturned: false, units: 1 },
    "Leave units empty when the buyer keeps the item: no stock comes back. Units are for items sent back to you.",
  );
  // The floor itself is a date the item can come back on (the form's min).
  const res = await post(back("2000-01-01"));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.entries.find((e) => e.id === res.body.id).returnedOn, "2000-01-01");
});

test("oversale control routes: a sale no order of the day can cover is still flagged", async (t) => {
  const { trip, detail } = await api(t);
  // The buyer kept the item, and the second sale is on the refund's day:
  // whatever the order, nothing came back to sell.
  const kept = await trip("Genuine oversale", [RC, S("2026-10-03"), KEPT("2026-10-05"), S("2026-10-05")]);
  let d = await detail(kept.id);
  assert.deepEqual(codes(d), ["sold-above-bought"]);
  assert.match(d.reconciliation.discrepancies[0].message, /^The sale on 5 Oct 2026 is for 1 unit, but none was in stock at that point/);
  assert.equal(d.reconciliation.verified, false);
  // Totals that agree but no order that works: 1 on hand and 1 out, a sale
  // of 3 and a return of 3 on one day (each needs the other first).
  const sizes = await trip("No order works", [
    { ...RC, units: 2 },
    S("2026-10-02"),
    { type: "sale", amount: 7500, units: 3, occurred: "2026-10-04" },
    RET("2026-10-04", 3),
  ]);
  d = await detail(sizes.id);
  assert.deepEqual(codes(d), ["sold-above-bought"]);
  assert.match(d.reconciliation.discrepancies[0].message, /is for 3 units, but only 1 unit was in stock at that point/);
  // A return with nothing sold that day or before is still flagged, whatever the order.
  const early = await trip("Return first", [RC, RET("2026-10-02"), S("2026-10-03")]);
  d = await detail(early.id);
  assert.deepEqual(codes(d), ["returned-above-sold"]);
  assert.match(d.reconciliation.discrepancies[0].message, /^The refund on 2 Oct 2026 says 1 unit came back, but no units had been sold/);
  // And a return dated before the sale it came from, by its date back.
  const backFirst = await trip("Back before sold", [RC, S("2026-10-04"), RET("2026-10-06", 1, { returnedOn: "2026-10-03" })]);
  d = await detail(backFirst.id);
  assert.deepEqual(codes(d), ["returned-above-sold"]);
  assert.match(d.reconciliation.discrepancies[0].message, /^The refund on 6 Oct 2026 \(item back on 3 Oct 2026\) says 1 unit came back/);
});

test("S6 routes: when no order of a day works and a sale and a return are both left over, the sale is flagged", async (t) => {
  const { trip, detail } = await api(t);
  // The verifier's S6: 1 unit out and none on hand; on 5 Oct a return of 2
  // and a sale of 2. Neither can go first. The sale is flagged (applied as
  // far as it can go), and the return then fits, so it is not flagged too.
  const { id } = await trip("Return and sale both stuck", [
    RC,
    S("2026-10-02"),
    RET("2026-10-05", 2, { amount: 5000 }),
    { type: "sale", amount: 5000, units: 2, occurred: "2026-10-05" },
  ]);
  const d = await detail(id);
  assert.deepEqual(codes(d), ["sold-above-bought"]);
  assert.match(d.reconciliation.discrepancies[0].message, /^The sale on 5 Oct 2026 is for 2 units, but none was in stock at that point/);
});

test("stock walk: one day's sales and returns are judged in every order", () => {
  let id = 1;
  const e = (type, occurred, units, extra = {}) => ({ id: id++, type, amount: 1000, occurred, units, ...extra });
  // Out of entry order on one day: the return first explains it.
  assert.equal(stockWalk([e("receipt", "2026-10-01", 1), e("sale", "2026-10-03", 1), e("sale", "2026-10-05", 1), e("refund", "2026-10-05", 1)]).short, null);
  // A return recorded before the sale it came from, on one day.
  assert.equal(stockWalk([e("receipt", "2026-10-01", 1), e("refund", "2026-10-03", 1), e("sale", "2026-10-03", 1)]).overReturned, null);
  // Several of each on one day in a scrambled order.
  const scrambled = [e("receipt", "2026-10-01", 1), e("sale", "2026-10-05", 1), e("sale", "2026-10-05", 1), e("sale", "2026-10-05", 1), e("refund", "2026-10-05", 1), e("refund", "2026-10-05", 1)];
  const walk = stockWalk(scrambled);
  assert.equal(walk.short, null);
  assert.equal(walk.overReturned, null);
  assert.equal(walk.onHand, 0);
  // One too many: flagged once, naming a sale.
  const tooMany = stockWalk([...scrambled, e("sale", "2026-10-05", 1)]);
  assert.equal(tooMany.shortSales, 1);
  assert.equal(tooMany.short.units, 1);
  // Many movements on one day (beyond trying every order): judged on totals.
  const many = [e("receipt", "2026-10-01", 1)];
  for (let i = 0; i < 8; i++) many.push(e("sale", "2026-10-05", 1), e("refund", "2026-10-05", 1));
  assert.equal(stockWalk(many).short, null);
  assert.equal(stockWalk([...many, e("sale", "2026-10-05", 1), e("sale", "2026-10-05", 1)]).shortSales > 0, true);
  // A kept refund (no units) moves no stock.
  assert.notEqual(stockWalk([e("receipt", "2026-10-01", 1), e("sale", "2026-10-02", 1), e("refund", "2026-10-03", null), e("sale", "2026-10-03", 1)]).short, null);
});

test("stock walk: above 12 movements in a day, a day with nothing on hand or out is flagged, and an order only a search finds is accepted", async (t) => {
  let id = 1;
  const e = (type, occurred, units) => ({ id: id++, type, amount: 100, occurred, units });
  // Verifier A12: 7 sales and 7 returns of 1 on a day with nothing on hand or
  // out before it. The totals agree, but no first movement can go. (Named
  // "the totals rule needs stock on hand or out" in the second pass; since
  // the third pass such a day is judged by the counted search.)
  const empty = [];
  for (let i = 0; i < 7; i++) empty.push(e("sale", "2026-10-05", 1), e("refund", "2026-10-05", 1));
  const walk = stockWalk(empty);
  assert.notEqual(walk.short, null);
  assert.equal(walk.short.onHand, 0);
  assert.equal(walk.shortSales, 1);
  // Through the routes, with the purchase recorded the day after.
  const { trip, detail } = await api(t);
  const late = await trip("Many moves before any stock", [
    ...empty.map(({ type, occurred, units }) =>
      type === "sale" ? { type, amount: 2500, units, occurred } : { type, amount: 2500, units, itemReturned: true, occurred }),
    { ...RC, occurred: "2026-10-06" },
  ]);
  assert.deepEqual(codes(await detail(late.id)), ["sold-above-bought", "sale-before-receipt"]);
  // With 1 on hand the same day reconciles (one unit sold and back, seven times).
  const stocked = await trip("Many moves with stock", [RC, ...empty.map(({ type, occurred, units }) =>
    type === "sale" ? { type, amount: 2500, units, occurred } : { type, amount: 2500, units, itemReturned: true, occurred })]);
  assert.deepEqual(codes(await detail(stocked.id)), []);
  // 13 movements where placing the first that fits gets stuck but an order
  // exists: 2 on hand; a sale of 1 first leaves the sale of 2 and the return
  // of 2 unable to go, while sale 2, return 2, ..., sale 1 works.
  const stuck = [e("receipt", "2026-10-01", 2), e("sale", "2026-10-05", 1), e("sale", "2026-10-05", 2), e("refund", "2026-10-05", 2)];
  for (let i = 0; i < 5; i++) stuck.push(e("sale", "2026-10-05", 2), e("refund", "2026-10-05", 2));
  const ok = stockWalk(stuck);
  assert.equal(ok.short, null);
  assert.equal(ok.overReturned, null);
  assert.equal(ok.onHand, 1);
});

test("stock walk: above 12 movements in a day, every count of each kind and size is tried, so a day no order explains is flagged", async (t) => {
  let id = 1;
  const e = (type, occurred, units) => ({ id: id++, type, amount: 100, occurred, units });
  // The verifier's S2: bought 1; on 5 Oct a sale of 2, a return of 2, 6 sales
  // of 1 and 5 returns of 1 (13 movements). Stock on hand and out together is
  // 1 all day, so the sale of 2 can never go, whatever the order.
  const day = [e("receipt", "2026-10-01", 1), e("sale", "2026-10-05", 2), e("refund", "2026-10-05", 2)];
  for (let i = 0; i < 6; i++) day.push(e("sale", "2026-10-05", 1));
  for (let i = 0; i < 5; i++) day.push(e("refund", "2026-10-05", 1));
  const walk = stockWalk(day);
  assert.equal(walk.shortSales, 1);
  assert.equal(walk.short.units, 2);
  assert.equal(walk.short.onHand, 0);
  assert.equal(walk.overReturned, null);
  const { trip, detail } = await api(t);
  const entries = [RC, { type: "sale", amount: 5000, units: 2, occurred: "2026-10-05" }, RET("2026-10-05", 2, { amount: 5000 })];
  for (let i = 0; i < 6; i++) entries.push(S("2026-10-05"));
  for (let i = 0; i < 5; i++) entries.push(RET("2026-10-05"));
  const d = await detail((await trip("13 moves, a sale of 2 with 1 bought", entries)).id);
  assert.deepEqual(codes(d), ["sold-above-bought"]);
  assert.match(d.reconciliation.discrepancies[0].message, /^The sale on 5 Oct 2026 is for 2 units, but none was in stock at that point/);
  // With 2 bought the same day works: the sale of 2, its return, then the rest.
  assert.equal(stockWalk([e("receipt", "2026-10-01", 2), ...day.slice(1)]).short, null);
  // Every movement within stock and the totals agreeing is not enough: bought
  // 3, then 8 sales of 2 and 5 returns of 3. After the first sale 2 are out
  // and 1 is on hand, so no sale of 2 and no return of 3 can go next.
  const sizes = [e("receipt", "2026-10-01", 3)];
  for (let i = 0; i < 8; i++) sizes.push(e("sale", "2026-10-05", 2));
  for (let i = 0; i < 5; i++) sizes.push(e("refund", "2026-10-05", 3));
  const stuck = stockWalk(sizes);
  assert.notEqual(stuck.short, null, "the totals rule would accept this day");
  assert.equal(stuck.short.units, 2);
  assert.equal(stuck.short.onHand, 1);
  // Movements in so many sizes that the combinations are not all tried (17
  // or more kinds and sizes): judged on the totals, which never accept a
  // movement bigger than all the stock on hand and out (a sale of 60 with
  // 50 bought), and accept a day within stock whose totals agree.
  const varied = [e("receipt", "2026-10-01", 50), e("sale", "2026-10-05", 60), e("refund", "2026-10-05", 60)];
  for (let u = 1; u <= 16; u++) varied.push(e("sale", "2026-10-05", u));
  for (let u = 1; u <= 15; u++) varied.push(e("refund", "2026-10-05", u));
  const tooBig = stockWalk(varied);
  assert.notEqual(tooBig.short, null, "a sale of 60 with 50 bought");
  assert.equal(tooBig.short.units, 60);
  // Every movement within stock, but more sold (45) than the stock and the
  // day's returns (5 + 30): flagged on its totals.
  const over = [e("receipt", "2026-10-01", 5)];
  for (let r = 0; r < 3; r++) for (let u = 1; u <= 5; u++) over.push(e("sale", "2026-10-05", u));
  for (let r = 0; r < 2; r++) for (let u = 1; u <= 5; u++) over.push(e("refund", "2026-10-05", u));
  assert.ok(stockWalk(over).shortSales > 0, "45 sold against 5 bought and 30 back");
  // Too many to count in few sizes (the verifier's S3 day with 261 more sales
  // and returns of 2): the totals allow it, so it is accepted, though placing
  // the first entry that fits would take the sale of 1 first and get stuck.
  const long = [e("receipt", "2026-10-01", 2), e("sale", "2026-10-05", 1), e("sale", "2026-10-05", 2), e("refund", "2026-10-05", 2)];
  for (let i = 0; i < 261; i++) long.push(e("sale", "2026-10-05", 2), e("refund", "2026-10-05", 2));
  const longWalk = stockWalk(long);
  assert.equal(longWalk.short, null);
  assert.equal(longWalk.overReturned, null);
  assert.equal(longWalk.onHand, 1);
  const within = [e("receipt", "2026-10-01", 100)];
  for (let u = 1; u <= 9; u++) within.push(e("sale", "2026-10-05", u));
  for (let u = 1; u <= 8; u++) within.push(e("refund", "2026-10-05", u));
  const fine = stockWalk(within);
  assert.equal(fine.short, null);
  assert.equal(fine.overReturned, null);
  assert.equal(fine.onHand, 100 - 45 + 36);
});

// --- 3. Earnings per hour without a purchase -------------------------------

test("L6 routes: a trip that sold stock with no purchase receipt is left out of earnings per hour and named", async (t) => {
  const { trip, detail, month, call } = await api(t);
  // The verifier's case: a sale, a payout and 30 minutes, no receipt; open, then the same trip closed.
  const entries = [
    { type: "sale", amount: 20000, units: 1, occurred: "2026-10-02" },
    { type: "payout", amount: 18000, units: 1, occurred: "2026-10-04" },
    WORK("2026-10-04", 30),
  ];
  const open = await trip("No receipt", entries);
  let oct = await month("2026-10");
  assert.equal(oct.realisedHourly, null);
  assert.equal(oct.hourly.stillOpen, 1);
  const closed = await trip("No receipt closed", entries, { close: true });
  oct = await month("2026-10");
  assert.equal(oct.realisedEarnings, 36000, "cash is still cash");
  assert.equal(oct.realisedHourly, null, "never £360 an hour");
  assert.equal(oct.hourly.trips, 0);
  assert.equal(oct.hourly.stillOpen, 1);
  assert.deepEqual(oct.hourlyNoPurchase, { trips: 1, earnings: 18000, open: 0, openNoWork: 0, countedTrips: 0, countedEarnings: 0 });
  assert.match(oct.basis, /sold stock with no purchase recorded for it are left out too/);
  const m = (await call("GET", "/api/ledger/metrics")).body;
  assert.equal(m.closedTrips, 1);
  assert.equal(m.hourly.realised, null);
  assert.equal(m.hourly.trips, 0);
  assert.equal(m.hourly.noPurchaseTrips, 1);
  assert.equal(m.hourly.noPurchaseEarnings, 18000);
  assert.equal(m.hourly.noPurchaseCountedTrips, 0);
  for (const id of [open.id, closed.id]) {
    const r = (await detail(id)).reconciliation;
    assert.equal(r.purchaseMissing, true);
    assert.equal(r.realisedHourly, null);
  }
  // With the purchase recorded on an open trip it counts.
  const bought = await trip("Receipt recorded", [{ type: "receipt", amount: 6000, units: 1, occurred: "2026-10-01" }, ...entries]);
  oct = await month("2026-10");
  assert.equal(oct.hourly.trips, 1);
  assert.equal(oct.realisedHourly, Math.round(((18000 - 6000) * 60) / 30));
  assert.equal((await detail(bought.id)).reconciliation.purchaseMissing, false);
});

test("earnings per hour: a part-recorded purchase is left out, a wasted trip still counts", async (t) => {
  const { trip, month, call } = await api(t);
  // Bought 1, sold 2 (the buyer kept the first): the second unit's cost is not recorded.
  await trip("Sold more than bought", [RC, S("2026-10-03"), P("2026-10-04"), KEPT("2026-10-05"), S("2026-10-06"), P("2026-10-07"), WORK("2026-10-07", 30)], { close: true });
  // Nothing bought or sold: an hour for nothing still lowers the figure.
  await trip("Wasted journey", [WORK("2026-10-10", 60), { type: "expense", amount: 400, occurred: "2026-10-10" }], { close: true });
  const oct = await month("2026-10");
  // It earned more per hour than the wasted trip, so counting it would raise the figure.
  assert.deepEqual(oct.hourlyNoPurchase, { trips: 1, earnings: 4400 - 1000 - 2500, open: 0, openNoWork: 0, countedTrips: 0, countedEarnings: 0 });
  assert.equal(oct.hourly.trips, 1);
  assert.equal(oct.realisedHourly, -400);
  const m = (await call("GET", "/api/ledger/metrics")).body;
  assert.equal(m.hourly.trips, 1);
  assert.equal(m.hourly.realised, -400);
  assert.equal(m.hourly.noPurchaseTrips, 1);
});

// A closed resale trip with only a sale, a payout and work time (no receipt).
const noReceipt = (sale, payout, day, minutes, extra = []) => [
  { type: "sale", amount: sale, units: 1, occurred: "2026-10-" + day },
  { type: "payout", amount: payout, units: 1, occurred: "2026-10-" + day },
  ...extra,
  WORK("2026-10-" + day, minutes),
];
// +£20 over 60 minutes, with its purchase recorded.
const MEASURED = [RC, { type: "sale", amount: 3500, units: 1, occurred: "2026-10-02" }, { type: "payout", amount: 3000, units: 1, occurred: "2026-10-04" }, WORK("2026-10-04", 60)];

test("D2 routes: legacy totals record their costs, so they keep counting in the month's earnings per hour", async (t) => {
  // The verifier's A3: a legacy outcome dated 15 Oct 2026, received £50,
  // total actual costs £80, 60 minutes, and one measured trip.
  const { trip, detail, month, call } = await api(t, OCTOBER_END, (d) => {
    d.exec("CREATE TABLE outcomes (id INTEGER PRIMARY KEY, sku TEXT, received INTEGER, costs INTEGER, minutes INTEGER, created TEXT)");
    d.prepare("INSERT INTO outcomes (id, sku, received, costs, minutes, created) VALUES (1, 'SKU-1', 5000, 8000, 60, '2026-10-15 10:00:00')").run();
  });
  await trip("Measured", MEASURED, { close: true });
  const oct = await month("2026-10");
  assert.equal(oct.realisedHourly, -500, "(£20 - £30) over 2 hours: the legacy loss counts");
  assert.equal(oct.hourly.trips, 2);
  assert.equal(oct.hourlyNoPurchase.trips, 0);
  assert.equal(oct.hourlyNoPurchase.countedTrips, 0);
  const legacy = (await call("GET", "/api/ledger/trips")).body.trips.find((x) => x.source === "legacy");
  const r = (await detail(legacy.id)).reconciliation;
  assert.equal(r.purchaseMissing, false);
  assert.equal(r.realisedHourly, -3000);
  // The measures leave legacy totals out as before (they cannot be reconciled).
  const m = (await call("GET", "/api/ledger/metrics")).body;
  assert.equal(m.legacyTrips, 1);
  assert.equal(m.hourly.trips, 1);
  assert.equal(m.hourly.noPurchaseTrips, 0);
});

test("D3 routes: a no-purchase trip counts where its recorded result lowers earnings per hour, and is left out where it would raise them", async (t) => {
  {
    const { trip, detail, month, call } = await api(t);
    // The verifier's A4: the measured trip and a closed no-receipt trip that
    // lost money (the buyer kept the item after a full refund), 60 minutes.
    await trip("Measured", MEASURED, { close: true });
    const loss = await trip("No receipt, loss", noReceipt(10000, 9000, "08", 60, [{ type: "refund", amount: 10000, itemReturned: false, occurred: "2026-10-08" }]), { close: true });
    let oct = await month("2026-10");
    assert.equal(oct.realisedHourly, 500, "(£20 - £10) over 2 hours, never £20.00");
    assert.deepEqual(
      { trips: oct.hourly.trips, minutes: oct.hourly.minutes, earnings: oct.hourly.earnings },
      { trips: 2, minutes: 120, earnings: 1000 },
    );
    assert.deepEqual(oct.hourlyNoPurchase, { trips: 0, earnings: 0, open: 0, openNoWork: 0, countedTrips: 1, countedEarnings: -1000 });
    let m = (await call("GET", "/api/ledger/metrics")).body;
    assert.equal(m.hourly.realised, 500);
    assert.equal(m.hourly.trips, 2);
    assert.equal(m.hourly.noPurchaseCountedTrips, 1);
    assert.equal(m.hourly.noPurchaseCountedEarnings, -1000);
    assert.equal(m.hourly.noPurchaseTrips, 0);
    assert.equal(m.hourly.comparison.trips, 0);
    const r = (await detail(loss.id)).reconciliation;
    assert.equal(r.purchaseMissing, true);
    assert.equal(r.realisedHourly, null, "its own figure is still not known");
    // L6 in the same month: counting its gain would raise the figure, so it is left out.
    await trip("No receipt, gain", noReceipt(20000, 18000, "14", 30), { close: true });
    oct = await month("2026-10");
    assert.equal(oct.realisedHourly, 500);
    assert.deepEqual(oct.hourlyNoPurchase, { trips: 1, earnings: 18000, open: 0, openNoWork: 0, countedTrips: 1, countedEarnings: -1000 });
    m = (await call("GET", "/api/ledger/metrics")).body;
    assert.equal(m.hourly.realised, 500);
    assert.equal(m.hourly.noPurchaseTrips, 1);
    assert.equal(m.hourly.noPurchaseEarnings, 18000);
  }
  {
    // Lowest first: +£15 over an hour is below the measured £20 an hour, but
    // once a -£60 hour is counted it would raise the figure, so it is left
    // out. Recorded in the other order, so entry order would give -£8.33.
    const { trip, month, call } = await api(t);
    await trip("Measured", MEASURED, { close: true });
    await trip("No receipt, small gain", noReceipt(1700, 1500, "10", 60), { close: true });
    await trip("No receipt, big loss", noReceipt(10000, 4000, "12", 60, [{ type: "refund", amount: 10000, itemReturned: false, occurred: "2026-10-12" }]), { close: true });
    const oct = await month("2026-10");
    assert.equal(oct.realisedHourly, -2000);
    assert.deepEqual(oct.hourlyNoPurchase, { trips: 1, earnings: 1500, open: 0, openNoWork: 0, countedTrips: 1, countedEarnings: -6000 });
    assert.equal((await call("GET", "/api/ledger/metrics")).body.hourly.realised, -2000);
  }
  {
    // With no measured trip there is no figure to lower: not known, and named.
    // An open trip completed with part of its purchase missing is named as
    // open, so its receipt can still be added.
    const { trip, month, call } = await api(t);
    await trip("No receipt, loss", noReceipt(10000, 9000, "08", 60, [{ type: "refund", amount: 10000, itemReturned: false, occurred: "2026-10-08" }]), { close: true });
    await trip("Sold more than bought, open", [RC, S("2026-10-03"), P("2026-10-04"), KEPT("2026-10-05"), S("2026-10-06"), P("2026-10-07"), WORK("2026-10-07", 30)]);
    const oct = await month("2026-10");
    assert.equal(oct.realisedHourly, null);
    assert.equal(oct.hourly.trips, 0);
    assert.deepEqual(oct.hourlyNoPurchase, { trips: 2, earnings: -1000 + 900, open: 1, openNoWork: 0, countedTrips: 0, countedEarnings: 0 });
    const m = (await call("GET", "/api/ledger/metrics")).body;
    assert.equal(m.hourly.realised, null);
    assert.equal(m.hourly.noPurchaseTrips, 1, "closed trips only");
  }
  // The rule on its own: none counted without a base; no work time is never counted.
  assert.deepEqual(ledger.countWhereLower({ minutes: 0, earnings: 0 }, [{ minutes: 60, earnings: -100 }]).counted, []);
  assert.deepEqual(ledger.countWhereLower({ minutes: 60, earnings: 1000 }, [{ minutes: 0, earnings: -500 }]).leftOut, [{ minutes: 0, earnings: -500 }]);
  assert.deepEqual(ledger.countWhereLower({ minutes: 60, earnings: 1000 }, [{ minutes: 60, earnings: 1000 }]).counted, [], "an equal rate changes nothing");
});

test("E1 routes: an open trip left out for stock with no purchase recorded is named as having no work time, and counts once both are recorded", async (t) => {
  const { trip, month, call } = await api(t);
  // The verifier's E1: the measured trip (+£20 over an hour) and an open trip
  // that bought 1, sold it, refunded a buyer who kept it, sold again and was
  // paid out twice, with no work recorded. It completes with part of its
  // purchase missing and no work time, so recording the purchase alone can
  // never count it: trips without work time stay out whatever they bought.
  await trip("Measured", MEASURED, { close: true });
  const partNoWork = [RC, S("2026-10-03"), P("2026-10-04"), KEPT("2026-10-05"), S("2026-10-06"), P("2026-10-08")];
  const e1 = await trip("Part bought, no work time", partNoWork);
  let oct = await month("2026-10");
  assert.equal(oct.realisedHourly, 2000);
  assert.deepEqual(oct.hourlyNoPurchase, { trips: 1, earnings: 900, open: 1, openNoWork: 1, countedTrips: 0, countedEarnings: 0 });
  // A second open one with 10 minutes of work: £54 an hour would raise the
  // figure, so it is left out, and it is not counted as having no work time.
  await trip("Part bought, with work time", [...partNoWork, WORK("2026-10-08", 10)]);
  oct = await month("2026-10");
  assert.deepEqual(oct.hourlyNoPurchase, { trips: 2, earnings: 1800, open: 2, openNoWork: 1, countedTrips: 0, countedEarnings: 0 });
  // A closed one without work time is left out too, but it is not open: its
  // entries can no longer be added, so it is not counted as open.
  await trip("No receipt, no work time, closed", [S("2026-10-09"), P("2026-10-10")], { close: true });
  oct = await month("2026-10");
  assert.deepEqual(oct.hourlyNoPurchase, { trips: 3, earnings: 4000, open: 2, openNoWork: 1, countedTrips: 0, countedEarnings: 0 });
  // The purchase of the second unit alone: the trip is then left out for
  // having no work time, as every such trip is.
  await call("POST", `/api/ledger/trips/${e1.id}/entries`, { ...RC, occurred: "2026-10-06" });
  oct = await month("2026-10");
  assert.equal(oct.realisedHourly, 2000);
  assert.equal(oct.hourly.leftOutTrips, 1);
  assert.deepEqual(oct.hourlyNoPurchase, { trips: 2, earnings: 900 + 2200, open: 1, openNoWork: 0, countedTrips: 0, countedEarnings: 0 });
  // With its work time too, it counts: (£20 + £44 - £20 - £25) over 90 minutes.
  await call("POST", `/api/ledger/trips/${e1.id}/entries`, WORK("2026-10-08", 30));
  oct = await month("2026-10");
  assert.equal(oct.hourly.trips, 2);
  assert.equal(oct.hourly.leftOutTrips, 0);
  assert.equal(oct.realisedHourly, Math.round(((2000 + 4400 - 2000 - 2500) * 60) / 90));
});

test("E14 routes: the measures' comparison with predictions leaves out a trip that sold stock with no purchase recorded", async (t) => {
  const { call } = await api(t);
  // The verifier's E14: a closed, predicted trip with its purchase (+£20 over
  // an hour) and a closed, predicted trip with no purchase receipt (+£180
  // over 30 minutes). The second one's realised figure is not known, so the
  // comparison of realised with predicted per hour leaves it out.
  const predicted = { units: 1, proceeds: 3000, contribution: 1000, cashRequired: 1000, activeMinutes: 60, sample: false };
  for (const [label, entries] of [
    ["Measured, predicted", MEASURED],
    ["No receipt, predicted", noReceipt(20000, 18000, "04", 30)],
  ]) {
    const id = (await call("POST", "/api/ledger/trips", { label, kind: "resale", source: "research", predicted })).body.id;
    for (const body of entries) assert.equal((await call("POST", `/api/ledger/trips/${id}/entries`, body)).status, 201);
    assert.equal((await call("POST", `/api/ledger/trips/${id}/close`, {})).status, 200);
  }
  const m = (await call("GET", "/api/ledger/metrics")).body;
  assert.deepEqual(m.hourly.comparison, { trips: 1, realised: 2000, predicted: 1000 });
  assert.equal(m.hourly.realised, 2000);
  assert.equal(m.hourly.noPurchaseTrips, 1);
});

// --- Storage: older databases ------------------------------------------------

// The ledger tables as the round-five commit (fc02d8a) left them.
const SCHEMA_FC02D8A = [
  "CREATE TABLE ledger_trips (id INTEGER PRIMARY KEY, label TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, reference TEXT, predicted TEXT, status TEXT NOT NULL DEFAULT 'open', created TEXT NOT NULL, closed_at TEXT)",
  "CREATE TABLE ledger_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, trip_id INTEGER NOT NULL REFERENCES ledger_trips(id), type TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount >= 0), units INTEGER, reference TEXT, occurred TEXT NOT NULL, minutes INTEGER, note TEXT, created TEXT NOT NULL)",
  "CREATE TABLE ledger_proofs (id INTEGER PRIMARY KEY AUTOINCREMENT, trip_id INTEGER NOT NULL REFERENCES ledger_trips(id), entry_id INTEGER REFERENCES ledger_entries(id), sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, media_type TEXT NOT NULL, label TEXT NOT NULL, created TEXT NOT NULL)",
  "CREATE TABLE ledger_legacy_outcomes (outcome_id INTEGER PRIMARY KEY, trip_id INTEGER NOT NULL REFERENCES ledger_trips(id), migrated TEXT NOT NULL)",
];

test("migration: an older database gains the date the item came back in place, rows unchanged", () => {
  const db = memoryDb((d) => {
    for (const sql of SCHEMA_FC02D8A) d.exec(sql);
  });
  const clock = { now: OCTOBER_END };
  const id = createTrip(db, { label: "Old", source: "manual", kind: "resale" }, clock);
  addEntry(db, id, RC, clock);
  addEntry(db, id, S("2026-10-03"), clock);
  addEntry(db, id, RET("2026-10-07"), clock);
  addEntry(db, id, S("2026-10-06"), clock);
  const before = db.prepare("SELECT * FROM ledger_entries ORDER BY id").all();
  // Read before the schema runs: every refund came back on its own date.
  assert.deepEqual(getTrip(db, id).reconciliation.discrepancies.map((d) => d.code), ["sold-above-bought"]);
  transaction(db, () => schema(db));
  schema(db); // idempotent
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_refund_returns'").get());
  assert.deepEqual(db.prepare("SELECT * FROM ledger_entries ORDER BY id").all(), before);
  assert.equal(getTrip(db, id).entries.find((e) => e.type === "refund").returnedOn, null);
  // The old refund is re-recorded with the date it came back: the resale reconciles.
  const old = getTrip(db, id).entries.find((e) => e.type === "refund");
  db.prepare("DELETE FROM ledger_entries WHERE id = ?").run(old.id);
  addEntry(db, id, RET("2026-10-07", 1, { returnedOn: "2026-10-05" }), clock);
  const trip = getTrip(db, id);
  assert.deepEqual(trip.reconciliation.discrepancies, []);
  assert.equal(listTrips(db).find((x) => x.id === id).discrepancies, 0);
  assert.equal(summary(db, "2026-10").unsoldUnits, 0);
  // A pure call with an entry that has no returnedOn field reads as before.
  assert.deepEqual(reconcile({ kind: "resale", status: "open", source: "manual" }, trip.entries.map(({ returnedOn, ...e }) => e)).discrepancies.map((d) => d.code), ["sold-above-bought"]);
});
