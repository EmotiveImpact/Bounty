import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, dateTime, loadMemberRules, money, toPence, type MemberRules, type RuleKey } from "./api";
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
  sample: string;
  promotion: string;
  stop: string;
  hidden: string;
  times: string;
};
type Member = {
  id: number;
  name: string;
  locality: string | null;
  alertsOptIn: boolean;
  alertLocalities: string[];
  created: string;
  // until is the form value; untilLabel the UK date for people.
  paid: { label: string; tier: Tier | null; until: string | null; untilLabel?: string | null; current: boolean; note: string };
  earned: { label: string; points: number; tier: Tier; next: (Tier & { pointsNeeded: number }) | null };
  release: { tier: Tier; via: "paid" | "earned"; offsetMinutes: number };
  rules: MemberRules;
  effectiveRules: Record<RuleKey, number>;
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
  promotionConfirmed?: boolean;
  paused?: boolean;
  // The member's own journey and the figures the claim was checked on.
  journeyCost?: number | null;
  journeyMinutes?: number | null;
  figures?: OwnFigures | null;
};
type OwnFigures = {
  units: number;
  unitCost: number | null;
  salePrice: number | null;
  contribution: number | null;
  unitProfit: number | null;
  returnOnCost: number | null;
  hourly: number | null;
  cashRequired: number | null;
  activeMinutes: number | null;
  tier: string | null;
};
type TripCheck = { ok: boolean; units: number; journey: { cost: number; minutes: number }; figures: OwnFigures | null; reasons: string[] };
type Check = { id: string; ok: boolean; detail: string };
// kind "stop" ("Don't make the trip") or "reopen"; superseded marks a stop
// notice a later reopen replaced.
type Notice = {
  id: number;
  bountyId: number;
  kind: string;
  reason: string;
  message: string;
  created: string;
  superseded?: boolean;
};
type TripState = {
  state: "go" | "full" | "paused" | "out-of-stock" | "stock-unconfirmed" | "blocked" | "sample" | "expired" | "withdrawn";
  go: boolean;
  label: string;
  headline: string | null;
};
type Eligibility = {
  condition: string;
  firstOrder: boolean;
  retailer: string;
  answer: "qualifies" | "not" | "used" | null;
  usedHere: boolean;
  confirmed: boolean;
  question: string;
};
type AccessNeed = { id: string; label: string; detail: string };
type Category = {
  applied: string | null;
  chosen: string | null;
  suggested: string | null;
  reason: string | null;
  warning: string | null;
};
type AttributeNote = { key: string; by: "operator" | "assumed"; text: string };
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
  retailer: string | null;
  locality: string;
  sample: boolean;
  sponsored: boolean;
  sponsor: string | null;
  placement: string | null;
  status: "open" | "expired" | "withdrawn";
  trip: TripState;
  created: string;
  expiresAt: string;
  cap: number;
  capBasis: { notes?: string[]; used?: { availableUnits: number | null; salesPerWeek: number | null } } | null;
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
    questions?: number;
    exposureLimit: number;
  };
  // What the figures are for: the units one member can claim, with the
  // operator's journey. hidden while a promotion price is not confirmed.
  figures?: {
    units: number | null;
    claimable: number | null;
    journey: { whose: string; cost: number | null; minutes: number | null; known: boolean } | null;
    label: string | null;
    hidden: boolean;
    note: string | null;
  } | null;
  category?: Category | null;
  attributes?: AttributeNote[];
  checked?: { price: string | null; priceLabel: string | null; stock: string | null; stockLabel: string | null };
  mainUncertainty?: string | null;
  accessNeeds?: AccessNeed[];
  claimBlockers: string[];
  maxClaimUnits: number;
  opportunity: Opportunity | null;
  pressure: {
    sourcing: {
      activeClaimedUnits: number;
      recentPositiveReports: number;
      availableUnits: number | null;
      ratio: number | null;
      unitsSource: "stock check" | "stock report" | "sample" | null;
      unitsAt: string | null;
      boughtSince: number;
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
  display: { permitted: boolean; basis: string; hidden: boolean; label: string | null };
  validation: { locality: string; complete: boolean; audited: number; target: number; warning: string | null } | null;
  promotion: {
    condition: string;
    price: number | null;
    regularPrice: number | null;
    costedAt: "promotion" | "regular";
    needsMemberConfirmation: boolean;
    firstOrder?: boolean;
    note: string | null;
  } | null;
  reports: { total: number; positive: number; negative: number; latestAt: string | null; items: Report[] };
  claims: Claim[];
  estimate: {
    checkedAt: string;
    offer: {
      provider?: string;
      sourceId?: string;
      title?: string;
      observed?: string | null;
      source?: string;
      promotion?: string | null;
    } | null;
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
    blockers: string[];
    ruleFailures: string[];
    trial: { limit: number; held: number; allowance: number; proven: boolean };
    maxClaimUnits: number;
    promotion: { condition: string; confirmed: boolean; risk: string | null } | null;
    eligibility?: Eligibility | null;
    askedAt?: string | null;
    stop: string | null;
    notices: Notice[];
  } | null;
  terms: Terms;
};
type BountiesResponse = { bounties: Bounty[]; terms: Terms; rules: { maxClaimUnits: number; maxDays: number } };
type Dispatch = {
  sent: { memberId: number; name: string; tier: Tier; label: string; reputation: number }[];
  asked?: { memberId: number; name: string; condition: string | null }[];
  notAlerted: { memberId: number; name: string; reason: string }[];
  blockers: string[];
  exposure: { cap: number; remaining: number; limit: number; alreadySent: number; budget: number };
  nextReleaseAt: string | null;
  promotion?: { condition: string } | null;
  warning?: string | null;
};
type MemberAlert = {
  id: number;
  bountyId: number;
  // "question": the price is a promotion the member has not said they
  // qualify for, so there are no figures yet.
  kind?: "alert" | "question";
  eligibility?: Eligibility | null;
  questionNote?: string | null;
  figures?: { label: string | null; units: number | null; unitProfit: number | null; contribution: number | null; cashRequired: number | null } | null;
  category?: Category | null;
  attributes?: AttributeNote[];
  accessNeeds?: AccessNeed[];
  title: string;
  retailer: string | null;
  locality: string;
  sponsored: boolean;
  sponsor: string | null;
  created: string;
  tier: Tier | null;
  label: string;
  bountyStatus: string;
  trip: TripState;
  promotion: { condition: string; note: string } | null;
  warning: string | null;
  notices: Notice[];
};
// Written by the Research tab's "Draft a bounty" button.
type Draft = { estimate: unknown; title?: string; retailer?: string | null; locality?: string };

const DRAFT_KEY = "bounty-draft";
const ACTING_KEY = "bounty-acting-as";
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

const cash = (pence: number | null | undefined) =>
  pence === null || pence === undefined || !Number.isFinite(pence) ? "unknown" : money(pence);
// Times for people, in UK time: "31 Oct 2026, 14:05".
const LONDON = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const when = (value: string | null | undefined) => {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? LONDON.format(new Date(ms)) : "unknown";
};
// A share as a percentage to one decimal place, rounded down, as Research shows it.
const percentDown = (share: number) =>
  (Math.floor(share * 1000 + 1e-9) / 10).toLocaleString("en-GB", { maximumFractionDigits: 1 }) + "%";
const minutes = (m: number) =>
  m === 0 ? "at once" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
// Server text as a sentence with one full stop at the end.
const sentence = (text: string) => text.replace(/[.\s]+$/, "") + ".";

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
          {member.paid.until ? (member.paid.current ? ` to ${member.paid.untilLabel ?? dateTime(member.paid.until)}` : " (ended)") : ""}
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

// The thresholds a member can tighten, shown in pounds, percent, kg and units.
const RULE_FIELDS: { key: RuleKey; label: string; unit: "pounds" | "percent" | "kg" | "units"; agreed: string }[] = [
  { key: "minUnitProfit", label: "Lowest profit per unit (£)", unit: "pounds", agreed: "£5.00" },
  { key: "minReturn", label: "Lowest return on purchase price (%)", unit: "percent", agreed: "35%" },
  { key: "minUnitPrice", label: "Lowest purchase price per unit (£)", unit: "pounds", agreed: "£5.00" },
  { key: "maxUnitPrice", label: "Highest purchase price per unit (£)", unit: "pounds", agreed: "£50.00" },
  { key: "maxWeightKg", label: "Weight limit per unit (kg)", unit: "kg", agreed: "under 2 kg" },
  { key: "trialUnits", label: "Trial batch (units)", unit: "units", agreed: "3 units" },
];
type RuleText = Partial<Record<RuleKey, string>>;
function rulesToText(rules: MemberRules): RuleText {
  const out: RuleText = {};
  for (const f of RULE_FIELDS) {
    const v = rules[f.key];
    if (typeof v !== "number") continue;
    out[f.key] = f.unit === "pounds" ? (v / 100).toFixed(2) : f.unit === "percent" ? String(Math.round(v * 1000) / 10) : String(v);
  }
  return out;
}
function textToRules(text: RuleText): MemberRules {
  const out: MemberRules = {};
  for (const f of RULE_FIELDS) {
    const raw = (text[f.key] ?? "").trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    out[f.key] = f.unit === "pounds" ? toPence(n) : f.unit === "percent" ? Math.round(n * 10) / 1000 : f.unit === "units" ? Math.round(n) : n;
  }
  return out;
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
  const [rules, setRules] = useState<RuleText>(() => rulesToText(member?.rules ?? {}));
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
      rules: textToRules(rules),
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
          Last paid day (lasts to midnight UK time)
          <input type="date" value={paidUntil} disabled={!paidTier} onChange={(e) => setPaidUntil(e.target.value)} />
        </label>
        <small className="muted">
          Paying changes only when alerts and claims open for you. It never adds reputation points.
        </small>
      </fieldset>
      <fieldset>
        <legend>Your stricter buying thresholds (optional)</legend>
        <small className="muted">
          You can tighten the agreed thresholds for yourself but never loosen them. A bounty that fails yours is not
          alerted to you and you cannot claim it. Leave a field blank to use the agreed figure.
        </small>
        <div className="form-grid">
          {RULE_FIELDS.map((f) => (
            <label key={f.key}>
              {f.label}
              <input
                type="number"
                min={0}
                step={f.unit === "units" ? 1 : 0.01}
                value={rules[f.key] ?? ""}
                placeholder={"Agreed: " + f.agreed}
                onChange={(e) => setRules((r) => ({ ...r, [f.key]: e.target.value }))}
              />
            </label>
          ))}
        </div>
        <button type="button" onClick={() => setRules(rulesToText(loadMemberRules()))}>
          Use the thresholds saved in this browser (Planner and Research)
        </button>
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
            ? `${member.paid.tier.name}${member.paid.until ? `, paid to the end of ${member.paid.untilLabel ?? dateTime(member.paid.until)} (UK time)` : ", no end date recorded"}${member.paid.current ? "" : " (not current)"}`
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
        <dt>Your stricter thresholds</dt>
        <dd>
          {Object.keys(member.rules ?? {}).length
            ? RULE_FIELDS.filter((f) => typeof member.rules[f.key] === "number")
                .map((f) => {
                  const v = member.rules[f.key] as number;
                  const shown =
                    f.unit === "pounds" ? money(v) : f.unit === "percent" ? percentDown(v) : f.unit === "kg" ? `under ${v} kg` : plural(v, "unit");
                  return `${f.label.replace(/ \((£|%|kg|units)\)$/, "")}: ${shown}`;
                })
                .join("; ")
            : "None: the agreed thresholds apply"}
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
  // No default count: for a real bounty the count comes from the stock check.
  const [availableUnits, setAvailableUnits] = useState(() => (readDraft() ? "" : "6"));
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
    setAvailableUnits((u) => u || "6");
  }
  // After a draft is used, the form starts again as a sample so the notice,
  // the button and the fields agree.
  function resetToSample() {
    setTitle("Sample: travel kettle 0.5 litre");
    setRetailer("Sample retailer");
    setLocality("London");
    setAvailableUnits("6");
    setSponsored(false);
    setSponsor("");
    setSample(true);
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
      availableUnits: availableUnits.trim() ? Number(availableUnits) : null,
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
        resetToSample();
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
            : "No Research draft found. To share a real opportunity, check it in the Research tab and press \"Draft a bounty\". Until then you can create a clearly labelled sample bounty with illustrative figures: it can never send an alert and nobody can claim it."}
          {draft && (
            <button
              type="button"
              onClick={() => {
                setSample(false);
                setTitle(draft.title ?? "");
                setRetailer(draft.retailer ?? "");
                setLocality(draft.locality || "London");
                setAvailableUnits("");
              }}
            >
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
        {sample ? (
          <label>
            Units on the shelf (sample figure)
            <input type="number" min={1} step={1} value={availableUnits} onChange={(e) => setAvailableUnits(e.target.value)} required />
          </label>
        ) : (
          <label>
            Most units to share (optional)
            <input
              type="number"
              min={1}
              step={1}
              value={availableUnits}
              placeholder="The stock check's count"
              onChange={(e) => setAvailableUnits(e.target.value)}
            />
          </label>
        )}
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
        listings. For a real bounty, units on the shelf come from the stock check's count and competing listings from the
        estimate; your figures can only lower them. With no unit count on the check, or no asking-price lookup on record
        when no listings were found, the cap is 0.
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
          {bounty.sample
            ? "This is a sample bounty: reports here are practice and earn no reputation points."
            : "Accurate reports earn reputation points once the operator verifies them, and an empty shelf counts as much as stock. A report of none on the shelf tells everyone alerted or holding a claim not to make the trip."}
        </small>
        <button type="submit" disabled={busy}>
          {busy ? "Saving" : "Save report"}
        </button>
        {error && <p role="alert">{error}</p>}
      </fieldset>
    </form>
  );
}

/**
 * "Don't make the trip" and reopen notices. A stop notice a later reopen
 * replaced is kept for the record but folded away, so the list never leads
 * with a stop that no longer applies.
 */
function NoticeList({ notices }: { notices: Notice[] }) {
  if (!notices.length) return null;
  const current = notices.filter((n) => !n.superseded);
  const old = notices.length - current.length;
  return (
    <>
      {current.length > 0 && (
        <ul className="stop-notices">
          {current.map((n) => (
            <li key={n.id} className={n.kind === "reopen" ? "reopen" : undefined}>
              <b>{n.message}</b>
              <small className="muted">Sent {when(n.created)}</small>
            </li>
          ))}
        </ul>
      )}
      {old > 0 && (
        <small className="muted">
          {old === 1 ? "1 earlier notice no longer applies" : `${old} earlier notices no longer apply`}: the bounty reopened after it.
        </small>
      )}
    </>
  );
}

/** Access needs as badges, with the detail for screen readers and on hover. */
function AccessList({ needs }: { needs: AccessNeed[] | undefined }) {
  if (!needs?.length) return null;
  return (
    <span className="access-needs">
      {needs.map((n) => (
        <span key={n.id} className={"badge access" + (n.id === "widely-accessible" ? " open" : "")} title={n.detail}>
          {n.label}
          <span className="sr-only">: {n.detail}</span>
        </span>
      ))}
    </span>
  );
}

/** The category whose rules the figures use, and any warning about it. */
function CategoryLine({ category }: { category: Category | null | undefined }) {
  if (!category?.applied) return null;
  return (
    <p className={category.warning ? "notice category-warning" : "muted category"}>
      {category.warning
        ? `Category: ${category.applied}. ${sentence(category.warning)}`
        : `Costed under the ${category.applied.toLowerCase()} rules.`}
    </p>
  );
}

/**
 * The promotion question for a member: whether they qualify for the price
 * the figures use. A first-order or new-customer offer can also be answered
 * "already used at this retailer", which stops such offers there.
 */
function EligibilityQuestion({
  bountyId,
  memberId,
  eligibility,
  onDone,
}: {
  bountyId: number;
  memberId: number;
  eligibility: Eligibility;
  onDone: (m: string, err?: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const answer = async (value: "qualifies" | "not" | "used") => {
    setBusy(true);
    try {
      const res = await api<{ message: string }>(`bounties/${bountyId}/eligibility`, { memberId, answer: value });
      onDone(res.message);
    } catch (err) {
      onDone((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const said =
    eligibility.usedHere
      ? `You said you have already used a first-order offer at ${eligibility.retailer}.`
      : eligibility.answer === "qualifies"
        ? "You said you qualify."
        : eligibility.answer === "not"
          ? "You said you do not qualify."
          : null;
  return (
    <div className="eligibility">
      <p>{eligibility.question}</p>
      {said && <small className="muted">{said} You can change your answer.</small>}
      <span className="actions">
        <button type="button" disabled={busy} onClick={() => answer("qualifies")}>
          Yes, I qualify
        </button>
        <button type="button" disabled={busy} onClick={() => answer("not")}>
          No
        </button>
        {eligibility.firstOrder && (
          <button type="button" disabled={busy} onClick={() => answer("used")}>
            I have already used one at {eligibility.retailer}
          </button>
        )}
      </span>
      <small className="muted">The figures are shown once you say you qualify. Nothing is claimed by answering.</small>
    </div>
  );
}

/** A member's own figures for a trip, in plain words. */
function OwnFiguresText({ check }: { check: TripCheck }) {
  const f = check.figures;
  return (
    <div className={check.ok ? "own-figures ok" : "own-figures warn"} role="status">
      <b>
        {check.ok ? "Your figures pass every check" : "Your figures fail"} for {plural(check.units, "unit")} with your journey (
        {cash(check.journey.cost)}, {plural(check.journey.minutes, "minute")})
      </b>
      {f && (
        <span>
          Profit per unit {cash(f.unitProfit)}
          {f.returnOnCost === null ? "" : `, return ${percentDown(f.returnOnCost)}`}
          {f.hourly === null ? "" : `, ${cash(f.hourly)} an active hour`}, cash needed before payout {cash(f.cashRequired)}.
        </span>
      )}
      {!check.ok && (
        <ul className="checks">
          {check.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ClaimPanel({ bounty, memberId, onDone }: { bounty: Bounty; memberId: number; onDone: (m: string, err?: boolean) => void }) {
  const [units, setUnits] = useState("1");
  const [bought, setBought] = useState("");
  const [qualifies, setQualifies] = useState(false);
  const [fare, setFare] = useState("");
  const [travel, setTravel] = useState("");
  const [own, setOwn] = useState<TripCheck | null>(null);
  const [formError, setFormError] = useState("");
  const v = bounty.viewer;
  if (!v) return null;
  if (bounty.sample)
    return (
      <div className="claim-panel">
        <p className="muted">{bounty.terms.sample}</p>
      </div>
    );
  const run = async (fn: () => Promise<{ message: string }>) => {
    try {
      onDone((await fn()).message);
    } catch (err) {
      onDone((err as Error).message, true);
    }
  };
  // The member's own return journey: both figures are required, and a blank
  // is never counted as zero.
  const journey = () => {
    const cost = fare.trim() === "" ? NaN : Number(fare);
    const mins = travel.trim() === "" ? NaN : Number(travel);
    if (!Number.isFinite(cost) || cost < 0 || !Number.isInteger(mins) || mins < 0) {
      setFormError(
        "Enter your own return journey cost in pounds and time in minutes. A blank is never counted as zero: enter 0 only if the trip really costs nothing, for example walking.",
      );
      return null;
    }
    setFormError("");
    return { journeyCost: toPence(cost), journeyMinutes: mins };
  };
  const max = Math.max(1, v.maxClaimUnits);
  // While the shelf is reported empty (or the last branch check found none)
  // nobody should set off, but a member who bought before that can still
  // record the purchase.
  const emptyShelf = bounty.trip.state === "paused" || bounty.trip.state === "out-of-stock";
  const eligibility = v.eligibility ?? null;
  const confirmed = Boolean(eligibility?.confirmed || v.promotion?.confirmed);
  const reasons = [
    ...bounty.claimBlockers,
    ...v.blockers,
    ...(bounty.claimBlockers.length || v.blockers.length
      ? []
      : [
          bounty.remaining <= 0
            ? bounty.cap === 0
              ? "The distribution cap is 0: the evidence leaves no units to share"
              : "The distribution cap is fully claimed"
            : v.trial.allowance === 0
              ? "You have reached the trial batch for this item"
              : "Claims are not open to you right now",
        ]),
  ];
  return (
    <div className="claim-panel">
      {v.stop && (v.activeClaim || v.alertedAt) && (
        <p className="stop" role="alert">
          {v.stop}
        </p>
      )}
      <NoticeList notices={v.notices} />
      <p className="muted">
        {v.release.open
          ? `Open to you since ${when(v.release.releaseAt)}`
          : `Opens for you at ${when(v.release.releaseAt)}`}{" "}
        ({v.release.tier.name}, via {v.release.via === "paid" ? "paid early access" : "earned reputation"})
        {v.alertedAt ? `. You were alerted at ${when(v.alertedAt)}.` : v.askedAt ? `. You were asked about the price at ${when(v.askedAt)}.` : "."}
      </p>
      {eligibility && !v.activeClaim && !eligibility.confirmed && (
        <EligibilityQuestion bountyId={bounty.id} memberId={memberId} eligibility={eligibility} onDone={onDone} />
      )}
      {v.activeClaim ? (
        <div className="row">
          <span>
            Your claim: {plural(v.activeClaim.units, "unit")} until {when(v.activeClaim.expiresAt)}
            {v.activeClaim.paused ? " (" + bounty.trip.label.toLowerCase() + ")" : ""}
            {v.activeClaim.promotionConfirmed && bounty.promotion ? `. You confirmed you qualify for: ${bounty.promotion.condition}.` : ""}
            {v.activeClaim.figures && v.activeClaim.journeyCost !== null && v.activeClaim.journeyCost !== undefined
              ? `. Checked on your journey (${cash(v.activeClaim.journeyCost)}, ${plural(v.activeClaim.journeyMinutes ?? 0, "minute")}): profit per unit ${cash(v.activeClaim.figures.unitProfit)}.`
              : ""}
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
          {emptyShelf && (
            <small className="muted">
              Only if you bought before the shelf was reported empty. Do not set off for this bounty now.
            </small>
          )}
        </div>
      ) : v.canClaim && !(eligibility && !eligibility.confirmed) ? (
        <form
          className="claim-form"
          onSubmit={(e) => {
            e.preventDefault();
            const trip = journey();
            if (!trip) return;
            run(() =>
              api(`bounties/${bounty.id}/claims`, {
                memberId,
                units: Number(units),
                ...trip,
                qualifiesForPromotion: v.promotion ? qualifies || confirmed : undefined,
              }),
            );
          }}
        >
          <label>
            Units to claim (your trial batch: up to {plural(max, "unit")} now)
            <select
              value={units}
              onChange={(e) => {
                setUnits(e.target.value);
                setOwn(null);
              }}
            >
              {Array.from({ length: max }, (_, i) => String(i + 1)).map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <div className="form-grid">
            <label>
              Your return journey cost (£)
              <input
                type="number"
                min={0}
                step={0.01}
                inputMode="decimal"
                value={fare}
                onChange={(e) => {
                  setFare(e.target.value);
                  setOwn(null);
                }}
                required
              />
            </label>
            <label>
              Your journey time there and back (minutes)
              <input
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                value={travel}
                onChange={(e) => {
                  setTravel(e.target.value);
                  setOwn(null);
                }}
                required
              />
            </label>
          </div>
          <small className="muted">
            The card's figures use the operator's journey. Your claim is checked again at the units you claim with your own
            journey and thresholds, and refused if it fails.
          </small>
          {v.promotion && !confirmed && (
            <div className="promotion">
              <label className="inline">
                <input type="checkbox" checked={qualifies} onChange={(e) => setQualifies(e.target.checked)} required />
                I qualify for this price myself: {v.promotion.condition}
              </label>
              {v.promotion.risk && <small className="muted">{v.promotion.risk}</small>}
            </div>
          )}
          {formError && <p role="alert">{formError}</p>}
          {own && <OwnFiguresText check={own} />}
          <span className="actions">
            <button
              type="button"
              onClick={async () => {
                const trip = journey();
                if (!trip) return;
                try {
                  const res = await api<{ check: TripCheck }>(`bounties/${bounty.id}/claim-check`, {
                    memberId,
                    units: Number(units),
                    ...trip,
                  });
                  setOwn(res.check);
                } catch (err) {
                  setFormError((err as Error).message);
                }
              }}
            >
              Check my figures
            </button>
            <button type="submit">Claim</button>
          </span>
        </form>
      ) : v.canClaim ? null : (
        <ul className="checks">
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {v.trial.held > 0 && !v.trial.proven && (
        <small className="muted">
          You hold or have bought {plural(v.trial.held, "unit")} of this item. Until a verified trade exists, one member's
          total is a trial batch of {plural(v.trial.limit, "unit")}.
        </small>
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

function shelfText(bounty: Bounty) {
  if (bounty.shelf.state === "unknown") return "No stock reports yet";
  if (bounty.shelf.state === "seen") return `${plural(bounty.shelf.unitsSeen ?? 0, "unit")} seen at ${when(bounty.shelf.at)}`;
  return `None on the shelf at ${when(bounty.shelf.at)}: claims and alerts paused`;
}

function unitsOnShelf(s: Bounty["pressure"]["sourcing"]) {
  if (s.availableUnits === null) return "units on the shelf not known (no count recorded)";
  const basis = s.unitsSource === "sample" ? "sample figure" : `${s.unitsSource ?? "evidence"} at ${when(s.unitsAt)}`;
  const bought = s.boughtSince ? `, less ${plural(s.boughtSince, "unit")} bought since` : "";
  return s.availableUnits === 0
    ? `none on the shelf (${basis}${bought})`
    : `${plural(s.availableUnits, "unit")} on the shelf (${basis}${bought})`;
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
  const trip = bounty.trip;
  return (
    <article className={"bounty" + (bounty.status === "open" ? "" : " closed")}>
      <div className="bounty-head">
        <h3>{bounty.title}</h3>
        <div>
          {bounty.sample && <span className="badge sample">Sample</span>}
          {bounty.placement && <span className="badge sponsored">{bounty.placement}</span>}
          {!bounty.sample && tierBadge(o?.tier ?? null)}
          <span className={"badge " + (trip.state === "go" ? "ok" : "warn")}>{trip.label}</span>
          {!bounty.sample && bounty.status === "open" && (
            <span className={"badge " + (bounty.alert.canSend ? "ok" : "warn")}>
              {bounty.alert.canSend ? "Alerts can be sent" : "No alerts"}
            </span>
          )}
        </div>
      </div>
      {!bounty.sample && bounty.accessNeeds?.length ? (
        <div className="access-line">
          <small className="muted">Access needs:</small> <AccessList needs={bounty.accessNeeds} />
        </div>
      ) : null}
      <p className="terms">{bounty.sample ? bounty.terms.sample : bounty.terms.buyAndResell}</p>
      {!trip.go && !bounty.sample && trip.headline && bounty.status === "open" && (
        <p className="stop" role="status">
          {trip.headline}
        </p>
      )}
      {bounty.validation?.warning && <p className="notice prevalidation">{bounty.validation.warning}</p>}
      {bounty.display.label && <p className="notice">{bounty.display.label}</p>}
      {bounty.promotion?.note && <p className="notice">{bounty.promotion.note}</p>}
      {!bounty.sample && <CategoryLine category={bounty.category} />}
      <dl className="facts">
        <Fact label="Retailer and locality">
          {bounty.retailer ?? "Not shown"}, {bounty.locality}
        </Fact>
        {bounty.barcode && <Fact label="Barcode">{bounty.barcode + (bounty.variant ? `, ${bounty.variant}` : "")}</Fact>}
        <Fact label="Expires">{when(bounty.expiresAt)}</Fact>
        <Fact label="Distribution cap">{plural(bounty.cap, "unit")}</Fact>
        <Fact label="Claimed now">{plural(bounty.claimedUnits, "unit")}</Fact>
        <Fact label="Bought by members">{plural(bounty.completedUnits, "unit")}</Fact>
        <Fact label="Remaining under the cap">
          {plural(bounty.remaining, "unit")}
          {!trip.go && bounty.status === "open" && bounty.remaining > 0 ? ", none claimable while " + trip.label.toLowerCase() : ""}
        </Fact>
        <Fact label="Shelf">{shelfText(bounty)}</Fact>
        {bounty.checked && !bounty.sample && (
          <Fact label="Last checked">
            {[bounty.checked.priceLabel, bounty.checked.stockLabel].filter(Boolean).join(". ")}.
          </Fact>
        )}
        {bounty.mainUncertainty && <Fact label="Main uncertainty">{bounty.mainUncertainty}</Fact>}
        {bounty.attributes?.length ? (
          <Fact label="Exact match">
            <ul className="match-notes">
              {bounty.attributes.map((a) => (
                <li key={a.key}>{a.text}</li>
              ))}
            </ul>
          </Fact>
        ) : null}
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
          <b>
            {sourcing.ratio === null
              ? sourcing.availableUnits === 0
                ? "none on the shelf"
                : "not known"
              : sourcing.ratio.toLocaleString("en-GB")}
          </b>
          <span className="muted">
            People heading to the shelf per unit: {plural(sourcing.activeClaimedUnits, "claimed unit")} and{" "}
            {plural(sourcing.recentPositiveReports, "stock sighting")} in 24 hours, for {unitsOnShelf(sourcing)}.
          </span>
        </div>
        <div>
          <small>RESALE COMPETITION</small>
          <b>
            {resale.competingListings === 0
              ? "No competing listings found"
              : resale.weeksOfSupply === null
                ? "not known"
                : `${resale.weeksOfSupply.toLocaleString("en-GB")} ${resale.weeksOfSupply === 1 ? "week" : "weeks"} of supply`}
          </b>
          <span className="muted">
            {resale.competingListings === null
              ? "Competing listings not known"
              : `${plural(resale.competingListings, "competing listing")}${resale.competingSellers === null ? "" : ` from ${plural(resale.competingSellers, "seller")}`}`}
            {resale.salesPerWeek === null ? ", sales rate not known." : `, against ${resale.salesPerWeek.toLocaleString("en-GB")} sales a week.`}
            {resale.note ? " " + resale.note : ""}
          </span>
        </div>
      </div>

      {o && o.tier && !bounty.sample && (
        <div className="opportunity">
          <b>Opportunity tier: {o.tier}</b>
          {o.reasons.length > 0 && (
            <ul className="muted">
              {o.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          {o.targetPrice ? <span className="muted">Would qualify at a purchase price of {cash(o.targetPrice)} or less.</span> : null}
        </div>
      )}

      {bounty.figures?.hidden && bounty.figures.note && <p className="notice">{bounty.figures.note}</p>}
      {e && (
        <details>
          <summary>
            {bounty.sample ? "Illustrative figures" : "Figures"} for {plural(e.units, "unit")} (checked{" "}
            {when(bounty.estimate?.checkedAt)})
          </summary>
          {bounty.figures?.label && <p className="muted figures-label">{bounty.figures.label}</p>}
          <dl className="facts">
            <Fact label="Cash required before payout">{cash(e.cashRequired)}</Fact>
            <Fact label="Purchase price per unit">
              {cash(e.unitCost)}
              {bounty.promotion && bounty.promotion.costedAt === "promotion"
                ? ` (promotion price: ${bounty.promotion.condition}; only if you qualify)`
                : bounty.promotion
                  ? " (regular price)"
                  : ""}
            </Fact>
            <Fact label="Sale estimate per unit (lower median of confirmed sales)">{cash(e.salePrice)}</Fact>
            <Fact label="Contribution after all costs">{cash(e.contribution)}</Fact>
            <Fact label="Profit per unit">{cash(o?.unitProfit ?? e.unitContribution)}</Fact>
            <Fact label="Return on purchase price">
              {o?.returnOnCost === null || o?.returnOnCost === undefined ? "unknown" : percentDown(o.returnOnCost)}
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

      {!bounty.sample && (
        <details open={!bounty.alert.canSend && bounty.status === "open"}>
          <summary>Alert checks now (evidence last re-checked {when(bounty.alert.checkedAt)})</summary>
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
            <p className="ok">Every check passes now and the cap has room.</p>
          )}
          <small className="muted">
            {plural(bounty.alert.sent, "alert")} sent
            {bounty.alert.questions ? `, and ${plural(bounty.alert.questions, "member")} asked whether they qualify for the price` : ""}.
            Exposure limit now: {plural(bounty.alert.exposureLimit, "alert")} in total (two per unit left under the cap).
          </small>
        </details>
      )}

      <details>
        <summary>
          Stock reports: {bounty.reports.positive} with stock, {bounty.reports.negative} with none
        </summary>
        {bounty.reports.items.length ? (
          <div className="reports">
            {bounty.reports.items.map((r) => (
              <div key={r.id} className="report">
                <div className="report-main">
                  <span>{when(r.observedAt)}</span>
                  <b>{r.unitsSeen === 0 ? "None on the shelf" : plural(r.unitsSeen, "unit") + " seen"}</b>
                  {isOperator && <span>{r.memberName}</span>}
                </div>
                <div className="report-note">
                  {r.note === undefined ? (
                    <span className="muted">Note and photo private</span>
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
                </div>
                <div className="report-verify">
                  {r.verified ? (
                    <span className={r.verified === "accurate" ? "ok" : "warn"}>
                      Verified {r.verified}
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
                    <span className="muted">Not verified yet</span>
                  )}
                </div>
              </div>
            ))}
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
                      <th>Their journey</th>
                      <th>Lapses</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bounty.claims.map((c) => (
                      <tr key={c.id}>
                        <td>{c.memberName}</td>
                        <td className="num">{c.units}</td>
                        <td>
                          {c.status}
                          {c.paused ? " (paused)" : ""}
                          {c.promotionConfirmed ? ", confirmed promotion" : ""}
                        </td>
                        <td>
                          {c.journeyCost === null || c.journeyCost === undefined
                            ? "not recorded"
                            : `${cash(c.journeyCost)}, ${plural(c.journeyMinutes ?? 0, "minute")}${c.figures ? `; ${cash(c.figures.unitProfit)} a unit` : ""}`}
                        </td>
                        <td>{c.status === "active" ? when(c.expiresAt) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          {bounty.status === "open" && (
            <div className="actions">
              {!bounty.sample && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const res = await api<Dispatch>(`bounties/${bounty.id}/alerts`, {});
                      setDispatch(res);
                      done(
                        res.sent.length || res.asked?.length
                          ? [
                              res.sent.length ? `Alerted ${plural(res.sent.length, "member")}.` : "",
                              res.asked?.length ? `Asked ${plural(res.asked.length, "member")} whether they qualify for the price.` : "",
                            ]
                              .filter(Boolean)
                              .join(" ")
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
              )}
              {!bounty.sample && (
                <button type="button" onClick={() => call(() => api(`bounties/${bounty.id}/recheck`, {}), "Re-checked")}>
                  Re-check evidence
                </button>
              )}
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
              {dispatch.asked && dispatch.asked.length > 0 && (
                <ul className="checks">
                  {dispatch.asked.map((q) => (
                    <li key={q.memberId}>
                      {q.name}: asked whether they qualify for the price, with no figures until they say they do
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
              {dispatch.sent.length > 0 && (dispatch.promotion || dispatch.warning) && (
                <small className="muted">
                  {dispatch.promotion ? `Each alert says the price is a promotion price: ${dispatch.promotion.condition}. ` : ""}
                  {dispatch.warning ?? ""}
                </small>
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

function AlertInbox({ memberId, refresh, onChanged }: { memberId: number; refresh: number; onChanged: () => void }) {
  const [alerts, setAlerts] = useState<MemberAlert[] | null>(null);
  const [stops, setStops] = useState<Notice[]>([]);
  const [notice, setNotice] = useState("");
  const [message, setMessage] = useState({ text: "", error: false });
  useEffect(() => {
    api<{ alerts: MemberAlert[]; stopNotices?: Notice[]; notice: string }>(`members/${memberId}/alerts`)
      .then((r) => {
        setAlerts(r.alerts);
        setStops(r.stopNotices ?? []);
        setNotice(r.notice);
      })
      .catch(() => setAlerts([]));
  }, [memberId, refresh]);
  if (!alerts) return null;
  const alerted = new Set(alerts.map((a) => a.bountyId));
  // Notices for bounties the member claimed without an alert.
  const others = stops.filter((n) => !alerted.has(n.bountyId));
  const answered = (text: string, error = false) => {
    setMessage({ text, error });
    onChanged();
  };
  return (
    <div>
      <h3>Your alerts</h3>
      <NoticeList notices={others} />
      {alerts.length ? (
        <ul className="alert-list">
          {alerts.map((a) => (
            <li key={a.id}>
              <b>{a.title}</b> {a.retailer ? `at ${a.retailer}, ` : "in "}
              {a.locality}
              {a.sponsored && <span className="badge sponsored">Sponsored by {a.sponsor}</span>}
              <span className={"badge " + (a.trip.state === "go" ? "ok" : "warn")}>{a.trip.label}</span>
              {a.kind === "question" && <span className="badge warn">Question about the price</span>}
              {a.trip.headline && !a.trip.go && <span className="stop">{a.trip.headline}</span>}
              {a.kind === "question" && a.eligibility && !a.eligibility.confirmed && !a.eligibility.usedHere && a.eligibility.answer !== "not" ? (
                <EligibilityQuestion bountyId={a.bountyId} memberId={memberId} eligibility={a.eligibility} onDone={answered} />
              ) : null}
              {a.questionNote && <small className="muted">{a.questionNote}</small>}
              {a.figures?.label && (
                <small className="muted">
                  {a.figures.label} Profit per unit {cash(a.figures.unitProfit)}.
                </small>
              )}
              {a.promotion && <small className="muted">{a.promotion.note}</small>}
              {a.category?.applied && (
                <small className="muted">
                  {a.category.warning
                    ? `Category: ${a.category.applied}. ${sentence(a.category.warning)}`
                    : `Costed under the ${a.category.applied.toLowerCase()} rules.`}
                </small>
              )}
              {a.attributes?.map((n) => (
                <small key={n.key} className="muted">
                  {n.text}.
                </small>
              ))}
              {a.accessNeeds?.length ? (
                <span className="access-line">
                  <small className="muted">Access needs:</small> <AccessList needs={a.accessNeeds} />
                </span>
              ) : null}
              {a.warning && <small className="muted">{a.warning}</small>}
              <NoticeList notices={a.notices} />
              <small className="muted">
                {a.kind === "question" ? "Asked" : "Alerted"} {when(a.created)}, {a.label}
                {a.tier ? ` (${a.tier.name})` : ""}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No alerts yet.</p>
      )}
      <Message text={message.text} error={message.error} />
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
            <span>{terms.promotion}</span>
            <span className="muted">{terms.times}</span>
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
            <AlertInbox memberId={me.id} refresh={refresh} onChanged={load} />
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
