import React, { useEffect, useState } from "react";
import { api, dateTime, hours, loadMemberRules, loadProfile, money, percent, toPence } from "./api";
import {
  AccessBadges,
  AccessNeed,
  CashTiming,
  Checked,
  Costs,
  FARE_UNKNOWN,
  Opportunity,
  Payout,
  Thresholds,
  TierBadge,
  byMode,
  cashSentence,
  checkedText,
  paymentText,
  payoutSentence,
  planProfile,
  plural,
  pounds,
  profileProblem,
} from "./Planner";
import "./Planner.css";

type Goals = {
  targetType: "income" | "savings";
  monthlyTarget: number;
  dispatchDays: number[];
  storageUnits: number;
  cashNeededBy: string | null;
  daysToSell: number;
  deliveryDays: number;
  payoutDelayDays: number;
  updated: string | null;
};
type Draft = {
  targetType: "income" | "savings";
  monthlyTarget: string;
  dispatchDays: number[];
  storageUnits: string;
  cashNeededBy: string;
  daysToSell: string;
  deliveryDays: string;
  payoutDelayDays: string;
};
type Timing = CashTiming;
// Payout timing for a basket: the cash is back once the last unit sells.
type BasketTiming = {
  payout: Payout;
  cash: Timing;
  payoutDays: number | null;
  daysToSell: number | null;
  daysToSellOneUnit: number;
  units: number;
  cashNeededBy: string | null;
};
type BasketItem = {
  sku: string;
  name: string;
  variant: string;
  shop: string;
  units: number;
  weightKg: number;
  travelShare: number;
  cashRequired: number;
  contribution: number;
  unitProfit: number | null;
  returnOnCost: number | null;
  returnsRate: number;
  thresholds: Thresholds;
  opportunity: Opportunity;
  accessNeeds: AccessNeed[];
  checked: Checked;
  mainUncertainty: string;
};
type Basket = {
  id: string;
  items: BasketItem[];
  shops: string[];
  journey: { mode: string; miles: number; cost: number; minutes: number; extraShops: number };
  units: number;
  storage: { used: number; limit: number };
  weightKg: number;
  economics: {
    units: number;
    proceeds: number;
    costs: Costs;
    totalCosts: number;
    contribution: number;
    cashRequired: number;
    journeyPerUnit: number;
    activeMinutes: number;
    hourly: number | null;
    unsoldLoss: number;
  };
  // halfSellsUnits: units sold in the half-sold case (half of each item's
  // units, rounded down), so the label matches the figure.
  downside: { nothingSells: number; halfSells: number; halfSellsUnits?: number };
  timing: BasketTiming;
  reasons: string[];
  recommended: boolean;
};
type BasketResponse = {
  sample: true;
  constraints: {
    budget: number;
    carry: number;
    carryEntered: number;
    storage: number;
    profileStorage: number;
    goalsStorage: number;
    quantity: number;
    unitCap: number;
    trialUnits: number;
    sellWindowWeeks: number;
    hourlyTarget: number;
    transport: string;
    fareMissing: boolean;
    area: string;
  };
  approximation: string;
  baskets: Basket[];
  bestSingle: Basket | null;
  recommended: string | null;
  // rejected: outside the buying thresholds; fareNeeded: waits for a
  // public transport fare (a blank fare is never counted as free).
  excluded: { sku: string; name: string; shop: string; reason: string; rejected?: boolean; fareNeeded?: boolean }[];
  searched: number;
  truncated: boolean;
  timing: BasketTiming; // for one unit; each basket carries its own
  rules: { ignored: { key: string; label: string }[] };
};
// The ledger summary (server/ledger.mjs summary). Potential proceeds count
// only live-evidence predictions; potentialProceedsLeftOut says how many
// open trips were left out, sample trips among them.
type Summary = {
  month: string;
  realisedEarnings: number;
  householdSavings: number;
  householdSavingsGross?: number;
  householdTripCosts?: number;
  pendingPayouts: number;
  potentialProceeds: number;
  potentialProceedsLeftOut?: { sample?: number; basisUnknown?: number; nothingBought?: number };
  cashTiedUp?: number;
  unsoldUnits?: number;
  realisedMinutes?: number;
  realisedHourly?: number | null;
};
type Target = {
  id: number;
  name: string;
  amount: number;
  deadline: string | null;
  start: string;
  payouts: number;
  costs: number;
  received: number;
  shared: number;
  counted: number;
  remaining: number;
  status: "reached" | "in progress" | "missed";
  daysLeft: number | null;
};
type Targets = { targets: Target[]; basis: string };

// Monday first, as a UK week is usually shown. Values are JavaScript weekday
// numbers (0 is Sunday).
const WEEKDAYS: [number, string][] = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [0, "Sun"],
];

const toDraft = (g: Goals): Draft => ({
  targetType: g.targetType,
  monthlyTarget: String(g.monthlyTarget / 100),
  dispatchDays: [...g.dispatchDays],
  storageUnits: String(g.storageUnits),
  cashNeededBy: g.cashNeededBy ?? "",
  daysToSell: String(g.daysToSell),
  deliveryDays: String(g.deliveryDays),
  payoutDelayDays: String(g.payoutDelayDays),
});

// Today's date in London (YYYY-MM-DD), the same "today" the server checks
// dates against.
const londonToday = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

function thisMonth() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

/** "October 2026" for "2026-10", as people write a month. */
const monthFormat = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
function monthText(month: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  const ms = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, 15) : NaN;
  return Number.isFinite(ms) ? monthFormat.format(new Date(ms)) : "the month chosen";
}

/** The draft as the API expects it, or a plain-language problem. */
function goalsBody(d: Draft): { body?: Omit<Goals, "updated">; problem?: string } {
  const whole = (v: string, label: string, max: number) => {
    const n = Number(v);
    return v.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= max
      ? n
      : label + " must be a whole number from 0 to " + max + ".";
  };
  const target = Number(d.monthlyTarget);
  if (d.monthlyTarget.trim() === "" || !Number.isFinite(target) || target < 0 || target > 100000)
    return { problem: "Monthly target must be between £0 and £100,000." };
  const fields = {
    storageUnits: whole(d.storageUnits, "Storage", 100000),
    daysToSell: whole(d.daysToSell, "Days to sell", 365),
    deliveryDays: whole(d.deliveryDays, "Delivery days", 60),
    payoutDelayDays: whole(d.payoutDelayDays, "Payout delay", 60),
  };
  const problem = Object.values(fields).find((v) => typeof v === "string");
  if (problem) return { problem: problem as string };
  if (d.cashNeededBy && d.cashNeededBy < londonToday())
    return { problem: "The date you need the cash back must be today or later." };
  return {
    body: {
      targetType: d.targetType,
      monthlyTarget: toPence(target),
      dispatchDays: [...d.dispatchDays].sort((a, b) => a - b),
      cashNeededBy: d.cashNeededBy || null,
      ...(fields as Record<keyof typeof fields, number>),
    },
  };
}

/** The monthly goal, storage and posting-day settings. Shown on the Profile
 * screen; the old Goals screen embeds it above its baskets. */
export function GoalsSettings({
  onLoaded,
  onSaved,
  savedNote = "Saved. Money and trip timing now use these.",
}: {
  onLoaded?: (g: Goals) => void;
  onSaved?: (g: Goals) => void;
  savedNote?: string;
}) {
  const [goals, setGoals] = useState<Goals | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [goalsNotice, setGoalsNotice] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    api<Goals>("goals")
      .then((g) => {
        if (!active) return;
        setGoals(g);
        setDraft(toDraft(g));
        onLoaded?.(g);
      })
      .catch((e) => active && setGoalsNotice("Could not load your goals: " + (e as Error).message));
    return () => {
      active = false;
    };
  }, []);

  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    if (!draft) return;
    const { body, problem } = goalsBody(draft);
    if (!body) {
      setGoalsNotice(problem!);
      return;
    }
    setSaving(true);
    try {
      const saved = await api<Goals>("goals", body, "PUT");
      setGoals(saved);
      setDraft(toDraft(saved));
      setGoalsNotice(savedNote);
      onSaved?.(saved);
    } catch (e) {
      setGoalsNotice("Could not save your goals. " + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
      <section>
        <small>Your goals</small>
        <h2>Monthly goal and selling rhythm</h2>
        {!draft ? (
          <p>{goalsNotice || "Loading your goals."}</p>
        ) : (
          <form onSubmit={save} noValidate>
            <div className="grid2">
              <label>
                Goal type
                <select
                  value={draft.targetType}
                  onChange={(e) => setDraft({ ...draft, targetType: e.target.value as Draft["targetType"] })}
                >
                  <option value="income">Income from resale</option>
                  <option value="savings">Household savings</option>
                </select>
              </label>
              <label>
                Monthly target (£)
                <input
                  type="number"
                  min={0}
                  step="any"
                  inputMode="decimal"
                  value={draft.monthlyTarget}
                  onChange={(e) => setDraft({ ...draft, monthlyTarget: e.target.value })}
                />
              </label>
              <label>
                Storage at home (units)
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={draft.storageUnits}
                  onChange={(e) => setDraft({ ...draft, storageUnits: e.target.value })}
                />
                <span className="muted">Baskets use the smaller of this and the Planner storage.</span>
              </label>
              <label>
                Date you need the cash back
                <input
                  type="date"
                  min={londonToday()}
                  value={draft.cashNeededBy}
                  onChange={(e) => setDraft({ ...draft, cashNeededBy: e.target.value })}
                />
                <span className="muted">Leave empty if there is no date.</span>
              </label>
            </div>
            <fieldset>
              <legend>Dispatch days (when you can post parcels)</legend>
              <div className="planner-days">
                {WEEKDAYS.map(([day, name]) => (
                  <label key={day}>
                    <input
                      type="checkbox"
                      checked={draft.dispatchDays.includes(day)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          dispatchDays: e.target.checked
                            ? [...draft.dispatchDays, day]
                            : draft.dispatchDays.filter((d) => d !== day),
                        })
                      }
                    />
                    {name}
                  </label>
                ))}
              </div>
              {draft.dispatchDays.length === 0 && (
                <p className="warn">With no dispatch days, a payout date cannot be scheduled.</p>
              )}
            </fieldset>
            <fieldset>
              <legend>Your timing assumptions (calendar days)</legend>
              <div className="grid2">
                <label>
                  Days to sell
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={draft.daysToSell}
                    onChange={(e) => setDraft({ ...draft, daysToSell: e.target.value })}
                  />
                </label>
                <label>
                  Delivery days
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={draft.deliveryDays}
                    onChange={(e) => setDraft({ ...draft, deliveryDays: e.target.value })}
                  />
                </label>
                <label>
                  Payout delay after delivery
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={draft.payoutDelayDays}
                    onChange={(e) => setDraft({ ...draft, payoutDelayDays: e.target.value })}
                  />
                </label>
              </div>
              <p className="muted">
                Sample defaults: 7 days to sell, 2 days for delivery and 2 days before the marketplace
                pays out. These are assumptions, not evidence for any item.
              </p>
            </fieldset>
            <button disabled={saving}>Save goals</button>
            {goals?.updated && <span className="muted"> Last saved {dateTime(goals.updated)}.</span>}
            {goalsNotice && <p role="status">{goalsNotice}</p>}
          </form>
        )}
      </section>

  );
}

export default function Goals() {
  const [goals, setGoals] = useState<Goals | null>(null);
  const [month, setMonth] = useState(thisMonth);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryError, setSummaryError] = useState("");
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    setSummary(null);
    setSummaryError("");
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    api<Summary>("ledger/summary?month=" + encodeURIComponent(month))
      .then((s) => active && setSummary(s))
      .catch((e) => active && setSummaryError((e as Error).message));
    return () => {
      active = false;
    };
  }, [month, version]);

  return (
    <div className="planner goals">
      <GoalsSettings
        savedNote="Goals saved. The baskets below now use them."
        onLoaded={setGoals}
        onSaved={(g) => {
          setGoals(g);
          setVersion((v) => v + 1);
        }}
      />
      <NamedGoals version={version} />

      <BasketSection version={version} />

      <section>
        <small>This month</small>
        <h2>Progress this month</h2>
        <label className="planner-month">
          Month
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </label>
        {summaryError ? (
          <p className="notice">
            The ledger summary is not available yet ({summaryError}). Progress will appear here once
            the ledger records trips.
          </p>
        ) : !summary ? (
          <p className="muted">Loading the ledger summary.</p>
        ) : (
          <Progress summary={summary} goals={goals} />
        )}
      </section>
    </div>
  );
}

/** Several items on one shopping trip, under one cash limit. Shown on the
 * Trip planner; uses the goals timing and the Planner profile. */
export function BasketSection({ version = 0 }: { version?: number }) {
  const [baskets, setBaskets] = useState<BasketResponse | null>(null);
  const [basketError, setBasketError] = useState("");
  const [run, setRun] = useState(0);

  useEffect(() => {
    let active = true;
    const profile = loadProfile();
    const problem = profileProblem(profile);
    if (problem) {
      setBaskets(null);
      setBasketError("Your Planner profile needs fixing first: " + problem);
      return;
    }
    api<BasketResponse>("baskets", { profile: planProfile(profile, loadMemberRules()) })
      .then((r) => {
        if (!active) return;
        setBaskets(r);
        setBasketError("");
      })
      .catch((e) => {
        if (!active) return;
        setBaskets(null);
        setBasketError((e as Error).message);
      });
    return () => {
      active = false;
    };
  }, [version, run]);

  return (
    <section id="basket-plan">
      <small>Basket plan</small>
      <h2>One shopping trip, one cash limit</h2>
      <p>
        Everything in a basket is bought on one shopping trip: one shared journey and one cash
        limit for the whole basket. Your cash, carry limit, maximum units and transport come from the
        planner above, and your stricter thresholds from Profile and settings.
      </p>
      <p className="notice">
        Sample data: illustrative Leeds offers with modelled sale totals. A basket is never a buy
        alert.
      </p>
      <button type="button" onClick={() => setRun((v) => v + 1)}>
        Recalculate
      </button>
      {basketError && <p role="alert">{basketError}</p>}
      {baskets && <BasketPlan plan={baskets} />}
    </section>
  );
}

function BasketPlan({ plan }: { plan: BasketResponse }) {
  const c = plan.constraints;
  const pick = plan.baskets.find((b) => b.recommended) || (plan.bestSingle?.recommended ? plan.bestSingle : null);
  const singleShown = plan.bestSingle && plan.baskets.some((b) => b.id === plan.bestSingle!.id);
  return (
    <>
      <dl className="planner-figures goals-limits">
        <div>
          <dt>Cash limit for the whole basket</dt>
          <dd>{money(c.budget)}</dd>
        </div>
        <div>
          <dt>Load limit</dt>
          <dd>
            {c.carry} kg
            {c.carry !== c.carryEntered ? ` (your ${c.carryEntered} kg, ${byMode(c.transport)})` : ""}
          </dd>
        </div>
        <div>
          <dt>Units on one trip</dt>
          <dd>
            up to {c.unitCap} (maximum units {c.quantity}, storage {c.storage})
          </dd>
        </div>
        <div>
          <dt>Each item, first purchase</dt>
          <dd>
            at most {plural(c.trialUnits, "unit")} (trial batch), and no more than its sales rate
            supports in {plural(c.sellWindowWeeks, "week")}
          </dd>
        </div>
        <div>
          <dt>Storage limit</dt>
          <dd>
            {plural(c.storage, "unit")}, the smaller of Planner {c.profileStorage} and goals {c.goalsStorage}
          </dd>
        </div>
        <div>
          <dt>Transport</dt>
          <dd>{c.transport}</dd>
        </div>
        <div>
          <dt>Hourly target</dt>
          <dd>{money(c.hourlyTarget)} an hour</dd>
        </div>
      </dl>
      <p className="muted">{plan.approximation}</p>
      {plan.rules.ignored.length > 0 && (
        <p className="notice">
          Some of your thresholds are looser than the agreed ones, so they have no effect here:{" "}
          {plan.rules.ignored.map((i) => i.label.toLowerCase()).join(", ")}. Change them in the
          Planner tab.
        </p>
      )}
      <p>
        <strong>Cash back for one unit:</strong> {payoutSentence(plan.timing.payout)}{" "}
        <span className={plan.timing.cash.status === "late" ? "warn" : ""}>
          {cashSentence(plan.timing.cash, plan.timing.cashNeededBy, plan.timing.payout.date)}
        </span>{" "}
        Time until payment: {paymentText(plan.timing.payoutDays, plan.timing.payout.date)}. Several
        units can take longer to sell, so each basket shows its own payout.
      </p>
      {c.fareMissing && (
        <p className="notice warn">
          No public transport fare is entered in the Planner. A blank fare is never counted as free:
          each item's profit per unit, the basket's contribution and its earnings per hour are{" "}
          {FARE_UNKNOWN}, so nothing is put in a basket. Enter your return fare (or tick that your
          travel is free) in the Planner, then recalculate.
        </p>
      )}
      {plan.timing.cash.status === "late" && (
        <p className="notice warn">
          Warning: the payout is expected after the date you need the cash, so no basket is
          recommended.
        </p>
      )}
      {pick ? (
        <p className="ok">
          Best fit for your profile: {basketTitle(pick)}. This is sample data and still not a buy
          alert.
        </p>
      ) : c.fareMissing && plan.excluded.some((e) => e.fareNeeded) ? (
        <p className="warn">
          Enter your return fare in the Planner to see whether these trips meet your thresholds:{" "}
          {plan.excluded
            .filter((e) => e.fareNeeded)
            .map((e) => e.name)
            .join(", ")}
          .
        </p>
      ) : plan.baskets.length ? (
        <p className="warn">
          No basket meets every condition (positive contribution, your hourly target, your buying
          thresholds, the trial batch and the cash date), so none is recommended. The closest
          options are shown with the reasons.
        </p>
      ) : (
        <p className="warn">
          No basket fits your cash, carrying, storage and unit limits with every item inside your
          buying thresholds. The lists below say why each offer is left out.
        </p>
      )}
      {plan.truncated && (
        <p className="notice">
          The search stopped after {plan.searched.toLocaleString("en-GB")} baskets, so a better one
          may exist.
        </p>
      )}
      {plan.baskets.length > 0 && <h3>Top baskets</h3>}
      {plan.baskets.map((b, i) => (
        <BasketCard key={b.id} basket={b} rank={i + 1} />
      ))}
      {plan.bestSingle && (
        <>
          <h3>Best single-item trip</h3>
          {singleShown ? (
            <p className="muted">
              The best single-item trip, {basketTitle(plan.bestSingle)}, is already in the top
              baskets above.
            </p>
          ) : (
            <BasketCard basket={plan.bestSingle} />
          )}
        </>
      )}
      {plan.excluded.some((e) => e.rejected) && (
        <>
          <h3>Rejected: outside your buying thresholds</h3>
          <p className="muted">
            These never enter a basket: each item must be inside every buying threshold that
            applies to you, including at least the minimum profit per unit after its share of the
            journey.
          </p>
          <ul>
            {plan.excluded
              .filter((e) => e.rejected)
              .map((e) => (
                <li key={e.sku}>
                  {e.name} at {e.shop}: {e.reason}.
                </li>
              ))}
          </ul>
        </>
      )}
      {plan.excluded.some((e) => e.fareNeeded) && (
        <>
          <h3>Waiting for your public transport fare</h3>
          <p className="muted">
            These clear your buying thresholds before travel. With your fare as their share of the
            journey they may not, so they are not in any basket until you enter it.
          </p>
          <ul>
            {plan.excluded
              .filter((e) => e.fareNeeded)
              .map((e) => (
                <li key={e.sku}>
                  {e.name} at {e.shop}: {e.reason}.
                </li>
              ))}
          </ul>
        </>
      )}
      {plan.excluded.some((e) => !e.rejected && !e.fareNeeded) && (
        <>
          <h3>Not in any basket</h3>
          <ul>
            {plan.excluded
              .filter((e) => !e.rejected && !e.fareNeeded)
              .map((e) => (
                <li key={e.sku}>
                  {e.name} at {e.shop}: {e.reason}.
                </li>
              ))}
          </ul>
        </>
      )}
    </>
  );
}

const basketTitle = (b: Basket) => b.items.map((it) => it.units + " × " + it.name).join(" and ");

function BasketCard({ basket: b, rank }: { basket: Basket; rank?: number }) {
  const e = b.economics;
  const late = b.timing.cash.status === "late";
  return (
    <article className={"planner-basket" + (b.recommended ? " recommended" : "")}>
      <p className="planner-badges">
        {rank && <span className="badge">#{rank}</span>}
        <span className="badge sample">Sample</span>
        {b.recommended ? (
          <span className="badge ok">Best fit for your profile</span>
        ) : (
          <span className="badge warn">Not recommended</span>
        )}
        {late && <span className="badge warn">Payout late by {plural(b.timing.cash.daysLate ?? 0, "day")}</span>}
      </p>
      <h3>{basketTitle(b)}</h3>
      <p className="muted">
        One trip to {b.shops.join(" and ")} {byMode(b.journey.mode)}: {b.journey.miles}{" "}
        miles there and back, {b.journey.minutes} minutes travelling
        {b.journey.extraShops
          ? `, including ${b.journey.extraShops} extra shop${b.journey.extraShops === 1 ? "" : "s"}`
          : ""}
        . {plural(b.units, "unit")}, {b.weightKg} kg. Storage used: {b.storage.used} of{" "}
        {plural(b.storage.limit, "unit")}.
      </p>
      <div className="planner-kpis">
        <div className="planner-kpi">
          <small>Cash needed</small>
          <b>{money(e.cashRequired)}</b>
          <span>before any payout</span>
        </div>
        <div className={"planner-kpi" + (e.contribution > 0 ? " gain" : e.contribution < 0 ? " loss" : "")}>
          <small>If every unit sells</small>
          <b>{money(e.contribution)}</b>
          <span>{e.hourly === null ? "earnings an hour not known" : money(e.hourly) + " an hour"}</span>
        </div>
        <div className="planner-kpi">
          <small>If nothing sells</small>
          <b>{money(b.downside.nothingSells)}</b>
          <span>the most you could lose</span>
        </div>
        <div className={"planner-kpi" + (late ? " loss" : "")}>
          <small>Cash back</small>
          <b>{b.timing.payout.date ? dateTime(b.timing.payout.date) : "Not scheduled"}</b>
          <span>{late ? `${plural(b.timing.cash.daysLate ?? 0, "day")} late` : paymentText(b.timing.payoutDays, b.timing.payout.date)}</span>
        </div>
      </div>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" className="num">
                Units
              </th>
              <th scope="col" className="num">
                Cash
              </th>
              <th scope="col" className="num">
                Travel share
              </th>
              <th scope="col" className="num">
                Profit per unit
              </th>
              <th scope="col" className="num">
                Return
              </th>
              <th scope="col">Tier</th>
            </tr>
          </thead>
          <tbody>
            {b.items.map((it) => (
              <tr key={it.sku}>
                <td>
                  {it.name}
                  <span className="muted"> at {it.shop}</span>
                  <span className="planner-badges">
                    <AccessBadges needs={it.accessNeeds} />
                  </span>
                  <span className="muted planner-cell-note">
                    Price checked {checkedText(it.checked.price)}, stock checked{" "}
                    {checkedText(it.checked.stock)}.
                  </span>
                </td>
                <td className="num">{it.units}</td>
                <td className="num">{money(it.cashRequired)}</td>
                <td className="num">{money(it.travelShare)}</td>
                <td className="num">{pounds(it.unitProfit)}</td>
                <td className="num">{it.returnOnCost === null ? "not known" : percent(it.returnOnCost)}</td>
                <td>
                  <TierBadge tier={it.opportunity.tier} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">
        Main uncertainty: {[...new Set(b.items.map((it) => it.mainUncertainty))].join("; ")}.
      </p>
      <details className="basket-breakdown">
        <summary>Full costs, downside and timing</summary>
      <div className="grid2">
        <dl className="planner-figures">
          <dt>Cash required before payout</dt>
          <dd>
            <strong>{money(e.cashRequired)}</strong>
          </dd>
          <dt>Stock</dt>
          <dd>{money(e.costs.stock)}</dd>
          <dt>Packaging</dt>
          <dd>{money(e.costs.packaging)}</dd>
          <dt>Parcel costs</dt>
          <dd>{money(e.costs.postage)}</dd>
          <dt>Marketplace fees</dt>
          <dd>{money(e.costs.fees)}</dd>
          <dt>Returns allowance</dt>
          <dd>{money(e.costs.returns)}</dd>
          <dt>Travel (one journey)</dt>
          <dd>{money(e.costs.travel)}</dd>
        </dl>
        <dl className="planner-figures">
          <dt>Contribution if every unit sells</dt>
          <dd>
            <strong>{money(e.contribution)}</strong>
          </dd>
          <dt>Active hours</dt>
          <dd>{hours(e.activeMinutes)}</dd>
          <dt>Earnings per hour</dt>
          <dd>{e.hourly === null ? "not known" : money(e.hourly) + " an hour"}</dd>
          <dt>Loss if nothing sells</dt>
          <dd>{money(b.downside.nothingSells)}</dd>
          <dt>
            {typeof b.downside.halfSellsUnits === "number"
              ? `If only ${b.downside.halfSellsUnits} of ${b.units} sell`
              : "If only half of each item sells"}
          </dt>
          <dd>{money(b.downside.halfSells)}</dd>
          <dt>Days until the last unit sells</dt>
          <dd>
            {b.timing.daysToSell === null
              ? "not known: the sales rate is unknown"
              : plural(b.timing.daysToSell, "day") +
                (b.timing.daysToSell > b.timing.daysToSellOneUnit
                  ? ` (your Goals assume ${plural(b.timing.daysToSellOneUnit, "day")} for one unit)`
                  : "")}
          </dd>
          <dt>Time until payment</dt>
          <dd>{paymentText(b.timing.payoutDays, b.timing.payout.date)}</dd>
          <dt>Cash back</dt>
          <dd className={late ? "warn" : ""}>
            {b.timing.payout.date ? dateTime(b.timing.payout.date) : "cannot be scheduled"}
            {late
              ? `, ${plural(b.timing.cash.daysLate ?? 0, "day")} late`
              : b.timing.cash.status === "on time"
                ? ", on time"
                : b.timing.payout.date
                  ? ", no cash date set"
                  : ""}
          </dd>
        </dl>
      </div>
      </details>
      {b.reasons.length > 0 && (
        <ul className="checks">
          {b.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

function Progress({ summary: s, goals }: { summary: Summary; goals: Goals | null }) {
  const savings = goals?.targetType === "savings";
  const target = goals?.monthlyTarget ?? 0;
  // Only realised figures count: payouts less costs for income, recorded
  // savings for a household goal. Pending payouts and potential proceeds never do.
  const realised = savings ? s.householdSavings : s.realisedEarnings;
  const share = target > 0 ? Math.max(0, realised) / target : 0;
  const leftOut = s.potentialProceedsLeftOut;
  const leftOutText = [
    leftOut?.sample ? plural(leftOut.sample, "sample trip") + " (illustrative figures)" : "",
    leftOut?.basisUnknown ? plural(leftOut.basisUnknown, "open trip") + " with no record of live evidence" : "",
    leftOut?.nothingBought ? plural(leftOut.nothingBought, "open trip") + " with nothing bought yet" : "",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <>
      {target > 0 ? (
        <>
          <progress className="planner-progress" max={target} value={Math.min(target, Math.max(0, realised))} />
          <p>
            {money(realised)} of {money(target)} {savings ? "household savings" : "realised earnings"}{" "}
            in {monthText(s.month)} ({percent(share)} of your target).
          </p>
        </>
      ) : (
        <p>Set a monthly target above to track progress.</p>
      )}
      <dl className="planner-figures">
        <dt>Realised earnings</dt>
        <dd>{money(s.realisedEarnings)}</dd>
        <dt>Household savings after trip costs (not earnings)</dt>
        <dd>{money(s.householdSavings)}</dd>
        {typeof s.householdSavingsGross === "number" && (
          <>
            <dt>Household savings before trip costs</dt>
            <dd>{money(s.householdSavingsGross)}</dd>
            <dt>Household trip costs</dt>
            <dd>{money(s.householdTripCosts ?? 0)}</dd>
          </>
        )}
        <dt>Pending payouts (sold, not yet paid: not counted)</dt>
        <dd>{money(s.pendingPayouts)}</dd>
        <dt>
          Potential proceeds from live-evidence trips (estimate: not counted)
          {leftOutText && <span className="muted planner-cell-note">Left out: {leftOutText}.</span>}
        </dt>
        <dd>{money(s.potentialProceeds)}</dd>
        {typeof s.cashTiedUp === "number" && (
          <>
            <dt>Cash tied up in open trips</dt>
            <dd>{money(s.cashTiedUp)}</dd>
          </>
        )}
      </dl>
      <p className="muted">
        Only realised figures count towards progress:{" "}
        {savings ? "household savings you recorded, less household trip costs" : "payouts received less recorded costs"}. Pending
        payouts and potential proceeds are shown separately and are not counted until paid. Sample
        trips never count in potential proceeds.
        {savings ? "" : " Household savings are never counted as earnings."}
      </p>
    </>
  );
}

const STATUS_TEXT: Record<Target["status"], string> = {
  reached: "Reached",
  "in progress": "In progress",
  missed: "Deadline passed",
};

/** Named goals: what the money is for, counting only cash received by the deadline. */
function NamedGoals({ version }: { version: number }) {
  const [data, setData] = useState<Targets | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState({ name: "", amount: "", deadline: "", start: "" });
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api<Targets>("goals/targets")
      .then((r) => {
        if (!active) return;
        setData(r);
        setError("");
      })
      .catch((e) => active && setError((e as Error).message));
    return () => {
      active = false;
    };
  }, [version]);

  async function add(ev: React.FormEvent) {
    ev.preventDefault();
    const amount = Number(draft.amount);
    if (!draft.name.trim()) return setNotice("Say what the money is for.");
    if (draft.amount.trim() === "" || !Number.isFinite(amount) || amount <= 0 || amount > 100000)
      return setNotice("Amount must be between £0.01 and £100,000.");
    const today = londonToday();
    if (draft.deadline && draft.deadline < today) return setNotice("The deadline must be today or later.");
    if (draft.start && draft.start > today)
      return setNotice("The date to count cash from cannot be in the future.");
    setBusy(true);
    try {
      const r = await api<Targets & { id: number }>("goals/targets", {
        name: draft.name.trim(),
        amount: toPence(amount),
        deadline: draft.deadline || null,
        start: draft.start || null,
      });
      setData(r);
      setDraft({ name: "", amount: "", deadline: "", start: "" });
      setNotice("Goal added.");
    } catch (e) {
      setNotice("Could not add the goal. " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(t: Target) {
    setBusy(true);
    try {
      setData(await api<Targets>("goals/targets/" + t.id, {}, "DELETE"));
      setNotice(`Removed "${t.name}".`);
    } catch (e) {
      setNotice("Could not remove the goal. " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <small>What the money is for</small>
      <h2>Named goals and deadlines</h2>
      <p>
        Name what the money is for, such as a hobby, fuel or a bill like car insurance. A goal with a
        deadline counts only cash received by that date: payouts less what you spent, never sales
        waiting to be paid or estimates. Fuel for a collection run is already a cost of that trip, so
        it is not counted twice.
      </p>
      {error && <p role="alert">Could not load your named goals: {error}</p>}
      {data && data.targets.length === 0 && <p className="muted">No named goals yet.</p>}
      {data?.targets.map((t) => (
        <article key={t.id} className="planner-target">
          <p className="planner-badges">
            <span className={"badge " + (t.status === "reached" ? "ok" : t.status === "missed" ? "warn" : "")}>
              {STATUS_TEXT[t.status]}
            </span>
          </p>
          <h3>{t.name}</h3>
          <progress className="planner-progress" max={t.amount} value={Math.min(t.amount, t.counted)} />
          <p>
            {money(t.counted)} of {money(t.amount)} received
            {t.deadline
              ? t.daysLeft !== null && t.daysLeft >= 0
                ? ` by ${dateTime(t.deadline)} (${plural(t.daysLeft, "day")} left)`
                : ` by ${dateTime(t.deadline)}`
              : " so far (no deadline)"}
            . Still needed: {money(t.remaining)}.
          </p>
          <p className="muted">
            Counting from {dateTime(t.start)}: payouts {money(t.payouts)}, less costs {money(t.costs)}.
            {t.shared > 0 ? ` ${money(t.shared)} of that already counts towards an earlier goal.` : ""}
          </p>
          <button type="button" onClick={() => remove(t)} disabled={busy}>
            Remove
          </button>
        </article>
      ))}
      <form onSubmit={add} className="planner-target-form" noValidate>
        <div className="grid2">
          <label>
            What the money is for
            <input
              value={draft.name}
              maxLength={80}
              placeholder="Car insurance"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            Amount (£)
            <input
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={draft.amount}
              onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
            />
          </label>
          <label>
            Deadline
            <input
              type="date"
              min={londonToday()}
              value={draft.deadline}
              onChange={(e) => setDraft({ ...draft, deadline: e.target.value })}
            />
            <span className="muted">Leave empty if there is no date.</span>
          </label>
          <label>
            Count cash received from
            <input
              type="date"
              max={londonToday()}
              value={draft.start}
              onChange={(e) => setDraft({ ...draft, start: e.target.value })}
            />
            <span className="muted">Leave empty to count from today.</span>
          </label>
        </div>
        <button disabled={busy}>Add goal</button>
        {notice && <p role="status">{notice}</p>}
      </form>
      {data && <p className="muted">{data.basis}</p>}
    </section>
  );
}
