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
import { upsertObservations, upsertResearch } from "./evidence.mjs";
import { awin, openPrices, sold } from "./sources.mjs";
import {
  UNSTATED_DISCOUNT,
  applyOfferAttributes,
  candidatesFor,
  displayPermission,
  estimateFromEvidence,
  findOffer,
  listOffers,
  observationPromotion,
  resaleWeeksOfSupply,
  salesPerWeek,
  suggestCategory,
  thresholdsFor,
  validateEstimateRequest,
} from "./estimate.mjs";
import { CATEGORY_RULES, OPPORTUNITY_RULES } from "./opportunity.mjs";
import * as researchRoutes from "./routes-research.mjs";

// Evidence tables straight from the contract, so these tests do not depend
// on the evidence module.
const evidenceTables = (db) => {
  db.exec(RESEARCH_TABLE);
  db.exec(OBSERVATIONS_TABLE);
  db.exec(PERMISSIONS_TABLE);
};

const DAY = 86400000;
const NOW = "2026-10-31T12:00:00.000Z";
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

/** Builds a database where every alert check can pass. */
function fixture({ now = NOW, sales = ["s1", "s2", "s3"], permission = true, check = true } = {}) {
  const db = memoryDb(evidenceTables, auditSchema);
  insert(db, offerRow({ observed: daysBefore(1, now) }));
  sales.forEach((id, i) => insert(db, saleRow(id, { price: 2800 + i * 200 }, now)));
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
      },
      { now },
    );
  return db;
}

const request = (extra = {}) => ({
  offer: { provider: "awin", sourceId: "offer-1" },
  sales: ["s1", "s2", "s3"].map((id) => ({ provider: "manual", sourceId: id })),
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
  assert.equal(r.sample.count, 3);
  assert.equal(r.sample.independent, 3);
  assert.equal(r.sample.lowerMedian, 3000);
  assert.equal(r.sample.daysToSell, 4);
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
  insert(db, saleRow("ask-low", { kind: KIND.ASKING, price: 900, seller: "x" }));
  insert(db, saleRow("ask-high", { kind: KIND.ASKING, price: 9000, seller: "y" }));
  const sales = [...request().sales, { provider: "manual", sourceId: "ask-low" }, { provider: "manual", sourceId: "ask-high" }];
  const after = estimateFromEvidence(db, request({ sales }));
  assert.equal(after.sample.lowerMedian, before.sample.lowerMedian);
  assert.equal(after.sample.count, 3);
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
  assert.equal(r.sample.count, 3);
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
  const db = fixture();
  db.prepare("UPDATE research SET observed = ? WHERE source_id = 'offer-1'").run(daysBefore(8));
  const r = estimateFromEvidence(db, request());
  assert.equal(r.offer.expired, true);
  // An evidence gap sends the opportunity to Review, which also fails the
  // buying thresholds.
  assert.deepEqual(failing(r), ["offer-fresh", "buying-thresholds"]);
  assert.equal(r.opportunity.tier, "Review");
  assert.equal(r.alert.eligible, false);
});

test("branch stock needs a recent positive check, not the request flag", () => {
  const db = fixture({ check: false });
  const r = estimateFromEvidence(db, request({ localStockConfirmed: true }));
  assert.equal(r.stock.confirmed, false);
  // Unconfirmed stock caps the tier at Priority 2 but blocks the alert.
  assert.deepEqual(failing(r), ["local-stock", "availability"]);
  assert.equal(r.opportunity.tier, "Priority 2");
  assert.ok(r.opportunity.reasons.includes("Branch stock not confirmed"));

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
    { barcode: "0" + BARCODE, retailer: "argos", locality: "leeds", method: "retailer_branch_page", inStock: true, checkedAt: daysBefore(0) + "T09:00:00Z" },
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
  db.prepare("UPDATE research SET seller = 'seller-s1' WHERE source_id = 's2'").run();
  const r = estimateFromEvidence(db, request());
  assert.equal(r.sample.count, 3);
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
  const lateDate = estimateFromEvidence(db, request({ cashNeededDays: undefined, cashNeededBy: "2026-11-02" }));
  assert.equal(lateDate.cashNeededDays, 1);
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
  insert(db, saleRow("ask", { kind: KIND.ASKING, price: 2000 }));
  const c = candidatesFor(db, { provider: "awin", sourceId: "offer-1", now: NOW });
  assert.equal(c.sales.length, 4);
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
    assert.equal(candidates.body.sales.length, 3);
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

    // A client-supplied clock cannot make an expired offer fresh.
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
  // 3 confirmed sales over 90 days is 3 / (90 / 7) a week.
  assert.equal(o.salesPerWeek, 0.23);
  // No listings recorded: competition is unknown, not low.
  assert.equal(o.resaleWeeksOfSupply, null);
  assert.ok(o.reasons.includes("Resale competition high or unknown"));
  assert.ok(o.reasons.includes("Sourcing pressure high or unknown"));
  assert.ok(o.reasons.includes("Fewer than 6 independent recent sales"));
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
  assert.equal(resaleWeeksOfSupply(0, 2), null);

  const db = fixture();
  insert(db, saleRow("ask-1", { kind: KIND.ASKING, provider: "ebay", price: 2500 }));
  insert(db, saleRow("ask-2", { kind: KIND.ASKING, provider: "ebay", price: 2600 }));
  const r = estimateFromEvidence(db, request());
  assert.equal(r.competition.activeListings, 2);
  // 2 listings / (3 sales / (90 / 7) weeks) = 8.57 weeks of supply.
  assert.equal(r.opportunity.resaleWeeksOfSupply, 8.57);
  // Without confirmed sales there is no rate, so it is unknown.
  const none = estimateFromEvidence(db, request({ sales: [] }));
  assert.equal(none.opportunity.salesPerWeek, null);
  assert.equal(none.opportunity.resaleWeeksOfSupply, null);
});

test("a research estimate reaches Priority 2 at best because sourcing pressure is unknown", () => {
  const ids = Array.from({ length: 12 }, (_, i) => "p" + i);
  const db = fixture({ sales: ids });
  insert(db, saleRow("ask-1", { kind: KIND.ASKING, provider: "ebay", price: 3500 }));
  const r = estimateFromEvidence(
    db,
    request({ sales: ids.map((id) => ({ provider: "manual", sourceId: id })) }),
  );
  assert.equal(r.sample.independent, 12);
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
  db.prepare("UPDATE research SET price = 450 WHERE source_id = 'offer-1'").run();
  const cheap = estimateFromEvidence(db, request());
  assert.equal(tierOf(cheap), "Reject");
  assert.match(cheap.opportunity.reasons[0], /Purchase price outside £5 to £50/);
  assert.ok(!checkOk(cheap, "buying-thresholds"));
  db.prepare("UPDATE research SET price = 5100 WHERE source_id = 'offer-1'").run();
  assert.equal(tierOf(estimateFromEvidence(db, request())), "Reject");
});

test("short profit or return gives Watch with the target purchase price", () => {
  const db = fixture();
  db.prepare("UPDATE research SET price = 1500 WHERE source_id = 'offer-1'").run();
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
  const four = estimateFromEvidence(db, request({ units: 4 }));
  assert.deepEqual(failing(four), ["trial-batch"]);
  assert.ok(four.warnings.some((w) => /trial batch of at most 3 units/.test(w)));
  const smaller = estimateFromEvidence(db, request({ units: 2, rules: { trialUnits: 1 } }));
  assert.equal(smaller.opportunity.trialUnits, 1);
  assert.deepEqual(failing(smaller), ["trial-batch"]);
  assert.equal(estimateFromEvidence(db, request({ units: 3 })).alert.eligible, true);
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
  assert.deepEqual(failing(blank), ["positive-contribution", "hourly-floor", "journey", "buying-thresholds"]);
  assert.equal(blank.alert.eligible, false);
  assert.equal(tierOf(blank), "Review");
  assert.match(blank.opportunity.reasons[0], /Journey cost or time not entered/);
  assert.equal(blank.opportunity.meetsThresholds, false);
  assert.ok(blank.warnings.some((w) => /No return journey cost entered/.test(w)));
  assert.ok(blank.warnings.some((w) => /No journey time entered/.test(w)));

  // Only the time missing: the cost is known, so the contribution counts, but
  // earnings per hour do not.
  const { journeyMinutes: _x, ...noMinutes } = request().costs;
  const timeless = estimateFromEvidence(db, request({ costs: noMinutes }));
  assert.deepEqual(failing(timeless), ["hourly-floor", "journey", "buying-thresholds"]);
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
  // Sold sample: 4 days to sell. Saturday 31 October: listed today, sold
  // Wednesday 4 November, posted the same day, delivered 6th, paid out 8th.
  const r = estimateFromEvidence(db, request({ cashNeededDays: undefined, cashNeededBy: "2026-11-05" }));
  assert.equal(r.sample.daysToSell, 4);
  assert.equal(r.cashNeededDays, 4);
  assert.equal(r.payout.start, "2026-10-31");
  assert.equal(r.payout.sold, "2026-11-04");
  assert.equal(r.payout.date, "2026-11-08");
  assert.equal(r.payout.days, 7);
  assert.equal(r.payout.timing.status, "late");
  assert.equal(r.payout.timing.daysLate, 3);
  assert.match(r.payout.note, /payout on 2026-11-08/);
  assert.equal(r.payout.goals.saved, false);
  const check = r.alert.checks.find((c) => c.id === "days-to-sell");
  assert.equal(check.ok, false);
  assert.match(check.detail, /Expected payout in 7 days, after the date the cash is needed/);
  assert.equal(r.alert.eligible, false);

  // A number of days (API callers) is compared the same way.
  const days = estimateFromEvidence(db, request({ cashNeededDays: 2 }));
  assert.equal(days.payout.timing.status, "late");
  assert.equal(days.payout.timing.daysLate, 5);
  assert.equal(checkOk(days, "days-to-sell"), false);

  // A payout on the day the cash is needed is in time.
  const onTime = estimateFromEvidence(db, request({ cashNeededDays: undefined, cashNeededBy: "2026-11-08" }));
  assert.equal(onTime.payout.timing.status, "on time");
  assert.equal(checkOk(onTime, "days-to-sell"), true);
  assert.equal(onTime.alert.eligible, true);

  // No cash date: only a known time to sell is needed, and the payout date is
  // still shown.
  const free = estimateFromEvidence(db, request({ cashNeededDays: undefined }));
  assert.equal(free.payout.date, "2026-11-08");
  assert.equal(free.payout.timing.status, "unknown");
  assert.equal(checkOk(free, "days-to-sell"), true);
});

test("saved goals move the payout; no dispatch days leave it unknown and fail the cash date", () => {
  const db = memoryDb(evidenceTables, auditSchema, goalsSchema);
  insert(db, offerRow());
  ["s1", "s2", "s3"].forEach((id, i) => insert(db, saleRow(id, { price: 2800 + i * 200 })));
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
  const saturday = estimateFromEvidence(db, request({ cashNeededDays: undefined, cashNeededBy: "2026-11-10" }));
  assert.equal(saturday.payout.goals.saved, true);
  assert.deepEqual(saturday.payout.goals.dispatchDays, [6]);
  assert.equal(saturday.payout.dispatch, "2026-11-07");
  assert.equal(saturday.payout.date, "2026-11-11");
  assert.equal(checkOk(saturday, "days-to-sell"), false);
  assert.equal(checkOk(estimateFromEvidence(db, request({ cashNeededDays: 14 })), "days-to-sell"), true);

  saveGoals(db, { ...goals, dispatchDays: [] }, { now: NOW });
  const none = estimateFromEvidence(db, request({ cashNeededDays: 14 }));
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
  db.prepare("UPDATE research SET promotion = 'Clubcard price', price = 1000 WHERE source_id = 'offer-1'").run();
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
  // With no check at all the stock is unknown, which still allows Priority 2.
  const unknown = estimateFromEvidence(fixture({ check: false }), request());
  assert.equal(unknown.stock.availability, "unknown");
  assert.equal(tierOf(unknown), "Priority 2");
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

test("the category comes from the request, else from a clear title word", () => {
  assert.equal(suggestCategory({ title: "Cotton crew-neck jumper, navy" }).id, "clothing");
  assert.equal(suggestCategory({ title: "Yorkshire heather honey 340g" }).id, "food");
  assert.equal(suggestCategory({ title: "Tefal Ingenio frying pan 28cm" }).id, "general");
  assert.equal(suggestCategory({ title: "Laptop stand" }).id, "general");

  const db = fixture();
  const general = estimateFromEvidence(db, request());
  assert.equal(general.category.id, "general");
  assert.equal(general.category.chosen, "suggested");
  assert.deepEqual(general.category.failures, []);
  assert.equal(general.offer.suggestedCategory.id, "general");

  db.prepare("UPDATE research SET title = 'Navy wool jumper' WHERE source_id = 'offer-1'").run();
  const suggested = estimateFromEvidence(db, request());
  assert.equal(suggested.category.id, "clothing");
  assert.equal(suggested.category.chosen, "suggested");
  const overridden = estimateFromEvidence(db, request({ category: "general" }));
  assert.equal(overridden.category.id, "general");
  assert.equal(overridden.category.chosen, "request");

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

/** The Awin fixture feed and manual sales through the real adapters. */
function importedFixture() {
  const db = memoryDb(evidenceTables, auditSchema);
  upsertResearch(db, "awin", awin(readFileSync(new URL("awin-sample.csv", FIXTURES), "utf8")), { now: NOW });
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
  db.prepare("INSERT INTO permissions(provider, programme, display) VALUES('awin', 'Example Outfitters', 1)").run();
  recordCheck(
    db,
    { barcode: "5012345678900", retailer: "Example Outfitters", locality: "Leeds", method: "in_store", inStock: true, checkedAt: daysBefore(0) + "T09:00:00Z" },
    { now: NOW },
  );
  return db;
}
const importedRequest = (extra = {}) =>
  request({
    offer: { provider: "awin", sourceId: "1001" },
    sales: ["ebay-1", "ebay-2", "ebay-3"].map((sourceId) => ({ provider: "manual", sourceId })),
    weightKg: 0.4,
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
  assert.deepEqual(failing(after), []);
  assert.equal(after.alert.eligible, true);

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
  assert.equal(r.sample.count, 4);
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
    request({ offer: { provider: "openprices", sourceId: "77" }, offerAttributes: { pack: "1", model: "L15006" } }),
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
