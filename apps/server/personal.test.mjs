import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryAccountsStore, serve } from "./test-support.mjs";
import { accounts } from "./accounts.mjs";
import { openDb } from "./db.mjs";
import { routeModules } from "./app.mjs";
import { personalStores, memberDir } from "./personal.mjs";

const INVITE = "flip-together-2026";

async function start() {
  const root = mkdtempSync(join(tmpdir(), "bounty-personal-"));
  const store = memoryAccountsStore();
  const members = accounts(store, { inviteCode: INVITE });
  const own = personalStores(root);
  const db = openDb(":memory:");
  const api = await serve(db, routeModules, { members, password: null, personal: own.personal });
  const call = async (method, path, body, cookie) => {
    const res = await fetch(api.base + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.get("set-cookie") };
  };
  const join_ = async (email) =>
    (await call("POST", "/api/auth/signup", { email, password: "a long enough secret", invite: INVITE })).setCookie.split(
      ";",
    )[0];
  return {
    root,
    store,
    call,
    join: join_,
    async close() {
      await api.close();
      own.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const goal = (name) => ({ name, amount: 50000, start: "2026-01-01" });

test("each member sees only their own Money goals", async () => {
  const s = await start();
  try {
    const amy = await s.join("amy@example.com");
    const ben = await s.join("ben@example.com");
    assert.equal((await s.call("POST", "/api/goals/targets", goal("Amy's holiday"), amy)).status, 201);
    assert.equal((await s.call("POST", "/api/goals/targets", goal("Ben's van"), ben)).status, 201);
    const names = async (cookie) =>
      (await s.call("GET", "/api/goals/targets", undefined, cookie)).body.targets.map((t) => t.name);
    assert.deepEqual(await names(amy), ["Amy's holiday"]);
    assert.deepEqual(await names(ben), ["Ben's van"]);
    assert.deepEqual(await names(undefined), [], "signed out: nothing of anyone's");
  } finally {
    await s.close();
  }
});

test("each member has their own Stock, and visitors see an empty one", async () => {
  const s = await start();
  try {
    const amy = await s.join("amy@example.com");
    const visitor = await s.call("GET", "/api/ledger/trips");
    assert.equal(visitor.status, 200);
    assert.deepEqual(visitor.body.trips, []);
    assert.equal((await s.call("GET", "/api/ledger/trips", undefined, amy)).status, 200);
    const write = await s.call("POST", "/api/goals/targets", goal("Nope"));
    assert.equal(write.status, 401, "a change still needs a sign-in");
  } finally {
    await s.close();
  }
});

test("a member's data sits in a folder named by a hash, not their email", async () => {
  const s = await start();
  try {
    const amy = await s.join("amy@example.com");
    await s.call("POST", "/api/goals/targets", goal("Holiday"), amy);
    const user = s.store.users.find((u) => u.email === "amy@example.com");
    const dir = memberDir(s.root, user);
    assert.ok(existsSync(join(dir, "desk.sqlite")));
    assert.ok(!readdirSync(join(s.root, "members")).some((name) => name.includes("amy")));
  } finally {
    await s.close();
  }
});
