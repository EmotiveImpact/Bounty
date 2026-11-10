import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryAccountsStore, serve } from "./test-support.mjs";
import { accounts } from "./accounts.mjs";
import { mailer } from "./mail.mjs";
import { openDb } from "./db.mjs";
import { routeModules } from "./app.mjs";
import { personalStores, memberDir } from "./personal.mjs";

const INVITE = "flip-together-2026";
const PASSWORD = "a long enough secret";

async function start({ mailOn = true, operators = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bounty-account-"));
  const store = memoryAccountsStore();
  const outbox = [];
  const mail = mailOn
    ? mailer({
        apiKey: "test",
        from: "Bounty <hello@example.com>",
        send: async (url, init) => (outbox.push(JSON.parse(init.body)), { ok: true }),
      })
    : mailer({ apiKey: "", from: "" });
  const members = accounts(store, { inviteCode: INVITE, mail });
  const own = personalStores(root);
  const db = openDb(":memory:");
  const api = await serve(db, routeModules, {
    members,
    password: null,
    operators,
    personal: own.personal,
    forget: own.forget,
  });
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
    const set = res.headers.get("set-cookie");
    return { status: res.status, body: text ? JSON.parse(text) : null, cookie: set ? set.split(";")[0] : null };
  };
  const join_ = async (email) => {
    const cookie = (await call("POST", "/api/auth/signup", { email, password: PASSWORD, invite: INVITE })).cookie;
    if (operators.includes(email)) await store.setVerified((await store.userByEmail(email)).id, true);
    return cookie;
  };
  const linkToken = (message, kind) => new RegExp(`#${kind}=([A-Za-z0-9_-]+)`).exec(message.text)[1];
  return {
    root,
    db,
    store,
    outbox,
    call,
    join: join_,
    linkToken,
    async close() {
      await api.close();
      own.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("sign-up sends a confirm email, and the link confirms it once", async () => {
  const s = await start();
  try {
    const cookie = await s.join("amy@example.com");
    assert.equal(s.outbox.length, 1);
    assert.match(s.outbox[0].subject, /Confirm your email/);
    assert.equal((await s.call("GET", "/api/auth/me", undefined, cookie)).body.user.verified, false);
    const token = s.linkToken(s.outbox[0], "verify");
    assert.equal((await s.call("POST", "/api/auth/verify", { token })).status, 200);
    assert.equal((await s.call("GET", "/api/auth/me", undefined, cookie)).body.user.verified, true);
    assert.equal((await s.call("POST", "/api/auth/verify", { token })).status, 400, "a link works once");
  } finally {
    await s.close();
  }
});

test("forgot password answers the same whether or not the email has an account", async () => {
  const s = await start();
  try {
    await s.join("amy@example.com");
    const asked = await s.call("POST", "/api/auth/forgot", { email: "amy@example.com" });
    assert.deepEqual(asked.body, { sent: true, mailOn: true });
    const unknown = await s.call("POST", "/api/auth/forgot", { email: "nobody@example.com" });
    assert.deepEqual(unknown.body, asked.body, "the same answer, so it does not reveal who has an account");
    const reset = s.outbox.find((m) => /Reset your/.test(m.subject));
    assert.ok(reset);
    assert.equal(s.outbox.filter((m) => /Reset your/.test(m.subject)).length, 1, "no email for an unknown address");
  } finally {
    await s.close();
  }
});

test("a reset link survives a refused password and then works once", async () => {
  const s = await start();
  try {
    const old = await s.join("amy@example.com");
    await s.call("POST", "/api/auth/forgot", { email: "amy@example.com" });
    const token = s.linkToken(s.outbox.find((m) => /Reset your/.test(m.subject)), "reset");
    assert.equal((await s.call("POST", "/api/auth/reset", { token, password: "short" })).status, 400);
    const done = await s.call("POST", "/api/auth/reset", { token, password: "a brand new password" });
    assert.equal(done.status, 200);
    assert.ok(done.cookie, "signed in on this device");
    assert.equal((await s.call("GET", "/api/auth/me", undefined, old)).body.user, null, "old sessions end");
    assert.equal((await s.call("POST", "/api/auth/reset", { token, password: "another new password" })).status, 400);
    const signIn = await s.call("POST", "/api/auth/signin", { email: "amy@example.com", password: "a brand new password" });
    assert.equal(signIn.status, 200);
  } finally {
    await s.close();
  }
});

test("with email off, forgot password says so and an operator can make a link", async () => {
  const s = await start({ mailOn: false, operators: ["boss@example.com"] });
  try {
    await s.join("amy@example.com");
    const boss = await s.join("boss@example.com");
    assert.deepEqual((await s.call("POST", "/api/auth/forgot", { email: "amy@example.com" })).body, {
      sent: false,
      mailOn: false,
    });
    const amyCookie = (await s.call("POST", "/api/auth/signin", { email: "amy@example.com", password: PASSWORD })).cookie;
    assert.equal((await s.call("POST", "/api/account/reset-link", { email: "amy@example.com" }, amyCookie)).status, 403);
    const made = await s.call("POST", "/api/account/reset-link", { email: "amy@example.com" }, boss);
    assert.equal(made.status, 200);
    const token = /#reset=([A-Za-z0-9_-]+)/.exec(made.body.link)[1];
    assert.equal((await s.call("POST", "/api/auth/reset", { token, password: "a brand new password" })).status, 200);
  } finally {
    await s.close();
  }
});

test("changing the password asks for the current one", async () => {
  const s = await start();
  try {
    const cookie = await s.join("amy@example.com");
    const wrong = await s.call("POST", "/api/account/password", { current: "nope", password: "a brand new password" }, cookie);
    assert.equal(wrong.status, 401);
    const ok = await s.call("POST", "/api/account/password", { current: PASSWORD, password: "a brand new password" }, cookie);
    assert.equal(ok.status, 200);
    assert.equal((await s.call("GET", "/api/auth/me", undefined, ok.cookie)).body.user.email, "amy@example.com");
  } finally {
    await s.close();
  }
});

test("changing email keeps Stock and Money and sends a confirm email to the new address", async () => {
  const s = await start();
  try {
    const cookie = await s.join("amy@example.com");
    await s.call("POST", "/api/goals/targets", { name: "Holiday", amount: 50000, start: "2026-01-01" }, cookie);
    const taken = await s.join("ben@example.com");
    assert.ok(taken);
    assert.equal(
      (await s.call("POST", "/api/account/email", { password: PASSWORD, email: "ben@example.com" }, cookie)).status,
      409,
    );
    const moved = await s.call("POST", "/api/account/email", { password: PASSWORD, email: "amy@newmail.com" }, cookie);
    assert.equal(moved.status, 200);
    assert.equal(moved.body.user.email, "amy@newmail.com");
    assert.equal(s.outbox.at(-1).to[0], "amy@newmail.com");
    const targets = (await s.call("GET", "/api/goals/targets", undefined, cookie)).body.targets;
    assert.deepEqual(
      targets.map((t) => t.name),
      ["Holiday"],
    );
  } finally {
    await s.close();
  }
});

test("download my data has the account, Money and Stock", async () => {
  const s = await start();
  try {
    const cookie = await s.join("amy@example.com");
    await s.call("POST", "/api/goals/targets", { name: "Holiday", amount: 50000, start: "2026-01-01" }, cookie);
    assert.equal((await s.call("GET", "/api/account/export")).status, 401);
    const data = (await s.call("GET", "/api/account/export", undefined, cookie)).body;
    assert.equal(data.account.email, "amy@example.com");
    assert.equal(data.account.password_hash, undefined, "never the password hash");
    assert.deepEqual(
      data.money.targets.targets.map((t) => t.name),
      ["Holiday"],
    );
    assert.deepEqual(data.stock.trips, []);
  } finally {
    await s.close();
  }
});

test("deleting the account removes it, its Stock and Money, and signs out", async () => {
  const s = await start();
  try {
    const cookie = await s.join("amy@example.com");
    await s.call("POST", "/api/goals/targets", { name: "Holiday", amount: 50000, start: "2026-01-01" }, cookie);
    const user = s.store.users.find((u) => u.email === "amy@example.com");
    const dir = memberDir(s.root, user);
    assert.ok(existsSync(dir));
    assert.equal((await s.call("POST", "/api/account/delete", { password: "wrong" }, cookie)).status, 401);
    const gone = await s.call("POST", "/api/account/delete", { password: PASSWORD }, cookie);
    assert.equal(gone.status, 200);
    assert.equal(existsSync(dir), false);
    assert.equal(s.store.users.some((u) => u.email === "amy@example.com"), false);
    assert.equal((await s.call("GET", "/api/auth/me", undefined, cookie)).body.user, null);
  } finally {
    await s.close();
  }
});
