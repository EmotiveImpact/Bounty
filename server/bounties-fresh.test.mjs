// Bounty evidence on reads and re-checks (round three): the newest shelf
// count, over-claimed bounties, each holder's own figures, competition and
// sales that age, Open Prices price rises at the same shop, reads that never
// wait on another writer, notice superseding, the tier now and the pilot
// sign-off line. Fixtures are copied from bounties.test.mjs, which does not
// export them.
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryDb, serve } from "./test-support.mjs";
import {
  addReport,
  blockerList,
  bountyView,
  claim as rawClaim,
  competitionNow,
  createBounty,
  createMember,
  dispatchAlerts,
  memberAlerts,
  memberNotices,
  requireBounty,
  salesNow,
  schema,
  syncTrip,
  tripState,
  validationFrom,
  verifyReport,
} from "./bounties.mjs";
import { refreshOpenBounties, routes } from "./routes-bounties.mjs";
import { recordCheck, schema as auditSchema } from "./audit.mjs";
import { OBSERVATIONS_TABLE, RESEARCH_TABLE } from "./contract.mjs";

const T0 = "2026-11-02T09:00:00.000Z";
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60000).toISOString();
const HOUR = 60;
const DAY = 24 * HOUR;
const GTIN = "05012345678900";

// A stand-in for an estimateFromEvidence result (copied from
// bounties.test.mjs). 26 confirmed sales in 90 days is about 2.02 a week.
// The economics follow the units and the journey: £10 contribution a unit
// before a £5 journey by default.
function fakeEstimate(over = {}) {
  const units = over.units ?? 2;
  const travel = over.journeyCost ?? 500;
  const minutes = over.journeyMinutes ?? 30;
  const contribution = units * 1000 - travel;
  const activeMinutes = minutes + 10 + units * 10;
  const unitProfit = Math.floor(contribution / units);
  const result = {
    offer: {
      provider: "awin",
      sourceId: "A1",
      title: "Travel kettle 0.5 l",
      price: 1500,
      observed: "2026-11-01",
      retailer: "Argos",
      gtin: GTIN,
      variant: "white",
      ...over.offer,
    },
    sample: { count: 26, independent: 6, lowerMedian: 3200, daysToSell: 5, ...over.sample },
    competition: { activeListings: 1, sellers: 1, lowestAsking: 3500, lowestAskingIncludesShipping: true, ...over.competition },
    match: "exact",
    unitCost: 1500,
    economics: {
      units,
      unitCost: 1500,
      salePrice: 3200,
      costs: { travel },
      contribution,
      unitContribution: unitProfit,
      cashRequired: units * 1600 + travel,
      hourly: Math.round((contribution * 60) / activeMinutes),
      activeMinutes,
      unsoldLoss: -3200,
      breakEvenSale: 2400,
      ...over.economics,
    },
    inputs: { units },
    opportunity: {
      tier: "Priority 2",
      reasons: ["Sourcing pressure high or unknown"],
      unitProfit,
      returnOnCost: Math.round((unitProfit / 1500) * 1000) / 1000,
      targetPrice: null,
      meetsThresholds: true,
      trialUnits: 3,
      unitPrice: 1500,
      weightKg: 0.9,
      ...over.opportunity,
    },
    alert: { eligible: true, reasons: [], checks: [{ id: "live-evidence", ok: true, detail: "Imported evidence" }], ...over.alert },
    stock: {
      confirmed: true,
      availability: "in_stock",
      ...over.stock,
      check:
        over.stock?.check === null
          ? null
          : { in_stock: 1, units_seen: 10, checked_at: "2026-11-02T08:00:00.000Z", ...over.stock?.check },
    },
    permission: { permitted: true, basis: "Permitted for awin (Argos) by a display permission recorded in Sources" },
    warnings: [],
    ...over.extra,
  };
  return result;
}

const JOURNEY = { cost: 300, minutes: 30 };
const ownCheck = (units, journey = JOURNEY) => fakeEstimate({ units, journeyCost: journey.cost, journeyMinutes: journey.minutes });
const claim = (db, args) =>
  rawClaim(db, { journey: args.journey ?? JOURNEY, check: ownCheck(args.units, args.journey ?? JOURNEY), ...args });

const bountyInput = (over = {}) => ({
  title: "Travel kettle",
  locality: "Camden",
  retailer: "Argos",
  availableUnits: 6,
  salesPerWeek: 3,
  sellWindowWeeks: 2,
  expiresAt: at(3 * DAY),
  sponsored: false,
  ...over,
});
const REQUEST = { offer: { provider: "awin", sourceId: "A1" } };
// Default fake: floor(2.02 * 2) = 4 sales in the window, less 1 listing = 3.
const liveBounty = (db, over = {}, estimate = fakeEstimate(), { request = REQUEST, lookup = null, now = T0 } = {}) =>
  createBounty(db, bountyInput(over), { estimate, request, lookup, now });

const member = (db, name, over = {}) =>
  createMember(db, { name, alertsOptIn: true, alertLocalities: ["Camden"], ...over }, { now: T0 });
const diamond = (db, name, over = {}) => member(db, name, { paidTier: "diamond", paidUntil: "2026-12-31", ...over });

const check = (db, over = {}, now = at(10)) =>
  recordCheck(db, { barcode: GTIN, retailer: "Argos", locality: "Camden", method: "phone", inStock: true, unitsSeen: 1, ...over }, { now });
const viewAs = (db, bountyId, m, now) =>
  bountyView(db, requireBounty(db, bountyId), { viewer: m ? { kind: "member", member: m } : { kind: "operator" }, now });
const current = (db, memberId, bountyId) => memberNotices(db, memberId, { bountyId }).filter((n) => !n.superseded);

// An estimate for the route options and refreshOpenBounties that follows the
// request's units and journey, with `over` merged in.
const following = (over = () => ({})) => (_db, request) =>
  fakeEstimate({
    units: Number.isSafeInteger(request?.units) ? request.units : 2,
    journeyCost: Number.isSafeInteger(request?.costs?.journeyCost) ? request.costs.journeyCost : 500,
    journeyMinutes: Number.isSafeInteger(request?.costs?.journeyMinutes) ? request.costs.journeyMinutes : 30,
    ...over(request),
  });

test("a branch check with fewer units than are claimed keeps the earliest claims and stops the rest (R3M5, R3B1)", () => {
  const db = memoryDb(schema, auditSchema);
  const b = liveBounty(db);
  assert.equal(b.cap, 3);
  const ann = diamond(db, "Ann");
  const bob = diamond(db, "Bob");
  const cy = diamond(db, "Cy");
  claim(db, { bountyId: b.id, memberId: ann.id, units: 1, now: at(1) });
  claim(db, { bountyId: b.id, memberId: bob.id, units: 1, now: at(2) });
  claim(db, { bountyId: b.id, memberId: cy.id, units: 1, now: at(3) });
  check(db, { unitsSeen: 1 });
  const op = viewAs(db, b.id, null, at(11));
  // The shelf count, cap and stock line use the newest check before any re-check.
  assert.deepEqual(op.shelfUnits, { units: 1, source: "stock check", at: at(10), boughtSince: 0 });
  assert.equal(op.checked.stockLabel, "Stock last checked 2 Nov 2026, 09:10 (branch check)");
  assert.equal(op.cap, 1);
  assert.equal(op.remaining, 0);
  assert.ok(op.capBasis.notes.includes("Units to share lowered to 1: the latest branch check (2 Nov 2026, 09:10) saw 1 unit"));
  // More claimed than on the shelf is never a go state.
  assert.equal(op.trip.go, false);
  assert.equal(op.trip.label, "More claimed than on the shelf");
  assert.equal(op.alert.canSend, false);
  assert.equal(viewAs(db, b.id, ann, at(11)).trip.label, "Your claim stands");
  assert.equal(viewAs(db, b.id, ann, at(11)).trip.go, true);
  const bobs = viewAs(db, b.id, bob, at(11)).trip;
  assert.equal(bobs.go, false);
  assert.equal(bobs.reason, "over-claimed");
  assert.match(
    bobs.headline,
    /^Don't make the trip: only 1 unit is on the shelf \(latest branch check, 2 Nov 2026, 09:10\) and members have claimed 3 units\. Yours is not one of the first 1 unit claimed$/,
  );
  // Later holders are told why; the earliest is told their claim stands.
  for (const m of [bob, cy]) {
    const n = current(db, m.id, b.id);
    assert.deepEqual(n.map((x) => x.kind), ["stop"]);
    assert.match(n[0].message, /Yours is not one of the first 1 unit claimed/);
  }
  const mine = current(db, ann.id, b.id);
  assert.deepEqual(mine.map((x) => [x.kind, x.reason]), [["reopen", "claim-stands"]]);
  assert.match(mine[0].message, /Yours is among the first 1 unit claimed, so it stands/);
  // Reading again sends nothing more.
  const count = db.prepare("SELECT COUNT(*) AS n FROM notices").get().n;
  viewAs(db, b.id, bob, at(12));
  memberAlerts(db, cy.id, { now: at(12) });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notices").get().n, count);
  // The cap worked out on the read is stored.
  assert.equal(requireBounty(db, b.id).cap, 1);
});

test("refreshing after a branch check: the cap falls, a refused claim says why, and a restock reopens (R3B1, R3Q2)", async () => {
  const db = memoryDb(schema, auditSchema);
  const request = { ...REQUEST, units: 2 };
  const b = liveBounty(db, {}, fakeEstimate(), { request });
  const ann = diamond(db, "Ann");
  dispatchAlerts(db, b.id, T0);
  check(db, { unitsSeen: 1 });
  // At 1 unit the operator's figures fall below the hourly floor.
  let shelf = { units_seen: 1, checked_at: at(10) };
  const estimate = following((req) => ({
    stock: { check: shelf },
    ...(req.units === 1
      ? { alert: { eligible: false, reasons: ["Below the hourly floor or working time unknown"], checks: [] } }
      : {}),
  }));
  const out = await refreshOpenBounties(db, { barcode: GTIN, retailer: "Argos", now: at(11), estimate, askingLookup: () => null });
  assert.deepEqual(out.rechecked, [b.id]);
  assert.deepEqual(out.stopped.map((x) => [x.bountyId, x.noticesSent]), [[b.id, 1]]);
  const card = viewAs(db, b.id, ann, at(12));
  assert.equal(card.cap, 1);
  assert.equal(card.checked.stockLabel, "Stock last checked 2 Nov 2026, 09:10 (branch check)");
  assert.equal(
    card.claimBlockers[0],
    "The latest branch check (2 Nov 2026, 09:10) saw 1 unit, so at most 1 can be claimed. At 1 unit the buy-alert checks do not pass: Below the hourly floor or working time unknown",
  );
  assert.equal(memberNotices(db, ann.id)[0].kind, "stop");
  // A restock reopens it once the estimate is worked out again.
  check(db, { unitsSeen: 6 }, at(20));
  shelf = { units_seen: 6, checked_at: at(20) };
  const again = await refreshOpenBounties(db, { barcode: GTIN, now: at(21), estimate, askingLookup: () => null });
  assert.deepEqual(again.reopened.map((x) => [x.bountyId, x.noticesSent]), [[b.id, 1]]);
  const open = viewAs(db, b.id, ann, at(22));
  assert.equal(open.trip.go, true);
  assert.equal(open.cap, 3);
  assert.deepEqual(current(db, ann.id, b.id).map((n) => n.kind), ["reopen"]);
});

test("a refresh re-runs each holder's own figures: a holder whose trip now fails is stopped, never reopened (R3M2)", async () => {
  const db = memoryDb(schema, auditSchema);
  db.exec(RESEARCH_TABLE);
  db.prepare(
    "INSERT INTO research(provider, source_id, kind, title, price, observed) VALUES('awin', 'A1', 'Retail offer', 'Travel kettle 0.5 l', 1500, '2026-11-01')",
  ).run();
  const b = liveBounty(db);
  const fay = diamond(db, "Fay");
  const gus = diamond(db, "Gus");
  const far = { cost: 1500, minutes: 30 };
  claim(db, { bountyId: b.id, memberId: fay.id, units: 1, journey: far, now: at(1) });
  claim(db, { bountyId: b.id, memberId: gus.id, units: 1, now: at(2) });
  db.prepare("UPDATE research SET price = 1700, observed = '2026-11-02' WHERE source_id = 'A1'").run();
  assert.equal(viewAs(db, b.id, fay, at(5)).trip.label, "Price has risen");
  assert.deepEqual(current(db, fay.id, b.id).map((n) => n.kind), ["stop"]);
  // The operator re-checks at £17: their figures pass, Fay's journey does not.
  const estimate = following((req) => ({
    offer: { price: 1700, observed: "2026-11-02" },
    ...(req.costs?.journeyCost >= 1500
      ? {
          opportunity: { tier: "Watch", meetsThresholds: false, reasons: ["Profit per unit below £5"] },
          alert: { eligible: false, reasons: ["Profit per unit below £5"], checks: [] },
        }
      : {}),
  }));
  const out = await refreshOpenBounties(db, { now: at(6), estimate, askingLookup: () => null });
  assert.deepEqual(out.reopened.map((x) => x.bountyId), [b.id]);
  assert.deepEqual(out.heldBack.map((x) => [x.bountyId, x.noticesSent]), [[b.id, 1]]);
  const fays = current(db, fay.id, b.id);
  assert.deepEqual(fays.map((n) => [n.kind, n.reason]), [["stop", "own-figures"]]);
  assert.match(
    fays[0].message,
    /^Don't make the trip: your own figures for 1 unit with your journey \(£15\.00, 30 minutes\), worked out again at £15\.00 a unit on the latest evidence \(2 Nov 2026, 09:06\), now fail.*Profit per unit below £5/,
  );
  assert.deepEqual(current(db, gus.id, b.id).map((n) => n.kind), ["reopen"]);
  const card = viewAs(db, b.id, fay, at(7));
  assert.equal(card.trip.go, false);
  assert.equal(card.trip.label, "Your figures no longer pass");
  assert.equal(card.claims[0].figures.ok, false);
  assert.equal(viewAs(db, b.id, gus, at(7)).trip.go, true);
  // The same failure on the next re-check is not sent again.
  await refreshOpenBounties(db, { now: at(8), estimate, askingLookup: () => null });
  assert.equal(memberNotices(db, fay.id).filter((n) => n.reason === "own-figures").length, 1);
});

test("a re-check uses each claim's stored hourly floor, and the cap uses the 2-week sell window (R3M2, R3M1)", async () => {
  const db = memoryDb(schema, auditSchema);
  const b = liveBounty(db, { sellWindowWeeks: 12 });
  // 2.02 sales a week over 2 weeks, less 1 listing: 3, never 23 over 12 weeks.
  assert.equal(b.cap, 3);
  assert.ok(JSON.parse(b.cap_basis).notes.includes("Sell window limited to 2 weeks, the window the buy-alert checks use, not the 12 entered"));
  const ivy = diamond(db, "Ivy");
  rawClaim(db, { bountyId: b.id, memberId: ivy.id, units: 1, journey: JOURNEY, check: ownCheck(1), terms: { hourlyFloor: 2000 }, now: at(1) });
  const floors = [];
  const estimate = following((req) => {
    floors.push(req.hourlyFloor ?? null);
    return req.hourlyFloor >= 2000
      ? { alert: { eligible: false, reasons: ["Below the hourly floor or working time unknown"], checks: [] } }
      : {};
  });
  await refreshOpenBounties(db, { now: at(5), estimate, askingLookup: () => null });
  assert.ok(floors.includes(2000));
  const n = current(db, ivy.id, b.id);
  assert.deepEqual(n.map((x) => x.reason), ["own-figures"]);
  assert.match(n[0].message, /Below the hourly floor: about £8\.40 an active hour, under your floor of £20\.00/);
});

test("a lookup that found no competing listings counts for 6 hours; then reads stop the trip and alerts (R3M6, R3Q3)", () => {
  const db = memoryDb(schema, auditSchema);
  const estimate = fakeEstimate({ competition: { activeListings: 0, sellers: 0 } });
  const b = liveBounty(db, {}, estimate, { lookup: { provider: "ebay", fetched: T0 } });
  const ann = diamond(db, "Ann");
  dispatchAlerts(db, b.id, T0);
  assert.equal(b.cap, 4);
  assert.equal(competitionNow(b, at(5 * HOUR)).known, true);
  assert.equal(viewAs(db, b.id, ann, at(5 * HOUR)).trip.go, true);
  const late = at(7 * HOUR);
  const lapsed = competitionNow(b, late);
  assert.equal(lapsed.lapsed, true);
  const card = viewAs(db, b.id, ann, late);
  assert.equal(card.trip.go, false);
  assert.equal(card.trip.label, "Competition check out of date");
  assert.match(card.trip.headline, /^Don't make the trip: competing listings were last checked more than 6 hours ago/);
  assert.equal(card.cap, 0);
  assert.match(card.capBasis.notes.join(" "), /eBay Browse lookup, 2 Nov 2026, 09:00, found none/);
  assert.deepEqual(current(db, ann.id, b.id).map((n) => n.kind), ["stop"]);
  // Dispatch works the same evidence out itself (an eligibility answer too).
  const bob = diamond(db, "Bob");
  const sent = dispatchAlerts(db, b.id, late, { memberId: bob.id });
  assert.deepEqual(sent.sent, []);
  assert.match(sent.blockers[0], /^Competing listings were last checked more than 6 hours ago/);
});

test("a positive competing-listings count lapses after 7 days", () => {
  const db = memoryDb(schema, auditSchema);
  const b = liveBounty(db, { expiresAt: at(10 * DAY) });
  assert.equal(competitionNow(b, at(7 * DAY + 23 * HOUR)).lapsed, false);
  const late = at(8 * DAY);
  assert.equal(competitionNow(b, late).lapsed, true);
  const list = blockerList(db, b, late);
  const lapsed = list.find((x) => x.id === "competition-lapsed");
  assert.match(lapsed.text, /^The latest asking-price check \(2 Nov 2026\) is more than 7 days old, so the 1 competing listing behind the cap may have changed/);
});

const sales = (dates) => dates.map((observed, i) => ({ seller: `Seller ${i + 1}`, observed, price: 3200 }));
const OLD = "2026-08-04T12:00:00.000Z"; // recent at T0, more than 90 days old 36 hours later
const RECENT = "2026-10-20T12:00:00.000Z";

test("sales that age out lower the cap and the sales line counts only the recent ones (R3Q3, R3Q8)", () => {
  const db = memoryDb(schema, auditSchema);
  const used = sales([...Array(20).fill(OLD), ...Array(20).fill(RECENT)]);
  const b = liveBounty(db, {}, fakeEstimate({ sample: { used, count: 40, independent: 40, oldest: OLD } }));
  assert.equal(b.cap, 5);
  const later = at(36 * HOUR);
  assert.deepEqual(salesNow(b, later), { counted: 40, recent: 20, enough: true, total: 40, recentSales: 20 });
  const card = viewAs(db, b.id, null, later);
  assert.equal(card.cap, 2);
  assert.equal(card.trip.go, true);
  assert.ok(card.capBasis.notes.includes("Sales a week lowered to 1.56: only 20 of the 40 confirmed sales behind the figures are still from the last 90 days"));
  assert.ok(!card.capBasis.notes.some((n) => /40 confirmed sales over 90 days/.test(n)));
  // When the recent sales no longer support the units the figures are for, the trip stops.
  const db2 = memoryDb(schema, auditSchema);
  const few = sales([...Array(32).fill(OLD), ...Array(8).fill(RECENT)]);
  const b2 = liveBounty(db2, {}, fakeEstimate({ sample: { used: few, count: 40, independent: 40, oldest: OLD } }));
  const trip = tripState(db2, b2, later);
  assert.equal(trip.go, false);
  assert.equal(trip.reason, "demand-aged");
  assert.equal(trip.label, "Sales evidence out of date");
  assert.match(blockerList(db2, b2, later)[0].text, /^Only 8 of the 40 confirmed sales behind the figures are still from the last 90 days, so sales now support about 0 units within 2 weeks, fewer than the 2 units the figures are for$/);
});

test("two independent sellers are not enough, and an old snapshot whose oldest sale aged blocks (BB8, BB9)", () => {
  const db = memoryDb(schema, auditSchema);
  const b = liveBounty(db, {}, fakeEstimate({ sample: { used: sales([OLD, RECENT, RECENT]) } }));
  assert.equal(tripState(db, b, T0).go, true);
  const later = at(36 * HOUR);
  const list = blockerList(db, b, later);
  assert.deepEqual(list.map((x) => x.id), ["sales-aged"]);
  assert.match(list[0].text, /^Only 2 of the 3 independent sales behind the figures are still from the last 90 days: fewer than 3/);
  // An older snapshot kept no sellers or dates, only the oldest sale.
  const db2 = memoryDb(schema, auditSchema);
  const old = liveBounty(db2);
  const snapshot = JSON.parse(old.estimate);
  snapshot.sample = { count: 26, independent: 6, lowerMedian: 3200, daysToSell: 5, oldest: OLD };
  db2.prepare("UPDATE bounties SET estimate = ? WHERE id = ?").run(JSON.stringify(snapshot), old.id);
  const stored = requireBounty(db2, old.id);
  assert.equal(tripState(db2, stored, T0).go, true);
  const ids = blockerList(db2, stored, later).map((x) => x.id);
  assert.ok(ids.includes("sales-aged"));
  assert.equal(tripState(db2, stored, later).go, false);
});

function openPricesShop() {
  const db = memoryDb(schema, auditSchema);
  db.exec(OBSERVATIONS_TABLE);
  const add = db.prepare(
    "INSERT INTO observations(id, title, store, place, city, price, day, barcode) VALUES(?, 'Travel kettle', ?, 'NW1 7DL', 'London', ?, ?, ?)",
  );
  return { db, add: (id, price, day, store = "Sainsbury's") => add.run(id, store, price, day, GTIN) };
}

test("a newer, higher Open Prices price at the same shop stops the trip, even by 50p, and says when it was seen (R3M3, R3Q8, BB5, BS5)", () => {
  const { db, add } = openPricesShop();
  add(990001, 1500, "2026-11-01");
  const b = liveBounty(
    db,
    { retailer: "Sainsbury's" },
    fakeEstimate({ offer: { provider: "openprices", sourceId: "990001", price: 1500, observed: "2026-11-01", retailer: "Sainsbury's" } }),
  );
  const ann = diamond(db, "Ann");
  dispatchAlerts(db, b.id, T0);
  // Another shop's price is not this shop's.
  add(990002, 2500, "2026-11-02", "Tesco");
  assert.equal(viewAs(db, b.id, ann, at(5)).trip.go, true);
  add(990003, 1550, "2026-11-02");
  const risen = viewAs(db, b.id, ann, at(6));
  assert.equal(risen.trip.label, "Price has risen");
  assert.match(risen.trip.headline, /^Don't make the trip: the offer price has risen from £15\.00 to £15\.50/);
  assert.equal(risen.checked.priceLabel, "Price seen 2 Nov 2026 at £15.50 (the figures use £15.00)");
  assert.equal(risen.checked.price, "2026-11-01");
  // Back to £15 (a later observation the same day), then up again: a second stop.
  add(990004, 1500, "2026-11-02");
  assert.equal(viewAs(db, b.id, ann, at(7)).trip.go, true);
  add(990005, 1550, "2026-11-02");
  assert.equal(viewAs(db, b.id, ann, at(8)).trip.go, false);
  assert.deepEqual(memberNotices(db, ann.id).map((n) => n.kind), ["stop", "reopen", "stop"]);
  assert.deepEqual(current(db, ann.id, b.id).map((n) => n.kind), ["stop"]);
});

test("a new stop notice supersedes the earlier reopen notice: only the latest shows (R3Q7)", () => {
  const db = memoryDb(schema, auditSchema);
  db.exec(RESEARCH_TABLE);
  db.prepare(
    "INSERT INTO research(provider, source_id, kind, title, price, observed) VALUES('awin', 'A1', 'Retail offer', 'Travel kettle 0.5 l', 1500, '2026-11-01')",
  ).run();
  const b = liveBounty(db);
  const dana = diamond(db, "Dana");
  claim(db, { bountyId: b.id, memberId: dana.id, units: 1, now: at(1) });
  db.prepare("UPDATE research SET price = 1700 WHERE source_id = 'A1'").run();
  viewAs(db, b.id, dana, at(2));
  db.prepare("UPDATE research SET price = 1500 WHERE source_id = 'A1'").run();
  viewAs(db, b.id, dana, at(3));
  assert.deepEqual(current(db, dana.id, b.id).map((n) => n.kind), ["reopen"]);
  check(db, { inStock: false, unitsSeen: 0 }, at(4));
  const card = viewAs(db, b.id, dana, at(5));
  assert.equal(card.trip.state, "out-of-stock");
  assert.deepEqual(card.viewer.notices.filter((n) => !n.superseded).map((n) => n.kind), ["stop"]);
  assert.deepEqual(memberNotices(db, dana.id).map((n) => [n.kind, n.superseded]), [["stop", false], ["reopen", true], ["stop", true]]);
});

test("a shelf count from a member's verified report says stock report (R2Q9)", () => {
  const db = memoryDb(schema, auditSchema);
  const b = liveBounty(db);
  const eve = diamond(db, "Eve");
  const report = addReport(db, { bountyId: b.id, memberId: eve.id, unitsSeen: 0 }, { now: at(30) });
  verifyReport(db, report.report?.id ?? report.id, true, { now: at(31), recordCheck });
  const card = viewAs(db, b.id, null, at(32));
  assert.equal(card.checked.stockLabel, "Stock last checked 2 Nov 2026, 09:30 (stock report)");
  const oos = blockerList(db, requireBounty(db, b.id), at(32)).find((x) => x.id === "out-of-stock");
  assert.match(oos.text, /^The operator confirmed a member's stock report of none on the shelf at 2 Nov 2026, 09:30/);
});

test("the tier is worked out again with pressure and competition now, so Priority 1 is reachable (R3P4, R2Q8)", () => {
  const db = memoryDb(schema, auditSchema);
  const b = liveBounty(db);
  const fresh = viewAs(db, b.id, null, T0);
  assert.equal(fresh.opportunity.tier, "Priority 1");
  assert.equal(fresh.opportunity.tierAtRecheck, "Priority 2");
  assert.match(fresh.opportunity.reasons[0], /^Strong sold evidence, confirmed stock and low pressure now/);
  // Pressure above 0.5 keeps it at Priority 2, with a true reason.
  const db2 = memoryDb(schema, auditSchema);
  const b2 = liveBounty(db2, {}, fakeEstimate({ stock: { check: { units_seen: 2 } } }));
  claim(db2, { bountyId: b2.id, memberId: diamond(db2, "Hal").id, units: 2, now: at(1) });
  const busy = viewAs(db2, b2.id, null, at(2));
  assert.equal(busy.opportunity.tier, "Priority 2");
  assert.deepEqual(busy.opportunity.reasons, ["Sourcing pressure high: 1 (Priority 1 allows 0.5)"]);
  // Other Priority 2 reasons from the re-check still hold.
  const db3 = memoryDb(schema, auditSchema);
  const b3 = liveBounty(db3, {}, fakeEstimate({ opportunity: { reasons: ["Fewer than 6 independent recent sales", "Sourcing pressure high or unknown"] } }));
  const view3 = viewAs(db3, b3.id, null, T0);
  assert.equal(view3.opportunity.tier, "Priority 2");
  assert.deepEqual(view3.opportunity.reasons, ["Fewer than 6 independent recent sales"]);
  for (const v of [fresh, busy, view3]) assert.doesNotMatch(v.opportunity.reasons.join(" "), /re-check works it out/);
});

test("after a standing sign-off cards keep one plain line with the result (R3B4)", () => {
  const signed = { at: "2026-10-31T10:00:00.000Z", passed: 12, evidenced: 30 };
  const base = { target: 30, audited: 30, evidenced: 30, passed: 12, complete: true };
  const v = validationFrom("Camden", { ...base, signedOff: signed });
  assert.equal(v.signedOff, true);
  assert.equal(v.caution, false);
  assert.equal(v.warning, "Pilot audit in Camden signed off on 31 Oct 2026: 12 of 30 items passed.");
  assert.equal(
    validationFrom("Camden", { ...base, signedOff: { ...signed, summary: "Pilot audit in Camden signed off on 31 Oct 2026: 12 of 30 items passed." } }).warning,
    "Pilot audit in Camden signed off on 31 Oct 2026: 12 of 30 items passed.",
  );
  // A sign-off with no item passed does not stand; the caution stays.
  const none = validationFrom("Camden", { ...base, passed: 0, signedOff: { ...signed, passed: 0 } });
  assert.equal(none.signedOff, false);
  assert.equal(none.caution, true);
  assert.equal(none.warning, "Pilot audit in Camden: 0 of 30 items passed, not yet signed off. Treat these figures with care.");
  assert.equal(validationFrom("Camden", { garbage: true }).warning, "Pilot not validated in Camden: 0 of 30 items checked against stored evidence");
});

test("reads return the card while another connection holds the write lock (R3B2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bounty-lock-"));
  const file = join(dir, "lock.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  schema(db);
  auditSchema(db);
  const other = new DatabaseSync(file);
  const api = await serve(db, [{ routes: (d) => routes(d, { clock: () => at(6), estimate: following(), askingLookup: () => null }) }]);
  try {
    const b = liveBounty(db);
    const ann = diamond(db, "Ann");
    dispatchAlerts(db, b.id, T0);
    // A check that found none: the next read must stop the trip and notify.
    check(db, { inStock: false, unitsSeen: 0 }, at(5));
    other.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    const started = Date.now();
    const card = await api.call("GET", `/api/bounties/${b.id}?viewer=${ann.id}`);
    assert.equal(card.status, 200);
    assert.equal(card.body.bounty.trip.go, false);
    assert.match(card.body.bounty.trip.headline, /^Don't make the trip: the latest branch check \(2 Nov 2026, 09:05\) found none on the shelf/);
    assert.equal((await api.call("GET", "/api/bounties")).status, 200);
    assert.equal((await api.call("GET", `/api/members/${ann.id}/alerts`)).status, 200);
    assert.ok(Date.now() - started < 3000, "reads do not wait for the busy timeout");
    assert.equal(memberNotices(db, ann.id).length, 0);
    assert.equal(syncTrip(db, requireBounty(db, b.id), at(6)).deferred, true);
    other.exec("ROLLBACK");
    // Once the lock is free (and the short pause after a locked read has
    // passed), the next read sends the notice.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal((await api.call("GET", `/api/bounties/${b.id}?viewer=${ann.id}`)).status, 200);
    assert.deepEqual(memberNotices(db, ann.id).map((n) => n.kind), ["stop"]);
  } finally {
    if (other.isTransaction) other.exec("ROLLBACK");
    await api.close();
    other.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the branch-check route works each open bounty out again, not only its blockers (R3B1)", async () => {
  const { routes: researchRoutes } = await import("./routes-research.mjs");
  const db = memoryDb(schema, auditSchema);
  const b = liveBounty(db);
  const ann = diamond(db, "Ann");
  dispatchAlerts(db, b.id, T0);
  const api = await serve(db, [{ routes: researchRoutes }]);
  mock.timers.enable({ apis: ["Date"], now: Date.parse(at(10)) });
  try {
    const res = await api.call("POST", "/api/research/checks", {
      barcode: GTIN,
      retailer: "Argos",
      locality: "Camden",
      method: "phone",
      inStock: true,
      unitsSeen: 4,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.checkedAtStamped, true);
    assert.deepEqual(res.body.bounties.rechecked, [b.id]);
    assert.equal(res.body.bounties.checked, 1);
    // The real estimate cannot run on this fixture, so the bounty fails closed
    // and Ann is told.
    assert.match(requireBounty(db, b.id).alert_reasons, /Evidence could not be re-checked/);
    assert.deepEqual(memberNotices(db, ann.id).map((n) => n.kind), ["stop"]);
  } finally {
    mock.timers.reset();
    await api.close();
  }
});
