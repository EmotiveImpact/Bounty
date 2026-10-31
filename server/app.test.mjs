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
