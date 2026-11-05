// The made-up development samples: 30 extra deals with a photo each, and
// example tips that are labelled sample and never doubled on restart.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { openDb } from "./db.mjs";
import { offers } from "./catalog.mjs";
import { allSampleOffers, moreOffers } from "./sample-deals.mjs";
import { seedSampleTips } from "./sample-tips.mjs";
import { listDeals } from "./deals.mjs";

test("30 extra sample deals, each labelled sample with its own photo", () => {
  assert.equal(moreOffers.length, 30);
  assert.equal(offers.length, 5, "the planner keeps its original five");
  const skus = allSampleOffers.map((o) => o.sku);
  assert.equal(new Set(skus).size, skus.length, "every sku is unique");
  for (const o of allSampleOffers) {
    assert.equal(o.sample, true, o.sku);
    assert.ok(existsSync(new URL(`../web/public/products/${o.sku}.jpg`, import.meta.url)), `photo for ${o.sku}`);
    if (o.category === "clothing") assert.ok(o.size, `${o.sku} needs a size`);
  }
  assert.ok(new Set(allSampleOffers.map((o) => o.shop)).size >= 12, "spread across at least 12 shops");
  const { deals } = listDeals({}, { offers: allSampleOffers });
  assert.equal(deals.length, 35);
  assert.ok(deals.every((d) => d.sample === true));
});

test("example tips are sample bounties added once", () => {
  const db = openDb();
  const now = "2026-11-02T10:00:00.000Z";
  assert.equal(seedSampleTips(db, { now }), 8);
  assert.equal(seedSampleTips(db, { now }), 0, "a restart never doubles them");
  const rows = db.prepare("SELECT sample, status FROM bounties").all();
  assert.equal(rows.length, 8);
  assert.ok(rows.every((r) => r.sample === 1 && r.status === "open"));
  // Once every example has ended, a fresh set is added.
  assert.equal(seedSampleTips(db, { now: "2026-11-20T10:00:00.000Z" }), 8);
});
