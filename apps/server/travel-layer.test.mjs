// Round 5 (Edem): travel is an added layer, not a blocker. A blank public
// transport fare must no longer hide an item: the Planner shortlist and the
// Goals baskets keep every item that is inside the buying thresholds on what
// is known (profit after fees, packaging and postage, before travel), rank
// them on that, and show the travel as not known yet. A blank fare is still
// never counted as zero or free: every figure after travel stays null and the
// figures before travel are labelled as such. Items that fail on what is
// already known are still left out, and a fare once entered works as before.
//
// Every test goes through the real plan and basket routes, except the two
// that check the ranking rule and a losing offer, which need a test-only
// offer the routes cannot be given.
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb, serve } from "./test-support.mjs";
import { FARE_NEEDED, REASONS, defaults, offers, plan, rankTrips } from "./catalog.mjs";
import { schema } from "./goals.mjs";
import * as planRoutes from "./routes-plan.mjs";

const NOW = "2026-10-31T12:00:00Z";
const bus = (over = {}) => ({ ...defaults, transport: "Public transport", fare: null, ...over });
const bySku = (rows) => Object.fromEntries(rows.map((r) => [r.sku, r]));
const offer = bySku(offers);

async function withApi(fn) {
  const api = await serve(memoryDb(schema), [planRoutes]);
  try {
    return await fn(api);
  } finally {
    await api.close();
  }
}
const ok = (res) => {
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};

test("a blank fare shortlists the items inside the thresholds before travel, ranked before travel and labelled", () =>
  withApi(async (api) => {
    const r = ok(await api.call("POST", "/api/plan", bus()));
    // The jacket and the bottle clear every threshold before travel: both
    // are shortlisted, ranked by profit per unit before the fare.
    assert.deepEqual(r.trips.map((t) => t.sku), ["jacket", "bottle"]);
    assert.equal(r.ranking, "before travel");
    assert.ok(r.trips[0].beforeTravel.unitProfit > r.trips[1].beforeTravel.unitProfit);
    for (const t of r.trips) {
      const o = offer[t.sku];
      const bt = t.beforeTravel;
      // The travel is visible and not known: never zero, never free.
      assert.equal(t.fareMissing, true, t.sku);
      assert.equal(t.journey.cost, null, t.sku);
      assert.ok(t.journey.minutes > 0, "the journey time is still known");
      for (const k of ["contribution", "unitContribution", "cashRequired", "journeyPerUnit", "hourly", "unsoldLoss", "totalCosts"])
        assert.equal(t.economics[k], null, `${t.sku} ${k} after travel`);
      assert.equal(t.economics.costs.travel, null, t.sku);
      assert.equal(t.downside.nothingSells, null, t.sku);
      assert.equal(t.thresholds.unitProfit, null, "no profit after travel");
      // What is known: profit after fees, packaging and postage, before travel.
      assert.ok(bt.unitProfit >= 500, `${t.sku} clears £5 a unit before travel`);
      assert.equal(bt.unitProfit, Math.floor(bt.contribution / t.units), t.sku);
      assert.equal(bt.cashRequired, t.units * (o.buy + o.pack + o.post), "cash before the fare");
      assert.ok(Number.isFinite(bt.hourly) && Number.isFinite(bt.unsoldLoss) && Number.isFinite(bt.halfSells), t.sku);
      // The verdict: inside before travel, after travel still to be checked.
      assert.equal(t.thresholds.ok, false, "never a pass after travel");
      assert.equal(t.thresholds.fareNeeded, true, t.sku);
      assert.deepEqual(t.thresholds.beforeTravel, { unitProfit: bt.unitProfit, returnOnCost: bt.returnOnCost, ok: true });
      assert.deepEqual(t.thresholds.failures, [FARE_NEEDED]);
      assert.equal(t.travelNote, FARE_NEEDED);
      assert.match(FARE_NEEDED, /^Travel cost still to be added/);
      assert.equal(t.reason, REASONS.FARE);
      assert.equal(t.fits, false, "never called fitting while the fare is blank");
      // Sample data never becomes a buy alert, and the blank fare is named.
      assert.equal(t.alert.eligible, false);
      const inputs = t.alert.checks.find((c) => c.id === "inputs-entered");
      assert.equal(inputs.ok, false);
      assert.match(inputs.detail, /public transport fare/);
      assert.match(t.alert.checks.find((c) => c.id === "journey").detail, /travel cost is not known yet/);
    }
    // The figures before travel are the trip with the journey left out: the
    // same as a free fare's, but labelled before travel, never as its profit.
    const free = bySku(ok(await api.call("POST", "/api/plan", bus({ fare: 0 }))).trips);
    for (const t of r.trips) {
      assert.equal(t.beforeTravel.contribution, free[t.sku].economics.contribution, t.sku);
      assert.equal(free[t.sku].beforeTravel, null, "a fare of 0 entered is known travel");
    }
  }));

test("with a fare entered everything works as today: travel shared across units, thresholds after travel", () =>
  withApi(async (api) => {
    const blank = bySku(ok(await api.call("POST", "/api/plan", bus())).trips);
    const r = ok(await api.call("POST", "/api/plan", bus({ fare: 450 })));
    assert.equal(r.ranking, "after travel");
    // The jacket clears £5 a unit after its share of the £4.50 fare; the
    // bottle (£5.72 before travel) does not, so it leaves the shortlist.
    assert.deepEqual(r.trips.map((t) => t.sku), ["jacket"]);
    const t = r.trips[0];
    const before = blank.jacket.beforeTravel;
    assert.equal(t.economics.costs.travel, 450);
    assert.equal(t.journey.cost, 450);
    assert.equal(t.economics.contribution, before.contribution - 450, "one journey, not one per unit");
    assert.equal(t.thresholds.unitProfit, Math.floor((before.contribution - 450) / t.units));
    assert.equal(t.economics.journeyPerUnit, Math.round(450 / t.units));
    assert.equal(t.economics.cashRequired, before.cashRequired + 450);
    assert.equal(t.thresholds.ok, true);
    assert.equal(t.thresholds.fareNeeded, false);
    assert.equal(t.thresholds.beforeTravel, null);
    assert.equal(t.beforeTravel, null);
    assert.equal(t.travelNote, null);
    assert.equal(t.reason, REASONS.FITS);
    assert.equal(t.alert.eligible, false, "still sample data");
    const rejected = bySku(r.rejected);
    assert.deepEqual(rejected.bottle.reasons, ["Profit per unit of £4.22 is below £5.00"]);
    assert.equal(rejected.bottle.tier, "Reject");
  }));

test("items that fail on what is already known are still left out with a blank fare", () =>
  withApi(async (api) => {
    const r = ok(await api.call("POST", "/api/plan", bus()));
    const rejected = bySku(r.rejected);
    assert.deepEqual(Object.keys(rejected).sort(), ["baby", "knit", "pot"]);
    assert.deepEqual(rejected.knit.reasons, ["Profit per unit of at most £2.42 is below £5.00, even before your public transport fare"]);
    assert.deepEqual(rejected.baby.reasons, ["Purchase price outside £5 to £50 per unit"]);
    assert.deepEqual(rejected.pot.reasons, ["Unit weighs 2 kg or more"]);
    // Fees and returns at the 50% maximum make every sale a loss even before
    // the fare: nothing is shortlisted or put in a basket.
    const dear = bus({ feeRate: 0.5, returnsRate: 0.5 });
    const losing = ok(await api.call("POST", "/api/plan", dear));
    assert.deepEqual(losing.trips, []);
    for (const x of losing.rejected.filter((x) => !["baby", "pot"].includes(x.sku)))
      assert.match(x.reasons.join("; "), /^Profit per unit of at most -£[\d.]+ is below £5\.00, even before your public transport fare/, x.sku);
    const baskets = ok(await api.call("POST", "/api/baskets", { profile: dear }));
    assert.deepEqual(baskets.baskets, []);
    assert.equal(baskets.recommended, null);
    for (const sku of ["jacket", "bottle"]) {
      const e = baskets.excluded.find((x) => x.sku === sku);
      assert.equal(e.rejected, true, sku);
      assert.match(e.reason, /\(even before its share of the journey\)$/, sku);
    }
    // No cash at all: no unit fits, so nothing is shortlisted.
    const broke = ok(await api.call("POST", "/api/plan", bus({ budget: 0 })));
    assert.deepEqual(broke.trips, []);
    assert.deepEqual(bySku(broke.rejected).jacket.reasons, ["No units fit: stopped by your available cash, so profit per unit cannot be checked"]);
  }));

test("an offer that loses money before travel is rejected with a blank fare, never shortlisted", () => {
  const losing = { ...offer.jacket, sku: "losing", sales: [1200] };
  const t = plan(losing, bus(), { now: NOW });
  assert.equal(t.reason, REASONS.LOSS);
  assert.ok(t.beforeTravel.contribution <= 0);
  assert.equal(t.thresholds.fareNeeded, false);
  assert.equal(t.thresholds.beforeTravel.ok, false);
  assert.match(t.thresholds.failures[0], /^Profit per unit of at most -£[\d.]+ is below £5\.00, even before your public transport fare$/);
});

test("the drive comparison shows the public transport side before its fare and never a difference after travel", () =>
  withApi(async (api) => {
    const r = ok(await api.call("POST", "/api/plan", bus()));
    const t = bySku(r.trips).jacket;
    const { current: a, alternative: b, difference: d, differenceBeforeTravel: dbt } = t.compare;
    assert.equal(a.mode, "Public transport");
    assert.equal(b.mode, "Car");
    assert.equal(a.travelCost, null, "the fare is not known yet");
    assert.equal(a.contribution, null);
    assert.deepEqual(a.beforeTravel, {
      cashRequired: t.beforeTravel.cashRequired,
      contribution: t.beforeTravel.contribution,
      hourly: t.beforeTravel.hourly,
    });
    assert.equal(b.beforeTravel, null);
    assert.ok(Number.isFinite(b.contribution) && b.travelCost > 0);
    for (const k of ["travelCost", "cashRequired", "contribution", "hourly"]) assert.equal(d[k], null, `no ${k} difference after travel`);
    assert.equal(dbt.cashRequired, b.cashRequired - a.beforeTravel.cashRequired);
    assert.equal(dbt.contribution, b.contribution - a.beforeTravel.contribution);
    assert.equal(dbt.hourly, b.hourly - a.beforeTravel.hourly);
    assert.ok(t.compare.assumptions.some((s) => s.includes("not known yet") && s.includes("before your fare")));
    assert.equal(r.drive.currentFareMissing, true);
    assert.deepEqual(r.drive.extra.map((x) => x.sku).sort(), ["bottle", "jacket"]);
    for (const x of r.drive.extra) assert.ok(Number.isFinite(x.contribution), x.sku);

    // A driver with no fare: the public transport side is before its fare,
    // and the trips that fit by car are not called lost by public transport.
    const car = ok(await api.call("POST", "/api/plan", { ...defaults, transport: "Car", fare: null }));
    assert.deepEqual(car.trips.map((x) => x.beforeTravel), [null, null], "a driver's own trips are known");
    assert.deepEqual(car.drive.lost, []);
    assert.deepEqual(car.drive.fareNeeded.map((x) => x.sku).sort(), ["bottle", "jacket"]);
    for (const x of car.drive.fareNeeded) assert.ok(Number.isFinite(x.beforeTravel.contribution), x.sku);
    const c = bySku(car.trips).jacket.compare;
    assert.equal(c.alternative.contribution, null);
    assert.equal(c.differenceBeforeTravel.contribution, c.alternative.beforeTravel.contribution - c.current.contribution);

    // With a fare entered both sides are known: no before-travel difference.
    const known = bySku(ok(await api.call("POST", "/api/plan", bus({ fare: 450 }))).trips).jacket.compare;
    assert.deepEqual(known.differenceBeforeTravel, { cashRequired: null, contribution: null, hourly: null });
    assert.equal(known.difference.contribution, known.alternative.contribution - known.current.contribution);
  }));

test("trips waiting for a fare rank after known ones, fitting before the fare first, then on profit per unit before travel", () =>
  withApi(async (api) => {
    // £23 an hour: the jacket (higher profit per unit) misses it even before
    // its fare, the bottle meets it before its fare, so the bottle ranks first.
    const r = ok(await api.call("POST", "/api/plan", bus({ target: 2300 })));
    const t = bySku(r.trips);
    assert.equal(t.jacket.reason, REASONS.HOURLY);
    assert.equal(t.bottle.reason, REASONS.FARE);
    assert.ok(t.jacket.beforeTravel.unitProfit > t.bottle.beforeTravel.unitProfit);
    assert.deepEqual(r.trips.map((x) => x.sku), ["bottle", "jacket"]);
    // A known trip outranks one whose figures are only the best before its
    // fare, even when that best is higher.
    const walked = plan(offer.bottle, { ...defaults }, { now: NOW });
    const waiting = plan(offer.jacket, bus(), { now: NOW });
    assert.ok(waiting.beforeTravel.unitProfit > walked.thresholds.unitProfit);
    assert.deepEqual([waiting, walked].sort(rankTrips).map((x) => x.sku), ["bottle", "jacket"]);
  }));

test("Goals baskets include items with a blank fare under the cash limit, figures before the fare, none recommended", () =>
  withApi(async (api) => {
    const profile = bus();
    const r = ok(await api.call("POST", "/api/baskets", { profile }));
    assert.equal(r.constraints.fareMissing, true);
    assert.equal(r.ranking, "before travel");
    assert.equal(r.recommended, null, "never the best fit while the fare is blank");
    assert.deepEqual(r.excluded.map((e) => e.sku).sort(), ["baby", "knit", "pot"]);
    assert.ok(r.excluded.every((e) => e.rejected), "only items failing on what is known are left out");
    assert.equal(r.baskets[0].id, "jacket:3,bottle:1");
    for (const b of r.baskets) {
      assert.equal(b.fareMissing, true);
      assert.equal(b.journey.cost, null, b.id);
      assert.equal(b.economics.costs.travel, null, b.id);
      for (const k of ["contribution", "cashRequired", "hourly", "unsoldLoss", "totalCosts", "journeyPerUnit"])
        assert.equal(b.economics[k], null, `${b.id} ${k}`);
      assert.deepEqual([b.downside.nothingSells, b.downside.halfSells], [null, null]);
      assert.ok(b.beforeTravel.cashRequired <= profile.budget, "under the cash limit before the fare");
      assert.ok(b.beforeTravel.contribution > 0, b.id);
      assert.equal(
        b.beforeTravel.contribution,
        b.items.reduce((n, it) => n + it.beforeTravel.contribution, 0),
        b.id,
      );
      assert.equal(b.reasons.filter((x) => x === FARE_NEEDED).length, 1, "the travel note once per basket");
      assert.equal(b.recommended, false);
      for (const it of b.items) {
        assert.equal(it.travelShare, null, it.sku);
        assert.equal(it.cashRequired, null, it.sku);
        assert.equal(it.unitProfit, null, it.sku);
        assert.ok(it.beforeTravel.unitProfit >= 500, it.sku);
        assert.equal(it.thresholds.fareNeeded, true, it.sku);
        assert.equal(it.opportunity.meetsThresholds, false, "sample data is never an alert");
      }
    }
    // Ranked on contribution before the fare.
    const order = r.baskets.map((b) => b.beforeTravel.contribution);
    assert.deepEqual(order, [...order].sort((x, y) => y - x));
    // The figures before the fare are those of the trip with the journey
    // left out (a free fare's), but never shown as the basket's own.
    const free = ok(await api.call("POST", "/api/baskets", { profile: bus({ fare: 0 }) }));
    assert.equal(free.baskets[0].id, r.baskets[0].id);
    assert.equal(free.baskets[0].economics.contribution, r.baskets[0].beforeTravel.contribution);
    assert.equal(free.baskets[0].economics.cashRequired, r.baskets[0].beforeTravel.cashRequired);
    // An hourly target missed even before the fare says so.
    const slow = ok(await api.call("POST", "/api/baskets", { profile: bus({ target: 10000 }) }));
    assert.ok(slow.baskets.every((b) => b.reasons.includes("Below hourly target, even before your fare")));
  }));

test("Goals baskets with a fare entered work as today: the fare is shared and a basket can be recommended", () =>
  withApi(async (api) => {
    const r = ok(await api.call("POST", "/api/baskets", { profile: bus({ fare: 450 }) }));
    assert.equal(r.ranking, "after travel");
    assert.equal(r.constraints.fareMissing, false);
    assert.equal(r.recommended, "jacket:3");
    for (const b of r.baskets) {
      assert.equal(b.economics.costs.travel, 450, b.id);
      assert.equal(b.beforeTravel, null, b.id);
      assert.equal(b.items.reduce((n, it) => n + it.travelShare, 0), 450, "the one fare is shared across the items");
      assert.ok(!b.reasons.includes(FARE_NEEDED), b.id);
    }
    // The bottle cannot keep £5 a unit with its share of the fare in any basket.
    const bottle = r.excluded.find((e) => e.sku === "bottle");
    assert.equal(bottle.rejected, true);
    assert.match(bottle.reason, /with its share of the journey, in every basket that fits/);
  }));
