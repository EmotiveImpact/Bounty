import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { memoryDb, serve } from "./test-support.mjs";
import { fail, reply } from "./http.mjs";

const echo = {
  routes: () => [
    ["GET", "/api/items/:id", ({ params }) => ({ id: params.id })],
    ["POST", "/api/items", ({ body }) => reply(201, body)],
    ["POST", "/api/bad", () => fail("Nope")],
    ["GET", "/api/crash", () => {
      throw Error("secret detail");
    }],
  ],
};

function raw(base, { method = "GET", path, headers = {}, body = "" }) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method, path, headers },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("router matches parameters, statuses and unknown routes", async () => {
  const api = await serve(memoryDb(), [echo]);
  try {
    assert.deepEqual((await api.call("GET", "/api/items/a%20b")).body, {
      id: "a b",
    });
    const created = await api.call("POST", "/api/items", { x: 1 });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body, { x: 1 });
    assert.equal((await api.call("POST", "/api/bad", {})).status, 400);
    assert.equal((await api.call("GET", "/api/none")).status, 404);
    assert.equal((await api.call("DELETE", "/api/items/1", {})).status, 405);
    const crash = await api.call("GET", "/api/crash");
    assert.equal(crash.status, 500);
    assert.ok(!JSON.stringify(crash.body).includes("secret"));
  } finally {
    await api.close();
  }
});

test("rejects foreign hosts, foreign origins and non-JSON writes", async () => {
  const api = await serve(memoryDb(), [echo]);
  try {
    const rebound = await raw(api.base, {
      path: "/api/items/1",
      headers: { Host: "attacker.example" },
    });
    assert.equal(rebound.status, 403);
    const foreign = await api.call(
      "POST",
      "/api/items",
      { x: 1 },
      { Origin: "https://attacker.example" },
    );
    assert.equal(foreign.status, 403);
    const form = await raw(api.base, {
      method: "POST",
      path: "/api/items",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "x=1",
    });
    assert.equal(form.status, 415);
    const local = await api.call(
      "POST",
      "/api/items",
      { x: 2 },
      { Origin: "http://localhost:5173" },
    );
    assert.equal(local.status, 201);
  } finally {
    await api.close();
  }
});

const limited = {
  routes: () => [
    ["POST", "/api/small", ({ body }) => body, { limit: 64 }],
    ["POST", "/api/default", ({ body }) => ({ size: JSON.stringify(body).length })],
    ["PUT", "/api/items/:id", ({ params }) => ({ id: params.id })],
    ["DELETE", "/api/items/:id", ({ params }) => ({ id: params.id })],
    ["POST", "/api/echo", ({ body }) => body],
  ],
};

test("bodies over the route limit or the default limit get 413", async () => {
  const api = await serve(memoryDb(), [limited]);
  try {
    assert.equal((await api.call("POST", "/api/small", { x: "a".repeat(40) })).status, 200);
    assert.equal((await api.call("POST", "/api/small", { x: "a".repeat(80) })).status, 413);
    assert.equal((await api.call("POST", "/api/default", { x: "a".repeat(60000) })).status, 200);
    assert.equal((await api.call("POST", "/api/default", { x: "a".repeat(70000) })).status, 413);
    // The limit counts bytes, not characters: 40 two-byte characters are
    // more than 64 bytes.
    assert.equal((await api.call("POST", "/api/small", { x: "é".repeat(40) })).status, 413);
    const bad = await raw(api.base, {
      method: "POST",
      path: "/api/echo",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(bad.status, 400);
  } finally {
    await api.close();
  }
});

test("a character split across two body chunks is kept intact", async () => {
  const api = await serve(memoryDb(), [limited]);
  try {
    const { port } = new URL(api.base);
    const body = Buffer.from(JSON.stringify({ name: "Zoë £5 shelf" }));
    const split = body.indexOf(Buffer.from("£")) + 1; // inside the two bytes of £
    const text = await new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/api/echo",
          headers: { "Content-Type": "application/json", "Content-Length": body.length },
        },
        (res) => {
          let t = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (t += c));
          res.on("end", () => resolve(t));
        },
      );
      req.on("error", reject);
      req.write(body.subarray(0, split));
      setTimeout(() => req.end(body.subarray(split)), 20);
    });
    assert.equal(JSON.parse(text).name, "Zoë £5 shelf");
  } finally {
    await api.close();
  }
});

test("cross-site PUT and DELETE are refused, and so are lookalike hosts and types", async () => {
  const api = await serve(memoryDb(), [limited]);
  try {
    for (const method of ["PUT", "DELETE"]) {
      const res = await api.call(method, "/api/items/1", {}, { Origin: "https://attacker.example" });
      assert.equal(res.status, 403, method);
    }
    const marked = await api.call("POST", "/api/echo", {}, { "Sec-Fetch-Site": "cross-site" });
    assert.equal(marked.status, 403);
    const sameOrigin = await api.call("POST", "/api/echo", { a: 1 }, { "Sec-Fetch-Site": "same-origin" });
    assert.equal(sameOrigin.status, 200);
    const nullOrigin = await api.call("POST", "/api/echo", {}, { Origin: "null" });
    assert.equal(nullOrigin.status, 403);
    for (const origin of [
      "http://evil-localhost:5173",
      "http://localhost.evil.example",
      "http://localhost:5173.evil.example",
      "http://127.0.0.1.evil.example",
      "http://0x7f.1:5173",
      "http://2130706433",
      "http://127.1",
      "localhost:5173",
      "http://localhost:5173/path",
    ]) {
      const res = await api.call("POST", "/api/echo", {}, { Origin: origin });
      assert.equal(res.status, 403, origin);
    }
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:4174", "http://[::1]:5173"]) {
      const res = await api.call("POST", "/api/echo", { a: 1 }, { Origin: origin });
      assert.equal(res.status, 200, origin);
    }
    for (const host of ["localhost.attacker.example", "127.0.0.1.attacker.example", "attacker.example:4174", "0x7f.1", "2130706433", "127.1", "localhost:4174:1"]) {
      const res = await raw(api.base, { path: "/api/items/1", headers: { Host: host } });
      assert.equal(res.status, 403, host);
    }
    for (const host of ["localhost:4174", "127.0.0.1", "[::1]:4174"]) {
      const res = await raw(api.base, { method: "PUT", path: "/api/items/7", headers: { Host: host, "Content-Type": "application/json" }, body: "{}" });
      assert.equal(res.status, 200, host);
    }
    const disguised = await raw(api.base, {
      method: "POST",
      path: "/api/echo",
      headers: { "Content-Type": "text/plain; x=application/json" },
      body: "{}",
    });
    assert.equal(disguised.status, 415);
  } finally {
    await api.close();
  }
});

test("every response is JSON, uncached and marked nosniff", async () => {
  const api = await serve(memoryDb(), [echo]);
  try {
    for (const path of ["/api/items/1", "/api/none", "/api/crash"]) {
      const res = await fetch(api.base + path);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
      assert.equal(res.headers.get("cache-control"), "no-store", path);
      assert.match(res.headers.get("content-type"), /^application\/json/, path);
    }
  } finally {
    await api.close();
  }
});

test("impossible calendar dates are a 400, never a crash", async () => {
  const { isoDate, isCalendarDate, HttpError } = await import("./http.mjs");
  for (const value of ["2026-13-01", "2027-00-10", "2026-12-32", "2026-02-30", "2026-1-01", 20261101, null]) {
    assert.equal(isCalendarDate(value), false, String(value));
    assert.throws(() => isoDate(value, "date"), (e) => e instanceof HttpError && e.status === 400);
  }
  assert.equal(isoDate("2028-02-29", "date"), "2028-02-29");
  assert.equal(isoDate("", "date", { optional: true }), null);
});
