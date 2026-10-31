import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { memoryDb, serve } from "./test-support.mjs";
import { HttpError } from "./http.mjs";
import { KIND, LICENCE } from "./contract.mjs";
import { schema as evidenceSchema, setPermission, upsertResearch } from "./evidence.mjs";
import {
  AUDIT_FAILURES,
  auditOutcome,
  latestCheck,
  listItems,
  progress,
  recordCheck,
  recordItem,
  schema,
  stockStatus,
} from "./audit.mjs";
import * as researchRoutes from "./routes-research.mjs";

const NOW = "2026-10-31T12:00:00.000Z";
const BARCODE = "5012345678900";
const GTIN = "05012345678900";
const hoursBefore = (h) => new Date(Date.parse(NOW) - h * 3600000).toISOString();

const status = (fn) => {
  try {
    fn();
    return 200;
  } catch (error) {
    assert.ok(error instanceof HttpError, String(error));
    return error.status;
  }
};

const check = (db, extra = {}) =>
  recordCheck(
    db,
    {
      barcode: BARCODE,
      retailer: "Argos",
      locality: LOCALITY,
      method: "in_store",
      inStock: true,
      unitsSeen: 4,
      checkedAt: hoursBefore(2),
      ...extra,
    },
    { now: NOW },
  );

// Stored evidence for one audited item in the pilot locality: an Awin offer
// at Argos, three confirmed exact sales from three named sellers and a
// display permission for the programme.
const LOCALITY = "Camden";
const daysBefore = (d) => new Date(Date.parse(NOW) - d * 86400000).toISOString().slice(0, 10);
const OFFER = {
  source_id: "offer-1",
  kind: KIND.RETAIL,
  title: "Tefal Ingenio pan 28cm",
  barcode: BARCODE,
  size: "28cm",
  pack: "1",
  model: "L15006",
  condition: "new",
  price: 1500,
  observed: hoursBefore(20),
  retailer: "Argos",
  licence: LICENCE.FEED,
};
const saleRow = (id, extra = {}) => ({
  source_id: id,
  kind: KIND.SOLD,
  title: "Tefal Ingenio pan 28 cm",
  barcode: BARCODE,
  size: "28 cm",
  pack: "single",
  model: "L15-006",
  condition: "New",
  price: 4000,
  observed: daysBefore(10),
  listed: daysBefore(15),
  seller: "seller-" + id,
  licence: LICENCE.SELF,
  ...extra,
});
const SALES = ["s1", "s2", "s3"].map((sourceId) => ({ provider: "sales", sourceId }));
const TRIP = { costs: { journeyCost: 200, journeyMinutes: 40, handlingMinutes: 10 } };

function evidenceDb({ sales = [saleRow("s1"), saleRow("s2"), saleRow("s3")], permit = true, offer = {} } = {}) {
  const db = memoryDb(evidenceSchema, schema);
  upsertResearch(db, "awin", [{ ...OFFER, ...offer }], { now: NOW });
  upsertResearch(db, "sales", sales, { now: NOW });
  if (permit) setPermission(db, { provider: "awin", programme: "Argos", display: true }, { now: NOW });
  return db;
}

const item = (db, extra = {}) =>
  recordItem(
    db,
    {
      locality: LOCALITY,
      barcode: BARCODE,
      title: "Tefal Ingenio pan 28cm",
      retailer: "Argos",
      offerProvider: "awin",
      offerSourceId: "offer-1",
      sales: SALES,
      weightKg: 0.9,
      promotionEligible: true,
      shipping: 300,
      // The trip inputs the operator used in Research, so the audited tier is
      // the one they saw.
      estimateInputs: TRIP,
      ...extra,
    },
    { now: NOW },
  );

const reasonsOf = (saved) => saved.outcome.reasons.join("; ");

test("schema is idempotent and migrates an older database in place", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE availability_checks (id INTEGER PRIMARY KEY, barcode TEXT NOT NULL,
 retailer TEXT NOT NULL, locality TEXT NOT NULL, checked_at TEXT NOT NULL, method TEXT NOT NULL,
 in_stock INTEGER NOT NULL)`);
  db.exec("INSERT INTO availability_checks(barcode, retailer, locality, checked_at, method, in_stock) VALUES('05012345678900', 'Argos', 'Leeds', '2026-10-31T10:00:00.000Z', 'phone', 1)");
  schema(db);
  schema(db);
  const columns = db.prepare("PRAGMA table_info(availability_checks)").all().map((c) => c.name);
  for (const c of ["units_seen", "note", "created"]) assert.ok(columns.includes(c), c);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM availability_checks").get().n, 1);
  const items = db.prepare("PRAGMA table_info(validation_items)").all().map((c) => c.name);
  for (const c of ["availability_check_id", "promotion_eligible", "match_decision", "updated"])
    assert.ok(items.includes(c), c);
});

test("checks are validated and stored with a canonical barcode", () => {
  const db = memoryDb(schema);
  const row = check(db, { barcode: "0" + BARCODE });
  assert.equal(row.barcode, GTIN);
  assert.equal(row.in_stock, 1);
  assert.equal(row.checked_at, hoursBefore(2));
  for (const extra of [
    { barcode: "5012345678901" },
    { barcode: "" },
    { method: "website" },
    { inStock: "yes" },
    { retailer: "" },
    { locality: undefined },
    { checkedAt: "2026-11-02T00:00:00Z" },
    { checkedAt: "last week" },
    { inStock: false, unitsSeen: 3 },
    { inStock: true, unitsSeen: 0 },
    { unitsSeen: -1 },
  ])
    assert.equal(status(() => check(db, extra)), 400, JSON.stringify(extra));
});

test("the latest check in the locality decides stock and old checks expire", () => {
  const db = memoryDb(schema);
  const at = { barcode: BARCODE, retailer: "Argos", locality: LOCALITY, now: NOW };
  assert.equal(stockStatus(db, at).confirmed, false);
  check(db, { checkedAt: hoursBefore(60) });
  assert.equal(stockStatus(db, at).confirmed, false);
  const recent = check(db, { checkedAt: hoursBefore(5) });
  const status1 = stockStatus(db, { ...at, retailer: "ARGOS", locality: " camden " });
  assert.equal(status1.confirmed, true);
  assert.equal(status1.availability, "in_stock");
  assert.equal(status1.check.id, recent.id);
  assert.equal(status1.reason, null);
  assert.equal(status1.locality, "camden");
  assert.equal(stockStatus(db, { ...at, retailer: "Tesco" }).check, null);
  const elsewhere = stockStatus(db, { ...at, locality: "Hackney" });
  assert.equal(elsewhere.check, null);
  assert.match(elsewhere.reason, /No availability check in Hackney/);
  check(db, { checkedAt: hoursBefore(1), inStock: false, unitsSeen: 0 });
  const status2 = stockStatus(db, at);
  assert.equal(status2.confirmed, false);
  assert.equal(status2.availability, "out_of_stock");
  assert.match(status2.reason, /latest check in Camden found none/);
  // latestCheck honours its window and never reads a check after `until`.
  assert.equal(latestCheck(db, BARCODE, "Argos", hoursBefore(3), { until: hoursBefore(2) }), null);
  assert.equal(latestCheck(db, "bad", "Argos", hoursBefore(100)), null);
  assert.equal(latestCheck(db, BARCODE, "Argos", hoursBefore(100), { locality: { toString: 1 } }), null);
  assert.equal(latestCheck(db, BARCODE, { toString: 1 }, hoursBefore(100)), null);
  // Without the audit tables there is no check, so stock is not confirmed.
  assert.equal(latestCheck(new DatabaseSync(":memory:"), BARCODE, "Argos", hoursBefore(10)), null);
});

test("without a locality no check from any town confirms stock", () => {
  const db = memoryDb(schema);
  // The only check is an in-store check in Leeds today.
  check(db, { locality: "Leeds", checkedAt: hoursBefore(1) });
  for (const locality of [undefined, null, "", "   ", 12, { toString: 1 }]) {
    const s = stockStatus(db, { barcode: BARCODE, retailer: "Argos", locality, now: NOW });
    assert.deepEqual(
      [s.confirmed, s.availability, s.check],
      [false, "unknown", null],
      JSON.stringify(locality) ?? String(locality),
    );
    assert.match(s.reason, /No locality given/);
  }
  assert.equal(stockStatus(db, { barcode: BARCODE, retailer: "Argos", locality: "Leeds", now: NOW }).confirmed, true);
  // Missing retailer, barcode or time never throws and never confirms.
  for (const bad of [{ retailer: null }, { retailer: { toString: 1 } }, { barcode: { toString: 1 } }, { now: "not a time" }]) {
    const s = stockStatus(db, { barcode: BARCODE, retailer: "Argos", locality: "Leeds", now: NOW, ...bad });
    assert.equal(s.confirmed, false, JSON.stringify(bad));
    assert.ok(s.reason);
  }
});

test("an audit item passes only on stored evidence", () => {
  const db = evidenceDb();
  const c = check(db);
  const passed = item(db, { availabilityCheckId: c.id });
  assert.equal(passed.outcome.passed, true, reasonsOf(passed));
  assert.deepEqual(passed.outcome.reasons, []);
  assert.deepEqual(passed.outcome.contradictions, []);
  // The figures come from the database and the estimate, not from typing.
  assert.equal(passed.evidence.match, "exact");
  assert.equal(passed.evidence.sales.used, 3);
  assert.equal(passed.evidence.sales.independent, 3);
  assert.equal(passed.evidence.sales.daysToSell, 5);
  assert.equal(passed.evidence.permission.permitted, true);
  assert.equal(passed.evidence.tier, "Priority 2");
  assert.equal(passed.evidence.offer.retailer, "Argos");
  assert.deepEqual(passed.sales, SALES, "the confirmed sales are stored with the item");
  assert.deepEqual(passed.outcome.checks.map((x) => x.id), [
    "barcode", "offer", "live-evidence", "offer-fresh", "availability", "promotion", "shipping",
    "days-to-sell", "independent-sales", "display-permitted", "match", "estimate-tier",
  ]);
  // Typed readings that agree with the evidence still pass.
  const agreed = item(db, { availabilityCheckId: c.id, daysToSell: 5, independentSales: 3, displayPermitted: true, matchDecision: "exact" });
  assert.equal(agreed.outcome.passed, true, reasonsOf(agreed));

  const empty = auditOutcome({});
  assert.equal(empty.passed, false);
  assert.ok(empty.checks.every((x) => !x.ok));
  // Without evidence attached, the evidence checks fail closed.
  const unread = auditOutcome({ ...passed, evidence: undefined });
  assert.equal(unread.passed, false);
  assert.ok(unread.reasons.includes(AUDIT_FAILURES.offerMissing));

  const base = { ...passed };
  for (const [field, value, reason] of [
    ["barcode", "123", AUDIT_FAILURES.barcode],
    ["offer_source_id", null, AUDIT_FAILURES.offer],
    ["check", null, AUDIT_FAILURES.noCheck],
    ["check", { ...c, in_stock: 0 }, AUDIT_FAILURES.noStock],
    ["check", { ...c, retailer: "Tesco" }, AUDIT_FAILURES.checkMismatch],
    ["check", { ...c, checked_at: "2026-10-27T12:00:00.000Z" }, AUDIT_FAILURES.staleCheck],
    ["check", { ...c, method: "feed" }, AUDIT_FAILURES.checkMethod],
    ["promotion_eligible", null, AUDIT_FAILURES.promotion],
    ["promotion_eligible", 0, AUDIT_FAILURES.promotion],
    ["shipping", null, AUDIT_FAILURES.shipping],
    ["shipping", 0, AUDIT_FAILURES.shipping],
    ["days_to_sell", 3, AUDIT_FAILURES.daysToSellContradiction],
    ["independent_sales", 5, AUDIT_FAILURES.independentContradiction],
    ["display_permitted", 0, AUDIT_FAILURES.displayContradiction],
    ["match_decision", "research", AUDIT_FAILURES.matchContradiction],
  ]) {
    const outcome = auditOutcome({ ...base, [field]: value });
    assert.equal(outcome.passed, false, field + "=" + JSON.stringify(value));
    assert.ok(outcome.reasons.includes(reason), field + ": " + outcome.reasons.join("; "));
  }
  for (const [path, value, reason] of [
    [["evidence", "live"], false, AUDIT_FAILURES.sample],
    [["evidence", "offerFresh"], false, AUDIT_FAILURES.offerStale],
    [["evidence", "match"], "research", AUDIT_FAILURES.matchUncertain],
    [["evidence", "tier"], "Review", AUDIT_FAILURES.tier],
    [["evidence", "tier"], "Watch", AUDIT_FAILURES.tier],
  ]) {
    const outcome = auditOutcome({ ...base, evidence: { ...base.evidence, [path[1]]: value } });
    assert.equal(outcome.passed, false, path.join(".") + "=" + value);
    assert.ok(outcome.reasons.includes(reason), path.join(".") + ": " + outcome.reasons.join("; "));
  }
  const fewer = auditOutcome({ ...base, evidence: { ...base.evidence, sales: { ...base.evidence.sales, independent: 2 } } });
  assert.ok(fewer.reasons.includes(AUDIT_FAILURES.independent));
  const later = auditOutcome({ ...base, evidence: { ...base.evidence, stock: { confirmed: false, availability: "out_of_stock", checkId: 99, reason: "x" } } });
  assert.ok(later.reasons.includes(AUDIT_FAILURES.laterNoStock));
});

test("typed figures that contradict the stored evidence fail and show both", () => {
  // The scenario from the review: an Awin offer, no completed sales and no
  // display permission, but the operator types an exact match, five sales,
  // three days to sell and display permitted.
  const db = evidenceDb({ sales: [], permit: false });
  const c = check(db);
  const saved = item(db, {
    availabilityCheckId: c.id,
    sales: [],
    matchDecision: "exact",
    independentSales: 5,
    daysToSell: 3,
    displayPermitted: true,
  });
  assert.equal(saved.outcome.passed, false);
  assert.equal(saved.evidence.match, "none");
  assert.equal(saved.evidence.sales.independent, 0);
  assert.equal(saved.evidence.sales.daysToSell, null);
  assert.equal(saved.evidence.permission.permitted, false);
  for (const reason of [
    AUDIT_FAILURES.matchUncertain,
    AUDIT_FAILURES.matchContradiction,
    AUDIT_FAILURES.independent,
    AUDIT_FAILURES.independentContradiction,
    AUDIT_FAILURES.daysToSell,
    AUDIT_FAILURES.daysToSellContradiction,
    AUDIT_FAILURES.display,
    AUDIT_FAILURES.displayContradiction,
    AUDIT_FAILURES.tier,
  ])
    assert.ok(saved.outcome.reasons.includes(reason), reason + " in " + reasonsOf(saved));
  assert.deepEqual(
    saved.outcome.contradictions.map((x) => [x.id, x.recorded, x.evidence]),
    [
      ["days-to-sell", 3, null],
      ["independent-sales", 5, 0],
      ["display-permitted", true, false],
      ["match", "exact", "none"],
    ],
  );
  const match = saved.outcome.checks.find((x) => x.id === "match");
  assert.deepEqual([match.recorded, match.evidence, match.contradiction], ["exact", "none", true]);
  assert.equal(progress(db, LOCALITY).passed, 0);
});

test("sales count only when confirmed, exact and from named sellers", () => {
  // Three exact sales by one seller, recorded by listing id only.
  const db = evidenceDb({
    sales: [
      saleRow("s1", { seller: "listing:110011" }),
      saleRow("s2", { seller: "listing:110012" }),
      saleRow("s3", { seller: "listing:110013" }),
    ],
  });
  const c = check(db);
  const saved = item(db, { availabilityCheckId: c.id });
  assert.equal(saved.evidence.sales.used, 3);
  assert.equal(saved.evidence.sales.independent, 0);
  assert.equal(saved.evidence.sales.withoutSeller, 3);
  assert.equal(saved.outcome.passed, false);
  assert.ok(saved.outcome.reasons.includes(AUDIT_FAILURES.independent));
  // A confirmed sale the estimate cannot use is listed with its reason.
  upsertResearch(db, "sales", [saleRow("s4", { size: "24cm", seller: "other" })], { now: NOW });
  const more = item(db, { availabilityCheckId: c.id, sales: [...SALES, { provider: "sales", sourceId: "s4" }, { provider: "sales", sourceId: "nope" }] });
  assert.deepEqual(
    more.evidence.sales.notUsed.map((x) => x.sale),
    ["sales|s4", "sales|nope"],
  );
  assert.match(more.evidence.sales.notUsed[0].reason, /Not an exact match: Size differs/);
  assert.equal(more.evidence.sales.notUsed[1].reason, "Not a completed sale with this barcode in the database");
  // Unconfirmed sales never count, however good they are.
  const unconfirmed = item(db, { availabilityCheckId: c.id, sales: [] });
  assert.equal(unconfirmed.evidence.sales.used, 0);
  assert.equal(unconfirmed.evidence.match, "research");
  assert.equal(unconfirmed.outcome.passed, false);
});

test("sample data, a stale offer or a later empty shelf never pass", () => {
  const sample = evidenceDb({ offer: { source_id: "sample-1" } });
  const c1 = check(sample);
  const s = item(sample, { offerSourceId: "sample-1", availabilityCheckId: c1.id });
  assert.equal(s.evidence.live, false);
  assert.ok(s.outcome.reasons.includes(AUDIT_FAILURES.sample), reasonsOf(s));

  const stale = evidenceDb({ offer: { observed: daysBefore(9) } });
  const c2 = check(stale);
  const old = item(stale, { availabilityCheckId: c2.id });
  assert.equal(old.evidence.offerFresh, false);
  assert.ok(old.outcome.reasons.includes(AUDIT_FAILURES.offerStale), reasonsOf(old));

  const shelf = evidenceDb();
  const c3 = check(shelf, { checkedAt: hoursBefore(3) });
  check(shelf, { checkedAt: hoursBefore(1), inStock: false, unitsSeen: 0 });
  const empty = item(shelf, { availabilityCheckId: c3.id });
  assert.ok(empty.outcome.reasons.includes(AUDIT_FAILURES.laterNoStock), reasonsOf(empty));

  // No unit weight: the estimate rejects the item, so it cannot pass.
  const db = evidenceDb();
  const c4 = check(db);
  const noWeight = item(db, { availabilityCheckId: c4.id, weightKg: null });
  assert.equal(noWeight.evidence.tier, "Reject");
  assert.ok(noWeight.outcome.reasons.includes(AUDIT_FAILURES.tier));
});

test("the recorded offer must exist and be for the same barcode and retailer", () => {
  const db = evidenceDb();
  const c = check(db);
  assert.equal(status(() => item(db, { offerSourceId: "does-not-exist", availabilityCheckId: c.id })), 404);
  assert.equal(status(() => item(db, { offerProvider: "made-up", offerSourceId: "nothing" })), 404);
  assert.equal(status(() => item(db, { offerProvider: "sales", offerSourceId: "s1" })), 400, "a sale is not an offer");
  assert.equal(status(() => item(db, { retailer: "Tesco" })), 400);
  upsertResearch(db, "awin", [{ ...OFFER, source_id: "offer-2", barcode: "4006381333931" }], { now: NOW });
  assert.equal(status(() => item(db, { offerSourceId: "offer-2" })), 400, "different barcode");
  assert.equal(status(() => item(db, { offerProvider: null, offerSourceId: null })), 400, "sales need an offer");
  assert.equal(status(() => item(db, { sales: [{ provider: "sales" }] })), 400);
  assert.equal(status(() => item(db, { sales: "s1" })), 400);
  assert.equal(status(() => item(db, { weightKg: 0 })), 400);
  assert.equal(status(() => item(db, { estimateInputs: { costs: { feeRate: 2 } } })), 400);
  assert.equal(status(() => item(db, { estimateInputs: "x" })), 400);
  assert.equal(status(() => item(db, { barcode: { toString: 1 } })), 400);
  // With no offer at all the item is saved and fails closed.
  const none = item(db, { offerProvider: null, offerSourceId: null, sales: [] });
  assert.equal(none.outcome.passed, false);
  assert.ok(none.outcome.reasons.includes(AUDIT_FAILURES.offer));
  assert.ok(none.outcome.reasons.includes(AUDIT_FAILURES.noEvidence));
  // An offer removed after the audit no longer counts.
  const saved = item(db, { availabilityCheckId: c.id });
  assert.equal(saved.outcome.passed, true, reasonsOf(saved));
  db.prepare("DELETE FROM research WHERE source_id = 'offer-1'").run();
  const [after] = listItems(db, LOCALITY);
  assert.equal(after.outcome.passed, false);
  assert.ok(after.outcome.reasons.includes(AUDIT_FAILURES.offerMissing));
  assert.equal(after.evidence.error, "Offer not found");
  assert.equal(after.evidence.errorKind, "offer");
  // Stored inputs the estimate refuses are reported as such, not as a
  // missing offer.
  const refused = auditOutcome({ ...saved, evidence: { ...saved.evidence, offer: null, error: "units must be a whole number", errorKind: "estimate" } });
  assert.ok(refused.reasons.includes(AUDIT_FAILURES.estimateFailed), refused.reasons.join("; "));
});

test("stored estimate inputs set the audited tier", () => {
  const db = evidenceDb();
  const c = check(db);
  // A high fee rate leaves too little profit: the estimate is not Priority 1 or 2.
  const costly = item(db, { availabilityCheckId: c.id, estimateInputs: { costs: { ...TRIP.costs, feeRate: 0.5, postage: 1 }, units: 1 } });
  assert.notEqual(costly.evidence.tier, "Priority 2");
  assert.ok(costly.outcome.reasons.includes(AUDIT_FAILURES.tier));
  assert.deepEqual(costly.estimate_inputs, { costs: { ...TRIP.costs, feeRate: 0.5 }, units: 1 }, "postage comes from the shipping field only");
  // Without journey cost or time the estimate cannot judge the trip.
  const noTrip = item(db, { availabilityCheckId: c.id, estimateInputs: null });
  assert.equal(noTrip.evidence.tier, "Review");
  assert.ok(noTrip.outcome.reasons.includes(AUDIT_FAILURES.tier));
  // The audit sets the offer, sales, locality and parcel cost itself.
  const kept = item(db, { availabilityCheckId: c.id, estimateInputs: { ...TRIP, offer: { provider: "x", sourceId: "y" }, locality: "Leeds", units: 1 } });
  assert.deepEqual(kept.estimate_inputs, { ...TRIP, units: 1 });
  assert.equal(kept.outcome.passed, true, reasonsOf(kept));
});

test("an operator-confirmed no-model lets a model-less item pass the audit", () => {
  // A feed offer and sales that state no model, as for most food.
  const db = evidenceDb({
    offer: { model: null },
    sales: ["s1", "s2", "s3"].map((id) => saleRow(id, { model: null })),
  });
  const c = check(db);
  const unconfirmed = item(db, { availabilityCheckId: c.id });
  assert.equal(unconfirmed.outcome.passed, false);
  assert.notEqual(unconfirmed.evidence.match, "exact");
  const confirmed = item(db, { availabilityCheckId: c.id, estimateInputs: { ...TRIP, offerAttributes: { model: "none" } } });
  assert.equal(confirmed.evidence.match, "exact");
  assert.equal(confirmed.evidence.sales.used, 3);
  assert.equal(confirmed.outcome.passed, true, reasonsOf(confirmed));
  // A sale that does state a model is not covered by the confirmation.
  upsertResearch(db, "sales", [saleRow("s2", { model: "L15-006" })], { now: NOW });
  const mixed = item(db, { availabilityCheckId: c.id, estimateInputs: { ...TRIP, offerAttributes: { model: "none" } } });
  assert.equal(mixed.evidence.sales.used, 2);
  assert.ok(mixed.evidence.sales.notUsed.some((n) => n.reason.includes("Model differs")), JSON.stringify(mixed.evidence.sales.notUsed));
  assert.equal(mixed.outcome.passed, false);
});

test("items are one per barcode per locality and linked checks must agree", () => {
  const db = evidenceDb();
  const c = check(db);
  const first = item(db, { availabilityCheckId: c.id });
  const again = item(db, { locality: "CAMDEN", barcode: "0" + BARCODE, shipping: 350, availabilityCheckId: c.id });
  assert.equal(again.id, first.id);
  assert.equal(again.shipping, 350);
  assert.equal(listItems(db, LOCALITY).length, 1);

  const hackney = check(db, { locality: "Hackney" });
  assert.equal(status(() => item(db, { availabilityCheckId: hackney.id })), 400);
  assert.equal(status(() => item(db, { availabilityCheckId: c.id, retailer: "Tesco" })), 400);
  assert.equal(status(() => item(db, { availabilityCheckId: 999 })), 404);
  assert.equal(status(() => item(db, { matchDecision: "probably" })), 400);
  assert.equal(status(() => item(db, { offerSourceId: undefined })), 400);
  assert.equal(status(() => item(db, { shipping: -1 })), 400);
  assert.equal(status(() => item(db, { title: "" })), 400);
  assert.equal(status(() => item(db, { barcode: "abc" })), 400);

  // Unknown values are stored as null and fail closed.
  const unknown = item(db, {
    barcode: "4006381333931",
    offerProvider: null,
    offerSourceId: null,
    sales: [],
    promotionEligible: null,
    shipping: null,
    daysToSell: null,
    independentSales: null,
    displayPermitted: null,
    matchDecision: null,
  });
  assert.equal(unknown.outcome.passed, false);
  assert.equal(unknown.promotion_eligible, null);
});

test("progress counts audited, passed and failed items per locality", () => {
  const db = evidenceDb();
  const c = check(db);
  item(db, { availabilityCheckId: c.id });
  item(db, { barcode: "4006381333931", offerProvider: null, offerSourceId: null, sales: [], matchDecision: "research" });
  item(db, { barcode: "5449000000996", offerProvider: null, offerSourceId: null, sales: [], independentSales: 1, shipping: null });
  item(db, { locality: "Hackney", barcode: "96385074", offerProvider: null, offerSourceId: null, sales: [] });
  const p = progress(db, "camden");
  assert.equal(p.target, 30);
  assert.equal(p.audited, 3);
  assert.equal(p.passed, 1);
  assert.equal(p.failed, 2);
  assert.equal(p.remaining, 27);
  assert.equal(p.complete, false);
  assert.equal(p.failures[AUDIT_FAILURES.noCheck], 2);
  assert.equal(p.failures[AUDIT_FAILURES.noEvidence], 2, "counted once per item");
  assert.equal(p.failures[AUDIT_FAILURES.shipping], 1);
  assert.equal(Object.getPrototypeOf(p.failures), Object.prototype);
  assert.equal(progress(db, "Hackney").audited, 1);
  assert.equal(progress(db, "Bristol").remaining, 30);
});

test("audit and check routes validate input and report progress", async () => {
  const db = evidenceDb();
  // The routes judge freshness by the server clock, so date the evidence now.
  const now = new Date();
  const ago = (days) => new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
  upsertResearch(db, "awin", [{ ...OFFER, observed: now.toISOString() }]);
  upsertResearch(db, "sales", ["s1", "s2", "s3"].map((id) => saleRow(id, { observed: ago(10), listed: ago(15) })));
  const api = await serve(db, [researchRoutes]);
  try {
    const created = await api.call("POST", "/api/research/checks", {
      barcode: BARCODE,
      retailer: "Argos",
      locality: LOCALITY,
      method: "phone",
      inStock: true,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.barcode, GTIN);
    const future = await api.call("POST", "/api/research/checks", {
      barcode: BARCODE,
      retailer: "Argos",
      locality: LOCALITY,
      method: "phone",
      inStock: true,
      checkedAt: new Date(Date.now() + 86400000).toISOString(),
    });
    assert.equal(future.status, 400);
    const list = await api.call("GET", "/api/research/checks?barcode=0" + BARCODE);
    assert.equal(list.status, 200);
    assert.equal(list.body.rows.length, 1);
    assert.equal((await api.call("GET", "/api/research/checks?barcode=12")).status, 400);
    for (const barcode of [{ toString: 1 }, ["1"], true])
      assert.equal(
        (await api.call("POST", "/api/research/checks", { barcode, retailer: "Argos", locality: LOCALITY, method: "phone", inStock: true })).status,
        400,
        JSON.stringify(barcode),
      );

    const body = {
      locality: LOCALITY,
      barcode: BARCODE,
      title: "Pan",
      retailer: "Argos",
      offerProvider: "awin",
      offerSourceId: "offer-1",
      sales: SALES,
      weightKg: 0.9,
      estimateInputs: TRIP,
      availabilityCheckId: created.body.id,
      promotionEligible: true,
      shipping: 300,
    };
    const saved = await api.call("POST", "/api/audit", body);
    assert.equal(saved.status, 201);
    assert.equal(saved.body.outcome.passed, true, saved.body.outcome.reasons.join("; "));
    assert.equal(saved.body.evidence.sales.independent, 3);
    assert.equal((await api.call("POST", "/api/audit", { locality: LOCALITY })).status, 400);
    assert.equal((await api.call("POST", "/api/audit", { ...body, offerProvider: "made-up", offerSourceId: "nothing" })).status, 404);
    assert.equal((await api.call("POST", "/api/audit", { ...body, barcode: { toString: 1 } })).status, 400);

    const items = await api.call("GET", "/api/audit?locality=" + LOCALITY);
    assert.equal(items.body.items.length, 1);
    assert.deepEqual(items.body.items[0].sales, SALES);
    const p = await api.call("GET", "/api/audit/progress?locality=" + LOCALITY);
    assert.equal(p.status, 200);
    assert.equal(p.body.passed, 1);
    assert.equal(p.body.remaining, 29);
    assert.equal((await api.call("GET", "/api/audit/progress")).status, 400);
  } finally {
    await api.close();
  }
});
