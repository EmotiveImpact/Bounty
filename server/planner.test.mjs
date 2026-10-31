import test from "node:test";
import assert from "node:assert/strict";
import { offers, defaults, plan } from "./catalog.mjs";
test("cash covers postage, packaging and the whole trip before allocating units", () => {
  const p = plan(offers[0], { ...defaults, budget: 20, travel: 2 });
  assert.equal(p.q, 1);
  assert.equal(
    p.profit,
    p.proceeds - Object.values(p.costs).reduce((a, b) => a + b, 0),
  );
});
test("a heavy item cannot qualify when it exceeds the total carrying limit", () => {
  const p = plan(offers[2], defaults);
  assert.equal(p.q, 0);
  assert.equal(p.profit, 0);
});
test("area and target change eligibility without inventing new sales evidence", () => {
  assert.equal(
    plan(offers[0], { ...defaults, area: "York" }).reason,
    "Outside your area",
  );
  assert.equal(
    plan(offers[0], { ...defaults, target: 100 }).reason,
    "Below hourly target",
  );
});
