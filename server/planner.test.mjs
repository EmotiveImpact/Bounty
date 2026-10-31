import test from "node:test";
import assert from "node:assert/strict";
import {
  CAR_BOOT_KG,
  HAND_CARRY_KG,
  REASONS,
  defaults,
  describeRules,
  journeyFor,
  offers,
  plan,
  planTrips,
  readProfile,
  readRules,
} from "./catalog.mjs";
import { HttpError } from "./http.mjs";
import { OPPORTUNITY_RULES } from "./opportunity.mjs";

const NOW = "2026-10-31T12:00:00Z";
const [knit, baby, pot] = offers;
const run = (offer, over = {}, opts = {}) => plan(offer, { ...defaults, ...over }, { now: NOW, ...opts });

// A test-only offer that meets every buying threshold: £10 a unit, 0.5 kg,
// a lower-median sale of £30.
const strong = Object.freeze({
  sku: "strong",
  name: "Test item",
  variant: "Test",
  shop: "Test shop",
  area: "Leeds",
  miles: 1,
  buy: 1000,
  sales: [2900, 3000, 3100],
  post: 300,
  pack: 30,
  weight: 0.5,
  stock: 10,
  handlingMinutes: 5,
  sample: true,
});

test("fixtures are labelled sample data with modelled sale totals", () => {
  assert.equal(offers.length, 4);
  for (const o of offers) {
    assert.equal(o.sample, true);
    assert.ok(o.sales.length > 0);
    assert.ok(Object.isFrozen(o));
  }
});

test("the cash constraint includes the journey before allocating units", () => {
  // Public transport, £3 fare: each knit needs £6 + 35p + £2.70 = £9.05 of cash.
  const p = run(knit, { transport: "Public transport", fare: 300, budget: 2200, quantity: 10 });
  assert.equal(p.journey.cost, 300);
  assert.equal(p.units, 2); // 3 units would need £27.15 + £3 fare
  assert.equal(p.limit, "cash");
  assert.ok(p.economics.cashRequired <= 2200);
  assert.equal(p.economics.cashRequired, 2 * 905 + 300);
  // Stock alone for three units is £27.15, which £30.14 covers, but the £3
  // fare counts too: £30.15 is needed, so only two units fit.
  const roomy = run(knit, { transport: "Public transport", fare: 300, budget: 3014, quantity: 10 });
  assert.equal(roomy.units, 2, "2715 + 300 = 3015 is over a 3014 budget");
  assert.equal(run(knit, { transport: "Public transport", fare: 300, budget: 3015, quantity: 10 }).units, 3);
  assert.equal(
    p.economics.contribution,
    p.economics.proceeds - Object.values(p.economics.costs).reduce((a, b) => a + b, 0),
  );
});

test("the carry limit stops a heavy item from qualifying", () => {
  const p = run(pot);
  assert.equal(p.units, 0);
  assert.equal(p.limit, "carry");
  assert.equal(p.reason, REASONS.LIMIT);
  assert.equal(p.economics.contribution, 0);
  assert.equal(p.economics.costs.travel, 0, "no units means no trip");
  assert.equal(run(knit, { carry: 0.96, quantity: 10 }).units, 3, "0.96 kg holds three 0.32 kg units");
  assert.equal(run(knit, { carry: 0.96, quantity: 10 }).limit, "carry");
});

test("storage at home limits the units", () => {
  const p = run(knit, { storage: 2, quantity: 10 });
  assert.equal(p.units, 2);
  assert.equal(p.limit, "storage");
  const none = run(knit, { storage: 0 });
  assert.equal(none.units, 0);
  assert.equal(none.reason, REASONS.LIMIT);
});

test("stock and the maximum units both bound the trip", () => {
  assert.equal(run(knit, { quantity: 50, carry: 50, storage: 50 }).limit, "stock");
  assert.equal(run(knit, { quantity: 50, carry: 50, storage: 50 }).units, knit.stock);
  assert.equal(run(knit, { quantity: 2 }).limit, "quantity");
});

test("area and the hourly target change the reason without inventing evidence", () => {
  assert.equal(run(knit, { area: "York" }).reason, REASONS.AREA);
  assert.equal(run(knit, { area: "  leeds " }).reason === REASONS.AREA, false);
  const slow = run(knit, { target: 100000 });
  assert.equal(slow.reason, REASONS.HOURLY);
  assert.equal(slow.fits, false);
  assert.deepEqual(slow.sales, [...knit.sales]);
  assert.equal(slow.salePrice, 1650, "lower median of the modelled totals");
});

test("negative or zero contribution reads Loses money, never fitting", () => {
  // A £60 fare wipes out the margin on four jumpers.
  const p = run(knit, { transport: "Public transport", fare: 6000 });
  assert.ok(p.economics.contribution <= 0);
  assert.equal(p.reason, REASONS.LOSS);
  assert.equal(p.fits, false);
  // A zero-margin trip also loses: break-even is not a fit.
  const zero = run({ ...strong, sales: [1000] }, { target: 0 });
  assert.ok(zero.economics.contribution <= 0);
  assert.equal(zero.reason, REASONS.LOSS);
  // Even with no hourly target, a sample trip never fits when it loses money.
  for (const o of offers)
    for (const fare of [0, 6000, 20000]) {
      const r = run(o, { transport: "Public transport", fare, budget: 1_000_000, target: 0 });
      if (r.economics.contribution <= 0) assert.notEqual(r.reason, REASONS.FITS);
    }
});

test("the public transport fare and the car cost per mile change the travel cost", () => {
  const walk = run(knit);
  assert.equal(walk.journey.cost, 0);
  const bus = run(knit, { transport: "Public transport", fare: 450 });
  assert.equal(bus.journey.cost, 450);
  assert.equal(bus.economics.costs.travel, 450);
  const car = run(knit, { transport: "Car", perMile: 45 });
  assert.equal(car.journey.cost, Math.round(1.2 * 2 * 45));
  const dearer = run(knit, { transport: "Car", perMile: 60, extra: 200 });
  assert.equal(dearer.journey.cost, Math.round(1.2 * 2 * 60) + 200);
  // Car costs, parking and tolls never apply on foot, by bicycle or by bus.
  assert.equal(run(knit, { transport: "Walk", perMile: 60, extra: 200 }).journey.cost, 0);
  assert.equal(run(knit, { transport: "Bicycle", perMile: 60, extra: 200 }).journey.cost, 0);
  assert.equal(journeyFor({ ...defaults, transport: "Public transport", fare: 300, extra: 500 }, 1).cost, 300);
});

test("the journey is shared across units, not charged per unit", () => {
  const one = run(knit, { transport: "Car", quantity: 1 });
  const four = run(knit, { transport: "Car", quantity: 4 });
  assert.equal(one.economics.costs.travel, four.economics.costs.travel);
  assert.equal(four.economics.journeyPerUnit, Math.round(four.journey.cost / 4));
  assert.equal(
    four.economics.cashRequired,
    4 * (knit.buy + knit.pack + knit.post) + four.journey.cost,
  );
});

test("a fixture is never an eligible alert and lists every failing check", () => {
  for (const o of offers)
    for (const over of [{}, { transport: "Car", carry: 50, budget: 100000, target: 0 }, { quantity: 1 }]) {
      const p = run(o, over);
      assert.equal(p.sample, true);
      assert.equal(p.alert.eligible, false);
      const failed = new Set(p.alert.checks.filter((c) => !c.ok).map((c) => c.id));
      assert.ok(failed.has("live-evidence"));
      assert.ok(failed.has("exact-match"));
      assert.ok(failed.has("buying-thresholds"));
      assert.ok(p.alert.checks.some((c) => c.id === "trial-batch"));
    }
  // Four units is more than the trial batch of three.
  const four = run(knit);
  assert.equal(four.units, 4);
  assert.equal(four.alert.checks.find((c) => c.id === "trial-batch").ok, false);
  assert.equal(run(knit, { quantity: 3 }).alert.checks.find((c) => c.id === "trial-batch").ok, true);
});

test("every trip carries an honest opportunity tier", () => {
  const tiers = Object.fromEntries(offers.map((o) => [o.sku, run(o).opportunity]));
  assert.equal(tiers.knit.tier, "Review", "sample evidence needs review");
  assert.ok(tiers.knit.reasons.includes("Sample or illustrative figures never trigger a buy alert"));
  assert.equal(tiers.baby.tier, "Reject", "£4.50 is below the £5 purchase price floor");
  assert.equal(tiers.pot.tier, "Reject", "10 kg is over the 2 kg limit");
  for (const t of Object.values(tiers)) assert.equal(t.meetsThresholds, false);
});

test("the buying thresholds are part of the profile fit", () => {
  const p = run(knit, { target: 0 });
  assert.equal(p.thresholds.unitProfit, Math.floor(p.economics.contribution / p.units));
  assert.equal(p.thresholds.ok, false);
  assert.ok(p.thresholds.failures.some((f) => f.startsWith("Profit per unit")));
  assert.equal(p.reason, REASONS.THRESHOLDS);
  const fits = run(strong);
  assert.equal(fits.thresholds.ok, true, fits.thresholds.failures.join("; "));
  assert.equal(fits.reason, REASONS.FITS);
  assert.equal(fits.fits, true);
  assert.equal(fits.alert.eligible, false, "still sample data");
  assert.equal(fits.opportunity.tier, "Review");
});

test("members can tighten thresholds but loosening has no effect", () => {
  const tight = run(strong, { rules: { minUnitProfit: 2000 } });
  assert.equal(tight.reason, REASONS.THRESHOLDS);
  assert.ok(tight.thresholds.failures.some((f) => f.includes("£20.00")));
  // A looser minimum price leaves the baby sleepsuits rejected.
  const loose = run(baby, { rules: { minUnitPrice: 100, maxWeightKg: 50 } });
  assert.equal(loose.opportunity.tier, "Reject");
  assert.equal(run(pot, { rules: { maxWeightKg: 50 } }).opportunity.tier, "Reject");
  const tightPrice = run(knit, { rules: { minUnitPrice: 700 } });
  assert.equal(tightPrice.opportunity.tier, "Reject");
  const info = describeRules({ minUnitPrice: 100, minReturn: 0.5, trialUnits: 1 });
  assert.equal(info.effective.minUnitPrice, OPPORTUNITY_RULES.minUnitPrice);
  assert.equal(info.effective.minReturn, 0.5);
  assert.equal(info.effective.trialUnits, 1);
  assert.deepEqual(info.ignored.map((i) => i.key), ["minUnitPrice"]);
  assert.equal(info.ignored[0].applied, OPPORTUNITY_RULES.minUnitPrice);
  // A one-unit trial batch makes a two-unit trip fail the trial check.
  const trial = run(knit, { quantity: 2, rules: { trialUnits: 1 } });
  assert.equal(trial.alert.checks.find((c) => c.id === "trial-batch").ok, false);
});

test("threshold overrides are validated", () => {
  assert.deepEqual(readRules(undefined), {});
  assert.deepEqual(readRules({ minUnitProfit: 700, maxWeightKg: null }), { minUnitProfit: 700 });
  for (const bad of [
    [],
    "strict",
    { minUnitPrice: 5.5 },
    { minUnitPrice: -1 },
    { minReturn: "0.4" },
    { trialUnits: 0 },
    { maxWeightKg: Infinity },
    { hourlyFloor: 100 },
  ])
    assert.throws(() => readRules(bad), HttpError, JSON.stringify(bad));
});

test("the whole profile is validated", () => {
  const ok = readProfile({ ...defaults, rules: { minReturn: 0.4 } });
  assert.equal(ok.transport, "Walk");
  assert.deepEqual(ok.rules, { minReturn: 0.4 });
  for (const [field, value] of [
    ["transport", "Rocket"],
    ["transport", "walk"],
    ["budget", 100.5],
    ["budget", -1],
    ["quantity", 0],
    ["quantity", 1.5],
    ["carry", -1],
    ["fare", "3"],
    ["perMile", 45.5],
    ["feeRate", 0.9],
    ["returnsRate", -0.1],
    ["storage", undefined],
    ["area", ""],
    ["area", "x".repeat(101)],
  ])
    assert.throws(() => readProfile({ ...defaults, [field]: value }), HttpError, field + "=" + value);
  assert.throws(() => readProfile(null), HttpError);
  assert.throws(() => readProfile([defaults]), HttpError);
});

test("walking compares the same trip by car with a car-boot carry limit", () => {
  const p = run(pot);
  const c = p.compare;
  assert.equal(c.heading, "What changes if I drive?");
  assert.equal(c.current.mode, "Walk");
  assert.equal(c.alternative.mode, "Car");
  assert.equal(c.alternative.carry, CAR_BOOT_KG);
  assert.equal(c.current.units, 0);
  assert.equal(c.alternative.units, 2, "25 kg holds two 10 kg planters");
  const car = run(pot, { transport: "Car", carry: CAR_BOOT_KG }, { compare: false });
  assert.equal(c.alternative.travelCost, car.economics.costs.travel);
  assert.equal(c.alternative.cashRequired, car.economics.cashRequired);
  assert.equal(c.alternative.contribution, car.economics.contribution);
  assert.equal(c.alternative.hourly, car.economics.hourly);
  for (const k of ["units", "travelCost", "travelMinutes", "cashRequired", "contribution"])
    assert.equal(c.difference[k], c.alternative[k] - c.current[k], k);
  assert.equal(c.difference.hourly, null, "no hourly figure without units on foot");
  assert.ok(c.assumptions.some((a) => a.includes("25 kg")));
  // The profile's cost per mile and parking are used for the car.
  const parked = run(knit, { perMile: 60, extra: 250 }).compare.alternative;
  assert.equal(parked.travelCost, Math.round(1.2 * 2 * 60) + 250);
  // A larger carry limit than the car boot is kept.
  assert.equal(run(knit, { carry: 40 }).compare.alternative.carry, 40);
});

test("drivers compare with public transport and a hand-carry limit", () => {
  const p = run(knit, { transport: "Van", carry: 100, fare: 380 });
  const c = p.compare;
  assert.equal(c.current.mode, "Van");
  assert.equal(c.alternative.mode, "Public transport");
  assert.equal(c.alternative.carry, HAND_CARRY_KG);
  assert.equal(c.alternative.travelCost, 380);
  assert.equal(c.difference.hourly, c.alternative.hourly - c.current.hourly);
  const free = run(knit, { transport: "Car", fare: 0 }).compare;
  assert.ok(free.assumptions.some((a) => a.includes("No public transport fare")));
  assert.equal(run(knit, { transport: "Car", carry: 4 }).compare.alternative.carry, 4);
});

test("trips rank fitting first, then by earnings per hour", () => {
  const { trips, sample, rules } = planTrips({ ...defaults, target: 0 }, { now: NOW });
  assert.equal(sample, true);
  assert.equal(trips.length, 4);
  assert.deepEqual(rules.effective.minUnitPrice, OPPORTUNITY_RULES.minUnitPrice);
  for (let i = 1; i < trips.length; i++) {
    const [a, b] = [trips[i - 1], trips[i]];
    assert.ok(
      Number(a.fits) > Number(b.fits) ||
        (a.fits === b.fits && (a.economics.hourly ?? -Infinity) >= (b.economics.hourly ?? -Infinity)),
    );
  }
  assert.equal(trips.at(-1).sku, "pot", "no units and no hourly figure ranks last");
});
