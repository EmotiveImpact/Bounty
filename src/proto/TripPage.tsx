// My trip, built from the building blocks (src/ui/kit.tsx): is this trip
// worth the journey, the route shop by shop, your cash, carry and space
// limits, and "Fill it for me". It works on the same trip list as the
// My trip drawer. Figures come from the deals (profit after fees and
// postage) and your own settings; anything estimated says so.
import React, { useEffect, useState } from "react";
import { api, money, type Profile } from "../api";
import type { Deal } from "../Deals";
import {
  Answer,
  Button,
  Card,
  Empty,
  Field,
  Label,
  Meter,
  MoneyInput,
  MoreBelow,
  Notice,
  PageHead,
  Row,
  Rows,
  Stepper,
} from "../ui/kit";
import { CrewArt } from "./CrewArt";
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
const shopInitials = (name: string) =>
  name
    .split(/[\s,]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");

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
  legacy,
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
  legacy?: React.ReactNode;
}) {
  const [cash, setCash] = useState(String(p.budget));
  const [cashErr, setCashErr] = useState("");
  const [timing, setTiming] = useState<Timing | null>(null);
  const [more, setMore] = useState(false);
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

  const setQty = (sku: string, n: number) => {
    const next = { ...trip, [sku]: n };
    if (n <= 0) delete next[sku];
    setTrip(next);
  };
  const fill = () => {
    const pounds = Number(cash.replace(/[£,\s]/g, ""));
    if (!Number.isFinite(pounds) || pounds <= 0) return setCashErr("Type how much cash you have, like 60.");
    setCashErr("");
    const pick = fillTrip(deals, Math.round(pounds * 100), p);
    if (!Object.keys(pick).length) return setCashErr("Nothing fits that cash right now. Try a bit more.");
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
  const noTravel = items.length > 0 && f.travel === null;

  const head = (
    <PageHead
      title="My trip"
      tint="pistachio"
      lead="Check the trip is worth the journey before you go. Travel is counted here and never hides a deal."
      aside={
        items.length > 0 && (
          <div className="k-headacts">
            <Button variant="line" onClick={copy}>
              Copy list
            </Button>
            <Button variant="main" onClick={going ? onFinish : onStart}>
              {going ? "Finish trip" : "Start trip"}
            </Button>
          </div>
        )
      }
    />
  );

  const fillCard = (
    <Card>
      <Label>Fill it for me</Label>
      <p className="tp-p">
        Bounty picks finds marked Buy with the best return on your cash, from up to 3 shops, within your carry
        limit and space.{items.length ? " Refilling replaces your list." : ""}
      </p>
      <form
        className="tp-fill"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          fill();
        }}
      >
        <Field label="Cash you have" htmlFor="tp-cash" error={cashErr}>
          <MoneyInput id="tp-cash" value={cash} onChange={(e) => setCash(e.target.value)} />
        </Field>
        <Button variant={items.length ? "line" : "main"} type="submit">
          {items.length ? "Refill my trip" : "Fill my trip"}
        </Button>
      </form>
    </Card>
  );

  const legacyBlock = legacy ? (
    <MoreBelow
      title="Your travel, cash and fees"
      lead="The full planner: how you travel, fares and fuel, selling fees, one-item plans and the several-items basket plan."
      open={more}
      onToggle={() => setMore((m) => !m)}
      showLabel="Show the full planner"
    >
      <div className="legacy">{legacy}</div>
    </MoreBelow>
  ) : null;

  if (!items.length)
    return (
      <div className="tp">
        {head}
        <div className="k-split">
          <Empty
            art={<CrewArt look="hauler-trolley" />}
            title="Nothing on your trip yet"
            text="Add finds from Deals with the + button, or let Bounty fill a trip for the cash you have."
            action={
              <Button variant="main" onClick={() => go("deals")}>
                Browse deals
              </Button>
            }
          />
          {fillCard}
        </div>
        {legacyBlock}
      </div>
    );

  const answer =
    verdict === null
      ? null
      : ({
          ok: { v: "buy", word: "Worth it", why: `It beats your ${money(target)} an hour target.` },
          thin: { v: "think", word: "Thin", why: `It makes money, but less than your ${money(target)} an hour target.` },
          bad: { v: "leave", word: "Not worth it", why: "Travel costs more than this trip keeps." },
        } as const)[verdict];

  const facts: [string, React.ReactNode][] = [
    ["You keep", f.after === null ? money(f.keep) : money(f.after)],
    ["Time", f.minutes === null ? "Not known" : hm(f.minutes)],
    ["Per hour", f.perHour === null ? "Not known" : money(f.perHour)],
    ["Money back", backBy ? "by " + backBy : "Not known"],
  ];

  return (
    <div className="tp">
      {head}
      {sample && (
        <Notice title="Sample data.">Some finds on this trip are illustrations, so their figures are not real offers.</Notice>
      )}
      <div className="k-split">
        <div className="k-col">
          {answer ? (
            <Answer verdict={answer.v} word={answer.word} headline={`${money(f.after ?? 0)} after travel`} why={answer.why} facts={facts}>
              <p className="tp-small">
                {f.stops.length} {f.stops.length === 1 ? "shop" : "shops"}, about {f.routeMiles} miles, {money(f.travel ?? 0)} travel.
                Time adds {SHOP_MINUTES} minutes in each shop. Money back uses the selling pace in your{" "}
                <Button variant="text" size="sm" onClick={() => go("profile")}>
                  settings
                </Button>
                .
              </p>
            </Answer>
          ) : (
            <Card className="tp-pending">
              <Label>Before travel</Label>
              <b className="k-display tp-big">{money(f.keep)}</b>
              <p className="tp-p">
                What this trip keeps after fees and postage. To check it is worth the journey, say how you travel
                in settings.
              </p>
              <div>
                <Button variant="tab" tint="pistachio" onClick={() => go("profile")}>
                  Add how you travel
                </Button>
              </div>
            </Card>
          )}

          <Card>
            <Label aside={<span>nearest first</span>}>Your route</Label>
            {f.stops.map((s, i) => (
              <div key={s.name} className="tp-stop">
                <div className="tp-shop">
                  <span className="tp-n">{i + 1}</span>
                  <b>{s.name}</b>
                  <small>{s.miles !== null ? `${s.miles} mi` : ""}</small>
                </div>
                <Rows>
                  {s.items.map((d) => (
                    <Row
                      key={d.sku}
                      badge={shopInitials(d.shop)}
                      tint="pistachio"
                      title={
                        <button type="button" className="tp-link" onClick={() => openDeal(d.sku)}>
                          {d.name}
                        </button>
                      }
                      sub={`${money(d.buy)} each · keep ${d.unitProfit === null ? "not known" : money(d.unitProfit)} each${
                        d.walkAway !== null ? ` · walk away above ${money(d.walkAway)}` : ""
                      }`}
                      slot={<Stepper label={d.name} value={trip[d.sku]} onChange={(n) => setQty(d.sku, n)} />}
                    />
                  ))}
                </Rows>
              </div>
            ))}
          </Card>
        </div>

        <div className="k-col">
          <Card>
            <Label>Your limits</Label>
            <Meter
              label="Cash"
              value={f.spend}
              max={p.budget * 100}
              shown={`${money(f.spend)} of ${money(p.budget * 100)}`}
              over={f.spend > p.budget * 100}
              ink
            />
            <Meter
              label={"Carry" + (f.noWeight ? ` (${f.noWeight} without a weight)` : "")}
              value={f.kg}
              max={kgMax}
              shown={`${f.kg.toFixed(1)} of ${kgMax} kg`}
              over={f.kg > kgMax}
              ink
            />
            <Meter label="Units" value={f.units} max={unitMax} shown={`${f.units} of ${unitMax}`} over={f.units > unitMax} ink />
            <p className="tp-small">
              From your settings: cash, carry limit by {p.transport.toLowerCase()}, and the smaller of your maximum
              units and storage space.
            </p>
          </Card>
          {warns.length > 0 || noTravel ? (
            <div className="tp-notes">
              {warns.map((w) => (
                <Notice key={w} tone="warn" title="Check first.">
                  {w}
                </Notice>
              ))}
              {noTravel && (
                <Notice title="Travel not counted.">
                  {p.transport === PUBLIC
                    ? "Add your bus or train fare in settings to count travel."
                    : "Say how you travel in settings to count travel and time."}
                </Notice>
              )}
            </div>
          ) : (
            <Notice tone="profit" title="All set.">
              Everything fits your cash, carry limit and space.
            </Notice>
          )}
          {fillCard}
        </div>
      </div>
      {legacyBlock}
    </div>
  );
}
