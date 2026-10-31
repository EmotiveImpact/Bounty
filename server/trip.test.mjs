import { test } from "node:test";
import assert from "node:assert/strict";
import { journey, tripEconomics, lowerMedian } from "./trip.mjs";
import { evaluateAlert } from "./alerts.mjs";

const base = {
  units: 4,
  unitCost: 600,
  salePrice: 1600,
  postage: 270,
  packaging: 35,
  feeRate: 0.13,
  feeFixed: 40,
  returnsRate: 0.05,
  journeyCost: 400,
  journeyMinutes: 30,
  overheadMinutes: 10,
  handlingMinutes: 9,
};

test("contribution subtracts every cost and the journey is shared once", () => {
  const t = tripEconomics(base);
  assert.equal(t.proceeds, 4 * 1600);
  assert.equal(t.costs.travel, 400);
  assert.equal(t.journeyPerUnit, 100);
  assert.equal(t.contribution, t.proceeds - t.totalCosts);
  assert.equal(
    t.totalCosts,
    4 * 600 + 4 * 35 + 4 * 270 + 4 * (208 + 40) + 4 * 80 + 400,
  );
  assert.equal(t.activeMinutes, 30 + 10 + 36);
  assert.equal(t.hourly, Math.round((t.contribution * 60) / 76));
});

test("cash before payout covers stock, packaging, postage and the journey", () => {
  const t = tripEconomics(base);
  assert.equal(t.cashRequired, 4 * (600 + 35 + 270) + 400);
});

test("unsold downside and partial sell-through never add proceeds", () => {
  const none = tripEconomics({ ...base, sellThrough: 0 });
  assert.equal(none.proceeds, 0);
  assert.equal(none.contribution, none.unsoldLoss);
  assert.ok(none.contribution < 0);
  const half = tripEconomics({ ...base, sellThrough: 0.5 });
  assert.equal(half.sold, 2);
  assert.ok(half.contribution < tripEconomics(base).contribution);
});

test("break-even sale price yields a non-negative contribution", () => {
  const t = tripEconomics(base);
  const even = tripEconomics({ ...base, salePrice: t.breakEvenSale });
  assert.ok(even.contribution >= 0);
  const below = tripEconomics({ ...base, salePrice: t.breakEvenSale - 5 });
  assert.ok(below.contribution < 0);
});

test("journey costs vary by mode and public transport uses the fare", () => {
  assert.equal(journey({ mode: "Walk", miles: 1.5 }).cost, 0);
  assert.equal(journey({ mode: "Walk", miles: 1.5 }).minutes, 60);
  assert.equal(journey({ mode: "Car", miles: 5 }).cost, 450);
  assert.equal(
    journey({ mode: "Public transport", miles: 3, fare: 480 }).cost,
    480,
  );
  assert.equal(journey({ mode: "Car", miles: 5, extra: 150 }).cost, 600);
  assert.throws(() => journey({ mode: "Hovercraft" }));
});

test("no units means no journey, no time and no hourly rate", () => {
  const t = tripEconomics({ ...base, units: 0 });
  assert.equal(t.cashRequired, 0);
  assert.equal(t.contribution, 0);
  assert.equal(t.hourly, null);
});

test("lower median leans cautious and ignores invalid values", () => {
  assert.equal(lowerMedian([1700, 1500, 1600, 1650]), 1600);
  assert.equal(lowerMedian([]), null);
  assert.equal(lowerMedian([0, -5, 1200]), 1200);
});

const passing = {
  evidenceClass: "live",
  match: "exact",
  contribution: 900,
  hourly: 1500,
  hourlyFloor: 1200,
  offerObserved: "2026-10-30",
  now: "2026-10-31T12:00:00Z",
  localStockConfirmed: true,
  availability: "in_stock",
  promotion: null,
  shippingKnown: true,
  recentIndependentSales: 3,
  daysToSell: 6,
  cashNeededDays: 14,
  displayPermitted: true,
};

test("alerts require every check and explain each failure", () => {
  assert.equal(evaluateAlert(passing).eligible, true);
  for (const [field, value] of [
    ["evidenceClass", "sample"],
    ["match", "research"],
    ["contribution", 0],
    ["contribution", -50],
    ["offerObserved", "2026-10-01"],
    ["offerObserved", null],
    ["localStockConfirmed", false],
    ["availability", "unknown"],
    ["shippingKnown", false],
    ["recentIndependentSales", 2],
    ["daysToSell", null],
    ["daysToSell", 20],
    ["displayPermitted", false],
    ["hourly", 1000],
  ]) {
    const result = evaluateAlert({ ...passing, [field]: value });
    assert.equal(result.eligible, false, field + "=" + value);
    assert.ok(result.reasons.length >= 1);
  }
});

test("a loyalty price needs confirmed eligibility; empty input fails closed", () => {
  assert.equal(
    evaluateAlert({ ...passing, promotion: "LOYALTY_PROGRAM" }).eligible,
    false,
  );
  assert.equal(
    evaluateAlert({
      ...passing,
      promotion: "LOYALTY_PROGRAM",
      promotionEligible: true,
    }).eligible,
    true,
  );
  const empty = evaluateAlert({});
  assert.equal(empty.eligible, false);
  assert.ok(empty.checks.every((c) => !c.ok || c.id === "promotion"));
});
