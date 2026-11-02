// Plans: compare the three memberships and choose one (server/plans.mjs).
// Payments are not switched on yet, so choosing sets what the member sees
// and nothing is charged; the page says so.
import { useState } from "react";
import { SIGN_IN_EVENT, money } from "../api";
import {
  choosePlan,
  currentPlan,
  usePlans,
  type Feature,
  type Plan,
  type PlansInfo,
} from "../plans";
import { Button, Card, Label, Notice, PageHead, type Tint } from "../ui/kit";
import "./plans.css";

const TINT: Record<Plan["id"], Tint> = { starter: "lime", plus: "sky", fulltime: "lilac" };
const ORDER: Plan["id"][] = ["starter", "plus", "fulltime"];
const FEATURE_ROWS: Feature[] = ["deals", "scan", "stock", "money", "tips", "trip", "research", "taxExport"];

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });
const areasText = (n: number | null) => (n === null ? "Any number of areas" : n === 1 ? "One home area" : `Up to ${n} areas`);

function Tick({ on }: { on: boolean }) {
  return on ? (
    <svg className="pl-tick" viewBox="0 0 20 20" aria-label="Included" role="img">
      <path d="M4.5 10.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <span className="pl-no" aria-label="Not included" role="img">–</span>
  );
}

function PlanCard({
  plan,
  info,
  onChoose,
  busy,
}: {
  plan: Plan;
  info: PlansInfo;
  onChoose: (id: Plan["id"]) => void;
  busy: boolean;
}) {
  const mine = currentPlan(info);
  const isMine = mine?.id === plan.id;
  const up = mine && ORDER.indexOf(plan.id) > ORDER.indexOf(mine.id);
  const extra = (() => {
    const i = ORDER.indexOf(plan.id);
    if (i === 0) return plan.opens;
    const before = info.plans.find((p) => p.id === ORDER[i - 1]);
    return plan.opens.filter((f) => !before?.opens.includes(f));
  })();
  const label = isMine
    ? "Your plan"
    : info.signedIn === false
      ? `Sign in to choose ${plan.name}`
      : mine
        ? `${up ? "Move up" : "Move"} to ${plan.name}`
        : `Start ${plan.name} for ${money(info.intro.pence).replace(".00", "")}`;
  return (
    <section className={"pl-card" + (isMine ? " mine" : "")} style={{ ["--k-tint" as string]: `var(--k-${TINT[plan.id]})` }}>
      <header className="pl-top">
        <div className="pl-name">
          <h2 className="k-display">{plan.name}</h2>
          {isMine && <span className="pl-badge">Your plan</span>}
        </div>
        <p>{plan.forWho}</p>
      </header>
      <div className="pl-price">
        <b className="k-display">{money(plan.pricePence)}</b>
        <span>a month</span>
      </div>
      <p className="pl-intro">
        {money(info.intro.pence).replace(".00", "")} for your first {info.intro.days} days, then {money(plan.pricePence)} a month.
      </p>
      <Button
        variant={isMine ? "line" : "main"}
        disabled={isMine || busy}
        onClick={() => (info.signedIn === false ? window.dispatchEvent(new Event(SIGN_IN_EVENT)) : onChoose(plan.id))}
      >
        {label}
      </Button>
      <ul className="pl-list">
        {ORDER.indexOf(plan.id) > 0 && (
          <li className="pl-lead">Everything in {info.plans[ORDER.indexOf(plan.id) - 1].name}, plus:</li>
        )}
        {extra.map((f) => (
          <li key={f}>
            <Tick on />
            <span>{info.features[f]}</span>
          </li>
        ))}
        <li>
          <Tick on />
          <span>{plan.tipTiming}</span>
        </li>
        <li>
          <Tick on />
          <span>{areasText(plan.areas)}</span>
        </li>
      </ul>
    </section>
  );
}

export default function PlansScreen() {
  const { info, error } = usePlans();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone?: "loss" | "profit"; text: string } | null>(null);
  const [stopping, setStopping] = useState(false);

  async function choose(id: Plan["id"] | null) {
    setBusy(true);
    setMsg(null);
    try {
      const now = await choosePlan(id);
      const plan = now && info?.plans.find((p) => p.id === now.id);
      setMsg(plan ? null : { tone: "profit", text: "Plan stopped. Every screen stays open to look around until you choose again." });
      setStopping(false);
    } catch (e) {
      setMsg({ tone: "loss", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const mine = currentPlan(info);
  return (
    <div className="pl">
      <PageHead
        title="Plans"
        tint="lemon"
        lead="Every plan starts at £1 for the first 7 days. Pick the one that fits how often you go out hunting; you can move up or down."
      />

      {error && (
        <Notice tone="loss" title="Plans did not load.">
          {error}
        </Notice>
      )}
      {info && !info.payments && (
        <Notice tone="warn" title="Payments are not switched on yet.">
          Choosing a plan sets what you see while we test the app. Nothing is charged.
        </Notice>
      )}
      {info?.current && mine && (
        <Notice tone="profit" title={`You are on ${mine.name}.`}>
          Since {day(info.current.since)}.
          {info.current.introEnds && Date.parse(info.current.introEnds) > Date.now()
            ? ` Your £1 week ends ${day(info.current.introEnds)}.`
            : ""}
        </Notice>
      )}
      {msg && (
        <Notice tone={msg.tone} title={msg.tone === "loss" ? "Not changed." : undefined}>
          {msg.text}
        </Notice>
      )}

      {info && (
        <div className="pl-grid">
          {ORDER.map((id) => {
            const plan = info.plans.find((p) => p.id === id);
            return plan ? <PlanCard key={id} plan={plan} info={info} onChoose={choose} busy={busy} /> : null;
          })}
        </div>
      )}

      {info && (
        <Card>
          <Label>What each plan opens</Label>
          <div className="pl-scroll">
            <table className="pl-table">
              <thead>
                <tr>
                  <td />
                  {ORDER.map((id) => (
                    <th scope="col" key={id}>
                      {info.plans.find((p) => p.id === id)?.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {FEATURE_ROWS.map((f) => (
                  <tr key={f}>
                    <th scope="row">
                      {info.features[f].split(":")[0]}
                      {info.features[f].includes(":") && (
                        <span className="pl-rest">:{info.features[f].split(":").slice(1).join(":")}</span>
                      )}
                    </th>
                    {ORDER.map((id) => (
                      <td key={id}>
                        <Tick on={!!info.plans.find((p) => p.id === id)?.opens.includes(f)} />
                      </td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <th scope="row">Tip timing</th>
                  {ORDER.map((id) => (
                    <td key={id} className="pl-txt">
                      {{ starter: "Normal time", plus: "3 hours early", fulltime: "First" }[id]}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">Areas</th>
                  {ORDER.map((id) => {
                    const n = info.plans.find((p) => p.id === id)?.areas ?? null;
                    return (
                      <td key={id} className="pl-txt">
                        {n === null ? "Any" : n}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {info && (
        <div className="pl-facts">
          <Card>
            <Label>The £1 start</Label>
            <p>
              £1 covers your first 7 days on any plan, then the monthly price applies. It can be used once per bank card,
              so a new email on the same card pays the full price.
            </p>
          </Card>
          <Card>
            <Label>Points are earned</Label>
            <p>
              Scout points and the level they unlock come only from accurate tips. A plan changes when tips reach you, never your
              level or points.
            </p>
          </Card>
          <Card>
            <Label>Simple or Pro</Label>
            <p>Every plan gets both views. Switch any time from the top of a page.</p>
          </Card>
        </div>
      )}

      {mine && (
        <div className="pl-stop">
          {stopping ? (
            <>
              <span>Stop {mine.name}? Plus and Full-time screens close straight away.</span>
              <Button variant="line" size="sm" onClick={() => setStopping(false)}>
                Keep it
              </Button>
              <Button variant="main" size="sm" disabled={busy} onClick={() => choose(null)}>
                Stop plan
              </Button>
            </>
          ) : (
            <Button variant="text" size="sm" onClick={() => setStopping(true)}>
              Stop my plan
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Shows a screen only when the member's plan opens it; otherwise an upgrade
 * card naming the cheapest plan that does. Before any plan is chosen every
 * screen stays open.
 */
export function PlanGate({
  feature,
  title,
  tint,
  what,
  go,
  children,
}: {
  feature: Feature;
  title: string;
  tint: Tint;
  what: string;
  go: (v: "plans") => void;
  children: React.ReactNode;
}) {
  const { info } = usePlans();
  const mine = currentPlan(info);
  if (!mine || mine.opens.includes(feature)) return <>{children}</>;
  const need = info?.plans.find((p) => p.opens.includes(feature));
  return (
    <div className="pl">
      <PageHead title={title} tint={tint} lead={what} />
      <Card className="pl-gate">
        <div className="pl-gate-body">
          <span className="pl-lock" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <rect x="5" y="10.5" width="14" height="10" rx="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </span>
          <div>
            <h2 className="k-display">
              {title} comes with {need?.name ?? "a higher plan"}
            </h2>
            <p>
              You are on {mine.name}.{" "}
              {need
                ? `${need.name} is ${money(need.pricePence)} a month and also adds ${need.opens
                    .filter((f) => f !== feature && !mine.opens.includes(f))
                    .map((f) => info!.features[f].split(":")[0].toLowerCase())
                    .concat(need.tipTiming.toLowerCase())
                    .join(", ")}.`
                : ""}
            </p>
          </div>
        </div>
        <div className="pl-gate-acts">
          <Button variant="main" onClick={() => go("plans")}>
            See plans
          </Button>
        </div>
      </Card>
    </div>
  );
}

/** The member's plan in one line, for the account menu and Profile. */
export function PlanLine({ go, wide = false }: { go: (v: "plans") => void; wide?: boolean }) {
  const { info } = usePlans();
  const mine = currentPlan(info);
  return (
    <>
      <div className={wide ? "set" : "pm-row"}>
        <span>{mine ? `${mine.name} plan` : "No plan chosen"}</span>
        <b>{mine ? `${money(mine.pricePence)} a month` : "From £1"}</b>
      </div>
      <small className={wide ? "sub" : undefined} style={wide ? { fontSize: 13, display: "block" } : undefined}>
        {info && !info.payments ? "Payments are not switched on yet, so nothing is charged. " : ""}
        <a
          href="#Plans"
          onClick={(e) => {
            e.preventDefault();
            go("plans");
          }}
        >
          {mine ? "Change plan" : "See plans"}
        </a>
      </small>
    </>
  );
}
