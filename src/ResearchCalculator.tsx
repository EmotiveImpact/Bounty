import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
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
  suggestedCategory?: { id: CategoryId; basis: string };
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
type Competition = {
  activeListings: number;
  sellers: number;
  lowestAsking: number | null;
  lowestAskingIncludesShipping: boolean | null;
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
    dispatchDays: number[];
    deliveryDays: number;
    payoutDelayDays: number;
    saved: boolean;
  };
  cashNeededBy: string | null;
  cashNeededDays: number | null;
  timing: { status: "on time" | "late" | "unknown"; daysLate: number | null; note: string };
};
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
  stock: { check: StockCheck | null; confirmed: boolean; availability: string };
  permission: { permitted: boolean; basis: string };
  unitCost: number;
  cashNeededDays: number | null;
  // Added in later rounds; optional so an older server still renders.
  sampleData?: boolean;
  payout?: Payout;
  prices?: Prices;
  category?: {
    id: CategoryId;
    name: string;
    chosen: "request" | "suggested";
    suggestion: { id: CategoryId; basis: string };
    rule: CategoryRule;
    returnsRate: number;
    returnsRaised: boolean;
    failures: string[];
  };
  journey?: { known: boolean; missing: string[]; costKnown: boolean; minutesKnown: boolean };
  offerAttributes?: AttributeResult;
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
export const isSampleRow = (row: {
  provider?: string | null;
  licence?: string | null;
  source_id?: string | null;
}) =>
  /\b(sample|fixture|demo)\b/i.test(row.provider || "") ||
  /\b(sample|fixture|demo)\b/i.test(row.licence || "") ||
  /^(sample|fixture|demo)\b/i.test(row.source_id || "");
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

function freshnessBadge(offer: Offer) {
  if (offer.freshness === "fresh")
    return <span className="badge ok">Observed {offer.ageDays} d ago</span>;
  if (offer.freshness === "expired")
    return <span className="badge warn">Expired · {offer.ageDays} d old</span>;
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
    packagingChecked: false,
    bestBefore: "",
  };
}
type FieldKind = "pounds" | "percent" | "minutes" | "count" | "kg";
const FIELDS: [keyof Inputs, string, FieldKind, string?][] = [
  ["units", "Units to buy", "count", "A first purchase is a small trial batch"],
  ["weightKg", "Unit weight (kg)", "kg", "One unit as posted. Unknown weight is rejected"],
  ["postage", "Parcel cost per unit sold (£)", "pounds", "What you pay to post one unit"],
  ["packaging", "Packaging per unit (£)", "pounds"],
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
  ["handlingMinutes", "Handling minutes per unit", "minutes", "Listing, packing and dispatch"],
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
  const food = (inputs.category || offer.suggestedCategory?.id) === "food";
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

export function ResearchCalculator({
  onAuditDraft,
}: {
  onAuditDraft?: (draft: AuditDraft) => void;
}) {
  const [query, setQuery] = useState("");
  const [offers, setOffers] = useState<{ rows: Offer[]; total: number }>({
    rows: [],
    total: 0,
  });
  const [offerError, setOfferError] = useState("");
  const [selected, setSelected] = useState<Offer | null>(null);
  const [candidates, setCandidates] = useState<Candidates | null>(null);
  const [candidateError, setCandidateError] = useState("");
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [attrs, setAttrs] = useState<AttrDraft>(NO_ATTRS);
  const [inputs, setInputs] = useState<Inputs>(initialInputs);
  const [stricter, setStricter] = useState<Stricter>(loadStricter);
  const [agreed, setAgreed] = useState<Agreed | null>(null);
  const [goalsCashDate, setGoalsCashDate] = useState<string | null>(null);
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

  // A cash date saved in Goals fills an empty cash date here.
  useEffect(() => {
    let active = true;
    api<{ cashNeededBy: string | null }>("goals")
      .then((goals) => {
        const date = goals?.cashNeededBy;
        if (!active || !date || date < localToday()) return;
        setGoalsCashDate(date);
        setInputs((current) => (current.cashNeededBy ? current : { ...current, cashNeededBy: date }));
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

  // A new offer starts from a clean slate.
  useEffect(() => {
    setCandidates(null);
    setCandidateError("");
    setResult(null);
    setConfirmed([]);
    setAttrs(NO_ATTRS);
    setNotice("");
  }, [selected]);

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
      selected ? buildRequest(selected, confirmed, inputs, stricter, offerAttributes) : null,
    [selected, confirmed, inputs, stricter, offerAttributes],
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

  async function trackInLedger() {
    const e = current?.economics;
    if (!current || !e) return;
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

  const categoryId: CategoryId = inputs.category || selected?.suggestedCategory?.id || "general";

  return (
    <article className="research-calculator">
      <small>RESEARCH DESK / TRIP ESTIMATE</small>
      <h2>Research a trip from real evidence</h2>
      <p>
        Choose a barcoded retail offer, confirm the completed sales that are the
        exact same variant, then enter your costs and time. Asking prices are
        shown as competition and never used as sale prices. This estimate does
        not confirm stock and does not send an alert.
      </p>

      <fieldset>
        <legend>1. Acquisition offer</legend>
        <label>
          Search offers by title or barcode
          <input value={query} onChange={(ev) => setQuery(ev.target.value)} />
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
                  Barcode {o.barcode} · Source date {o.observed || "unknown"} ·{" "}
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
                <div className={"evidence-row status-" + c.status} key={k}>
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
                      Sold {c.row.observed || "date unknown"}
                      {c.row.listed ? " · listed " + c.row.listed : ""} · seller{" "}
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
              <p>
                {candidates.competition.activeListings} active listing
                {candidates.competition.activeListings === 1 ? "" : "s"} from{" "}
                {candidates.competition.sellers} seller
                {candidates.competition.sellers === 1 ? "" : "s"}
                {candidates.competition.lowestAsking !== null &&
                  " · lowest asking " +
                    money(candidates.competition.lowestAsking) +
                    (candidates.competition.lowestAskingIncludesShipping
                      ? " including shipping"
                      : " excluding unknown shipping")}
              </p>
              {candidates.listings.map((c) => (
                <div className="evidence-row" key={key(c.row.provider, c.row.source_id)}>
                  <div>
                    <span className="badge">Asking price</span>
                    <span className="badge">{LISTING_LABEL[c.status]}</span>
                    <b>{c.row.title}</b>
                    <small>
                      Seller {c.row.seller || "unknown"} · {c.row.provider} · seen{" "}
                      {c.row.observed || dateTime(c.row.imported)}
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
                          {c.row.provider} · {c.row.kind} · {c.row.observed || "date unknown"}
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
                    aria-invalid={
                      (field === "journeyCost" || field === "journeyMinutes") &&
                      String(inputs[field]).trim() === ""
                    }
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
            rules={agreed?.categories ?? null}
            packagingChecked={inputs.packagingChecked}
            bestBefore={inputs.bestBefore}
            onChange={set}
            failures={
              estimate?.category && estimate.category.id === categoryId
                ? estimate.category.failures
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
              onSaved={() => setRefresh((n) => n + 1)}
            />
          )}

          {estimate && (
            <div className="actions">
              <button type="button" onClick={trackInLedger} disabled={!current?.economics}>
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

/** Category choice, the rules it brings and any that fail. */
function CategoryPanel({
  suggestion,
  chosen,
  id,
  rules,
  packagingChecked,
  bestBefore,
  onChange,
  failures,
}: {
  suggestion: { id: CategoryId; basis: string } | null;
  chosen: "" | CategoryId;
  id: CategoryId;
  rules: Record<CategoryId, CategoryRule> | null;
  packagingChecked: boolean;
  bestBefore: string;
  onChange: (field: keyof Inputs, value: string | boolean) => void;
  failures: string[] | null;
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
              ? "Chosen by you"
              : (suggestion?.basis ?? "No clear category in the title") + ". Change it if that is wrong"}
          </span>
        </label>
      </div>
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

const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : "date unknown");
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
      <small>THREE PRICES, KEPT APART</small>
      <div className="price-columns">
        <div className="price-col">
          <h3>{prices.claimed?.kind === "rrp" ? "Recommended retail price" : "Claimed previous price"}</h3>
          <span className="badge">{prices.claimed?.evidenceClass ?? "Retail offer"}</span>
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
        <div className="price-col">
          <h3>Price observed over time</h3>
          <span className="badge">{o.evidenceClass}</span>
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
        <div className="price-col">
          <h3>Completed resale prices</h3>
          <span className="badge">{s.evidenceClass}</span>
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
  beforeTravel,
}: {
  opportunity: Opportunity;
  rules: Rules;
  beforeTravel: boolean;
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
        <dd className={meets(o.unitProfit === null ? null : o.unitProfit >= rules.minUnitProfit)}>
          {o.unitProfit === null ? "not known" : money(o.unitProfit)}
          {beforeTravel && o.unitProfit !== null ? " before travel, which is not entered" : ""} (needs at
          least {money(rules.minUnitProfit)})
        </dd>
        <dt>Return on purchase price</dt>
        <dd className={meets(o.returnOnCost === null ? null : o.returnOnCost >= rules.minReturn)}>
          {o.returnOnCost === null ? "not known" : percent(o.returnOnCost)} (needs at least{" "}
          {percent(rules.minReturn)})
        </dd>
        <dt>Unit weight</dt>
        <dd className={meets(o.weightKg === null ? false : o.weightKg < rules.maxWeightKg)}>
          {o.weightKg === null ? "not entered" : o.weightKg + " kg"} (must be under{" "}
          {rules.maxWeightKg} kg)
        </dd>
        <dt>Confirmed sales per week</dt>
        <dd>{o.salesPerWeek === null ? "not known" : o.salesPerWeek}</dd>
        <dt>Resale weeks of supply</dt>
        <dd>
          {o.resaleWeeksOfSupply === null
            ? "not known"
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
      <small>CHOSEN OFFER</small>
      <b>{offer.title}</b>
      <span className="badges">
        {freshnessBadge(offer)}
        {offer.sample && <span className="badge sample">Sample</span>}
        <span className="badge warn">Branch stock not established</span>
      </span>
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
          {offer.observed || "unknown"}
          {offer.ageDays !== null
            ? " (" + offer.ageDays + (offer.ageDays === 1 ? " day" : " days") + " ago)"
            : ""}
        </dd>
        <dt>Imported</dt>
        <dd>{dateTime(offer.imported)}</dd>
        <dt>Barcode</dt>
        <dd>{offer.barcode}</dd>
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

/** When the cash comes back, from the Goals payout model. */
function PayoutPanel({ payout: p }: { payout: Payout }) {
  const g = p.goals;
  const status = p.timing.status === "late" ? "warn" : p.timing.status === "on time" ? "ok" : "";
  return (
    <div className="payout">
      <h3>Time until payment</h3>
      <p className={status}>
        {p.cashNeededBy || p.cashNeededDays !== null
          ? p.timing.note
          : p.date
            ? "Payout expected " +
              p.date +
              (p.days === null ? "." : p.days <= 0 ? ", today." : ", in about " + plural(p.days, "day") + ".")
            : "Payout date unknown."}
      </p>
      <p className="muted">
        {p.note} Assumes the trip is today ({p.start}) and each unit is listed the same day,
        with{" "}
        {g.daysToSell === null
          ? "days to sell unknown"
          : plural(g.daysToSell, "day") + " to sell from the confirmed sales"}
        , posting on{" "}
        {g.dispatchDays.length ? g.dispatchDays.map((d) => WEEKDAYS[d]).join(", ") : "no days"},{" "}
        {plural(g.deliveryDays, "day")} for delivery and {plural(g.payoutDelayDays, "day")} until
        the marketplace pays out ({g.saved ? "your Goals" : "Goals defaults"}).{" "}
        <a href="#Goals">Change these in Goals</a>.
      </p>
    </div>
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
  // Figures that rest on a value left blank say so, so they never sit
  // beside a check that calls the value unknown without explanation.
  const notEntered = (pence: number) => "not entered (counted as " + money(pence) + ")";
  const category = estimate.category;
  return (
    <section className={"result" + (stale ? " stale" : "")} aria-live="polite" aria-busy={stale}>
      <small>6. ESTIMATE</small>
      {stale && (
        <p className="notice" role="status">
          Updating for your latest changes. The figures below are for your previous inputs.
        </p>
      )}
      <TierCard
        opportunity={estimate.opportunity}
        rules={estimate.thresholds.rules}
        beforeTravel={!journey.costKnown}
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
            {s.oldest ? ", sold " + s.oldest + " to " + s.newest : ""}.
            {s.withoutSeller ? " " + noSellerNote(s.withoutSeller) + "." : ""} Lower median
            sale {cash(s.lowerMedian)} including buyer postage. Stock costed at{" "}
            {money(estimate.unitCost)} per unit.
          </p>
          <dl className="figures">
            <dt>Cash required before payout</dt>
            <dd>
              <b>{money(e.cashRequired)}</b>
              {!journey.costKnown ? " plus travel, which is not entered" : ""}
            </dd>
            <dt>Stock ({e.units} units)</dt>
            <dd>{money(e.costs.stock)}</dd>
            <dt>Packaging</dt>
            <dd>{defaulted.has("packaging") ? notEntered(e.costs.packaging) : money(e.costs.packaging)}</dd>
            <dt>Parcel costs</dt>
            <dd className={e.costs.postage > 0 ? "" : "warn"}>
              {e.costs.postage > 0
                ? money(e.costs.postage)
                : defaulted.has("postage")
                  ? notEntered(0)
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
                : notEntered(0)}
            </dd>
            <dt>Potential proceeds (not realised)</dt>
            <dd>{money(e.proceeds)}</dd>
            <dt>Contribution</dt>
            <dd className={journey.costKnown && e.contribution > 0 ? "ok" : "warn"}>
              <b>{money(e.contribution)}</b>
              {journey.costKnown ? "" : " before travel, which is not entered"}
            </dd>
            <dt>Active hours</dt>
            <dd>
              {hours(e.activeMinutes)}
              {journey.minutesKnown ? "" : ", leaving out the journey, which is not entered"}
            </dd>
            <dt>Earnings per active hour</dt>
            <dd className={journey.known ? "" : "warn"}>
              {!journey.known
                ? "not known until the journey cost and time are entered"
                : e.hourly === null
                  ? "not known"
                  : money(e.hourly)}
            </dd>
            <dt>Loss if nothing sells</dt>
            <dd className="warn">
              {money(e.unsoldLoss)}
              {journey.costKnown ? "" : " plus travel"}
            </dd>
            <dt>Break-even sale price</dt>
            <dd>
              {cash(e.breakEvenSale)}
              {journey.costKnown ? "" : " before travel"}
            </dd>
            <dt>Sample size</dt>
            <dd>{s.count}</dd>
            <dt>Independent sellers</dt>
            <dd>
              {s.independent}
              {s.withoutSeller ? <span className="note warn">{noSellerNote(s.withoutSeller)}</span> : null}
            </dd>
            <dt>Days to sell</dt>
            <dd>{s.daysToSell === null ? "not known" : s.daysToSell + " days"}</dd>
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
const localNow = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

function StockCheckForm({
  offer,
  locality,
  latest,
  onSaved,
}: {
  offer: Offer;
  locality: string;
  latest: StockCheck | null;
  onSaved: () => void;
}) {
  const [checks, setChecks] = useState<StockCheck[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    api<{ rows: StockCheck[] }>("research/checks?barcode=" + encodeURIComponent(offer.gtin))
      .then((d) => active && setChecks(d.rows))
      .catch((e: Error) => active && setMessage(e.message));
    return () => {
      active = false;
    };
  }, [offer.gtin, version]);
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
            " UTC."
          : " No usable check yet."}
      </p>
      <form
        onSubmit={async (ev) => {
          ev.preventDefault();
          const f = new FormData(ev.currentTarget);
          const units = String(f.get("unitsSeen") || "").trim();
          const at = String(f.get("checkedAt") || "");
          setBusy(true);
          setMessage("");
          try {
            await api("research/checks", {
              barcode: offer.gtin,
              retailer: String(f.get("retailer") || ""),
              locality: String(f.get("locality") || ""),
              method: String(f.get("method")),
              inStock: f.get("inStock") === "yes",
              ...(units ? { unitsSeen: Math.round(Number(units)) } : {}),
              ...(at ? { checkedAt: new Date(at).toISOString() } : {}),
              ...(String(f.get("note") || "").trim() ? { note: String(f.get("note")).trim() } : {}),
            });
            setMessage("Check saved.");
            setVersion((n) => n + 1);
            onSaved();
          } catch (err) {
            setMessage((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="grid2">
          <label>
            Retailer
            <input name="retailer" required defaultValue={offer.retailer || ""} maxLength={120} />
          </label>
          <label>
            Locality
            <input name="locality" required defaultValue={locality} maxLength={120} />
          </label>
          <label>
            How you checked
            <select name="method" defaultValue="in_store">
              {METHODS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label>
            Result
            <select name="inStock" defaultValue="yes">
              <option value="yes">In stock</option>
              <option value="no">None found</option>
            </select>
          </label>
          <label>
            Units seen (optional)
            <input name="unitsSeen" type="number" min={0} max={10000} step={1} />
          </label>
          <label>
            Checked at (your local time)
            <input name="checkedAt" type="datetime-local" defaultValue={localNow()} />
          </label>
        </div>
        <label>
          Note (optional)
          <input name="note" maxLength={500} />
        </label>
        <button disabled={busy}>Record check</button>
      </form>
      {message && <p role="status">{message}</p>}
      {checks.length > 0 && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Checked (UTC)</th>
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
