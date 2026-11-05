// Year-end export (Full-time plan): every entry recorded in Stock during one
// UK tax year (6 April to 5 April), as a spreadsheet file. It lists what the
// member recorded; it is not a tax return and not tax advice.
import { useState } from "react";
import { api } from "../api";
import { cheapestFor, opens, usePlans } from "../plans";
import { Button } from "../ui/kit";

type Entry = {
  id: number;
  type: string;
  amount: number;
  units: number | null;
  reference: string | null;
  occurred: string;
  minutes: number | null;
  note: string | null;
};
type TripList = { trips: { id: number; label: string }[] };
type TripDetail = { trip: { id: number; label: string }; entries: Entry[] };

const TYPE_WORD: Record<string, string> = {
  receipt: "Bought",
  sale: "Sold",
  payout: "Paid out",
  expense: "Cost",
  refund: "Refund",
  work: "Time",
  saving: "Saving",
};

/** The tax year that holds a date: { start, end, label }, London dates. */
export function taxYear(today: string) {
  const year = Number(today.slice(0, 4));
  const startYear = today.slice(5) >= "04-06" ? year : year - 1;
  return {
    start: `${startYear}-04-06`,
    end: `${startYear + 1}-04-05`,
    label: `${startYear} to ${String(startYear + 1).slice(2)}`,
  };
}

const cell = (v: string | number | null) => {
  const s = v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function TaxExport({ go }: { go: (v: "plans") => void }) {
  const { info } = usePlans();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const [which, setWhich] = useState<"this" | "last">("this");
  const now = taxYear(today);
  const last = taxYear(`${Number(now.start.slice(0, 4)) - 1}-06-01`);
  const year = which === "this" ? now : last;

  if (!opens(info, "taxExport")) {
    const plan = cheapestFor(info, "taxExport");
    return (
      <div className="mn-export">
        <p className="mn-small">
          A year-end list of everything you recorded, ready for your tax return, comes with {plan?.name ?? "Full-time"}.
        </p>
        <Button variant="text" size="sm" onClick={() => go("plans")}>
          See plans
        </Button>
      </div>
    );
  }

  async function download() {
    setBusy(true);
    setNote("");
    try {
      const { trips } = await api<TripList>("ledger/trips");
      const details = await Promise.all(trips.map((t) => api<TripDetail>("ledger/trips/" + t.id)));
      const rows = details
        .flatMap((d) => d.entries.map((e) => ({ trip: d.trip.label, ...e })))
        .filter((e) => e.occurred.slice(0, 10) >= year.start && e.occurred.slice(0, 10) <= year.end)
        .sort((a, b) => a.occurred.localeCompare(b.occurred) || a.id - b.id);
      if (!rows.length) {
        setNote(`Nothing recorded between ${year.start} and ${year.end}.`);
        return;
      }
      const lines = [
        ["Date", "Trip", "What", "Amount (£)", "Units", "Minutes", "Reference", "Note"].join(","),
        ...rows.map((r) =>
          [
            r.occurred.slice(0, 10),
            r.trip,
            TYPE_WORD[r.type] ?? r.type,
            (r.amount / 100).toFixed(2),
            r.units,
            r.minutes,
            r.reference,
            r.note,
          ]
            .map(cell)
            .join(","),
        ),
      ];
      const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `bounty-tax-year-${year.start.slice(0, 4)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNote(`${rows.length} entries saved as a spreadsheet file.`);
    } catch (e) {
      setNote("Could not make the file: " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mn-export">
      <div className="mn-export-row">
        <select
          className="k-input mn-export-year"
          value={which}
          onChange={(e) => setWhich(e.target.value as "this" | "last")}
          aria-label="Tax year"
        >
          <option value="this">Tax year {now.label}</option>
          <option value="last">Tax year {last.label}</option>
        </select>
        <Button variant="main" size="sm" onClick={download} disabled={busy}>
          {busy ? "Making the file…" : "Download year-end list"}
        </Button>
      </div>
      <p className="mn-small" role="status">
        {note || "Everything you recorded in Stock for that year, as a spreadsheet. A list of your records, not tax advice."}
      </p>
    </div>
  );
}
