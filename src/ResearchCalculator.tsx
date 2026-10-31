import { useEffect, useMemo, useRef, useState } from "react";
import { api, dateTime, hours, loadProfile, money, percent, toPence } from "./api";
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
type RuleKey = "minUnitPrice" | "maxUnitPrice" | "maxWeightKg" | "minUnitProfit" | "minReturn" | "trialUnits";
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
type Estimate = {
  offer: Offer;
  sample: {
    used: EvidenceRow[];
    excluded: { row: EvidenceRow; reason: string }[];
    count: number;
    independent: number;
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
  assumptions: string[];
  warnings: string[];
};
type EstimateRequest = {
  offer: { provider: string; sourceId: string };
  sales: { provider: string; sourceId: string }[];
  units: number;
  costs: Record<string, number>;
  weightKg?: number;
  rules?: Partial<Record<RuleKey, number>>;
  hourlyFloor?: number;
  promotionEligible: boolean;
  cashNeededBy?: string;
  locality?: string;
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
export const attributesText = (row: {
  size: string | null;
  pack: string | number | null;
  model: string | null;
  condition: string | null;
}) =>
  [
    ["size", row.size],
    ["pack", row.pack],
    ["model", row.model],
    ["condition", row.condition],
  ]
    .map(([k, v]) => k + " " + (v === null || v === "" ? "not stated" : v))
    .join(" · ");

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
};
function initialInputs(): Inputs {
  const p = loadProfile();
  return {
    // A first purchase is a trial batch, so start small whatever the profile says.
    units: String(Math.min(3, Math.max(1, Math.round(p.quantity) || 1))),
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
    locality: p.area,
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
  ["journeyCost", "Return journey cost (£)", "pounds", "Fares, fuel, parking: shared across units"],
  ["journeyMinutes", "Journey minutes (return)", "minutes"],
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

// A member's own stricter buying thresholds, kept as form text.
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
const STRICTER_KEY = "bounty-stricter-thresholds";
function loadStricter(): Stricter {
  try {
    const saved = JSON.parse(localStorage.getItem(STRICTER_KEY) || "{}");
    const out = { ...NO_STRICTER };
    for (const [key] of STRICTER_FIELDS)
      if (typeof saved[key] === "string") out[key] = saved[key];
    return out;
  } catch {
    return { ...NO_STRICTER };
  }
}
function saveStricter(value: Stricter) {
  try {
    localStorage.setItem(STRICTER_KEY, JSON.stringify(value));
  } catch {
    /* storage unavailable: the thresholds last for this visit only */
  }
}
// Threshold value in form units, for placeholders and messages.
function ruleText(key: RuleKey, rules: Rules) {
  const v = rules[key];
  if (key === "minUnitPrice" || key === "maxUnitPrice" || key === "minUnitProfit") return money(v);
  if (key === "minReturn") return percent(v);
  if (key === "maxWeightKg") return v + " kg";
  return v + (v === 1 ? " unit" : " units");
}
function formValue(key: RuleKey, rules: Rules) {
  const v = rules[key];
  if (key === "minUnitPrice" || key === "maxUnitPrice" || key === "minUnitProfit")
    return (v / 100).toFixed(2);
  if (key === "minReturn") return String(Math.round(v * 1000) / 10);
  return String(v);
}

/** Builds the estimate request, or returns an error message. */
function buildRequest(
  offer: Offer,
  confirmed: string[],
  inputs: Inputs,
  stricter: Stricter,
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
  const rules: Partial<Record<RuleKey, number>> = {};
  for (const [key, label, kind] of STRICTER_FIELDS) {
    const value = readNumber(stricter[key], kind);
    if (Number.isNaN(value)) return label + " must be a number";
    if (value !== undefined) rules[key] = value;
  }
  const hourlyFloor = read("hourlyFloor", "pounds");
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
  };
}

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
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [inputs, setInputs] = useState<Inputs>(initialInputs);
  const [stricter, setStricter] = useState<Stricter>(loadStricter);
  const [agreed, setAgreed] = useState<{ rules: Rules; alertRules: AlertRules } | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
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

  // The agreed buying thresholds, so they can be shown before an estimate.
  useEffect(() => {
    let active = true;
    api<{ rules: Rules; alertRules: AlertRules }>("research/rules")
      .then((data) => active && setAgreed(data))
      .catch(() => {
        /* the estimate result carries the thresholds as well */
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => saveStricter(stricter), [stricter]);

  // Candidate evidence for the chosen offer.
  useEffect(() => {
    setCandidates(null);
    setEstimate(null);
    setConfirmed([]);
    setNotice("");
    if (!selected) return;
    let active = true;
    const params = new URLSearchParams({
      provider: selected.provider,
      sourceId: selected.sourceId,
    });
    api<Candidates>("research/candidates?" + params)
      .then((data) => active && setCandidates(data))
      .catch((e: Error) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [selected]);

  const request = useMemo(
    () => (selected ? buildRequest(selected, confirmed, inputs, stricter) : null),
    [selected, confirmed, inputs, stricter],
  );

  // Recalculate shortly after any change; ignore stale answers.
  useEffect(() => {
    if (!request) return;
    if (typeof request === "string") {
      setError(request);
      setEstimate(null);
      return;
    }
    const id = ++sequence.current;
    const timer = setTimeout(() => {
      api<Estimate>("research/estimate", request)
        .then((data) => {
          if (id !== sequence.current) return;
          setEstimate(data);
          setError("");
        })
        .catch((e: Error) => {
          if (id !== sequence.current) return;
          setEstimate(null);
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

  const e = estimate?.economics ?? null;
  const offer = estimate?.offer ?? selected;

  async function trackInLedger() {
    if (!estimate || !e || !offer) return;
    setNotice("");
    try {
      const saved = await api<{ id: number | string }>("ledger/trips", {
        label: (offer.title + (offer.retailer ? " at " + offer.retailer : "")).slice(0, 120),
        source: "research",
        kind: "resale",
        reference: offer.provider + ":" + offer.sourceId,
        predicted: {
          units: e.units,
          proceeds: e.proceeds,
          contribution: e.contribution,
          cashRequired: e.cashRequired,
          activeMinutes: e.activeMinutes,
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
    if (!offer || !request || typeof request === "string") return;
    try {
      localStorage.setItem(
        "bounty-draft",
        JSON.stringify({
          estimate: request,
          title: offer.title,
          retailer: offer.retailer,
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
    if (!estimate || !offer || !onAuditDraft) return;
    const postage = typeof request === "object" && request ? request.costs.postage : undefined;
    onAuditDraft({
      locality: inputs.locality.trim(),
      barcode: offer.gtin,
      title: offer.title,
      retailer: offer.retailer || "",
      offerProvider: offer.provider,
      offerSourceId: offer.sourceId,
      availabilityCheckId: estimate.stock.check?.id ?? null,
      promotion: offer.promotion,
      promotionEligible: offer.promotion ? (inputs.promotionEligible ? true : null) : true,
      shipping: postage && postage > 0 ? postage : null,
      daysToSell: estimate.sample.daysToSell,
      independentSales: estimate.sample.independent,
      displayPermitted: estimate.permission.permitted,
      matchDecision: estimate.match,
    });
    setNotice("Audit form filled from this estimate. Review it below before saving.");
  }

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
          <fieldset>
            <legend>2. Completed sales</legend>
            <p className="muted">
              Only an exact match (same barcode, size, pack, model and condition),
              sold within 90 days, can be confirmed. Tick it only after you have
              checked the listing yourself. Similar products need research and
              never enter the sample.
            </p>
            {!candidates && !error && <p className="muted">Loading evidence…</p>}
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
              </label>
              <label>
                Locality for the stock check
                <input
                  value={inputs.locality}
                  onChange={(ev) => set("locality", ev.target.value)}
                />
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

          <ThresholdsPanel
            agreed={agreed}
            thresholds={estimate?.thresholds ?? null}
            stricter={stricter}
            onChange={setStricter}
          />

          {error && <p role="alert">{error}</p>}
          {estimate && <Result estimate={estimate} />}

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
              <button type="button" onClick={trackInLedger} disabled={!e}>
                Track in ledger
              </button>
              <button type="button" onClick={draftBounty}>
                Draft a bounty
              </button>
              {onAuditDraft && (
                <button type="button" onClick={auditDraft}>
                  Add to validation audit
                </button>
              )}
            </div>
          )}
          {!e && estimate && (
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
  agreed: { rules: Rules; alertRules: AlertRules } | null;
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
      <legend>4. Buying thresholds</legend>
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
          only.
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
function TierCard({ opportunity: o, rules }: { opportunity: Opportunity; rules: Rules }) {
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
          {o.unitProfit === null ? "not known" : money(o.unitProfit)} (needs at least{" "}
          {money(rules.minUnitProfit)})
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
          {attributesText(offer)}
          {!offer.condition && " (retailers sell new stock, so new is assumed)"}
        </dd>
        {offer.promotion && (
          <>
            <dt>Promotion</dt>
            <dd>{offer.promotion}</dd>
          </>
        )}
        {offer.availability && (
          <>
            <dt>Source availability</dt>
            <dd>{offer.availability} (as reported, not verified)</dd>
          </>
        )}
      </dl>
      <p className="muted">{offer.stockNote}</p>
    </div>
  );
}

function Result({ estimate }: { estimate: Estimate }) {
  const e = estimate.economics;
  const s = estimate.sample;
  const failing = estimate.alert.checks.filter((c) => !c.ok).length;
  return (
    <section className="result" aria-live="polite">
      <small>5. ESTIMATE</small>
      <TierCard opportunity={estimate.opportunity} rules={estimate.thresholds.rules} />
      {!e && (
        <p className="notice">
          {estimate.match === "research"
            ? "No confirmed exact sale yet. Check and confirm the sales above, or research the similar ones, before relying on this trip."
            : "No matching completed sales. There is no evidence of what buyers pay, so no estimate is shown."}
        </p>
      )}
      {e && (
        <>
          <p className="muted">
            Based on {s.count} confirmed sale{s.count === 1 ? "" : "s"} from{" "}
            {s.independent} independent seller{s.independent === 1 ? "" : "s"}
            {s.oldest ? ", sold " + s.oldest + " to " + s.newest : ""}. Lower median
            sale {cash(s.lowerMedian)} including buyer postage. Stock costed at{" "}
            {money(estimate.unitCost)} per unit.
          </p>
          <dl className="figures">
            <dt>Cash required before payout</dt>
            <dd>
              <b>{money(e.cashRequired)}</b>
            </dd>
            <dt>Stock ({e.units} units)</dt>
            <dd>{money(e.costs.stock)}</dd>
            <dt>Packaging</dt>
            <dd>{money(e.costs.packaging)}</dd>
            <dt>Parcel costs</dt>
            <dd>{money(e.costs.postage)}</dd>
            <dt>Marketplace fees</dt>
            <dd>{money(e.costs.fees)}</dd>
            <dt>Returns allowance</dt>
            <dd>{money(e.costs.returns)}</dd>
            <dt>Travel</dt>
            <dd>
              {money(e.costs.travel)} ({money(e.journeyPerUnit)} per unit)
            </dd>
            <dt>Potential proceeds (not realised)</dt>
            <dd>{money(e.proceeds)}</dd>
            <dt>Contribution</dt>
            <dd className={e.contribution > 0 ? "ok" : "warn"}>
              <b>{money(e.contribution)}</b>
            </dd>
            <dt>Active hours</dt>
            <dd>{hours(e.activeMinutes)}</dd>
            <dt>Earnings per active hour</dt>
            <dd>{e.hourly === null ? "not known" : money(e.hourly)}</dd>
            <dt>Loss if nothing sells</dt>
            <dd className="warn">{money(e.unsoldLoss)}</dd>
            <dt>Break-even sale price</dt>
            <dd>{cash(e.breakEvenSale)}</dd>
            <dt>Sample size</dt>
            <dd>{s.count}</dd>
            <dt>Independent sellers</dt>
            <dd>{s.independent}</dd>
            <dt>Days to sell</dt>
            <dd>{s.daysToSell === null ? "not known" : s.daysToSell + " days"}</dd>
          </dl>
        </>
      )}
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
      <legend>6. Branch availability check</legend>
      <p className="muted">
        Branch stock is confirmed only by a check you record here from the last
        two days. Feeds, catalogues and past observations never confirm it.
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
