import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { memoryDb, serve } from "./test-support.mjs";
import { HttpError } from "./http.mjs";
import { KIND, LICENCE } from "./contract.mjs";
import { schema as evidenceSchema, setPermission, upsertResearch } from "./evidence.mjs";
import {
  AUDIT_FAILURES,
  AUDIT_RULES,
  AUDIT_TARGET,
  EVIDENCE_GAPS,
  auditOutcome,
  evidenceGaps,
  isEvidenced,
  latestCheck,
  listItems,
  newestShelfEvidence,
  progress,
  recordCheck,
  recordItem,
  schema,
  signOff,
  signOffLine,
  stockStatus,
} from "./audit.mjs";
import { schema as bountiesSchema } from "./bounties.mjs";
import * as researchRoutes from "./routes-research.mjs";

const NOW = "2026-10-31T12:00:00.000Z";
const BARCODE = "5012345678900";
const GTIN = "05012345678900";
const hoursBefore = (h) => new Date(Date.parse(NOW) - h * 3600000).toISOString();
const hoursAfter = (h) => hoursBefore(-h);

const status = (fn) => {
  try {
    fn();
    return 200;
  } catch (error) {
    assert.ok(error instanceof HttpError, String(error));
    return error.status;
  }
};

// The check records the shelf price seen at the branch (the same £15.00 the
// feed lists), so the price applies at the branch checked (round 5).
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
      pricePence: 1500,
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
// Every required cost and time entered, as in Research (a blank is never
// zero): packaging, the return journey and handling. The parcel cost comes
// from the item's shipping field.
const TRIP = { costs: { packaging: 50, journeyCost: 200, journeyMinutes: 40, handlingMinutes: 10 } };

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
  for (const c of ["availability_check_id", "promotion_eligible", "match_decision", "audited_offer", "updated"])
    assert.ok(items.includes(c), c);
});

test("the sign-off bar is a named rule", () => {
  assert.deepEqual({ ...AUDIT_RULES }, { target: 30, minPassedToSignOff: 1 });
  assert.ok(Object.isFrozen(AUDIT_RULES));
  assert.equal(AUDIT_TARGET, AUDIT_RULES.target);
  assert.equal(
    signOffLine({ at: "2026-10-31T20:47:00.000Z", passed: 12, evidenced: 30 }, "Camden"),
    "Pilot audit in Camden signed off on 31 Oct 2026: 12 of 30 items passed.",
  );
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

test("a check with no time is stamped by the server, and an older one says what still decides the shelf", () => {
  // R3Q1: a check typed with an old time loses to a newer report, so the
  // person recording it is told.
  const db = memoryDb(evidenceSchema, schema, bountiesSchema);
  for (const checkedAt of [undefined, null, "", "   "]) {
    const row = check(db, { checkedAt, unitsSeen: 2 });
    assert.equal(row.checked_at, NOW, JSON.stringify(checkedAt));
    assert.equal(row.checkedAtStamped, true);
    assert.equal(row.newerEvidence, null, "a check at the same time is not newer");
    assert.equal(row.olderWarning, null);
  }
  const typed = check(db, { checkedAt: hoursBefore(2), inStock: false, unitsSeen: 0 });
  assert.equal(typed.checkedAtStamped, false);
  assert.deepEqual({ ...typed.newerEvidence, id: undefined }, { kind: "check", id: undefined, at: NOW, inStock: true, unitsSeen: 2 });
  assert.equal(
    typed.olderWarning,
    "This check is dated 31 Oct 2026, 10:00, earlier than the branch check at 31 Oct 2026, 12:00 (2 seen), so the newer one still decides what bounties show for this shelf. If you checked just now, leave the time blank and the time you save is recorded.",
  );
  // A check in another locality or for another retailer is not compared.
  assert.equal(check(db, { checkedAt: hoursBefore(5), locality: "Hackney" }).newerEvidence, null);
  assert.equal(check(db, { checkedAt: hoursBefore(5), retailer: "Tesco" }).newerEvidence, null);

  // A member's stock report on a bounty for the same item counts too, unless
  // the operator marked it inaccurate.
  const OTHER = "4006381333931";
  db.prepare("INSERT INTO members(id, name) VALUES(1, 'Fay')").run();
  db.prepare(
    `INSERT INTO bounties(id, title, barcode, retailer, locality, available_units, sales_per_week, sell_window_weeks, expires_at)
 VALUES(1, 'Pan', '0' || ?, 'argos', 'camden', 4, 2, 2, ?)`,
  ).run(OTHER, hoursAfter(48));
  const report = db
    .prepare("INSERT INTO stock_reports(bounty_id, member_id, units_seen, observed_at) VALUES(1, 1, 4, ?)")
    .run(hoursBefore(1));
  const stale = check(db, { barcode: OTHER, checkedAt: hoursBefore(3), inStock: false, unitsSeen: 0 });
  assert.deepEqual(stale.newerEvidence, { kind: "report", id: Number(report.lastInsertRowid), at: hoursBefore(1), inStock: true, unitsSeen: 4 });
  assert.match(stale.olderWarning, /earlier than the stock report at 31 Oct 2026, 11:00 \(4 seen\)/);
  db.prepare("UPDATE stock_reports SET verified = 'inaccurate'").run();
  const older = check(db, { barcode: OTHER, checkedAt: hoursBefore(4) });
  assert.equal(older.newerEvidence.kind, "check");
  assert.equal(older.newerEvidence.id, stale.id);
  assert.match(older.olderWarning, /earlier than the branch check at 31 Oct 2026, 09:00 \(none found\)/);
  assert.deepEqual(
    newestShelfEvidence(db, { barcode: OTHER, retailer: "ARGOS", locality: " Camden " }),
    { kind: "check", id: stale.id, at: hoursBefore(3), inStock: false, unitsSeen: 0 },
  );
  for (const bad of [{ barcode: "12" }, { retailer: "" }, { locality: null }])
    assert.equal(newestShelfEvidence(db, { barcode: OTHER, retailer: "Argos", locality: LOCALITY, ...bad }), null);
  // Without the bounty tables only checks are compared.
  const plainDb = memoryDb(schema);
  check(plainDb, { checkedAt: hoursBefore(1) });
  assert.equal(check(plainDb, { checkedAt: hoursBefore(2) }).newerEvidence.kind, "check");
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
    "barcode", "offer", "live-evidence", "offer-fresh", "availability", "price-at-branch", "promotion", "shipping",
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
  // A stock-only check: the feed's own (stale) price is the one judged.
  const c2 = check(stale, { pricePence: null });
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
  assert.deepEqual(noTrip.evidence.missingInputs, ["packaging cost", "return journey cost", "journey time", "handling time"]);
  // A required cost left blank in Research is never zero: the item cannot pass.
  const { packaging: _packaging, ...noPackaging } = TRIP.costs;
  const blank = item(db, { availabilityCheckId: c.id, estimateInputs: { costs: noPackaging } });
  assert.equal(blank.evidence.tier, "Review");
  assert.deepEqual(blank.evidence.missingInputs, ["packaging cost"]);
  assert.equal(blank.outcome.passed, false);
  // An unknown parcel cost is not sent as 0 either.
  const noParcel = item(db, { availabilityCheckId: c.id, shipping: null });
  assert.deepEqual(noParcel.evidence.missingInputs, ["parcel cost"]);
  assert.ok(noParcel.outcome.reasons.includes(AUDIT_FAILURES.shipping));
  assert.equal(item(db, { availabilityCheckId: c.id }).evidence.missingInputs.length, 0);
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
  assert.equal(p.evidenced, 1, "items with no recorded offer are audited but not evidenced");
  assert.equal(p.withoutEvidence, 2);
  assert.equal(p.passed, 1);
  assert.equal(p.failed, 2);
  assert.equal(p.remaining, 29, "29 more items with stored evidence are needed");
  assert.equal(p.complete, false);
  assert.equal(p.signedOff, null);
  assert.equal(p.signOffLapsed, null);
  assert.equal(p.failures[AUDIT_FAILURES.noCheck], 2);
  assert.equal(p.failures[AUDIT_FAILURES.noEvidence], 2, "counted once per item");
  assert.equal(p.failures[AUDIT_FAILURES.shipping], 1);
  assert.equal(Object.getPrototypeOf(p.failures), Object.prototype);
  assert.equal(progress(db, "Hackney").audited, 1);
  assert.equal(progress(db, "Bristol").remaining, 30);
});

// A valid GTIN-13 for item n of a 30-item audit.
function gtin13(n) {
  const data = "50123456" + String(n).padStart(4, "0");
  let sum = 0;
  const padded = data.padStart(13, "0");
  for (let i = 0; i < 13; i++) sum += Number(padded[i]) * (i % 2 === 0 ? 3 : 1);
  return data + ((10 - (sum % 10)) % 10);
}

// count items in Camden from item number `from`, each with its own recorded
// Awin offer and branch check (found stock), audited at `now`. Each has
// `sales` confirmed exact sales from different sellers, except the first
// `passing` items, which have three and pass every check. One sale counts
// the item towards the 30, but fewer than three independent sales fail it.
// linkCheck false leaves the check unlinked.
function auditedOffers(db, count, { from = 1, now = NOW, passing = 0, sales = 1, linkCheck = true } = {}) {
  const numbers = Array.from({ length: count }, (_, i) => from + i);
  upsertResearch(db, "awin", numbers.map((n) => ({ ...OFFER, source_id: "o" + n, barcode: gtin13(n) })), { now: NOW });
  return numbers.map((n, i) => {
    const sold = ["a", "b", "c"]
      .slice(0, i < passing ? 3 : sales)
      .map((s) => saleRow(`s${n}${s}`, { barcode: gtin13(n) }));
    if (sold.length) upsertResearch(db, "sales", sold, { now: NOW });
    const linked = linkCheck ? check(db, { barcode: gtin13(n) }).id : null;
    return recordItem(
      db,
      {
        locality: LOCALITY,
        barcode: gtin13(n),
        title: OFFER.title,
        retailer: "Argos",
        offerProvider: "awin",
        offerSourceId: "o" + n,
        sales: sold.map((r) => ({ provider: "sales", sourceId: r.source_id })),
        weightKg: 0.9,
        promotionEligible: true,
        shipping: 300,
        estimateInputs: TRIP,
        availabilityCheckId: linked,
      },
      { now },
    );
  });
}

test("thirty rows with no stored evidence never complete the audit", () => {
  const db = evidenceDb();
  // The review scenario: 30 rows holding only a barcode, title and retailer.
  for (let n = 1; n <= AUDIT_TARGET; n++)
    item(db, { barcode: gtin13(n), offerProvider: null, offerSourceId: null, sales: [] });
  const p = progress(db, LOCALITY);
  assert.deepEqual(
    [p.audited, p.evidenced, p.passed, p.remaining, p.complete, p.signedOff],
    [30, 0, 0, 30, false, null],
  );
  assert.equal(p.withoutEvidenceReasons[EVIDENCE_GAPS.offer], 30);
  assert.equal(status(() => signOff(db, { locality: LOCALITY }, { now: NOW })), 409);
  assert.throws(() => signOff(db, { locality: LOCALITY }, { now: NOW }), /not complete: 0 of 30 items have been checked against stored evidence/);
  const sample = evidenceDb({ offer: { source_id: "sample-1" } });
  item(sample, { offerSourceId: "sample-1", availabilityCheckId: check(sample).id });
  assert.equal(progress(sample, LOCALITY).evidenced, 0, "sample data never counts towards the audit");
});

test("an item counts towards the 30 only with an offer, a confirmed exact sale and a branch check there", () => {
  // R3P1: 30 items naming an offer, with no sold evidence and no branch
  // check, are not 30 checked items.
  const db = evidenceDb();
  auditedOffers(db, AUDIT_TARGET, { sales: 0, linkCheck: false });
  const p = progress(db, LOCALITY);
  assert.deepEqual([p.audited, p.evidenced, p.complete, p.remaining], [30, 0, false, 30]);
  assert.equal(p.withoutEvidenceReasons[EVIDENCE_GAPS.sale], 30);
  assert.equal(p.withoutEvidenceReasons[EVIDENCE_GAPS.check], 30);
  const [one] = listItems(db, LOCALITY);
  assert.equal(one.evidenced, false);
  assert.deepEqual(one.evidenceGaps, [EVIDENCE_GAPS.sale, EVIDENCE_GAPS.check]);
  // One confirmed sale and a linked check count it, though it fails.
  const [counted] = auditedOffers(db, 1);
  assert.equal(counted.evidenced, true);
  assert.deepEqual(counted.evidenceGaps, []);
  assert.equal(counted.outcome.passed, false);
  assert.equal(progress(db, LOCALITY).evidenced, 1);

  // Each condition on its own, on the shape listItems returns.
  const base = {
    offer_provider: "awin",
    offer_source_id: "x",
    barcode: BARCODE,
    retailer: "Argos",
    locality: LOCALITY,
    check: { barcode: GTIN, retailer: "argos", locality: "camden", in_stock: 0 },
    evidence: { offer: {}, error: null, live: true, sales: { used: 1 } },
  };
  assert.equal(isEvidenced(base), true, "a check that found no stock is still a branch check");
  for (const [change, gap] of [
    [{ offer_provider: null }, EVIDENCE_GAPS.offer],
    [{ offer_source_id: null }, EVIDENCE_GAPS.offer],
    [{ evidence: undefined }, EVIDENCE_GAPS.unread],
    [{ evidence: { ...base.evidence, offer: null, error: "Offer not found" } }, EVIDENCE_GAPS.unread],
    // An errored item is never evidenced, even with an offer attached (AS7).
    [{ evidence: { ...base.evidence, error: "units must be a whole number" } }, EVIDENCE_GAPS.unread],
    [{ evidence: { ...base.evidence, live: false } }, EVIDENCE_GAPS.sample],
    [{ evidence: { ...base.evidence, live: null } }, EVIDENCE_GAPS.sample],
    [{ evidence: { ...base.evidence, sales: { used: 0 } } }, EVIDENCE_GAPS.sale],
    [{ evidence: { ...base.evidence, sales: null } }, EVIDENCE_GAPS.sale],
    [{ check: null }, EVIDENCE_GAPS.check],
    [{ check: { ...base.check, locality: "Hackney" } }, EVIDENCE_GAPS.check],
    [{ check: { ...base.check, retailer: "Tesco" } }, EVIDENCE_GAPS.check],
    [{ check: { ...base.check, barcode: "04006381333931" } }, EVIDENCE_GAPS.check],
    [{ barcode: "123" }, EVIDENCE_GAPS.check],
  ]) {
    const it = { ...base, ...change };
    assert.equal(isEvidenced(it), false, JSON.stringify(change));
    assert.deepEqual(evidenceGaps(it), [gap], JSON.stringify(change));
  }
});

test("an audit with no passed item cannot be signed off, and a sign-off lapses when the result changes", () => {
  const db = evidenceDb();
  auditedOffers(db, AUDIT_TARGET - 1);
  const short = progress(db, LOCALITY);
  assert.equal(short.complete, false);
  assert.match(short.signOffBlocked, /not complete: 29 of 30/);
  assert.equal(status(() => signOff(db, { locality: LOCALITY }, { now: NOW })), 409);
  // The thirtieth evidenced item completes the audit, though none passed.
  auditedOffers(db, 1, { from: AUDIT_TARGET });
  const none = progress(db, LOCALITY);
  assert.deepEqual([none.audited, none.evidenced, none.passed, none.failed, none.complete, none.signedOff], [30, 30, 0, 30, true, null]);
  assert.equal(none.minPassedToSignOff, 1);
  // R3P1, R3B4, R3Q4: nothing passed, so there is nothing to sign off.
  assert.equal(none.signOffBlocked, "Only 0 of 30 items passed, so the audit cannot be signed off. At least 1 must pass first");
  assert.equal(status(() => signOff(db, { locality: LOCALITY, passed: 0, evidenced: 30 }, { now: NOW })), 409);
  assert.throws(() => signOff(db, { locality: LOCALITY }, { now: NOW }), /Only 0 of 30 items passed, so the audit cannot be signed off/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_signoffs").get().n, 0);
  // A sign-off recorded before the bar (0 passed) no longer stands.
  db.prepare("INSERT INTO audit_signoffs(locality, signed_at, target, audited, evidenced, passed) VALUES('Camden', ?, 30, 30, 30, 0)").run(hoursAfter(0.5));
  const legacy = progress(db, LOCALITY);
  assert.equal(legacy.signedOff, null);
  assert.equal(legacy.signOffLapsed.reason, "Only 0 of 30 items passed, fewer than the 1 a sign-off needs");

  // Two items are audited again with three sales each, and pass.
  const later = hoursAfter(1);
  auditedOffers(db, 2, { from: 1, now: later, passing: 2 });
  const two = progress(db, LOCALITY);
  assert.deepEqual([two.evidenced, two.passed, two.signOffBlocked], [30, 2, null]);
  // Counts the operator did not see are refused.
  assert.equal(status(() => signOff(db, { locality: LOCALITY, passed: 5, evidenced: 30 }, { now: later })), 409);
  assert.throws(() => signOff(db, { locality: LOCALITY, passed: 5 }, { now: later }), /changed since you looked: 2 of 30 items now pass/);
  assert.equal(status(() => signOff(db, { locality: "" }, { now: later })), 400);
  assert.equal(status(() => signOff(db, { locality: LOCALITY, passed: "0" }, { now: later })), 400);
  assert.equal(status(() => signOff(db, null, { now: later })), 400);
  const signed = signOff(db, { locality: "camden", passed: 2, evidenced: 30, note: "Accepted for the pilot" }, { now: later });
  assert.equal(signed.created, true);
  assert.deepEqual(
    { ...signed.signedOff, id: undefined },
    {
      id: undefined,
      locality: "camden",
      at: later,
      target: 30,
      audited: 30,
      evidenced: 30,
      passed: 2,
      note: "Accepted for the pilot",
      summary: "Pilot audit in camden signed off on 31 Oct 2026: 2 of 30 items passed.",
    },
  );
  assert.deepEqual(progress(db, LOCALITY).signedOff, signed.signedOff);
  assert.equal(signOff(db, { locality: LOCALITY }, { now: later }).created, false, "a standing sign-off is not recorded twice");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_signoffs").get().n, 2);
  assert.equal(progress(db, "Hackney").signedOff, null, "a sign-off covers its own locality only");

  // R3Q5: the routine feed import changes a passed item's offer (new price,
  // dated after the audit). The item is judged on the offer as it was
  // audited, so the result and the sign-off stand.
  upsertResearch(db, "awin", [{ ...OFFER, source_id: "o1", barcode: gtin13(1), price: 950, observed: hoursAfter(2) }], { now: hoursAfter(2) });
  const imported = progress(db, LOCALITY);
  assert.equal(imported.passed, 2);
  assert.deepEqual(imported.signedOff, signed.signedOff);
  assert.equal(imported.signOffLapsed, null);

  // AS2: the pass count changes while every item still counts (a sale
  // behind item 1 is removed): the sign-off lapses.
  db.prepare("DELETE FROM research WHERE provider = 'sales' AND source_id = 's1b'").run();
  const fewer = progress(db, LOCALITY);
  assert.deepEqual([fewer.evidenced, fewer.passed, fewer.complete], [30, 1, true]);
  assert.equal(fewer.signedOff, null);
  assert.deepEqual(fewer.signOffLapsed, {
    at: later,
    passed: 2,
    evidenced: 30,
    reason: "The result changed after the sign-off: 2 of 30 items passed then, 1 of 30 now",
  });

  // Signed off again at 1 passed; saving an item after it lapses it.
  const again = signOff(db, { locality: LOCALITY, passed: 1, evidenced: 30 }, { now: hoursAfter(3) });
  assert.equal(again.created, true);
  assert.equal(progress(db, LOCALITY).signOffLapsed, null);
  auditedOffers(db, 1, { from: 5, now: hoursAfter(4) });
  const changed = progress(db, LOCALITY);
  assert.equal(changed.signedOff, null);
  assert.deepEqual(changed.signOffLapsed, { at: hoursAfter(3), passed: 1, evidenced: 30, reason: "1 item was changed after the sign-off" });
  signOff(db, { locality: LOCALITY }, { now: hoursAfter(4) });
  // Evidence that can no longer be read takes the audit below 30, and the
  // sign-off lapses with it.
  db.prepare("DELETE FROM research WHERE provider = 'awin' AND source_id = 'o2'").run();
  const removed = progress(db, LOCALITY);
  assert.deepEqual([removed.evidenced, removed.complete, removed.signedOff], [29, false, null]);
  assert.equal(removed.signOffLapsed.reason, "Only 29 of 30 items now have stored evidence");
});

test("an offer or a stock check for another item never passes", () => {
  const db = evidenceDb();
  const c = check(db);
  const saved = item(db, { availabilityCheckId: c.id });
  assert.equal(saved.outcome.passed, true, reasonsOf(saved));
  // A check for another barcode at the same shop and place is refused.
  const other = check(db, { barcode: "4006381333931" });
  assert.throws(() => item(db, { availabilityCheckId: other.id }), /That availability check is for a different barcode/);
  assert.equal(status(() => item(db, { availabilityCheckId: other.id })), 400);
  const wrong = auditOutcome({ ...saved, check: { ...c, barcode: "04006381333931" } });
  assert.ok(wrong.reasons.includes(AUDIT_FAILURES.checkMismatch));
  // The feed now names another retailer for the recorded offer: the item
  // is judged on the offer as it was audited (Argos), and the change is
  // shown beside it.
  upsertResearch(db, "awin", [{ ...OFFER, retailer: "Tesco" }], { now: NOW });
  const [moved] = listItems(db, LOCALITY);
  assert.equal(moved.outcome.passed, true, reasonsOf(moved));
  assert.equal(moved.evidence.offer.retailer, "Argos");
  assert.deepEqual(moved.evidence.offerChange.changed, ["retailer"]);
  assert.match(moved.evidence.offerChange.note, /audited: Argos then, Tesco now\./);
  // A copy taken from an offer that names another retailer fails the offer
  // check, not only the stock check.
  db.prepare("UPDATE validation_items SET audited_offer = NULL").run();
  schema(db);
  const [copied] = listItems(db, LOCALITY);
  const offerCheck = copied.outcome.checks.find((x) => x.id === "offer");
  assert.equal(offerCheck.ok, false);
  assert.equal(offerCheck.detail, AUDIT_FAILURES.offerMismatch);
  assert.equal(copied.outcome.passed, false);
  // An offer with no retailer, or one for another barcode, fails the same way.
  for (const offer of [{ ...saved.evidence.offer, retailer: null }, { ...saved.evidence.offer, retailer: "Tesco" }, { ...saved.evidence.offer, barcode: "04006381333931" }]) {
    const outcome = auditOutcome({ ...saved, evidence: { ...saved.evidence, offer } });
    assert.equal(outcome.checks.find((x) => x.id === "offer").detail, AUDIT_FAILURES.offerMismatch, JSON.stringify(offer));
    assert.equal(outcome.passed, false);
  }
});

test("an item is judged on its copy of the offer, and a changed live offer is shown beside it", () => {
  const db = evidenceDb();
  const c = check(db);
  const saved = item(db, { availabilityCheckId: c.id });
  assert.equal(saved.outcome.passed, true, reasonsOf(saved));
  assert.deepEqual(saved.audited_offer, {
    provider: "awin",
    sourceId: "offer-1",
    price: 1500,
    observed: OFFER.observed,
    retailer: "Argos",
    barcode: GTIN,
    copiedAt: NOW,
    migrated: false,
  });
  assert.deepEqual(saved.evidence.offerCopy, saved.audited_offer);
  assert.equal(saved.evidence.offerChange, null);

  // R3Q5: the routine feed import six minutes later changes the price and
  // the date. Judged on the live row the offer would be dated after the
  // audit and fail as "not observed within 7 days"; it is judged on the copy.
  const later = new Date(Date.parse(NOW) + 6 * 60000).toISOString();
  upsertResearch(db, "awin", [{ ...OFFER, price: 950, observed: later }], { now: later });
  const [after] = listItems(db, LOCALITY);
  assert.equal(after.outcome.passed, true, reasonsOf(after));
  assert.equal(after.evidence.offer.price, 1500);
  // The shelf price on the branch check is the price judged, dated at the
  // check (round 5); the live feed row never changes it.
  assert.equal(after.evidence.offer.observed, c.checked_at);
  assert.equal(after.evidence.offerFresh, true);
  assert.deepEqual(after.evidence.offerChange.changed, ["price", "observed"]);
  assert.deepEqual(after.evidence.offerChange.now, { price: 950, observed: later, retailer: "Argos", barcode: GTIN });
  assert.equal(
    after.evidence.offerChange.note,
    "The offer has changed since this item was audited: £15.00 then, £9.50 now. This item is judged on the offer as it stood then.",
  );
  // The same price seen again: no note.
  upsertResearch(db, "awin", [{ ...OFFER, observed: later }], { now: later });
  const [seen] = listItems(db, LOCALITY);
  assert.deepEqual([seen.outcome.passed, seen.evidence.offerChange.changed, seen.evidence.offerChange.note], [true, ["observed"], null]);
  // A live row that is no longer a usable offer (no price): judged on the
  // copy, and said so.
  db.prepare("UPDATE research SET price = 0 WHERE source_id = 'offer-1'").run();
  const [unpriced] = listItems(db, LOCALITY);
  assert.equal(unpriced.outcome.passed, true, reasonsOf(unpriced));
  assert.deepEqual(unpriced.evidence.offerChange.changed, ["unreadable"]);
  assert.match(unpriced.evidence.offerChange.note, /can no longer be read as it is now \(The offer has no price\)/);
  // Saving the item again audits the offer as it stands then.
  upsertResearch(db, "awin", [{ ...OFFER, price: 950, observed: later }], { now: later });
  const resaved = recordItem(
    db,
    {
      locality: LOCALITY,
      barcode: BARCODE,
      title: OFFER.title,
      retailer: "Argos",
      offerProvider: "awin",
      offerSourceId: "offer-1",
      sales: SALES,
      weightKg: 0.9,
      promotionEligible: true,
      shipping: 300,
      estimateInputs: TRIP,
      availabilityCheckId: c.id,
    },
    { now: new Date(Date.parse(later) + 60000).toISOString() },
  );
  assert.equal(resaved.audited_offer.price, 950);
  assert.equal(resaved.audited_offer.observed, later);
  // The feed now lists £9.50, but the trip pays the £15.00 shelf price the
  // branch check recorded (round 5).
  assert.equal(resaved.evidence.priceAtBranch.seen.price, 950);
  assert.equal(resaved.evidence.offer.price, 1500);
  assert.equal(resaved.evidence.offerChange, null);
});

test("an Open Prices item stays costed at the audited observation when a newer one at the same shop arrives", () => {
  const db = evidenceDb();
  const seen = db.prepare(
    `INSERT INTO observations(id, title, store, place, city, price, day, quantity, barcode)
 VALUES(?, 'Tefal Ingenio pan 28cm', 'Argos', 'NW1 7DL', 'London', ?, ?, '28cm', ?)`,
  );
  seen.run(990001, 1500, daysBefore(1), BARCODE);
  const c = check(db);
  const saved = item(db, {
    offerProvider: "openprices",
    offerSourceId: "990001",
    availabilityCheckId: c.id,
    estimateInputs: { ...TRIP, offerAttributes: { pack: "1", model: "L15006" } },
  });
  assert.equal(saved.evidence.offer.sourceId, "990001");
  assert.equal(saved.evidence.offer.price, 1500);
  // Imported later: a dearer price at the same shop, dated today, which is
  // before the audit time because Open Prices dates by day.
  seen.run(990003, 1900, NOW.slice(0, 10), BARCODE);
  const [after] = listItems(db, LOCALITY);
  assert.equal(after.evidence.offer.sourceId, "990001");
  assert.equal(after.evidence.offer.price, 1500);
  assert.equal(after.evidence.offer.unitCost, saved.evidence.offer.unitCost);
  assert.equal(after.evidence.tier, saved.evidence.tier);
  assert.deepEqual(after.outcome.reasons, saved.outcome.reasons);
  assert.equal(after.outcome.passed, saved.outcome.passed);
});

test("items saved before the offer copy get one from the current offer, and a sign-off does not lapse", () => {
  const db = evidenceDb();
  const c = check(db);
  const saved = item(db, { availabilityCheckId: c.id });
  // An older database: the column is empty.
  db.prepare("UPDATE validation_items SET audited_offer = NULL").run();
  const [legacy] = listItems(db, LOCALITY);
  assert.equal(legacy.evidence.offerCopy, null, "judged on the live offer until it has a copy");
  assert.equal(legacy.outcome.passed, true, reasonsOf(legacy));
  schema(db);
  const row = db.prepare("SELECT audited_offer, updated FROM validation_items").get();
  assert.equal(row.updated, saved.updated, "the migration does not change the audit time");
  const copy = JSON.parse(row.audited_offer);
  assert.deepEqual({ ...copy, copiedAt: undefined }, { ...saved.audited_offer, copiedAt: undefined, migrated: true });
  const [migrated] = listItems(db, LOCALITY);
  assert.equal(migrated.outcome.passed, true, reasonsOf(migrated));
  schema(db);
  assert.equal(db.prepare("SELECT audited_offer FROM validation_items").get().audited_offer, row.audited_offer, "a copy is taken once");

  // An offer a later import changed before the copy was taken: the copy is
  // dated after the audit, so the item fails with that reason, never with
  // "not observed within 7 days". (Without a shelf price on the check, so
  // the offer's own price and date are the ones judged.)
  db.prepare("UPDATE availability_checks SET price_pence = NULL").run();
  db.prepare("UPDATE validation_items SET audited_offer = NULL").run();
  upsertResearch(db, "awin", [{ ...OFFER, price: 950, observed: hoursAfter(1) }], { now: hoursAfter(1) });
  schema(db);
  const [late] = listItems(db, LOCALITY);
  assert.equal(late.outcome.passed, false);
  assert.ok(late.outcome.reasons.includes(AUDIT_FAILURES.offerAfterAudit), reasonsOf(late));
  assert.ok(!late.outcome.reasons.includes(AUDIT_FAILURES.offerStale), reasonsOf(late));
  // An offer that is gone gets no copy, and the item keeps failing.
  db.prepare("UPDATE validation_items SET audited_offer = NULL").run();
  db.prepare("DELETE FROM research WHERE source_id = 'offer-1'").run();
  schema(db);
  assert.equal(db.prepare("SELECT audited_offer FROM validation_items").get().audited_offer, null);
  const [gone] = listItems(db, LOCALITY);
  assert.equal(gone.evidence.errorKind, "offer");
  assert.equal(gone.evidenced, false);
  // A copy that is not of the recorded offer (a hand-edited row) is never
  // used: the item is judged on the live offer.
  upsertResearch(db, "awin", [OFFER], { now: NOW });
  db.prepare("UPDATE validation_items SET audited_offer = ?").run(JSON.stringify({ ...saved.audited_offer, sourceId: "offer-2", price: 100 }));
  const [other] = listItems(db, LOCALITY);
  assert.equal(other.evidence.offerCopy, null);
  assert.equal(other.evidence.offer.price, 1500);
  for (const broken of [{ ...saved.audited_offer, provider: "hobnight" }, { ...saved.audited_offer, price: "15" }, { ...saved.audited_offer, barcode: null }, "not json"]) {
    db.prepare("UPDATE validation_items SET audited_offer = ?").run(typeof broken === "string" ? broken : JSON.stringify(broken));
    assert.equal(listItems(db, LOCALITY)[0].evidence.offerCopy, null, JSON.stringify(broken));
  }
  // A copy taken when the item was saved is never replaced by the migration.
  const fresh = item(db, { availabilityCheckId: c.id });
  schema(db);
  assert.deepEqual(listItems(db, LOCALITY)[0].audited_offer, fresh.audited_offer);
  // Without the evidence tables the migration leaves items alone.
  const bare = memoryDb(schema);
  bare.prepare("INSERT INTO validation_items(locality, barcode, title, retailer, offer_provider, offer_source_id) VALUES('Camden', ?, 'Pan', 'Argos', 'awin', 'x')").run(GTIN);
  schema(bare);
  assert.equal(bare.prepare("SELECT audited_offer FROM validation_items").get().audited_offer, null);
});

test("deeply nested or oversized estimate inputs are refused with 400", () => {
  const db = evidenceDb();
  let deep = 1;
  for (let i = 0; i < 5000; i++) deep = [deep];
  const hostile = [
    { units: deep },
    { costs: { ...TRIP.costs, extra: deep } },
    { notes: "x".repeat(5000) },
    { list: Array.from({ length: 3000 }, () => 1) },
    { costs: { a: { b: { c: { d: { e: { f: 1 } } } } } } },
    { costs: { ...TRIP.costs, at: () => 1 } },
  ];
  hostile.forEach((estimateInputs, i) => assert.equal(status(() => item(db, { estimateInputs })), 400, "case " + i));
  assert.throws(() => item(db, { estimateInputs: { units: deep } }), /nested too deeply/);
  assert.throws(() => item(db, { estimateInputs: { notes: "x".repeat(5000) } }), /too large \(up to 4000 characters\)/);
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
      pricePence: 1500,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.barcode, GTIN);
    // No time given: the server stamps it (R3Q1).
    assert.equal(created.body.checkedAtStamped, true);
    assert.ok(Math.abs(Date.parse(created.body.checked_at) - Date.now()) < 60000);
    assert.equal(created.body.newerEvidence, null);
    const blank = await api.call("POST", "/api/research/checks", {
      barcode: BARCODE,
      retailer: "Argos",
      locality: LOCALITY,
      method: "phone",
      inStock: true,
      checkedAt: "",
    });
    assert.equal(blank.status, 201);
    assert.equal(blank.body.checkedAtStamped, true);
    const backdated = await api.call("POST", "/api/research/checks", {
      barcode: BARCODE,
      retailer: "Argos",
      locality: LOCALITY,
      method: "phone",
      inStock: false,
      checkedAt: new Date(Date.now() - 3 * 60000).toISOString(),
    });
    assert.equal(backdated.status, 201);
    assert.equal(backdated.body.newerEvidence.kind, "check");
    assert.match(backdated.body.olderWarning, /so the newer one still decides what bounties show for this shelf/);
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
    assert.equal(list.body.rows.length, 3);
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
    assert.equal(p.body.evidenced, 1);
    assert.equal(p.body.remaining, 29);
    assert.equal(p.body.signedOff, null);
    assert.equal((await api.call("GET", "/api/audit/progress")).status, 400);

    // Sign-off: operator only, and only once the audit is complete.
    const early = await api.call("POST", "/api/audit/signoff", { locality: LOCALITY });
    assert.equal(early.status, 409);
    assert.match(early.body.error, /1 of 30 items have been checked against stored evidence/);
    assert.equal((await api.call("POST", "/api/audit/signoff", { locality: LOCALITY, memberId: 1 })).status, 403);
    assert.equal((await api.call("POST", "/api/audit/signoff?viewer=3", { locality: LOCALITY })).status, 403);
    assert.equal((await api.call("POST", "/api/audit/signoff", {})).status, 400);
    // A body with estimateInputs.units nested 5000 lists deep, sent as text
    // (JSON.stringify itself cannot write it).
    const deep = "[".repeat(5000) + "1" + "]".repeat(5000);
    const raw = JSON.stringify({ ...body, estimateInputs: { ...TRIP, units: 1 } }).replace('"units":1', '"units":' + deep);
    const nested = await fetch(api.base + "/api/audit", { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });
    assert.equal(nested.status, 400);
    assert.match((await nested.json()).error, /nested too deeply/);
  } finally {
    await api.close();
  }
});
