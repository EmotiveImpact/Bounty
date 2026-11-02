import React, { useState } from "react";
import { api, money } from "../api";
import { readBase64 } from "../Ledger";
import type { Deal } from "../Deals";

// The end of a trip: what the person actually got, at what they actually
// paid, before any of it goes into Stock. Rows start from the items ticked
// off, at the trip quantity and the listed shop price; the person corrects
// anything that differs. Nothing is saved until they press Add to stock.

const PROOF_TYPES = ["image/jpeg", "image/png", "application/pdf"];
const MAX_PROOF_BYTES = 5 * 1024 * 1024;

type Row = { deal: Deal; units: string; paid: string };

// Today on the person's own calendar, as the ledger's date.
function today() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whole pence from a pounds field, or null when it is not a price. */
export function pence(value: string): number | null {
  const v = value.trim().replace(/^£/, "");
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(v)) return null;
  const p = Math.round(Number(v) * 100);
  return p > 0 ? p : null;
}

/** A whole number of units from 1 to 999, or null. */
export function unitCount(value: string): number | null {
  if (!/^\d{1,3}$/.test(value.trim())) return null;
  const n = Number(value);
  return n >= 1 ? n : null;
}

export default function SignOff({
  ticked,
  trip,
  onBack,
  onDone,
}: {
  ticked: Deal[];
  trip: Record<string, number>;
  onBack: () => void;
  onDone: (added: number, note?: string) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    ticked.map((d) => ({
      deal: d,
      units: String(trip[d.sku] ?? 1),
      paid: (d.buy / 100).toFixed(2),
    })),
  );
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const set = (i: number, patch: Partial<Row>) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const parsed = rows.map((r) => ({
    ...r,
    n: unitCount(r.units),
    p: pence(r.paid),
  }));
  const bad = parsed.some((r) => r.n === null || r.p === null);
  const total = parsed.reduce((a, r) => a + (r.n ?? 0) * (r.p ?? 0), 0);

  async function save() {
    if (bad)
      return setError("Check the quantities and prices: each needs a number.");
    if (file && !PROOF_TYPES.includes(file.type))
      return setError("A receipt must be a JPEG or PNG photo, or a PDF.");
    if (file && file.size > MAX_PROOF_BYTES)
      return setError("A receipt must be 5 MB or smaller.");
    setBusy(true);
    setError("");
    try {
      const date = today();
      const shops = [...new Set(rows.map((r) => r.deal.shop))].join(", ");
      const { id } = await api<{ id: number }>("ledger/trips", {
        label: `Trip ${date} · ${shops}`.slice(0, 120),
        source: "manual",
        kind: "resale",
      });
      const entryIds: number[] = [];
      for (const r of parsed) {
        const res = await api<{ id: number }>(
          "ledger/trips/" + id + "/entries",
          {
            type: "receipt",
            amount: (r.n as number) * (r.p as number),
            units: r.n,
            reference: r.deal.name.slice(0, 120),
            occurred: date,
            note: `${r.deal.shop}${r.deal.area ? ", " + r.deal.area : ""}. Listed in Bounty at ${money(r.deal.buy)} each.`,
          },
        );
        entryIds.push(res.id);
      }
      // The purchases are saved by now, so a refused receipt must not leave
      // the person stuck: pressing Add again would record them twice.
      let receiptNote = "";
      if (file) {
        try {
          await api("ledger/trips/" + id + "/proofs", {
            label: ("Receipt " + date).slice(0, 120),
            mediaType: file.type,
            data: await readBase64(file),
            // One item: the receipt proves that purchase. Several: the whole trip.
            entryId: entryIds.length === 1 ? entryIds[0] : undefined,
          });
        } catch (err) {
          receiptNote =
            " The receipt was not attached (" +
            (err as Error).message +
            "). Add it in Stock.";
        }
      }
      onDone(
        parsed.reduce((a, r) => a + (r.n as number), 0),
        receiptNote,
      );
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="signoff">
      {rows.length === 0 ? (
        <p className="so-empty">
          Nothing is ticked off, so nothing goes into Stock. Go back and tick
          what you got, or finish without adding anything.
        </p>
      ) : (
        <>
          <p className="so-lead">
            Check what you got and what you paid. Change anything that's
            different.
          </p>
          <div className="so-rows">
            {parsed.map((r, i) => (
              <div className="so-row" key={r.deal.sku}>
                <div className="so-name">
                  <b>{r.deal.name}</b>
                  <small>{r.deal.shop}</small>
                </div>
                <label>
                  <span>Got</span>
                  <input
                    inputMode="numeric"
                    value={r.units}
                    aria-invalid={r.n === null}
                    onChange={(e) => set(i, { units: e.target.value })}
                  />
                </label>
                <label>
                  <span>Paid each, £</span>
                  <input
                    inputMode="decimal"
                    value={r.paid}
                    aria-invalid={r.p === null}
                    onChange={(e) => set(i, { paid: e.target.value })}
                  />
                </label>
              </div>
            ))}
          </div>
          <div className="so-file">
            <span>Receipt photo (optional)</span>
            <label className="so-filebtn">
              <input
                type="file"
                accept="image/jpeg,image/png,application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {file ? "Change photo" : "Add receipt photo"}
            </label>
            {file && <small className="so-filename">{file.name}</small>}
          </div>
          <div className="so-total">
            <span>You paid</span>
            <b>{bad ? "–" : money(total)}</b>
          </div>
        </>
      )}
      {error && (
        <p className="so-error" role="alert">
          {error}
        </p>
      )}
      <div className="tbtns">
        <button
          type="button"
          className="bt ghost"
          onClick={onBack}
          disabled={busy}
        >
          Back
        </button>
        {rows.length === 0 ? (
          <button type="button" className="bt" onClick={() => onDone(0)}>
            Finish without adding
          </button>
        ) : (
          <button
            type="button"
            className="bt green"
            onClick={save}
            disabled={busy || bad}
          >
            {busy ? "Adding…" : "Add to stock"}
          </button>
        )}
      </div>
    </div>
  );
}
