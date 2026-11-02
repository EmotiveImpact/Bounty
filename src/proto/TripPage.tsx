// My trip as a full page, built from the agreed full-site mock: is this trip
// worth the journey, the route shop by shop, your cash, carry and space
// limits, and "Fill it for me". It works on the same trip list as the
// My trip drawer. Figures come from the deals (profit after fees and
// postage) and your own settings; anything estimated says so.
import React, { useEffect, useState } from "react";
import { api, money, type Profile } from "../api";
import type { Deal } from "../Deals";
import "./trip.css";

type Timing = { daysToSell: number; deliveryDays: number; payoutDelayDays: number };
type Stop = { name: string; miles: number | null; items: Deal[] };

const SHOP_MINUTES = 10; // time inside each shop, an assumption
const HOP_MINUTES = 5; // between shops on one trip, an assumption

const VEHICLES = new Set(["Car", "Van"]);
const PUBLIC = "Public transport";

/** The load you can take home, as the Trip planner works it out. */
export function carryLimit(p: Profile) {
  if (VEHICLES.has(p.transport)) return Math.max(p.carry, 25);
  if (p.transport === PUBLIC) return Math.min(p.carry, 10);
  return p.carry;
}

function stopsOf(items: Deal[]): Stop[] {
  const m = new Map<string, Stop>();
  for (const d of items) {
    const k = d.shop + (d.area ? ", " + d.area : "");
    const s = m.get(k) ?? { name: k, miles: d.miles, items: [] };
    s.items.push(d);
    m.set(k, s);
  }
  return [...m.values()].sort((a, b) => (a.miles ?? 99) - (b.miles ?? 99));
}

/** Everything the page shows about one trip list. */
export function tripFigures(items: Deal[], trip: Record<string, number>, p: Profile) {
  const units = items.reduce((a, d) => a + trip[d.sku], 0);
  const spend = items.reduce((a, d) => a + d.buy * trip[d.sku], 0);
  const keep = items.reduce((a, d) => a + (d.unitProfit ?? 0) * trip[d.sku], 0);
  const kg = items.reduce((a, d) => a + (d.weight ?? 0) * trip[d.sku], 0);
  const noWeight = items.filter((d) => d.weight === null).length;
  const stops = stopsOf(items);
  const far = Math.max(0, ...stops.map((s) => s.miles ?? 0));
  const routeMiles = stops.length ? +(far * 2 + (stops.length - 1) * 0.4).toFixed(1) : 0;
  // Travel: the furthest shop's return journey from the deals, plus the
  // short hops between shops by car or van.
  const legs = items.filter((d) => d.travel.added);
  const travelKnown = items.length > 0 && legs.length === items.length && legs.every((d) => d.travel.cost !== null);
  const base = travelKnown ? Math.max(0, ...legs.map((d) => d.travel.cost ?? 0)) : null;
  const hop = VEHICLES.has(p.transport) ? Math.round((routeMiles - far * 2) * p.perMile) : 0;
  const travel = base === null ? null : base + Math.max(0, hop);
  const legMinutes = legs.map((d) => d.travel.minutes).filter((m): m is number => m !== null);
  const minutes =
    items.length && legMinutes.length === legs.length && legs.length === items.length
      ? Math.max(...legMinutes) + stops.length * SHOP_MINUTES + (stops.length - 1) * HOP_MINUTES
      : null;
  const after = travel === null ? null : keep - travel;
  const perHour = after !== null && minutes ? Math.round((after * 60) / minutes) : null;
  return { units, spend, keep, kg, noWeight, stops, routeMiles, travel, minutes, after, perHour };
}

/** Picks the best finds within the cash, carry, unit and space limits. */
export function fillTrip(deals: Deal[], cash: number, p: Profile) {
  const kgMax = carryLimit(p);
  const unitMax = Math.min(p.quantity, p.storage);
  const pool = deals
    .filter((d) => d.unitProfit !== null && d.unitProfit > 0 && d.verdict === "buy" && d.buy > 0)
    .sort((a, b) => b.unitProfit! / b.buy - a.unitProfit! / a.buy);
  const pick: Record<string, number> = {};
  const shops = new Set<string>();
  let left = cash,
    kg = 0,
    n = 0;
  for (const d of pool) {
    if (!shops.has(d.shop) && shops.size >= 3) continue;
    let u = Math.min(d.stock ?? 2, 3, unitMax - n, Math.floor(left / d.buy));
    if (d.weight) u = Math.min(u, Math.floor((kgMax - kg) / d.weight));
    if (u <= 0) continue;
    pick[d.sku] = u;
    shops.add(d.shop);
    left -= u * d.buy;
    kg += u * (d.weight ?? 0);
    n += u;
  }
  return pick;
}

const hm = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);
const ukDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });
const pct = (a: number, b: number) => Math.max(0, Math.min(100, b > 0 ? (a / b) * 100 : 0));

export default function TripPage({
  deals,
  trip,
  setTrip,
  profile: p,
  going,
  onStart,
  onFinish,
  openDeal,
  say,
  go,
}: {
  deals: Deal[];
  trip: Record<string, number>;
  setTrip: (t: Record<string, number>) => void;
  profile: Profile;
  going: boolean;
  onStart: () => void;
  onFinish: () => void;
  openDeal: (sku: string) => void;
  say: (t: string) => void;
  go: (v: "deals" | "profile") => void;
}) {
  const [cash, setCash] = useState(String(p.budget));
  const [timing, setTiming] = useState<Timing | null>(null);
  useEffect(() => {
    api<Timing>("goals")
      .then(setTiming)
      .catch(() => undefined);
  }, []);

  const bySku = new Map(deals.map((d) => [d.sku, d]));
  const items = Object.keys(trip)
    .filter((s) => bySku.has(s))
    .map((s) => bySku.get(s)!);
  const f = tripFigures(items, trip, p);
  const target = p.target * 100; // pence an hour
  const verdict =
    !items.length || f.after === null
      ? null
      : f.after <= 0
        ? "bad"
        : f.perHour !== null && f.perHour < target
          ? "thin"
          : "ok";
  const backBy =
    timing && items.length
      ? ukDate.format(
          new Date(Date.now() + (timing.daysToSell + timing.deliveryDays + timing.payoutDelayDays) * 86400000),
        )
      : null;

  const qty = (sku: string, by: number) => {
    const n = { ...trip, [sku]: (trip[sku] ?? 0) + by };
    if (n[sku] <= 0) delete n[sku];
    setTrip(n);
  };
  const fill = () => {
    const pounds = Number(cash);
    if (!Number.isFinite(pounds) || pounds <= 0) return say("Type how much cash you have, in pounds.");
    const pick = fillTrip(deals, Math.round(pounds * 100), p);
    if (!Object.keys(pick).length) return say("Nothing fits that cash right now. Try a bit more.");
    setTrip(pick);
    say("Filled with the best finds for £" + pounds.toLocaleString("en-GB") + ".");
  };
  const copy = async () => {
    const text = f.stops
      .map((s) => s.name + "\n" + s.items.map((d) => `  ${trip[d.sku]} × ${d.name} at ${money(d.buy)}`).join("\n"))
      .join("\n");
    try {
      await navigator.clipboard.writeText("My Bounty trip\n" + text);
      say("Trip list copied. Paste it anywhere.");
    } catch {
      say("Could not copy the list on this device.");
    }
  };

  const kgMax = carryLimit(p);
  const unitMax = Math.min(p.quantity, p.storage);
  const warns: string[] = [];
  if (f.spend > p.budget * 100) warns.push(`This spends ${money(f.spend - p.budget * 100)} more than your ${money(p.budget * 100)} cash.`);
  if (f.kg > kgMax) warns.push(`About ${f.kg.toFixed(1)} kg is more than the ${kgMax} kg you can take home.`);
  if (f.units > unitMax) warns.push(`${f.units} units is more than the ${unitMax} you said you have room for.`);
  for (const d of items) {
    if (d.stock !== null && trip[d.sku] > d.stock)
      warns.push(`${d.name}: only ${d.stock} on the shelf${d.stockChecked ? "" : " (assumed)"}.`);
    if (d.unitProfit === null) warns.push(`${d.name}: profit not known yet, so it is not counted.`);
  }
  const sample = items.some((d) => d.sample);
  if (items.length && f.travel === null)
    warns.push(
      p.transport === PUBLIC
        ? "Add your bus or train fare in settings to count travel."
        : "Say how you travel in settings to count travel and time.",
    );

  const head = (
    <div className="titlebar">
      <div>
        <h1>My trip</h1>
        <p>Check the trip is worth the journey before you go. Travel is counted here and never hides a deal.</p>
      </div>
      {items.length > 0 && (
        <div className="btns">
          <button type="button" className="bt ghost" onClick={copy}>
            Copy list
          </button>
          {going ? (
            <button type="button" className="bt" onClick={onFinish}>
              Finish trip
            </button>
          ) : (
            <button type="button" className="bt" onClick={onStart}>
              Start trip
            </button>
          )}
        </div>
      )}
    </div>
  );

  const fillPanel = (
    <div className="panel fillbar">
      <h3>
        Fill it for me <small>best finds for your cash</small>
      </h3>
      <div>
        <label className="cashin">
          Cash, £
          <input type="number" min={1} inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} />
        </label>
        <button type="button" className="bt sm" onClick={fill}>
          {items.length ? "Refill my trip" : "Fill my trip"}
        </button>
      </div>
      <small className="muted">
        Picks finds marked Buy with the best return on cash, up to 3 shops, within your carry limit and
        space. {items.length ? "Refilling replaces your list." : ""}
      </small>
    </div>
  );

  if (!items.length)
    return (
      <>
        {head}
        <div className="tripgrid">
          <div className="panel tnone">
            <h3>Nothing on your trip yet</h3>
            <p className="muted">
              Add finds from Deals with the + button, or let Bounty fill a trip for the cash you have.
            </p>
            <button type="button" className="bt ghost sm" onClick={() => go("deals")}>
              Browse deals
            </button>
          </div>
          {fillPanel}
        </div>
      </>
    );

  const words = {
    ok: ["Worth it", `It beats your ${money(target)} an hour target.`],
    thin: ["Thin", `It makes money but less than your ${money(target)} an hour target.`],
    bad: ["Not worth it", "Travel costs more than this trip keeps."],
  };

  return (
    <>
      {head}
      {sample && (
        <p className="note">Some finds on this trip are sample data, so their figures are illustrations.</p>
      )}
      <div className="tripgrid">
        <div className="tcol">
          <div className={"panel worth " + (verdict ?? "")}>
            <div className="wtop">
              <span className="wv">{verdict ? words[verdict][0] : "Not checked yet"}</span>
              <span>{verdict ? words[verdict][1] : "Add how you travel to check it."}</span>
            </div>
            <div className="wnums">
              <div>
                <small>You keep</small>
                <b>{f.after === null ? money(f.keep) : money(f.after)}</b>
                <span>{f.travel === null ? "before travel" : `after ${money(f.travel)} travel`}</span>
              </div>
              <div>
                <small>Time</small>
                <b>{f.minutes === null ? "Not known" : hm(f.minutes)}</b>
                <span>
                  {f.stops.length} {f.stops.length === 1 ? "shop" : "shops"}, about {f.routeMiles} miles
                </span>
              </div>
              <div>
                <small>Per hour</small>
                <b>{f.perHour === null ? "Not known" : money(f.perHour)}</b>
                <span>your target {money(target)}</span>
              </div>
              <div>
                <small>Money back</small>
                <b>{backBy ? "by " + backBy : "Not known"}</b>
                <span>if it sells at your usual pace</span>
              </div>
            </div>
            <small className="muted">
              Time adds {SHOP_MINUTES} minutes in each shop to your journey. Money back uses the selling
              pace in{" "}
              <button type="button" className="linkbtn" onClick={() => go("profile")}>
                settings
              </button>
              .
            </small>
          </div>

          <div className="panel">
            <h3>
              Your route <small>nearest first</small>
            </h3>
            {f.stops.map((s, i) => (
              <React.Fragment key={s.name}>
                <div className="tstop">
                  <span className="sn">{i + 1}</span>
                  <b>{s.name}</b>
                  <small>{s.miles !== null ? `${s.miles} mi` : ""}</small>
                </div>
                {s.items.map((d) => (
                  <div key={d.sku} className="trow">
                    <div className="tname">
                      <button type="button" className="linkish" onClick={() => openDeal(d.sku)}>
                        {d.name}
                      </button>
                      <small>
                        {money(d.buy)} each · keep {d.unitProfit === null ? "not known" : money(d.unitProfit)} each
                        {d.walkAway !== null ? ` · walk away above ${money(d.walkAway)}` : ""}
                      </small>
                    </div>
                    <div className="qty">
                      <button type="button" aria-label="One fewer" onClick={() => qty(d.sku, -1)}>
                        −
                      </button>
                      <span>{trip[d.sku]}</span>
                      <button type="button" aria-label="One more" onClick={() => qty(d.sku, 1)}>
                        +
                      </button>
                    </div>
                  </div>
                ))}
              </React.Fragment>
            ))}
          </div>
        </div>

        <div className="tcol">
          <div className="panel">
            <h3>Your limits</h3>
            <div className="lim">
              <div className="row2">
                <span>Cash</span>
                <span>
                  {money(f.spend)} of {money(p.budget * 100)}
                </span>
              </div>
              <div className={"bar" + (f.spend > p.budget * 100 ? " over" : "")}>
                <i style={{ width: pct(f.spend, p.budget * 100) + "%" }} />
              </div>
            </div>
            <div className="lim">
              <div className="row2">
                <span>Carry</span>
                <span>
                  {f.kg.toFixed(1)} of {kgMax} kg{f.noWeight ? ` (${f.noWeight} without a weight)` : ""}
                </span>
              </div>
              <div className={"bar" + (f.kg > kgMax ? " over" : "")}>
                <i style={{ width: pct(f.kg, kgMax) + "%" }} />
              </div>
            </div>
            <div className="lim">
              <div className="row2">
                <span>Units</span>
                <span>
                  {f.units} of {unitMax}
                </span>
              </div>
              <div className={"bar" + (f.units > unitMax ? " over" : "")}>
                <i style={{ width: pct(f.units, unitMax) + "%" }} />
              </div>
            </div>
            <small className="muted">
              From your settings: cash, carry limit by {p.transport.toLowerCase()}, and the smaller of your
              maximum units and storage space.
            </small>
          </div>
          {warns.length > 0 ? (
            <div className="panel warnp">
              <h3>Check before you go</h3>
              {warns.map((w) => (
                <p key={w}>{w}</p>
              ))}
            </div>
          ) : (
            <div className="panel okp">Everything fits your cash, carry limit and space.</div>
          )}
          {fillPanel}
        </div>
      </div>
    </>
  );
}
