// Buy-alert gate. An alert tells someone to make a trip, so every check must
// pass on positive evidence; anything missing or uncertain fails closed.
// Planner fixtures, negative or zero contribution, expired observations,
// uncertain matches and absent sold evidence can never produce an alert.

export const ALERT_RULES = Object.freeze({
  maxOfferAgeDays: 7, // a shelf price older than this has expired
  maxSaleAgeDays: 90, // completed sales older than this do not count
  minIndependentSales: 3, // distinct named sellers with recent sales; a listing id is not a seller
});

import { londonDate } from "./http.mjs";

// The checks suitability.mjs gives for the person making a trip, and what
// each says when it was not given (it then fails).
const SUITABILITY_CHECK_IDS = Object.freeze(["one-unit-load", "total-load", "cash-available", "storage-space"]);
const SUITABILITY_UNCHECKED = Object.freeze({
  "one-unit-load": "One unit was not checked against your load limit",
  "total-load": "The load for every unit planned was not checked against your load limit",
  "cash-available": "The cash the trip needs was not checked against the cash you can spend",
  "storage-space": "The units were not checked against your storage at home",
});

const DAY = 86400000;
const CALENDAR = /^\d{4}-\d{2}-\d{2}$/;
export function ageDays(date, now) {
  const then = Date.parse(date);
  const at = Date.parse(now);
  if (!Number.isFinite(then) || !Number.isFinite(at)) return null;
  // A calendar date (an offer seen on 24 July, a sale on 3 May) is a UK date,
  // so its age is counted in UK days: just after midnight in summer time it
  // is already a day older than the UTC clock says.
  if (typeof date === "string" && CALENDAR.test(date))
    return Math.round((Date.parse(londonDate(new Date(at)) + "T00:00:00Z") - then) / DAY);
  return Math.floor((at - then) / DAY);
}

// input:
//  evidenceClass       "live" for imported evidence; anything else is sample
//  match               "exact" | "research" | "none"
//  contribution        trip contribution in pence (all units)
//  hourly, hourlyFloor pence per active hour
//  missingInputs       names of required inputs left blank (for example
//                      "packaging", "handling time"); must be an empty
//                      array. A blank cost or time is never zero
//  journeyKnown        true when the return journey cost and time were
//                      entered (0 counts only when entered, for example
//                      walking); a blank journey is never free and instant
//  offerObserved       source date of the acquisition price
//  now                 ISO timestamp the decision is made at
//  localStockConfirmed true only after an in-store or retailer branch check;
//                      affiliate feeds and online catalogues never set it
//  availability        availability from the latest branch check (in-store,
//                      phone or retailer branch page); must be "in_stock".
//                      A feed's own in-stock flag never sets it
//  priceAtBranch       true only when the acquisition price is shown to apply
//                      at the branch the stock check covers: that check (or
//                      an earlier one at the same branch) recorded the shelf
//                      price, or the offer is from that same identified shop
//                      (estimate.mjs priceAtBranch). A price seen at another
//                      shop, or online, never sets it
//  priceAtBranchBasis  "check" | "same-shop" when it is set
//  priceAtBranchReason why it is not, in words naming where the price was
//                      seen and where stock was checked
//  promotion           promotion or loyalty condition on the price, or null
//  promotionEligible   true when the user confirmed they qualify
//  costedAtRegularPrice true when the stock is costed at the known regular
//                      price because eligibility is not confirmed, so the
//                      trip does not depend on the promotion
//  shippingKnown       true when parcel cost for the item is known
//  recentIndependentSales  count of independent completed sales within
//                      maxSaleAgeDays of exact matches
//  daysToSell          median days from listing to sale, or null if unknown
//  cashNeededDays      days until the user needs the cash back, or null
//  payoutDays          days from the decision until the payout is expected
//                      (trip, listing, sale, dispatch, delivery and payout
//                      delay, as goals.payoutDate works it out); required
//                      when cashNeededDays is set
//  displayPermitted    licence or programme permits showing this offer
//  meetsThresholds     classifyOpportunity(...).meetsThresholds
//  units, trialUnits   units planned and the trial batch size (default 3)
//  shelfUnits          units likely left on the shelf from the newest branch
//                      check that counted them (less units bought through
//                      bounties since), or null when the shelf was not counted
//  demandUnits         units the evidence supports selling within the sell
//                      window (opportunity.demandUnits); null when unknown
//  sellWindowWeeks     the window demandUnits was worked out for
//  provenItem          true when a verified trade exists for the item
//  suitability         whether the trip fits the person making it (round 5):
//                      the checks from suitability.mjs suitability() for
//                      their transport, carry limit, cash and storage
//                      (one-unit-load, total-load, cash-available,
//                      storage-space), each kept as a gate check; a check
//                      that is missing fails. "per-member" for a bounty,
//                      whose figures are shared with many members: each
//                      member's own profile decides at the alert and the
//                      claim (bounties.mjs). Missing on live evidence fails
//                      closed; sample figures (the Planner, which caps its
//                      units by the same limits) carry no such check
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
  add(
    "inputs-entered",
    Array.isArray(input.missingInputs) && input.missingInputs.length === 0,
    "Every cost and time entered",
    Array.isArray(input.missingInputs)
      ? "Not entered: " + input.missingInputs.join(", ") + ". A blank is never counted as zero"
      : "Required costs and times were not checked",
  );
  add(
    "journey",
    input.journeyKnown === true,
    "Return journey cost and time entered",
    "Journey cost or time not entered, so travel is left out of profit and earnings per hour",
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
    "Latest branch check found stock",
    input.availability === "out_of_stock"
      ? "Latest branch check found none on the shelf"
      : "No branch check has found stock",
  );
  // The price must apply where the stock is: a price seen at a shop in one
  // town, or online, says nothing about the shelf the trip goes to. Without
  // a stated reason it still fails closed.
  add(
    "price-at-branch",
    input.priceAtBranch === true,
    input.priceAtBranchBasis === "same-shop"
      ? "Price seen at the same shop the branch check covers"
      : "Shelf price recorded on the branch check",
    typeof input.priceAtBranchReason === "string" && input.priceAtBranchReason.trim()
      ? input.priceAtBranchReason.trim()
      : "The price is not shown to apply at the branch checked: record the shelf price on a branch check there",
  );
  // A branch check that counted the shelf caps the units a trip can buy.
  // Planning more than are likely left (the count less units already bought
  // through bounties) would send someone for stock that is not there, so it
  // fails. An uncounted shelf leaves this to the availability check.
  const shelfCounted = Number.isSafeInteger(input.shelfUnits) && input.shelfUnits >= 0;
  add(
    "shelf-units",
    !shelfCounted || (Number.isInteger(input.units) && input.units <= input.shelfUnits),
    shelfCounted
      ? "About " + input.shelfUnits + " left on the shelf, enough for the units planned"
      : "Shelf not counted",
    Number.isInteger(input.units)
      ? "Only about " + input.shelfUnits + " likely left on the shelf, fewer than the " + input.units + " planned"
      : "Units planned not known, so they cannot be checked against the " + input.shelfUnits + " left on the shelf",
  );
  add(
    "promotion",
    !input.promotion || input.promotionEligible === true || input.costedAtRegularPrice === true,
    !input.promotion
      ? "No promotion condition"
      : input.promotionEligible === true
        ? "Promotion eligibility confirmed"
        : "Costed at the regular price, so the trip does not depend on the promotion",
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
  // The cash date is met only by money received: the payout, not the sale.
  const cashDate = Number.isFinite(input.cashNeededDays);
  const sellKnown = Number.isFinite(input.daysToSell) && input.daysToSell >= 0;
  const payoutKnown = Number.isFinite(input.payoutDays) && input.payoutDays >= 0;
  add(
    "days-to-sell",
    sellKnown && (!cashDate || (payoutKnown && input.payoutDays <= input.cashNeededDays)),
    cashDate
      ? "Expected to be paid out within " + input.cashNeededDays + " days, before the cash is needed"
      : "Time to sell known",
    !sellKnown
      ? "Days to sell unknown"
      : !payoutKnown
        ? "Payout date unknown, so the cash date cannot be checked"
        : "Expected payout in " + input.payoutDays + " days, after the date the cash is needed",
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
  // Alerts are rationed by demand: a trip may not buy more units than the
  // evidence supports selling within the sell window.
  const weeks = Number.isFinite(input.sellWindowWeeks) ? input.sellWindowWeeks : 2;
  const demandKnown = Number.isInteger(input.demandUnits) && input.demandUnits >= 0;
  add(
    "demand",
    demandKnown && Number.isInteger(input.units) && input.units <= input.demandUnits,
    "Sales rate supports these units within " + weeks + " weeks",
    !demandKnown
      ? "Sales rate or competing listings unknown, so demand for these units is not shown"
      : "Sales support about " + input.demandUnits + " unit" + (input.demandUnits === 1 ? "" : "s") +
          " within " + weeks + " weeks after competing listings, fewer than the " + input.units + " planned",
  );
  // The trip must fit the person making it: one unit and every unit within
  // their load limit, the cash before payout within what they can spend,
  // and the units within their storage. Unknown fails (suitability.mjs).
  if (Array.isArray(input.suitability)) {
    for (const id of SUITABILITY_CHECK_IDS) {
      const c = input.suitability.find((x) => x && x.id === id);
      const detail = typeof c?.detail === "string" && c.detail.trim() ? c.detail.trim() : SUITABILITY_UNCHECKED[id];
      add(id, c?.ok === true, detail, detail);
    }
  } else if (input.suitability === "per-member")
    add(
      "member-fit",
      true,
      "Checked for each member: their own transport, carrying limit, cash and storage decide when they are alerted and when they claim",
      null,
    );
  else if (input.evidenceClass === "live")
    add(
      "member-fit",
      false,
      null,
      "Not checked against the transport, carrying limit, cash and storage of the person making the trip",
    );
  return {
    eligible: checks.every((c) => c.ok),
    reasons: checks.filter((c) => !c.ok).map((c) => c.detail),
    checks,
  };
}
