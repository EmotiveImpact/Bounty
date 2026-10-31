// Buy-alert gate. An alert tells someone to make a trip, so every check must
// pass on positive evidence; anything missing or uncertain fails closed.
// Planner fixtures, negative or zero contribution, expired observations,
// uncertain matches and absent sold evidence can never produce an alert.

export const ALERT_RULES = Object.freeze({
  maxOfferAgeDays: 7, // a shelf price older than this has expired
  maxSaleAgeDays: 90, // completed sales older than this do not count
  minIndependentSales: 3, // distinct sellers or listings with recent sales
});

const DAY = 86400000;
export function ageDays(date, now) {
  const then = Date.parse(date);
  const at = Date.parse(now);
  if (!Number.isFinite(then) || !Number.isFinite(at)) return null;
  return Math.floor((at - then) / DAY);
}

// input:
//  evidenceClass       "live" for imported evidence; anything else is sample
//  match               "exact" | "research" | "none"
//  contribution        trip contribution in pence (all units)
//  hourly, hourlyFloor pence per active hour
//  offerObserved       source date of the acquisition price
//  now                 ISO timestamp the decision is made at
//  localStockConfirmed true only after an in-store or retailer branch check;
//                      affiliate feeds and online catalogues never set it
//  availability        source availability; must be "in_stock"
//  promotion           promotion or loyalty condition on the price, or null
//  promotionEligible   true when the user confirmed they qualify
//  shippingKnown       true when parcel cost for the item is known
//  recentIndependentSales  count of independent completed sales within
//                      maxSaleAgeDays of exact matches
//  daysToSell          median days from listing to sale, or null if unknown
//  cashNeededDays      days until the user needs the cash back, or null
//  displayPermitted    licence or programme permits showing this offer
//  meetsThresholds     classifyOpportunity(...).meetsThresholds
//  units, trialUnits   units planned and the trial batch size (default 3)
//  provenItem          true when a verified trade exists for the item
export function evaluateAlert(input = {}, rules = ALERT_RULES) {
  const checks = [];
  const add = (id, ok, pass, failure) =>
    checks.push({ id, ok: ok === true, detail: ok === true ? pass : failure });

  add(
    "live-evidence",
    input.evidenceClass === "live",
    "Imported evidence",
    "Sample or illustrative figures never trigger a buy alert",
  );
  add(
    "exact-match",
    input.match === "exact",
    "Barcode, size, pack, model and condition match",
    input.match === "research"
      ? "Similar product only: needs research before an alert"
      : "No matching sold evidence",
  );
  const contribution = input.contribution;
  add(
    "positive-contribution",
    Number.isFinite(contribution) && contribution > 0,
    "Positive contribution after costs",
    Number.isFinite(contribution)
      ? "Contribution is not positive after costs"
      : "Contribution cannot be calculated",
  );
  add(
    "hourly-floor",
    Number.isFinite(input.hourly) &&
      Number.isFinite(input.hourlyFloor) &&
      input.hourly >= input.hourlyFloor,
    "Meets the hourly floor",
    "Below the hourly floor or working time unknown",
  );
  const offerAge = input.offerObserved
    ? ageDays(input.offerObserved, input.now)
    : null;
  add(
    "offer-fresh",
    offerAge !== null && offerAge >= 0 && offerAge <= rules.maxOfferAgeDays,
    "Offer price observed within " + rules.maxOfferAgeDays + " days",
    offerAge === null
      ? "Offer date unknown"
      : "Offer observation has expired (" + offerAge + " days old)",
  );
  add(
    "local-stock",
    input.localStockConfirmed === true,
    "Branch stock confirmed",
    "Branch stock not confirmed; feeds and online catalogues do not establish local stock",
  );
  add(
    "availability",
    input.availability === "in_stock",
    "Reported in stock",
    "Availability not reported as in stock",
  );
  add(
    "promotion",
    !input.promotion || input.promotionEligible === true,
    input.promotion ? "Promotion eligibility confirmed" : "No promotion condition",
    "Promotion or loyalty price: eligibility not confirmed",
  );
  add(
    "shipping",
    input.shippingKnown === true,
    "Parcel cost known",
    "Parcel cost unknown",
  );
  add(
    "independent-sales",
    Number.isInteger(input.recentIndependentSales) &&
      input.recentIndependentSales >= rules.minIndependentSales,
    input.recentIndependentSales + " independent sales in " + rules.maxSaleAgeDays + " days",
    "Fewer than " +
      rules.minIndependentSales +
      " independent completed sales in the last " +
      rules.maxSaleAgeDays +
      " days",
  );
  add(
    "days-to-sell",
    Number.isFinite(input.daysToSell) &&
      input.daysToSell >= 0 &&
      (input.cashNeededDays === null ||
        input.cashNeededDays === undefined ||
        input.daysToSell <= input.cashNeededDays),
    "Expected to sell before the cash is needed",
    Number.isFinite(input.daysToSell)
      ? "Expected to sell after the date the cash is needed"
      : "Days to sell unknown",
  );
  add(
    "display-permitted",
    input.displayPermitted === true,
    "Source permits display",
    "No recorded permission to display this source",
  );
  // Buying thresholds and tiers come from classifyOpportunity in
  // opportunity.mjs; only Priority 1 and Priority 2 set meetsThresholds.
  add(
    "buying-thresholds",
    input.meetsThresholds === true,
    "Meets the buying thresholds (Priority 1 or 2)",
    "Not a Priority 1 or 2 opportunity under the buying thresholds",
  );
  // A first purchase of an item is a small trial batch until a verified
  // trade (receipt and payout) proves it.
  const trialUnits = Number.isInteger(input.trialUnits) ? input.trialUnits : 3;
  add(
    "trial-batch",
    Number.isInteger(input.units) &&
      input.units >= 1 &&
      (input.units <= trialUnits || input.provenItem === true),
    "Within the trial batch size",
    "More than a trial batch of " + trialUnits + " units for an unproven item",
  );
  return {
    eligible: checks.every((c) => c.ok),
    reasons: checks.filter((c) => !c.ok).map((c) => c.detail),
    checks,
  };
}
