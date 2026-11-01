// Bounty fixes from the fourth review round: figures worked out again for
// the units left after purchases (N1), a first-order price a holder has
// since used (N2), units bought before a newer shelf count taken off once
// (N3), the 7-day competing-listings window (N4), sale dates aged in UK days
// (N5), an empty-shelf pause lifted by a newer branch check (R3P7), and the
// wording of losses and cap notes. The fake-estimate fixtures are copied
// from bounties-fresh.test.mjs, which does not export them; the N1 and N2
// tests run the real estimate on an in-memory database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb, serve } from "./test-support.mjs";
import {
  addReport,
  blockerList,
  bountyView,
  claim as rawClaim,
  competitionNow,
  completeClaim,
  createBounty,
  createMember,
  dispatchAlerts,
  memberNotices,
  requireBounty,
  salesNow,
  schema,
} from "./bounties.mjs";
import { refreshOpenBounties, routes as bountyRoutes } from "./routes-bounties.mjs";
import { recordCheck, schema as auditSchema } from "./audit.mjs";
import { openDb } from "./db.mjs";
import { setPermission, storeLookup, upsertResearch } from "./evidence.mjs";

const T0 = "2026-11-02T09:00:00.000Z";
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60000).toISOString();
const HOUR = 60;
const DAY = 24 * HOUR;
const GTIN = "05012345678900";

// A stand-in for an estimateFromEvidence result (copied from
// bounties-fresh.test.mjs). 26 confirmed sales in 90 days is about 2.02 a
// week. The economics follow the units and the journey.
function fakeEstimate(over = {}) {
  const units = over.units ?? 2;
  const travel = over.journeyCost ?? 500;
  const minutes = over.journeyMinutes ?? 30;
  const contribution = units * 1000 - travel;
  const activeMinutes = minutes + 10 + units * 10;
  const unitProfit = Math.floor(contribution / units);
  return {
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
}

const JOURNEY = { cost: 300, minutes: 30 };
// Round 5: a member's trip profile (a car, so the units fit) and the cash
// they can spend on a trip; a claim without them is refused.
const CASH = 100000;
const FIT = { transport: "Car", carryKg: 25, storageUnits: 50 };
const ownCheck = (units, journey = JOURNEY) => fakeEstimate({ units, journeyCost: journey.cost, journeyMinutes: journey.minutes });
const claim = (db, args) =>
  rawClaim(db, { journey: args.journey ?? JOURNEY, check: ownCheck(args.units, args.journey ?? JOURNEY), cashAvailable: CASH, ...args });

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
const liveBounty = (db, over = {}, estimate = fakeEstimate(), { request = REQUEST, lookup = null, now = T0 } = {}) =>
  createBounty(db, bountyInput(over), { estimate, request, lookup, now });

const member = (db, name, over = {}) =>
  createMember(db, { name, alertsOptIn: true, alertLocalities: ["Camden"], ...FIT, ...over }, { now: T0 });
const diamond = (db, name, over = {}) => member(db, name, { paidTier: "diamond", paidUntil: "2026-12-31", ...over });

const check = (db, over = {}, now = at(10)) =>
  recordCheck(db, { barcode: GTIN, retailer: "Argos", locality: "Camden", method: "phone", inStock: true, unitsSeen: 1, ...over }, { now });
const viewAs = (db, bountyId, m, now) =>
  bountyView(db, requireBounty(db, bountyId), { viewer: m ? { kind: "member", member: m } : { kind: "operator" }, now });
const current = (db, memberId, bountyId) => memberNotices(db, memberId, { bountyId }).filter((n) => !n.superseded);

// An estimate for refreshOpenBounties that follows the request's units and
// journey, with `over` merged in.
const following = (over = () => ({})) => (_db, request) =>
  fakeEstimate({
    units: Number.isSafeInteger(request?.units) ? request.units : 2,
    journeyCost: Number.isSafeInteger(request?.costs?.journeyCost) ? request.costs.journeyCost : 500,
    journeyMinutes: Number.isSafeInteger(request?.costs?.journeyMinutes) ? request.costs.journeyMinutes : 30,
    ...over(request),
  });

// No competing listings, with a lookup that found none: cap 4 on 4 units.
const LOOKUP = { provider: "ebay", fetched: T0 };
const FOUR = { competition: { activeListings: 0, sellers: 0, lookup: LOOKUP }, stock: { check: { units_seen: 4 } } };
// A claim whose own figures use the same evidence (no competing listings).
const claimFour = (db, args) =>
  rawClaim(db, { journey: JOURNEY, check: fakeEstimate({ ...FOUR, units: args.units, journeyCost: JOURNEY.cost, journeyMinutes: JOURNEY.minutes }), cashAvailable: CASH, ...args });

// ------------------------------------------------- the real estimate (N1, N2)

const NOW = "2026-10-31T12:00:00.000Z";
const REAL_DAY = 86400000;
const ago = (n) => new Date(Date.parse(NOW) - n * REAL_DAY).toISOString().slice(0, 10);
const after = (minutes) => new Date(Date.parse(NOW) + minutes * 60000).toISOString();

/**
 * An in-memory database with the real estimate, audit and evidence modules
 * and the bounty routes on a test server with a controllable clock: one item
 * per entry of `items`, each with an offer at `retailer`, 26 recent sales, a
 * current asking-price lookup that found none and a branch check that saw
 * `unitsSeen`.
 */
async function world({ unitsSeen = 6, retailer = "Argos", promotion = null, items = [{ barcode: "5012345678115", title: "Mini Bluetooth speaker black", model: "BTS-20", sourceId: "o1" }] } = {}) {
  const clock = { now: NOW };
  const db = openDb(":memory:");
  for (const it of items) {
    const base = { title: it.title, barcode: it.barcode, size: "one size", pack: "1", model: it.model, condition: "new" };
    upsertResearch(
      db,
      "awin",
      [{ ...base, source_id: it.sourceId, kind: "Retail offer", price: 1200, observed: NOW, retailer, licence: "Licensed feed", ...(promotion ? { promotion } : {}) }],
      { now: NOW },
    );
    it.sales = Array.from({ length: 26 }, (_, i) => ({ source_id: it.barcode + "s" + i, seller: "seller" + i, observed: ago(1 + Math.floor((i * 80) / 26)), listed: ago(5 + i) }));
    upsertResearch(db, "sales", it.sales.map((s) => ({ ...base, ...s, kind: "Reported completed sale", price: 2800, retailer: "eBay UK", licence: "Self-reported" })), { now: NOW });
    storeLookup(db, "ebay", it.barcode, [], { now: NOW });
    // The check records the shelf price (the £12.00 the feed lists), so the
    // price applies at the branch checked (round 5).
    recordCheck(db, { barcode: it.barcode, retailer, locality: "Camden", checkedAt: NOW, method: "in_store", inStock: true, unitsSeen, pricePence: 1200 }, { now: NOW });
  }
  setPermission(db, { provider: "awin", display: true }, { now: NOW });
  const api = await serve(db, [{ routes: (x) => bountyRoutes(x, { clock: () => clock.now, photoDir: "/nonexistent-photos" }) }]);
  const call = (m, p, body) => api.call(m, p, body, { Origin: api.base });
  const request = (it, over = {}) => ({
    offer: { provider: "awin", sourceId: it.sourceId },
    sales: it.sales.map((s) => ({ provider: "sales", sourceId: s.source_id })),
    units: 1,
    weightKg: 0.4,
    costs: { postage: 300, packaging: 30, handlingMinutes: 5, journeyCost: 0, journeyMinutes: 15 },
    hourlyFloor: 800,
    locality: "Camden",
    ...over,
  });
  const bounty = (over = {}, { item = items[0], ...req } = {}) =>
    call("POST", "/api/bounties", {
      title: item.title, locality: "Camden", retailer, salesPerWeek: 10, sellWindowWeeks: 2,
      expiresAt: new Date(Date.parse(clock.now) + 5 * REAL_DAY).toISOString(), sponsored: false, estimate: request(item, req), ...over,
    });
  const join = async (name) =>
    (await call("POST", "/api/members", { name, alertsOptIn: true, alertLocalities: ["Camden"], paidTier: "diamond", paidUntil: "2027-06-01", ...FIT })).body.member;
  const view = async (id, viewer) => (await call("GET", `/api/bounties/${id}${viewer ? "?viewer=" + viewer : ""}`)).body.bounty;
  const TRIP = { journeyCost: 0, journeyMinutes: 15, cashAvailable: CASH };
  return { db, api, call, clock, bounty, join, view, TRIP, items };
}

test("after a member buys some of the units a check counted, the figures are worked out for the units left and the trip stays open (round 4, N1)", async () => {
  const w = await world({ unitsSeen: 3 });
  try {
    const created = await w.bounty({}, { units: 3 });
    assert.equal(created.status, 201);
    assert.equal(created.body.bounty.figures.units, 3);
    w.clock.now = after(10);
    const ann = await w.join("Ann");
    const cat = await w.join("Cat");
    const bob = await w.join("Bob");
    const a = await w.call("POST", "/api/bounties/1/claims", { memberId: ann.id, units: 1, ...w.TRIP });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal((await w.call("POST", "/api/bounties/1/claims", { memberId: cat.id, units: 1, ...w.TRIP })).status, 201);
    w.clock.now = after(20);
    assert.equal((await w.call("POST", `/api/claims/${a.body.claim.id}/complete`, { memberId: ann.id })).status, 200);
    // Bob's claim re-checks the evidence: 2 are left of the 3 the check saw,
    // so the figures are worked out for 2, not stopped for being for 3.
    w.clock.now = after(30);
    const b = await w.call("POST", "/api/bounties/1/claims", { memberId: bob.id, units: 1, ...w.TRIP });
    assert.equal(b.status, 201, b.body.error);
    const card = await w.view(1, cat.id);
    assert.equal(card.trip.go, true, card.trip.headline);
    assert.equal(card.figures.units, 2);
    assert.equal(card.alert.eligible, true);
    assert.deepEqual(card.shelfUnits.units, 2);
    assert.deepEqual(current(w.db, cat.id, 1).filter((n) => n.kind === "stop"), []);
    assert.ok(!card.estimate.checks.some((c) => c.id === "shelf-units" && c.ok === false));
  } finally {
    await w.api.close();
  }
});

test("a bounty opened after members bought units on an earlier one for the item counts them off the shelf and stays eligible (round 4, N1)", async () => {
  const w = await world({ unitsSeen: 3 });
  try {
    assert.equal((await w.bounty({}, { units: 3 })).status, 201);
    w.clock.now = after(10);
    const ann = await w.join("Ann");
    const a = await w.call("POST", "/api/bounties/1/claims", { memberId: ann.id, units: 1, ...w.TRIP });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    w.clock.now = after(20);
    assert.equal((await w.call("POST", `/api/claims/${a.body.claim.id}/complete`, { memberId: ann.id })).status, 200);
    assert.equal((await w.call("POST", "/api/bounties/1/withdraw", {})).status, 200);
    w.clock.now = after(30);
    const next = await w.bounty({}, { units: 3 });
    assert.equal(next.status, 201);
    assert.match(next.body.message, /^Bounty created \(Priority \d\) with a cap of 3 units/);
    const v = next.body.bounty;
    assert.equal(v.alert.canSend, true, v.alert.blockers.join("; "));
    assert.equal(v.figures.units, 2);
    // The card agrees with the estimate: 2 of the 3 seen are left.
    assert.deepEqual(v.shelfUnits, { units: 2, source: "stock check", at: NOW, boughtSince: 1 });
    assert.equal(v.remaining, 2);
  } finally {
    await w.api.close();
  }
});

test("after a member buys at a first-order price, their claim on another first-order bounty at the retailer stops, once (round 4, N2)", async () => {
  const FIRST = "New customers only: 30% off your first order";
  const w = await world({
    retailer: "Boots",
    promotion: FIRST,
    items: [
      { barcode: "5012345678115", title: "Mini Bluetooth speaker black", model: "BTS-20", sourceId: "o1" },
      { barcode: "5012345678443", title: "Travel hair dryer white", model: "HD-9", sourceId: "o2" },
    ],
  });
  try {
    const first = await w.bounty({}, { item: w.items[0], promotionEligible: true });
    const second = await w.bounty({}, { item: w.items[1], promotionEligible: true });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.bounty.promotion.firstOrder, true);
    const ann = await w.join("Ann");
    const bob = await w.join("Bob");
    w.clock.now = after(5);
    const c1 = await w.call("POST", "/api/bounties/1/claims", { memberId: ann.id, units: 1, ...w.TRIP, qualifiesForPromotion: true });
    const c2 = await w.call("POST", "/api/bounties/2/claims", { memberId: ann.id, units: 1, ...w.TRIP, qualifiesForPromotion: true });
    assert.equal(c1.status, 201, JSON.stringify(c1.body));
    assert.equal(c2.status, 201, JSON.stringify(c2.body));
    w.clock.now = after(30);
    const done = await w.call("POST", `/api/claims/${c1.body.claim.id}/complete`, { memberId: ann.id });
    assert.equal(done.status, 200);
    assert.equal(done.body.claim.promotionUsed, true);
    // Told at once, before anyone reads the second bounty.
    const stops = () => w.db.prepare("SELECT reason, message FROM notices WHERE bounty_id = 2 AND member_id = ? AND kind = 'stop'").all(ann.id);
    assert.deepEqual(stops().map((n) => n.reason), ["promotion-declined"]);
    assert.match(
      stops()[0].message,
      /^Don't make the trip: you have already used the first-order offer at Boots, so this price is not available to you \(you marked a claim at a first-order price there as bought on 31 Oct 2026\): release this claim$/,
    );
    // The operator's re-check re-costs her without the first-order price.
    w.clock.now = after(60);
    assert.equal((await w.call("POST", "/api/bounties/2/recheck", {})).status, 200);
    const card = await w.view(2, ann.id);
    assert.equal(card.trip.go, false);
    assert.equal(card.trip.state, "blocked");
    assert.equal(card.trip.reason, "promotion-declined");
    assert.equal(card.trip.label, "This price is not available to you");
    assert.equal(card.viewer.promotion?.confirmed ?? false, false);
    assert.equal(card.viewer.activeClaim.figures.ok, false);
    assert.equal(card.claims.find((c) => c.status === "active").paused, true);
    // Sent once, whatever reads and re-checks follow.
    await w.view(2, ann.id);
    await w.call("GET", `/api/members/${ann.id}/alerts`);
    await w.call("POST", "/api/bounties/2/recheck", {});
    assert.equal(stops().length, 1);
    const inbox = (await w.call("GET", `/api/members/${ann.id}/alerts`)).body;
    assert.deepEqual(inbox.stopNotices.filter((n) => n.bountyId === 2 && !n.superseded).map((n) => n.reason), ["promotion-declined"]);
    // A holder who answers that they do not qualify is stopped the same way.
    const b2 = await w.call("POST", "/api/bounties/2/claims", { memberId: bob.id, units: 1, ...w.TRIP, qualifiesForPromotion: true });
    assert.equal(b2.status, 201, JSON.stringify(b2.body));
    const no = await w.call("POST", "/api/bounties/2/eligibility", { memberId: bob.id, answer: "not" });
    assert.equal(no.status, 200);
    assert.equal(no.body.bounty.trip.reason, "promotion-declined");
    assert.match(no.body.bounty.trip.headline, /^Don't make the trip: you said you do not qualify for this price \("New customers only: 30% off your first order"\), so it is not available to you: release this claim/);
    assert.deepEqual(current(w.db, bob.id, 2).map((n) => [n.kind, n.reason]), [["stop", "promotion-declined"]]);
  } finally {
    await w.api.close();
  }
});

// ------------------------------------------------------ fake estimate (N3+)

test("units bought before a newer shelf count are taken off once, so a holder whose units are on the shelf keeps the claim (round 4, N3)", async () => {
  const db = memoryDb(schema, auditSchema);
  const b = liveBounty(db, {}, fakeEstimate(FOUR), { lookup: LOOKUP });
  assert.equal(b.cap, 4);
  const ann = diamond(db, "Ann");
  const bob = diamond(db, "Bob");
  const a = claimFour(db, { bountyId: b.id, memberId: ann.id, units: 2, now: at(1) });
  claimFour(db, { bountyId: b.id, memberId: bob.id, units: 2, now: at(2) });
  completeClaim(db, { claimId: a.id, memberId: ann.id, now: at(30) });
  // A branch check after Ann's purchase sees the 2 left: Bob's 2.
  check(db, { unitsSeen: 2 }, at(40));
  const card = viewAs(db, b.id, bob, at(41));
  assert.equal(card.trip.go, true, card.trip.headline);
  assert.notEqual(card.trip.reason, "over-claimed");
  assert.deepEqual(card.shelfUnits, { units: 2, source: "stock check", at: at(40), boughtSince: 0 });
  assert.deepEqual([card.cap, card.completedUnits, card.claimedUnits, card.remaining], [4, 2, 2, 0]);
  assert.deepEqual(current(db, bob.id, b.id), []);
  // The same after the evidence is worked out again with that check.
  const estimate = following(() => ({ ...FOUR, stock: { check: { units_seen: 2, checked_at: at(40) } } }));
  const out = await refreshOpenBounties(db, { now: at(42), estimate, askingLookup: () => ({ provider: "ebay", fetched: at(42) }) });
  assert.deepEqual([out.stopped, out.heldBack], [[], []]);
  const again = viewAs(db, b.id, bob, at(43));
  assert.equal(again.trip.go, true, again.trip.headline);
  assert.equal(again.cap, 4);
  assert.ok(
    again.capBasis.notes.includes("Units to share: 4, the 2 units counted on the latest stock check and the 2 units members bought through this bounty before it"),
    again.capBasis.notes.join(" | "),
  );
  assert.deepEqual(current(db, bob.id, b.id), []);
});

test("after purchases and a newer count, the units left can still be claimed and the card adds up (round 4, N3)", () => {
  const db = memoryDb(schema, auditSchema);
  const b = liveBounty(db, {}, fakeEstimate(FOUR), { lookup: LOOKUP });
  const ann = diamond(db, "Ann");
  const cy = diamond(db, "Cy");
  const a = claimFour(db, { bountyId: b.id, memberId: ann.id, units: 2, now: at(1) });
  completeClaim(db, { claimId: a.id, memberId: ann.id, now: at(30) });
  check(db, { unitsSeen: 2 }, at(40));
  const op = viewAs(db, b.id, null, at(41));
  // Cap 4: the 2 on the shelf and the 2 bought before the check.
  assert.deepEqual([op.cap, op.completedUnits, op.claimedUnits, op.remaining], [4, 2, 0, 2]);
  assert.equal(op.trip.state, "go");
  assert.equal(dispatchAlerts(db, b.id, at(41)).exposure.remaining, 2);
  assert.equal(claimFour(db, { bountyId: b.id, memberId: cy.id, units: 2, now: at(42) }).units, 2);
  assert.equal(viewAs(db, b.id, null, at(43)).remaining, 0);
});

test("with no room left a holder is told so, never 'the first 0 units' (round 4, N3)", () => {
  const db = memoryDb(schema, auditSchema);
  const b = liveBounty(db);
  const ann = diamond(db, "Ann");
  claim(db, { bountyId: b.id, memberId: ann.id, units: 1, now: at(1) });
  // A newer check found stock but recorded no count: nothing can be shared.
  check(db, { unitsSeen: undefined }, at(10));
  const card = viewAs(db, b.id, ann, at(11));
  assert.equal(card.trip.go, false);
  assert.equal(card.trip.reason, "over-claimed");
  assert.doesNotMatch(card.trip.headline, /first 0/);
  assert.match(card.trip.headline, /\. No claim held now can be met, yours included: release your claim$/);
  for (const n of memberNotices(db, ann.id)) assert.doesNotMatch(n.message, /first 0/);
  assert.doesNotMatch(viewAs(db, b.id, null, at(11)).trip.headline, /first 0|more than the shelf holds/);
});

test("a positive competing-listings count holds for 7 x 24 hours, not a moment longer (round 4, N4)", () => {
  const db = memoryDb(schema, auditSchema);
  const b = liveBounty(db, { expiresAt: at(10 * DAY) });
  const seven = Date.parse(T0) + 7 * 86400000;
  const atSeven = competitionNow(b, new Date(seven).toISOString());
  assert.equal(atSeven.lapsed, false);
  assert.equal(atSeven.until, new Date(seven).toISOString());
  const past = new Date(seven + 1).toISOString();
  assert.equal(competitionNow(b, past).lapsed, true);
  assert.ok(blockerList(db, b, past).some((x) => x.id === "competition-lapsed"));
  assert.ok(viewAs(db, b.id, null, past).claimBlockers.some((t) => /^The latest asking-price check \(2 Nov 2026\) is more than 7 days old/.test(t)));
  // A listing dated after the re-check that counted it lapses from the re-check.
  const db2 = memoryDb(schema, auditSchema);
  const ahead = liveBounty(db2, { expiresAt: at(10 * DAY) }, fakeEstimate({ competition: { checkedAt: at(2 * HOUR) } }));
  assert.equal(competitionNow(ahead, new Date(seven + 1).toISOString()).lapsed, true);
  assert.equal(competitionNow(ahead, at(1)).lapsed, false);
});

test("sale dates are aged in UK days, as the estimate ages them (round 4, N5)", () => {
  const db = memoryDb(schema, auditSchema);
  const used = ["2026-05-02", "2026-07-01", "2026-07-20"].map((observed, i) => ({ seller: `Seller ${i + 1}`, observed, price: 3200 }));
  const b = liveBounty(db, {}, fakeEstimate({ sample: { used, count: 3, independent: 3, oldest: "2026-05-02" } }));
  const sample = JSON.parse(b.estimate).sample;
  assert.deepEqual(sample.dates, ["2026-05-02", "2026-07-01", "2026-07-20"]);
  assert.deepEqual(sample.sellers, ["2026-05-02", "2026-07-01", "2026-07-20"]);
  // 00:30 on 1 August in London: 2 May is 91 UK days old, so it no longer counts.
  const late = "2026-07-31T23:30:00.000Z";
  assert.deepEqual(salesNow(b, late), { counted: 3, recent: 2, enough: false, total: 3, recentSales: 2 });
  assert.deepEqual(salesNow(b, "2026-07-31T22:30:00.000Z"), { counted: 3, recent: 3, enough: true, total: 3, recentSales: 3 });
  // A snapshot stored before this change kept the date as midnight UTC.
  const legacy = { sample: 0, estimate: JSON.stringify({ sample: { count: 3, oldest: "2026-05-02", sellers: used.map((u) => u.observed + "T00:00:00.000Z"), dates: used.map((u) => u.observed + "T00:00:00.000Z") } }) };
  assert.deepEqual(salesNow(legacy, late), { counted: 3, recent: 2, enough: false, total: 3, recentSales: 2 });
});

test("a branch check after an empty-shelf report lifts the pause, and the card agrees with itself (round 4, R3P7)", () => {
  const db = memoryDb(schema, auditSchema);
  const b = liveBounty(db);
  const bob = diamond(db, "Bob");
  const ann = diamond(db, "Ann");
  dispatchAlerts(db, b.id, T0);
  addReport(db, { bountyId: b.id, memberId: bob.id, unitsSeen: 0 }, { now: at(5) });
  assert.equal(viewAs(db, b.id, ann, at(6)).trip.state, "paused");
  check(db, { unitsSeen: 7 }, at(20));
  const card = viewAs(db, b.id, ann, at(21));
  assert.equal(card.trip.go, true, card.trip.headline);
  assert.equal(card.shelf.paused, false);
  assert.deepEqual(card.shelfUnits, { units: 7, source: "stock check", at: at(20), boughtSince: 0 });
  assert.ok(!card.claimBlockers.length, card.claimBlockers.join("; "));
  assert.ok(!card.estimate.checks.some((c) => ["local-stock", "availability"].includes(c.id) && c.ok === false));
  // A later check that finds none stops it as out of stock, not paused.
  check(db, { inStock: false, unitsSeen: 0 }, at(30));
  assert.equal(viewAs(db, b.id, ann, at(31)).trip.state, "out-of-stock");
  // An empty-shelf report dated before a branch check on record stops nobody.
  const db2 = memoryDb(schema, auditSchema);
  const b2 = liveBounty(db2);
  const cy = diamond(db2, "Cy");
  const dee = diamond(db2, "Dee");
  dispatchAlerts(db2, b2.id, T0);
  check(db2, { unitsSeen: 5 }, at(30));
  addReport(db2, { bountyId: b2.id, memberId: cy.id, unitsSeen: 0, observedAt: at(20) }, { now: at(31) });
  assert.deepEqual(memberNotices(db2, dee.id), []);
  assert.equal(viewAs(db2, b2.id, dee, at(32)).trip.go, true);
});

test("a holder whose figures now make a loss reads -£ or 'a loss of', never £-", async () => {
  const db = memoryDb(schema, auditSchema);
  const b = liveBounty(db);
  const fay = diamond(db, "Fay");
  claim(db, { bountyId: b.id, memberId: fay.id, units: 1, journey: { cost: 1500, minutes: 30 }, now: at(1) });
  const estimate = following((req) =>
    req.costs?.journeyCost >= 1500
      ? {
          opportunity: { tier: "Watch", meetsThresholds: false, unitProfit: -500, reasons: ["Profit per unit below £5"] },
          alert: { eligible: false, reasons: ["Profit per unit below £5"], checks: [] },
        }
      : {},
  );
  await refreshOpenBounties(db, { now: at(6), estimate, askingLookup: () => null });
  const n = current(db, fay.id, b.id);
  assert.deepEqual(n.map((x) => x.reason), ["own-figures"]);
  assert.match(n[0].message, /now fail \(a loss of £5\.00 a unit\): Profit per unit below £5$/);
  assert.doesNotMatch(n[0].message, /£-/);
});

test("a lowered cap note counts the units bought since, so it agrees with the shelf line (round 4)", () => {
  const db = memoryDb(schema, auditSchema);
  const b = liveBounty(db, {}, fakeEstimate({ stock: { check: { units_seen: 6 } } }));
  const ann = diamond(db, "Ann");
  const eve = diamond(db, "Eve");
  const a = claim(db, { bountyId: b.id, memberId: ann.id, units: 2, now: at(1) });
  addReport(db, { bountyId: b.id, memberId: eve.id, unitsSeen: 2 }, { now: at(5) });
  completeClaim(db, { claimId: a.id, memberId: ann.id, now: at(10) });
  const card = viewAs(db, b.id, null, at(11));
  assert.deepEqual(card.shelfUnits, { units: 0, source: "stock report", at: at(5), boughtSince: 2 });
  assert.ok(
    card.capBasis.notes.includes(
      "Units to share lowered to 2: the latest stock report (2 Nov 2026, 09:05) saw 2 units, and members have bought 2 units since, so none are likely left on the shelf",
    ),
    card.capBasis.notes.join(" | "),
  );
  // With units still on the shelf it says how many.
  const db2 = memoryDb(schema, auditSchema);
  const b2 = liveBounty(db2, {}, fakeEstimate({ stock: { check: { units_seen: 6 } } }));
  const cy = diamond(db2, "Cy");
  const dee = diamond(db2, "Dee");
  const c = claim(db2, { bountyId: b2.id, memberId: cy.id, units: 1, now: at(1) });
  addReport(db2, { bountyId: b2.id, memberId: dee.id, unitsSeen: 2 }, { now: at(5) });
  completeClaim(db2, { claimId: c.id, memberId: cy.id, now: at(10) });
  const card2 = viewAs(db2, b2.id, null, at(11));
  assert.equal(card2.shelfUnits.units, 1);
  assert.ok(
    card2.capBasis.notes.includes(
      "Units to share lowered to 2: the latest stock report (2 Nov 2026, 09:05) saw 2 units, and members have bought 1 unit since, so about 1 unit is likely left on the shelf",
    ),
    card2.capBasis.notes.join(" | "),
  );
});
