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
  meetsReturn,
  categoryChecks,
  categoryReturnsRate,
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
    journeyKnown: true,
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
  categoryFailures: [],
};

test("profit per unit carries the unit's share of travel and every variable cost", () => {
  const e = trip();
  const { unitProfit, returnOnCost } = unitReturns(e);
  assert.equal(unitProfit, Math.floor(e.contribution / 3));
  assert.equal(returnOnCost, Math.floor((unitProfit / 1000) * 1000) / 1000);
});

test("a return just under the minimum fails and is never displayed rounded up", () => {
  // 699p on a £20 unit is 34.95%; 350p on £10.01 is 34.965%.
  assert.equal(meetsReturn(699, 2000, 0.35), false);
  assert.equal(meetsReturn(700, 2000, 0.35), true);
  assert.equal(meetsReturn(350, 1001, 0.35), false);
  assert.equal(unitReturns({ units: 1, contribution: 699, unitCost: 2000 }).returnOnCost, 0.349);
  assert.equal(unitReturns({ units: 1, contribution: 700, unitCost: 2000 }).returnOnCost, 0.35);
  const e = trip({ units: 1, unitCost: 2000, journeyCost: 0, salePrice: 4000 });
  const { unitProfit } = unitReturns(e);
  const c = classifyOpportunity({ ...strong, unitPrice: 2000, economics: { ...e, contribution: 699 }, alert: passingAlert(e) });
  assert.ok(unitProfit > 0);
  assert.notEqual(c.tier, "Priority 1");
  assert.notEqual(c.tier, "Priority 2");
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

test("a check that found the shelf empty is Review, never Priority 2", () => {
  const e = trip();
  const alert = passingAlert(e, { localStockConfirmed: false, availability: "out_of_stock" });
  const c = classifyOpportunity({ ...strong, availability: "out_of_stock", economics: e, alert });
  assert.equal(c.tier, "Review");
  assert.ok(c.reasons.includes("Latest check found none on the shelf"));
});

test("an unconfirmed promotion price with no regular price is Review", () => {
  const e = trip();
  const c = classifyOpportunity({ ...strong, promotionUnconfirmed: true, economics: e, alert: passingAlert(e) });
  assert.equal(c.tier, "Review");
  assert.equal(c.meetsThresholds, false);
});

test("category rules fail closed for clothing and food", () => {
  const now = "2026-10-31T12:00:00Z";
  assert.deepEqual(categoryChecks({ category: "general" }), []);
  assert.equal(categoryChecks({ category: "clothing", size: "Age 5 to 6", returnsRate: 0.15 }).length, 0);
  assert.equal(categoryChecks({ category: "clothing", returnsRate: 0.15 }).length, 1);
  assert.equal(categoryChecks({ category: "clothing", size: "M", returnsRate: 0.05 }).length, 1);
  assert.equal(categoryReturnsRate("clothing", 0.05), 0.15);
  assert.equal(categoryReturnsRate("clothing", 0.2), 0.2);
  assert.equal(categoryReturnsRate("general", 0.05), 0.05);
  const food = { category: "food", packagingChecked: true, bestBefore: "2027-03-01", daysToSell: 10, now };
  assert.deepEqual(categoryChecks(food), []);
  assert.equal(categoryChecks({ ...food, packagingChecked: false }).length, 1);
  assert.equal(categoryChecks({ ...food, bestBefore: null }).length, 1);
  assert.equal(categoryChecks({ ...food, bestBefore: "2026-11-30" }).length, 1);
  assert.equal(categoryChecks({ ...food, daysToSell: null }).length, 1);
  const e = trip();
  const failures = categoryChecks({ category: "food", now });
  const c = classifyOpportunity({ ...strong, categoryFailures: failures, economics: e, alert: passingAlert(e) });
  assert.equal(c.tier, "Review");
  const unchecked = classifyOpportunity({ ...strong, categoryFailures: undefined, economics: e, alert: passingAlert(e) });
  assert.equal(unchecked.tier, "Review");
  assert.ok(unchecked.reasons.includes("Category rules were not checked"));
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
    { journeyKnown: false },
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
  assert.ok(meetsReturn(unitProfit, c.targetPrice));
  assert.ok(returnOnCost >= OPPORTUNITY_RULES.minReturn);
  const penny = trip({ salePrice: 2000, unitCost: c.targetPrice + 1 });
  const above = unitReturns(penny);
  assert.ok(
    above.unitProfit < OPPORTUNITY_RULES.minUnitProfit ||
      !meetsReturn(above.unitProfit, c.targetPrice + 1),
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
