// Round five, ledger findings 3 and 5.
//   3. Earnings per hour come from whole trips completed in the month, never
//      one month's payout over one month's minutes.
//   5. Stock is reconciled in date order: a unit a buyer sent back can be
//      sold again; a refund where the buyer kept the item returns no stock.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
  stockWalk,
  summary,
  metrics,
} from "./ledger.mjs";
import * as ledgerRoutes from "./routes-ledger.mjs";

const NOVEMBER = { now: new Date("2026-11-20T12:00:00.000Z") };
const DECEMBER = { now: new Date("2026-12-05T12:00:00.000Z") };
const scratch = mkdtempSync(join(tmpdir(), "bounty-round5-ledger-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

async function api(t, now = NOVEMBER.now) {
  const db = memoryDb(schema);
  const proofDir = join(scratch, "routes-" + Math.random().toString(36).slice(2));
  const server = await serve(db, [{ routes: (d) => ledgerRoutes.routes(d, { proofDir, now: () => now }) }]);
  t.after(() => server.close());
  return { ...server, db };
}

const resaleTrip = (overrides = {}) => ({ id: 1, label: "Test", source: "manual", kind: "resale", status: "open", predicted: null, ...overrides });
let nextId = 1;
const entry = (type, amount, occurred, extra = {}) => ({ id: nextId++, type, amount, occurred, units: null, minutes: null, ...extra });
const codes = (entries) => reconcile(resaleTrip(), entries).discrepancies.map((d) => d.code);

// --- Finding 3: earnings per hour across a month boundary --------------------

/** The reviewer's trip: £100 and 2 h in October, £180 and 5 min in November. */
function crossMonth(db, label = "Cross-month", clock = NOVEMBER) {
  const id = createTrip(db, { label, source: "manual", kind: "resale" }, clock);
  addEntry(db, id, { type: "receipt", amount: 10000, units: 1, occurred: "2026-10-10" }, clock);
  addEntry(db, id, { type: "work", minutes: 120, occurred: "2026-10-10" }, clock);
  addEntry(db, id, { type: "sale", amount: 20000, units: 1, occurred: "2026-11-03" }, clock);
  addEntry(db, id, { type: "payout", amount: 18000, units: 1, occurred: "2026-11-05" }, clock);
  addEntry(db, id, { type: "work", minutes: 5, occurred: "2026-11-05" }, clock);
  return id;
}

test("F3: a trip worked in October and paid out in November gives £38.40 an hour, in November only", () => {
  for (const close of [false, true]) {
    const db = memoryDb(schema);
    const id = crossMonth(db);
    if (close) closeTrip(db, id, NOVEMBER);
    const oct = summary(db, "2026-10");
    const nov = summary(db, "2026-11");
    // Monthly cash is exactly as before: cash in and out in each month.
    assert.equal(oct.realisedEarnings, -10000);
    assert.equal(oct.payouts, 0);
    assert.equal(oct.realisedMinutes, 120);
    assert.equal(nov.realisedEarnings, 18000);
    assert.equal(nov.payouts, 18000);
    assert.equal(nov.realisedMinutes, 5);
    // Per hour: the whole trip, £80 over 125 minutes, in the month it was completed.
    assert.equal(nov.realisedHourly, 3840, "never £2,160 an hour");
    assert.deepEqual(nov.hourly, {
      trips: 1,
      minutes: 125,
      earnings: 8000,
      leftOutTrips: 0,
      leftOutEarnings: 0,
      stillOpen: 0,
      completedLater: 0,
    });
    // October shows no hourly figure from it, and says why.
    assert.equal(oct.realisedHourly, null, "never -£50.00 an hour from October's half");
    assert.equal(oct.hourly.trips, 0);
    assert.equal(oct.hourly.completedLater, 1);
    // The trip's own figure and the measures use the same whole-trip basis.
    const r = getTrip(db, id).reconciliation;
    assert.equal(r.realisedHourly, 3840);
    assert.equal(r.completedOn, "2026-11-05");
    if (close) {
      assert.equal(metrics(db).hourly.realised, 3840);
      assert.equal(metrics(db).hourly.trips, 1);
    }
  }
});

test("F3: before the payout the trip is still open and left out of both months", () => {
  const db = memoryDb(schema);
  const id = createTrip(db, { label: "Waiting", source: "manual", kind: "resale" }, NOVEMBER);
  addEntry(db, id, { type: "receipt", amount: 10000, units: 1, occurred: "2026-10-10" }, NOVEMBER);
  addEntry(db, id, { type: "work", minutes: 120, occurred: "2026-10-10" }, NOVEMBER);
  addEntry(db, id, { type: "sale", amount: 20000, units: 1, occurred: "2026-11-03" }, NOVEMBER);
  for (const month of ["2026-10", "2026-11"]) {
    const s = summary(db, month);
    assert.equal(s.realisedHourly, null, month);
    assert.equal(s.hourly.stillOpen, 1, month);
    assert.equal(s.hourly.trips, 0, month);
  }
  assert.equal(getTrip(db, id).reconciliation.completedOn, null);
  // Its own figure is the trip so far.
  assert.equal(getTrip(db, id).reconciliation.realisedHourly, -5000);
});

test("F3: a closed trip counts in the month of its last entry, and losses count too", () => {
  const db = memoryDb(schema);
  const gain = crossMonth(db, "Gain");
  // A loss: bought in November, sold for less, 60 minutes, closed in December.
  const loss = createTrip(db, { label: "Loss", source: "manual", kind: "resale" }, NOVEMBER);
  addEntry(db, loss, { type: "receipt", amount: 4000, units: 1, occurred: "2026-11-06" }, NOVEMBER);
  addEntry(db, loss, { type: "work", minutes: 60, occurred: "2026-11-06" }, NOVEMBER);
  addEntry(db, loss, { type: "sale", amount: 2500, units: 1, occurred: "2026-11-10" }, NOVEMBER);
  addEntry(db, loss, { type: "payout", amount: 2000, units: 1, occurred: "2026-11-12" }, NOVEMBER);
  closeTrip(db, gain, DECEMBER);
  closeTrip(db, loss, DECEMBER);
  const nov = summary(db, "2026-11");
  // (80.00 - 20.00) over 185 minutes: the loss is never left out.
  assert.equal(nov.realisedHourly, Math.round((6000 * 60) / 185));
  assert.equal(nov.hourly.trips, 2);
  assert.equal(nov.hourly.minutes, 185);
  assert.equal(summary(db, "2026-12").realisedHourly, null);
  assert.equal(metrics(db).hourly.realised, Math.round((6000 * 60) / 185));
});

test("F3: an open finished trip opens again when something is still to come", () => {
  const db = memoryDb(schema);
  const id = crossMonth(db);
  assert.equal(summary(db, "2026-11").realisedHourly, 3840);
  // More stock bought on the same trip: no longer finished, so left out.
  addEntry(db, id, { type: "receipt", amount: 3000, units: 1, occurred: "2026-11-15" }, NOVEMBER);
  const nov = summary(db, "2026-11");
  assert.equal(nov.realisedHourly, null);
  assert.equal(nov.hourly.stillOpen, 1);
  assert.equal(nov.realisedEarnings, 18000 - 3000, "cash is still cash");
  // Sold and paid out in December: completed then, with every cost and minute.
  addEntry(db, id, { type: "sale", amount: 5000, units: 1, occurred: "2026-12-01" }, DECEMBER);
  addEntry(db, id, { type: "payout", amount: 4500, units: 1, occurred: "2026-12-03" }, DECEMBER);
  const dec = summary(db, "2026-12");
  assert.equal(dec.realisedHourly, Math.round(((18000 + 4500 - 10000 - 3000) * 60) / 125));
  assert.equal(summary(db, "2026-11").hourly.completedLater, 1);
  assert.equal(summary(db, "2026-10").hourly.completedLater, 1);
});

test("F3 routes: the summary reports the whole trip in the month it was completed", async (t) => {
  const { call } = await api(t);
  const id = (await call("POST", "/api/ledger/trips", { label: "Cross-month", source: "manual", kind: "resale" })).body.id;
  const add = (body) => call("POST", `/api/ledger/trips/${id}/entries`, body);
  for (const body of [
    { type: "receipt", amount: 10000, units: 1, occurred: "2026-10-10" },
    { type: "work", minutes: 120, occurred: "2026-10-10" },
    { type: "sale", amount: 20000, units: 1, occurred: "2026-11-03" },
    { type: "payout", amount: 18000, units: 1, occurred: "2026-11-05" },
    { type: "work", minutes: 5, occurred: "2026-11-05" },
  ])
    assert.equal((await add(body)).status, 201, JSON.stringify(body));
  const nov = (await call("GET", "/api/ledger/summary?month=2026-11")).body;
  assert.equal(nov.realisedHourly, 3840);
  assert.equal(nov.realisedEarnings, 18000);
  assert.equal(nov.hourly.trips, 1);
  assert.equal(nov.hourly.minutes, 125);
  assert.equal(nov.hourly.earnings, 8000);
  assert.match(nov.basis, /completed in the month/);
  const oct = (await call("GET", "/api/ledger/summary?month=2026-10")).body;
  assert.equal(oct.realisedHourly, null);
  assert.equal(oct.realisedEarnings, -10000);
  assert.equal(oct.hourly.completedLater, 1);
  const detail = (await call("GET", `/api/ledger/trips/${id}`)).body;
  assert.equal(detail.reconciliation.realisedHourly, 3840);
  assert.equal(detail.reconciliation.completedOn, "2026-11-05");
  await call("POST", `/api/ledger/trips/${id}/close`, {});
  assert.equal((await call("GET", "/api/ledger/metrics")).body.hourly.realised, 3840);
  assert.equal((await call("GET", "/api/ledger/summary?month=2026-11")).body.realisedHourly, 3840);
});

// --- Finding 5: returns and resale -------------------------------------------

/** Buy 1, sell it, refund it (returned or kept), sell it again. */
const resold = (refund) => [
  entry("receipt", 1000, "2026-10-01", { units: 1 }),
  entry("sale", 2500, "2026-10-03", { units: 1 }),
  entry("payout", 2200, "2026-10-05", { units: 1 }),
  entry("refund", 2500, "2026-10-07", refund),
  entry("sale", 2500, "2026-10-09", { units: 1 }),
  entry("payout", 2200, "2026-10-12", { units: 1 }),
];

test("F5: a unit the buyer sent back can be sold again with no discrepancy", () => {
  const r = reconcile(resaleTrip(), resold({ units: 1 }));
  assert.deepEqual(r.discrepancies, []);
  assert.equal(r.unitsBought, 1);
  assert.equal(r.unitsSold, 2);
  assert.equal(r.unitsReturned, 1);
  assert.equal(r.unsoldUnits, 0);
  assert.equal(r.realisedContribution, 2200 + 2200 - 1000 - 2500);
  assert.equal(r.checklist.reconciled, false, "work time still missing");
  assert.equal(stockWalk(resold({ units: 1 })).onHand, 0);
});

test("F5: a refund where the buyer kept the item leaves nothing to resell", () => {
  const before = reconcile(resaleTrip(), resold({ units: null }).slice(0, 4));
  assert.equal(before.unitsReturned, 0);
  assert.equal(before.unsoldUnits, 0, "no unit came back");
  assert.deepEqual(before.discrepancies, []);
  const r = reconcile(resaleTrip(), resold({ units: null }));
  assert.deepEqual(r.discrepancies.map((d) => d.code), ["sold-above-bought"]);
  assert.match(r.discrepancies[0].message, /The sale on 9 Oct 2026 is for 1 unit, but none was in stock at that point/);
  // A returned unit is back in stock until it is sold again.
  const back = reconcile(resaleTrip(), resold({ units: 1 }).slice(0, 4));
  assert.equal(back.unsoldUnits, 1);
});

test("F5: a sale with nothing on hand at that point is still flagged, in date order", () => {
  // Totals agree (2 bought, 2 sold) but the second sale came before the second purchase.
  assert.deepEqual(
    codes([
      entry("receipt", 1000, "2026-10-01", { units: 1 }),
      entry("sale", 2500, "2026-10-02", { units: 1 }),
      entry("sale", 2500, "2026-10-03", { units: 1 }),
      entry("receipt", 1000, "2026-10-04", { units: 1 }),
    ]),
    ["sold-above-bought"],
  );
  // A sale bigger than the stock on hand.
  const big = reconcile(resaleTrip(), [
    entry("receipt", 1000, "2026-10-01", { units: 1 }),
    entry("sale", 5000, "2026-10-02", { units: 2 }),
  ]);
  assert.match(big.discrepancies[0].message, /is for 2 units, but only 1 unit was in stock/);
  // Selling again after a refund where the buyer kept the item is flagged
  // even when another refund (returned) came later.
  assert.ok(
    codes([
      ...resold({ units: null }),
      entry("refund", 2500, "2026-10-14", { units: 1 }),
    ]).includes("sold-above-bought"),
  );
  // A return dated before the sale it refunds.
  assert.deepEqual(
    codes([
      entry("receipt", 1000, "2026-10-01", { units: 1 }),
      entry("refund", 2500, "2026-10-02", { units: 1 }),
      entry("sale", 2500, "2026-10-03", { units: 1 }),
    ]),
    ["returned-above-sold"],
  );
  // The same unit cannot come back twice.
  const twice = reconcile(resaleTrip(), [
    entry("receipt", 1000, "2026-10-01", { units: 1 }),
    entry("sale", 2500, "2026-10-02", { units: 1 }),
    entry("refund", 2500, "2026-10-03", { units: 1 }),
    entry("refund", 2500, "2026-10-04", { units: 1 }),
  ]);
  assert.deepEqual(twice.discrepancies.map((d) => d.code), ["returned-above-sold"]);
  assert.match(twice.discrepancies[0].message, /The refund on 4 Oct 2026 says 1 unit came back, but no units had been sold and not already returned by then/);
});

test("F5: on one day a purchase covers a sale recorded before it; other movements keep their order", () => {
  // Receipt entered after the sale on the same day: still covered.
  assert.deepEqual(
    codes([entry("sale", 2500, "2026-10-02", { units: 1 }), entry("receipt", 1000, "2026-10-02", { units: 1 })]),
    [],
  );
  // Buy, sell, return and sell again all on one day, in that order.
  const sameDay = resold({ units: 1 }).map((e) => ({ ...e, occurred: "2026-10-02" }));
  assert.deepEqual(codes(sameDay), []);
  // The second sale entered before the return on that day is short.
  const [receipt, sale1, payout1, refund, sale2] = resold({ units: 1 }).map((e) => ({ ...e, occurred: "2026-10-02" }));
  assert.deepEqual(codes([receipt, sale1, payout1, { ...sale2, id: refund.id - 0.5 }, refund]), ["sold-above-bought"]);
});

test("F5 routes: a refund says whether the item came back; both kinds are recorded and checked", async (t) => {
  const { call, db } = await api(t, new Date("2026-10-31T12:00:00Z"));
  const pdf = (body) => Buffer.from("%PDF-1.4\n%" + body + "\n%%EOF\n", "latin1").toString("base64");
  async function trip(label, refund) {
    const id = (await call("POST", "/api/ledger/trips", { label, source: "manual", kind: "resale" })).body.id;
    const add = async (body) => {
      const r = await call("POST", `/api/ledger/trips/${id}/entries`, body);
      assert.equal(r.status, 201, JSON.stringify(body) + " " + JSON.stringify(r.body));
      return r.body.id;
    };
    const receipt = await add({ type: "receipt", amount: 1000, units: 1, occurred: "2026-10-01" });
    await add({ type: "sale", amount: 2500, units: 1, occurred: "2026-10-03" });
    const p1 = await add({ type: "payout", amount: 2200, units: 1, occurred: "2026-10-05" });
    const refundId = await add({ type: "refund", amount: 2500, occurred: "2026-10-07", ...refund });
    await add({ type: "sale", amount: 2500, units: 1, occurred: "2026-10-09" });
    const p2 = await add({ type: "payout", amount: 2200, units: 1, occurred: "2026-10-12" });
    for (const [entryId, name] of [[receipt, "receipt"], [p1, "payout 1"], [p2, "payout 2"]]) {
      const stored = await call("POST", `/api/ledger/trips/${id}/proofs`, { label: name, mediaType: "application/pdf", data: pdf(label + name), entryId });
      assert.equal(stored.status, 201, JSON.stringify(stored.body));
    }
    return { id, refundId, detail: (await call("GET", `/api/ledger/trips/${id}`)).body };
  }

  // The reviewer's case: returned and resold reaches verified.
  const returned = await trip("Returned and resold", { itemReturned: true, units: 1 });
  let r = returned.detail.reconciliation;
  assert.deepEqual(r.discrepancies, []);
  assert.equal(r.unsoldUnits, 0);
  assert.equal(r.unitsReturned, 1);
  assert.equal(r.verified, true, JSON.stringify(r.verificationMissing));
  const refundEntry = returned.detail.entries.find((e) => e.id === returned.refundId);
  assert.equal(refundEntry.itemReturned, true);
  assert.equal(refundEntry.units, 1);

  // A refund with units and no itemReturned keeps meaning the stock came back.
  const legacyShape = await trip("Units only", { units: 1 });
  assert.equal(legacyShape.detail.reconciliation.verified, true);
  assert.equal(legacyShape.detail.entries.find((e) => e.id === legacyShape.refundId).itemReturned, true);

  // The buyer kept the item: the second sale has nothing to sell, so it is flagged and unverified.
  const kept = await trip("Buyer kept it", { itemReturned: false });
  r = kept.detail.reconciliation;
  assert.deepEqual(r.discrepancies.map((d) => d.code), ["sold-above-bought"]);
  assert.equal(r.unitsReturned, 0);
  assert.equal(r.verified, false);
  assert.ok(r.verificationMissing.some((m) => /none was in stock at that point/.test(m)));
  const keptEntry = kept.detail.entries.find((e) => e.id === kept.refundId);
  assert.equal(keptEntry.itemReturned, false);
  assert.equal(keptEntry.units, null);
  const listed = (await call("GET", "/api/ledger/trips")).body.trips;
  assert.equal(listed.find((t) => t.id === kept.id).discrepancies, 1);
  assert.equal(listed.find((t) => t.id === returned.id).verified, true);

  // Validation.
  const id = (await call("POST", "/api/ledger/trips", { label: "Checks", source: "manual", kind: "resale" })).body.id;
  const post = (body) => call("POST", `/api/ledger/trips/${id}/entries`, { amount: 500, occurred: "2026-10-02", ...body });
  let res = await post({ type: "refund", itemReturned: false, units: 1 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Leave units empty when the buyer keeps the item/);
  res = await post({ type: "refund" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /units returned.*itemReturned false/);
  assert.equal((await post({ type: "refund", itemReturned: true })).status, 400);
  assert.equal((await post({ type: "refund", itemReturned: "no" })).status, 400);
  res = await post({ type: "expense", itemReturned: false });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /refund entries only/);

  // Refunds stored before this change (always with units) keep meaning returned.
  db.prepare(
    "INSERT INTO ledger_entries (trip_id, type, amount, units, reference, occurred, minutes, note, created) VALUES (?, 'refund', 900, 1, NULL, '2026-10-03', NULL, NULL, ?)",
  ).run(id, new Date().toISOString());
  const old = (await call("GET", `/api/ledger/trips/${id}`)).body.entries.find((e) => e.type === "refund");
  assert.equal(old.itemReturned, true);
  assert.equal(listTrips(db).find((t) => t.id === id).unsoldUnits, 1);
});

test("F3 and F5 together: a returned unit keeps the trip open until it is resold and paid out", () => {
  const db = memoryDb(schema);
  const clock = { now: new Date("2026-10-31T12:00:00Z") };
  const id = createTrip(db, { label: "Return", source: "manual", kind: "resale" }, clock);
  addEntry(db, id, { type: "receipt", amount: 1000, units: 1, occurred: "2026-10-01" }, clock);
  addEntry(db, id, { type: "work", minutes: 60, occurred: "2026-10-01" }, clock);
  addEntry(db, id, { type: "sale", amount: 2500, units: 1, occurred: "2026-10-03" }, clock);
  addEntry(db, id, { type: "payout", amount: 2200, units: 1, occurred: "2026-10-05" }, clock);
  assert.equal(getTrip(db, id).reconciliation.completedOn, "2026-10-05");
  addEntry(db, id, { type: "refund", amount: 2500, units: 1, itemReturned: true, occurred: "2026-10-07" }, clock);
  assert.equal(getTrip(db, id).reconciliation.completedOn, null, "the unit is back in stock");
  assert.equal(summary(db, "2026-10").hourly.stillOpen, 1);
  addEntry(db, id, { type: "sale", amount: 2500, units: 1, occurred: "2026-10-09" }, clock);
  addEntry(db, id, { type: "payout", amount: 2200, units: 1, occurred: "2026-10-12" }, clock);
  const s = summary(db, "2026-10");
  assert.equal(s.realisedHourly, 2200 + 2200 - 1000 - 2500);
  assert.equal(getTrip(db, id).reconciliation.completedOn, "2026-10-12");
  // A refund where the buyer kept the item finishes nothing new: the trip
  // stays completed, on the refund's date, with the refund counted.
  addEntry(db, id, { type: "refund", amount: 2500, itemReturned: false, occurred: "2026-10-20" }, clock);
  assert.equal(getTrip(db, id).reconciliation.completedOn, "2026-10-20");
  assert.equal(summary(db, "2026-10").realisedHourly, 2200 + 2200 - 1000 - 2500 - 2500);
});
