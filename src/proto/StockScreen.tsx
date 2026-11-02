// Stock in the new shell, built from the agreed full-site mock: each open
// trip shows what you bought, what has sold and what is left, with one-tap
// actions for the things that happen next (a sale, the money arriving, a
// cost, a return, time spent). Everything is a dated ledger entry, so Money
// updates from it. The full records (proofs, checks, editing) stay below.
import React, { useEffect, useState } from "react";
import { api, money, toPence } from "../api";
import { readBase64 } from "../Ledger";
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
  amount: number;
  units: number | null;
  reference: string | null;
  occurred: string;
};
type Detail = {
  entries: Entry[];
  reconciliation: { payouts: number; spend: number; unitsBought: number; unitsSold: number; cashTiedUp: number };
};
type Summary = { pendingPayouts: number; cashTiedUp?: number; unsoldUnits?: number; realisedEarnings: number };
type Action = "sale" | "payout" | "expense" | "refund" | "work" | "receipt";

const ACTIONS: [Action, string][] = [
  ["sale", "Record a sale"],
  ["payout", "Money arrived"],
  ["expense", "Add a cost"],
  ["refund", "Return"],
  ["work", "Add time"],
  ["receipt", "Add a purchase"],
];
const COSTS = ["Postage", "Packaging", "Selling fees", "Fuel or fares", "Parking", "Other"];
const PROOF_TYPES = ["image/jpeg", "image/png", "application/pdf"];
// Purchases recorded without an item name are grouped under this.
const UNNAMED = "Items on this trip";

const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

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
      r.paid += e.amount;
    } else if (e.type === "sale" && m.has(name)) row(name).sold += e.units ?? 0;
    else if (e.type === "refund" && m.has(name)) row(name).returned += e.units ?? 0;
  }
  return [...m.values()];
}

function stage(t: TripRow, d: Detail | undefined) {
  if (t.kind === "household") return ["Household", "hh"];
  if (t.status === "closed") return ["Closed", "done"];
  const r = d?.reconciliation;
  if (!r || r.unitsBought === 0) return ["Planned", "plan"];
  if (t.pendingPayout > 0) return ["Sold, waiting for money", "wait"];
  if (r.unitsSold === 0) return ["Bought, not listed or sold", "bought"];
  if ((t.unsoldUnits ?? 0) > 0) return ["Selling", "sell"];
  return ["All sold and paid", "done"];
}

export default function StockScreen({ legacy, go }: { legacy: React.ReactNode; go: (v: "money" | "deals") => void }) {
  const [trips, setTrips] = useState<TripRow[] | null>(null);
  const [details, setDetails] = useState<Record<number, Detail>>({});
  const [sum, setSum] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<{ trip: number; action: Action; item?: string } | null>(null);
  const [notice, setNotice] = useState<{ trip: number; text: string } | null>(null);

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
  const closed = (trips ?? []).filter((t) => t.status === "closed").slice(0, 8);

  async function close(t: TripRow) {
    try {
      await api("ledger/trips/" + t.id + "/close", {});
      setNotice({ trip: t.id, text: "Trip closed." });
      setVersion((v) => v + 1);
    } catch (e) {
      setNotice({ trip: t.id, text: (e as Error).message });
    }
  }

  return (
    <>
      <div className="titlebar">
        <div>
          <h1>Stock</h1>
          <p>Everything you bought, from the shelf to the payout. Each step you record here updates Money.</p>
        </div>
      </div>
      {sum && (
        <div className="stats three sstats">
          <div className="stat">
            <small>Not sold yet</small>
            <b>{sum.unsoldUnits ?? 0} units</b>
            <span>{money(sum.cashTiedUp ?? 0)} of your cash in stock</span>
          </div>
          <div className="stat">
            <small>Sold, waiting for money</small>
            <b>{money(sum.pendingPayouts)}</b>
            <span>record it when it arrives</span>
          </div>
          <div className="stat">
            <small>Kept this month</small>
            <b className="kept">{money(sum.realisedEarnings)}</b>
            <span>
              <button type="button" className="linkbtn" onClick={() => go("money")}>
                See Money
              </button>
            </span>
          </div>
        </div>
      )}
      {error && <p className="note">Your stock could not be loaded ({error}).</p>}
      {trips && openTrips.length === 0 && (
        <div className="panel sempty">
          <h3>No open trips</h3>
          <p className="muted">
            Plan a trip from Deals, tick things off in the shop, then press Finish trip. What you got lands
            here, ready to sell.
          </p>
          <button type="button" className="bt ghost sm" onClick={() => go("deals")}>
            Browse deals
          </button>
        </div>
      )}
      <div className="strips">
        {openTrips.map((t) => {
          const d = details[t.id];
          const [label, cls] = stage(t, d);
          const items = d ? itemsOf(d.entries) : [];
          const resale = t.kind === "resale";
          return (
            <div key={t.id} className="panel scard">
              <div className="shead">
                <div>
                  <h3>{t.label}</h3>
                  <span className={"stag " + cls}>{label}</span>
                  {t.sample && <span className="stag">Sample</span>}
                  {t.verified && <span className="stag done">Verified</span>}
                </div>
                <div className="sfig">
                  <span>
                    <small>Waiting</small>
                    <b>{money(t.pendingPayout)}</b>
                  </span>
                  <span>
                    <small>Kept so far</small>
                    <b className="kept">{money(t.realisedContribution ?? 0)}</b>
                  </span>
                </div>
              </div>
              {resale && items.length > 0 && (
                <div className="sitems">
                  {items.map((it) => {
                    const left = Math.max(0, it.bought - it.sold);
                    return (
                      <div key={it.name} className="sitem">
                        <div className="tname">
                          <b>{it.name}</b>
                          <small>
                            {it.bought} bought at {money(it.bought ? Math.round(it.paid / it.bought) : 0)} each ·{" "}
                            {it.sold} sold{it.returned ? ` · ${it.returned} returned` : ""}
                          </small>
                        </div>
                        <div className="sprog" aria-label={`${it.sold} of ${it.bought} sold`}>
                          <i style={{ width: (it.bought ? Math.min(100, (it.sold / it.bought) * 100) : 0) + "%" }} />
                        </div>
                        <span className="sleft">{left} left</span>
                        {left > 0 && (
                          <button
                            type="button"
                            className="bt ghost sm"
                            onClick={() => setOpen({ trip: t.id, action: "sale", item: it.name })}
                          >
                            Sold one
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {resale && (
                <div className="sacts">
                  {ACTIONS.map(([a, l]) => (
                    <button
                      key={a}
                      type="button"
                      className="chipbtn"
                      aria-pressed={open?.trip === t.id && open.action === a}
                      onClick={() =>
                        setOpen(open?.trip === t.id && open.action === a ? null : { trip: t.id, action: a })
                      }
                    >
                      {l}
                    </button>
                  ))}
                  <button type="button" className="chipbtn" onClick={() => close(t)}>
                    Close trip
                  </button>
                </div>
              )}
              {!resale && (
                <p className="muted">Household savings are recorded in the full records below.</p>
              )}
              {open?.trip === t.id && (
                <EntryQuick
                  key={open.action + (open.item ?? "")}
                  trip={t}
                  action={open.action}
                  item={open.item}
                  items={items.map((i) => i.name)}
                  onDone={(text) => {
                    setOpen(null);
                    setNotice({ trip: t.id, text });
                    setVersion((v) => v + 1);
                  }}
                  onCancel={() => setOpen(null)}
                />
              )}
              {notice?.trip === t.id && (
                <p className="muted" role="status">
                  {notice.text}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {closed.length > 0 && (
        <div className="panel sclosed">
          <h3>
            Closed trips <small>most recent</small>
          </h3>
          {closed.map((t) => (
            <div key={t.id} className="set">
              <span>{t.label}</span>
              <b>{t.realisedContribution === null ? "Not known" : money(t.realisedContribution) + " kept"}</b>
            </div>
          ))}
        </div>
      )}
      <section className="stockmore">
        <h2>Full records</h2>
        <p>Every entry and proof, the checks behind Verified, and how each trip compared with its prediction.</p>
        <div className="legacy">{legacy}</div>
      </section>
    </>
  );
}

function EntryQuick({
  trip,
  action,
  item,
  items,
  onDone,
  onCancel,
}: {
  trip: TripRow;
  action: Action;
  item?: string;
  items: string[];
  onDone: (text: string) => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const withItem = action === "sale" || action === "refund" || action === "receipt";
  const withUnits = withItem || action === "payout";
  const withProof = action === "receipt" || action === "payout";

  async function submit(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    const v = (k: string) => String(f.get(k) ?? "").trim();
    const body: Record<string, unknown> = { type: action, occurred: v("date") || today() };
    if (action === "work") {
      const mins = Math.round(Number(v("hours")) * 60);
      if (!Number.isFinite(mins) || mins < 1) return setErr("Say how long, in hours, like 1.5.");
      body.minutes = mins;
    } else {
      const pounds = Number(v("amount").replace(/^£/, ""));
      if (!Number.isFinite(pounds) || pounds <= 0) return setErr("Type the amount in pounds.");
      body.amount = toPence(pounds);
    }
    if (withUnits && v("units")) body.units = Number(v("units"));
    if (withItem) {
      if (!v("item")) return setErr("Say which item.");
      if (v("item") !== UNNAMED) body.reference = v("item").slice(0, 120);
      if (!body.units) return setErr("Say how many.");
    }
    if (action === "expense") body.note = v("what") || null;
    const file = withProof ? (f.get("proof") as File | null) : null;
    if (file && file.size && !PROOF_TYPES.includes(file.type))
      return setErr("A photo (JPEG or PNG) or a PDF, please.");
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ id: number }>("ledger/trips/" + trip.id + "/entries", body);
      if (file && file.size)
        await api("ledger/trips/" + trip.id + "/proofs", {
          label: (action === "receipt" ? "Receipt " : "Payout ") + body.occurred,
          mediaType: file.type,
          data: await readBase64(file),
          entryId: r.id,
        });
      onDone(
        {
          sale: "Sale recorded. It shows as waiting until the money arrives.",
          payout: "Money recorded. Money now counts it as kept.",
          expense: "Cost added.",
          refund: "Return recorded.",
          work: "Time added. Money can now work out your hourly rate.",
          receipt: "Purchase added.",
          saving: "",
        }[action],
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const listId = "items-" + trip.id;
  return (
    <form className="squick" onSubmit={submit} noValidate>
      {withItem && (
        <label className="wide">
          Item
          <input name="item" list={listId} defaultValue={item ?? (action === "receipt" ? "" : items[0] ?? "")} maxLength={120} />
          <datalist id={listId}>
            {items.map((i) => (
              <option key={i} value={i} />
            ))}
          </datalist>
        </label>
      )}
      {withUnits && (
        <label>
          {action === "payout" ? "Units (optional)" : "How many"}
          <input name="units" type="number" min={1} inputMode="numeric" defaultValue={withItem ? 1 : ""} />
        </label>
      )}
      {action === "work" ? (
        <label>
          Hours
          <input name="hours" type="number" min={0.1} step="0.25" inputMode="decimal" placeholder="1.5" />
        </label>
      ) : (
        <label>
          {
            {
              sale: "Buyer paid, £",
              payout: "Paid to you, £",
              expense: "Cost, £",
              refund: "Refunded, £",
              receipt: "You paid, £",
              work: "",
            }[action]
          }
          <input name="amount" type="number" min={0.01} step="0.01" inputMode="decimal" />
        </label>
      )}
      {action === "expense" && (
        <label>
          What for
          <select name="what" defaultValue="Postage">
            {COSTS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      )}
      <label>
        Date
        <input name="date" type="date" max={today()} defaultValue={today()} />
      </label>
      {withProof && (
        <label className="wide">
          {action === "receipt" ? "Receipt photo (optional)" : "Payout screenshot (optional)"}
          <input name="proof" type="file" accept={PROOF_TYPES.join(",")} />
        </label>
      )}
      <div className="sbtns">
        <button className="bt sm" disabled={busy}>
          Save
        </button>
        <button type="button" className="bt ghost sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {err && (
        <p className="serr" role="alert">
          {err}
        </p>
      )}
      {action === "sale" && (
        <small className="muted wide">
          What the buyer paid in total, including any postage they paid. Fees come off when the money arrives.
        </small>
      )}
    </form>
  );
}
