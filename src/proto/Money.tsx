// The Money screen in the new shell, built from the agreed full-site mock
// (Simple: calm figures; Pro: charts and the working behind them). Every
// figure here comes from the ledger: payouts, receipts, expenses and refunds
// that were actually recorded. Nothing is modelled or made up.
import React, { useEffect, useMemo, useState } from "react";
import { api, dateTime, money, toPence, type Lens } from "../api";
import "./money.css";

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
  payouts?: number;
  verifiedPayouts?: number;
  openTrips?: number;
  basis?: string;
};
type GoalsData = { targetType: "income" | "savings"; monthlyTarget: number };
type Target = {
  id: number;
  name: string;
  amount: number;
  deadline: string | null;
  counted: number;
  remaining: number;
  status: "reached" | "in progress" | "missed";
  daysLeft: number | null;
};
type Targets = { targets: Target[]; basis: string };

const TAX_ALLOWANCE = 100000; // £1,000 trading allowance, in pence

/** YYYY-MM for a month offset from this month, in UK time. */
function monthAt(offset: number) {
  const [y, m] = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
  })
    .format(new Date())
    .split("-")
    .map(Number);
  const d = new Date(Date.UTC(y, m - 1 + offset, 15));
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}
const short = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" });
const long = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" });
const monthName = (ym: string, f = short) => f.format(new Date(ym + "-15T12:00:00Z"));
const pounds = (pence: number) =>
  (pence < 0 ? "-£" : "£") +
  Math.round(Math.abs(pence) / 100).toLocaleString("en-GB");
const clamp = (n: number) => Math.max(0, Math.min(100, n));

/** Months of the tax year so far (from April), oldest first. */
function taxMonths() {
  const now = monthAt(0);
  const mm = Number(now.slice(5));
  const back = mm >= 4 ? mm - 4 : mm + 8;
  return Array.from({ length: back + 1 }, (_, i) => monthAt(i - back));
}

export default function MoneyScreen({
  lens,
  lensButtons,
  go,
}: {
  lens: Lens;
  lensButtons: React.ReactNode;
  go: (view: "stock" | "profile" | "planner") => void;
}) {
  const chartMonths = useMemo(() => Array.from({ length: 6 }, (_, i) => monthAt(i - 5)), []);
  const tax = useMemo(taxMonths, []);
  const [sums, setSums] = useState<Record<string, Summary>>({});
  const [error, setError] = useState("");
  const [goals, setGoals] = useState<GoalsData | null>(null);
  const [targets, setTargets] = useState<Targets | null>(null);
  const [form, setForm] = useState(false);
  const [draft, setDraft] = useState({ name: "", amount: "", deadline: "" });
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const months = [...new Set([...chartMonths, ...tax])];
    Promise.all(
      months.map((m) => api<Summary>("ledger/summary?month=" + m).then((s) => [m, s] as const)),
    )
      .then((rows) => active && setSums(Object.fromEntries(rows)))
      .catch((e) => active && setError((e as Error).message));
    api<GoalsData>("goals")
      .then((g) => active && setGoals(g))
      .catch(() => undefined);
    api<Targets>("goals/targets")
      .then((t) => active && setTargets(t))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [chartMonths, tax]);

  const now = sums[monthAt(0)];
  const savings = goals?.targetType === "savings";
  const kept = now ? (savings ? now.householdSavings : now.realisedEarnings) : 0;
  const target = goals?.monthlyTarget ?? 0;
  const taxPaid = tax.reduce((a, m) => a + (sums[m]?.payouts ?? 0), 0);
  const series = chartMonths.map((m) => ({ m, v: sums[m]?.realisedEarnings ?? 0 }));
  const empty =
    !!now &&
    series.every((s) => s.v === 0) &&
    !now.pendingPayouts &&
    !now.cashTiedUp &&
    !now.openTrips;

  async function addGoal(ev: React.FormEvent) {
    ev.preventDefault();
    const amount = Number(draft.amount);
    if (!draft.name.trim()) return setNotice("Say what the money is for.");
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000)
      return setNotice("Amount must be between £0.01 and £100,000.");
    setBusy(true);
    try {
      const r = await api<Targets>("goals/targets", {
        name: draft.name.trim(),
        amount: toPence(amount),
        deadline: draft.deadline || null,
        start: null,
      });
      setTargets(r);
      setDraft({ name: "", amount: "", deadline: "" });
      setForm(false);
      setNotice("Goal added.");
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function removeGoal(t: Target) {
    setBusy(true);
    try {
      setTargets(await api<Targets>("goals/targets/" + t.id, {}, "DELETE"));
      setNotice(`Removed "${t.name}".`);
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const head = (
    <div className="titlebar">
      <div>
        <h1>Money</h1>
        <p>
          {monthName(monthAt(0), long)} so far. Only money that has actually reached you counts as
          kept.
        </p>
      </div>
      <div className="btns">{lensButtons}</div>
    </div>
  );

  if (error)
    return (
      <>
        {head}
        <p className="note">Your figures could not be loaded ({error}). Try again in a moment.</p>
      </>
    );
  if (!now)
    return (
      <>
        {head}
        <p className="sub">Loading your figures…</p>
      </>
    );

  const targetLine = (
    <div className="mtarget">
      {target > 0 ? (
        <>
          <span>
            {pounds(Math.max(0, kept))} of your {pounds(target)} monthly{" "}
            {savings ? "savings" : ""} target ·{" "}
            <button type="button" className="linkbtn" onClick={() => go("profile")}>
              change
            </button>
          </span>
          <div className="bar">
            <i style={{ width: clamp((kept / target) * 100) + "%" }} />
          </div>
        </>
      ) : (
        <span>
          No monthly target yet.{" "}
          <button type="button" className="linkbtn" onClick={() => go("profile")}>
            Set one in settings
          </button>
        </span>
      )}
    </div>
  );

  const goalPanel = (
    <div className="panel mgoals">
      <h3>
        What it is for <small>cash received only</small>
      </h3>
      {targets && targets.targets.length === 0 && !form && (
        <p className="muted">Name what the money is for, like a holiday or a bill, and watch it fill.</p>
      )}
      {targets?.targets.map((t) => (
        <div key={t.id} className="mgoal">
          <div className="row2">
            <b>{t.name}</b>
            <span className="num">
              {pounds(Math.min(t.counted, t.amount))} of {pounds(t.amount)}
            </span>
          </div>
          <div className="bar dark">
            <i style={{ width: clamp((t.counted / t.amount) * 100) + "%" }} />
          </div>
          <div className="row2 muted">
            <span>
              {t.status === "reached"
                ? "Reached. Well done."
                : t.status === "missed"
                  ? "The deadline has passed."
                  : t.deadline
                    ? `${pounds(t.remaining)} to go by ${dateTime(t.deadline)}`
                    : `${pounds(t.remaining)} to go`}
            </span>
            <button type="button" className="linkbtn" disabled={busy} onClick={() => removeGoal(t)}>
              Remove
            </button>
          </div>
        </div>
      ))}
      {form ? (
        <form className="mform" onSubmit={addGoal} noValidate>
          <label>
            What is it for
            <input
              value={draft.name}
              maxLength={80}
              placeholder="New phone"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            Amount, £
            <input
              type="number"
              min={1}
              inputMode="decimal"
              placeholder="250"
              value={draft.amount}
              onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
            />
          </label>
          <label>
            By (optional)
            <input
              type="date"
              value={draft.deadline}
              onChange={(e) => setDraft({ ...draft, deadline: e.target.value })}
            />
          </label>
          <button className="bt sm" disabled={busy}>
            Add
          </button>
        </form>
      ) : (
        <button type="button" className="linkbtn" onClick={() => setForm(true)}>
          + Add a goal
        </button>
      )}
      {notice && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
    </div>
  );

  const taxPanel = (
    <div className="panel">
      <h3>
        Paid out since April <small>{pounds(taxPaid)} of £1,000</small>
      </h3>
      <div className="bar">
        <i className="taxbar" style={{ width: clamp((taxPaid / TAX_ALLOWANCE) * 100) + "%" }} />
      </div>
      <p className="muted msmall">
        {taxPaid < TAX_ALLOWANCE
          ? `You can make £1,000 a year from selling before you need to tell HMRC. About ${pounds(TAX_ALLOWANCE - taxPaid)} to go.`
          : "You have passed £1,000 this tax year, so you may need to tell HMRC."}{" "}
        HMRC counts your total sales before fees, which is more than what was paid out, so treat
        this as a low guide. Not tax advice.
      </p>
    </div>
  );

  const emptyNote = empty && (
    <div className="note mempty">
      Nothing recorded yet. Money fills in from the trips you record in Stock: what you bought,
      what sold and what was paid out.{" "}
      <button type="button" className="linkbtn" onClick={() => go("stock")}>
        Go to Stock
      </button>
    </div>
  );

  const top = Math.max(1, ...series.map((s) => Math.abs(s.v)));
  const hourly = now.realisedHourly;

  if (lens === "simple")
    return (
      <>
        {head}
        {emptyNote}
        <div className="mgrid">
          <div className="mcol">
            <div className="panel mhero">
              <div>
                <small className="muted">You kept</small>
                <b className="mbig num">{pounds(kept)}</b>
                <span className="muted">
                  {savings
                    ? "Household savings recorded this month, after trip costs"
                    : "Paid out to you this month, after what you spent"}
                </span>
                {targetLine}
              </div>
              <div className="mweeks" aria-label="Kept in the last four months">
                {series.slice(-4).map((s, i) => (
                  <div key={s.m} className={i === 3 ? "now" : ""}>
                    <i style={{ height: Math.max(6, Math.round((Math.max(0, s.v) / top) * 110)) }} />
                    <small>{i === 3 ? "This month" : monthName(s.m)}</small>
                  </div>
                ))}
              </div>
            </div>
            <div className="stats three">
              <div className="stat">
                <small>On the way</small>
                <b>{money(now.pendingPayouts)}</b>
                <span>sold, waiting for the money</span>
              </div>
              <div className="stat">
                <small>In your stock</small>
                <b>{money(now.cashTiedUp ?? 0)}</b>
                <span>
                  {now.unsoldUnits ?? 0} {now.unsoldUnits === 1 ? "unit" : "units"} not sold yet
                </span>
              </div>
              <div className="stat">
                <small>Per hour</small>
                <b>{hourly == null ? "Not known" : money(hourly)}</b>
                <span>{hourly == null ? "log your time on a trip to see it" : "on trips where you logged time"}</span>
              </div>
            </div>
          </div>
          <div className="mcol">
            {goalPanel}
            {taxPanel}
          </div>
        </div>
      </>
    );

  // Pro: the month chart and the working behind every figure.
  const W = 640,
    H = 220,
    L = 52,
    B = 26,
    T = 18;
  const lo = Math.min(0, ...series.map((s) => s.v));
  const hi = Math.max(1, ...series.map((s) => s.v));
  const y = (v: number) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const step = (W - L - 20) / series.length;
  const bw = Math.min(72, step - 18);
  return (
    <>
      {head}
      {emptyNote}
      <div className="stats">
        <div className="stat">
          <small>Kept this month</small>
          <b className="kept">{money(kept)}</b>
          <span>{money(now.payouts ?? 0)} paid out</span>
        </div>
        <div className="stat">
          <small>On the way</small>
          <b>{money(now.pendingPayouts)}</b>
          <span>sold, not paid yet</span>
        </div>
        <div className="stat">
          <small>In stock</small>
          <b>{money(now.cashTiedUp ?? 0)}</b>
          <span>
            {now.unsoldUnits ?? 0} units across {now.openTrips ?? 0} open{" "}
            {now.openTrips === 1 ? "trip" : "trips"}
          </span>
        </div>
        <div className="stat">
          <small>Per hour</small>
          <b>{hourly == null ? "Not known" : money(hourly)}</b>
          <span>{now.realisedMinutes ? `${Math.round(now.realisedMinutes / 6) / 10} h logged` : "no time logged"}</span>
        </div>
      </div>
      <div className="two">
        <div className="panel chart">
          <h3>
            Kept each month <small>last 6 months</small>
          </h3>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Money kept each month">
            {[...new Set([lo, 0, hi])].map((v, i) => (
              <g key={i}>
                <line x1={L} x2={W - 10} y1={y(v)} y2={y(v)} stroke="var(--line)" />
                <text x={L - 6} y={y(v) + 4} fontSize="11" textAnchor="end" fill="var(--muted)">
                  {pounds(v)}
                </text>
              </g>
            ))}
            {series.map((s, i) => {
              const x = L + 10 + i * step;
              const top0 = y(Math.max(0, s.v));
              const h = Math.max(2, Math.abs(y(s.v) - y(0)));
              const last = i === series.length - 1;
              return (
                <g key={s.m}>
                  <rect
                    x={x}
                    y={top0}
                    width={bw}
                    height={h}
                    rx="8"
                    fill={s.v < 0 ? "#f3b4ad" : last ? "var(--brand)" : "#d9dde3"}
                  />
                  {s.v !== 0 && (
                    <text
                      x={x + bw / 2}
                      y={s.v < 0 ? y(s.v) - 8 : top0 - 6}
                      fontSize="12"
                      textAnchor="middle"
                      fontWeight="700"
                      fill="var(--ink-2)"
                    >
                      {pounds(s.v)}
                    </text>
                  )}
                  <text x={x + bw / 2} y={H - 8} fontSize="11.5" textAnchor="middle" fill="var(--muted)">
                    {last ? "This month" : monthName(s.m)}
                  </text>
                </g>
              );
            })}
          </svg>
          {targetLine}
        </div>
        <div className="panel">
          <h3>How it adds up</h3>
          <div className="set">
            <span>Paid out to you</span>
            <b>{money(now.payouts ?? 0)}</b>
          </div>
          <div className="set">
            <span>Less what you spent this month</span>
            <b>{money((now.payouts ?? 0) - now.realisedEarnings)}</b>
          </div>
          <div className="set">
            <span>Kept</span>
            <b className="kept">{money(now.realisedEarnings)}</b>
          </div>
          <div className="set">
            <span>Paid out with full proof</span>
            <b>{money(now.verifiedPayouts ?? 0)}</b>
          </div>
          <div className="set">
            <span>Could still come in (estimate, not counted)</span>
            <b>{money(now.potentialProceeds)}</b>
          </div>
          {now.householdSavings !== 0 && (
            <div className="set">
              <span>Household savings (never counted as earnings)</span>
              <b>{money(now.householdSavings)}</b>
            </div>
          )}
          {now.basis && <p className="muted msmall">{now.basis}</p>}
        </div>
      </div>
      <div className="two" style={{ marginTop: 20 }}>
        {goalPanel}
        {taxPanel}
      </div>
    </>
  );
}
