// Bounties and membership (PRD journeys 5 and 6).
//
// A bounty shares one checked buy-and-resell opportunity with members without
// flooding the shelf or the resale market. Every bounty is buy and resell:
// the member buys and owns the stock and carries the risk, and a bounty never
// pays a reward. Accurate stock reports, including reports that the shelf was
// empty, earn reputation points.
//
// Distribution is capped by the units available and by the resale demand
// left after competing listings. A claim reserves a member's attention on a
// bounty, never stock at the retailer. Alerts go out in release windows: paid
// or earned early access tiers (MEMBERSHIP_TIERS in opportunity.mjs) are
// alerted first, and the exposure limit stops alerts once the stock-sized cap
// is used, so with little stock the later tiers receive nothing.
//
// Members are local profiles. This single-user pilot has no accounts or
// authentication, so the "acting as" member and the operator view are chosen
// by whoever uses this computer. Privacy rules here (notes and photos only for
// their author and the operator) are not secure until accounts exist.
//
// Money is integer pence and times are ISO 8601 UTC strings. Every function
// that decides something takes `now` so tests can inject the clock.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addMissingColumns } from "./contract.mjs";
import { ALERT_RULES, ageDays } from "./alerts.mjs";
import {
  CATEGORY_RULES,
  MEMBERSHIP_TIERS,
  OPPORTUNITY_RULES,
  PAID_TIER_IDS,
  accessTier,
  effectiveRules,
  meetsReturn,
  membershipTier,
} from "./opportunity.mjs";
import { AUDIT_TARGET, CHECK_VALID_DAYS, latestCheck, progress as auditProgress } from "./audit.mjs";
import { HAND_CARRY_KG, accessNeeds } from "./catalog.mjs";
import { normaliseBarcode, sellerName } from "./matching.mjs";
import { displayPermitted } from "./evidence.mjs";
import { stripMetadata } from "./metadata.mjs";
import { bool, fail, int, isoDate, num, oneOf, text, transaction } from "./http.mjs";

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const BOUNTY_RULES = Object.freeze({
  maxDays: 14, // a bounty expires at most 14 days after it opens
  claimHours: 3, // a claim lapses after 3 hours unless released or completed
  // A claim is at most a trial batch: a first purchase of an item stays small
  // until a verified trade (purchase receipt and payout record) exists.
  maxClaimUnits: OPPORTUNITY_RULES.trialUnits,
  exposurePerUnit: 2, // at most 2 alerts in total per remaining capped unit
  recentReportHours: 24, // positive reports this recent count as sourcing pressure
  reportMaxAgeHours: 48, // a stock report must describe the last 48 hours
  saleWindowDays: ALERT_RULES.maxSaleAgeDays, // confirmed sales cover 90 days
  maxSellWindowWeeks: 12,
  maxAvailableUnits: 1000,
  maxSalesPerWeek: 10000,
});

// Reputation is earned only. A verified accurate report earns the same points
// whether it found stock or an empty shelf; an inaccurate one earns nothing.
// Only one report per member per bounty per UTC day is rewarded, so repeating
// a report of the same shelf cannot farm points. Paid tiers never change it.
export const REPUTATION_RULES = Object.freeze({
  accurateReport: 10,
  rewardedReportsPerBountyPerDay: 1,
});

export const PHOTO_RULES = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  mediaTypes: Object.freeze(["image/jpeg", "image/png"]),
});

// Copy the API returns with bounty and member views, so the interface and any
// other client say the same thing.
export const TERMS = Object.freeze({
  buyAndResell:
    "Every bounty is buy and resell: you buy and own the stock and carry the risk. A bounty never pays a reward.",
  reputation:
    "Accurate stock reports earn reputation points, including reports that the shelf was empty. Reputation is earned only and is never bought.",
  claim:
    "A claim reserves your attention on this bounty, not stock at the retailer: the shelf may be empty when you arrive.",
  photo:
    "A shelf photo supports a stock report. Location and camera details are removed on upload. A photo is never proof of a purchase or of profit.",
  paid:
    "Paid early access is a paid timing benefit: earlier alerts and claims. It never adds reputation points.",
  privacy:
    "Accounts are not authenticated yet: anyone using this computer can act as any member or as the operator. Report notes and photos are shown only to their author and the operator view, but that is not secure until accounts exist.",
  billing: "Paid status is recorded by the operator. Membership billing is not built yet.",
  alerts: "Alerts are recorded here for each member. Nothing is sent by email or text yet.",
  verified:
    "A trade counts as verified only with both the purchase receipt and the payout record in the Ledger.",
  sample:
    "Sample bounty: the figures are illustrative, entered by hand, and describe no real offer. Nothing here can be claimed or bought, and it never sends an alert.",
  promotion:
    "Promotion and loyalty prices depend on the person buying. The operator's check covers only the operator: each member confirms for themselves that they qualify before claiming.",
  eligibility:
    "This price is only for people who qualify. Until you say you qualify you are not alerted and the figures stay hidden, because without the offer you would pay more.",
  journey:
    "The figures on a bounty use the operator's return journey. Enter your own journey cost and time when you claim: the server works your figures out again for your units and refuses the claim if they fail.",
  stop: "Don't make the trip",
  hidden:
    "The source of this offer does not permit display, so its title, retailer, prices and sale figures are not shown.",
  times: "Times are UK time (London).",
});

// ---------------------------------------------------------------- schema

const TABLES = [
  {
    name: "members",
    sql: `CREATE TABLE IF NOT EXISTS members (
 id INTEGER PRIMARY KEY,
 name TEXT NOT NULL,
 locality TEXT,
 paid_tier TEXT,
 paid_until TEXT,
 alerts_opt_in INTEGER NOT NULL DEFAULT 0,
 alert_localities TEXT NOT NULL DEFAULT '[]',
 rules TEXT NOT NULL DEFAULT '{}',
 created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
    columns: [
      "id", "name", "locality", "paid_tier", "paid_until", "alerts_opt_in", "alert_localities", "rules", "created",
    ],
    types: {
      alerts_opt_in: "INTEGER NOT NULL DEFAULT 0",
      alert_localities: "TEXT NOT NULL DEFAULT '[]'",
      rules: "TEXT NOT NULL DEFAULT '{}'",
    },
  },
  {
    name: "bounties",
    sql: `CREATE TABLE IF NOT EXISTS bounties (
 id INTEGER PRIMARY KEY,
 title TEXT NOT NULL,
 barcode TEXT,
 variant TEXT,
 retailer TEXT NOT NULL,
 locality TEXT NOT NULL,
 available_units INTEGER NOT NULL,
 sales_per_week REAL NOT NULL,
 sell_window_weeks REAL NOT NULL,
 competing_listings INTEGER,
 competing_sellers INTEGER,
 cap INTEGER NOT NULL DEFAULT 0,
 cap_basis TEXT,
 expires_at TEXT NOT NULL,
 sponsored INTEGER NOT NULL DEFAULT 0,
 sponsor TEXT,
 sample INTEGER NOT NULL DEFAULT 0,
 alert_eligible INTEGER NOT NULL DEFAULT 0,
 alert_reasons TEXT NOT NULL DEFAULT '[]',
 opportunity_tier TEXT,
 opportunity TEXT,
 estimate TEXT,
 checked_at TEXT,
 status TEXT NOT NULL DEFAULT 'open',
 created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 withdrawn_at TEXT
)`,
    columns: [
      "id", "title", "barcode", "variant", "retailer", "locality", "available_units",
      "sales_per_week", "sell_window_weeks", "competing_listings", "competing_sellers",
      "cap", "cap_basis", "expires_at", "sponsored", "sponsor", "sample", "alert_eligible",
      "alert_reasons", "opportunity_tier", "opportunity", "estimate", "checked_at",
      "status", "created", "withdrawn_at",
    ],
    types: {
      available_units: "INTEGER NOT NULL DEFAULT 0",
      sales_per_week: "REAL NOT NULL DEFAULT 0",
      sell_window_weeks: "REAL NOT NULL DEFAULT 0",
      competing_listings: "INTEGER",
      competing_sellers: "INTEGER",
      cap: "INTEGER NOT NULL DEFAULT 0",
      expires_at: "TEXT NOT NULL DEFAULT ''",
      sponsored: "INTEGER NOT NULL DEFAULT 0",
      sample: "INTEGER NOT NULL DEFAULT 0",
      alert_eligible: "INTEGER NOT NULL DEFAULT 0",
      alert_reasons: "TEXT NOT NULL DEFAULT '[]'",
      status: "TEXT NOT NULL DEFAULT 'open'",
    },
  },
  {
    name: "claims",
    sql: `CREATE TABLE IF NOT EXISTS claims (
 id INTEGER PRIMARY KEY,
 bounty_id INTEGER NOT NULL REFERENCES bounties(id),
 member_id INTEGER NOT NULL REFERENCES members(id),
 units INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'active',
 created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at TEXT NOT NULL,
 ended_at TEXT,
 promotion TEXT,
 promotion_confirmed INTEGER NOT NULL DEFAULT 0,
 journey_cost INTEGER,
 journey_minutes INTEGER,
 figures TEXT
)`,
    columns: [
      "id", "bounty_id", "member_id", "units", "status", "created", "expires_at", "ended_at", "promotion",
      "promotion_confirmed", "journey_cost", "journey_minutes", "figures",
    ],
    types: {
      bounty_id: "INTEGER",
      member_id: "INTEGER",
      units: "INTEGER NOT NULL DEFAULT 0",
      status: "TEXT NOT NULL DEFAULT 'active'",
      expires_at: "TEXT NOT NULL DEFAULT ''",
      promotion_confirmed: "INTEGER NOT NULL DEFAULT 0",
      journey_cost: "INTEGER",
      journey_minutes: "INTEGER",
    },
  },
  {
    name: "stock_reports",
    sql: `CREATE TABLE IF NOT EXISTS stock_reports (
 id INTEGER PRIMARY KEY,
 bounty_id INTEGER NOT NULL REFERENCES bounties(id),
 member_id INTEGER NOT NULL REFERENCES members(id),
 units_seen INTEGER NOT NULL,
 observed_at TEXT NOT NULL,
 note TEXT,
 photo_sha256 TEXT,
 photo_bytes INTEGER,
 photo_media_type TEXT,
 verified TEXT,
 verified_at TEXT,
 created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
    columns: [
      "id", "bounty_id", "member_id", "units_seen", "observed_at", "note", "photo_sha256",
      "photo_bytes", "photo_media_type", "verified", "verified_at", "created",
    ],
    types: {
      bounty_id: "INTEGER",
      member_id: "INTEGER",
      units_seen: "INTEGER NOT NULL DEFAULT 0",
      observed_at: "TEXT NOT NULL DEFAULT ''",
      photo_bytes: "INTEGER",
    },
  },
  {
    name: "reputation_events",
    sql: `CREATE TABLE IF NOT EXISTS reputation_events (
 id INTEGER PRIMARY KEY,
 member_id INTEGER NOT NULL REFERENCES members(id),
 report_id INTEGER REFERENCES stock_reports(id),
 points INTEGER NOT NULL,
 reason TEXT NOT NULL,
 created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
    columns: ["id", "member_id", "report_id", "points", "reason", "created"],
    types: {
      member_id: "INTEGER",
      report_id: "INTEGER",
      points: "INTEGER NOT NULL DEFAULT 0",
      reason: "TEXT NOT NULL DEFAULT ''",
    },
  },
  {
    // kind "alert" tells a member about a bounty with its figures. kind
    // "question" asks a member whether they qualify for a promotion price
    // first, and carries no figures (it becomes an alert once they say yes).
    name: "alerts",
    sql: `CREATE TABLE IF NOT EXISTS alerts (
 id INTEGER PRIMARY KEY,
 bounty_id INTEGER NOT NULL REFERENCES bounties(id),
 member_id INTEGER NOT NULL REFERENCES members(id),
 tier TEXT NOT NULL,
 via TEXT NOT NULL,
 release_at TEXT NOT NULL,
 reputation INTEGER NOT NULL DEFAULT 0,
 promotion TEXT,
 warning TEXT,
 kind TEXT NOT NULL DEFAULT 'alert',
 created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(bounty_id, member_id)
)`,
    columns: [
      "id", "bounty_id", "member_id", "tier", "via", "release_at", "reputation", "promotion", "warning", "kind",
      "created",
    ],
    types: {
      bounty_id: "INTEGER",
      member_id: "INTEGER",
      tier: "TEXT NOT NULL DEFAULT 'new'",
      via: "TEXT NOT NULL DEFAULT 'earned'",
      release_at: "TEXT NOT NULL DEFAULT ''",
      reputation: "INTEGER NOT NULL DEFAULT 0",
      kind: "TEXT NOT NULL DEFAULT 'alert'",
    },
  },
  {
    // Notices: kind "stop" ("Don't make the trip"), one per member per event
    // (ref), sent to every member alerted for a bounty or holding a live
    // claim on it when the trip stops (an empty shelf, a branch check that
    // finds none, a price rise, lapsed evidence, a withdrawal). kind
    // "reopen" says the bounty is open again; the stop notices it replaces
    // get superseded_at.
    name: "notices",
    sql: `CREATE TABLE IF NOT EXISTS notices (
 id INTEGER PRIMARY KEY,
 bounty_id INTEGER NOT NULL REFERENCES bounties(id),
 member_id INTEGER NOT NULL REFERENCES members(id),
 kind TEXT NOT NULL DEFAULT 'stop',
 reason TEXT NOT NULL,
 ref TEXT NOT NULL,
 message TEXT NOT NULL,
 created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 superseded_at TEXT,
 UNIQUE(bounty_id, member_id, ref)
)`,
    columns: ["id", "bounty_id", "member_id", "kind", "reason", "ref", "message", "created", "superseded_at"],
    types: {
      bounty_id: "INTEGER",
      member_id: "INTEGER",
      kind: "TEXT NOT NULL DEFAULT 'stop'",
      reason: "TEXT NOT NULL DEFAULT ''",
      ref: "TEXT NOT NULL DEFAULT ''",
      message: "TEXT NOT NULL DEFAULT ''",
    },
  },
  {
    // A member's answer to "do you qualify for this promotion price?":
    // "qualifies", "not", or "used" (they have already used a first-order
    // or new-customer offer at this retailer, so such offers there are
    // never alerted to them again). retailer is normalised.
    name: "promotion_answers",
    sql: `CREATE TABLE IF NOT EXISTS promotion_answers (
 id INTEGER PRIMARY KEY,
 member_id INTEGER NOT NULL REFERENCES members(id),
 bounty_id INTEGER NOT NULL REFERENCES bounties(id),
 retailer TEXT NOT NULL,
 condition TEXT NOT NULL,
 first_order INTEGER NOT NULL DEFAULT 0,
 answer TEXT NOT NULL,
 created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(member_id, bounty_id)
)`,
    columns: ["id", "member_id", "bounty_id", "retailer", "condition", "first_order", "answer", "created"],
    types: {
      member_id: "INTEGER",
      bounty_id: "INTEGER",
      retailer: "TEXT NOT NULL DEFAULT ''",
      condition: "TEXT NOT NULL DEFAULT ''",
      first_order: "INTEGER NOT NULL DEFAULT 0",
      answer: "TEXT NOT NULL DEFAULT ''",
    },
  },
];

/**
 * Creates the bounty and membership tables. Idempotent: an older local
 * database gains any missing column in place and keeps its rows.
 */
export function schema(db) {
  for (const table of TABLES) {
    db.exec(table.sql);
    addMissingColumns(db, table.name, table.columns, { created: "TEXT", ...table.types });
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS claims_one_active
 ON claims(bounty_id, member_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS claims_bounty ON claims(bounty_id, status);
CREATE INDEX IF NOT EXISTS stock_reports_bounty ON stock_reports(bounty_id, observed_at);
CREATE UNIQUE INDEX IF NOT EXISTS reputation_one_per_report
 ON reputation_events(report_id) WHERE report_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS reputation_member ON reputation_events(member_id);
CREATE INDEX IF NOT EXISTS alerts_member ON alerts(member_id, created);
CREATE INDEX IF NOT EXISTS notices_member ON notices(member_id, created);
CREATE INDEX IF NOT EXISTS notices_bounty ON notices(bounty_id, kind, superseded_at);
CREATE INDEX IF NOT EXISTS promotion_answers_member ON promotion_answers(member_id, retailer);
CREATE INDEX IF NOT EXISTS bounties_barcode ON bounties(barcode, status);`);
}

// --------------------------------------------------------------- helpers

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const iso = (ms) => new Date(ms).toISOString();
const plain = (row) => (row ? { ...row } : null);
const round2 = (v) => Math.round(v * 100) / 100;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isPositive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
const pounds = (pence) => "£" + (pence / 100).toFixed(2);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
// Share as a percentage to one decimal place, rounded down (34.96% is 34.9%).
const percentDown = (share) => (Math.floor(share * 1000 + 1e-9) / 10).toLocaleString("en-GB") + "%";

const LONDON = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
/** A date and time for people, in UK time: "31 Oct 2026, 14:05". */
export function humanTime(value) {
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? LONDON.format(new Date(ms)) : "an unknown time";
}

const LONDON_DATE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "numeric",
  month: "short",
  year: "numeric",
});
/**
 * A date for people, in UK time: "30 Oct 2026". A calendar date
 * (YYYY-MM-DD) is shown as written; a date and time is shown as its date in
 * London.
 */
export function humanDate(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const ms = Date.parse(value + "T12:00:00Z");
    return Number.isFinite(ms) ? LONDON_DATE.format(new Date(ms)) : "an unknown date";
  }
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? LONDON_DATE.format(new Date(ms)) : "an unknown date";
}

const LONDON_HOUR = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hourCycle: "h23" });
/**
 * The instant a UK calendar date ends (midnight in London at the start of
 * the next day): UTC midnight in winter, 23:00 UTC during British Summer
 * Time. Clocks change at 01:00 UTC, never at midnight, so one probe works.
 */
export function londonDayEnd(date) {
  const [y, m, d] = date.split("-").map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d + 1);
  const offsetHours = Number(LONDON_HOUR.format(new Date(utcMidnight))) === 1 ? 1 : 0;
  return new Date(utcMidnight - offsetHours * 3600000).toISOString();
}

const tableExists = (db, name) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

/** Milliseconds for the injected clock; a bad clock is a programming error. */
function clock(now) {
  const ms = typeof now === "string" ? Date.parse(now) : NaN;
  if (!Number.isFinite(ms)) throw Error("now must be an ISO date and time");
  return ms;
}

/** A client-supplied date and time, as milliseconds. */
function instant(value, name) {
  const ms = typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) fail(`${name} must be a date and time`);
  return ms;
}

function json(value, fallback) {
  try {
    return value === null || value === undefined ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Localities (and retailers) compare without case or repeated spaces.
 * Anything that is not text is no place at all: it is never converted with
 * String(), so an object sent as a locality cannot throw.
 */
export const normaliseLocality = (value) =>
  (typeof value === "string" ? value : "").trim().replace(/\s+/g, " ").toLowerCase();

const id = (value, name) => int(value, name, 1, Number.MAX_SAFE_INTEGER);

// ------------------------------------------------------------ membership

/** Paid access runs to the end of the paid-until date in the UK. */
const paidUntilInstant = (date) => (date ? londonDayEnd(date) : null);

const tierSummary = (tier) =>
  tier ? { id: tier.id, name: tier.name, offsetMinutes: tier.offsetMinutes, earnPoints: tier.earnPoints } : null;

// The tiers as configured in opportunity.mjs (names, windows and point
// thresholds are still open decisions, so the interface reads them from here).
export const MEMBERSHIP = Object.freeze({
  tiers: MEMBERSHIP_TIERS.map(tierSummary),
  paidTierIds: PAID_TIER_IDS,
});

/** Sum of earned reputation points. Paid tiers never enter it. */
export function reputation(db, memberId) {
  return (
    db.prepare("SELECT COALESCE(SUM(points), 0) AS points FROM reputation_events WHERE member_id = ?").get(memberId)
      .points ?? 0
  );
}

/** The next tier that more earned points would unlock, or null at the top. */
function nextEarned(points) {
  const higher = MEMBERSHIP_TIERS.filter((t) => t.earnPoints !== null && t.earnPoints > points);
  const next = higher[higher.length - 1];
  return next ? { ...tierSummary(next), pointsNeeded: next.earnPoints - points } : null;
}

/**
 * Release position for a member row: accessTier from opportunity.mjs with the
 * member's paid tier (only while current) and earned reputation.
 */
export function memberAccess(db, member, now) {
  const points = reputation(db, member.id);
  const access = accessTier({
    paidTier: member.paid_tier,
    paidUntil: paidUntilInstant(member.paid_until),
    reputation: points,
    now,
  });
  return { points, ...access };
}

function localityList(value) {
  if (!Array.isArray(value) || value.length > 10)
    fail("alertLocalities must be a list of up to 10 localities");
  const seen = new Map();
  value.forEach((v, i) => {
    const place = text(v, `alertLocalities[${i}]`, 120);
    if (!seen.has(normaliseLocality(place))) seen.set(normaliseLocality(place), place);
  });
  return [...seen.values()];
}

// Thresholds a member may tighten for themselves, in API units: pence for
// money, kilograms, a share of the purchase price for the return, units.
const RULE_INPUTS = Object.freeze({
  minUnitPrice: { label: "Lowest purchase price per unit", check: (v, n) => int(v, n, 0, 10_000_000), show: pounds },
  maxUnitPrice: { label: "Highest purchase price per unit", check: (v, n) => int(v, n, 0, 10_000_000), show: pounds },
  maxWeightKg: { label: "Weight limit per unit", check: (v, n) => num(v, n, 0, 1000), show: (v) => v + " kg" },
  minUnitProfit: { label: "Lowest profit per unit", check: (v, n) => int(v, n, 0, 10_000_000), show: pounds },
  minReturn: { label: "Lowest return on purchase price", check: (v, n) => num(v, n, 0, 100), show: percentDown },
  trialUnits: { label: "Trial batch", check: (v, n) => int(v, n, 1, 100), show: (v) => v + " units" },
});
export const MEMBER_RULE_KEYS = Object.freeze(Object.keys(RULE_INPUTS));

/**
 * A member's stricter thresholds from a request. Each value must be at
 * least as strict as the agreed threshold (effectiveRules keeps only
 * stricter overrides, so a looser value is refused here rather than
 * silently dropped). Values equal to the agreed thresholds are not stored.
 */
function memberRulesInput(value) {
  if (value === null) return {};
  if (!isObject(value)) fail("rules must be an object of stricter thresholds");
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    // Own keys only: "toString", "valueOf", "constructor" or "__proto__"
    // must be a 400, never something inherited from Object.prototype.
    if (!Object.hasOwn(RULE_INPUTS, key))
      fail(`rules.${key} is not a threshold a member can set: use ${MEMBER_RULE_KEYS.join(", ")}`);
    const spec = RULE_INPUTS[key];
    if (raw === null || raw === undefined || raw === "") continue;
    const v = spec.check(raw, `rules.${key}`);
    if (effectiveRules({ [key]: v })[key] !== v)
      fail(
        `${spec.label} of ${spec.show(v)} would loosen the agreed ${spec.show(OPPORTUNITY_RULES[key])}: you can tighten the thresholds for yourself but never loosen them`,
      );
    if (v !== OPPORTUNITY_RULES[key]) out[key] = v;
  }
  const rules = effectiveRules(out);
  if (rules.minUnitPrice > rules.maxUnitPrice)
    fail("The lowest purchase price per unit must not be above the highest");
  return out;
}

/** The member's stored stricter thresholds (raw overrides). */
export const memberRules = (member) => {
  const saved = json(member?.rules, {});
  return isObject(saved) ? saved : {};
};

function memberFields(body, current) {
  if (!isObject(body)) fail("Send a member as a JSON object");
  const has = (k) => Object.hasOwn(body, k);
  const next = current
    ? { ...current, alert_localities: json(current.alert_localities, []), rules: memberRules(current) }
    : {
        name: null, locality: null, paid_tier: null, paid_until: null, alerts_opt_in: 0, alert_localities: [],
        rules: {},
      };
  if (has("rules")) next.rules = memberRulesInput(body.rules);
  if (!current || has("name")) next.name = text(body.name, "name", 80);
  if (has("locality")) next.locality = text(body.locality, "locality", 120, { optional: true });
  if (has("alertsOptIn")) next.alerts_opt_in = bool(body.alertsOptIn, "alertsOptIn") ? 1 : 0;
  if (has("alertLocalities")) next.alert_localities = localityList(body.alertLocalities);
  if (has("paidTier"))
    next.paid_tier =
      body.paidTier === null || body.paidTier === ""
        ? null
        : oneOf(body.paidTier, "paidTier", PAID_TIER_IDS);
  if (has("paidUntil")) {
    next.paid_until = isoDate(body.paidUntil, "paidUntil", { optional: true });
    if (next.paid_until && !next.paid_tier) fail("paidUntil needs a paidTier");
  }
  if (!next.paid_tier) next.paid_until = null;
  return next;
}

const getMember = (db, memberId) =>
  plain(db.prepare("SELECT * FROM members WHERE id = ?").get(memberId));

/** The member row, or a 404. */
export function requireMember(db, memberId) {
  return getMember(db, id(memberId, "memberId")) ?? fail("Member not found", 404);
}

/**
 * A member as the API shows it. Paid status and earned status are separate
 * objects with their own labels; release is the earlier of the two.
 */
export function memberView(db, member, { now }) {
  const access = memberAccess(db, member, now);
  return {
    id: member.id,
    name: member.name,
    locality: member.locality,
    alertsOptIn: member.alerts_opt_in === 1,
    alertLocalities: json(member.alert_localities, []),
    // Stricter thresholds this member set for their own alerts and claims
    // (API units), and the thresholds that result.
    rules: memberRules(member),
    effectiveRules: pick(effectiveRules(memberRules(member)), MEMBER_RULE_KEYS),
    created: member.created,
    paid: {
      label: "Paid early access",
      tier: tierSummary(membershipTier(member.paid_tier)),
      // until is the form value (YYYY-MM-DD); untilLabel is for people.
      until: member.paid_until,
      untilLabel: member.paid_until ? humanDate(member.paid_until) : null,
      endsAt: paidUntilInstant(member.paid_until),
      current: Boolean(access.paid),
      note: TERMS.billing,
    },
    earned: {
      label: "Earned reputation",
      points: access.points,
      tier: tierSummary(access.earned),
      next: nextEarned(access.points),
    },
    release: {
      tier: tierSummary(access.tier),
      via: access.via,
      offsetMinutes: access.tier.offsetMinutes,
    },
  };
}

/** Creates a local member profile. Alerts are off until the member opts in. */
export function createMember(db, body, { now }) {
  clock(now);
  const m = memberFields(body, null);
  const result = db
    .prepare(
      `INSERT INTO members(name, locality, paid_tier, paid_until, alerts_opt_in, alert_localities, rules, created)
 VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.name, m.locality, m.paid_tier, m.paid_until, m.alerts_opt_in, JSON.stringify(m.alert_localities),
      JSON.stringify(m.rules), now,
    );
  return getMember(db, Number(result.lastInsertRowid));
}

/** Updates name, locality, alert opt-in and localities, stricter thresholds or the paid tier. */
export function updateMember(db, memberId, body, { now }) {
  clock(now);
  const current = requireMember(db, memberId);
  const m = memberFields(body, current);
  db.prepare(
    `UPDATE members SET name = ?, locality = ?, paid_tier = ?, paid_until = ?, alerts_opt_in = ?, alert_localities = ?,
 rules = ? WHERE id = ?`,
  ).run(
    m.name, m.locality, m.paid_tier, m.paid_until, m.alerts_opt_in, JSON.stringify(m.alert_localities),
    JSON.stringify(m.rules), current.id,
  );
  return getMember(db, current.id);
}

export const listMembers = (db) =>
  db.prepare("SELECT * FROM members ORDER BY name COLLATE NOCASE, id").all().map(plain);

// ------------------------------------------------------- distribution cap

/**
 * How many units a bounty may share out:
 *   min(availableUnits, max(0, floor(salesPerWeek * sellWindowWeeks) - competingListings))
 * so distribution is capped by the units on the shelf and by the resale
 * demand left after competing sellers' listings. Any unknown or invalid input
 * gives 0 (fail closed).
 */
export function distributionCap({ availableUnits, salesPerWeek, sellWindowWeeks, competingListings } = {}) {
  if (!isCount(availableUnits) || !isPositive(salesPerWeek) || !isPositive(sellWindowWeeks) || !isCount(competingListings))
    return 0;
  const demand = Math.floor(salesPerWeek * sellWindowWeeks + 1e-9);
  return Math.min(availableUnits, Math.max(0, demand - competingListings));
}

/**
 * Sales a week evidenced by the confirmed completed-sale sample, spread over
 * the whole sale window (90 days). This understates a recent burst, which
 * keeps the cap cautious. Null when the sample count is unknown.
 */
export function evidencedSalesPerWeek(count) {
  return isCount(count) ? (count * 7) / BOUNTY_RULES.saleWindowDays : null;
}

/**
 * Units on the shelf according to the stock check the estimate used: the
 * units seen when the check found stock, 0 when it found none, null when no
 * check or no count is recorded.
 */
function evidencedUnits(stock) {
  const check = stock?.check;
  if (!check) return null;
  if (check.in_stock !== 1) return 0;
  return Number.isSafeInteger(check.units_seen) && check.units_seen > 0 ? check.units_seen : null;
}

/**
 * A recorded asking-price lookup for the barcode, { provider, fetched } or
 * null: from options (the route checks the lookup cache) or from the
 * estimate's competition when it carries one.
 */
function lookupOf(estimate, lookup) {
  const given = lookup ?? estimate?.competition?.lookup ?? null;
  return isObject(given) && typeof given.fetched === "string" && Number.isFinite(Date.parse(given.fetched))
    ? { provider: String(given.provider ?? "unknown"), fetched: given.fetched }
    : null;
}

/**
 * The figures behind a live bounty's cap. Units on the shelf come only from
 * the evidence (the latest stock check's count); the operator's entry can
 * only lower them, and a form figure never stands in for a count. Sales a
 * week are the confirmed sales rate, lowered further by the operator's
 * entry. Competing listings come from the estimate's resale competition.
 * No listings with no recorded asking-price lookup means nobody looked, so
 * competition is unknown, never zero. Unknown evidence fails closed (cap 0).
 */
function capBasis(entered, estimate, lookup = null) {
  const units = evidencedUnits(estimate.stock);
  const rate = evidencedSalesPerWeek(estimate.sample?.count);
  const listings = estimate.competition?.activeListings;
  const sellers = estimate.competition?.sellers;
  const looked = lookupOf(estimate, lookup);
  const limit = isCount(entered.availableUnits) ? entered.availableUnits : null;
  const knownListings = isCount(listings) && (listings > 0 || looked !== null) ? listings : null;
  const used = {
    availableUnits: units === null ? null : limit === null ? units : Math.min(limit, units),
    salesPerWeek: rate === null ? null : Math.min(entered.salesPerWeek, rate),
    sellWindowWeeks: entered.sellWindowWeeks,
    competingListings: knownListings,
  };
  const notes = [];
  if (units === null)
    notes.push(
      estimate.stock?.check
        ? "The stock check recorded no unit count, so units on the shelf are unknown and the cap is 0. Record a check with the units seen."
        : "No stock check with a unit count, so units on the shelf are unknown and the cap is 0",
    );
  else if (limit !== null && limit < units)
    notes.push(`Units to share limited to ${limit} of the ${units} counted on the latest stock check`);
  if (rate === null) notes.push("No confirmed sales count, so the cap is 0");
  else if (rate < entered.salesPerWeek)
    notes.push(
      `Sales a week lowered to ${round2(rate)}: ${estimate.sample.count} confirmed sales over ${BOUNTY_RULES.saleWindowDays} days`,
    );
  if (knownListings === null)
    notes.push(
      listings === 0
        ? "No competing listings recorded and no asking-price lookup for this barcode is on record, so competition is unknown (not zero) and the cap is 0. Run an asking-price lookup before sharing."
        : typeof estimate.competition?.note === "string" && estimate.competition.note
          ? `${estimate.competition.note}. Competing listings unknown, so the cap is 0`
          : "Competing listings unknown, so the cap is 0",
    );
  else if (knownListings === 0)
    notes.push(`An asking-price lookup (${looked.provider}, ${humanTime(looked.fetched)}) found no competing listings`);
  return {
    entered,
    evidence: {
      unitsSeen: units,
      salesPerWeek: rate === null ? null : round2(rate),
      confirmedSales: isCount(estimate.sample?.count) ? estimate.sample.count : null,
      competingListings: knownListings,
      competingSellers: knownListings === null ? null : isCount(sellers) ? sellers : null,
      askingLookup: looked,
    },
    used: { ...used, salesPerWeek: used.salesPerWeek === null ? null : round2(used.salesPerWeek) },
    cap: distributionCap(used),
    notes,
  };
}

// ------------------------------------------------------- estimate snapshot

const pick = (source, keys) =>
  isObject(source) ? Object.fromEntries(keys.filter((k) => k in source).map((k) => [k, source[k]])) : null;

/**
 * The opportunity tier from estimate.opportunity (classifyOpportunity in
 * opportunity.mjs). A missing classification is recorded as Review, which
 * never meets the buying thresholds.
 */
function opportunitySnapshot(estimate) {
  const o = estimate?.opportunity;
  if (!isObject(o) || typeof o.tier !== "string")
    return { tier: "Review", reasons: ["The estimate did not include an opportunity tier"], meetsThresholds: false };
  return pick(o, [
    "tier", "reasons", "unitProfit", "returnOnCost", "targetPrice", "meetsThresholds", "trialUnits",
    "unitPrice", "weightKg", "salesPerWeek", "resaleWeeksOfSupply", "provenItem",
  ]);
}

/**
 * The promotion or loyalty condition on a live bounty's price, or null.
 * operatorConfirmed records the operator's tick, which covers only the
 * operator. needsMemberConfirmation is true unless the stock is costed at
 * a known regular price, so each member confirms for themselves that they
 * qualify before claiming.
 */
function promotionSnapshot(estimate, request) {
  const condition = estimate.offer?.promotion;
  if (typeof condition !== "string" || !condition.trim()) return null;
  const price = Number.isSafeInteger(estimate.offer?.price) ? estimate.offer.price : null;
  const regular = Number.isSafeInteger(estimate.offer?.regularPrice) ? estimate.offer.regularPrice : null;
  const unitCost = Number.isSafeInteger(estimate.unitCost) ? estimate.unitCost : null;
  const atRegular = regular !== null && unitCost === regular;
  return {
    condition: condition.trim(),
    price,
    regularPrice: regular,
    costedAt: atRegular ? "regular" : "promotion",
    operatorConfirmed: request?.promotionEligible === true,
    needsMemberConfirmation: !atRegular,
  };
}

/** Display permission recorded with the estimate: fails closed when absent. */
function permissionSnapshot(estimate) {
  const p = estimate.permission;
  return {
    permitted: p?.permitted === true,
    basis: typeof p?.basis === "string" ? p.basis : "No display permission was recorded with the evidence",
  };
}

const categoryName = (value) => {
  if (typeof value === "string") return CATEGORY_RULES[value]?.name ?? null;
  if (isObject(value)) return value.name ?? CATEGORY_RULES[value.id]?.name ?? null;
  return null;
};

/**
 * The category the estimate used, as { applied, chosen, suggested, reason,
 * warning } with names for people (General, Clothing, Food). Reads the
 * estimate's category decision ({ chosen, suggested, applied, reason,
 * warning } with ids) and the older shape ({ id, name, chosen: "request" or
 * "suggested", suggestion }); null when the estimate has none.
 */
function categorySnapshot(estimate) {
  const c = estimate?.category;
  if (!isObject(c)) return null;
  const marker = c.chosen === "request" || c.chosen === "suggested";
  const applied = categoryName(c.applied) ?? categoryName(c.id) ?? (typeof c.name === "string" ? c.name : null);
  return {
    applied,
    chosen: marker ? (c.chosen === "request" ? applied : null) : categoryName(c.chosen),
    suggested: categoryName(c.suggested) ?? categoryName(c.suggestion),
    reason: typeof c.reason === "string" && c.reason.trim() ? c.reason.trim() : null,
    warning: typeof c.warning === "string" && c.warning.trim() ? c.warning.trim() : null,
    returnsRate: Number.isFinite(c.returnsRate) ? c.returnsRate : null,
  };
}

const ATTRIBUTE_LABELS = Object.freeze({ size: "Size", pack: "Pack", model: "Model", condition: "Condition" });

/**
 * Match attributes the source did not state, from the offer's
 * attributeSource: "Pack 1: confirmed by the operator, not stated by the
 * source", and a retail offer's condition taken as new.
 */
export function attributeNotes(offer) {
  const source = isObject(offer?.attributeSource) ? offer.attributeSource : {};
  const confirmed = Array.isArray(offer?.operatorConfirmed) ? offer.operatorConfirmed : [];
  const notes = [];
  for (const key of Object.keys(ATTRIBUTE_LABELS)) {
    const value = offer?.[key];
    const shown = value === null || value === undefined || value === "" ? "" : ` ${value}`;
    if (source[key] === "operator" || confirmed.includes(key))
      notes.push({ key, by: "operator", text: `${ATTRIBUTE_LABELS[key]}${shown}: confirmed by the operator, not stated by the source` });
    else if (source[key] === "assumed")
      notes.push({ key, by: "assumed", text: `${ATTRIBUTE_LABELS[key]}${shown || " new"}: assumed for a shop's offer, not stated by the source` });
  }
  return notes;
}

/**
 * Newest sale date for each independent (named) seller in the sold sample,
 * oldest first. Re-checking these at any later time says how many of the
 * independent sales the figures rely on are still recent.
 */
function sellerDates(sample) {
  const used = Array.isArray(sample?.used) ? sample.used : null;
  if (!used) return null;
  const newest = new Map();
  for (const row of used) {
    const name = sellerName(row?.seller);
    const at = Date.parse(row?.observed);
    if (name === null || !Number.isFinite(at)) continue;
    if (!newest.has(name) || at > newest.get(name)) newest.set(name, at);
  }
  return [...newest.values()].sort((a, b) => a - b).map((ms) => iso(ms));
}

/**
 * Whose return journey the bounty's figures use: the operator's, from the
 * estimate request. A blank cost or time is null, never zero.
 */
function journeyOf(request) {
  const costs = isObject(request?.costs) ? request.costs : {};
  const cost = Number.isSafeInteger(costs.journeyCost) && costs.journeyCost >= 0 ? costs.journeyCost : null;
  const minutes = Number.isSafeInteger(costs.journeyMinutes) && costs.journeyMinutes >= 0 ? costs.journeyMinutes : null;
  return { whose: "operator", cost, minutes, known: cost !== null && minutes !== null };
}

/**
 * Units one member can claim on a live bounty: the smallest of the
 * estimate's units, the distribution cap and the trial batch (0 when any of
 * them is unknown or 0).
 */
export function claimableUnits({ estimateUnits, cap, trialUnits }) {
  return Math.min(...[estimateUnits, cap, trialUnits].map((v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0)));
}

/**
 * The unit plan for a live bounty from its evidence: { cap, trial,
 * estimateUnits, claimable, figures, rerun }. figures is the count the
 * bounty's figures must be worked out for (claimable, at least 1); rerun is
 * true when the estimate was for more units than that, so it must be run
 * again for `figures` units before the bounty may alert.
 */
function unitsPlan(entered, estimate, lookup) {
  const basis = capBasis(entered, estimate, lookup);
  const tightened = estimate?.opportunity?.trialUnits;
  const trial =
    Number.isSafeInteger(tightened) && tightened >= 1 ? Math.min(BOUNTY_RULES.maxClaimUnits, tightened) : BOUNTY_RULES.maxClaimUnits;
  const fromEconomics = estimate?.economics?.units;
  const fromRequest = estimate?.inputs?.units;
  const estimateUnits = Number.isSafeInteger(fromEconomics)
    ? fromEconomics
    : Number.isSafeInteger(fromRequest)
      ? fromRequest
      : null;
  const claimable = claimableUnits({ estimateUnits, cap: basis.cap, trialUnits: trial });
  const figures = Math.max(1, claimable);
  return {
    cap: basis.cap,
    trial,
    estimateUnits,
    claimable,
    figures,
    rerun: Number.isSafeInteger(fromEconomics) && fromEconomics > figures,
  };
}

/**
 * The unit plan for a new bounty, so the route can re-run the estimate for
 * the units one member can claim before creating it. Validates the bounty
 * fields like createBounty.
 */
export function planForInput(input, estimate, { lookup = null, now } = {}) {
  const f = bountyFields(input, clock(now));
  return unitsPlan(
    { availableUnits: f.availableUnits, salesPerWeek: f.salesPerWeek, sellWindowWeeks: f.sellWindowWeeks },
    estimate,
    lookup,
  );
}

/** The unit plan for re-checking a live bounty with a fresh estimate. */
export function planForBounty(bounty, estimate, { lookup = null } = {}) {
  return unitsPlan(enteredOf(bounty), estimate, lookup);
}

const enteredOf = (bounty) =>
  json(bounty.cap_basis, {})?.entered ?? {
    availableUnits: bounty.available_units,
    salesPerWeek: bounty.sales_per_week,
    sellWindowWeeks: bounty.sell_window_weeks,
  };

/**
 * What a bounty keeps from an estimate: the request (so the server can
 * re-check the evidence later) and the key results. No credentials are ever
 * part of an estimate.
 */
function estimateSnapshot(estimate, request, at, lookup = null, plan = null) {
  const e = estimate.economics;
  const sample = pick(estimate.sample, ["count", "independent", "lowerMedian", "daysToSell", "newest", "oldest"]);
  const sellers = sellerDates(estimate.sample);
  return {
    request: request ?? null,
    checkedAt: iso(at),
    permission: permissionSnapshot(estimate),
    promotion: promotionSnapshot(estimate, request),
    askingLookup: lookupOf(estimate, lookup),
    offer: pick(estimate.offer, [
      "provider", "sourceId", "title", "price", "regularPrice", "observed", "retailer", "location", "gtin", "variant",
      "source", "stockNote", "sample", "expired", "ageDays", "promotion", "size", "pack", "model", "condition",
      "attributeSource", "operatorConfirmed",
    ]),
    unitCost: estimate.unitCost ?? null,
    match: estimate.match ?? null,
    sample: sample ? { ...sample, sellers } : null,
    competition: pick(estimate.competition, [
      "activeListings", "sellers", "lowestAsking", "lowestAskingIncludesShipping", "checkedAt", "note",
    ]),
    economics: e
      ? pick(e, [
          "units", "unitCost", "salePrice", "proceeds", "costs", "totalCosts", "contribution",
          "unitContribution", "cashRequired", "journeyPerUnit", "activeMinutes", "activeHours", "hourly",
          "unsoldLoss", "breakEvenSale",
        ])
      : null,
    // The figures are for `units.figures` units (the most one member can
    // claim) with the operator's journey.
    units: plan
      ? { requested: plan.estimateUnits, claimable: plan.claimable, figures: plan.figures, cap: plan.cap, trial: plan.trial }
      : null,
    journey: journeyOf(request),
    category: categorySnapshot(estimate),
    stock: {
      confirmed: estimate.stock?.confirmed === true,
      availability: estimate.stock?.availability ?? "unknown",
      checkedAt: estimate.stock?.check?.checked_at ?? null,
      unitsSeen: estimate.stock?.check?.units_seen ?? null,
    },
    alert: {
      eligible: estimate.alert?.eligible === true,
      reasons: Array.isArray(estimate.alert?.reasons) ? estimate.alert.reasons.map(String) : [],
      checks: Array.isArray(estimate.alert?.checks) ? estimate.alert.checks : [],
    },
    opportunity: opportunitySnapshot(estimate),
    // The estimate's own main uncertainty, kept for the card (P12).
    mainUncertainty: typeof estimate.mainUncertainty === "string" ? estimate.mainUncertainty : null,
    warnings: Array.isArray(estimate.warnings) ? estimate.warnings.map(String) : [],
  };
}

/**
 * Alert eligibility from estimate.alert (evaluateAlert, fail closed). With
 * a unit plan, figures worked out for more units than one member can claim
 * also fail: the journey would be shared over units nobody can buy.
 */
function alertFrom(estimate, plan = null) {
  let eligible = estimate?.alert?.eligible === true;
  const reasons = Array.isArray(estimate?.alert?.reasons) ? estimate.alert.reasons.map(String) : [];
  if (!eligible && !reasons.length) reasons.push("Buy-alert checks are missing or did not pass");
  if (plan?.rerun) {
    eligible = false;
    reasons.push(
      `The figures are for ${plural(plan.estimateUnits, "unit")}, but one member can claim at most ${plural(plan.figures, "unit")} (the smallest of the estimate's units, the cap and the trial batch): the estimate must be worked out again for ${plural(plan.figures, "unit")}`,
    );
  }
  return { eligible, reasons: eligible ? [] : reasons };
}

// --------------------------------------------------------------- bounties

function bountyFields(input, at) {
  if (!isObject(input)) fail("Send a bounty as a JSON object");
  const salesPerWeek = num(input.salesPerWeek, "salesPerWeek", 0, BOUNTY_RULES.maxSalesPerWeek);
  if (!(salesPerWeek > 0)) fail("salesPerWeek must be more than 0");
  const sellWindowWeeks = num(input.sellWindowWeeks, "sellWindowWeeks", 0, BOUNTY_RULES.maxSellWindowWeeks);
  if (!(sellWindowWeeks > 0)) fail("sellWindowWeeks must be more than 0");
  const expires = instant(input.expiresAt, "expiresAt");
  if (expires <= at) fail("expiresAt must be in the future");
  if (expires > at + BOUNTY_RULES.maxDays * DAY)
    fail(`expiresAt must be at most ${BOUNTY_RULES.maxDays} days ahead`);
  const sponsored = bool(input.sponsored, "sponsored");
  const sponsor = text(input.sponsor, "sponsor", 120, { optional: true });
  if (sponsored && !sponsor) fail("sponsor is required for a sponsored bounty, so the placement is identifiable");
  if (!sponsored && sponsor) fail("A sponsor is named but sponsored is false: mark the bounty as sponsored");
  return {
    title: text(input.title, "title", 200),
    locality: text(input.locality, "locality", 120),
    retailer: text(input.retailer, "retailer", 120),
    // Optional for a live bounty: an upper limit on units to share. The
    // count itself comes from the stock check.
    availableUnits:
      input.availableUnits === undefined || input.availableUnits === null || input.availableUnits === ""
        ? null
        : int(input.availableUnits, "availableUnits", 1, BOUNTY_RULES.maxAvailableUnits),
    salesPerWeek,
    sellWindowWeeks,
    expiresAt: iso(expires),
    sponsored,
    sponsor: sponsored ? sponsor : null,
  };
}

/**
 * Creates a bounty.
 *
 * input: { title, locality, retailer, availableUnits, salesPerWeek,
 *   sellWindowWeeks, expiresAt, sponsored, sponsor?, sample? } and, for a
 *   sample bounty only, competingListings, competingSellers, barcode?,
 *   variant?.
 * options.estimate: the estimateFromEvidence result for a live bounty
 *   (competing listings and sellers, the barcode and alert eligibility come
 *   from it). options.request: the estimate request, stored so the evidence
 *   can be re-checked before claims and alerts. options.lookup: the latest
 *   asking-price lookup for the barcode inside its time to live
 *   ({ provider, fetched }) or null; without one, no competing listings
 *   means competition is unknown.
 *
 * For a live bounty availableUnits is optional: it can only lower the count
 * on the stock check. A sample bounty needs it, has no estimate, is
 * labelled Sample everywhere, can never alert and can never be claimed.
 * Only one live bounty may be open per barcode, because the cap shares out
 * the resale demand for the item and two bounties would double it.
 */
export function createBounty(db, input, { estimate = null, request = null, lookup = null, now } = {}) {
  const at = clock(now);
  if (!isObject(input)) fail("Send a bounty as a JSON object");
  const sample = input.sample === undefined ? false : bool(input.sample, "sample");
  const f = bountyFields(input, at);
  if (sample && f.availableUnits === null) fail("availableUnits is required for a sample bounty");
  const entered = {
    availableUnits: f.availableUnits,
    salesPerWeek: f.salesPerWeek,
    sellWindowWeeks: f.sellWindowWeeks,
  };
  let row;
  if (sample) {
    if (estimate) fail("A sample bounty takes no estimate");
    const competingListings = int(input.competingListings, "competingListings", 0, 100000);
    const competingSellers = int(input.competingSellers, "competingSellers", 0, 100000);
    const barcode = text(input.barcode, "barcode", 40, { optional: true });
    if (barcode && !/^\d+$/.test(barcode)) fail("barcode must contain digits only");
    const used = { ...entered, competingListings };
    row = {
      ...f,
      barcode,
      variant: text(input.variant, "variant", 120, { optional: true }),
      competingListings,
      competingSellers,
      cap: distributionCap(used),
      capBasis: { entered, evidence: null, used, notes: ["Sample figures entered by hand"] },
      alertEligible: false,
      alertReasons: ["Sample bounty: illustrative figures never send an alert"],
      opportunity: { tier: null, reasons: ["Sample bounty: no opportunity tier"], meetsThresholds: false },
      snapshot: null,
      checkedAt: null,
    };
  } else {
    if (!isObject(estimate)) fail("An estimate is required unless the bounty is a labelled sample");
    const offer = estimate.offer ?? {};
    const gtin = typeof offer.gtin === "string" && /^\d{14}$/.test(offer.gtin) ? offer.gtin : null;
    if (!gtin) fail("The estimate's offer has no valid barcode, so it cannot become a bounty");
    if (offer.retailer && normaliseLocality(offer.retailer) !== normaliseLocality(f.retailer))
      fail(`retailer must match the offer's retailer (${offer.retailer})`);
    const basis = capBasis(entered, estimate, lookup);
    const plan = unitsPlan(entered, estimate, lookup);
    const alert = alertFrom(estimate, plan);
    row = {
      ...f,
      availableUnits: basis.used.availableUnits ?? 0,
      barcode: gtin,
      variant: offer.variant ?? null,
      competingListings: basis.evidence.competingListings,
      competingSellers: basis.evidence.competingSellers,
      cap: basis.cap,
      capBasis: basis,
      alertEligible: alert.eligible,
      alertReasons: alert.reasons,
      opportunity: opportunitySnapshot(estimate),
      snapshot: estimateSnapshot(estimate, request, at, lookup, plan),
      checkedAt: iso(at),
    };
  }
  return transaction(db, () => {
    if (!sample) {
      const clash = db
        .prepare("SELECT id FROM bounties WHERE barcode = ? AND sample = 0 AND status = 'open' AND expires_at > ?")
        .get(row.barcode, iso(at));
      if (clash)
        fail(
          `Bounty ${clash.id} is already open for this barcode. Its cap shares out the resale demand for the item, so withdraw it or let it expire before opening another.`,
          409,
        );
    }
    const result = db
      .prepare(
        `INSERT INTO bounties(title, barcode, variant, retailer, locality, available_units, sales_per_week,
 sell_window_weeks, competing_listings, competing_sellers, cap, cap_basis, expires_at, sponsored, sponsor,
 sample, alert_eligible, alert_reasons, opportunity_tier, opportunity, estimate, checked_at, status, created)
 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(
        row.title, row.barcode, row.variant, row.retailer, row.locality, row.availableUnits,
        row.salesPerWeek, row.sellWindowWeeks, row.competingListings, row.competingSellers, row.cap,
        JSON.stringify(row.capBasis), row.expiresAt, row.sponsored ? 1 : 0, row.sponsor, sample ? 1 : 0,
        row.alertEligible ? 1 : 0, JSON.stringify(row.alertReasons), row.opportunity.tier,
        JSON.stringify(row.opportunity), row.snapshot ? JSON.stringify(row.snapshot) : null, row.checkedAt,
        iso(at),
      );
    return getBounty(db, Number(result.lastInsertRowid));
  });
}

const getBounty = (db, bountyId) =>
  plain(db.prepare("SELECT * FROM bounties WHERE id = ?").get(bountyId));

/** The bounty row, or a 404. */
export function requireBounty(db, bountyId) {
  return getBounty(db, id(bountyId, "bountyId")) ?? fail("Bounty not found", 404);
}

/** The stored estimate request for a live bounty, or null. */
export function storedRequest(bounty) {
  return bounty.sample ? null : (json(bounty.estimate, null)?.request ?? null);
}

/**
 * Replaces a live bounty's evidence with a fresh estimate (the server
 * re-runs estimateFromEvidence before claims and alerts so an offer that has
 * expired or a stock check that has lapsed stops them). Alert eligibility,
 * the opportunity tier, competing listings and the cap are recomputed from
 * the operator's original entries and the new evidence. Pass { error } when
 * the estimate could not be re-run: the bounty then fails closed.
 */
export function refreshBounty(db, bountyId, estimate, now, { lookup = null } = {}) {
  const at = clock(now);
  const bounty = requireBounty(db, bountyId);
  if (bounty.sample) return bounty;
  const old = json(bounty.estimate, {}) ?? {};
  if (!isObject(estimate) || estimate.error) {
    const reason = "Evidence could not be re-checked" + (estimate?.error ? ": " + estimate.error : "");
    db.prepare("UPDATE bounties SET alert_eligible = 0, alert_reasons = ?, checked_at = ? WHERE id = ?").run(
      JSON.stringify([reason]),
      iso(at),
      bounty.id,
    );
    return settled(db, bounty.id, now);
  }
  const entered = enteredOf(bounty);
  const gtin = estimate.offer?.gtin;
  if (gtin !== bounty.barcode) {
    // Never let another item's evidence replace this bounty's: keep the old
    // snapshot and stop alerts and claims.
    db.prepare("UPDATE bounties SET alert_eligible = 0, alert_reasons = ?, checked_at = ? WHERE id = ?").run(
      JSON.stringify(["The re-checked offer no longer has this bounty's barcode"]),
      iso(at),
      bounty.id,
    );
    return settled(db, bounty.id, now);
  }
  const basis = capBasis(entered, estimate, lookup);
  const plan = unitsPlan(entered, estimate, lookup);
  const alert = alertFrom(estimate, plan);
  const opportunity = opportunitySnapshot(estimate);
  const snapshot = estimateSnapshot(estimate, old.request ?? null, at, lookup, plan);
  transaction(db, () => {
    db.prepare(
      `UPDATE bounties SET available_units = ?, competing_listings = ?, competing_sellers = ?, cap = ?, cap_basis = ?,
 alert_eligible = ?, alert_reasons = ?, opportunity_tier = ?, opportunity = ?, estimate = ?, checked_at = ? WHERE id = ?`,
    ).run(
      basis.used.availableUnits ?? 0, basis.evidence.competingListings, basis.evidence.competingSellers, basis.cap,
      JSON.stringify(basis), alert.eligible ? 1 : 0, JSON.stringify(alert.reasons), opportunity.tier,
      JSON.stringify(opportunity), JSON.stringify(snapshot), iso(at), bounty.id,
    );
    // A branch check that now finds none stops anyone already on the way.
    const check = estimate.stock?.check;
    if (estimate.stock?.availability === "out_of_stock" && bountyStatus(bounty, now) === "open")
      notifyStop(db, bounty, {
        reason: "out-of-stock",
        // Keyed on when the shelf was seen empty, so a verified report that
        // became this check does not notify the same members twice.
        ref: "empty:" + (check?.checked_at ?? iso(at)),
        message: `${TERMS.stop}: the latest branch stock check (${humanTime(check?.checked_at ?? at)}) found none on the shelf. Claims and alerts for this bounty are paused.`,
        now,
      });
  });
  return settled(db, bounty.id, now);
}

/**
 * The bounty row after a change to its evidence, once anyone alerted or
 * holding a claim has been told about a trip that stopped (or reopened).
 */
function settled(db, bountyId, now) {
  syncTrip(db, getBounty(db, bountyId), now);
  return getBounty(db, bountyId);
}

/** Withdraws a bounty, tells everyone alerted or holding a claim, and releases its active claims. */
export function withdrawBounty(db, bountyId, { now }) {
  const at = iso(clock(now));
  return transaction(db, () => {
    const bounty = requireBounty(db, bountyId);
    if (bounty.status === "withdrawn") fail("This bounty is already withdrawn", 409);
    if (bountyStatus(bounty, now) === "open")
      notifyStop(db, bounty, {
        reason: "withdrawn",
        ref: "withdrawn",
        message: `${TERMS.stop}: the operator withdrew this bounty at ${humanTime(at)}. Any claim you held on it has been released.`,
        now,
      });
    db.prepare("UPDATE bounties SET status = 'withdrawn', withdrawn_at = ? WHERE id = ?").run(at, bounty.id);
    db.prepare("UPDATE claims SET status = 'released', ended_at = ? WHERE bounty_id = ? AND status = 'active'").run(
      at,
      bounty.id,
    );
    return getBounty(db, bounty.id);
  });
}

// ---------------------------------------------------------------- notices

/**
 * Records a "Don't make the trip" notice for every member alerted for the
 * bounty or holding a live claim on it, except `exclude` (the member whose
 * report caused it). One notice per member per ref, so repeating an event
 * never duplicates it. Returns the number of notices added.
 */
export function notifyStop(db, bounty, { reason, ref, message, now, exclude = null, onlyUnwarned = false }) {
  const at = iso(clock(now));
  const warned = onlyUnwarned
    ? new Set(
        db
          .prepare("SELECT member_id FROM notices WHERE bounty_id = ? AND kind = 'stop' AND superseded_at IS NULL")
          .all(bounty.id)
          .map((r) => r.member_id),
      )
    : new Set();
  const targets = db
    .prepare(
      `SELECT member_id FROM alerts WHERE bounty_id = ? AND kind = 'alert'
 UNION SELECT member_id FROM claims WHERE bounty_id = ? AND status = 'active' AND expires_at > ?`,
    )
    .all(bounty.id, bounty.id, at)
    .map((r) => r.member_id)
    .filter((m) => m !== exclude && !warned.has(m));
  const insert = db.prepare(
    `INSERT OR IGNORE INTO notices(bounty_id, member_id, kind, reason, ref, message, created)
 VALUES(?, ?, 'stop', ?, ?, ?, ?)`,
  );
  let added = 0;
  for (const memberId of targets) added += insert.run(bounty.id, memberId, reason, ref, message, at).changes;
  return added;
}

/**
 * When a stopped bounty can send people on trips again, members holding a
 * current stop notice get a notice that it reopened, and those stop notices
 * are marked superseded (their ref is freed, so the same event can stop
 * the trip again later). Returns the number of reopen notices added.
 */
function reopenNotices(db, bounty, now) {
  const at = iso(clock(now));
  const stale = db
    .prepare("SELECT DISTINCT member_id FROM notices WHERE bounty_id = ? AND kind = 'stop' AND superseded_at IS NULL")
    .all(bounty.id)
    .map((r) => r.member_id);
  if (!stale.length) return 0;
  db.prepare(
    "UPDATE notices SET superseded_at = ?, ref = ref || '~' || id WHERE bounty_id = ? AND kind = 'stop' AND superseded_at IS NULL",
  ).run(at, bounty.id);
  const shelf = shelfStatus(db, bounty.id);
  const sighting =
    shelf.state === "seen" ? ` The latest stock report saw ${plural(shelf.unitsSeen, "unit")} at ${humanTime(shelf.at)}.` : "";
  const full = bounty.cap - claimedUnits(db, bounty.id, now).committed <= 0;
  const message = `Open for trips again at ${humanTime(at)}: every check passes now, so the earlier "${TERMS.stop}" notice no longer applies.${sighting}${full ? " Every unit under the cap is claimed, so only members holding a claim can go." : ""} Look at the card before you go: stock may have sold since.`;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO notices(bounty_id, member_id, kind, reason, ref, message, created)
 VALUES(?, ?, 'reopen', 'reopened', ?, ?, ?)`,
  );
  let added = 0;
  for (const memberId of stale) added += insert.run(bounty.id, memberId, "reopen:" + at, message, at).changes;
  return added;
}

const noticeView = (n) => ({
  id: n.id,
  bountyId: n.bounty_id,
  kind: n.kind,
  reason: n.reason,
  message: n.message,
  created: n.created,
  // A stop notice a later reopen notice replaced: kept for the record only.
  superseded: Boolean(n.superseded_at),
});

/** A member's notices (stop and reopen), newest first, optionally for one bounty. */
export function memberNotices(db, memberId, { bountyId = null } = {}) {
  const rows = bountyId
    ? db
        .prepare("SELECT * FROM notices WHERE member_id = ? AND bounty_id = ? ORDER BY created DESC, id DESC")
        .all(memberId, bountyId)
    : db.prepare("SELECT * FROM notices WHERE member_id = ? ORDER BY created DESC, id DESC LIMIT 100").all(memberId);
  return rows.map(noticeView);
}

// ----------------------------------------------------------------- claims

/** Marks claims past their expiry as expired, which frees their units. */
export function expireClaims(db, now) {
  const at = iso(clock(now));
  return db
    .prepare("UPDATE claims SET status = 'expired', ended_at = expires_at WHERE status = 'active' AND expires_at <= ?")
    .run(at).changes;
}

/**
 * Units held against a bounty's cap. Active claims hold units until they
 * expire or are released. Completed claims keep their units: those units
 * were bought and are now on the resale market the cap protects.
 */
export function claimedUnits(db, bountyId, now) {
  const at = iso(clock(now));
  const row = db
    .prepare(
      `SELECT
 COALESCE(SUM(CASE WHEN status = 'active' AND expires_at > ? THEN units END), 0) AS active,
 COALESCE(SUM(CASE WHEN status = 'completed' THEN units END), 0) AS completed
 FROM claims WHERE bounty_id = ?`,
    )
    .get(at, bountyId);
  return { active: row.active, completed: row.completed, committed: row.active + row.completed };
}

/** Why no units are left: a zero cap from the evidence, or a full one. */
const capFullMessage = (bounty) =>
  bounty.cap === 0
    ? "The distribution cap is 0: the evidence leaves no units to share."
    : "The distribution cap for this bounty is fully claimed.";

/** open, withdrawn or expired at `now`. */
export function bountyStatus(bounty, now) {
  if (bounty.status === "withdrawn") return "withdrawn";
  return Date.parse(bounty.expires_at) <= clock(now) ? "expired" : "open";
}

/** When a member's release window for a bounty opens. */
export function releaseFor(db, bounty, member, now) {
  const access = memberAccess(db, member, now);
  const releaseAt = iso(Date.parse(bounty.created) + access.tier.offsetMinutes * MINUTE);
  return {
    tier: tierSummary(access.tier),
    via: access.via,
    points: access.points,
    releaseAt,
    open: clock(now) >= Date.parse(releaseAt),
  };
}

/**
 * The offer as the evidence holds it now, for a live bounty: the research
 * row (or Open Prices observation) the estimate used, read again. Returns
 * null when there is no evidence table to read (the snapshot then stands),
 * or { gone, price, observed, rose, fell, was } where was is the price the
 * figures use.
 */
export function offerNow(db, bounty) {
  if (bounty.sample) return null;
  const o = json(bounty.estimate, null)?.offer;
  if (!o?.provider || o.sourceId === undefined || o.sourceId === null) return null;
  let row;
  try {
    if (o.provider === "openprices") {
      if (!tableExists(db, "observations") || !/^\d{1,15}$/.test(String(o.sourceId))) return null;
      row = db.prepare("SELECT price, day AS observed FROM observations WHERE id = ?").get(Number(o.sourceId));
    } else {
      if (!tableExists(db, "research")) return null;
      row = db
        .prepare("SELECT price, observed, kind FROM research WHERE provider = ? AND source_id = ?")
        .get(o.provider, String(o.sourceId));
      if (row && row.kind !== "Retail offer") row = undefined;
    }
  } catch {
    return null;
  }
  const was = Number.isSafeInteger(o.price) ? o.price : null;
  if (!row) return { gone: true, price: null, observed: null, rose: false, fell: false, was };
  const price = Number.isSafeInteger(row.price) && row.price > 0 ? row.price : null;
  return {
    gone: price === null,
    price,
    observed: row.observed ?? null,
    rose: price !== null && was !== null && price > was,
    fell: price !== null && was !== null && price < was,
    was,
  };
}

/**
 * When the offer price was last observed: the evidence's date, or a newer
 * observation of the same or a lower price in the evidence now.
 */
function offerObserved(bounty, live) {
  const stored = json(bounty.estimate, null)?.offer?.observed ?? null;
  const now = live?.offer;
  if (now && !now.gone && !now.rose && now.observed && Date.parse(now.observed) > Date.parse(stored ?? ""))
    return now.observed;
  return stored;
}

/** The offer age in days from a live bounty's latest evidence, or null. */
function offerAge(bounty, now, live = null) {
  const observed = offerObserved(bounty, live);
  return observed ? ageDays(observed, now) : null;
}

/**
 * The newest branch availability check for the bounty's barcode, retailer
 * and locality made after the check the evidence used, or null.
 */
function newerCheck(db, bounty, now) {
  if (bounty.sample || !bounty.barcode) return null;
  const since = Date.parse(json(bounty.estimate, null)?.stock?.checkedAt);
  try {
    return latestCheck(
      db,
      bounty.barcode,
      bounty.retailer,
      Number.isFinite(since) ? iso(since + 1) : "1970-01-01T00:00:00.000Z",
      { locality: bounty.locality, until: iso(clock(now)) },
    );
  } catch {
    return null;
  }
}

/**
 * How many of the independent sales the figures rely on are still within
 * the sale window at `now`: { counted, recent, enough }. Uses the newest
 * sale date per independent seller kept with the evidence; an older
 * snapshot without them falls back to its oldest sale date. Null when
 * nothing can be said.
 */
export function salesNow(bounty, now) {
  if (bounty.sample) return null;
  const s = json(bounty.estimate, null)?.sample;
  if (!s) return null;
  const recentEnough = (d) => {
    const age = ageDays(d, now);
    return age !== null && age >= 0 && age <= ALERT_RULES.maxSaleAgeDays;
  };
  if (Array.isArray(s.sellers)) {
    const recent = s.sellers.filter(recentEnough).length;
    return { counted: s.sellers.length, recent, enough: recent >= ALERT_RULES.minIndependentSales };
  }
  if (s.oldest && !recentEnough(s.oldest)) return { counted: null, recent: null, enough: false };
  return null;
}

/**
 * The evidence for a live bounty as it stands at `now`, read again: the
 * newest branch check, the offer price and the sales behind the figures.
 */
export function liveEvidence(db, bounty, now) {
  if (bounty.sample) return { check: null, offer: null, sales: null };
  return { check: newerCheck(db, bounty, now), offer: offerNow(db, bounty), sales: salesNow(bounty, now) };
}

const SAMPLE_BLOCKER = "Sample bounty: illustrative figures only, so there is nothing to claim, buy or alert";

/**
 * Whether the branch stock check behind a live bounty has lapsed at `now`.
 * A check counts for CHECK_VALID_DAYS (audit.mjs), the same window the
 * estimate uses, so a card can never keep saying "Branch stock confirmed"
 * on an old check. Returns { lapsed, checkedAt, message } or null when the
 * stock check does not apply (a sample, or stock was never confirmed and
 * the alert reasons already say so).
 */
export function stockLapse(bounty, now) {
  if (bounty.sample) return null;
  const stock = json(bounty.estimate, null)?.stock;
  if (!(stock?.confirmed === true || bounty.alert_eligible === 1)) return null;
  const checked = Date.parse(stock?.checkedAt);
  if (!Number.isFinite(checked))
    return {
      lapsed: true,
      checkedAt: null,
      message: "No dated branch stock check is recorded: stock must be checked before anyone travels",
    };
  if (checked < clock(now) - CHECK_VALID_DAYS * DAY)
    return {
      lapsed: true,
      checkedAt: iso(checked),
      message: `The branch stock check from ${humanTime(checked)} has lapsed (a check counts for ${CHECK_VALID_DAYS} days): stock must be re-checked before anyone travels`,
    };
  return { lapsed: false, checkedAt: iso(checked), message: null };
}

/**
 * Whether the offer behind a bounty may be shown to members and visitors.
 * When the permissions table exists the recorded permission decides now
 * (displayPermitted in evidence.mjs), so a refusal takes effect at once;
 * otherwise the permission recorded with the estimate decides. Anything
 * missing fails closed.
 */
export function displayStatus(db, bounty) {
  if (bounty.sample) return { permitted: true, basis: "Sample figures entered by hand" };
  const snapshot = json(bounty.estimate, null);
  const offer = snapshot?.offer;
  if (offer?.provider && tableExists(db, "permissions")) {
    const permitted = displayPermitted(db, offer.provider, offer.retailer ?? "");
    const scope = offer.provider + (offer.retailer ? ` (${offer.retailer})` : "");
    return {
      permitted,
      basis: permitted
        ? snapshot.permission?.permitted === true
          ? snapshot.permission.basis
          : `Permitted for ${scope} by a display permission recorded in Sources`
        : `Not permitted for ${scope}: no display permission is recorded, or it was refused. Review it in Sources`,
    };
  }
  return {
    permitted: snapshot?.permission?.permitted === true,
    basis: snapshot?.permission?.basis ?? "No display permission was recorded with the evidence",
  };
}

/**
 * The locality's pilot validation as audit.mjs progress() reports it now.
 * The warning clears only when the operator signed off a complete audit
 * there (progress().signedOff set); until then every bounty card and alert
 * there says so. A progress() without signedOff (an older audit module) is
 * never signed off.
 */
export function validationStatus(db, locality, cache = null) {
  const key = normaliseLocality(locality);
  if (cache?.has(key)) return cache.get(key);
  const status = validationNow(db, locality);
  cache?.set(key, status);
  return status;
}

// progress() re-runs an estimate per audit item, so callers that read many
// bounties pass a Map to validationStatus and it runs once per locality.
function validationNow(db, locality) {
  let found = null;
  try {
    if (tableExists(db, "validation_items") && tableExists(db, "availability_checks"))
      found = auditProgress(db, locality);
  } catch {
    found = null;
  }
  return validationFrom(locality, found);
}

/**
 * The validation status from an audit progress() result (or null when
 * there is none), read defensively: a missing count is 0, a missing
 * signedOff is not signed off, and a sign-off on an audit that is not
 * complete does not count.
 */
export function validationFrom(locality, found) {
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  const target = count(found?.target) ?? AUDIT_TARGET;
  const audited = count(found?.audited) ?? 0;
  const evidenced = count(found?.evidenced) ?? 0;
  const passed = count(found?.passed) ?? 0;
  const complete = found?.complete === true && evidenced >= target;
  const signedOff = complete && isObject(found?.signedOff) ? found.signedOff : null;
  const lapsed = !signedOff && isObject(found?.signOffLapsed) && typeof found.signOffLapsed.reason === "string" ? found.signOffLapsed.reason : null;
  return {
    locality,
    complete,
    signedOff: Boolean(signedOff),
    signedOffAt: typeof signedOff?.at === "string" ? signedOff.at : typeof signedOff?.signedAt === "string" ? signedOff.signedAt : null,
    audited,
    evidenced,
    passed,
    target,
    warning: signedOff
      ? null
      : complete
        ? `Pilot audit in ${locality}: ${passed} of ${evidenced} items passed, not yet signed off. Treat these figures with care.`
        : `Pilot not validated in ${locality}: ${Math.min(evidenced, target)} of ${target} items checked against stored evidence`,
    // Why an earlier sign-off no longer stands (audit.mjs signOffLapsed), or null.
    signOffLapsed: lapsed,
  };
}

/**
 * Why a bounty cannot send members on a trip right now, as objects
 * { id, ref, text, headline } in the order the card leads with them. ref
 * names the event, so a "Don't make the trip" notice for it is sent once.
 * Computed at `now` from the evidence read again (liveEvidence), so an
 * empty-shelf report, a newer branch check that found none, a price rise, a
 * lapsed check, an expired offer, sales that aged out of the window or a
 * refused display permission stop claims and alerts without waiting for a
 * re-check.
 */
export function blockerList(db, bounty, now, live = liveEvidence(db, bounty, now)) {
  const list = [];
  const add = (id, ref, text, headline = text) =>
    list.push({ id, ref, text, headline: `${TERMS.stop}: ${headline[0].toLowerCase()}${headline.slice(1)}` });
  const status = bountyStatus(bounty, now);
  if (status === "withdrawn") add("withdrawn", "withdrawn", "This bounty has been withdrawn");
  if (status === "expired") add("expired", "expired", "This bounty has expired");
  if (bounty.sample) {
    add("sample", "sample", SAMPLE_BLOCKER);
    list[list.length - 1].headline = SAMPLE_BLOCKER;
    return list;
  }
  const snapshot = json(bounty.estimate, null) ?? {};
  const shelf = shelfStatus(db, bounty.id);
  if (shelf.paused)
    add(
      "shelf-empty",
      "empty:" + shelf.at,
      `The latest stock report found none on the shelf at ${humanTime(shelf.at)}: ${TERMS.stop.toLowerCase()}. Claims and alerts are paused until someone reports stock again`,
      `none on the shelf at ${humanTime(shelf.at)}, in the latest stock report`,
    );
  const none = live.check && live.check.in_stock !== 1 ? live.check : null;
  // A newer check that found stock is not used until the evidence is
  // re-checked (the cap and figures depend on its count), but the card says so.
  const found = live.check && live.check.in_stock === 1 ? live.check : null;
  const newer = found
    ? `. A newer branch check (${humanTime(found.checked_at)}) found ${Number.isSafeInteger(found.units_seen) && found.units_seen > 0 ? plural(found.units_seen, "unit") : "stock"}: the evidence must be re-checked to use it`
    : "";
  const oos = none?.checked_at ?? (snapshot.stock?.availability === "out_of_stock" ? (snapshot.stock.checkedAt ?? null) : undefined);
  if (oos !== undefined)
    add(
      "out-of-stock",
      "empty:" + (oos ?? snapshot.checkedAt),
      `The latest branch check (${humanTime(oos)}) found none on the shelf${none ? "" : newer}`,
      emptyCheckHeadline(db, bounty, oos) + (none ? "" : newer),
    );
  const lapse = stockLapse(bounty, now);
  if (lapse?.lapsed)
    add(
      "stock-lapsed",
      "lapse:" + (lapse.checkedAt ?? snapshot.checkedAt),
      lapse.message + newer,
      `branch stock has not been checked in the last ${CHECK_VALID_DAYS} days` + newer,
    );
  if (live.offer?.gone)
    add(
      "offer-gone",
      "offer-gone:" + snapshot.checkedAt,
      "The offer is no longer in the imported evidence, so its price cannot be confirmed",
    );
  else if (live.offer?.rose)
    add(
      "price-rose",
      "price:" + live.offer.price,
      `The offer price has risen from ${pounds(live.offer.was)} to ${pounds(live.offer.price)} since the figures were worked out (${humanTime(snapshot.checkedAt)}), so they no longer hold`,
    );
  const age = offerAge(bounty, now, live);
  if (age === null || age < 0 || age > ALERT_RULES.maxOfferAgeDays)
    add(
      "offer-stale",
      "offer-age:" + (offerObserved(bounty, live) ?? "unknown"),
      `The offer price is not from the last ${ALERT_RULES.maxOfferAgeDays} days`,
    );
  if (bounty.alert_eligible === 1 && live.sales && !live.sales.enough)
    add(
      "sales-aged",
      "sales:" + snapshot.checkedAt,
      live.sales.recent === null
        ? `A confirmed sale behind the figures is now more than ${ALERT_RULES.maxSaleAgeDays} days old, so the independent sales must be checked again`
        : `Only ${live.sales.recent} of the ${plural(live.sales.counted, "independent sale")} behind the figures ${live.sales.recent === 1 ? "is" : "are"} still from the last ${ALERT_RULES.maxSaleAgeDays} days: fewer than ${ALERT_RULES.minIndependentSales}`,
    );
  if (bounty.alert_eligible === 1 && !displayStatus(db, bounty).permitted)
    add("display", "display", "The source no longer permits display of this offer");
  if (bounty.alert_eligible !== 1)
    add(
      "ineligible",
      "ineligible:" + (bounty.checked_at ?? snapshot.checkedAt),
      "The buy-alert checks do not pass: " + json(bounty.alert_reasons, []).join("; "),
    );
  return list;
}

/**
 * The "Don't make the trip" line for a branch check that found none. When
 * the check is a member's empty-shelf report the operator verified, it says
 * so, and a newer report of stock waiting for verification is mentioned, so
 * a member who saw stock is not told a branch check found none.
 */
function emptyCheckHeadline(db, bounty, checkedAt) {
  const verified = checkedAt
    ? db
        .prepare(
          "SELECT id FROM stock_reports WHERE bounty_id = ? AND verified = 'accurate' AND units_seen = 0 AND observed_at = ? LIMIT 1",
        )
        .get(bounty.id, checkedAt)
    : null;
  const pending = db
    .prepare(
      `SELECT units_seen, observed_at FROM stock_reports WHERE bounty_id = ? AND verified IS NULL AND units_seen > 0
 AND observed_at > ? ORDER BY observed_at DESC, id DESC LIMIT 1`,
    )
    .get(bounty.id, checkedAt ?? "");
  const head = verified
    ? `the operator confirmed a report of none on the shelf at ${humanTime(checkedAt)}`
    : `the latest branch check (${humanTime(checkedAt)}) found none on the shelf`;
  return pending
    ? `${head}. A newer report of ${plural(pending.units_seen, "unit")} at ${humanTime(pending.observed_at)} is waiting for the operator to verify it; until then the bounty stays paused`
    : head;
}

/**
 * Why a bounty cannot send members on a trip right now (claims and alerts),
 * in order. Empty when it can. See blockerList.
 */
export function tripBlockers(db, bounty, now, live = liveEvidence(db, bounty, now)) {
  return blockerList(db, bounty, now, live).map((b) => b.text);
}

/**
 * Re-evaluates a live open bounty at `now` and tells members: when a trip
 * blocker has appeared, everyone alerted or holding a claim who has no
 * current "Don't make the trip" notice for it gets one; when every blocker
 * has cleared, members holding a stop notice are told it reopened. Every
 * bounty read calls this before it returns. Returns { bountyId, stopped,
 * reasons, noticesSent, reopened }.
 */
export function syncTrip(db, bounty, now, live = null) {
  const out = { bountyId: bounty.id, stopped: false, reasons: [], noticesSent: 0, reopened: 0 };
  if (bounty.sample || bountyStatus(bounty, now) !== "open") return out;
  const list = blockerList(db, bounty, now, live ?? liveEvidence(db, bounty, now));
  return transaction(db, () => {
    if (list.length) {
      const first = list[0];
      out.stopped = true;
      out.reasons = list.map((b) => b.text);
      out.noticesSent = notifyStop(db, bounty, {
        reason: first.id,
        ref: first.ref,
        message: `${first.headline}. Claims and alerts for this bounty are paused until it passes every check again.`,
        now,
        onlyUnwarned: true,
      });
    } else out.reopened = reopenNotices(db, bounty, now);
    return out;
  });
}

/**
 * Re-evaluates every open live bounty for a barcode (any barcode spelling;
 * all open live bounties when none is given), optionally only at one
 * retailer, against the evidence now, and sends "Don't make the trip" (or
 * reopen) notices before returning. Call it after a branch availability
 * check is recorded and after an import changes offers or sales. Returns
 * { checked, bountyIds, stopped: [{ bountyId, title, reasons, noticesSent }],
 * reopened: [{ bountyId, title, noticesSent }] }.
 */
export function recheckOpenBounties(db, { barcode = null, retailer = null, now } = {}) {
  const at = iso(clock(now));
  const out = { checked: 0, bountyIds: [], stopped: [], reopened: [] };
  const given = barcode !== null && barcode !== undefined && barcode !== "";
  const gtin = given ? normaliseBarcode(barcode) : null;
  if (given && !gtin) return out;
  const shop = typeof retailer === "string" && retailer.trim() ? normaliseLocality(retailer) : null;
  const rows = db
    .prepare(
      `SELECT * FROM bounties WHERE sample = 0 AND status = 'open' AND expires_at > ?${gtin ? " AND barcode = ?" : ""} ORDER BY id`,
    )
    .all(...(gtin ? [at, gtin] : [at]))
    .map(plain)
    .filter((b) => !shop || normaliseLocality(b.retailer) === shop);
  for (const bounty of rows) {
    out.checked++;
    out.bountyIds.push(bounty.id);
    const result = syncTrip(db, bounty, now);
    if (result.stopped)
      out.stopped.push({ bountyId: bounty.id, title: bounty.title, reasons: result.reasons, noticesSent: result.noticesSent });
    else if (result.reopened)
      out.reopened.push({ bountyId: bounty.id, title: bounty.title, noticesSent: result.reopened });
  }
  return out;
}

/**
 * Largest claim: the trial batch, or the stricter batch size the estimate
 * used when the operator tightened the thresholds.
 */
export function trialBatch(bounty) {
  const tightened = json(bounty.opportunity, null)?.trialUnits;
  return Number.isSafeInteger(tightened) && tightened >= 1
    ? Math.min(BOUNTY_RULES.maxClaimUnits, tightened)
    : BOUNTY_RULES.maxClaimUnits;
}

/**
 * Units of an item (barcode) a member holds in live claims or has marked as
 * bought, across every live bounty for that barcode.
 */
export function memberItemUnits(db, memberId, barcode, now) {
  if (!barcode) return 0;
  return db
    .prepare(
      `SELECT COALESCE(SUM(c.units), 0) AS n FROM claims c JOIN bounties b ON b.id = c.bounty_id
 WHERE c.member_id = ? AND b.barcode = ? AND b.sample = 0
 AND (c.status = 'completed' OR (c.status = 'active' AND c.expires_at > ?))`,
    )
    .get(memberId, barcode, iso(clock(now))).n;
}

/**
 * How many more units a member may claim on a bounty. Until a verified
 * trade proves the item, one member's total across claims held and units
 * bought is a single trial batch (the bounty's, or the member's own
 * stricter one), so repeated trial batches cannot add up.
 */
export function trialAllowance(db, bounty, member, now) {
  const limit = Math.min(trialBatch(bounty), effectiveRules(memberRules(member)).trialUnits);
  const proven = json(bounty.opportunity, null)?.provenItem === true;
  const held = proven ? 0 : memberItemUnits(db, member.id, bounty.barcode, now);
  return { limit, held, proven, allowance: Math.max(0, limit - held) };
}

/**
 * Reasons a live bounty fails a member's own stricter thresholds (empty
 * when the member set none or it passes). Unknown figures fail closed.
 */
export function memberRuleFailures(bounty, member) {
  const overrides = memberRules(member);
  if (bounty.sample || !Object.keys(overrides).length) return [];
  const rules = effectiveRules(overrides);
  const o = json(bounty.opportunity, null) ?? {};
  const snapshot = json(bounty.estimate, null);
  const unitPrice = Number.isSafeInteger(o.unitPrice) ? o.unitPrice : snapshot?.unitCost;
  const failures = [];
  if (!Number.isSafeInteger(unitPrice)) failures.push("Purchase price unknown, so your thresholds cannot be checked");
  else if (unitPrice < rules.minUnitPrice || unitPrice > rules.maxUnitPrice)
    failures.push(
      `Purchase price ${pounds(unitPrice)} is outside your band of ${pounds(rules.minUnitPrice)} to ${pounds(rules.maxUnitPrice)}`,
    );
  if (!isPositive(o.weightKg)) failures.push("Unit weight unknown, so your weight limit cannot be checked");
  else if (o.weightKg >= rules.maxWeightKg)
    failures.push(`Unit weighs ${o.weightKg} kg, not under your limit of ${rules.maxWeightKg} kg`);
  if (!Number.isSafeInteger(o.unitProfit)) failures.push("Profit per unit unknown, so your thresholds cannot be checked");
  else {
    if (o.unitProfit < rules.minUnitProfit)
      failures.push(`Profit per unit ${pounds(o.unitProfit)} is below your ${pounds(rules.minUnitProfit)}`);
    if (Number.isSafeInteger(unitPrice) && !meetsReturn(o.unitProfit, unitPrice, rules.minReturn))
      failures.push(
        `Return on purchase price ${percentDown(o.unitProfit / unitPrice)} is below your ${percentDown(rules.minReturn)}`,
      );
  }
  return failures;
}

/** The promotion condition on a live bounty, or null. */
function promotionOf(bounty) {
  return bounty.sample ? null : (json(bounty.estimate, null)?.promotion ?? null);
}

/** What a member who does not qualify for a promotion price risks paying. */
export function promotionRisk(promotion, unitProfit = null) {
  if (!promotion) return null;
  if (promotion.costedAt === "regular")
    return `Costed at the regular price of ${pounds(promotion.regularPrice)}: the promotion price applies only if you qualify.`;
  if (Number.isSafeInteger(promotion.regularPrice) && Number.isSafeInteger(promotion.price)) {
    const gap = promotion.regularPrice - promotion.price;
    const atRegular = Number.isSafeInteger(unitProfit) ? unitProfit - gap : null;
    return `If you do not qualify you pay the regular price of ${pounds(promotion.regularPrice)}, ${pounds(gap)} more per unit${atRegular === null ? "" : `, which leaves about ${pounds(atRegular)} profit per unit`}.`;
  }
  return "If you do not qualify you pay more, and the regular price is not known, so the trip may lose money.";
}

// ------------------------------------------------------ promotion answers

/** True for a new-customer, first-order or welcome offer: usable once per shopper at a retailer. */
export const isFirstOrderOffer = (condition) =>
  typeof condition === "string" &&
  /\b(new[- ]customers?|first[- ](order|purchase|shop|time|delivery)|welcome (offer|discount|voucher)|introductory)\b/i.test(condition);

export const ELIGIBILITY_ANSWERS = Object.freeze(["qualifies", "not", "used"]);

/**
 * Where a member stands on a bounty's promotion price, or null when the
 * bounty's figures do not depend on one (no promotion, or costed at the
 * known regular price): { condition, firstOrder, retailer, answer,
 * usedHere, confirmed, question }. answer is the member's answer for this
 * bounty ("qualifies", "not", "used") or null; usedHere is true when they
 * said they already used a first-order offer at this retailer (on any
 * bounty). confirmed is true only when they said they qualify and have not
 * since said they used such an offer here.
 */
export function promotionStanding(db, bounty, member) {
  const promotion = promotionOf(bounty);
  if (!promotion?.needsMemberConfirmation) return null;
  const firstOrder = isFirstOrderOffer(promotion.condition);
  const retailer = normaliseLocality(bounty.retailer);
  const row = member
    ? db.prepare("SELECT answer FROM promotion_answers WHERE member_id = ? AND bounty_id = ?").get(member.id, bounty.id)
    : null;
  const answer = row?.answer ?? null;
  const usedHere =
    firstOrder && member
      ? Boolean(
          db
            .prepare("SELECT 1 FROM promotion_answers WHERE member_id = ? AND retailer = ? AND first_order = 1 AND answer = 'used' LIMIT 1")
            .get(member.id, retailer),
        )
      : false;
  return {
    condition: promotion.condition,
    firstOrder,
    retailer: bounty.retailer,
    answer,
    usedHere,
    confirmed: answer === "qualifies" && !usedHere,
    question: firstOrder
      ? `This price is a first-order or new-customer offer at ${bounty.retailer}: "${promotion.condition}". Do you qualify, that is, have you never used such an offer at ${bounty.retailer}?`
      : `This price depends on a promotion: "${promotion.condition}". Do you qualify for it yourself?`,
  };
}

/**
 * Records a member's answer to a bounty's promotion question: "qualifies",
 * "not" (not alerted for this bounty) or "used" (already used a first-order
 * offer at this retailer, so first-order offers there are never alerted to
 * them again). Saying "qualifies" withdraws an earlier "used" at this
 * retailer. Returns promotionStanding after the answer.
 */
export function answerPromotion(db, { bountyId, memberId, answer, now }) {
  const at = iso(clock(now));
  const choice = oneOf(answer, "answer", ELIGIBILITY_ANSWERS);
  return transaction(db, () => {
    const bounty = requireBounty(db, bountyId);
    const member = requireMember(db, memberId);
    const promotion = promotionOf(bounty);
    if (!promotion?.needsMemberConfirmation)
      fail("This bounty's figures do not depend on a promotion, so there is nothing to answer", 409);
    const firstOrder = isFirstOrderOffer(promotion.condition);
    if (choice === "used" && !firstOrder)
      fail("This promotion is not a first-order or new-customer offer: answer qualifies or not", 400);
    const retailer = normaliseLocality(bounty.retailer);
    if (choice === "qualifies")
      db.prepare("DELETE FROM promotion_answers WHERE member_id = ? AND retailer = ? AND first_order = 1 AND answer = 'used'").run(
        member.id,
        retailer,
      );
    db.prepare(
      `INSERT INTO promotion_answers(member_id, bounty_id, retailer, condition, first_order, answer, created)
 VALUES(?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(member_id, bounty_id) DO UPDATE SET answer = excluded.answer, created = excluded.created,
 retailer = excluded.retailer, condition = excluded.condition, first_order = excluded.first_order`,
    ).run(member.id, bounty.id, retailer, promotion.condition, firstOrder ? 1 : 0, choice, at);
    return promotionStanding(db, bounty, member);
  });
}

// ------------------------------------------------------- member's own trip

/** A member's own return journey from a request: both cost and minutes are required, a blank is never zero. */
export function journeyInput(input) {
  const blank = (v) => v === undefined || v === null || v === "";
  if (!isObject(input) || blank(input.journeyCost) || blank(input.journeyMinutes))
    fail(
      "Enter your own return journey cost (pence) and time (minutes) for this trip. A blank is never counted as zero: enter 0 only if the trip really costs nothing, for example walking",
    );
  return {
    cost: int(input.journeyCost, "journeyCost", 0, 100000),
    minutes: int(input.journeyMinutes, "journeyMinutes", 0, 1440),
  };
}

/** The stricter of several sets of threshold overrides, as overrides. */
function stricterRules(...sets) {
  let rules = OPPORTUNITY_RULES;
  for (const set of sets) if (isObject(set)) rules = effectiveRules(set, rules);
  return Object.fromEntries(MEMBER_RULE_KEYS.filter((k) => rules[k] !== OPPORTUNITY_RULES[k]).map((k) => [k, rules[k]]));
}

/**
 * The estimate request for one member's own trip on a bounty: the stored
 * request at the units they claim, with their own journey, the stricter of
 * the operator's and the member's thresholds, and their own promotion
 * answer (never the operator's).
 */
export function memberRequest(bounty, member, { units, journey, qualifies = false }) {
  const request = storedRequest(bounty);
  if (!isObject(request)) return null;
  return {
    ...request,
    units,
    costs: { ...(isObject(request.costs) ? request.costs : {}), journeyCost: journey.cost, journeyMinutes: journey.minutes },
    rules: stricterRules(request.rules, memberRules(member)),
    promotionEligible: qualifies === true,
  };
}

/**
 * Whether a member's own trip passes, from the estimate re-run for them
 * (memberRequest): { ok, units, journey, figures, reasons }. Every buy-alert
 * check must pass at their units with their journey and thresholds, and the
 * figures must be for exactly those units and that journey cost. Unknown
 * figures fail closed.
 */
export function memberTripCheck(result, { units, journey }) {
  const reasons = [];
  const e = isObject(result) && !result.error ? result.economics : null;
  const o = isObject(result?.opportunity) ? result.opportunity : {};
  if (!isObject(result) || result.error)
    reasons.push("Your figures could not be worked out" + (result?.error ? ": " + result.error : ""));
  else if (!isObject(e)) reasons.push("No completed-sale price for this item, so your profit cannot be worked out");
  else {
    if (e.units !== units) reasons.push(`The figures were worked out for ${plural(e.units, "unit")}, not your ${units}`);
    if (isObject(e.costs) && e.costs.travel !== journey.cost) reasons.push("The figures do not use your journey cost");
    const thresholds = o.meetsThresholds === true ? [] : Array.isArray(o.reasons) ? o.reasons.map(String) : [];
    const checks = result.alert?.eligible === true ? [] : Array.isArray(result.alert?.reasons) ? result.alert.reasons.map(String) : ["The buy-alert checks did not run"];
    for (const r of [...thresholds, ...checks]) if (!reasons.includes(r)) reasons.push(r);
  }
  const unitProfit = Number.isSafeInteger(o.unitProfit) ? o.unitProfit : e && e.units ? Math.floor(e.contribution / e.units) : null;
  return {
    ok: reasons.length === 0,
    units,
    journey,
    figures: e
      ? {
          units: e.units,
          unitCost: e.unitCost ?? null,
          salePrice: e.salePrice ?? null,
          contribution: e.contribution ?? null,
          unitProfit,
          returnOnCost: Number.isFinite(o.returnOnCost) ? o.returnOnCost : null,
          hourly: Number.isFinite(e.hourly) ? e.hourly : null,
          cashRequired: e.cashRequired ?? null,
          activeMinutes: e.activeMinutes ?? null,
          tier: typeof o.tier === "string" ? o.tier : null,
        }
      : null,
    reasons,
  };
}

/** Plain words for a member's trip check, for messages and the claim form. */
export function memberTripText(check) {
  const where = `${plural(check.units, "unit")} with your journey (${pounds(check.journey.cost)}, ${plural(check.journey.minutes, "minute")})`;
  if (!check.ok) return `At ${where} this trip fails: ${check.reasons.join("; ")}.`;
  const f = check.figures;
  return `At ${where}: profit per unit ${pounds(f.unitProfit)}${f.returnOnCost === null ? "" : `, return ${percentDown(f.returnOnCost)}`}${f.hourly === null ? "" : `, ${pounds(f.hourly)} an hour`}, cash needed before payout ${pounds(f.cashRequired)}. Every check passes.`;
}

/**
 * Claims units on a bounty inside BEGIN IMMEDIATE, so concurrent claims
 * serialise and the cap cannot be oversubscribed. Stale claims expire first.
 * The bounty must be live (never a sample), open and unexpired, pass its
 * buy-alert checks, have a fresh offer and a current stock check, not be
 * paused by a negative report, and be inside the member's release window.
 * It must pass the member's own stricter thresholds, and a promotion or
 * loyalty price needs the member's own confirmation (qualifiesForPromotion,
 * or an earlier "qualifies" answer) that they qualify. One active claim per
 * member per bounty; until the item is proven, the member's units held and
 * bought across its bounties stay within one trial batch; the units held
 * plus the new units must fit the cap. A claim reserves attention, not
 * retailer stock.
 *
 * journey { cost, minutes } is the member's own return journey (required)
 * and check is the estimate re-run for them at these units with that
 * journey (memberRequest): the claim is refused with the failing reasons
 * unless every check passes on their own figures.
 */
export function claim(db, { bountyId, memberId, units, journey, check, qualifiesForPromotion = false, now }) {
  const at = clock(now);
  return transaction(db, () => {
    expireClaims(db, now);
    const bounty = requireBounty(db, bountyId);
    const max = trialBatch(bounty);
    if (!Number.isSafeInteger(units) || units < 1 || units > max)
      fail(`units must be a whole number from 1 to ${max}: a claim is at most a trial batch until a verified trade exists`);
    const count = units;
    const member = requireMember(db, memberId);
    const blockers = tripBlockers(db, bounty, now);
    if (blockers.length) fail(blockers.join(". ") + ".", 409);
    const trip = journeyInput({ journeyCost: journey?.cost, journeyMinutes: journey?.minutes });
    const release = releaseFor(db, bounty, member, now);
    if (!release.open)
      fail(
        `Your release window for this bounty opens at ${humanTime(release.releaseAt)} (${release.tier.name}, via ${release.via === "paid" ? "paid early access" : "earned reputation"}).`,
        409,
      );
    const existing = db
      .prepare("SELECT id FROM claims WHERE bounty_id = ? AND member_id = ? AND status = 'active'")
      .get(bounty.id, member.id);
    if (existing) fail("You already have an active claim on this bounty. Release it before claiming again.", 409);
    const failures = memberRuleFailures(bounty, member);
    if (failures.length) fail("This bounty fails your stricter thresholds: " + failures.join("; ") + ".", 409);
    const trial = trialAllowance(db, bounty, member, now);
    if (count > trial.allowance)
      fail(
        trial.allowance === 0
          ? `You already hold or have bought ${plural(trial.held, "unit")} of this item. Until a verified trade exists, one member's total is a trial batch of ${plural(trial.limit, "unit")}.`
          : `You can claim at most ${plural(trial.allowance, "more unit")} of this item: until a verified trade exists, one member's total is a trial batch of ${plural(trial.limit, "unit")}, and you hold or have bought ${trial.held}.`,
        409,
      );
    const promotion = promotionOf(bounty);
    const standing = promotionStanding(db, bounty, member);
    if (standing?.usedHere && qualifiesForPromotion !== true)
      fail(
        `You said you have already used a first-order offer at ${bounty.retailer}, so this price ("${standing.condition}") is not open to you. If that was a mistake, answer that you qualify first.`,
        409,
      );
    const qualifies = qualifiesForPromotion === true || standing?.confirmed === true;
    if (promotion?.needsMemberConfirmation && !qualifies)
      fail(
        `This price depends on a promotion: "${promotion.condition}". Confirm that you qualify before claiming. ${promotionRisk(promotion, json(bounty.opportunity, null)?.unitProfit)}`,
        409,
      );
    const own = memberTripCheck(check, { units: count, journey: trip });
    if (!own.ok) fail(memberTripText(own), 409);
    const held = claimedUnits(db, bounty.id, now);
    const remaining = Math.max(0, bounty.cap - held.committed);
    if (count > remaining)
      fail(
        remaining === 0
          ? capFullMessage(bounty) +
              " A claim reserves attention, not retailer stock, so the cap limits how many people are sent."
          : `Only ${remaining} unit${remaining === 1 ? " remains" : "s remain"} under this bounty's distribution cap.`,
        409,
      );
    if (promotion?.needsMemberConfirmation && qualifiesForPromotion === true && standing?.answer !== "qualifies")
      answerPromotion(db, { bountyId: bounty.id, memberId: member.id, answer: "qualifies", now });
    const result = db
      .prepare(
        `INSERT INTO claims(bounty_id, member_id, units, status, created, expires_at, promotion, promotion_confirmed,
 journey_cost, journey_minutes, figures)
 VALUES(?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        bounty.id, member.id, count, iso(at), iso(at + BOUNTY_RULES.claimHours * HOUR), promotion?.condition ?? null,
        promotion && qualifies ? 1 : 0, trip.cost, trip.minutes, JSON.stringify(own.figures),
      );
    return getClaim(db, Number(result.lastInsertRowid));
  });
}

const getClaim = (db, claimId) => plain(db.prepare("SELECT * FROM claims WHERE id = ?").get(claimId));

function activeClaimFor(db, claimId, memberId, now) {
  expireClaims(db, now);
  const found = getClaim(db, id(claimId, "claimId")) ?? fail("Claim not found", 404);
  if (found.member_id !== id(memberId, "memberId"))
    fail("Only the member who made a claim can change it", 403);
  if (found.status !== "active") fail(`This claim is already ${found.status}`, 409);
  return found;
}

/** Releases an active claim, freeing its units for other members. */
export function releaseClaim(db, { claimId, memberId, now }) {
  const at = iso(clock(now));
  return transaction(db, () => {
    const found = activeClaimFor(db, claimId, memberId, now);
    db.prepare("UPDATE claims SET status = 'released', ended_at = ? WHERE id = ?").run(at, found.id);
    return getClaim(db, found.id);
  });
}

/**
 * Marks an active claim as bought. unitsBought (default: the units claimed,
 * never more) stays held against the cap; any unbought units are freed.
 * Buying earns no reputation: a trade is verified only with the purchase
 * receipt and the payout record in the Ledger. A claim on a sample bounty
 * (only possible in an older database) can never be marked as bought.
 */
export function completeClaim(db, { claimId, memberId, unitsBought, now }) {
  const at = iso(clock(now));
  return transaction(db, () => {
    const found = activeClaimFor(db, claimId, memberId, now);
    if (requireBounty(db, found.bounty_id).sample)
      fail("Sample bounty: illustrative figures only, so there is nothing to mark as bought. Release this claim.", 409);
    const units = unitsBought === undefined || unitsBought === null ? found.units : int(unitsBought, "units", 1, found.units);
    db.prepare("UPDATE claims SET status = 'completed', units = ?, ended_at = ? WHERE id = ?").run(units, at, found.id);
    return getClaim(db, found.id);
  });
}

// ---------------------------------------------------------- stock reports

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** True when the bytes start with the signature of the declared type. */
export function photoMagicMatches(buffer, mediaType) {
  const magic = mediaType === "image/jpeg" ? JPEG_MAGIC : mediaType === "image/png" ? PNG_MAGIC : null;
  return Boolean(magic && buffer.length > magic.length && buffer.subarray(0, magic.length).equals(magic));
}

/**
 * Validates and prepares an uploaded shelf photo: { mediaType, data } with
 * base64 data of a JPEG or PNG, at most 5 MB, whose bytes match the declared
 * type. Location, camera and text metadata are stripped before hashing.
 * Returns { buffer, mediaType, sha256, bytes } of the stripped image.
 */
export function preparePhoto(photo) {
  if (!isObject(photo)) fail("photo must be { mediaType, data }");
  const mediaType = oneOf(photo.mediaType, "photo.mediaType", PHOTO_RULES.mediaTypes);
  if (typeof photo.data !== "string") fail("photo.data must be base64 text");
  const clean = photo.data.replace(/\s+/g, "");
  if (!clean || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean))
    fail("photo.data must be base64 text");
  const tooBig = "The photo must be 5 MB or smaller";
  if (clean.length > Math.ceil(PHOTO_RULES.maxBytes / 3) * 4) fail(tooBig);
  const raw = Buffer.from(clean, "base64");
  if (raw.length > PHOTO_RULES.maxBytes) fail(tooBig);
  if (!photoMagicMatches(raw, mediaType))
    fail(`The photo's contents are not a ${mediaType === "image/jpeg" ? "JPEG" : "PNG"} image`);
  let buffer;
  try {
    buffer = stripMetadata(raw, mediaType);
  } catch (error) {
    fail("The photo could not be read: " + error.message);
  }
  return {
    buffer,
    mediaType,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    bytes: buffer.length,
  };
}

/**
 * Writes a prepared photo to <dir>/<sha256> with file mode 0600 inside a
 * directory with mode 0700. Content addressed, so the same image is stored
 * once. Files are never served over HTTP. Returns { path, created }.
 */
export function savePhoto(dir, photo) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, photo.sha256);
  try {
    writeFileSync(path, photo.buffer, { mode: 0o600, flag: "wx" });
    chmodSync(path, 0o600);
    return { path, created: true };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    chmodSync(path, 0o600);
    return { path, created: false };
  }
}

/**
 * Records a stock report. unitsSeen 0 is a negative report (none on the
 * shelf), which pauses claims and alerts until a later positive report and,
 * when it is the latest report, sends a "Don't make the trip" notice to
 * every other member alerted for the bounty or holding a live claim on it.
 * observedAt defaults to now, cannot be in the future and must be within the
 * last 48 hours. An optional photo ({ mediaType, data }) is stripped of
 * metadata and stored privately under options.photoDir; only its hash, size
 * and type are kept in the database.
 */
export function addReport(db, input, { now, photoDir } = {}) {
  const at = clock(now);
  if (!isObject(input)) fail("Send a stock report as a JSON object");
  const unitsSeen = int(input.unitsSeen, "unitsSeen", 0, 10000);
  let observed = at;
  if (input.observedAt !== undefined && input.observedAt !== null && input.observedAt !== "") {
    observed = instant(input.observedAt, "observedAt");
    if (observed > at + 5 * MINUTE) fail("observedAt cannot be in the future");
    if (observed < at - BOUNTY_RULES.reportMaxAgeHours * HOUR)
      fail(`observedAt must be within the last ${BOUNTY_RULES.reportMaxAgeHours} hours`);
    observed = Math.min(observed, at);
  }
  const note = text(input.note, "note", 500, { optional: true });
  const photo = input.photo === undefined || input.photo === null ? null : preparePhoto(input.photo);
  if (photo && !photoDir) throw Error("photoDir is required to store a photo");
  return transaction(db, () => {
    const bounty = requireBounty(db, input.bountyId);
    const member = requireMember(db, input.memberId);
    const status = bountyStatus(bounty, now);
    if (status !== "open") fail(`This bounty is ${status}: stock reports are closed`, 409);
    const saved = photo ? savePhoto(photoDir, photo) : null;
    try {
      const result = db
        .prepare(
          `INSERT INTO stock_reports(bounty_id, member_id, units_seen, observed_at, note, photo_sha256, photo_bytes,
 photo_media_type, created) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          bounty.id, member.id, unitsSeen, iso(observed), note, photo?.sha256 ?? null, photo?.bytes ?? null,
          photo?.mediaType ?? null, iso(at),
        );
      const report = getReport(db, Number(result.lastInsertRowid));
      if (unitsSeen === 0) stopForEmptyShelf(db, bounty, report, { now, exclude: member.id });
      return report;
    } catch (error) {
      if (saved?.created) unlinkSync(saved.path);
      throw error;
    }
  });
}

const getReport = (db, reportId) => plain(db.prepare("SELECT * FROM stock_reports WHERE id = ?").get(reportId));

/**
 * Notices for an empty-shelf report, sent only while it is the report that
 * decides the shelf (an older report behind a newer sighting stops nobody).
 * Keyed on the time the shelf was seen empty, so the report, its
 * verification and the branch check it becomes notify each member once.
 */
function stopForEmptyShelf(db, bounty, report, { now, exclude = null, confirmed = false }) {
  if (bounty.sample || report.units_seen !== 0) return 0;
  const shelf = shelfStatus(db, bounty.id);
  if (!shelf.paused || shelf.reportId !== report.id) return 0;
  return notifyStop(db, bounty, {
    reason: confirmed ? "verified-empty" : "empty-shelf",
    ref: "empty:" + report.observed_at,
    message: `${TERMS.stop}: ${confirmed ? "the operator confirmed a report of" : "a member reported"} none on the shelf at ${humanTime(report.observed_at)}. Claims and alerts for this bounty are paused until someone reports stock again.`,
    now,
    exclude,
  });
}

/**
 * The shelf as the latest stock report describes it, ignoring reports the
 * operator marked inaccurate: "unknown" (no report), "seen" or "none". A
 * "none" report pauses claims and alerts.
 */
export function shelfStatus(db, bountyId) {
  const latest = db
    .prepare(
      `SELECT id, units_seen, observed_at, verified FROM stock_reports
 WHERE bounty_id = ? AND (verified IS NULL OR verified != 'inaccurate')
 ORDER BY observed_at DESC, id DESC LIMIT 1`,
    )
    .get(bountyId);
  if (!latest) return { state: "unknown", paused: false, at: null, unitsSeen: null, verified: null, reportId: null };
  const none = latest.units_seen === 0;
  return {
    state: none ? "none" : "seen",
    paused: none,
    at: latest.observed_at,
    unitsSeen: latest.units_seen,
    verified: latest.verified,
    reportId: latest.id,
  };
}

/**
 * Operator verification of a stock report. Accurate reports earn
 * REPUTATION_RULES.accurateReport points whether they found stock or an
 * empty shelf; inaccurate reports earn none and stop counting towards the
 * shelf status. A report is verified once. Reports on sample bounties and
 * repeat reports by the same member on the same bounty and UTC day are
 * recorded as accurate but earn nothing.
 *
 * options.recordCheck(db, check, { now }) (audit.mjs recordCheck) receives a
 * verified accurate report on a live bounty as an in-store availability
 * check, so the estimate's branch stock check can use it. A verified
 * empty-shelf report that still decides the shelf makes sure everyone
 * alerted or holding a claim has a "Don't make the trip" notice.
 */
export function verifyReport(db, reportId, accurate, { now, recordCheck = null } = {}) {
  const at = iso(clock(now));
  const isAccurate = bool(accurate, "accurate");
  return transaction(db, () => {
    const report = getReport(db, id(reportId, "reportId")) ?? fail("Report not found", 404);
    if (report.verified) fail(`This report was already verified as ${report.verified}`, 409);
    const bounty = requireBounty(db, report.bounty_id);
    db.prepare("UPDATE stock_reports SET verified = ?, verified_at = ? WHERE id = ?").run(
      isAccurate ? "accurate" : "inaccurate",
      at,
      report.id,
    );
    let points = 0;
    let reason;
    if (!isAccurate) reason = "Inaccurate report: no points";
    else if (bounty.sample) reason = "Sample bounty: reports are for demonstration and earn no points";
    else {
      const rewarded = db
        .prepare(
          `SELECT COUNT(*) AS n FROM reputation_events e JOIN stock_reports r ON r.id = e.report_id
 WHERE e.member_id = ? AND e.points > 0 AND r.bounty_id = ? AND substr(r.observed_at, 1, 10) = ?`,
        )
        .get(report.member_id, bounty.id, report.observed_at.slice(0, 10)).n;
      if (rewarded >= REPUTATION_RULES.rewardedReportsPerBountyPerDay)
        reason = "Accurate, but a report on this bounty already earned points that day";
      else {
        points = REPUTATION_RULES.accurateReport;
        reason = report.units_seen === 0 ? "Accurate stock report: none on the shelf" : "Accurate stock report: stock seen";
      }
    }
    if (points > 0)
      db.prepare("INSERT INTO reputation_events(member_id, report_id, points, reason, created) VALUES(?, ?, ?, ?, ?)").run(
        report.member_id,
        report.id,
        points,
        reason,
        at,
      );
    if (isAccurate) stopForEmptyShelf(db, bounty, report, { now, exclude: report.member_id, confirmed: true });
    let check = null;
    if (isAccurate && !bounty.sample && bounty.barcode && typeof recordCheck === "function")
      check = recordCheck(
        db,
        {
          barcode: bounty.barcode,
          retailer: bounty.retailer,
          locality: bounty.locality,
          checkedAt: report.observed_at,
          method: "in_store",
          inStock: report.units_seen > 0,
          unitsSeen: report.units_seen,
          note: `Bounty ${bounty.id} stock report ${report.id}, verified accurate by the operator`,
        },
        { now },
      );
    return { report: getReport(db, report.id), points, reason, stockCheckId: check?.id ?? null };
  });
}

// ------------------------------------------------------------------ alerts

/**
 * Sends a bounty's alerts that are due at `now`.
 *
 * Nothing is sent unless the bounty is open, unexpired, not a sample, passes
 * its buy-alert checks and every live trip check (blockerList: stock, offer
 * price and freshness, sales age, display) and has room under its cap. Then
 * only members who opted in and list the bounty's locality are considered,
 * each at most once, and never a member who already claimed it, whose own
 * stricter thresholds it fails, or who already holds or bought a trial
 * batch of the item. A member becomes due when now is at least
 * bounty.created plus their tier's offsetMinutes (paid tier while current,
 * or earned tier, whichever is earlier), so calling again later releases
 * further tiers. Due members are ordered by window, then by earned
 * reputation. The exposure limit allows at most 2 x remaining cap alerts in
 * total per bounty, so with little stock later tiers receive nothing.
 *
 * When the price is a promotion only some shoppers get (a new-customer or
 * first-order offer, a loyalty price), a member who has not said they
 * qualify gets an eligibility question instead (kind "question": no
 * figures, and it does not count towards the exposure limit). When they
 * answer that they qualify, calling again for them (options.memberId) turns
 * it into an alert. A member who said they do not qualify, or that they
 * already used a first-order offer at the retailer, is not alerted.
 *
 * Returns { bountyId, sent, asked, notAlerted, blockers, exposure,
 * nextReleaseAt, promotion, warning }.
 */
export function dispatchAlerts(db, bountyId, now, { memberId = null } = {}) {
  const at = clock(now);
  return transaction(db, () => {
    expireClaims(db, now);
    const bounty = requireBounty(db, bountyId);
    const held = claimedUnits(db, bounty.id, now);
    const remaining = Math.max(0, bounty.cap - held.committed);
    const alreadySent = db
      .prepare("SELECT COUNT(*) AS n FROM alerts WHERE bounty_id = ? AND kind = 'alert'")
      .get(bounty.id).n;
    const limit = BOUNTY_RULES.exposurePerUnit * remaining;
    const exposure = {
      cap: bounty.cap,
      committed: held.committed,
      remaining,
      limit,
      alreadySent,
      budget: Math.max(0, limit - alreadySent),
    };
    syncTrip(db, bounty, now);
    const blockers = [...tripBlockers(db, bounty, now)];
    if (remaining <= 0) blockers.push(capFullMessage(bounty));
    const promotion = promotionOf(bounty);
    const validation = bounty.sample ? null : validationStatus(db, bounty.locality);
    const result = {
      bountyId: bounty.id,
      sent: [],
      asked: [],
      notAlerted: [],
      blockers,
      exposure,
      nextReleaseAt: null,
      promotion: promotion ? { condition: promotion.condition, regularPrice: promotion.regularPrice } : null,
      warning: validation?.warning ?? null,
    };
    if (blockers.length) return result;

    const locality = normaliseLocality(bounty.locality);
    const earlier = new Map(
      db
        .prepare("SELECT member_id, kind FROM alerts WHERE bounty_id = ?")
        .all(bounty.id)
        .map((r) => [r.member_id, r.kind]),
    );
    const claimed = new Set(
      db
        .prepare("SELECT member_id FROM claims WHERE bounty_id = ? AND status IN ('active', 'completed')")
        .all(bounty.id)
        .map((r) => r.member_id),
    );
    const due = [];
    let next = null;
    const members = listMembers(db).filter((m) => memberId === null || m.id === memberId);
    for (const member of members) {
      const who = { memberId: member.id, name: member.name };
      if (member.alerts_opt_in !== 1) {
        result.notAlerted.push({ ...who, reason: "Not opted in to alerts" });
        continue;
      }
      const places = json(member.alert_localities, []).map(normaliseLocality);
      if (!places.includes(locality)) {
        result.notAlerted.push({ ...who, reason: `Alert localities do not include ${bounty.locality}` });
        continue;
      }
      if (earlier.get(member.id) === "alert") {
        result.notAlerted.push({ ...who, reason: "Already alerted for this bounty" });
        continue;
      }
      if (claimed.has(member.id)) {
        result.notAlerted.push({ ...who, reason: "Already claimed this bounty" });
        continue;
      }
      const failures = memberRuleFailures(bounty, member);
      if (failures.length) {
        result.notAlerted.push({ ...who, reason: "Fails the member's stricter thresholds: " + failures.join("; ") });
        continue;
      }
      if (trialAllowance(db, bounty, member, now).allowance === 0) {
        result.notAlerted.push({
          ...who,
          reason: "Already holds or bought a trial batch of this item, and no verified trade exists yet",
        });
        continue;
      }
      const standing = promotionStanding(db, bounty, member);
      if (standing?.usedHere) {
        result.notAlerted.push({
          ...who,
          reason: `Said they already used a first-order offer at ${bounty.retailer}, so this price is not open to them`,
        });
        continue;
      }
      if (standing?.answer === "not") {
        result.notAlerted.push({ ...who, reason: `Said they do not qualify for the promotion price (${standing.condition})` });
        continue;
      }
      const release = releaseFor(db, bounty, member, now);
      if (!release.open) {
        result.notAlerted.push({
          ...who,
          reason: `Release window opens at ${humanTime(release.releaseAt)} (${release.tier.name}, via ${release.via === "paid" ? "paid early access" : "earned reputation"})`,
          releaseAt: release.releaseAt,
        });
        if (!next || release.releaseAt < next) next = release.releaseAt;
        continue;
      }
      due.push({ member, release, ask: Boolean(standing && !standing.confirmed), asked: earlier.get(member.id) === "question" });
    }
    // Earlier window first; within a window, more earned reputation first.
    due.sort(
      (a, b) =>
        a.release.tier.offsetMinutes - b.release.tier.offsetMinutes ||
        b.release.points - a.release.points ||
        a.member.id - b.member.id,
    );
    const insert = db.prepare(
      `INSERT INTO alerts(bounty_id, member_id, tier, via, release_at, reputation, promotion, warning, kind, created)
 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const upgrade = db.prepare(
      `UPDATE alerts SET kind = 'alert', tier = ?, via = ?, release_at = ?, reputation = ?, promotion = ?, warning = ?, created = ?
 WHERE bounty_id = ? AND member_id = ?`,
    );
    let used = 0;
    for (const { member, release, ask, asked } of due) {
      const who = { memberId: member.id, name: member.name };
      if (ask) {
        if (asked) {
          result.notAlerted.push({ ...who, reason: "Asked whether they qualify for the promotion price: waiting for their answer" });
          continue;
        }
        insert.run(
          bounty.id, member.id, release.tier.id, release.via, release.releaseAt, release.points,
          promotion?.condition ?? null, result.warning, "question", iso(at),
        );
        result.asked.push({ ...who, condition: promotion?.condition ?? null });
        continue;
      }
      if (used >= exposure.budget) {
        result.notAlerted.push({
          ...who,
          reason: `Exposure limit reached: at most ${BOUNTY_RULES.exposurePerUnit} alerts per unit left under the cap`,
        });
        continue;
      }
      used++;
      if (asked)
        upgrade.run(
          release.tier.id, release.via, release.releaseAt, release.points, promotion?.condition ?? null, result.warning,
          iso(at), bounty.id, member.id,
        );
      else
        insert.run(
          bounty.id, member.id, release.tier.id, release.via, release.releaseAt, release.points,
          promotion?.condition ?? null, result.warning, "alert", iso(at),
        );
      result.sent.push({
        ...who,
        tier: release.tier,
        via: release.via,
        label: release.via === "paid" ? "Paid early access" : "Earned release",
        reputation: release.points,
        releaseAt: release.releaseAt,
      });
    }
    result.exposure.alreadySent = alreadySent + result.sent.length;
    result.exposure.budget = Math.max(0, limit - result.exposure.alreadySent);
    result.nextReleaseAt = result.exposure.budget > 0 ? next : null;
    return result;
  });
}

/**
 * Whether a bounty can send anyone on a trip now, for the card and the
 * alert inbox: { state, go, label, headline, reason }. state is "go",
 * "full" (the cap leaves nothing to claim, though members holding a claim
 * may go), "paused" (an empty-shelf report), "out-of-stock" (the newest
 * branch check found none), "stock-unconfirmed" (the stock check lapsed),
 * "blocked" (any other blocker, such as a price rise or sales that aged
 * out), "sample", "expired" or "withdrawn". headline is the "Don't make the
 * trip" line and reason the first blocker's id (blockerList).
 */
export function tripState(db, bounty, now, list = blockerList(db, bounty, now)) {
  const status = bountyStatus(bounty, now);
  if (status !== "open")
    return {
      state: status,
      go: false,
      label: status === "withdrawn" ? "Withdrawn" : "Expired",
      headline: `${TERMS.stop}: ${status === "withdrawn" ? "this bounty has been withdrawn" : "this bounty has expired"}`,
      reason: status,
    };
  if (bounty.sample)
    return { state: "sample", go: false, label: "Sample: practice only", headline: SAMPLE_BLOCKER, reason: "sample" };
  if (list.length) {
    const first = list[0];
    const [state, label] = TRIP_STATES[first.id] ?? ["blocked", "Not open for trips"];
    return { state, go: false, label, headline: first.headline, reason: first.id };
  }
  // Members already holding a claim may go; nobody new can claim.
  if (bounty.cap - claimedUnits(db, bounty.id, now).committed <= 0)
    return {
      state: "full",
      go: true,
      label: bounty.cap === 0 ? "Nothing to share: cap 0" : "Fully claimed",
      headline: null,
      reason: null,
    };
  return { state: "go", go: true, label: "Open for trips", headline: null, reason: null };
}

const TRIP_STATES = Object.freeze({
  "shelf-empty": ["paused", "Paused: none on the shelf"],
  "out-of-stock": ["out-of-stock", "Out of stock at the last branch check"],
  "stock-lapsed": ["stock-unconfirmed", "Stock check lapsed"],
  "price-rose": ["blocked", "Price has risen"],
  "offer-gone": ["blocked", "Offer no longer listed"],
  "offer-stale": ["blocked", "Offer price out of date"],
  "sales-aged": ["blocked", "Sales evidence out of date"],
});

const HIDDEN_TITLE = "Details not shown";

/** When a value was seen, in UK time: a calendar date as a date, a time as a date and time. */
const whenSeen = (value) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? humanDate(value) : humanTime(value);

/** The latest stock report on a bounty that was not marked inaccurate, or null. */
const latestReport = (db, bountyId) =>
  plain(
    db
      .prepare(
        `SELECT * FROM stock_reports WHERE bounty_id = ? AND (verified IS NULL OR verified != 'inaccurate')
 ORDER BY observed_at DESC, id DESC LIMIT 1`,
      )
      .get(bountyId),
  );

/**
 * What a bounty's figures are for, in plain words: the units (the most one
 * member can claim) and whose journey they use. Null when there are none.
 */
export function figuresLabel(snapshot) {
  const e = snapshot?.economics;
  const u = snapshot?.units;
  const units = Number.isSafeInteger(e?.units) ? e.units : Number.isSafeInteger(u?.figures) ? u.figures : null;
  if (units === null) return null;
  const j = snapshot?.journey;
  const journey = j?.known
    ? `the operator's return journey (${pounds(j.cost)}, ${plural(j.minutes, "minute")})`
    : "the operator's return journey";
  const most = Number.isSafeInteger(u?.claimable) && u.claimable === units ? ", the most one member can claim" : "";
  return `Figures for ${plural(units, "unit")}${most}, using ${journey}. Your own journey cost and time are used when you claim.`;
}

/**
 * The access needs for a live bounty (PRD journey 3), from its unit weight
 * and the units on the shelf now. The bounty does not know a member's carry
 * limit, so a hand-carried load (HAND_CARRY_KG) is assumed.
 */
function accessFor(bounty, shelfUnits) {
  if (bounty.sample) return [];
  const o = json(bounty.opportunity, null) ?? {};
  return accessNeeds(
    { weight: o.weightKg, stock: shelfUnits?.units ?? null, stockChecked: shelfUnits?.at ?? null, storageNeeds: null },
    { carry: HAND_CARRY_KG },
  ).map((n) =>
    n.id === "vehicle-required" ? { ...n, detail: `One unit weighs ${o.weightKg} kg, more than one person can carry by hand` } : n,
  );
}

// Blockers that are a change in the evidence since the figures were worked out.
const LIVE_BLOCKERS = new Set(["shelf-empty", "out-of-stock", "stock-lapsed", "offer-gone", "price-rose", "offer-stale", "sales-aged"]);

/**
 * The main uncertainty behind a bounty's figures now: a change in the
 * evidence since they were worked out, otherwise the estimate's own.
 */
function uncertaintyNow(bounty, snapshot, list) {
  if (bounty.sample) return "Sample figures: illustrative only, never observed evidence";
  const change = list.find((b) => LIVE_BLOCKERS.has(b.id));
  if (change) return change.text;
  if (snapshot?.mainUncertainty) return snapshot.mainUncertainty;
  const s = snapshot?.sample;
  return Number.isSafeInteger(s?.count) && s.count > 0 && Number.isSafeInteger(s?.lowerMedian)
    ? `Whether buyers still pay about ${pounds(s.lowerMedian)}: the estimate rests on ${plural(s.count, "confirmed sale")}`
    : "No completed sales are recorded for this item, so what buyers pay is not known";
}

/** When the price and the stock were last checked, for the card (UK time). */
function checkedLabels(bounty, snapshot, live, shelfUnits) {
  if (bounty.sample) return { price: null, priceLabel: null, stock: null, stockLabel: null };
  const price = offerObserved(bounty, live);
  const stock = shelfUnits?.at ?? snapshot?.stock?.checkedAt ?? null;
  const by = shelfUnits?.source === "stock report" ? "stock report" : "branch check";
  return {
    price,
    priceLabel: price ? `Price seen ${whenSeen(price)}` : "Price observation date unknown",
    stock,
    stockLabel: stock ? `Stock last checked ${humanTime(stock)} (${by})` : "Branch stock never checked",
  };
}

/**
 * The opportunity tier's reasons beside the card's current figures. The
 * tier is worked out at a re-check; competition and sourcing pressure can
 * change after it, so those reasons say what is known now instead of
 * contradicting the card.
 */
function tierReasonsNow(reasons, { resale, sourcing }) {
  const maxWeeks = OPPORTUNITY_RULES.maxResaleWeeksOfSupplyPriority1;
  const maxPressure = OPPORTUNITY_RULES.maxSourcingPressurePriority1;
  return reasons.map((r) => {
    if (/^Resale competition high or unknown/.test(r)) {
      if (resale.weeksOfSupply !== null)
        return resale.weeksOfSupply <= maxWeeks
          ? `Resale competition: about ${resale.weeksOfSupply} weeks of supply listed now, within the ${maxWeeks} weeks Priority 1 allows. The tier was set before that was known; a re-check works it out again`
          : `Resale competition high: about ${resale.weeksOfSupply} weeks of supply listed (Priority 1 allows ${maxWeeks})`;
      return resale.competingListings === 0
        ? "Resale competition unknown: no competing listings were found, but one search at one time is not proof of low competition"
        : "Resale competition unknown: competing listings have not been counted";
    }
    if (/^Sourcing pressure high or unknown/.test(r)) {
      if (sourcing.ratio !== null)
        return sourcing.ratio <= maxPressure
          ? `Sourcing pressure is ${sourcing.ratio} now, within the ${maxPressure} Priority 1 allows. The tier was set before that was known; a re-check works it out again`
          : `Sourcing pressure high: ${sourcing.ratio} (Priority 1 allows ${maxPressure})`;
      return sourcing.availableUnits === 0
        ? "Sourcing pressure not worked out: none on the shelf now"
        : "Sourcing pressure unknown: the units on the shelf have not been counted";
    }
    return r;
  });
}

/**
 * A member's alerts and eligibility questions, newest first, each with the
 * bounty's state now. Before anything is read, every bounty the member was
 * alerted for or holds a live claim on is re-evaluated (syncTrip), so a
 * blocker that appeared since sends the "Don't make the trip" notice first.
 * Each item carries the trip state and its headline, the shelf, the
 * promotion condition and the member's answer to it, the locality's
 * validation status now, the category the figures use, match attributes the
 * source did not state, the access needs and the member's notices for that
 * bounty. kind "question" items carry no figures: the price is a promotion
 * the member has not said they qualify for. When the source does not
 * permit display, the title, retailer and figures are hidden.
 */
export function memberAlerts(db, memberId, { now, cache = new Map() }) {
  const member = requireMember(db, memberId);
  const at = iso(clock(now));
  const rows = db.prepare("SELECT * FROM alerts WHERE member_id = ? ORDER BY created DESC, id DESC").all(member.id);
  const ids = new Set(rows.map((a) => a.bounty_id));
  for (const r of db
    .prepare("SELECT DISTINCT bounty_id FROM claims WHERE member_id = ? AND status = 'active' AND expires_at > ?")
    .all(member.id, at))
    ids.add(r.bounty_id);
  for (const bountyId of ids) {
    const bounty = getBounty(db, bountyId);
    if (bounty) syncTrip(db, bounty, now);
  }
  return rows.map((a) => {
    const bounty = getBounty(db, a.bounty_id);
    const display = displayStatus(db, bounty);
    const snapshot = json(bounty.estimate, null);
    const live = liveEvidence(db, bounty, now);
    const list = blockerList(db, bounty, now, live);
    const promotion = promotionOf(bounty);
    const standing = promotionStanding(db, bounty, member);
    const condition = a.promotion ?? promotion?.condition ?? null;
    const shelfUnits = shelfUnitsNow(db, bounty, snapshot, json(bounty.cap_basis, null), latestReport(db, bounty.id));
    const kind = a.kind === "question" ? "question" : "alert";
    const showFigures = display.permitted && kind === "alert" && (!standing || standing.confirmed);
    const opportunity = json(bounty.opportunity, null);
    return {
      id: a.id,
      bountyId: a.bounty_id,
      kind,
      title: display.permitted ? bounty.title : HIDDEN_TITLE,
      retailer: display.permitted ? bounty.retailer : null,
      locality: bounty.locality,
      sponsored: bounty.sponsored === 1,
      sponsor: bounty.sponsor,
      created: a.created,
      releaseAt: a.release_at,
      tier: tierSummary(membershipTier(a.tier)),
      via: a.via,
      label: a.via === "paid" ? "Paid early access" : "Earned release",
      bountyStatus: bountyStatus(bounty, now),
      trip: tripState(db, bounty, now, list),
      shelf: shelfStatus(db, bounty.id),
      promotion:
        condition && display.permitted
          ? {
              condition,
              regularPrice: promotion?.regularPrice ?? null,
              note: `Promotion price: ${condition}. Confirm that you qualify before you claim. ${promotionRisk(promotion ?? { condition }, showFigures ? opportunity?.unitProfit : null)}`,
            }
          : null,
      // The member's answer to the promotion question, with the question.
      eligibility: display.permitted ? standing : null,
      questionNote:
        kind === "question"
          ? standing?.confirmed
            ? "You said you qualify. The full alert with the figures follows while there is room under the cap."
            : "Answer the question to see the figures. Nothing is shown or claimed until you say you qualify."
          : null,
      figures:
        showFigures && snapshot?.economics
          ? {
              label: figuresLabel(snapshot),
              units: snapshot.economics.units ?? null,
              unitProfit: Number.isSafeInteger(opportunity?.unitProfit) ? opportunity.unitProfit : null,
              contribution: snapshot.economics.contribution ?? null,
              cashRequired: snapshot.economics.cashRequired ?? null,
            }
          : null,
      // The validation status now, never the text stored when it was sent.
      warning: bounty.sample ? null : validationStatus(db, bounty.locality, cache).warning,
      category: display.permitted ? (snapshot?.category ?? null) : null,
      attributes: display.permitted ? attributeNotes(snapshot?.offer) : [],
      accessNeeds: accessFor(bounty, shelfUnits),
      notices: memberNotices(db, member.id, { bountyId: bounty.id }),
    };
  });
}

// ------------------------------------------------------------------- views

/**
 * Sourcing pressure: people heading to the shelf relative to the units
 * there. Each active claimed unit and each positive stock report in the last
 * 24 hours counts once. Null ratio when available units are unknown or none
 * are on the shelf.
 */
export function sourcingPressure({ activeClaimedUnits, recentPositiveReports, availableUnits }) {
  const ratio =
    isCount(activeClaimedUnits) && isCount(recentPositiveReports) && Number.isSafeInteger(availableUnits) && availableUnits > 0
      ? round2((activeClaimedUnits + recentPositiveReports) / availableUnits)
      : null;
  return { activeClaimedUnits, recentPositiveReports, availableUnits, ratio };
}

/**
 * Resale competition: competing listings relative to sales a week, as weeks
 * of supply already on the market. Null when either figure is unknown, and
 * when no listing is recorded: none recorded is never read as no
 * competition (the same rule as estimate.mjs resaleWeeksOfSupply).
 * recordedListings is the estimate's own count and lookup the asking-price
 * lookup on record, so the note can say why competition is unknown.
 */
export function resaleCompetition({
  competingListings,
  competingSellers = null,
  salesPerWeek,
  recordedListings = null,
  lookup = null,
}) {
  const weeksOfSupply =
    isCount(competingListings) && competingListings > 0 && isPositive(salesPerWeek)
      ? round2(competingListings / salesPerWeek)
      : null;
  let note = null;
  if (competingListings === 0)
    note = lookup
      ? `An asking-price lookup (${lookup.provider}, ${humanTime(lookup.fetched)}) found no competing listings. That covers one marketplace at one time.`
      : "No active listings recorded. That can mean nobody has looked, so it is not proof of low competition.";
  else if (competingListings === null && recordedListings === 0)
    note =
      "No active listings recorded and no asking-price lookup for this barcode is on record, so competition is not known. Nobody may have looked.";
  return { competingListings, competingSellers, salesPerWeek, weeksOfSupply, note };
}

const photoView = (r) =>
  r.photo_sha256
    ? {
        label: "Shelf photo (stock report, not proof of profit)",
        sha256: r.photo_sha256,
        bytes: r.photo_bytes,
        mediaType: r.photo_media_type,
      }
    : null;

/**
 * Parses a viewer: null (public), "operator", or a member id. Members see
 * their own notes, photos and claims; the operator sees everything; anyone
 * else sees counts and dates only.
 */
export function resolveViewer(db, viewer) {
  if (viewer === null || viewer === undefined || viewer === "") return { kind: "public" };
  if (viewer === "operator") return { kind: "operator" };
  if (!/^\d{1,15}$/.test(String(viewer))) fail("viewer must be a member id or operator");
  return { kind: "member", member: requireMember(db, Number(viewer)) };
}

/**
 * Units on the shelf now, from evidence only: the newer of the stock check
 * behind the estimate and the latest stock report that was not marked
 * inaccurate, less units members marked as bought after that count. A
 * sample uses its hand-entered figure. units is null when no count exists.
 */
function shelfUnitsNow(db, bounty, snapshot, basis, latestReport) {
  if (bounty.sample)
    return { units: basis?.used?.availableUnits ?? bounty.available_units, source: "sample", at: null, boughtSince: 0 };
  const stock = snapshot?.stock;
  const checkAt = Date.parse(stock?.checkedAt);
  let units = null;
  let source = null;
  let at = null;
  if (latestReport && (!Number.isFinite(checkAt) || Date.parse(latestReport.observed_at) >= checkAt)) {
    units = latestReport.units_seen;
    source = "stock report";
    at = latestReport.observed_at;
  } else if (Number.isFinite(checkAt)) {
    source = "stock check";
    at = iso(checkAt);
    units =
      stock.availability === "out_of_stock"
        ? 0
        : stock.availability === "in_stock" && Number.isSafeInteger(stock.unitsSeen) && stock.unitsSeen > 0
          ? stock.unitsSeen
          : null;
  }
  if (units === null) return { units: null, source, at, boughtSince: 0 };
  const boughtSince = db
    .prepare("SELECT COALESCE(SUM(units), 0) AS n FROM claims WHERE bounty_id = ? AND status = 'completed' AND ended_at > ?")
    .get(bounty.id, at).n;
  return { units: Math.max(0, units - boughtSince), source, at, boughtSince };
}

/**
 * The stored alert checks with the ones that can change since the last
 * re-check worked out now: branch stock and availability (an empty-shelf
 * report, a newer branch check that found none, or a lapsed check), offer
 * freshness and price, the age of the independent sales, display
 * permission and, for a promotion price, whether this viewer said they
 * qualify. The exact-match check names the match attributes the source did
 * not state (attributeNotes).
 */
function liveChecks(stored, { shelf, lapse, live, offerStale, display, promotion, viewer, confirmed, attributes }) {
  const none = live?.check && live.check.in_stock !== 1 ? live.check : null;
  return stored.map((c) => {
    if (c.id === "exact-match" && attributes.length)
      return { ...c, detail: `${c.detail ? c.detail + ". " : ""}${attributes.map((a) => a.text).join(". ")}`, notes: attributes.map((a) => a.text) };
    if (c.id === "local-stock" || c.id === "availability") {
      if (shelf.paused)
        return {
          ...c,
          ok: false,
          detail:
            c.id === "local-stock"
              ? `Branch stock not confirmed: a stock report found none on the shelf at ${humanTime(shelf.at)}`
              : `Latest stock report found none on the shelf at ${humanTime(shelf.at)}`,
        };
      if (none)
        return {
          ...c,
          ok: false,
          detail:
            c.id === "local-stock"
              ? `Branch stock not confirmed: a newer branch check (${humanTime(none.checked_at)}) found none on the shelf`
              : `Latest branch check (${humanTime(none.checked_at)}) found none on the shelf`,
        };
      if (lapse?.lapsed)
        return {
          ...c,
          ok: false,
          detail: c.id === "local-stock" ? lapse.message : `Availability not checked in the last ${CHECK_VALID_DAYS} days`,
        };
    }
    if (c.id === "offer-fresh") {
      if (live?.offer?.gone) return { ...c, ok: false, detail: "The offer is no longer in the imported evidence" };
      if (live?.offer?.rose)
        return { ...c, ok: false, detail: `Offer price has risen from ${pounds(live.offer.was)} to ${pounds(live.offer.price)}` };
      if (offerStale) return { ...c, ok: false, detail: `Offer price is not from the last ${ALERT_RULES.maxOfferAgeDays} days` };
    }
    if (c.id === "independent-sales" && live?.sales && !live.sales.enough)
      return {
        ...c,
        ok: false,
        detail:
          live.sales.recent === null
            ? `A sale behind the figures is now more than ${ALERT_RULES.maxSaleAgeDays} days old`
            : `${live.sales.recent} of ${plural(live.sales.counted, "independent sale")} still from the last ${ALERT_RULES.maxSaleAgeDays} days`,
      };
    if (c.id === "display-permitted")
      return {
        ...c,
        ok: display.permitted,
        detail: display.permitted ? "Source permits display" : "No recorded permission to display this source",
      };
    if (c.id === "promotion" && promotion?.needsMemberConfirmation) {
      if (viewer.kind === "member")
        return confirmed
          ? { ...c, ok: true, detail: `You said you qualify for: ${promotion.condition}` }
          : { ...c, ok: false, detail: `Promotion price (${promotion.condition}): say whether you qualify to see the figures` };
      if (viewer.kind === "operator")
        return {
          ...c,
          detail: c.ok
            ? `You confirmed you qualify (${promotion.condition}). That covers only you: each member confirms for themselves`
            : c.detail,
        };
      return { ...c, ok: false, detail: `Promotion price (${promotion.condition}): each member must confirm they qualify` };
    }
    return c;
  });
}

/**
 * A bounty as the API shows it to a viewer. Every read first re-evaluates
 * a live open bounty against the evidence now (syncTrip: the newest branch
 * check, the offer price and expiry, the age of the sales), so a blocker
 * that appeared since sends the "Don't make the trip" notice before the view
 * returns. Everything that can change without a re-check is then worked out
 * at `now`: the trip state, the alert checks, the shelf count, sourcing
 * pressure and the claim offer. When the offer's source does not permit
 * display, members and visitors see no title, retailer, barcode, prices or
 * sale figures; the operator sees them with display.label saying they are
 * not shown to others. When the price is a promotion only some shoppers get,
 * the figures are shown only to the operator and to a member who said they
 * qualify (viewer.eligibility asks the others).
 *
 * options.cache (a Map) lets a list share one pilot validation read per
 * locality.
 */
export function bountyView(db, bounty, { viewer = { kind: "public" }, now, cache = null }) {
  const at = clock(now);
  const status = bountyStatus(bounty, now);
  const live = liveEvidence(db, bounty, now);
  syncTrip(db, bounty, now, live);
  const held = claimedUnits(db, bounty.id, now);
  const remaining = Math.max(0, bounty.cap - held.committed);
  const basis = json(bounty.cap_basis, null);
  const snapshot = json(bounty.estimate, null);
  const shelf = shelfStatus(db, bounty.id);
  const reports = db
    .prepare(
      `SELECT r.*, m.name AS member_name, e.points FROM stock_reports r JOIN members m ON m.id = r.member_id
 LEFT JOIN reputation_events e ON e.report_id = r.id WHERE r.bounty_id = ? ORDER BY r.observed_at DESC, r.id DESC`,
    )
    .all(bounty.id)
    .map(plain);
  const since = iso(at - BOUNTY_RULES.recentReportHours * HOUR);
  const recentPositive = reports.filter(
    (r) => r.units_seen > 0 && r.verified !== "inaccurate" && r.observed_at >= since,
  ).length;
  const shelfUnits = shelfUnitsNow(
    db,
    bounty,
    snapshot,
    basis,
    reports.find((r) => r.verified !== "inaccurate"),
  );
  const usedRate = basis?.used ? basis.used.salesPerWeek : bounty.sales_per_week;
  const isOperator = viewer.kind === "operator";
  const me = viewer.kind === "member" ? viewer.member.id : null;
  const display = displayStatus(db, bounty);
  const hidden = !display.permitted && !isOperator;
  const reportView = (r) =>
    isOperator || r.member_id === me
      ? {
          id: r.id,
          mine: r.member_id === me,
          memberId: r.member_id,
          memberName: r.member_name,
          unitsSeen: r.units_seen,
          observedAt: r.observed_at,
          note: r.note,
          photo: photoView(r),
          verified: r.verified,
          verifiedAt: r.verified_at,
          points: r.points ?? 0,
        }
      : { id: r.id, mine: false, unitsSeen: r.units_seen, observedAt: r.observed_at, verified: r.verified };
  const list = blockerList(db, bounty, now, live);
  const blockers = list.map((b) => b.text);
  const trip = tripState(db, bounty, now, list);
  const claims = db
    .prepare(
      `SELECT c.*, m.name AS member_name FROM claims c JOIN members m ON m.id = c.member_id
 WHERE c.bounty_id = ? ORDER BY c.created DESC, c.id DESC`,
    )
    .all(bounty.id)
    .map(plain)
    .filter((c) => isOperator || c.member_id === me)
    .map((c) => {
      const active = c.status === "active" && Date.parse(c.expires_at) > at;
      return {
        id: c.id,
        memberId: c.member_id,
        memberName: c.member_name,
        units: c.units,
        status: c.status === "active" && !active ? "expired" : c.status,
        created: c.created,
        expiresAt: c.expires_at,
        endedAt: c.ended_at,
        promotionConfirmed: c.promotion_confirmed === 1,
        // The member's own journey and the figures their claim was checked on.
        journeyCost: c.journey_cost ?? null,
        journeyMinutes: c.journey_minutes ?? null,
        figures: hidden ? null : json(c.figures, null),
        // A live claim on a bounty that cannot send anyone on a trip now.
        paused: active && !trip.go,
      };
    });
  const alertBlockers = [...blockers];
  if (remaining <= 0) alertBlockers.push(capFullMessage(bounty));
  const sentRow = db
    .prepare(
      "SELECT COALESCE(SUM(kind = 'alert'), 0) AS alerts, COALESCE(SUM(kind = 'question'), 0) AS questions FROM alerts WHERE bounty_id = ?",
    )
    .get(bounty.id);
  const promotion = promotionOf(bounty);
  const standing = viewer.kind === "member" ? promotionStanding(db, bounty, viewer.member) : null;
  // Figures for a promotion price only some shoppers get are shown to the
  // operator and to a member who said they qualify.
  const figuresHidden =
    !bounty.sample && Boolean(promotion?.needsMemberConfirmation) && !isOperator && !standing?.confirmed;
  const stored = json(bounty.opportunity, null);
  const lapse = stockLapse(bounty, now);
  const age = offerAge(bounty, now, live);
  const offerStale = !bounty.sample && (age === null || age < 0 || age > ALERT_RULES.maxOfferAgeDays);
  const sourcing = {
    ...sourcingPressure({
      activeClaimedUnits: held.active,
      recentPositiveReports: recentPositive,
      availableUnits: shelfUnits.units,
    }),
    unitsSource: shelfUnits.source,
    unitsAt: shelfUnits.at,
    boughtSince: shelfUnits.boughtSince,
  };
  const resale = resaleCompetition({
    competingListings: bounty.competing_listings,
    competingSellers: bounty.competing_sellers,
    salesPerWeek: usedRate,
    recordedListings: snapshot?.competition?.activeListings ?? null,
    lookup: snapshot?.askingLookup ?? basis?.evidence?.askingLookup ?? null,
  });
  if (resale.competingListings === null && !resale.note && snapshot?.competition?.note) resale.note = snapshot.competition.note;
  const opportunity = stored
    ? {
        ...stored,
        reasons: tierReasonsNow(Array.isArray(stored.reasons) ? stored.reasons : [], { resale, sourcing }),
        setAt: bounty.checked_at ?? null,
      }
    : null;
  let viewerInfo = null;
  if (viewer.kind === "member") {
    const release = releaseFor(db, bounty, viewer.member, now);
    const alert = db
      .prepare("SELECT created, kind FROM alerts WHERE bounty_id = ? AND member_id = ?")
      .get(bounty.id, viewer.member.id);
    const active = claims.find((c) => c.status === "active") ?? null;
    const ruleFailures = memberRuleFailures(bounty, viewer.member);
    const trial = bounty.sample
      ? { limit: 0, held: 0, proven: false, allowance: 0 }
      : trialAllowance(db, bounty, viewer.member, now);
    const own = [];
    if (!blockers.length) {
      if (ruleFailures.length) own.push("This bounty fails your stricter thresholds: " + ruleFailures.join("; "));
      if (trial.allowance === 0 && !active)
        own.push(
          `You already hold or have bought ${plural(trial.held, "unit")} of this item: until a verified trade exists, one member's total is a trial batch of ${plural(trial.limit, "unit")}`,
        );
      if (!release.open)
        own.push(
          `Your release window opens at ${humanTime(release.releaseAt)} (${release.tier.name}, via ${release.via === "paid" ? "paid early access" : "earned reputation"})`,
        );
      if (standing?.usedHere && !active)
        own.push(`You said you already used a first-order offer at ${bounty.retailer}, so this price is not open to you`);
      else if (standing?.answer === "not" && !active)
        own.push(`You said you do not qualify for this price (${standing.condition})`);
    }
    viewerInfo = {
      memberId: viewer.member.id,
      release,
      alertedAt: alert?.kind === "alert" ? alert.created : null,
      askedAt: alert?.kind === "question" ? alert.created : null,
      activeClaim: active,
      canClaim: !blockers.length && !own.length && remaining > 0 && !active && trial.allowance > 0,
      blockers: own,
      ruleFailures: hidden ? ruleFailures.map(() => "Fails one of your stricter thresholds") : ruleFailures,
      trial,
      maxClaimUnits: Math.max(0, Math.min(trial.allowance, remaining)),
      promotion:
        promotion?.needsMemberConfirmation && !hidden
          ? {
              condition: promotion.condition,
              confirmed: Boolean(active?.promotionConfirmed) || Boolean(standing?.confirmed),
              risk: promotionRisk(promotion, figuresHidden ? null : stored?.unitProfit),
            }
          : null,
      // The promotion question and this member's answer (null when the
      // figures do not depend on a promotion).
      eligibility: hidden ? null : standing,
      stop: trip.go ? null : trip.headline,
      notices: memberNotices(db, viewer.member.id, { bountyId: bounty.id }),
    };
  }
  const attributes = bounty.sample || hidden ? [] : attributeNotes(snapshot?.offer);
  const checks = liveChecks(Array.isArray(snapshot?.alert?.checks) ? snapshot.alert.checks : [], {
    shelf,
    lapse,
    live,
    offerStale,
    display,
    promotion,
    viewer,
    confirmed: Boolean(viewerInfo?.activeClaim?.promotionConfirmed) || Boolean(standing?.confirmed),
    attributes,
  });
  const economics = figuresHidden ? null : (snapshot?.economics ?? null);
  const validation = bounty.sample ? null : validationStatus(db, bounty.locality, cache);
  const checked = checkedLabels(bounty, snapshot, live, shelfUnits);
  const figuresNote = figuresHidden
    ? `The figures depend on a promotion price ("${promotion.condition}"). They are shown once you say you qualify for it.`
    : null;
  return {
    id: bounty.id,
    title: hidden ? HIDDEN_TITLE : bounty.title,
    barcode: hidden ? null : bounty.barcode,
    variant: hidden ? null : bounty.variant,
    retailer: hidden ? null : bounty.retailer,
    locality: bounty.locality,
    sample: bounty.sample === 1,
    sponsored: bounty.sponsored === 1,
    sponsor: bounty.sponsor,
    placement: bounty.sponsored === 1 ? `Sponsored by ${bounty.sponsor}` : null,
    status,
    trip,
    created: bounty.created,
    expiresAt: bounty.expires_at,
    withdrawnAt: bounty.withdrawn_at,
    cap: bounty.cap,
    capBasis: basis,
    claimedUnits: held.active,
    completedUnits: held.completed,
    remaining,
    alert: {
      eligible: bounty.alert_eligible === 1,
      reasons: json(bounty.alert_reasons, []),
      checkedAt: bounty.checked_at,
      canSend: alertBlockers.length === 0,
      blockers: alertBlockers,
      sent: sentRow.alerts,
      questions: sentRow.questions,
      exposureLimit: BOUNTY_RULES.exposurePerUnit * remaining,
    },
    claimBlockers: blockers,
    // The largest single claim: the trial batch (the member's own when
    // stricter). viewer.maxClaimUnits is what this member can claim now.
    maxClaimUnits: viewerInfo && !bounty.sample ? viewerInfo.trial.limit : trialBatch(bounty),
    opportunity:
      (hidden || figuresHidden) && opportunity
        ? { tier: opportunity.tier, reasons: hidden ? [] : opportunity.reasons, meetsThresholds: opportunity.meetsThresholds, setAt: opportunity.setAt }
        : opportunity,
    // What the figures are for: the units one member can claim and whose
    // journey they use.
    figures: bounty.sample || hidden
      ? null
      : {
          units: economics?.units ?? snapshot?.units?.figures ?? null,
          claimable: snapshot?.units?.claimable ?? null,
          journey: snapshot?.journey ?? null,
          label: figuresHidden ? null : figuresLabel(snapshot),
          hidden: figuresHidden,
          note: figuresNote,
        },
    category: hidden ? null : (snapshot?.category ?? null),
    attributes,
    checked,
    mainUncertainty: hidden ? null : uncertaintyNow(bounty, snapshot, list),
    accessNeeds: accessFor(bounty, shelfUnits),
    pressure: { sourcing, resale },
    shelf,
    shelfUnits,
    display: {
      permitted: display.permitted,
      // The basis names the source and programme, so only the operator sees it.
      basis: hidden ? "No display permission for this source" : display.basis,
      hidden,
      label: display.permitted
        ? null
        : isOperator
          ? "Not shown to members or visitors: " + display.basis
          : TERMS.hidden,
    },
    validation,
    promotion:
      promotion && !hidden
        ? {
            condition: promotion.condition,
            price: promotion.price,
            regularPrice: promotion.regularPrice,
            costedAt: promotion.costedAt,
            needsMemberConfirmation: promotion.needsMemberConfirmation,
            firstOrder: isFirstOrderOffer(promotion.condition),
            note: promotion.needsMemberConfirmation
              ? `The purchase price is a promotion price: ${promotion.condition}. ${TERMS.promotion} ${promotionRisk(promotion, figuresHidden ? null : stored?.unitProfit)}`
              : promotionRisk(promotion),
          }
        : null,
    reports: {
      total: reports.length,
      positive: reports.filter((r) => r.units_seen > 0).length,
      negative: reports.filter((r) => r.units_seen === 0).length,
      latestAt: reports[0]?.observed_at ?? null,
      items: reports.map(reportView),
    },
    claims,
    estimate:
      snapshot && !hidden
        ? {
            checkedAt: snapshot.checkedAt,
            offer: snapshot.offer,
            unitCost: snapshot.unitCost,
            match: snapshot.match,
            sample: snapshot.sample,
            competition: snapshot.competition,
            economics,
            stock: snapshot.stock,
            checks,
            warnings: snapshot.warnings ?? [],
          }
        : snapshot
          ? {
              checkedAt: snapshot.checkedAt,
              offer: null,
              unitCost: null,
              match: snapshot.match,
              sample: null,
              competition: null,
              economics: null,
              stock: snapshot.stock,
              checks,
              warnings: [],
            }
          : null,
    viewer: viewerInfo,
    terms: TERMS,
  };
}

/**
 * Bounties for a viewer: open ones first, then newest. Each is re-evaluated
 * against the evidence now before it is shown (bountyView), and the pilot
 * validation status is read once per locality.
 */
export function listBounties(db, { viewer, now }) {
  const at = iso(clock(now));
  const cache = new Map();
  return db
    .prepare(
      `SELECT * FROM bounties ORDER BY (status = 'open' AND expires_at > ?) DESC, created DESC, id DESC LIMIT 200`,
    )
    .all(at)
    .map((b) => bountyView(db, plain(b), { viewer, now, cache }));
}
