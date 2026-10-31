import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb, serve } from "./test-support.mjs";
import { HttpError } from "./http.mjs";
import { CAR_BOOT_KG, defaults, journeyFor, offers } from "./catalog.mjs";
import {
  BASKET_SEARCH,
  DEFAULT_GOALS,
  addTarget,
  basketOptions,
  cashTiming,
  deleteTarget,
  getGoals,
  goalTargets,
  lastSaleDays,
  payoutDate,
  readGoals,
  readTarget,
  saveGoals,
  schema,
  tripTiming,
} from "./goals.mjs";
import { addEntry, createTrip, schema as ledgerSchema } from "./ledger.mjs";
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
// needs exactly £10 of cash and nets a known margin (£14.20 for A, £12.56
// for B after the sample fees and returns). Demand is plentiful.
const item = (over) => ({
  sku: "a",
  name: "Item A",
  variant: "Test",
  category: "general",
  salesPerWeek: 10,
  competingListings: 0,
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

test("a basket that loses money is never shown or recommended", () => {
  // A £300 fare is more than ten units can earn: every item's share of the
  // journey takes it under £5 a unit, so no basket is shown and each item is
  // listed as rejected with the reason.
  const p = profile({ transport: "Public transport", fare: 30000, budget: 100000 });
  const r = basketOptions([A, B], p, goals(), { now: NOW });
  assert.deepEqual(r.baskets, []);
  assert.equal(r.bestSingle, null);
  assert.equal(r.recommended, null);
  const rejected = r.excluded.filter((e) => e.rejected);
  assert.deepEqual(rejected.map((e) => e.sku).sort(), ["a", "b"]);
  for (const e of rejected)
    assert.match(e.reason, /^Profit per unit of at most -?£[\d.]+ is below £5\.00.*\(with its share of the journey, in every basket that fits\)$/);
});

test("the sample basket recommends the trial batch of jackets and stays sample data", () => {
  // Only the sample jacket clears the buying thresholds, and a first purchase
  // is a trial batch of three even though four units would fit.
  const sample = basketOptions(offers, { ...defaults }, goals(), { now: NOW });
  assert.equal(sample.sample, true);
  assert.equal(sample.recommended, "jacket:3");
  const pick = sample.baskets.find((b) => b.recommended);
  assert.ok(pick, "the recommended basket is in the top baskets");
  assert.equal(pick.id, "jacket:3");
  assert.ok(pick.economics.contribution > 0);
  assert.equal(sample.constraints.trialUnits, 3);
  for (const b of [...sample.baskets, sample.bestSingle])
    for (const it of b.items) assert.ok(it.units <= 3, b.id);
  // A stricter trial batch of two is the most any item gets. Two jackets
  // spread the walk over fewer units and earn under £12 an hour, so nothing
  // is recommended.
  const two = basketOptions(offers, { ...defaults, rules: { trialUnits: 2 } }, goals(), { now: NOW });
  for (const b of two.baskets) for (const it of b.items) assert.ok(it.units <= 2, b.id);
  assert.equal(two.recommended, null);
  assert.ok(two.baskets.find((b) => b.id === "jacket:2").reasons.includes("Below hourly target"));
  // Sample items never pass the buy-alert gate.
  for (const it of pick.items) assert.equal(it.opportunity.meetsThresholds, false);
});

test("offers that fail any buying threshold never enter a basket", () => {
  const r = basketOptions(offers, { ...defaults, budget: 100000 }, goals(), { now: NOW });
  const rejected = Object.fromEntries(r.excluded.filter((e) => e.rejected).map((e) => [e.sku, e.reason]));
  assert.deepEqual(Object.keys(rejected).sort(), ["baby", "knit", "pot"]);
  assert.equal(rejected.baby, "Purchase price outside £5 to £50 per unit");
  assert.equal(rejected.pot, "Unit weighs 2 kg or more");
  // The jumper nets £2.42 a unit before any travel, so no basket can lift it to £5.
  assert.equal(rejected.knit, "Profit per unit of £2.42 is below £5.00");
  for (const b of [...r.baskets, r.bestSingle])
    assert.ok(b.items.every((it) => !["baby", "pot", "knit"].includes(it.sku)), b.id);
  // By car the reason says the journey would only lower it further.
  const car = basketOptions(offers, { ...defaults, transport: "Car" }, goals(), { now: NOW });
  assert.equal(
    car.excluded.find((e) => e.sku === "knit").reason,
    "Profit per unit of £2.42 is below £5.00 (even before its share of the journey)",
  );
  // A member's stricter price floor leaves the jumper out for its price too.
  const strict = basketOptions(offers, { ...defaults, rules: { minUnitPrice: 700 } }, goals(), { now: NOW });
  assert.match(strict.excluded.find((e) => e.sku === "knit" && e.rejected).reason, /Purchase price outside £7 to £50/);
  // Stricter profit or return rules leave out the jacket as well, so nothing is shown.
  for (const rules of [{ minUnitProfit: 800 }, { minReturn: 0.75 }]) {
    const tight = basketOptions(offers, { ...defaults, rules }, goals(), { now: NOW });
    assert.deepEqual(tight.baskets, [], JSON.stringify(rules));
    assert.equal(tight.recommended, null);
    assert.ok(tight.excluded.some((e) => e.sku === "jacket" && e.rejected), JSON.stringify(rules));
  }
});

test("every item in every basket shown clears the thresholds with its share of the journey", () => {
  // F's shop is 20 miles away by car: one unit carries an £18 journey and
  // loses money, three units carry £6 each and keep £8.20 a unit.
  const F = item({ sku: "f", name: "Item F", shop: "Far shop", miles: 20 });
  const p = profile({ transport: "Car", perMile: 45, budget: 100000 });
  const r = basketOptions([A, F], p, goals(), { now: NOW });
  assert.ok(r.baskets.length > 0);
  for (const b of [...r.baskets, r.bestSingle])
    for (const it of b.items) {
      assert.equal(it.thresholds.ok, true, b.id + " " + it.sku + " " + it.thresholds.failures.join("; "));
      assert.ok(it.unitProfit >= 500, b.id);
    }
  assert.ok(!r.baskets.some((b) => b.id === "f:1"), "a lone far unit is never shown");
  // A shop so far that every basket leaves the item under £5 a unit is rejected with the reason.
  const G = item({ sku: "g", name: "Item G", shop: "Very far shop", miles: 40 });
  const far = basketOptions([G], p, goals(), { now: NOW });
  assert.deepEqual(far.baskets, []);
  assert.deepEqual(far.excluded, [
    {
      sku: "g",
      name: "Item G",
      shop: "Very far shop",
      reason:
        "Profit per unit of at most £2.20 is below £5.00; Return of at most 22% is below 35% of the purchase price (with its share of the journey, in every basket that fits)",
      rejected: true,
    },
  ]);
});

test("basket items respect the sales rate after competing listings", () => {
  const slow = item({ salesPerWeek: 1, competingListings: 1 }); // one unit in two weeks
  const r = basketOptions([slow], profile({ budget: 100000 }), goals(), { now: NOW });
  assert.ok(r.baskets.every((b) => b.units <= 1));
  const none = basketOptions([item({ competingListings: 40 })], profile({ budget: 100000 }), goals(), { now: NOW });
  assert.equal(none.baskets.length, 0);
  assert.match(none.excluded[0].reason, /expected demand/);
  // Unknown demand fails closed.
  const unknown = basketOptions([item({ salesPerWeek: undefined })], profile(), goals(), { now: NOW });
  assert.equal(unknown.baskets.length, 0);
});

test("a basket below the hourly target is never recommended, even when it ranks first", () => {
  // Item A earns more but takes two hours a unit to handle, so the basket
  // with the most contribution earns under £12 an hour.
  const slowA = item({ handlingMinutes: 120 });
  const quickB = item({ sku: "b", name: "Item B", shop: "Shop B", sales: [2800], handlingMinutes: 5 });
  const r = basketOptions([slowA, quickB], profile({ budget: 100000, target: 1200 }), goals(), { now: NOW });
  const first = r.baskets[0];
  assert.equal(first.id, "a:3,b:3", "most contribution first");
  assert.ok(first.economics.hourly < 1200);
  assert.equal(first.recommended, false);
  assert.ok(first.reasons.includes("Below hourly target"));
  assert.notEqual(r.recommended, null);
  assert.notEqual(r.recommended, first.id);
  const pick = [...r.baskets, r.bestSingle].find((b) => b.id === r.recommended);
  assert.ok(pick.economics.hourly >= 1200);
  assert.deepEqual(pick.reasons, []);
});

test("an item under the buying thresholds is never in any basket, only in the rejected list", () => {
  // Item C nets £4.36 a unit: positive, so it would add contribution, but under £5.
  const C = item({ sku: "c", name: "Item C", shop: "Shop A", sales: [1800] });
  const r = basketOptions([A, C], profile({ budget: 100000 }), goals(), { now: NOW });
  for (const b of [...r.baskets, r.bestSingle]) assert.ok(b.items.every((it) => it.sku !== "c"), b.id);
  assert.deepEqual(r.excluded, [
    { sku: "c", name: "Item C", shop: "Shop A", reason: "Profit per unit of £4.36 is below £5.00", rejected: true },
  ]);
  assert.equal(r.recommended, "a:3");
  // A return under 35% is rejected the same way: £30 a unit making £8.14 is 27.1%.
  const D = item({ sku: "d", name: "Item D", buy: 3000, sales: [4700] });
  const thin = basketOptions([D], profile({ budget: 100000 }), goals(), { now: NOW });
  assert.deepEqual(thin.baskets, []);
  assert.equal(thin.excluded[0].reason, "Return of 27.1% is below 35% of the purchase price");
  // A blank cost is never zero: the item is rejected until it is entered.
  const blank = basketOptions([item({ pack: undefined })], profile({ budget: 100000 }), goals(), { now: NOW });
  assert.deepEqual(blank.baskets, []);
  assert.equal(blank.excluded[0].reason, "Profit per unit cannot be checked until these are entered: packaging cost");
});

test("ranking counts the journey: a far shop loses to a near one with a smaller margin", () => {
  // F nets 80p a unit more than A, but its shop is 20 miles away by car.
  const F = item({ sku: "f", name: "Item F", shop: "Far shop", miles: 20, sales: [3098] });
  const r = basketOptions([A, F], profile({ transport: "Car", perMile: 45, budget: 100000 }), goals(), { now: NOW });
  assert.equal(r.bestSingle.id, "a:3");
  const single = r.baskets.find((b) => b.id === "f:3");
  assert.ok(!single || single.economics.contribution < r.bestSingle.economics.contribution);
  assert.equal(r.bestSingle.economics.contribution, 3 * 1420 - journeyFor(profile({ transport: "Car" }), 1).cost);
});

test("a payout one day after the cash date is late and blocks the recommendation", () => {
  const t = cashTiming({ payoutDate: "2026-11-13", cashNeededBy: "2026-11-12" });
  assert.equal(t.status, "late");
  assert.equal(t.daysLate, 1);
  assert.match(t.note, /1 day after/);
  assert.doesNotMatch(t.note, /1 days/);
  // The payout is 13 November (see tripTiming), so a cash date of 12 November is one day short.
  const p = profile({ budget: 100000 });
  const r = basketOptions([A, B], p, goals({ cashNeededBy: "2026-11-12" }), { now: NOW });
  assert.equal(r.timing.payout.date, "2026-11-13");
  assert.equal(r.timing.cash.daysLate, 1);
  assert.equal(r.recommended, null);
  const onTheDay = basketOptions([A, B], p, goals({ cashNeededBy: "2026-11-13" }), { now: NOW });
  assert.notEqual(onTheDay.recommended, null);
});

test("public transport with no fare entered is never recommended", () => {
  const missing = basketOptions([A, B], profile({ transport: "Public transport", fare: null, budget: 100000 }), goals(), { now: NOW });
  assert.equal(missing.constraints.fareMissing, true);
  assert.equal(missing.recommended, null);
  assert.ok(missing.baskets.every((b) => b.reasons.some((x) => x.includes("fare not entered"))));
  const free = basketOptions([A, B], profile({ transport: "Public transport", fare: 0, budget: 100000 }), goals(), { now: NOW });
  assert.notEqual(free.recommended, null);
});

test("baskets use the same load limit as the Planner for the transport", () => {
  // A 10 kg item: on foot with 5 kg none fits, by car the boot holds two.
  const heavy = item({ sku: "h", weight: 10, buy: 1000 });
  const walk = basketOptions([heavy], profile({ carry: 5, budget: 100000 }), goals(), { now: NOW });
  assert.equal(walk.constraints.carry, 5);
  assert.equal(walk.baskets.length, 0, "a 10 kg unit fails the 2 kg weight filter and is excluded");
  const light = item({ sku: "l", weight: 1.5 });
  const car = basketOptions([light], profile({ transport: "Car", carry: 5, budget: 100000 }), goals(), { now: NOW });
  assert.equal(car.constraints.carry, CAR_BOOT_KG);
  assert.equal(car.constraints.carryEntered, 5);
  const foot = basketOptions([light], profile({ carry: 3, budget: 100000 }), goals(), { now: NOW });
  assert.ok(foot.baskets.every((b) => b.weightKg <= 3));
});

test("baskets show storage used against the limit, time until payment and access needs", () => {
  const r = basketOptions(offers, { ...defaults }, goals(), { now: NOW });
  const pick = r.baskets.find((b) => b.recommended);
  assert.deepEqual(pick.storage, { used: 3, limit: 10 });
  assert.equal(pick.timing.payoutDays, 13);
  assert.equal(r.timing.payoutDays, 13);
  assert.deepEqual(pick.items[0].accessNeeds.map((n) => n.id), ["limited-stock"]);
  assert.deepEqual(pick.items[0].checked, { price: null, stock: null });
  assert.match(pick.items[0].mainUncertainty, /Sample figures/);
  assert.ok(pick.items[0].returnsRate >= 0.15, "clothing returns allowance");
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
  // Reasons are plain words with no raw dates.
  for (const b of late.baskets) for (const r of b.reasons) assert.doesNotMatch(r, /\d{4}-\d{2}-\d{2}/, r);
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
    assert.equal(plan.body.trips.length + plan.body.rejected.length, 4);
    assert.ok(plan.body.trips.every((t) => t.alert.eligible === false && t.opportunity.tier));
    assert.ok(plan.body.trips.every((t) => t.timing && "payoutDays" in t.timing), "payout timing from the goals");
    assert.ok(plan.body.trips.every((t) => t.compare.heading === "What changes if I drive?"));
    assert.deepEqual(plan.body.rules.ignored.map((i) => i.key), ["minUnitPrice"]);
    // Only offers inside every buying threshold are shortlisted; the jumper
    // (£2.42 a unit) is listed as rejected with its reason.
    assert.deepEqual(plan.body.trips.map((t) => t.sku), ["jacket"]);
    assert.deepEqual(plan.body.rejected.find((r) => r.sku === "knit").reasons, ["Profit per unit of £2.42 is below £5.00"]);
    // Each trip's payout allows for selling the units it buys.
    const jacketTrip = plan.body.trips[0];
    assert.equal(jacketTrip.timing.units, jacketTrip.units);
    assert.equal(jacketTrip.timing.daysToSellOneUnit, 7);
    // A fare left blank (null) is "not entered", for walkers and bus users alike.
    for (const transport of ["Walk", "Public transport"]) {
      const blank = await api.call("POST", "/api/plan", { ...defaults, transport, fare: null });
      assert.equal(blank.status, 200, transport);
      assert.equal(blank.body.trips.length, 1, transport);
    }
    const bus = await api.call("POST", "/api/baskets", { profile: { ...defaults, transport: "Public transport", fare: null } });
    assert.equal(bus.status, 200);
    assert.ok(bus.body.baskets.length > 0, "baskets still shown, none recommended");
    assert.equal(bus.body.recommended, null);
    for (const bad of [
      { ...defaults, transport: "Rocket" },
      { ...defaults, quantity: 0 },
      { ...defaults, budget: 99.5 },
      { ...defaults, rules: { loosenEverything: true } },
      { ...defaults, rules: { minReturn: -1 } },
      { ...defaults, rules: { toString: 1 } },
      { ...defaults, rules: { constructor: 1 } },
      [],
    ])
      assert.equal((await api.call("POST", "/api/plan", bad)).status, 400, JSON.stringify(bad));
    // A key named __proto__ arrives as an own property of the parsed body.
    const proto = await fetch(api.base + "/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...defaults, rules: {} }).replace('"rules":{}', '"rules":{"__proto__":1}'),
    });
    assert.equal(proto.status, 400);

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
      (await api.call("POST", "/api/baskets", { profile: { ...defaults, rules: { constructor: 1 } } })).status,
      400,
    );
    assert.equal((await api.call("POST", "/api/baskets", [])).status, 400);
    assert.equal(
      (await api.call("POST", "/api/baskets", { profile: { ...defaults, carry: -1 } })).status,
      400,
    );
  } finally {
    await api.close();
  }
});

test("basket payouts wait for the last unit to sell at each item's sales rate", () => {
  // Item S sells 1.5 a week: three units take 14 days, one unit the Goals' 7.
  const S = item({ sku: "s", name: "Item S", salesPerWeek: 1.5, competingListings: 0 });
  assert.equal(lastSaleDays(goals(), [{ units: 3, salesPerWeek: 1.5 }]), 14);
  assert.equal(lastSaleDays(goals(), [{ units: 1, salesPerWeek: 1.5 }, { units: 2, salesPerWeek: 10 }]), 7);
  assert.equal(lastSaleDays(goals(), [{ units: 2, salesPerWeek: null }]), null);
  const p = profile({ budget: 100000 });
  const r = basketOptions([S], p, goals(), { now: NOW });
  const three = r.baskets.find((b) => b.id === "s:3");
  const one = r.baskets.find((b) => b.id === "s:1");
  assert.equal(three.timing.daysToSell, 14);
  assert.equal(three.timing.payout.date, "2026-11-20");
  assert.equal(one.timing.payout.date, "2026-11-13");
  assert.equal(r.timing.payout.date, "2026-11-13", "the top-level payout is for one unit");
  // Needing the cash on 16 November: three units are late, so a smaller basket is recommended.
  const tight = basketOptions([S], p, goals({ cashNeededBy: "2026-11-16" }), { now: NOW });
  const late = tight.baskets.find((b) => b.id === "s:3");
  assert.equal(late.recommended, false);
  assert.ok(late.reasons.includes("Payout expected 4 days after you need the cash"));
  assert.notEqual(tight.recommended, null);
  assert.notEqual(tight.recommended, "s:3");
  const pick = tight.baskets.find((b) => b.recommended) || tight.bestSingle;
  assert.equal(pick.timing.cash.status, "on time");
});

test("today is the London date for payouts, cash dates and goal deadlines", () => {
  // 00:30 on Saturday 4 July 2026 in London is 23:30 on Friday 3 July UTC.
  const lateNight = "2026-07-03T23:30:00Z";
  const g = goals({ cashNeededBy: "2026-07-16" });
  const t = tripTiming(g, { now: lateNight });
  assert.equal(t.start, "2026-07-04");
  // Sold Saturday 11 July, posted Monday 13, paid out Friday 17: a day late.
  assert.equal(t.payout.date, "2026-07-17");
  assert.equal(t.cash.status, "late");
  assert.equal(t.cashNeededDays, 12);
  // An hour earlier it is still Friday 3 July in London, and the payout is on time.
  const evening = tripTiming(g, { now: "2026-07-03T22:30:00Z" });
  assert.equal(evening.start, "2026-07-03");
  assert.equal(evening.cash.status, "on time");
  // Yesterday in London cannot be saved as the cash date, though it is still today in UTC.
  const db = ledgerDb();
  assert.throws(
    () => saveGoals(db, { ...validGoals, cashNeededBy: "2026-07-03" }, { now: lateNight }),
    (e) => e instanceof HttpError && e.message === "The date you need the cash back must be today or later.",
  );
  assert.equal(saveGoals(db, { ...validGoals, cashNeededBy: "2026-07-04" }, { now: lateNight }).cashNeededBy, "2026-07-04");
  // Named goals: the deadline and the days left count from the London date.
  assert.throws(() => addTarget(db, { name: "Fuel", amount: 100, deadline: "2026-07-03" }, { now: lateNight }), HttpError);
  addTarget(db, { name: "Fuel", amount: 100, deadline: "2026-07-10" }, { now: lateNight });
  const [goal] = goalTargets(db, { now: lateNight }).targets;
  assert.equal(goal.start, "2026-07-04");
  assert.equal(goal.daysLeft, 6);
});

test("goal errors are plain sentences with no raw field names", () => {
  const today = "2026-10-31";
  const message = (fn) => {
    try {
      fn();
    } catch (e) {
      assert.ok(e instanceof HttpError);
      return e.message;
    }
    assert.fail("accepted");
  };
  const raw = /cashNeededBy|dispatchDays|targetType|monthlyTarget|storageUnits|daysToSell|deliveryDays|payoutDelayDays|\(pence\)|YYYY/;
  assert.equal(
    message(() => readGoals({ ...validGoals, cashNeededBy: "2026-10-30" }, { today })),
    "The date you need the cash back must be today or later.",
  );
  for (const [field, value] of [
    ["targetType", "profit"],
    ["monthlyTarget", -1],
    ["dispatchDays", [7]],
    ["dispatchDays", [1, 1]],
    ["dispatchDays", "1,2"],
    ["storageUnits", 1.5],
    ["cashNeededBy", "2026-02-30"],
    ["daysToSell", -1],
    ["deliveryDays", "2"],
    ["payoutDelayDays", undefined],
  ]) {
    const text = message(() => readGoals({ ...validGoals, [field]: value }, { today }));
    assert.doesNotMatch(text, raw, text);
    assert.match(text, /^[A-Z].*\.$/, text);
  }
  for (const bad of [
    { amount: 100 },
    { name: "Fuel", amount: 0 },
    { name: "Fuel", amount: 100, deadline: "2026-10-30" },
    { name: "Fuel", amount: 100, deadline: "2026-02-30" },
    { name: "Fuel", amount: 100, start: "2026-11-01" },
    { name: "Fuel", amount: 100, start: "1999-12-31" },
  ]) {
    const text = message(() => readTarget(bad, { today }));
    assert.doesNotMatch(text, /^(name|amount|deadline|start)\b|\(pence\)|YYYY|whole number between/, text);
    assert.match(text, /^[A-Z].*\.$/, text);
  }
});

test("trip timing gives days to the payout and to the cash date", () => {
  const t = tripTiming(goals({ cashNeededBy: "2026-11-30" }), { now: NOW });
  assert.equal(t.start, "2026-10-31");
  assert.equal(t.payout.date, "2026-11-13");
  assert.equal(t.payoutDays, 13);
  assert.equal(t.cashNeededDays, 30);
  assert.equal(t.cash.status, "on time");
  const none = tripTiming(goals({ dispatchDays: [] }), { now: NOW });
  assert.equal(none.payoutDays, null);
  assert.equal(none.cashNeededDays, null);
});

// Named goals read received cash from the ledger.
const ledgerDb = () => memoryDb(schema, ledgerSchema);
const resaleTrip = (db, at) =>
  createTrip(db, { label: "Test trip", source: "manual", kind: "resale" }, { now: new Date(at) });
const entry = (db, trip, type, amount, occurred, units) =>
  addEntry(db, trip, { type, amount, occurred, ...(units ? { units } : {}) }, { now: new Date(NOW) });

test("named goals are validated", () => {
  const today = "2026-10-31";
  assert.deepEqual(readTarget({ name: " Car insurance ", amount: 20000, deadline: "2026-11-30" }, { today }), {
    name: "Car insurance",
    amount: 20000,
    deadline: "2026-11-30",
    start: today,
  });
  for (const bad of [
    null,
    [],
    { amount: 100 },
    { name: "", amount: 100 },
    { name: "Fuel", amount: 0 },
    { name: "Fuel", amount: 10.5 },
    { name: "Fuel", amount: 100, deadline: "2026-10-30" },
    { name: "Fuel", amount: 100, deadline: "2026-02-30" },
    { name: "Fuel", amount: 100, start: "2026-11-01" },
    { name: "x".repeat(81), amount: 100 },
  ])
    assert.throws(() => readTarget(bad, { today }), HttpError, JSON.stringify(bad));
});

test("a deadline goal counts only cash received by its date", () => {
  const db = ledgerDb();
  // The goal was set on 1 October for 15 October.
  const id = addTarget(db, { name: "Car insurance", amount: 6000, deadline: "2026-10-15", start: "2026-10-01" }, { now: "2026-10-01T09:00:00Z" });
  const trip = resaleTrip(db, "2026-10-01T09:00:00Z");
  entry(db, trip, "receipt", 1000, "2026-10-02", 2);
  entry(db, trip, "sale", 9000, "2026-10-08", 2);
  entry(db, trip, "payout", 5000, "2026-10-10");
  entry(db, trip, "payout", 3000, "2026-10-20"); // after the deadline
  entry(db, trip, "payout", 700, "2026-09-30"); // before the start
  const [goal] = goalTargets(db, { now: NOW }).targets;
  assert.equal(goal.id, id);
  assert.equal(goal.payouts, 5000);
  assert.equal(goal.costs, 1000);
  assert.equal(goal.received, 4000, "payouts less costs; the sale itself is not cash");
  assert.equal(goal.counted, 4000);
  assert.equal(goal.remaining, 2000);
  assert.equal(goal.status, "missed", "the deadline passed short of the amount");
  assert.equal(goal.daysLeft, -16);
});

test("named goals in progress never count pending payouts or predictions, and never count cash twice", () => {
  const db = ledgerDb();
  const fuel = addTarget(db, { name: "Fuel", amount: 3000, deadline: "2026-11-15", start: "2026-10-01" }, { now: NOW });
  const hobby = addTarget(db, { name: "Pottery class", amount: 5000, start: "2026-10-01" }, { now: NOW });
  const trip = createTrip(
    db,
    { label: "Predicted", source: "research", kind: "resale", predicted: { units: 2, proceeds: 90000, contribution: 50000, cashRequired: 2000, activeMinutes: 60 } },
    { now: new Date(NOW) },
  );
  entry(db, trip, "sale", 40000, "2026-10-20", 1); // sold, not yet paid out
  entry(db, trip, "payout", 4000, "2026-10-25");
  const { targets, basis } = goalTargets(db, { now: NOW });
  assert.match(basis, /only cash received/);
  // Deadline goals come first; the goal without a deadline gets what is left.
  assert.deepEqual(targets.map((t) => t.id), [fuel, hobby]);
  const [f, h] = targets;
  assert.equal(f.counted, 3000);
  assert.equal(f.status, "reached");
  assert.equal(f.daysLeft, 15);
  assert.equal(h.received, 4000);
  assert.equal(h.shared, 3000, "already counted towards Fuel");
  assert.equal(h.counted, 1000);
  assert.equal(h.status, "in progress");
  assert.equal(f.counted + h.counted, 4000, "the same payout is never counted twice");
  // Household savings are not earnings.
  const home = createTrip(db, { label: "Home", source: "manual", kind: "household" }, { now: new Date(NOW) });
  entry(db, home, "saving", 9000, "2026-10-26");
  assert.equal(goalTargets(db, { now: NOW }).targets[1].counted, 1000);
  assert.deepEqual(deleteTarget(db, fuel), { deleted: fuel });
  assert.throws(() => deleteTarget(db, fuel), HttpError);
  assert.equal(goalTargets(db, { now: NOW }).targets[0].counted, 4000);
});

test("named goal routes add, list and delete", async () => {
  const db = ledgerDb();
  const api = await serve(db, [planRoutes]);
  try {
    const empty = await api.call("GET", "/api/goals/targets");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.targets, []);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const added = await api.call("POST", "/api/goals/targets", { name: "Bill", amount: 2500, deadline: tomorrow });
    assert.equal(added.status, 201);
    assert.equal(added.body.targets.length, 1);
    assert.equal(added.body.targets[0].name, "Bill");
    assert.equal((await api.call("POST", "/api/goals/targets", { name: "Bill", amount: -1 })).status, 400);
    assert.equal((await api.call("POST", "/api/goals/targets", { name: "Bill", amount: 1, deadline: "2020-01-01" })).status, 400);
    assert.equal((await api.call("DELETE", "/api/goals/targets/abc", {})).status, 400);
    assert.equal((await api.call("DELETE", "/api/goals/targets/999", {})).status, 404);
    const gone = await api.call("DELETE", "/api/goals/targets/" + added.body.id, {});
    assert.equal(gone.status, 200);
    assert.deepEqual(gone.body.targets, []);
  } finally {
    await api.close();
  }
});
