import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { memoryDb, serve } from "./test-support.mjs";
import { HttpError } from "./http.mjs";
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
      locality: "Leeds",
      method: "in_store",
      inStock: true,
      unitsSeen: 4,
      checkedAt: hoursBefore(2),
      ...extra,
    },
    { now: NOW },
  );

const item = (db, extra = {}) =>
  recordItem(
    db,
    {
      locality: "Leeds",
      barcode: BARCODE,
      title: "Tefal Ingenio pan 28cm",
      retailer: "Argos",
      offerProvider: "awin",
      offerSourceId: "offer-1",
      promotionEligible: true,
      shipping: 300,
      daysToSell: 5,
      independentSales: 3,
      displayPermitted: true,
      matchDecision: "exact",
      ...extra,
    },
    { now: NOW },
  );

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

test("the latest check decides stock and old checks expire", () => {
  const db = memoryDb(schema);
  assert.equal(stockStatus(db, { barcode: BARCODE, retailer: "Argos", now: NOW }).confirmed, false);
  check(db, { checkedAt: hoursBefore(60) });
  assert.equal(stockStatus(db, { barcode: BARCODE, retailer: "Argos", now: NOW }).confirmed, false);
  const recent = check(db, { checkedAt: hoursBefore(5) });
  const status1 = stockStatus(db, { barcode: BARCODE, retailer: "ARGOS", locality: "leeds", now: NOW });
  assert.equal(status1.confirmed, true);
  assert.equal(status1.availability, "in_stock");
  assert.equal(status1.check.id, recent.id);
  assert.equal(stockStatus(db, { barcode: BARCODE, retailer: "Tesco", now: NOW }).check, null);
  assert.equal(stockStatus(db, { barcode: BARCODE, retailer: "Argos", locality: "York", now: NOW }).check, null);
  check(db, { checkedAt: hoursBefore(1), inStock: false, unitsSeen: 0 });
  const status2 = stockStatus(db, { barcode: BARCODE, retailer: "Argos", now: NOW });
  assert.equal(status2.confirmed, false);
  assert.equal(status2.availability, "out_of_stock");
  // latestCheck honours its window and never reads a check after `until`.
  assert.equal(latestCheck(db, BARCODE, "Argos", hoursBefore(3), { until: hoursBefore(2) }), null);
  assert.equal(latestCheck(db, "bad", "Argos", hoursBefore(100)), null);
  // Without the audit tables there is no check, so stock is not confirmed.
  assert.equal(latestCheck(new DatabaseSync(":memory:"), BARCODE, "Argos", hoursBefore(10)), null);
});

test("an audit item passes only when every field passes", () => {
  const db = memoryDb(schema);
  const c = check(db);
  const passed = item(db, { availabilityCheckId: c.id });
  assert.equal(passed.outcome.passed, true, passed.outcome.reasons.join("; "));
  assert.deepEqual(passed.outcome.reasons, []);

  const empty = auditOutcome({});
  assert.equal(empty.passed, false);
  assert.ok(empty.checks.every((x) => !x.ok));

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
    ["days_to_sell", null, AUDIT_FAILURES.daysToSell],
    ["independent_sales", 2, AUDIT_FAILURES.independent],
    ["independent_sales", null, AUDIT_FAILURES.independent],
    ["display_permitted", null, AUDIT_FAILURES.display],
    ["display_permitted", 0, AUDIT_FAILURES.display],
    ["match_decision", "research", AUDIT_FAILURES.matchUncertain],
    ["match_decision", "none", AUDIT_FAILURES.matchUncertain],
    ["match_decision", null, AUDIT_FAILURES.matchUnknown],
  ]) {
    const outcome = auditOutcome({ ...base, [field]: value });
    assert.equal(outcome.passed, false, field + "=" + JSON.stringify(value));
    assert.ok(outcome.reasons.includes(reason), field + ": " + outcome.reasons.join("; "));
    // An invalid barcode also cannot agree with the linked check.
    if (field !== "barcode") assert.equal(outcome.reasons.length, 1, field);
  }
});

test("items are one per barcode per locality and linked checks must agree", () => {
  const db = memoryDb(schema);
  const c = check(db);
  const first = item(db, { availabilityCheckId: c.id });
  const again = item(db, { locality: "LEEDS", barcode: "0" + BARCODE, shipping: 350, availabilityCheckId: c.id });
  assert.equal(again.id, first.id);
  assert.equal(again.shipping, 350);
  assert.equal(listItems(db, "Leeds").length, 1);

  const york = check(db, { locality: "York" });
  assert.equal(status(() => item(db, { availabilityCheckId: york.id })), 400);
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
  const db = memoryDb(schema);
  const c = check(db);
  item(db, { availabilityCheckId: c.id });
  item(db, { barcode: "4006381333931", matchDecision: "research" });
  item(db, { barcode: "5449000000996", independentSales: 1, shipping: null });
  item(db, { locality: "York", barcode: "96385074" });
  const p = progress(db, "leeds");
  assert.equal(p.target, 30);
  assert.equal(p.audited, 3);
  assert.equal(p.passed, 1);
  assert.equal(p.failed, 2);
  assert.equal(p.remaining, 27);
  assert.equal(p.complete, false);
  assert.equal(p.failures[AUDIT_FAILURES.noCheck], 2);
  assert.equal(p.failures[AUDIT_FAILURES.matchUncertain], 1);
  assert.equal(p.failures[AUDIT_FAILURES.independent], 1);
  assert.equal(p.failures[AUDIT_FAILURES.shipping], 1);
  assert.equal(progress(db, "York").audited, 1);
  assert.equal(progress(db, "Bristol").remaining, 30);
});

test("audit and check routes validate input and report progress", async () => {
  const db = memoryDb(schema);
  const api = await serve(db, [researchRoutes]);
  try {
    const created = await api.call("POST", "/api/research/checks", {
      barcode: BARCODE,
      retailer: "Argos",
      locality: "Leeds",
      method: "phone",
      inStock: true,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.barcode, GTIN);
    const future = await api.call("POST", "/api/research/checks", {
      barcode: BARCODE,
      retailer: "Argos",
      locality: "Leeds",
      method: "phone",
      inStock: true,
      checkedAt: new Date(Date.now() + 86400000).toISOString(),
    });
    assert.equal(future.status, 400);
    const list = await api.call("GET", "/api/research/checks?barcode=0" + BARCODE);
    assert.equal(list.status, 200);
    assert.equal(list.body.rows.length, 1);
    assert.equal((await api.call("GET", "/api/research/checks?barcode=12")).status, 400);

    const saved = await api.call("POST", "/api/audit", {
      locality: "Leeds",
      barcode: BARCODE,
      title: "Pan",
      retailer: "Argos",
      offerProvider: "awin",
      offerSourceId: "offer-1",
      availabilityCheckId: created.body.id,
      promotionEligible: true,
      shipping: 300,
      daysToSell: 4,
      independentSales: 3,
      displayPermitted: true,
      matchDecision: "exact",
    });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.outcome.passed, true, saved.body.outcome.reasons.join("; "));
    assert.equal((await api.call("POST", "/api/audit", { locality: "Leeds" })).status, 400);

    const items = await api.call("GET", "/api/audit?locality=Leeds");
    assert.equal(items.body.items.length, 1);
    const p = await api.call("GET", "/api/audit/progress?locality=Leeds");
    assert.equal(p.status, 200);
    assert.equal(p.body.passed, 1);
    assert.equal(p.body.remaining, 29);
    assert.equal((await api.call("GET", "/api/audit/progress")).status, 400);
  } finally {
    await api.close();
  }
});
