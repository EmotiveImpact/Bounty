// Made-up example trips for Stock and Money while Bounty is in development.
// They live only here in the browser: nothing is saved to the ledger, so
// they never count towards real totals, tax or goals. Every place they show
// is marked Example. The items match the sample Deals list, and the dates
// are counted back from today so the examples never look stale.
import { money } from "../api";

export type ExampleEntry = {
  id: number;
  type: "receipt" | "sale" | "payout" | "expense" | "refund" | "work" | "saving";
  amount: number | null;
  units: number | null;
  reference: string | null;
  occurred: string;
  minutes?: number | null;
  note?: string | null;
};
export type ExampleTrip = {
  trip: {
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
  detail: {
    entries: ExampleEntry[];
    reconciliation: { payouts: number; spend: number; unitsBought: number; unitsSold: number; cashTiedUp: number };
  };
  minutes: number;
};

export const EXAMPLE_NOTE =
  "This is a made-up example, so nothing is saved. Plan a real trip from Deals to record your own.";

const daysAgo = (n: number) => {
  const d = new Date(Date.now() - n * 86400000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

type Line = [ExampleEntry["type"], number | null, number | null, string | null, number, number?];

/** Builds one example trip from its entries; the figures add up. */
function trip(id: number, label: string, started: number, status: "open" | "closed", lines: Line[]): ExampleTrip {
  const entries: ExampleEntry[] = lines.map(([type, amount, units, reference, ago, minutes], i) => ({
    id: id * 100 + i,
    type,
    amount,
    units,
    reference,
    occurred: daysAgo(ago),
    minutes: minutes ?? null,
    note: type === "expense" ? reference : null,
  }));
  const sum = (t: ExampleEntry["type"], f: (e: ExampleEntry) => number) =>
    entries.filter((e) => e.type === t).reduce((a, e) => a + f(e), 0);
  const spend = sum("receipt", (e) => e.amount ?? 0) + sum("expense", (e) => e.amount ?? 0);
  const payouts = sum("payout", (e) => e.amount ?? 0);
  const unitsBought = sum("receipt", (e) => e.units ?? 0);
  const unitsSold = sum("sale", (e) => e.units ?? 0);
  // Cash still in stock: what each unsold unit cost.
  let cashTiedUp = 0;
  for (const r of entries.filter((e) => e.type === "receipt")) {
    const sold = entries
      .filter((e) => e.type === "sale" && e.reference === r.reference)
      .reduce((a, e) => a + (e.units ?? 0), 0);
    const each = (r.amount ?? 0) / (r.units || 1);
    cashTiedUp += Math.max(0, (r.units ?? 0) - sold) * each;
  }
  const sales = sum("sale", (e) => e.amount ?? 0);
  const fees = Math.round(sales * 0.138);
  const pendingPayout = payouts === 0 && sales > 0 ? sales - fees : 0;
  return {
    trip: {
      id: -id,
      label,
      kind: "resale",
      status,
      sample: false,
      created: daysAgo(started),
      realisedContribution: payouts - spend,
      pendingPayout,
      unsoldUnits: unitsBought - unitsSold,
      verified: false,
    },
    detail: { entries, reconciliation: { payouts, spend, unitsBought, unitsSold, cashTiedUp: Math.round(cashTiedUp) } },
    minutes: sum("work", (e) => e.minutes ?? 0),
  };
}

export const EXAMPLE_TRIPS: ExampleTrip[] = [
  trip(1, "Tesco and Argos, Saturday run", 9, "open", [
    ["receipt", 6000, 3, "Wireless headphones", 9],
    ["receipt", 5000, 2, "Mechanical keyboard", 9],
    ["expense", 450, null, "Fuel or fares", 9],
    ["work", null, null, null, 9, 95],
    ["sale", 8800, 2, "Wireless headphones", 5],
    ["sale", 5000, 1, "Mechanical keyboard", 4],
    ["payout", 11900, null, null, 2],
  ]),
  trip(2, "B&M toy aisle", 6, "open", [
    ["receipt", 6000, 4, "Remote control stunt car", 6],
    ["work", null, null, null, 6, 70],
    ["sale", 13600, 4, "Remote control stunt car", 2],
  ]),
  trip(3, "Dunelm and TK Maxx", 1, "open", [
    ["receipt", 3600, 3, "Chunky knit throw", 1],
    ["receipt", 2800, 4, "Large fox soft toy", 1],
    ["expense", 200, null, "Parking", 1],
  ]),
  trip(4, "Superdrug gift sets", 20, "closed", [
    ["receipt", 6000, 5, "Perfume gift set", 20],
    ["expense", 1350, null, "Postage", 16],
    ["work", null, null, null, 20, 120],
    ["sale", 14000, 5, "Perfume gift set", 15],
    ["payout", 12100, null, null, 12],
  ]),
];

/** The Money figures the example trips would give. */
export function exampleMoney() {
  const t = EXAMPLE_TRIPS;
  const paid = t.filter((x) => x.detail.reconciliation.payouts > 0);
  const kept = paid.reduce((a, x) => a + (x.trip.realisedContribution ?? 0), 0);
  const minutes = paid.reduce((a, x) => a + x.minutes, 0);
  return {
    kept,
    onTheWay: t.reduce((a, x) => a + x.trip.pendingPayout, 0),
    inStock: t.reduce((a, x) => a + x.detail.reconciliation.cashTiedUp, 0),
    unsold: t.reduce((a, x) => a + (x.trip.unsoldUnits ?? 0), 0),
    perHour: minutes ? Math.round((kept / minutes) * 60) : null,
    hours: Math.round(minutes / 6) / 10,
    trips: t.length,
    lines: paid.map((x) => `${x.trip.label}: ${money(x.trip.realisedContribution ?? 0)} kept`),
  };
}
