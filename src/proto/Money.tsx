// The Money screen, built from the building blocks (src/ui/kit.tsx)
// (Simple: calm figures; Pro: charts and the working behind them). Every
// figure here comes from the ledger: payouts, receipts, expenses and refunds
// that were actually recorded. Nothing is modelled or made up.
import React, { useEffect, useMemo, useState } from "react";
import { api, dateTime, money, toPence, type Lens } from "../api";
import {
  Button,
  Card,
  Empty,
  Field,
  Figure,
  Figures,
  Input,
  Label,
  Meter,
  MoneyInput,
  Notice,
  PageHead,
  Toasts,
  Window,
  useToast,
} from "../ui/kit";
import { TaxExport } from "./TaxExport";
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

type Props = {
  lens: Lens;
  lensButtons: React.ReactNode;
  go: (view: "stock" | "profile" | "planner" | "plans") => void;
};

export default function MoneyScreen(props: Props) {
  return (
    <Toasts>
      <MoneyInner {...props} />
    </Toasts>
  );
}

function MoneyInner({ lens, lensButtons, go }: Props) {
  const say = useToast();
  const chartMonths = useMemo(() => Array.from({ length: 6 }, (_, i) => monthAt(i - 5)), []);
  const tax = useMemo(taxMonths, []);
  const [sums, setSums] = useState<Record<string, Summary>>({});
  const [error, setError] = useState("");
  const [goals, setGoals] = useState<GoalsData | null>(null);
  const [targets, setTargets] = useState<Targets | null>(null);
  const [form, setForm] = useState(false);
  const [draft, setDraft] = useState({ name: "", amount: "", deadline: "" });
  const [errs, setErrs] = useState<Record<string, string>>({});
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
    const amount = Number(draft.amount.replace(/[£,\s]/g, ""));
    const bad: Record<string, string> = {};
    if (!draft.name.trim()) bad.name = "Say what the money is for, like a holiday.";
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) bad.amount = "An amount between £1 and £100,000.";
    setErrs(bad);
    if (Object.keys(bad).length) return;
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
      say("Goal added.");
    } catch (e) {
      setErrs({ form: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  async function removeGoal(t: Target) {
    setBusy(true);
    try {
      setTargets(await api<Targets>("goals/targets/" + t.id, {}, "DELETE"));
      say(`Removed "${t.name}".`);
    } catch (e) {
      say((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const head = (
    <PageHead
      title="Money"
      tint="candy"
      lead={`${monthName(monthAt(0), long)} so far. Only money that has actually reached you counts as kept.`}
      aside={<div className="k-headacts">{lensButtons}</div>}
    />
  );

  if (error)
    return (
      <div className="mn">
        {head}
        <Notice tone="loss" title="Not loaded.">
          Your figures could not be loaded ({error}). Try again in a moment.
        </Notice>
      </div>
    );
  if (!now)
    return (
      <div className="mn">
        {head}
        <p className="mn-p">Loading your figures…</p>
      </div>
    );

  const targetMeter =
    target > 0 ? (
      <div className="mn-target">
        <Meter
          label={`${savings ? "Monthly savings target" : "Monthly target"}`}
          value={Math.max(0, kept)}
          max={target}
          shown={`${pounds(Math.max(0, kept))} of ${pounds(target)}`}
        />
        <Button variant="text" size="sm" onClick={() => go("profile")}>
          Change target
        </Button>
      </div>
    ) : (
      <p className="mn-p">
        No monthly target yet.{" "}
        <Button variant="text" size="sm" onClick={() => go("profile")}>
          Set one in settings
        </Button>
      </p>
    );

  const goalCard = (
    <Card>
      <Label
        aside={
          <Button variant="tab" tint="candy" size="sm" onClick={() => (setErrs({}), setForm(true))}>
            Add a goal
          </Button>
        }
      >
        What it is for
      </Label>
      {targets && targets.targets.length === 0 && (
        <p className="mn-p">Name what the money is for, like a holiday or a bill, and watch it fill from cash you receive.</p>
      )}
      {targets?.targets.map((t) => (
        <div key={t.id} className="mn-goal">
          <Meter
            label={<b>{t.name}</b>}
            value={Math.min(t.counted, t.amount)}
            max={t.amount}
            shown={`${pounds(Math.min(t.counted, t.amount))} of ${pounds(t.amount)}`}
            ink={t.status !== "reached"}
          />
          <div className="mn-goalfoot">
            <span>
              {t.status === "reached"
                ? "Reached. Well done."
                : t.status === "missed"
                  ? "The deadline has passed."
                  : t.deadline
                    ? `${pounds(t.remaining)} to go by ${dateTime(t.deadline)}`
                    : `${pounds(t.remaining)} to go`}
            </span>
            <Button variant="text" size="sm" disabled={busy} onClick={() => removeGoal(t)}>
              Remove
            </Button>
          </div>
        </div>
      ))}
    </Card>
  );

  const goalWindow = (
    <Window
      open={form}
      onOpenChange={setForm}
      tint="candy"
      title="Add a goal"
      description="Money you receive counts towards it."
      footer={
        <>
          <Button variant="line" onClick={() => setForm(false)}>
            Cancel
          </Button>
          <Button variant="main" type="submit" form="mn-goal" disabled={busy}>
            {busy ? "Adding…" : "Add goal"}
          </Button>
        </>
      }
    >
      <form id="mn-goal" className="k-form" onSubmit={addGoal} noValidate>
        <Field label="What is it for" htmlFor="mn-name" error={errs.name}>
          <Input
            id="mn-name"
            value={draft.name}
            maxLength={80}
            placeholder="New phone"
            autoFocus
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <div className="k-pair mn-pair">
          <Field label="Amount" htmlFor="mn-amount" error={errs.amount}>
            <MoneyInput id="mn-amount" placeholder="250" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
          </Field>
          <Field label="By (optional)" htmlFor="mn-by">
            <Input id="mn-by" type="date" value={draft.deadline} onChange={(e) => setDraft({ ...draft, deadline: e.target.value })} />
          </Field>
        </div>
        {errs.form && (
          <Notice tone="loss" title="Not added.">
            {errs.form}
          </Notice>
        )}
      </form>
    </Window>
  );

  const taxCard = (
    <Card>
      <Label>The £1,000 trading allowance</Label>
      <Meter
        label="Paid out since 6 April"
        value={taxPaid}
        max={TAX_ALLOWANCE}
        shown={`${pounds(taxPaid)} of £1,000`}
        over={taxPaid >= TAX_ALLOWANCE}
        ink
      />
      <p className="mn-small">
        {taxPaid < TAX_ALLOWANCE
          ? `You can make £1,000 a year from selling before you need to tell HMRC. About ${pounds(TAX_ALLOWANCE - taxPaid)} to go.`
          : "You have passed £1,000 this tax year, so you may need to tell HMRC."}{" "}
        HMRC counts your total sales before fees, which is more than what was paid out, so treat this as a low
        guide. Not tax advice.
      </p>
      <TaxExport go={go} />
    </Card>
  );

  const emptyNote = empty && (
    <Empty
      title="Nothing recorded yet"
      text="Money fills in from the trips you record in Stock: what you bought, what sold and what was paid out."
      action={
        <Button variant="main" onClick={() => go("stock")}>
          Go to Stock
        </Button>
      }
    />
  );

  const top = Math.max(1, ...series.map((s) => Math.abs(s.v)));
  const hourly = now.realisedHourly;

  if (lens === "simple")
    return (
      <div className="mn">
        {head}
        {emptyNote}
        <div className="k-split">
          <div className="k-col">
            <Card className="mn-hero">
              <div className="mn-herotop">
                <div>
                  <Label>You kept</Label>
                  <b className="k-display mn-big">{pounds(kept)}</b>
                  <p className="mn-p">
                    {savings
                      ? "Household savings recorded this month, after trip costs."
                      : "Paid out to you this month, after what you spent."}
                  </p>
                </div>
                <div className="mn-bars" aria-label="Kept in the last four months">
                  {series.slice(-4).map((s, i) => (
                    <div key={s.m} className={i === 3 ? "now" : ""}>
                      <span>{s.v ? pounds(s.v) : ""}</span>
                      <i style={{ height: Math.max(6, Math.round((Math.max(0, s.v) / top) * 96)) }} />
                      <small>{i === 3 ? "Now" : monthName(s.m)}</small>
                    </div>
                  ))}
                </div>
              </div>
              {targetMeter}
            </Card>
            <Figures>
              <Figure label="On the way" value={money(now.pendingPayouts)} note="sold, waiting for the money" />
              <Figure
                label="In your stock"
                value={money(now.cashTiedUp ?? 0)}
                note={`${now.unsoldUnits ?? 0} ${now.unsoldUnits === 1 ? "unit" : "units"} not sold yet`}
              />
              <Figure
                label="Per hour"
                value={hourly == null ? "Not known" : money(hourly)}
                note={hourly == null ? "add time on a trip in Stock" : "on trips where you logged time"}
              />
            </Figures>
          </div>
          <div className="k-col">
            {goalCard}
            {taxCard}
          </div>
        </div>
        {goalWindow}
      </div>
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
  const rows: [string, number, string?][] = [
    ["Paid out to you", now.payouts ?? 0],
    ["Less what you spent this month", (now.payouts ?? 0) - now.realisedEarnings],
    ["Kept", now.realisedEarnings, "profit"],
    ["Paid out with full proof", now.verifiedPayouts ?? 0],
    ["Could still come in (estimate, not counted)", now.potentialProceeds],
  ];
  if (now.householdSavings !== 0) rows.push(["Household savings (never counted as earnings)", now.householdSavings]);
  return (
    <div className="mn">
      {head}
      {emptyNote}
      <Figures>
        <Figure label="Kept this month" value={money(kept)} tone={kept >= 0 ? "profit" : "loss"} note={`${money(now.payouts ?? 0)} paid out`} />
        <Figure label="On the way" value={money(now.pendingPayouts)} note="sold, not paid yet" />
        <Figure
          label="In stock"
          value={money(now.cashTiedUp ?? 0)}
          note={`${now.unsoldUnits ?? 0} units across ${now.openTrips ?? 0} open ${now.openTrips === 1 ? "trip" : "trips"}`}
        />
        <Figure
          label="Per hour"
          value={hourly == null ? "Not known" : money(hourly)}
          note={now.realisedMinutes ? `${Math.round(now.realisedMinutes / 6) / 10} h logged` : "no time logged"}
        />
      </Figures>
      <div className="k-split">
        <Card>
          <Label aside={<span>last 6 months</span>}>Kept each month</Label>
          <svg className="mn-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Money kept each month">
            {[...new Set([lo, 0, hi])].map((v, i) => (
              <g key={i}>
                <line x1={L} x2={W - 10} y1={y(v)} y2={y(v)} stroke="var(--k-line)" />
                <text x={L - 6} y={y(v) + 4} fontSize="11" textAnchor="end" fill="var(--k-muted)">
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
                    fill={s.v < 0 ? "#f3b4ad" : last ? "var(--k-profit)" : "#dcdae3"}
                  />
                  {s.v !== 0 && (
                    <text
                      x={x + bw / 2}
                      y={s.v < 0 ? y(s.v) - 8 : top0 - 6}
                      fontSize="12"
                      textAnchor="middle"
                      fontWeight="700"
                      fill="var(--k-ink)"
                    >
                      {pounds(s.v)}
                    </text>
                  )}
                  <text x={x + bw / 2} y={H - 8} fontSize="11.5" textAnchor="middle" fill="var(--k-muted)">
                    {last ? "This month" : monthName(s.m)}
                  </text>
                </g>
              );
            })}
          </svg>
          {targetMeter}
        </Card>
        <Card>
          <Label>How it adds up</Label>
          <div className="mn-sum">
            {rows.map(([k, v, tone]) => (
              <div key={k} className={tone}>
                <span>{k}</span>
                <b>{money(v)}</b>
              </div>
            ))}
          </div>
          {now.basis && <p className="mn-small">{now.basis}</p>}
        </Card>
      </div>
      <div className="k-split mn-even">
        {goalCard}
        {taxCard}
      </div>
      {goalWindow}
    </div>
  );
}
