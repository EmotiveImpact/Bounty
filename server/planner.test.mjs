import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCESS_NEEDS,
  CAR_BOOT_KG,
  HAND_CARRY_KG,
  REASONS,
  defaults,
  describeRules,
  journeyFor,
  loadLimit,
  missingInputs,
  offerDemand,
  offers,
  plan,
  planTrips,
  rankTrips,
  readProfile,
  readRules,
} from "./catalog.mjs";
import { DEFAULT_GOALS, tripTiming } from "./goals.mjs";
import { HttpError } from "./http.mjs";
import { OPPORTUNITY_RULES, demandUnits } from "./opportunity.mjs";

const NOW = "2026-10-31T12:00:00Z"; // a Saturday
const bySku = Object.fromEntries(offers.map((o) => [o.sku, o]));
const { knit, baby, pot, jacket } = bySku;
const run = (offer, over = {}, opts = {}) => plan(offer, { ...defaults, ...over }, { now: NOW, ...opts });
const check = (trip, id) => trip.alert.checks.find((c) => c.id === id);
const goals = (over = {}) => ({ ...DEFAULT_GOALS, dispatchDays: [1, 2, 3, 4, 5], ...over });

// A test-only offer that meets every buying threshold: £10 a unit, 0.5 kg,
// a lower-median sale of £30, plenty of demand.
const strong = Object.freeze({
  sku: "strong",
  name: "Test item",
  variant: "Test",
  category: "general",
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
  salesPerWeek: 10,
  competingListings: 0,
  sample: true,
});
// The jumper as a proven item with plenty of demand, so tests of the other
// limits are not bound by the trial batch or the sales rate.
const roomy = Object.freeze({ ...knit, sku: "roomy", provenItem: true, salesPerWeek: 50, competingListings: 0 });

test("fixtures are labelled sample data with categories and modelled demand", () => {
  assert.equal(offers.length, 4);
  for (const o of offers) {
    assert.equal(o.sample, true);
    assert.ok(o.sales.length > 0);
    assert.ok(Object.isFrozen(o));
    assert.ok(["general", "clothing", "food"].includes(o.category), o.sku);
    assert.ok(Number.isFinite(o.salesPerWeek) && Number.isInteger(o.competingListings), o.sku);
    assert.equal(o.priceChecked, null);
    assert.equal(o.stockChecked, null);
  }
  assert.equal(jacket.category, "clothing");
  assert.equal(jacket.size, "Age 5 to 6");
});

test("clothing is costed with at least a 15% returns allowance and passes its category checks", () => {
  const p = run(jacket);
  assert.ok(p.returnsRate >= 0.15);
  assert.deepEqual(p.categoryFailures, []);
  assert.equal(p.economics.costs.returns, p.economics.sold * Math.round(p.salePrice * 0.15));
  assert.ok(!p.opportunity.reasons.includes("Category rules were not checked"));
  // A general item keeps the member's own allowance.
  assert.equal(run(pot, { transport: "Car" }).returnsRate, defaults.returnsRate);
  // A clothing item without a size goes to review.
  const noSize = run({ ...strong, category: "clothing", size: null });
  assert.equal(noSize.opportunity.tier, "Review");
  assert.ok(noSize.opportunity.reasons.some((r) => r.startsWith("Clothing needs a size")));
});

test("the cash constraint includes the journey before allocating units", () => {
  // Public transport, £3 fare: each jumper needs £6 + 35p + £2.70 = £9.05 of cash.
  const p = run(roomy, { transport: "Public transport", fare: 300, budget: 2200, quantity: 10 });
  assert.equal(p.journey.cost, 300);
  assert.equal(p.units, 2); // 3 units would need £27.15 + £3 fare
  assert.equal(p.limit, "cash");
  assert.ok(p.economics.cashRequired <= 2200);
  assert.equal(p.economics.cashRequired, 2 * 905 + 300);
  const roomyBudget = run(roomy, { transport: "Public transport", fare: 300, budget: 3014, quantity: 10 });
  assert.equal(roomyBudget.units, 2, "2715 + 300 = 3015 is over a 3014 budget");
  assert.equal(run(roomy, { transport: "Public transport", fare: 300, budget: 3015, quantity: 10 }).units, 3);
  assert.equal(
    p.economics.contribution,
    p.economics.proceeds - Object.values(p.economics.costs).reduce((a, b) => a + b, 0),
  );
});

test("the carry limit stops a heavy item from qualifying on foot", () => {
  const p = run(pot);
  assert.equal(p.units, 0);
  assert.equal(p.limit, "carry");
  assert.equal(p.reason, REASONS.LIMIT);
  assert.equal(p.economics.contribution, 0);
  assert.equal(p.economics.costs.travel, 0, "no units means no trip");
  assert.equal(run(roomy, { carry: 0.96, quantity: 10 }).units, 3, "0.96 kg holds three 0.32 kg units");
  assert.equal(run(roomy, { carry: 0.96, quantity: 10 }).limit, "carry");
});

test("storage at home, stock and the maximum units bound the trip", () => {
  const p = run(roomy, { storage: 2, quantity: 10 });
  assert.equal(p.units, 2);
  assert.equal(p.limit, "storage");
  const none = run(roomy, { storage: 0 });
  assert.equal(none.units, 0);
  assert.equal(none.reason, REASONS.LIMIT);
  assert.equal(run(roomy, { quantity: 50, carry: 50, storage: 50 }).limit, "stock");
  assert.equal(run(roomy, { quantity: 50, carry: 50, storage: 50 }).units, knit.stock);
  assert.equal(run(roomy, { quantity: 2 }).limit, "quantity");
});

test("a first purchase is capped at the trial batch and fits only within it", () => {
  // Default profile: four units allowed, jacket demand five, trial batch three.
  const p = run(jacket);
  assert.equal(p.units, OPPORTUNITY_RULES.trialUnits);
  assert.equal(p.limit, "trial");
  assert.equal(p.caps.trial, 3);
  assert.equal(p.afterTrial, 4, "the larger quantity is reported as a later option");
  assert.equal(p.reason, REASONS.FITS);
  assert.equal(check(p, "trial-batch").ok, true);
  // A stricter trial batch of two plans two.
  const two = run(jacket, { rules: { trialUnits: 2 } });
  assert.equal(two.units, 2);
  assert.equal(two.limit, "trial");
  // A looser trial batch has no effect.
  assert.equal(run(jacket, { rules: { trialUnits: 10 } }).units, 3);
  // Under any profile, no fixture is planned above the trial batch, and a
  // fitting trip always passes the trial check.
  for (const o of offers)
    for (const over of [{}, { transport: "Car", carry: 50, budget: 100000, quantity: 20, storage: 50 }, { rules: { trialUnits: 1 } }]) {
      const t = run(o, over);
      assert.ok(t.units <= t.trialUnits, o.sku + " " + JSON.stringify(over));
      if (t.fits) assert.equal(check(t, "trial-batch").ok, true, o.sku);
    }
});

test("quantity respects the sales rate and competing listings in the shared sell window", () => {
  // The planner uses the same window and demand rule as every other area.
  const p = run(knit, { quantity: 10 });
  assert.equal(p.sellWindowWeeks, OPPORTUNITY_RULES.sellWindowWeeks);
  // Jumper: 2.5 sales a week for two weeks is 5, less 3 competing listings.
  assert.equal(offerDemand(knit), demandUnits(knit, OPPORTUNITY_RULES.sellWindowWeeks));
  assert.equal(offerDemand(knit), 2);
  assert.equal(p.demandUnits, 2);
  assert.equal(p.units, 2);
  assert.equal(p.limit, "demand");
  // Competition that absorbs the demand leaves nothing to buy.
  const crowded = run({ ...strong, competingListings: 20 });
  assert.equal(crowded.units, 0);
  assert.equal(crowded.limit, "demand");
  assert.equal(crowded.reason, REASONS.LIMIT);
  // Unknown demand is null, never zero or plenty, and fails closed at 0 units.
  assert.equal(offerDemand({ ...strong, salesPerWeek: null }), null);
  assert.equal(offerDemand({ ...strong, competingListings: undefined }), null);
  const unknown = run({ ...strong, salesPerWeek: undefined });
  assert.equal(unknown.units, 0);
  assert.equal(unknown.demandUnits, null);
});

test("the alert gate gets the planned units, the demand and every blank cost or time", () => {
  // Jacket: three units against modelled demand of five in two weeks.
  const p = run(jacket);
  assert.equal(check(p, "demand").ok, true);
  assert.match(check(p, "demand").detail, /within 2 weeks/);
  assert.equal(check(p, "inputs-entered").ok, true, "every fixture cost and time is entered");
  // Unknown competition fails the demand check, not just the quantity.
  const unknown = run({ ...strong, competingListings: null });
  assert.equal(check(unknown, "demand").ok, false);
  assert.match(check(unknown, "demand").detail, /unknown/);
  // A blank parcel cost is never zero: it is named, the profit per unit is
  // not checked, and the offer is not shortlisted.
  const blank = run({ ...strong, post: undefined });
  assert.deepEqual(missingInputs({ ...strong, post: undefined }, { ...defaults }), ["parcel cost"]);
  assert.equal(check(blank, "inputs-entered").ok, false);
  assert.match(check(blank, "inputs-entered").detail, /^Not entered: parcel cost/);
  assert.equal(blank.thresholds.ok, false);
  assert.deepEqual(blank.thresholds.failures, ["Profit per unit cannot be checked until these are entered: parcel cost"]);
  assert.equal(blank.opportunity.tier, "Review");
  // By public transport with no fare, the fare is a blank input too.
  const bus = run(jacket, { transport: "Public transport", fare: null });
  assert.equal(check(bus, "inputs-entered").ok, false);
  assert.match(check(bus, "inputs-entered").detail, /public transport fare/);
  assert.equal(check(run(jacket, { transport: "Public transport", fare: 0 }), "inputs-entered").ok, true);
  // Sample offers never become an alert, whatever passes.
  assert.equal(run(strong).alert.eligible, false);
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
  // A £60 fare wipes out the margin on two jumpers.
  const p = run(knit, { transport: "Public transport", fare: 6000 });
  assert.ok(p.economics.contribution <= 0);
  assert.equal(p.reason, REASONS.LOSS);
  assert.equal(p.fits, false);
  // A zero-margin trip also loses: break-even is not a fit.
  const zero = run({ ...strong, sales: [1000] }, { target: 0 });
  assert.ok(zero.economics.contribution <= 0);
  assert.equal(zero.reason, REASONS.LOSS);
  // Even with no hourly target, a sample trip never fits when it loses money.
  let losses = 0;
  for (const o of offers)
    for (const fare of [0, 6000, 20000]) {
      const r = run(o, { transport: "Public transport", fare, budget: 1_000_000, target: 0 });
      if (r.economics.contribution <= 0) {
        losses++;
        assert.notEqual(r.reason, REASONS.FITS);
      }
    }
  assert.ok(losses > 0, "the loop covers losing trips");
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

test("the profile defaults to no public transport fare entered", () => {
  assert.equal(defaults.fare, null);
  assert.equal(readProfile({ ...defaults }).fare, null);
  // Walking, cycling and driving never need the fare.
  for (const transport of ["Walk", "Bicycle", "Car", "Van"])
    assert.equal(run(jacket, { transport, carry: 5 }).fareMissing, false, transport);
});

test("public transport with no fare entered is never called fitting", () => {
  const missing = run(jacket, { transport: "Public transport", fare: null });
  assert.equal(missing.fareMissing, true);
  assert.equal(missing.economics.costs.travel, 0);
  assert.equal(missing.reason, REASONS.FARE);
  assert.equal(missing.fits, false);
  // A fare of 0 that was entered (free travel) is accepted.
  const free = run(jacket, { transport: "Public transport", fare: 0 });
  assert.equal(free.fareMissing, false);
  assert.equal(free.reason, REASONS.FITS);
  // Other transport never needs a fare.
  assert.equal(run(jacket, { fare: null }).reason, REASONS.FITS);
  // The route accepts null as "not entered" but not other non-numbers.
  assert.equal(readProfile({ ...defaults, fare: null }).fare, null);
  assert.throws(() => readProfile({ ...defaults, fare: "" }), HttpError);
  // Drivers comparing with public transport are told the fare is missing.
  const c = run(jacket, { transport: "Car", fare: null }).compare;
  assert.ok(c.assumptions.some((a) => a.includes("No public transport fare is entered")));
  assert.equal(c.alternative.reason === REASONS.FITS, false);
});

test("the journey is shared across units, not charged per unit", () => {
  const one = run(roomy, { transport: "Car", quantity: 1 });
  const four = run(roomy, { transport: "Car", quantity: 4 });
  assert.equal(four.units, 4);
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
      assert.ok(failed.has("availability"), "no branch check has found stock");
      assert.ok(p.alert.checks.some((c) => c.id === "trial-batch"));
    }
});

test("check wording matches the illustrative figures shown", () => {
  const p = run(jacket);
  const all = [...p.alert.reasons, ...p.opportunity.reasons, ...p.alert.checks.map((c) => c.detail)];
  assert.ok(!all.includes("Parcel cost unknown"), "the money table shows a parcel cost");
  assert.equal(check(p, "shipping").ok, false, "an illustrative parcel cost is not a quote");
  assert.match(check(p, "shipping").detail, /illustrative/);
  assert.ok(p.opportunity.reasons.some((r) => /illustrative/.test(r)));
});

test("every trip carries an honest opportunity tier", () => {
  const tiers = Object.fromEntries(offers.map((o) => [o.sku, run(o).opportunity]));
  assert.equal(tiers.knit.tier, "Review", "sample evidence needs review");
  assert.ok(tiers.knit.reasons.includes("Sample or illustrative figures never trigger a buy alert"));
  assert.equal(tiers.jacket.tier, "Review");
  assert.equal(tiers.baby.tier, "Reject", "£4.50 is below the £5 purchase price floor");
  assert.equal(tiers.pot.tier, "Reject", "10 kg is over the 2 kg limit");
  for (const t of Object.values(tiers)) {
    assert.equal(t.meetsThresholds, false);
    assert.ok(!t.reasons.includes("Category rules were not checked"));
  }
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

test("a return below 35% fails the profile fit even with more than £5 profit", () => {
  // £20 a unit with no parcel or packaging: a £33.40 sale leaves £6.99 profit,
  // 34.95% of the purchase price.
  const thin = { ...strong, buy: 2000, post: 0, pack: 0, sales: [3340] };
  const p = run(thin, { target: 0, quantity: 1 });
  assert.equal(p.thresholds.unitProfit, 699);
  assert.ok(p.thresholds.unitProfit >= OPPORTUNITY_RULES.minUnitProfit);
  assert.equal(p.thresholds.ok, false);
  assert.deepEqual(p.thresholds.failures, ["Return of 34.9% is below 35% of the purchase price"]);
  assert.equal(p.reason, REASONS.THRESHOLDS);
  assert.equal(p.fits, false);
  // A penny more profit (£7.00, exactly 35%) passes.
  const enough = run({ ...thin, sales: [3341] }, { target: 0, quantity: 1 });
  assert.equal(enough.thresholds.unitProfit, 700);
  assert.equal(enough.thresholds.ok, true, enough.thresholds.failures.join("; "));
  assert.equal(enough.reason, REASONS.FITS);
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
  // A one-unit trial batch plans one unit.
  const trial = run(jacket, { rules: { trialUnits: 1 } });
  assert.equal(trial.units, 1);
  assert.equal(check(trial, "trial-batch").ok, true);
});

test("threshold overrides are validated, including names of object built-ins", () => {
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
    { toString: 1 },
    { constructor: 1 },
    { hasOwnProperty: 1 },
    JSON.parse('{"__proto__": 1}'),
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
    ["transport", "toString"],
    ["budget", 100.5],
    ["budget", -1],
    ["quantity", 0],
    ["quantity", 1.5],
    ["carry", -1],
    ["fare", "3"],
    ["fare", undefined],
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
  // Messages name the field as the Planner labels it, never a raw field name.
  for (const [field, value] of [["budget", -1], ["fare", -5], ["feeRate", 0.9], ["perMile", 1.5], ["rules", { minReturn: -1 }]]) {
    try {
      readProfile({ ...defaults, [field]: value });
      assert.fail("accepted " + field);
    } catch (e) {
      assert.doesNotMatch(e.message, /\b(budget|feeRate|perMile|minReturn|returnsRate|feeFixed)\b|rules\.|\(pence\b/, e.message);
    }
  }
});

test("load limits follow one rule for each transport", () => {
  assert.equal(loadLimit("Walk", 5), 5);
  assert.equal(loadLimit("Bicycle", 12), 12);
  assert.equal(loadLimit("Car", 5), CAR_BOOT_KG);
  assert.equal(loadLimit("Van", 40), 40);
  assert.equal(loadLimit("Public transport", 40), HAND_CARRY_KG);
  assert.equal(loadLimit("Public transport", 4), 4);
  // The member's own car plan uses the car-boot load, as the comparison does.
  const car = run(pot, { transport: "Car" });
  assert.equal(car.carry, CAR_BOOT_KG);
  assert.equal(car.carryEntered, 5);
  assert.equal(car.units, 2, "25 kg holds two 10 kg planters");
});

test("What changes if I drive? agrees with the plan for that transport", () => {
  // Walking compares with the car; the car plan must show the same figures.
  for (const o of offers)
    for (const over of [{}, { perMile: 60, extra: 250 }, { carry: 40 }]) {
      const c = run(o, over).compare;
      const car = run(o, { ...over, transport: "Car" }, { compare: false });
      assert.equal(c.alternative.mode, "Car");
      for (const [k, v] of [
        ["carry", car.carry],
        ["units", car.units],
        ["loadKg", car.weightKg],
        ["travelCost", car.economics.costs.travel],
        ["cashRequired", car.economics.cashRequired],
        ["contribution", car.economics.contribution],
        ["hourly", car.economics.hourly],
        ["reason", car.reason],
      ])
        assert.equal(c.alternative[k], v, `${o.sku} ${k} ${JSON.stringify(over)}`);
    }
  // Drivers compare with public transport, which must match the public transport plan.
  for (const o of offers)
    for (const over of [{ transport: "Van", carry: 100, fare: 380 }, { transport: "Car", carry: 4, fare: 250 }]) {
      const c = run(o, over).compare;
      const bus = run(o, { ...over, transport: "Public transport" }, { compare: false });
      assert.equal(c.alternative.mode, "Public transport");
      assert.equal(c.alternative.carry, bus.carry);
      assert.equal(c.alternative.units, bus.units);
      assert.equal(c.alternative.contribution, bus.economics.contribution);
      assert.equal(c.alternative.reason, bus.reason);
    }
  assert.equal(run(knit, { transport: "Van", carry: 100, fare: 380 }).compare.alternative.carry, HAND_CARRY_KG);
});

test("the comparison shows mileage, parking, total load and time saved", () => {
  const p = run(pot, { perMile: 60, extra: 250 });
  const c = p.compare;
  assert.equal(c.heading, "What changes if I drive?");
  assert.equal(c.current.mode, "Walk");
  assert.equal(c.current.units, 0);
  assert.equal(c.current.miles, 0, "no units means no trip");
  assert.equal(c.alternative.carry, CAR_BOOT_KG);
  assert.equal(c.alternative.units, 2);
  assert.equal(c.alternative.loadKg, 20);
  assert.equal(c.alternative.miles, 5);
  assert.equal(c.alternative.parking, 250);
  assert.equal(c.alternative.travelCost, Math.round(5 * 60) + 250);
  for (const k of ["units", "loadKg", "miles", "parking", "travelCost", "travelMinutes", "cashRequired", "contribution"])
    assert.equal(c.difference[k], c.alternative[k] - c.current[k], k);
  assert.equal(c.difference.hourly, null, "no hourly figure without units on foot");
  assert.equal(c.timeSaved, null);
  assert.ok(c.assumptions.some((a) => a.includes("25 kg")));
  // With a trip both ways, time saved is the walking minutes less the driving minutes.
  const j = run(jacket).compare;
  assert.equal(j.timeSaved, j.current.travelMinutes - j.alternative.travelMinutes);
  assert.ok(j.timeSaved > 0);
  assert.equal(j.current.parking, 0);
  assert.equal(j.current.loadKg, 1.35);
});

test("the shortlist leaves out every offer failing a buying threshold", () => {
  const { trips, rejected, sample } = planTrips({ ...defaults }, { now: NOW });
  assert.equal(sample, true);
  // The jumper makes £2.42 a unit, under the £5 minimum, so only the jacket
  // is shortlisted.
  assert.deepEqual(trips.map((t) => t.sku), ["jacket"]);
  assert.ok(trips.every((t) => t.thresholds.ok));
  assert.deepEqual(rejected.map((r) => r.sku).sort(), ["baby", "knit", "pot"]);
  const reasons = Object.fromEntries(rejected.map((r) => [r.sku, r.reasons]));
  assert.deepEqual(reasons.baby, ["Purchase price outside £5 to £50 per unit"]);
  assert.deepEqual(reasons.pot, ["Unit weighs 2 kg or more"]);
  assert.deepEqual(reasons.knit, ["Profit per unit of £2.42 is below £5.00"]);
  const knitRow = rejected.find((r) => r.sku === "knit");
  assert.equal(knitRow.unitProfit, 242);
  assert.equal(knitRow.units, 2);
  assert.ok(rejected.every((r) => r.sample === true && r.tier === "Reject"));
  // Whatever the profile, nothing in the shortlist fails a threshold.
  for (const over of [{}, { transport: "Car" }, { transport: "Public transport", fare: 450 }, { target: 0 }, { budget: 2000 }])
    for (const t of planTrips({ ...defaults, ...over }, { now: NOW }).trips)
      assert.equal(t.thresholds.ok, true, t.sku + " " + JSON.stringify(over));
  // A member's stricter price floor moves the jumper out for its price too.
  const strict = planTrips({ ...defaults, rules: { minUnitPrice: 700 } }, { now: NOW });
  assert.deepEqual(strict.trips.map((t) => t.sku), ["jacket"]);
  assert.ok(strict.rejected.find((r) => r.sku === "knit").reasons.includes("Purchase price outside £7 to £50 per unit"));
  // Stricter profit or return rules move the jacket out as well (£7.13, 71.3%).
  const profit = planTrips({ ...defaults, rules: { minUnitProfit: 800 } }, { now: NOW });
  assert.deepEqual(profit.trips, []);
  assert.deepEqual(profit.rejected.find((r) => r.sku === "jacket").reasons, ["Profit per unit of £7.13 is below £8.00"]);
  const ret = planTrips({ ...defaults, rules: { minReturn: 0.75 } }, { now: NOW });
  assert.deepEqual(ret.trips, []);
  assert.deepEqual(ret.rejected.find((r) => r.sku === "jacket").reasons, ["Return of 71.3% is below 75% of the purchase price"]);
  // An offer where no unit fits cannot show its profit, so it is not shortlisted either.
  const none = planTrips({ ...defaults, storage: 0 }, { now: NOW });
  assert.deepEqual(none.trips, []);
  assert.deepEqual(none.rejected.find((r) => r.sku === "jacket").reasons, [
    "No units fit: stopped by your storage at home, so profit per unit cannot be checked",
  ]);
  assert.equal(none.rejected.find((r) => r.sku === "jacket").tier, "Review", "no profit was measured to reject");
});

test("the drive summary lists opportunities that only fit by car", () => {
  // At £20 an hour the jacket is too slow on foot but fits by car.
  const r = planTrips({ ...defaults, target: 2000 }, { now: NOW });
  assert.equal(r.drive.current, "Walk");
  assert.equal(r.drive.alternative, "Car");
  assert.deepEqual(r.drive.extra.map((t) => t.sku), ["jacket"]);
  const extra = r.drive.extra[0];
  assert.equal(extra.reason, REASONS.FITS);
  assert.equal(extra.units, 3);
  assert.equal(r.drive.lost.length, 0);
  // Offers outside the price or weight limits are never offered as extra opportunities.
  const hard = ["baby", "pot"];
  assert.ok(r.drive.extra.every((t) => !hard.includes(t.sku)));
  // At the default target the jacket already fits on foot, so nothing is extra.
  assert.deepEqual(planTrips({ ...defaults }, { now: NOW }).drive.extra, []);
  // With a 0.3 kg carry limit no jacket fits on foot, so it is not
  // shortlisted, but by car it fits every threshold and is an extra.
  const light = planTrips({ ...defaults, carry: 0.3 }, { now: NOW });
  assert.ok(light.rejected.some((x) => x.sku === "jacket"));
  assert.deepEqual(light.drive.extra.map((t) => t.sku), ["jacket"]);
  assert.equal(light.drive.extra[0].reason, REASONS.FITS);
});

test("access needs are labelled for each offer and this member", () => {
  const ids = (o, over = {}) => run(o, over).accessNeeds.map((n) => n.id);
  assert.deepEqual(
    ACCESS_NEEDS.map((n) => n.label),
    ["Widely accessible", "Vehicle required", "Heavy handling", "Limited local stock", "Specialist storage"],
  );
  assert.deepEqual(ids(knit), ["widely-accessible"]);
  assert.deepEqual(ids(jacket), ["limited-stock"], "four assumed on the shelf");
  assert.deepEqual(ids(pot), ["vehicle-required", "heavy-handling", "limited-stock", "specialist-storage"]);
  // A member who can carry 12 kg does not need a vehicle, but the load is still heavy.
  assert.deepEqual(ids(pot, { carry: 12 }), ["heavy-handling", "limited-stock", "specialist-storage"]);
  for (const o of offers) for (const n of run(o).accessNeeds) assert.ok(n.label && n.detail, o.sku);
  // Rejected offers keep their labels.
  const { rejected } = planTrips({ ...defaults }, { now: NOW });
  assert.ok(rejected.find((r) => r.sku === "pot").accessNeeds.some((n) => n.id === "vehicle-required"));
});

test("cards say when price and stock were checked and the main uncertainty", () => {
  for (const o of offers) {
    const p = run(o);
    assert.deepEqual(p.checked, { price: null, stock: null });
    assert.match(p.mainUncertainty, /Sample figures/);
  }
});

test("payout timing comes from the saved goals and the cash date gates the fit", () => {
  const timing = tripTiming(goals(), { now: NOW });
  // Saturday 31 October: sold Saturday 7 November, posted Monday 9, delivered
  // Wednesday 11, paid out Friday 13 November.
  assert.equal(timing.payout.date, "2026-11-13");
  assert.equal(timing.payoutDays, 13);
  assert.equal(timing.cashNeededDays, null);
  const p = run(jacket, {}, { timing });
  assert.equal(p.timing.payoutDays, 13);
  assert.equal(p.reason, REASONS.FITS);
  // A cash date before the payout stops the trip fitting and is passed to the alert gate.
  const early = tripTiming(goals({ cashNeededBy: "2026-11-10" }), { now: NOW });
  assert.equal(early.cashNeededDays, 10);
  assert.equal(early.cash.status, "late");
  const late = run(jacket, {}, { timing: early });
  assert.equal(late.reason, REASONS.CASH_DATE);
  assert.equal(late.fits, false);
  assert.equal(check(late, "days-to-sell").ok, false);
  // A cash date after the payout lets the trip fit again.
  const fine = run(jacket, {}, { timing: tripTiming(goals({ cashNeededBy: "2026-11-30" }), { now: NOW }) });
  assert.equal(fine.reason, REASONS.FITS);
  // With no dispatch days the payout cannot be scheduled, so a cash date cannot be met.
  const unknown = run(jacket, {}, { timing: tripTiming(goals({ dispatchDays: [], cashNeededBy: "2026-11-30" }), { now: NOW }) });
  assert.equal(unknown.timing.payoutDays, null);
  assert.equal(unknown.reason, REASONS.CASH_DATE);
  // planTrips carries the timing through.
  const r = planTrips({ ...defaults }, { now: NOW, timing });
  assert.equal(r.timing.payoutDays, 13);
  assert.ok(r.trips.every((t) => t.timing.payoutDays === 13));
});

test("several units are paid out only once the sales rate can sell them all", () => {
  // A proven jumper selling one a week: two units take 14 days to sell, not
  // the 7 days the Goals assume for one unit.
  const slow = { ...strong, sku: "slow", salesPerWeek: 1, competingListings: 0 };
  const g = goals({ cashNeededBy: "2026-11-20" });
  const timing = (sale) => tripTiming(g, { now: NOW, items: [sale] });
  const p = run(slow, { quantity: 10, target: 0 }, { timing });
  assert.equal(p.units, 2);
  assert.equal(p.limit, "demand");
  assert.equal(p.reason, REASONS.FITS);
  assert.equal(p.timing.daysToSell, 14);
  assert.equal(p.timing.daysToSellOneUnit, 7);
  // Sold Saturday 14 November, posted Monday 16, paid out Friday 20: on time.
  assert.equal(p.timing.payout.date, "2026-11-20");
  // One unit alone would be paid out on 13 November.
  assert.equal(tripTiming(g, { now: NOW }).payout.date, "2026-11-13");
  // A cash date between the two is met by one unit but not by two.
  const tight = goals({ cashNeededBy: "2026-11-16" });
  const late = run(slow, { quantity: 10, target: 0 }, { timing: (sale) => tripTiming(tight, { now: NOW, items: [sale] }) });
  assert.equal(late.reason, REASONS.CASH_DATE);
  assert.equal(check(late, "days-to-sell").ok, false);
  assert.equal(tripTiming(tight, { now: NOW }).cash.status, "on time");
  // An unknown sales rate for more than one unit cannot be scheduled.
  const unknown = tripTiming(g, { now: NOW, items: [{ units: 2, salesPerWeek: null }] });
  assert.equal(unknown.payout.date, null);
  assert.match(unknown.payout.note, /sales rate is unknown/);
  assert.equal(unknown.cash.status, "unknown");
  // The comparison by car uses its own units for its payout.
  assert.equal(p.compare.alternative.units, 2);
  // planTrips reports the one-unit payout at the top level.
  assert.equal(planTrips({ ...defaults }, { now: NOW, timing }).timing.payout.date, "2026-11-13");
});

test("trips rank fitting first, then by earnings per hour", () => {
  const { trips: shortlisted, rules } = planTrips({ ...defaults, target: 0 }, { now: NOW });
  assert.deepEqual(rules.effective.minUnitPrice, OPPORTUNITY_RULES.minUnitPrice);
  assert.equal(shortlisted[0].sku, "jacket");
  // Only the jacket clears the thresholds among the fixtures, so rank test
  // offers that all clear them: one that fits, a faster one that does not.
  const trips = [
    run({ ...strong, sku: "slow", handlingMinutes: 60 }, { target: 0 }),
    run({ ...strong, sku: "quick" }, { target: 0 }),
    run({ ...strong, sku: "far", miles: 9 }, { target: 3000 }),
  ].sort(rankTrips);
  assert.deepEqual(trips.map((t) => t.sku), ["quick", "slow", "far"]);
  for (let i = 1; i < trips.length; i++) {
    const [a, b] = [trips[i - 1], trips[i]];
    assert.ok(
      Number(a.fits) > Number(b.fits) ||
        (a.fits === b.fits && (a.economics.hourly ?? -Infinity) >= (b.economics.hourly ?? -Infinity)),
    );
  }
});
