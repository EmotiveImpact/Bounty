import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
const { keepForGood, memoryStore } = await import(process.env.BOUNTY_KEEP_TEST_MODULE || "./keep.mjs");
import { openDb } from "./db.mjs";
import { createApi } from "./app.mjs";
import { personalStores, memberDir } from "./personal.mjs";

const goal = (name) => ({ name, amount: 50000, start: "2026-01-01" });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

async function instance(t, store, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bounty-durability-synthetic-"));
  const opened = [];
  const personal = [];
  const keeper = keepForGood({
    store, dir, log: () => {},
    build() {
      const db = openDb(join(dir, "desk.sqlite"));
      opened.push(db);
      const own = options.members ? personalStores(dir) : null;
      if (own) personal.push(own);
      return {
        handle: createApi(db, { members: options.members, personal: own?.personal, forget: own?.forget, ...options.apiOptions }),
        checkpoint: () => { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); own?.checkpoint(); },
        close: () => { own?.close(); if (db.isOpen) db.close(); },
      };
    },
    ...options,
  });
  const server = createServer((req, res) => {
    Promise.resolve(keeper.handle(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(503);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    for (const own of personal) own.close();
    for (const db of opened) if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    keeper, dir, base,
    async call(method, path = "/api/goals/targets", body, headers = {}) {
      const res = await fetch(base + path, {
        method, signal: AbortSignal.timeout(5000),
        headers: { "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
    },
  };
}

// Works on the original per-file store too, so these tests can demonstrate
// failures on the pinned main-branch revision before the fix.
function interceptSave(store, fn) {
  const method = store.commit ? "commit" : "putFile";
  const original = store[method].bind(store);
  store[method] = (...args) => fn(() => original(...args), args);
}

test("durability: no HTTP success is released while the save is paused", async (t) => {
  const store = memoryStore();
  const entered = deferred();
  const release = deferred();
  interceptSave(store, async (save) => { entered.resolve(); await release.promise; return save(); });
  const a = await instance(t, store);
  let responded = false;
  const request = a.call("POST", undefined, goal("Synthetic paused save")).then((r) => { responded = true; return r; });
  await entered.promise;
  // Give the loopback HTTP client time to receive any prematurely sent bytes.
  await new Promise((r) => setTimeout(r, 30));
  const early = responded;
  release.resolve();
  assert.equal((await request).status, 201);
  assert.equal(early, false);
});

test("durability: unavailable storage cannot acknowledge a lost record", async (t) => {
  const store = memoryStore();
  let offline = true;
  interceptSave(store, (save) => { if (offline) throw Error("synthetic storage outage"); return save(); });
  const a = await instance(t, store);
  const result = await a.call("POST", undefined, goal("Synthetic lost purchase budget"));
  offline = false;
  const b = await instance(t, store);
  assert.deepEqual((await b.call("GET")).body.targets, []);
  assert.equal(result.status, 503, "a success followed by an empty restart is data loss");
  // A later successful request must not silently commit the failed local edit.
  assert.deepEqual((await a.call("GET")).body.targets, []);
  assert.equal((await a.call("POST", undefined, goal("Synthetic retry"))).status, 201);
});

test("durability: a failed version check refuses the request before mutation", async (t) => {
  const store = memoryStore();
  const a = await instance(t, store);
  await a.keeper.ready();
  const version = store.version.bind(store);
  store.version = async () => { throw Error("synthetic version outage"); };
  const result = await a.call("POST", undefined, goal("Synthetic stale write"));
  store.version = version;
  assert.equal(result.status, 503);
  assert.deepEqual((await a.call("GET")).body.targets, []);
});

test("durability: the same instance retries an initially failed restore", async (t) => {
  const store = memoryStore();
  const method = store.snapshot ? "snapshot" : "version";
  const original = store[method].bind(store);
  let first = true;
  store[method] = async () => {
    if (first) { first = false; throw Error("synthetic cold-start outage"); }
    return original();
  };
  const a = await instance(t, store);
  await assert.rejects(a.keeper.ready(), /cold-start outage/);
  await a.keeper.ready();
  assert.equal((await a.call("POST", undefined, goal("Synthetic recovered"))).status, 201);
});

test("durability: a purchase entry lost after restart is never acknowledged", async (t) => {
  const store = memoryStore();
  let offline = false;
  interceptSave(store, (save) => { if (offline) throw Error("synthetic unavailable storage"); return save(); });
  const a = await instance(t, store);
  const trip = await a.call("POST", "/api/ledger/trips", { label: "Synthetic purchase loss reproduction", source: "manual", kind: "resale" });
  assert.equal(trip.status, 201);
  // Drain the original implementation's post-response queue for setup only.
  if (a.keeper.changed) await a.keeper.changed();
  const before = await a.call("GET", `/api/ledger/trips/${trip.body.id}`);
  offline = true;
  const purchase = await a.call("POST", `/api/ledger/trips/${trip.body.id}/entries`, {
    type: "receipt", amount: 1000, units: 1, occurred: "2026-11-01",
  });
  if (a.keeper.changed) await a.keeper.changed();
  offline = false;
  const b = await instance(t, store);
  const after = await b.call("GET", `/api/ledger/trips/${trip.body.id}`);
  assert.deepEqual(after.body.entries, before.body.entries, "the uncommitted purchase is absent after restart");
  assert.equal(purchase.status, 503, "201 here would falsely promise the purchase was saved");
});

test("durability: competing instances acknowledge one winner, then the loser can retry", async (t) => {
  const store = memoryStore();
  const a = await instance(t, store);
  const b = await instance(t, store);
  await Promise.all([a.keeper.ready(), b.keeper.ready()]);
  const commit = store.commit.bind(store);
  const both = deferred();
  let arrivals = 0;
  store.commit = async (...args) => {
    if (++arrivals === 2) both.resolve();
    await both.promise;
    return commit(...args);
  };
  const result = await Promise.all([
    a.call("POST", undefined, goal("Synthetic A")),
    b.call("POST", undefined, goal("Synthetic B")),
  ]);
  assert.deepEqual(result.map((r) => r.status).sort(), [201, 409]);
  store.commit = commit;
  const winner = result[0].status === 201 ? "Synthetic A" : "Synthetic B";
  const loser = result[0].status === 409 ? a : b;
  assert.deepEqual((await loser.call("GET")).body.targets.map((x) => x.name), [winner]);
  assert.equal((await loser.call("POST", undefined, goal("Synthetic retry"))).status, 201);
  const restarted = await instance(t, store);
  assert.deepEqual((await restarted.call("GET")).body.targets.map((x) => x.name).sort(), [winner, "Synthetic retry"].sort());
});

test("durability: concurrent requests and reads on one instance wait for the commit", async (t) => {
  const store = memoryStore();
  const entered = deferred();
  const release = deferred();
  let first = true;
  interceptSave(store, async (save) => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return save();
  });
  const a = await instance(t, store);
  const firstRequest = a.call("POST", undefined, goal("Synthetic first"));
  await entered.promise;
  let readFinished = false;
  const read = a.call("GET").then((r) => { readFinished = true; return r; });
  const second = a.call("POST", undefined, goal("Synthetic second"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(readFinished, false, "reads cannot see uncommitted state");
  release.resolve();
  assert.equal((await firstRequest).status, 201);
  assert.equal((await second).status, 201);
  assert.equal((await read).status, 200);
  const b = await instance(t, store);
  assert.equal((await b.call("GET")).body.targets.length, 2);
});

test("durability: a lost commit acknowledgement is not reported as success or replayed", async (t) => {
  const store = memoryStore();
  let loseReply = true;
  interceptSave(store, async (save) => {
    const value = await save();
    if (loseReply) { loseReply = false; throw Error("synthetic connection lost after commit"); }
    return value;
  });
  const a = await instance(t, store);
  const result = await a.call("POST", undefined, goal("Synthetic committed once"));
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "save_not_confirmed");
  const read = await a.call("GET");
  assert.deepEqual(read.body.targets.map((x) => x.name), ["Synthetic committed once"]);
  const b = await instance(t, store);
  assert.equal((await b.call("GET")).body.targets.length, 1);
});

test("durability: an interrupted save retains old receipts and does not leak partial local edits", async (t) => {
  const store = memoryStore();
  const a = await instance(t, store);
  await a.keeper.change(() => writeFileSync(join(a.dir, "synthetic-receipt.txt"), "old receipt"));
  const saved = await store.snapshot();
  const commit = store.commit;
  store.commit = async () => { throw Error("synthetic interrupted upload"); };
  await assert.rejects(a.keeper.change(() => {
    writeFileSync(join(a.dir, "synthetic-receipt.txt"), "unconfirmed replacement");
    writeFileSync(join(a.dir, "synthetic-extra.txt"), "partial upload");
  }), /interrupted upload/);
  assert.deepEqual(await store.snapshot(), saved);
  store.commit = commit;
  await a.call("GET");
  assert.equal(readFileSync(join(a.dir, "synthetic-receipt.txt"), "utf8"), "old receipt");
  assert.equal(existsSync(join(a.dir, "synthetic-extra.txt")), false);
});

test("durability: corrupt restore preserves the last cache and later recovers", async (t) => {
  const store = memoryStore();
  const a = await instance(t, store);
  await a.call("POST", undefined, goal("Synthetic original"));
  const before = readFileSync(join(a.dir, "desk.sqlite"));
  const snapshot = store.snapshot.bind(store);
  const version = store.version.bind(store);
  store.version = async () => (await version()) + 1;
  store.snapshot = async () => ({ version: 99, files: { "desk.sqlite": "not gzip" } });
  assert.equal((await a.call("POST", undefined, goal("Synthetic refused"))).status, 503);
  assert.deepEqual(readFileSync(join(a.dir, "desk.sqlite")), before);
  store.snapshot = snapshot;
  store.version = version;
  assert.deepEqual((await a.call("GET")).body.targets.map((x) => x.name), ["Synthetic original"]);
});

test("durability: invalid snapshot paths are refused without replacing local files", async (t) => {
  const store = memoryStore();
  store.snapshot = async () => ({ version: 1, files: { "../outside": gzipSync("synthetic").toString("base64") } });
  const a = await instance(t, store);
  writeFileSync(join(a.dir, "synthetic-preserve.txt"), "preserve");
  await assert.rejects(a.keeper.ready(), /Invalid snapshot path/);
  assert.equal(readFileSync(join(a.dir, "synthetic-preserve.txt"), "utf8"), "preserve");
});

test("durability: a partially mutating rejected handler is discarded before the next save", async (t) => {
  const store = memoryStore();
  const module = { routes: (db) => [["POST", "/synthetic-failure", () => {
    db.exec("CREATE TABLE synthetic_partial (id INTEGER)");
    throw Error("synthetic handler failure");
  }]] };
  const a = await instance(t, store, { apiOptions: { modules: [module] } });
  assert.equal((await a.call("POST", "/synthetic-failure", {})).status, 500);
  assert.equal(await store.version(), 0);
  await a.keeper.ready();
  const db = openDb(join(a.dir, "desk.sqlite"));
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'synthetic_partial'").get().n, 0);
  db.close();
});

test("durability: responses and cookies are withheld on save failure", async (t) => {
  const store = memoryStore();
  interceptSave(store, () => { throw Error("synthetic failure"); });
  let dir;
  const a = await instance(t, store, { build: () => ({
    handle: (_req, res) => {
      writeFileSync(join(dir, "synthetic.txt"), "mutation");
      res.setHeader("Set-Cookie", "synthetic-session=value");
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    }, checkpoint() {}, close() {},
  }) });
  dir = a.dir;
  const result = await a.call("POST", "/synthetic", {});
  assert.equal(result.status, 503);
  assert.equal(result.headers.get("set-cookie"), null);
  assert.equal(result.body.ok, undefined);
});

test("durability: mixed account and snapshot operations fail before touching accounts", async (t) => {
  const store = memoryStore();
  let touched = 0;
  const members = { user: async () => ({ id: "synthetic", email: "synthetic@example.invalid" }),
    changeEmail: async () => { touched++; }, deleteAccount: async () => { touched++; } };
  const a = await instance(t, store, { members });
  for (const path of ["/api/account/email", "/api/account/delete"])
    assert.equal((await a.call("POST", path, {})).body.code, "account_change_unavailable");
  assert.equal(touched, 0);
  assert.equal(await store.version(), 0);
});

test("durability: two members' Stock, Money and receipt bytes survive a fresh instance", async (t) => {
  const store = memoryStore();
  const members = { user: async (req) => ({ id: req.headers["x-synthetic-member"] || "synthetic-a", email: "synthetic@example.invalid" }) };
  const a = await instance(t, store, { members });
  const secondMember = { "x-synthetic-member": "synthetic-b" };
  assert.equal((await a.call("POST", undefined, goal("Synthetic A money"))).status, 201);
  assert.equal((await a.call("POST", undefined, goal("Synthetic B money"), secondMember)).status, 201);
  const trip = await a.call("POST", "/api/ledger/trips", { label: "Synthetic purchase", source: "manual", kind: "resale" });
  assert.equal(trip.status, 201);
  const entry = await a.call("POST", `/api/ledger/trips/${trip.body.id}/entries`, { type: "receipt", amount: 1000, units: 1, occurred: "2026-11-01" });
  assert.equal(entry.status, 201);
  // Minimal synthetic PDF recognised by the real proof upload route.
  const data = Buffer.from("%PDF-1.4\nSynthetic receipt fixture\n%%EOF\n");
  const proof = await a.call("POST", `/api/ledger/trips/${trip.body.id}/proofs`, {
    entryId: entry.body.id, label: "Synthetic receipt", mediaType: "application/pdf", data: data.toString("base64"),
  });
  assert.equal(proof.status, 201, JSON.stringify(proof.body));
  const snapshot = await store.snapshot();
  const receiptPath = Object.keys(snapshot.files).find((path) => path.includes("/proofs/"));
  assert.ok(receiptPath);
  const originalBytes = readFileSync(join(a.dir, receiptPath));
  const b = await instance(t, store, { members });
  assert.deepEqual((await b.call("GET")).body.targets.map((x) => x.name), ["Synthetic A money"]);
  assert.deepEqual((await b.call("GET", undefined, undefined, secondMember)).body.targets.map((x) => x.name), ["Synthetic B money"]);
  assert.equal((await b.call("GET", "/api/ledger/trips")).body.trips[0].label, "Synthetic purchase");
  assert.deepEqual((await b.call("GET", "/api/ledger/trips", undefined, secondMember)).body.trips, []);
  assert.deepEqual(readFileSync(join(b.dir, receiptPath)), originalBytes);
  assert.ok(existsSync(join(memberDir(b.dir, { id: "synthetic-b" }), "desk.sqlite")));
});

test('durability: an empty remote store cannot erase pre-existing local records at first restore', async (t) => {
  const a = await instance(t, memoryStore());
  writeFileSync(join(a.dir, 'synthetic-legacy-receipt.txt'), 'retain this local receipt');
  await assert.rejects(a.keeper.ready(), /empty remote snapshot cannot replace/);
  assert.equal(readFileSync(join(a.dir, 'synthetic-legacy-receipt.txt'), 'utf8'), 'retain this local receipt');
});

test('durability: initial local files are retained separately when a remote snapshot replaces the cache', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bounty-initial-copy-synthetic-'));
  const dir = join(root, 'cache');
  mkdirSync(dir); writeFileSync(join(dir, 'local-receipt.txt'), 'local record for review');
  const store = memoryStore();
  await store.commit(0, [{ path: 'remote-receipt.txt', data: gzipSync('remote receipt').toString('base64') }], []);
  let backup;
  const keeper = keepForGood({ dir, store, log(message) { backup = message.split(' at ')[1]; },
    build: () => ({ handle() {}, checkpoint() {}, close() {} }) });
  t.after(async () => { await keeper.close(); rmSync(root, { recursive: true, force: true }); });
  await keeper.ready();
  assert.equal(readFileSync(join(dir, 'remote-receipt.txt'), 'utf8'), 'remote receipt');
  assert.equal(readFileSync(join(backup, 'local-receipt.txt'), 'utf8'), 'local record for review');
});

test('security: a partial network body holds neither the queue nor a transaction', async (t) => {
  const { request } = await import('node:http');
  let entered = 0;
  const a = await instance(t, memoryStore(), { transaction: async fn => { entered++; return fn(); } });
  let finish;
  const slow = new Promise((resolve, reject) => {
    const req = request(a.base + '/api/goals/targets', { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write('{"name":');
    finish = () => req.end('"Synthetic slow sender","amount":50000,"start":"2026-01-01"}');
  });
  await new Promise(r => setTimeout(r, 40));
  const earlyTransactions = entered;
  const fast = a.call('GET');
  const earlyRead = await Promise.race([fast.then(() => true), new Promise(r => setTimeout(() => r(false), 150))]);
  finish();
  assert.equal(await slow, 201);
  assert.equal((await fast).status, 200);
  assert.equal(earlyTransactions, 0, 'a network sender must not own the global write lock');
  assert.equal(earlyRead, true, 'another member can read while the first body is unfinished');
});

test('security: partial body expires with 408 and a later write succeeds', async (t) => {
  const { request } = await import('node:http');
  let entered = 0;
  const a = await instance(t, memoryStore(), { intakeOptions: { timeoutMs: 40 }, transaction: async fn => { entered++; return fn(); } });
  const status = await new Promise((resolve, reject) => {
    const req = request(a.base + '/api/goals/targets', { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.setTimeout(1000, () => req.destroy(Error('Synthetic timeout guard')));
    req.write('{');
  });
  assert.equal(status, 408);
  assert.equal(entered, 0);
  assert.equal((await a.call('POST', undefined, goal('After slow sender'))).status, 201);
});
