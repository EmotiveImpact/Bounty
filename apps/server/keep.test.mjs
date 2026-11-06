import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepForGood, memoryStore, postgresKeepStore } from "./keep.mjs";
import { openDb } from "./db.mjs";
import { createApi } from "./app.mjs";

// One "instance": its own temporary folder (like a fresh Vercel instance)
// sharing the store (like Neon).
async function instance(store, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bounty-keep-"));
  const keeper = keepForGood({
    store,
    dir,
    build: (file) => {
      const db = openDb(file);
      return { db, handle: createApi(db) };
    },
    log: () => undefined,
    ...extra,
  });
  const server = createServer(keeper.handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  return {
    dir,
    keeper,
    async call(method, path, body) {
      const res = await fetch(base + path, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const goal = (name) => ({ name, amount: 50000, start: "2026-01-01" });

test("a change survives a fresh instance", async () => {
  const store = memoryStore();
  const a = await instance(store);
  const saved = await a.call("POST", "/api/goals/targets", goal("Holiday"));
  assert.equal(saved.status, 201);
  await a.close();

  const b = await instance(store);
  const read = await b.call("GET", "/api/goals/targets");
  assert.equal(read.status, 200);
  assert.deepEqual(
    read.body.targets.map((t) => t.name),
    ["Holiday"],
  );
  await b.close();
});

test("an instance picks up another instance's change before making its own", async () => {
  const store = memoryStore();
  const a = await instance(store);
  const b = await instance(store);
  await a.call("GET", "/api/goals/targets");
  await b.call("GET", "/api/goals/targets");
  await a.call("POST", "/api/goals/targets", goal("Rent"));
  await b.call("POST", "/api/goals/targets", goal("Car"));

  const c = await instance(store);
  const names = (await c.call("GET", "/api/goals/targets")).body.targets.map((t) => t.name).sort();
  assert.deepEqual(names, ["Car", "Rent"]);
  for (const x of [a, b, c]) await x.close();
});

test("reads see another instance's change once the check interval passes", async () => {
  const store = memoryStore();
  let clock = 0;
  const a = await instance(store, { now: () => clock });
  const b = await instance(store, { now: () => clock });
  await b.call("GET", "/api/goals/targets");
  await a.call("POST", "/api/goals/targets", goal("Laptop"));
  assert.equal((await b.call("GET", "/api/goals/targets")).body.targets.length, 0, "within the interval: cached");
  clock += 6000;
  assert.equal((await b.call("GET", "/api/goals/targets")).body.targets.length, 1);
  await a.close();
  await b.close();
});

test("a refused change saves nothing", async () => {
  const store = memoryStore();
  const a = await instance(store);
  const bad = await a.call("POST", "/api/goals/targets", { name: "" });
  assert.equal(bad.status, 400);
  assert.equal(await store.version(), 0);
  await a.close();
});

test("receipt and photo files are kept, and removed files are removed", async () => {
  const store = memoryStore();
  const a = await instance(store);
  await a.call("GET", "/api/goals/targets");
  mkdirSync(join(a.dir, "proofs", "trip-1"), { recursive: true });
  writeFileSync(join(a.dir, "proofs", "trip-1", "receipt.jpg"), "receipt bytes");
  await a.keeper.changed();
  assert.deepEqual(await store.files(), ["proofs/trip-1/receipt.jpg"]);
  await a.close();

  const b = await instance(store);
  await b.call("GET", "/api/goals/targets");
  const file = join(b.dir, "proofs", "trip-1", "receipt.jpg");
  assert.equal(readFileSync(file, "utf8"), "receipt bytes");
  rmSync(file);
  await b.keeper.changed();
  assert.deepEqual(await store.files(), []);
  assert.equal(existsSync(file), false);
  await b.close();
});

test("two saves from the same version: the second is refused and reloads", async () => {
  const store = memoryStore();
  assert.equal(await store.save("x", 0), 1);
  assert.equal(await store.save("y", 0), null);
  assert.equal(await store.save("y", 1), 2);
});

test("the Postgres store sends version-checked saves", async () => {
  const sent = [];
  const rows = [];
  const store = await postgresKeepStore(async (text, params) => {
    sent.push(text);
    if (text.startsWith("INSERT INTO bounty_keep ")) return rows.length ? [] : (rows.push(params[0]), [{ version: "1" }]);
    if (text.startsWith("UPDATE bounty_keep ")) return params[1] === 1 ? [{ version: "2" }] : [];
    return [];
  });
  assert.equal(await store.save("a", 0), 1);
  assert.equal(await store.save("b", 0), null);
  assert.equal(await store.save("b", 1), 2);
  assert.ok(sent.some((t) => t.includes("WHERE id = 'main' AND version = $2")));
});
