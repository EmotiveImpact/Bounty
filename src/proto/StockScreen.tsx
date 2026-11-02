// Stock, built from the building blocks (src/ui/kit.tsx). Each open trip is
// one card with one main button for its next step (a sale, the money
// arriving, closing it), everything else under More, and the full detail in
// a window. Every action is a dated ledger entry, so Money updates from it.
// The older full records (proofs, checks, editing) open below on request.
import React, { useEffect, useRef, useState } from "react";
import { api, money, toPence } from "../api";
import { readBase64 } from "../Ledger";
import {
  Button,
  Card,
  Chip,
  Empty,
  Field,
  Figure,
  Figures,
  Input,
  Menu,
  Meter,
  MoneyInput,
  Notice,
  PageHead,
  Row,
  Rows,
  Segmented,
  Tabs,
  Toasts,
  Window,
  useToast,
  type ChipTone,
  type MenuItem,
} from "../ui/kit";
import { CrewArt } from "./CrewArt";
import { EXAMPLE_NOTE, EXAMPLE_TRIPS, type ExampleTrip } from "./examples";
import "./stock.css";

type EntryType = "receipt" | "sale" | "payout" | "expense" | "refund" | "work" | "saving";
type TripRow = {
  id: number;
  label: string;
  kind: "resale" | "household";
  status: "open" | "closed";
  sample: boolean;
  created: string;
  realisedContribution: number | null;
  pendingPayout: number;
  unsoldUnits: number | null;
  verified: boolean;
};
type Entry = {
  id: number;
  type: EntryType;
  amount: number | null;
  units: number | null;
  reference: string | null;
  occurred: string;
  minutes?: number | null;
  note?: string | null;
};
type Detail = {
  entries: Entry[];
  reconciliation: { payouts: number; spend: number; unitsBought: number; unitsSold: number; cashTiedUp: number };
};
type Summary = { pendingPayouts: number; cashTiedUp?: number; unsoldUnits?: number; realisedEarnings: number };
type Action = "sale" | "payout" | "expense" | "refund" | "work" | "receipt";
type Stage = "plan" | "bought" | "sell" | "wait" | "done" | "closed" | "hh";

const ACTION_LABEL: Record<Action, string> = {
  receipt: "Add a purchase",
  sale: "Record a sale",
  payout: "Money arrived",
  expense: "Add a cost",
  refund: "Record a return",
  work: "Add time",
};
const ACTION_ORDER: Action[] = ["sale", "payout", "receipt", "expense", "refund", "work"];
const COSTS: [string, string][] = [
  ["Postage", "Postage"],
  ["Packaging", "Packaging"],
  ["Selling fees", "Selling fees"],
  ["Fuel or fares", "Fuel or fares"],
  ["Parking", "Parking"],
  ["Other", "Other"],
];
const PROOF_TYPES = ["image/jpeg", "image/png", "application/pdf"];
// Purchases recorded without an item name are grouped under this.
const UNNAMED = "Items on this trip";

const STAGE: Record<Stage, [string, ChipTone]> = {
  plan: ["Planned", "plan"],
  bought: ["Bought", "bought"],
  sell: ["Selling", "listed"],
  wait: ["Sold, waiting for money", "wait"],
  done: ["All sold and paid", "paid"],
  closed: ["Finished", "done"],
  hh: ["Household", "plan"],
};
const ENTRY_LABEL: Record<EntryType, string> = {
  receipt: "Bought",
  sale: "Sold",
  payout: "Money arrived",
  expense: "Cost",
  refund: "Returned",
  work: "Time",
  saving: "Saving",
};

const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const shortDate = (iso: string) => {
  const d = new Date(iso.length === 10 ? iso + "T12:00:00" : iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });
};
const initials = (s: string) =>
  s
    .split(/\s+/)
    .filter((w) => /^[A-Za-z0-9]/.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("") || "•";

/** Items on a trip, from its purchase entries, with what has sold. */
function itemsOf(entries: Entry[]) {
  const m = new Map<string, { name: string; bought: number; paid: number; sold: number; returned: number }>();
  const row = (name: string) => {
    const r = m.get(name) ?? { name, bought: 0, paid: 0, sold: 0, returned: 0 };
    m.set(name, r);
    return r;
  };
  for (const e of entries) {
    const name = e.reference?.trim() || UNNAMED;
    if (e.type === "receipt") {
      const r = row(name);
      r.bought += e.units ?? 0;
      r.paid += e.amount ?? 0;
    } else if (e.type === "sale" && m.has(name)) row(name).sold += e.units ?? 0;
    else if (e.type === "refund" && m.has(name)) row(name).returned += e.units ?? 0;
  }
  return [...m.values()];
}

function stageOf(t: TripRow, d: Detail | undefined): Stage {
  if (t.kind === "household") return "hh";
  if (t.status === "closed") return "closed";
  const r = d?.reconciliation;
  if (!r || r.unitsBought === 0) return "plan";
  if (t.pendingPayout > 0) return "wait";
  if (r.unitsSold === 0) return "bought";
  if ((t.unsoldUnits ?? 0) > 0) return "sell";
  return "done";
}

/** The likely next step for a trip at this stage. */
const NEXT: Record<Stage, Action | "close" | "details"> = {
  plan: "receipt",
  bought: "sale",
  sell: "sale",
  wait: "payout",
  done: "close",
  closed: "details",
  hh: "details",
};

type Open =
  | { kind: "entry"; trip: TripRow; action: Action; item?: string }
  | { kind: "details"; trip: TripRow }
  | { kind: "close"; trip: TripRow }
  | { kind: "example"; ex: ExampleTrip }
  | null;

const EXAMPLES_KEY = "bounty.stock.examples";
function readShowExamples() {
  try {
    return localStorage.getItem(EXAMPLES_KEY) !== "hide";
  } catch {
    return true;
  }
}

export default function StockScreen(props: { legacy: React.ReactNode; go: (v: "money" | "deals") => void }) {
  return (
    <Toasts>
      <Stock {...props} />
    </Toasts>
  );
}

function Stock({ legacy, go }: { legacy: React.ReactNode; go: (v: "money" | "deals") => void }) {
  const say = useToast();
  const [trips, setTrips] = useState<TripRow[] | null>(null);
  const [details, setDetails] = useState<Record<number, Detail>>({});
  const [sum, setSum] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<Open>(null);
  const [tab, setTab] = useState<"open" | "done">("open");
  const [records, setRecords] = useState(false);
  const [examples, setExamples] = useState(readShowExamples);
  const toggleExamples = () =>
    setExamples((v) => {
      try {
        localStorage.setItem(EXAMPLES_KEY, v ? "hide" : "show");
      } catch {
        // Still works for this visit.
      }
      return !v;
    });
  const recordsRef = useRef<HTMLElement>(null);
  const refresh = () => setVersion((v) => v + 1);

  useEffect(() => {
    let active = true;
    api<{ trips: TripRow[] }>("ledger/trips")
      .then(async ({ trips }) => {
        const shown = trips.filter((t) => t.status === "open");
        const pairs = await Promise.all(
          shown.map((t) => api<Detail>("ledger/trips/" + t.id).then((d) => [t.id, d] as const)),
        );
        if (!active) return;
        setTrips(trips);
        setDetails(Object.fromEntries(pairs));
        setError("");
      })
      .catch((e) => active && setError((e as Error).message));
    api<Summary>("ledger/summary")
      .then((s) => active && setSum(s))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [version]);

  const openTrips = (trips ?? []).filter((t) => t.status === "open");
  const finished = (trips ?? []).filter((t) => t.status === "closed");

  async function closeTrip(t: TripRow) {
    try {
      await api("ledger/trips/" + t.id + "/close", {});
      setOpen(null);
      say(`${t.label} moved to Finished.`);
      refresh();
    } catch (e) {
      say((e as Error).message);
    }
  }

  function showRecords() {
    setOpen(null);
    setRecords(true);
    requestAnimationFrame(() => recordsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  const openList =
    trips && openTrips.length === 0 ? (
      <Empty
        art={<CrewArt look="fixer-handover" />}
        title="No open trips"
        text="Plan a trip from Deals, tick things off in the shop, then press Finish trip. What you got lands here, ready to sell."
        action={
          <Button variant="main" onClick={() => go("deals")}>
            Browse deals
          </Button>
        }
      />
    ) : (
      <div className="sk-cards">
        {openTrips.map((t) => (
          <TripCard
            key={t.id}
            trip={t}
            detail={details[t.id]}
            onAction={(action, item) => setOpen({ kind: "entry", trip: t, action, item })}
            onDetails={() => setOpen({ kind: "details", trip: t })}
            onClose={() => setOpen({ kind: "close", trip: t })}
          />
        ))}
      </div>
    );

  const doneList =
    finished.length === 0 ? (
      <Empty art={<CrewArt look="fixer-parcels" />} title="Nothing finished yet" text="When every item on a trip is sold and paid, close it and it moves here." />
    ) : (
      <Card>
        <Rows>
          {finished.map((t) => (
            <Row
              key={t.id}
              badge={initials(t.label)}
              tint="pistachio"
              title={t.label}
              sub={"Started " + shortDate(t.created) + (t.sample ? " · sample" : "")}
              value={t.realisedContribution === null ? "Not known" : money(t.realisedContribution)}
              valueNote={t.realisedContribution === null ? undefined : t.realisedContribution >= 0 ? "kept" : "lost"}
              tone={(t.realisedContribution ?? -1) >= 0 ? "profit" : undefined}
              onClick={() => setOpen({ kind: "details", trip: t })}
            />
          ))}
        </Rows>
      </Card>
    );

  return (
    <div className="sk">
      <PageHead
        title="Stock"
        tint="peach"
        lead="From the shelf to the payout. Each step you record here updates Money."
      />
      {sum && (
        <Figures>
          <Figure
            label="Kept this month"
            value={money(sum.realisedEarnings)}
            tone={sum.realisedEarnings >= 0 ? "profit" : "loss"}
            note={
              <Button variant="text" size="sm" onClick={() => go("money")}>
                See Money
              </Button>
            }
          />
          <Figure label="Waiting for money" value={money(sum.pendingPayouts)} note="sold, not paid out yet" />
          <Figure
            label="Not sold yet"
            value={`${sum.unsoldUnits ?? 0} ${sum.unsoldUnits === 1 ? "unit" : "units"}`}
            note={`${money(sum.cashTiedUp ?? 0)} of your cash`}
          />
        </Figures>
      )}
      {error && (
        <Notice tone="loss" title="Not loaded.">
          Your stock could not be loaded ({error}).
        </Notice>
      )}
      {trips && (
        <Tabs
          label="Trips"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "open", label: "Open", count: openTrips.length, content: openList },
            { value: "done", label: "Finished", count: finished.length, content: doneList },
          ]}
        />
      )}

      <section className="sk-examples" aria-label="Example trips">
        <div className="sk-rechead">
          <div>
            <h2 className="k-display">Example trips</h2>
            <p>Made up to show how Stock works. Nothing here is saved, and none of it counts in your totals or in Money.</p>
          </div>
          <Button variant="line" onClick={toggleExamples} aria-expanded={examples}>
            {examples ? "Hide examples" : "Show examples"}
          </Button>
        </div>
        {examples && (
          <div className="sk-cards">
            {EXAMPLE_TRIPS.map((ex) => (
              <TripCard
                key={ex.trip.id}
                trip={ex.trip}
                detail={ex.detail}
                example
                onAction={() => say(EXAMPLE_NOTE)}
                onDetails={() => setOpen({ kind: "example", ex })}
                onClose={() => say(EXAMPLE_NOTE)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="sk-records" ref={recordsRef}>
        <div className="sk-rechead">
          <div>
            <h2 className="k-display">Full records</h2>
            <p>Every entry and proof, the checks behind Verified, and how each trip compared with its prediction.</p>
          </div>
          <Button variant="line" onClick={() => setRecords((r) => !r)} aria-expanded={records}>
            {records ? "Hide full records" : "Show full records"}
          </Button>
        </div>
        {records && <div className="legacy">{legacy}</div>}
      </section>

      {open?.kind === "entry" && (
        <EntryWindow
          key={open.trip.id + open.action + (open.item ?? "")}
          trip={open.trip}
          action={open.action}
          item={open.item}
          items={itemsOf(details[open.trip.id]?.entries ?? []).map((i) => i.name)}
          onClose={() => setOpen(null)}
          onSaved={(text, undo) => {
            setOpen(null);
            say(text, undo ? () => undo().then(refresh, (e) => say((e as Error).message)) : undefined);
            refresh();
          }}
        />
      )}
      {open?.kind === "details" && (
        <DetailsWindow
          trip={open.trip}
          version={version}
          onClose={() => setOpen(null)}
          onAction={(action, item) => setOpen({ kind: "entry", trip: open.trip, action, item })}
          onRecords={showRecords}
        />
      )}
      {open?.kind === "example" && (
        <DetailsWindow
          trip={open.ex.trip}
          example={open.ex.detail}
          version={version}
          onClose={() => setOpen(null)}
          onAction={() => say(EXAMPLE_NOTE)}
          onRecords={() => say(EXAMPLE_NOTE)}
        />
      )}
      {open?.kind === "close" && (
        <Window
          open
          onOpenChange={(o) => !o && setOpen(null)}
          tint="peach"
          title="Close this trip?"
          description={open.trip.label}
          footer={
            <>
              <Button variant="line" onClick={() => setOpen(null)}>
                Not yet
              </Button>
              <Button variant="main" onClick={() => closeTrip(open.trip)}>
                Close trip
              </Button>
            </>
          }
        >
          <p className="sk-p">
            It moves to Finished and its figures stay in Money. You cannot add to a trip once it is closed, so
            record any last sale, cost or payout first.
          </p>
          {(open.trip.unsoldUnits ?? 0) > 0 && (
            <Notice tone="warn" title="Check first.">
              {open.trip.unsoldUnits} {open.trip.unsoldUnits === 1 ? "unit is" : "units are"} still unsold on this
              trip.
            </Notice>
          )}
          {open.trip.pendingPayout > 0 && (
            <Notice tone="warn" title="Check first.">
              {money(open.trip.pendingPayout)} is still waiting to be paid out.
            </Notice>
          )}
        </Window>
      )}
    </div>
  );
}

function TripCard({
  trip: t,
  detail: d,
  example = false,
  onAction,
  onDetails,
  onClose,
}: {
  trip: TripRow;
  detail: Detail | undefined;
  example?: boolean;
  onAction: (a: Action, item?: string) => void;
  onDetails: () => void;
  onClose: () => void;
}) {
  const stage = stageOf(t, d);
  const [label, tone] = STAGE[stage];
  const next = NEXT[stage];
  const r = d?.reconciliation;
  const rc = t.realisedContribution;
  const resale = t.kind === "resale";
  const main =
    next === "close" ? (
      <Button variant="main" onClick={onClose}>
        Close trip
      </Button>
    ) : next === "details" ? (
      <Button variant="main" onClick={onDetails}>
        Open details
      </Button>
    ) : (
      <Button variant="main" onClick={() => onAction(next)}>
        {next === "receipt" ? "Add what you bought" : ACTION_LABEL[next]}
      </Button>
    );
  const more: MenuItem[] = resale && t.status === "open"
    ? [
        ...ACTION_ORDER.filter((a) => a !== next).map((a) => ({ label: ACTION_LABEL[a], onSelect: () => onAction(a) })),
        ...(next !== "close" ? ["-" as const, { label: "Close trip", onSelect: onClose }] : []),
      ]
    : [];
  const left = r ? Math.max(0, r.unitsBought - r.unitsSold) : 0;

  return (
    <Card className={example ? "sk-card sk-example" : "sk-card"}>
      <div className="sk-top">
        <div className="sk-name">
          <h3>
            <button type="button" className="sk-title k-focus" onClick={onDetails}>
              {t.label}
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </h3>
          <div className="k-chips">
            <Chip tone={tone}>{label}</Chip>
            {t.verified && <Chip tone="buy">Verified</Chip>}
            {t.sample && <Chip tone="sample">Sample</Chip>}
            {example && <Chip tone="sample">Example</Chip>}
          </div>
        </div>
        <div className="sk-money">
          <span>
            <small>Waiting</small>
            <b>{money(t.pendingPayout)}</b>
          </span>
          {rc !== null && (
            <span>
              <small>{rc >= 0 ? "Kept so far" : "To earn back"}</small>
              <b className={rc > 0 ? "profit" : undefined}>{money(Math.abs(rc))}</b>
            </span>
          )}
        </div>
      </div>
      {resale && r && r.unitsBought > 0 && (
        <Meter
          label="Sold"
          value={r.unitsSold}
          max={r.unitsBought}
          shown={`${r.unitsSold} of ${r.unitsBought} · ${left} left`}
        />
      )}
      {!resale && <p className="sk-p">Household savings are recorded in the full records.</p>}
      <div className="sk-acts">
        {main}
        {more.length > 0 && <Menu items={more} />}
        {next !== "details" && (
          <Button variant="text" className="sk-details" onClick={onDetails}>
            Details
          </Button>
        )}
      </div>
    </Card>
  );
}

function DetailsWindow({
  trip: t,
  example,
  version,
  onClose,
  onAction,
  onRecords,
}: {
  trip: TripRow;
  /** A made-up example's figures: shown as they are, never fetched or changed. */
  example?: Detail;
  version: number;
  onClose: () => void;
  onAction: (a: Action, item?: string) => void;
  onRecords: () => void;
}) {
  const [d, setD] = useState<Detail | null>(example ?? null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (example) return;
    let active = true;
    api<Detail>("ledger/trips/" + t.id)
      .then((x) => active && setD(x))
      .catch((e) => active && setErr((e as Error).message));
    return () => {
      active = false;
    };
  }, [t.id, version, example]);
  const stage = stageOf(t, d ?? undefined);
  const [label, tone] = STAGE[stage];
  const items = d ? itemsOf(d.entries) : [];
  const entries = d ? [...d.entries].sort((a, b) => (a.occurred < b.occurred ? 1 : a.occurred > b.occurred ? -1 : b.id - a.id)) : [];
  const open = !example && t.status === "open" && t.kind === "resale";
  const next = NEXT[stage];

  return (
    <Window
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      tint="peach"
      title={t.label}
      description={
        <span className="k-chips" style={{ marginTop: 4 }}>
          <Chip tone={tone}>{label}</Chip>
          {t.verified && <Chip tone="buy">Verified</Chip>}
          {t.sample && <Chip tone="sample">Sample</Chip>}
          {example && <Chip tone="sample">Example</Chip>}
        </span>
      }
      footer={
        <>
          {example ? (
            <span className="sk-p" style={{ marginRight: "auto" }}>
              Made up to show how a trip adds up. Not saved, not counted.
            </span>
          ) : (
            <Button variant="text" onClick={onRecords} style={{ marginRight: "auto" }}>
              Proofs and checks
            </Button>
          )}
          {open && next !== "close" && next !== "details" && (
            <Button variant="main" onClick={() => onAction(next)}>
              {next === "receipt" ? "Add what you bought" : ACTION_LABEL[next]}
            </Button>
          )}
        </>
      }
    >
      {err && (
        <Notice tone="loss" title="Not loaded.">
          {err}
        </Notice>
      )}
      {!d && !err && <p className="sk-p">Loading…</p>}
      {d && (
        <>
          <div className="sk-wfigs">
            <Figure label="You spent" value={money(d.reconciliation.spend)} />
            <Figure label="Paid out to you" value={money(d.reconciliation.payouts)} />
            <Figure label="Waiting" value={money(t.pendingPayout)} />
            <Figure label="Cash in stock" value={money(d.reconciliation.cashTiedUp)} />
          </div>
          {items.length > 0 && (
            <div className="sk-sec">
              <h4>What you bought</h4>
              <Rows>
                {items.map((it) => {
                  const left = Math.max(0, it.bought - it.sold);
                  return (
                    <Row
                      key={it.name}
                      badge={left}
                      tint={left ? "peach" : "lime"}
                      title={it.name}
                      sub={`${it.bought} at ${money(it.bought ? Math.round(it.paid / it.bought) : 0)} each · ${it.sold} sold${
                        it.returned ? ` · ${it.returned} returned` : ""
                      }`}
                      slot={
                        open && left > 0 ? (
                          <Button size="sm" onClick={() => onAction("sale", it.name)}>
                            Sold one
                          </Button>
                        ) : (
                          <span className="sk-left">{left ? `${left} left` : "All sold"}</span>
                        )
                      }
                    />
                  );
                })}
              </Rows>
            </div>
          )}
          <div className="sk-sec">
            <h4>Everything recorded</h4>
            {entries.length === 0 ? (
              <p className="sk-p">Nothing recorded on this trip yet.</p>
            ) : (
              <Rows>
                {entries.map((e) => (
                  <Row
                    key={e.id}
                    date={{ day: shortDate(e.occurred).split(" ")[0], month: shortDate(e.occurred).split(" ")[1] ?? "" }}
                    tint={e.type === "payout" ? "lime" : e.type === "sale" ? "sky" : e.type === "receipt" ? "peach" : undefined}
                    title={ENTRY_LABEL[e.type] + (e.reference ? ": " + e.reference : e.note ? ": " + e.note : "")}
                    sub={e.units ? `${e.units} ${e.units === 1 ? "unit" : "units"}` : e.type === "work" ? "Shopping, listing or packing" : undefined}
                    value={
                      e.type === "work"
                        ? `${Math.round(((e.minutes ?? 0) / 60) * 100) / 100} h`
                        : money(e.amount ?? 0)
                    }
                    tone={e.type === "payout" ? "profit" : undefined}
                  />
                ))}
              </Rows>
            )}
          </div>
        </>
      )}
    </Window>
  );
}

function EntryWindow({
  trip,
  action,
  item,
  items,
  onClose,
  onSaved,
}: {
  trip: TripRow;
  action: Action;
  item?: string;
  items: string[];
  onClose: () => void;
  onSaved: (text: string, undo?: () => Promise<unknown>) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [cost, setCost] = useState("Postage");
  const withItem = action === "sale" || action === "refund" || action === "receipt";
  const withUnits = withItem || action === "payout";
  const withProof = action === "receipt" || action === "payout";
  const formId = "entry-" + trip.id;
  const listId = "items-" + trip.id;

  async function submit(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    const v = (k: string) => String(f.get(k) ?? "").trim();
    const bad: Record<string, string> = {};
    const body: Record<string, unknown> = { type: action, occurred: v("date") || today() };
    if (action === "work") {
      const mins = Math.round(Number(v("hours")) * 60);
      if (!Number.isFinite(mins) || mins < 1) bad.hours = "Say how long in hours, like 1.5.";
      else body.minutes = mins;
    } else {
      const pounds = Number(v("amount").replace(/[£,\s]/g, ""));
      if (!v("amount") || !Number.isFinite(pounds) || pounds <= 0) bad.amount = "Type the amount in pounds, like 9.50.";
      else body.amount = toPence(pounds);
    }
    if (withUnits && v("units")) {
      const n = Number(v("units"));
      if (!Number.isInteger(n) || n < 1) bad.units = "A whole number, like 1.";
      else body.units = n;
    }
    if (withItem) {
      if (!v("item")) bad.item = "Say which item.";
      else if (v("item") !== UNNAMED) body.reference = v("item").slice(0, 120);
      if (!v("units")) bad.units = "Say how many.";
    }
    if (action === "expense") body.note = cost;
    const file = withProof ? (f.get("proof") as File | null) : null;
    if (file && file.size && !PROOF_TYPES.includes(file.type)) bad.proof = "A photo (JPEG or PNG) or a PDF, please.";
    setErrs(bad);
    if (Object.keys(bad).length) return;
    setBusy(true);
    try {
      const r = await api<{ id: number }>("ledger/trips/" + trip.id + "/entries", body);
      const withFile = !!(file && file.size);
      if (withFile)
        await api("ledger/trips/" + trip.id + "/proofs", {
          label: (action === "receipt" ? "Receipt " : "Payout ") + body.occurred,
          mediaType: file!.type,
          data: await readBase64(file!),
          entryId: r.id,
        });
      const undo = withFile
        ? undefined
        : () => api("ledger/trips/" + trip.id + "/entries/" + r.id, {}, "DELETE");
      onSaved(
        {
          sale: "Sale recorded. It waits until the money arrives.",
          payout: "Money recorded. Money counts it as kept.",
          expense: "Cost added.",
          refund: "Return recorded.",
          work: "Time added to your hourly rate.",
          receipt: "Purchase added.",
        }[action],
        undo,
      );
    } catch (e) {
      setErrs({ form: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const amountLabel = {
    sale: "Buyer paid",
    payout: "Paid to you",
    expense: "It cost",
    refund: "Refunded",
    receipt: "You paid in total",
    work: "",
  }[action];
  const amountHint = {
    sale: "The total the buyer paid, with any postage they paid. Fees come off when the money arrives.",
    payout: "What reached your bank after the platform's fees.",
    expense: undefined,
    refund: "What you gave back to the buyer.",
    receipt: "For all of them together, from the receipt.",
    work: undefined,
  }[action];

  return (
    <Window
      open
      onOpenChange={(o) => !o && onClose()}
      tint="peach"
      title={action === "receipt" ? "Add what you bought" : ACTION_LABEL[action]}
      description={trip.label}
      footer={
        <>
          <Button variant="line" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="main" type="submit" form={formId} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <form id={formId} className="k-form" onSubmit={submit} noValidate>
        {withItem && (
          <div className="k-pair sk-pair">
            <Field label="Item" htmlFor={formId + "-item"} error={errs.item}>
              <Input
                id={formId + "-item"}
                name="item"
                list={listId}
                defaultValue={item ?? (action === "receipt" ? "" : items[0] ?? "")}
                maxLength={120}
                placeholder="Lip balm gift set"
              />
              <datalist id={listId}>
                {items.map((i) => (
                  <option key={i} value={i} />
                ))}
              </datalist>
            </Field>
            <Field label="How many" htmlFor={formId + "-units"} error={errs.units}>
              <Input id={formId + "-units"} name="units" type="number" min={1} inputMode="numeric" defaultValue={1} />
            </Field>
          </div>
        )}
        {action === "expense" && (
          <Field label="What for">
            <Segmented label="What the cost was for" value={cost} onChange={setCost} options={COSTS} />
          </Field>
        )}
        {action === "work" ? (
          <Field label="Hours" htmlFor={formId + "-hours"} error={errs.hours} hint="Shopping, travel, listing and packing all count.">
            <Input id={formId + "-hours"} name="hours" type="text" inputMode="decimal" placeholder="1.5" />
          </Field>
        ) : (
          <Field label={amountLabel} htmlFor={formId + "-amount"} error={errs.amount} hint={amountHint}>
            <MoneyInput id={formId + "-amount"} name="amount" placeholder="0.00" autoFocus />
          </Field>
        )}
        <div className="k-pair sk-pair">
          {action === "payout" && (
            <Field label="Units (optional)" htmlFor={formId + "-units"} error={errs.units}>
              <Input id={formId + "-units"} name="units" type="number" min={1} inputMode="numeric" />
            </Field>
          )}
          <Field label="Date" htmlFor={formId + "-date"}>
            <Input id={formId + "-date"} name="date" type="date" max={today()} defaultValue={today()} />
          </Field>
        </div>
        {withProof && (
          <Field
            label={action === "receipt" ? "Receipt photo (optional)" : "Payout screenshot (optional)"}
            htmlFor={formId + "-proof"}
            error={errs.proof}
            hint="A proof makes the trip count as Verified."
          >
            <Input id={formId + "-proof"} name="proof" type="file" accept={PROOF_TYPES.join(",")} />
          </Field>
        )}
        {errs.form && (
          <Notice tone="loss" title="Not saved.">
            {errs.form}
          </Notice>
        )}
      </form>
    </Window>
  );
}
