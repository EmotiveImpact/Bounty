import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api, hours, money, percent, toPence } from "./api";
import "./Ledger.css";

// Shapes returned by server/routes-ledger.mjs. Money is integer pence.
type Kind = "resale" | "household";
type EntryType = "receipt" | "sale" | "payout" | "expense" | "refund" | "work" | "saving";
type Predicted = {
  units: number;
  proceeds: number;
  contribution: number;
  cashRequired: number;
  activeMinutes: number;
  payoutBy: string | null;
  sample?: boolean | null;
};
type Basis = "live" | "sample" | "unknown";
type Trip = {
  id: number;
  label: string;
  source: "planner" | "research" | "bounty" | "manual" | "legacy";
  kind: Kind;
  reference: string | null;
  predicted: Predicted | null;
  status: "open" | "closed";
  created: string;
  closed_at: string | null;
  legacy: boolean;
  // Where the prediction came from; only "live" counts in potential proceeds
  // and the prediction accuracy measures.
  predictionBasis: Basis | null;
  sample: boolean;
};
type TripRow = Trip & {
  entries: number;
  proofs: number;
  realisedContribution: number | null;
  householdSavings: number;
  netHouseholdSaving: number | null;
  pendingPayout: number;
  unsoldUnits: number | null;
  complete: boolean;
  discrepancies: number;
  verified: boolean;
  verificationMissing: string[];
};
type Entry = {
  id: number;
  trip_id: number;
  type: EntryType;
  amount: number;
  units: number | null;
  reference: string | null;
  occurred: string;
  minutes: number | null;
  note: string | null;
  created: string;
};
type Proof = {
  id: number;
  trip_id: number;
  entry_id: number | null;
  sha256: string;
  bytes: number;
  media_type: string;
  label: string;
  created: string;
  metadataRemoved: boolean;
};
type Status = "present" | "missing" | "not applicable";
type Reconciliation = {
  kind: Kind;
  status: "open" | "closed";
  legacy: boolean;
  receipts: number;
  sales: number;
  payouts: number;
  expenses: number;
  refunds: number;
  minutes: number;
  spend: number;
  unitsBought: number;
  unitsSold: number;
  unitsReturned: number;
  unsoldUnits: number | null;
  realisedContribution: number | null;
  realisedHourly: number | null;
  pendingPayout: number;
  pendingBasis: "units" | "dates" | "no payouts" | null;
  impliedFees: number | null;
  cashTiedUp: number;
  householdSavings: number;
  netHouseholdSaving: number | null;
  checklist: {
    receipt: Status;
    soldListing: Status;
    payout: Status;
    expenses: Status;
    returns: Status;
    work: Status;
    saving: Status;
    required: string[];
    complete: boolean;
    reconciled: boolean;
  };
  discrepancies: { code: string; message: string }[];
  verified: boolean;
  verificationMissing: string[];
  // Receipt and payout entries whose own proof counts towards verification.
  proofedEntries: number[];
  forecast: {
    basis: Basis;
    counted: boolean;
    final: boolean;
    predictedUnits: number;
    predictedProceeds: number;
    predictedContribution: number;
    predictedCashRequired: number;
    predictedMinutes: number;
    predictedHourly: number | null;
    payoutBy: string | null;
    contributionError: number;
    minutesError: number | null;
    cashSpent: number;
    payoutLateDays: number | null;
  } | null;
  timeToPayoutDays: number | null;
};
type Detail = { trip: Trip; entries: Entry[]; proofs: Proof[]; reconciliation: Reconciliation };
type Summary = {
  month: string;
  realisedEarnings: number;
  // Net of household trip costs; the gross figure and costs are its parts.
  householdSavings: number;
  householdSavingsGross: number;
  householdTripCosts: number;
  pendingPayouts: number;
  potentialProceeds: number;
  potentialProceedsLeftOut: { sample: number; basisUnknown: number; nothingBought: number };
  cashTiedUp: number;
  unsoldUnits: number;
  realisedMinutes: number;
  // Earnings per hour on the trips with work time this month only; null
  // when none of them has money in or out this month.
  realisedHourly: number | null;
  hourly?: { trips: number; minutes: number; earnings: number; leftOutTrips: number; leftOutEarnings: number };
  payouts: number;
  verifiedPayouts: number;
  verifiedEarnings: number;
  verifiedTrips: number;
  unverifiedTrips: number;
  openTrips: number;
};
type Metrics = {
  closedTrips: number;
  verifiedTrips: number;
  legacyTrips: number;
  forecast: {
    trips: number;
    meanAbsoluteContributionError: number | null;
    meanContributionError: number | null;
    minutesTrips: number;
    meanAbsoluteMinutesError: number | null;
    meanMinutesError: number | null;
    leftOut: { sample: number; basisUnknown: number; notTaken: number };
  };
  cash: { spend: number; payouts: number; verifiedPayouts: number; recoveryRate: number | null };
  payoutTrips: number;
  medianTimeToPayoutDays: number | null;
  unsoldUnits: number;
  hourly: {
    trips: number;
    realised: number | null;
    comparison: { trips: number; realised: number | null; predicted: number | null };
  };
};

const ENTRY_TYPES: Record<Kind, EntryType[]> = {
  resale: ["receipt", "sale", "payout", "expense", "refund", "work"],
  household: ["receipt", "saving", "expense", "work"],
};
const TYPE_LABEL: Record<EntryType, string> = {
  receipt: "Purchase receipt",
  sale: "Sold listing",
  payout: "Payout",
  expense: "Expense",
  refund: "Refund to a buyer",
  work: "Work time",
  saving: "Household saving",
};
const TYPE_HINT: Record<EntryType, string> = {
  receipt: "What you paid for the stock, and how many units. Reference: the receipt number.",
  sale: "What the buyer paid, including the postage they paid. Reference: the sold listing or order number.",
  payout: "Money the marketplace actually paid into your account. Give the units it covers so fees can be told apart from payouts still to come.",
  expense: "Travel, parking, postage labels, packaging or fees charged separately from the payout.",
  refund: "Money you paid back to a buyer for a return, and how many units came back. Only record it if the money left you or was taken from a payout you have already recorded.",
  work: "Time spent on this trip: travelling, in store, listing, packing and posting.",
  saving: "The saving against the usual price of what you bought. Your own estimate: it is never earnings.",
};
const SOURCE_LABEL: Record<Trip["source"], string> = {
  planner: "From the planner",
  research: "From research",
  bounty: "From a bounty",
  manual: "Entered here",
  legacy: "Legacy totals",
};
const MAX_PROOF_BYTES = 5 * 1024 * 1024;
const PROOF_TYPES = ["image/jpeg", "image/png", "application/pdf"];

// Calendar dates in the viewer's own time zone, matching what they would write.
const today = () => new Date().toLocaleDateString("en-CA");
const thisMonth = () => today().slice(0, 7);
const longDate = (date: string) =>
  new Date(date + "T12:00:00Z").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
// Shown where a figure cannot be worked out yet.
const BLANK = "not known";
const signed = (pence: number | null) =>
  pence === null ? BLANK : (pence > 0 ? "+" : "") + money(pence);
const perHour = (pence: number | null) => (pence === null ? "no work time recorded" : money(pence) + " per hour");
const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? Math.max(1, Math.round(bytes / 1024)).toLocaleString("en-GB") + " KB"
    : (bytes / 1024 / 1024).toLocaleString("en-GB", { maximumFractionDigits: 1 }) + " MB";
const plural = (n: number, word: string) => n.toLocaleString("en-GB") + " " + word + (n === 1 ? "" : "s");
// The UK calendar day of a stored timestamp, such as when a trip was closed.
const ukDay = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" })
    : "";
const minutesText = (m: number | null) => (m === null ? "none recorded" : hours(m));

export default function Ledger() {
  const [trips, setTrips] = useState<TripRow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState("");
  const changed = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let active = true;
    api<{ trips: TripRow[] }>("ledger/trips")
      .then((data) => {
        if (!active) return;
        setTrips(data.trips);
        setError("");
      })
      .catch((e: Error) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [version]);

  return (
    <section className="ledger">
      <SummaryPanel version={version} />
      <TaxNote />
      <div className="ledger-layout">
        <article>
          <h2>Trips</h2>
          <NewTripForm
            onCreated={(id) => {
              setSelected(id);
              changed();
            }}
          />
          {error && <p role="alert">{error}</p>}
          <TripList trips={trips} selected={selected} onSelect={setSelected} />
        </article>
        <article>
          {selected === null ? (
            <p className="muted">
              Choose a trip to record its receipt, sold listing, payout, expenses, returns and work
              time, and to see how it compares with the prediction.
            </p>
          ) : (
            <TripDetail id={selected} version={version} onChanged={changed} />
          )}
        </article>
      </div>
      <MetricsPanel version={version} />
    </section>
  );
}

function Stat({ label, value, note, tone }: { label: string; value: string; note: string; tone?: "estimate" | "pending" }) {
  return (
    <div className={"ledger-stat" + (tone ? " " + tone : "")}>
      <span className="ledger-stat-label">{label}</span>
      <span className="ledger-stat-value">{value}</span>
      <span className="muted">{note}</span>
    </div>
  );
}

function SummaryPanel({ version }: { version: number }) {
  const [month, setMonth] = useState(thisMonth);
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    let active = true;
    api<Summary>("ledger/summary?month=" + encodeURIComponent(month))
      .then((s) => {
        if (!active) return;
        setData(s);
        setError("");
      })
      .catch((e: Error) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [month, version]);

  return (
    <article className="ledger-summary">
      <div className="ledger-heading">
        <h2>Month summary</h2>
        <label>
          Month
          <input type="month" value={month} max={thisMonth()} onChange={(e) => setMonth(e.target.value)} />
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <div className="ledger-stats">
            <Stat
              label="Realised earnings"
              value={signed(data.realisedEarnings)}
              note={
                "Payouts received minus money spent, dated this month. " +
                (data.payouts > 0
                  ? money(data.verifiedPayouts) + " of " + money(data.payouts) + " in payouts is verified."
                  : "No payouts this month.")
              }
            />
            <Stat
              label="Household savings"
              value={signed(data.householdSavings)}
              note={
                "Saved against usual prices on things for your home, less those trips' costs such as travel and parking" +
                (data.householdTripCosts > 0
                  ? ": " + money(data.householdSavingsGross) + " saved, " + money(data.householdTripCosts) + " costs."
                  : ".") +
                " Not earnings."
              }
            />
            <Stat
              label="Pending payouts"
              value={money(data.pendingPayouts)}
              tone="pending"
              note="Sales on open trips that no payout covers yet. Not realised until the marketplace pays them out."
            />
            <Stat
              label="Potential proceeds"
              value={money(data.potentialProceeds)}
              tone="estimate"
              note={
                "Estimate only, never counted as earned: live-evidence predictions for stock bought on open trips with no payout yet, less sales recorded." +
                leftOutText(data.potentialProceedsLeftOut)
              }
            />
            <Stat
              label="Cash tied up"
              value={money(data.cashTiedUp)}
              note="Money spent on open trips that payouts have not yet recovered."
            />
            <Stat
              label="Unsold units"
              value={data.unsoldUnits.toLocaleString("en-GB")}
              note="Bought on open trips and not yet sold. You carry the risk if they do not sell."
            />
            <Stat
              label="Realised hourly"
              value={data.realisedHourly === null ? BLANK : money(data.realisedHourly)}
              note={hourlyNote(data)}
            />
          </div>
          <p className="muted">
            Basis: cash in the month. Realised earnings are payouts dated this month minus receipts,
            expenses and refunds dated this month, so stock bought in one month and paid out in the
            next shows as a cost first and income later. Only payouts count as earned. Pending
            payouts, potential proceeds, cash tied up and unsold units describe open trips as they
            stand today, whatever the month. Potential proceeds count a prediction only when it came
            from live evidence and stock has been bought, scaled to the units bought. Household
            savings are net of those trips&apos; own costs. Realised hourly counts only the trips with
            work time recorded this month, so money is never divided by another trip&apos;s hours.{" "}
            {data.verifiedTrips + data.unverifiedTrips > 0 &&
              `This month: ${data.verifiedTrips} verified and ${data.unverifiedTrips} unverified resale trips. Verified earnings: ${signed(data.verifiedEarnings)}.`}
          </p>
        </>
      )}
    </article>
  );
}

/**
 * What the month's hourly figure covers: only trips with work time this
 * month, and how much realised money from other trips was left out.
 */
function hourlyNote(data: Summary) {
  const h = data.hourly;
  if (!h)
    return data.realisedMinutes ? "Per hour over " + hours(data.realisedMinutes) + " of recorded work this month." : "No work time recorded this month.";
  const left =
    h.leftOutTrips > 0
      ? " " +
        (h.leftOutEarnings < 0 ? "A net loss of " + money(-h.leftOutEarnings) : money(h.leftOutEarnings)) +
        " from " + plural(h.leftOutTrips, "trip") + " without work time is not included."
      : "";
  if (data.realisedHourly !== null) return "Per hour over " + hours(h.minutes) + " on " + plural(h.trips, "trip") + "." + left;
  if (h.trips > 0)
    return "Not known: the " + hours(h.minutes) + " of work this month is on trips with no money in or out this month." + left;
  if (h.leftOutTrips > 0) return "Not known: no trip with money this month has work time recorded." + left;
  return "No work time recorded this month.";
}

/** Names the open trips left out of potential proceeds, if any. */
function leftOutText(left: Summary["potentialProceedsLeftOut"] | undefined) {
  if (!left) return "";
  const parts = [
    left.sample && plural(left.sample, "trip") + " with a sample prediction",
    left.basisUnknown && plural(left.basisUnknown, "trip") + " whose evidence is unknown",
    left.nothingBought && plural(left.nothingBought, "trip") + " with nothing bought yet",
  ].filter(Boolean);
  return parts.length ? " Left out: " + parts.join(", ") + "." : "";
}

function TaxNote() {
  return (
    <article className="ledger-tax">
      <h2>Tax</h2>
      <p>
        Income from resale may need to be reported to HMRC. HMRC says you are probably trading if
        you buy goods intending to sell them for a profit, and that if your total trading income for
        the tax year (6 April to 5 April) is more than the £1,000 trading allowance you need to tell
        it. The allowance is measured on income before costs, not on the profit shown here. Online
        marketplaces also report some sellers&apos; details and income to HMRC each year.
      </p>
      <p className="muted">
        Bounty does not give tax advice. Check GOV.UK:{" "}
        <a href="https://www.gov.uk/guidance/tax-free-allowances-on-property-and-trading-income" target="_blank" rel="noreferrer">
          tax-free allowances on property and trading income
        </a>
        ,{" "}
        <a href="https://www.gov.uk/guidance/check-if-you-need-to-tell-hmrc-about-your-income-from-online-platforms" target="_blank" rel="noreferrer">
          check if you need to tell HMRC about income from online platforms
        </a>{" "}
        and{" "}
        <a href="https://www.gov.uk/guidance/selling-goods-or-services-on-a-digital-platform" target="_blank" rel="noreferrer">
          selling goods or services on a digital platform
        </a>
        .
      </p>
    </article>
  );
}

function NewTripForm({ onCreated }: { onCreated: (id: number) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    setError("");
    try {
      const saved = await api<{ id: number }>("ledger/trips", {
        label: String(f.get("label") || "").trim(),
        source: "manual",
        kind: f.get("kind"),
        reference: String(f.get("reference") || "").trim() || undefined,
      });
      form.reset();
      onCreated(saved.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>New trip</summary>
      <form className="ledger-form" onSubmit={submit}>
        <label>
          Name
          <input name="label" required maxLength={120} placeholder="Saturday charity shop run" />
        </label>
        <label>
          Kind
          <select name="kind" defaultValue="resale">
            <option value="resale">Resale: buy to sell on</option>
            <option value="household">Household: buy for home at a saving</option>
          </select>
        </label>
        <label>
          Reference (optional)
          <input name="reference" maxLength={120} placeholder="Shop, item or bounty" />
        </label>
        <button disabled={busy}>Create trip</button>
        {error && <p role="alert">{error}</p>}
      </form>
      <p className="muted">
        Trips tracked from the planner or research tabs arrive here with their prediction attached,
        so you can compare what happened with what was expected.
      </p>
    </details>
  );
}

function VerifiedBadge({ verified, kind, legacy }: { verified: boolean; kind: Kind; legacy: boolean }) {
  if (kind === "household" || legacy) return null;
  return verified ? (
    <span className="badge ok">Verified</span>
  ) : (
    <span className="badge warn">Unverified</span>
  );
}

function PredictionBadge({ basis }: { basis: Basis | null }) {
  if (basis === "sample") return <span className="badge sample">Sample prediction</span>;
  if (basis === "unknown") return <span className="badge sample">Evidence unknown</span>;
  return null;
}

/** Why a trip's prediction is left out of potential proceeds and the measures. */
function PredictionNotice({ trip }: { trip: Trip }) {
  if (trip.predictionBasis === "sample")
    return (
      <p className="notice">
        Sample prediction: this trip was tracked with figures from sample or illustrative data, not
        live evidence. Its prediction is not counted in potential proceeds or in the prediction
        accuracy measures. Receipts, sales and payouts you record here are real and count as usual.
      </p>
    );
  if (trip.predictionBasis === "unknown")
    return (
      <p className="notice">
        This trip was tracked without saying whether its prediction came from live evidence, so it
        is treated like a sample: not counted in potential proceeds or in the prediction accuracy
        measures. Receipts, sales and payouts you record here count as usual.
      </p>
    );
  return null;
}

function TripList({
  trips,
  selected,
  onSelect,
}: {
  trips: TripRow[];
  selected: number | null;
  onSelect: (id: number) => void;
}) {
  if (!trips.length)
    return <p className="muted">No trips yet. Create one, or track a trip from the planner or research tabs.</p>;
  return (
    <div className="ledger-trips">
      {trips.map((t) => (
        <button
          key={t.id}
          className={"card ledger-trip" + (t.id === selected ? " active" : "")}
          aria-current={t.id === selected ? "true" : undefined}
          onClick={() => onSelect(t.id)}
        >
          <span>
            <b>{t.label}</b>
            <span className="badges">
              <span className={"badge" + (t.legacy ? " sample" : "")}>{SOURCE_LABEL[t.source]}</span>
              {t.kind === "household" && <span className="badge">Household</span>}
              <PredictionBadge basis={t.predictionBasis} />
              <span className="badge">{t.status === "open" ? "Open" : "Closed"}</span>
              <VerifiedBadge verified={t.verified} kind={t.kind} legacy={t.legacy} />
              {t.discrepancies > 0 && <span className="badge warn">{t.discrepancies} to check</span>}
            </span>
          </span>
          <span>
            {t.kind === "household" ? (
              <>
                {signed(t.netHouseholdSaving ?? t.householdSavings)}
                <span className="muted ledger-sub">saved after costs</span>
              </>
            ) : (
              <>
                {signed(t.realisedContribution)}
                <span className="muted ledger-sub">realised</span>
              </>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

function TripDetail({ id, version, onChanged }: { id: number; version: number; onChanged: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  useEffect(() => {
    setActionError("");
    let active = true;
    api<Detail>("ledger/trips/" + id)
      .then((d) => {
        if (!active) return;
        setDetail(d);
        setError("");
      })
      .catch((e: Error) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [id, version]);

  if (error) return <p role="alert">{error}</p>;
  if (!detail || detail.trip.id !== id) return <p className="muted">Loading the trip.</p>;
  const { trip, entries, proofs, reconciliation: r } = detail;
  const editable = trip.status === "open" && !trip.legacy;

  async function close() {
    if (!window.confirm("Close this trip? You will not be able to add entries afterwards. Closed trips feed the forecast measures.")) return;
    try {
      await api("ledger/trips/" + id + "/close", {});
      onChanged();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  async function remove(entry: Entry) {
    const proofNote = proofs.some((p) => p.entry_id === entry.id)
      ? " Its proof stays stored as a whole-trip proof, which does not count towards verification until you link it to another entry."
      : "";
    if (!window.confirm("Remove this " + TYPE_LABEL[entry.type].toLowerCase() + " entry?" + proofNote)) return;
    try {
      await api("ledger/trips/" + id + "/entries/" + entry.id, {}, "DELETE");
      onChanged();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  return (
    <div className="stack">
      <div className="ledger-heading">
        <h2>{trip.label}</h2>
        {trip.status === "open" && !trip.legacy && (
          <button type="button" onClick={close}>
            Close trip
          </button>
        )}
      </div>
      {actionError && <p role="alert">{actionError}</p>}
      <p className="badges">
        <span className={"badge" + (trip.legacy ? " sample" : "")}>{SOURCE_LABEL[trip.source]}</span>
        <span className="badge">{trip.kind === "household" ? "Household" : "Resale"}</span>
        <PredictionBadge basis={trip.predictionBasis} />
        <span className="badge">
          {trip.status === "open" ? "Open" : "Closed " + ukDay(trip.closed_at)}
        </span>
        <VerifiedBadge verified={r.verified} kind={trip.kind} legacy={trip.legacy} />
        {trip.reference && <span className="muted">Reference: {trip.reference}</span>}
      </p>
      {trip.legacy && (
        <p className="notice">
          Legacy totals: entered before the ledger existed as single figures for actual proceeds,
          total costs and minutes. There is no receipt or sold listing behind them, so they cannot be
          reconciled or verified, and they are left out of the forecast measures.
        </p>
      )}
      <PredictionNotice trip={trip} />

      {trip.kind === "resale" ? <ResaleFigures r={r} /> : <HouseholdFigures r={r} />}
      <Checklist r={r} />
      {trip.kind === "resale" && !trip.legacy && <Verification r={r} />}
      {r.forecast && <Forecast r={r} />}

      <EntriesTable
        entries={entries}
        proofs={proofs}
        proofed={trip.kind === "resale" && !trip.legacy ? r.proofedEntries : null}
        onRemove={editable ? remove : undefined}
      />
      {editable && <EntryForm key={"entry-" + trip.id} trip={trip} onSaved={onChanged} />}
      {!trip.legacy && (
        <Proofs
          key={"proofs-" + trip.id}
          trip={trip}
          entries={entries}
          proofs={proofs}
          proofed={r.proofedEntries}
          onSaved={onChanged}
        />
      )}
    </div>
  );
}

function ResaleFigures({ r }: { r: Reconciliation }) {
  return (
    <dl className="ledger-figures">
      <dt>Purchase receipts</dt>
      <dd>{money(r.receipts)}</dd>
      <dt>Expenses</dt>
      <dd>{money(r.expenses)}</dd>
      <dt>Refunds to buyers</dt>
      <dd>{money(r.refunds)}</dd>
      <dt>Recorded sales (not cash until paid out)</dt>
      <dd>{money(r.sales)}</dd>
      <dt>Payouts received</dt>
      <dd>{money(r.payouts)}</dd>
      <dt>Realised contribution (payouts minus spending)</dt>
      <dd className={r.realisedContribution !== null && r.realisedContribution < 0 ? "warn" : undefined}>
        <b>{signed(r.realisedContribution)}</b>
      </dd>
      <dt>Work time</dt>
      <dd>{minutesText(r.minutes || null)}</dd>
      <dt>Realised earnings per hour</dt>
      <dd>{perHour(r.realisedHourly)}</dd>
      {r.status !== "closed" && (
        <>
          <dt>Pending payout (not realised)</dt>
          <dd>{money(r.pendingPayout)}</dd>
          <dt>Cash tied up</dt>
          <dd>{money(r.cashTiedUp)}</dd>
        </>
      )}
      <dt>Fees kept by the marketplace (implied)</dt>
      <dd>{r.impliedFees === null ? BLANK : money(r.impliedFees)}</dd>
      {!r.legacy && (
        <>
          <dt>Units bought, sold, returned</dt>
          <dd>
            {r.unitsBought} / {r.unitsSold} / {r.unitsReturned}
          </dd>
          <dt>Unsold units</dt>
          <dd>{r.unsoldUnits ?? BLANK}</dd>
        </>
      )}
      <dt>Time to payout (first receipt to last payout)</dt>
      <dd>
        {r.timeToPayoutDays !== null
          ? plural(r.timeToPayoutDays, "day")
          : r.payouts > 0
            ? BLANK
            : "not paid out yet"}
      </dd>
      {r.pendingBasis === "dates" && r.impliedFees !== null && (
        <dd className="ledger-figures-note muted">
          A payout without a unit count is taken to cover every sale recorded up to its date, so the
          gap is shown as fees rather than as a payout still to come. If part of it is still to be
          paid, give the units each payout covers.
        </dd>
      )}
    </dl>
  );
}

function HouseholdFigures({ r }: { r: Reconciliation }) {
  return (
    <dl className="ledger-figures">
      <dt>Paid at the till</dt>
      <dd>{money(r.receipts)}</dd>
      <dt>Saving against usual prices</dt>
      <dd>
        <b>{money(r.householdSavings)}</b>
      </dd>
      <dt>Trip expenses</dt>
      <dd>{money(r.expenses)}</dd>
      <dt>Saving after trip expenses</dt>
      <dd className={(r.netHouseholdSaving ?? 0) < 0 ? "warn" : undefined}>{money(r.netHouseholdSaving)}</dd>
      <dt>Work time</dt>
      <dd>{minutesText(r.minutes || null)}</dd>
      <dd className="ledger-figures-note muted">
        Household savings are your own estimate against the usual price. They are never counted as
        earnings or proceeds.
      </dd>
    </dl>
  );
}

const CHECK_LABEL: [keyof Reconciliation["checklist"], string][] = [
  ["receipt", "Purchase receipt"],
  ["soldListing", "Sold listing"],
  ["payout", "Payout"],
  ["saving", "Household saving"],
  ["expenses", "Expenses"],
  ["returns", "Returns"],
  ["work", "Work time"],
];

function Checklist({ r }: { r: Reconciliation }) {
  const c = r.checklist;
  const missing = c.required.filter((key) => c[key as keyof Reconciliation["checklist"]] !== "present");
  // Work time is needed for earnings per hour, not to prove a trade, so a
  // trip missing only its work time does not say "Records missing".
  const recordsMissing = missing.some((key) => key !== "work");
  return (
    <div>
      <b>
        Reconciliation{" "}
        {c.reconciled ? (
          <span className="badge ok">Complete</span>
        ) : (
          <span className="badge warn">
            {recordsMissing ? "Records missing" : r.discrepancies.length > 0 ? "Check discrepancies" : "Work time missing"}
          </span>
        )}
      </b>
      <ul className="checks">
        {CHECK_LABEL.filter(([key]) => c[key] !== "not applicable").map(([key, label]) => {
          const required = c.required.includes(key);
          const present = c[key] === "present";
          return (
            <li key={key} className={present || !required ? "pass" : undefined}>
              {label}:{" "}
              {present ? "recorded" : required ? "missing" : "none recorded (fine if there were none)"}
            </li>
          );
        })}
      </ul>
      {r.discrepancies.length > 0 && (
        <>
          <b className="warn">Discrepancies to check</b>
          <ul className="checks">
            {r.discrepancies.map((d) => (
              <li key={d.code}>{d.message}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Verification({ r }: { r: Reconciliation }) {
  const noWork = r.checklist.work !== "present";
  return (
    <div>
      <b>
        Verification{" "}
        {r.verified ? <span className="badge ok">Verified</span> : <span className="badge warn">Unverified</span>}
      </b>
      {r.verified && (
        <p>
          Verified: the purchase receipt and payout proofs are attached and the amounts, units and
          dates agree.
          {noWork && " Work time is not recorded, so earnings per hour for this trip are not known."}
        </p>
      )}
      <p className="muted">
        A trade is verified only when every purchase receipt and every payout has its own proof
        attached to that entry, a sold listing is recorded, and the amounts, units and dates agree
        with each other. One document proves one purchase or one payout: a file that is already the
        proof for another entry, on this trip or any other, does not count again. Whole-trip proofs
        do not count. Work time is not needed to verify a trade. Unverified figures still count in
        your totals, but the summary and measures say how much is verified.
      </p>
      {!r.verified && (
        <>
          <b>Not verified because:</b>
          <ul className="checks">
            {r.verificationMissing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Forecast({ r }: { r: Reconciliation }) {
  const f = r.forecast!;
  return (
    <div>
      <b>
        Realised against predicted{" "}
        {f.basis === "sample" ? (
          <span className="badge sample">Sample: not measured</span>
        ) : f.basis !== "live" ? (
          <span className="badge sample">Evidence unknown: not measured</span>
        ) : !f.counted ? (
          <span className="badge">Nothing recorded yet</span>
        ) : (
          !f.final && <span className="badge">Provisional until the trip is closed</span>
        )}
      </b>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th />
              <th className="num">Predicted</th>
              <th className="num">Realised</th>
              <th className="num">Difference</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Contribution</td>
              <td className="num">{signed(f.predictedContribution)}</td>
              <td className="num">{signed(r.realisedContribution)}</td>
              <td className={"num" + (f.contributionError < 0 ? " warn" : "")}>{signed(f.contributionError)}</td>
            </tr>
            <tr>
              <td>Active time</td>
              <td className="num">{hours(f.predictedMinutes)}</td>
              <td className="num">{minutesText(r.minutes || null)}</td>
              <td className="num">
                {f.minutesError === null ? BLANK : (f.minutesError > 0 ? "+" : "") + f.minutesError + " min"}
              </td>
            </tr>
            <tr>
              <td>Per hour</td>
              <td className="num">{f.predictedHourly === null ? BLANK : money(f.predictedHourly)}</td>
              <td className="num">{r.realisedHourly === null ? BLANK : money(r.realisedHourly)}</td>
              <td />
            </tr>
            <tr>
              <td>Cash out (receipts and expenses)</td>
              <td className="num">{money(f.predictedCashRequired)}</td>
              <td className="num">{money(f.cashSpent)}</td>
              <td />
            </tr>
            <tr>
              <td>Units</td>
              <td className="num">{f.predictedUnits}</td>
              <td className="num">
                {r.unitsBought} bought, {r.unitsSold} sold
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <p className="muted">
        Predicted proceeds were {money(f.predictedProceeds)}
        {f.basis === "sample" ? ", from sample figures" : ""}. Predictions are never counted as
        realised cash.
        {f.payoutBy && " Payout was expected by " + longDate(f.payoutBy) + "."}
        {f.payoutLateDays !== null && " The last payout came " + plural(f.payoutLateDays, "day") + " later than that."}
      </p>
    </div>
  );
}

function EntriesTable({
  entries,
  proofs,
  proofed,
  onRemove,
}: {
  entries: Entry[];
  proofs: Proof[];
  // Receipt and payout ids whose proof counts; null when nothing is verified (household, legacy).
  proofed: number[] | null;
  onRemove?: (entry: Entry) => void;
}) {
  if (!entries.length) return <p className="muted">No entries yet.</p>;
  const proofCount = (id: number) => proofs.filter((p) => p.entry_id === id).length;
  const proofBadge = (e: Entry) => {
    const attached = proofCount(e.id) > 0;
    if (!proofed || (e.type !== "receipt" && e.type !== "payout"))
      return attached ? <span className="badge ok">Proof</span> : null;
    if (proofed.includes(e.id)) return <span className="badge ok">Proof</span>;
    return attached ? (
      <span className="badge warn">Proof not counted</span>
    ) : (
      <span className="badge warn">Needs proof</span>
    );
  };
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Entry</th>
            <th className="num">Amount</th>
            <th className="num">Units</th>
            <th>Reference and note</th>
            {onRemove && <th />}
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td>{longDate(e.occurred)}</td>
              <td>
                {TYPE_LABEL[e.type]}
                <span className="ledger-sub">{proofBadge(e)}</span>
              </td>
              <td className="num">{e.type === "work" ? hours(e.minutes || 0) : money(e.amount)}</td>
              <td className="num">{e.units ?? ""}</td>
              <td>
                {e.reference}
                {e.note && <span className="muted ledger-sub">{e.note}</span>}
              </td>
              {onRemove && (
                <td>
                  <button type="button" className="ledger-remove" onClick={() => onRemove(e)}>
                    Remove
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EntryForm({ trip, onSaved }: { trip: Trip; onSaved: () => void }) {
  const types = ENTRY_TYPES[trip.kind];
  const [type, setType] = useState<EntryType>(types[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const unitsRequired = trip.kind === "resale" && ["receipt", "sale", "refund"].includes(type);
  const unitsOptional =
    (trip.kind === "resale" && type === "payout") ||
    (trip.kind === "household" && ["receipt", "saving"].includes(type));

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const value = (name: string) => String(f.get(name) ?? "").trim();
    const body: Record<string, unknown> = {
      type,
      occurred: value("occurred"),
      reference: value("reference") || undefined,
      note: value("note") || undefined,
    };
    if (type === "work") body.minutes = Math.round(Number(value("minutes")));
    else {
      const pounds = Number(value("amount"));
      if (!Number.isFinite(pounds) || pounds <= 0) return setError("Enter an amount in pounds above zero.");
      body.amount = toPence(pounds);
    }
    if ((unitsRequired || unitsOptional) && value("units")) body.units = Math.round(Number(value("units")));
    setBusy(true);
    setError("");
    try {
      await api("ledger/trips/" + trip.id + "/entries", body);
      form.reset();
      setType(types[0]);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset>
      <legend>Add an entry</legend>
      <form className="ledger-form" onSubmit={submit}>
        <label>
          Entry
          <select value={type} onChange={(e) => setType(e.target.value as EntryType)}>
            {types.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        {type === "work" ? (
          <label>
            Minutes
            <input name="minutes" type="number" min={1} max={10080} step={1} required />
          </label>
        ) : (
          <label>
            Amount (£)
            <input name="amount" type="number" min={0.01} step={0.01} required inputMode="decimal" />
          </label>
        )}
        {(unitsRequired || unitsOptional) && (
          <label>
            {type === "payout" ? "Units this payout covers (optional)" : unitsRequired ? "Units" : "Units (optional)"}
            <input name="units" type="number" min={1} max={10000} step={1} required={unitsRequired} />
          </label>
        )}
        <label>
          Date
          <input name="occurred" type="date" max={today()} defaultValue={today()} required />
        </label>
        <label>
          Reference (optional)
          <input name="reference" maxLength={120} placeholder="Receipt number or listing id" />
        </label>
        <label className="ledger-form-wide">
          Note (optional, private)
          <input name="note" maxLength={500} />
        </label>
        <p className="muted ledger-form-wide">
          {trip.kind === "household" && type === "receipt"
            ? "What you paid at the till. Reference: the receipt number."
            : TYPE_HINT[type]}
        </p>
        <button disabled={busy}>Save entry</button>
        {error && <p role="alert">{error}</p>}
      </form>
    </fieldset>
  );
}

/** Reads a file as base64 without the data URL prefix. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      comma > 0 ? resolve(result.slice(comma + 1)) : reject(Error("The file could not be read"));
    };
    reader.onerror = () => reject(Error("The file could not be read"));
    reader.readAsDataURL(file);
  });
}

/**
 * The entry a new proof most likely supports: the newest receipt or payout
 * still without a counting proof, then the newest receipt or payout, then the
 * newest entry. "" (whole trip) only when the trip has no entries.
 */
function suggestedEntry(entries: Entry[], proofed: number[]): string {
  const newest = (list: Entry[]) => (list.length ? list.reduce((a, b) => (b.id > a.id ? b : a)) : null);
  const verifiable = entries.filter((e) => e.type === "receipt" || e.type === "payout");
  const pick =
    newest(verifiable.filter((e) => !proofed.includes(e.id))) ?? newest(verifiable) ?? newest(entries);
  return pick ? String(pick.id) : "";
}

const WHOLE_TRIP = "Whole trip (does not count towards verification)";

function Proofs({
  trip,
  entries,
  proofs,
  proofed,
  onSaved,
}: {
  trip: Trip;
  entries: Entry[];
  proofs: Proof[];
  proofed: number[];
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Errors from moving or removing a stored proof, shown next to the list.
  const [listError, setListError] = useState("");
  const [notice, setNotice] = useState("");
  // null until the member picks an entry themselves; the suggestion follows
  // new entries until then.
  const [choice, setChoice] = useState<string | null>(null);
  const resale = trip.kind === "resale";
  const entryName = useMemo(() => {
    const names = new Map<number, string>();
    for (const e of entries)
      names.set(
        e.id,
        TYPE_LABEL[e.type] +
          ", " +
          longDate(e.occurred) +
          (e.type === "work" ? "" : ", " + money(e.amount)) +
          (e.reference ? " (" + e.reference + ")" : ""),
      );
    return names;
  }, [entries]);
  const typeOf = useMemo(() => new Map(entries.map((e) => [e.id, e.type])), [entries]);
  const valid = (value: string | null) =>
    value !== null && (value === "" || entries.some((e) => String(e.id) === value));
  const supports = valid(choice) ? (choice as string) : suggestedEntry(entries, proofed);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const file = f.get("file");
    if (!(file instanceof File) || !file.size) return setError("Choose a file.");
    if (!PROOF_TYPES.includes(file.type)) return setError("Proofs must be JPEG or PNG photos, or PDF documents.");
    if (file.size > MAX_PROOF_BYTES) return setError("Proof files must be 5 MB or smaller.");
    setBusy(true);
    setError("");
    setListError("");
    setNotice("");
    try {
      await api("ledger/trips/" + trip.id + "/proofs", {
        label: String(f.get("label") || "").trim() || file.name.slice(0, 120),
        mediaType: file.type,
        data: await readBase64(file),
        entryId: supports ? Number(supports) : undefined,
      });
      form.reset();
      setChoice(null);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function relink(proof: Proof, value: string) {
    setError("");
    setListError("");
    setNotice("");
    try {
      await api("ledger/trips/" + trip.id + "/proofs/" + proof.id, { entryId: value ? Number(value) : null }, "PATCH");
      setNotice('"' + proof.label + '" now supports ' + (value ? entryName.get(Number(value)) : "the whole trip") + ".");
      onSaved();
    } catch (err) {
      setListError('"' + proof.label + '" was not moved. ' + (err as Error).message);
    }
  }

  async function remove(proof: Proof) {
    if (!window.confirm('Remove the proof "' + proof.label + '"? The stored file is deleted unless another proof uses the same file.'))
      return;
    setError("");
    setListError("");
    setNotice("");
    try {
      const result = await api<{ removed: { file: string } }>("ledger/trips/" + trip.id + "/proofs/" + proof.id, {}, "DELETE");
      const file = result.removed.file;
      setNotice(
        '"' + proof.label + '" removed. ' +
          (file === "in use"
            ? "The stored file is kept because another proof uses the same file."
            : file === "error"
              ? "The stored file could not be deleted from this computer. Check the API log."
              : "The stored file was deleted from this computer."),
      );
      onSaved();
    } catch (err) {
      setListError((err as Error).message);
    }
  }

  /** Whether a stored proof counts towards verification, in words. */
  const standing = (p: Proof) => {
    if (!resale) return null;
    if (p.entry_id === null) return <span className="warn">Does not count towards verification</span>;
    const type = typeOf.get(p.entry_id);
    if (type !== "receipt" && type !== "payout")
      return <span className="muted">Kept as evidence. Only receipt and payout proofs count towards verification.</span>;
    return proofed.includes(p.entry_id) ? (
      <span className="ok">Counts towards verification</span>
    ) : (
      <span className="warn">Does not count: the same file is also attached to another receipt or payout, on this trip or another</span>
    );
  };

  return (
    <fieldset>
      <legend>Private proofs</legend>
      <p className="muted">
        Proofs stay on this computer. Bounty stores them in its private data folder, readable only by
        your user account, and never shows or sends their contents: only the label, type, size and a
        fingerprint (SHA-256 hash) appear here. Photos (JPEG or PNG) have their location and camera
        data removed before they are stored. PDF documents are stored unchanged, so their document
        properties, such as author and creation date, are kept.
      </p>
      {proofs.length > 0 && (
        <ul className="ledger-proofs">
          {proofs.map((p) => (
            <li key={p.id}>
              <div className="ledger-proof-file">
                <b>{p.label}</b>
                <span className="muted">
                  {p.media_type === "application/pdf" ? "PDF" : p.media_type === "image/png" ? "PNG" : "JPEG"},{" "}
                  {size(p.bytes)}, {p.metadataRemoved ? "location data removed" : "document properties kept"}.
                  Fingerprint <code title={p.sha256}>{p.sha256.slice(0, 12)}…</code>
                </span>
              </div>
              <label className="ledger-proof-link">
                Supports
                <select value={p.entry_id === null ? "" : String(p.entry_id)} onChange={(e) => relink(p, e.target.value)}>
                  {entries.map((e) => (
                    <option key={e.id} value={e.id}>
                      {entryName.get(e.id)}
                    </option>
                  ))}
                  <option value="">{WHOLE_TRIP}</option>
                </select>
                {standing(p)}
              </label>
              <button type="button" className="ledger-remove" onClick={() => remove(p)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {listError && <p role="alert">{listError}</p>}
      {notice && <p role="status">{notice}</p>}
      <form className="ledger-form" onSubmit={submit}>
        <label>
          File (JPEG, PNG or PDF, up to 5 MB)
          <input name="file" type="file" accept="image/jpeg,image/png,application/pdf" required />
        </label>
        <label>
          Supports
          <select name="entryId" value={supports} onChange={(e) => setChoice(e.target.value)}>
            {entries.map((e) => (
              <option key={e.id} value={e.id}>
                {entryName.get(e.id)}
              </option>
            ))}
            <option value="">{WHOLE_TRIP}</option>
          </select>
        </label>
        <label>
          Label (optional)
          <input name="label" maxLength={120} placeholder="Till receipt" />
        </label>
        {resale && (
          <p className={"ledger-form-wide " + (supports === "" ? "warn" : "muted")}>
            {supports !== ""
              ? "Attach each document to the entry it records. Only proofs on the purchase receipt and payout entries count towards verification, one file per entry. A file that is already the proof for another entry, on any trip, is refused. Whole-trip proofs do not count."
              : entries.length
                ? "A whole-trip proof is kept with the trip but does not count towards verification. Choose the purchase receipt or payout entry this document records."
                : "A whole-trip proof is kept with the trip but does not count towards verification. Add the purchase receipt or payout entry first, then attach its document to that entry."}
          </p>
        )}
        <button disabled={busy}>{busy ? "Storing" : "Store proof"}</button>
        {error && <p role="alert">{error}</p>}
      </form>
    </fieldset>
  );
}

function metricsLeftOut(left: Metrics["forecast"]["leftOut"] | undefined) {
  if (!left) return "";
  const parts = [
    left.sample && plural(left.sample, "trip") + " with a sample prediction",
    left.basisUnknown && plural(left.basisUnknown, "trip") + " whose evidence is unknown",
    left.notTaken && plural(left.notTaken, "trip") + " closed with nothing recorded",
  ].filter(Boolean);
  return parts.length ? " Left out of the prediction measures: " + parts.join(", ") + "." : "";
}

function MetricsPanel({ version }: { version: number }) {
  const [data, setData] = useState<Metrics | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<Metrics>("ledger/metrics")
      .then((m) => {
        if (!active) return;
        setData(m);
        setError("");
      })
      .catch((e: Error) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [version]);
  if (error) return <article><p role="alert">{error}</p></article>;
  if (!data) return null;
  const f = data.forecast;
  const c = data.cash;
  return (
    <article>
      <h2>Prediction accuracy</h2>
      <p className="muted">
        Closed resale trips only: {data.closedTrips} closed, {data.verifiedTrips} of them verified.
        {data.legacyTrips > 0 && ` Legacy totals (${data.legacyTrips}) are left out because they cannot be reconciled.`}{" "}
        Differences are realised minus predicted, so a negative figure means a trip did worse than
        predicted. Only predictions from live evidence on trips that were taken are measured.
        {metricsLeftOut(f.leftOut)}
      </p>
      {data.closedTrips === 0 ? (
        <p className="muted">Close a trip to start measuring.</p>
      ) : (
        <dl className="ledger-figures">
          <dt>Trips with a measured prediction</dt>
          <dd>{f.trips}</dd>
          <dt>Average contribution error (size)</dt>
          <dd>{f.meanAbsoluteContributionError === null ? BLANK : money(f.meanAbsoluteContributionError)}</dd>
          <dt>Average contribution error (direction)</dt>
          <dd>{signed(f.meanContributionError)}</dd>
          <dt>Average time error</dt>
          <dd>
            {f.meanMinutesError === null
              ? BLANK
              : (f.meanMinutesError > 0 ? "+" : "") + f.meanMinutesError + " min (size " + f.meanAbsoluteMinutesError + " min)"}
          </dd>
          <dt>Cash recovered (payouts over money spent)</dt>
          <dd>
            {c.recoveryRate === null ? BLANK : percent(c.recoveryRate)} ({money(c.payouts)} of {money(c.spend)})
          </dd>
          <dt>Verified share of payouts</dt>
          <dd>{c.payouts > 0 ? percent(c.verifiedPayouts / c.payouts) + " (" + money(c.verifiedPayouts) + ")" : BLANK}</dd>
          <dt>Median time to payout</dt>
          <dd>
            {data.medianTimeToPayoutDays === null
              ? BLANK
              : data.medianTimeToPayoutDays.toLocaleString("en-GB") + " days over " + plural(data.payoutTrips, "trip")}
          </dd>
          <dt>Units left unsold at close</dt>
          <dd>{data.unsoldUnits}</dd>
          <dt>Realised per hour</dt>
          <dd>
            {data.hourly.realised === null ? BLANK : money(data.hourly.realised)} over {plural(data.hourly.trips, "trip")} with work time
          </dd>
          <dt>Realised against predicted per hour</dt>
          <dd>
            {data.hourly.comparison.trips === 0
              ? BLANK
              : `${money(data.hourly.comparison.realised)} against ${money(data.hourly.comparison.predicted)} on ${plural(data.hourly.comparison.trips, "trip")}`}
          </dd>
        </dl>
      )}
    </article>
  );
}
