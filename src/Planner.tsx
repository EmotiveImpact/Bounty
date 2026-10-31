import React, { useEffect, useState } from "react";
import {
  api,
  hours,
  loadProfile,
  money,
  percent,
  Profile,
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
  travel: number;
};
export type Economics = {
  units: number;
  sold: number;
  salePrice: number;
  unitCost: number;
  proceeds: number;
  costs: Costs;
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
};
type ModeSummary = {
  mode: string;
  carry: number;
  units: number;
  limit: string;
  travelCost: number;
  travelMinutes: number;
  cashRequired: number;
  contribution: number;
  hourly: number | null;
  reason: string;
};
type Trip = {
  sku: string;
  name: string;
  variant: string;
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
  sample: true;
  salePrice: number | null;
  transport: string;
  carry: number;
  units: number;
  limit: "quantity" | "stock" | "carry" | "storage" | "cash";
  weightKg: number;
  journey: { mode: string; miles: number; cost: number; minutes: number };
  economics: Economics;
  downside: { nothingSells: number; halfSellsUnits: number; halfSells: number };
  thresholds: Thresholds;
  reason: string;
  fits: boolean;
  alert: { eligible: boolean; reasons: string[]; checks: Check[] };
  opportunity: Opportunity;
  compare: {
    heading: string;
    current: ModeSummary;
    alternative: ModeSummary;
    difference: Record<string, number | null>;
    assumptions: string[];
  };
};
export type RuleKey =
  | "minUnitPrice"
  | "maxUnitPrice"
  | "maxWeightKg"
  | "minUnitProfit"
  | "minReturn"
  | "trialUnits";
export type Rules = Partial<Record<RuleKey, number>>;
type RulesInfo = {
  agreed: Record<RuleKey, number>;
  overrides: Rules;
  effective: Record<RuleKey, number>;
  ignored: { key: RuleKey; label: string; value: number; applied: number }[];
};
type PlanResponse = { sample: true; trips: Trip[]; rules: RulesInfo };

/** Pence as pounds, saying "not known" rather than showing a dash. */
export const pounds = (pence: number | null | undefined) =>
  pence === null || pence === undefined || !Number.isFinite(pence)
    ? "not known"
    : money(pence);
const signed = (pence: number | null) =>
  pence === null ? "not comparable" : (pence > 0 ? "+" : "") + money(pence);
const perHour = (pence: number | null) => (pence === null ? "no trip" : money(pence) + " an hour");
const perHourShort = (pence: number | null) => (pence === null ? "no trip" : money(pence) + "/h");
const minutesText = (m: number) => m + " min";

// Member threshold overrides, kept in this browser. The server applies them
// only where they are stricter than the agreed thresholds.
const RULES_KEY = "bounty-rules";
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
const RULE_KEYS = RULE_INPUTS.map((f) => f.key);

export function loadRules(): Rules {
  try {
    const saved = JSON.parse(localStorage.getItem(RULES_KEY) || "{}");
    const rules: Rules = {};
    if (saved && typeof saved === "object")
      for (const key of RULE_KEYS)
        if (typeof saved[key] === "number" && Number.isFinite(saved[key])) rules[key] = saved[key];
    return rules;
  } catch {
    return {};
  }
}
function saveRules(rules: Rules) {
  try {
    localStorage.setItem(RULES_KEY, JSON.stringify(rules));
  } catch {
    /* storage unavailable: the thresholds last for this visit only */
  }
}
function ruleText(key: RuleKey, value: number | undefined) {
  if (value === undefined) return "not set";
  const unit = RULE_INPUTS.find((f) => f.key === key)!.unit;
  if (unit === "pounds") return money(value);
  if (unit === "percent") return percent(value);
  if (unit === "kg") return value + " kg";
  return value + (value === 1 ? " unit" : " units");
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

/**
 * The profile as the API expects it: money in whole pence, rates as shares,
 * and the member's stricter thresholds.
 */
export function planProfile(p: Profile, rules: Rules) {
  return {
    area: p.area,
    budget: toPence(p.budget),
    target: toPence(p.target),
    transport: p.transport,
    carry: p.carry,
    quantity: p.quantity,
    fare: toPence(p.fare),
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
    [between(p.fare, 0, 1000), "Public transport fare must be between £0 and £1,000."],
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

const LIMIT_TEXT: Record<Trip["limit"], string> = {
  quantity: "your maximum units",
  stock: "the stock on the shelf",
  carry: "your carry limit",
  storage: "your storage at home",
  cash: "your available cash",
};

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
  note?: string;
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

// Rates are stored as shares and edited as percentages.
const asPercent = (share: number) => (Number.isFinite(share) ? Math.round(share * 10000) / 100 : NaN);

export default function Planner() {
  const [profile, setProfile] = useState<Profile>(loadProfile);
  const [rules, setRules] = useState<Rules>(loadRules);
  const [result, setResult] = useState<PlanResponse | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const set = (patch: Partial<Profile>) => setProfile({ ...profile, ...patch });
  const problem = profileProblem(profile);

  useEffect(() => saveProfile(profile), [profile]);
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

  const trips = result?.trips ?? [];
  const trip = trips.find((t) => t.sku === selected) ?? trips[0];

  return (
    <div className="planner">
      <div className="layout">
        <aside>
          <small>01 / PARAMETERS</small>
          <h2>Your buying profile</h2>
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
          />
          <NumberField
            label="Maximum units per trip"
            value={profile.quantity}
            step={1}
            min={1}
            onChange={(quantity) => set({ quantity })}
          />
          <NumberField
            label="Storage at home (units)"
            value={profile.storage}
            step={1}
            onChange={(storage) => set({ storage })}
          />
          <fieldset>
            <legend>Travel costs</legend>
            <NumberField
              label="Public transport return fare (£)"
              value={profile.fare}
              onChange={(fare) => set({ fare })}
              note="Used when you travel by public transport."
            />
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
              40p per item sold and a 5% returns allowance. Replace them with your own marketplace's
              fees.
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
        </aside>
        <section>
          <small>02 / RANKED OPPORTUNITIES</small>
          <h2>Local shortlist</h2>
          <p className="notice">
            Sample data: illustrative Leeds offers with modelled sale totals. Stock, prices and
            earnings are simulated, so nothing here is ever a buy alert.
          </p>
          {error && <p role="alert">{error}</p>}
          {trips.map((t) => (
            <button
              key={t.sku}
              type="button"
              className={"card" + (t.sku === trip?.sku ? " active" : "")}
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
                </span>
                <em className={t.fits ? "ok" : "warn"}>{t.reason}</em>
              </span>
              <span>
                <b>{money(t.economics.contribution)}</b>
                <small>{perHour(t.economics.hourly)}</small>
              </span>
            </button>
          ))}
          {trip && <TripView key={trip.sku} trip={trip} profile={profile} />}
          <BasketsLink />
          <StricterThresholds
            rules={rules}
            info={result?.rules ?? null}
            onSave={(next) => {
              saveRules(next);
              setRules(next);
            }}
          />
        </section>
      </div>
    </div>
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

function TripView({ trip: t, profile }: { trip: Trip; profile: Profile }) {
  const e = t.economics;
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
        },
      });
      setLedger({
        busy: false,
        notice:
          "Tracked in the ledger as trip " +
          saved.id +
          ". These are predictions from sample data, not realised cash: record receipts and payouts in Ledger.",
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
      </p>
      <p>
        {t.variant} at {t.shop}, {t.miles} miles from the centre of {t.area}.{" "}
        {t.units
          ? `${t.units} unit${t.units === 1 ? "" : "s"} (${t.weightKg} kg), limited by ${LIMIT_TEXT[t.limit]}. Return journey by ${t.journey.mode.toLowerCase()}: ${t.journey.miles} miles, ${t.journey.minutes} minutes.`
          : `No units fit: limited by ${LIMIT_TEXT[t.limit]}.`}
      </p>
      {t.reason === "Outside your area" && (
        <p className="notice">
          This shop is outside your area. Travel is measured from the centre of {t.area}, so the
          figures leave out your journey to get there.
        </p>
      )}
      <div className="grid2">
        <div>
          <h3>Money</h3>
          <Figures
            rows={[
              ["Cash required before payout", <strong key="c">{money(e.cashRequired)}</strong>],
              ["Stock", money(e.costs.stock)],
              ["Packaging", money(e.costs.packaging)],
              ["Parcel costs", money(e.costs.postage)],
              ["Marketplace fees", money(e.costs.fees)],
              ["Returns allowance", money(e.costs.returns)],
              ["Travel (one journey)", money(e.costs.travel)],
              ["Travel per unit", money(e.journeyPerUnit)],
              ["Proceeds if every unit sells (estimate)", money(e.proceeds)],
              ["Contribution", <strong key="p">{money(e.contribution)}</strong>],
            ]}
          />
        </div>
        <div>
          <h3>Time and downside</h3>
          <Figures
            rows={[
              ["Active hours", hours(e.activeMinutes)],
              ["Earnings per hour", perHour(e.hourly)],
              ["Loss if nothing sells", money(t.downside.nothingSells)],
              [
                `If only ${t.downside.halfSellsUnits} of ${t.units} sell`,
                money(t.downside.halfSells),
              ],
              ["Break-even sale price per unit", pounds(e.breakEvenSale)],
              ["Sale price used per unit", pounds(t.salePrice)],
              ["Shelf price per unit", money(t.buy)],
            ]}
          />
        </div>
      </div>

      <h3>Buying thresholds</h3>
      <p>
        Profit per unit after fees, postage, packaging, returns and the unit's share of travel:{" "}
        {pounds(t.thresholds.unitProfit)}. Return on the purchase price:{" "}
        {t.thresholds.returnOnCost === null ? "not known" : percent(t.thresholds.returnOnCost)}.
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
          {t.weight} kg. {t.stock} assumed on the shelf.
        </p>
        <p>
          Fees use your assumptions: {percent(profile.feeRate)} of the sale plus{" "}
          {money(profile.feeFixed)} per item sold, and a {percent(profile.returnsRate)} returns
          allowance. Contribution assumes every unit sells; the loss if nothing sells and the
          half-sold figure show the downside. Postage is paid at dispatch, before the payout, so it
          counts in the cash required.
        </p>
        <p>
          Time: a return journey of {t.journey.minutes} minutes, 10 minutes in the shop and{" "}
          {t.handlingMinutes} minutes per unit to list, pack and post.
        </p>
      </details>

      <button type="button" onClick={track} disabled={ledger.busy || !t.units}>
        Track this trip in the ledger
      </button>
      {!t.units && <p className="muted">No units fit, so there is nothing to track.</p>}
      {ledger.notice && <p role="status">{ledger.notice}</p>}
    </article>
  );
}

function DriveComparison({ compare: c }: { compare: Trip["compare"] }) {
  const a = c.current;
  const b = c.alternative;
  const d = c.difference;
  const rows: [string, string, string, string][] = [
    ["Carry limit", a.carry + " kg", b.carry + " kg", ""],
    ["Units", String(a.units), String(b.units), (d.units! > 0 ? "+" : "") + d.units],
    ["Travel cost", money(a.travelCost), money(b.travelCost), signed(d.travelCost)],
    [
      "Travel time",
      minutesText(a.travelMinutes),
      minutesText(b.travelMinutes),
      (d.travelMinutes! > 0 ? "+" : "") + d.travelMinutes + " min",
    ],
    ["Cash required before payout", money(a.cashRequired), money(b.cashRequired), signed(d.cashRequired)],
    ["Contribution", money(a.contribution), money(b.contribution), signed(d.contribution)],
    ["Earnings per hour", perHourShort(a.hourly), perHourShort(b.hourly), signed(d.hourly)],
  ];
  return (
    <>
      <h3>{c.heading}</h3>
      {VEHICLES.has(a.mode) && (
        <p>You already travel by {a.mode.toLowerCase()}, so this shows the same trip by public transport.</p>
      )}
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
        Saved in this browser only. They apply to the planner trips and the baskets in Goals.
      </p>
    </article>
  );
}
