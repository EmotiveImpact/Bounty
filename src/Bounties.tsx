import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, dateTime, money } from "./api";
import "./Bounties.css";

// Shapes returned by server/routes-bounties.mjs. Money is integer pence.
type Tier = { id: string; name: string; offsetMinutes: number; earnPoints: number | null };
type Terms = {
  buyAndResell: string;
  reputation: string;
  claim: string;
  photo: string;
  paid: string;
  privacy: string;
  billing: string;
  alerts: string;
  verified: string;
};
type Member = {
  id: number;
  name: string;
  locality: string | null;
  alertsOptIn: boolean;
  alertLocalities: string[];
  created: string;
  paid: { label: string; tier: Tier | null; until: string | null; current: boolean; note: string };
  earned: { label: string; points: number; tier: Tier; next: (Tier & { pointsNeeded: number }) | null };
  release: { tier: Tier; via: "paid" | "earned"; offsetMinutes: number };
};
type MembersResponse = {
  members: Member[];
  tiers: Tier[];
  paidTierIds: string[];
  reputation: { accurateReport: number; rewardedReportsPerBountyPerDay: number };
  terms: Terms;
};
type Photo = { label: string; sha256: string; bytes: number; mediaType: string };
type Report = {
  id: number;
  mine: boolean;
  memberId?: number;
  memberName?: string;
  unitsSeen: number;
  observedAt: string;
  note?: string | null;
  photo?: Photo | null;
  verified: "accurate" | "inaccurate" | null;
  verifiedAt?: string | null;
  points?: number;
};
type Claim = {
  id: number;
  memberId: number;
  memberName: string;
  units: number;
  status: "active" | "released" | "expired" | "completed";
  created: string;
  expiresAt: string;
  endedAt: string | null;
};
type Check = { id: string; ok: boolean; detail: string };
type Opportunity = {
  tier: string | null;
  reasons: string[];
  unitProfit?: number | null;
  returnOnCost?: number | null;
  targetPrice?: number | null;
  meetsThresholds?: boolean;
  trialUnits?: number;
};
type Economics = {
  units: number;
  unitCost: number;
  salePrice: number;
  contribution: number;
  unitContribution: number;
  cashRequired: number;
  hourly: number | null;
  activeMinutes: number;
  unsoldLoss: number;
  breakEvenSale: number | null;
};
type Bounty = {
  id: number;
  title: string;
  barcode: string | null;
  variant: string | null;
  retailer: string;
  locality: string;
  sample: boolean;
  sponsored: boolean;
  sponsor: string | null;
  placement: string | null;
  status: "open" | "expired" | "withdrawn";
  created: string;
  expiresAt: string;
  cap: number;
  capBasis: { notes?: string[]; used?: { availableUnits: number; salesPerWeek: number | null } } | null;
  claimedUnits: number;
  completedUnits: number;
  remaining: number;
  alert: {
    eligible: boolean;
    reasons: string[];
    checkedAt: string | null;
    canSend: boolean;
    blockers: string[];
    sent: number;
    exposureLimit: number;
  };
  claimBlockers: string[];
  maxClaimUnits: number;
  opportunity: Opportunity | null;
  pressure: {
    sourcing: {
      activeClaimedUnits: number;
      recentPositiveReports: number;
      availableUnits: number;
      ratio: number | null;
    };
    resale: {
      competingListings: number | null;
      competingSellers: number | null;
      salesPerWeek: number | null;
      weeksOfSupply: number | null;
      note: string | null;
    };
  };
  shelf: { state: "unknown" | "seen" | "none"; paused: boolean; at: string | null; unitsSeen: number | null };
  reports: { total: number; positive: number; negative: number; latestAt: string | null; items: Report[] };
  claims: Claim[];
  estimate: {
    checkedAt: string;
    offer: { provider?: string; sourceId?: string; title?: string; observed?: string | null; source?: string } | null;
    unitCost: number | null;
    sample: { count?: number; independent?: number; lowerMedian?: number | null; daysToSell?: number | null } | null;
    economics: Economics | null;
    checks: Check[];
    warnings: string[];
  } | null;
  viewer: {
    memberId: number;
    release: { tier: Tier; via: "paid" | "earned"; points: number; releaseAt: string; open: boolean };
    alertedAt: string | null;
    activeClaim: Claim | null;
    canClaim: boolean;
  } | null;
  terms: Terms;
};
type BountiesResponse = { bounties: Bounty[]; terms: Terms; rules: { maxClaimUnits: number; maxDays: number } };
type Dispatch = {
  sent: { memberId: number; name: string; tier: Tier; label: string; reputation: number }[];
  notAlerted: { memberId: number; name: string; reason: string }[];
  blockers: string[];
  exposure: { cap: number; remaining: number; limit: number; alreadySent: number; budget: number };
  nextReleaseAt: string | null;
};
type MemberAlert = {
  id: number;
  bountyId: number;
  title: string;
  retailer: string;
  locality: string;
  sponsored: boolean;
  sponsor: string | null;
  created: string;
  tier: Tier | null;
  label: string;
  bountyStatus: string;
};
// Written by the Research tab's "Draft a bounty" button.
type Draft = { estimate: unknown; title?: string; retailer?: string | null; locality?: string };

const DRAFT_KEY = "bounty-draft";
const ACTING_KEY = "bounty-acting-as";
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

const cash = (pence: number | null | undefined) =>
  pence === null || pence === undefined || !Number.isFinite(pence) ? "unknown" : money(pence);
const when = (value: string | null | undefined) => (value ? dateTime(value) + " UTC" : "unknown");
const minutes = (m: number) =>
  m === 0 ? "at once" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the choice lasts for this visit only */
  }
}
function readDraft(): Draft | null {
  try {
    const value = JSON.parse(readStorage(DRAFT_KEY) || "null");
    return value && typeof value === "object" && value.estimate && typeof value.estimate === "object" ? value : null;
  } catch {
    return null;
  }
}
// datetime-local value in the viewer's time zone, some hours from now.
function localInput(hoursAhead: number) {
  const d = new Date(Date.now() + hoursAhead * 3600000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const toIso = (local: string) => (local ? new Date(local).toISOString() : "");

function tierBadge(tier: string | null) {
  if (!tier) return null;
  const tone = tier.startsWith("Priority") ? "ok" : "warn";
  return <span className={"badge " + tone}>{tier}</span>;
}

/** Paid and earned status, always as two separate badges. */
function StatusBadges({ member }: { member: Member }) {
  return (
    <span className="member-badges">
      {member.paid.tier ? (
        <span className={"badge paid" + (member.paid.current ? "" : " lapsed")}>
          Paid early access: {member.paid.tier.name}
          {member.paid.until ? (member.paid.current ? ` to ${member.paid.until}` : " (ended)") : ""}
        </span>
      ) : (
        <span className="badge">No paid early access</span>
      )}
      <span className="badge earned">
        Earned: {member.earned.tier.name}, {plural(member.earned.points, "point")}
      </span>
    </span>
  );
}

function Message({ text, error }: { text: string; error?: boolean }) {
  if (!text) return null;
  return error ? <p role="alert">{text}</p> : <p className="notice">{text}</p>;
}

function MemberForm({
  tiers,
  paidTierIds,
  member,
  onSaved,
}: {
  tiers: Tier[];
  paidTierIds: string[];
  member: Member | null;
  onSaved: (m: Member) => void;
}) {
  const [name, setName] = useState(member?.name ?? "");
  const [locality, setLocality] = useState(member?.locality ?? "London");
  const [optIn, setOptIn] = useState(member?.alertsOptIn ?? false);
  const [places, setPlaces] = useState((member?.alertLocalities ?? []).join(", "));
  const [paidTier, setPaidTier] = useState(member?.paid.tier?.id ?? "");
  const [paidUntil, setPaidUntil] = useState(member?.paid.until ?? "");
  const [message, setMessage] = useState({ text: "", error: false });
  async function save(e: FormEvent) {
    e.preventDefault();
    setMessage({ text: "", error: false });
    const body = {
      name: name.trim(),
      locality: locality.trim() || null,
      alertsOptIn: optIn,
      alertLocalities: places
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
      paidTier: paidTier || null,
      paidUntil: paidTier && paidUntil ? paidUntil : null,
    };
    try {
      const res = member
        ? await api<{ member: Member }>("members/" + member.id, body, "PATCH")
        : await api<{ member: Member }>("members", body);
      setMessage({ text: member ? "Saved." : "Member added.", error: false });
      if (!member) {
        setName("");
        setPlaces("");
      }
      onSaved(res.member);
    } catch (err) {
      setMessage({ text: (err as Error).message, error: true });
    }
  }
  return (
    <form className="member-form" onSubmit={save}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
      </label>
      <label>
        Home locality
        <input value={locality} onChange={(e) => setLocality(e.target.value)} maxLength={120} />
      </label>
      <label className="inline">
        <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} />
        Send me bounty alerts (off unless you opt in)
      </label>
      <label>
        Alert localities, separated by commas
        <input value={places} onChange={(e) => setPlaces(e.target.value)} placeholder="Camden, Islington" />
      </label>
      <fieldset>
        <legend>Paid early access (recorded by the operator)</legend>
        <label>
          Paid tier
          <select value={paidTier} onChange={(e) => setPaidTier(e.target.value)}>
            <option value="">None</option>
            {tiers
              .filter((t) => paidTierIds.includes(t.id))
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}: alerts {minutes(t.offsetMinutes)} after a bounty opens
                </option>
              ))}
          </select>
        </label>
        <label>
          Paid until (inclusive, UTC)
          <input type="date" value={paidUntil} disabled={!paidTier} onChange={(e) => setPaidUntil(e.target.value)} />
        </label>
        <small className="muted">
          Paying changes only when alerts and claims open for you. It never adds reputation points.
        </small>
      </fieldset>
      <button type="submit">{member ? "Save member" : "Add member"}</button>
      <Message text={message.text} error={message.error} />
    </form>
  );
}

function MemberSummary({ member }: { member: Member }) {
  return (
    <div className="member-summary">
      <b>{member.name}</b>
      <StatusBadges member={member} />
      <dl className="facts">
        <dt>Paid status</dt>
        <dd>
          {member.paid.tier
            ? `${member.paid.tier.name}${member.paid.until ? `, paid until ${member.paid.until}` : ", no end date recorded"}${member.paid.current ? "" : " (not current)"}`
            : "None"}
        </dd>
        <dt>Earned status</dt>
        <dd>
          {member.earned.tier.name} from {plural(member.earned.points, "earned point")}
          {member.earned.next
            ? `. ${plural(member.earned.next.pointsNeeded, "more point")} unlocks ${member.earned.next.name}.`
            : "."}
        </dd>
        <dt>Your release window</dt>
        <dd>
          {minutes(member.release.offsetMinutes)} after a bounty opens ({member.release.tier.name}, via{" "}
          {member.release.via === "paid" ? "paid early access" : "earned reputation"})
        </dd>
        <dt>Alerts</dt>
        <dd>
          {member.alertsOptIn
            ? member.alertLocalities.length
              ? "On for " + member.alertLocalities.join(", ")
              : "On, but no alert localities listed, so none will arrive"
            : "Off"}
        </dd>
      </dl>
    </div>
  );
}

function TierTable({ tiers, points }: { tiers: Tier[]; points: number }) {
  return (
    <details>
      <summary>Early access tiers</summary>
      <p className="muted">
        A member can pay for a tier or earn it with reputation; the earlier of the two decides when alerts and claims
        open. Tier names, windows and point levels are provisional settings. An accurate stock report earns{" "}
        {plural(points, "point")}, whether the shelf had stock or was empty.
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Tier</th>
              <th>Alerts and claims open</th>
              <th className="num">Earned at</th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>{minutes(t.offsetMinutes)} after a bounty opens</td>
                <td className="num">{t.earnPoints === null ? "paid only" : plural(t.earnPoints, "point")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function CreateBounty({ onCreated }: { onCreated: () => void }) {
  const [draft, setDraft] = useState<Draft | null>(() => readDraft());
  const [sample, setSample] = useState(() => !readDraft());
  const [title, setTitle] = useState(draft?.title ?? "");
  const [retailer, setRetailer] = useState(draft?.retailer ?? "");
  const [locality, setLocality] = useState(draft?.locality || "London");
  const [availableUnits, setAvailableUnits] = useState("6");
  const [salesPerWeek, setSalesPerWeek] = useState("2");
  const [sellWindowWeeks, setSellWindowWeeks] = useState("2");
  const [expiresAt, setExpiresAt] = useState(() => localInput(72));
  const [sponsored, setSponsored] = useState(false);
  const [sponsor, setSponsor] = useState("");
  const [competingListings, setCompetingListings] = useState("2");
  const [competingSellers, setCompetingSellers] = useState("2");
  const [message, setMessage] = useState({ text: "", error: false });

  function switchToSample() {
    setSample(true);
    setTitle((t) => t || "Sample: travel kettle 0.5 litre");
    setRetailer((r) => r || "Sample retailer");
  }
  function discardDraft() {
    writeStorage(DRAFT_KEY, null);
    setDraft(null);
    switchToSample();
  }
  async function create(e: FormEvent) {
    e.preventDefault();
    setMessage({ text: "", error: false });
    const body: Record<string, unknown> = {
      title: title.trim(),
      retailer: retailer.trim(),
      locality: locality.trim(),
      availableUnits: Number(availableUnits),
      salesPerWeek: Number(salesPerWeek),
      sellWindowWeeks: Number(sellWindowWeeks),
      expiresAt: toIso(expiresAt),
      sponsored,
      sponsor: sponsored ? sponsor.trim() : null,
    };
    if (sample) {
      body.sample = true;
      body.competingListings = Number(competingListings);
      body.competingSellers = Number(competingSellers);
    } else body.estimate = draft?.estimate;
    try {
      const res = await api<{ message: string }>("bounties", body);
      if (!sample) {
        writeStorage(DRAFT_KEY, null);
        setDraft(null);
      }
      setMessage({ text: res.message, error: false });
      onCreated();
    } catch (err) {
      setMessage({ text: (err as Error).message, error: true });
    }
  }
  const request = draft?.estimate as { offer?: { provider?: string; sourceId?: string }; units?: number } | undefined;
  return (
    <form className="create-bounty" onSubmit={create}>
      {draft && !sample ? (
        <p className="notice">
          Draft from the Research tab: offer {request?.offer?.provider ?? "unknown"} {request?.offer?.sourceId ?? ""}
          {request?.units ? `, ${plural(request.units, "unit")} in the estimate` : ""}. The server re-runs the estimate
          when you create the bounty, and again before every claim and alert.{" "}
          <button type="button" onClick={discardDraft}>
            Discard draft
          </button>
        </p>
      ) : (
        <p className="notice">
          <span className="badge sample">Sample</span>
          {draft
            ? "Creating a sample bounty. Switch back to use the Research draft."
            : "No Research draft found. To share a real opportunity, check it in the Research tab and press \"Draft a bounty\". Until then you can create a clearly labelled sample bounty, which can never send an alert."}
          {draft && (
            <button type="button" onClick={() => setSample(false)}>
              Use the Research draft
            </button>
          )}
        </p>
      )}
      <div className="form-grid">
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </label>
        <label>
          Retailer
          <input value={retailer} onChange={(e) => setRetailer(e.target.value)} required maxLength={120} />
        </label>
        <label>
          Locality
          <input value={locality} onChange={(e) => setLocality(e.target.value)} required maxLength={120} />
        </label>
        <label>
          Units on the shelf
          <input type="number" min={1} step={1} value={availableUnits} onChange={(e) => setAvailableUnits(e.target.value)} required />
        </label>
        <label>
          Completed sales a week (your estimate)
          <input type="number" min={0.01} step={0.01} value={salesPerWeek} onChange={(e) => setSalesPerWeek(e.target.value)} required />
        </label>
        <label>
          Weeks to sell
          <input type="number" min={0.5} max={12} step={0.5} value={sellWindowWeeks} onChange={(e) => setSellWindowWeeks(e.target.value)} required />
        </label>
        <label>
          Expires (at most 14 days ahead)
          <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} required />
        </label>
        {sample && (
          <>
            <label>
              Competing listings (sample figure)
              <input type="number" min={0} step={1} value={competingListings} onChange={(e) => setCompetingListings(e.target.value)} required />
            </label>
            <label>
              Competing sellers (sample figure)
              <input type="number" min={0} step={1} value={competingSellers} onChange={(e) => setCompetingSellers(e.target.value)} required />
            </label>
          </>
        )}
      </div>
      <label className="inline">
        <input type="checkbox" checked={sponsored} onChange={(e) => setSponsored(e.target.checked)} />
        Sponsored placement (shown as "Sponsored by" on every view)
      </label>
      {sponsored && (
        <label>
          Sponsor name
          <input value={sponsor} onChange={(e) => setSponsor(e.target.value)} required maxLength={120} />
        </label>
      )}
      <p className="muted">
        The cap is the smaller of the units on the shelf and the sales expected in the selling window less competing
        listings. For a real bounty, competing listings come from the estimate, and your units and sales figures can only
        be lowered by the evidence (the latest stock check and the confirmed sales rate).
      </p>
      <button type="submit">{sample ? "Create sample bounty" : "Create bounty"}</button>
      <Message text={message.text} error={message.error} />
    </form>
  );
}

function ReportForm({ bounty, memberId, onDone }: { bounty: Bounty; memberId: number; onDone: (m: string) => void }) {
  const [seen, setSeen] = useState(true);
  const [units, setUnits] = useState("1");
  const [observed, setObserved] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (file && !["image/jpeg", "image/png"].includes(file.type)) return setError("The photo must be a JPEG or PNG.");
    if (file && file.size > MAX_PHOTO_BYTES) return setError("The photo must be 5 MB or smaller.");
    setBusy(true);
    try {
      const photo = file
        ? {
            mediaType: file.type,
            data: await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
              reader.onerror = () => reject(Error("The photo could not be read"));
              reader.readAsDataURL(file);
            }),
          }
        : undefined;
      const res = await api<{ message: string }>(`bounties/${bounty.id}/reports`, {
        memberId,
        unitsSeen: seen ? Number(units) : 0,
        observedAt: observed ? toIso(observed) : undefined,
        note: note.trim() || undefined,
        photo,
      });
      setNote("");
      setFile(null);
      onDone(res.message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="report-form" onSubmit={submit}>
      <fieldset>
        <legend>Stock report</legend>
        <label className="inline">
          <input type="radio" checked={seen} onChange={() => setSeen(true)} /> Stock seen
        </label>
        {seen && (
          <label>
            Units seen
            <input type="number" min={1} step={1} value={units} onChange={(e) => setUnits(e.target.value)} required />
          </label>
        )}
        <label className="inline">
          <input type="radio" checked={!seen} onChange={() => setSeen(false)} /> None on the shelf
        </label>
        <label>
          When you looked (leave blank for now; within 48 hours)
          <input type="datetime-local" value={observed} onChange={(e) => setObserved(e.target.value)} />
        </label>
        <label>
          Private note (only you and the operator see it)
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </label>
        <label>
          Shelf photo, optional (JPEG or PNG, up to 5 MB)
          <input type="file" accept="image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <small className="muted">{bounty.terms.photo}</small>
        <small className="muted">
          Accurate reports earn reputation points once the operator verifies them, and an empty shelf counts as much as
          stock.
        </small>
        <button type="submit" disabled={busy}>
          {busy ? "Saving" : "Save report"}
        </button>
        {error && <p role="alert">{error}</p>}
      </fieldset>
    </form>
  );
}

function ClaimPanel({ bounty, memberId, onDone }: { bounty: Bounty; memberId: number; onDone: (m: string, err?: boolean) => void }) {
  const [units, setUnits] = useState("1");
  const [bought, setBought] = useState("");
  const v = bounty.viewer;
  if (!v) return null;
  const run = async (fn: () => Promise<{ message: string }>) => {
    try {
      onDone((await fn()).message);
    } catch (err) {
      onDone((err as Error).message, true);
    }
  };
  const max = Math.max(1, Math.min(bounty.maxClaimUnits, bounty.remaining));
  return (
    <div className="claim-panel">
      <p className="muted">
        {v.release.open
          ? `Open to you since ${when(v.release.releaseAt)}`
          : `Opens for you at ${when(v.release.releaseAt)}`}{" "}
        ({v.release.tier.name}, via {v.release.via === "paid" ? "paid early access" : "earned reputation"})
        {v.alertedAt ? `. You were alerted at ${when(v.alertedAt)}.` : "."}
      </p>
      {v.activeClaim ? (
        <div className="row">
          <span>
            Your claim: {plural(v.activeClaim.units, "unit")} until {when(v.activeClaim.expiresAt)}
          </span>
          <span className="actions">
            <button type="button" onClick={() => run(() => api(`claims/${v.activeClaim!.id}/release`, { memberId }))}>
              Release
            </button>
            <input
              aria-label="Units bought"
              type="number"
              min={1}
              max={v.activeClaim.units}
              placeholder={String(v.activeClaim.units)}
              value={bought}
              onChange={(e) => setBought(e.target.value)}
            />
            <button
              type="button"
              onClick={() =>
                run(() => api(`claims/${v.activeClaim!.id}/complete`, { memberId, units: bought ? Number(bought) : undefined }))
              }
            >
              I bought them
            </button>
          </span>
        </div>
      ) : v.canClaim ? (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => api(`bounties/${bounty.id}/claims`, { memberId, units: Number(units) }));
          }}
        >
          <label>
            Units to claim (a trial batch of up to {bounty.maxClaimUnits})
            <select value={units} onChange={(e) => setUnits(e.target.value)}>
              {Array.from({ length: max }, (_, i) => String(i + 1)).map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <button type="submit">Claim</button>
        </form>
      ) : (
        <ul className="checks">
          {(bounty.claimBlockers.length
            ? bounty.claimBlockers
            : [
                !v.release.open
                  ? "Your release window has not opened yet"
                  : bounty.cap === 0
                    ? "The distribution cap is 0: the evidence leaves no units to share"
                    : "The distribution cap is fully claimed",
              ]
          ).map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <small className="muted">{bounty.terms.claim}</small>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function BountyCard({
  bounty,
  acting,
  onChanged,
}: {
  bounty: Bounty;
  acting: "operator" | "public" | number;
  onChanged: () => void;
}) {
  const [message, setMessage] = useState({ text: "", error: false });
  const [dispatch, setDispatch] = useState<Dispatch | null>(null);
  const done = (text: string, error = false) => {
    setMessage({ text, error });
    onChanged();
  };
  const call = async (fn: () => Promise<{ message?: string }>, fallback: string) => {
    try {
      done((await fn()).message || fallback);
    } catch (err) {
      setMessage({ text: (err as Error).message, error: true });
    }
  };
  const { sourcing, resale } = bounty.pressure;
  const e = bounty.estimate?.economics ?? null;
  const o = bounty.opportunity;
  const isOperator = acting === "operator";
  return (
    <article className={"bounty" + (bounty.status === "open" ? "" : " closed")}>
      <div className="bounty-head">
        <h3>{bounty.title}</h3>
        <div>
          {bounty.sample && <span className="badge sample">Sample</span>}
          {bounty.placement && <span className="badge sponsored">{bounty.placement}</span>}
          {tierBadge(o?.tier ?? null)}
          <span className={"badge " + (bounty.status === "open" ? "ok" : "warn")}>{bounty.status}</span>
          <span className={"badge " + (bounty.alert.canSend ? "ok" : "warn")}>
            {bounty.alert.canSend ? "Alerts can be sent" : "No alerts"}
          </span>
        </div>
      </div>
      <p className="terms">{bounty.terms.buyAndResell}</p>
      <dl className="facts">
        <Fact label="Retailer and locality">
          {bounty.retailer}, {bounty.locality}
        </Fact>
        {bounty.barcode && <Fact label="Barcode">{bounty.barcode + (bounty.variant ? `, ${bounty.variant}` : "")}</Fact>}
        <Fact label="Expires">{when(bounty.expiresAt)}</Fact>
        <Fact label="Distribution cap">{plural(bounty.cap, "unit")}</Fact>
        <Fact label="Claimed now">{plural(bounty.claimedUnits, "unit")}</Fact>
        <Fact label="Bought by members">{plural(bounty.completedUnits, "unit")}</Fact>
        <Fact label="Remaining under the cap">{plural(bounty.remaining, "unit")}</Fact>
        <Fact label="Shelf">
          {bounty.shelf.state === "unknown"
            ? "No stock reports yet"
            : bounty.shelf.state === "seen"
              ? `${plural(bounty.shelf.unitsSeen ?? 0, "unit")} seen at ${when(bounty.shelf.at)}`
              : `None on the shelf at ${when(bounty.shelf.at)}: claims and alerts paused`}
        </Fact>
      </dl>
      {bounty.capBasis?.notes?.length ? (
        <ul className="muted cap-notes">
          {bounty.capBasis.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}

      <div className="pressure">
        <div>
          <small>SOURCING PRESSURE</small>
          <b>{sourcing.ratio === null ? "unknown" : sourcing.ratio.toLocaleString("en-GB")}</b>
          <span className="muted">
            People heading to the shelf per unit: {plural(sourcing.activeClaimedUnits, "claimed unit")} and{" "}
            {plural(sourcing.recentPositiveReports, "stock sighting")} in 24 hours, for{" "}
            {plural(sourcing.availableUnits, "unit")} on the shelf.
          </span>
        </div>
        <div>
          <small>RESALE COMPETITION</small>
          <b>
            {resale.weeksOfSupply === null
              ? "unknown"
              : `${resale.weeksOfSupply.toLocaleString("en-GB")} ${resale.weeksOfSupply === 1 ? "week" : "weeks"} of supply`}
          </b>
          <span className="muted">
            {resale.competingListings === null
              ? "Competing listings unknown."
              : `${plural(resale.competingListings, "competing listing")}${resale.competingSellers === null ? "" : ` from ${plural(resale.competingSellers, "seller")}`}`}
            {resale.salesPerWeek === null ? ", sales rate unknown." : `, against ${resale.salesPerWeek.toLocaleString("en-GB")} sales a week.`}
            {resale.note ? " " + resale.note : ""}
          </span>
        </div>
      </div>

      {o && o.tier && (
        <div className="opportunity">
          <b>Opportunity tier: {o.tier}</b>
          <ul className="muted">
            {o.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {o.targetPrice ? <span className="muted">Would qualify at a purchase price of {cash(o.targetPrice)} or less.</span> : null}
        </div>
      )}

      {e && (
        <details>
          <summary>Estimate for {plural(e.units, "unit")} (checked {when(bounty.estimate?.checkedAt)})</summary>
          <dl className="facts">
            <Fact label="Cash required before payout">{cash(e.cashRequired)}</Fact>
            <Fact label="Purchase price per unit">{cash(e.unitCost)}</Fact>
            <Fact label="Sale estimate per unit (lower median of confirmed sales)">{cash(e.salePrice)}</Fact>
            <Fact label="Contribution after all costs">{cash(e.contribution)}</Fact>
            <Fact label="Profit per unit">{cash(o?.unitProfit ?? e.unitContribution)}</Fact>
            <Fact label="Return on purchase price">
              {o?.returnOnCost === null || o?.returnOnCost === undefined ? "unknown" : `${Math.round(o.returnOnCost * 100)}%`}
            </Fact>
            <Fact label="Earnings per active hour">{cash(e.hourly)}</Fact>
            <Fact label="Loss if nothing sells">{cash(e.unsoldLoss)}</Fact>
            <Fact label="Break-even sale price">{cash(e.breakEvenSale)}</Fact>
            <Fact label="Confirmed sales used">
              {bounty.estimate?.sample?.count ?? 0}, from {bounty.estimate?.sample?.independent ?? 0} independent sellers
            </Fact>
          </dl>
          <small className="muted">
            Estimates, not realised cash. Your own costs and timing may differ: run your figures in the Research tab.
          </small>
        </details>
      )}

      <details open={!bounty.alert.canSend && bounty.status === "open"}>
        <summary>
          Alert checks {bounty.alert.checkedAt ? `(as of ${when(bounty.alert.checkedAt)})` : ""}
        </summary>
        {bounty.estimate?.checks?.length ? (
          <ul className="checks">
            {bounty.estimate.checks.map((c) => (
              <li key={c.id} className={c.ok ? "pass" : undefined}>
                {c.detail}
              </li>
            ))}
          </ul>
        ) : null}
        {bounty.alert.blockers.length ? (
          <ul className="checks">
            {bounty.alert.blockers.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : (
          <p className="ok">Every check passes and the cap has room.</p>
        )}
        <small className="muted">
          {plural(bounty.alert.sent, "alert")} sent. Exposure limit now: {plural(bounty.alert.exposureLimit, "alert")} in
          total (two per unit left under the cap).
        </small>
      </details>

      <details>
        <summary>
          Stock reports: {bounty.reports.positive} with stock, {bounty.reports.negative} with none
        </summary>
        {bounty.reports.items.length ? (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Looked at (UTC)</th>
                  <th>Seen</th>
                  {isOperator && <th>Member</th>}
                  <th>Note and photo</th>
                  <th>Verified</th>
                </tr>
              </thead>
              <tbody>
                {bounty.reports.items.map((r) => (
                  <tr key={r.id}>
                    <td>{dateTime(r.observedAt)}</td>
                    <td>{r.unitsSeen === 0 ? "None" : plural(r.unitsSeen, "unit")}</td>
                    {isOperator && <td>{r.memberName}</td>}
                    <td>
                      {r.note === undefined ? (
                        <span className="muted">Private</span>
                      ) : (
                        <>
                          {r.note || <span className="muted">No note</span>}
                          {r.photo && (
                            <small className="muted">
                              {r.photo.label}: {r.photo.mediaType}, {Math.ceil(r.photo.bytes / 1024)} KB, SHA-256{" "}
                              {r.photo.sha256.slice(0, 12)}. Kept on this computer only.
                            </small>
                          )}
                        </>
                      )}
                    </td>
                    <td>
                      {r.verified ? (
                        <span className={r.verified === "accurate" ? "ok" : "warn"}>
                          {r.verified}
                          {r.points ? `, ${plural(r.points, "point")}` : ""}
                        </span>
                      ) : isOperator ? (
                        <span className="actions">
                          <button type="button" onClick={() => call(() => api(`reports/${r.id}/verify`, { accurate: true }), "Verified")}>
                            Accurate
                          </button>
                          <button type="button" onClick={() => call(() => api(`reports/${r.id}/verify`, { accurate: false }), "Verified")}>
                            Inaccurate
                          </button>
                        </span>
                      ) : (
                        <span className="muted">Not yet</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No reports yet.</p>
        )}
        {acting !== "operator" && acting !== "public" && bounty.status === "open" && (
          <ReportForm bounty={bounty} memberId={acting} onDone={(m) => done(m)} />
        )}
      </details>

      {typeof acting === "number" && bounty.status === "open" && <ClaimPanel bounty={bounty} memberId={acting} onDone={done} />}

      {isOperator && (
        <div className="operator">
          {bounty.claims.length > 0 && (
            <details>
              <summary>Claims ({bounty.claims.length})</summary>
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th className="num">Units</th>
                      <th>Status</th>
                      <th>Lapses (UTC)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bounty.claims.map((c) => (
                      <tr key={c.id}>
                        <td>{c.memberName}</td>
                        <td className="num">{c.units}</td>
                        <td>{c.status}</td>
                        <td>{c.status === "active" ? dateTime(c.expiresAt) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          {bounty.status === "open" && (
            <div className="actions">
              <button
                type="button"
                onClick={async () => {
                  try {
                    const res = await api<Dispatch>(`bounties/${bounty.id}/alerts`, {});
                    setDispatch(res);
                    done(
                      res.sent.length
                        ? `Alerted ${plural(res.sent.length, "member")}.`
                        : res.blockers.length
                          ? "No alerts sent."
                          : "No members due an alert right now.",
                    );
                  } catch (err) {
                    setMessage({ text: (err as Error).message, error: true });
                  }
                }}
              >
                Send due alerts
              </button>
              <button type="button" onClick={() => call(() => api(`bounties/${bounty.id}/withdraw`, {}), "Withdrawn")}>
                Withdraw
              </button>
            </div>
          )}
          {dispatch && (
            <div className="dispatch">
              {dispatch.blockers.length > 0 && (
                <ul className="checks">
                  {dispatch.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              )}
              {dispatch.sent.length > 0 && (
                <ul className="checks">
                  {dispatch.sent.map((s) => (
                    <li key={s.memberId} className="pass">
                      {s.name}: {s.tier.name} ({s.label}), {plural(s.reputation, "earned point")}
                    </li>
                  ))}
                </ul>
              )}
              {dispatch.notAlerted.length > 0 && (
                <ul className="muted">
                  {dispatch.notAlerted.map((n) => (
                    <li key={n.memberId}>
                      {n.name}: {n.reason}
                    </li>
                  ))}
                </ul>
              )}
              <small className="muted">
                Exposure: {dispatch.exposure.alreadySent} of {dispatch.exposure.limit} alerts used.
                {dispatch.nextReleaseAt ? ` Next window opens at ${when(dispatch.nextReleaseAt)}: send again then.` : ""}
              </small>
            </div>
          )}
        </div>
      )}
      <Message text={message.text} error={message.error} />
    </article>
  );
}

function AlertInbox({ memberId, refresh }: { memberId: number; refresh: number }) {
  const [alerts, setAlerts] = useState<MemberAlert[] | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    api<{ alerts: MemberAlert[]; notice: string }>(`members/${memberId}/alerts`)
      .then((r) => {
        setAlerts(r.alerts);
        setNotice(r.notice);
      })
      .catch(() => setAlerts([]));
  }, [memberId, refresh]);
  if (!alerts) return null;
  return (
    <div>
      <h3>Your alerts</h3>
      {alerts.length ? (
        <ul className="alert-list">
          {alerts.map((a) => (
            <li key={a.id}>
              <b>{a.title}</b> at {a.retailer}, {a.locality}
              {a.sponsored && <span className="badge sponsored">Sponsored by {a.sponsor}</span>}
              <small className="muted">
                {when(a.created)}, {a.label}
                {a.tier ? ` (${a.tier.name})` : ""}, bounty {a.bountyStatus}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No alerts yet.</p>
      )}
      <small className="muted">{notice}</small>
    </div>
  );
}

export default function Bounties() {
  const [data, setData] = useState<MembersResponse | null>(null);
  const [bounties, setBounties] = useState<Bounty[] | null>(null);
  const [terms, setTerms] = useState<Terms | null>(null);
  const [acting, setActing] = useState<"operator" | "public" | number>(() => {
    const saved = readStorage(ACTING_KEY);
    return saved === "public" ? "public" : saved && /^\d+$/.test(saved) ? Number(saved) : "operator";
  });
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [showCreate, setShowCreate] = useState(() => Boolean(readDraft()));
  const [showNewMember, setShowNewMember] = useState(false);

  const viewer = acting === "public" ? "" : String(acting);
  const load = useCallback(() => {
    setError("");
    api<MembersResponse>("members")
      .then((d) => {
        setData(d);
        setTerms(d.terms);
      })
      .catch((e: Error) => setError(e.message));
    api<BountiesResponse>("bounties" + (viewer ? "?viewer=" + encodeURIComponent(viewer) : ""))
      .then((d) => {
        setBounties(d.bounties);
        setTerms(d.terms);
      })
      .catch((e: Error) => {
        // A remembered member who no longer exists falls back to the operator.
        if (typeof acting === "number") choose("operator");
        setError(e.message);
      });
    setRefresh((r) => r + 1);
  }, [viewer]);
  useEffect(load, [load]);

  function choose(value: "operator" | "public" | number) {
    setActing(value);
    writeStorage(ACTING_KEY, String(value));
  }
  const me = typeof acting === "number" ? data?.members.find((m) => m.id === acting) ?? null : null;

  return (
    <section className="bounties">
      {terms && (
        <>
          <p className="notice">{terms.privacy}</p>
          <div className="terms-box">
            <b>{terms.buyAndResell}</b>
            <span>{terms.reputation}</span>
            <span>{terms.paid}</span>
          </div>
        </>
      )}
      {error && <p role="alert">{error}</p>}

      <div className="acting">
        <label>
          Acting as
          <select
            value={String(acting)}
            onChange={(e) => {
              const v = e.target.value;
              choose(v === "operator" || v === "public" ? v : Number(v));
            }}
          >
            <option value="operator">Operator view (sees every note and claim)</option>
            <option value="public">Visitor (counts and dates only)</option>
            {data?.members.map((m) => (
              <option key={m.id} value={String(m.id)}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => setShowNewMember((s) => !s)}>
          {showNewMember ? "Close" : "Add a member"}
        </button>
        {acting === "operator" && (
          <button type="button" onClick={() => setShowCreate((s) => !s)}>
            {showCreate ? "Close" : "Create a bounty"}
          </button>
        )}
      </div>

      {data && showNewMember && (
        <article>
          <h3>New member</h3>
          <MemberForm
            tiers={data.tiers}
            paidTierIds={data.paidTierIds}
            member={null}
            onSaved={(m) => {
              setShowNewMember(false);
              choose(m.id);
            }}
          />
        </article>
      )}

      {data && me && (
        <div className="grid2 member-area">
          <article>
            <MemberSummary member={me} />
            <details>
              <summary>Edit profile, alerts and paid tier</summary>
              <MemberForm key={me.id} tiers={data.tiers} paidTierIds={data.paidTierIds} member={me} onSaved={() => load()} />
            </details>
          </article>
          <article>
            <AlertInbox memberId={me.id} refresh={refresh} />
          </article>
        </div>
      )}
      {data && <TierTable tiers={data.tiers} points={data.reputation.accurateReport} />}

      {acting === "operator" && showCreate && (
        <article>
          <h3>Create a bounty</h3>
          <CreateBounty
            onCreated={() => {
              load();
            }}
          />
        </article>
      )}

      <h2>Bounties</h2>
      {acting !== "operator" && typeof acting !== "number" && (
        <p className="muted">Choose a member under "Acting as" to claim or report, or the operator view to verify and send alerts.</p>
      )}
      {bounties === null ? (
        <p className="muted">Loading.</p>
      ) : bounties.length === 0 ? (
        <p className="muted">No bounties yet.</p>
      ) : (
        bounties.map((b) => <BountyCard key={b.id + ":" + viewer} bounty={b} acting={acting} onChanged={load} />)
      )}
    </section>
  );
}
