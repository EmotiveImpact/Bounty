import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KIND,
  OBSERVATIONS_TABLE,
  PERMISSIONS_TABLE,
  RESEARCH_TABLE,
} from "./contract.mjs";
import { memoryDb, serve } from "./test-support.mjs";
import { HttpError } from "./http.mjs";
import { readFileSync } from "node:fs";
import { schema as auditSchema, recordCheck } from "./audit.mjs";
import { schema as goalsSchema, saveGoals } from "./goals.mjs";
import { storeLookup, upsertObservations, upsertResearch } from "./evidence.mjs";
import { awin, openPrices, sold } from "./sources.mjs";
import {
  UNSTATED_DISCOUNT,
  applyOfferAttributes,
  askingLookup,
  candidatesFor,
  categoryDecision,
  demandFor,
  displayPermission,
  estimateFromEvidence,
  findOffer,
  isSampleRecord,
  listOffers,
  missingInputsOf,
  observationPromotion,
  payoutSchedule,
  resaleWeeksOfSupply,
  salesPerWeek,
  suggestCategory,
  thresholdsFor,
  QUANTITY_HINT,
  branchShelf,
  currentOffer,
  currentShopPrice,
  ukTime,
  ukDate,
  validateEstimateRequest,
} from "./estimate.mjs";
import { CATEGORY_RULES, OPPORTUNITY_RULES } from "./opportunity.mjs";
import * as researchRoutes from "./routes-research.mjs";
import { schema as bountiesSchema } from "./bounties.mjs";

// Evidence tables straight from the contract, so these tests do not depend
// on the evidence module.
const evidenceTables = (db) => {
  db.exec(RESEARCH_TABLE);
  db.exec(OBSERVATIONS_TABLE);
  db.exec(PERMISSIONS_TABLE);
};

const DAY = 86400000;
const NOW = "2026-10-31T12:00:00.000Z";
// The asking-price lookup cache (evidence.mjs). A lookup inside its time to
// live that found no listings makes competition known to be zero; without
// one, no listings means nobody looked.
const LOOKUP_CACHE_TABLE = `CREATE TABLE IF NOT EXISTS lookup_cache (
 provider TEXT NOT NULL, query TEXT NOT NULL, fetched TEXT NOT NULL,
 source_ids TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(provider, query))`;
function lookedUp(db, { now = NOW, hoursAgo = 1, barcode = BARCODE } = {}) {
  db.exec(LOOKUP_CACHE_TABLE);
  storeLookup(db, "ebay", barcode, [], { now: new Date(Date.parse(now) - hoursAgo * 3600000).toISOString() });
}
const daysBefore = (n, now = NOW) =>
  new Date(Date.parse(now) - n * DAY).toISOString().slice(0, 10);
const BARCODE = "5012345678900";

function insert(db, row) {
  const full = {
    barcode: BARCODE,
    variant: null,
    size: "28cm",
    pack: "1",
    model: "L15006",
    condition: "new",
    shipping: null,
    observed: daysBefore(1),
    listed: null,
    retailer: null,
    location: null,
    availability: null,
    promotion: null,
    seller: null,
    url: null,
    licence: null,
    ...row,
  };
  const columns = Object.keys(full);
  db.prepare(
    `INSERT INTO research(${columns.join(", ")}) VALUES(${columns.map(() => "?").join(", ")})`,
  ).run(...columns.map((c) => full[c]));
}

const offerRow = (extra = {}) => ({
  provider: "awin",
  source_id: "offer-1",
  kind: KIND.RETAIL,
  title: "Tefal Ingenio frying pan 28cm",
  condition: null,
  price: 1200,
  retailer: "Argos",
  licence: "Licensed feed",
  ...extra,
});
const saleRow = (id, extra = {}, now = NOW) => ({
  provider: "manual",
  source_id: id,
  kind: KIND.SOLD,
  title: "Tefal Ingenio pan 28 cm",
  barcode: "05012345678900",
  price: 3000,
  observed: daysBefore(10, now),
  listed: daysBefore(14, now),
  seller: "seller-" + id,
  licence: "Self-reported",
  ...extra,
});

// Enough confirmed sales for the sales rate to absorb a trial batch within
// the two-week sell window: 21 sales in 90 days is 1.63 a week, so about 3
// units can sell in 2 weeks. The first three sell at £28, £30 and £32 and the
// rest at £30, so the lower median is £30.
const SALES = Array.from({ length: 21 }, (_, i) => "s" + (i + 1));
const salePrice = (i) => (i < 3 ? 2800 + i * 200 : 3000);
const salesOf = (ids, provider = "manual") => ids.map((sourceId) => ({ provider, sourceId }));

/**
 * Builds a database where every alert check can pass. The branch check
 * records the shelf price (shelfPrice, the same £12.00 the feed lists), so
 * the price applies at the branch checked; shelfPrice null records a
 * stock-only check, which leaves the feed's online price unconfirmed there.
 */
function fixture({ now = NOW, sales = SALES, permission = true, check = true, lookup = true, shelfPrice = 1200 } = {}) {
  const db = memoryDb(evidenceTables, auditSchema);
  insert(db, offerRow({ observed: daysBefore(1, now) }));
  sales.forEach((id, i) => insert(db, saleRow(id, { price: salePrice(i) }, now)));
  if (lookup) lookedUp(db, { now });
  if (permission)
    db.prepare("INSERT INTO permissions(provider, programme, display) VALUES('awin', 'Argos', 1)").run();
  if (check)
    recordCheck(
      db,
      {
        barcode: BARCODE,
        retailer: "Argos",
        locality: "Leeds",
        method: "in_store",
        inStock: true,
        unitsSeen: 6,
        checkedAt: new Date(Date.parse(now) - 3600000).toISOString(),
        ...(shelfPrice === null ? {} : { pricePence: shelfPrice }),
      },
      { now },
    );
  return db;
}

// The offer's price and the shelf price on the fixture's branch check, set
// together: the figures use the price that applies at the branch.
const priceAll = (db, pence) => {
  db.prepare("UPDATE research SET price = ? WHERE source_id = 'offer-1'").run(pence);
  db.prepare("UPDATE availability_checks SET price_pence = ?").run(pence);
};

const request = (extra = {}) => ({
  offer: { provider: "awin", sourceId: "offer-1" },
  sales: salesOf(SALES),
  units: 2,
  costs: {
    postage: 300,
    packaging: 40,
    feeRate: 0.13,
    feeFixed: 40,
    returnsRate: 0.05,
    journeyCost: 300,
    journeyMinutes: 30,
    overheadMinutes: 10,
    handlingMinutes: 10,
  },
  hourlyFloor: 1200,
  promotionEligible: false,
  cashNeededDays: 14,
  locality: "Leeds",
  weightKg: 0.9,
  now: NOW,
  ...extra,
});

const failing = (result) => result.alert.checks.filter((c) => !c.ok).map((c) => c.id);

test("a full positive case passes every alert check", () => {
  const db = fixture();
  const r = estimateFromEvidence(db, request());
  assert.equal(r.match, "exact");
  assert.equal(r.sample.count, 21);
  assert.equal(r.sample.independent, 21);
  assert.equal(r.sample.lowerMedian, 3000);
  assert.equal(r.sample.daysToSell, 4);
  assert.deepEqual(r.missingInputs, []);
  // 21 sales in 90 days is 1.63 a week: 3 units in 2 weeks, none competing.
  assert.deepEqual(
    { units: r.demand.units, competing: r.demand.competingListings, weeks: r.demand.sellWindowWeeks },
    { units: 3, competing: 0, weeks: 2 },
  );
  assert.equal(r.competition.lookup.provider, "ebay");
  assert.equal(r.economics.unitCost, 1200);
  assert.equal(r.economics.salePrice, 3000);
  assert.equal(r.economics.units, 2);
  assert.equal(r.economics.costs.travel, 300);
  assert.equal(r.economics.journeyPerUnit, 150);
  assert.ok(r.economics.contribution > 0);
  assert.equal(r.stock.confirmed, true);
  assert.equal(r.permission.permitted, true);
  assert.equal(r.opportunity.tier, "Priority 2");
  assert.equal(r.opportunity.meetsThresholds, true);
  assert.deepEqual(failing(r), []);
  assert.ok(r.alert.checks.some((c) => c.id === "buying-thresholds" && c.ok));
  assert.ok(r.alert.checks.some((c) => c.id === "trial-batch" && c.ok));
  assert.equal(r.alert.eligible, true);
});

test("asking prices never change the sale price, even if ticked", () => {
  const db = fixture();
  const before = estimateFromEvidence(db, request());
  insert(db, saleRow("ask-low", { kind: KIND.ASKING, price: 900, seller: "x", observed: daysBefore(1) }));
  insert(db, saleRow("ask-high", { kind: KIND.ASKING, price: 9000, seller: "y", observed: daysBefore(1) }));
  const sales = [...request().sales, { provider: "manual", sourceId: "ask-low" }, { provider: "manual", sourceId: "ask-high" }];
  const after = estimateFromEvidence(db, request({ sales }));
  assert.equal(after.sample.lowerMedian, before.sample.lowerMedian);
  assert.equal(after.sample.count, 21);
  assert.equal(after.economics.salePrice, before.economics.salePrice);
  assert.equal(after.economics.contribution, before.economics.contribution);
  assert.equal(after.competition.activeListings, 2);
  assert.equal(after.competition.lowestAsking, 900);
  const excluded = after.sample.excluded.filter((e) => e.row.kind === KIND.ASKING);
  assert.equal(excluded.length, 2);
  assert.ok(excluded.every((e) => /resale competition, not a sale/.test(e.reason)));
});

test("retail offers and Amazon history with the same barcode are never sales", () => {
  const db = fixture();
  insert(db, offerRow({ source_id: "offer-2", price: 5000 }));
  insert(db, saleRow("amz", { kind: KIND.AMAZON, provider: "keepa", price: 6000 }));
  const sales = [...request().sales, { provider: "awin", sourceId: "offer-2" }, { provider: "keepa", sourceId: "amz" }];
  const r = estimateFromEvidence(db, request({ sales }));
  assert.equal(r.sample.count, 21);
  assert.equal(r.sample.lowerMedian, 3000);
  assert.ok(
    r.sample.excluded
      .filter((e) => e.row.kind !== KIND.SOLD)
      .every((e) => e.reason === "Not a completed sale"),
  );
});

test("no sales gives null economics, match none and no alert", () => {
  const db = fixture({ sales: [] });
  const r = estimateFromEvidence(db, request({ sales: [] }));
  assert.equal(r.economics, null);
  assert.equal(r.match, "none");
  assert.equal(r.sample.count, 0);
  assert.equal(r.alert.eligible, false);
  assert.ok(failing(r).includes("exact-match"));
  assert.ok(failing(r).includes("positive-contribution"));
});

test("unconfirmed or inexact sales leave the match in research", () => {
  const db = fixture();
  const unconfirmed = estimateFromEvidence(db, request({ sales: [] }));
  assert.equal(unconfirmed.match, "research");
  assert.equal(unconfirmed.economics, null);
  assert.ok(unconfirmed.alert.reasons.some((r) => /Similar product only/.test(r)));

  const db2 = fixture({ sales: [] });
  insert(db2, saleRow("nosize", { size: null }));
  insert(db2, saleRow("similar", { barcode: null }));
  const r = estimateFromEvidence(
    db2,
    request({ sales: [{ provider: "manual", sourceId: "nosize" }, { provider: "manual", sourceId: "similar" }] }),
  );
  assert.equal(r.match, "research");
  assert.equal(r.sample.count, 0);
  assert.equal(r.economics, null);
  const reason = (id) => r.sample.excluded.find((e) => e.row.source_id === id).reason;
  assert.match(reason("nosize"), /Size not stated for the sale/);
  assert.match(reason("similar"), /Similar product/);
});

test("a stale offer blocks the alert", () => {
  // A stock-only check: the feed's own (stale) price is the one judged, and
  // it is not shown to apply at the branch either (round 5).
  const db = fixture({ shelfPrice: null });
  db.prepare("UPDATE research SET observed = ? WHERE source_id = 'offer-1'").run(daysBefore(8));
  const r = estimateFromEvidence(db, request());
  assert.equal(r.offer.expired, true);
  // An evidence gap sends the opportunity to Review, which also fails the
  // buying thresholds.
  assert.deepEqual(failing(r), ["offer-fresh", "price-at-branch", "buying-thresholds"]);
  assert.equal(r.opportunity.tier, "Review");
  assert.equal(r.alert.eligible, false);
});

test("branch stock needs a recent positive check, not the request flag", () => {
  const db = fixture({ check: false });
  const r = estimateFromEvidence(db, request({ localStockConfirmed: true }));
  assert.equal(r.stock.confirmed, false);
  // Unconfirmed stock blocks the alert, and with no branch check the feed's
  // price is not shown to apply at any branch either (round 5): Review.
  assert.deepEqual(failing(r), ["local-stock", "availability", "price-at-branch", "buying-thresholds"]);
  assert.equal(r.opportunity.tier, "Review");
  assert.ok(r.opportunity.reasons.some((x) => /no branch check in Leeds/.test(x)));

  // A check older than two days does not count.
  recordCheck(
    db,
    { barcode: BARCODE, retailer: "Argos", locality: "Leeds", method: "phone", inStock: true, checkedAt: daysBefore(3) + "T09:00:00Z" },
    { now: NOW },
  );
  assert.equal(estimateFromEvidence(db, request()).alert.eligible, false);

  // A check in another locality does not count when a locality is given.
  recordCheck(
    db,
    { barcode: BARCODE, retailer: "Argos", locality: "York", method: "in_store", inStock: true, checkedAt: daysBefore(0) + "T09:00:00Z" },
    { now: NOW },
  );
  assert.equal(estimateFromEvidence(db, request()).stock.confirmed, false);

  // A matching recent check passes; a later check that found none overrides it.
  recordCheck(
    db,
    { barcode: "0" + BARCODE, retailer: "argos", locality: "leeds", method: "retailer_branch_page", inStock: true, checkedAt: daysBefore(0) + "T09:00:00Z", pricePence: 1200 },
    { now: NOW },
  );
  assert.equal(estimateFromEvidence(db, request()).alert.eligible, true);
  recordCheck(
    db,
    { barcode: BARCODE, retailer: "Argos", locality: "Leeds", method: "in_store", inStock: false, checkedAt: daysBefore(0) + "T10:00:00Z" },
    { now: NOW },
  );
  const gone = estimateFromEvidence(db, request());
  assert.equal(gone.stock.availability, "out_of_stock");
  assert.equal(gone.alert.eligible, false);
});

test("missing display permission blocks the alert; a refusal outranks the provider row", () => {
  const db = fixture({ permission: false });
  assert.deepEqual(failing(estimateFromEvidence(db, request())), ["display-permitted"]);
  db.prepare("INSERT INTO permissions(provider, programme, display) VALUES('awin', '', 1)").run();
  assert.equal(estimateFromEvidence(db, request()).alert.eligible, true);
  db.prepare("INSERT INTO permissions(provider, programme, display) VALUES('awin', 'argos', 0)").run();
  assert.deepEqual(failing(estimateFromEvidence(db, request())), ["display-permitted"]);
});

test("two independent sales block the alert", () => {
  const db = fixture();
  db.prepare("UPDATE research SET seller = 'seller-s2' WHERE kind = ? AND source_id NOT IN ('s1', 's2')").run(KIND.SOLD);
  const r = estimateFromEvidence(db, request());
  assert.equal(r.sample.count, 21);
  assert.equal(r.sample.independent, 2);
  assert.deepEqual(failing(r), ["independent-sales", "buying-thresholds"]);
  assert.equal(r.opportunity.tier, "Review");
});

test("sales with no seller name are reported apart and never counted as independent", () => {
  const db = fixture({ sales: ["s1", "s2", "s3", "s4"] });
  db.prepare("UPDATE research SET seller = NULL WHERE source_id IN ('s3', 's4')").run();
  const r = estimateFromEvidence(db, request({ sales: ["s1", "s2", "s3", "s4"].map((sourceId) => ({ provider: "manual", sourceId })) }));
  assert.equal(r.sample.count, 4);
  assert.equal(r.sample.independent, 2);
  assert.equal(r.sample.withoutSeller, 2, "the Research page shows this count beside the independent sellers");
  assert.ok(failing(r).includes("independent-sales"));
});

test("costs that wipe out the margin, missing postage or a late cash date block the alert", () => {
  const db = fixture();
  const loss = estimateFromEvidence(db, request({ costs: { ...request().costs, journeyCost: 9000 } }));
  assert.ok(loss.economics.contribution < 0);
  assert.ok(failing(loss).includes("positive-contribution"));

  const noPostage = estimateFromEvidence(db, request({ costs: { ...request().costs, postage: 0 } }));
  assert.ok(failing(noPostage).includes("shipping"));
  assert.ok(noPostage.warnings.some((w) => /parcel cost/i.test(w)));

  const late = estimateFromEvidence(db, request({ cashNeededDays: 2 }));
  assert.deepEqual(failing(late), ["days-to-sell", "buying-thresholds"]);
  // Calendar days from today in London: Saturday 31 October to 2 November.
  const lateDate = estimateFromEvidence(db, request({ cashNeededDays: undefined, cashNeededBy: "2026-11-02" }));
  assert.equal(lateDate.cashNeededDays, 2);
  assert.deepEqual(failing(lateDate), ["days-to-sell", "buying-thresholds"]);

  const slow = estimateFromEvidence(db, request({ hourlyFloor: 50000 }));
  assert.deepEqual(failing(slow), ["hourly-floor"]);
  const noFloor = estimateFromEvidence(db, request({ hourlyFloor: undefined }));
  assert.ok(failing(noFloor).includes("hourly-floor"));
});

test("a promotion price needs confirmed eligibility and is costed at the regular price", () => {
  const db = memoryDb(evidenceTables, auditSchema);
  db.prepare(
    `INSERT INTO observations(id, title, store, place, city, price, regular_price, discounted, discount_type, day, unit, quantity, barcode)
 VALUES(77, 'Tefal Ingenio pan', 'Argos', 'LS1 4AB', 'Leeds', 1000, 1400, 1, 'LOYALTY_PROGRAM', ?, 'UNKNOWN', '28cm', ?)`,
  ).run(daysBefore(1), BARCODE);
  const offer = findOffer(db, "openprices", "77", NOW);
  assert.equal(offer.kind, KIND.RETAIL);
  assert.equal(offer.licence, "ODbL");
  assert.equal(offer.retailer, "Argos");
  assert.equal(offer.location, "LS1 4AB, Leeds");
  assert.equal(offer.size, "28cm");
  assert.equal(offer.promotion, "LOYALTY_PROGRAM");
  assert.equal(offer.observed, daysBefore(1));
  assert.equal(offer.branchStockEstablished, false);

  insert(db, saleRow("s1", { pack: null }));
  const r = estimateFromEvidence(db, request({ offer: { provider: "openprices", sourceId: 77 } }));
  // Open Prices has no pack or model, so the match can only be research.
  assert.equal(r.match, "research");
  assert.equal(r.permission.permitted, true);
  // Costed at the known regular price, the trip no longer depends on the
  // loyalty price, so the promotion check passes and says why.
  assert.ok(!failing(r).includes("promotion"));
  assert.equal(r.unitCost, 1400);
  assert.match(r.alert.checks.find((c) => c.id === "promotion").detail, /regular price/);

  const eligible = estimateFromEvidence(db, request({ offer: { provider: "openprices", sourceId: "77" }, promotionEligible: true }));
  assert.ok(!failing(eligible).includes("promotion"));
  assert.equal(eligible.unitCost, 1000);
  const notEligible = estimateFromEvidence(db, request({ offer: { provider: "openprices", sourceId: "77" } }));
  assert.equal(notEligible.unitCost, 1400);
});

test("sample data never becomes a buy alert", () => {
  const db = fixture({ permission: false });
  db.prepare("UPDATE research SET provider = 'sample' WHERE source_id = 'offer-1'").run();
  db.prepare("INSERT INTO permissions(provider, programme, display) VALUES('sample', '', 1)").run();
  const r = estimateFromEvidence(db, request({ offer: { provider: "sample", sourceId: "offer-1" } }));
  assert.equal(r.offer.sample, true);
  assert.deepEqual(failing(r), ["live-evidence", "buying-thresholds"]);
  assert.equal(r.opportunity.tier, "Review");
});

test("unknown offers, non-offers and offers without a valid barcode are rejected", () => {
  const db = fixture();
  insert(db, offerRow({ source_id: "nobarcode", barcode: "12345" }));
  db.prepare(
    "INSERT INTO observations(id, title, price, day, unit, barcode) VALUES(5, 'Bananas', 80, ?, 'KILOGRAM', ?)",
  ).run(daysBefore(1), BARCODE);
  const status = (req) => {
    try {
      estimateFromEvidence(db, req);
      return 200;
    } catch (error) {
      assert.ok(error instanceof HttpError, String(error));
      return error.status;
    }
  };
  assert.equal(status(request({ offer: { provider: "awin", sourceId: "missing" } })), 404);
  assert.equal(status(request({ offer: { provider: "openprices", sourceId: "999" } })), 404);
  assert.equal(status(request({ offer: { provider: "manual", sourceId: "s1" } })), 400);
  assert.equal(status(request({ offer: { provider: "awin", sourceId: "nobarcode" } })), 400);
  assert.equal(status(request({ offer: { provider: "openprices", sourceId: "5" } })), 400);
});

test("estimate inputs are validated", () => {
  const bad = [
    { units: 0 },
    { units: 101 },
    { units: 1.5 },
    { costs: { postage: -1 } },
    { costs: { feeRate: 0.6 } },
    { costs: { returnsRate: -0.1 } },
    { costs: { journeyMinutes: 2000 } },
    { costs: "free" },
    { hourlyFloor: -5 },
    { promotionEligible: "yes" },
    { cashNeededDays: -1 },
    { cashNeededBy: "2026-02-30" },
    { sales: "all" },
    { sales: [{ provider: "manual" }] },
    { offer: null },
    { now: "soon" },
  ];
  for (const extra of bad)
    assert.throws(
      () => validateEstimateRequest(request(extra)),
      (e) => e instanceof HttpError && e.status === 400,
      JSON.stringify(extra),
    );
  const defaults = validateEstimateRequest({ offer: { provider: "awin", sourceId: "x" } });
  assert.equal(defaults.units, 1);
  assert.equal(defaults.costs.feeRate, 0.13);
  assert.equal(defaults.costs.postage, 0);
  assert.equal(defaults.hourlyFloor, null);
});

test("offers list barcoded retail offers and per-item Open Prices observations", () => {
  const db = fixture();
  insert(db, offerRow({ source_id: "old", observed: daysBefore(30), title: "Old pan" }));
  insert(db, offerRow({ source_id: "nobarcode", barcode: null }));
  db.prepare("INSERT INTO observations(id, title, store, price, day, unit, barcode) VALUES(8, 'Pan', 'Argos', 1100, ?, 'UNKNOWN', ?)").run(daysBefore(2), BARCODE);
  db.prepare("INSERT INTO observations(id, title, price, day, unit, barcode) VALUES(9, 'Bananas', 80, ?, 'KILOGRAM', ?)").run(daysBefore(1), BARCODE);
  const all = listOffers(db, { now: NOW });
  assert.equal(all.total, 3);
  assert.deepEqual(all.rows.map((r) => r.provider + ":" + r.sourceId), ["awin:offer-1", "openprices:8", "awin:old"]);
  const old = all.rows.find((r) => r.sourceId === "old");
  assert.equal(old.expired, true);
  assert.equal(old.ageDays, 30);
  assert.ok(all.rows.every((r) => r.branchStockEstablished === false && r.stockNote));
  assert.equal(listOffers(db, { q: "old", now: NOW }).total, 1);
  assert.equal(listOffers(db, { q: "0" + BARCODE, now: NOW }).total, 3);
  assert.equal(listOffers(db, { limit: 1, offset: 1, now: NOW }).rows[0].sourceId, "8");
});

test("candidates separate sales from competition and mark what can be confirmed", () => {
  const db = fixture();
  insert(db, saleRow("stale", { observed: daysBefore(120) }));
  insert(db, saleRow("ask", { kind: KIND.ASKING, price: 2000, observed: daysBefore(1) }));
  const c = candidatesFor(db, { provider: "awin", sourceId: "offer-1", now: NOW });
  assert.equal(c.sales.length, 22);
  assert.ok(c.sales.every((s) => s.row.kind === KIND.SOLD));
  assert.equal(c.sales.find((s) => s.row.source_id === "s1").confirmable, true);
  const stale = c.sales.find((s) => s.row.source_id === "stale");
  assert.equal(stale.status, "exact");
  assert.equal(stale.confirmable, false);
  assert.match(stale.blocker, /more than 90 days/);
  assert.equal(c.listings.length, 1);
  assert.equal(c.competition.activeListings, 1);
});

test("routes serve candidates and estimates on the server clock", async () => {
  const now = new Date().toISOString();
  const db = fixture({ now });
  const api = await serve(db, [researchRoutes]);
  try {
    const candidates = await api.call("GET", "/api/research/candidates?provider=awin&sourceId=offer-1");
    assert.equal(candidates.status, 200);
    assert.equal(candidates.body.sales.length, 21);
    assert.equal(candidates.body.offer.gtin, "05012345678900");

    const missing = await api.call("GET", "/api/research/candidates?provider=awin&sourceId=nope");
    assert.equal(missing.status, 404);
    const noProvider = await api.call("GET", "/api/research/candidates?sourceId=offer-1");
    assert.equal(noProvider.status, 400);

    const body = request({ now: undefined });
    const estimate = await api.call("POST", "/api/research/estimate", body);
    assert.equal(estimate.status, 200);
    assert.equal(estimate.body.alert.eligible, true);
    assert.equal(estimate.body.match, "exact");

    // A client-supplied clock cannot make an expired offer fresh. Without
    // the shelf price on the check, the offer's own date is the price's date.
    db.prepare("UPDATE availability_checks SET price_pence = NULL").run();
    db.prepare("UPDATE research SET observed = ? WHERE source_id = 'offer-1'").run(daysBefore(20, now));
    const rewound = await api.call("POST", "/api/research/estimate", {
      ...body,
      now: new Date(Date.parse(now) - 19 * DAY).toISOString(),
    });
    assert.equal(rewound.status, 200);
    assert.equal(rewound.body.alert.eligible, false);
    assert.ok(rewound.body.alert.checks.some((c) => c.id === "offer-fresh" && !c.ok));

    const invalid = await api.call("POST", "/api/research/estimate", { ...body, units: 0 });
    assert.equal(invalid.status, 400);

    const offers = await api.call("GET", "/api/research/offers?limit=10");
    assert.equal(offers.status, 200);
    assert.equal(offers.body.total, 1);
    assert.equal(offers.body.maxOfferAgeDays, 7);
    assert.equal((await api.call("GET", "/api/research/offers?limit=0")).status, 400);
    assert.equal((await api.call("GET", "/api/research/offers?limit=ten")).status, 400);
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// Opportunity tiers and buying thresholds.

const tierOf = (r) => r.opportunity.tier;
const checkOk = (r, id) => r.alert.checks.find((c) => c.id === id)?.ok;

test("the estimate classifies the opportunity from the same evidence as the alert", () => {
  const db = fixture();
  const r = estimateFromEvidence(db, request());
  const o = r.opportunity;
  // Per unit: 3000 sale - 1200 stock - 40 packaging - 300 postage - 430 fees
  // - 150 returns - 150 travel = 730 profit; 730 / 1200 = 60.8% return.
  assert.equal(o.unitProfit, 730);
  assert.equal(o.returnOnCost, 0.608);
  assert.equal(o.unitPrice, 1200);
  assert.equal(o.weightKg, 0.9);
  assert.equal(o.targetPrice, null);
  assert.equal(o.trialUnits, 3);
  assert.equal(o.sourcingPressure, null);
  assert.equal(o.provenItem, false);
  // 21 confirmed sales over 90 days is 21 / (90 / 7) a week.
  assert.equal(o.salesPerWeek, 1.63);
  // No listings recorded, but a current asking-price lookup found none:
  // weeks of supply are known to be 0.
  assert.equal(r.competition.activeListings, 0);
  assert.equal(o.resaleWeeksOfSupply, 0);
  assert.ok(!o.reasons.includes("Resale competition high or unknown"));
  assert.ok(o.reasons.includes("Sourcing pressure high or unknown"));
  // Cash required stays its own figure, apart from profit per unit.
  assert.equal(r.economics.cashRequired, 2 * (1200 + 40 + 300) + 300);
  assert.deepEqual(r.thresholds.rules, OPPORTUNITY_RULES);
  assert.deepEqual(r.thresholds.tightened, []);
  assert.deepEqual(r.thresholds.ignored, []);
});

test("resale weeks of supply divides active listings by the confirmed sales rate", () => {
  assert.equal(salesPerWeek(0), null);
  assert.equal(salesPerWeek(9, 63), 1);
  assert.equal(resaleWeeksOfSupply(4, 2), 2);
  assert.equal(resaleWeeksOfSupply(4, null), null);
  // 0 is passed only when a lookup found no listings; null is "not known".
  assert.equal(resaleWeeksOfSupply(0, 2), 0);
  assert.equal(resaleWeeksOfSupply(null, 2), null);

  const db = fixture();
  insert(db, saleRow("ask-1", { kind: KIND.ASKING, provider: "ebay", price: 2500, observed: daysBefore(1) }));
  insert(db, saleRow("ask-2", { kind: KIND.ASKING, provider: "ebay", price: 2600, observed: daysBefore(2) }));
  const r = estimateFromEvidence(db, request());
  assert.equal(r.competition.activeListings, 2);
  // 2 listings / (21 sales / (90 / 7) weeks) = 1.22 weeks of supply.
  assert.equal(r.opportunity.resaleWeeksOfSupply, 1.22);
  // Without confirmed sales there is no rate, so it is unknown.
  const none = estimateFromEvidence(db, request({ sales: [] }));
  assert.equal(none.opportunity.salesPerWeek, null);
  assert.equal(none.opportunity.resaleWeeksOfSupply, null);
});

test("a research estimate reaches Priority 2 at best because sourcing pressure is unknown", () => {
  const db = fixture();
  insert(db, saleRow("ask-1", { kind: KIND.ASKING, provider: "ebay", price: 3500, observed: daysBefore(1) }));
  const r = estimateFromEvidence(db, request());
  assert.equal(r.sample.independent, 21);
  assert.ok(r.opportunity.resaleWeeksOfSupply <= OPPORTUNITY_RULES.maxResaleWeeksOfSupplyPriority1);
  assert.equal(tierOf(r), "Priority 2");
  assert.deepEqual(r.opportunity.reasons, ["Sourcing pressure high or unknown"]);
  assert.equal(r.alert.eligible, true);
});

test("unknown or heavy unit weight rejects the opportunity and blocks the alert", () => {
  const db = fixture();
  for (const weightKg of [undefined, null]) {
    const r = estimateFromEvidence(db, request({ weightKg }));
    assert.equal(tierOf(r), "Reject");
    assert.deepEqual(r.opportunity.reasons, ["Unit weight unknown"]);
    assert.equal(r.opportunity.meetsThresholds, false);
    assert.equal(r.inputs.weightKg, null);
    assert.ok(r.warnings.some((w) => /unit weight not entered/i.test(w)));
    assert.deepEqual(failing(r), ["buying-thresholds"]);
    assert.equal(r.alert.eligible, false);
  }
  const heavy = estimateFromEvidence(db, request({ weightKg: 2 }));
  assert.equal(tierOf(heavy), "Reject");
  assert.deepEqual(heavy.opportunity.reasons, ["Unit weighs 2 kg or more"]);
  assert.equal(tierOf(estimateFromEvidence(db, request({ weightKg: 1.99 }))), "Priority 2");
});

test("a purchase price outside £5 to £50 is rejected", () => {
  const db = fixture();
  priceAll(db, 450);
  const cheap = estimateFromEvidence(db, request());
  assert.equal(tierOf(cheap), "Reject");
  assert.match(cheap.opportunity.reasons[0], /Purchase price outside £5 to £50/);
  assert.ok(!checkOk(cheap, "buying-thresholds"));
  priceAll(db, 5100);
  assert.equal(tierOf(estimateFromEvidence(db, request())), "Reject");
});

test("short profit or return gives Watch with the target purchase price", () => {
  const db = fixture();
  priceAll(db, 1500);
  const r = estimateFromEvidence(db, request({ hourlyFloor: 0 }));
  // 3000 - 1500 - 40 - 300 - 430 - 150 - 150 = 430 per unit; 430 / 1500 is
  // 28.67%, rounded down to 28.6% so a return never reads higher than it is.
  assert.equal(r.opportunity.unitProfit, 430);
  assert.equal(r.opportunity.returnOnCost, 0.286);
  assert.ok(r.economics.contribution > 0);
  assert.equal(tierOf(r), "Watch");
  // Profit at a zero price is 1930: £5 profit needs 1430 or less and a 35%
  // return needs floor(1930 / 1.35) = 1429 or less.
  assert.equal(r.opportunity.targetPrice, 1429);
  assert.ok(r.opportunity.reasons.includes("Would qualify at a purchase price of £14.29 or less"));
  assert.deepEqual(failing(r), ["buying-thresholds"]);
  assert.equal(r.alert.eligible, false);

  // A loss with no workable price in the band is rejected outright.
  const loss = estimateFromEvidence(db, request({ costs: { ...request().costs, journeyCost: 9000 } }));
  assert.equal(tierOf(loss), "Reject");
  assert.equal(loss.opportunity.targetPrice, null);
});

test("missing or uncertain evidence gives Review", () => {
  const db = fixture();
  const none = estimateFromEvidence(db, request({ sales: [] }));
  assert.equal(tierOf(none), "Review");
  assert.ok(none.opportunity.reasons.includes("No completed-sale price for this exact variant"));
  const noPostage = estimateFromEvidence(db, request({ costs: { ...request().costs, postage: 0 } }));
  assert.equal(tierOf(noPostage), "Review");
  assert.ok(noPostage.opportunity.reasons.includes("Parcel cost unknown"));
});

test("member thresholds only tighten; looser values are ignored and reported", () => {
  const db = fixture();
  const strict = estimateFromEvidence(db, request({ rules: { minUnitProfit: 800 } }));
  assert.equal(strict.thresholds.rules.minUnitProfit, 800);
  assert.deepEqual(strict.thresholds.tightened, ["minUnitProfit"]);
  assert.equal(tierOf(strict), "Watch");
  // 730 + 1200 = 1930 at a zero price, so £8 profit needs 1130 or less.
  assert.equal(strict.opportunity.targetPrice, 1130);
  assert.equal(strict.alert.eligible, false);

  const loose = estimateFromEvidence(
    db,
    request({ rules: { minUnitProfit: 100, minReturn: 0.1, maxWeightKg: 30, maxUnitPrice: 50000, trialUnits: 50 } }),
  );
  assert.deepEqual(loose.thresholds.rules, OPPORTUNITY_RULES);
  assert.deepEqual(loose.thresholds.tightened, []);
  assert.deepEqual(loose.thresholds.ignored, ["maxUnitPrice", "maxWeightKg", "minUnitProfit", "minReturn", "trialUnits"]);
  assert.ok(loose.warnings.some((w) => /never loosen/.test(w)));
  assert.equal(loose.alert.eligible, true);
  // A 3 kg item stays rejected even if the member asks for 30 kg.
  assert.equal(tierOf(estimateFromEvidence(db, request({ weightKg: 3, rules: { maxWeightKg: 30 } }))), "Reject");

  // Tightened limits apply to the hard filters too.
  const priced = estimateFromEvidence(db, request({ rules: { maxUnitPrice: 1000 } }));
  assert.equal(tierOf(priced), "Reject");
  assert.match(priced.opportunity.reasons[0], /£5 to £10 per unit/);
  const light = estimateFromEvidence(db, request({ rules: { maxWeightKg: 0.5 } }));
  assert.deepEqual(light.opportunity.reasons, ["Unit weighs 0.5 kg or more"]);

  // The default equal to the agreed value is neither tightened nor ignored.
  const same = thresholdsFor({ minReturn: OPPORTUNITY_RULES.minReturn });
  assert.deepEqual([same.tightened, same.ignored], [[], []]);
});

test("a first purchase is held to the trial batch", () => {
  const db = fixture();
  // Four units are more than the trial batch and more than the 3 units the
  // sales rate supports in two weeks.
  const four = estimateFromEvidence(db, request({ units: 4, cashNeededDays: undefined }));
  assert.deepEqual(failing(four), ["trial-batch", "demand"]);
  assert.ok(four.warnings.some((w) => /trial batch of at most 3 units/.test(w)));
  const smaller = estimateFromEvidence(db, request({ units: 2, rules: { trialUnits: 1 } }));
  assert.equal(smaller.opportunity.trialUnits, 1);
  assert.deepEqual(failing(smaller), ["trial-batch"]);
  // Three units take 13 days to sell at 1.63 a week, so the cash date is
  // three weeks away here.
  assert.equal(estimateFromEvidence(db, request({ units: 3, cashNeededDays: 21 })).alert.eligible, true);
});

test("weight and threshold overrides are validated", () => {
  const bad = [
    { weightKg: 0 },
    { weightKg: -1 },
    { weightKg: "1kg" },
    { weightKg: 5000 },
    { rules: [] },
    { rules: "strict" },
    { rules: { minProfit: 600 } },
    { rules: { minReturn: "high" } },
    { rules: { minUnitProfit: 5.5 } },
    { rules: { trialUnits: 0 } },
    { rules: { maxWeightKg: -1 } },
  ];
  for (const extra of bad)
    assert.throws(
      () => validateEstimateRequest(request(extra)),
      (e) => e instanceof HttpError && e.status === 400,
      JSON.stringify(extra),
    );
  const ok = validateEstimateRequest(request({ rules: { minReturn: 0.5, trialUnits: null } }));
  assert.deepEqual(ok.rules, { minReturn: 0.5 });
  assert.equal(validateEstimateRequest(request({ weightKg: 0.25 })).weightKg, 0.25);
});

// ---------------------------------------------------------------------------
// Open Prices promotions and display permission.

test("an Open Prices discount without a type still needs confirmed eligibility", () => {
  assert.equal(observationPromotion({ discount_type: "QUANTITY", discounted: 1 }), "QUANTITY");
  assert.equal(observationPromotion({ discount_type: null, discounted: 1 }), UNSTATED_DISCOUNT);
  assert.equal(observationPromotion({ discount_type: "  ", discounted: 1 }), UNSTATED_DISCOUNT);
  assert.equal(observationPromotion({ discount_type: null, discounted: 0 }), null);
  assert.equal(UNSTATED_DISCOUNT, "Discounted price (type not stated)");

  const db = memoryDb(evidenceTables, auditSchema);
  db.prepare(
    `INSERT INTO observations(id, title, store, price, discounted, discount_type, day, unit, quantity, barcode)
 VALUES(81, 'Tefal pan', 'Argos', 1000, 1, NULL, ?, NULL, '28cm', ?)`,
  ).run(daysBefore(1), BARCODE);
  db.prepare(
    `INSERT INTO observations(id, title, store, price, discounted, discount_type, day, unit, quantity, barcode)
 VALUES(82, 'Tefal pan', 'Argos', 1300, 0, NULL, ?, NULL, '28cm', ?)`,
  ).run(daysBefore(1), BARCODE);
  assert.equal(findOffer(db, "openprices", "81", NOW).promotion, UNSTATED_DISCOUNT);
  assert.equal(findOffer(db, "openprices", "82", NOW).promotion, null);
  const listed = listOffers(db, { now: NOW }).rows.find((o) => o.sourceId === "81");
  assert.equal(listed.promotion, UNSTATED_DISCOUNT);

  const offer = { provider: "openprices", sourceId: "81" };
  const unconfirmed = estimateFromEvidence(db, request({ offer }));
  assert.equal(checkOk(unconfirmed, "promotion"), false);
  // No regular price is known, so the cost stays at the offer price with a warning.
  assert.equal(unconfirmed.unitCost, 1000);
  assert.ok(unconfirmed.warnings.some((w) => /eligibility is not confirmed: you may pay more/.test(w)));
  const confirmed = estimateFromEvidence(db, request({ offer, promotionEligible: true }));
  assert.equal(checkOk(confirmed, "promotion"), true);
  assert.equal(checkOk(estimateFromEvidence(db, request({ offer: { provider: "openprices", sourceId: "82" } })), "promotion"), true);
});

test("display permission uses the shared rule from the evidence module", () => {
  const db = memoryDb(evidenceTables);
  const op = { provider: "openprices", retailer: "Tesco" };
  const awin = { provider: "awin", retailer: "Argos" };
  // Open Prices is permitted under the ODbL until a row says otherwise.
  assert.equal(displayPermission(db, op).permitted, true);
  assert.match(displayPermission(db, op).basis, /ODbL/);
  assert.equal(displayPermission(db, awin).permitted, false);
  db.prepare("INSERT INTO permissions(provider, programme, display) VALUES('openprices', '', 0)").run();
  assert.equal(displayPermission(db, op).permitted, false);
  db.prepare("INSERT INTO permissions(provider, programme, display) VALUES('openprices', 'TESCO', 1)").run();
  assert.equal(displayPermission(db, op).permitted, true);
  db.prepare("INSERT INTO permissions(provider, programme, display) VALUES('awin', '', 1)").run();
  assert.equal(displayPermission(db, awin).permitted, true);
  assert.match(displayPermission(db, awin).basis, /Permitted for awin \(Argos\)/);
  // Without a permissions table nothing is permitted, Open Prices included.
  const bare = memoryDb((d) => d.exec(RESEARCH_TABLE));
  assert.equal(displayPermission(bare, op).permitted, false);
});

test("routes publish the thresholds in force and validate overrides", async () => {
  const now = new Date().toISOString();
  const db = fixture({ now });
  const api = await serve(db, [researchRoutes]);
  try {
    const rules = await api.call("GET", "/api/research/rules");
    assert.equal(rules.status, 200);
    assert.deepEqual(rules.body.rules, { ...OPPORTUNITY_RULES });
    assert.ok(rules.body.overridable.includes("minUnitProfit"));
    assert.equal(rules.body.alertRules.maxOfferAgeDays, 7);

    const body = request({ now: undefined, rules: { minReturn: 0.5 } });
    const estimate = await api.call("POST", "/api/research/estimate", body);
    assert.equal(estimate.status, 200);
    assert.equal(estimate.body.opportunity.tier, "Priority 2");
    assert.equal(estimate.body.thresholds.rules.minReturn, 0.5);
    assert.deepEqual(estimate.body.thresholds.tightened, ["minReturn"]);
    const bad = await api.call("POST", "/api/research/estimate", { ...body, rules: { minReturn: -1 } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /rules\.minReturn/);
    const noWeight = await api.call("POST", "/api/research/estimate", { ...body, weightKg: null });
    assert.equal(noWeight.status, 200);
    assert.equal(noWeight.body.opportunity.tier, "Reject");
    assert.equal(noWeight.body.alert.eligible, false);
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// Journey: a blank cost or time is never a free, instant trip (M6, qa:Q1).

test("a blank journey cost or time fails closed; an entered 0 is accepted", () => {
  const db = fixture();
  const { journeyCost: _c, journeyMinutes: _m, ...noJourney } = request().costs;
  const blank = estimateFromEvidence(db, request({ costs: noJourney }));
  assert.equal(blank.journey.known, false);
  assert.deepEqual(blank.journey.missing, ["journeyCost", "journeyMinutes"]);
  // The figures are still shown, but the gate cannot rely on them.
  assert.ok(blank.economics.contribution > 0);
  assert.equal(blank.economics.costs.travel, 0);
  assert.deepEqual(failing(blank), ["positive-contribution", "hourly-floor", "inputs-entered", "journey", "buying-thresholds"]);
  assert.deepEqual(blank.missingInputs, ["return journey cost", "journey time"]);
  assert.equal(blank.alert.eligible, false);
  assert.equal(tierOf(blank), "Review");
  assert.ok(blank.opportunity.reasons.some((x) => /Journey cost or time not entered/.test(x)));
  assert.ok(blank.opportunity.reasons.includes("Not entered: return journey cost, journey time. A blank is never counted as zero"));
  assert.equal(blank.opportunity.meetsThresholds, false);
  assert.ok(blank.warnings.some((w) => /No return journey cost entered/.test(w)));
  assert.ok(blank.warnings.some((w) => /No journey time entered/.test(w)));

  // Only the time missing: the cost is known, so the contribution counts, but
  // earnings per hour do not.
  const { journeyMinutes: _x, ...noMinutes } = request().costs;
  const timeless = estimateFromEvidence(db, request({ costs: noMinutes }));
  assert.deepEqual(failing(timeless), ["hourly-floor", "inputs-entered", "journey", "buying-thresholds"]);
  assert.deepEqual(timeless.journey.missing, ["journeyMinutes"]);

  // Walking: a cost of 0 entered on purpose, with the time, is a real journey.
  const walk = estimateFromEvidence(
    db,
    request({ costs: { ...request().costs, journeyCost: 0, journeyMinutes: 40 } }),
  );
  assert.equal(walk.journey.known, true);
  assert.ok(walk.alert.checks.some((c) => c.id === "journey" && c.ok));
  assert.equal(walk.alert.eligible, true);
  assert.equal(tierOf(walk), "Priority 2");
});

// ---------------------------------------------------------------------------
// Cash date: compared with the payout, not the sale (M8).

test("the cash date is checked against the payout date from the saved goals", () => {
  const db = fixture();
  // One unit, 4 days to sell. Saturday 31 October: listed today, sold
  // Wednesday 4 November, posted the same day, delivered 6th, paid out 8th.
  // One unit carries the whole journey, so the hourly floor is lower here.
  const one = (extra) => request({ units: 1, cashNeededDays: undefined, hourlyFloor: 600, ...extra });
  const r = estimateFromEvidence(db, one({ cashNeededBy: "2026-11-05" }));
  assert.equal(r.sample.daysToSell, 4);
  assert.equal(r.cashNeededDays, 5);
  assert.equal(r.payout.start, "2026-10-31");
  assert.equal(r.payout.sold, "2026-11-04");
  assert.equal(r.payout.date, "2026-11-08");
  assert.equal(r.payout.days, 8);
  assert.equal(r.payout.timing.status, "late");
  assert.equal(r.payout.timing.daysLate, 3);
  // Notes give dates as people write them, never as raw ISO dates.
  assert.match(r.payout.note, /payout on 8 Nov 2026/);
  assert.match(r.payout.timing.note, /8 Nov 2026, 3 days after you need the cash \(5 Nov 2026\)/);
  assert.doesNotMatch(r.payout.note + r.payout.timing.note, /\d{4}-\d{2}-\d{2}/);
  assert.equal(r.payout.goals.saved, false);
  assert.deepEqual(r.payout.unitPayouts, ["2026-11-08"]);
  assert.equal(r.payout.unitsByCashDate, 0);
  assert.ok(r.assumptions.includes("0 of 1 unit expected to have paid out by 5 Nov 2026, the date you need the cash"));
  const check = r.alert.checks.find((c) => c.id === "days-to-sell");
  assert.equal(check.ok, false);
  assert.match(check.detail, /Expected payout in 8 days, after the date the cash is needed/);
  assert.equal(r.alert.eligible, false);

  // A number of days (API callers) is compared the same way.
  const days = estimateFromEvidence(db, one({ cashNeededDays: 2 }));
  assert.equal(days.payout.timing.status, "late");
  assert.equal(days.payout.timing.daysLate, 6);
  assert.equal(checkOk(days, "days-to-sell"), false);

  // A payout on the day the cash is needed is in time.
  const onTime = estimateFromEvidence(db, one({ cashNeededBy: "2026-11-08" }));
  assert.equal(onTime.payout.timing.status, "on time");
  assert.equal(onTime.payout.unitsByCashDate, 1);
  assert.equal(checkOk(onTime, "days-to-sell"), true);
  assert.equal(onTime.alert.eligible, true);

  // No cash date: only a known time to sell is needed, and the payout date is
  // still shown.
  const free = estimateFromEvidence(db, one());
  assert.equal(free.payout.date, "2026-11-08");
  assert.equal(free.payout.timing.status, "unknown");
  assert.equal(free.payout.unitsByCashDate, null);
  assert.equal(checkOk(free, "days-to-sell"), true);
});

test("saved goals move the payout; no dispatch days leave it unknown and fail the cash date", () => {
  const db = memoryDb(evidenceTables, auditSchema, goalsSchema);
  insert(db, offerRow());
  ["s1", "s2", "s3"].forEach((id, i) => insert(db, saleRow(id, { price: 2800 + i * 200 })));
  // One unit, so the payout follows the 4 days one sale takes.
  const one = (extra) => request({ units: 1, sales: salesOf(["s1", "s2", "s3"]), ...extra });
  db.prepare("INSERT INTO permissions(provider, programme, display) VALUES('awin', 'Argos', 1)").run();
  recordCheck(
    db,
    { barcode: BARCODE, retailer: "Argos", locality: "Leeds", method: "in_store", inStock: true, checkedAt: daysBefore(0) + "T09:00:00Z" },
    { now: NOW },
  );
  const goals = {
    targetType: "income",
    monthlyTarget: 0,
    dispatchDays: [6],
    storageUnits: 10,
    cashNeededBy: null,
    daysToSell: 7,
    deliveryDays: 2,
    payoutDelayDays: 2,
  };
  saveGoals(db, goals, { now: NOW });
  // Sold Wednesday 4th, posted only on Saturday 7th, delivered 9th, paid 11th.
  const saturday = estimateFromEvidence(db, one({ cashNeededDays: undefined, cashNeededBy: "2026-11-10" }));
  assert.equal(saturday.payout.goals.saved, true);
  assert.deepEqual(saturday.payout.goals.dispatchDays, [6]);
  assert.equal(saturday.payout.dispatch, "2026-11-07");
  assert.equal(saturday.payout.date, "2026-11-11");
  assert.equal(checkOk(saturday, "days-to-sell"), false);
  assert.equal(checkOk(estimateFromEvidence(db, one({ cashNeededDays: 14 })), "days-to-sell"), true);

  saveGoals(db, { ...goals, dispatchDays: [] }, { now: NOW });
  const none = estimateFromEvidence(db, one({ cashNeededDays: 14 }));
  assert.equal(none.payout.date, null);
  assert.match(none.payout.note, /No dispatch days/);
  const check = none.alert.checks.find((c) => c.id === "days-to-sell");
  assert.equal(check.ok, false);
  assert.match(check.detail, /Payout date unknown/);
});

// ---------------------------------------------------------------------------
// Promotion and branch availability feed the tier (M17, P14).

test("an unconfirmed promotion with no regular price goes to Review, not Priority 2", () => {
  const db = fixture();
  db.prepare("UPDATE research SET promotion = 'Clubcard price' WHERE source_id = 'offer-1'").run();
  // The shelf price seen at the branch is the promotion price, so its
  // condition still applies (round 5).
  priceAll(db, 1000);
  const r = estimateFromEvidence(db, request());
  assert.equal(r.unitCost, 1000);
  assert.equal(tierOf(r), "Review");
  assert.ok(r.opportunity.reasons.some((x) => /promotion you have not confirmed/.test(x)));
  assert.equal(r.alert.eligible, false);
  const confirmed = estimateFromEvidence(db, request({ promotionEligible: true }));
  assert.equal(tierOf(confirmed), "Priority 2");
  assert.equal(confirmed.alert.eligible, true);
});

test("a recent check that found none on the shelf gives Review, never Priority 2", () => {
  const db = fixture({ check: false });
  recordCheck(
    db,
    { barcode: BARCODE, retailer: "Argos", locality: "Leeds", method: "in_store", inStock: false, checkedAt: daysBefore(0) + "T09:00:00Z" },
    { now: NOW },
  );
  const r = estimateFromEvidence(db, request());
  assert.equal(r.stock.availability, "out_of_stock");
  assert.equal(tierOf(r), "Review");
  assert.ok(r.opportunity.reasons.includes("Latest check found none on the shelf"));
  // With no check at all the stock is unknown, and the feed's price is not
  // shown to apply at any branch, so it is Review too (round 5).
  const unknown = estimateFromEvidence(fixture({ check: false }), request());
  assert.equal(unknown.stock.availability, "unknown");
  assert.equal(tierOf(unknown), "Review");
});

test("without a locality no branch check can count, and the estimate says so", () => {
  const db = fixture();
  const r = estimateFromEvidence(db, request({ locality: undefined }));
  assert.ok(r.warnings.some((w) => /No locality given/.test(w)));
  assert.equal(r.stock.confirmed, false);
  // With a locality, the warning is stockStatus's own reason.
  const elsewhere = estimateFromEvidence(db, request({ locality: "York" }));
  assert.ok(elsewhere.warnings.some((w) => /No availability check in York/.test(w)));
  assert.equal(r.inputs.locality, null);
});

// ---------------------------------------------------------------------------
// Category rules (P6).

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

test("the category comes from the request, else from a clear title word", () => {
  assert.equal(suggestCategory({ title: "Cotton crew-neck jumper, navy" }).id, "clothing");
  assert.equal(suggestCategory({ title: "Yorkshire heather honey 340g" }).id, "food");
  assert.equal(suggestCategory({ title: "Tefal Ingenio frying pan 28cm" }).id, "general");
  assert.equal(suggestCategory({ title: "Laptop stand" }).id, "general");

  const db = fixture();
  const general = estimateFromEvidence(db, request());
  assert.equal(general.category.id, "general");
  assert.deepEqual(
    pick(general.category, ["chosen", "suggested", "applied", "reason", "warning"]),
    { chosen: null, suggested: "general", applied: "general", reason: null, warning: null },
  );
  assert.deepEqual(general.category.failures, []);
  assert.equal(general.offer.suggestedCategory.id, "general");

  db.prepare("UPDATE research SET title = 'Navy wool jumper' WHERE source_id = 'offer-1'").run();
  const suggested = estimateFromEvidence(db, request());
  assert.equal(suggested.category.id, "clothing");
  assert.equal(suggested.category.chosen, null);
  // A stricter choice needs no reason and carries no warning.
  const stricter = estimateFromEvidence(db, request({ category: "food" }));
  assert.equal(stricter.category.applied, "clothing", "food would drop the clothing rules, so it needs a reason");

  for (const category of ["shoes", 1, "__proto__"])
    assert.throws(
      () => validateEstimateRequest(request({ category })),
      (e) => e instanceof HttpError && e.status === 400,
    );
});

test("clothing raises the returns allowance and needs a size", () => {
  const db = fixture();
  const r = estimateFromEvidence(db, request({ category: "clothing" }));
  assert.equal(r.category.returnsRate, CATEGORY_RULES.clothing.minReturnsRate);
  assert.equal(r.category.returnsRaised, true);
  // 15% of the £30 sale per unit, two units.
  assert.equal(r.economics.costs.returns, 2 * 450);
  assert.ok(r.assumptions.some((a) => /Clothing returns allowance raised to 15%/.test(a)));
  assert.deepEqual(r.category.failures, []);

  db.prepare("UPDATE research SET size = NULL WHERE source_id = 'offer-1'").run();
  const sizeless = estimateFromEvidence(db, request({ category: "clothing", offerAttributes: {} }));
  assert.ok(sizeless.category.failures.some((f) => /needs a size/.test(f)));
  assert.equal(tierOf(sizeless), "Review");
  assert.equal(sizeless.alert.eligible, false);
});

test("food needs checked packaging and enough shelf life after the expected sale", () => {
  const db = fixture();
  const unchecked = estimateFromEvidence(db, request({ category: "food" }));
  assert.equal(tierOf(unchecked), "Review");
  assert.ok(unchecked.category.failures.some((f) => /packaging not checked/.test(f)));
  assert.ok(unchecked.category.failures.some((f) => /Best-before date not recorded/.test(f)));
  assert.equal(unchecked.alert.eligible, false);

  // 4 days to sell: 33 days left leaves 29 after the sale, under 30.
  const short = estimateFromEvidence(
    db,
    request({ category: "food", packagingChecked: true, bestBefore: "2026-12-03" }),
  );
  assert.deepEqual(short.category.failures, [
    "Less than 30 days left on the best-before date after the expected sale",
  ]);
  const ok = estimateFromEvidence(
    db,
    request({ category: "food", packagingChecked: true, bestBefore: "2027-03-01" }),
  );
  assert.deepEqual(ok.category.failures, []);
  assert.equal(tierOf(ok), "Priority 2");
  assert.equal(ok.alert.eligible, true);
  assert.throws(
    () => validateEstimateRequest(request({ bestBefore: "soon" })),
    (e) => e instanceof HttpError && e.status === 400,
  );
  assert.throws(
    () => validateEstimateRequest(request({ packagingChecked: "yes" })),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

// ---------------------------------------------------------------------------
// Imported offers reach an exact match only once the operator confirms the
// blank attributes (P3, qa:Q3, tests:Q1).

const FIXTURES = new URL("./fixtures/sources/", import.meta.url);

/**
 * The Awin fixture feed and manual sales through the real adapters. The feed's
 * made-up "Example ..." merchants make it sample data, so by default the
 * merchant is renamed to stand in for a real feed with the same rows.
 */
function importedFixture({ asShipped = false } = {}) {
  const db = memoryDb(evidenceTables, auditSchema);
  upsertResearch(db, "awin", awin(readFileSync(new URL("awin-sample.csv", FIXTURES), "utf8")), { now: NOW });
  const retailer = asShipped ? "Example Outfitters" : "Northern Outfitters";
  if (!asShipped) db.prepare("UPDATE research SET retailer = ? WHERE provider = 'awin' AND retailer = 'Example Outfitters'").run(retailer);
  const sale = (reference, totalPence, soldDate, listedDate, seller) => ({
    reference,
    title: "Cotton crew neck jumper navy M",
    variant: "Navy, medium",
    barcode: "5012345678900",
    size: "M",
    pack: "1",
    model: "CJ-200",
    condition: "New",
    currency: "GBP",
    totalPence,
    soldDate,
    listedDate,
    seller,
  });
  upsertResearch(
    db,
    "manual",
    sold(
      [
        sale("ebay-1", 3400, "2026-10-20", "2026-10-15", "alpha"),
        sale("ebay-2", 3600, "2026-10-22", "2026-10-18", "bravo"),
        sale("ebay-3", 3500, "2026-10-25", "2026-10-21", "charlie"),
      ],
      { now: NOW },
    ),
    { now: NOW },
  );
  db.prepare("INSERT INTO permissions(provider, programme, display) VALUES('awin', ?, 1)").run(retailer);
  // The check records the shelf price, the price the feed lists, so the
  // price applies at the branch checked (round 5).
  const listed = db.prepare("SELECT price FROM research WHERE provider = 'awin' AND source_id = '1001'").get().price;
  recordCheck(
    db,
    { barcode: "5012345678900", retailer, locality: "Leeds", method: "in_store", inStock: true, checkedAt: daysBefore(0) + "T09:00:00Z", pricePence: listed },
    { now: NOW },
  );
  lookedUp(db);
  return db;
}
// One unit: three sales in 90 days cannot absorb more in the sell window.
const importedRequest = (extra = {}) =>
  request({
    offer: { provider: "awin", sourceId: "1001" },
    sales: ["ebay-1", "ebay-2", "ebay-3"].map((sourceId) => ({ provider: "manual", sourceId })),
    units: 1,
    weightKg: 0.4,
    hourlyFloor: 600,
    ...extra,
  });

test("an imported Awin offer matches imported sales only after the operator confirms its pack", () => {
  const db = importedFixture();
  const row = db.prepare("SELECT pack, model, size, condition FROM research WHERE provider = 'awin' AND source_id = '1001'").get();
  assert.deepEqual({ ...row }, { pack: null, model: "cj-200", size: "m", condition: "new" });

  // Fails closed without the confirmation: the feed never states the pack.
  const before = estimateFromEvidence(db, importedRequest());
  assert.equal(before.match, "research");
  assert.equal(before.economics, null);
  assert.equal(before.sample.count, 0);
  assert.ok(before.sample.excluded.every((x) => /Pack not stated for the offer/.test(x.reason)));
  assert.equal(before.alert.eligible, false);
  assert.equal(candidatesFor(db, { provider: "awin", sourceId: "1001", now: NOW }).sales.every((s) => !s.confirmable), true);

  // The operator looked at the item: one jumper in the pack.
  const after = estimateFromEvidence(db, importedRequest({ offerAttributes: { pack: "single" } }));
  assert.equal(after.match, "exact");
  assert.equal(after.sample.count, 3);
  assert.equal(after.sample.independent, 3);
  assert.equal(after.offer.pack, "single");
  assert.equal(after.offer.attributeSource.pack, "operator");
  assert.equal(after.offer.attributeSource.model, "source");
  assert.deepEqual(after.offer.operatorConfirmed, ["pack"]);
  assert.deepEqual(after.offerAttributes.applied, { pack: "single" });
  assert.ok(after.assumptions.some((a) => /You confirmed pack single after looking at the item/.test(a)));
  // The feed names a jumper, so clothing rules apply: size M is stated and
  // returns are raised to 15%.
  assert.equal(after.category.id, "clothing");
  assert.deepEqual(after.category.failures, []);
  assert.equal(after.opportunity.tier, "Priority 2");
  // Three sales in 90 days are 0.23 a week: not even one unit is expected to
  // sell within two weeks, so the alert stays closed.
  assert.equal(after.demand.units, 0);
  assert.deepEqual(failing(after), ["demand"]);
  assert.match(after.alert.reasons[0], /Sales support about 0 units within 2 weeks/);
  assert.equal(after.alert.eligible, false);

  const confirmable = candidatesFor(db, {
    provider: "awin",
    sourceId: "1001",
    now: NOW,
    offerAttributes: { pack: "1" },
  });
  assert.ok(confirmable.sales.every((s) => s.confirmable && s.status === "exact"));
});

test("operator attributes never override a stored value and must be recognised", () => {
  const db = importedFixture();
  const r = estimateFromEvidence(
    db,
    importedRequest({ offerAttributes: { pack: "1", model: "CJ-999", size: "L" } }),
  );
  // The feed states model CJ-200 and size M, so those are kept.
  assert.equal(r.offer.model, "cj-200");
  assert.equal(r.offer.size, "m");
  assert.deepEqual(r.offerAttributes.applied, { pack: "1" });
  assert.deepEqual(r.offerAttributes.ignored.map((x) => x.key), ["size", "model"]);
  assert.ok(r.warnings.some((w) => /Model you confirmed \(CJ-999\) differs from the source \(cj-200\)/.test(w)));
  assert.equal(r.match, "exact");
  // The same value spelt differently is not a conflict.
  assert.deepEqual(applyOfferAttributes({ model: "cj-200", kind: KIND.RETAIL }, { model: "CJ 200" }).ignored, []);

  for (const offerAttributes of [
    { pack: "several" },
    { condition: "mint" },
    { colour: "navy" },
    { pack: { toString: 1 } },
    JSON.parse('{"__proto__": {"pack": "1"}}'),
    "pack 1",
  ])
    assert.throws(
      () => validateEstimateRequest(importedRequest({ offerAttributes })),
      (e) => e instanceof HttpError && e.status === 400,
      JSON.stringify(offerAttributes),
    );
});

test("an Open Prices offer, imported through the adapter, matches once pack and model are confirmed", () => {
  const db = memoryDb(evidenceTables, auditSchema);
  const page = JSON.parse(readFileSync(new URL("openprices-page.json", FIXTURES), "utf8"));
  const rows = openPrices(page).map((r) => (r.id === 1 ? { ...r, day: daysBefore(1) } : r));
  upsertObservations(db, rows, { now: NOW });
  upsertResearch(
    db,
    "manual",
    sold(
      ["a", "b", "c"].map((seller, i) => ({
        reference: "flapjack-" + seller,
        title: "Vegan cherry coconut oat flapjack 120g",
        variant: "120 g bar",
        barcode: "5060006200021",
        size: "120 g",
        pack: "1",
        model: "VCF-120",
        condition: "new",
        currency: "GBP",
        totalPence: 900 + i * 50,
        soldDate: daysBefore(5),
        listedDate: daysBefore(8),
        seller,
      })),
      { now: NOW },
    ),
    { now: NOW },
  );
  const offer = { provider: "openprices", sourceId: "1" };
  const sales = ["a", "b", "c"].map((s) => ({ provider: "manual", sourceId: "flapjack-" + s }));
  const before = estimateFromEvidence(db, request({ offer, sales }));
  assert.equal(before.match, "research");
  assert.ok(before.sample.excluded.every((x) => /Pack not stated for the offer; Model not stated for the offer/.test(x.reason)));
  const after = estimateFromEvidence(
    db,
    request({ offer, sales, offerAttributes: { pack: "1", model: "VCF-120" } }),
  );
  assert.equal(after.match, "exact");
  assert.equal(after.sample.count, 3);
  assert.equal(after.offer.attributeSource.size, "source");
  assert.deepEqual(after.offer.operatorConfirmed, ["pack", "model"]);
  // A flapjack is food: the packaging and best-before checks apply.
  assert.equal(after.category.id, "food");
  assert.ok(after.category.failures.length > 0);
});

// ---------------------------------------------------------------------------
// Sample sales mixed into live evidence (tests:Q8).

test("a live offer whose sold sample includes a sample sale is never alert-eligible", () => {
  const db = fixture();
  insert(db, saleRow("sample-4", { price: 3100 }));
  const sales = [...request().sales, { provider: "manual", sourceId: "sample-4" }];
  const r = estimateFromEvidence(db, request({ sales }));
  assert.equal(r.offer.sample, false);
  assert.equal(r.sample.count, 22);
  assert.ok(r.sample.used.some((u) => u.source_id === "sample-4"));
  assert.equal(checkOk(r, "live-evidence"), false);
  assert.equal(r.sampleData, true);
  assert.equal(estimateFromEvidence(db, request()).sampleData, false);
  assert.ok(r.warnings.includes("Sample data: illustrative only and never a buy alert"));
  assert.equal(r.opportunity.tier, "Review");
  assert.equal(r.alert.eligible, false);
});

// ---------------------------------------------------------------------------
// Three prices side by side (P8).

test("the claimed, observed and sold prices are reported apart with their classes and dates", () => {
  const db = memoryDb(evidenceTables, auditSchema);
  db.prepare(
    `INSERT INTO observations(id, title, store, price, regular_price, discounted, discount_type, day, unit, quantity, barcode)
 VALUES(77, 'Tefal pan', 'Argos', 1200, 1600, 1, 'LOYALTY_PROGRAM', ?, 'UNKNOWN', '28cm', ?)`,
  ).run(daysBefore(1), BARCODE);
  db.prepare(
    `INSERT INTO observations(id, title, store, price, day, unit, quantity, barcode)
 VALUES(78, 'Tefal pan', 'Argos', 1500, ?, 'UNKNOWN', '28cm', ?), (79, 'Tefal pan', 'Argos', 300, ?, 'KILOGRAM', '28cm', ?)`,
  ).run(daysBefore(40), "0" + BARCODE, daysBefore(2), BARCODE);
  insert(db, offerRow({ source_id: "argos-old", price: 1400, observed: daysBefore(20) }));
  insert(db, saleRow("amz-1", { kind: KIND.AMAZON, provider: "keepa", price: 1999, observed: daysBefore(3) }));
  ["s1", "s2", "s3"].forEach((id, i) => insert(db, saleRow(id, { price: 2800 + i * 200 })));
  insert(db, saleRow("s4", { price: 5000 }));
  const r = estimateFromEvidence(
    db,
    request({
      offer: { provider: "openprices", sourceId: "77" },
      sales: salesOf(["s1", "s2", "s3"]),
      offerAttributes: { pack: "1", model: "L15006" },
    }),
  );
  const p = r.prices;
  assert.deepEqual(
    { ...p.claimed, basis: undefined },
    { evidenceClass: KIND.RETAIL, kind: "regular", price: 1600, observed: daysBefore(1), basis: undefined },
  );
  // Over time: the chosen observation, an older one and a retail offer; the
  // per-kilogram price is left out.
  assert.deepEqual(
    p.observed.points.map((x) => [x.provider + ":" + x.sourceId, x.price, x.observed, x.evidenceClass, x.chosen]),
    [
      ["openprices:77", 1200, daysBefore(1), KIND.RETAIL, true],
      ["awin:argos-old", 1400, daysBefore(20), KIND.RETAIL, false],
      ["openprices:78", 1500, daysBefore(40), KIND.RETAIL, false],
    ],
  );
  assert.equal(p.observed.lowest, 1200);
  assert.equal(p.observed.highest, 1500);
  assert.equal(p.observed.oldest, daysBefore(40));
  // Amazon history is research context, never mixed with retail prices.
  assert.equal(p.observed.amazon.evidenceClass, KIND.AMAZON);
  assert.deepEqual(p.observed.amazon.points.map((x) => x.price), [1999]);
  // Completed sales: the confirmed sample, with the unconfirmed exact sale counted apart.
  assert.equal(p.sold.evidenceClass, KIND.SOLD);
  assert.equal(p.sold.count, 3);
  assert.equal(p.sold.lowerMedian, 3000);
  assert.equal(p.sold.highest, 3200);
  assert.equal(p.sold.exactNotInSample, 1);
  // A source without a regular price claims nothing.
  assert.equal(estimateFromEvidence(fixture(), request()).prices.claimed, null);
});

// ---------------------------------------------------------------------------
// Inherited object keys are client errors (B4).

test("rule keys named after Object.prototype members give 400, never 500", async () => {
  for (const rules of [{ toString: 1 }, { constructor: 1 }, { hasOwnProperty: 1 }, JSON.parse('{"__proto__": 1}')])
    assert.throws(
      () => validateEstimateRequest(request({ rules })),
      (e) => e instanceof HttpError && e.status === 400 && /rules can only set/.test(e.message),
      JSON.stringify(rules),
    );
  const now = new Date().toISOString();
  const db = fixture({ now });
  const api = await serve(db, [researchRoutes]);
  try {
    for (const raw of ['{"toString": 1}', '{"constructor": 1}', '{"__proto__": 1}']) {
      const body = { ...request({ now: undefined }), rules: JSON.parse(raw) };
      const res = await api.call("POST", "/api/research/estimate", body);
      assert.equal(res.status, 400, raw);
    }
    const attr = await api.call("POST", "/api/research/estimate", {
      ...request({ now: undefined }),
      offerAttributes: JSON.parse('{"__proto__": {"pack": "1"}}'),
    });
    assert.equal(attr.status, 400);
    // The candidates route takes confirmed attributes from the query.
    const bad = await api.call("GET", "/api/research/candidates?provider=awin&sourceId=offer-1&pack=lots");
    assert.equal(bad.status, 400);
    const ok = await api.call("GET", "/api/research/candidates?provider=awin&sourceId=offer-1&pack=2");
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.offerAttributes.ignored.map((x) => x.key), ["pack"]);
    const rules = await api.call("GET", "/api/research/rules");
    assert.deepEqual(Object.keys(rules.body.categories), ["general", "clothing", "food"]);
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// Claimed prices from a feed are claims, never the cost.

test("an Awin previous price or RRP is the claimed price, never the regular price used as cost", () => {
  const db = memoryDb(evidenceTables, auditSchema);
  const feed = [
    "aw_product_id,product_name,currency,search_price,ean,merchant_name,last_updated,condition,Fashion:size,model_number,product_price_old,rrp_price,promotional_text",
    `5001,Tefal Ingenio frying pan 28cm,GBP,12.00,${BARCODE},Argos,${daysBefore(1)},new,28cm,L15006,18.00,20.00,Clubcard price`,
    `5002,Tefal Ingenio frying pan 28cm,GBP,12.00,${BARCODE},Argos,${daysBefore(1)},new,28cm,L15006,,20.00,`,
  ].join("\n");
  upsertResearch(db, "awin", awin(feed), { now: NOW });
  ["s1", "s2", "s3"].forEach((id, i) => insert(db, saleRow(id, { price: 2800 + i * 200 })));
  const offer = (sourceId) => ({ provider: "awin", sourceId });
  const was = estimateFromEvidence(db, request({ offer: offer("5001"), offerAttributes: { pack: "1" } }));
  assert.equal(was.offer.wasPrice, 1800);
  assert.equal(was.offer.rrpPrice, 2000);
  assert.equal(was.offer.regularPrice, null);
  assert.deepEqual(
    { ...was.prices.claimed },
    {
      evidenceClass: KIND.RETAIL,
      kind: "previous",
      price: 1800,
      observed: daysBefore(1),
      basis: "Previous price claimed by the retailer in the Awin feed",
    },
  );
  // An unconfirmed promotion is not costed at the claimed price: nobody pays
  // a was-price, so the real cost stays unknown and the tier is Review.
  assert.equal(was.unitCost, 1200);
  assert.equal(was.opportunity.tier, "Review");
  assert.ok(was.opportunity.reasons.some((x) => /promotion you have not confirmed/.test(x)));

  const rrp = estimateFromEvidence(db, request({ offer: offer("5002"), offerAttributes: { pack: "1" } }));
  assert.equal(rrp.prices.claimed.kind, "rrp");
  assert.equal(rrp.prices.claimed.price, 2000);
  assert.equal(rrp.prices.claimed.basis, "Recommended retail price in the Awin feed");
  assert.equal(rrp.unitCost, 1200);
});

// ---------------------------------------------------------------------------
// An item with no model number matches only once the operator confirms it.

test("a no-model item reaches an exact match only when the operator confirms it has none", () => {
  const db = memoryDb(evidenceTables, auditSchema);
  const honey = "5000128104517";
  db.prepare(
    `INSERT INTO observations(id, title, store, place, city, price, day, unit, quantity, barcode)
 VALUES(501, 'Yorkshire heather honey', 'Tesco', 'SE1 7PB', 'London', 750, ?, 'UNKNOWN', '340 g', ?)`,
  ).run(daysBefore(1), honey);
  const sale = (id, extra = {}) =>
    saleRow(id, { barcode: honey, title: "Yorkshire heather honey 340g", size: "340g", model: null, price: 1900, ...extra });
  ["h1", "h2", "h3"].forEach((id) => insert(db, sale(id)));
  insert(db, sale("h-model", { model: "YH-340" }));
  const offer = { provider: "openprices", sourceId: "501" };
  const sales = ["h1", "h2", "h3", "h-model"].map((sourceId) => ({ provider: "manual", sourceId }));
  const food = { category: "food", packagingChecked: true, bestBefore: "2027-06-01" };

  // Pack alone is not enough: neither side states a model.
  const packOnly = estimateFromEvidence(db, request({ offer, sales, ...food, offerAttributes: { pack: "1" } }));
  assert.equal(packOnly.match, "research");
  assert.ok(packOnly.sample.excluded.some((x) => /Model not stated for the offer/.test(x.reason)));

  const none = estimateFromEvidence(
    db,
    request({ offer, sales, ...food, offerAttributes: { pack: "1", model: "none" } }),
  );
  assert.equal(none.match, "exact");
  assert.equal(none.sample.count, 3);
  assert.equal(none.offer.model, "none");
  assert.equal(none.offer.attributeSource.model, "operator");
  // A sale that states a model is still a different variant.
  const stated = none.sample.excluded.find((x) => x.row.source_id === "h-model");
  assert.match(stated.reason, /Model differs/);
  assert.equal(none.category.id, "food");
  assert.deepEqual(none.category.failures, []);

  // The candidates view agrees once the same confirmation is given.
  const c = candidatesFor(db, { ...offer, now: NOW, offerAttributes: { pack: "1", model: "none" } });
  assert.deepEqual(
    c.sales.map((x) => [x.row.source_id, x.status]).sort(),
    [["h-model", "research"], ["h1", "exact"], ["h2", "exact"], ["h3", "exact"]],
  );
});

// ---------------------------------------------------------------------------
// Round two: required inputs, demand, payout by sales rate, London dates,
// category downgrades, sample merchants and stale competition.

test("blank packaging cost and handling time are missing inputs, never zero; a typed 0 counts (R2P3)", () => {
  const db = fixture();
  const { packaging: _p, handlingMinutes: _h, ...blankCosts } = request().costs;
  const blank = estimateFromEvidence(db, request({ costs: blankCosts }));
  assert.deepEqual(blank.missingInputs, ["packaging cost", "handling time"]);
  assert.deepEqual(failing(blank), ["positive-contribution", "hourly-floor", "inputs-entered", "buying-thresholds"]);
  const check = blank.alert.checks.find((c) => c.id === "inputs-entered");
  assert.equal(check.detail, "Not entered: packaging cost, handling time. A blank is never counted as zero");
  assert.equal(tierOf(blank), "Review");
  assert.ok(blank.opportunity.reasons.includes(check.detail));
  assert.ok(blank.warnings.some((w) => /No packaging cost entered/.test(w)));
  assert.ok(blank.warnings.some((w) => /No handling time entered/.test(w)));
  assert.match(blank.mainUncertainty, /^Packaging cost and handling time not entered/);
  assert.equal(blank.alert.eligible, false);

  // Handling alone blank: the cost is known, earnings per hour are not.
  const { handlingMinutes: _x, ...noHandling } = request().costs;
  const timeless = estimateFromEvidence(db, request({ costs: noHandling }));
  assert.deepEqual(failing(timeless), ["hourly-floor", "inputs-entered", "buying-thresholds"]);

  // Entered as 0 on purpose: accepted, with a note about what it leaves out.
  const typed = estimateFromEvidence(db, request({ costs: { ...request().costs, packaging: 0, handlingMinutes: 0 } }));
  assert.deepEqual(typed.missingInputs, []);
  assert.equal(checkOk(typed, "inputs-entered"), true);
  assert.equal(typed.alert.eligible, true);
  assert.ok(typed.warnings.some((w) => /Handling time entered as 0/.test(w)));

  assert.deepEqual(missingInputsOf(["feeRate", "handlingMinutes", "postage"]), ["parcel cost", "handling time"]);
  // A blank parcel cost is a missing input as well as an unknown parcel cost.
  const { postage: _q, ...noPostage } = request().costs;
  const unposted = estimateFromEvidence(db, request({ costs: noPostage }));
  assert.deepEqual(unposted.missingInputs, ["parcel cost"]);
  assert.ok(failing(unposted).includes("inputs-entered") && failing(unposted).includes("shipping"));
});

test("several units pay out at the confirmed sales rate, not as fast as one (R2M4, R2Q3)", () => {
  // Three confirmed sales in 90 days: 0.23 a week. Each sold 4 days after listing.
  const db = fixture({ sales: ["s1", "s2", "s3"] });
  const r = estimateFromEvidence(
    db,
    request({ units: 3, sales: salesOf(["s1", "s2", "s3"]), cashNeededDays: undefined, cashNeededBy: "2026-11-08" }),
  );
  assert.equal(r.sample.daysToSell, 4);
  assert.equal(r.opportunity.salesPerWeek, 0.23);
  // The first unit pays out on 8 November; the others weeks later.
  assert.equal(r.payout.unitPayouts[0], "2026-11-08");
  assert.ok(r.payout.unitPayouts[1] > "2026-12-25" && r.payout.unitPayouts[2] > r.payout.unitPayouts[1]);
  assert.equal(r.payout.date, r.payout.unitPayouts[2]);
  assert.ok(r.payout.goals.daysToSellAll >= 89);
  assert.equal(r.payout.unitsByCashDate, 1);
  assert.equal(r.payout.timing.status, "late");
  assert.match(r.payout.note, /the last of 3 units sells by/);
  assert.ok(r.assumptions.includes("1 of 3 units expected to have paid out by 8 Nov 2026, the date you need the cash"));
  assert.ok(r.assumptions.some((a) => /At 0\.23 confirmed sales a week, the last of 3 units is expected to sell after \d+ days, not after the 4 days one sale takes/.test(a)));
  // Research never passes 3 units at 0.23 sales a week.
  assert.equal(checkOk(r, "days-to-sell"), false);
  assert.equal(checkOk(r, "demand"), false);
  assert.equal(r.demand.units, 0);
  assert.equal(r.alert.eligible, false);

  // Without a cash date the payout is still dated by the last unit.
  const free = estimateFromEvidence(db, request({ units: 3, sales: salesOf(["s1", "s2", "s3"]), cashNeededDays: undefined }));
  assert.equal(free.payout.date, r.payout.date);
  assert.equal(free.payout.unitsByCashDate, null);

  // An unknown sales rate cannot schedule more than one unit.
  const goals = { dispatchDays: [1, 2, 3, 4, 5], deliveryDays: 2, payoutDelayDays: 2, updated: null };
  const unknown = payoutSchedule({ now: NOW, daysToSell: 4, goals, units: 2, salesPerWeek: null, cashNeededDays: 30 });
  assert.equal(unknown.date, null);
  assert.equal(unknown.timing.status, "unknown");
  assert.match(unknown.note, /sales rate is unknown/);
  assert.equal(payoutSchedule({ now: NOW, daysToSell: 4, goals, units: 1 }).date, "2026-11-08");
});

test("today for payout and cash dates is the London date, not the UTC date (R2M6)", () => {
  // Saturday 4 July 2026 at 00:30 in London is Friday 3 July 23:30 UTC.
  const now = "2026-07-03T23:30:00.000Z";
  const db = fixture({ now });
  const req = request({ now, units: 1, hourlyFloor: 600, cashNeededDays: undefined, cashNeededBy: "2026-07-16" });
  const r = estimateFromEvidence(db, req);
  assert.equal(r.payout.start, "2026-07-04");
  // Listed Saturday, sold Wednesday 8 July, posted that day, paid on Sunday 12th.
  assert.equal(r.payout.sold, "2026-07-08");
  assert.equal(r.payout.date, "2026-07-12");
  assert.equal(r.payout.days, 8);
  assert.equal(r.cashNeededDays, 12);
  // An hour later it is still Saturday in London: the same answer.
  const later = estimateFromEvidence(db, { ...req, now: "2026-07-04T00:30:00.000Z" });
  assert.deepEqual(
    [later.payout.start, later.payout.date, later.cashNeededDays, later.payout.days],
    ["2026-07-04", "2026-07-12", 12, 8],
  );
  // At 23:30 on Friday in London it is still Friday.
  assert.equal(estimateFromEvidence(db, { ...req, now: "2026-07-03T22:30:00.000Z" }).payout.start, "2026-07-03");
  assert.equal(ukDate("2026-07-04"), "4 Jul 2026");
});

test("a looser category keeps the suggested rules unless a reason is given, and always warns (R2M3, R2P4)", () => {
  const db = fixture();
  db.prepare("UPDATE research SET title = 'Cotton crew-neck jumper navy', size = 'M' WHERE source_id = 'offer-1'").run();
  db.prepare("UPDATE research SET size = 'M' WHERE kind = ?").run(KIND.SOLD);
  const suggested = estimateFromEvidence(db, request());
  assert.equal(suggested.category.applied, "clothing");
  assert.equal(suggested.category.returnsRate, 0.15);

  // General with no reason: the clothing rules stay and the warning says so.
  const noReason = estimateFromEvidence(db, request({ category: "general" }));
  assert.deepEqual(
    pick(noReason.category, ["chosen", "suggested", "applied", "reason"]),
    { chosen: "general", suggested: "clothing", applied: "clothing", reason: null },
  );
  assert.equal(noReason.category.returnsRate, 0.15);
  assert.equal(noReason.economics.costs.returns, suggested.economics.costs.returns);
  assert.equal(noReason.opportunity.unitProfit, suggested.opportunity.unitProfit);
  assert.match(noReason.category.warning, /The title mentions "jumper", which suggests clothing\. You chose General, which would drop the 15% returns allowance and the size check, so the clothing rules still apply/);
  assert.ok(noReason.warnings.includes(noReason.category.warning));

  // With a reason, General applies, and the warning names what was dropped.
  const reasoned = estimateFromEvidence(db, request({ category: "general", categoryReason: "  A knitted tea cosy, not clothing  " }));
  assert.equal(reasoned.category.applied, "general");
  assert.equal(reasoned.category.reason, "A knitted tea cosy, not clothing");
  assert.equal(reasoned.category.returnsRate, 0.05);
  assert.match(reasoned.category.warning, /Costed as General although the title mentions "jumper", which suggests clothing: the 15% returns allowance and the size check are dropped\. Your reason: A knitted tea cosy, not clothing/);
  assert.ok(reasoned.warnings.includes(reasoned.category.warning));
  assert.ok(reasoned.opportunity.unitProfit > suggested.opportunity.unitProfit);

  // A blank reason is no reason; a stricter category needs none.
  assert.equal(estimateFromEvidence(db, request({ category: "general", categoryReason: "   " })).category.applied, "clothing");
  const plain = categoryDecision({ id: "general", basis: "The title does not clearly name clothing or food" }, "food");
  assert.deepEqual([plain.applied, plain.warning, plain.dropped], ["food", null, []]);
  assert.throws(
    () => validateEstimateRequest(request({ categoryReason: "x".repeat(301) })),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

test("Open Prices observations and food quantities suggest Food (R2Q12)", () => {
  assert.equal(suggestCategory({ title: "Celebrations Box", provider: "openprices" }).id, "food");
  assert.match(suggestCategory({ title: "Celebrations Box", provider: "openprices" }).basis, /Open Food Facts/);
  // A quantity suggests Food only from a food catalogue (R3P5, R3B8).
  assert.deepEqual(suggestCategory({ title: "Oat drink", size: "1 l", provider: "hobnight" }), {
    id: "food",
    basis: 'Hobnight is a supermarket catalogue and the size "1 l" is a food quantity',
  });
  assert.equal(suggestCategory({ title: "Celebrations 320g", provider: "hobnight" }).id, "food");
  assert.match(suggestCategory({ title: "Celebrations 320g", provider: "hobnight" }).basis, /title gives a food quantity \("320g"\)/);
  assert.equal(suggestCategory({ title: "Galaxy A15 5G phone" }).id, "general");
  assert.equal(suggestCategory({ title: "Tefal Ingenio frying pan 28cm", size: "28cm" }).id, "general");
  // A clothing word still wins over a quantity.
  assert.equal(suggestCategory({ title: "Merino socks 200g", provider: "openprices" }).id, "clothing");

  const db = memoryDb(evidenceTables, auditSchema);
  db.prepare(
    `INSERT INTO observations(id, title, store, price, day, unit, barcode) VALUES(90, 'Celebrations Box', 'Lidl', 600, ?, NULL, ?)`,
  ).run(daysBefore(1), BARCODE);
  const offer = findOffer(db, "openprices", "90", NOW);
  assert.equal(offer.suggestedCategory.id, "food");
  const r = estimateFromEvidence(db, request({ offer: { provider: "openprices", sourceId: "90" }, sales: [] }));
  assert.equal(r.category.applied, "food");
  assert.ok(r.category.failures.some((f) => /packaging not checked/.test(f)));
});

test("a volume or weight alone suggests General with a hint, never Food (R3P5, R3B8)", () => {
  const general = (offer) => {
    const s = suggestCategory(offer);
    assert.equal(s.id, "general", JSON.stringify(offer));
    return s;
  };
  // A kettle, a flask and a shampoo with a volume, from a feed or by hand.
  const kettle = general({ title: "Travel kettle white TK-5", size: "0.5 l", provider: "awin" });
  assert.equal(kettle.hint, QUANTITY_HINT);
  assert.equal(QUANTITY_HINT, "The size gives a quantity: choose Food if this is food");
  assert.equal(general({ title: "Steel kettle", size: "1.7l", provider: "awin" }).hint, QUANTITY_HINT);
  assert.equal(general({ title: "Stainless steel flask 500 ml", provider: "awin" }).hint, QUANTITY_HINT);
  assert.equal(general({ title: "Shampoo 250ml", provider: "manual" }).hint, QUANTITY_HINT);
  assert.equal(general({ title: "Hex dumbbell", size: "500g" }).hint, QUANTITY_HINT);
  // No quantity, no hint.
  assert.equal(general({ title: "Travel kettle white TK-5", size: "compact" }).hint, undefined);
  // Food words and the food catalogues still suggest Food.
  assert.equal(suggestCategory({ title: "Manuka honey 500ml", provider: "awin" }).id, "food");
  assert.equal(suggestCategory({ title: "Shampoo 250ml", provider: "openprices" }).id, "food");

  // The kettle costs as General with no reason and no dropped-checks warning.
  const db = fixture();
  db.prepare("UPDATE research SET title = 'Travel kettle white TK-5', size = '0.5 l' WHERE source_id = 'offer-1'").run();
  db.prepare("UPDATE research SET size = '0.5 l', title = 'Travel kettle TK-5' WHERE kind = ?").run(KIND.SOLD);
  const r = estimateFromEvidence(db, request());
  assert.equal(r.offer.suggestedCategory.id, "general");
  assert.equal(r.offer.suggestedCategory.hint, QUANTITY_HINT);
  assert.deepEqual([r.category.applied, r.category.warning], ["general", null]);
  assert.deepEqual(r.category.failures, []);
  assert.ok(!r.warnings.some((w) => /best-before|food/i.test(w)));
  // Food is stricter, so choosing it needs no reason.
  const food = estimateFromEvidence(db, request({ category: "food" }));
  assert.deepEqual([food.category.applied, food.category.warning], ["food", null]);
});

test("retailers and merchants named Example are sample data, wherever the file came from (R2M9)", () => {
  assert.equal(isSampleRecord({ provider: "awin", licence: "Licensed feed", retailer: "Example Outfitters" }), true);
  assert.equal(isSampleRecord({ provider: "awin", merchant_name: "Example Homeware" }), true);
  assert.equal(isSampleRecord({ provider: "awin", retailer: "Argos" }), false);
  assert.equal(isSampleRecord({ provider: "awin", retailer: "Exemplary Bakes" }), false);

  // The repository's own Awin sample feed, imported as if it were real.
  const db = importedFixture({ asShipped: true });
  const r = estimateFromEvidence(db, importedRequest({ offerAttributes: { pack: "1" } }));
  assert.equal(r.offer.sample, true);
  assert.equal(r.sampleData, true);
  assert.equal(checkOk(r, "live-evidence"), false);
  assert.equal(r.opportunity.tier, "Review");
  assert.equal(r.alert.eligible, false);
  assert.ok(listOffers(db, { now: NOW }).rows.every((o) => o.sample));
});

test("competition is known only from recent listings or a lookup; otherwise demand fails closed (R2M5)", () => {
  // No listings and no lookup on record: nobody may have looked.
  const unlooked = estimateFromEvidence(fixture({ lookup: false }), request());
  assert.equal(unlooked.competition.lookup, null);
  assert.equal(unlooked.competition.competingListings, null);
  assert.equal(unlooked.demand.units, null);
  assert.match(unlooked.demand.note, /^Competition not known: no competing listings are recorded and no asking-price lookup/);
  assert.deepEqual(failing(unlooked), ["demand"]);
  assert.match(unlooked.alert.reasons[0], /competing listings unknown/);
  // Weeks of supply use the same count, so an unchecked market never reads
  // as low competition.
  assert.equal(unlooked.opportunity.resaleWeeksOfSupply, null);
  assert.ok(unlooked.opportunity.reasons.includes("Resale competition high or unknown"));

  // A lookup older than its time to live does not count.
  const oldLookup = fixture({ lookup: false });
  lookedUp(oldLookup, { hoursAgo: 7 });
  assert.equal(askingLookup(oldLookup, "05012345678900", NOW), null);
  assert.equal(estimateFromEvidence(oldLookup, request()).demand.units, null);

  // One listing seen 180 days ago, and no lookup since: competition is not
  // known, so it can never open the gate.
  const stale = fixture({ lookup: false });
  insert(stale, saleRow("ask-old", { kind: KIND.ASKING, provider: "ebay", price: 2500, observed: daysBefore(180) }));
  const s = estimateFromEvidence(stale, request());
  assert.equal(s.competition.activeListings, null);
  assert.equal(s.demand.units, null);
  assert.match(s.demand.note, /^Competition not known\. Competing listings last checked/);
  assert.equal(s.opportunity.resaleWeeksOfSupply, null);
  assert.equal(checkOk(s, "demand"), false);
  assert.equal(s.alert.eligible, false);
  const c = candidatesFor(stale, { provider: "awin", sourceId: "offer-1", now: NOW });
  assert.equal(c.competition.activeListings, null);
  assert.equal(c.competition.competingListings, null);

  // A recent listing counts and lowers the units the sales rate supports.
  const fresh = fixture();
  insert(fresh, saleRow("ask-new", { kind: KIND.ASKING, provider: "ebay", price: 2500, observed: daysBefore(1) }));
  const f = estimateFromEvidence(fresh, request());
  assert.equal(f.demand.competingListings, 1);
  assert.equal(f.demand.units, 2);
  assert.equal(f.alert.eligible, true);
  assert.match(f.demand.note, /after allowing for 1 competing listing$/);
  assert.match(estimateFromEvidence(fixture(), request()).demand.note, /with no competing listings found by the latest asking-price lookup$/);
  assert.equal(estimateFromEvidence(fresh, request({ units: 3, cashNeededDays: 21 })).alert.reasons[0], "Sales support about 2 units within 2 weeks after competing listings, fewer than the 3 planned");
  assert.deepEqual(demandFor({ rate: null, competition: { activeListings: 0 }, lookup: null }).units, null);
});

test("classification uses the cost actually paid: an unconfirmed promotion is judged at the regular price (EJ13)", () => {
  const db = memoryDb(evidenceTables, auditSchema);
  db.prepare(
    `INSERT INTO observations(id, title, store, price, regular_price, discounted, discount_type, day, unit, quantity, barcode)
 VALUES(61, 'Tefal pan', 'Argos', 4500, 5500, 1, 'LOYALTY_PROGRAM', ?, NULL, '28cm', ?),
       (62, 'Tefal pan', 'Argos', 450, 600, 1, 'LOYALTY_PROGRAM', ?, NULL, '28cm', ?)`,
  ).run(daysBefore(1), BARCODE, daysBefore(1), BARCODE);
  const at = (id, extra = {}) => estimateFromEvidence(db, request({ offer: { provider: "openprices", sourceId: id }, sales: [], ...extra }));
  // £45 on promotion, £55 regular: costed at £55, above the £50 limit.
  const dear = at("61");
  assert.equal(dear.unitCost, 5500);
  assert.equal(tierOf(dear), "Reject");
  assert.match(dear.opportunity.reasons[0], /Purchase price outside £5 to £50/);
  // Confirmed eligibility: costed at £45, inside the band.
  assert.notEqual(tierOf(at("61", { promotionEligible: true })), "Reject");
  // £4.50 on promotion, £6 regular: costed at £6, inside the band.
  const cheap = at("62");
  assert.equal(cheap.unitCost, 600);
  assert.notEqual(tierOf(cheap), "Reject");
  assert.ok(!cheap.opportunity.reasons.some((x) => /Purchase price outside/.test(x)));
  assert.equal(tierOf(at("62", { promotionEligible: true })), "Reject");
});

test("results carry access needs, when the price and stock were checked and the main uncertainty (P7, P12)", () => {
  const db = fixture();
  const r = estimateFromEvidence(db, request());
  assert.deepEqual(r.access.needs.map((n) => n.label), ["Widely accessible"]);
  assert.equal(r.access.carrySource, "default");
  // The shelf price on the branch check dates the price (round 5).
  assert.equal(r.checked.price, new Date(Date.parse(NOW) - 3600000).toISOString());
  assert.equal(r.checked.stock, new Date(Date.parse(NOW) - 3600000).toISOString());
  assert.match(r.mainUncertainty, /^Whether buyers still pay about £30\.00/);

  const heavy = estimateFromEvidence(db, request({ weightKg: 1.5, carryKg: 1 }));
  assert.deepEqual(heavy.access.needs.map((n) => n.label), ["Vehicle required", "Heavy handling"]);
  assert.equal(heavy.access.carryKg, 1);
  assert.throws(() => validateEstimateRequest(request({ carryKg: -1 })), (e) => e instanceof HttpError && e.status === 400);

  // Few units seen on the shelf, and no stock check at all.
  recordCheck(db, { barcode: BARCODE, retailer: "Argos", locality: "Leeds", method: "in_store", inStock: true, unitsSeen: 2, checkedAt: new Date(Date.parse(NOW) - 600000).toISOString() }, { now: NOW });
  assert.match(estimateFromEvidence(db, request()).access.needs.find((n) => n.id === "limited-stock").detail, /^2 on the shelf$/);
  const unchecked = estimateFromEvidence(fixture({ check: false }), request());
  assert.equal(unchecked.checked.stock, null);
  assert.equal(unchecked.access.needs.find((n) => n.id === "limited-stock").detail, "Shelf stock unknown");
  assert.match(unchecked.mainUncertainty, /Branch stock has not been confirmed/);
  assert.equal(estimateFromEvidence(db, request({ sales: [] })).mainUncertainty, "No confirmed completed sale of this exact item yet, so what buyers pay is not known");
});

// ---------------------------------------------------------------------------
// A newer Open Prices price at the same shop (R3M3).

const HONEY = "5012345678443";
function honeyShop({ now = NOW } = {}) {
  const db = memoryDb(evidenceTables, auditSchema);
  const add = db.prepare(
    `INSERT INTO observations(id, title, store, place, city, osm_id, price, day, unit, quantity, barcode)
 VALUES(?, 'Manuka honey MGO 263+', ?, ?, 'London', ?, ?, ?, ?, '250 g', ?)`,
  );
  const today = new Date(Date.parse(now)).toISOString().slice(0, 10);
  // The chosen observation, then a newer one at the same shop the same day.
  add.run(990001, "Sainsbury's", "NW1 7DL", null, 1500, daysBefore(1, now), null, HONEY);
  add.run(990003, " sainsbury's ", "nw1  7dl", null, 1900, today, null, HONEY);
  // Not this shop, older than the chosen one, priced per kilogram or dated
  // in the future: none of these is the current price.
  add.run(990004, "Tesco", "NW1 7DL", null, 2500, today, null, HONEY);
  add.run(990005, "Sainsbury's", "SE1 9SG", null, 2600, today, null, HONEY);
  add.run(990000, "Sainsbury's", "NW1 7DL", null, 1000, daysBefore(5, now), null, HONEY);
  add.run(990006, "Sainsbury's", "NW1 7DL", null, 6000, today, "KILOGRAM", HONEY);
  add.run(990007, "Sainsbury's", "NW1 7DL", null, 2900, "2026-11-02", null, HONEY);
  return db;
}

test("the current shop price is the newest same-shop observation at or after the chosen one", () => {
  const db = honeyShop();
  const current = currentShopPrice(db, "990001", { now: NOW });
  assert.deepEqual(
    { ...current, offer: undefined },
    {
      sourceId: "990003",
      price: 1900,
      regularPrice: null,
      promotion: null,
      observed: "2026-10-31",
      newer: true,
      chosen: { sourceId: "990001", price: 1500, observed: "2026-10-30" },
      offer: undefined,
    },
  );
  assert.equal(current.offer.provider, "openprices");
  assert.equal(current.offer.sourceId, "990003");
  // The newest is its own current price; numbers work as ids too.
  assert.equal(currentShopPrice(db, 990003, { now: NOW }).newer, false);
  assert.equal(currentShopPrice(db, "990003", { now: NOW }).price, 1900);
  // On the same day the later price id is the newer one, never the earlier.
  db.prepare("UPDATE observations SET day = ? WHERE id = 990001").run("2026-10-31");
  assert.equal(currentShopPrice(db, "990001", { now: NOW }).sourceId, "990003");
  db.prepare("INSERT INTO observations(id, title, store, place, price, day, barcode) VALUES(989999, 'Manuka', 'Sainsbury''s', 'NW1 7DL', 1200, '2026-10-31', ?)").run(HONEY);
  assert.equal(currentShopPrice(db, "990001", { now: NOW }).sourceId, "990003");
  assert.equal(currentShopPrice(db, "989999", { now: NOW }).sourceId, "990003");
  // Unknown, per-kilogram or not Open Prices: null.
  assert.equal(currentShopPrice(db, "123", { now: NOW }), null);
  assert.equal(currentShopPrice(db, "990006", { now: NOW }), null);
  assert.equal(currentShopPrice(db, "abc", { now: NOW }), null);
  assert.equal(currentShopPrice(memoryDb(), "990001", { now: NOW }), null);
});

test("the same shop is the same OpenStreetMap id, or the same retailer and place", () => {
  const db = memoryDb(evidenceTables, auditSchema);
  const add = db.prepare(
    "INSERT INTO observations(id, title, store, place, osm_id, price, day, barcode) VALUES(?, 'Manuka honey', ?, ?, ?, ?, ?, ?)",
  );
  add.run(1, "Sainsbury's", "", "node/42", 1500, daysBefore(2), HONEY);
  add.run(2, "Sainsbury's Local", "Camden", "node/42", 1700, daysBefore(1), HONEY);
  add.run(3, "Sainsbury's", "", "node/43", 2500, NOW.slice(0, 10), HONEY);
  assert.equal(currentShopPrice(db, "1", { now: NOW }).sourceId, "2");
  // A store name alone, with no place or map id, never identifies the shop.
  add.run(4, "Lidl", null, null, 900, daysBefore(2), HONEY);
  add.run(5, "Lidl", null, null, 1400, daysBefore(1), HONEY);
  assert.equal(currentShopPrice(db, "4", { now: NOW }).newer, false);
});

test("an estimate costs at the newer same-shop price and says which price it used (R3M3)", () => {
  const db = honeyShop();
  const honeySale = (id) =>
    saleRow(id, { barcode: HONEY, title: "Manuka honey MGO 263+ 250g", size: "250g", model: null, price: 3000 });
  SALES.forEach((id) => insert(db, honeySale(id)));
  const req = request({
    offer: { provider: "openprices", sourceId: "990001" },
    category: "food",
    packagingChecked: true,
    bestBefore: "2027-06-01",
    offerAttributes: { pack: "1", model: "none" },
    locality: null,
  });
  const r = estimateFromEvidence(db, req);
  assert.equal(r.offer.sourceId, "990003");
  assert.deepEqual(r.offer.chosenOffer, { sourceId: "990001", price: 1500, observed: "2026-10-30" });
  assert.equal(r.unitCost, 1900);
  assert.equal(r.economics.unitCost, 1900);
  assert.deepEqual(r.shopPrice, {
    chosen: { sourceId: "990001", price: 1500, observed: "2026-10-30" },
    used: { sourceId: "990003", price: 1900, observed: "2026-10-31" },
    change: "rose",
  });
  assert.ok(
    r.warnings.includes("A newer price at this shop is £19.00 (31 Oct 2026). Figures use £19.00, not the £15.00 you chose (30 Oct 2026)"),
    r.warnings.join("\n"),
  );
  // £30 lower median at £15 clears the thresholds; at £19 it does not.
  db.prepare("DELETE FROM observations WHERE id = 990003").run();
  const old = estimateFromEvidence(db, req);
  assert.equal(old.unitCost, 1500);
  assert.equal(old.shopPrice, null);
  assert.ok(old.opportunity.unitProfit > r.opportunity.unitProfit);
  // The prices panel marks the observation the figures use.
  assert.equal(r.prices.observed.points.find((p) => p.chosen).sourceId, "990003");
  // The candidates view uses the same offer.
  const fresh = honeyShop();
  const c = candidatesFor(fresh, { provider: "openprices", sourceId: "990001", now: NOW });
  assert.equal(c.offer.sourceId, "990003");
  assert.equal(c.shopPrice.change, "rose");
  // A newer, lower price is the current price too; the same price only
  // moves the date.
  fresh.prepare("UPDATE observations SET price = 1300 WHERE id = 990003").run();
  assert.equal(currentOffer(fresh, "openprices", "990001", NOW).shopPrice.change, "fell");
  fresh.prepare("UPDATE observations SET price = 1500 WHERE id = 990003").run();
  const same = estimateFromEvidence(fresh, { ...req, sales: [] });
  assert.equal(same.shopPrice.change, "same");
  assert.ok(!same.warnings.some((w) => /newer price/.test(w)));
  assert.ok(same.assumptions.some((a) => /newer Open Prices observation at this shop \(31 Oct 2026\) gives the same £15\.00/.test(a)));
  // A record judged as it stood (an audit item) can pin the chosen price.
  const pinned = estimateFromEvidence(honeyShop(), { ...req, sales: [] }, { pinOffer: true });
  assert.deepEqual([pinned.offer.sourceId, pinned.unitCost, pinned.shopPrice], ["990001", 1500, null]);
  // Other offers are never replaced.
  assert.equal(currentOffer(fixture(), "awin", "offer-1", NOW).shopPrice, null);
});

// ---------------------------------------------------------------------------
// The shelf as the bounty card counts it (R3Q6).

function shelfFixture() {
  const db = fixture();
  bountiesSchema(db);
  db.prepare("INSERT INTO members(id, name) VALUES(1, 'Dana'), (2, 'Erin')").run();
  const bounty = db.prepare(
    `INSERT INTO bounties(title, barcode, retailer, locality, available_units, sales_per_week, sell_window_weeks, expires_at, sample)
 VALUES('Tefal pan', ?, ?, ?, 6, 1.6, 2, '2026-11-07T12:00:00.000Z', ?)`,
  );
  bounty.run("05012345678900", "Argos", "Leeds", 0); // 1
  bounty.run("05012345678900", "Argos", "York", 0); // 2: another branch
  bounty.run("05012345678900", " argos ", "leeds", 1); // 3: a sample
  return db;
}
const minutesBefore = (n) => new Date(Date.parse(NOW) - n * 60000).toISOString();
function bought(db, bountyId, units, minutesAgo, status = "completed") {
  db.prepare(
    "INSERT INTO claims(bounty_id, member_id, units, status, created, expires_at, ended_at) VALUES(?, 1, ?, ?, ?, ?, ?)",
  ).run(bountyId, units, status, minutesBefore(minutesAgo + 30), minutesBefore(minutesAgo - 60), minutesBefore(minutesAgo));
}
function reported(db, unitsSeen, minutesAgo, verified = null) {
  db.prepare(
    "INSERT INTO stock_reports(bounty_id, member_id, units_seen, observed_at, verified) VALUES(1, 2, ?, ?, ?)",
  ).run(unitsSeen, minutesBefore(minutesAgo), verified);
}

test("Research's shelf count subtracts units members bought through bounties since the check (R3Q6)", () => {
  const db = shelfFixture();
  // The check (6 seen) was an hour ago. Bought since: 3 here; not counted:
  // before the check, another branch, a sample, a claim still active.
  bought(db, 1, 3, 30);
  bought(db, 1, 2, 90);
  bought(db, 2, 4, 20);
  bought(db, 3, 5, 20);
  bought(db, 1, 1, 10, "active");
  const r = estimateFromEvidence(db, request());
  assert.deepEqual(
    { ...r.stock.shelf, note: undefined },
    { units: 3, seen: 6, source: "stock check", at: minutesBefore(60), boughtSince: 3, report: null, note: undefined },
  );
  assert.equal(r.stock.shelf.note, "6 units seen in the branch check at 31 Oct 2026, 11:00, less 3 units members have bought through bounties since, leaves about 3");
  assert.equal(r.stock.confirmed, true);
  assert.ok(r.warnings.includes("Members have bought 3 units through bounties since the branch check at 31 Oct 2026, 11:00, so about 3 units of the 6 seen are left"));
  assert.equal(r.access.needs.find((n) => n.id === "limited-stock").detail, "3 on the shelf");
  assert.deepEqual(failing(r), []);

  // More units planned than are left: said plainly, and the main uncertainty.
  const four = estimateFromEvidence(db, request({ units: 3, cashNeededDays: 30 }));
  bought(db, 1, 1, 5);
  const more = estimateFromEvidence(db, request({ units: 3, cashNeededDays: 30 }));
  assert.equal(more.stock.shelf.units, 2);
  assert.ok(more.warnings.some((w) => w.startsWith("Only about 2 units likely left on the shelf, fewer than the 3 units planned")));
  assert.equal(more.mainUncertainty, "Only about 2 units likely left on the shelf for the 3 units planned");
  assert.ok(!four.warnings.some((w) => /^Only about/.test(w)));
  // The gate fails too: a trip for more units than are left is never a go.
  assert.ok(failing(more).includes("shelf-units"));
  assert.equal(more.alert.eligible, false);
  assert.match(more.alert.reasons.join(" "), /Only about 2 likely left on the shelf, fewer than the 3 planned/);
  assert.ok(!failing(four).includes("shelf-units"));
  assert.ok(!failing(estimateFromEvidence(db, request({ units: 2, cashNeededDays: 30 }))).includes("shelf-units"));

  // Every unit seen has been bought: stock is no longer confirmed.
  bought(db, 1, 2, 1);
  const gone = estimateFromEvidence(db, request());
  assert.equal(gone.stock.shelf.units, 0);
  assert.equal(gone.stock.confirmed, false);
  // availability stays what the check found: a bounty reads out_of_stock as
  // a check that found none.
  assert.equal(gone.stock.availability, "in_stock");
  assert.equal(gone.stock.reason, "Members have bought 6 units through bounties since the branch check at 31 Oct 2026, 11:00, which saw 6, so the shelf may be empty: record a new check");
  assert.ok(gone.warnings.includes(gone.stock.reason));
  assert.equal(gone.alert.eligible, false);
  assert.deepEqual(failing(gone), ["local-stock"]);
  assert.ok(gone.opportunity.reasons.includes("Branch stock not confirmed"));
  assert.notEqual(gone.opportunity.tier, "Priority 1");
  assert.match(gone.mainUncertainty, /^The shelf may be empty/);
  // Without the bounty tables nothing changes.
  assert.equal(estimateFromEvidence(fixture(), request()).stock.shelf.boughtSince, 0);
  assert.equal(branchShelf(fixture(), { barcode: BARCODE, retailer: "Argos", locality: "Leeds", check: null, now: NOW }).units, null);
});

test("a newer stock report sets the shelf count, as on the bounty card; inaccurate ones never do (R3Q6)", () => {
  const db = shelfFixture();
  reported(db, 9, 40, "inaccurate");
  assert.equal(estimateFromEvidence(db, request()).stock.shelf.source, "stock check");
  reported(db, 2, 30);
  const r = estimateFromEvidence(db, request());
  assert.deepEqual([r.stock.shelf.units, r.stock.shelf.source, r.stock.shelf.at], [2, "stock report", minutesBefore(30)]);
  assert.deepEqual(r.stock.shelf.report, { at: minutesBefore(30), unitsSeen: 2, verified: null });
  assert.ok(r.warnings.includes("A member reported 2 on the shelf at 31 Oct 2026, 11:30, after the latest branch check (not verified yet): the shelf count uses it, as the bounty does"));
  assert.equal(r.stock.confirmed, true);
  // Bought after the report counts against the report.
  bought(db, 1, 1, 20);
  assert.equal(estimateFromEvidence(db, request()).stock.shelf.units, 1);
  // A newer report of none stops the stock confirmation.
  reported(db, 0, 10);
  const none = estimateFromEvidence(db, request());
  assert.equal(none.stock.confirmed, false);
  assert.equal(none.stock.reason, "A member reported none on the shelf at 31 Oct 2026, 11:50, after the latest branch check (not verified yet): record a new check");
  assert.equal(none.alert.eligible, false);
  // A newer branch check wins again.
  recordCheck(db, { barcode: BARCODE, retailer: "Argos", locality: "Leeds", method: "phone", inStock: true, unitsSeen: 5, checkedAt: minutesBefore(5) }, { now: NOW });
  const again = estimateFromEvidence(db, request());
  assert.deepEqual([again.stock.confirmed, again.stock.shelf.units, again.stock.shelf.source], [true, 5, "stock check"]);
  assert.deepEqual(again.stock.shelf.report, { at: minutesBefore(10), unitsSeen: 0, verified: null });
  assert.equal(ukTime("2026-10-31T21:22:00Z"), "31 Oct 2026, 21:22");
  assert.equal(ukTime("2026-07-01T20:22:00Z"), "1 Jul 2026, 21:22");
});
