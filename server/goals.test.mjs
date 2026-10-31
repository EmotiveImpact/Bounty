import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb, serve } from "./test-support.mjs";
import { HttpError } from "./http.mjs";
import { defaults, journeyFor, offers } from "./catalog.mjs";
import {
  BASKET_SEARCH,
  DEFAULT_GOALS,
  basketOptions,
  cashTiming,
  getGoals,
  payoutDate,
  saveGoals,
  schema,
} from "./goals.mjs";
import * as planRoutes from "./routes-plan.mjs";

const NOW = "2026-10-31T12:00:00Z"; // a Saturday
const goals = (over = {}) => ({ ...DEFAULT_GOALS, dispatchDays: [1, 2, 3, 4, 5], ...over });
const validGoals = {
  targetType: "income",
  monthlyTarget: 30000,
  dispatchDays: [1, 3, 5],
  storageUnits: 12,
  cashNeededBy: "2026-11-30",
  daysToSell: 7,
  deliveryDays: 2,
  payoutDelayDays: 3,
};

// Test-only offers: £10 a unit with no parcel or packaging cost, so each unit
// needs exactly £10 of cash and nets a known margin.
const item = (over) => ({
  sku: "a",
  name: "Item A",
  variant: "Test",
  shop: "Shop A",
  area: "Leeds",
  miles: 1,
  buy: 1000,
  sales: [3000],
  post: 0,
  pack: 0,
  weight: 0.5,
  stock: 5,
  handlingMinutes: 5,
  sample: true,
  ...over,
});
const A = item({});
const B = item({ sku: "b", name: "Item B", shop: "Shop B", miles: 2, sales: [2800] });
const profile = (over = {}) => ({
  ...defaults,
  budget: 2500,
  carry: 10,
  quantity: 10,
  storage: 10,
  target: 0,
  ...over,
});

test("schema is idempotent and migrates an older goals table in place", () => {
  const db = memoryDb();
  db.exec("CREATE TABLE goals (id INTEGER PRIMARY KEY, monthly_target INTEGER)");
  db.exec("INSERT INTO goals (id, monthly_target) VALUES (1, 5000)");
  schema(db);
  schema(db);
  const g = getGoals(db);
  assert.equal(g.monthlyTarget, 5000, "existing value kept");
  assert.equal(g.targetType, "income");
  assert.deepEqual(g.dispatchDays, [1, 2, 3, 4, 5]);
  assert.equal(g.daysToSell, 7);
  assert.equal(g.deliveryDays, 2);
  assert.equal(g.payoutDelayDays, 2);
});

test("goals default until saved, then round-trip", () => {
  const db = memoryDb(schema);
  const empty = getGoals(db);
  assert.equal(empty.updated, null);
  assert.equal(empty.cashNeededBy, null);
  assert.equal(empty.daysToSell, 7);
  const saved = saveGoals(db, { ...validGoals, dispatchDays: [5, 1, 3] }, { now: NOW });
  assert.deepEqual(saved.dispatchDays, [1, 3, 5]);
  assert.equal(saved.monthlyTarget, 30000);
  assert.equal(saved.cashNeededBy, "2026-11-30");
  assert.equal(saved.updated, NOW);
  const again = saveGoals(db, { ...validGoals, targetType: "savings", cashNeededBy: null }, { now: NOW });
  assert.equal(again.targetType, "savings");
  assert.equal(again.cashNeededBy, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM goals").get().n, 1, "one settings row");
});

test("goals are validated", () => {
  const db = memoryDb(schema);
  for (const [field, value] of [
    ["targetType", "profit"],
    ["monthlyTarget", -1],
    ["monthlyTarget", 10.5],
    ["dispatchDays", [7]],
    ["dispatchDays", [1, 1]],
    ["dispatchDays", "1,2"],
    ["dispatchDays", [1.5]],
    ["storageUnits", -2],
    ["cashNeededBy", "2026-02-30"],
    ["cashNeededBy", "2026-10-30"], // before today
    ["daysToSell", -1],
    ["deliveryDays", "2"],
    ["payoutDelayDays", undefined],
  ])
    assert.throws(
      () => saveGoals(db, { ...validGoals, [field]: value }, { now: NOW }),
      HttpError,
      field + "=" + JSON.stringify(value),
    );
  assert.throws(() => saveGoals(db, null, { now: NOW }), HttpError);
  assert.equal(getGoals(db).updated, null, "nothing saved");
  // Today is allowed, and an empty list of dispatch days can be saved.
  const ok = saveGoals(db, { ...validGoals, cashNeededBy: "2026-10-31", dispatchDays: [] }, { now: NOW });
  assert.deepEqual(ok.dispatchDays, []);
});

test("payout comes on the first dispatch day after the sale, plus delivery and payout delay", () => {
  // 2026-11-02 is a Monday; a sale 7 days later is Monday 9 November.
  const wed = payoutDate({ start: "2026-11-02", daysToSell: 7, dispatchDays: [3], deliveryDays: 2, payoutDelayDays: 2 });
  assert.equal(wed.sold, "2026-11-09");
  assert.equal(wed.dispatch, "2026-11-11");
  assert.equal(wed.delivered, "2026-11-13");
  assert.equal(wed.date, "2026-11-15");
  const mon = payoutDate({ start: "2026-11-02", daysToSell: 7, dispatchDays: [1, 3], deliveryDays: 2, payoutDelayDays: 2 });
  assert.equal(mon.dispatch, "2026-11-09", "a dispatch day on the sale day is used");
  assert.equal(mon.date, "2026-11-13");
  const sat = payoutDate({ start: "2026-11-02", daysToSell: 7, dispatchDays: [6], deliveryDays: 0, payoutDelayDays: 0 });
  assert.equal(sat.date, "2026-11-14");
});

test("no dispatch days means the payout cannot be scheduled", () => {
  const p = payoutDate({ start: "2026-11-02", daysToSell: 7, dispatchDays: [], deliveryDays: 2, payoutDelayDays: 2 });
  assert.equal(p.date, null);
  assert.match(p.note, /No dispatch days/);
  const t = cashTiming({ payoutDate: p.date, cashNeededBy: "2026-11-30" });
  assert.equal(t.status, "unknown");
  assert.match(t.note, /unknown/);
});

test("cash timing reports late, on time and unknown", () => {
  const late = cashTiming({ payoutDate: "2026-11-15", cashNeededBy: "2026-11-12" });
  assert.equal(late.status, "late");
  assert.equal(late.daysLate, 3);
  assert.match(late.note, /3 days after/);
  assert.equal(cashTiming({ payoutDate: "2026-11-12", cashNeededBy: "2026-11-12" }).status, "on time");
  assert.equal(cashTiming({ payoutDate: "2026-11-10", cashNeededBy: "2026-11-12" }).status, "on time");
  const none = cashTiming({ payoutDate: "2026-11-10", cashNeededBy: null });
  assert.equal(none.status, "unknown");
  assert.equal(none.daysLate, null);
});

test("baskets share one cash limit across every item", () => {
  // Either item alone could take two units (£20 of £25), but not together.
  const r = basketOptions([A, B], profile(), goals(), { now: NOW });
  assert.equal(r.sample, true);
  assert.ok(r.baskets.length > 0 && r.baskets.length <= BASKET_SEARCH.top);
  for (const b of r.baskets) {
    assert.ok(b.economics.cashRequired <= 2500, b.id);
    assert.ok(b.units <= 2, b.id);
  }
  assert.equal(r.baskets[0].id, "a:2", "highest contribution first");
  assert.equal(r.bestSingle.id, "a:2");
  assert.ok(r.baskets.some((b) => b.items.length === 2), "a mixed basket is compared");
  // Cash includes the one shared journey: by car £25 no longer covers two units.
  const car = basketOptions([A, B], profile({ transport: "Car", budget: 2000 }), goals(), { now: NOW });
  for (const b of car.baskets) assert.ok(b.economics.cashRequired <= 2000);
  assert.ok(car.baskets.every((b) => b.units === 1));
});

test("baskets respect the carry limit and the smaller storage setting", () => {
  const carry = basketOptions([A, B], profile({ carry: 1, budget: 100000 }), goals(), { now: NOW });
  for (const b of carry.baskets) assert.ok(b.weightKg <= 1 && b.units <= 2, b.id);
  const storage = basketOptions([A, B], profile({ budget: 100000 }), goals({ storageUnits: 1 }), { now: NOW });
  assert.equal(storage.constraints.storage, 1);
  for (const b of storage.baskets) assert.equal(b.units, 1);
  const quantity = basketOptions([A, B], profile({ budget: 100000, quantity: 3 }), goals(), { now: NOW });
  for (const b of quantity.baskets) assert.ok(b.units <= 3);
});

test("a basket makes one journey: the furthest shop plus a detour per extra shop", () => {
  const p = profile({ transport: "Car", perMile: 45, extra: 150, budget: 100000 });
  const r = basketOptions([A, B], p, goals(), { now: NOW });
  const mixed = r.baskets.find((b) => b.items.length === 2);
  assert.ok(mixed, "a two-shop basket is in the top five");
  const expected = journeyFor(p, 2 + BASKET_SEARCH.extraShopMiles);
  assert.equal(mixed.journey.cost, expected.cost);
  assert.equal(mixed.journey.minutes, expected.minutes + BASKET_SEARCH.extraShopMinutes);
  assert.equal(mixed.economics.costs.travel, expected.cost, "travel charged once");
  assert.ok(expected.cost < journeyFor(p, 1).cost + journeyFor(p, 2).cost, "not two journeys");
  assert.equal(
    mixed.items.reduce((s, it) => s + it.travelShare, 0),
    expected.cost,
    "item shares add up to the one journey",
  );
  assert.equal(
    mixed.economics.cashRequired,
    mixed.items.reduce((s, it) => s + it.units * 1000, 0) + expected.cost,
  );
  // Two items from the same shop need no detour.
  const sameShop = basketOptions([A, { ...B, shop: "Shop A", miles: 1 }], p, goals(), { now: NOW });
  const both = sameShop.baskets.find((b) => b.items.length === 2);
  assert.equal(both.journey.extraShops, 0);
  assert.equal(both.journey.cost, journeyFor(p, 1).cost);
});

test("baskets show the downside if nothing sells and if half sells", () => {
  const r = basketOptions([A, B], profile({ transport: "Car" }), goals(), { now: NOW });
  for (const b of r.baskets) {
    const c = b.economics.costs;
    assert.equal(b.downside.nothingSells, -(c.stock + c.packaging + c.travel));
    assert.ok(b.downside.halfSells < b.economics.contribution);
    assert.equal(b.economics.unsoldLoss, b.downside.nothingSells);
  }
});

test("a basket that loses money is never recommended", () => {
  // A £300 fare is more than ten units can earn, so every basket loses money.
  const p = profile({ transport: "Public transport", fare: 30000, budget: 100000 });
  const r = basketOptions([A, B], p, goals(), { now: NOW });
  assert.ok(r.baskets.length > 0);
  assert.ok(r.baskets.every((b) => b.economics.contribution <= 0));
  assert.equal(r.recommended, null);
  assert.ok(r.baskets.every((b) => !b.recommended && b.reasons.includes("Loses money")));
  assert.equal(r.bestSingle.recommended, false);
  // Only the sample jacket clears the buying thresholds, so a recommended
  // sample basket holds jackets alone and stays labelled as sample data.
  const sample = basketOptions(offers, { ...defaults }, goals(), { now: NOW });
  assert.equal(sample.sample, true);
  const pick = sample.baskets.find((b) => b.recommended);
  if (pick) {
    assert.ok(pick.economics.contribution > 0);
    assert.ok(pick.items.every((i) => i.sku === "jacket" || i.units === 0));
  }
});

test("the recommended basket is positive, meets the targets and pays out on time", () => {
  const p = profile({ budget: 100000, target: 1200 });
  const onTime = basketOptions([A, B], p, goals({ cashNeededBy: "2026-12-31" }), { now: NOW });
  const pick = onTime.baskets.find((b) => b.recommended);
  assert.ok(pick, "a basket is recommended");
  assert.equal(onTime.recommended, pick.id);
  assert.ok(pick.economics.contribution > 0);
  assert.ok(pick.economics.hourly >= 1200);
  assert.deepEqual(pick.reasons, []);
  assert.equal(onTime.baskets.filter((b) => b.recommended).length, 1);
  // Needing the cash before the payout blocks the recommendation.
  const late = basketOptions([A, B], p, goals({ cashNeededBy: "2026-11-03" }), { now: NOW });
  assert.equal(late.timing.cash.status, "late");
  assert.equal(late.recommended, null);
  assert.ok(late.baskets.every((b) => b.reasons.some((r) => r.includes("after you need the cash"))));
  // With a cash date but no dispatch days the payout is unknown, so nothing is recommended.
  const unknown = basketOptions([A, B], p, goals({ cashNeededBy: "2026-12-31", dispatchDays: [] }), { now: NOW });
  assert.equal(unknown.timing.payout.date, null);
  assert.equal(unknown.recommended, null);
});

test("only offers in the area are searched, at most eight", () => {
  const away = { ...B, sku: "york", area: "York" };
  const r = basketOptions([A, away], profile(), goals(), { now: NOW });
  assert.deepEqual(r.excluded.map((e) => [e.sku, e.reason]), [["york", "Outside your area"]]);
  assert.ok(r.baskets.every((b) => b.items.every((it) => it.sku !== "york")));
  const many = Array.from({ length: 10 }, (_, i) =>
    item({ sku: "s" + i, shop: "Shop " + i, stock: 1, sales: [2000 + i * 100] }),
  );
  const big = basketOptions(many, profile({ budget: 100000 }), goals(), { now: NOW });
  const skipped = big.excluded.filter((e) => e.reason.includes("strongest"));
  assert.deepEqual(skipped.map((e) => e.sku).sort(), ["s0", "s1"], "the weakest two are left out");
  assert.equal(big.truncated, false);
});

test("plan, goals and baskets routes validate their input", async () => {
  const db = memoryDb(schema);
  const api = await serve(db, [planRoutes]);
  try {
    const plan = await api.call("POST", "/api/plan", { ...defaults, rules: { minUnitPrice: 100 } });
    assert.equal(plan.status, 200);
    assert.equal(plan.body.sample, true);
    assert.equal(plan.body.trips.length, 4);
    assert.ok(plan.body.trips.every((t) => t.alert.eligible === false && t.opportunity.tier));
    assert.ok(plan.body.trips.every((t) => t.compare.heading === "What changes if I drive?"));
    assert.deepEqual(plan.body.rules.ignored.map((i) => i.key), ["minUnitPrice"]);
    for (const bad of [
      { ...defaults, transport: "Rocket" },
      { ...defaults, quantity: 0 },
      { ...defaults, budget: 99.5 },
      { ...defaults, rules: { loosenEverything: true } },
      { ...defaults, rules: { minReturn: -1 } },
      [],
    ])
      assert.equal((await api.call("POST", "/api/plan", bad)).status, 400, JSON.stringify(bad));

    const initial = await api.call("GET", "/api/goals");
    assert.equal(initial.status, 200);
    assert.equal(initial.body.updated, null);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const put = await api.call("PUT", "/api/goals", { ...validGoals, cashNeededBy: tomorrow });
    assert.equal(put.status, 200);
    assert.equal(put.body.cashNeededBy, tomorrow);
    assert.equal((await api.call("PUT", "/api/goals", { ...validGoals, dispatchDays: [9] })).status, 400);
    assert.equal((await api.call("PUT", "/api/goals", { ...validGoals, cashNeededBy: "2020-01-01" })).status, 400);
    assert.equal((await api.call("GET", "/api/goals")).body.storageUnits, 12);

    const baskets = await api.call("POST", "/api/baskets", { profile: { ...defaults } });
    assert.equal(baskets.status, 200);
    assert.equal(baskets.body.constraints.storage, 10, "smaller of profile 10 and goals 12");
    assert.ok(Array.isArray(baskets.body.baskets));
    assert.ok(baskets.body.timing.cash.status);
    const loose = await api.call("POST", "/api/baskets", {
      profile: { ...defaults, rules: { maxWeightKg: 50, minUnitProfit: 900 } },
    });
    assert.equal(loose.status, 200);
    assert.deepEqual(loose.body.rules.ignored.map((i) => i.key), ["maxWeightKg"]);
    assert.equal(loose.body.rules.effective.minUnitProfit, 900);
    assert.equal(
      (await api.call("POST", "/api/baskets", { profile: { ...defaults, rules: { maxWeightKg: "50" } } })).status,
      400,
    );
    assert.equal((await api.call("POST", "/api/baskets", {})).status, 400);
    assert.equal(
      (await api.call("POST", "/api/baskets", { profile: { ...defaults, carry: -1 } })).status,
      400,
    );
  } finally {
    await api.close();
  }
});
