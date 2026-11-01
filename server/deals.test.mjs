import test from "node:test";
import assert from "node:assert/strict";
import { dealFor, dealTravel, listDeals, readDealOptions } from "./deals.mjs";
import { offers } from "./catalog.mjs";
import { HttpError } from "./http.mjs";
import * as dealRoutes from "./routes-deals.mjs";
import { memoryDb, serve } from "./test-support.mjs";

const bySku = Object.fromEntries(offers.map((o) => [o.sku, o]));

test("every offer is listed with no setup, biggest profit a unit first", () => {
  const { deals } = listDeals();
  assert.equal(deals.length, offers.length);
  assert.deepEqual(
    deals.map((d) => [d.sku, d.unitProfit]),
    [
      ["jacket", 713],
      ["pot", 660],
      ["bottle", 572],
      ["knit", 242],
      ["baby", 176],
    ],
  );
  for (const d of deals) assert.equal(d.travel.added, false);
});

test("profit a unit is the completed-sale estimate less the shop price, fees, returns, postage and packaging", () => {
  const d = dealFor(bySku.jacket);
  // Lower median of 28, 29, 30, 31 is £29.
  assert.equal(d.salePrice, 2900);
  assert.deepEqual(d.sales, [2800, 2900, 3000, 3100]);
  // 13% plus 40p fee, clothing at least 15% returns.
  assert.deepEqual(d.costs, { fees: 417, returns: 435, postage: 300, packaging: 35 });
  assert.equal(d.unitProfit, 2900 - 1000 - 417 - 435 - 300 - 35);
  assert.equal(d.underSale, 65);
  assert.equal(d.meetsThresholds, true);
  assert.deepEqual(d.notes, []);
});

test("small profits and heavy items stay listed, with a plain note", () => {
  const { deals } = listDeals();
  const knit = deals.find((d) => d.sku === "knit");
  assert.equal(knit.meetsThresholds, false);
  assert.ok(knit.notes.some((n) => /Profit per unit of £2.42 is below £5.00/.test(n)));
  const pot = deals.find((d) => d.sku === "pot");
  assert.ok(pot.notes.some((n) => /2 kg or more/.test(n)));
  assert.equal(pot.storageNeeds, bySku.pot.storageNeeds);
});

test("a deal with no completed sales is listed last with an unknown profit, never zero", () => {
  const unsold = { ...bySku.bottle, sku: "unsold", name: "Unsold", sales: [] };
  const { deals } = listDeals({}, { offers: [unsold, ...offers] });
  const last = deals.at(-1);
  assert.equal(last.sku, "unsold");
  assert.equal(last.salePrice, null);
  assert.equal(last.unitProfit, null);
  assert.equal(last.costs, null);
  assert.equal(last.meetsThresholds, false);
  assert.ok(last.notes[0].startsWith("No completed sales"));
});

test("travel is shown when added but never changes the profit or the order", () => {
  const plain = listDeals();
  const byCar = listDeals({ transport: "Car", perMile: 45, extra: 100 });
  assert.deepEqual(
    byCar.deals.map((d) => [d.sku, d.unitProfit]),
    plain.deals.map((d) => [d.sku, d.unitProfit]),
  );
  const jacket = byCar.deals.find((d) => d.sku === "jacket");
  // 1.4 miles each way at 45p a mile, plus £1 parking.
  assert.deepEqual(jacket.travel, { added: true, mode: "Car", miles: 1.4, cost: Math.round(2.8 * 45) + 100, minutes: 10 });
});

test("a blank bus fare is unknown, never free; a ticked free fare costs nothing", () => {
  const blank = dealTravel(bySku.jacket, { transport: "Public transport" });
  assert.equal(blank.added, true);
  assert.equal(blank.cost, null);
  assert.equal(dealTravel(bySku.jacket, { transport: "Public transport", fare: 450 }).cost, 450);
  assert.equal(dealTravel(bySku.jacket, { transport: "Public transport", fareFree: true }).cost, 0);
  assert.equal(dealTravel(bySku.jacket, { transport: "Walk" }).cost, 0);
});

test("the member's own fees replace the sample ones, and clothing keeps its returns floor", () => {
  const own = listDeals({ feeRate: 0.1, feeFixed: 0, returnsRate: 0 });
  assert.equal(own.assumptions.ownFees, true);
  const jacket = own.deals.find((d) => d.sku === "jacket");
  assert.equal(jacket.costs.fees, 290);
  assert.equal(jacket.returnsRate, 0.15);
  const bottle = own.deals.find((d) => d.sku === "bottle");
  assert.equal(bottle.costs.returns, 0);
});

test("options are checked", () => {
  assert.deepEqual(readDealOptions(undefined), {});
  assert.throws(() => readDealOptions([]), HttpError);
  assert.throws(() => readDealOptions({ transport: "Rocket" }), HttpError);
  assert.throws(() => readDealOptions({ fare: -1 }), HttpError);
  assert.throws(() => readDealOptions({ fare: 1.5 }), HttpError);
  assert.throws(() => readDealOptions({ feeRate: 0.9 }), HttpError);
  assert.throws(() => readDealOptions({ fareFree: "yes" }), HttpError);
  assert.deepEqual(readDealOptions({ transport: "Walk", fare: null }), { transport: "Walk", fareFree: false });
});

test("GET and POST /api/deals", async () => {
  const api = await serve(memoryDb(), [dealRoutes]);
  try {
    const got = await api.call("GET", "/api/deals");
    assert.equal(got.status, 200);
    assert.equal(got.body.deals[0].sku, "jacket");
    const posted = await api.call("POST", "/api/deals", { transport: "Public transport", fare: 380 });
    assert.equal(posted.status, 200);
    assert.equal(posted.body.deals[0].travel.cost, 380);
    const bad = await api.call("POST", "/api/deals", { transport: "Rocket" });
    assert.equal(bad.status, 400);
  } finally {
    await api.close();
  }
});
