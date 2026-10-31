import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { memoryDb, serve } from "./test-support.mjs";
import { KIND, LICENCE } from "./contract.mjs";
import {
  schema,
  upsertResearch,
  upsertObservations,
  recordRun,
  readiness,
  recentRuns,
  listEvidence,
  listObservations,
  setPermission,
  displayPermitted,
  cachedLookup,
} from "./evidence.mjs";
import { openPrices } from "./sources.mjs";
import { importLookup, importFile, isFixture } from "./research.mjs";
import { importOpenPrices, fetchJson, parseArgs } from "./worker.mjs";
import * as evidenceRoutes from "./routes-evidence.mjs";

const fixture = (name) => readFileSync(new URL("./fixtures/sources/" + name, import.meta.url), "utf8");
const T0 = "2026-10-31T09:00:00.000Z";
const T1 = "2026-10-31T10:00:00.000Z";
const at = (iso) => () => new Date(iso);

const offer = (overrides = {}) => ({
  source_id: "1001",
  kind: KIND.RETAIL,
  title: "Cotton jumper",
  barcode: "5012345678900",
  size: "m",
  condition: "new",
  price: 1200,
  shipping: 399,
  observed: "2026-10-30T14:05:00.000Z",
  retailer: "Example Outfitters",
  licence: LICENCE.FEED,
  ...overrides,
});

test("research upsert: a retry does not duplicate, refreshes imported, keeps first_imported", () => {
  const db = memoryDb(schema);
  assert.equal(upsertResearch(db, "awin", [offer()], { now: T0 }), 1);
  assert.equal(upsertResearch(db, "awin", [offer({ price: 1100, availability: "in_stock" })], { now: T1 }), 1);
  const rows = db.prepare("SELECT * FROM research").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].price, 1100);
  assert.equal(rows[0].availability, "in_stock");
  assert.equal(rows[0].imported, T1);
  assert.equal(rows[0].first_imported, T0);
  assert.equal(rows[0].observed, "2026-10-30T14:05:00.000Z", "source date is kept apart from import time");
  // The same source id from another provider is a different record.
  upsertResearch(db, "hobnight", [offer({ kind: KIND.RETAIL })], { now: T1 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM research").get().n, 2);
});

test("research upsert skips invalid rows and returns the saved count", () => {
  const db = memoryDb(schema);
  const saved = upsertResearch(db, "awin", [
    offer({ source_id: "ok" }),
    offer({ source_id: "" }),
    offer({ source_id: "no-title", title: " " }),
    offer({ source_id: "zero", price: 0 }),
    offer({ source_id: "negative", price: -5 }),
    offer({ source_id: "fraction", price: 12.5 }),
    offer({ source_id: "nan", price: NaN }),
    offer({ source_id: "kind", kind: "Rumour" }),
    { id: "legacy-id", kind: KIND.RETAIL, title: "Old shape", price: 100 },
  ]);
  assert.equal(saved, 2);
  assert.deepEqual(
    db.prepare("SELECT source_id FROM research ORDER BY source_id").all().map((r) => r.source_id),
    ["legacy-id", "ok"],
  );
});

test("observation upsert is idempotent and keeps first_imported", () => {
  const db = memoryDb(schema);
  const rows = openPrices(JSON.parse(fixture("openprices-page.json")));
  assert.equal(upsertObservations(db, rows, { now: T0 }), 3);
  assert.equal(upsertObservations(db, rows.map((r) => ({ ...r, price: r.price + 1 })), { now: T1 }), 3);
  const stored = db.prepare("SELECT * FROM observations ORDER BY id").all();
  assert.equal(stored.length, 3);
  assert.equal(stored[0].price, 50);
  assert.equal(stored[0].imported, T1);
  assert.equal(stored[0].first_imported, T0);
  assert.equal(stored[0].unit, null);
  assert.equal(stored[1].regular_price, 535);
  assert.equal(stored[1].discounted, 1);
  assert.equal(stored[1].licence, "ODbL");
  assert.equal(upsertObservations(db, [{ ...rows[0], id: 99, day: null }]), 0, "undated rows are skipped");
});

// The schema at d456f87 (server/db.mjs), including its column migration.
const D456F87 = `CREATE TABLE IF NOT EXISTS outcomes(id INTEGER PRIMARY KEY,sku TEXT, received INTEGER, costs INTEGER, minutes INTEGER, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY,title TEXT, store TEXT, place TEXT, price INTEGER,day TEXT,unit TEXT);
CREATE TABLE IF NOT EXISTS research (
 provider TEXT NOT NULL, source_id TEXT NOT NULL, kind TEXT NOT NULL,
 title TEXT NOT NULL, barcode TEXT, variant TEXT, price INTEGER NOT NULL, observed TEXT,
 retailer TEXT, imported TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(provider,source_id)
);
ALTER TABLE observations ADD COLUMN barcode TEXT;
ALTER TABLE observations ADD COLUMN proof_id TEXT;`;

test("migrates a d456f87 database in place without losing rows", () => {
  const db = memoryDb((d) => d.exec(D456F87));
  db.exec(`INSERT INTO observations(id,title,store,place,price,day,unit,barcode,proof_id)
VALUES (7,'Milk','Tesco','',105,'2026-09-01','UNKNOWN','5000112637922','42');
INSERT INTO research(provider,source_id,kind,title,barcode,variant,price,observed,retailer,imported)
VALUES ('sales','s1','Reported completed sale','Honey','12345670','340g',1000,'2026-09-01','eBay UK','2026-09-02 10:00:00'),
('ebay','e1','Active asking price','Honey','12345670',NULL,950,NULL,'eBay UK','2026-09-03 11:00:00');`);
  schema(db);
  schema(db); // idempotent
  const research = db.prepare("SELECT * FROM research ORDER BY provider").all();
  assert.equal(research.length, 2);
  const sale = research.find((r) => r.provider === "sales");
  assert.equal(sale.price, 1000);
  assert.equal(sale.imported, "2026-09-02T10:00:00Z");
  assert.equal(sale.first_imported, "2026-09-02T10:00:00Z");
  assert.equal(sale.licence, LICENCE.SELF);
  assert.equal(sale.condition, null, "unknown attributes stay null so matching fails closed");
  assert.equal(research.find((r) => r.provider === "ebay").licence, LICENCE.PROVIDER);
  const columns = db.prepare("PRAGMA table_info(research)").all().map((c) => c.name);
  for (const c of ["size", "pack", "model", "condition", "shipping", "listed", "seller", "url", "licence", "first_imported"])
    assert.ok(columns.includes(c), "research gains " + c);
  const [obs] = db.prepare("SELECT * FROM observations").all();
  assert.equal(obs.title, "Milk");
  assert.equal(obs.unit, null, "legacy UNKNOWN unit becomes null");
  assert.equal(obs.place, null);
  assert.equal(obs.licence, "ODbL");
  assert.equal(obs.discounted, 0);
  assert.match(obs.imported, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(obs.first_imported, obs.imported);
  // The migrated tables accept new upserts and keep the original first sighting.
  upsertResearch(db, "sales", [{ source_id: "s1", kind: KIND.SOLD, title: "Honey", price: 1000, condition: "new" }], { now: T1 });
  const again = db.prepare("SELECT * FROM research WHERE source_id = 's1'").get();
  assert.equal(again.first_imported, "2026-09-02T10:00:00Z");
  assert.equal(again.imported, T1);
  // Other tables from the old database are untouched.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outcomes").get().n, 0);
  for (const table of ["permissions", "import_runs", "lookup_cache"])
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(table), table + " exists");
});

test("readiness: staleness, last error, cached runs and no credential values", () => {
  const db = memoryDb(schema);
  const env = { HOBNIGHT_API_KEY: "hob-very-secret", KEEPA_API_KEY: "", EBAY_ACCESS_TOKEN: "ebay-very-secret" };
  const now = "2026-10-31T12:00:00.000Z";
  let open = readiness(db, env, { now }).find((s) => s.provider === "openprices");
  assert.equal(open.stale, true, "never imported is stale");
  assert.equal(open.status, "Public API");
  recordRun(db, { provider: "openprices", mode: "scheduled", started: "2026-10-30T11:00:00Z", finished: "2026-10-30T11:00:05Z", ok: true, rows: 90 });
  open = readiness(db, env, { now }).find((s) => s.provider === "openprices");
  assert.equal(open.stale, true, "25 hours since the last success is stale");
  recordRun(db, { provider: "openprices", mode: "scheduled", started: "2026-10-31T10:00:00Z", finished: "2026-10-31T10:00:05Z", ok: true, rows: 95 });
  recordRun(db, { provider: "openprices", mode: "manual", started: "2026-10-31T11:00:00Z", ok: false, error: "Open Prices returned HTTP 503" });
  open = readiness(db, env, { now }).find((s) => s.provider === "openprices");
  assert.equal(open.stale, false);
  assert.equal(open.lastSuccess, "2026-10-31T10:00:05.000Z");
  assert.equal(open.lastError, "Open Prices returned HTTP 503");
  assert.equal(open.lastRun.ok, false);
  recordRun(db, { provider: "hobnight", mode: "lookup", query: "milk", started: "2026-10-31T11:30:00Z", ok: true, rows: 4, cached: true });
  const all = readiness(db, env, { now });
  const hob = all.find((s) => s.provider === "hobnight");
  assert.equal(hob.status, "Credential configured");
  assert.equal(hob.lastSuccess, null, "a cache reuse is not a fresh fetch");
  assert.equal(hob.stale, false, "on-demand lookups are never stale");
  assert.equal(all.find((s) => s.provider === "keepa").status, "Needs KEEPA_API_KEY");
  assert.equal(all.find((s) => s.provider === "awin").status, "Local import");
  const text = JSON.stringify(all);
  assert.ok(!text.includes("hob-very-secret") && !text.includes("ebay-very-secret"));
  assert.ok(text.includes("HOBNIGHT_API_KEY"), "names the variable, not the value");
});

test("recordRun redacts credential values from errors and queries", () => {
  const db = memoryDb(schema);
  const env = { KEEPA_API_KEY: "keepa-secret-value" };
  recordRun(db, { provider: "keepa", mode: "lookup", query: "B000000000", ok: false, error: "failed at https://api.keepa.com/product?key=keepa-secret-value&domain=2" }, { env });
  const [run] = recentRuns(db);
  assert.ok(!run.error.includes("keepa-secret-value"));
  assert.throws(() => recordRun(db, { provider: "keepa", mode: "nightly" }), /Unknown run mode/);
});

test("recordRun redacts a raw credential value in the query and the error", () => {
  const db = memoryDb(schema);
  // No key= or Bearer prefix: only the redaction by value can catch these.
  const env = { HOBNIGHT_API_KEY: "hob-raw-secret-9081", EBAY_ACCESS_TOKEN: "ebay-raw-token-4471" };
  recordRun(
    db,
    {
      provider: "hobnight",
      mode: "lookup",
      query: "milk hob-raw-secret-9081",
      ok: false,
      error: "Upstream said: token ebay-raw-token-4471 is not valid for hob-raw-secret-9081",
    },
    { env },
  );
  const stored = db.prepare("SELECT query, error FROM import_runs").get();
  for (const value of Object.values(env)) {
    assert.ok(!stored.query.includes(value), "query keeps " + value);
    assert.ok(!stored.error.includes(value), "error keeps " + value);
  }
  assert.equal(stored.query, "milk [redacted]");
  assert.match(stored.error, /token \[redacted\] is not valid for \[redacted\]/);
});

const hobnightBody = () => JSON.parse(fixture("hobnight-products.json"));

test("lookup cache: a repeat reuses stored rows with no network call; --refresh fetches", async () => {
  const db = memoryDb(schema);
  const env = { HOBNIGHT_API_KEY: "hob-cache-key" };
  let calls = 0;
  const request = async () => {
    calls++;
    return Response.json(hobnightBody());
  };
  const first = await importLookup(db, "hobnight", "milk", { env, request, now: at(T0) });
  assert.equal(first.cached, false);
  assert.equal(first.saved, 2);
  assert.equal(calls, 1);

  const second = await importLookup(db, "hobnight", "  MILK ", { env, request, now: at("2026-10-31T14:59:00Z") });
  assert.equal(second.cached, true);
  assert.equal(calls, 1, "no network call inside the six-hour window");
  assert.equal(second.rows.length, 2);
  assert.equal(second.fetched, T0);
  assert.equal(
    db.prepare("SELECT imported FROM research WHERE source_id = '101'").get().imported,
    T0,
    "a cache reuse does not pretend the rows are newer",
  );

  const refreshed = await importLookup(db, "hobnight", "milk", { env, request, refresh: true, now: at("2026-10-31T15:00:00Z") });
  assert.equal(refreshed.cached, false);
  assert.equal(calls, 2, "--refresh bypasses the cache");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM research").get().n, 2, "no duplicates");

  const expired = await importLookup(db, "hobnight", "milk", { env, request, now: at("2026-10-31T21:00:01Z") });
  assert.equal(expired.cached, false);
  assert.equal(calls, 3, "an expired entry fetches again");

  const runs = recentRuns(db);
  assert.deepEqual(runs.map((r) => [r.mode, r.ok, r.cached]).reverse(), [
    ["lookup", true, false],
    ["lookup", true, true],
    ["lookup", true, false],
    ["lookup", true, false],
  ]);
  assert.ok(!JSON.stringify(runs).includes("hob-cache-key"));
});

test("Keepa cache lasts 24 hours and failures are recorded, not cached", async () => {
  const db = memoryDb(schema);
  const env = { KEEPA_API_KEY: "k".repeat(64) };
  let calls = 0;
  const failing = async () => {
    calls++;
    return Response.json({ error: { message: "Operation unauthorized. No active API plan found.", type: "unauthorized" } }, { status: 402 });
  };
  await assert.rejects(importLookup(db, "keepa", "B000000000", { env, request: failing, now: at(T0) }), /HTTP 402/);
  await assert.rejects(importLookup(db, "keepa", "B000000000", { env, request: failing, now: at(T1) }), /HTTP 402/);
  assert.equal(calls, 2, "a failed lookup is not cached");
  const [run] = recentRuns(db);
  assert.equal(run.ok, false);
  assert.match(run.error, /No active API plan/);
  assert.equal(readiness(db, env).find((s) => s.provider === "keepa").lastError, run.error);

  const ok = async () => {
    calls++;
    return Response.json({ products: [{ asin: "B000000000", title: "Kettle", csv: [[8000000, 2499]] }] });
  };
  await importLookup(db, "keepa", "B000000000", { env, request: ok, now: at(T0) });
  await importLookup(db, "keepa", "B000000000", { env, request: ok, now: at("2026-11-01T08:59:00Z") });
  assert.equal(calls, 3);
  assert.equal(cachedLookup(db, "keepa", "B000000000", { now: "2026-11-01T09:00:01Z" }), null);
});

test("listEvidence filters by kind and reports the total beyond one page", () => {
  const db = memoryDb(schema);
  const sales = Array.from({ length: 250 }, (_, i) => ({
    source_id: "s" + i,
    kind: KIND.SOLD,
    title: "Honey jar",
    barcode: "12345670",
    condition: "new",
    price: 1000 + i,
    observed: "2026-10-" + String((i % 28) + 1).padStart(2, "0"),
  }));
  upsertResearch(db, "sales", sales);
  upsertResearch(db, "ebay", [{ source_id: "e1", kind: KIND.ASKING, title: "Honey jar", barcode: "12345670", price: 900 }]);
  upsertResearch(db, "awin", [offer()]);
  const page = listEvidence(db, { kind: KIND.SOLD, limit: 100 });
  assert.equal(page.rows.length, 100);
  assert.equal(page.total, 250);
  assert.ok(page.rows.every((r) => r.kind === KIND.SOLD), "asking prices never appear among sales");
  assert.equal(listEvidence(db, { kind: KIND.SOLD, limit: 100, offset: 200 }).rows.length, 50);
  assert.equal(listEvidence(db, { barcode: "12345670" }).total, 251);
  assert.equal(listEvidence(db, { kind: KIND.ASKING }).total, 1);
  assert.equal(listEvidence(db, { q: "JUMPER" }).total, 1);
  assert.equal(listEvidence(db, { q: "100%" }).total, 0, "LIKE wildcards are escaped");
  assert.equal(listEvidence(db, { provider: "awin" }).rows[0].source_id, "1001");
  assert.equal(listEvidence(db, { kind: KIND.SOLD, limit: 5000 }).rows.length, 250, "limit is capped at 500");
});

test("display permission: programme row wins, then provider-wide, else not permitted", () => {
  const db = memoryDb(schema);
  assert.equal(displayPermitted(db, "awin", "Example Outfitters"), false, "absence is not permission");
  setPermission(db, { provider: "awin", programme: "", display: true, note: "Publisher terms allow display" });
  assert.equal(displayPermitted(db, "awin", "Example Outfitters"), true);
  setPermission(db, { provider: "awin", programme: "Example Outfitters", display: false });
  assert.equal(displayPermitted(db, "awin", "example outfitters"), false, "programme-specific row wins");
  assert.equal(displayPermitted(db, "awin", "Other Shop"), true);
  setPermission(db, { provider: "awin", programme: "EXAMPLE OUTFITTERS", display: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM permissions WHERE provider = 'awin'").get().n, 2, "one row per programme regardless of case");
  assert.equal(displayPermitted(db, "awin", "Example Outfitters"), true);
  assert.equal(displayPermitted(db, "hobnight", ""), false);
  assert.throws(() => setPermission(db, { provider: "awin", display: "yes" }), /true or false/);
});

test("worker retries transient failures, records runs and is idempotent", async () => {
  const db = memoryDb(schema);
  const page = fixture("openprices-page.json");
  const waits = [];
  let calls = 0;
  const flaky = async (url, options) => {
    calls++;
    assert.equal(url.searchParams.get("currency"), "GBP");
    assert.ok(options.headers["User-Agent"].startsWith("Bounty/"));
    if (calls === 1) throw new TypeError("fetch failed");
    if (calls === 2) return new Response("busy", { status: 503, headers: { "Retry-After": "1" } });
    return new Response(page, { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const result = await importOpenPrices(db, { request: flaky, sleep: async (ms) => waits.push(ms), now: at(T0) });
  assert.deepEqual(result, { saved: 3, fetched: 7 });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 1000], "backoff, then Retry-After");
  await importOpenPrices(db, { mode: "scheduled", request: async () => new Response(page), sleep: async () => {}, now: at(T1) });
  assert.equal(listObservations(db).total, 3, "a repeat import does not duplicate");
  const runs = recentRuns(db);
  assert.deepEqual(runs.map((r) => [r.provider, r.mode, r.ok, r.rows]), [
    ["openprices", "scheduled", true, 3],
    ["openprices", "manual", true, 3],
  ]);
});

test("worker gives up after three attempts and does not retry a client error", async () => {
  const db = memoryDb(schema);
  let calls = 0;
  await assert.rejects(
    importOpenPrices(db, { request: async () => (calls++, new Response("", { status: 502 })), sleep: async () => {}, now: at(T0) }),
    /HTTP 502/,
  );
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(
    fetchJson(new URL("https://example.test"), { request: async () => (calls++, new Response("", { status: 400 })), sleep: async () => {} }),
    /HTTP 400/,
  );
  assert.equal(calls, 1);
  const [run] = recentRuns(db);
  assert.equal(run.ok, false);
  assert.match(run.error, /HTTP 502/);
  assert.equal(readiness(db, {}, { now: T0 }).find((s) => s.provider === "openprices").stale, true);
  assert.deepEqual(parseArgs(["--pages", "3", "--scheduled"]), { pages: 3, mode: "scheduled" });
  assert.throws(() => parseArgs(["--pages", "6"]), /1 to 5/);
});

test("manual sales file import is all or nothing and recorded", () => {
  const db = memoryDb(schema);
  const sale = {
    reference: "r1",
    title: "Honey",
    variant: "340g glass jar",
    barcode: "12345670",
    condition: "new",
    currency: "GBP",
    totalPence: 1085,
    postagePence: 285,
    soldDate: "2026-10-12",
    seller: "a_seller",
  };
  const now = at("2026-10-31T12:00:00Z");
  assert.throws(() => importFile(db, "sales", JSON.stringify([sale, { ...sale, reference: "r2", condition: "" }]), { now }), /index 1/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM research").get().n, 0);
  assert.deepEqual(importFile(db, "sales", JSON.stringify([sale]), { now }), { saved: 1, parsed: 1, skipped: 0, withoutSeller: 0 });
  const row = db.prepare("SELECT * FROM research").get();
  assert.deepEqual([row.kind, row.price, row.shipping, row.seller, row.licence], [KIND.SOLD, 1085, 285, "a_seller", LICENCE.SELF]);
  assert.deepEqual(recentRuns(db).map((r) => r.ok), [true, false]);
  assert.throws(() => importFile(db, "sales", "not json", { now }), /not valid JSON/);
  assert.ok(isFixture(new URL("./fixtures/sources/awin-sample.csv", import.meta.url).pathname));
  assert.ok(!isFixture("/tmp/feed.csv"));
});

test("a sale with a total of 0 rejects the whole sales file instead of being skipped", () => {
  const db = memoryDb(schema);
  const sale = {
    reference: "z1",
    title: "Honey",
    variant: "340g glass jar",
    barcode: "12345670",
    condition: "new",
    currency: "GBP",
    totalPence: 1085,
    soldDate: "2026-10-12",
  };
  const now = at("2026-10-31T12:00:00Z");
  const file = JSON.stringify([sale, { ...sale, reference: "z2", totalPence: 0 }]);
  assert.throws(() => importFile(db, "sales", file, { now }), /index 1: totalPence must be a positive whole number/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM research").get().n, 0, "nothing is saved");
  const [run] = recentRuns(db);
  assert.equal(run.ok, false);
  assert.match(run.error, /index 1: totalPence/);
  // Sales with no seller name, or only a listing id, are saved and counted
  // as not showing independence.
  const result = importFile(
    db,
    "sales",
    JSON.stringify([sale, { ...sale, reference: "z3", listingId: "110011" }, { ...sale, reference: "z4", seller: "honey_shop" }]),
    { now },
  );
  assert.deepEqual(result, { saved: 3, parsed: 3, skipped: 0, withoutSeller: 2 });
});

test("an Awin import reports the rows it skipped", () => {
  const db = memoryDb(schema);
  const feed = "aw_product_id,product_name,currency,search_price\n1,Kettle,GBP,24.50\n2,Free sample,GBP,0\n,No id,GBP,3.00\n";
  assert.deepEqual(importFile(db, "awin", feed, { now: at(T0) }), { saved: 1, parsed: 3, skipped: 2, withoutSeller: 0 });
});

test("routes: /api/evidence returns rows and total and validates input", async () => {
  const db = memoryDb(schema);
  upsertResearch(db, "sales", Array.from({ length: 120 }, (_, i) => ({ source_id: "s" + i, kind: KIND.SOLD, title: "Honey", barcode: "12345670", price: 1000 })));
  upsertResearch(db, "ebay", [{ source_id: "e1", kind: KIND.ASKING, title: "Honey", barcode: "12345670", price: 900 }]);
  const api = await serve(db, [evidenceRoutes]);
  try {
    const sold = await api.call("GET", "/api/evidence?kind=" + encodeURIComponent(KIND.SOLD));
    assert.equal(sold.status, 200);
    assert.equal(sold.body.rows.length, 100, "default limit");
    assert.equal(sold.body.total, 120);
    const all = await api.call("GET", "/api/evidence?barcode=12345670&limit=500&offset=0");
    assert.equal(all.body.total, 121);
    assert.equal(all.body.rows.length, 121);
    const asking = await api.call("GET", "/api/evidence?provider=ebay");
    assert.deepEqual(asking.body.rows.map((r) => r.kind), [KIND.ASKING]);
    for (const bad of ["kind=Rumour", "limit=501", "limit=0", "limit=ten", "offset=-1", "provider=amazon", "barcode=abc"])
      assert.equal((await api.call("GET", "/api/evidence?" + bad)).status, 400, bad);
  } finally {
    await api.close();
  }
});

test("routes: /api/permissions saves, lists and rejects bad input", async () => {
  const db = memoryDb(schema);
  const api = await serve(db, [evidenceRoutes]);
  try {
    const saved = await api.call("POST", "/api/permissions", { provider: "awin", programme: "Example Outfitters", display: true, note: "Programme terms 2026-10" });
    assert.equal(saved.status, 200);
    assert.deepEqual([saved.body.provider, saved.body.programme, saved.body.display], ["awin", "Example Outfitters", true]);
    await api.call("POST", "/api/permissions", { provider: "openprices", display: true });
    const list = await api.call("GET", "/api/permissions");
    assert.deepEqual(list.body.permissions.map((p) => [p.provider, p.programme, p.display]), [
      ["awin", "Example Outfitters", true],
      ["openprices", "", true],
    ]);
    assert.equal(displayPermitted(db, "awin", "Example Outfitters"), true);
    for (const bad of [
      { provider: "amazon", display: true },
      { provider: "awin", display: "true" },
      { provider: "awin" },
      { provider: "awin", display: true, programme: 5 },
      { provider: "awin", display: true, note: "x".repeat(501) },
    ])
      assert.equal((await api.call("POST", "/api/permissions", bad)).status, 400, JSON.stringify(bad));
  } finally {
    await api.close();
  }
});

test("routes: /api/sources and /api/observations", async () => {
  const db = memoryDb(schema);
  upsertObservations(db, openPrices(JSON.parse(fixture("openprices-page.json"))), { now: T0 });
  recordRun(db, { provider: "openprices", mode: "manual", started: T0, ok: true, rows: 3 });
  const previous = process.env.EBAY_ACCESS_TOKEN;
  process.env.EBAY_ACCESS_TOKEN = "route-secret-token";
  // A failed lookup whose query and error echo the raw token (no key= or
  // Bearer prefix), recorded with the server environment.
  recordRun(db, { provider: "ebay", mode: "lookup", query: "jumper route-secret-token", started: T1, ok: false, error: "eBay rejected route-secret-token" });
  const api = await serve(db, [evidenceRoutes]);
  try {
    const sources = await api.call("GET", "/api/sources");
    assert.equal(sources.status, 200);
    assert.equal(sources.body.sources.length, 6);
    assert.equal(sources.body.runs.length, 2);
    assert.ok(!JSON.stringify(sources.body).includes("route-secret-token"));
    const failed = sources.body.runs.find((r) => r.provider === "ebay");
    assert.deepEqual([failed.query, failed.error], ["jumper [redacted]", "eBay rejected [redacted]"]);
    assert.equal(sources.body.sources.find((s) => s.provider === "ebay").lastError, "eBay rejected [redacted]");
    assert.equal(sources.body.sources.find((s) => s.provider === "ebay").status, "Credential configured");
    const obs = await api.call("GET", "/api/observations?barcode=5060108452137");
    assert.equal(obs.body.total, 1);
    assert.equal(obs.body.rows[0].discounted, true);
    assert.equal((await api.call("GET", "/api/observations?limit=501")).status, 400);
    assert.equal((await api.call("GET", "/api/observations")).body.rows.length, 3);
  } finally {
    await api.close();
    if (previous === undefined) delete process.env.EBAY_ACCESS_TOKEN;
    else process.env.EBAY_ACCESS_TOKEN = previous;
  }
});
