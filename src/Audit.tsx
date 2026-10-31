import { useEffect, useState, type FormEvent } from "react";
import { api, dateTime, loadProfile, money, toPence } from "./api";
import type { AuditDraft, StockCheck } from "./ResearchCalculator";
import "./Research.css";

// Validation audit for the "Real buying alerts" gate: check 30 barcoded
// items in one UK locality against retailer and actual sold evidence.
type AuditCheck = { id: string; ok: boolean; detail: string };
type AuditItem = {
  id: number;
  locality: string;
  barcode: string;
  title: string;
  retailer: string;
  offer_provider: string | null;
  offer_source_id: string | null;
  availability_check_id: number | null;
  promotion: string | null;
  promotion_eligible: number | null;
  shipping: number | null;
  days_to_sell: number | null;
  independent_sales: number | null;
  display_permitted: number | null;
  match_decision: string | null;
  notes: string | null;
  updated: string;
  check: StockCheck | null;
  outcome: { passed: boolean; reasons: string[]; checks: AuditCheck[] };
};
type Progress = {
  locality: string;
  target: number;
  audited: number;
  passed: number;
  failed: number;
  remaining: number;
  complete: boolean;
  failures: Record<string, number>;
};

// Form values are text; "" means unknown and is sent as null so the item
// fails closed on that field.
type Form = {
  barcode: string;
  title: string;
  retailer: string;
  offerProvider: string;
  offerSourceId: string;
  availabilityCheckId: string;
  promotion: string;
  promotionEligible: "" | "yes" | "no";
  shipping: string;
  daysToSell: string;
  independentSales: string;
  displayPermitted: "" | "yes" | "no";
  matchDecision: "" | "exact" | "research" | "none";
  notes: string;
};
const emptyForm: Form = {
  barcode: "",
  title: "",
  retailer: "",
  offerProvider: "",
  offerSourceId: "",
  availabilityCheckId: "",
  promotion: "",
  promotionEligible: "",
  shipping: "",
  daysToSell: "",
  independentSales: "",
  displayPermitted: "",
  matchDecision: "",
  notes: "",
};
const yesNo = (v: boolean | null): "" | "yes" | "no" =>
  v === null ? "" : v ? "yes" : "no";
function fromDraft(d: AuditDraft): Form {
  return {
    barcode: d.barcode,
    title: d.title,
    retailer: d.retailer,
    offerProvider: d.offerProvider,
    offerSourceId: d.offerSourceId,
    availabilityCheckId: d.availabilityCheckId === null ? "" : String(d.availabilityCheckId),
    promotion: d.promotion || "",
    promotionEligible: yesNo(d.promotionEligible),
    shipping: d.shipping === null ? "" : (d.shipping / 100).toFixed(2),
    daysToSell: d.daysToSell === null ? "" : String(d.daysToSell),
    independentSales: d.independentSales === null ? "" : String(d.independentSales),
    displayPermitted: yesNo(d.displayPermitted),
    matchDecision: d.matchDecision || "",
    notes: "",
  };
}
const whole = (v: string) => (v.trim() === "" ? null : Math.round(Number(v)));
const choice = (v: "" | "yes" | "no") => (v === "" ? null : v === "yes");

export default function Audit({ draft }: { draft?: AuditDraft | null }) {
  const [locality, setLocality] = useState(() => loadProfile().area);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [items, setItems] = useState<AuditItem[]>([]);
  const [form, setForm] = useState<Form>(emptyForm);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!draft) return;
    setForm(fromDraft(draft));
    if (draft.locality) setLocality(draft.locality);
    setMessage("");
  }, [draft]);

  useEffect(() => {
    const place = locality.trim();
    if (!place) {
      setProgress(null);
      setItems([]);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      const q = "?locality=" + encodeURIComponent(place);
      Promise.all([
        api<Progress>("audit/progress" + q),
        api<{ items: AuditItem[] }>("audit" + q),
      ])
        .then(([p, list]) => {
          if (!active) return;
          setProgress(p);
          setItems(list.items);
          setError("");
        })
        .catch((e: Error) => active && setError(e.message));
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [locality, version]);

  const set = (field: keyof Form, value: string) =>
    setForm((current) => ({ ...current, [field]: value }));

  async function save(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const numbers = [form.shipping, form.daysToSell, form.independentSales, form.availabilityCheckId];
      if (numbers.some((v) => v.trim() !== "" && !Number.isFinite(Number(v))))
        throw Error("Enter numbers only in the number fields");
      const saved = await api<AuditItem>("audit", {
        locality: locality.trim(),
        barcode: form.barcode.trim(),
        title: form.title.trim(),
        retailer: form.retailer.trim(),
        offerProvider: form.offerProvider.trim() || null,
        offerSourceId: form.offerSourceId.trim() || null,
        availabilityCheckId: whole(form.availabilityCheckId),
        promotion: form.promotion.trim() || null,
        promotionEligible: choice(form.promotionEligible),
        shipping: form.shipping.trim() === "" ? null : toPence(form.shipping),
        daysToSell: whole(form.daysToSell),
        independentSales: whole(form.independentSales),
        displayPermitted: choice(form.displayPermitted),
        matchDecision: form.matchDecision || null,
        notes: form.notes.trim() || null,
      });
      setMessage(
        saved.outcome.passed
          ? "Saved. This item passes every audit check."
          : "Saved. This item fails: " + saved.outcome.reasons.join("; ") + ".",
      );
      setForm(emptyForm);
      setVersion((n) => n + 1);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const failures = Object.entries(progress?.failures || {}).sort((a, b) => b[1] - a[1]);
  return (
    <article className="audit">
      <small>VALIDATION / REAL BUYING ALERTS GATE</small>
      <h2>Validation audit</h2>
      <p>
        Before buy alerts can be trusted, check 30 barcoded items in one UK
        locality against the retailer and actual sold evidence. An item passes
        only when branch stock, promotion eligibility, parcel cost, days to sell,
        at least three independent recent sales, display permission and an exact
        match are all confirmed. Anything unknown fails.
      </p>
      <label>
        Locality
        <input value={locality} maxLength={120} onChange={(e) => setLocality(e.target.value)} />
      </label>
      {error && <p role="alert">{error}</p>}
      {progress && (
        <div className="audit-progress">
          <progress max={progress.target} value={Math.min(progress.audited, progress.target)} />
          <p>
            <b>
              {progress.audited} of {progress.target} items audited in {progress.locality}
            </b>
            {" · "}
            <span className="ok">{progress.passed} passed</span>
            {" · "}
            <span className="warn">{progress.failed} failed</span>
            {" · "}
            {progress.remaining} still to audit
          </p>
          {progress.complete && (
            <p className="notice">
              {progress.target} items audited. Review the failures before relying
              on buy alerts in this locality.
            </p>
          )}
          {failures.length > 0 && (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Failure</th>
                    <th className="num">Items</th>
                  </tr>
                </thead>
                <tbody>
                  {failures.map(([reason, count]) => (
                    <tr key={reason}>
                      <td>{reason}</td>
                      <td className="num">{count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <details open={Boolean(draft)}>
        <summary>Record an audited item</summary>
        <form onSubmit={save}>
          <div className="grid2">
            <label>
              Barcode
              <input required value={form.barcode} onChange={(e) => set("barcode", e.target.value)} inputMode="numeric" maxLength={40} />
            </label>
            <label>
              Title
              <input required value={form.title} onChange={(e) => set("title", e.target.value)} maxLength={200} />
            </label>
            <label>
              Retailer
              <input required value={form.retailer} onChange={(e) => set("retailer", e.target.value)} maxLength={120} />
            </label>
            <label>
              Offer provider
              <input value={form.offerProvider} onChange={(e) => set("offerProvider", e.target.value)} maxLength={60} />
            </label>
            <label>
              Offer source id
              <input value={form.offerSourceId} onChange={(e) => set("offerSourceId", e.target.value)} maxLength={200} />
            </label>
            <label>
              Availability check number
              <input type="number" min={1} step={1} value={form.availabilityCheckId} onChange={(e) => set("availabilityCheckId", e.target.value)} />
            </label>
            <label>
              Promotion or loyalty condition (if any)
              <input value={form.promotion} onChange={(e) => set("promotion", e.target.value)} maxLength={200} />
            </label>
            <label>
              Price available to the shopper?
              <select value={form.promotionEligible} onChange={(e) => set("promotionEligible", e.target.value)}>
                <option value="">Unknown</option>
                <option value="yes">Yes: no condition, or they qualify</option>
                <option value="no">No</option>
              </select>
            </label>
            <label>
              Parcel cost (£)
              <input type="number" min={0} step={0.01} value={form.shipping} onChange={(e) => set("shipping", e.target.value)} />
            </label>
            <label>
              Days to sell
              <input type="number" min={0} step={1} value={form.daysToSell} onChange={(e) => set("daysToSell", e.target.value)} />
            </label>
            <label>
              Independent sales in the last 90 days
              <input type="number" min={0} step={1} value={form.independentSales} onChange={(e) => set("independentSales", e.target.value)} />
            </label>
            <label>
              Display permitted?
              <select value={form.displayPermitted} onChange={(e) => set("displayPermitted", e.target.value)}>
                <option value="">Unknown</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
            <label>
              Match decision
              <select value={form.matchDecision} onChange={(e) => set("matchDecision", e.target.value)}>
                <option value="">Not recorded</option>
                <option value="exact">Exact</option>
                <option value="research">Research: similar or uncertain</option>
                <option value="none">No match</option>
              </select>
            </label>
          </div>
          <label>
            Notes
            <input value={form.notes} onChange={(e) => set("notes", e.target.value)} maxLength={1000} />
          </label>
          <button disabled={busy || !locality.trim()}>Save audit item</button>
        </form>
        {message && <p role="status">{message}</p>}
      </details>

      {items.length > 0 && (
        <div className="audit-items">
          {items.map((item) => (
            <div className="evidence-row" key={item.id}>
              <div>
                <span className={"badge " + (item.outcome.passed ? "ok" : "warn")}>
                  {item.outcome.passed ? "Pass" : "Fail"}
                </span>
                <b>{item.title}</b>
                <small>
                  {item.barcode} · {item.retailer} · parcel{" "}
                  {item.shipping === null ? "unknown" : money(item.shipping)} · updated{" "}
                  {dateTime(item.updated)} UTC
                </small>
                {!item.outcome.passed && (
                  <ul className="reasons">
                    {item.outcome.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
