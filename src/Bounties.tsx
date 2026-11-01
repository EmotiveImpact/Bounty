import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, barcodeText, dateTime, loadMemberRules, money, toPence, type MemberRules, type RuleKey } from "./api";
import { TRANSPORTS, TRANSPORT_WORDS, savedTripProfile } from "./ResearchCalculator";
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
  // The member's own transport, carrying limit (kg) and storage (units):
  // null when not entered, never zero (server/bounties.mjs memberProfileView).
  profile?: MemberProfile;
  // The seller name their marketplace listings show, such as their eBay
  // user name (round 5b): their own listings of units bought through
  // bounties are then counted once against the demand. Null when not given.
  sellerName?: string | null;
  // When the operator confirmed the seller name is theirs (round 5b), or
  // null: until then their listings count in full.
  sellerConfirmedAt?: string | null;
};
type MemberProfile = {
  transport: string | null;
  carryKg: number | null;
  // Their room at home for units in all (round 5b: the total, counting the
  // space units bought through bounties take up).
  storageUnits: number | null;
  // Units at home from bounties and in live claims, and the room left now
  // (null where the server did not work them out).
  heldUnits?: number | null;
  claimedUnits?: number | null;
  roomNow?: number | null;
  complete: boolean;
  missing: string[];
  loadLimitKg: number | null;
  note: string;
};
// One check of whether a trip fits the member (server/suitability.mjs).
type FitCheck = { id: string; ok: boolean; detail: string; known?: boolean; maxUnits?: number | null };
type ViewerFit = {
  ok: boolean;
  complete: boolean;
  units: number;
  figures: number | null;
  partial: boolean;
  maxUnits: number | null;
  loadLimitKg: number | null;
  checks: FitCheck[];
  // The profile values still missing ("transport", "carryKg", "storageUnits").
  missing?: string[];
  note: string | null;
  cash: string;
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
  // The cash the member said they can spend on this trip (their own claims
  // only), and whether a live claim stores none (made before it was asked
  // for, round 5b): the holder confirms it under the claim.
  cashAvailable?: number | null;
  needsCash?: boolean;
  // For units bought: what is recorded as sold, returned or reconciled, and
  // what still counts against the demand for the item (null otherwise).
  released?: Released | null;
  outstanding?: number | null;
  releases?: { kind: "sold" | "returned" | "reconciled"; units: number; reason: string | null; recordedBy: string; at: string }[];
};
type Released = { sold: number; returned: number; reconciled: number };
type SellerNameRow = {
  memberId: number;
  name: string | null;
  sellerName: string | null;
  confirmed: boolean;
  prior: boolean;
  outstanding: number;
  status: string;
};
// Units earlier bounties for the item still have against its resale demand
// (server/bounties.mjs earlierAllocation): bought and not recorded as sold or
// returned, or held in a live claim. claims are the purchases with units
// outstanding: all of them for the operator, only their own for a member.
type EarlierClaim = {
  id: number;
  bountyId: number;
  memberId: number;
  memberName: string | null;
  mine: boolean;
  units: number;
  released: Released;
  outstanding: number;
  endedAt: string | null;
};
type Earlier = {
  units: number;
  outstanding: number;
  held: number;
  bought: number;
  released: Released;
  bounties: number[];
  note: string | null;
  release: string | null;
  binding: boolean;
  capWithout: number | null;
  claims: EarlierClaim[];
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
  // When the member's unit is likely to sell and be paid out, counting the
  // units other members already claimed or bought (UK date).
  sellDays?: number | null;
  payoutDate?: string | null;
  // Values the member has not given that the figures wait on (round 5b).
  confirm?: string[] | null;
};
// The units already claimed or bought on the bounty, as the member's check
// counted them against demand.
type SharedDemand = {
  committed: number;
  mine: number;
  others: number;
  // Units from earlier bounties for the item still counted against demand.
  earlier?: number;
  salesPerWeek: number | null;
  sellWindowWeeks: number | null;
  competingListings: number | null;
  demand: number | null;
  demandLeft: number | null;
  sellDays: number | null;
  payoutDate: string | null;
  cashNeededBy: string | null;
  note: string | null;
};
type TripCheck = {
  ok: boolean;
  units: number;
  journey: { cost: number; minutes: number };
  figures: OwnFigures | null;
  reasons: string[];
  shared?: SharedDemand | null;
  // The hourly floor the check used: the stricter of the operator's and the
  // member's own, and the member's own cash date (never the operator's).
  floor?: { used: number | null; mine: number | null; operator: number | null } | null;
  cashNeededBy?: string | null;
  // blocked: the trip cannot be made now (stop, trip blockers or nothing
  // left under the cap). stop leads; ownOk and ownReasons are the member's
  // own result.
  blocked?: boolean;
  stop?: string;
  blockers?: string[];
  ownOk?: boolean;
  ownReasons?: string[];
  // Load, cash and storage for this member at these units.
  fit?: { ok: boolean; known: boolean; checks: FitCheck[]; loadLimitKg: number | null; missing: string[] } | null;
};
type Check = { id: string; ok: boolean; detail: string };
// kind "stop" ("Don't make the trip") or "reopen" (reason "claim-stands"
// when a holder's claim stands); superseded marks a notice a newer one
// replaced, since only the latest notice on a bounty is current.
type Notice = {
  id: number;
  bountyId: number;
  kind: string;
  reason: string;
  message: string;
  created: string;
  superseded?: boolean;
};
// server/bounties.mjs tripState. "full" is go only for members holding a
// claim: "Fully claimed", "Nothing to share: cap 0", or "Your claim stands"
// (with note) for a holder among the first claims when more is claimed than
// the shelf holds. "blocked" covers any other blocker, including "More
// claimed than on the shelf", "Your figures no longer pass", "Competition
// check out of date" and "Sales evidence out of date". A blocker's own label
// replaces the state's.
type TripState = {
  // "confirm-profile": the member's transport, carrying limit or storage is
  // not entered; "does-not-fit": the trip does not fit them (round 5).
  // "confirm-cash": the holder's claim stores no cash they can spend on the
  // trip (made before it was asked for), and nothing else fails (round 5b).
  state:
    | "go"
    | "full"
    | "paused"
    | "out-of-stock"
    | "stock-unconfirmed"
    | "blocked"
    | "confirm-profile"
    | "confirm-cash"
    | "does-not-fit"
    | "sample"
    | "expired"
    | "withdrawn";
  go: boolean;
  label: string;
  headline: string | null;
  // Why the trip cannot be made: the first blocker's id (for example
  // "price-rose", "competition-lapsed" or "demand-aged"), "over-claimed",
  // "own-figures", "sample", "expired" or "withdrawn". Null when it can.
  reason?: TripReason | null;
  // Why this holder's claim stands ("Your claim stands" only).
  note?: string | null;
  // For "confirm-profile" from a claim's re-check: the values still missing.
  confirm?: string[] | null;
};
type TripReason =
  | "shelf-empty"
  | "out-of-stock"
  | "stock-lapsed"
  | "price-rose"
  | "offer-gone"
  | "offer-stale"
  | "sales-aged"
  | "competition-lapsed"
  | "demand-aged"
  | "over-claimed"
  | "own-figures"
  | "promotion-declined"
  | "profile-unknown"
  | "cash-unknown"
  | "does-not-fit"
  | "sample"
  | "expired"
  | "withdrawn"
  // Any other blocker id (ineligible, display, cap and so on).
  | (string & {});
type Eligibility = {
  condition: string;
  firstOrder: boolean;
  retailer: string;
  answer: "qualifies" | "not" | "used" | null;
  usedHere: boolean;
  // usedBy "purchase": the member bought at a first-order price here, which
  // cannot be undone; "answer": they said so.
  usedBy?: "purchase" | "answer" | null;
  usedOn?: string | null;
  confirmed: boolean;
  // declined: the bounty is not for this member (notForYou says why);
  // canUndo: the answer can be removed ("I answered by mistake").
  declined?: boolean;
  canUndo?: boolean;
  notForYou?: string | null;
  refusal?: string | null;
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
  earlier?: Earlier | null;
  // For the operator only (round 5b): members holding units of this item,
  // with the seller name each gave and whether it is confirmed.
  sellerNames?: SellerNameRow[] | null;
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
  // The latest stock report that was not marked inaccurate.
  shelf: { state: "unknown" | "seen" | "none"; paused: boolean; at: string | null; unitsSeen: number | null };
  // Units on the shelf now: the newest of the figures' stock check, a newer
  // branch check and the latest stock report, less units members bought
  // since (server/bounties.mjs shelfUnitsNow). source "stock check" is any
  // branch check; units is null when that count recorded none.
  shelfUnits?: {
    units: number | null;
    source: "stock check" | "stock report" | "sample" | null;
    at: string | null;
    boughtSince: number;
  } | null;
  display: { permitted: boolean; basis: string; hidden: boolean; label: string | null };
  // warning is one line: after a pilot audit sign-off that stands, its plain
  // result with caution false; otherwise the caution (caution true).
  validation: {
    locality: string;
    complete: boolean;
    audited: number;
    target: number;
    warning: string | null;
    caution?: boolean;
    signedOff?: boolean;
  } | null;
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
    // What sets maxClaimUnits, in words: "your trial batch", "what is left
    // under the cap", or what fits their load limit or room at home.
    claimLimit?: string | null;
    promotion: { condition: string; confirmed: boolean; risk: string | null } | null;
    eligibility?: Eligibility | null;
    askedAt?: string | null;
    stop: string | null;
    notices: Notice[];
    profile?: MemberProfile;
    fit?: ViewerFit | null;
    // Units of this item they bought through bounties are outstanding and
    // their profile has no seller name: any they list count twice (round 5b).
    sellerNote?: string | null;
  } | null;
  terms: Terms;
};
type BountiesResponse = { bounties: Bounty[]; terms: Terms; rules: { maxClaimUnits: number; maxDays: number } };
type Dispatch = {
  sent: { memberId: number; name: string; tier: Tier; label: string; reputation: number }[];
  asked?: { memberId: number; name: string; condition: string | null }[];
  // Members with no complete profile, asked to confirm it (no figures).
  confirm?: { memberId: number; name: string; missing: string[] }[];
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
  // qualify for, so there are no figures yet. "declined": the member said
  // they do not qualify or already used a first-order offer here, so the
  // bounty is not for them.
  // "profile": the member was asked to confirm their transport, carrying
  // limit and storage, so there are no figures yet.
  kind?: "alert" | "question" | "declined" | "profile";
  profile?: MemberProfile | null;
  eligibility?: Eligibility | null;
  questionNote?: string | null;
  figures?: { label: string | null; units: number | null; unitProfit: number | null; contribution: number | null; cashRequired: number | null } | null;
  category?: Category | null;
  attributes?: AttributeNote[];
  accessNeeds?: AccessNeed[];
  // When the price and the stock were last checked, and the main
  // uncertainty (never the sale estimate before the member qualifies).
  checked?: { priceLabel: string | null; stockLabel: string | null } | null;
  mainUncertainty?: string | null;
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
const upperFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
// The member profile values, short (server/bounties.mjs CONFIRM_LABELS).
const FIELD_LABELS: Record<string, string> = { transport: "transport", carryKg: "carrying limit", storageUnits: "storage", cashAvailable: "cash" };
/** The profile values a claim's figures wait on, in words, or "" (round 5b). */
const waitingOn = (c: Claim) =>
  andList((c.figures?.confirm ?? []).filter((k) => k !== "cashAvailable").map((k) => FIELD_LABELS[k] ?? k));
const andList = (items: string[]) =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
// Several pieces of server text as sentences, one full stop each.
const sentences = (parts: (string | null | undefined | false)[]) =>
  parts
    .filter((p): p is string => typeof p === "string" && p.trim() !== "")
    .map(sentence)
    .join(" ");
// "Price seen 31 Oct 2026, 20:00. Stock checked ..." from the server's labels.
const checkedText = (checked: { priceLabel: string | null; stockLabel: string | null } | null | undefined) =>
  checked ? sentences([checked.priceLabel, checked.stockLabel]) : "";
/**
 * Whether a trip reads as go (the green style). Only when the server says go
 * and the state is one that sends someone: "go", or "full" for a member
 * holding a claim ("Your claim stands" carries its note). Every other state,
 * and any state or label this page does not know, reads as a stop.
 */
function tripGo(trip: TripState | null | undefined, holding = false) {
  if (!trip || trip.go !== true) return false;
  if (trip.state === "go") return true;
  return trip.state === "full" && (holding || Boolean(trip.note));
}
// The evidence behind a shelf count in words, as the server names it.
const countWord = (source: string | null | undefined) => (source === "stock report" ? "stock report" : "branch check");
// Today in the viewer's time zone, as a date input value.
function todayInput() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

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

const numText = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "");

/** A member's transport, carrying limit and storage, in words. */
function profileText(p: MemberProfile | undefined) {
  if (!p) return "Not entered";
  const parts = [
    p.transport ? TRANSPORT_WORDS[p.transport] ?? p.transport : "transport not entered",
    p.carryKg === null ? "carrying limit not entered" : `carries up to ${p.carryKg} kg`,
    p.storageUnits === null ? "room at home not entered" : `room for ${plural(p.storageUnits, "unit")} at home in all`,
  ];
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
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
  // The member's own transport, carrying limit and storage, as form text: a
  // blank is not entered (never zero) and is sent as null.
  const [transport, setTransport] = useState(member?.profile?.transport ?? "");
  const [carry, setCarry] = useState(numText(member?.profile?.carryKg));
  const [storage, setStorage] = useState(numText(member?.profile?.storageUnits));
  // Optional: the seller name their marketplace listings show. A blank is
  // not given, and their own listings then count in full.
  const [seller, setSeller] = useState(member?.sellerName ?? "");
  // A refused seller name is shown next to its field (round 5b).
  const [sellerError, setSellerError] = useState("");
  const [message, setMessage] = useState({ text: "", error: false });
  async function save(e: FormEvent) {
    e.preventDefault();
    setMessage({ text: "", error: false });
    setSellerError("");
    const carryKg = carry.trim() === "" ? null : Number(carry);
    const storageUnits = storage.trim() === "" ? null : Number(storage);
    if (carryKg !== null && !(Number.isFinite(carryKg) && carryKg >= 0)) {
      setMessage({ text: "Enter how much you can carry in kilograms, or leave it blank.", error: true });
      return;
    }
    if (storageUnits !== null && !(Number.isInteger(storageUnits) && storageUnits >= 0)) {
      setMessage({ text: "Enter the room you have at home for units in all as a whole number, or leave it blank.", error: true });
      return;
    }
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
      transport: transport || null,
      carryKg,
      storageUnits,
      sellerName: seller.trim() || null,
    };
    try {
      const res = member
        ? await api<{ member: Member; message?: string }>("members/" + member.id, body, "PATCH")
        : await api<{ member: Member; message?: string }>("members", body);
      // A profile change checks the member's live claims again, and says so.
      setMessage({ text: res.message ?? (member ? "Saved." : "Member added."), error: false });
      if (!member) {
        setName("");
        setPlaces("");
      }
      onSaved(res.member);
    } catch (err) {
      const text = (err as Error).message;
      if (/seller name/i.test(text)) {
        setSellerError(text);
        setMessage({ text: "Not saved: check your marketplace seller name.", error: true });
      } else setMessage({ text, error: true });
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
      <label>
        Your marketplace seller name, optional (for example your eBay user name)
        <input
          value={seller}
          onChange={(e) => {
            setSeller(e.target.value);
            setSellerError("");
          }}
          maxLength={64}
          autoComplete="off"
          aria-invalid={sellerError ? true : undefined}
          aria-describedby={sellerError ? "seller-error" : undefined}
        />
        {sellerError && (
          <span className="field-error" id="seller-error" role="alert">
            {sellerError}
          </span>
        )}
        <small className="muted">
          Units you bought through bounties count against the demand for the item until you record them as sold or
          returned. Once the operator checks your seller name against your marketplace profile or one of your listings
          and confirms it, your own listings of them are counted once, not again as competing listings. Leave it blank
          if you do not sell online: your listings then count in full.
        </small>
      </label>
      <fieldset className="trip-profile">
        <legend>How you travel, what you can carry and your storage</legend>
        <small className="muted">
          Every trip is checked against these: one unit and the whole batch must fit your load limit, and the units must
          fit the room you have at home. Until all three are entered no trip is shown to you as one to make. A blank is
          never counted as zero or as enough. The cash you can spend is asked each time you claim.
        </small>
        <div className="form-grid">
          <label>
            How you travel
            <select value={transport} onChange={(e) => setTransport(e.target.value)} aria-invalid={!transport}>
              <option value="">Not entered</option>
              {TRANSPORTS.map((t) => (
                <option key={t} value={t}>
                  {TRANSPORT_WORDS[t]}
                </option>
              ))}
            </select>
          </label>
          <label>
            How much you can carry (kg)
            <input
              type="number"
              min={0}
              max={1000}
              step={0.1}
              inputMode="decimal"
              value={carry}
              aria-invalid={carry.trim() === ""}
              onChange={(e) => setCarry(e.target.value)}
            />
          </label>
          <label>
            Room at home for units, in all
            <input
              type="number"
              min={0}
              max={100000}
              step={1}
              inputMode="numeric"
              value={storage}
              aria-invalid={storage.trim() === ""}
              onChange={(e) => setStorage(e.target.value)}
            />
            <small className="muted">
              Count all the room you keep for stock, including the space taken by units you bought through bounties and
              have not yet sold or returned. Those units, and the units in your live claims, are taken off it for you.
            </small>
          </label>
        </div>
        <small className="muted">
          By car or van your load limit is at least 25 kg (the boot); by public transport it is at most 10 kg, about two
          full shopping bags; on foot or by bicycle it is what you can carry.
        </small>
        <button
          type="button"
          onClick={() => {
            // Only the trip fields someone changed in the Planner (round 5b).
            const saved = savedTripProfile();
            if (!saved.transport && !saved.carryKg && !saved.storageUnits) {
              setMessage({
                text: "No trip fields from the Planner are kept in this browser: its starting values are never used. Enter yours here, or change how you travel, what you can carry or your storage in the Planner first.",
                error: true,
              });
              return;
            }
            if (saved.transport) setTransport(saved.transport);
            if (saved.carryKg) setCarry(saved.carryKg);
            if (saved.storageUnits) setStorage(saved.storageUnits);
            const left = [
              saved.transport ? "" : "how you travel",
              saved.carryKg ? "" : "how much you can carry",
              saved.storageUnits ? "" : "your room at home",
            ].filter(Boolean);
            setMessage({
              text: `Filled in from what you changed in the Planner. ${
                left.length ? `${upperFirst(andList(left))} ${left.length === 1 ? "was" : "were"} not changed there, so enter ${left.length === 1 ? "it" : "them"} here. ` : ""
              }Save member to keep it.`,
              error: false,
            });
          }}
        >
          Use the Planner profile saved in this browser
        </button>
      </fieldset>
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
        <dt>How you travel, carry and store</dt>
        <dd className={member.profile?.complete ? "" : "warn"} data-profile={member.profile?.complete ? "complete" : "missing"}>
          {profileText(member.profile)}. {member.profile ? sentence(member.profile.note) : ""}
        </dd>
        <dt>Marketplace seller name</dt>
        <dd data-seller={member.sellerName ? (member.sellerConfirmedAt ? "confirmed" : "given") : "none"}>
          {member.sellerName
            ? member.sellerConfirmedAt
              ? `${member.sellerName}, confirmed by the operator on ${dateTime(member.sellerConfirmedAt)}`
              : `${member.sellerName}. Waiting for the operator to confirm it is yours: until then, units you bought through bounties and list for sale count twice against the demand for the item.`
            : "Not given: if you list units you bought through bounties, they count twice against the demand for the item"}
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

// real: a live bounty was created (the form closes and the page says so);
// otherwise a sample, and the form stays open with its message.
function CreateBounty({ onCreated }: { onCreated: (message: string, real: boolean) => void }) {
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
        // The draft is used up. The parent closes this form and shows the
        // message, so the sample notice never sits above a real bounty's.
        writeStorage(DRAFT_KEY, null);
        setDraft(null);
        resetToSample();
        onCreated(res.message, true);
        return;
      }
      setMessage({ text: res.message, error: false });
      onCreated(res.message, false);
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
 * "Don't make the trip" and reopen notices. Any newer notice on a bounty
 * replaces the earlier ones (the server marks them superseded): they are
 * kept for the record but folded away, so the list only leads with the
 * notice that applies now.
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
          {old === 1
            ? "1 earlier notice no longer applies: a newer notice replaced it."
            : `${old} earlier notices no longer apply: a newer notice replaced them.`}
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

type EligibilityReply = { message: string; bounty?: Bounty; eligibility?: Eligibility };

/** Posts a member's answer to a promotion question ("undo" removes it). */
async function sendAnswer(bountyId: number, memberId: number, answer: "qualifies" | "not" | "used" | "undo") {
  return api<EligibilityReply>(`bounties/${bountyId}/eligibility`, { memberId, answer });
}

/**
 * The promotion question for a member: whether they qualify for the price
 * the figures use. A first-order or new-customer offer can also be answered
 * "already used at this retailer", which stops such offers there. Shown only
 * while the member has not answered: after "not" or "used" the bounty is not
 * for them (NotForYou).
 */
function EligibilityQuestion({
  bountyId,
  memberId,
  eligibility,
  onDone,
  onAnswered,
}: {
  bountyId: number;
  memberId: number;
  eligibility: Eligibility;
  onDone: (m: string, err?: boolean) => void;
  onAnswered?: (reply: EligibilityReply) => void;
}) {
  const [busy, setBusy] = useState(false);
  const answer = async (value: "qualifies" | "not" | "used") => {
    setBusy(true);
    try {
      const res = await sendAnswer(bountyId, memberId, value);
      onAnswered?.(res);
      onDone(res.message);
    } catch (err) {
      onDone((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="eligibility">
      <p>{eligibility.question}</p>
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

/**
 * The member said they do not qualify, or used a first-order offer at this
 * retailer (said so, or bought at such a price): the bounty is not for them.
 * An answer given by mistake can be removed; a purchase cannot.
 */
function NotForYou({
  bountyId,
  memberId,
  eligibility,
  onDone,
  onAnswered,
}: {
  bountyId: number;
  memberId: number;
  eligibility: Eligibility;
  onDone: (m: string, err?: boolean) => void;
  onAnswered?: (reply: EligibilityReply) => void;
}) {
  const [busy, setBusy] = useState(false);
  const undo = async () => {
    setBusy(true);
    try {
      const res = await sendAnswer(bountyId, memberId, "undo");
      onAnswered?.(res);
      onDone(res.message);
    } catch (err) {
      onDone((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="eligibility declined">
      <p>{sentence(eligibility.notForYou || "This bounty is not for you")}</p>
      {eligibility.canUndo && (
        <button type="button" className="link-button" disabled={busy} onClick={undo}>
          I answered by mistake
        </button>
      )}
    </div>
  );
}

/** The figures line of a member's own check. */
function ownFiguresLine(f: OwnFigures) {
  return (
    `Profit per unit ${cash(f.unitProfit)}` +
    (f.returnOnCost === null ? "" : `, return ${percentDown(f.returnOnCost)}`) +
    (f.hourly === null ? "" : `, ${cash(f.hourly)} an active hour`) +
    `, cash needed before payout ${cash(f.cashRequired)}` +
    (f.payoutDate ? `, likely paid out on ${dateTime(f.payoutDate)}` : "") +
    "."
  );
}

/** Which hourly floor and cash date the check used, when the member gave them. */
function termsLine(check: TripCheck) {
  const floor = check.floor;
  const date = check.cashNeededBy ? dateTime(check.cashNeededBy) : null;
  if (floor && floor.mine !== null && floor.used !== null)
    return `Checked against an hourly floor of ${cash(floor.used)}${floor.used > floor.mine ? " (the operator's, stricter than yours)" : ""}${date ? ` and your cash date of ${date}` : ""}.`;
  return date ? `Checked against your cash date of ${date}.` : "";
}

/**
 * A member's own figures for a trip, in plain words. While the trip cannot
 * be made (blocked), the "Don't make the trip" line leads, with the
 * blockers, and the member's own result follows.
 */
function OwnFiguresText({ check }: { check: TripCheck }) {
  const f = check.figures;
  const where = `${plural(check.units, "unit")} with your journey (${cash(check.journey.cost)}, ${plural(check.journey.minutes, "minute")})`;
  if (check.blocked) {
    const stop = check.stop ?? "Don't make the trip";
    const others = (check.blockers ?? []).filter((b) => !stop.includes(b));
    const ownReasons = check.ownReasons ?? [];
    return (
      <div className="own-figures warn" role="status">
        <b>{sentence(stop)}</b>
        {others.length > 0 && (
          <ul className="checks">
            {others.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        <span>
          {check.ownOk
            ? `Your own figures would otherwise pass for ${where}.`
            : `For ${where} your own figures also fail.`}
        </span>
        {f && <span>{ownFiguresLine(f)}</span>}
        {!check.ownOk && ownReasons.length > 0 && (
          <ul className="checks">
            {ownReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  const extra = sentences([check.shared?.note, termsLine(check)]);
  return (
    <div className={check.ok ? "own-figures ok" : "own-figures warn"} role="status">
      <b>
        {check.ok ? "Your figures pass every check" : "Your figures fail"} for {where}
      </b>
      {f && <span>{ownFiguresLine(f)}</span>}
      {extra && <span>{extra}</span>}
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

/**
 * Whether the trip fits the member viewing the card: their load limit and
 * storage at the units they would take (the cash they can spend is asked
 * when they claim), in plain words.
 */
function FitBlock({ fit, profile }: { fit: ViewerFit; profile?: MemberProfile }) {
  return (
    <div className={"fit " + (fit.ok ? "ok" : "warn")} data-fit={fit.ok ? "yes" : fit.complete ? "no" : "unknown"}>
      <b>
        {fit.ok
          ? `Your load limit and room at home fit ${plural(fit.units, "unit")}`
          : !fit.complete
            ? `Confirm your ${andList((fit.missing ?? ["transport", "carryKg", "storageUnits"]).map((k) => FIELD_LABELS[k] ?? k))}`
            : fit.partial && fit.maxUnits !== null
              ? `Only ${plural(fit.maxUnits, "unit")} ${fit.maxUnits === 1 ? "fits" : "fit"} you`
              : `Does not fit you for ${plural(fit.units, "unit")}`}
      </b>
      {profile && <span className="muted">Your profile: {profileText(profile)}.</span>}
      <ul className="checks">
        {fit.checks.map((c) => (
          <li key={c.id} className={c.ok ? "pass" : ""} data-check={c.id}>
            {c.detail}
          </li>
        ))}
      </ul>
      {fit.note && <small className="muted">{sentence(fit.note)}</small>}
      {!fit.complete && <small className="muted">Enter them under "Edit profile, alerts and paid tier" above.</small>}
      <small className="muted">{sentence(fit.cash)}</small>
    </div>
  );
}

function ClaimPanel({
  bounty,
  memberId,
  onDone,
  onAnswered,
}: {
  bounty: Bounty;
  memberId: number;
  onDone: (m: string, err?: boolean) => void;
  onAnswered?: (reply: EligibilityReply) => void;
}) {
  const [units, setUnits] = useState("1");
  const [bought, setBought] = useState("");
  const [qualifies, setQualifies] = useState(false);
  const [fare, setFare] = useState("");
  const [travel, setTravel] = useState("");
  // Optional: the member's own hourly floor (pounds) and the date they need
  // the cash back. Blank means not given, never zero.
  const [floor, setFloor] = useState("");
  const [cashBy, setCashBy] = useState("");
  // Required: the cash the member can spend on this trip before any payout
  // (pounds). A blank is never counted as zero or as enough.
  const [spend, setSpend] = useState("");
  // The cash a holder can spend on this trip, under their live claim
  // (round 5b): the stored figure, which they can correct.
  const heldClaim = bounty.viewer?.activeClaim ?? null;
  const storedCash = (c: Claim | null) => (typeof c?.cashAvailable === "number" ? String(c.cashAvailable / 100) : "");
  const [holdCash, setHoldCash] = useState(() => storedCash(heldClaim));
  useEffect(() => setHoldCash(storedCash(heldClaim)), [heldClaim?.id, heldClaim?.cashAvailable]);
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
    const spendPounds = spend.trim() === "" ? NaN : Number(spend);
    if (!Number.isFinite(spendPounds) || spendPounds < 0) {
      setFormError(
        "Enter the cash you can spend on this trip in pounds, before any payout comes in. A blank is never counted as zero or as enough.",
      );
      return null;
    }
    const own: { hourlyFloor?: number; cashNeededBy?: string } = {};
    if (floor.trim() !== "") {
      const pounds = Number(floor);
      if (!Number.isFinite(pounds) || pounds < 0) {
        setFormError("Enter your hourly floor in pounds an hour, or leave it blank to use the operator's.");
        return null;
      }
      own.hourlyFloor = toPence(pounds);
    }
    if (cashBy) {
      if (cashBy < todayInput()) {
        setFormError("The date you need the cash back must be today or later, or leave it blank.");
        return null;
      }
      own.cashNeededBy = cashBy;
    }
    setFormError("");
    return { journeyCost: toPence(cost), journeyMinutes: mins, cashAvailable: toPence(spendPounds), ...own };
  };
  const max = Math.max(1, v.maxClaimUnits);
  // While the shelf is reported empty (or the last branch check found none)
  // nobody should set off, but a member who bought before that can still
  // record the purchase.
  const emptyShelf = bounty.trip.state === "paused" || bounty.trip.state === "out-of-stock";
  const eligibility = v.eligibility ?? null;
  // The member said the price is not for them: say so, with the undo link,
  // instead of the question, the claim form and the other reasons.
  const declined = Boolean(eligibility?.declined) && !v.activeClaim;
  const unanswered = Boolean(eligibility && !eligibility.confirmed && !eligibility.declined);
  const confirmed = Boolean(eligibility?.confirmed || v.promotion?.confirmed);
  // What the fit block already says is not repeated in the list below it.
  const fitShown = new Set([...(v.fit?.checks ?? []).filter((c) => !c.ok).map((c) => c.detail), v.fit?.note ?? ""]);
  const reasons = [
    ...bounty.claimBlockers,
    ...v.blockers.filter((b) => b !== eligibility?.notForYou && !(v.fit && !declined && fitShown.has(b))),
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
      {v.fit && !declined && <FitBlock fit={v.fit} profile={v.profile} />}
      {v.sellerNote && (
        <p className="notice seller-note" role="note">
          {sentence(v.sellerNote)}
        </p>
      )}
      <p className="muted">
        {v.release.open
          ? `Open to you since ${when(v.release.releaseAt)}`
          : `Opens for you at ${when(v.release.releaseAt)}`}{" "}
        ({v.release.tier.name}, via {v.release.via === "paid" ? "paid early access" : "earned reputation"})
        {v.alertedAt ? `. You were alerted at ${when(v.alertedAt)}.` : v.askedAt ? `. You were asked about the price at ${when(v.askedAt)}.` : "."}
      </p>
      {eligibility && declined && (
        <NotForYou bountyId={bounty.id} memberId={memberId} eligibility={eligibility} onDone={onDone} onAnswered={onAnswered} />
      )}
      {eligibility && unanswered && !v.activeClaim && (
        <EligibilityQuestion bountyId={bounty.id} memberId={memberId} eligibility={eligibility} onDone={onDone} onAnswered={onAnswered} />
      )}
      {declined ? null : v.activeClaim ? (
        <div className="row">
          <span>
            {sentences([
              `Your claim: ${plural(v.activeClaim.units, "unit")} until ${when(v.activeClaim.expiresAt)}${v.activeClaim.paused ? " (" + bounty.trip.label.toLowerCase() + ")" : ""}`,
              v.activeClaim.promotionConfirmed && bounty.promotion ? `You confirmed you qualify for: ${bounty.promotion.condition}` : null,
              v.activeClaim.figures && v.activeClaim.journeyCost !== null && v.activeClaim.journeyCost !== undefined
                ? `Checked on your journey (${cash(v.activeClaim.journeyCost)}, ${plural(v.activeClaim.journeyMinutes ?? 0, "minute")}): profit per unit ${cash(v.activeClaim.figures.unitProfit)}`
                : null,
            ])}
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
          {v.activeClaim.status === "active" && (
            <form
              className="claim-cash"
              onSubmit={(e) => {
                e.preventDefault();
                const pounds = holdCash.trim() === "" ? NaN : Number(holdCash);
                if (!Number.isFinite(pounds) || pounds < 0) {
                  setFormError(
                    "Enter the cash you can spend on this trip in pounds, before any payout comes in. A blank is never counted as zero or as enough.",
                  );
                  return;
                }
                setFormError("");
                run(() => api(`claims/${v.activeClaim!.id}/cash`, { memberId, cashAvailable: toPence(pounds) }));
              }}
            >
              <label>
                Cash you can spend on this trip (£)
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  inputMode="decimal"
                  value={holdCash}
                  aria-invalid={holdCash.trim() === ""}
                  onChange={(e) => setHoldCash(e.target.value)}
                  required
                />
                <small className="muted">
                  {v.activeClaim.needsCash
                    ? "Your claim was made before this was asked, so it is checked again with it. "
                    : "Change it if it was wrong or has changed: your figures are checked again with it. "}
                  Before any payout comes in. A blank is never counted as zero or as enough.
                </small>
              </label>
              {waitingOn(v.activeClaim) && (
                <small className="muted">
                  Your figures also wait on your {waitingOn(v.activeClaim)} in your member profile: saving your profile
                  checks this claim again.
                </small>
              )}
              {formError && <p role="alert">{formError}</p>}
              <button type="submit">Save cash and check my figures</button>
            </form>
          )}
        </div>
      ) : v.canClaim && !unanswered ? (
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
            Units to claim (up to {plural(max, "unit")} now: {v.claimLimit ?? "your trial batch"})
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
            <label>
              Cash you can spend on this trip (£)
              <input
                type="number"
                min={0}
                step={0.01}
                inputMode="decimal"
                value={spend}
                aria-invalid={spend.trim() === ""}
                onChange={(e) => {
                  setSpend(e.target.value);
                  setOwn(null);
                }}
                required
              />
              <small className="muted">Before any payout comes in. A blank is never counted as zero or as enough.</small>
            </label>
            <label>
              Your hourly floor, optional (£ an hour)
              <input
                type="number"
                min={0}
                step={0.01}
                inputMode="decimal"
                value={floor}
                placeholder="The operator's"
                onChange={(e) => {
                  setFloor(e.target.value);
                  setOwn(null);
                }}
              />
            </label>
            <label>
              Date you need the cash back, optional
              <input
                type="date"
                min={todayInput()}
                value={cashBy}
                onChange={(e) => {
                  setCashBy(e.target.value);
                  setOwn(null);
                }}
              />
            </label>
          </div>
          <small className="muted">
            The card's figures use the operator's journey. Your claim is checked again at the units you claim with your own
            journey, load limit, storage, the cash you can spend and thresholds, the stricter of your hourly floor and the operator's, and your cash date if you give one,
            counting the units other members have already claimed and units bought through earlier bounties for this item that
            are not yet recorded as sold or returned. It is refused if it fails.
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
      ) : v.canClaim ? null : reasons.length ? (
        <ul className="checks">
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
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

/** The line under the alert checks when the shared checks pass but a listed one does not. */
function checksClosing(bounty: Bounty) {
  const fit = bounty.viewer?.fit;
  const lead = "The checks for every member pass and the cap has room, but";
  if (fit && !fit.complete)
    return `${lead} no trip is shown to you as one to make until your transport, carrying limit and room at home are entered in your profile.`;
  if (fit?.partial && fit.maxUnits !== null)
    return `${lead} only ${fit.maxUnits} of the ${fit.units} units fit you: check your own figures for ${plural(fit.maxUnits, "unit")} before you claim.`;
  if (fit && !fit.ok) return `${lead} this trip does not fit you as planned.`;
  return "Not every check above passes.";
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** The latest stock report on its own (a sample bounty, or no count at all). */
function reportText(shelf: Bounty["shelf"]) {
  if (shelf.state === "unknown") return "No stock reports yet";
  if (shelf.state === "seen") return `${plural(shelf.unitsSeen ?? 0, "unit")} seen at ${when(shelf.at)}`;
  return `None on the shelf at ${when(shelf.at)}: claims and alerts paused`;
}

/**
 * The shelf line. A live bounty uses the server's count (shelfUnits): the
 * newest branch check or stock report, less units members bought since, so
 * the line never shows more on the shelf than that count. It says which
 * evidence the count is, and when it is newer than the latest stock report.
 */
function shelfText(bounty: Bounty) {
  const shelf = bounty.shelf;
  const count = bounty.shelfUnits;
  if (bounty.sample || !count || count.source === "sample" || !count.at) return reportText(shelf);
  const word = countWord(count.source);
  const at = when(count.at);
  const by = word === "stock report" ? `in the stock report at ${at}` : `at the branch check at ${at}`;
  const bought = count.boughtSince > 0 ? plural(count.boughtSince, "unit") : null;
  const reportAt = shelf.state !== "unknown" && shelf.at ? Date.parse(shelf.at) : NaN;
  // A report wins a tie with a check, so the same time is the report itself.
  const isReport = Number.isFinite(reportAt) && reportAt === Date.parse(count.at);
  let line: string;
  if (count.units === null) line = `Units not counted ${by}`;
  else if (bought)
    line = `${count.units === 0 ? "None" : plural(count.units, "unit")} likely left: members have bought ${bought} since the ${word} at ${at}`;
  else line = count.units === 0 ? `None on the shelf ${by}` : `${plural(count.units, "unit")} seen ${by}`;
  if (isReport) return shelf.paused ? `${line}: claims and alerts paused` : line;
  if (!Number.isFinite(reportAt)) return line;
  // The count is newer than the latest stock report. A report of none still
  // pauses claims and alerts until someone reports stock again.
  return shelf.paused
    ? `${line}. The latest stock report found none at ${when(shelf.at)}, so claims and alerts stay paused until someone reports stock again`
    : `${line}, newer than the latest stock report (${when(shelf.at)})`;
}

function unitsOnShelf(s: Bounty["pressure"]["sourcing"]) {
  if (s.availableUnits === null) return "units on the shelf not known (no count recorded)";
  const basis = s.unitsSource === "sample" ? "sample figure" : `${s.unitsSource ? countWord(s.unitsSource) : "evidence"} at ${when(s.unitsAt)}`;
  const bought = s.boughtSince ? `, less ${plural(s.boughtSince, "unit")} members have bought since` : "";
  return s.availableUnits === 0
    ? `none on the shelf (${basis}${bought})`
    : `${plural(s.availableUnits, "unit")} on the shelf (${basis}${bought})`;
}

/** "2 recorded as sold and 1 as returned to the shop", or "" when nothing is recorded. */
function releasedText(r: Released | null | undefined) {
  if (!r) return "";
  const parts = [
    r.sold ? `${r.sold} recorded as sold` : "",
    r.returned ? `${r.returned} as returned to the shop` : "",
    r.reconciled ? `${r.reconciled} reconciled by the operator` : "",
  ].filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts.join("");
}

type Releasable = {
  id: number;
  memberId: number;
  memberName: string | null | undefined;
  units: number;
  outstanding: number;
  released?: Released | null;
  endedAt: string | null;
};

/**
 * One purchase whose units still count against the demand for the item:
 * the member who bought them records units sold or returned, and the
 * operator records a reconciliation with a reason. Neither form accepts
 * more than is outstanding; the server checks it again.
 */
function PurchaseRelease({
  claim,
  where,
  acting,
  onDone,
}: {
  claim: Releasable;
  where: string;
  acting: "operator" | "public" | number;
  onDone: (m: string, err?: boolean) => void;
}) {
  const [sold, setSold] = useState("");
  const [returned, setReturned] = useState("");
  const [units, setUnits] = useState("");
  const [reason, setReason] = useState("");
  const mine = typeof acting === "number" && claim.memberId === acting;
  const run = async (fn: () => Promise<{ message: string }>) => {
    try {
      const { message } = await fn();
      // Recorded: empty the boxes so the same units are not sent twice.
      setSold("");
      setReturned("");
      setUnits("");
      setReason("");
      onDone(message);
    } catch (err) {
      onDone((err as Error).message, true);
    }
  };
  // A blank box means none of that kind; anything else must be a whole number.
  const count = (value: string) => (value.trim() === "" ? undefined : Number(value));
  const who = mine ? "You" : (claim.memberName ?? "A member");
  const recorded = releasedText(claim.released);
  const left =
    claim.outstanding === 0
      ? "every unit is recorded as sold, returned or reconciled"
      : `${plural(claim.outstanding, "unit")} not yet recorded as sold or returned`;
  const outstanding = Math.max(1, claim.outstanding);
  return (
    <div className="purchase-release">
      <p>
        {sentences([`${who} bought ${plural(claim.units, "unit")} ${where} on ${when(claim.endedAt)}: ${left}`, recorded ? `So far ${recorded}` : null])}
      </p>
      {mine && claim.outstanding > 0 && (
        <form
          className="release-form"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => api(`claims/${claim.id}/resale`, { memberId: acting, sold: count(sold), returned: count(returned) }));
          }}
        >
          <label>
            Units sold
            <input type="number" min={0} max={outstanding} step={1} inputMode="numeric" value={sold} onChange={(e) => setSold(e.target.value)} />
          </label>
          <label>
            Units returned to the shop
            <input
              type="number"
              min={0}
              max={outstanding}
              step={1}
              inputMode="numeric"
              value={returned}
              onChange={(e) => setReturned(e.target.value)}
            />
          </label>
          <button type="submit">Record sold or returned</button>
        </form>
      )}
      {acting === "operator" && claim.outstanding > 0 && (
        <form
          className="release-form"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => api(`claims/${claim.id}/reconcile`, { viewer: "operator", units: count(units), reason }));
          }}
        >
          <label>
            Units to release
            <input
              type="number"
              min={1}
              max={outstanding}
              step={1}
              inputMode="numeric"
              value={units}
              onChange={(e) => setUnits(e.target.value)}
              required
            />
          </label>
          <label className="wide">
            Reason (kept with the time)
            <input type="text" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} required />
          </label>
          <button type="submit">Record reconciliation</button>
        </form>
      )}
    </div>
  );
}

/**
 * For the operator (round 5b): members holding units of this bounty's item,
 * with the seller name each gave. Their own listings count once only after
 * the operator checks the name against their marketplace profile or one of
 * their listings and confirms it here; until then they count in full.
 */
function SellerNames({ names, onDone }: { names: SellerNameRow[]; onDone: (m: string, err?: boolean) => void }) {
  const run = async (fn: () => Promise<{ message: string }>) => {
    try {
      onDone((await fn()).message);
    } catch (err) {
      onDone((err as Error).message, true);
    }
  };
  return (
    <div className="seller-names">
      <b>Seller names of members holding this item</b>
      <ul>
        {names.map((n) => (
          <li key={n.memberId} data-seller-name={n.confirmed ? "confirmed" : n.sellerName ? "unconfirmed" : "none"}>
            {sentences([
              `${n.name ?? "A member"}: ${n.sellerName ? `"${n.sellerName}"` : "no seller name"}, ${plural(n.outstanding, "unit")} not yet recorded as sold or returned`,
              n.status,
            ])}
            {n.sellerName && (n.confirmed || !n.prior) && (
              <button
                type="button"
                aria-label={`${n.confirmed ? "Withdraw the confirmation of" : "Confirm"} ${n.sellerName} as ${n.name ?? "this member"}'s seller name`}
                onClick={() =>
                  run(() =>
                    api(`members/${n.memberId}/seller-confirmation`, {
                      viewer: "operator",
                      sellerName: n.sellerName,
                      ...(n.confirmed ? { withdraw: true } : {}),
                    }),
                  )
                }
              >
                {n.confirmed ? "Withdraw confirmation" : "Confirm seller name"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Units earlier bounties for the item still have against its resale demand,
 * on the card of the bounty that replaced them: what they are, what the cap
 * would be without them, how they stop counting, and the purchases this
 * viewer can release.
 */
function EarlierUnits({
  earlier,
  acting,
  onDone,
}: {
  earlier: Earlier;
  acting: "operator" | "public" | number;
  onDone: (m: string, err?: boolean) => void;
}) {
  return (
    <section className="earlier" aria-label="Units from earlier bounties for this item">
      <b>Units from earlier bounties for this item</b>
      {earlier.note && <p>{sentence(earlier.note)}</p>}
      {earlier.binding && earlier.capWithout !== null && (
        <p className="muted">Without them the distribution cap would be {plural(earlier.capWithout, "unit")}.</p>
      )}
      {earlier.release && <p className="muted">{sentence(earlier.release)}</p>}
      {earlier.claims.map((c) => (
        <PurchaseRelease key={c.id} claim={c} where={`through bounty ${c.bountyId}`} acting={acting} onDone={onDone} />
      ))}
    </section>
  );
}

function BountyCard({
  bounty,
  acting,
  onChanged,
  onAnswered,
}: {
  bounty: Bounty;
  acting: "operator" | "public" | number;
  onChanged: () => void;
  // A member answered the promotion question on this card.
  onAnswered?: (reply: EligibilityReply) => void;
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
  // Green only for a state that sends someone (tripGo): a "full" trip is go
  // for this viewer only while they hold a claim.
  const go = tripGo(trip, Boolean(bounty.viewer?.activeClaim));
  const validation = bounty.validation;
  // Purchases on this bounty whose units still count against the demand for
  // the item (the operator sees every one, a member their own).
  const bought = bounty.sample ? [] : bounty.claims.filter((c) => c.status === "completed" && (c.outstanding ?? 0) > 0);
  // The earlier bounties' units have their own box, so their cap note is not repeated.
  const showEarlier = Boolean(bounty.earlier) && bounty.status === "open" && !bounty.sample;
  const capNotes = (bounty.capBasis?.notes ?? []).filter((n) => !(showEarlier && n === bounty.earlier?.note));
  return (
    <article className={"bounty" + (bounty.status === "open" ? "" : " closed")}>
      <div className="bounty-head">
        <h3>{bounty.title}</h3>
        <div>
          {bounty.sample && <span className="badge sample">Sample</span>}
          {bounty.placement && <span className="badge sponsored">{bounty.placement}</span>}
          {!bounty.sample && tierBadge(o?.tier ?? null)}
          <span className={"badge " + (go ? "ok" : "warn")}>{trip.label}</span>
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
      {!go && !bounty.sample && trip.headline && bounty.status === "open" && (
        <p className="stop" role="status">
          {trip.headline}
        </p>
      )}
      {go && trip.note && bounty.status === "open" && (
        <p className="go-note" role="status">
          {sentence(trip.note)}
        </p>
      )}
      {validation?.warning && (
        // After a sign-off that stands (caution false) the line is a plain
        // result; otherwise, or when the server does not say, a caution.
        <p className={validation.caution === false ? "validation-result" : "notice prevalidation"}>{validation.warning}</p>
      )}
      {bounty.display.label && <p className="notice">{bounty.display.label}</p>}
      {bounty.promotion?.note && <p className="notice">{bounty.promotion.note}</p>}
      {!bounty.sample && <CategoryLine category={bounty.category} />}
      <dl className="facts">
        <Fact label="Retailer and locality">
          {bounty.retailer ?? "Not shown"}, {bounty.locality}
        </Fact>
        {bounty.barcode && <Fact label="Barcode">{barcodeText(bounty.barcode) + (bounty.variant ? `, ${bounty.variant}` : "")}</Fact>}
        <Fact label="Expires">{when(bounty.expiresAt)}</Fact>
        <Fact label="Distribution cap">{plural(bounty.cap, "unit")}</Fact>
        <Fact label="Claimed now">{plural(bounty.claimedUnits, "unit")}</Fact>
        <Fact label="Bought by members">{plural(bounty.completedUnits, "unit")}</Fact>
        <Fact label="Remaining under the cap">
          {plural(bounty.remaining, "unit")}
          {!go && bounty.status === "open" && bounty.remaining > 0
            ? trip.state === "confirm-cash"
              ? ", and your claim is waiting for the cash you can spend on this trip"
              : trip.state === "confirm-profile"
              ? bounty.viewer?.activeClaim
                ? `, and your claim is waiting until you ${lowerFirst(trip.label)}`
                : `, none claimable by you until you ${lowerFirst(trip.label)}`
              : trip.state === "does-not-fit"
                ? bounty.viewer?.fit?.partial && bounty.viewer.fit.maxUnits !== null
                  ? `; ${bounty.viewer.fit.maxUnits} of the ${bounty.viewer.fit.units} units fit you, so check your own figures for ${plural(bounty.viewer.fit.maxUnits, "unit")} before you claim`
                  : ", none claimable by you as planned: the trip does not fit your transport, carrying limit or storage"
                : ", none claimable while " + trip.label.toLowerCase()
            : ""}
        </Fact>
        <Fact label="Shelf">{shelfText(bounty)}</Fact>
        {bounty.checked && !bounty.sample && checkedText(bounty.checked) && (
          <Fact label="Last checked">{checkedText(bounty.checked)}</Fact>
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
      {capNotes.length ? (
        <ul className="muted cap-notes">
          {capNotes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {showEarlier && bounty.earlier && (
        <EarlierUnits earlier={bounty.earlier} acting={acting} onDone={done} />
      )}
      {bought.length > 0 && (
        <section className="earlier" aria-label="Units bought through this bounty">
          <b>Units bought through this bounty</b>
          <p className="muted">
            Until they are recorded as sold or returned, they count against the demand for this item on any later bounty for it.
          </p>
          {bought.map((c) => (
            <PurchaseRelease
              key={c.id}
              claim={{ ...c, outstanding: c.outstanding ?? 0 }}
              where="through this bounty"
              acting={acting}
              onDone={done}
            />
          ))}
        </section>
      )}

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
          ) : (bounty.estimate?.checks ?? []).some((c) => !c.ok) ? (
            // A member's own fit checks are in the list above: "every check
            // passes" only when every listed check does.
            <p className="warn">{checksClosing(bounty)}</p>
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

      {typeof acting === "number" && bounty.status === "open" && (
        <ClaimPanel bounty={bounty} memberId={acting} onDone={done} onAnswered={onAnswered} />
      )}

      {isOperator && (
        <div className="operator">
          {bounty.sellerNames && bounty.sellerNames.length > 0 && <SellerNames names={bounty.sellerNames} onDone={done} />}
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
                        res.sent.length || res.asked?.length || res.confirm?.length
                          ? [
                              res.sent.length ? `Alerted ${plural(res.sent.length, "member")}.` : "",
                              res.asked?.length ? `Asked ${plural(res.asked.length, "member")} whether they qualify for the price.` : "",
                              res.confirm?.length
                                ? `Asked ${plural(res.confirm.length, "member")} to confirm their transport, carrying limit and storage.`
                                : "",
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
              {dispatch.confirm && dispatch.confirm.length > 0 && (
                <ul className="checks">
                  {dispatch.confirm.map((q) => (
                    <li key={q.memberId}>
                      {q.name}: asked to confirm their transport, carrying limit and storage, with no figures until they do
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
          {alerts.map((a) =>
            a.kind === "declined" ? (
              // The member's answer says the bounty is not for them: no
              // figures or offer details, only the answer and the undo link.
              <li key={a.id} className="declined">
                <b>{a.title}</b> {a.retailer ? `at ${a.retailer}, ` : "in "}
                {a.locality}
                <span className="badge">Not for you</span>
                {a.eligibility ? (
                  <NotForYou bountyId={a.bountyId} memberId={memberId} eligibility={a.eligibility} onDone={answered} />
                ) : (
                  a.questionNote && <small className="muted">{a.questionNote}</small>
                )}
                <NoticeList notices={a.notices} />
                <small className="muted">
                  {when(a.created)}, {a.label}
                  {a.tier ? ` (${a.tier.name})` : ""}
                </small>
              </li>
            ) : (
              <li key={a.id}>
                <b>{a.title}</b> {a.retailer ? `at ${a.retailer}, ` : "in "}
                {a.locality}
                {a.sponsored && <span className="badge sponsored">Sponsored by {a.sponsor}</span>}
                <span className={"badge " + (tripGo(a.trip) ? "ok" : "warn")}>{a.trip.label}</span>
                {a.kind === "question" && <span className="badge warn">Question about the price</span>}
                {a.kind === "profile" && !a.profile?.complete && <span className="badge warn">Confirm your profile first</span>}
                {a.trip.headline && !tripGo(a.trip) && <span className="stop">{a.trip.headline}</span>}
                {tripGo(a.trip) && a.trip.note && <span className="go-note">{sentence(a.trip.note)}</span>}
                {a.eligibility && !a.eligibility.confirmed && !a.eligibility.declined ? (
                  <EligibilityQuestion bountyId={a.bountyId} memberId={memberId} eligibility={a.eligibility} onDone={answered} />
                ) : (
                  a.questionNote && <small className="muted">{a.questionNote}</small>
                )}
                {a.figures?.label && (
                  <small className="muted">
                    {a.figures.label} Profit per unit {cash(a.figures.unitProfit)}.
                  </small>
                )}
                {a.promotion && <small className="muted">{a.promotion.note}</small>}
                {checkedText(a.checked) && <small className="muted">Last checked: {checkedText(a.checked)}</small>}
                {a.mainUncertainty && <small className="muted">Main uncertainty: {sentence(a.mainUncertainty)}</small>}
                {a.category?.applied && (
                  <small className="muted">
                    {a.category.warning
                      ? `Category: ${a.category.applied}. ${sentence(a.category.warning)}`
                      : `Costed under the ${a.category.applied.toLowerCase()} rules.`}
                  </small>
                )}
                {a.attributes?.map((n) => (
                  <small key={n.key} className="muted">
                    {sentence(n.text)}
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
                  {a.kind === "question" || a.kind === "profile" ? "Asked" : "Alerted"} {when(a.created)}, {a.label}
                  {a.tier ? ` (${a.tier.name})` : ""}
                </small>
              </li>
            ),
          )}
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
  // A page-level notice, for example after a real bounty is created and its
  // form closes.
  const [pageNote, setPageNote] = useState("");
  // Cards a member just said are not for them. A first-order bounty is then
  // no longer listed for them, but the card stays on this page (where it
  // was) so they can read why and undo an answer given by mistake.
  const [kept, setKept] = useState<{ bounty: Bounty; index: number }[]>([]);

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
    setKept([]);
    setPageNote("");
    writeStorage(ACTING_KEY, String(value));
  }
  function answered(reply: EligibilityReply) {
    const fresh = reply.bounty;
    if (!fresh) return;
    setKept((list) => {
      const others = list.filter((k) => k.bounty.id !== fresh.id);
      if (!fresh.viewer?.eligibility?.declined) return others;
      const index = bounties?.findIndex((b) => b.id === fresh.id) ?? -1;
      return [...others, { bounty: fresh, index: index < 0 ? (bounties?.length ?? 0) : index }];
    });
  }
  // The listed bounties, with any kept card back where it was.
  const shown = (() => {
    if (!bounties) return null;
    const list = [...bounties];
    for (const k of [...kept].sort((a, b) => a.index - b.index))
      if (!list.some((b) => b.id === k.bounty.id)) list.splice(Math.min(k.index, list.length), 0, k.bounty);
    return list;
  })();
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
          <button
            type="button"
            onClick={() => {
              setShowCreate((s) => !s);
              setPageNote("");
            }}
          >
            {showCreate ? "Close" : "Create a bounty"}
          </button>
        )}
      </div>
      {pageNote && (
        <p className="notice" role="status">
          {pageNote}
        </p>
      )}

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
            onCreated={(message, real) => {
              if (real) {
                setShowCreate(false);
                setPageNote(message);
              }
              load();
            }}
          />
        </article>
      )}

      <h2>Bounties</h2>
      {acting !== "operator" && typeof acting !== "number" && (
        <p className="muted">Choose a member under "Acting as" to claim or report, or the operator view to verify and send alerts.</p>
      )}
      {shown === null ? (
        <p className="muted">Loading.</p>
      ) : shown.length === 0 ? (
        <p className="muted">No bounties yet.</p>
      ) : (
        shown.map((b) => (
          <BountyCard key={b.id + ":" + viewer} bounty={b} acting={acting} onChanged={load} onAnswered={answered} />
        ))
      )}
    </section>
  );
}
