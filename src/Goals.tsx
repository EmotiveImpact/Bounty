import React, { useEffect, useState } from "react";
import { api, hours, loadProfile, money, percent, toPence } from "./api";
import {
  Costs,
  Opportunity,
  Thresholds,
  TierBadge,
  loadRules,
  planProfile,
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
type Payout = {
  sold: string | null;
  dispatch: string | null;
  delivered: string | null;
  date: string | null;
  note: string;
};
type Timing = { status: "on time" | "late" | "unknown"; daysLate: number | null; note: string };
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
  thresholds: Thresholds;
  opportunity: Opportunity;
};
type Basket = {
  id: string;
  items: BasketItem[];
  shops: string[];
  journey: { mode: string; miles: number; cost: number; minutes: number; extraShops: number };
  units: number;
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
  downside: { nothingSells: number; halfSells: number };
  timing: { payout: Payout; cash: Timing };
  reasons: string[];
  recommended: boolean;
};
type BasketResponse = {
  sample: true;
  constraints: {
    budget: number;
    carry: number;
    storage: number;
    profileStorage: number;
    goalsStorage: number;
    quantity: number;
    unitCap: number;
    hourlyTarget: number;
    transport: string;
    area: string;
  };
  approximation: string;
  baskets: Basket[];
  bestSingle: Basket | null;
  recommended: string | null;
  excluded: { sku: string; name: string; shop: string; reason: string }[];
  searched: number;
  truncated: boolean;
  timing: { payout: Payout; cash: Timing };
  rules: { ignored: { key: string; label: string }[] };
};
type Summary = {
  month: string;
  realisedEarnings: number;
  householdSavings: number;
  pendingPayouts: number;
  potentialProceeds: number;
  cashTiedUp?: number;
  unsoldUnits?: number;
  realisedMinutes?: number;
  realisedHourly?: number | null;
};

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

function thisMonth() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
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

export default function Goals() {
  const [goals, setGoals] = useState<Goals | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [goalsNotice, setGoalsNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [baskets, setBaskets] = useState<BasketResponse | null>(null);
  const [basketError, setBasketError] = useState("");
  const [month, setMonth] = useState(thisMonth);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryError, setSummaryError] = useState("");
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    api<Goals>("goals")
      .then((g) => {
        if (!active) return;
        setGoals(g);
        setDraft(toDraft(g));
      })
      .catch((e) => active && setGoalsNotice("Could not load your goals: " + (e as Error).message));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const profile = loadProfile();
    const problem = profileProblem(profile);
    if (problem) {
      setBaskets(null);
      setBasketError("Your Planner profile needs fixing first: " + problem);
      return;
    }
    api<BasketResponse>("baskets", { profile: planProfile(profile, loadRules()) })
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
  }, [version]);

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
      setGoalsNotice("Goals saved. The baskets below now use them.");
      setVersion((v) => v + 1);
    } catch (e) {
      setGoalsNotice("Could not save your goals: " + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="planner goals">
      <section>
        <small>01 / YOUR GOALS</small>
        <h2>Monthly goal and selling rhythm</h2>
        {!draft ? (
          <p>{goalsNotice || "Loading your goals."}</p>
        ) : (
          <form onSubmit={save}>
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
            {goals?.updated && <span className="muted"> Last saved {goals.updated.slice(0, 10)}.</span>}
            {goalsNotice && <p role="status">{goalsNotice}</p>}
          </form>
        )}
      </section>

      <section>
        <small>02 / BASKET PLAN</small>
        <h2>One shopping trip, one cash limit</h2>
        <p>
          Everything in a basket is bought on one shopping trip: one shared journey and one cash
          limit for the whole basket. Your cash, carry limit, maximum units, transport and stricter
          thresholds come from the Planner tab.
        </p>
        <p className="notice">
          Sample data: illustrative Leeds offers with modelled sale totals. A basket is never a buy
          alert.
        </p>
        <button type="button" onClick={() => setVersion((v) => v + 1)}>
          Recalculate
        </button>
        {basketError && <p role="alert">{basketError}</p>}
        {baskets && <BasketPlan plan={baskets} />}
      </section>

      <section>
        <small>03 / THIS MONTH</small>
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

function BasketPlan({ plan }: { plan: BasketResponse }) {
  const c = plan.constraints;
  const pick = plan.baskets.find((b) => b.recommended) || (plan.bestSingle?.recommended ? plan.bestSingle : null);
  const singleShown = plan.bestSingle && plan.baskets.some((b) => b.id === plan.bestSingle!.id);
  return (
    <>
      <dl className="planner-figures">
        <dt>Cash limit for the whole basket</dt>
        <dd>{money(c.budget)}</dd>
        <dt>Carry limit</dt>
        <dd>{c.carry} kg</dd>
        <dt>Units on one trip</dt>
        <dd>
          up to {c.unitCap} (maximum units {c.quantity}, storage {c.storage})
        </dd>
        <dt>Storage used</dt>
        <dd>
          {c.storage} units, the smaller of Planner {c.profileStorage} and goals {c.goalsStorage}
        </dd>
        <dt>Transport</dt>
        <dd>{c.transport}</dd>
        <dt>Hourly target</dt>
        <dd>{money(c.hourlyTarget)} an hour</dd>
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
        <strong>Cash back:</strong> {plan.timing.payout.note}{" "}
        <span className={plan.timing.cash.status === "late" ? "warn" : ""}>{plan.timing.cash.note}</span>
      </p>
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
      ) : plan.baskets.length ? (
        <p className="warn">
          No basket meets every condition (positive contribution, your hourly target, your buying
          thresholds and the cash date), so none is recommended. The closest options are shown with
          the reasons.
        </p>
      ) : (
        <p className="warn">No basket fits your cash, carrying, storage and unit limits.</p>
      )}
      {plan.truncated && (
        <p className="notice">
          The search stopped after {plan.searched.toLocaleString("en-GB")} baskets, so a better one
          may exist.
        </p>
      )}
      <h3>Top baskets</h3>
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
      {plan.excluded.length > 0 && (
        <>
          <h3>Not in any basket</h3>
          <ul>
            {plan.excluded.map((e) => (
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
        {late && <span className="badge warn">Payout late by {b.timing.cash.daysLate} days</span>}
      </p>
      <h3>{basketTitle(b)}</h3>
      <p className="muted">
        One trip to {b.shops.join(" and ")} by {b.journey.mode.toLowerCase()}: {b.journey.miles}{" "}
        miles there and back, {b.journey.minutes} minutes travelling
        {b.journey.extraShops
          ? `, including ${b.journey.extraShops} extra shop${b.journey.extraShops === 1 ? "" : "s"}`
          : ""}
        . {b.units} units, {b.weightKg} kg.
      </p>
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
          <dt>If only half sell</dt>
          <dd>{money(b.downside.halfSells)}</dd>
          <dt>Cash back</dt>
          <dd className={late ? "warn" : ""}>
            {b.timing.payout.date ?? "cannot be scheduled"}
            {late
              ? `, ${b.timing.cash.daysLate} days late`
              : b.timing.cash.status === "on time"
                ? ", on time"
                : b.timing.payout.date
                  ? ", no cash date set"
                  : ""}
          </dd>
        </dl>
      </div>
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
  return (
    <>
      {target > 0 ? (
        <>
          <progress className="planner-progress" max={target} value={Math.min(target, Math.max(0, realised))} />
          <p>
            {money(realised)} of {money(target)} {savings ? "household savings" : "realised earnings"}{" "}
            in {s.month} ({percent(share)} of your target).
          </p>
        </>
      ) : (
        <p>Set a monthly target above to track progress.</p>
      )}
      <dl className="planner-figures">
        <dt>Realised earnings</dt>
        <dd>{money(s.realisedEarnings)}</dd>
        <dt>Household savings (not earnings)</dt>
        <dd>{money(s.householdSavings)}</dd>
        <dt>Pending payouts (sold, not yet paid: not counted)</dt>
        <dd>{money(s.pendingPayouts)}</dd>
        <dt>Potential proceeds (estimate: not counted)</dt>
        <dd>{money(s.potentialProceeds)}</dd>
        {typeof s.cashTiedUp === "number" && (
          <>
            <dt>Cash tied up in open trips</dt>
            <dd>{money(s.cashTiedUp)}</dd>
          </>
        )}
      </dl>
      <p className="muted">
        Only realised figures count toward progress: {savings ? "household savings you recorded" : "payouts received less recorded costs"}
        . Pending payouts and potential proceeds are shown separately and are not counted until paid.
        {savings ? "" : " Household savings are never counted as earnings."}
      </p>
    </>
  );
}
