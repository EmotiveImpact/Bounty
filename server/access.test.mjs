import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { memoryDb, serve } from "./test-support.mjs";
import { accessConfig, publicHosts } from "./access.mjs";

const PASSWORD = "correct horse battery staple";
const echo = {
  routes: () => [
    ["GET", "/api/ping", () => ({ ok: true })],
    ["POST", "/api/echo", ({ body }) => body],
  ],
};
const basic = (user, pass) => "Basic " + Buffer.from(user + ":" + pass).toString("base64");

function raw(base, { method = "GET", path, headers = {}, body = "" }) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("the local default needs no password and no public hosts", () => {
  assert.deepEqual(accessConfig({}), { listenHost: "127.0.0.1", publicHosts: [], password: null });
});

test("listening beyond this machine or naming public hosts needs a long password", () => {
  assert.throws(() => accessConfig({ BOUNTY_LISTEN_HOST: "0.0.0.0" }), /BOUNTY_PASSWORD/);
  assert.throws(() => accessConfig({ BOUNTY_PUBLIC_HOSTS: "bounty.vercel.app" }), /BOUNTY_PASSWORD/);
  assert.throws(
    () => accessConfig({ BOUNTY_LISTEN_HOST: "0.0.0.0", BOUNTY_PASSWORD: "short" }),
    /at least 16/,
  );
  const config = accessConfig({
    BOUNTY_LISTEN_HOST: "0.0.0.0",
    BOUNTY_PUBLIC_HOSTS: " Bounty.vercel.app , api.example.co.uk ",
    BOUNTY_PASSWORD: PASSWORD,
  });
  assert.deepEqual(config.publicHosts, ["bounty.vercel.app", "api.example.co.uk"]);
  assert.equal(config.password, PASSWORD);
});

test("public hosts must be plain host names", () => {
  for (const bad of ["https://bounty.vercel.app", "bounty.vercel.app:443", "bounty.vercel.app/api", "*.vercel.app", "a b"])
    assert.throws(() => publicHosts(bad), /plain host name/, bad);
});

test("with a password every request needs it, and the browser is asked for it", async () => {
  const api = await serve(memoryDb(), [echo], { password: PASSWORD });
  try {
    const none = await raw(api.base, { path: "/api/ping" });
    assert.equal(none.status, 401);
    assert.match(none.headers["www-authenticate"], /^Basic realm="Bounty"/);
    assert.equal(none.headers["cache-control"], "no-store");
    const wrong = await raw(api.base, { path: "/api/ping", headers: { Authorization: basic("x", PASSWORD + "!") } });
    assert.equal(wrong.status, 401);
    const noColon = await raw(api.base, {
      path: "/api/ping",
      headers: { Authorization: "Basic " + Buffer.from(PASSWORD).toString("base64") },
    });
    assert.equal(noColon.status, 401);
    const bearer = await raw(api.base, { path: "/api/ping", headers: { Authorization: "Bearer " + PASSWORD } });
    assert.equal(bearer.status, 401);
    const unknown = await raw(api.base, { path: "/api/none" });
    assert.equal(unknown.status, 401, "unknown routes are not revealed before the password");
    const right = await api.call("GET", "/api/ping", undefined, { Authorization: basic("anyone", PASSWORD) });
    assert.deepEqual(right, { status: 200, body: { ok: true } });
    const write = await api.call("POST", "/api/echo", { a: 1 }, { Authorization: basic("", PASSWORD) });
    assert.deepEqual(write, { status: 200, body: { a: 1 } });
  } finally {
    await api.close();
  }
});

test("named public hosts and origins are accepted, others still refused", async () => {
  const auth = { Authorization: basic("bounty", PASSWORD) };
  const api = await serve(memoryDb(), [echo], {
    password: PASSWORD,
    publicHosts: ["bounty.vercel.app", "bounty-api.up.railway.app"],
  });
  try {
    for (const host of ["bounty.vercel.app", "bounty-api.up.railway.app", "BOUNTY.vercel.app:443"]) {
      const res = await raw(api.base, { path: "/api/ping", headers: { Host: host, ...auth } });
      assert.equal(res.status, 200, host);
    }
    for (const host of ["attacker.example", "bounty.vercel.app.attacker.example", "evil-bounty.vercel.app"]) {
      const res = await raw(api.base, { path: "/api/ping", headers: { Host: host, ...auth } });
      assert.equal(res.status, 403, host);
    }
    const ok = await api.call("POST", "/api/echo", { a: 1 }, { Origin: "https://bounty.vercel.app", ...auth });
    assert.equal(ok.status, 200);
    const foreign = await api.call("POST", "/api/echo", { a: 1 }, { Origin: "https://other.vercel.app", ...auth });
    assert.equal(foreign.status, 403);
    const crossSite = await api.call("POST", "/api/echo", { a: 1 }, { "Sec-Fetch-Site": "cross-site", ...auth });
    assert.equal(crossSite.status, 403);
  } finally {
    await api.close();
  }
});

test("on Vercel the deployment's own host names are accepted without listing them", () => {
  const env = {
    VERCEL: "1",
    VERCEL_URL: "bounty-abc123.vercel.app",
    VERCEL_BRANCH_URL: "bounty-git-main.vercel.app",
    VERCEL_PROJECT_PRODUCTION_URL: "bounty.vercel.app",
    BOUNTY_PASSWORD: PASSWORD,
  };
  assert.deepEqual(accessConfig(env).publicHosts, [
    "bounty-abc123.vercel.app",
    "bounty-git-main.vercel.app",
    "bounty.vercel.app",
  ]);
  // Without VERCEL the variables are ignored, and without a password it refuses.
  assert.deepEqual(accessConfig({ ...env, VERCEL: "" }).publicHosts, []);
  assert.throws(() => accessConfig({ ...env, BOUNTY_PASSWORD: "" }), /BOUNTY_PASSWORD/);
});
