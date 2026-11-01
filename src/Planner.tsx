import React, { useEffect, useState } from "react";
import {
  api,
  dateTime,
  hours,
  loadMemberRules,
  loadProfile,
  MemberRules,
  money,
  percent,
  Profile,
  RuleKey as ApiRuleKey,
  saveMemberRules,
  saveProfile,
  toPence,
} from "./api";
import "./Planner.css";

// Transport modes, matching MODES in server/trip.mjs.
export const MODES = ["Walk", "Bicycle", "Public transport", "Car", "Van"];
const VEHICLES = new Set(["Car", "Van"]);

export type Costs = {
  stock: number;
  packaging: number;
  postage: number;
  fees: number;
  returns: number;
  travel: number | null; // null while a public transport fare is blank
};
// Every figure built on the journey cost is null while a public transport
// fare is blank (journeyKnown false): a blank is never a free journey.
export type Economics = {
  units: number;
  sold: number;
  salePrice: number;
  unitCost: number;
  proceeds: number;
  costs: Costs;
  totalCosts: number | null;
  contribution: number | null;
  unitContribution: number | null;
  cashRequired: number | null;
  journeyPerUnit: number | null;
  activeMinutes: number;
  activeHours: number;
  hourly: number | null;
  unsoldLoss: number | null;
  breakEvenSale: number | null;
  allSellAssumed: boolean;
  journeyKnown?: false;
};
type Check = { id: string; ok: boolean; detail: string };
export type Opportunity = {
  tier: string;
  reasons: string[];
  unitProfit: number | null;
  returnOnCost: number | null;
  targetPrice: number | null;
  meetsThresholds: boolean;
  trialUnits: number;
};
export type Thresholds = {
  unitProfit: number | null;
  returnOnCost: number | null;
  ok: boolean;
  failures: string[];
  fareNeeded?: boolean; // the verdict waits for a public transport fare
};
export type AccessNeed = { id: string; label: string; detail: string };
export type Checked = { price: string | null; stock: string | null };
export type Payout = {
  sold: string | null;
  dispatch: string | null;
  delivered: string | null;
  date: string | null;
  note: string;
};
export type CashTiming = { status: "on time" | "late" | "unknown"; daysLate: number | null; note: string };
type TripTiming = {
  start: string;
  daysToSell: number | null; // until the last unit sells; null when the sales rate is unknown
  daysToSellOneUnit: number; // the Goals assumption for one unit
  units: number;
  payout: Payout;
  payoutDays: number | null;
  cashNeededBy: string | null;
  cashNeededDays: number | null;
  cash: CashTiming;
};
type ModeSummary = {
  mode: string;
  carry: number;
  units: number;
  limit: string;
  loadKg: number;
  miles: number;
  travelCost: number | null;
  parking: number;
  travelMinutes: number;
  cashRequired: number | null;
  contribution: number | null;
  hourly: number | null;
  fareMissing: boolean;
  reason: string;
  fits: boolean;
};
type Limit = "trial" | "quantity" | "demand" | "stock" | "carry" | "storage" | "cash";
type Trip = {
  sku: string;
  name: string;
  variant: string;
  category: string;
  size: string | null;
  shop: string;
  area: string;
  miles: number;
  buy: number;
  post: number;
  pack: number;
  weight: number;
  stock: number;
  handlingMinutes: number;
  sales: number[];
  salesPerWeek: number | null;
  competingListings: number | null;
  sample: true;
  salePrice: number | null;
  returnsRate: number;
  categoryFailures: string[];
  transport: string;
  carry: number;
  carryEntered: number;
  units: number;
  limit: Limit;
  caps: Record<Limit, number>;
  trialUnits: number;
  afterTrial: number;
  sellWindowWeeks: number;
  demandUnits: number | null;
  weightKg: number;
  journey: { mode: string; miles: number; cost: number | null; minutes: number };
  fareMissing: boolean;
  economics: Economics;
  downside: { nothingSells: number | null; halfSellsUnits: number; halfSells: number | null };
  thresholds: Thresholds;
  hardFilters: string[];
  accessNeeds: AccessNeed[];
  checked: Checked;
  mainUncertainty: string;
  timing: TripTiming | null;
  reason: string;
  fits: boolean;
  alert: { eligible: boolean; reasons: string[]; checks: Check[] };
  opportunity: Opportunity;
  compare: {
    heading: string;
    current: ModeSummary;
    alternative: ModeSummary;
    difference: Record<string, number | null>;
    timeSaved: number | null;
    assumptions: string[];
  };
};
type Rejected = {
  sku: string;
  name: string;
  variant: string;
  shop: string;
  area: string;
  miles: number;
  buy: number;
  weight: number;
  units: number;
  unitProfit: number | null;
  returnOnCost: number | null;
  reasons: string[];
  fareNeeded?: boolean; // waits for a public transport fare
  tier: string;
  accessNeeds: AccessNeed[];
};
type DriveOption = {
  sku: string;
  name: string;
  shop: string;
  units: number;
  loadKg: number;
  contribution: number | null;
  hourly: number | null;
  reason: string;
};
type Drive = {
  heading: string;
  current: string;
  alternative: string;
  currentFareMissing?: boolean;
  alternativeFareMissing?: boolean;
  extra: DriveOption[];
  lost: DriveOption[];
  fareNeeded?: DriveOption[]; // fit now; by public transport they wait for a fare
};
export type RuleKey = ApiRuleKey;
export type Rules = MemberRules;
type RulesInfo = {
  agreed: Record<RuleKey, number>;
  overrides: Rules;
  effective: Record<RuleKey, number>;
  ignored: { key: RuleKey; label: string; value: number; applied: number }[];
};
type PlanResponse = {
  sample: true;
  trips: Trip[];
  rejected: Rejected[];
  drive: Drive;
  timing: TripTiming | null;
  accessNeeds: { id: string; label: string }[];
  rules: RulesInfo;
};

/** Pence as pounds, saying "not known" rather than showing a dash. */
export const pounds = (pence: number | null | undefined) =>
  pence === null || pence === undefined || !Number.isFinite(pence)
    ? "not known"
    : money(pence);
/** What a figure that needs the journey cost reads while the fare is blank. */
export const FARE_UNKNOWN = "not known until you enter your fare";
const FARE_NEEDED_TEXT = "Enter your return fare to see whether this trip meets your thresholds.";
/** A figure that depends on the journey: unknown while the fare is blank, never £0. */
export const fareFigure = (pence: number | null | undefined, fareMissing: boolean) =>
  fareMissing && (pence === null || pence === undefined) ? FARE_UNKNOWN : pounds(pence);
const signed = (pence: number | null) =>
  pence === null ? "not comparable" : (pence > 0 ? "+" : "") + money(pence);
const signedNumber = (n: number | null, unit: string) =>
  n === null ? "not comparable" : (n > 0 ? "+" : "") + n + unit;
const perHour = (pence: number | null, fareMissing = false) =>
  pence === null ? (fareMissing ? FARE_UNKNOWN : "no trip") : money(pence) + " an hour";
const perHourShort = (pence: number | null, fareMissing = false) =>
  pence === null ? (fareMissing ? FARE_UNKNOWN : "no trip") : money(pence) + "/h";
const minutesText = (m: number) => m + " min";
/** "on foot", "by bicycle", "by public transport", "by car" or "by van". */
export const byMode = (mode: string) => (mode === "Walk" ? "on foot" : "by " + mode.toLowerCase());
export const plural = (n: number, one: string, many = one + "s") => n + " " + (n === 1 ? one : many);

/** "13 days (payout expected 13 Nov 2026)", or why it is not known. */
export function paymentText(payoutDays: number | null | undefined, date: string | null | undefined) {
  if (payoutDays === null || payoutDays === undefined || !date) return "not known: no payout date can be scheduled";
  return `${plural(payoutDays, "day")} (payout expected ${dateTime(date)})`;
}
/** When a price or stock check was made, or "never". */
export const checkedText = (date: string | null) => (date ? dateTime(date) : "never");

/** The payout schedule in words, with dates as people write them. */
export function payoutSentence(p: Payout) {
  if (!p.date) return p.note; // why it cannot be scheduled; carries no dates
  return `Assumes a sale by ${dateTime(p.sold)}, posting on ${dateTime(p.dispatch)}, delivery by ${dateTime(p.delivered)} and payout on ${dateTime(p.date)}.`;
}

/** The payout against the date the cash is needed, in words. */
export function cashSentence(cash: CashTiming, cashNeededBy: string | null, payoutDate: string | null) {
  if (!cashNeededBy) return "No date is set for when you need the cash back.";
  if (!payoutDate) return `The payout date is unknown, so it cannot be checked against ${dateTime(cashNeededBy)}.`;
  if (cash.status === "late")
    return `Payout expected ${dateTime(payoutDate)}, ${plural(cash.daysLate ?? 0, "day")} after you need the cash (${dateTime(cashNeededBy)}).`;
  return `Payout expected ${dateTime(payoutDate)}, on or before ${dateTime(cashNeededBy)}.`;
}

/** How long selling takes: the Goals figure for one unit, or longer for several. */
export function sellingSentence(t: { daysToSell: number | null; daysToSellOneUnit: number; units: number }) {
  if (t.daysToSell === null) return "";
  if (t.daysToSell > t.daysToSellOneUnit)
    return `At the item's sales rate the last of ${plural(t.units, "unit")} is expected to sell after ${plural(t.daysToSell, "day")}, longer than the ${plural(t.daysToSellOneUnit, "day")} your Goals assume for one unit.`;
  return `It uses your Goals assumption of ${plural(t.daysToSellOneUnit, "day")} to sell, your dispatch days, delivery and payout delay, not sold evidence for this item.`;
}

// The member's stricter thresholds are shared with Research through api.ts
// (one store for every tab). The server applies them only where they are
// stricter than the agreed thresholds.
export const loadRules = loadMemberRules;
const RULE_INPUTS: {
  key: RuleKey;
  label: string;
  unit: "pounds" | "kg" | "percent" | "units";
  hint: string;
}[] = [
  { key: "minUnitPrice", label: "Lowest purchase price per unit (£)", unit: "pounds", hint: "Higher is stricter" },
  { key: "maxUnitPrice", label: "Highest purchase price per unit (£)", unit: "pounds", hint: "Lower is stricter" },
  { key: "maxWeightKg", label: "Each unit weighs under (kg)", unit: "kg", hint: "Lower is stricter" },
  { key: "minUnitProfit", label: "Lowest profit per unit (£)", unit: "pounds", hint: "Higher is stricter" },
  { key: "minReturn", label: "Lowest return on purchase price (%)", unit: "percent", hint: "Higher is stricter" },
  { key: "trialUnits", label: "Trial batch for a first purchase (units)", unit: "units", hint: "Lower is stricter" },
];

function ruleText(key: RuleKey, value: number | undefined) {
  if (value === undefined) return "not set";
  const unit = RULE_INPUTS.find((f) => f.key === key)!.unit;
  if (unit === "pounds") return money(value);
  if (unit === "percent") return percent(value);
  if (unit === "kg") return value + " kg";
  return plural(value, "unit");
}
const toDraft = (rules: Rules) =>
  Object.fromEntries(
    RULE_INPUTS.map(({ key, unit }) => {
      const v = rules[key];
      if (v === undefined) return [key, ""];
      if (unit === "pounds") return [key, String(v / 100)];
      if (unit === "percent") return [key, String(Math.round(v * 1000) / 10)];
      return [key, String(v)];
    }),
  ) as Record<RuleKey, string>;

// The profile as saved in this browser. fare is null when the field is
// empty (not entered); fareFree records that public transport is free for
// this member (a bus pass, for example), which is the only way £0 counts.
export type PlannerProfile = Profile;

const FARE_MAX = 1000; // pounds
/** True when the fare field holds a number, valid or not. */
const fareFilled = (p: Profile) => typeof p.fare === "number" && Number.isFinite(p.fare);
/** True when the fare is a usable entry: more than 0p and at most £1,000. */
const fareEntered = (p: Profile) =>
  fareFilled(p) && toPence(p.fare as number) > 0 && (p.fare as number) <= FARE_MAX;
/** True when the fare is used: by public transport, unless travel is free. */
const fareUsed = (p: Profile) => p.transport === "Public transport" && p.fareFree !== true;

/** True when travelling by public transport with no fare entered. */
export const fareNotEntered = (p: PlannerProfile) => fareUsed(p) && !fareEntered(p);

/**
 * The profile as the API expects it: money in whole pence, rates as shares,
 * and the member's stricter thresholds. The fare is 0 when the member ticked
 * that their travel is free, the fare in pence when one is entered, and null
 * (not entered) otherwise: an empty field, £0 without the tick, or a value
 * that is ignored because it is not used (walking, cycling or driving).
 */
export function planProfile(p: PlannerProfile, rules: Rules) {
  return {
    area: p.area,
    budget: toPence(p.budget),
    target: toPence(p.target),
    transport: p.transport,
    carry: p.carry,
    quantity: p.quantity,
    fare: p.fareFree === true ? 0 : fareEntered(p) ? toPence(p.fare as number) : null,
    perMile: Math.round(p.perMile),
    extra: toPence(p.extra),
    storage: p.storage,
    feeRate: p.feeRate,
    feeFixed: Math.round(p.feeFixed),
    returnsRate: p.returnsRate,
    rules,
  };
}

/** A plain-language problem with the profile, or null when it can be sent. */
export function profileProblem(p: Profile): string | null {
  if (typeof p.area !== "string" || !p.area.trim()) return "Enter your local area.";
  if (!MODES.includes(p.transport)) return "Choose how you travel.";
  const between = (v: unknown, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
  const whole = (v: unknown, min: number, max: number) => between(v, min, max) && Number.isInteger(v);
  const rules: [boolean, string][] = [
    [between(p.budget, 0, 100000), "Available cash must be between £0 and £100,000."],
    [between(p.target, 0, 10000), "Hourly target must be between £0 and £10,000."],
    [between(p.carry, 0, 1000), "Carry limit must be between 0 and 1,000 kg."],
    [whole(p.quantity, 1, 1000), "Maximum units must be a whole number from 1 to 1,000."],
    [whole(p.storage, 0, 100000), "Storage at home must be a whole number of units."],
    // The fare is checked only when it is filled in and used; an empty field
    // is "not entered", and it is ignored when walking, cycling, driving or
    // when public transport is free.
    [
      !fareUsed(p) || !fareFilled(p) || between(p.fare, 0, FARE_MAX),
      "Public transport fare must be between £0 and £1,000, or leave it empty if you do not know it.",
    ],
    [between(p.perMile, 0, 1000), "Cost per mile must be between 0p and 1,000p."],
    [between(p.extra, 0, 1000), "Parking or tolls must be between £0 and £1,000."],
    [between(p.feeRate, 0, 0.5), "Marketplace fee must be between 0% and 50%."],
    [between(p.feeFixed, 0, 10000), "Fixed fee per item must be between 0p and 10,000p."],
    [between(p.returnsRate, 0, 0.5), "Returns allowance must be between 0% and 50%."],
  ];
  return rules.find(([ok]) => !ok)?.[1] ?? null;
}

export function TierBadge({ tier }: { tier: string }) {
  return (
    <span className={"badge planner-tier-" + tier.toLowerCase().replace(/\s+/g, "-")}>{tier}</span>
  );
}

/** Access-need labels as badges; the detail is the tooltip and screen-reader text. */
export function AccessBadges({ needs }: { needs: AccessNeed[] }) {
  return (
    <>
      {needs.map((n) => (
        <span
          key={n.id}
          className={"badge planner-access" + (n.id === "widely-accessible" ? " open" : "")}
          title={n.detail}
        >
          {n.label}
          <span className="planner-sr">: {n.detail}</span>
        </span>
      ))}
    </>
  );
}

const limitText = (t: Trip) => {
  const text: Record<Limit, string> = {
    trial: `the trial batch of ${plural(t.trialUnits, "unit")} for a first purchase`,
    quantity: "your maximum units",
    demand: `expected demand: about ${t.salesPerWeek ?? "an unknown number of"} sales a week over ${plural(t.sellWindowWeeks, "week")}, less ${plural(t.competingListings ?? 0, "competing listing")}`,
    stock: "the stock on the shelf",
    carry: VEHICLES.has(t.transport)
      ? `the ${t.carry} kg load limit by ${t.transport.toLowerCase()}`
      : `your ${t.carry} kg load limit`,
    storage: "your storage at home",
    cash: "your available cash",
  };
  return text[t.limit];
};

// Access needs the member asked to hide, kept in this browser only.
const ACCESS_KEY = "bounty-access-hide";
function loadHidden(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(ACCESS_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}
function saveHidden(ids: string[]) {
  try {
    localStorage.setItem(ACCESS_KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable: the filter lasts for this visit only */
  }
}
const ACCESS_FILTERS: [string, string][] = [
  ["vehicle-required", "Vehicle required"],
  ["heavy-handling", "Heavy handling"],
  ["limited-stock", "Limited local stock"],
  ["specialist-storage", "Specialist storage"],
];

function NumberField({
  label,
  value,
  onChange,
  step = "any",
  min = 0,
  note,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number | "any";
  min?: number;
  note?: React.ReactNode;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        inputMode="decimal"
        min={min}
        step={step}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
      />
      {note && <span className="muted">{note}</span>}
    </label>
  );
}

/** A number field that may be left empty: empty is null, never zero. */
function OptionalNumberField({
  label,
  value,
  onChange,
  placeholder,
  disabled = false,
  note,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder: string;
  disabled?: boolean;
  note?: React.ReactNode;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        placeholder={placeholder}
        disabled={disabled}
        value={typeof value === "number" && Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
      {note && <span className="muted">{note}</span>}
    </label>
  );
}

// Rates are stored as shares and edited as percentages.
const asPercent = (share: number) => (Number.isFinite(share) ? Math.round(share * 10000) / 100 : NaN);

export default function Planner() {
  const [profile, setProfile] = useState<PlannerProfile>(loadProfile);
  const [rules, setRules] = useState<Rules>(loadMemberRules);
  const [hidden, setHidden] = useState<string[]>(loadHidden);
  const [result, setResult] = useState<PlanResponse | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  // Display only: on a phone the buying profile folds away behind a button.
  const [profileOpen, setProfileOpen] = useState(false);
  const set = (patch: Partial<PlannerProfile>) => setProfile({ ...profile, ...patch });
  const problem = profileProblem(profile);
  const noFare = fareNotEntered(profile);

  useEffect(() => saveProfile(profile), [profile]);
  useEffect(() => saveHidden(hidden), [hidden]);
  useEffect(() => {
    if (problem) {
      setError(problem);
      setResult(null);
      return;
    }
    let active = true;
    // Wait for typing to pause before asking the API.
    const timer = setTimeout(() => {
      api<PlanResponse>("plan", planProfile(profile, rules))
        .then((r) => {
          if (!active) return;
          setResult(r);
          setError("");
        })
        .catch((e) => {
          if (!active) return;
          setResult(null);
          setError((e as Error).message);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [profile, rules, problem]);

  const all = result?.trips ?? [];
  const isHidden = (t: { accessNeeds: AccessNeed[] }) => t.accessNeeds.some((n) => hidden.includes(n.id));
  const trips = all.filter((t) => !isHidden(t));
  const hiddenTrips = all.filter(isHidden);
  const trip = trips.find((t) => t.sku === selected) ?? trips[0];

  return (
    <div className="planner">
      <div className="layout">
        <aside className={"planner-profile" + (profileOpen ? " open" : "")}>
          <small>01 / PARAMETERS</small>
          <h2>Your buying profile</h2>
          <button
            type="button"
            className="planner-profile-toggle"
            aria-expanded={profileOpen}
            onClick={() => setProfileOpen(!profileOpen)}
          >
            {profileOpen ? "Hide profile" : "Edit profile"}
          </button>
          <label>
            Local area
            <input value={profile.area ?? ""} onChange={(e) => set({ area: e.target.value })} />
          </label>
          <label>
            Transport
            <select value={profile.transport} onChange={(e) => set({ transport: e.target.value })}>
              {MODES.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <NumberField label="Available cash (£)" value={profile.budget} onChange={(budget) => set({ budget })} />
          <NumberField label="Hourly target (£)" value={profile.target} onChange={(target) => set({ target })} />
          <NumberField
            label="Comfortable carry limit (kg)"
            value={profile.carry}
            onChange={(carry) => set({ carry })}
            note={`What you can carry by hand. By car or van the load limit is the larger of this and 25 kg; by public transport, the smaller of this and 10 kg.`}
          />
          <NumberField
            label="Maximum units per trip"
            value={profile.quantity}
            step={1}
            min={1}
            onChange={(quantity) => set({ quantity })}
            note="A first purchase of any item is still a small trial batch."
          />
          <NumberField
            label="Storage at home (units)"
            value={profile.storage}
            step={1}
            onChange={(storage) => set({ storage })}
          />
          <fieldset>
            <legend>Travel costs</legend>
            <OptionalNumberField
              label="Public transport return fare (£)"
              value={profile.fare}
              placeholder="Not entered"
              disabled={profile.fareFree === true}
              onChange={(fare) => set({ fare })}
              note={
                profile.fareFree === true
                  ? "Not used: you ticked that your public transport is free."
                  : "Used when you travel by public transport, and for the public transport comparison when you drive. Leave it empty if you do not know it yet."
              }
            />
            <label className="planner-check">
              <input
                type="checkbox"
                checked={profile.fareFree === true}
                onChange={(e) => set({ fareFree: e.target.checked })}
              />
              My public transport is free (for example a bus pass)
            </label>
            {noFare && (
              <p className="notice warn" role="status">
                {profile.fare === 0
                  ? "A fare of £0 counts only when you tick that your travel is free. "
                  : "Enter your return fare, or tick the box if your travel is free. "}
                A blank fare is never counted as free: until then profit per unit, contribution and
                earnings per hour are not known for any trip, and nothing is shortlisted.
              </p>
            )}
            <NumberField
              label="Car or van cost per mile (p)"
              value={profile.perMile}
              step={1}
              onChange={(perMile) => set({ perMile })}
              note="45p is the HMRC mileage rate, covering fuel and wear. Used for car or van trips and the driving comparison."
            />
            <NumberField
              label="Parking or tolls per trip (£)"
              value={profile.extra}
              onChange={(extra) => set({ extra })}
              note="Car or van only."
            />
          </fieldset>
          <fieldset>
            <legend>Your selling assumptions</legend>
            <p className="muted">
              These are your assumptions. The cautious sample defaults are a 13% marketplace fee plus
              40p per item sold and a 5% returns allowance. Clothing always uses at least 15% for
              returns. Replace them with your own marketplace's fees.
            </p>
            <NumberField
              label="Marketplace fee (% of the sale)"
              value={asPercent(profile.feeRate)}
              onChange={(v) => set({ feeRate: v / 100 })}
            />
            <NumberField
              label="Fixed fee per item sold (p)"
              value={profile.feeFixed}
              step={1}
              onChange={(feeFixed) => set({ feeFixed })}
            />
            <NumberField
              label="Returns allowance (% of the sale)"
              value={asPercent(profile.returnsRate)}
              onChange={(v) => set({ returnsRate: v / 100 })}
            />
          </fieldset>
          <fieldset>
            <legend>Access needs to avoid</legend>
            <p className="muted">Hide trips with any need you tick.</p>
            {ACCESS_FILTERS.map(([id, label]) => (
              <label key={id} className="planner-check">
                <input
                  type="checkbox"
                  checked={hidden.includes(id)}
                  onChange={(e) =>
                    setHidden(e.target.checked ? [...hidden, id] : hidden.filter((h) => h !== id))
                  }
                />
                {label}
              </label>
            ))}
          </fieldset>
        </aside>
        <section>
          <small>02 / RANKED OPPORTUNITIES</small>
          <h2>Local shortlist</h2>
          <p className="notice">
            Sample data: illustrative Leeds offers with modelled sale totals. Stock, prices and
            earnings are simulated, so nothing here is ever a buy alert.
          </p>
          {error && <p role="alert">{error}</p>}
          {result && !all.length && (
            <p className="warn">
              {result.rejected.some((r) => r.fareNeeded)
                ? `Enter your return fare to see whether these trips meet your thresholds: ${result.rejected
                    .filter((r) => r.fareNeeded)
                    .map((r) => r.name)
                    .join(", ")}. Until then nothing is shortlisted. The list of offers not shortlisted says why for each one.`
                : "No offer is inside your buying thresholds, so nothing is shortlisted. The list of offers not shortlisted says why."}
            </p>
          )}
          {trips.map((t) => (
            <button
              key={t.sku}
              type="button"
              className={
                "card" +
                (t.sku === trip?.sku ? " active" : "") +
                // Display only: tint the figure by its sign; unknown stays neutral.
                (t.fareMissing || t.economics.contribution == null
                  ? ""
                  : t.economics.contribution > 0
                    ? " gain"
                    : " loss")
              }
              aria-current={t.sku === trip?.sku ? "true" : undefined}
              onClick={() => setSelected(t.sku)}
            >
              <span>
                <small>
                  {t.shop} · {t.miles} mi · {t.area}
                </small>
                <b>{t.name}</b>
                <span className="planner-badges">
                  <span className="badge sample">Sample</span>
                  <TierBadge tier={t.opportunity.tier} />
                  <AccessBadges needs={t.accessNeeds} />
                </span>
                <em className={t.fits ? "ok" : "warn"}>
                  {t.reason}
                  {t.units ? `: ${plural(t.units, "unit")}` : ""}
                </em>
                <em>
                  Price checked: {checkedText(t.checked.price)}. Stock checked:{" "}
                  {checkedText(t.checked.stock)}. Main uncertainty: {t.mainUncertainty}.
                </em>
                <em>
                  Time until payment:{" "}
                  {t.units ? paymentText(t.timing?.payoutDays, t.timing?.payout.date) : "no trip"}
                </em>
              </span>
              <span>
                <small>Contribution</small>
                <b>{fareFigure(t.economics.contribution, t.fareMissing)}</b>
                <small>{perHour(t.economics.hourly, t.fareMissing)}</small>
              </span>
            </button>
          ))}
          {hiddenTrips.length > 0 && (
            <p className="muted">
              Hidden by your access needs: {hiddenTrips.map((t) => t.name).join(", ")}. Untick a need
              in the profile to show {hiddenTrips.length === 1 ? "it" : "them"}.
            </p>
          )}
          {result && result.rejected.length > 0 && (
            <RejectedList rejected={result.rejected} rules={result.rules.effective} />
          )}
          {trip && <TripView key={trip.sku} trip={trip} profile={profile} />}
          {result && <DriveSummary drive={result.drive} />}
          <BasketsLink />
          <StricterThresholds
            rules={rules}
            info={result?.rules ?? null}
            onSave={(next) => {
              saveMemberRules(next);
              setRules(next);
            }}
          />
        </section>
      </div>
    </div>
  );
}

/** The buying thresholds that apply to this member, in one sentence. */
export function thresholdsSentence(rules: Record<RuleKey, number>) {
  return `${money(rules.minUnitPrice)} to ${money(rules.maxUnitPrice)} per unit, under ${rules.maxWeightKg} kg, at least ${money(rules.minUnitProfit)} profit per unit after every cost including its share of travel, and at least ${percent(rules.minReturn)} return on the purchase price`;
}

function RejectedList({ rejected, rules }: { rejected: Rejected[]; rules: Record<RuleKey, number> }) {
  const waiting = rejected.filter((r) => r.fareNeeded).length;
  return (
    <details className="planner-rejected">
      <summary>
        {waiting
          ? `Not shortlisted: ${plural(rejected.length, "offer")}, ${waiting} waiting for your fare`
          : `Not shortlisted: ${plural(rejected.length, "offer")} outside your buying thresholds`}
      </summary>
      <p className="muted">
        An offer is shortlisted only when it is inside every buying threshold that applies to you:{" "}
        {thresholdsSentence(rules)}.
        {waiting
          ? " By public transport your fare is part of each unit's share of travel, so whether an offer meets these is not known until you enter your return fare (or tick that your travel is free)."
          : ""}
      </p>
      <ul>
        {rejected.map((r) => (
          <li key={r.sku}>
            <b>{r.name}</b> at {r.shop} ({money(r.buy)}, {r.weight} kg): {r.reasons.join("; ")}.{" "}
            <span className="planner-badges">
              <span className="badge sample">Sample</span>
              <AccessBadges needs={r.accessNeeds} />
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function Figures({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="planner-figures">
      {rows.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function TripView({ trip: t, profile }: { trip: Trip; profile: PlannerProfile }) {
  const e = t.economics;
  // Figures that need the journey cost read "not known until you enter your
  // fare" while a public transport fare is blank, never £0.
  const fig = (pence: number | null | undefined) => fareFigure(pence, t.fareMissing);
  const [ledger, setLedger] = useState({ busy: false, notice: "" });
  const failing = t.alert.checks.filter((c) => !c.ok).length;

  async function track() {
    setLedger({ busy: true, notice: "" });
    try {
      const saved = await api<{ id: number | string }>("ledger/trips", {
        label: (t.name + " at " + t.shop + " (sample)").slice(0, 120),
        source: "planner",
        kind: "resale",
        reference: t.sku,
        predicted: {
          units: e.units,
          proceeds: e.proceeds,
          contribution: e.contribution,
          cashRequired: e.cashRequired,
          activeMinutes: e.activeMinutes,
          ...(t.timing?.payout.date ? { payoutBy: t.timing.payout.date } : {}),
          sample: true,
        },
      });
      setLedger({
        busy: false,
        notice:
          "Tracked in the ledger as trip " +
          saved.id +
          ". The predictions are sample figures: they never count as potential proceeds or in prediction accuracy. Record real receipts and payouts in Ledger.",
      });
    } catch (err) {
      setLedger({ busy: false, notice: "Could not track this trip: " + (err as Error).message });
    }
  }

  return (
    <article>
      <small>03 / TRIP CALCULATION</small>
      <h2>{t.name}</h2>
      <p className="planner-badges">
        <span className="badge sample">Sample</span>
        <TierBadge tier={t.opportunity.tier} />
        <span className={t.fits ? "badge ok" : "badge warn"}>{t.reason}</span>
        <AccessBadges needs={t.accessNeeds} />
      </p>
      <p>
        {t.variant} at {t.shop}, {t.miles} miles from the centre of {t.area}.{" "}
        {t.units
          ? `${plural(t.units, "unit")} (${t.weightKg} kg), limited by ${limitText(t)}. Return journey ${byMode(t.journey.mode)}: ${t.journey.miles} miles, ${t.journey.minutes} minutes.`
          : `No units fit: limited by ${limitText(t)}.`}
      </p>
      {t.units > 0 && t.afterTrial > t.units && t.limit === "trial" && (
        <p className="muted">
          A first purchase is a trial batch. Once a verified trade (receipt and payout) proves the
          item, your other limits would allow {plural(t.afterTrial, "unit")}.
        </p>
      )}
      {t.fareMissing && (
        <p className="notice warn">
          No public transport fare is entered, so the cash required, contribution, profit per unit
          and earnings per hour are {FARE_UNKNOWN}. {FARE_NEEDED_TEXT} Enter it in the profile (or
          tick that your travel is free).
        </p>
      )}
      {t.reason === "Outside your area" && (
        <p className="notice">
          This shop is outside your area. Travel is measured from the centre of {t.area}, so the
          figures leave out your journey to get there.
        </p>
      )}
      <p>
        <strong>Access needs:</strong> {t.accessNeeds.map((n) => `${n.label} (${n.detail})`).join("; ")}.
      </p>
      <p>
        <strong>Last checked:</strong> price {checkedText(t.checked.price)}, stock{" "}
        {checkedText(t.checked.stock)}. <strong>Main uncertainty:</strong> {t.mainUncertainty}.
      </p>
      <div className="grid2">
        <div>
          <h3>Money</h3>
          <Figures
            rows={[
              ["Cash required before payout", <strong key="c">{fig(e.cashRequired)}</strong>],
              ["Stock", money(e.costs.stock)],
              ["Packaging", money(e.costs.packaging)],
              ["Parcel costs (illustrative)", money(e.costs.postage)],
              ["Marketplace fees", money(e.costs.fees)],
              [`Returns allowance (${percent(t.returnsRate)})`, money(e.costs.returns)],
              ["Travel (one journey)", fig(e.costs.travel)],
              ["Travel per unit", fig(e.journeyPerUnit)],
              ["Proceeds if every unit sells (estimate)", money(e.proceeds)],
              ["Contribution", <strong key="p">{fig(e.contribution)}</strong>],
            ]}
          />
        </div>
        <div>
          <h3>Time and downside</h3>
          <Figures
            rows={[
              ["Active hours", hours(e.activeMinutes)],
              ["Earnings per hour", perHour(e.hourly, t.fareMissing)],
              [
                "Time until payment",
                t.units ? paymentText(t.timing?.payoutDays, t.timing?.payout.date) : "no trip",
              ],
              ["Loss if nothing sells", fig(t.downside.nothingSells)],
              [
                `If only ${t.downside.halfSellsUnits} of ${t.units} sell`,
                fig(t.downside.halfSells),
              ],
              ["Break-even sale price per unit", fig(e.breakEvenSale)],
              ["Sale price used per unit", pounds(t.salePrice)],
              ["Shelf price per unit", money(t.buy)],
            ]}
          />
        </div>
      </div>
      <p className="muted">
        Active hours are your working time. Time until payment is when the cash comes back:{" "}
        {t.timing
          ? `${payoutSentence(t.timing.payout)} ${sellingSentence(t.timing)}`
          : "set your selling rhythm in Goals to see it."}
        {t.timing?.cashNeededBy
          ? " " + cashSentence(t.timing.cash, t.timing.cashNeededBy, t.timing.payout.date)
          : ""}
      </p>

      <h3>Buying thresholds</h3>
      <p>
        Profit per unit after fees, postage, packaging, returns and the unit's share of travel:{" "}
        {fig(t.thresholds.unitProfit)}. Return on the purchase price:{" "}
        {t.thresholds.returnOnCost === null
          ? t.fareMissing
            ? FARE_UNKNOWN
            : "not known"
          : percent(t.thresholds.returnOnCost)}
        .
      </p>
      <ul className="checks">
        {t.thresholds.ok ? (
          <li className="pass">Inside your buying thresholds</li>
        ) : (
          t.thresholds.failures.map((f) => <li key={f}>{f}</li>)
        )}
      </ul>

      <h3>
        Opportunity tier: <TierBadge tier={t.opportunity.tier} />
      </h3>
      <ul>
        {t.opportunity.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {t.opportunity.targetPrice !== null && (
        <p>Would qualify at a purchase price of {money(t.opportunity.targetPrice)} or less.</p>
      )}

      <h3>Buy alert</h3>
      <p className="notice">
        <strong>Sample data: never a buy alert.</strong> {failing} of {t.alert.checks.length}{" "}
        checks fail.
      </p>
      <ul className="checks">
        {t.alert.checks.map((c) => (
          <li key={c.id} className={c.ok ? "pass" : ""}>
            {c.detail}
          </li>
        ))}
      </ul>

      <DriveComparison compare={t.compare} />

      <details>
        <summary>Evidence and assumptions</summary>
        <p>
          Sample fixture, not a live source: there is no observation date, no branch stock check and
          no completed sale. Modelled sale totals including buyer postage:{" "}
          {t.sales.map(money).join(", ")}. The planner uses the lower median,{" "}
          {pounds(t.salePrice)}, so the estimate leans cautious.
        </p>
        <p>
          Per unit: shelf price {money(t.buy)}, parcel {money(t.post)}, packaging {money(t.pack)},{" "}
          {t.weight} kg. {t.stock} assumed on the shelf. Modelled demand: about {t.salesPerWeek ?? "an unknown number of"}{" "}
          sales a week and {t.competingListings ?? "an unknown number of"} competing listings, so about{" "}
          {plural(t.caps.demand, "unit")} could sell in {plural(t.sellWindowWeeks, "week")}.
        </p>
        <p>
          Fees use your assumptions: {percent(profile.feeRate)} of the sale plus{" "}
          {money(profile.feeFixed)} per item sold, and a {percent(t.returnsRate)} returns allowance
          {t.returnsRate > profile.returnsRate ? " (the clothing minimum)" : ""}. Contribution
          assumes every unit sells; the loss if nothing sells and the half-sold figure show the
          downside. Postage is paid at dispatch, before the payout, so it counts in the cash
          required.
        </p>
        <p>
          Time: a return journey of {t.journey.minutes} minutes, 10 minutes in the shop and{" "}
          {t.handlingMinutes} minutes per unit to list, pack and post.
        </p>
      </details>

      <button type="button" onClick={track} disabled={ledger.busy || !t.units || t.fareMissing}>
        Track this trip in the ledger
      </button>
      {!t.units && <p className="muted">No units fit, so there is nothing to track.</p>}
      {t.units > 0 && t.fareMissing && (
        <p className="muted">Enter your return fare before tracking this trip.</p>
      )}
      {t.units > 0 && !t.fareMissing && (
        <p className="muted">
          A tracked sample trip is labelled sample in the Ledger, so its prediction never counts as
          potential proceeds.
        </p>
      )}
      {ledger.notice && <p role="status">{ledger.notice}</p>}
    </article>
  );
}

function DriveComparison({ compare: c }: { compare: Trip["compare"] }) {
  const a = c.current;
  const b = c.alternative;
  const d = c.difference;
  // A side with a blank public transport fare has no journey cost, so the
  // figures built on it are not known (and neither is the difference).
  const fig = (s: ModeSummary, pence: number | null) => fareFigure(pence, s.fareMissing);
  const rows: [string, string, string, string][] = [
    ["Load limit", a.carry + " kg", b.carry + " kg", ""],
    ["Units", String(a.units), String(b.units), signedNumber(d.units, "")],
    ["Total load", a.loadKg + " kg", b.loadKg + " kg", signedNumber(d.loadKg, " kg")],
    ["Mileage (return)", a.miles + " mi", b.miles + " mi", signedNumber(d.miles, " mi")],
    ["Travel cost", fig(a, a.travelCost), fig(b, b.travelCost), signed(d.travelCost)],
    ["Parking or tolls (in travel cost)", money(a.parking), money(b.parking), signed(d.parking)],
    ["Travel time", minutesText(a.travelMinutes), minutesText(b.travelMinutes), signedNumber(d.travelMinutes, " min")],
    ["Cash required before payout", fig(a, a.cashRequired), fig(b, b.cashRequired), signed(d.cashRequired)],
    ["Contribution", fig(a, a.contribution), fig(b, b.contribution), signed(d.contribution)],
    [
      "Earnings per hour",
      perHourShort(a.hourly, a.fareMissing && a.units > 0),
      perHourShort(b.hourly, b.fareMissing && b.units > 0),
      signed(d.hourly),
    ],
  ];
  return (
    <>
      <h3>{c.heading}</h3>
      <p>
        {VEHICLES.has(a.mode)
          ? `You already travel by ${a.mode.toLowerCase()}, so this shows the same trip by public transport.`
          : `Your plan ${byMode(a.mode)} beside the same trip by car. Choosing Car as your transport shows exactly the car figures here.`}{" "}
        {c.timeSaved !== null &&
          (c.timeSaved > 0
            ? `${b.mode} saves ${c.timeSaved} minutes of travel.`
            : c.timeSaved < 0
              ? `${b.mode} takes ${-c.timeSaved} minutes longer.`
              : "Travel time is the same.")}
      </p>
      <div className="scroll">
        <table className="planner-compare">
          <thead>
            <tr>
              <th scope="col">Figure</th>
              <th scope="col" className="num">
                {a.mode} (yours)
              </th>
              <th scope="col" className="num">
                {b.mode}
              </th>
              <th scope="col" className="num">
                Difference
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, x, y, diff]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td className="num">{x}</td>
                <td className="num">{y}</td>
                <td className="num">{diff}</td>
              </tr>
            ))}
            <tr>
              <th scope="row">Result</th>
              <td className="num">{a.reason}</td>
              <td className="num">{b.reason}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <ul className="muted">
        {c.assumptions.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
    </>
  );
}

function DriveSummary({ drive }: { drive: Drive }) {
  const line = (o: DriveOption) =>
    `${o.name} at ${o.shop}: ${plural(o.units, "unit")}, ${o.loadKg} kg, ${pounds(o.contribution)}, ${perHour(o.hourly)}`;
  const waiting = drive.fareNeeded ?? [];
  return (
    <article>
      <small>WHAT CHANGES IF I {drive.alternative === "Car" ? "DRIVE" : "TAKE PUBLIC TRANSPORT"}?</small>
      <h2>
        {drive.alternative === "Car" ? "Extra opportunities by car" : "Opportunities by public transport"}
      </h2>
      {drive.extra.length ? (
        <>
          <p>
            {drive.currentFareMissing
              ? `These fit your profile ${byMode(drive.alternative)}. ${byMode(drive.current).replace(/^b/, "B")} they cannot be checked until you enter your return fare:`
              : `These fit your profile ${byMode(drive.alternative)} but not ${byMode(drive.current)}:`}
          </p>
          <ul>
            {drive.extra.map((o) => (
              <li key={o.sku}>{line(o)}</li>
            ))}
          </ul>
        </>
      ) : drive.alternativeFareMissing ? (
        <p>
          No public transport fare is entered, so whether any trip works by public transport is not
          known until you enter your return fare (or tick that your travel is free). A blank fare is
          never counted as free.
        </p>
      ) : (
        <p>
          No other offer fits your profile {byMode(drive.alternative)}. The trip calculation above
          shows the figures for each trip both ways.
        </p>
      )}
      {waiting.length > 0 && (
        <p>
          These fit now; {byMode(drive.alternative)} they cannot be checked until you enter your
          return fare: {waiting.map((o) => `${o.name} at ${o.shop}`).join(" and ")}.
        </p>
      )}
      {drive.lost.length > 0 && (
        <>
          <p>These fit now but would not by {drive.alternative.toLowerCase()}:</p>
          <ul>
            {drive.lost.map((o) => (
              <li key={o.sku}>
                {o.name} at {o.shop}: {o.reason}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted">Sample data: a comparison, never a buy alert.</p>
    </article>
  );
}

function BasketsLink() {
  const [asked, setAsked] = useState(false);
  return (
    <article>
      <small>04 / SEVERAL ITEMS, ONE TRIP</small>
      <h2>One shopping trip, one cash limit</h2>
      <p>
        Each trip above buys one item. To buy several items on one trip, sharing one journey and one
        cash limit for the whole basket, use the basket plan in the Goals tab.
      </p>
      <button
        type="button"
        onClick={() => {
          location.hash = "#Goals";
          window.dispatchEvent(new HashChangeEvent("hashchange"));
          setAsked(true);
        }}
      >
        Open the basket plan in Goals
      </button>
      <p className="muted">
        {asked
          ? "If the page has not switched, select Goals in the tabs above."
          : "You can also select Goals in the tabs above."}
      </p>
    </article>
  );
}

function StricterThresholds({
  rules,
  info,
  onSave,
}: {
  rules: Rules;
  info: RulesInfo | null;
  onSave: (rules: Rules) => void;
}) {
  const [draft, setDraft] = useState<Record<RuleKey, string>>(() => toDraft(rules));
  const [notice, setNotice] = useState("");

  function submit(ev: React.FormEvent) {
    ev.preventDefault();
    const next: Rules = {};
    for (const { key, unit, label } of RULE_INPUTS) {
      const raw = draft[key].trim();
      if (!raw) continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        setNotice(label + " must be a number of 0 or more.");
        return;
      }
      if (unit === "units" && (!Number.isInteger(value) || value < 1)) {
        setNotice(label + " must be a whole number of 1 or more.");
        return;
      }
      next[key] =
        unit === "pounds" ? toPence(value) : unit === "percent" ? Math.round(value * 100) / 10000 : value;
    }
    onSave(next);
    setNotice(Object.keys(next).length ? "Saved in this browser." : "Cleared. The agreed thresholds apply.");
  }

  return (
    <article>
      <small>05 / YOUR THRESHOLDS</small>
      <h2>Your stricter thresholds</h2>
      <p>
        The agreed buying thresholds apply to everyone. You can make them stricter for yourself, for
        example by asking for more profit per unit. A looser value has no effect: the agreed threshold
        still applies. Leave a field empty to use the agreed value.
      </p>
      <form onSubmit={submit}>
        <div className="grid2">
          {RULE_INPUTS.map(({ key, label, unit, hint }) => (
            <label key={key}>
              {label}
              <input
                type="number"
                inputMode="decimal"
                min={unit === "units" ? 1 : 0}
                step={unit === "units" ? 1 : "any"}
                value={draft[key]}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              />
              <span className="muted">
                {hint}.{" "}
                {info
                  ? `Agreed: ${ruleText(key, info.agreed[key])}. Applied: ${ruleText(key, info.effective[key])}.`
                  : ""}
              </span>
            </label>
          ))}
        </div>
        <div className="planner-actions">
          <button>Save my thresholds</button>
          <button
            type="button"
            onClick={() => {
              setDraft(toDraft({}));
              onSave({});
              setNotice("Cleared. The agreed thresholds apply.");
            }}
          >
            Clear
          </button>
        </div>
      </form>
      {info && info.ignored.length > 0 && (
        <div className="notice">
          These values are looser than the agreed thresholds, so they have no effect:
          <ul>
            {info.ignored.map((i) => (
              <li key={i.key}>
                {i.label}: yours is {ruleText(i.key, i.value)}, {ruleText(i.key, i.applied)} applies.
              </li>
            ))}
          </ul>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      <p className="muted">
        Saved in this browser only. They apply to the planner trips, the baskets in Goals and the
        Research desk.
      </p>
    </article>
  );
}
