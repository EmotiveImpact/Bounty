import { test } from "node:test";
import assert from "node:assert/strict";
import { tripEconomics } from "./trip.mjs";
import { evaluateAlert } from "./alerts.mjs";
import {
  OPPORTUNITY_RULES,
  classifyOpportunity,
  targetPrice,
  unitReturns,
  accessTier,
  hardFilters,
} from "./opportunity.mjs";

const trip = (over = {}) =>
  tripEconomics({
    units: 3,
    unitCost: 1000,
    salePrice: 2600,
    postage: 300,
    packaging: 30,
    feeRate: 0.13,
    feeFixed: 40,
    returnsRate: 0.05,
    journeyCost: 300,
    journeyMinutes: 30,
    handlingMinutes: 8,
    ...over,
  });

const passingAlert = (economics, over = {}) =>
  evaluateAlert({
    evidenceClass: "live",
    match: "exact",
    contribution: economics.contribution,
    hourly: economics.hourly,
    hourlyFloor: 0,
    offerObserved: "2026-10-30",
    now: "2026-10-31T12:00:00Z",
    localStockConfirmed: true,
    availability: "in_stock",
    shippingKnown: true,
    recentIndependentSales: 8,
    daysToSell: 5,
    displayPermitted: true,
    meetsThresholds: true,
    ...over,
  });

const strong = {
  unitPrice: 1000,
  weightKg: 0.4,
  independentSales: 8,
  daysToSell: 5,
  sourcingPressure: 0.2,
  resaleWeeksOfSupply: 1,
};

test("profit per unit carries the unit's share of travel and every variable cost", () => {
  const e = trip();
  const { unitProfit, returnOnCost } = unitReturns(e);
  assert.equal(unitProfit, Math.floor(e.contribution / 3));
  assert.equal(returnOnCost, Math.round((unitProfit / 1000) * 1000) / 1000);
});

test("hard filters reject the price band and weight, and unknown weight", () => {
  assert.equal(hardFilters({ unitPrice: 499, weightKg: 1 }).length, 1);
  assert.equal(hardFilters({ unitPrice: 5001, weightKg: 1 }).length, 1);
  assert.equal(hardFilters({ unitPrice: 1000, weightKg: 2 }).length, 1);
  assert.equal(hardFilters({ unitPrice: 1000 }).length, 1);
  assert.equal(hardFilters({ unitPrice: 1000, weightKg: 1.99 }).length, 0);
});

test("strong, stocked, low-pressure evidence is Priority 1", () => {
  const e = trip();
  const c = classifyOpportunity({ ...strong, economics: e, alert: passingAlert(e) });
  assert.equal(c.tier, "Priority 1", c.reasons.join("; "));
  assert.equal(c.meetsThresholds, true);
});

test("unknown branch stock caps the tier at Priority 2", () => {
  const e = trip();
  const alert = passingAlert(e, { localStockConfirmed: false, availability: "unknown" });
  const c = classifyOpportunity({ ...strong, economics: e, alert });
  assert.equal(c.tier, "Priority 2");
  assert.ok(c.reasons.includes("Branch stock not confirmed"));
});

test("weaker demand or higher pressure is Priority 2", () => {
  const e = trip();
  for (const over of [
    { independentSales: 3 },
    { daysToSell: 30 },
    { resaleWeeksOfSupply: 6 },
    { sourcingPressure: null },
  ]) {
    const c = classifyOpportunity({ ...strong, ...over, economics: e, alert: passingAlert(e) });
    assert.equal(c.tier, "Priority 2", JSON.stringify(over));
  }
});

test("missing or uncertain evidence goes to Review", () => {
  const e = trip();
  for (const over of [
    { match: "research" },
    { recentIndependentSales: 1 },
    { offerObserved: "2026-09-01" },
    { evidenceClass: "sample" },
  ]) {
    const c = classifyOpportunity({ ...strong, economics: e, alert: passingAlert(e, over) });
    assert.equal(c.tier, "Review", JSON.stringify(over));
    assert.equal(c.meetsThresholds, false);
  }
  assert.equal(
    classifyOpportunity({ ...strong, economics: null, alert: passingAlert(e) }).tier,
    "Review",
  );
});

test("short profit or return is Watch with a target price that would qualify", () => {
  const e = trip({ salePrice: 2000 });
  const c = classifyOpportunity({ ...strong, economics: e, alert: passingAlert(e) });
  assert.equal(c.tier, "Watch");
  assert.ok(c.targetPrice < 1000);
  const atTarget = trip({ salePrice: 2000, unitCost: c.targetPrice });
  const { unitProfit, returnOnCost } = unitReturns(atTarget);
  assert.ok(unitProfit >= OPPORTUNITY_RULES.minUnitProfit);
  assert.ok(returnOnCost >= OPPORTUNITY_RULES.minReturn);
  const penny = trip({ salePrice: 2000, unitCost: c.targetPrice + 1 });
  const above = unitReturns(penny);
  assert.ok(
    above.unitProfit < OPPORTUNITY_RULES.minUnitProfit ||
      above.returnOnCost < OPPORTUNITY_RULES.minReturn,
  );
});

test("an item that cannot qualify at any price in the band is rejected", () => {
  const e = trip({ salePrice: 1100 });
  assert.equal(targetPrice(e), null);
  const c = classifyOpportunity({ ...strong, economics: e, alert: passingAlert(e) });
  assert.equal(c.tier, "Reject");
});

test("access tier is the earlier of current paid and earned, shown separately", () => {
  const now = "2026-10-31T12:00:00Z";
  const paid = accessTier({ paidTier: "ruby", paidUntil: "2026-12-01", reputation: 30, now });
  assert.equal(paid.tier.id, "ruby");
  assert.equal(paid.via, "paid");
  assert.equal(paid.earned.id, "amethyst");
  const earned = accessTier({ paidTier: "amethyst", reputation: 130, now });
  assert.equal(earned.tier.id, "sapphire");
  assert.equal(earned.via, "earned");
  const lapsed = accessTier({ paidTier: "diamond", paidUntil: "2026-10-01", reputation: 0, now });
  assert.equal(lapsed.paid, null);
  assert.equal(lapsed.tier.id, "new");
});

test("members can tighten the thresholds but never loosen them", async () => {
  const { effectiveRules } = await import("./opportunity.mjs");
  const tight = effectiveRules({ minUnitProfit: 800, minReturn: 0.5, maxWeightKg: 1, maxUnitPrice: 3000 });
  assert.equal(tight.minUnitProfit, 800);
  assert.equal(tight.minReturn, 0.5);
  assert.equal(tight.maxWeightKg, 1);
  assert.equal(tight.maxUnitPrice, 3000);
  const loose = effectiveRules({ minUnitProfit: 100, minReturn: 0.1, maxWeightKg: 10, maxUnitPrice: 9000, minUnitPrice: 0 });
  assert.equal(loose.minUnitProfit, OPPORTUNITY_RULES.minUnitProfit);
  assert.equal(loose.minReturn, OPPORTUNITY_RULES.minReturn);
  assert.equal(loose.maxWeightKg, OPPORTUNITY_RULES.maxWeightKg);
  assert.equal(loose.maxUnitPrice, OPPORTUNITY_RULES.maxUnitPrice);
  assert.equal(loose.minUnitPrice, OPPORTUNITY_RULES.minUnitPrice);
  assert.equal(effectiveRules({ minReturn: "high" }).minReturn, OPPORTUNITY_RULES.minReturn);
});
