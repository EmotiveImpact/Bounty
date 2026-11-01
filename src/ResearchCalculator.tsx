import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  barcodeText,
  dateTime,
  hours,
  loadMemberRules,
  loadProfile,
  money,
  percent,
  saveMemberRules,
  toPence,
  type MemberRules,
  type RuleKey,
} from "./api";
import "./Research.css";

// Shapes returned by the research routes (server/routes-research.mjs).
// Money is integer pence; dates are ISO strings.
export type EvidenceRow = {
  provider: string;
  source_id: string;
  kind: string;
  title: string;
  barcode: string | null;
  variant: string | null;
  size: string | null;
  pack: string | null;
  model: string | null;
  condition: string | null;
  price: number;
  shipping: number | null;
  observed: string | null;
  listed: string | null;
  retailer: string | null;
  location: string | null;
  availability: string | null;
  promotion: string | null;
  seller: string | null;
  url: string | null;
  licence: string | null;
  imported: string | null;
};
type CategoryId = "general" | "clothing" | "food";
type AttrKey = "size" | "pack" | "model" | "condition";
const ATTR_KEYS: AttrKey[] = ["size", "pack", "model", "condition"];
// The model value that says the operator checked and the item has no model
// number (NO_MODEL in server/matching.mjs). It matches only sales that state
// no model either.
const NO_MODEL = "none";
type AttrSource = "source" | "operator" | "assumed" | null;
export type Offer = {
  provider: string;
  sourceId: string;
  kind: string;
  title: string;
  barcode: string | null;
  gtin: string;
  variant: string | null;
  size: string | null;
  pack: string | null;
  model: string | null;
  condition: string | null;
  price: number;
  regularPrice: number | null;
  observed: string | null;
  imported: string | null;
  retailer: string | null;
  location: string | null;
  availability: string | null;
  promotion: string | null;
  url: string | null;
  licence: string | null;
  ageDays: number | null;
  freshness: "fresh" | "expired" | "unknown" | "future";
  expired: boolean;
  source: string;
  stockNote: string;
  branchStockEstablished: boolean;
  sample: boolean;
  // hint: set when the size gives a quantity but nothing else says food.
  suggestedCategory?: { id: CategoryId; basis: string; hint?: string };
  // Set when a newer Open Prices price at the same shop replaced the
  // observation you chose (server/estimate.mjs currentOffer).
  chosenOffer?: { sourceId: string; price: number; observed: string | null };
  // Present once operator-confirmed attributes were applied by the server.
  attributeSource?: Record<AttrKey, AttrSource>;
  operatorConfirmed?: AttrKey[];
};
type AttributeResult = {
  applied: Partial<Record<AttrKey, string>>;
  ignored: { key: AttrKey; value: string; stored: string; reason: string }[];
};
type Status = "exact" | "research" | "none";
type Candidate = {
  row: EvidenceRow;
  status: Status;
  reasons: string[];
  sample: boolean;
  confirmable?: boolean;
  blocker?: string | null;
};
// activeListings counts listings seen recently; null when the newest one on
// record is too old, so competition is not known. competingListings is the
// count the demand check uses: also null when no listings are recorded and
// no asking-price lookup is on record (nobody may have looked).
type Competition = {
  activeListings: number | null;
  sellers: number | null;
  lowestAsking: number | null;
  lowestAskingIncludesShipping: boolean | null;
  competingListings?: number | null;
  lookup?: { provider: string; fetched: string } | null;
  checkedAt?: string | null;
  olderListings?: number;
  note?: string | null;
};
type Candidates = {
  offer: Offer;
  sales: Candidate[];
  listings: Candidate[];
  other: Candidate[];
  competition: Competition;
  offerAttributes?: AttributeResult;
};
type Economics = {
  units: number;
  sold: number;
  salePrice: number;
  unitCost: number;
  proceeds: number;
  costs: {
    stock: number;
    packaging: number;
    postage: number;
    fees: number;
    returns: number;
    travel: number;
  };
  totalCosts: number;
  contribution: number;
  unitContribution: number;
  cashRequired: number;
  journeyPerUnit: number;
  activeMinutes: number;
  activeHours: number;
  hourly: number | null;
  unsoldLoss: number;
  breakEvenSale: number | null;
  allSellAssumed: boolean;
};
type AlertCheck = { id: string; ok: boolean; detail: string };
// Buying thresholds (server/opportunity.mjs OPPORTUNITY_RULES). Money in
// pence; minReturn is a share of the purchase price.
export type Rules = {
  minUnitPrice: number;
  maxUnitPrice: number;
  maxWeightKg: number;
  minUnitProfit: number;
  minReturn: number;
  trialUnits: number;
  strongIndependentSales: number;
  maxDaysToSellPriority1: number;
  maxResaleWeeksOfSupplyPriority1: number;
  maxSourcingPressurePriority1: number;
};
type AlertRules = { maxOfferAgeDays: number; maxSaleAgeDays: number; minIndependentSales: number };
type CategoryRule = {
  id: CategoryId;
  name: string;
  minReturnsRate?: number;
  needsSize?: boolean;
  needsPackaging?: boolean;
  minShelfLifeDays?: number;
};
type Agreed = {
  rules: Rules;
  alertRules: AlertRules;
  categories?: Record<CategoryId, CategoryRule>;
};
type Tier = "Priority 1" | "Priority 2" | "Watch" | "Review" | "Reject";
type Opportunity = {
  tier: Tier;
  reasons: string[];
  unitProfit: number | null;
  returnOnCost: number | null;
  targetPrice: number | null;
  meetsThresholds: boolean;
  trialUnits: number;
  unitPrice: number;
  weightKg: number | null;
  salesPerWeek: number | null;
  resaleWeeksOfSupply: number | null;
  sourcingPressure: number | null;
  provenItem: boolean;
};
type Thresholds = {
  rules: Rules;
  defaults: Rules;
  tightened: RuleKey[];
  ignored: RuleKey[];
};
export type StockCheck = {
  id: number;
  barcode: string;
  retailer: string;
  locality: string;
  checked_at: string;
  method: string;
  in_stock: number;
  units_seen: number | null;
  note: string | null;
};
type PricePoint = {
  evidenceClass: string;
  provider: string;
  sourceId: string;
  price: number;
  observed: string | null;
  retailer: string | null;
  promotion: string | null;
  chosen: boolean;
};
type PriceRange = {
  count: number;
  lowest: number | null;
  highest: number | null;
  oldest: string | null;
  newest: string | null;
};
type Prices = {
  claimed: {
    evidenceClass: string;
    // previous: the retailer's was price; rrp: the recommended retail price;
    // regular: the price without the discount recorded by the source.
    kind?: "previous" | "rrp" | "regular";
    price: number;
    observed: string | null;
    basis: string;
  } | null;
  observed: PriceRange & {
    evidenceClass: string;
    points: PricePoint[];
    amazon: PriceRange & { evidenceClass: string; note: string; points: PricePoint[] };
  };
  sold: PriceRange & {
    evidenceClass: string;
    lowerMedian: number | null;
    exactNotInSample: number;
    note: string;
  };
};
type Payout = {
  start: string;
  sold: string | null;
  dispatch: string | null;
  delivered: string | null;
  date: string | null;
  note: string;
  days: number | null;
  goals: {
    daysToSell: number | null;
    // Days until the last unit is expected to sell, at the sales rate.
    daysToSellAll?: number | null;
    salesPerWeek?: number | null;
    dispatchDays: number[];
    deliveryDays: number;
    payoutDelayDays: number;
    saved: boolean;
  };
  cashNeededBy: string | null;
  cashNeededDays: number | null;
  timing: { status: "on time" | "late" | "unknown"; daysLate: number | null; note: string };
  // Added in round two: the payout of several units follows the sales rate.
  units?: number;
  unitPayouts?: (string | null)[];
  cashDate?: string | null;
  unitsByCashDate?: number | null;
};
type Demand = {
  units: number | null;
  salesPerWeek: number | null;
  competingListings: number | null;
  sellWindowWeeks: number;
  note: string;
};
type AccessNeed = { id: string; label: string; detail: string };
// Units on the shelf now: the newer of the branch check and a member's stock
// report, less units members bought through bounties since that count.
type Shelf = {
  units: number | null;
  seen: number | null;
  source: "stock check" | "stock report" | null;
  at: string | null;
  boughtSince: number;
  report: { at: string; unitsSeen: number; verified: string | null } | null;
  note: string | null;
};
type PricePick = { sourceId: string; price: number; observed: string | null };
type Estimate = {
  offer: Offer;
  sample: {
    used: EvidenceRow[];
    excluded: { row: EvidenceRow; reason: string }[];
    count: number;
    independent: number;
    // Used sales with no seller name: never counted as independent.
    withoutSeller?: number;
    lowerMedian: number | null;
    newest: string | null;
    oldest: string | null;
    daysToSell: number | null;
  };
  competition: Competition;
  match: Status;
  economics: Economics | null;
  opportunity: Opportunity;
  thresholds: Thresholds;
  alert: { eligible: boolean; reasons: string[]; checks: AlertCheck[] };
  stock: {
    check: StockCheck | null;
    confirmed: boolean;
    availability: string;
    reason?: string | null;
    // The shelf as the bounty card counts it (server/estimate.mjs branchShelf).
    shelf?: Shelf;
  };
  permission: { permitted: boolean; basis: string };
  unitCost: number;
  cashNeededDays: number | null;
  // Added in later rounds; optional so an older server still renders.
  sampleData?: boolean;
  payout?: Payout;
  prices?: Prices;
  // chosen is the category you picked (null: the suggestion), applied the
  // one whose rules are used, warning set when a looser choice drops rules.
  category?: {
    id: CategoryId;
    name: string;
    chosen: CategoryId | null;
    suggested: CategoryId;
    applied: CategoryId;
    reason: string | null;
    warning: string | null;
    dropped: string[];
    suggestion: { id: CategoryId; basis: string };
    rule: CategoryRule;
    returnsRate: number;
    returnsRaised: boolean;
    failures: string[];
  };
  journey?: { known: boolean; missing: string[]; costKnown: boolean; minutesKnown: boolean };
  missingInputs?: string[];
  demand?: Demand;
  access?: { needs: AccessNeed[]; carryKg: number; carrySource: "request" | "default" };
  checked?: { price: string | null; stock: string | null; locality: string | null };
  mainUncertainty?: string;
  offerAttributes?: AttributeResult;
  // A newer Open Prices price at the same shop that the figures use.
  shopPrice?: { chosen: PricePick; used: PricePick; change: "rose" | "fell" | "same" } | null;
  inputs?: { defaulted: string[]; costs: Record<string, number> };
  assumptions: string[];
  warnings: string[];
};
type EstimateRequest = {
  offer: { provider: string; sourceId: string };
  sales: { provider: string; sourceId: string }[];
  units: number;
  costs: Record<string, number>;
  weightKg?: number;
  rules?: MemberRules;
  hourlyFloor?: number;
  promotionEligible: boolean;
  cashNeededBy?: string;
  locality?: string;
  category?: CategoryId;
  categoryReason?: string;
  carryKg?: number;
  packagingChecked?: boolean;
  bestBefore?: string;
  offerAttributes?: Partial<Record<AttrKey, string>>;
};
// Prefill for the validation audit form (see Audit.tsx).
export type AuditDraft = {
  locality: string;
  barcode: string;
  title: string;
  retailer: string;
  offerProvider: string;
  offerSourceId: string;
  availabilityCheckId: number | null;
  promotion: string | null;
  promotionEligible: boolean | null;
  shipping: number | null;
  daysToSell: number | null;
  independentSales: number | null;
  displayPermitted: boolean | null;
  matchDecision: Status | null;
  // Handed over so the audit rebuilds the estimate the operator saw (see
  // AuditHandover in Audit.tsx). estimateInputs is the estimate request
  // without the fields the audit sets from the item itself.
  sales?: { provider: string; sourceId: string }[];
  weightKg?: number | null;
  estimateInputs?: Record<string, unknown> | null;
};

// Money and dates for display. Unknown values say so in words.
export const cash = (pence: number | null | undefined) =>
  pence === null || pence === undefined || !Number.isFinite(pence)
    ? "not known"
    : money(pence);
// The same rule as server/estimate.mjs isSampleRecord: sample, fixture or
// demo in the provider, licence or source id, or a made-up "Example ..."
// retailer from the repository's own sample feeds.
export const isSampleRow = (row: {
  provider?: string | null;
  licence?: string | null;
  source_id?: string | null;
  retailer?: string | null;
}) =>
  /\b(sample|fixture|demo)\b/i.test(row.provider || "") ||
  /\b(sample|fixture|demo)\b/i.test(row.licence || "") ||
  /^(sample|fixture|demo)\b/i.test(row.source_id || "") ||
  /^\s*example\b/i.test(row.retailer || "");
// sources marks attributes the operator confirmed after looking at the item
// (the source left them blank) and a retail offer's assumed condition.
export const attributesText = (
  row: {
    size: string | null;
    pack: string | number | null;
    model: string | null;
    condition: string | null;
  },
  sources?: Partial<Record<AttrKey, AttrSource>>,
) =>
  ATTR_KEYS.map((k) => {
    const v = row[k];
    if (v === null || v === undefined || v === "")
      return k + (sources?.[k] === "assumed" ? " new (assumed for a retailer)" : " not stated");
    const shown = k === "model" && v === NO_MODEL ? "no model number" : k + " " + v;
    return shown + (sources?.[k] === "operator" ? " (you confirmed)" : "");
  }).join(" · ");

const key = (provider: string, sourceId: string) => provider + "|" + sourceId;
const STATUS_LABEL: Record<Status, string> = {
  exact: "Exact",
  research: "Research",
  none: "No match",
};
// For listings the match only says whether the competitor sells the same
// variant; a listing is competition whatever its status.
const LISTING_LABEL: Record<Status, string> = {
  exact: "Same variant",
  research: "Variant not confirmed",
  none: "Different item",
};
const STATUS_CLASS: Record<Status, string> = {
  exact: "ok",
  research: "sample",
  none: "warn",
};

// "today", "1 day ago", "3 days ago": never "0 d ago".
const daysAgo = (n: number) => (n === 0 ? "today" : n === 1 ? "1 day ago" : n + " days ago");
function freshnessBadge(offer: Offer) {
  const age = offer.ageDays;
  if (offer.freshness === "fresh")
    return <span className="badge ok">Observed {age === null ? "recently" : daysAgo(age)}</span>;
  if (offer.freshness === "expired")
    return (
      <span className="badge warn">
        Expired{age === null ? "" : ": " + age + (age === 1 ? " day" : " days") + " old"}
      </span>
    );
  if (offer.freshness === "future")
    return <span className="badge warn">Dated in the future</span>;
  return <span className="badge warn">Date unknown</span>;
}

// Form values are kept as text so an empty field means "not entered" and is
// left out of the request, never sent as zero by accident.
type Inputs = {
  units: string;
  weightKg: string;
  postage: string;
  packaging: string;
  feeRate: string;
  feeFixed: string;
  returnsRate: string;
  journeyCost: string;
  journeyMinutes: string;
  overheadMinutes: string;
  handlingMinutes: string;
  hourlyFloor: string;
  cashNeededBy: string;
  promotionEligible: boolean;
  locality: string;
  // "" means the category the offer suggests.
  category: "" | CategoryId;
  // Why a looser category than the suggested one is right.
  categoryReason: string;
  packagingChecked: boolean;
  bestBefore: string;
};
function initialInputs(): Inputs {
  const p = loadProfile();
  // A first purchase is a trial batch, so start small whatever the profile
  // says, and no larger than the member's own stricter trial batch.
  const trial = loadMemberRules().trialUnits;
  const cap = Number.isInteger(trial) && (trial as number) >= 1 ? Math.min(3, trial as number) : 3;
  return {
    units: String(Math.min(cap, Math.max(1, Math.round(p.quantity) || 1))),
    weightKg: "",
    postage: "",
    packaging: "",
    feeRate: String(Math.round(p.feeRate * 1000) / 10),
    feeFixed: (p.feeFixed / 100).toFixed(2),
    returnsRate: String(Math.round(p.returnsRate * 1000) / 10),
    journeyCost: "",
    journeyMinutes: "",
    overheadMinutes: "10",
    handlingMinutes: "",
    hourlyFloor: String(p.target),
    cashNeededBy: "",
    promotionEligible: false,
    // Blank on purpose: a branch check counts only in the locality the
    // operator states for this trip, never one assumed from the profile.
    locality: "",
    category: "",
    categoryReason: "",
    packagingChecked: false,
    bestBefore: "",
  };
}
// Costs and times the estimate needs entered: a blank is never counted as
// zero, and 0 counts only when typed (server/estimate.mjs REQUIRED_INPUTS).
const REQUIRED_FIELDS = new Set<keyof Inputs>([
  "postage",
  "packaging",
  "journeyCost",
  "journeyMinutes",
  "handlingMinutes",
]);
// The same plain labels the server lists in missingInputs.
const REQUIRED_LABELS: Partial<Record<keyof Inputs, string>> = {
  postage: "parcel cost",
  packaging: "packaging cost",
  journeyCost: "return journey cost",
  journeyMinutes: "journey time",
  handlingMinutes: "handling time",
};
type FieldKind = "pounds" | "percent" | "minutes" | "count" | "kg";
const FIELDS: [keyof Inputs, string, FieldKind, string?][] = [
  ["units", "Units to buy", "count", "A first purchase is a small trial batch"],
  ["weightKg", "Unit weight (kg)", "kg", "One unit as posted. Unknown weight is rejected"],
  ["postage", "Parcel cost per unit sold (£), required", "pounds", "What you pay to post one unit"],
  [
    "packaging",
    "Packaging per unit (£), required",
    "pounds",
    "Mailer, box and filler. Enter 0 only if it truly costs nothing",
  ],
  ["feeRate", "Marketplace fee rate (%)", "percent", "Up to 50%"],
  ["feeFixed", "Fixed fee per sale (£)", "pounds"],
  ["returnsRate", "Returns allowance (%)", "percent", "Share of the sale price set aside"],
  [
    "journeyCost",
    "Return journey cost (£), required",
    "pounds",
    "Fares, fuel and parking, shared across units. Enter 0 only if it costs nothing, for example walking",
  ],
  [
    "journeyMinutes",
    "Journey minutes (return), required",
    "minutes",
    "Door to door, there and back. A blank journey is never treated as free or instant",
  ],
  ["overheadMinutes", "Minutes in store", "minutes"],
  [
    "handlingMinutes",
    "Handling minutes per unit, required",
    "minutes",
    "Listing, packing and dispatch. A blank is never treated as no time",
  ],
  ["hourlyFloor", "Hourly floor (£ per hour)", "pounds"],
];

// Reads a text field as a number in API units: pounds to pence, a percentage
// to a share, kilograms as given, minutes and counts as whole numbers.
// undefined means not entered; NaN means not a number.
function readNumber(raw: string, kind: FieldKind) {
  const text = raw.trim();
  if (text === "") return undefined;
  const value = Number(text);
  if (!Number.isFinite(value)) return NaN;
  if (kind === "pounds") return toPence(value);
  if (kind === "percent") return Math.round(value * 10) / 1000;
  if (kind === "kg") return value;
  return Math.round(value);
}

// A member's own stricter buying thresholds, kept as form text. They are
// stored in API units with loadMemberRules and saveMemberRules, so the
// Planner, Research and bounty drafts share them.
type Stricter = Record<RuleKey, string>;
const NO_STRICTER: Stricter = {
  minUnitPrice: "",
  maxUnitPrice: "",
  maxWeightKg: "",
  minUnitProfit: "",
  minReturn: "",
  trialUnits: "",
};
// [key, label, unit, direction]: "higher" thresholds are minimums, so only a
// higher value is stricter; "lower" thresholds are maximums.
const STRICTER_FIELDS: [RuleKey, string, FieldKind, "higher" | "lower"][] = [
  ["minUnitPrice", "Lowest purchase price per unit (£)", "pounds", "higher"],
  ["maxUnitPrice", "Highest purchase price per unit (£)", "pounds", "lower"],
  ["maxWeightKg", "Unit weight must be under (kg)", "kg", "lower"],
  ["minUnitProfit", "Lowest profit per unit (£)", "pounds", "higher"],
  ["minReturn", "Lowest return on purchase price (%)", "percent", "higher"],
  ["trialUnits", "Largest first purchase (units)", "count", "lower"],
];
// Threshold value in form units, for placeholders and messages.
function ruleText(key: RuleKey, rules: Rules) {
  const v = rules[key];
  if (key === "minUnitPrice" || key === "maxUnitPrice" || key === "minUnitProfit") return money(v);
  if (key === "minReturn") return percent(v);
  if (key === "maxWeightKg") return v + " kg";
  return v + (v === 1 ? " unit" : " units");
}
// An API value (pence, share, kg, units) as form text (pounds, percent).
function ruleFormText(key: RuleKey, v: number) {
  if (key === "minUnitPrice" || key === "maxUnitPrice" || key === "minUnitProfit")
    return (v / 100).toFixed(2);
  if (key === "minReturn") return String(Math.round(v * 1000) / 10);
  return String(v);
}
const formValue = (key: RuleKey, rules: Rules) => ruleFormText(key, rules[key]);
function loadStricter(): Stricter {
  const saved = loadMemberRules();
  const out = { ...NO_STRICTER };
  for (const [key] of STRICTER_FIELDS) {
    const v = saved[key];
    if (typeof v === "number") out[key] = ruleFormText(key, v);
  }
  return out;
}
// Form text to API units; blank or unreadable values are left out.
function stricterRules(value: Stricter): MemberRules {
  const rules: MemberRules = {};
  for (const [key, , kind] of STRICTER_FIELDS) {
    const v = readNumber(value[key], kind);
    if (v !== undefined && !Number.isNaN(v)) rules[key] = v;
  }
  return rules;
}

/** Builds the estimate request, or returns an error message. */
function buildRequest(
  offer: Offer,
  confirmed: string[],
  inputs: Inputs,
  stricter: Stricter,
  offerAttributes: Partial<Record<AttrKey, string>>,
  carryKg: number | null,
): EstimateRequest | string {
  const read = (field: keyof Inputs, kind: FieldKind) => readNumber(String(inputs[field]), kind);
  const costs: Record<string, number> = {};
  for (const [field, label, kind] of FIELDS) {
    const value = read(field, kind);
    if (Number.isNaN(value)) return label + " must be a number";
    if (value !== undefined && !["units", "hourlyFloor", "weightKg"].includes(field))
      costs[field] = value;
  }
  const units = read("units", "count");
  if (units === undefined || Number.isNaN(units)) return "Enter the number of units";
  const weightKg = read("weightKg", "kg");
  if (weightKg !== undefined && !(weightKg > 0)) return "Unit weight must be more than 0 kg";
  for (const [key, label, kind] of STRICTER_FIELDS)
    if (Number.isNaN(readNumber(stricter[key], kind))) return label + " must be a number";
  const rules = stricterRules(stricter);
  const hourlyFloor = read("hourlyFloor", "pounds");
  const food = categoryChoice(inputs, offer).applied === "food";
  const reason = inputs.categoryReason.trim();
  return {
    offer: { provider: offer.provider, sourceId: offer.sourceId },
    sales: confirmed.map((k) => {
      const [provider, ...rest] = k.split("|");
      return { provider, sourceId: rest.join("|") };
    }),
    units,
    costs,
    ...(weightKg === undefined ? {} : { weightKg }),
    ...(Object.keys(rules).length ? { rules } : {}),
    ...(hourlyFloor === undefined ? {} : { hourlyFloor }),
    promotionEligible: inputs.promotionEligible,
    ...(inputs.cashNeededBy ? { cashNeededBy: inputs.cashNeededBy } : {}),
    ...(inputs.locality.trim() ? { locality: inputs.locality.trim() } : {}),
    ...(inputs.category ? { category: inputs.category } : {}),
    ...(inputs.category && reason ? { categoryReason: reason.slice(0, 300) } : {}),
    ...(carryKg !== null ? { carryKg } : {}),
    ...(food ? { packagingChecked: inputs.packagingChecked } : {}),
    ...(food && inputs.bestBefore ? { bestBefore: inputs.bestBefore } : {}),
    ...(Object.keys(offerAttributes).length ? { offerAttributes } : {}),
  };
}

// The estimate request without what the audit sets from the item itself
// (the offer, the sales, the locality, promotion eligibility and the unit
// weight): costs, units, rules, the hourly floor, the cash date, the category
// and its checks, and any attributes the operator confirmed.
export function estimateInputsOf(req: EstimateRequest): Record<string, unknown> {
  const {
    offer: _offer,
    sales: _sales,
    locality: _locality,
    promotionEligible: _promotion,
    weightKg: _weight,
    ...rest
  } = req;
  return rest;
}

// Attributes the operator confirms, sent only once the confirmation box is
// ticked, and only for attributes the source left blank.
type AttrDraft = { values: Record<AttrKey, string>; confirmed: boolean };
const NO_ATTRS: AttrDraft = {
  values: { size: "", pack: "", model: "", condition: "" },
  confirmed: false,
};
function confirmedAttributes(offer: Offer | null, draft: AttrDraft) {
  const out: Partial<Record<AttrKey, string>> = {};
  if (!offer || !draft.confirmed) return out;
  for (const k of ATTR_KEYS)
    if (!offer[k] && draft.values[k].trim()) out[k] = draft.values[k].trim();
  return out;
}
const blankAttributes = (offer: Offer) => ATTR_KEYS.filter((k) => !offer[k]);

/**
 * The category choice as the server makes it (estimate.mjs
 * categoryDecision): a choice that drops any rule of the suggested category
 * is looser, and applies only with a reason; otherwise the suggested rules
 * stay. General has no rules of its own, so any other choice than the
 * suggestion is looser when the suggestion is clothing or food.
 */
function categoryChoice(inputs: Inputs, offer: Offer | null) {
  const suggested: CategoryId = offer?.suggestedCategory?.id ?? "general";
  const chosen: CategoryId | null = inputs.category || null;
  const looser = chosen !== null && chosen !== suggested && suggested !== "general";
  const reasoned = inputs.categoryReason.trim() !== "";
  const applied: CategoryId = looser && !reasoned ? suggested : (chosen ?? suggested);
  return { suggested, chosen, looser, reasoned, applied };
}

// The calculator's inputs for this browser tab, so following the page's own
// links (Sources, Goals) or reloading does not lose the work. Kept in
// sessionStorage, which can be unavailable: then the draft lasts as long as
// the page is open.
const DRAFT_KEY = "bounty-research-draft";
type Draft = {
  query: string;
  selected: Offer | null;
  confirmed: string[];
  attrs: AttrDraft;
  inputs: Inputs;
  goalsCashDate: string | null;
};
const isText = (v: unknown): v is string => typeof v === "string";
function loadDraft(): Draft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<Draft>;
    if (!d || typeof d !== "object") return null;
    const base = initialInputs();
    const inputs = { ...base };
    if (d.inputs && typeof d.inputs === "object")
      for (const k of Object.keys(base) as (keyof Inputs)[]) {
        const v = (d.inputs as Record<string, unknown>)[k];
        if (typeof v === typeof base[k]) (inputs as Record<string, unknown>)[k] = v;
      }
    if (!["", "general", "clothing", "food"].includes(inputs.category)) inputs.category = "";
    const o = d.selected as Offer | null | undefined;
    const selected =
      o && typeof o === "object" && isText(o.provider) && isText(o.sourceId) && isText(o.title) ? o : null;
    const values = d.attrs?.values as Record<string, unknown> | undefined;
    const attrs: AttrDraft =
      values && ATTR_KEYS.every((k) => isText(values[k]))
        ? { values: values as Record<AttrKey, string>, confirmed: d.attrs?.confirmed === true }
        : NO_ATTRS;
    return {
      query: isText(d.query) ? d.query : "",
      selected,
      confirmed: selected && Array.isArray(d.confirmed) ? d.confirmed.filter(isText) : [],
      attrs: selected ? attrs : NO_ATTRS,
      inputs,
      goalsCashDate: isText(d.goalsCashDate) ? d.goalsCashDate : null,
    };
  } catch {
    return null;
  }
}
function saveDraft(draft: Draft) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* storage unavailable: the draft lasts while the page is open */
  }
}
/** Forgets the saved Research inputs, for example after the tab failed. */
export function clearResearchDraft() {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* nothing stored */
  }
}
// The member's carry limit from the shared profile, for the access needs.
function profileCarry(): number | null {
  const carry = loadProfile().carry;
  return typeof carry === "number" && Number.isFinite(carry) && carry >= 0 && carry <= 1000 ? carry : null;
}

export function ResearchCalculator({
  onAuditDraft,
}: {
  onAuditDraft?: (draft: AuditDraft) => void;
}) {
  // Restored once, on mount, from this browser tab's saved draft.
  const [restored] = useState(loadDraft);
  const [carryKg] = useState(profileCarry);
  const [query, setQuery] = useState(restored?.query ?? "");
  const [offers, setOffers] = useState<{ rows: Offer[]; total: number }>({
    rows: [],
    total: 0,
  });
  const [offerError, setOfferError] = useState("");
  const [selected, setSelected] = useState<Offer | null>(restored?.selected ?? null);
  const [candidates, setCandidates] = useState<Candidates | null>(null);
  const [candidateError, setCandidateError] = useState("");
  const [confirmed, setConfirmed] = useState<string[]>(restored?.confirmed ?? []);
  const [attrs, setAttrs] = useState<AttrDraft>(restored?.attrs ?? NO_ATTRS);
  const [inputs, setInputs] = useState<Inputs>(() => restored?.inputs ?? initialInputs());
  const [stricter, setStricter] = useState<Stricter>(loadStricter);
  const [agreed, setAgreed] = useState<Agreed | null>(null);
  const [goalsCashDate, setGoalsCashDate] = useState<string | null>(restored?.goalsCashDate ?? null);
  // The cash date Goals held when the draft was saved, so a date that came
  // from Goals follows a change made there.
  const previousGoalsDate = useRef(restored?.goalsCashDate ?? null);
  // The latest estimate with the request it answers. When the inputs have
  // moved on it is shown as out of date and never tracked or drafted.
  const [result, setResult] = useState<{ data: Estimate; key: string } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const sequence = useRef(0);

  // Offers: newest first, filtered by title or barcode.
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ limit: "50" });
      if (query.trim()) params.set("q", query.trim());
      api<{ rows: Offer[]; total: number }>("research/offers?" + params)
        .then((data) => {
          if (!active) return;
          setOffers(data);
          setOfferError("");
        })
        .catch((e: Error) => active && setOfferError(e.message));
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query]);

  // The agreed buying thresholds and category rules, shown before an estimate.
  useEffect(() => {
    let active = true;
    api<Agreed>("research/rules")
      .then((data) => active && setAgreed(data))
      .catch(() => {
        /* the estimate result carries the thresholds as well */
      });
    return () => {
      active = false;
    };
  }, []);

  // A cash date saved in Goals fills an empty cash date here, and replaces
  // one that came from Goals before (after "Change these in Goals").
  useEffect(() => {
    let active = true;
    api<{ cashNeededBy: string | null }>("goals")
      .then((goals) => {
        if (!active) return;
        const saved = goals?.cashNeededBy;
        const date = saved && saved >= localToday() ? saved : null;
        const before = previousGoalsDate.current;
        setGoalsCashDate(date);
        setInputs((current) =>
          !current.cashNeededBy || (before !== null && current.cashNeededBy === before)
            ? { ...current, cashNeededBy: date ?? "" }
            : current,
        );
      })
      .catch(() => {
        /* goals are optional here */
      });
    return () => {
      active = false;
    };
  }, []);

  // Shared with the Planner: thresholds saved here apply there and back.
  useEffect(() => saveMemberRules(stricterRules(stricter)), [stricter]);

  // A new offer starts from a clean slate. The offer restored from the draft
  // keeps its confirmed sales and attributes.
  const lastOffer = useRef<string | null>(
    restored?.selected ? key(restored.selected.provider, restored.selected.sourceId) : null,
  );
  useEffect(() => {
    const k = selected ? key(selected.provider, selected.sourceId) : null;
    if (k === lastOffer.current) return;
    lastOffer.current = k;
    setCandidates(null);
    setCandidateError("");
    setResult(null);
    setConfirmed([]);
    setAttrs(NO_ATTRS);
    setNotice("");
  }, [selected]);

  // Keep the draft for this browser tab.
  useEffect(
    () => saveDraft({ query, selected, confirmed, attrs, inputs, goalsCashDate }),
    [query, selected, confirmed, attrs, inputs, goalsCashDate],
  );

  const offerAttributes = useMemo(() => confirmedAttributes(selected, attrs), [selected, attrs]);
  const attrKey = JSON.stringify(offerAttributes);

  // Candidate evidence for the chosen offer, read with the attributes the
  // operator confirmed so that exact sales become confirmable.
  useEffect(() => {
    if (!selected) return;
    let active = true;
    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        provider: selected.provider,
        sourceId: selected.sourceId,
      });
      for (const [k, v] of Object.entries(JSON.parse(attrKey) as Record<string, string>))
        params.set(k, v);
      api<Candidates>("research/candidates?" + params)
        .then((data) => {
          if (!active) return;
          setCandidates(data);
          setCandidateError("");
        })
        .catch((e: Error) => active && setCandidateError(e.message));
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [selected, attrKey]);

  const request = useMemo(
    () =>
      selected ? buildRequest(selected, confirmed, inputs, stricter, offerAttributes, carryKg) : null,
    [selected, confirmed, inputs, stricter, offerAttributes, carryKg],
  );
  const requestKey = request && typeof request === "object" ? JSON.stringify(request) : null;

  // Recalculate shortly after any change. Every change takes a new sequence
  // number first, so an answer still in flight for older inputs can never
  // replace a newer validation error or a newer result.
  useEffect(() => {
    const id = ++sequence.current;
    if (!request) return;
    if (typeof request === "string") {
      setError(request);
      setResult(null);
      return;
    }
    const key = JSON.stringify(request);
    const timer = setTimeout(() => {
      api<Estimate>("research/estimate", request)
        .then((data) => {
          if (id !== sequence.current) return;
          setResult({ data, key });
          setError("");
        })
        .catch((e: Error) => {
          if (id !== sequence.current) return;
          setResult(null);
          setError(e.message);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [request, refresh]);

  const set = (field: keyof Inputs, value: string | boolean) =>
    setInputs((current) => ({ ...current, [field]: value }));
  const toggle = (k: string, on: boolean) =>
    setConfirmed((current) =>
      on ? [...new Set([...current, k])] : current.filter((x) => x !== k),
    );

  const estimate = result?.data ?? null;
  // Only an estimate for the inputs on screen may be tracked or drafted.
  const current = result && result.key === requestKey ? result.data : null;
  const stale = estimate !== null && current === null;
  const offer = estimate?.offer ?? candidates?.offer ?? selected;

  // A trip is tracked only once every required cost and time is entered: a
  // prediction with a blank counted as nothing would overstate the forecast.
  const blankRequired = [...REQUIRED_FIELDS]
    .filter((f) => String(inputs[f]).trim() === "")
    .map((f) => REQUIRED_LABELS[f] ?? String(f));
  const notEntered = [...new Set([...(current?.missingInputs ?? []), ...blankRequired])];

  async function trackInLedger() {
    const e = current?.economics;
    if (!current || !e || notEntered.length) return;
    const o = current.offer;
    // The same rule as the server: a sample offer or any sample sale in the
    // sold sample makes the whole estimate sample data.
    const sample =
      current.sampleData ?? (o.sample || current.sample.used.some((r) => isSampleRow(r)));
    const suffix = sample ? " (sample)" : "";
    setNotice("");
    try {
      const saved = await api<{ id: number | string }>("ledger/trips", {
        label:
          (o.title + (o.retailer ? " at " + o.retailer : "")).slice(0, 120 - suffix.length) + suffix,
        source: "research",
        kind: "resale",
        reference: o.provider + ":" + o.sourceId,
        predicted: {
          units: e.units,
          proceeds: e.proceeds,
          contribution: e.contribution,
          cashRequired: e.cashRequired,
          activeMinutes: e.activeMinutes,
          sample,
          ...(current.payout?.date ? { payoutBy: current.payout.date } : {}),
        },
      });
      setNotice(
        "Tracked in the ledger as trip " +
          saved.id +
          ". These are predictions, not realised cash: record receipts and payouts in Ledger.",
      );
    } catch (err) {
      setNotice("Could not track this trip: " + (err as Error).message);
    }
  }

  function draftBounty() {
    if (!current || !request || typeof request === "string") return;
    try {
      localStorage.setItem(
        "bounty-draft",
        JSON.stringify({
          estimate: request,
          title: current.offer.title,
          retailer: current.offer.retailer,
          locality: inputs.locality.trim(),
        }),
      );
      setNotice(
        "Bounty draft saved. Open the Bounties tab to finish it. A bounty only sends alerts while every check passes.",
      );
    } catch {
      setNotice("Could not save the draft: browser storage is unavailable.");
    }
  }

  function auditDraft() {
    if (!current || !onAuditDraft) return;
    const o = current.offer;
    // current is the estimate for this exact request (see requestKey), so
    // the handover matches the figures on screen.
    const req = typeof request === "object" && request ? request : null;
    const postage = req ? req.costs.postage : undefined;
    onAuditDraft({
      locality: inputs.locality.trim(),
      barcode: o.gtin,
      title: o.title,
      retailer: o.retailer || "",
      offerProvider: o.provider,
      offerSourceId: o.sourceId,
      availabilityCheckId: current.stock.check?.id ?? null,
      promotion: o.promotion,
      promotionEligible: o.promotion ? (inputs.promotionEligible ? true : null) : true,
      shipping: postage && postage > 0 ? postage : null,
      daysToSell: current.sample.daysToSell,
      independentSales: current.sample.independent,
      displayPermitted: current.permission.permitted,
      matchDecision: current.match,
      sales: req ? req.sales : [],
      weightKg: req?.weightKg ?? null,
      estimateInputs: req ? estimateInputsOf(req) : null,
    });
    setNotice("Audit form filled from this estimate. Review it below before saving.");
  }

  const choice = categoryChoice(inputs, selected);
  const categoryId: CategoryId = choice.applied;

  return (
    <article className="research-calculator">
      <small>Research desk</small>
      <h2>Research a trip from real evidence</h2>
      <p>
        Choose a barcoded retail offer, confirm the completed sales that are the
        exact same variant, then enter your costs and time. Asking prices are
        shown as competition and never used as sale prices. This estimate does
        not confirm stock and does not send an alert.
      </p>

      <fieldset className="research-search">
        <legend>1. Acquisition offer</legend>
        <label>
          Search offers by title or barcode
          <input
            type="search"
            placeholder="For example water bottle, or 5059123400017"
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
          />
        </label>
        {offerError && <p role="alert">{offerError}</p>}
        {!offerError && offers.total === 0 && (
          <p className="muted">
            No barcoded retail offers yet. Import a feed or run the Open Prices
            worker, then reload this tab.
          </p>
        )}
        <div className="offer-list">
          {offers.rows.map((o) => (
            <button
              type="button"
              key={key(o.provider, o.sourceId)}
              className={
                "card" +
                (selected && key(selected.provider, selected.sourceId) === key(o.provider, o.sourceId)
                  ? " active"
                  : "")
              }
              aria-pressed={
                !!selected &&
                key(selected.provider, selected.sourceId) === key(o.provider, o.sourceId)
              }
              onClick={() => {
                setError("");
                setSelected(o);
              }}
            >
              <span>
                <small>
                  {o.source} · {o.retailer || "retailer unknown"}
                  {o.location ? " · " + o.location : ""}
                </small>
                <b>{o.title}</b>
                <span className="badges">
                  {freshnessBadge(o)}
                  {o.sample && <span className="badge sample">Sample</span>}
                  {o.promotion && <span className="badge">Promotion</span>}
                </span>
                <em>
                  Barcode {barcodeText(o.barcode)} · Source date {dateTime(o.observed)} ·{" "}
                  {o.stockNote}
                </em>
              </span>
              <span>
                <b>{money(o.price)}</b>
                <small>offer price</small>
              </span>
            </button>
          ))}
        </div>
        {offers.total > offers.rows.length && (
          <p className="muted">
            Showing the newest {offers.rows.length} of {offers.total}. Search to
            narrow the list.
          </p>
        )}
      </fieldset>

      {selected && offer && (
        <>
          <OfferSummary offer={offer} />
          <AttributesPanel
            offer={selected}
            draft={attrs}
            onChange={setAttrs}
            result={candidates?.offerAttributes ?? null}
            error={candidateError}
          />
          {estimate?.prices ? (
            <PriceComparison prices={estimate.prices} />
          ) : (
            <p className="muted">The three prices appear with the estimate.</p>
          )}
          <fieldset>
            <legend>2. Completed sales</legend>
            <p className="muted">
              Only an exact match (same barcode, size, pack, model and condition),
              sold within 90 days, can be confirmed. Tick it only after you have
              checked the listing yourself. Similar products need research and
              never enter the sample.
            </p>
            {!candidates && !candidateError && <p className="muted">Loading evidence…</p>}
            {candidateError && !candidates && <p role="alert">{candidateError}</p>}
            {candidates && candidates.sales.length === 0 && (
              <p>No completed sales recorded for this barcode or a similar title.</p>
            )}
            {candidates?.sales.map((c) => {
              const k = key(c.row.provider, c.row.source_id);
              return (
                <div className={"evidence-row ev-row-sold status-" + c.status} key={k}>
                  <label className="confirm">
                    <input
                      type="checkbox"
                      disabled={!c.confirmable}
                      checked={c.confirmable === true && confirmed.includes(k)}
                      onChange={(ev) => toggle(k, ev.target.checked)}
                    />
                    <span>
                      {c.confirmable
                        ? "I have checked this is the exact variant"
                        : "Cannot be confirmed"}
                    </span>
                  </label>
                  <div>
                    <span className={"badge " + STATUS_CLASS[c.status]}>
                      {STATUS_LABEL[c.status]}
                    </span>
                    {c.sample && <span className="badge sample">Sample</span>}
                    <b>{c.row.title}</b>
                    <small>
                      Sold {c.row.observed ? dateTime(c.row.observed) : "date unknown"}
                      {c.row.listed ? " · listed " + dateTime(c.row.listed) : ""} · seller{" "}
                      {c.row.seller || "unknown"} · {c.row.provider}
                    </small>
                    <small>{attributesText(c.row)}</small>
                    <ul className="reasons">
                      {c.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                      {c.blocker && c.status === "exact" && <li>{c.blocker}</li>}
                    </ul>
                  </div>
                  <div className="amount">
                    <b>{money(c.row.price)}</b>
                    <small>realised total incl. buyer postage</small>
                  </div>
                </div>
              );
            })}
          </fieldset>

          {candidates && (
            <fieldset>
              <legend>Resale competition</legend>
              <p className="muted">
                Active listings with the same barcode. They show what competing
                sellers are asking, not what buyers paid, so they never enter the
                sold sample.
              </p>
              <CompetitionLine competition={candidates.competition} />
              {candidates.listings.map((c) => (
                <div className="evidence-row ev-row-asking" key={key(c.row.provider, c.row.source_id)}>
                  <div>
                    <span className="badge ev-asking">Asking price</span>
                    <span className="badge">{LISTING_LABEL[c.status]}</span>
                    <b>{c.row.title}</b>
                    <small>
                      Seller {c.row.seller || "unknown"} · {c.row.provider} · seen{" "}
                      {dateTime(c.row.observed || c.row.imported)}
                    </small>
                  </div>
                  <div className="amount">
                    <b>{money(c.row.price)}</b>
                    <small>
                      {c.row.shipping === null
                        ? "shipping unknown"
                        : "+ " + money(c.row.shipping) + " shipping"}
                    </small>
                  </div>
                </div>
              ))}
              {candidates.other.length > 0 && (
                <details>
                  <summary>
                    Other retail and Amazon records with this barcode (not sales)
                  </summary>
                  {candidates.other.map((c) => (
                    <div className="row" key={key(c.row.provider, c.row.source_id)}>
                      <span>
                        <small>
                          {c.row.provider} · {c.row.kind} ·{" "}
                          {c.row.observed ? dateTime(c.row.observed) : "date unknown"}
                        </small>
                        <b>{c.row.title}</b>
                      </span>
                      {money(c.row.price)}
                    </div>
                  ))}
                </details>
              )}
            </fieldset>
          )}

          <fieldset>
            <legend>3. Your costs and time</legend>
            <div className="grid2 inputs">
              {FIELDS.map(([field, label, kind, hint]) => (
                <label key={field}>
                  {label}
                  <input
                    type="number"
                    inputMode="decimal"
                    min={field === "units" ? 1 : 0}
                    max={
                      field === "units"
                        ? 100
                        : kind === "percent"
                          ? 50
                          : kind === "minutes"
                            ? 1440
                            : kind === "kg"
                              ? 1000
                              : undefined
                    }
                    step={kind === "pounds" || kind === "kg" ? 0.01 : kind === "percent" ? 0.1 : 1}
                    value={String(inputs[field])}
                    aria-invalid={REQUIRED_FIELDS.has(field) && String(inputs[field]).trim() === ""}
                    onChange={(ev) => set(field, ev.target.value)}
                  />
                  {hint && <span className="muted">{hint}</span>}
                </label>
              ))}
              <label>
                Date you need the cash back
                <input
                  type="date"
                  value={inputs.cashNeededBy}
                  onChange={(ev) => set("cashNeededBy", ev.target.value)}
                />
                <span className="muted">
                  {goalsCashDate && inputs.cashNeededBy === goalsCashDate
                    ? "From your Goals. Checked against the expected payout, not the sale"
                    : "Checked against the expected payout, not the sale"}
                </span>
              </label>
              <label>
                Locality for the stock check
                <input
                  value={inputs.locality}
                  maxLength={120}
                  aria-invalid={!inputs.locality.trim()}
                  onChange={(ev) => set("locality", ev.target.value)}
                />
                <span className={inputs.locality.trim() ? "muted" : "warn"}>
                  {inputs.locality.trim()
                    ? "A branch check counts only in this locality"
                    : "Enter the town or area of the branch: without it no branch check can confirm stock"}
                </span>
              </label>
            </div>
            {offer.promotion && (
              <label className="confirm">
                <input
                  type="checkbox"
                  checked={inputs.promotionEligible}
                  onChange={(ev) => set("promotionEligible", ev.target.checked)}
                />
                <span>
                  I have checked that I qualify for this price, for example I hold
                  the loyalty card or meet the multibuy terms. Condition recorded:{" "}
                  {offer.promotion}.
                  {offer.promotion === "Discounted price (type not stated)" &&
                    " The source does not say what the discount depends on, so check it at the shelf before relying on it."}
                </span>
              </label>
            )}
          </fieldset>

          <CategoryPanel
            suggestion={selected.suggestedCategory ?? null}
            chosen={inputs.category}
            id={categoryId}
            looser={choice.looser}
            reason={inputs.categoryReason}
            rules={agreed?.categories ?? null}
            packagingChecked={inputs.packagingChecked}
            bestBefore={inputs.bestBefore}
            onChange={set}
            failures={
              estimate?.category && estimate.category.id === categoryId
                ? estimate.category.failures
                : null
            }
            warning={
              current?.category && (current.category.chosen ?? "") === inputs.category
                ? current.category.warning
                : null
            }
          />

          <ThresholdsPanel
            agreed={agreed}
            thresholds={estimate?.thresholds ?? null}
            stricter={stricter}
            onChange={setStricter}
          />

          {error && <p role="alert">{error}</p>}
          {estimate && <Result estimate={estimate} stale={stale} />}

          {estimate && (
            <StockCheckForm
              key={key(estimate.offer.provider, estimate.offer.sourceId)}
              offer={estimate.offer}
              locality={inputs.locality}
              latest={estimate.stock.check}
              shelf={estimate.stock.shelf ?? null}
              estimateLocality={estimate.checked?.locality ?? null}
              onSaved={() => setRefresh((n) => n + 1)}
            />
          )}

          {estimate && (
            <div className="actions">
              <button
                type="button"
                onClick={trackInLedger}
                disabled={!current?.economics || notEntered.length > 0}
                aria-describedby={notEntered.length ? "track-needs-costs" : undefined}
              >
                Track in ledger
              </button>
              <button type="button" onClick={draftBounty} disabled={!current}>
                Draft a bounty
              </button>
              {onAuditDraft && (
                <button type="button" onClick={auditDraft} disabled={!current}>
                  Add to validation audit
                </button>
              )}
            </div>
          )}
          {stale && (
            <p className="muted">
              The estimate is updating for your latest changes, so these actions wait for it.
            </p>
          )}
          {estimate && notEntered.length > 0 && (
            <p className="muted" id="track-needs-costs">
              Enter every cost before tracking this trip: {listText(notEntered)}{" "}
              {notEntered.length === 1 ? "is" : "are"} not entered yet.
            </p>
          )}
          {!stale && estimate && !estimate.economics && (
            <p className="muted">
              Tracking needs at least one confirmed exact sale, so there is a
              prediction to compare against.
            </p>
          )}
          {notice && <p role="status" className="notice">{notice}</p>}
        </>
      )}
    </article>
  );
}

// Today as YYYY-MM-DD in the browser's time zone, for date inputs.
const localToday = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};

const ATTR_LABEL: Record<AttrKey, string> = {
  size: "Size",
  pack: "Pack",
  model: "Model or part number",
  condition: "Condition",
};
const ATTR_HINT: Record<AttrKey, string> = {
  size: "As printed on the label, for example M, 10 or 28cm",
  pack: "Units in one pack as sold, for example 1, single or 3-pack",
  model: "As printed on the packaging, or none if it has no model number",
  condition: "Retailers sell new stock, so new is assumed if you leave this blank",
};
const CONDITIONS = [
  "new",
  "new with tags",
  "new without tags",
  "new with box",
  "new without box",
  "new other",
  "new with defects",
  "used",
  "refurbished",
  "for parts",
];

/**
 * Lets the operator fill attributes the source left blank after looking at
 * the item. Values apply only once the confirmation box is ticked, never
 * replace what the source states, and are marked as confirmed by you.
 */
function AttributesPanel({
  offer,
  draft,
  onChange,
  result,
  error,
}: {
  offer: Offer;
  draft: AttrDraft;
  onChange: (value: AttrDraft) => void;
  result: AttributeResult | null;
  error: string;
}) {
  const blank = blankAttributes(offer);
  if (!blank.length) return null;
  const applied = Object.entries(result?.applied ?? {});
  const entered = blank.some((k) => draft.values[k].trim() !== "");
  const noModel = draft.values.model.trim().toLowerCase() === NO_MODEL;
  const setValue = (k: AttrKey, value: string) =>
    onChange({ ...draft, values: { ...draft.values, [k]: value } });
  return (
    <fieldset className="attributes">
      <legend>Attributes the source left blank</legend>
      <p className="muted">
        An exact match needs the size, pack, model and condition stated on both
        the offer and the sale. This source does not state{" "}
        {blank.map((k) => ATTR_LABEL[k].toLowerCase()).join(", ")}. Look at the item
        itself (the shelf label, the packaging or the retailer's product page) and
        enter what you see. Your values fill only these blanks and are shown as
        confirmed by you.
      </p>
      <div className="grid2 inputs">
        {blank.map((k) =>
          k === "model" ? (
            <div className="model-field" key={k}>
              <label>
                {ATTR_LABEL.model}
                <input
                  value={noModel ? "" : draft.values.model}
                  maxLength={100}
                  disabled={noModel}
                  placeholder={noModel ? "No model number" : undefined}
                  onChange={(ev) => setValue("model", ev.target.value)}
                />
                <span className="muted">{ATTR_HINT.model}</span>
              </label>
              <label className="confirm">
                <input
                  type="checkbox"
                  checked={noModel}
                  onChange={(ev) => setValue("model", ev.target.checked ? NO_MODEL : "")}
                />
                <span>
                  This item has no model number. It then matches only sales that state
                  no model either
                </span>
              </label>
            </div>
          ) : (
          <label key={k}>
            {ATTR_LABEL[k]}
            {k === "condition" ? (
              <select
                value={draft.values.condition}
                onChange={(ev) => setValue("condition", ev.target.value)}
              >
                <option value="">Not confirmed</option>
                {CONDITIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={draft.values[k]}
                maxLength={100}
                onChange={(ev) => setValue(k, ev.target.value)}
              />
            )}
            <span className="muted">{ATTR_HINT[k]}</span>
          </label>
          ),
        )}
      </div>
      <label className="confirm">
        <input
          type="checkbox"
          checked={draft.confirmed}
          disabled={!entered && !draft.confirmed}
          onChange={(ev) => onChange({ ...draft, confirmed: ev.target.checked })}
        />
        <span>I have looked at the item and these values are correct</span>
      </label>
      {error && <p role="alert">{error}</p>}
      {draft.confirmed && applied.length > 0 && !error && (
        <p className="ok note">
          Applied as confirmed by you:{" "}
          {applied
            .map(([k, v]) => (k === "model" && v === NO_MODEL ? "no model number" : k + " " + v))
            .join(", ")}
          .
        </p>
      )}
      {result?.ignored.map((x) => (
        <p className="warn note" key={x.key}>
          {x.reason}
        </p>
      ))}
    </fieldset>
  );
}

const CATEGORY_NAME: Record<CategoryId, string> = {
  general: "General",
  clothing: "Clothing",
  food: "Food",
};
function categoryRuleText(id: CategoryId, rule: CategoryRule | null) {
  if (id === "clothing")
    return [
      "A returns allowance of at least " +
        percent(rule?.minReturnsRate ?? 0.15) +
        " of the sale price: a lower figure is raised to it",
      "A stated size, because demand and sales are size-specific: only sales of that size can match",
    ];
  if (id === "food")
    return [
      "Packaging checked as sealed, undamaged and fit to post",
      "At least " +
        (rule?.minShelfLifeDays ?? 30) +
        " days left on the best-before date after the expected sale",
      "Unit weight entered, as for every item",
    ];
  return ["No rules beyond the buying thresholds"];
}

// What the suggested category's rules check, for the reason prompt.
function droppedText(suggested: CategoryId, rule: CategoryRule | null) {
  if (suggested === "clothing")
    return "the " + percent(rule?.minReturnsRate ?? 0.15) + " returns allowance and the size check";
  if (suggested === "food")
    return "the sealed packaging check and the " + (rule?.minShelfLifeDays ?? 30) + "-day best-before check";
  return "no rules";
}

/**
 * Category choice, the rules it brings and any that fail. A choice looser
 * than the suggestion keeps the suggested rules until a reason is given,
 * and the estimate always warns about what it drops.
 */
function CategoryPanel({
  suggestion,
  chosen,
  id,
  looser,
  reason,
  rules,
  packagingChecked,
  bestBefore,
  onChange,
  failures,
  warning,
}: {
  suggestion: { id: CategoryId; basis: string; hint?: string } | null;
  chosen: "" | CategoryId;
  id: CategoryId;
  looser: boolean;
  reason: string;
  rules: Record<CategoryId, CategoryRule> | null;
  packagingChecked: boolean;
  bestBefore: string;
  onChange: (field: keyof Inputs, value: string | boolean) => void;
  failures: string[] | null;
  warning: string | null;
}) {
  const suggested = suggestion?.id ?? "general";
  return (
    <fieldset className="category">
      <legend>4. Category rules</legend>
      <div className="grid2 inputs">
        <label>
          Category
          <select value={chosen} onChange={(ev) => onChange("category", ev.target.value)}>
            <option value="">Suggested: {CATEGORY_NAME[suggested]}</option>
            {(Object.keys(CATEGORY_NAME) as CategoryId[]).map((c) => (
              <option key={c} value={c}>
                {CATEGORY_NAME[c]}
              </option>
            ))}
          </select>
          <span className="muted">
            {chosen
              ? "Chosen by you. Suggested: " + CATEGORY_NAME[suggested] + ". " + (suggestion?.basis ?? "")
              : (suggestion?.basis ?? "No clear category in the title") + ". Change it if that is wrong"}
          </span>
          {suggestion?.hint && chosen !== "food" && (
            <span className="warn">{suggestion.hint}.</span>
          )}
        </label>
        {looser && (
          <label>
            Why is this {CATEGORY_NAME[chosen || suggested]}, not {CATEGORY_NAME[suggested].toLowerCase()}?
            <input
              value={reason}
              maxLength={300}
              aria-invalid={!reason.trim()}
              onChange={(ev) => onChange("categoryReason", ev.target.value)}
            />
            <span className={reason.trim() ? "muted" : "warn"}>
              {reason.trim()
                ? "Costed as " + CATEGORY_NAME[chosen || suggested] + " without " + droppedText(suggested, rules?.[suggested] ?? null) + ". The estimate says so"
                : "Until you give a reason the " + CATEGORY_NAME[suggested].toLowerCase() + " rules still apply (" + droppedText(suggested, rules?.[suggested] ?? null) + ")"}
            </span>
          </label>
        )}
      </div>
      {warning && <p className="warn note">{warning}.</p>}
      <p className="muted">{CATEGORY_NAME[id]} items need, on top of the buying thresholds:</p>
      <ul className="threshold-list">
        {categoryRuleText(id, rules?.[id] ?? null).map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      {id === "food" && (
        <div className="grid2 inputs">
          <label className="confirm">
            <input
              type="checkbox"
              checked={packagingChecked}
              onChange={(ev) => onChange("packagingChecked", ev.target.checked)}
            />
            <span>I have checked the packaging is sealed, undamaged and fit to post</span>
          </label>
          <label>
            Best-before date on the pack
            <input
              type="date"
              value={bestBefore}
              onChange={(ev) => onChange("bestBefore", ev.target.value)}
            />
          </label>
        </div>
      )}
      {failures !== null &&
        (failures.length ? (
          <ul className="warnings">
            {failures.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        ) : (
          <p className="ok note">The {CATEGORY_NAME[id].toLowerCase()} rules pass.</p>
        ))}
    </fieldset>
  );
}

// A calendar date for people ("30 Oct 2026"), never the raw ISO form.
const day = (value: string | null | undefined) => (value ? dateTime(value.slice(0, 10)) : "date unknown");
const span = (r: { lowest: number | null; highest: number | null }) =>
  r.lowest === null
    ? "not known"
    : r.lowest === r.highest
      ? money(r.lowest)
      : money(r.lowest) + " to " + money(r.highest);
const plural = (n: number, word: string) => n + " " + word + (n === 1 ? "" : "s");
// Shown wherever independent sales are: a sale with no seller name cannot
// show independence, so it is left out of the count.
export const noSellerNote = (n: number | null | undefined) =>
  n && n > 0
    ? plural(n, "sale") + " with no seller name " + (n === 1 ? "is" : "are") + " not counted as independent"
    : "";
const between = (r: { oldest: string | null; newest: string | null }) =>
  day(r.oldest) === day(r.newest) ? "on " + day(r.newest) : day(r.oldest) + " to " + day(r.newest);

/**
 * The three prices side by side, each with its evidence class and dates:
 * the claimed previous price, the acquisition price observed over time and
 * completed resale prices. They answer different questions and are never
 * pooled.
 */
function PriceComparison({ prices }: { prices: Prices }) {
  const o = prices.observed;
  const s = prices.sold;
  const point = (p: PricePoint) => (
    <li key={p.provider + "|" + p.sourceId}>
      {day(p.observed)} · <b className="inline">{money(p.price)}</b> ·{" "}
      {p.retailer || p.provider}
      {p.promotion ? " · promotion" : ""}
      {p.chosen ? " (this offer)" : ""}
    </li>
  );
  return (
    <section className="three-prices" aria-label="Three prices">
      <small>Three prices, kept apart</small>
      <div className="price-columns">
        <div className="price-col ev-col-retail">
          <h3>{prices.claimed?.kind === "rrp" ? "Recommended retail price" : "Claimed previous price"}</h3>
          <span className="badge ev-retail">{prices.claimed?.evidenceClass ?? "Retail offer"}</span>
          {prices.claimed ? (
            <>
              <b className="figure">{money(prices.claimed.price)}</b>
              <span className="note">
                {prices.claimed.basis}. Source date {day(prices.claimed.observed)}.
              </span>
            </>
          ) : (
            <p className="muted">
              Not stated by this source, so there is no claimed previous price or
              recommended retail price to compare.
            </p>
          )}
        </div>
        <div className="price-col ev-col-retail">
          <h3>Price observed over time</h3>
          <span className="badge ev-retail">{o.evidenceClass}</span>
          {o.count ? (
            <>
              <b className="figure">{span(o)}</b>
              <span className="note">
                {plural(o.count, "dated price")} for this barcode, {between(o)}
              </span>
              <ul className="price-points">{o.points.slice(0, 5).map(point)}</ul>
              {o.points.length > 5 && (
                <details>
                  <summary>All {o.points.length} shown prices</summary>
                  <ul className="price-points">{o.points.slice(5).map(point)}</ul>
                </details>
              )}
            </>
          ) : (
            <p className="muted">No dated prices recorded for this barcode.</p>
          )}
          {o.amazon.count > 0 && (
            <p className="muted">
              <span className="badge">{o.amazon.evidenceClass}</span> {span(o.amazon)},{" "}
              {plural(o.amazon.count, "point")}, {between(o.amazon)}. {o.amazon.note}.
            </p>
          )}
        </div>
        <div className="price-col ev-col-sold">
          <h3>Completed resale prices</h3>
          <span className="badge ev-sold">{s.evidenceClass}</span>
          {s.count ? (
            <>
              <b className="figure">{money(s.lowerMedian)} lower median</b>
              <span className="note">
                {plural(s.count, "confirmed sale")}, {span(s)}, sold {between(s)}. {s.note}.
              </span>
            </>
          ) : (
            <p className="muted">No confirmed exact sale yet, so there is no resale price.</p>
          )}
          {s.exactNotInSample > 0 && (
            <span className="note">
              {plural(s.exactNotInSample, "other exact-variant sale")} not in the sample
              (not confirmed, too old or undated).
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

// "at least" for minimum thresholds, "at most" or "under" for maximums.
function agreedText(key: RuleKey, rules: Rules) {
  if (key === "maxWeightKg") return "under " + ruleText(key, rules);
  const direction = STRICTER_FIELDS.find(([k]) => k === key)?.[3];
  return (direction === "higher" ? "at least " : "at most ") + ruleText(key, rules);
}

/**
 * The buying thresholds in force and the member's optional stricter values.
 * The server applies an override only when it is stricter (effectiveRules);
 * a looser value is flagged here and ignored there.
 */
function ThresholdsPanel({
  agreed,
  thresholds,
  stricter,
  onChange,
}: {
  agreed: Agreed | null;
  thresholds: Thresholds | null;
  stricter: Stricter;
  onChange: (value: Stricter) => void;
}) {
  const base = thresholds?.defaults ?? agreed?.rules ?? null;
  const inForce = thresholds?.rules ?? base;
  const tightened = new Set<RuleKey>(thresholds?.tightened ?? []);
  const yours = (...keys: RuleKey[]) =>
    keys.some((k) => tightened.has(k)) ? <span className="badge">Yours</span> : null;
  const alertRules = agreed?.alertRules ?? null;
  const entered = STRICTER_FIELDS.some(([k]) => stricter[k].trim() !== "");
  return (
    <fieldset className="thresholds">
      <legend>5. Buying thresholds</legend>
      {!inForce && <p className="muted">Loading the buying thresholds…</p>}
      {inForce && (
        <>
          <p className="muted">
            An item has to meet all of these to reach Priority 1 or 2, and only
            then can it become a buy alert.
          </p>
          <ul className="threshold-list">
            <li>
              Purchase price {ruleText("minUnitPrice", inForce)} to{" "}
              {ruleText("maxUnitPrice", inForce)} per unit {yours("minUnitPrice", "maxUnitPrice")}
            </li>
            <li>
              Each unit weighs under {ruleText("maxWeightKg", inForce)} {yours("maxWeightKg")}
            </li>
            <li>
              At least {ruleText("minUnitProfit", inForce)} estimated profit per unit after
              fees, postage, packaging, the returns allowance and the unit's share of
              travel {yours("minUnitProfit")}
            </li>
            <li>
              At least {ruleText("minReturn", inForce)} return: profit per unit divided by
              the purchase price per unit {yours("minReturn")}
            </li>
            <li>
              {alertRules
                ? "At least " +
                  alertRules.minIndependentSales +
                  " independent completed sales of the exact item in the last " +
                  alertRules.maxSaleAgeDays +
                  " days"
                : "Several recent completed sales of the exact item"}
            </li>
            <li>
              A first purchase is a trial batch of at most {ruleText("trialUnits", inForce)}{" "}
              {yours("trialUnits")}
            </li>
          </ul>
          <p className="muted">
            Cash required before payout is a separate figure in the estimate: check you
            can afford it whatever the tier.
          </p>
        </>
      )}
      <details open={entered}>
        <summary>Your stricter thresholds (optional)</summary>
        <p className="muted">
          You can make any threshold stricter for yourself, for example a higher
          minimum profit or a smaller first purchase. Loosening is not allowed: the
          agreed thresholds keep out trips that are likely to lose money, so a looser
          value is ignored and the agreed threshold applies. Saved in this browser
          and shared with the Planner, so the same thresholds apply in both.
        </p>
        <div className="grid2 inputs">
          {STRICTER_FIELDS.map(([key, label, kind, direction]) => {
            const value = readNumber(stricter[key], kind);
            const looser =
              base !== null &&
              value !== undefined &&
              !Number.isNaN(value) &&
              (direction === "higher" ? value < base[key] : value > base[key]);
            return (
              <label key={key}>
                {label}
                <input
                  type="number"
                  inputMode="decimal"
                  min={kind === "count" ? 1 : 0}
                  step={kind === "count" ? 1 : kind === "percent" ? 0.1 : 0.01}
                  placeholder={base ? formValue(key, base) : ""}
                  value={stricter[key]}
                  onChange={(ev) => onChange({ ...stricter, [key]: ev.target.value })}
                />
                <span className={looser ? "warn" : "muted"}>
                  {base
                    ? looser
                      ? "Looser than the agreed threshold (" + agreedText(key, base) + "), so it is not applied"
                      : "Agreed: " + agreedText(key, base)
                    : ""}
                </span>
              </label>
            );
          })}
        </div>
        {entered && (
          <button type="button" onClick={() => onChange({ ...NO_STRICTER })}>
            Clear my thresholds
          </button>
        )}
      </details>
    </fieldset>
  );
}

const TIER_CLASS: Record<Tier, string> = {
  "Priority 1": "ok",
  "Priority 2": "ok",
  Watch: "sample",
  Review: "sample",
  Reject: "warn",
};
const TIER_MEANING: Record<Tier, string> = {
  "Priority 1":
    "Passes the buying thresholds with strong sold evidence, easy fulfilment and confirmed stock.",
  "Priority 2":
    "Passes the buying thresholds, but demand is weaker, pressure is higher or unknown, or stock is not confirmed.",
  Watch:
    "The evidence holds up but profit or return falls short. It would qualify at a lower purchase price.",
  Review: "Evidence is missing or uncertain. Resolve the reasons below before judging the numbers.",
  Reject: "Fails a buying threshold that a better price cannot fix, or a hard filter. Do not buy.",
};

/** Opportunity tier with its reasons, profit per unit and return. */
function TierCard({
  opportunity: o,
  rules,
  leftOut,
  demand,
}: {
  opportunity: Opportunity;
  rules: Rules;
  // Costs left blank, which profit per unit does not include yet.
  leftOut: string[];
  demand: Demand | null;
}) {
  const meets = (ok: boolean | null) => (ok === null ? "" : ok ? "ok" : "warn");
  return (
    <div className={"tier tier-" + o.tier.toLowerCase().replace(/\s+/g, "-")}>
      <p className="tier-head">
        <span className={"badge " + TIER_CLASS[o.tier]}>{o.tier}</span>
        <b>{TIER_MEANING[o.tier]}</b>
      </p>
      <ul className="reasons">
        {o.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {o.tier === "Watch" && o.targetPrice !== null && (
        <p className="notice">
          Target purchase price: <b className="inline">{money(o.targetPrice)} or less per unit</b>{" "}
          (costed now at {money(o.unitPrice)}). At that price both the profit and the
          return thresholds are met, with every other cost unchanged.
        </p>
      )}
      <dl className="figures">
        <dt>Purchase price per unit</dt>
        <dd>{money(o.unitPrice)}</dd>
        <dt>Profit per unit after variable costs</dt>
        {/* A figure that leaves out a blank cost is never shown as passing. */}
        <dd className={leftOut.length ? "warn" : meets(o.unitProfit === null ? null : o.unitProfit >= rules.minUnitProfit)}>
          {o.unitProfit === null ? "not known" : money(o.unitProfit)}
          {leftOut.length && o.unitProfit !== null ? " leaving out the " + listText(leftOut) + ", not entered" : ""}{" "}
          (needs at least {money(rules.minUnitProfit)})
        </dd>
        <dt>Return on purchase price</dt>
        <dd className={leftOut.length ? "warn" : meets(o.returnOnCost === null ? null : o.returnOnCost >= rules.minReturn)}>
          {o.returnOnCost === null ? "not known" : percent(o.returnOnCost)}
          {leftOut.length && o.returnOnCost !== null ? " leaving out the " + listText(leftOut) + ", not entered" : ""} (needs at least{" "}
          {percent(rules.minReturn)})
        </dd>
        <dt>Unit weight</dt>
        <dd className={meets(o.weightKg === null ? false : o.weightKg < rules.maxWeightKg)}>
          {o.weightKg === null ? "not entered" : o.weightKg + " kg"} (must be under{" "}
          {rules.maxWeightKg} kg)
        </dd>
        <dt>Confirmed sales per week</dt>
        <dd>{o.salesPerWeek === null ? "not known" : o.salesPerWeek}</dd>
        {demand && (
          <>
            <dt>Units the sales rate supports in {plural(demand.sellWindowWeeks, "week")}</dt>
            <dd className={demand.units === null || demand.units === 0 ? "warn" : ""}>
              {demand.units === null ? "not known" : demand.units}
              <span className="note">{demand.note}.</span>
            </dd>
          </>
        )}
        <dt>Resale weeks of supply</dt>
        <dd>
          {o.resaleWeeksOfSupply === null
            ? "not known"
            : o.resaleWeeksOfSupply === 0
              ? "none: the latest asking-price lookup found no competing listings"
              : o.resaleWeeksOfSupply + " weeks of competing listings"}
        </dd>
        <dt>Sourcing pressure</dt>
        <dd>{o.sourcingPressure === null ? "not known at research time" : o.sourcingPressure}</dd>
      </dl>
      <p className="muted">
        A tier is a buying guide, not a buy alert: every check further down must pass
        as well. A research estimate reaches Priority 2 at best, because nobody knows
        yet how many others are heading to the shelf. Until a verified trade (purchase
        receipt and payout record) exists for this item, a first purchase is at most{" "}
        {o.trialUnits} {o.trialUnits === 1 ? "unit" : "units"}.
      </p>
    </div>
  );
}

const ONLINE_AVAILABILITY: Record<string, string> = {
  in_stock: "In stock online",
  out_of_stock: "Out of stock online",
  discontinued: "Discontinued",
};

function OfferSummary({ offer }: { offer: Offer }) {
  return (
    <div className="offer-summary">
      <small>Chosen offer</small>
      <b>{offer.title}</b>
      <span className="badges">
        {freshnessBadge(offer)}
        {offer.sample && <span className="badge sample">Sample</span>}
        <span className="badge warn">Branch stock not established</span>
      </span>
      {offer.chosenOffer && (
        <p className={"notice" + (offer.price > offer.chosenOffer.price ? " warn" : "")} role="status">
          {offer.price === offer.chosenOffer.price
            ? "A newer price at this shop (" + day(offer.observed) + ") gives the same " + money(offer.price) + ", so the figures use its date."
            : "A newer price at this shop is " + money(offer.price) + " (" + day(offer.observed) + "). Figures use " +
              money(offer.price) + ", not the " + money(offer.chosenOffer.price) + " you chose (" +
              day(offer.chosenOffer.observed) + ")."}
        </p>
      )}
      <dl>
        <dt>Offer price</dt>
        <dd>
          {money(offer.price)}
          {offer.regularPrice ? " (regular " + money(offer.regularPrice) + ")" : ""}
        </dd>
        <dt>Source</dt>
        <dd>
          {offer.url ? (
            <a href={offer.url} target="_blank" rel="noreferrer noopener">
              {offer.source}
            </a>
          ) : (
            offer.source
          )}
        </dd>
        <dt>Licence</dt>
        <dd>{offer.licence || "not recorded"}</dd>
        <dt>Retailer</dt>
        <dd>
          {offer.retailer || "unknown"}
          {offer.location ? " · " + offer.location : ""}
        </dd>
        <dt>Observed</dt>
        <dd>
          {dateTime(offer.observed)}
          {offer.ageDays !== null && offer.ageDays >= 0 ? " (" + daysAgo(offer.ageDays) + ")" : ""}
        </dd>
        <dt>Imported</dt>
        <dd>{dateTime(offer.imported)}</dd>
        <dt>Barcode</dt>
        <dd>{barcodeText(offer.barcode)}</dd>
        <dt>Variant</dt>
        <dd>
          {attributesText(offer, offer.attributeSource)}
          {!offer.attributeSource && !offer.condition && " (retailers sell new stock, so new is assumed)"}
        </dd>
        {offer.promotion && (
          <>
            <dt>Promotion</dt>
            <dd>{offer.promotion}</dd>
          </>
        )}
        {offer.availability && (
          <>
            <dt>Online availability in the source</dt>
            <dd>
              {ONLINE_AVAILABILITY[offer.availability] ?? offer.availability}, as the source
              claims online. It says nothing about branch stock, which only a branch check
              confirms
            </dd>
          </>
        )}
      </dl>
      <p className="muted">{offer.stockNote}</p>
    </div>
  );
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// "a, b and c" for short lists of plain labels.
const listText = (items: string[]) =>
  items.length <= 1 ? items.join("") : items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
// Costs whose blank the figures leave out (server/estimate.mjs REQUIRED_INPUTS).
const MONEY_LABELS: Record<string, string> = {
  postage: "parcel cost",
  packaging: "packaging cost",
  journeyCost: "return journey cost",
};

/** Resale competition in words; an unknown count says so and why. */
function CompetitionLine({ competition: c }: { competition: Competition }) {
  if (c.activeListings === null)
    return (
      <p className="warn">
        Competition not known. {c.note || "The competing listings on record are too old to count"}.
        Without a current count no buy alert can be sent.
      </p>
    );
  if (c.activeListings === 0 && c.competingListings === null)
    return (
      <p className="warn">
        Competition not known: no competing listings are recorded and no asking-price lookup for this
        barcode is on record, so nobody may have looked. Run an eBay asking-price lookup (see Sources)
        before relying on it.
      </p>
    );
  return (
    <p>
      {plural(c.activeListings, "active listing")} from {plural(c.sellers ?? 0, "seller")}
      {c.activeListings === 0 && c.lookup ? " (an asking-price lookup on " + dateTime(c.lookup.fetched) + " found none)" : ""}
      {c.lowestAsking !== null &&
        " · lowest asking " +
          money(c.lowestAsking) +
          (c.lowestAskingIncludesShipping ? " including shipping" : " excluding unknown shipping")}
      {c.note ? ". " + c.note : ""}
    </p>
  );
}

/** When the cash comes back, from the Goals payout model and the sales rate. */
function PayoutPanel({ payout: p }: { payout: Payout }) {
  const g = p.goals;
  const status = p.timing.status === "late" ? "warn" : p.timing.status === "on time" ? "ok" : "";
  const units = p.units ?? 1;
  const cashDate = p.cashDate ?? p.cashNeededBy;
  const last = units === 1 ? "Payout" : "Payout of the last of " + units + " units";
  let headline: string;
  if (!p.date) headline = "Payout date unknown. " + p.note;
  else if (cashDate && p.timing.status === "late")
    headline =
      last + " expected " + dateTime(p.date) + ", " + plural(p.timing.daysLate ?? 0, "day") +
      " after you need the cash (" + dateTime(cashDate) + ").";
  else if (cashDate)
    headline = last + " expected " + dateTime(p.date) + ", on or before " + dateTime(cashDate) + ", when you need the cash.";
  else
    headline =
      last + " expected " + dateTime(p.date) +
      (p.days === null ? "." : p.days <= 0 ? ", today." : ", in about " + plural(p.days, "day") + ".");
  return (
    <div className="payout">
      <h3>Time until payment</h3>
      <p className={status}>{headline}</p>
      {cashDate && p.unitsByCashDate !== undefined && p.unitsByCashDate !== null && units > 1 && (
        <p className={p.unitsByCashDate < units ? "warn" : "ok"}>
          {p.unitsByCashDate} of {units} units expected to have paid out by {dateTime(cashDate)}.
        </p>
      )}
      <p className="muted">
        {p.date &&
          (units === 1 ? "Assumes a sale by " : "Assumes the last unit sells by ") +
            dateTime(p.sold) + ", posting on " + dateTime(p.dispatch) + ", delivery by " +
            dateTime(p.delivered) + " and payout on " + dateTime(p.date) + ". "}
        The trip is assumed to be today ({dateTime(p.start)}) and each unit listed the same day, with{" "}
        {g.daysToSell === null
          ? "days to sell unknown"
          : plural(g.daysToSell, "day") + " to sell one unit from the confirmed sales"}
        {units > 1 && g.daysToSellAll != null
          ? " and " + plural(g.daysToSellAll, "day") + " for " + (units === 2 ? "both units" : "all " + units + " units") + " at " + g.salesPerWeek + " confirmed sales a week"
          : ""}
        , posting on{" "}
        {g.dispatchDays.length ? g.dispatchDays.map((d) => WEEKDAYS[d]).join(", ") : "no days"},{" "}
        {plural(g.deliveryDays, "day")} for delivery and {plural(g.payoutDelayDays, "day")} until
        the marketplace pays out ({g.saved ? "your Goals" : "Goals defaults"}).{" "}
        <a href="#Goals">Change these in Goals</a>.
      </p>
    </div>
  );
}

/** Access needs as the Planner labels them (server/catalog.mjs accessNeeds). */
function AccessLabels({ needs }: { needs: AccessNeed[] }) {
  return (
    <span className="badges access-needs">
      {needs.map((n) => (
        <span
          key={n.id}
          className={"badge access" + (n.id === "widely-accessible" ? " open" : "")}
          title={n.detail}
        >
          {n.label}
          <span className="sr-only">: {n.detail}</span>
        </span>
      ))}
    </span>
  );
}

// What has changed on the shelf since the check, as the bounty card counts
// it: a member's newer stock report, and units bought through bounties.
function shelfText(shelf: Shelf | undefined) {
  if (!shelf || shelf.seen === null || shelf.at === null) return "";
  const what = shelf.source === "stock report" ? "report" : "check";
  const report =
    shelf.source === "stock report"
      ? "; a member's stock report at " + dateTime(shelf.at) + " saw " + shelf.seen +
        (shelf.report?.verified === "accurate" ? "" : " (not verified yet)")
      : "";
  const bought =
    shelf.boughtSince > 0
      ? ". Members have bought " + shelf.boughtSince + " through bounties since this " + what + ", so about " +
        shelf.units + " " + (shelf.units === 1 ? "is" : "are") + " left of the " + shelf.seen + " seen"
      : "";
  return report + bought;
}

/** When the price and stock were last checked, and the main uncertainty. */
function CheckedLine({ estimate }: { estimate: Estimate }) {
  const c = estimate.checked;
  if (!c && !estimate.mainUncertainty) return null;
  const age = estimate.offer.ageDays;
  return (
    <p className="checked-line">
      {c && (
        <>
          <b className="inline">Price checked:</b>{" "}
          {c.price ? dateTime(c.price) + (age !== null && age >= 0 ? " (" + daysAgo(age) + ")" : "") : "never"}
          . <b className="inline">Stock checked:</b>{" "}
          {c.stock
            ? dateTime(c.stock) + (c.locality ? " in " + c.locality : "")
            : c.locality
              ? "no usable check in " + c.locality + " from the last 2 days"
              : "not known, because no locality is entered"}
          {shelfText(estimate.stock.shelf)}
          .{" "}
        </>
      )}
      {estimate.mainUncertainty && (
        <>
          <b className="inline">Main uncertainty:</b> {estimate.mainUncertainty}.
        </>
      )}
    </p>
  );
}

function Result({ estimate, stale }: { estimate: Estimate; stale: boolean }) {
  const e = estimate.economics;
  const s = estimate.sample;
  const failing = estimate.alert.checks.filter((c) => !c.ok).length;
  const defaulted = new Set(estimate.inputs?.defaulted ?? []);
  const journey = estimate.journey ?? {
    known: true,
    missing: [],
    costKnown: true,
    minutesKnown: true,
  };
  const missing = estimate.missingInputs ?? [];
  // Costs left blank: the figures count them as nothing, so they say so.
  const leftOut = Object.keys(MONEY_LABELS)
    .filter((k) => defaulted.has(k))
    .map((k) => MONEY_LABELS[k]);
  const leftOutText = leftOut.length ? " leaving out the " + listText(leftOut) + ", not entered" : "";
  // Figures that rest on a value left blank say so, so they never sit
  // beside a check that calls the value unknown without explanation.
  const notEntered = () => "not entered, so left out of these figures";
  const category = estimate.category;
  return (
    <section className={"result" + (stale ? " stale" : "")} aria-live="polite" aria-busy={stale}>
      <small>6. Estimate</small>
      {stale && (
        <p className="notice" role="status">
          Updating for your latest changes. The figures below are for your previous inputs.
        </p>
      )}
      {estimate.access && <AccessLabels needs={estimate.access.needs} />}
      <CheckedLine estimate={estimate} />
      {missing.length > 0 && (
        <p className="notice warn">
          Not entered: {listText(missing)}. A blank is never counted as zero, so profit and
          earnings per hour cannot be judged and no buy alert can be sent. Enter 0 only if it
          truly costs nothing or takes no time.
        </p>
      )}
      <TierCard
        opportunity={estimate.opportunity}
        rules={estimate.thresholds.rules}
        leftOut={leftOut}
        demand={estimate.demand ?? null}
      />
      {!e && (
        <p className="notice">
          {estimate.match === "research"
            ? "No confirmed exact sale yet. Fill in any attributes the source left blank above, then tick the sales you have checked are the exact variant. A sale of a similar product never enters the sample."
            : "No matching completed sales. There is no evidence of what buyers pay, so no estimate is shown."}
        </p>
      )}
      {e && (
        <>
          <p className="muted">
            Based on {s.count} confirmed sale{s.count === 1 ? "" : "s"} from{" "}
            {s.independent} independent seller{s.independent === 1 ? "" : "s"}
            {s.oldest ? ", sold " + between(s) : ""}.
            {s.withoutSeller ? " " + noSellerNote(s.withoutSeller) + "." : ""} Lower median
            sale {cash(s.lowerMedian)} including buyer postage. Stock costed at{" "}
            {money(estimate.unitCost)} per unit
            {category ? " under the " + category.name.toLowerCase() + " rules" : ""}.
          </p>
          <dl className="figures">
            <dt>Cash required before payout</dt>
            <dd>
              <b>{money(e.cashRequired)}</b>
              {leftOut.length ? " plus the " + listText(leftOut) + ", not entered" : ""}
            </dd>
            <dt>Stock ({e.units} units)</dt>
            <dd>{money(e.costs.stock)}</dd>
            <dt>Packaging</dt>
            <dd className={defaulted.has("packaging") ? "warn" : ""}>
              {defaulted.has("packaging") ? notEntered() : money(e.costs.packaging)}
            </dd>
            <dt>Parcel costs</dt>
            <dd className={e.costs.postage > 0 ? "" : "warn"}>
              {e.costs.postage > 0
                ? money(e.costs.postage)
                : defaulted.has("postage")
                  ? notEntered()
                  : money(0) + ", treated as unknown: enter what you pay to post one unit"}
            </dd>
            <dt>Marketplace fees</dt>
            <dd>{money(e.costs.fees)}</dd>
            <dt>Returns allowance</dt>
            <dd>
              {money(e.costs.returns)}
              {category?.returnsRaised
                ? " (" + percent(category.returnsRate) + ", the " + category.name.toLowerCase() + " minimum)"
                : ""}
            </dd>
            <dt>Travel</dt>
            <dd className={journey.costKnown ? "" : "warn"}>
              {journey.costKnown
                ? money(e.costs.travel) + " (" + money(e.journeyPerUnit) + " per unit)"
                : notEntered()}
            </dd>
            <dt>Potential proceeds (not realised)</dt>
            <dd>{money(e.proceeds)}</dd>
            <dt>Contribution</dt>
            <dd className={!leftOut.length && e.contribution > 0 ? "ok" : "warn"}>
              <b>{money(e.contribution)}</b>
              {leftOutText}
            </dd>
            <dt>Active hours</dt>
            <dd>
              {hours(e.activeMinutes)}
              {!journey.minutesKnown ? ", leaving out the journey, which is not entered" : ""}
              {defaulted.has("handlingMinutes") ? ", leaving out handling, which is not entered" : ""}
            </dd>
            <dt>Earnings per active hour</dt>
            <dd className={missing.length ? "warn" : ""}>
              {missing.length
                ? "not known until the " + listText(missing) + " " + (missing.length === 1 ? "is" : "are") + " entered"
                : e.hourly === null
                  ? "not known"
                  : money(e.hourly)}
            </dd>
            <dt>Loss if nothing sells</dt>
            <dd className="warn">
              {money(e.unsoldLoss)}
              {leftOut.length ? " plus the " + listText(leftOut) : ""}
            </dd>
            <dt>Break-even sale price</dt>
            <dd>
              {cash(e.breakEvenSale)}
              {leftOut.length ? " before the " + listText(leftOut) : ""}
            </dd>
            <dt>Sample size</dt>
            <dd>{s.count}</dd>
            <dt>Independent sellers</dt>
            <dd>
              {s.independent}
              {s.withoutSeller ? <span className="note warn">{noSellerNote(s.withoutSeller)}</span> : null}
            </dd>
            <dt>Days to sell</dt>
            <dd>{s.daysToSell === null ? "not known" : s.daysToSell + " days for one unit"}</dd>
          </dl>
        </>
      )}
      {estimate.payout && <PayoutPanel payout={estimate.payout} />}
      <h3>Buy-alert checks</h3>
      <p className={estimate.alert.eligible ? "ok" : "warn"}>
        {estimate.alert.eligible
          ? "Every check passes. A bounty built from this estimate could send alerts."
          : failing + " of " + estimate.alert.checks.length + " checks fail, so this cannot become a buy alert."}
      </p>
      <ul className="checks">
        {estimate.alert.checks.map((c) => (
          <li key={c.id} className={c.ok ? "pass" : ""}>
            {c.detail}
          </li>
        ))}
      </ul>
      <p className="muted">Display: {estimate.permission.basis}.</p>
      {estimate.warnings.length > 0 && (
        <ul className="warnings">
          {estimate.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {estimate.assumptions.length > 0 && (
        <details>
          <summary>Assumptions</summary>
          <ul>
            {estimate.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </details>
      )}
      {s.excluded.length > 0 && (
        <details>
          <summary>Excluded from the sold sample ({s.excluded.length})</summary>
          <ul className="reasons">
            {s.excluded.map((x) => (
              <li key={x.row.provider + "|" + x.row.source_id}>
                {x.row.title} ({x.row.kind}, {money(x.row.price)}): {x.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

const METHODS: [string, string][] = [
  ["in_store", "In store"],
  ["phone", "Phoned the branch"],
  ["retailer_branch_page", "Retailer's branch stock page"],
];
// Shop and place names compare without case or extra spaces, as the server
// compares them.
const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim().replace(/\s+/g, " ").toLowerCase() === (b ?? "").trim().replace(/\s+/g, " ").toLowerCase();

// What the server says back about a saved check (server/audit.mjs
// recordCheck): the stored row, plus, when known, whether the time was
// stamped by the server and a warning that a newer check or report still
// decides the shelf.
type SavedCheck = StockCheck & { checkedAtStamped?: boolean; olderWarning?: string | null };

/**
 * Records a branch check. "Checked at" starts empty: a blank time is the
 * time the server saves it, so a check made just now is never back-dated to
 * when the page was opened. A time typed in is for a check made earlier;
 * when it is older than the newest check or member's stock report for the
 * same branch the form says so before saving, because the newer one still
 * decides what the bounty and the estimate show. After each save the time,
 * units and note are cleared again.
 */
function StockCheckForm({
  offer,
  locality,
  latest,
  shelf,
  estimateLocality,
  onSaved,
}: {
  offer: Offer;
  locality: string;
  latest: StockCheck | null;
  // The shelf the estimate worked out for its own retailer and locality.
  shelf: Shelf | null;
  estimateLocality: string | null;
  onSaved: () => void;
}) {
  const [checks, setChecks] = useState<StockCheck[]>([]);
  const [message, setMessage] = useState<{ text: string; warn: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [retailer, setRetailer] = useState(offer.retailer || "");
  // null until edited: the form follows the estimate's locality until then.
  const [place, setPlace] = useState<string | null>(null);
  const [method, setMethod] = useState("in_store");
  const [inStock, setInStock] = useState("yes");
  const [unitsSeen, setUnitsSeen] = useState("");
  const [checkedAt, setCheckedAt] = useState("");
  const [note, setNote] = useState("");
  const branch = place ?? locality;
  useEffect(() => {
    let active = true;
    api<{ rows: StockCheck[] }>("research/checks?barcode=" + encodeURIComponent(offer.gtin))
      .then((d) => active && setChecks(d.rows))
      .catch((e: Error) => active && setMessage({ text: e.message, warn: true }));
    return () => {
      active = false;
    };
  }, [offer.gtin, version]);

  // The newest check or member's stock report for the branch in the form.
  // Reports are known for the estimate's own branch only.
  const newestCheck = checks
    .filter((c) => sameText(c.retailer, retailer) && sameText(c.locality, branch))
    .reduce<StockCheck | null>((a, c) => (!a || Date.parse(c.checked_at) > Date.parse(a.checked_at) ? c : a), null);
  const report =
    shelf?.report && sameText(retailer, offer.retailer) && sameText(branch, estimateLocality) ? shelf.report : null;
  const newest =
    report && (!newestCheck || Date.parse(report.at) > Date.parse(newestCheck.checked_at))
      ? { kind: "a member's stock report", at: report.at }
      : newestCheck
        ? { kind: "a branch check", at: newestCheck.checked_at }
        : null;
  const typed = checkedAt ? Date.parse(new Date(checkedAt).toISOString()) : NaN;
  const older = newest !== null && Number.isFinite(typed) && typed < Date.parse(newest.at);

  return (
    <fieldset className="stock-check">
      <legend>7. Branch availability check</legend>
      <p className="muted">
        Branch stock is confirmed only by a check you record here from the last
        two days, at this retailer and in the locality of the estimate
        {locality.trim() ? " (" + locality.trim() + ")" : ", which is not entered yet"}.
        Feeds, catalogues and past observations never confirm it.
        {latest
          ? " Latest usable check: " +
            (latest.in_stock ? "in stock" : "none found") +
            " at " +
            latest.retailer +
            ", " +
            latest.locality +
            " on " +
            dateTime(latest.checked_at) +
            shelfText(shelf ?? undefined) +
            "."
          : " No usable check yet."}
      </p>
      <form
        onSubmit={async (ev) => {
          ev.preventDefault();
          const units = unitsSeen.trim();
          setBusy(true);
          setMessage(null);
          try {
            const saved = await api<SavedCheck>("research/checks", {
              barcode: offer.gtin,
              retailer: retailer.trim(),
              locality: branch.trim(),
              method,
              inStock: inStock === "yes",
              ...(units ? { unitsSeen: Math.round(Number(units)) } : {}),
              // Blank: the server records the time it saves the check.
              ...(checkedAt ? { checkedAt: new Date(checkedAt).toISOString() } : {}),
              ...(note.trim() ? { note: note.trim() } : {}),
            });
            setMessage(
              saved?.olderWarning
                ? { text: "Check saved. " + saved.olderWarning, warn: true }
                : {
                    text:
                      "Check saved for " +
                      dateTime(saved?.checked_at) +
                      (checkedAt ? "." : ", the time you saved it."),
                    warn: false,
                  },
            );
            setCheckedAt("");
            setUnitsSeen("");
            setNote("");
            setVersion((n) => n + 1);
            onSaved();
          } catch (err) {
            setMessage({ text: (err as Error).message, warn: true });
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="grid2">
          <label>
            Retailer
            <input
              name="retailer"
              required
              value={retailer}
              maxLength={120}
              onChange={(ev) => setRetailer(ev.target.value)}
            />
          </label>
          <label>
            Locality
            <input
              name="locality"
              required
              value={branch}
              maxLength={120}
              onChange={(ev) => setPlace(ev.target.value)}
            />
          </label>
          <label>
            How you checked
            <select name="method" value={method} onChange={(ev) => setMethod(ev.target.value)}>
              {METHODS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label>
            Result
            <select name="inStock" value={inStock} onChange={(ev) => setInStock(ev.target.value)}>
              <option value="yes">In stock</option>
              <option value="no">None found</option>
            </select>
          </label>
          <label>
            Units seen (optional)
            <input
              name="unitsSeen"
              type="number"
              min={0}
              max={10000}
              step={1}
              value={unitsSeen}
              onChange={(ev) => setUnitsSeen(ev.target.value)}
            />
          </label>
          <label>
            Checked at (your local time)
            <input
              name="checkedAt"
              type="datetime-local"
              value={checkedAt}
              aria-invalid={older}
              aria-describedby="checked-at-hint"
              onChange={(ev) => setCheckedAt(ev.target.value)}
            />
            <span className={older ? "warn" : "muted"} id="checked-at-hint">
              {older && newest
                ? "This check is older than " + newest.kind + " at " + dateTime(newest.at) +
                  " and will not change the bounty or this estimate: the newer one still decides the shelf. Clear the time if you checked just now."
                : "Leave blank if you checked just now: the time you save it is recorded. Enter a time only for a check made earlier."}
            </span>
          </label>
        </div>
        <label>
          Note (optional)
          <input name="note" maxLength={500} value={note} onChange={(ev) => setNote(ev.target.value)} />
        </label>
        <button disabled={busy}>{older ? "Record this older check anyway" : "Record check"}</button>
      </form>
      {message && (
        <p role="status" className={message.warn ? "warn" : ""}>
          {message.text}
        </p>
      )}
      {checks.length > 0 && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Checked</th>
                <th>Retailer</th>
                <th>Locality</th>
                <th>Method</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.id}>
                  <td>{dateTime(c.checked_at)}</td>
                  <td>{c.retailer}</td>
                  <td>{c.locality}</td>
                  <td>{METHODS.find(([v]) => v === c.method)?.[1] || c.method}</td>
                  <td>
                    {c.in_stock ? "In stock" : "None found"}
                    {c.units_seen !== null ? " (" + c.units_seen + " seen)" : ""} · #{c.id}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </fieldset>
  );
}
