import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb, serve, memoryAccountsStore as memoryStore } from "./test-support.mjs";
import { accounts, checkPassword, hashPassword, readCookie } from "./accounts.mjs";
import { accessConfig } from "./access.mjs";

const INVITE = "flip-together-2026";
const echo = {
  routes: () => [
    ["GET", "/api/ping", () => ({ ok: true })],
    ["POST", "/api/echo", ({ body }) => body],
    ["POST", "/api/work-out", ({ body }) => ({ sum: body.a + body.b }), { read: true }],
  ],
};

// An Admin tool: marked for operators only.
const admin = {
  routes: () => [
    ["GET", "/api/desk", () => ({ desk: true }), { operator: true }],
    ["POST", "/api/desk", ({ body }) => body, { operator: true }],
  ],
};

async function start(options = {}, operators = []) {
  const store = memoryStore();
  const members = accounts(store, { inviteCode: INVITE, ...options });
  const api = await serve(memoryDb(), [echo, admin], { members, password: null, operators });
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
    return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: set };
  };
  return { api, store, call };
}
const sessionCookie = (setCookie) => setCookie.split(";")[0];

test("passwords are stored as scrypt hashes and checked", async () => {
  const stored = await hashPassword("a long enough secret");
  assert.match(stored, /^scrypt\$16384\$8\$1\$/);
  assert.ok(!stored.includes("a long enough secret"));
  assert.equal(await checkPassword("a long enough secret", stored), true);
  assert.equal(await checkPassword("a long enough secreT", stored), false);
  assert.equal(await checkPassword("x", "not a hash"), false);
});

test("cookies are read by exact name", () => {
  const req = { headers: { cookie: "xbounty_session=bad; bounty_session=good; other=1" } };
  assert.equal(readCookie(req), "good");
  assert.equal(readCookie({ headers: {} }), null);
});

test("signed out, anyone can look around but every change asks to sign in", async () => {
  const { api, call } = await start();
  try {
    assert.deepEqual((await call("GET", "/api/ping")).body, { ok: true });
    assert.deepEqual((await call("POST", "/api/work-out", { a: 1, b: 2 })).body, { sum: 3 }, "a read-only POST is open");
    const write = await call("POST", "/api/echo", { a: 1 });
    assert.equal(write.status, 401);
    assert.equal(write.body.signIn, true);
    const me = await call("GET", "/api/auth/me");
    assert.deepEqual(me, { status: 200, body: { required: true, user: null, inviteOpen: true, operator: false, mailOn: false }, setCookie: null });
    const res = await fetch(api.base + "/api/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.headers.get("www-authenticate"), null, "no browser pop-up");
  } finally {
    await api.close();
  }
});

test("sign up with the invite code, stay signed in, then sign out", async () => {
  const { api, store, call } = await start();
  try {
    const wrongCode = await call("POST", "/api/auth/signup", { email: "a@b.co.uk", password: "0123456789", invite: "nope" });
    assert.equal(wrongCode.status, 403);
    const short = await call("POST", "/api/auth/signup", { email: "a@b.co.uk", password: "short", invite: INVITE });
    assert.equal(short.status, 400);
    const badEmail = await call("POST", "/api/auth/signup", { email: "not-an-email", password: "0123456789", invite: INVITE });
    assert.equal(badEmail.status, 400);
    assert.equal(store.users.length, 0);

    const up = await call("POST", "/api/auth/signup", { email: " Edem@Example.co.uk ", password: "0123456789", invite: INVITE, name: "Edem" });
    assert.equal(up.status, 200);
    assert.deepEqual(up.body.user, { email: "edem@example.co.uk", name: "Edem", verified: false });
    assert.match(up.setCookie, /^bounty_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    assert.ok(!up.setCookie.includes("Secure"), "plain http on this machine cannot keep a Secure cookie");
    const cookie = sessionCookie(up.setCookie);
    assert.ok(![...store.sessions.keys()].includes(cookie.split("=")[1]), "only a hash of the token is stored");

    assert.deepEqual((await call("POST", "/api/echo", { a: 1 }, cookie)).body, { a: 1 });
    const me = await call("GET", "/api/auth/me", undefined, cookie);
    assert.deepEqual(me.body, { required: true, user: { email: "edem@example.co.uk", name: "Edem", verified: false }, inviteOpen: true, operator: false, mailOn: false });

    const again = await call("POST", "/api/auth/signup", { email: "edem@example.co.uk", password: "0123456789", invite: INVITE });
    assert.equal(again.status, 409);

    const out = await call("POST", "/api/auth/signout", {}, cookie);
    assert.equal(out.status, 200);
    assert.match(out.setCookie, /^bounty_session=; .*Max-Age=0/);
    assert.equal((await call("POST", "/api/echo", { a: 1 }, cookie)).status, 401);
  } finally {
    await api.close();
  }
});

test("sign in checks the password and slows down repeated guesses", async () => {
  const { api, call } = await start();
  try {
    await call("POST", "/api/auth/signup", { email: "m@b.co.uk", password: "0123456789", invite: INVITE });
    const unknown = await call("POST", "/api/auth/signin", { email: "who@b.co.uk", password: "0123456789" });
    const wrong = await call("POST", "/api/auth/signin", { email: "m@b.co.uk", password: "9876543210" });
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(unknown.body.error, wrong.body.error, "an unknown email reads the same as a wrong password");
    const right = await call("POST", "/api/auth/signin", { email: "M@B.co.uk", password: "0123456789" });
    assert.equal(right.status, 200);
    assert.deepEqual((await call("POST", "/api/echo", { b: 2 }, sessionCookie(right.setCookie))).body, { b: 2 });

    for (let i = 0; i < 8; i++) await call("POST", "/api/auth/signin", { email: "m@b.co.uk", password: "wrong-guess" });
    const locked = await call("POST", "/api/auth/signin", { email: "m@b.co.uk", password: "0123456789" });
    assert.equal(locked.status, 429);
  } finally {
    await api.close();
  }
});

test("sign-up is closed without an invite code; sign-in writes still need JSON", async () => {
  const { api, call } = await start({ inviteCode: null });
  try {
    const me = await call("GET", "/api/auth/me");
    assert.equal(me.body.inviteOpen, false);
    const up = await call("POST", "/api/auth/signup", { email: "a@b.co.uk", password: "0123456789", invite: "" });
    assert.equal(up.status, 403);
    const form = await fetch(api.base + "/api/auth/signin", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "email=a@b.co.uk&password=x",
    });
    assert.equal(form.status, 415);
  } finally {
    await api.close();
  }
});

test("without accounts the app reports that no sign-in is needed", async () => {
  const api = await serve(memoryDb(), [echo]);
  try {
    assert.deepEqual(await api.call("GET", "/api/auth/me"), { status: 200, body: { required: false, user: null, operator: true } });
  } finally {
    await api.close();
  }
});

test("a database URL replaces the shared password for hosted use", () => {
  const config = accessConfig({ BOUNTY_PUBLIC_HOSTS: "bounty.vercel.app", DATABASE_URL: "postgres://x", BOUNTY_INVITE_CODE: INVITE });
  assert.equal(config.databaseUrl, "postgres://x");
  assert.equal(config.inviteCode, INVITE);
  assert.equal(config.password, null);
  assert.throws(() => accessConfig({ DATABASE_URL: "postgres://x", BOUNTY_INVITE_CODE: "short" }), /at least 8/);
});

test("Admin tools answer only a signed-in operator", async () => {
  const { api, call, store } = await start({}, [" Boss@Example.co.uk "]);
  try {
    assert.equal((await call("GET", "/api/desk")).status, 401, "signed out: sign in first, even to read");
    const member = sessionCookie(
      (await call("POST", "/api/auth/signup", { email: "member@example.co.uk", password: "0123456789", invite: INVITE })).setCookie,
    );
    assert.equal((await call("GET", "/api/desk", undefined, member)).status, 403);
    assert.equal((await call("POST", "/api/desk", { a: 1 }, member)).status, 403);
    assert.equal((await call("GET", "/api/auth/me", undefined, member)).body.operator, false);
    const boss = sessionCookie(
      (await call("POST", "/api/auth/signup", { email: "boss@example.co.uk", password: "0123456789", invite: INVITE })).setCookie,
    );
    assert.equal((await call("GET", "/api/auth/me", undefined, boss)).body.operator, false, "mailbox must be verified");
    await store.setVerified((await store.userByEmail("boss@example.co.uk")).id, true);
    assert.equal((await call("GET", "/api/auth/me", undefined, boss)).body.operator, true);
    assert.deepEqual((await call("GET", "/api/desk", undefined, boss)).body, { desk: true });
    assert.deepEqual((await call("POST", "/api/desk", { a: 1 }, boss)).body, { a: 1 });
    assert.deepEqual((await call("POST", "/api/echo", { a: 2 }, member)).body, { a: 2 }, "members still save their own changes");
  } finally {
    await api.close();
  }
});

test("the real Admin routes are marked for operators", async () => {
  const { OPERATOR_ROUTES } = await import("./app.mjs");
  for (const r of ["POST /api/bounties", "POST /api/reports/:id/verify", "POST /api/audit/signoff", "GET /api/sources", "POST /api/permissions"])
    assert.ok(OPERATOR_ROUTES.has(r), r);
  assert.deepEqual(accessConfig({ BOUNTY_OPERATORS: "A@b.co, c@d.co ,," }).operators, ["a@b.co", "c@d.co"]);
});

test("every operator route names a real route", async () => {
  const { OPERATOR_ROUTES, routeModules } = await import("./app.mjs");
  const real = new Set(routeModules.flatMap((m) => m.routes(memoryDb())).map(([method, pattern]) => `${method} ${pattern}`));
  for (const r of OPERATOR_ROUTES) assert.ok(real.has(r), r);
});

test("signed in, a scout profile is linked to the account and only that account acts as it", async () => {
  const { routeModules } = await import("./app.mjs");
  const { openDb } = await import("./db.mjs");
  const store = memoryStore();
  const members = accounts(store, { inviteCode: INVITE });
  const api = await serve(openDb(":memory:"), routeModules, { members, password: null, operators: ["boss@example.co.uk"] });
  const call = async (method, path, body, cookie) => {
    const res = await fetch(api.base + path, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.get("set-cookie") };
  };
  const signUp = async (email) =>
    sessionCookie((await call("POST", "/api/auth/signup", { email, password: "0123456789", invite: INVITE })).setCookie);
  try {
    const ana = await signUp("ana@example.co.uk");
    const ben = await signUp("ben@example.co.uk");
    const boss = await signUp("boss@example.co.uk");
    await store.setVerified((await store.userByEmail("boss@example.co.uk")).id, true);
    assert.deepEqual((await call("GET", "/api/members/me", undefined, ana)).body, { member: null });
    const made = await call("POST", "/api/members", { name: "Ana" }, ana);
    assert.equal(made.status, 201);
    const id = made.body.member.id;
    assert.equal((await call("GET", "/api/members/me", undefined, ana)).body.member.id, id);
    assert.equal((await call("POST", "/api/members", { name: "Ana again" }, ana)).body.member.id, id, "one profile per account");
    assert.equal((await call("PATCH", `/api/members/${id}`, { name: "Ana K" }, ana)).status, 200);
    assert.equal((await call("PATCH", `/api/members/${id}`, { name: "Not Ana" }, ben)).status, 403);
    assert.equal((await call("GET", `/api/members/${id}/alerts`, undefined, ben)).status, 403);
    assert.equal((await call("PATCH", `/api/members/${id}`, { name: "Ana" }, boss)).status, 200, "an operator may act as anyone");
    assert.deepEqual((await call("GET", "/api/members/me")).body, { member: null }, "signed out: no profile");
  } finally {
    await api.close();
  }
});

test("a plan sets the linked profile's tip timing and how many alert areas it may have", async () => {
  const { routeModules } = await import("./app.mjs");
  const { openDb } = await import("./db.mjs");
  const store = memoryStore();
  const members = accounts(store, { inviteCode: INVITE });
  const api = await serve(openDb(":memory:"), routeModules, { members, password: null, operators: [] });
  const call = async (method, path, body, cookie) => {
    const res = await fetch(api.base + path, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.get("set-cookie") };
  };
  try {
    const ana = sessionCookie(
      (await call("POST", "/api/auth/signup", { email: "ana@example.co.uk", password: "0123456789", invite: INVITE })).setCookie,
    );
    assert.equal((await call("POST", "/api/plans/choose", { plan: "starter" }, ana)).status, 200);
    const tooMany = await call("POST", "/api/members", { name: "Ana", alertLocalities: ["Camden", "Hackney"] }, ana);
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.error, /Starter plan covers one area/);
    const made = await call("POST", "/api/members", { name: "Ana", alertLocalities: ["Camden"], paidTier: "diamond" }, ana);
    assert.equal(made.status, 201);
    assert.equal(made.body.member.paid.tier, null, "a member cannot buy a tier by hand; Starter has no early access");
    const id = made.body.member.id;
    await call("POST", "/api/plans/choose", { plan: "plus" }, ana);
    let me = (await call("GET", "/api/members/me", undefined, ana)).body.member;
    assert.equal(me.paid.tier.id, "emerald", "Plus: tips 3 hours early");
    assert.equal((await call("PATCH", `/api/members/${id}`, { alertLocalities: ["Camden", "Hackney", "Brixton"] }, ana)).status, 200);
    assert.equal((await call("PATCH", `/api/members/${id}`, { alertLocalities: ["A", "B", "C", "D"] }, ana)).status, 400);
    await call("POST", "/api/plans/choose", { plan: "fulltime" }, ana);
    me = (await call("GET", "/api/members/me", undefined, ana)).body.member;
    assert.equal(me.paid.tier.id, "diamond", "Full-time: the earliest tips");
    assert.equal((await call("PATCH", `/api/members/${id}`, { alertLocalities: ["A", "B", "C", "D"] }, ana)).status, 200);
  } finally {
    await api.close();
  }
});
