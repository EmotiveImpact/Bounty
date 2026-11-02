// Round 5, finding 1: a price seen at one branch must never qualify a trip
// to another. An Open Prices price of £12 at Home Bargains in Preston with
// a stock check in Camden used to pass every alert check and let a member
// claim the bounty. The price now counts only when a branch check recorded
// the shelf price there, or the offer is an Open Prices price from the same
// identified shop; an online price never counts by itself.
//
// The route tests run the research estimate, bounty creation, alerts and
// claims on the server clock, as the app does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.mjs";
import { memoryDb, serve } from "./test-support.mjs";
import { londonDate } from "./http.mjs";
import { KIND, LICENCE } from "./contract.mjs";
import { schema as evidenceSchema, setPermission, storeLookup, upsertObservations, upsertResearch } from "./evidence.mjs";
import {
  AUDIT_FAILURES,
  MAX_SHELF_PRICE_PENCE,
  recordCheck,
  recordItem,
  sameBranch,
  schema as auditSchema,
  shopIsBranch,
} from "./audit.mjs";
import { estimateFromEvidence } from "./estimate.mjs";
import { evaluateAlert } from "./alerts.mjs";
import { classifyOpportunity } from "./opportunity.mjs";
import { blockerList, memberNotices, offerNow, recheckOpenBounties, requireBounty } from "./bounties.mjs";
import { defaults, planTrips } from "./catalog.mjs";
import * as researchRoutes from "./routes-research.mjs";
import * as bountyRoutes from "./routes-bounties.mjs";

const DAY = 86400000;
const HOUR = 3600000;
const GTIN = "5012345678115";
const TITLE = "Mini Bluetooth speaker black";
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const ukDay = (days) => londonDate(new Date(Date.now() - days * DAY));
const PRESTON_REASON =
  "The £12.00 price was seen at Home Bargains, PR1 2AR, Preston, not at the branch checked in Camden: record the shelf price on a branch check there";

// Open Prices: £12.00 at Home Bargains, PR1 2AR, Preston (node/111), today.
const PRESTON = {
  id: 900001,
  title: TITLE,
  store: "Home Bargains",
  place: "PR1 2AR",
  city: "Preston",
  osm_id: "node/111",
  price: 1200,
  barcode: GTIN,
};
const ITEM = { title: TITLE, barcode: GTIN, size: "one size", pack: "1", model: "BTS-20", condition: "new" };
// 26 independent completed sales at £28 over 80 days, so demand and days to
// sell pass for a single unit.
const SALES = Array.from({ length: 26 }, (_, i) => {
  const sold = 1 + Math.floor((i * 80) / 26);
  return { source_id: "s" + i, seller: "seller" + i, observed: ukDay(sold), listed: ukDay(sold + 4) };
});

function evidence({ observations = [{ ...PRESTON, day: ukDay(0) }], awin = null } = {}) {
  const now = new Date().toISOString();
  const db = openDb(":memory:");
  upsertObservations(db, observations, { now });
  upsertResearch(
    db,
    "sales",
    SALES.map((s) => ({ ...ITEM, ...s, kind: KIND.SOLD, price: 2800, retailer: "eBay UK", licence: LICENCE.SELF })),
    { now },
  );
  if (awin) {
    upsertResearch(
      db,
      "awin",
      [{ ...ITEM, source_id: "A1", kind: KIND.RETAIL, price: awin, observed: ukDay(0), retailer: "Home Bargains", licence: LICENCE.FEED }],
      { now },
    );
    setPermission(db, { provider: "awin", programme: "Home Bargains", display: true }, { now });
  }
  storeLookup(db, "ebay", GTIN, [], { now });
  return db;
}

// The estimate request the Research page sends for one unit, by foot.
const request = (over = {}) => ({
  offer: { provider: "openprices", sourceId: "900001" },
  sales: SALES.map((s) => ({ provider: "sales", sourceId: s.source_id })),
  units: 1,
  weightKg: 0.4,
  costs: { postage: 300, packaging: 30, handlingMinutes: 5, journeyCost: 0, journeyMinutes: 15 },
  hourlyFloor: 800,
  locality: "Camden",
  offerAttributes: { pack: "1", model: "BTS-20", condition: "new", size: "one size" },
  category: "general",
  categoryReason: "A loudspeaker, not food: Open Prices suggests Food for every observation",
  // Round 5 (suitability): the operator's own transport, carrying limit,
  // cash and storage; without them the trip is never eligible.
  profile: { transport: "Walk", carryKg: 5, cashAvailable: 100000, storageUnits: 20 },
  ...over,
});
const AWIN = { offer: { provider: "awin", sourceId: "A1" }, offerAttributes: undefined };

async function app(db) {
  const api = await serve(db, [
    { routes: researchRoutes.routes },
    { routes: (x) => bountyRoutes.routes(x, { clock: () => new Date().toISOString(), photoDir: "/nonexistent-photos" }) },
  ]);
  const call = (method, path, body) => api.call(method, path, body, { Origin: api.base });
  const bountyFor = (estimate, over = {}) =>
    call("POST", "/api/bounties", {
      title: "Mini speaker",
      locality: estimate.locality ?? "Camden",
      retailer: "Home Bargains",
      salesPerWeek: 10,
      sellWindowWeeks: 2,
      expiresAt: new Date(Date.now() + 5 * DAY).toISOString(),
      sponsored: false,
      estimate,
      ...over,
    });
  const member = async (name, locality = "Camden") =>
    (
      await call("POST", "/api/members", {
        name,
        alertsOptIn: true,
        alertLocalities: [locality],
        paidTier: "diamond",
        paidUntil: new Date(Date.now() + 200 * DAY).toISOString().slice(0, 10),
        // Round 5 (suitability): a member is only alerted, and can only claim,
        // once their transport, carrying limit and storage are known.
        transport: "Car",
        carryKg: 25,
        storageUnits: 50,
      })
    ).body.member;
  const claim = (bountyId, memberId) =>
    call("POST", `/api/bounties/${bountyId}/claims`, {
      memberId,
      units: 1,
      journeyCost: 0,
      journeyMinutes: 15,
      cashAvailable: 100000,
    });
  return { api, call, bountyFor, member, claim, close: () => api.close() };
}

const priceCheck = (estimate) => estimate.alert.checks.find((c) => c.id === "price-at-branch");
const row = (db, id) => db.prepare("SELECT alert_eligible, alert_reasons FROM bounties WHERE id = ?").get(id);
const camdenCheck = (over = {}) => ({
  barcode: GTIN,
  retailer: "Home Bargains",
  locality: "Camden",
  method: "in_store",
  inStock: true,
  unitsSeen: 6,
  ...over,
});

test("a Preston price with a Camden stock check is ineligible end to end: no alert and no claim", async () => {
  const db = evidence();
  const a = await app(db);
  try {
    const check = await a.call("POST", "/api/research/checks", camdenCheck());
    assert.equal(check.status, 201);
    assert.equal(check.body.price_pence, null, "a check without a shelf price records none");
    assert.equal(check.body.branch, null);

    const est = await a.call("POST", "/api/research/estimate", request());
    assert.equal(est.status, 200);
    assert.equal(est.body.stock.confirmed, true, "the Camden check does confirm Camden stock");
    assert.equal(est.body.alert.eligible, false);
    assert.equal(priceCheck(est.body).ok, false);
    assert.equal(priceCheck(est.body).detail, PRESTON_REASON);
    assert.equal(est.body.priceAtBranch.confirmed, false);
    assert.equal(est.body.priceAtBranch.seen.where, "Home Bargains, PR1 2AR, Preston");
    assert.equal(est.body.opportunity.tier, "Review", "an unconfirmed price is an evidence gap");
    assert.ok(est.body.opportunity.reasons.includes(PRESTON_REASON));
    assert.ok(est.body.warnings.includes(PRESTON_REASON));
    assert.equal(est.body.offer.price, 1200, "the offer is shown as seen");

    const created = await a.bountyFor(request());
    assert.equal(created.status, 201);
    const id = created.body.bounty.id;
    assert.equal(row(db, id).alert_eligible, 0);
    assert.ok(JSON.parse(row(db, id).alert_reasons).includes(PRESTON_REASON));
    assert.match(created.body.message, /cannot send alerts or take claims/);

    const ann = await a.member("Ann");
    const sent = await a.call("POST", `/api/bounties/${id}/alerts`, {});
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body.sent, []);
    const claimed = await a.claim(id, ann.id);
    assert.equal(claimed.status, 409);
    assert.match(claimed.body.error, /seen at Home Bargains, PR1 2AR, Preston, not at the branch checked in Camden/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM claims").get().n, 0);
  } finally {
    await a.close();
  }
});

test("a Camden check with the shelf price passes, costs the trip at it and dates it at the check", async () => {
  const db = evidence();
  const a = await app(db);
  try {
    const check = await a.call(
      "POST",
      "/api/research/checks",
      camdenCheck({ branch: "Home Bargains, Camden High Street NW1 7JE", pricePence: 1250 }),
    );
    assert.equal(check.status, 201);
    assert.equal(check.body.price_pence, 1250);
    assert.equal(check.body.branch, "Home Bargains, Camden High Street NW1 7JE");

    const est = await a.call("POST", "/api/research/estimate", request());
    assert.equal(est.body.alert.eligible, true, est.body.alert.reasons.join("; "));
    assert.equal(priceCheck(est.body).detail, "Shelf price recorded on the branch check");
    assert.equal(est.body.priceAtBranch.basis, "check");
    assert.equal(est.body.priceAtBranch.price, 1250);
    // The figures use the Camden shelf price, dated at the check, not the
    // £12.00 seen in Preston.
    assert.equal(est.body.offer.price, 1250);
    assert.equal(est.body.unitCost, 1250);
    assert.equal(est.body.offer.observed, check.body.checked_at);
    assert.equal(est.body.offer.location, "Home Bargains, Camden High Street NW1 7JE, Camden");
    assert.equal(est.body.offer.seenOffer.price, 1200);
    assert.equal(est.body.offer.shelfPrice.id, check.body.id);
    assert.ok(est.body.warnings.some((w) => /shelf price at the branch is £12\.50/.test(w)));

    const created = await a.bountyFor(request());
    assert.equal(created.status, 201);
    const id = created.body.bounty.id;
    assert.equal(row(db, id).alert_eligible, 1, row(db, id).alert_reasons);
    const ann = await a.member("Ann");
    const sent = await a.call("POST", `/api/bounties/${id}/alerts`, {});
    assert.deepEqual(sent.body.sent.map((s) => s.memberId), [ann.id]);
    const claimed = await a.claim(id, ann.id);
    assert.equal(claimed.status, 201, claimed.body.error);
  } finally {
    await a.close();
  }
});

test("an Open Prices price from the shop the check names passes; a town, a borough or another shop never does", async () => {
  const db = evidence();
  const a = await app(db);
  const preston = request({ locality: "Preston" });
  const outcome = async (branch, locality = "Preston") => {
    db.prepare("DELETE FROM availability_checks").run();
    const check = await a.call("POST", "/api/research/checks", camdenCheck({ locality, branch }));
    assert.equal(check.status, 201, JSON.stringify(check.body));
    return (await a.call("POST", "/api/research/estimate", locality === "Preston" ? preston : request())).body;
  };
  try {
    for (const branch of ["node/111", "Home Bargains, OpenStreetMap node/111", "Home Bargains, Fishergate, pr1 2ar"]) {
      const est = await outcome(branch);
      assert.equal(est.priceAtBranch.confirmed, true, branch + ": " + est.priceAtBranch.reason);
      assert.equal(est.priceAtBranch.basis, "same-shop", branch);
      assert.equal(priceCheck(est).detail, "Price seen at the same shop the branch check covers");
      assert.equal(est.offer.price, 1200);
      assert.equal(est.offer.observed, ukDay(0), "a same-shop price keeps the observation's date");
      assert.equal(est.alert.eligible, true, branch + ": " + est.alert.reasons.join("; "));
    }
    for (const branch of ["Preston", "Home Bargains Preston", "node/222", "Home Bargains, PR1 3AB"]) {
      const est = await outcome(branch);
      assert.equal(est.priceAtBranch.confirmed, false, branch);
      assert.equal(est.alert.eligible, false, branch);
      assert.equal(
        priceCheck(est).detail,
        `The £12.00 price was seen at Home Bargains, PR1 2AR, Preston, not at the branch checked in Preston (${branch}): record the shelf price on a branch check there`,
      );
    }
    // The same shop's price needs a check that names the shop: one that
    // names no branch never matches it.
    const unnamed = await outcome(null);
    assert.equal(unnamed.priceAtBranch.confirmed, false);
  } finally {
    await a.close();
  }
});

test("an online price never applies at a branch by itself; a shelf price on the check does", async () => {
  const db = evidence({ awin: 1200 });
  const a = await app(db);
  try {
    await a.call("POST", "/api/research/checks", camdenCheck({ branch: "node/111" }));
    const est = await a.call("POST", "/api/research/estimate", request(AWIN));
    assert.equal(est.status, 200, est.body.error);
    assert.equal(est.body.alert.eligible, false);
    assert.equal(
      priceCheck(est.body).detail,
      "The £12.00 price is an online price from the Awin affiliate feed, not a shelf price at the branch checked in Camden (node/111): record the shelf price on a branch check there",
    );
    assert.equal(est.body.opportunity.tier, "Review");
    const refused = await a.bountyFor(request(AWIN));
    assert.equal(row(db, refused.body.bounty.id).alert_eligible, 0);
    await a.call("POST", `/api/bounties/${refused.body.bounty.id}/withdraw`, {});

    await a.call("POST", "/api/research/checks", camdenCheck({ branch: "node/111", pricePence: 1100 }));
    const priced = await a.call("POST", "/api/research/estimate", request(AWIN));
    assert.equal(priced.body.alert.eligible, true, priced.body.alert.reasons.join("; "));
    assert.equal(priced.body.offer.price, 1100);
    assert.equal(priced.body.offer.seenOffer.online, true);
    const created = await a.bountyFor(request(AWIN));
    assert.equal(row(db, created.body.bounty.id).alert_eligible, 1);
    const ann = await a.member("Ann");
    assert.equal((await a.claim(created.body.bounty.id, ann.id)).status, 201);
  } finally {
    await a.close();
  }
});

test("an earlier shelf price at the same branch stands behind a newer check without one; another branch's does not", () => {
  const db = evidence({ awin: 1200 });
  const now = new Date().toISOString();
  const run = () => estimateFromEvidence(db, request(AWIN), { now });
  recordCheck(db, camdenCheck({ branch: "Home Bargains NW1 7JE", pricePence: 1150, checkedAt: ago(5 * HOUR) }), { now });
  const stockOnly = recordCheck(db, camdenCheck({ checkedAt: ago(1 * HOUR) }), { now });
  let r = run();
  assert.equal(r.stock.check.id, stockOnly.id, "the newer check decides stock");
  assert.equal(r.priceAtBranch.basis, "check");
  assert.equal(r.priceAtBranch.price, 1150, "a check that names no branch is the same shelf");
  assert.equal(r.offer.price, 1150);

  // A newer check that names another branch is not the shelf that was priced.
  db.prepare("DELETE FROM availability_checks WHERE id = ?").run(stockOnly.id);
  recordCheck(db, camdenCheck({ branch: "Home Bargains NW5 2HP", checkedAt: ago(1 * HOUR) }), { now });
  r = run();
  assert.equal(r.priceAtBranch.confirmed, false);
  assert.match(r.priceAtBranch.reason, /not a shelf price at the branch checked in Camden \(Home Bargains NW5 2HP\)/);
  // The same branch named again keeps the price.
  recordCheck(db, camdenCheck({ branch: "home bargains, nw1 7je", checkedAt: ago(0.5 * HOUR) }), { now });
  assert.equal(run().priceAtBranch.price, 1150);
  assert.equal(sameBranch("Home Bargains NW1 7JE", "home bargains, nw1 7je"), true);
  assert.equal(sameBranch("Camden", "Camden"), true, "the same words name the same branch");
  assert.equal(sameBranch("Camden", null), false);
  assert.equal(sameBranch("node/1", "node/2"), false);
});

test("a shelf price more than 7 days old no longer applies, and says so", () => {
  const db = evidence({ awin: 1200 });
  const now = new Date().toISOString();
  recordCheck(db, camdenCheck({ pricePence: 1150, checkedAt: ago(8 * DAY) }), { now });
  recordCheck(db, camdenCheck({ checkedAt: ago(1 * HOUR) }), { now });
  const r = estimateFromEvidence(db, request(AWIN), { now });
  assert.equal(r.priceAtBranch.confirmed, false);
  assert.match(
    r.priceAtBranch.reason,
    /^The shelf price on the branch check in Camden \(£11\.50, .+\) is more than 7 days old, and the £12\.00 price is an online price from the Awin affiliate feed, not a shelf price at the branch checked in Camden: record the shelf price on a branch check there$/,
  );
  assert.equal(r.alert.eligible, false);
});

test("with no branch check at all the price is unconfirmed and the estimate goes to Review", () => {
  const db = evidence();
  const r = estimateFromEvidence(db, request(), { now: new Date().toISOString() });
  assert.equal(r.priceAtBranch.confirmed, false);
  assert.equal(
    r.priceAtBranch.reason,
    "The £12.00 price was seen at Home Bargains, PR1 2AR, Preston, and no branch check in Camden from the last 2 days shows it applies there: record the shelf price on a branch check there",
  );
  assert.equal(r.opportunity.tier, "Review");
  const none = estimateFromEvidence(db, request({ locality: undefined }), { now: new Date().toISOString() });
  assert.match(none.priceAtBranch.reason, /no locality is entered/);
});

test("on the same day a shelf price and the same shop's price both apply, the higher one is used", () => {
  const db = evidence();
  const now = new Date().toISOString();
  recordCheck(db, camdenCheck({ locality: "Preston", branch: "node/111", pricePence: 1100, checkedAt: ago(1 * HOUR) }), { now });
  const r = estimateFromEvidence(db, request({ locality: "Preston" }), { now });
  assert.equal(r.priceAtBranch.basis, "same-shop");
  assert.equal(r.offer.price, 1200);
  db.prepare("UPDATE availability_checks SET price_pence = 1300").run();
  const higher = estimateFromEvidence(db, request({ locality: "Preston" }), { now });
  assert.equal(higher.priceAtBranch.basis, "check");
  assert.equal(higher.offer.price, 1300);
});

test("checks record the branch and shelf price in whole pence, and older tables gain the columns", () => {
  const db = memoryDb(auditSchema);
  const now = "2026-11-01T12:00:00.000Z";
  const base = { barcode: GTIN, retailer: "Home Bargains", locality: "Camden", method: "phone", inStock: true, checkedAt: "2026-11-01T11:00:00.000Z" };
  const saved = recordCheck(db, { ...base, branch: "  Home Bargains,  NW1 7JE ", pricePence: 1250 }, { now });
  assert.equal(saved.price_pence, 1250);
  assert.equal(saved.branch, "Home Bargains,  NW1 7JE");
  for (const blank of [undefined, null, ""]) assert.equal(recordCheck(db, { ...base, pricePence: blank }, { now }).price_pence, null);
  for (const bad of [0, -1, 12.5, "12.50", "1250", MAX_SHELF_PRICE_PENCE + 1, true, Number.NaN])
    assert.throws(
      () => recordCheck(db, { ...base, pricePence: bad }, { now }),
      /pricePence must be the shelf price for one unit in whole pence, from 1 to 10000000/,
      String(bad),
    );
  assert.throws(() => recordCheck(db, { ...base, branch: "x".repeat(201) }, { now }), /branch/);
  // Existing validations still hold.
  assert.throws(() => recordCheck(db, { ...base, method: "feed", pricePence: 1250 }, { now }));
  assert.throws(() => recordCheck(db, { ...base, checkedAt: "2026-11-02T12:00:00.000Z", pricePence: 1250 }, { now }));

  const old = new DatabaseSync(":memory:");
  old.exec(`CREATE TABLE availability_checks (id INTEGER PRIMARY KEY, barcode TEXT NOT NULL,
 retailer TEXT NOT NULL, locality TEXT NOT NULL, checked_at TEXT NOT NULL, method TEXT NOT NULL,
 in_stock INTEGER NOT NULL)`);
  old.exec("INSERT INTO availability_checks(barcode, retailer, locality, checked_at, method, in_stock) VALUES('05012345678115', 'Home Bargains', 'Camden', '2026-11-01T10:00:00.000Z', 'phone', 1)");
  auditSchema(old);
  auditSchema(old);
  const columns = old.prepare("PRAGMA table_info(availability_checks)").all().map((c) => c.name);
  assert.ok(columns.includes("branch") && columns.includes("price_pence"));
  const kept = old.prepare("SELECT branch, price_pence FROM availability_checks").get();
  assert.deepEqual({ ...kept }, { branch: null, price_pence: null }, "an old check has no shelf price, never zero");
});

test("the gate fails closed without the price at the branch and the tier goes to Review", () => {
  const passing = {
    evidenceClass: "live",
    match: "exact",
    contribution: 2000,
    hourly: 2000,
    hourlyFloor: 0,
    journeyKnown: true,
    missingInputs: [],
    offerObserved: "2026-10-31",
    now: "2026-10-31T12:00:00Z",
    localStockConfirmed: true,
    availability: "in_stock",
    shippingKnown: true,
    recentIndependentSales: 8,
    daysToSell: 5,
    displayPermitted: true,
    meetsThresholds: true,
    units: 1,
    demandUnits: 4,
    // The trip fits the person making it (round 5, finding 4).
    suitability: "per-member",
  };
  const gate = (over) => evaluateAlert({ ...passing, ...over }).checks.find((c) => c.id === "price-at-branch");
  assert.deepEqual(gate({}), {
    id: "price-at-branch",
    ok: false,
    detail: "The price is not shown to apply at the branch checked: record the shelf price on a branch check there",
  });
  assert.equal(gate({ priceAtBranch: "yes" }).ok, false, "only true passes");
  assert.equal(gate({ priceAtBranch: false, priceAtBranchReason: PRESTON_REASON }).detail, PRESTON_REASON);
  assert.equal(gate({ priceAtBranch: true }).detail, "Shelf price recorded on the branch check");
  assert.equal(gate({ priceAtBranch: true, priceAtBranchBasis: "same-shop" }).detail, "Price seen at the same shop the branch check covers");
  assert.equal(evaluateAlert({ ...passing, priceAtBranch: true }).eligible, true);

  const economics = { units: 1, unitCost: 1000, contribution: 900, hourly: 2000 };
  const strong = { unitPrice: 1000, weightKg: 0.4, independentSales: 8, daysToSell: 5, sourcingPressure: 0.2, resaleWeeksOfSupply: 1, categoryFailures: [], economics };
  const unconfirmed = classifyOpportunity({ ...strong, alert: evaluateAlert({ ...passing, priceAtBranchReason: PRESTON_REASON }) });
  assert.equal(unconfirmed.tier, "Review");
  assert.ok(unconfirmed.reasons.includes(PRESTON_REASON));
  assert.notEqual(classifyOpportunity({ ...strong, alert: evaluateAlert({ ...passing, priceAtBranch: true }) }).tier, "Review");
});

test("a newer, higher shelf price at the bounty's branch is price-rose; a check without a price changes nothing", async () => {
  const db = evidence();
  const a = await app(db);
  try {
    const first = await a.call("POST", "/api/research/checks", camdenCheck({ pricePence: 1250, checkedAt: ago(3 * HOUR) }));
    const created = await a.bountyFor(request());
    const id = created.body.bounty.id;
    assert.equal(row(db, id).alert_eligible, 1, row(db, id).alert_reasons);
    const ann = await a.member("Ann");
    assert.equal((await a.call("POST", `/api/bounties/${id}/alerts`, {})).body.sent.length, 1);
    const live = () => offerNow(db, requireBounty(db, id), new Date().toISOString());
    assert.deepEqual(
      { price: live().price, rose: live().rose, was: live().was, observed: live().observed },
      { price: 1250, rose: false, was: 1250, observed: first.body.checked_at },
    );

    // Recorded straight to the table, so no re-check works the figures out
    // again: the bounty's own reading of the evidence must catch it.
    const now = new Date().toISOString();
    const unpriced = recordCheck(db, camdenCheck({ checkedAt: ago(2 * HOUR) }), { now });
    assert.equal(live().price, 1250, "a check without a price changes nothing");
    assert.equal(live().rose, false);
    assert.ok(!blockerList(db, requireBounty(db, id), now).some((b) => b.id === "price-rose"));

    const lower = recordCheck(db, camdenCheck({ pricePence: 1100, checkedAt: ago(1.5 * HOUR) }), { now });
    assert.deepEqual({ price: live().price, rose: live().rose, fell: live().fell }, { price: 1100, rose: false, fell: true });

    const higher = recordCheck(db, camdenCheck({ pricePence: 1400, checkedAt: ago(1 * HOUR) }), { now });
    assert.deepEqual(
      { price: live().price, rose: live().rose, was: live().was, observed: live().observed },
      { price: 1400, rose: true, was: 1250, observed: higher.checked_at },
    );
    const blockers = blockerList(db, requireBounty(db, id), now);
    const rose = blockers.find((b) => b.id === "price-rose");
    assert.ok(rose, JSON.stringify(blockers));
    const result = recheckOpenBounties(db, { barcode: higher.barcode, retailer: "Home Bargains", now });
    assert.deepEqual(result.stopped.map((s) => s.bountyId), [id]);
    const stops = memberNotices(db, ann.id, { bountyId: id }).filter((n) => n.kind === "stop");
    assert.ok(stops.some((n) => /risen from £12\.50 to £14\.00/.test(n.message)), JSON.stringify(stops));
    // A claim works the figures out again on the latest evidence first, so
    // it is judged at the £14.00 shelf price, which still pays here.
    assert.equal((await a.claim(id, ann.id)).status, 201);
    assert.equal(JSON.parse(requireBounty(db, id).estimate).offer.price, 1400);
    assert.ok(unpriced.id < lower.id && lower.id < higher.id);
  } finally {
    await a.close();
  }
});

test("a same-shop bounty is stopped by a newer, higher shelf price recorded at its branch", async () => {
  const db = evidence();
  const a = await app(db);
  try {
    await a.call("POST", "/api/research/checks", camdenCheck({ locality: "Preston", branch: "node/111", checkedAt: ago(3 * HOUR) }));
    const created = await a.bountyFor(request({ locality: "Preston" }), { locality: "Preston" });
    const id = created.body.bounty.id;
    assert.equal(row(db, id).alert_eligible, 1, row(db, id).alert_reasons);
    const now = new Date().toISOString();
    recordCheck(db, camdenCheck({ locality: "Preston", branch: "node/111", pricePence: 1150, checkedAt: ago(2 * HOUR) }), { now });
    assert.equal(offerNow(db, requireBounty(db, id), now).rose, false, "a lower shelf price is not a rise");
    recordCheck(db, camdenCheck({ locality: "Preston", branch: "node/111", pricePence: 1500, checkedAt: ago(1 * HOUR) }), { now });
    const live = offerNow(db, requireBounty(db, id), now);
    assert.deepEqual({ price: live.price, was: live.was, rose: live.rose }, { price: 1500, was: 1200, rose: true });
    assert.ok(blockerList(db, requireBounty(db, id), now).some((b) => b.id === "price-rose"));
  } finally {
    await a.close();
  }
});

test("through the check route, a higher shelf price works the figures out again and stops a trip that no longer pays", async () => {
  const db = evidence();
  const a = await app(db);
  try {
    await a.call("POST", "/api/research/checks", camdenCheck({ pricePence: 1250, checkedAt: ago(3 * HOUR) }));
    const id = (await a.bountyFor(request())).body.bounty.id;
    const ann = await a.member("Ann");
    await a.call("POST", `/api/bounties/${id}/alerts`, {});
    const check = await a.call("POST", "/api/research/checks", camdenCheck({ pricePence: 2700 }));
    assert.equal(check.status, 201);
    assert.equal(row(db, id).alert_eligible, 0);
    assert.equal(JSON.parse(requireBounty(db, id).estimate).offer.price, 2700, "the figures now use the new shelf price");
    assert.ok(memberNotices(db, ann.id, { bountyId: id }).some((n) => n.kind === "stop"));
    assert.equal((await a.claim(id, ann.id)).status, 409);
  } finally {
    await a.close();
  }
});

// The audit's Awin offer at Argos, with three confirmed exact sales from
// named sellers (as in audit.test.mjs).
function auditDb() {
  const NOW = new Date().toISOString();
  const db = memoryDb(evidenceSchema, auditSchema);
  const pan = { title: "Tefal Ingenio pan 28cm", barcode: "5012345678900", size: "28cm", pack: "1", model: "L15006", condition: "new" };
  upsertResearch(db, "awin", [{ ...pan, source_id: "offer-1", kind: KIND.RETAIL, price: 1500, observed: ago(20 * HOUR), retailer: "Argos", licence: LICENCE.FEED }], { now: NOW });
  upsertResearch(
    db,
    "sales",
    ["s1", "s2", "s3"].map((id) => ({ ...pan, source_id: id, kind: KIND.SOLD, price: 4000, observed: ukDay(10), listed: ukDay(15), seller: "seller-" + id, licence: LICENCE.SELF })),
    { now: NOW },
  );
  setPermission(db, { provider: "awin", programme: "Argos", display: true }, { now: NOW });
  const item = (checkId) =>
    recordItem(
      db,
      {
        locality: "Camden",
        barcode: "5012345678900",
        title: "Tefal Ingenio pan 28cm",
        retailer: "Argos",
        offerProvider: "awin",
        offerSourceId: "offer-1",
        sales: ["s1", "s2", "s3"].map((sourceId) => ({ provider: "sales", sourceId })),
        weightKg: 0.9,
        promotionEligible: true,
        shipping: 300,
        estimateInputs: { costs: { packaging: 50, journeyCost: 200, journeyMinutes: 40, handlingMinutes: 10 } },
        availabilityCheckId: checkId,
      },
      { now: new Date().toISOString() },
    );
  const check = (over = {}) =>
    recordCheck(
      db,
      { barcode: "5012345678900", retailer: "Argos", locality: "Camden", method: "in_store", inStock: true, unitsSeen: 4, checkedAt: ago(2 * HOUR), ...over },
      { now: new Date().toISOString() },
    );
  return { db, item, check };
}

test("an audit item passes only with the price confirmed at its branch", () => {
  const { db, item, check } = auditDb();
  const stockOnly = check();
  const failed = item(stockOnly.id);
  const gate = failed.outcome.checks.find((c) => c.id === "price-at-branch");
  assert.equal(failed.outcome.passed, false);
  assert.equal(gate.ok, false);
  assert.equal(gate.detail, AUDIT_FAILURES.priceAtBranch);
  assert.match(gate.reason, /online price from the Awin affiliate feed, not a shelf price at the branch checked in Camden/);
  assert.equal(failed.evidence.priceAtBranch.confirmed, false);

  db.prepare("DELETE FROM validation_items").run();
  const priced = check({ pricePence: 1500, checkedAt: ago(1 * HOUR) });
  const passed = item(priced.id);
  assert.equal(passed.outcome.passed, true, passed.outcome.reasons.join("; "));
  const ok = passed.outcome.checks.find((c) => c.id === "price-at-branch");
  assert.equal(ok.detail, "Shelf price recorded on the branch check");
  assert.equal(passed.evidence.priceAtBranch.basis, "check");
  assert.equal(passed.evidence.priceAtBranch.check.id, priced.id);
  assert.equal(
    passed.outcome.checks.find((c) => c.id === "offer-fresh").detail,
    "Shelf price recorded on the branch check within 7 days of the audit",
  );
});

test("the planner's sample trips say their price was never seen at a branch", () => {
  const r = planTrips({ ...defaults, transport: "Car", fare: null }, { now: new Date().toISOString() });
  const rows = [...r.trips, ...r.rejected].filter((x) => x.alert?.checks);
  assert.ok(rows.length > 0);
  for (const x of rows) {
    const c = x.alert.checks.find((k) => k.id === "price-at-branch");
    assert.deepEqual({ ok: c.ok, detail: c.detail }, { ok: false, detail: "Illustrative sample price, not a shelf price seen at a branch" });
  }
  assert.equal(shopIsBranch({ osm_id: "node/111", store: "Home Bargains", place: "PR1 2AR" }, { retailer: "Home Bargains", branch: "Preston" }), false);
});
