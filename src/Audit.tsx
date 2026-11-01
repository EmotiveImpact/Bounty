import { useEffect, useState, type FormEvent } from "react";
import { api, barcodeText, dateTime, initialProfile, money, toPence } from "./api";
import type { AuditDraft, StockCheck } from "./ResearchCalculator";
import "./Research.css";

// Validation audit for the "Real buying alerts" gate: check 30 barcoded
// items in the pilot locality (one London borough, still to be chosen)
// against retailer and actual sold evidence. An item passes only on stored
// evidence: the offer in the database, the sales confirmed in Research and
// the estimate built from them. What the operator types is their own
// reading, compared with that evidence. Each item is judged on the offer as
// it was audited (the server keeps a copy), and a later change to the live
// offer is shown beside it.
//
// A sign-off records that the operator reviewed the result. It does not
// make the figures proven: members always see the pass count on bounty cards
// and alerts in the locality.

type SaleKey = { provider: string; sourceId: string };
// Extra fields a Research estimate can hand over with its draft: the sales
// it confirmed, the unit weight and the rest of the estimate request (trip
// costs, rules, category, confirmed offer attributes), so the audited tier is
// the one the operator saw.
export type AuditHandover = AuditDraft & {
  sales?: SaleKey[];
  weightKg?: number | null;
  estimateInputs?: Record<string, unknown> | null;
};

type AuditCheck = {
  id: string;
  ok: boolean;
  detail: string;
  recorded?: string | number | boolean | null;
  evidence?: unknown;
  contradiction?: boolean;
  error?: string | null;
};
type Contradiction = {
  id: string;
  label: string;
  recorded: string | number | boolean | null;
  evidence: string | number | boolean | null;
  reason?: string;
};
type Evidence = {
  evaluatedAt: string;
  stock: { confirmed: boolean; availability: string; checkId: number | null; reason: string | null };
  error: string | null;
  errorKind: "offer" | "estimate" | null;
  offer: {
    provider: string;
    sourceId: string;
    title: string;
    retailer: string | null;
    price: number;
    unitCost: number;
    observed: string | null;
    freshness: string;
    promotion: string | null;
    sample: boolean;
    source: string;
  } | null;
  sales: {
    confirmed: number;
    used: number;
    independent: number;
    withoutSeller: number | null;
    daysToSell: number | null;
    lowerMedian: number | null;
    notUsed: { sale: string; provider?: string; sourceId?: string; reason: string }[];
  } | null;
  match: string | null;
  permission: { permitted: boolean; basis: string } | null;
  tier: string | null;
  tierReasons: string[];
  // Required costs and times the Research estimate left blank.
  missingInputs?: string[] | null;
  // The copy of the offer the item is judged on (null for an item saved
  // before copies were kept, until the server migrates it).
  offerCopy?: { price: number; observed: string | null; retailer: string | null; copiedAt: string; migrated: boolean } | null;
  // How the live offer differs from that copy, or null.
  offerChange?: { changed: string[]; note: string | null } | null;
};
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
  sales?: SaleKey[];
  weight_kg?: number | null;
  updated: string;
  check: StockCheck | null;
  evidence?: Evidence;
  // Whether the item counts towards the 30, and why not.
  evidenced?: boolean;
  evidenceGaps?: string[];
  outcome: { passed: boolean; reasons: string[]; checks: AuditCheck[]; contradictions?: Contradiction[] };
};
type SignOff = {
  id: number;
  locality: string;
  at: string;
  target: number;
  audited: number;
  evidenced: number;
  passed: number;
  note: string | null;
  // The line members see on cards and alerts, for example "Pilot audit in
  // Camden signed off on 31 Oct 2026: 12 of 30 items passed."
  summary?: string;
};
type Progress = {
  locality: string;
  target: number;
  // The fewest passed items a sign-off accepts (an open decision).
  minPassedToSignOff?: number;
  audited: number;
  // Items with a recorded offer, a confirmed exact sale and a branch check
  // in the locality, whose stored evidence could be read (not sample data).
  // Only these count towards the 30.
  evidenced: number;
  withoutEvidence: number;
  withoutEvidenceReasons?: Record<string, number>;
  passed: number;
  failed: number;
  remaining: number;
  complete: boolean;
  // Why a sign-off would be refused now, or null.
  signOffBlocked?: string | null;
  signedOff: SignOff | null;
  signOffLapsed: { at: string; passed: number; evidenced: number; reason: string } | null;
  failures: Record<string, number>;
};

// A date for people, in UK time: "31 Oct 2026".
const dayFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "numeric",
  month: "short",
  year: "numeric",
});
const day = (iso: string) => (Number.isFinite(Date.parse(iso)) ? dayFormat.format(new Date(Date.parse(iso))) : "an unknown date");
const memberLine = (locality: string, at: string, passed: number, evidenced: number) =>
  `Pilot audit in ${locality} signed off on ${day(at)}: ${passed} of ${evidenced} items passed.`;
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

// Required costs and times the estimate needs (a blank is never zero). The
// parcel cost is the form's own field.
const REQUIRED_TRIP_INPUTS: [string, string][] = [
  ["packaging", "packaging cost"],
  ["journeyCost", "return journey cost"],
  ["journeyMinutes", "journey time"],
  ["handlingMinutes", "handling time"],
];
function blankTripInputs(inputs: Record<string, unknown> | null): string[] {
  const costs = inputs && typeof inputs.costs === "object" && inputs.costs ? (inputs.costs as Record<string, unknown>) : {};
  return REQUIRED_TRIP_INPUTS.filter(([key]) => typeof costs[key] !== "number" || !Number.isFinite(costs[key])).map(
    ([, label]) => label,
  );
}

// The pilot locality is a setting kept in this browser. It never defaults to
// the planner's sample area.
const LOCALITY_KEY = "bounty-audit-pilot-locality";
export function loadPilotLocality(): string {
  try {
    const value = localStorage.getItem(LOCALITY_KEY);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}
function savePilotLocality(value: string) {
  try {
    if (value.trim()) localStorage.setItem(LOCALITY_KEY, value.trim());
    else localStorage.removeItem(LOCALITY_KEY);
  } catch {
    // Storage unavailable: the setting lasts for this visit only.
  }
}
const isSampleArea = (value: string) =>
  value.trim().toLowerCase() === initialProfile.area.trim().toLowerCase();

// Form values are text; "" means unknown and is sent as null so the item
// fails closed on that field (or, for the typed readings, is left to the
// stored evidence).
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
  weightKg: string;
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
  weightKg: "",
  daysToSell: "",
  independentSales: "",
  displayPermitted: "",
  matchDecision: "",
  notes: "",
};
const yesNo = (v: boolean | null): "" | "yes" | "no" =>
  v === null ? "" : v ? "yes" : "no";
const draftWeight = (d: AuditHandover): number | null => {
  if (typeof d.weightKg === "number") return d.weightKg;
  const fromRequest = d.estimateInputs?.weightKg;
  return typeof fromRequest === "number" ? fromRequest : null;
};
// The figures the estimate worked out are not copied into "your reading":
// that is for what the operator checks for themselves.
function fromDraft(d: AuditHandover): Form {
  const weight = draftWeight(d);
  return {
    ...emptyForm,
    barcode: d.barcode,
    title: d.title,
    retailer: d.retailer,
    offerProvider: d.offerProvider,
    offerSourceId: d.offerSourceId,
    availabilityCheckId: d.availabilityCheckId === null ? "" : String(d.availabilityCheckId),
    promotion: d.promotion || "",
    promotionEligible: yesNo(d.promotionEligible),
    shipping: d.shipping === null ? "" : (d.shipping / 100).toFixed(2),
    weightKg: weight === null ? "" : String(weight),
  };
}
const whole = (v: string) => (v.trim() === "" ? null : Math.round(Number(v)));
const choice = (v: "" | "yes" | "no") => (v === "" ? null : v === "yes");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const listed = (labels: string[]) =>
  labels.length < 2 ? labels.join("") : labels.slice(0, -1).join(", ") + " and " + labels[labels.length - 1];
const shown = (value: unknown) =>
  value === null || value === undefined
    ? "not known"
    : value === true
      ? "yes"
      : value === false
        ? "no"
        : String(value);

function EvidenceSummary({ item }: { item: AuditItem }) {
  const ev = item.evidence;
  if (!ev) return null;
  if (!ev.offer)
    return (
      <p className="muted">
        Stored evidence: {ev.error ? "could not be read (" + ev.error + ")" : "none, because no retailer offer from the database is recorded"}.
      </p>
    );
  const s = ev.sales;
  return (
    <div className="muted">
      <p>
        Stored evidence at {dateTime(ev.evaluatedAt)}: {ev.offer.source} offer at{" "}
        {money(ev.offer.unitCost)}
        {ev.offer.sample ? " (sample data)" : ""}.{" "}
        {s
          ? `${plural(s.used, "confirmed sale")} from ${plural(s.independent, "independent seller")}`
          : "No sales"}
        {s && s.withoutSeller ? ` (${plural(s.withoutSeller, "sale")} with no seller name not counted as independent)` : ""}
        {s ? ` · days to sell ${shown(s.daysToSell)}` : ""} · match {shown(ev.match)} · display{" "}
        {ev.permission?.permitted ? "permitted" : "not permitted"} · estimate {ev.tier ?? "not run"}.
      </p>
      {ev.offerChange?.note && <p className="notice">{ev.offerChange.note}</p>}
      {ev.offerCopy?.migrated && (
        <p className="muted">
          This item was saved before the audit kept its own copy of the offer, so the copy was taken
          on {dateTime(ev.offerCopy.copiedAt)} from the offer as it stood then.
        </p>
      )}
      {ev.missingInputs && ev.missingInputs.length > 0 && (
        <p className="warn">
          Not entered in Research: {listed(ev.missingInputs)}. A blank is never counted as zero, so
          the estimate stays at Review and the item cannot pass. Enter them in Research and fill this
          form from the estimate again.
        </p>
      )}
      {s && s.notUsed.length > 0 && (
        <ul className="reasons">
          {s.notUsed.map((n) => (
            <li key={n.sale}>
              Confirmed sale {n.sourceId ? `${n.sourceId} (${n.provider})` : n.sale} not used: {n.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Audit({ draft }: { draft?: AuditHandover | null }) {
  const [locality, setLocality] = useState(loadPilotLocality);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [items, setItems] = useState<AuditItem[]>([]);
  const [form, setForm] = useState<Form>(emptyForm);
  const [handover, setHandover] = useState<{ sales: SaleKey[]; estimateInputs: Record<string, unknown> | null }>({
    sales: [],
    estimateInputs: null,
  });
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [accept, setAccept] = useState(false);
  const [signNote, setSignNote] = useState("");
  const [signMessage, setSignMessage] = useState("");

  useEffect(() => {
    if (!draft) return;
    setForm(fromDraft(draft));
    setHandover({
      sales: Array.isArray(draft.sales) ? draft.sales : [],
      estimateInputs: draft.estimateInputs ?? null,
    });
    if (draft.locality) setLocality(draft.locality);
    setMessage("");
  }, [draft]);

  useEffect(() => {
    const place = locality.trim();
    savePilotLocality(place);
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

  // A changed audit needs a fresh look before it is accepted.
  useEffect(() => {
    setAccept(false);
  }, [progress?.locality, progress?.passed, progress?.evidenced, progress?.signedOff?.id]);

  async function signOff(ev: FormEvent) {
    ev.preventDefault();
    if (!progress) return;
    setBusy(true);
    setSignMessage("");
    try {
      const result = await api<{ signedOff: SignOff; created: boolean }>("audit/signoff", {
        locality: progress.locality,
        // The counts on screen: the server refuses if the audit has changed.
        passed: progress.passed,
        evidenced: progress.evidenced,
        note: signNote.trim() || null,
      });
      // The notice above shows the sign-off once the audit reloads.
      setSignMessage(result.created ? "" : "This audit was already signed off.");
      setSignNote("");
      setVersion((n) => n + 1);
    } catch (err) {
      setSignMessage((err as Error).message);
      setVersion((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  async function save(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const numbers = [form.shipping, form.weightKg, form.daysToSell, form.independentSales, form.availabilityCheckId];
      if (numbers.some((v) => v.trim() !== "" && !Number.isFinite(Number(v))))
        throw Error("Enter numbers only in the number fields");
      const saved = await api<AuditItem>("audit", {
        locality: locality.trim(),
        barcode: form.barcode.trim(),
        title: form.title.trim(),
        retailer: form.retailer.trim(),
        offerProvider: form.offerProvider.trim() || null,
        offerSourceId: form.offerSourceId.trim() || null,
        sales: form.offerProvider.trim() ? handover.sales : [],
        weightKg: form.weightKg.trim() === "" ? null : Number(form.weightKg),
        estimateInputs: handover.estimateInputs,
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
          ? "Saved. This item passes every audit check on the stored evidence."
          : "Saved. This item fails: " + saved.outcome.reasons.join("; ") + ".",
      );
      setForm(emptyForm);
      setHandover({ sales: [], estimateInputs: null });
      setVersion((n) => n + 1);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const failures = Object.entries(progress?.failures || {}).sort((a, b) => b[1] - a[1]);
  const sampleArea = locality.trim() !== "" && isSampleArea(locality);
  return (
    <article className="audit">
      <small>Before real buy alerts</small>
      <h2>Validation audit</h2>
      <p>
        Before buy alerts can be trusted, check 30 barcoded items in the pilot
        locality (one London borough, still to be chosen) against the retailer
        and actual sold evidence. An item passes only on the evidence stored
        here: the retailer offer, the completed sales you confirmed in Research,
        a branch stock check in the pilot locality, the display permission and
        an estimate of Priority 1 or 2. Promotion eligibility and the parcel
        cost come from you. Anything unknown fails.
      </p>
      <p className="muted">
        An item counts towards the 30 only when it has a retailer offer from the
        database, at least one completed sale you confirmed as the exact item and
        a branch check in the pilot locality, and its evidence is not sample data.
        Each item is judged on the offer as it was when you saved it, so a later
        feed import does not change the result; a changed offer is shown beside
        the item.
      </p>
      <label>
        Pilot locality
        <input
          value={locality}
          maxLength={120}
          placeholder="The London borough chosen for the pilot"
          onChange={(e) => setLocality(e.target.value)}
        />
      </label>
      <p className="muted">Kept in this browser as your audit setting.</p>
      {!locality.trim() && (
        <p className="notice">Enter the pilot locality to see and record audited items.</p>
      )}
      {sampleArea && (
        <p className="notice" role="status">
          {initialProfile.area} is the planner's sample area, not the pilot
          locality. Items audited here do not count towards the London pilot.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {progress && (
        <div className="audit-progress">
          <progress max={progress.target} value={Math.min(progress.evidenced, progress.target)} />
          <p>
            <b>
              {progress.evidenced} of {progress.target} items checked against stored evidence in{" "}
              {progress.locality}
            </b>
          </p>
          <p>
            <span className="ok">{progress.passed} passed</span>
            {" · "}
            <span className="warn">{progress.failed} failed</span>
            {" · "}
            {progress.remaining === 0
              ? "no more items needed"
              : `${plural(progress.remaining, "more item")} with stored evidence needed`}
          </p>
          {progress.withoutEvidence > 0 && (
            <div className="muted">
              <p>
                {plural(progress.withoutEvidence, "recorded item")} {progress.withoutEvidence === 1 ? "does" : "do"} not
                count towards the {progress.target}:
              </p>
              <ul className="reasons">
                {Object.entries(progress.withoutEvidenceReasons ?? {})
                  .sort((a, b) => b[1] - a[1])
                  .map(([gap, count]) => (
                    <li key={gap}>
                      {gap}: {plural(count, "item")}
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {progress.signedOff ? (
            <div className="notice" role="status">
              <p>
                <b>
                  Signed off on {dateTime(progress.signedOff.at)}: {progress.signedOff.passed} of{" "}
                  {progress.signedOff.evidenced} items passed.
                </b>
                {progress.signedOff.note ? ` Your note: ${progress.signedOff.note}` : ""}
              </p>
              <p>
                Bounty cards and alerts in {progress.locality} now say “
                {progress.signedOff.summary ??
                  memberLine(progress.locality, progress.signedOff.at, progress.signedOff.passed, progress.signedOff.evidenced)}
                ”
                in place of the caution, so members always see the result. The sign-off records that you
                reviewed it; it does not make the figures proven.
              </p>
            </div>
          ) : progress.complete ? (
            <div className="notice">
              <p>
                <b>
                  Audit complete, not yet signed off: {progress.passed} of {progress.evidenced} items
                  passed.
                </b>{" "}
                Until you sign it off, bounties in {progress.locality} tell members to treat their
                figures with care. Review the failures below before you accept it.
              </p>
              {progress.signOffLapsed && (
                <p className="warn">
                  Your sign-off on {dateTime(progress.signOffLapsed.at)} no longer stands:{" "}
                  {progress.signOffLapsed.reason}.
                </p>
              )}
              {progress.signOffBlocked ? (
                <p className="warn">
                  {progress.signOffBlocked}. How many items must pass before the pilot can be signed off
                  is still to be agreed.
                </p>
              ) : (
                <form onSubmit={signOff}>
                  <p className="muted">
                    Signing off records that you have reviewed this result. It does not mean the figures are
                    proven: bounty cards and alerts in {progress.locality} will say “
                    {memberLine(progress.locality, new Date().toISOString(), progress.passed, progress.evidenced)}”
                    so members always see how many passed.
                  </p>
                  <label className="inline">
                    <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
                    I have reviewed this audit and accept it: {progress.passed} of {progress.evidenced} items
                    passed
                  </label>
                  <label>
                    Note (optional)
                    <input value={signNote} onChange={(e) => setSignNote(e.target.value)} maxLength={500} />
                  </label>
                  <button disabled={busy || !accept}>Sign off the audit</button>
                </form>
              )}
            </div>
          ) : (
            <p className="notice">
              Not validated yet: {progress.evidenced} of {progress.target} items checked against stored
              evidence. Bounties in {progress.locality} say so until {progress.target} items have stored
              evidence and you sign the audit off.
              {progress.signOffLapsed
                ? ` Your sign-off on ${dateTime(progress.signOffLapsed.at)} no longer stands: ${progress.signOffLapsed.reason}.`
                : ""}
            </p>
          )}
          {signMessage && <p role="status">{signMessage}</p>}
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
        <p className="muted">
          Fill this form from a Research estimate so the offer, the confirmed
          sales and the trip inputs come with it. Without confirmed sales an
          item cannot pass.
        </p>
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
              Unit weight (kg)
              <input type="number" min={0} step={0.001} value={form.weightKg} onChange={(e) => set("weightKg", e.target.value)} />
            </label>
          </div>
          <p className="muted">
            {handover.sales.length
              ? `${plural(handover.sales.length, "completed sale")} confirmed in Research will be checked against the database.`
              : "No confirmed sales came with this form."}
            {handover.estimateInputs ? " The trip inputs from the Research estimate are kept with the item." : ""}
          </p>
          {form.offerProvider.trim() && blankTripInputs(handover.estimateInputs).length > 0 && (
            <p className="warn">
              Not entered in Research: {listed(blankTripInputs(handover.estimateInputs))}. A blank is
              never counted as zero, so this item will stay at Review and fail. Enter them in Research
              and fill this form from the estimate again.
            </p>
          )}
          <fieldset>
            <legend>Your own reading (optional)</legend>
            <p className="muted">
              Leave these blank to rely on the stored evidence. Anything you
              enter is compared with it, and a figure that disagrees fails the
              item and is shown beside the evidence.
            </p>
            <div className="grid2">
              <label>
                Days to sell
                <input type="number" min={0} step={1} value={form.daysToSell} onChange={(e) => set("daysToSell", e.target.value)} />
              </label>
              <label>
                Independent sellers in the last 90 days
                <input type="number" min={0} step={1} value={form.independentSales} onChange={(e) => set("independentSales", e.target.value)} />
              </label>
              <label>
                Display permitted?
                <select value={form.displayPermitted} onChange={(e) => set("displayPermitted", e.target.value)}>
                  <option value="">Not entered</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </label>
              <label>
                Match decision
                <select value={form.matchDecision} onChange={(e) => set("matchDecision", e.target.value)}>
                  <option value="">Not entered</option>
                  <option value="exact">Exact</option>
                  <option value="research">Research: similar or uncertain</option>
                  <option value="none">No match</option>
                </select>
              </label>
            </div>
          </fieldset>
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
          {items.map((item) => {
            const contradictions = item.outcome.contradictions ?? [];
            return (
              <div className="evidence-row" key={item.id}>
                <div>
                  <span className={"badge " + (item.outcome.passed ? "ok" : "warn")}>
                    {item.outcome.passed ? "Pass" : "Fail"}
                  </span>
                  <b>{item.title}</b>
                  <small>
                    {barcodeText(item.barcode)} · {item.retailer} · parcel{" "}
                    {item.shipping === null ? "unknown" : money(item.shipping)} · updated{" "}
                    {dateTime(item.updated)}
                  </small>
                  {item.evidenced !== undefined && (
                    <p className={item.evidenced ? "muted" : "warn"}>
                      {item.evidenced
                        ? `Counts towards the ${progress?.target ?? 30}.`
                        : `Does not count towards the ${progress?.target ?? 30}: ${(item.evidenceGaps ?? []).map(lowerFirst).join("; ")}.`}
                    </p>
                  )}
                  <EvidenceSummary item={item} />
                  {contradictions.length > 0 && (
                    <ul className="warnings">
                      {contradictions.map((c) => (
                        <li key={c.id}>
                          {c.label}: you recorded {shown(c.recorded)}, the stored evidence says {shown(c.evidence)}
                        </li>
                      ))}
                    </ul>
                  )}
                  {!item.outcome.passed && (
                    <ul className="reasons">
                      {item.outcome.reasons
                        .filter((r) => !contradictions.some((c) => c.reason === r))
                        .map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                    </ul>
                  )}
                  {item.evidence?.tier && item.evidence.tierReasons.length > 0 && !["Priority 1", "Priority 2"].includes(item.evidence.tier) && (
                    <p className="muted">
                      Estimate {item.evidence.tier}: {item.evidence.tierReasons.join("; ")}.
                    </p>
                  )}
                  <details>
                    <summary>Every check</summary>
                    <ul className="checks">
                      {item.outcome.checks.map((c) => (
                        <li key={c.id} className={c.ok ? "pass" : ""}>
                          {c.detail}
                        </li>
                      ))}
                    </ul>
                  </details>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}
