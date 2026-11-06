import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryAccountsStore, serve } from "./test-support.mjs";
import { accounts } from "./accounts.mjs";
import { openDb } from "./db.mjs";
import { routeModules } from "./app.mjs";

const INVITE = "flip-together-2026";

async function start() {
  const members = accounts(memoryAccountsStore(), { inviteCode: INVITE });
  const api = await serve(openDb(":memory:"), routeModules, { members, password: null, operators: ["boss@example.com"] });
  const call = async (method, path, body, cookie) => {
    const res = await fetch(api.base + path, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const set = res.headers.get("set-cookie");
    return { status: res.status, body: text ? JSON.parse(text) : null, cookie: set ? set.split(";")[0] : null };
  };
  const join = async (email) =>
    (await call("POST", "/api/auth/signup", { email, password: "a long enough secret", invite: INVITE })).cookie;
  return { api, call, join };
}

test("anyone can send a Help message, even signed out, and only operators read them", async () => {
  const { api, call, join } = await start();
  try {
    const sent = await call("POST", "/api/help", { topic: "account", email: "Amy@Example.com", message: "I can't sign in" });
    assert.equal(sent.status, 201);
    assert.equal((await call("POST", "/api/help", { email: "amy@example.com", message: "hi" })).status, 400, "too short");
    assert.equal((await call("POST", "/api/help", { email: "nope", message: "A real question" })).status, 400);
    assert.equal((await call("GET", "/api/help")).status, 401);
    const amy = await join("amy@example.com");
    assert.equal((await call("GET", "/api/help", undefined, amy)).status, 403);
    const boss = await join("boss@example.com");
    const list = await call("GET", "/api/help", undefined, boss);
    assert.equal(list.status, 200);
    assert.equal(list.body.messages[0].email, "amy@example.com");
    assert.equal(list.body.messages[0].topic, "account");
    assert.equal((await call("POST", `/api/help/${sent.body.id}/done`, {}, boss)).status, 200);
    assert.ok((await call("GET", "/api/help", undefined, boss)).body.messages[0].done_at);
  } finally {
    await api.close();
  }
});

test("a flood of messages from one address is refused", async () => {
  const { api, call } = await start();
  try {
    for (let i = 0; i < 5; i += 1)
      assert.equal((await call("POST", "/api/help", { email: "x@example.com", message: "Message number " + i })).status, 201);
    assert.equal((await call("POST", "/api/help", { email: "x@example.com", message: "One more message" })).status, 429);
  } finally {
    await api.close();
  }
});
