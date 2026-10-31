import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type Profile = {
  area: string;
  budget: number;
  target: number;
  transport: string;
  carry: number;
  quantity: number;
  travel: number;
};
type Offer = {
  sku: string;
  name: string;
  variant: string;
  shop: string;
  area: string;
  q: number;
  sold: number;
  sales: number[];
  costs: Record<string, number>;
  profit: number;
  hourly: number;
  proceeds: number;
  minutes: number;
  reason: string;
  miles: number;
  buy: number;
  weight: number;
};
type Observation = {
  id: number;
  title: string;
  store: string;
  place: string;
  price: number;
  day: string;
  unit: string;
};
type Outcome = {
  id: number;
  sku: string;
  received: number;
  costs: number;
  minutes: number;
};
const money = (p: number) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(
    p / 100,
  );
const initial: Profile = {
  area: "Leeds",
  budget: 100,
  target: 12,
  transport: "Walk",
  carry: 5,
  quantity: 4,
  travel: 0,
};
async function api<T>(route: string, body?: unknown): Promise<T> {
  const res = await fetch(
    "/api/" + route,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  if (!res.ok) throw Error((await res.json()).error || "Request failed");
  return res.json();
}
function App() {
  const [profile, P] = useState<Profile>(() => {
    try {
      return {
        ...initial,
        ...JSON.parse(localStorage.getItem("bounty-profile") || "{}"),
      };
    } catch {
      return initial;
    }
  });
  const [tab, T] = useState("Planner"),
    [offers, O] = useState<Offer[]>([]),
    [obs, B] = useState<Observation[]>([]),
    [log, L] = useState<Outcome[]>([]),
    [selected, S] = useState(""),
    [message, M] = useState(""),
    [busy, Q] = useState(false);
  useEffect(() => {
    let active = true;
    M("");
    const run = async () => {
      if (tab === "Planner") {
        const rows = await api<Offer[]>("plan", profile);
        if (active) {
          O(rows);
          localStorage.setItem("bounty-profile", JSON.stringify(profile));
        }
      } else if (tab === "Observations") {
        const rows = await api<Observation[]>("observations");
        if (active) B(rows);
      } else {
        const rows = await api<Outcome[]>("outcomes");
        if (active) L(rows);
      }
    };
    run().catch((e) => {
      if (active) {
        M(e.message);
        O([]);
      }
    });
    return () => {
      active = false;
    };
  }, [profile, tab]);
  const offer = offers.find((o) => o.sku === selected) ?? offers[0];
  const fields: [keyof Profile, string][] = [
    ["budget", "Available cash (£)"],
    ["target", "Hourly target (£)"],
    ["carry", "Carry limit (kg)"],
    ["quantity", "Maximum units"],
    ["travel", "Trip cost (£)"],
  ];
  return (
    <>
      <header>
        <strong>◈ &nbsp; Bounty</strong>
        <span>FIELD DESK &nbsp; / &nbsp; UK</span>
      </header>
      <main>
        <small>OPERATIONS &nbsp; / &nbsp; PERSONAL WORKSPACE</small>
        <h1>
          {tab === "Planner"
            ? "Bounty planner"
            : tab === "Observations"
              ? "Price observations"
              : "Outcome ledger"}
        </h1>
        <p>
          {tab === "Planner"
            ? "Find the trips that fit your cash, time and carrying capacity."
            : tab === "Observations"
              ? "Dated UK shelf and receipt observations from Open Prices."
              : "Review your recorded proceeds, costs and working time."}
        </p>
        <nav>
          {["Planner", "Observations", "Ledger"].map((t) => (
            <button key={t} aria-pressed={t === tab} onClick={() => T(t)}>
              {t}
            </button>
          ))}
        </nav>
        {message && <p role="status">{message}</p>}
        {tab === "Planner" && (
          <div className="layout">
            <aside>
              <small>01 / PARAMETERS</small>
              <h2>Your buying profile</h2>
              <label>
                Local area
                <input
                  value={profile.area}
                  onChange={(e) => P({ ...profile, area: e.target.value })}
                />
              </label>
              <label>
                Transport
                <select
                  value={profile.transport}
                  onChange={(e) => P({ ...profile, transport: e.target.value })}
                >
                  {["Walk", "Bicycle", "Car", "Van"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              {fields.map(([k, title]) => (
                <label key={k}>
                  {title}
                  <input
                    type="number"
                    min={k === "quantity" ? 1 : 0}
                    step={k === "quantity" ? 1 : "any"}
                    value={profile[k]}
                    onChange={(e) =>
                      P({ ...profile, [k]: Number(e.target.value) })
                    }
                  />
                </label>
              ))}
            </aside>
            <section>
              <small>02 / RANKED OPPORTUNITIES</small>
              <h2>Local shortlist</h2>
              <p className="notice">
                Scenario mode · Illustrative Leeds offers and sold prices. Stock
                and earnings are simulated.
              </p>
              {offers.map((o) => (
                <button
                  key={o.sku}
                  className={"card " + (o.sku === offer?.sku ? "active" : "")}
                  onClick={() => S(o.sku)}
                >
                  <span>
                    <small>
                      {o.shop} · {o.miles} mi
                    </small>
                    <b>{o.name}</b>
                    <em>{o.reason}</em>
                  </span>
                  <span>
                    <b>{money(o.profit)}</b>
                    <small>{money(o.hourly)}/hr</small>
                  </span>
                </button>
              ))}
              {offer && (
                <article>
                  <small>03 / TRIP CALCULATION</small>
                  <h2>{offer.name}</h2>
                  <p>
                    {offer.variant} · {offer.q} units ·{" "}
                    {(offer.weight * offer.q).toFixed(2)} kg · {offer.minutes}{" "}
                    active minutes
                  </p>
                  <dl>
                    {Object.entries({
                      proceeds: offer.proceeds,
                      ...offer.costs,
                      contribution: offer.profit,
                    }).map(([key, value]) => (
                      <React.Fragment key={key}>
                        <dt>{key}</dt>
                        <dd>{money(value)}</dd>
                      </React.Fragment>
                    ))}
                  </dl>
                  <details>
                    <summary>Evidence and assumptions</summary>
                    <p>
                      Fixture source · No live sale date. Modelled sale totals
                      including postage: {offer.sales.map(money).join(", ")}.
                      Conservative median used: {money(offer.sold)}. Buy price:{" "}
                      {money(offer.buy)}. Assumes every unit sells. Fees use a
                      sample 13% plus 40p per item, with a 5% returns allowance.
                      Travel time includes a return journey.
                    </p>
                  </details>
                  <details>
                    <summary>Record an outcome</summary>
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        const f = new FormData(e.currentTarget);
                        Q(true);
                        try {
                          await api("outcomes", {
                            sku: offer.sku,
                            received: Math.round(
                              Number(f.get("received")) * 100,
                            ),
                            costs: Math.round(Number(f.get("costs")) * 100),
                            minutes: Number(f.get("minutes")),
                          });
                          T("Ledger");
                        } catch (err) {
                          M(String(err));
                        } finally {
                          Q(false);
                        }
                      }}
                    >
                      {["received", "costs", "minutes"].map((key, i) => (
                        <label key={key}>
                          {
                            [
                              "Actual proceeds (£)",
                              "Total actual costs (£)",
                              "Active minutes",
                            ][i]
                          }
                          <input
                            required
                            name={key}
                            type="number"
                            min={i === 2 ? 1 : 0}
                            step={i === 2 ? 1 : 0.01}
                          />
                        </label>
                      ))}
                      <button disabled={busy}>Save outcome</button>
                    </form>
                  </details>
                </article>
              )}
            </section>
          </div>
        )}
        {tab === "Observations" && (
          <section>
            <p>
              Historical evidence only. Check the observation date and price
              unit.{" "}
              <a href="https://prices.openfoodfacts.org/">Open Prices · ODbL</a>
            </p>
            {!obs.length && (
              <p>
                No observations imported. Run <code>npm run worker</code> and
                reopen this tab.
              </p>
            )}
            {obs.map((r) => (
              <div className="row" key={r.id}>
                <span>
                  <b>{r.title}</b>
                  <small>
                    {r.store} · {r.place} · {r.day}
                  </small>
                </span>
                <span>
                  {money(r.price)} / {r.unit.toLowerCase()}
                </span>
              </div>
            ))}
          </section>
        )}
        {tab === "Ledger" && (
          <section>
            {!log.length && (
              <p>
                No outcomes yet. Open a planner opportunity and enter your
                actual figures.
              </p>
            )}
            {log.map((r) => (
              <div className="row" key={r.id}>
                <span>
                  <b>
                    {r.sku} · {money(r.received - r.costs)} contribution
                  </b>
                  <small>
                    {money(r.received)} received · {money(r.costs)} spent ·{" "}
                    {r.minutes} min
                  </small>
                </span>
                {money(((r.received - r.costs) * 60) / r.minutes)}/hr
              </div>
            ))}
          </section>
        )}
      </main>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
