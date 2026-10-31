// Trip economics shared by the planner, research estimates, baskets and
// bounties. Money is integer pence, time is minutes. Every figure here is an
// estimate from the inputs; nothing in this module is realised cash.

// Transport modes. mph is a door-to-door average including waiting.
// perMile is a default running cost in pence per mile; 45p is the HMRC
// approved mileage rate, which covers fuel and wear, so it errs on the side of
// not overstating earnings. Public transport uses the fare the user enters.
export const TRANSPORT = Object.freeze({
  Walk: { mph: 3, perMile: 0 },
  Bicycle: { mph: 9, perMile: 0 },
  "Public transport": { mph: 10, perMile: 0 },
  Car: { mph: 18, perMile: 45 },
  Van: { mph: 16, perMile: 55 },
});
export const MODES = Object.freeze(Object.keys(TRANSPORT));

// Sample selling assumptions. Users should replace them with their own
// marketplace fees; they are deliberately on the cautious side.
export const SAMPLE_ASSUMPTIONS = Object.freeze({
  feeRate: 0.13,
  feeFixed: 40,
  returnsRate: 0.05,
  overheadMinutes: 10,
});

const whole = (v) => Math.round(Number(v) || 0);
const nonNegative = (v) => Math.max(0, whole(v));

// One return journey. miles is one way. fare is a return fare in pence for
// public transport. perMile overrides the mode default. extra covers parking
// or tolls. minutes overrides the speed-based estimate when the user knows it.
export function journey({
  mode = "Walk",
  miles = 0,
  fare = 0,
  perMile,
  extra = 0,
  minutes,
} = {}) {
  const spec = TRANSPORT[mode];
  if (!spec) throw Error("Unknown transport mode " + mode);
  const distance = Math.max(0, Number(miles) || 0) * 2;
  const rate = perMile === undefined || perMile === null ? spec.perMile : perMile;
  const running = Math.round(distance * Math.max(0, Number(rate) || 0));
  const cost =
    running + (mode === "Public transport" ? nonNegative(fare) : 0) + nonNegative(extra);
  const travelMinutes =
    minutes === undefined || minutes === null
      ? Math.ceil((distance / spec.mph) * 60)
      : nonNegative(minutes);
  return { mode, miles: distance, cost, minutes: travelMinutes };
}

// Economics of buying `units` of one item on one journey, assuming every unit
// sells at salePrice unless sellThrough says otherwise.
//
// unitCost     acquisition price per unit
// salePrice    expected realised total per unit including buyer-paid postage
//              (use completed-sale evidence, never asking prices)
// postage      seller's parcel cost per unit sold
// packaging    per unit bought
// feeRate      marketplace fee applied to salePrice
// feeFixed     fixed fee per unit sold
// returnsRate  allowance for returns and refunds, share of salePrice
// journeyCost  cost of the whole journey, shared across units
// journeyMinutes, overheadMinutes (in store), handlingMinutes (per unit:
//              listing, packing and dispatch)
// sellThrough  share of units expected to sell, 0 to 1
export function tripEconomics(input) {
  const units = Math.max(0, Math.floor(Number(input.units) || 0));
  const unitCost = nonNegative(input.unitCost);
  const salePrice = nonNegative(input.salePrice);
  const postage = nonNegative(input.postage);
  const packaging = nonNegative(input.packaging);
  const feeRate = Math.max(0, Number(input.feeRate ?? SAMPLE_ASSUMPTIONS.feeRate));
  const feeFixed = nonNegative(input.feeFixed ?? SAMPLE_ASSUMPTIONS.feeFixed);
  const returnsRate = Math.max(
    0,
    Number(input.returnsRate ?? SAMPLE_ASSUMPTIONS.returnsRate),
  );
  const journeyCost = units ? nonNegative(input.journeyCost) : 0;
  const sellThrough = Math.min(1, Math.max(0, Number(input.sellThrough ?? 1)));
  const sold = Math.floor(units * sellThrough + 1e-9);

  const unitFee = Math.round(salePrice * feeRate) + feeFixed;
  const unitReturns = Math.round(salePrice * returnsRate);
  const costs = {
    stock: units * unitCost,
    packaging: units * packaging,
    postage: sold * postage,
    fees: sold * unitFee,
    returns: sold * unitReturns,
    travel: journeyCost,
  };
  const proceeds = sold * salePrice;
  const totalCosts = Object.values(costs).reduce((a, b) => a + b, 0);
  const contribution = proceeds - totalCosts;
  // Cash leaves the account before the first payout: stock, packaging, the
  // journey and postage for every unit (postage is paid at dispatch, before
  // the marketplace releases funds). Fees are deducted from payouts.
  const cashRequired =
    units * (unitCost + packaging + postage) + journeyCost;
  const activeMinutes = units
    ? nonNegative(input.journeyMinutes) +
      nonNegative(input.overheadMinutes ?? SAMPLE_ASSUMPTIONS.overheadMinutes) +
      units * nonNegative(input.handlingMinutes)
    : 0;
  const hourly = activeMinutes
    ? Math.round((contribution * 60) / activeMinutes)
    : null;
  // Loss if nothing sells: stock, packaging and the journey are spent; no
  // postage or fees are incurred. Returning goods to the retailer may recover
  // some of this, but that is not assumed.
  const unsoldLoss = -(costs.stock + costs.packaging + journeyCost);
  // Lowest realised sale per unit at which the trip breaks even.
  const perUnitFixed = units ? journeyCost / units : 0;
  const breakEvenSale = units
    ? Math.ceil(
        (unitCost + packaging + postage + feeFixed + perUnitFixed) /
          Math.max(1e-9, 1 - feeRate - returnsRate),
      )
    : null;
  return {
    units,
    sold,
    salePrice,
    unitCost,
    proceeds,
    costs,
    totalCosts,
    contribution,
    unitContribution: units ? Math.round(contribution / units) : 0,
    cashRequired,
    journeyPerUnit: units ? Math.round(journeyCost / units) : 0,
    activeMinutes,
    activeHours: Math.round((activeMinutes / 60) * 100) / 100,
    hourly,
    unsoldLoss,
    breakEvenSale,
    allSellAssumed: sellThrough === 1,
  };
}

// Lower median of a list of pence values: with an even count it takes the
// lower middle value so the estimate leans cautious. Null for an empty list.
export function lowerMedian(values) {
  const sorted = values
    .filter((v) => Number.isSafeInteger(v) && v > 0)
    .sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
}
