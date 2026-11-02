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
// Whether a trip fits a member's own transport, carry limit, cash and
// storage (round 5, finding 4).
import { profileLoadLimit, readTripProfile, suitability as tripSuitability, tripProfile } from "./suitability.mjs";
import { normaliseBarcode, sellerName } from "./matching.mjs";
import { displayPermitted } from "./evidence.mjs";
import { stripMetadata } from "./metadata.mjs";
import { bool, fail, int, isoDate, num, oneOf, text, transaction } from "./http.mjs";
// For a member's own trip check (claims): shared demand and the payout date.
import { daysToSellAll as claimSellDays, demandUnits as claimDemandUnits } from "./opportunity.mjs";
import { payoutDate as claimPayoutDate } from "./goals.mjs";
import { londonDate as claimToday } from "./http.mjs";
// For the live evidence on reads (bounty evidence): demand now, the asking-price
// lookup's time to live, and the audit's sign-off rules read defensively.
import { demandUnits as liveDemandUnits } from "./opportunity.mjs";
import { sourceFor as lookupSource } from "./sources.mjs";
import * as auditModule from "./audit.mjs";
import { currentShopPrice } from "./estimate.mjs";

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
 created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 transport TEXT,
 carry_kg REAL,
 storage_units INTEGER,
 seller_name TEXT,
 seller_key TEXT,
 seller_confirmed_at TEXT,
 account_email TEXT
)`,
    // transport, carry_kg and storage_units are the member's own trip
    // profile (round 5): how they travel (trip.mjs MODES), the most they can
    // carry in kg and the units they can store at home. NULL is not known,
    // never zero: such a member is asked to confirm it and never told to go.
    // seller_name (round 5b) is their marketplace seller name (for example
    // their eBay user name) as they gave it, so their own listings of units
    // bought through a bounty count once; NULL is not known. seller_key is
    // its matching key (sellerKey: NFKC, Unicode lower case, spaces
    // collapsed), unique across members; matching uses only the key.
    // seller_confirmed_at is when the operator confirmed the name belongs to
    // the member, cleared whenever the name changes: until then their
    // listings count in full. account_email links the scout profile to the
    // signed-in account that made it (lower case, one profile per account);
    // NULL for profiles made without accounts, on this computer.
    columns: [
      "id", "name", "locality", "paid_tier", "paid_until", "alerts_opt_in", "alert_localities", "rules", "created",
      "transport", "carry_kg", "storage_units", "seller_name", "seller_key", "seller_confirmed_at", "account_email",
    ],
    types: {
      alerts_opt_in: "INTEGER NOT NULL DEFAULT 0",
      alert_localities: "TEXT NOT NULL DEFAULT '[]'",
      rules: "TEXT NOT NULL DEFAULT '{}'",
      transport: "TEXT",
      carry_kg: "REAL",
      storage_units: "INTEGER",
      seller_name: "TEXT",
      seller_key: "TEXT",
      seller_confirmed_at: "TEXT",
      account_email: "TEXT",
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
 figures TEXT,
 terms TEXT
)`,
    // terms: the member's own { hourlyFloor, cashNeededBy } given with the
    // claim (JSON, either may be null), so a re-check uses them again.
    columns: [
      "id", "bounty_id", "member_id", "units", "status", "created", "expires_at", "ended_at", "promotion",
      "promotion_confirmed", "journey_cost", "journey_minutes", "figures", "terms",
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
    // never alerted to them again). retailer is normalised. claim_id is
    // set when "used" was recorded because the member marked a claim at a
    // first-order price as bought: that is a purchase, never an answer
    // given by mistake, so it cannot be undone.
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
 claim_id INTEGER,
 UNIQUE(member_id, bounty_id)
)`,
    columns: ["id", "member_id", "bounty_id", "retailer", "condition", "first_order", "answer", "created", "claim_id"],
    types: {
      member_id: "INTEGER",
      bounty_id: "INTEGER",
      retailer: "TEXT NOT NULL DEFAULT ''",
      condition: "TEXT NOT NULL DEFAULT ''",
      first_order: "INTEGER NOT NULL DEFAULT 0",
      answer: "TEXT NOT NULL DEFAULT ''",
      claim_id: "INTEGER",
    },
  },
  {
    // Units bought through a completed claim that no longer count against
    // the resale demand for the item (round 5): kind "sold" or "returned"
    // (to the shop), recorded by the member who made the claim, or
    // "reconciled", recorded by the operator with a reason. recorded_by is
    // "member" or "operator"; member_id is the member who recorded it.
    // Append-only: the units released on a claim never exceed the units
    // bought through it.
    name: "claim_releases",
    sql: `CREATE TABLE IF NOT EXISTS claim_releases (
 id INTEGER PRIMARY KEY,
 claim_id INTEGER NOT NULL REFERENCES claims(id),
 kind TEXT NOT NULL,
 units INTEGER NOT NULL,
 reason TEXT,
 recorded_by TEXT NOT NULL,
 member_id INTEGER REFERENCES members(id),
 created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
    columns: ["id", "claim_id", "kind", "units", "reason", "recorded_by", "member_id", "created"],
    types: {
      claim_id: "INTEGER",
      kind: "TEXT NOT NULL DEFAULT ''",
      units: "INTEGER NOT NULL DEFAULT 0",
      recorded_by: "TEXT NOT NULL DEFAULT ''",
      member_id: "INTEGER",
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
  sellerKeys(db);
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
CREATE INDEX IF NOT EXISTS bounties_barcode ON bounties(barcode, status);
CREATE INDEX IF NOT EXISTS claim_releases_claim ON claim_releases(claim_id);
CREATE UNIQUE INDEX IF NOT EXISTS members_seller_key ON members(seller_key) WHERE seller_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS members_account ON members(account_email) WHERE account_email IS NOT NULL;`);
}

/**
 * Fills in the matching key for seller names stored without one (round 5b),
 * in member order. A name whose key another member already has keeps no key
 * (its listings count in full) and loses any confirmation, so the unique
 * index can be built.
 */
function sellerKeys(db) {
  const rows = db.prepare("SELECT id, seller_name FROM members WHERE seller_name IS NOT NULL AND seller_key IS NULL ORDER BY id").all();
  if (!rows.length) return;
  const taken = new Set(db.prepare("SELECT seller_key FROM members WHERE seller_key IS NOT NULL").all().map((r) => r.seller_key));
  const set = db.prepare("UPDATE members SET seller_key = ? WHERE id = ?");
  const clear = db.prepare("UPDATE members SET seller_confirmed_at = NULL WHERE id = ?");
  for (const r of rows) {
    const key = sellerKey(r.seller_name);
    if (key && !taken.has(key)) {
      taken.add(key);
      set.run(key, r.id);
    } else clear.run(r.id);
  }
}

// --------------------------------------------------------------- helpers

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const iso = (ms) => new Date(ms).toISOString();
const plain = (row) => (row ? { ...row } : null);
const round2 = (v) => Math.round(v * 100) / 100;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isPositive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
// A loss reads "-£5.00", never "£-5.00".
const pounds = (pence) => (pence < 0 ? "-£" : "£") + (Math.abs(pence) / 100).toFixed(2);
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
        rules: {}, transport: null, carry_kg: null, storage_units: null, seller_name: null, seller_key: null,
        seller_confirmed_at: null,
      };
  if (has("rules")) next.rules = memberRulesInput(body.rules);
  // The member's trip profile (round 5): each field given is validated, and
  // a blank one ("" or null) clears it to not known, never zero.
  const trip = readTripProfile(
    Object.fromEntries(MEMBER_PROFILE_FIELDS.filter(has).map((k) => [k, body[k]])),
    { prefix: "", fields: MEMBER_PROFILE_FIELDS.filter(has) },
  );
  if (has("transport")) next.transport = trip?.transport ?? null;
  if (has("carryKg")) next.carry_kg = trip?.carryKg ?? null;
  if (has("storageUnits")) next.storage_units = trip?.storageUnits ?? null;
  // Their marketplace seller name (round 5b): optional, a blank clears it.
  if (has("sellerName")) {
    next.seller_name = sellerNameInput(body.sellerName);
    const key = next.seller_name === null ? null : sellerKey(next.seller_name);
    // A new or changed name needs the operator to confirm it again.
    if (key !== (current?.seller_key ?? null)) next.seller_confirmed_at = null;
    next.seller_key = key;
  }
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

/**
 * A marketplace seller name from a request: null when blank; otherwise 1 to
 * 64 characters with no control characters, and a seller name a listing
 * can carry (not a listing id such as "listing:123"), or a 400.
 */
export const SELLER_NAME_ERROR =
  "Your marketplace seller name must be the name your listings show, such as your eBay user name, in 64 characters or fewer.";
export const SELLER_NAME_TAKEN =
  "Another member already gave this seller name. Each member's listings are matched by their own seller name, so check the spelling.";

function sellerNameInput(value) {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return null;
  if (typeof value !== "string") fail(SELLER_NAME_ERROR);
  const name = value.trim();
  if (name.length > 64 || /[\u0000-\u001f\u007f]/.test(name) || sellerKey(name) === null) fail(SELLER_NAME_ERROR);
  return name;
}

/**
 * Refuses a seller name whose matching key (sellerKey) another member
 * already has (409): fullwidth, accented-case or spaced copies match the
 * same listings, so they are the same name.
 */
function uniqueSellerName(db, key, memberId = null) {
  if (key === null) return;
  const taken = db.prepare("SELECT id FROM members WHERE seller_key = ? AND id IS NOT ?").get(key, memberId);
  if (taken) fail(SELLER_NAME_TAKEN, 409);
}

/** Runs a member write, turning the unique seller key index into the plain 409. */
function sellerWrite(fn) {
  try {
    return fn();
  } catch (error) {
    if (/UNIQUE constraint failed: members\.seller_key/.test(String(error?.message))) fail(SELLER_NAME_TAKEN, 409);
    throw error;
  }
}

/**
 * The operator confirms that a member's seller name is theirs (round 5b),
 * for example from their marketplace profile or one of their listings.
 * sellerName must be the name the member gave now (compared by its
 * matching key), so a name changed since the operator looked is not
 * confirmed (409). withdraw: true clears a confirmation. Until a name is
 * confirmed the member's listings count in full.
 */
export function confirmSellerName(db, memberId, { sellerName: given, withdraw = false } = {}, { now }) {
  const at = iso(clock(now));
  const member = requireMember(db, memberId);
  if (withdraw === true) {
    db.prepare("UPDATE members SET seller_confirmed_at = NULL WHERE id = ?").run(member.id);
    return getMember(db, member.id);
  }
  if (!member.seller_key) fail("This member has given no marketplace seller name to confirm.", 409);
  const key = typeof given === "string" ? sellerKey(given) : null;
  if (!key) fail("Send the seller name you checked, as the member gave it.");
  if (key !== member.seller_key)
    fail(`The member's seller name is now "${member.seller_name}", not the name you checked. Check it again before confirming.`, 409);
  db.prepare("UPDATE members SET seller_confirmed_at = ? WHERE id = ?").run(at, member.id);
  return getMember(db, member.id);
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
    // How they travel, how much they can carry and the units they can store
    // at home (round 5), each null when not known. The cash they can spend
    // is asked with each claim.
    profile: memberProfileView(member, homeStock(db, member.id, { now })),
    // Their marketplace seller name (round 5b), or null when not given, and
    // when the operator confirmed it (null until then: their listings count
    // in full).
    sellerName: typeof member.seller_name === "string" ? member.seller_name : null,
    sellerConfirmedAt: member.seller_key && member.seller_confirmed_at ? member.seller_confirmed_at : null,
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
/** The scout profile linked to a signed-in account, or null. */
export function memberForAccount(db, email) {
  if (!email) return null;
  return db.prepare("SELECT * FROM members WHERE account_email = ?").get(String(email).toLowerCase()) ?? null;
}

/**
 * Creates a member. accountEmail links it to the signed-in account that
 * made it; an account has at most one scout profile, so a second attempt
 * returns the one it already has.
 */
export function createMember(db, body, { now, accountEmail = null }) {
  clock(now);
  const existing = memberForAccount(db, accountEmail);
  if (existing) return existing;
  const m = memberFields(body, null);
  uniqueSellerName(db, m.seller_key);
  const result = sellerWrite(() =>
    db
      .prepare(
        `INSERT INTO members(name, locality, paid_tier, paid_until, alerts_opt_in, alert_localities, rules, created,
 transport, carry_kg, storage_units, seller_name, seller_key, seller_confirmed_at)
 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        m.name, m.locality, m.paid_tier, m.paid_until, m.alerts_opt_in, JSON.stringify(m.alert_localities),
        JSON.stringify(m.rules), now, m.transport, m.carry_kg, m.storage_units, m.seller_name, m.seller_key,
      ),
  );
  const id = Number(result.lastInsertRowid);
  if (accountEmail)
    db.prepare("UPDATE members SET account_email = ? WHERE id = ?").run(String(accountEmail).toLowerCase(), id);
  return getMember(db, id);
}

/** Updates name, locality, alert opt-in and localities, stricter thresholds, the trip profile or the paid tier. */
export function updateMember(db, memberId, body, { now }) {
  clock(now);
  const current = requireMember(db, memberId);
  const m = memberFields(body, current);
  uniqueSellerName(db, m.seller_key, current.id);
  sellerWrite(() =>
    db
      .prepare(
        `UPDATE members SET name = ?, locality = ?, paid_tier = ?, paid_until = ?, alerts_opt_in = ?, alert_localities = ?,
 rules = ?, transport = ?, carry_kg = ?, storage_units = ?, seller_name = ?, seller_key = ?, seller_confirmed_at = ? WHERE id = ?`,
      )
      .run(
        m.name, m.locality, m.paid_tier, m.paid_until, m.alerts_opt_in, JSON.stringify(m.alert_localities),
        JSON.stringify(m.rules), m.transport, m.carry_kg, m.storage_units, m.seller_name, m.seller_key,
        m.seller_confirmed_at ?? null, current.id,
      ),
  );
  return getMember(db, current.id);
}

// ------------------------------------------------------- trip profile

/** The member profile fields as requests name them. Cash is asked per claim. */
export const MEMBER_PROFILE_FIELDS = Object.freeze(["transport", "carryKg", "storageUnits"]);

/**
 * A member's stored trip profile with the cash they can spend on one trip:
 * { transport, carryKg, cashAvailable, storageUnits, heldUnits } for
 * suitability.mjs. Each value is null when not known (cashAvailable is
 * undefined-safe: null unless given). storageUnits is the room they gave
 * at home in all (round 5b, second verification: the total, counting the
 * space units bought through bounties take up); room (homeStock) is { held,
 * claimed }: the units they bought through bounties and have not recorded
 * as sold or returned, and the units in their other live claims, which take
 * up some of it (a number is read as held).
 */
export function memberTripProfile(member, cashAvailable = null, room = {}) {
  const r = typeof room === "number" ? { held: room } : (room ?? {});
  return tripProfile({
    transport: member?.transport ?? null,
    carryKg: typeof member?.carry_kg === "number" ? member.carry_kg : null,
    cashAvailable,
    storageUnits: Number.isSafeInteger(member?.storage_units) ? member.storage_units : null,
    heldUnits: r.held ?? 0,
    claimedUnits: r.claimed ?? 0,
  });
}

/**
 * What takes up a member's room at home for a trip on `bountyId` (round 5b,
 * second verification): { held, claimed }. held is stockHeld; claimed the
 * units in their live claims on other live bounties (not sample ones), so
 * two claims cannot each count the same free room. before: a claim row ({
 * id, created }): only claims made before it count, so when two claims
 * would not both fit, the later one is the one that fails its re-check.
 */
/**
 * homeStock for a member on a bounty: when they hold a live claim on it,
 * only their claims made before that one count (as its re-check counts
 * them), otherwise all their other live claims.
 */
export function roomFor(db, bounty, memberId, now) {
  const own = db
    .prepare("SELECT id, created FROM claims WHERE bounty_id = ? AND member_id = ? AND status = 'active' AND expires_at > ? ORDER BY id DESC LIMIT 1")
    .get(bounty.id, memberId, iso(clock(now)));
  return homeStock(db, memberId, { bountyId: bounty.id, before: own ?? null, now });
}

export function homeStock(db, memberId, { bountyId = null, before = null, now }) {
  const at = iso(clock(now));
  const rows = db
    .prepare(
      `SELECT c.id, c.units, c.created FROM claims c JOIN bounties b ON b.id = c.bounty_id
 WHERE c.member_id = ? AND c.status = 'active' AND c.expires_at > ? AND b.sample = 0 AND c.bounty_id IS NOT ?`,
    )
    .all(memberId, at, bountyId)
    .filter((c) => isCount(c.units))
    .filter((c) => !before || c.created < before.created || (c.created === before.created && c.id < before.id));
  return { held: stockHeld(db, memberId), claimed: rows.reduce((n, c) => n + c.units, 0) };
}

/**
 * Units a member bought through bounties and has not recorded as sold or
 * returned (nor the operator reconciled), across every live bounty: stock
 * at their home that takes up the room they gave for storage (round 5b).
 * Units released in any way are left out.
 */
export function stockHeld(db, memberId) {
  const rows = db
    .prepare(
      "SELECT c.id, c.units FROM claims c JOIN bounties b ON b.id = c.bounty_id WHERE c.member_id = ? AND c.status = 'completed' AND b.sample = 0",
    )
    .all(memberId)
    .filter((r) => isCount(r.units));
  if (!rows.length) return 0;
  const released = releasedOn(db, rows.map((r) => r.id));
  return rows.reduce((n, r) => n + r.units - Math.min(r.units, released.get(r.id)?.total ?? 0), 0);
}

/**
 * The profile as the API shows it: values, what is missing and the load
 * limit. room (homeStock, when known) gives the room now: storageUnits is
 * the room at home in all, and units held from bounties and units in live
 * claims are taken off it (round 5b, second verification), as on the card.
 */
export function memberProfileView(member, room = null) {
  const p = memberTripProfile(member, null, room ?? {});
  const missing = MEMBER_PROFILE_FIELDS.filter((k) => p[k] === null);
  const held = room ? p.heldUnits : null;
  const claimed = room ? p.claimedUnits : null;
  const roomNow = room && p.storageUnits !== null ? Math.max(0, p.storageUnits - held - claimed) : null;
  const taken = [
    held > 0 ? `${plural(held, "unit")} bought through bounties and not yet recorded as sold or returned` : "",
    claimed > 0 ? `${plural(claimed, "unit")} in your live claims` : "",
  ].filter(Boolean);
  const storage =
    roomNow === null
      ? "units you buy through bounties take up some of your room at home until you record them as sold or returned"
      : `room at home for ${plural(roomNow, "more unit")} now${taken.length ? `, after ${taken.join(", and ")}` : ""}`;
  return {
    transport: p.transport,
    carryKg: p.carryKg,
    storageUnits: p.storageUnits,
    heldUnits: held,
    claimedUnits: claimed,
    roomNow,
    complete: missing.length === 0,
    missing,
    loadLimitKg: profileLoadLimit(p),
    note: missing.length
      ? profileNeeded(missing)
      : `Load limit ${profileLoadLimit(p)} kg; ${storage}. The cash you can spend is asked when you claim.`,
  };
}

// What a member with no complete profile is told instead of "go", naming
// only the values still missing (round 5b, second verification).
const NEEDED_WORDS = Object.freeze({
  transport: "your transport",
  carryKg: "how much you can carry (kg)",
  storageUnits: "how many units you have room for at home in all",
});
export function profileNeeded(missing = MEMBER_PROFILE_FIELDS) {
  const listed = MEMBER_PROFILE_FIELDS.filter((k) => Array.isArray(missing) && missing.includes(k));
  const fields = listed.length ? listed : MEMBER_PROFILE_FIELDS;
  const words = fields.map((k) => NEEDED_WORDS[k]);
  const list = words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
  return `Confirm ${list}, in your member profile, so trips can be checked against ${fields.length === 1 ? "it" : "them"}. Until then no trip is shown to you as one to make`;
}
export const PROFILE_NEEDED = profileNeeded();

export const listMembers = (db) =>
  db.prepare("SELECT * FROM members ORDER BY name COLLATE NOCASE, id").all().map(plain);

// ------------------------------------------------------- distribution cap

/**
 * How many units a bounty may share out:
 *   min(availableUnits, max(0, floor(salesPerWeek * sellWindowWeeks) - competingListings))
 * so distribution is capped by the units on the shelf and by the resale
 * demand left after competing sellers' listings. Any unknown or invalid input
 * gives 0 (fail closed).
 *
 * earlierUnits (round 5, optional): units bought through earlier bounties for
 * the same item that have not been recorded as sold or returned, plus units
 * held in live claims on them (earlierAllocation). They are on their way to
 * the same buyers, so they come off the demand like competing listings.
 * Absent (undefined) means none; anything else that is not a count,
 * null included, gives 0.
 *
 * ownListings (round 5b, optional): competing listings that are members'
 * own units, already counted as earlier units or as units bought through
 * this bounty (ownListings()), so they are counted once. Never more than
 * competingListings; absent or not a count leaves every listing counted.
 */
export function distributionCap({ availableUnits, salesPerWeek, sellWindowWeeks, competingListings, earlierUnits, ownListings } = {}) {
  const earlier = earlierUnits === undefined ? 0 : earlierUnits;
  if (!isCount(availableUnits) || !isPositive(salesPerWeek) || !isPositive(sellWindowWeeks) || !isCount(competingListings) || !isCount(earlier))
    return 0;
  // Members' own listings of units already counted (round 5b) count once;
  // anything that is not a count leaves every listing counted.
  const own = isCount(ownListings) ? Math.min(ownListings, competingListings) : 0;
  const demand = Math.floor(salesPerWeek * sellWindowWeeks + 1e-9);
  return Math.min(availableUnits, Math.max(0, demand - (competingListings - own) - earlier));
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
 *
 * options.boughtBefore: units members marked as bought through this bounty
 * before that stock check (round 4, N3). They are no longer on the shelf the
 * check counted, but they stay held against the cap (completed claims), so
 * the units the bounty shares in all are the count plus those units; without
 * them a check made after purchases would take those units off twice.
 * basis.demand is the cap before any shelf limit: the resale demand left
 * after competing listings, never more than the operator's limit.
 *
 * options.earlier (round 5): earlierAllocation for the bounty, the units
 * earlier bounties for the item still have against its demand (bought and
 * not recorded as sold or returned, or held in a live claim). They come off
 * the demand like competing listings (used.earlierUnits), never off the
 * operator's limit or the shelf, and the notes say so in plain words. The
 * bounty's own purchases are not among them: claimSeats takes those off.
 *
 * options.owners (round 5b): listingOwners for the bounty. Competing
 * listings that are members' own units bought through bounties for the item
 * (ownListings, matched by their seller name) are counted once
 * (used.ownListings); evidence.listingsBySeller keeps the competition's
 * listings per seller so a later read can match them again.
 */
function capBasis(entered, estimate, lookup = null, { boughtBefore = 0, earlier = null, owners = null } = {}) {
  const earlierUnits = isCount(earlier?.units) ? earlier.units : 0;
  const counted = evidencedUnits(estimate.stock);
  const before = counted === null || !isCount(boughtBefore) ? 0 : boughtBefore;
  const units = counted === null ? null : counted + before;
  const rate = evidencedSalesPerWeek(estimate.sample?.count);
  const listings = estimate.competition?.activeListings;
  const sellers = estimate.competition?.sellers;
  const looked = lookupOf(estimate, lookup);
  const limit = isCount(entered.availableUnits) ? entered.availableUnits : null;
  const knownListings = isCount(listings) && (listings > 0 || looked !== null) ? listings : null;
  const bySeller = knownListings !== null && Array.isArray(estimate.competition?.bySeller) ? estimate.competition.bySeller : null;
  const own = ownListings(bySeller, owners ?? [], knownListings);
  // One sell window for the cap and the buy-alert gate: an operator's longer
  // window is capped at the gate's (OPPORTUNITY_RULES.sellWindowWeeks).
  const gateWeeks = OPPORTUNITY_RULES.sellWindowWeeks;
  const weeks = isPositive(entered.sellWindowWeeks) ? Math.min(entered.sellWindowWeeks, gateWeeks) : entered.sellWindowWeeks;
  const used = {
    availableUnits: units === null ? null : limit === null ? units : Math.min(limit, units),
    salesPerWeek: rate === null ? null : Math.min(entered.salesPerWeek, rate),
    sellWindowWeeks: weeks,
    competingListings: knownListings,
    earlierUnits,
    ownListings: own.units,
  };
  const notes = [];
  if (isPositive(entered.sellWindowWeeks) && entered.sellWindowWeeks > gateWeeks)
    notes.push(
      `Sell window limited to ${plural(gateWeeks, "week")}, the window the buy-alert checks use, not the ${entered.sellWindowWeeks} entered`,
    );
  if (units === null)
    notes.push(
      estimate.stock?.check
        ? "The stock check recorded no unit count, so units on the shelf are unknown and the cap is 0. Record a check with the units seen."
        : "No stock check with a unit count, so units on the shelf are unknown and the cap is 0",
    );
  else if (limit !== null && limit < units)
    notes.push(
      before > 0
        ? `Units to share limited to ${limit} of the ${units}: the ${counted} counted on the latest stock check and the ${before} members bought through this bounty before it`
        : `Units to share limited to ${limit} of the ${units} counted on the latest stock check`,
    );
  else if (before > 0)
    notes.push(
      `Units to share: ${units}, the ${plural(counted, "unit")} counted on the latest stock check and the ${plural(before, "unit")} members bought through this bounty before it`,
    );
  if (rate === null) notes.push("No confirmed sales count, so the cap is 0");
  else if (rate < entered.salesPerWeek)
    notes.push(
      `Sales a week lowered to ${round2(rate)}: ${estimate.sample.count} confirmed sales over ${BOUNTY_RULES.saleWindowDays} days`,
    );
  if (knownListings === null)
    notes.push(
      listings === 0
        ? `No competing listings recorded and no asking-price lookup for this barcode in the last ${plural(DEFAULT_LOOKUP_HOURS, "hour")} (a lookup that found none counts that long), so competition is unknown (not zero) and the cap is 0. Run an asking-price lookup before sharing.`
        : typeof estimate.competition?.note === "string" && estimate.competition.note
          ? `${estimate.competition.note}. Competing listings unknown, so the cap is 0`
          : "Competing listings unknown, so the cap is 0",
    );
  else if (knownListings === 0)
    notes.push(`An asking-price lookup (${looked.provider}, ${humanTime(looked.fetched)}) found no competing listings`);
  const earlierText = earlierNote(earlier);
  if (earlierText) notes.push(earlierText);
  const ownText = ownListingsNote(own, knownListings);
  if (ownText) notes.push(ownText);
  const unnamedText = unnamedSellerNote(own);
  if (unnamedText) notes.push(unnamedText);
  return {
    entered,
    evidence: {
      unitsSeen: counted,
      boughtBefore: before,
      earlierUnits,
      ownListings: own.units,
      listingsBySeller: bySeller,
      salesPerWeek: rate === null ? null : round2(rate),
      confirmedSales: isCount(estimate.sample?.count) ? estimate.sample.count : null,
      competingListings: knownListings,
      competingSellers: knownListings === null ? null : isCount(sellers) ? sellers : null,
      askingLookup: looked,
    },
    used: { ...used, salesPerWeek: used.salesPerWeek === null ? null : round2(used.salesPerWeek) },
    cap: distributionCap(used),
    demand: demandCap(used, limit),
    notes,
  };
}

/**
 * The cap before any shelf limit (round 4, N3): the resale demand in the
 * sell window less competing listings, never more than the operator's
 * limit on units to share (null for none). 0 when any figure is unknown.
 */
function demandCap(used, limit = null) {
  const demand = distributionCap({ ...used, availableUnits: Number.MAX_SAFE_INTEGER });
  return isCount(limit) ? Math.min(limit, demand) : demand;
}

// ------------------------------------------- resale demand across bounties

// Round 5: the resale demand for an item belongs to the item, not to one
// bounty, so withdrawing a bounty (or letting it expire) and opening another
// never starts again from the full demand. Units bought through a claim count
// against the demand until they are released on evidence: the member who
// bought them records them as sold or returned, or the operator records a
// reconciliation with a reason (claim_releases). Without a record they stay
// allocated (fail closed). No ledger trip is linked to a claim today, so the
// ledger cannot release them.

export const RELEASE_KINDS = Object.freeze(["sold", "returned", "reconciled"]);
const noReleases = () => ({ sold: 0, returned: 0, reconciled: 0, total: 0 });

/** Units released on each completed claim: Map claim id -> { sold, returned, reconciled, total }. */
function releasedOn(db, claimIds) {
  const out = new Map();
  if (!claimIds.length) return out;
  const rows = db
    .prepare(
      `SELECT claim_id, kind, COALESCE(SUM(units), 0) AS n FROM claim_releases
 WHERE claim_id IN (${claimIds.map(() => "?").join(", ")}) GROUP BY claim_id, kind`,
    )
    .all(...claimIds);
  for (const r of rows) {
    // Only a known kind releases anything (fail closed).
    if (!RELEASE_KINDS.includes(r.kind) || !isCount(r.n)) continue;
    const e = out.get(r.claim_id) ?? noReleases();
    e[r.kind] += r.n;
    e.total += r.n;
    out.set(r.claim_id, e);
  }
  return out;
}

/**
 * A completed claim's units against the demand for its item: { bought,
 * released: { sold, returned, reconciled }, outstanding }. Outstanding is
 * the units bought less the units released, never below 0. An active or
 * ended claim that bought nothing has nothing outstanding.
 */
export function claimAllocation(db, claim) {
  const bought = claim?.status === "completed" && isCount(claim.units) ? claim.units : 0;
  const r = bought ? (releasedOn(db, [claim.id]).get(claim.id) ?? noReleases()) : noReleases();
  return {
    bought,
    released: { sold: r.sold, returned: r.returned, reconciled: r.reconciled },
    outstanding: Math.max(0, bought - Math.min(bought, r.total)),
  };
}

/**
 * The units earlier live bounties for the same item still have against its
 * resale demand (round 5): every bounty that is not a sample, has the same
 * canonical barcode and was opened before this one (a lower id; options
 * for a bounty not yet created have no id), whatever its status (open,
 * withdrawn or expired) and its retailer or locality, since the item resells
 * to the same buyers wherever it was bought. Units bought through completed
 * claims count until released (claimAllocation); units in live claims count
 * until the claim lapses, is released or is marked as bought.
 *
 * Not scoped by variant or condition: a GTIN already names one variant,
 * every bounty buys new retail stock, and splitting by the variant text
 * would let a differently written variant start again from the full demand
 * (fail open).
 *
 * Returns { units, outstanding, held, bought, released: { sold, returned,
 * reconciled }, bounties: [id], heldOn: [id], claims: [{ id, bountyId,
 * memberId, units, released, outstanding, endedAt }] } where units =
 * outstanding + held, bounties are the bounties with units outstanding,
 * heldOn those with live claims, and claims lists the completed claims with
 * units still outstanding, oldest first.
 */
export function earlierAllocation(db, bounty, now) {
  const out = { units: 0, outstanding: 0, held: 0, bought: 0, released: { sold: 0, returned: 0, reconciled: 0 }, bounties: [], heldOn: [], claims: [] };
  if (!bounty || bounty.sample) return out;
  // A live bounty stores the canonical GTIN (createBounty), as boughtAtBranch reads it.
  const gtin = normaliseBarcode(bounty.barcode);
  if (!gtin) return out;
  const before = Number.isSafeInteger(bounty.id) ? bounty.id : Number.MAX_SAFE_INTEGER;
  const ids = db.prepare("SELECT id FROM bounties WHERE sample = 0 AND barcode = ? AND id < ?").all(gtin, before).map((b) => b.id);
  if (!ids.length) return out;
  const rows = db
    .prepare(
      `SELECT id, bounty_id, member_id, units, status, ended_at FROM claims WHERE bounty_id IN (${ids.map(() => "?").join(", ")})
 AND (status = 'completed' OR (status = 'active' AND expires_at > ?)) ORDER BY ended_at, id`,
    )
    .all(...ids, iso(clock(now)));
  const done = rows.filter((c) => c.status === "completed" && isCount(c.units) && c.units > 0);
  const released = releasedOn(db, done.map((c) => c.id));
  const counted = new Set();
  const heldOn = new Set();
  for (const c of rows) {
    if (c.status === "active") {
      if (!isCount(c.units)) continue;
      out.held += c.units;
      heldOn.add(c.bounty_id);
      continue;
    }
    if (!(isCount(c.units) && c.units > 0)) continue;
    const r = released.get(c.id) ?? noReleases();
    const outstanding = Math.max(0, c.units - Math.min(c.units, r.total));
    out.bought += c.units;
    for (const k of ["sold", "returned", "reconciled"]) out.released[k] += r[k];
    if (outstanding === 0) continue;
    out.outstanding += outstanding;
    counted.add(c.bounty_id);
    out.claims.push({
      id: c.id,
      bountyId: c.bounty_id,
      memberId: c.member_id,
      units: c.units,
      released: { sold: r.sold, returned: r.returned, reconciled: r.reconciled },
      outstanding,
      endedAt: c.ended_at,
    });
  }
  out.units = out.outstanding + out.held;
  out.bounties = [...counted].sort((a, b) => a - b);
  out.heldOn = [...heldOn].sort((a, b) => a - b);
  return out;
}

const earlierWhere = (n) => (n > 1 ? "earlier bounties" : "an earlier bounty");

/**
 * The plain words for units earlier bounties still have against the
 * demand for the item, or null when there are none: "3 units bought
 * through an earlier bounty for this item have not been recorded as sold
 * or returned, so they still count against the demand for it".
 */
export function earlierNote(e) {
  if (!isObject(e) || !(e.units > 0)) return null;
  const parts = [];
  if (e.outstanding > 0)
    parts.push(
      `${plural(e.outstanding, "unit")} bought through ${earlierWhere(e.bounties?.length ?? 1)} for this item ${e.outstanding === 1 ? "has" : "have"} not been recorded as sold or returned, so ${e.outstanding === 1 ? "it still counts" : "they still count"} against the demand for it`,
    );
  if (e.held > 0)
    parts.push(
      `${plural(e.held, "unit")} ${e.held === 1 ? "is" : "are"} held in a claim on ${earlierWhere(e.heldOn?.length ?? 1)} for this item, so ${e.held === 1 ? "it counts" : "they count"} against the demand for it until the claim lapses or is released`,
    );
  return parts.join(". ");
}

/** How units from earlier bounties stop counting, in plain words, or null. */
export function earlierRelease(e) {
  if (!isObject(e) || !(e.units > 0)) return null;
  const parts = [];
  if (e.outstanding > 0)
    parts.push(
      "Units bought stop counting once the member who bought them records them as sold or returned, or the operator records a reconciliation with a reason",
    );
  if (e.held > 0) parts.push("A claim stops counting when it lapses or is released, or counts as bought when it is marked as bought");
  return parts.join(". ");
}

// ------------------------------------- members' own listings (round 5b)

// A member who bought units through a bounty and lists them on eBay shows up
// twice: their listings are counted as competing listings, and their units
// as units from an earlier bounty (or as units bought through this one).
// With their marketplace seller name on their profile, confirmed by the
// operator, their own listings are counted once. Everything else counts in
// full (fail closed): a listing by no stated seller or by a seller no member
// gave, a listing with no known listing time, a listing from before the
// unit it would match was bought, a member who gave no seller name or whose
// name the operator has not confirmed, and a name that was already selling
// the item before the member first bought it through a bounty.

/**
 * A seller name as compared: NFKC, Unicode lower case, spaces collapsed
 * (matching.sellerName); null when none. Uniqueness and matching use only
 * this key.
 */
export const sellerKey = (value) => {
  const name = typeof value === "string" ? sellerName(value) : null;
  return name ? name.toLowerCase() : null;
};

const timeMs = (value) => (typeof value === "string" && value ? Date.parse(value) : NaN);

/**
 * The earliest time (ms) each seller key was seen in the evidence as a
 * seller of the item (any research row for the barcode: a sale or a
 * listing, by its observed or listed time). Map key -> ms.
 */
function sellerFirstSeen(db, gtin, keys) {
  const out = new Map();
  if (!gtin || !keys.size) return out;
  const rows = db
    .prepare("SELECT barcode, seller, observed, listed FROM research WHERE seller IS NOT NULL AND barcode LIKE ?")
    .all("%" + gtin.slice(-8));
  for (const r of rows) {
    if (normaliseBarcode(r.barcode) !== gtin) continue;
    const key = sellerKey(r.seller);
    if (!key || !keys.has(key)) continue;
    for (const t of [timeMs(r.observed), timeMs(r.listed)])
      if (Number.isFinite(t) && !(out.get(key) <= t)) out.set(key, t);
  }
  return out;
}

/**
 * Members holding, or who held, units bought through bounties for the item:
 * every completed claim on a live bounty with the same canonical barcode up
 * to and including this one (a bounty not yet created has no id, so only
 * earlier ones). Returns [{ memberId, name, seller, givenKey, confirmed,
 * prior, key, firstBought, outstanding, claims: [{ bountyId, boughtAt,
 * units, releases: [{ at, units }] }] }] sorted by member id (times in
 * milliseconds). seller is the name as they gave it; givenKey its matching
 * key; confirmed whether the operator confirmed it; prior whether that key
 * was seen selling the item before the member's first purchase of it; key
 * is givenKey only when confirmed and not prior (otherwise null: their
 * listings count in full); outstanding is the units not yet recorded as
 * sold, returned or reconciled now.
 */
export function listingOwners(db, bounty, now) {
  if (!bounty || bounty.sample) return [];
  const gtin = normaliseBarcode(bounty.barcode);
  if (!gtin) return [];
  const upTo = Number.isSafeInteger(bounty.id) ? bounty.id : Number.MAX_SAFE_INTEGER;
  const at = iso(clock(now));
  const claims = db
    .prepare(
      `SELECT c.id, c.bounty_id, c.member_id, c.units, c.ended_at FROM claims c JOIN bounties b ON b.id = c.bounty_id
 WHERE b.sample = 0 AND b.barcode = ? AND b.id <= ? AND c.status = 'completed' AND c.units > 0 AND c.ended_at <= ?
 ORDER BY c.ended_at, c.id`,
    )
    .all(gtin, upTo, at)
    .filter((c) => isCount(c.units) && Number.isFinite(Date.parse(c.ended_at)));
  if (!claims.length) return [];
  const releases = db
    .prepare(
      `SELECT claim_id, kind, units, created FROM claim_releases WHERE claim_id IN (${claims.map(() => "?").join(", ")})
 AND created <= ? ORDER BY created, id`,
    )
    .all(...claims.map((c) => c.id), at)
    .filter((r) => RELEASE_KINDS.includes(r.kind) && isCount(r.units));
  const byMember = new Map();
  for (const c of claims) {
    const own = releases
      .filter((r) => r.claim_id === c.id && Number.isFinite(Date.parse(r.created)))
      .map((r) => ({ at: Date.parse(r.created), units: r.units }));
    const released = Math.min(c.units, own.reduce((n, r) => n + r.units, 0));
    const entry = byMember.get(c.member_id) ?? { outstanding: 0, claims: [] };
    entry.outstanding += c.units - released;
    entry.claims.push({ bountyId: c.bounty_id, boughtAt: Date.parse(c.ended_at), units: c.units, releases: own });
    byMember.set(c.member_id, entry);
  }
  const get = db.prepare("SELECT id, name, seller_name, seller_key, seller_confirmed_at FROM members WHERE id = ?");
  const members = [...byMember.keys()].map((memberId) => get.get(memberId)).filter(Boolean);
  const firstSeen = sellerFirstSeen(db, gtin, new Set(members.map((m) => m.seller_key).filter(Boolean)));
  return members
    .map((m) => {
      const e = byMember.get(m.id);
      const givenKey = typeof m.seller_key === "string" && m.seller_key ? m.seller_key : null;
      const confirmed = Boolean(givenKey && m.seller_confirmed_at);
      const firstBought = Math.min(...e.claims.map((c) => c.boughtAt));
      const prior = Boolean(givenKey && firstSeen.get(givenKey) < firstBought);
      return {
        memberId: m.id,
        name: m.name ?? null,
        seller: typeof m.seller_name === "string" ? m.seller_name : null,
        givenKey,
        confirmed,
        prior,
        key: confirmed && !prior ? givenKey : null,
        firstBought,
        outstanding: e.outstanding,
        claims: e.claims,
      };
    })
    .sort((a, b) => a.memberId - b.memberId);
}

/** Why a member's own listings still count in full: "none", "unconfirmed" or "prior"; null when they count once. */
const unmatchedReason = (o) => (o.key ? null : !o.givenKey ? "none" : o.prior ? "prior" : "unconfirmed");

/**
 * The note for a member viewing a bounty while units they bought through
 * bounties for its item are outstanding and their listings would still
 * count in full (no seller name, a name the operator has not confirmed, or
 * a name already selling the item before they bought), when the cap counts
 * competing listings (round 5b), or null.
 */
function viewerSellerNote(db, bounty, member, basis, now) {
  if (!member || bounty.sample) return null;
  const listings = basis?.used?.competingListings;
  if (!isCount(listings) || listings === 0) return null;
  const mine = listingOwners(db, bounty, now).find((o) => o.memberId === member.id);
  const why = mine && mine.outstanding > 0 ? unmatchedReason(mine) : null;
  if (!why) return null;
  const n = mine.outstanding;
  const lead = `You have ${plural(n, "unit")} of this item bought through bounties and not yet recorded as sold or returned`;
  const twice = `If you list ${n === 1 ? "it" : "them"} for sale, ${n === 1 ? "it counts" : "they count"} twice against the demand: as competing listings and as units bought`;
  if (why === "none")
    return `${lead}, and your profile has no marketplace seller name. ${twice}. Add your seller name (for example your eBay user name) to your member profile and ask the operator to confirm it to stop that`;
  if (why === "unconfirmed")
    return `${lead}, and the operator has not yet confirmed your seller name "${mine.seller}". ${twice} until the operator checks it against your marketplace profile or one of your listings and confirms it`;
  return `${lead}. Your seller name "${mine.seller}" was already selling this item before you bought it through a bounty, so listings under it count in full as competing listings`;
}

/**
 * How many competing listings are members' own units (round 5b), so they
 * are counted once. bySeller is the resale competition's listings per
 * stated seller (matching.competition: each listing once, with when it was
 * last seen and when it was listed), owners listingOwners.
 *
 * Only an owner with a key (a seller name the operator confirmed, not seen
 * selling the item before their first purchase) has listings left out, and
 * only listings with a known listing time. Listings are matched to units
 * per sighting: the listings last seen at a time t may be left out only up
 * to the units the member held at t (bought at or before t, less what was
 * released by t), each matched to a unit bought at or before the listing
 * was listed, and each listing used once. So a listing first seen after
 * every unit was released, one listed before the unit it would match was
 * bought, and listings beyond the units held when they were seen all count.
 *
 * Returns { units, members: [{ memberId, seller, listings, own }], unnamed:
 * [{ memberId, name, outstanding, reason }] }: units is never more than
 * competingListings (0 when that is not a count); unnamed are members with
 * units outstanding whose listings still count in full (reason "none",
 * "unconfirmed" or "prior"), listed only while there are competing listings.
 */
export function ownListings(bySeller, owners, competingListings) {
  const out = { units: 0, members: [], unnamed: [] };
  if (!isCount(competingListings) || competingListings === 0 || !Array.isArray(owners)) return out;
  out.unnamed = owners
    .filter((o) => o.outstanding > 0 && unmatchedReason(o))
    .map((o) => ({ memberId: o.memberId, name: o.name, outstanding: o.outstanding, reason: unmatchedReason(o) }));
  const seen = new Map();
  for (const entry of Array.isArray(bySeller) ? bySeller : []) {
    const key = sellerKey(entry?.seller);
    if (!key || !Array.isArray(entry.seen)) continue;
    const times = entry.seen.filter((l) => isObject(l) && Number.isFinite(timeMs(l.observed)));
    seen.set(key, [...(seen.get(key) ?? []), ...times]);
  }
  const used = new Set();
  for (const o of owners) {
    if (!o.key || used.has(o.key) || !seen.has(o.key)) continue;
    used.add(o.key);
    const listings = seen.get(o.key);
    // Listings with a known listing time, grouped by when they were seen.
    const bySighting = new Map();
    for (const l of listings) {
      const listed = timeMs(l.listed);
      if (!Number.isFinite(listed)) continue;
      const t = timeMs(l.observed);
      bySighting.set(t, [...(bySighting.get(t) ?? []), listed]);
    }
    let own = 0;
    for (const [t, listedTimes] of bySighting) {
      // The units held at t, by purchase.
      const pool = o.claims
        .filter((c) => c.boughtAt <= t)
        .map((c) => ({
          boughtAt: c.boughtAt,
          left: c.units - Math.min(c.units, c.releases.filter((r) => r.at <= t).reduce((k, r) => k + r.units, 0)),
        }))
        .sort((a, b) => a.boughtAt - b.boughtAt);
      for (const listed of listedTimes.sort((a, b) => a - b)) {
        const unit = pool.find((p) => p.left > 0 && p.boughtAt <= listed);
        if (!unit) continue;
        unit.left -= 1;
        own += 1;
      }
    }
    own = Math.min(own, listings.length);
    out.members.push({ memberId: o.memberId, seller: o.seller, listings: listings.length, own });
    out.units += own;
  }
  out.units = Math.min(out.units, competingListings);
  return out;
}

/**
 * The operator's list of members holding units of the item (round 5b):
 * [{ memberId, name, sellerName, confirmed, prior, outstanding, status }],
 * status in words: what still stops their listings counting once.
 */
function sellerNamesView(db, bounty, now) {
  return listingOwners(db, bounty, now)
    .filter((o) => o.outstanding > 0)
    .map((o) => {
      const why = unmatchedReason(o);
      return {
        memberId: o.memberId,
        name: o.name,
        sellerName: o.seller,
        confirmed: o.confirmed,
        prior: o.prior,
        outstanding: o.outstanding,
        status:
          why === "none"
            ? "No seller name given: any of their units listed for sale count twice."
            : why === "prior"
              ? "This seller name was already selling the item before they bought it through a bounty, so its listings count in full."
              : why === "unconfirmed"
                ? "Not confirmed yet: check the name against their marketplace profile or one of their listings, then confirm it. Until then their listings count in full."
                : "Confirmed: their listings with a listing time after they bought are counted once, up to the units they hold.",
      };
    });
}

/** The plain words for listings counted once, or null: no names, as every viewer may see the cap notes. */
export function ownListingsNote(own, listings) {
  if (!isObject(own) || !(own.units > 0)) return null;
  return `${own.units} of the ${plural(listings, "competing listing")} ${own.units === 1 ? "is a member's own unit" : "are members' own units"} bought through bounties for this item (matched by the seller name on their profile, confirmed by the operator), so ${own.units === 1 ? "it is" : "they are"} counted once, not again as competing listings`;
}

/** The plain words for members whose own listings still count in full, or null. */
export function unnamedSellerNote(own) {
  const list = isObject(own) && Array.isArray(own.unnamed) ? own.unnamed : [];
  const count = (reason) => list.filter((u) => u.reason === reason).length;
  const holding = (n) => `${plural(n, "member")} holding units bought through bounties for this item`;
  const has = (n) => (n === 1 ? "has" : "have");
  const parts = [];
  const none = count("none");
  if (none)
    parts.push(
      `${holding(none)} ${has(none)} given no marketplace seller name, so any of those units listed for sale count twice: as competing listings and as units bought. Adding the seller name (for example the eBay user name) to the member profile, once the operator confirms it, stops their own listings counting twice`,
    );
  const unconfirmed = count("unconfirmed");
  if (unconfirmed)
    parts.push(
      `${holding(unconfirmed)} ${has(unconfirmed)} a seller name the operator has not yet confirmed, so any of those units listed for sale still count twice until the operator checks the name against the member's marketplace profile or a listing and confirms it`,
    );
  const prior = count("prior");
  if (prior)
    parts.push(
      `${holding(prior)} gave a seller name that was already selling this item before they bought it through a bounty, so listings under it count in full as competing listings`,
    );
  return parts.length ? parts.join(". ") : null;
}

/** The completed claim a release is recorded on, or an error. */
function boughtClaim(db, claimId, action) {
  const found = getClaim(db, id(claimId, "claimId")) ?? fail("Claim not found", 404);
  if (found.status !== "completed")
    fail(
      found.status === "active"
        ? `This claim has not been marked as bought, so nothing bought through it can be ${action}: release it or mark it as bought first`
        : `This claim ended without a purchase (${found.status}), so nothing bought through it can be ${action}`,
      409,
    );
  return found;
}

const outstandingRefusal = (state, asked) =>
  state.outstanding === 0
    ? "Every unit bought through this claim is already recorded as sold, returned or reconciled"
    : `Only ${plural(state.outstanding, "unit")} bought through this claim ${state.outstanding === 1 ? "is" : "are"} not yet recorded as sold, returned or reconciled, so ${asked} cannot be recorded`;

/**
 * Records units bought through a member's own completed claim as sold or
 * returned to the shop (round 5), so they stop counting against the resale
 * demand for the item. Only the member who made the claim (403), only a
 * claim marked as bought (409), and never more than is outstanding (409).
 * sold and returned are whole numbers (blank means none); at least one unit.
 * Each kind is stored as its own row with the time and the member.
 */
export function recordResale(db, { claimId, memberId, sold, returned, now }) {
  const at = iso(clock(now));
  const count = (value, name) => (value === undefined || value === null || value === "" ? 0 : int(value, name, 0, BOUNTY_RULES.maxAvailableUnits));
  return transaction(db, () => {
    const found = getClaim(db, id(claimId, "claimId")) ?? fail("Claim not found", 404);
    if (found.member_id !== id(memberId, "memberId"))
      fail("Only the member who made a claim can record its units as sold or returned", 403);
    boughtClaim(db, found.id, "recorded as sold or returned");
    const s = count(sold, "sold");
    const r = count(returned, "returned");
    if (s + r === 0) fail("Enter the units sold or returned: at least 1");
    const state = claimAllocation(db, found);
    if (s + r > state.outstanding) fail(outstandingRefusal(state, plural(s + r, "unit")), 409);
    const put = db.prepare(
      "INSERT INTO claim_releases(claim_id, kind, units, reason, recorded_by, member_id, created) VALUES(?, ?, ?, NULL, 'member', ?, ?)",
    );
    if (s) put.run(found.id, "sold", s, found.member_id, at);
    if (r) put.run(found.id, "returned", r, found.member_id, at);
    return { claim: found, ...claimAllocation(db, found) };
  });
}

/**
 * The operator's reconciliation of units bought through a completed claim
 * (round 5): units the operator has evidence are no longer heading to the
 * resale market (for example a sale the member reported another way), with
 * a reason, stored with the time and "operator". Never more than is
 * outstanding (409). The route checks that the caller is the operator.
 */
export function reconcileClaim(db, { claimId, units, reason, now }) {
  const at = iso(clock(now));
  return transaction(db, () => {
    const found = boughtClaim(db, claimId, "reconciled");
    const n = int(units, "units", 1, BOUNTY_RULES.maxAvailableUnits);
    const why = text(reason, "reason", 300);
    const state = claimAllocation(db, found);
    if (n > state.outstanding) fail(outstandingRefusal(state, plural(n, "unit")), 409);
    db.prepare(
      "INSERT INTO claim_releases(claim_id, kind, units, reason, recorded_by, member_id, created) VALUES(?, 'reconciled', ?, ?, 'operator', NULL, ?)",
    ).run(found.id, n, why, at);
    return { claim: found, ...claimAllocation(db, found) };
  });
}

/** Every release recorded on a claim, oldest first, for the card. */
function releasesOf(db, claimId) {
  return db
    .prepare("SELECT kind, units, reason, recorded_by, member_id, created FROM claim_releases WHERE claim_id = ? ORDER BY created, id")
    .all(claimId)
    .map((r) => ({ kind: r.kind, units: r.units, reason: r.reason ?? null, recordedBy: r.recorded_by, at: r.created }));
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
    if (!newest.has(name) || at > newest.get(name).ms) newest.set(name, { ms: at, value: saleDateValue(row.observed, at) });
  }
  return [...newest.values()].sort((a, b) => a.ms - b.ms).map((d) => d.value);
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A sale date as the snapshot keeps it (round 4, N5): a calendar date
 * ("2026-05-02") stays a calendar date, so a later read ages it in UK days
 * as the estimate does (alerts.mjs ageDays); a time is kept as an ISO time.
 */
const saleDateValue = (observed, ms) => (typeof observed === "string" && CALENDAR_DATE.test(observed) ? observed : iso(ms));

/**
 * The date of every confirmed sale behind the figures, oldest first, so a
 * later read can count how many are still inside the sale window and work
 * the sales rate (and the cap) out again. Null when the sample has no rows
 * or a sale has no usable date (the rate then cannot be re-counted).
 */
function saleDates(sample) {
  const used = Array.isArray(sample?.used) ? sample.used : null;
  if (!used) return null;
  const dates = used.map((row) => ({ ms: Date.parse(row?.observed), observed: row?.observed }));
  if (dates.some((d) => !Number.isFinite(d.ms))) return null;
  return dates.sort((a, b) => a.ms - b.ms).map((d) => saleDateValue(d.observed, d.ms));
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
 * them is unknown or 0), and, when given (not null), the units left on the
 * shelf.
 */
export function claimableUnits({ estimateUnits, cap, trialUnits, shelfUnits = null }) {
  const limits = [estimateUnits, cap, trialUnits];
  if (shelfUnits !== null && shelfUnits !== undefined) limits.push(shelfUnits);
  return Math.min(...limits.map((v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0)));
}

/**
 * Units likely left on the shelf by the estimate's own count (stock.shelf:
 * the newest branch check or stock report less units members bought through
 * bounties since, as the buy-alert gate's shelf-units check reads it), or
 * null when the estimate does not confirm stock or has no count.
 */
function estimateShelfUnits(estimate) {
  const stock = estimate?.stock;
  return stock?.confirmed === true && isCount(stock.shelf?.units) ? stock.shelf.units : null;
}

/**
 * The unit plan for a live bounty from its evidence: { cap, trial,
 * estimateUnits, shelf, claimable, figures, rerun }. figures is the count
 * the bounty's figures must be worked out for (claimable, at least 1);
 * rerun is true when the estimate was for more units than that, so it must
 * be run again for `figures` units before the bounty may alert.
 *
 * Round 4 (N1): claimable is never more than the units the estimate says
 * are left on the shelf (shelf), so once members buy some of the units a
 * check counted, the figures are worked out again for the units left
 * instead of failing the shelf-units check for the whole bounty. Nor is it
 * more than the cap less units already bought (options.completed).
 *
 * Round 5: options.earlier (earlierAllocation) takes the units earlier
 * bounties for the item still have against its demand off the cap first
 * (capBasis), so a replacement bounty's figures are for what is left.
 */
function unitsPlan(entered, estimate, lookup, { boughtBefore = 0, completed = 0, earlier = null, owners = null } = {}) {
  const basis = capBasis(entered, estimate, lookup, { boughtBefore, earlier, owners });
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
  const shelf = estimateShelfUnits(estimate);
  const bought = isCount(completed) ? completed : 0;
  const claimable = claimableUnits({ estimateUnits, cap: Math.max(0, basis.cap - bought), trialUnits: trial, shelfUnits: shelf });
  const figures = Math.max(1, claimable);
  return {
    cap: basis.cap,
    trial,
    estimateUnits,
    shelf,
    claimable,
    figures,
    rerun: Number.isSafeInteger(fromEconomics) && fromEconomics > figures,
  };
}

/**
 * The unit plan for a new bounty, so the route can re-run the estimate for
 * the units one member can claim before creating it. Validates the bounty
 * fields like createBounty. With options.db, the units earlier bounties for
 * the item still have against its demand come off the cap (round 5), as
 * createBounty counts them.
 */
export function planForInput(input, estimate, { lookup = null, now, db = null } = {}) {
  const f = bountyFields(input, clock(now));
  return unitsPlan(
    { availableUnits: f.availableUnits, salesPerWeek: f.salesPerWeek, sellWindowWeeks: f.sellWindowWeeks },
    estimate,
    lookup,
    db
      ? {
          earlier: earlierAllocation(db, { barcode: estimate?.offer?.gtin }, now),
          owners: listingOwners(db, { barcode: estimate?.offer?.gtin }, now),
        }
      : {},
  );
}

/**
 * The unit plan for re-checking a live bounty with a fresh estimate. With
 * options.db, the units bought through the bounty count as refreshBounty
 * counts them (before the estimate's stock check, and in all), and so do
 * the units earlier bounties for the item still have against its demand
 * (round 5).
 */
export function planForBounty(bounty, estimate, { lookup = null, db = null, now = null } = {}) {
  return unitsPlan(
    enteredOf(bounty),
    estimate,
    lookup,
    db
      ? {
          ...boughtOn(db, bounty, estimate),
          earlier: earlierAllocation(db, bounty, now ?? new Date().toISOString()),
          owners: listingOwners(db, bounty, now ?? new Date().toISOString()),
        }
      : {},
  );
}

/**
 * Units members marked as bought through a bounty: { boughtBefore, completed }
 * where boughtBefore is those bought at or before the estimate's stock check
 * (capBasis) and completed every unit bought.
 */
function boughtOn(db, bounty, estimate) {
  const rows = db.prepare("SELECT units, ended_at FROM claims WHERE bounty_id = ? AND status = 'completed'").all(bounty.id);
  const checkAt = Date.parse(estimate?.stock?.check?.checked_at);
  let boughtBefore = 0;
  let completed = 0;
  for (const r of rows) {
    if (!isCount(r.units)) continue;
    completed += r.units;
    if (Number.isFinite(checkAt) && Date.parse(r.ended_at) <= checkAt) boughtBefore += r.units;
  }
  return { boughtBefore, completed };
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
    sample: sample ? { ...sample, sellers, dates: saleDates(estimate.sample) } : null,
    competition: pick(estimate.competition, [
      "activeListings", "sellers", "lowestAsking", "lowestAskingIncludesShipping", "checkedAt", "note", "bySeller",
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
      ? {
          requested: plan.estimateUnits,
          claimable: plan.claimable,
          figures: plan.figures,
          cap: plan.cap,
          trial: plan.trial,
          shelf: plan.shelf ?? null,
        }
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
      `The figures are for ${plural(plan.estimateUnits, "unit")}, but one member can claim at most ${plural(plan.figures, "unit")} (the smallest of the estimate's units, the cap, the trial batch${plan.shelf === null || plan.shelf === undefined ? "" : " and the units likely left on the shelf"}): the estimate must be worked out again for ${plural(plan.figures, "unit")}`,
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
 * the resale demand for the item and two bounties would double it. Units
 * earlier bounties for the barcode still have against the demand (bought
 * and not recorded as sold or returned, or held in a live claim) come off
 * the cap (earlierAllocation, round 5), so a replacement never starts again
 * from the full demand.
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
    // The resale demand belongs to the item (round 5): units earlier bounties
    // for it still have against the demand come off this bounty's cap.
    const earlier = earlierAllocation(db, { barcode: gtin }, now);
    // Members' own listings of units they bought through earlier bounties
    // count once (round 5b).
    const owners = listingOwners(db, { barcode: gtin }, now);
    const basis = capBasis(entered, estimate, lookup, { earlier, owners });
    const plan = unitsPlan(entered, estimate, lookup, { earlier, owners });
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
 *
 * options.claimChecks: [{ claimId, check }], each active claim's own trip
 * check re-run on the same evidence with its stored units and journey
 * (memberTripCheck; routes-bounties.mjs recheckClaims). Each claim's
 * figures are replaced with the re-run ones, marked { checkedAt, ok,
 * reasons }, and a holder whose own figures now fail gets a "Don't make
 * the trip" notice that says why instead of an "open again" notice
 * (syncTrip).
 */
export function refreshBounty(db, bountyId, estimate, now, { lookup = null, claimChecks = null } = {}) {
  const at = clock(now);
  const bounty = requireBounty(db, bountyId);
  if (bounty.sample) return bounty;
  const old = json(bounty.estimate, {}) ?? {};
  if (!isObject(estimate) || estimate.error) {
    const reason = "Evidence could not be re-checked" + (estimate?.error ? ": " + estimate.error : "");
    transaction(db, () => {
      db.prepare("UPDATE bounties SET alert_eligible = 0, alert_reasons = ?, checked_at = ? WHERE id = ?").run(
        JSON.stringify([reason]),
        iso(at),
        bounty.id,
      );
      storeClaimChecks(db, claimChecks, at);
    });
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
  // Units bought through this bounty before the new stock check stay held
  // against the cap but are not on the shelf it counted (round 4, N3), and
  // units earlier bounties for the item still have against its demand come
  // off it (round 5).
  const bought = { ...boughtOn(db, bounty, estimate), earlier: earlierAllocation(db, bounty, now), owners: listingOwners(db, bounty, now) };
  const basis = capBasis(entered, estimate, lookup, bought);
  const plan = unitsPlan(entered, estimate, lookup, bought);
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
    storeClaimChecks(db, claimChecks, at);
    // A branch check that now finds none stops anyone already on the way.
    const check = estimate.stock?.check;
    if (estimate.stock?.availability === "out_of_stock" && bountyStatus(bounty, now) === "open")
      notifyStop(db, bounty, {
        reason: "out-of-stock",
        // Keyed on when the shelf was seen empty, so a verified report that
        // became this check does not notify the same members twice.
        ref: "empty:" + (check?.checked_at ?? iso(at)),
        message: `${TERMS.stop}: ${emptyCheckHeadline(db, bounty, check?.checked_at ?? iso(at))}. Claims and alerts for this bounty are paused.`,
        now,
      });
  });
  return settled(db, bounty.id, now);
}

/**
 * Replaces each re-checked active claim's figures with the figures worked
 * out again on the latest evidence (refreshBounty), marked with when
 * (checkedAt), whether they pass (ok) and why not (reasons). A re-run that
 * gave no figures keeps the old ones, marked outOfDate. Returns the number
 * of claims updated.
 */
function storeClaimChecks(db, claimChecks, at) {
  if (!Array.isArray(claimChecks) || !claimChecks.length) return 0;
  const get = db.prepare("SELECT figures FROM claims WHERE id = ?");
  const put = db.prepare("UPDATE claims SET figures = ? WHERE id = ? AND status = 'active'");
  let n = 0;
  for (const item of claimChecks) {
    const check = item?.check;
    if (!Number.isSafeInteger(item?.claimId) || !isObject(check)) continue;
    const old = json(get.get(item.claimId)?.figures, null);
    const fresh = isObject(check.figures);
    const figures = {
      ...(fresh ? check.figures : isObject(old) ? old : {}),
      checkedAt: iso(at),
      ok: check.ok === true,
      reasons: Array.isArray(check.reasons) ? check.reasons.map(String) : [],
      // Values the member has still to give (memberTripCheck confirm, round 5b).
      confirm: Array.isArray(check.confirm) && check.confirm.length ? check.confirm.map(String) : null,
      ...(fresh ? {} : { outOfDate: true }),
    };
    n += put.run(JSON.stringify(figures), item.claimId).changes;
  }
  return n;
}

/**
 * The bounty row after a change to its evidence, once anyone alerted or
 * holding a claim has been told about a trip that stopped (or reopened).
 */
function settled(db, bountyId, now) {
  syncTrip(db, getBounty(db, bountyId), now, null, { read: false });
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
  const warned = onlyUnwarned ? warnedMembers(db, bounty.id) : new Set();
  const targets = noticeTargets(db, bounty.id, at).filter((m) => m !== exclude && !warned.has(m));
  let added = 0;
  for (const memberId of targets)
    added += addNotice(db, { bountyId: bounty.id, memberId, kind: "stop", reason, ref, message, at });
  return added;
}

/** Members alerted for a bounty or holding a live claim on it at `at`. */
function noticeTargets(db, bountyId, at) {
  return db
    .prepare(
      `SELECT member_id FROM alerts WHERE bounty_id = ? AND kind = 'alert'
 UNION SELECT member_id FROM claims WHERE bounty_id = ? AND status = 'active' AND expires_at > ?`,
    )
    .all(bountyId, bountyId, at)
    .map((r) => r.member_id);
}

/** Members holding a current (not superseded) "Don't make the trip" notice for a bounty. */
function warnedMembers(db, bountyId) {
  return new Set(
    db
      .prepare("SELECT DISTINCT member_id FROM notices WHERE bounty_id = ? AND kind = 'stop' AND superseded_at IS NULL")
      .all(bountyId)
      .map((r) => r.member_id),
  );
}

/**
 * Records one notice for one member, once per ref, and marks that member's
 * earlier current notices on the bounty superseded (R3Q7): a new "Don't make
 * the trip" replaces an earlier "Open for trips again", and only the latest
 * notice shows. A superseded stop keeps its ref, so the same event is not
 * notified twice before the bounty reopens (reopening frees the refs).
 * resurface: when a notice with this ref was already sent and later
 * superseded, make it the current one again instead of sending nothing.
 * Returns 1 when a notice was added, else 0.
 */
function addNotice(db, { bountyId, memberId, kind, reason, ref, message, at, resurface = false }) {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO notices(bounty_id, member_id, kind, reason, ref, message, created)
 VALUES(?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(bountyId, memberId, kind, reason, ref, message, at);
  let current = result.changes ? Number(result.lastInsertRowid) : null;
  if (!current && resurface) {
    const earlier = db
      .prepare("SELECT id, superseded_at FROM notices WHERE bounty_id = ? AND member_id = ? AND ref = ?")
      .get(bountyId, memberId, ref);
    if (earlier?.superseded_at) {
      db.prepare("UPDATE notices SET superseded_at = NULL WHERE id = ?").run(earlier.id);
      current = earlier.id;
    }
  }
  if (current)
    db.prepare(
      "UPDATE notices SET superseded_at = ? WHERE bounty_id = ? AND member_id = ? AND superseded_at IS NULL AND id != ?",
    ).run(at, bountyId, memberId, current);
  return result.changes;
}

/**
 * When a stopped bounty can send people on trips again, members holding a
 * current stop notice get a notice that it reopened, and their stop notices
 * are marked superseded with their refs freed, so the same event can stop
 * the trip again later. exclude: members who stay stopped (their own
 * figures fail, or their claim is beyond the units on the shelf).
 * extra: per member { ref, text }, a sentence added to their notice (and
 * the ref it is sent under). full: whether nothing is left to claim (the
 * units on the shelf now, when the caller worked them out). Returns the
 * number of reopen notices added.
 */
function reopenNotices(db, bounty, now, { exclude = new Set(), extra = new Map(), full: fullNow = null } = {}) {
  const at = iso(clock(now));
  const stale = [...warnedMembers(db, bounty.id)].filter((m) => !exclude.has(m));
  if (!stale.length) return 0;
  const free = db.prepare(
    `UPDATE notices SET superseded_at = COALESCE(superseded_at, ?), ref = ref || '~' || id
 WHERE bounty_id = ? AND member_id = ? AND kind = 'stop' AND instr(ref, '~') = 0`,
  );
  const shelf = shelfStatus(db, bounty.id);
  const sighting =
    shelf.state === "seen" ? ` The latest stock report saw ${plural(shelf.unitsSeen, "unit")} at ${humanTime(shelf.at)}.` : "";
  const full = fullNow ?? bounty.cap - claimedUnits(db, bounty.id, now).committed <= 0;
  const message = `Open for trips again at ${humanTime(at)}: every check passes now, so the earlier "${TERMS.stop}" notice no longer applies.${sighting}${full ? " Every unit under the cap is claimed, so only members holding a claim can go." : ""} Look at the card before you go: stock may have sold since.`;
  let added = 0;
  for (const memberId of stale) {
    free.run(at, bounty.id, memberId);
    const more = extra.get(memberId);
    added += addNotice(db, {
      bountyId: bounty.id,
      memberId,
      kind: "reopen",
      reason: "reopened",
      ref: more?.ref ?? "reopen:" + at,
      message: more?.text ? `${message} ${more.text}` : message,
      at,
    });
  }
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

/**
 * Why no units are left: a zero cap from the evidence, or a full one. With
 * earlier (capNow's), units earlier bounties for the item still have against
 * its demand are named when they are why the cap is lower (round 5).
 */
const capFullMessage = (bounty, earlier = null) => {
  const owed = earlier?.binding ? earlierNote(earlier) : null;
  if (bounty.cap === 0)
    return owed ? `The distribution cap is 0: ${owed}.` : "The distribution cap is 0: the evidence leaves no units to share.";
  return "The distribution cap for this bounty is fully claimed." + (owed ? ` ${upperFirst(owed)}.` : "");
};

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

// The branch check the figures were costed from (the snapshot's offer is
// dated at its time and carries its shelf price), and the newest later check
// at the bounty's branch that recorded a shelf price: { pricedBy, newer },
// each a check or null.
function branchShelfPrice(db, bounty, o, now) {
  const none = { pricedBy: null, newer: null };
  if (!bounty.barcode || !tableExists(db, "availability_checks")) return none;
  const read = (since, until) =>
    latestCheck(db, bounty.barcode, bounty.retailer, since, { locality: bounty.locality, until, priced: true });
  try {
    const t = typeof o.observed === "string" && o.observed.includes("T") ? Date.parse(o.observed) : NaN;
    const at = Number.isFinite(t) ? read(iso(t), iso(t)) : null;
    const pricedBy = at && Number.isSafeInteger(o.price) && at.price_pence === o.price ? at : null;
    const from = pricedBy ? Date.parse(pricedBy.checked_at) : Date.parse(json(bounty.estimate, null)?.stock?.checkedAt);
    const newer = Number.isFinite(from) ? read(iso(from + 1), iso(clock(now))) : null;
    return { pricedBy, newer };
  } catch {
    return none;
  }
}
/**
 * The offer as the evidence holds it now, for a live bounty: the research
 * row the estimate used, read again, or for an Open Prices offer the newest
 * observation of the same barcode at the same shop as Research reads it
 * (currentShopPrice in estimate.mjs: same OpenStreetMap id, or the same
 * store and place) that is newer than the observation the figures use
 * (R3M3), so a newer, higher price there is "price-rose".
 * Returns null when there is no evidence table to read (the snapshot then
 * stands), or { gone, price, observed, rose, fell, was, sourceId } where
 * was is the price the figures use.
 *
 * Shelf prices on branch checks (round 5): when the figures use the shelf
 * price recorded on a branch check (estimate.mjs priceAtBranch), the price
 * now is the newest later check at the bounty's branch that recorded one,
 * and the offer's own price elsewhere no longer decides. Otherwise a later
 * branch check with a higher shelf price than the figures use is a rise
 * too. A check with no price is never read, so it changes nothing here.
 */
export function offerNow(db, bounty, now = new Date().toISOString()) {
  if (bounty.sample) return null;
  const o = json(bounty.estimate, null)?.offer;
  if (!o?.provider || o.sourceId === undefined || o.sourceId === null) return null;
  const shelf = branchShelfPrice(db, bounty, o, now);
  let row;
  try {
    if (o.provider === "openprices") {
      if (!tableExists(db, "observations") || !/^\d{1,15}$/.test(String(o.sourceId))) return null;
      const shop = currentShopPrice(db, String(o.sourceId), { now: iso(clock(now)) });
      row = shop ? { price: shop.price, observed: shop.observed, sourceId: shop.sourceId } : undefined;
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
  if (!row) return { gone: true, price: null, observed: null, rose: false, fell: false, was, sourceId: null };
  let price = Number.isSafeInteger(row.price) && row.price > 0 ? row.price : null;
  let observed = row.observed ?? null;
  if (price !== null && shelf.pricedBy) {
    // Costed at the branch's shelf price: the newest shelf price there
    // decides, never the offer's price at the shop where it was seen.
    price = shelf.newer ? shelf.newer.price_pence : was;
    observed = shelf.newer ? shelf.newer.checked_at : o.observed;
  } else if (price !== null && shelf.newer && shelf.newer.price_pence > Math.max(price, was ?? 0)) {
    price = shelf.newer.price_pence;
    observed = shelf.newer.checked_at;
  }
  return {
    gone: price === null,
    price,
    observed,
    rose: price !== null && was !== null && price > was,
    fell: price !== null && was !== null && price < was,
    was,
    sourceId: row.sourceId ?? String(o.sourceId),
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
 * How many of the sales the figures rely on are still within the sale
 * window at `now`: { counted, recent, enough, total, recentSales }.
 * counted and recent are independent sellers (the newest sale per seller
 * kept with the evidence) and enough is whether at least
 * ALERT_RULES.minIndependentSales of them are still recent; an older
 * snapshot without sellers falls back to its oldest sale date (enough is
 * false once that sale has aged out). total is the confirmed sales behind
 * the figures and recentSales how many are still recent, from every sale
 * date when the snapshot keeps them, all of them while the oldest is
 * recent (or when no sale date was kept at all), otherwise null (not
 * known). Null when there is no sample.
 */
export function salesNow(bounty, now) {
  if (bounty.sample) return null;
  const s = json(bounty.estimate, null)?.sample;
  if (!s) return null;
  // Aged as the estimate ages them (round 4, N5): a calendar date in UK
  // days. An older snapshot stored a calendar date as midnight UTC, which is
  // read back as that date (never younger than the estimate counts it).
  const recentEnough = (d) => {
    const legacy = typeof d === "string" ? /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z$/.exec(d) : null;
    const age = ageDays(legacy ? legacy[1] : d, now);
    return age !== null && age >= 0 && age <= ALERT_RULES.maxSaleAgeDays;
  };
  const total = isCount(s.count) ? s.count : null;
  let recentSales = null;
  if (total === 0) recentSales = 0;
  else if (total !== null && Array.isArray(s.dates) && s.dates.length === total) recentSales = s.dates.filter(recentEnough).length;
  // Otherwise the oldest sale decides: all of them are recent while it is,
  // and with no sale date kept at all (an older snapshot) nothing is known
  // to have aged, as for enough below.
  else if (total !== null && (!s.oldest || recentEnough(s.oldest))) recentSales = total;
  const counts = { total, recentSales };
  if (Array.isArray(s.sellers)) {
    const recent = s.sellers.filter(recentEnough).length;
    return { counted: s.sellers.length, recent, enough: recent >= ALERT_RULES.minIndependentSales, ...counts };
  }
  if (s.oldest && !recentEnough(s.oldest)) return { counted: null, recent: null, enough: false, ...counts };
  return { counted: null, recent: null, enough: true, ...counts };
}

// How long a lookup that found no competing listings counts when its source
// has no time to live of its own (the eBay Browse lookup's).
const DEFAULT_LOOKUP_HOURS = 6;

/**
 * Whether the competing-listings count behind a live bounty's cap still
 * holds at `now` (R3M6, R3Q3). The count the cap uses is from the latest
 * re-check (its cap basis). A count of 0 rests on an asking-price lookup
 * that found none, which counts only for that lookup's time to live (6
 * hours for eBay Browse, as the estimate's lookup cache uses it), the same
 * rule a re-check applies. A count above 0 rests on listings seen in the
 * last ALERT_RULES.maxOfferAgeDays (7) days, the window the estimate counts
 * listings in, so it lapses 7 days after the newest listing or lookup.
 * Returns null for a sample, else { known, lapsed, listings, relies,
 * checkedAt, until, text, headline }: listings is null when not known now.
 */
export function competitionNow(bounty, now) {
  if (bounty.sample) return null;
  const snapshot = json(bounty.estimate, null) ?? {};
  const stored = json(bounty.cap_basis, null);
  const base = isObject(stored?.live?.base) ? stored.live.base : stored;
  const listings = base?.evidence?.competingListings ?? base?.used?.competingListings;
  const out = { known: false, lapsed: false, listings: null, relies: null, checkedAt: null, until: null, text: null, headline: null };
  if (!isCount(listings)) return out;
  const at = clock(now);
  if (listings === 0) {
    const lookup = base?.evidence?.askingLookup ?? snapshot.askingLookup ?? null;
    const fetched = Date.parse(lookup?.fetched);
    const hours = lookupSource(lookup?.provider)?.ttlHours ?? DEFAULT_LOOKUP_HOURS;
    const until = Number.isFinite(fetched) ? fetched + hours * HOUR : NaN;
    const lapsed = !(Number.isFinite(until) && at < until && at >= fetched);
    const name = lookupSource(lookup?.provider)?.name ?? "asking-price";
    return {
      known: !lapsed,
      lapsed,
      listings: lapsed ? null : 0,
      relies: "lookup",
      checkedAt: Number.isFinite(fetched) ? iso(fetched) : null,
      until: Number.isFinite(until) ? iso(until) : null,
      text: lapsed
        ? Number.isFinite(fetched)
          ? `Competing listings were last checked more than ${plural(hours, "hour")} ago (${name} lookup, ${humanTime(fetched)}, found none), so competition is not known now: the asking-price lookup must be run again before anyone travels`
          : "No dated asking-price lookup backs the count of no competing listings, so competition is not known: run the asking-price lookup again before anyone travels"
        : null,
      headline: lapsed ? `competing listings were last checked more than ${plural(hours, "hour")} ago, so competition is not known now` : null,
    };
  }
  // Current means at most 7 x 24 hours elapsed, the rule matching.competition
  // counts listings by (round 4, N4), never 7 whole days rounded down. A
  // listing dated after the re-check that counted it is taken as seen at the
  // re-check, so it never holds longer than the estimate would keep it.
  let checked = Date.parse(snapshot.competition?.checkedAt ?? snapshot.checkedAt);
  const recheckedAt = Date.parse(snapshot.checkedAt);
  if (Number.isFinite(checked) && Number.isFinite(recheckedAt) && checked > recheckedAt) checked = recheckedAt;
  const days = ALERT_RULES.maxOfferAgeDays;
  const lapsed = !(Number.isFinite(checked) && checked <= at && at - checked <= days * DAY);
  return {
    known: !lapsed,
    lapsed,
    listings: lapsed ? null : listings,
    relies: "listings",
    checkedAt: Number.isFinite(checked) ? iso(checked) : null,
    until: Number.isFinite(checked) ? iso(checked + days * DAY) : null,
    text: lapsed
      ? `The latest asking-price check (${Number.isFinite(checked) ? humanDate(checked) : "date unknown"}) is more than ${plural(days, "day")} old, so the ${plural(listings, "competing listing")} behind the cap may have changed and competition is not known now: run an asking-price lookup again before anyone travels`
      : null,
    headline: lapsed ? `the latest asking-price check is more than ${plural(days, "day")} old, so competition is not known now` : null,
  };
}

/**
 * The resale demand the sales behind the figures support at `now`, once
 * some of them have aged out of the sale window: { units, rate,
 * recentSales, total, competing, weeks } with units null when it cannot be
 * worked out (sale dates not on record, or competition not known). Null
 * while every sale is still recent (nothing has changed since the re-check).
 * Uses the evidenced rate and the buy-alert gate's sell window, as the gate
 * does.
 */
function demandNow(bounty, live) {
  const s = live?.sales;
  if (!s || s.total === null || s.total === 0 || (s.recentSales !== null && s.recentSales >= s.total)) return null;
  const weeks = OPPORTUNITY_RULES.sellWindowWeeks;
  const competing = live.competition?.known ? live.competition.listings : null;
  const rate = s.recentSales === null ? null : evidencedSalesPerWeek(s.recentSales);
  const units = rate === null ? null : liveDemandUnits({ salesPerWeek: rate, competingListings: competing }, weeks);
  return { units, rate: rate === null ? null : round2(rate), recentSales: s.recentSales, total: s.total, competing, weeks };
}

/**
 * The evidence for a live bounty as it stands at `now`, read again: the
 * newest branch check, the offer price, the sales behind the figures and
 * whether the competing-listings count still holds.
 */
export function liveEvidence(db, bounty, now) {
  if (bounty.sample) return { check: null, offer: null, sales: null, competition: null };
  return {
    check: newerCheck(db, bounty, now),
    offer: offerNow(db, bounty, now),
    sales: salesNow(bounty, now),
    competition: competitionNow(bounty, now),
  };
}

/**
 * The verified stock report a branch check at `checkedAt` came from (the
 * operator verified a member's report and it became the check), or null.
 */
function reportBehind(db, bounty, checkedAt) {
  if (!checkedAt) return null;
  return (
    db
      .prepare("SELECT id, units_seen, observed_at FROM stock_reports WHERE bounty_id = ? AND verified = 'accurate' AND observed_at = ? LIMIT 1")
      .get(bounty.id, checkedAt) ?? null
  );
}

/**
 * The newest count of the shelf for a live bounty: the stock check behind
 * the figures, a newer branch check (live.check) or the latest stock report
 * that was not marked inaccurate, whichever is newest (a report wins a tie
 * with a check). { units, source, at, newer } where units is the count seen
 * (0 for none, null when the check recorded no count), source "stock
 * check" (a branch check) or "stock report" (a member's report, or a branch
 * check made from a verified one), and newer whether it came after the
 * figures' own check. Null when nothing was ever counted.
 */
/** The evidence behind a shelf count in words: "branch check" or "stock report". */
const checkWord = (source) => (source === "stock report" ? "stock report" : "branch check");

function shelfCount(db, bounty, live, report = latestReport(db, bounty.id)) {
  const stock = (json(bounty.estimate, null) ?? {}).stock;
  const checkAt = Date.parse(stock?.checkedAt);
  const found = [];
  if (Number.isFinite(checkAt))
    found.push({
      ms: checkAt,
      at: iso(checkAt),
      source: reportBehind(db, bounty, iso(checkAt)) || reportBehind(db, bounty, stock.checkedAt) ? "stock report" : "stock check",
      newer: false,
      units:
        stock.availability === "out_of_stock"
          ? 0
          : stock.availability === "in_stock" && Number.isSafeInteger(stock.unitsSeen) && stock.unitsSeen > 0
            ? stock.unitsSeen
            : null,
    });
  const c = live?.check;
  if (c && Number.isFinite(Date.parse(c.checked_at)))
    found.push({
      ms: Date.parse(c.checked_at),
      at: c.checked_at,
      source: reportBehind(db, bounty, c.checked_at) ? "stock report" : "stock check",
      newer: true,
      units: c.in_stock !== 1 ? 0 : Number.isSafeInteger(c.units_seen) && c.units_seen > 0 ? c.units_seen : null,
    });
  if (report && Number.isFinite(Date.parse(report.observed_at))) {
    const ms = Date.parse(report.observed_at);
    found.push({ ms: ms + 0.5, at: report.observed_at, source: "stock report", newer: !Number.isFinite(checkAt) || ms > checkAt, units: report.units_seen });
  }
  if (!found.length) return null;
  const newest = found.sort((a, b) => b.ms - a.ms)[0];
  return { units: newest.units, source: newest.source, at: newest.at, newer: newest.newer };
}

/**
 * The distribution cap for a live bounty at `now`: the cap from the latest
 * re-check, lowered (never raised) by evidence that changed since: a newer
 * count of the shelf with fewer units, sales that aged out of the sale
 * window (the sales rate counts only the recent ones), a competing-listings
 * count that lapsed (competition unknown, so 0), and the one sell window.
 * Returns { cap, changed, basis, notes, demand }: basis is the cap basis to
 * show, with live { base, at, notes } kept beside the re-check's own figures
 * so a later read can work the cap out again from them; changed says
 * whether it differs from what is stored. demand is the cap before any
 * shelf limit (capBasis's demand, lowered by sales and competition now).
 * A newer shelf count lowers the units to share to that count plus the
 * units bought through the bounty before it (round 4, N3).
 *
 * Round 5: the units earlier bounties for the item still have against its
 * demand (earlierAllocation, returned as earlier) are read now and come off
 * the demand like competing listings, so the cap and demand fall while they
 * are outstanding and rise again, up to the re-check's own figures, once
 * they are released.
 */
export function capNow(db, bounty, now, live = liveEvidence(db, bounty, now)) {
  const stored = json(bounty.cap_basis, null);
  const base = isObject(stored?.live?.base) ? stored.live.base : stored;
  if (bounty.sample || !isObject(base?.used))
    return { cap: bounty.cap, changed: false, basis: stored, notes: [], demand: bounty.cap, earlier: null };
  // Units earlier bounties for the item still have against its demand, read
  // now (round 5). The re-check's own cap and demand are worked out again
  // without the units it counted, so a release recorded since raises the
  // cap back and units still outstanding keep it down.
  const earlier = earlierAllocation(db, bounty, now);
  const baseEarlier = isCount(base.used.earlierUnits) ? base.used.earlierUnits : 0;
  // Members' own listings among the competing listings the re-check counted,
  // matched now (round 5b): a seller name added, or units bought or released
  // since, change how many count once.
  const baseOwn = isCount(base.used.ownListings) ? base.used.ownListings : 0;
  const bySeller = Array.isArray(base.evidence?.listingsBySeller) ? base.evidence.listingsBySeller : null;
  const owners = listingOwners(db, bounty, now);
  const own = ownListings(bySeller, owners, base.used.competingListings);
  const cross = baseEarlier > 0 || baseOwn > 0 || own.units > 0;
  const evidenceOnly = { ...base.used, earlierUnits: 0, ownListings: own.units };
  const baseCap = cross ? distributionCap(evidenceOnly) : Number.isSafeInteger(base.cap) ? base.cap : bounty.cap;
  const used = { ...base.used, earlierUnits: earlier.units, ownListings: own.units };
  const notes = [];
  const drop = [];
  const days = BOUNTY_RULES.saleWindowDays;
  const gate = OPPORTUNITY_RULES.sellWindowWeeks;
  if (isPositive(used.sellWindowWeeks) && used.sellWindowWeeks > gate) {
    used.sellWindowWeeks = gate;
    notes.push(`Sell window limited to ${plural(gate, "week")}, the window the buy-alert checks use`);
  }
  const count = shelfCount(db, bounty, live);
  // An empty shelf stops the trip on its own (blockerList); only a positive
  // or unknown newer count changes the cap.
  if (count?.newer && count.units !== 0) {
    if (count.units === null) {
      if (used.availableUnits !== null) {
        used.availableUnits = null;
        drop.push(/^Units to share/);
        notes.push(
          `The latest ${checkWord(count.source)} (${humanTime(count.at)}) recorded no unit count, so units on the shelf are unknown and the cap is 0`,
        );
      }
    } else {
      // Units bought through this bounty before the count are off the shelf
      // it saw but still held against the cap (completed claims), so the
      // units shared in all are the count plus them (round 4, N3).
      const before = db
        .prepare("SELECT COALESCE(SUM(units), 0) AS n FROM claims WHERE bounty_id = ? AND status = 'completed' AND ended_at <= ?")
        .get(bounty.id, count.at).n;
      const total = count.units + before;
      if (!isCount(used.availableUnits) || total < used.availableUnits) {
        used.availableUnits = total;
        drop.push(/^Units to share/);
        const since = boughtAtBranch(db, bounty, count.at);
        const left = Math.max(0, count.units - since);
        notes.push(
          `Units to share lowered to ${total}: the latest ${checkWord(count.source)} (${humanTime(count.at)}) saw ${plural(count.units, "unit")}` +
            (before > 0 ? `, after members had bought ${plural(before, "unit")} through this bounty` : "") +
            (since > 0
              ? `, and members have bought ${plural(since, "unit")} since, so ${left === 0 ? "none are" : `about ${plural(left, "unit")} ${left === 1 ? "is" : "are"}`} likely left on the shelf`
              : ""),
        );
      }
    }
  }
  const s = live?.sales;
  if (s && s.total !== null && s.total > 0 && (s.recentSales === null || s.recentSales < s.total)) {
    drop.push(/^Sales a week lowered/);
    if (s.recentSales === null) {
      used.salesPerWeek = null;
      notes.push(
        `Some of the ${plural(s.total, "confirmed sale")} behind the figures are now more than ${days} days old and their dates are not on record, so the sales rate is not known and the cap is 0`,
      );
    } else {
      const entered = enteredOf(bounty)?.salesPerWeek;
      const evidenced = evidencedSalesPerWeek(s.recentSales);
      const rate = isPositive(entered) ? Math.min(entered, evidenced) : evidenced;
      if (!isPositive(used.salesPerWeek) || rate < used.salesPerWeek) used.salesPerWeek = round2(rate);
      notes.push(
        `Sales a week lowered to ${round2(rate)}: only ${s.recentSales} of the ${plural(s.total, "confirmed sale")} behind the figures ${s.recentSales === 1 ? "is" : "are"} still from the last ${days} days`,
      );
    }
  }
  const c = live?.competition;
  if (c?.lapsed) {
    used.competingListings = null;
    drop.push(/^An asking-price lookup/);
    notes.push(`${c.text}. The cap is 0 until then`);
  }
  // The cap before any shelf limit (round 4, N3), lowered only by demand
  // that changed since the re-check (sales, competition, the sell window).
  const limit = isCount(base.entered?.availableUnits) ? base.entered.availableUnits : null;
  const baseDemand =
    cross ? demandCap(evidenceOnly, limit) : isCount(base.demand) ? base.demand : demandCap(base.used, limit);
  // The earlier bounties' units as they stand now replace the re-check's note.
  const earlierText = earlierNote(earlier);
  if (earlierText || baseEarlier !== earlier.units) drop.push(/earlier bount/);
  if (earlierText) notes.push(earlierText);
  // So do the members' own listings and who gave no seller name (round 5b).
  const ownText = ownListingsNote(own, used.competingListings);
  const unnamedText = unnamedSellerNote(own);
  const baseNotes = Array.isArray(base.notes) ? base.notes : [];
  if (ownText || unnamedText || baseOwn !== own.units || baseNotes.some((n) => OWN_NOTE.test(n))) drop.push(OWN_NOTE);
  if (ownText) notes.push(ownText);
  if (unnamedText) notes.push(unnamedText);
  if (!notes.length && baseEarlier === earlier.units && baseOwn === own.units) {
    const back = baseCap !== bounty.cap || stored !== base;
    return { cap: baseCap, changed: back, basis: base, notes, demand: baseDemand, earlier: { ...earlier, capWithout: baseCap, binding: false } };
  }
  const cap = Math.min(baseCap, distributionCap(used));
  const demand = Math.min(baseDemand, demandCap(used, limit));
  // What the cap would be without the earlier bounties' units, so messages
  // say when those units are why the cap is lower.
  // Without them their owners' listings would count as competing listings
  // (only units bought through this bounty would still be matched).
  const ownHere = ownListings(
    bySeller,
    owners.map((o) => ({ ...o, claims: o.claims.filter((c) => c.bountyId === bounty.id) })).filter((o) => o.claims.length),
    used.competingListings,
  );
  earlier.capWithout = Math.min(baseCap, distributionCap({ ...used, earlierUnits: 0, ownListings: ownHere.units }));
  earlier.binding = earlier.capWithout > cap;
  const basis = {
    ...base,
    used,
    cap,
    demand,
    notes: [...(Array.isArray(base.notes) ? base.notes : []).filter((n) => !drop.some((re) => re.test(n))), ...notes],
    live: { base, at: stored?.live?.at && sameNotes(stored.live.notes, notes) ? stored.live.at : iso(clock(now)), notes },
  };
  const changed = cap !== bounty.cap || !sameNotes(stored?.live?.notes, notes);
  return { cap, changed, basis, notes, demand, earlier };
}

const sameNotes = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// The cap notes about members' own listings (ownListingsNote, unnamedSellerNote).
const OWN_NOTE = /counted once, not again as competing listings|given no marketplace seller name|operator has not yet confirmed|already selling this item before/;

/** Puts capNow's result on a bounty row in memory, so the rest of a read uses it. */
function applyCap(bounty, result) {
  bounty.cap = result.cap;
  bounty.cap_basis = result.basis ? JSON.stringify(result.basis) : bounty.cap_basis;
  const used = result.basis?.used;
  if (isObject(used)) {
    bounty.available_units = isCount(used.availableUnits) ? used.availableUnits : 0;
    bounty.competing_listings = isCount(used.competingListings) ? used.competingListings : null;
  }
  return bounty;
}

/**
 * Who among a live bounty's claim holders can still be served by the units
 * left (R3M5): active claims in claim order (the earliest keep theirs) are
 * kept while their units fit in the room. The first claim that does not fit
 * and every later one are beyond it. Returns { room, active, over, kept:
 * Map, beyond: Map } keyed by member id, each { claim, before, ref,
 * message }, plus phrase (why the room is what it is) and headline (the
 * bounty-level "Don't make the trip" line while it is over-claimed).
 *
 * The limits are kept apart (round 4, N3), so a unit is never taken off
 * twice: the room is the smallest of the demand room (the cap before any
 * shelf limit, capNow's demand, less every unit bought), the cap room (the
 * cap now less every unit bought: the cap counts the units bought before
 * its shelf count, so this is the units on that count less units bought
 * since) and the shelf room (the newest count less units bought since,
 * shelfUnitsNow; 0 when the units on the shelf are not known).
 */
function claimSeats(db, bounty, now, live, cap = capNow(db, bounty, now, live)) {
  const at = iso(clock(now));
  const claims = db
    .prepare(
      "SELECT id, member_id, units, created FROM claims WHERE bounty_id = ? AND status = 'active' AND expires_at > ? ORDER BY created, id",
    )
    .all(bounty.id, at)
    .map(plain);
  const held = claimedUnits(db, bounty.id, now);
  const snapshot = json(bounty.estimate, null);
  const shelf = shelfUnitsNow(db, bounty, snapshot, cap.basis, latestReport(db, bounty.id), live);
  const demand = isCount(cap.demand) ? cap.demand : cap.cap;
  const evidenceRoom = Math.max(0, Math.min(demand, cap.cap) - held.completed);
  const shelfRoom = isCount(shelf.units) ? shelf.units : 0;
  const byShelf = isCount(shelf.units) && shelfRoom <= evidenceRoom;
  const room = Math.min(evidenceRoom, shelfRoom);
  const when = shelf.at ? ` (latest ${checkWord(shelf.source)}, ${humanTime(shelf.at)}${shelf.boughtSince ? `, less ${plural(shelf.boughtSince, "unit")} members bought since` : ""})` : "";
  // Units earlier bounties for the item still have against its demand, when
  // they are why the evidence leaves less (round 5).
  const owed = cap.earlier?.binding
    ? `, after ${plural(cap.earlier.units, "unit")} from ${earlierWhere(new Set([...(cap.earlier.bounties ?? []), ...(cap.earlier.heldOn ?? [])]).size)} for this item that still count against the demand for it`
    : "";
  const phrase = byShelf
    ? room === 0
      ? `no units are left on the shelf${when}`
      : `only ${plural(room, "unit")} ${room === 1 ? "is" : "are"} on the shelf${when}`
    : shelf.units === null && shelf.at
      ? `the latest ${checkWord(shelf.source)} (${humanTime(shelf.at)}) recorded no unit count, so the units on the shelf are not known`
      : room === 0
        ? `the evidence now leaves no units to share${owed}`
        : `the evidence now supports only ${plural(room, "unit")} for this bounty${owed}`;
  const kept = new Map();
  const beyond = new Map();
  let used = 0;
  let full = false;
  for (const c of claims) {
    if (!full && used + c.units <= room) {
      kept.set(c.member_id, { claim: c, before: used });
      used += c.units;
      continue;
    }
    full = true;
    const before = used;
    // Never "the first 0 units": with no room, no claim can be met.
    const message =
      room === 0
        ? `${TERMS.stop}: ${phrase}. No claim held now can be met, yours included: release your claim`
        : before < room && before + c.units > room
          ? `${TERMS.stop}: ${phrase}, and members who claimed before you hold ${before === 0 ? "none" : before} of them, so your claim for ${plural(c.units, "unit")} cannot be met in full. Release it and claim again for what is left if your own figures still pass`
          : `${TERMS.stop}: ${phrase} and members have claimed ${plural(held.active, "unit")}. Yours is not one of the first ${plural(room, "unit")} claimed`;
    beyond.set(c.member_id, { claim: c, before, ref: `over:${c.id}:${room}:${shelf.at ?? "none"}`, message });
  }
  const over = beyond.size > 0;
  const lead = phrase.charAt(0).toUpperCase() + phrase.slice(1);
  for (const [memberId, k] of kept)
    kept.set(memberId, {
      ...k,
      ref: `shelf:${k.claim.id}:${room}:${shelf.at ?? "none"}`,
      message: `${lead} and members have claimed ${plural(held.active, "unit")}. Yours is among the first ${plural(room, "unit")} claimed, so it stands. Look at the card before you go: stock may sell.`,
    });
  return {
    room,
    active: held.active,
    over,
    kept,
    beyond,
    phrase,
    headline: over
      ? `${TERMS.stop}: ${phrase} and members have claimed ${plural(held.active, "unit")}, ${
          kept.size
            ? "so only the members who claimed first can go"
            : room === 0
              ? "so no claim held now can be met"
              : byShelf
                ? "more than the shelf holds, so no claim held now can be met"
                : "more than is left to share, so no claim held now can be met"
        }`
      : null,
  };
}

/**
 * Members whose own figures failed when their claim was last checked again
 * (refreshBounty stores the re-run on the claim): Map member id ->
 * { claim, ref, message }. Their trip stays stopped until a re-check passes.
 */
function ownFigureFailures(db, bounty, now) {
  const rows = db
    .prepare("SELECT * FROM claims WHERE bounty_id = ? AND status = 'active' AND expires_at > ? ORDER BY created, id")
    .all(bounty.id, iso(clock(now)))
    .map(plain);
  const out = new Map();
  for (const c of rows) {
    const f = json(c.figures, null);
    if (!isObject(f) || f.ok !== false) continue;
    // Only values the member has not given are missing (round 5b): ask for
    // them, and never say the figures failed.
    const asked = confirmAsk(c, f);
    if (asked) {
      out.set(c.member_id, asked);
      continue;
    }
    const reasons = Array.isArray(f.reasons) && f.reasons.length ? f.reasons.join("; ") : "they could not be worked out again";
    const price = Number.isSafeInteger(f.unitCost) ? `at ${pounds(f.unitCost)} a unit ` : "";
    const journey =
      Number.isSafeInteger(c.journey_cost) && Number.isSafeInteger(c.journey_minutes)
        ? ` with your journey (${pounds(c.journey_cost)}, ${plural(c.journey_minutes, "minute")})`
        : "";
    const profit =
      Number.isSafeInteger(f.unitProfit) && !f.outOfDate
        ? f.unitProfit < 0
          ? ` (a loss of ${pounds(-f.unitProfit)} a unit)`
          : ` (profit per unit ${pounds(f.unitProfit)})`
        : "";
    out.set(c.member_id, {
      claim: c,
      // One notice per claim and failure: the same reasons at the same price
      // on a later re-check do not notify again.
      ref: `own:${c.id}:${createHash("sha256").update(JSON.stringify([f.unitCost ?? null, f.reasons ?? null])).digest("hex").slice(0, 12)}`,
      message: `${TERMS.stop}: your own figures for ${plural(c.units, "unit")}${journey}, worked out again ${price}on the latest evidence (${humanTime(f.checkedAt)}), now fail${profit}: ${reasons}`,
    });
  }
  return out;
}

/** The cash stored with a claim's terms (pence), or null when it stores none. */
function claimCash(c) {
  const terms = json(c?.terms, null);
  return isObject(terms) && Number.isSafeInteger(terms.cashAvailable) && terms.cashAvailable >= 0 ? terms.cashAvailable : null;
}

const CONFIRM_FIELDS = Object.freeze(["transport", "carryKg", "storageUnits", "cashAvailable"]);
const CONFIRM_WORDS = Object.freeze({ transport: "transport", carryKg: "carrying limit", storageUnits: "storage at home" });
// The same values, short, for the badge: "Confirm your storage and cash".
const CONFIRM_LABELS = Object.freeze({ transport: "transport", carryKg: "carrying limit", storageUnits: "storage", cashAvailable: "cash" });
const listAnd = (items) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/**
 * The "confirm" entry for a claim whose last re-check failed only on values
 * the member has not given (memberTripCheck confirm, round 5b), or null.
 * A claim made before the cash was asked for stores none, so the re-check
 * asks for it: through "Check my figures" under the claim, never as figures
 * that failed. { claim, ref, message, reason, confirm }: reason
 * "cash-unknown" when only the cash is missing, otherwise
 * "profile-unknown". One notice per claim and set of missing values.
 */
function confirmAsk(c, f) {
  const fields = Array.isArray(f?.confirm) ? CONFIRM_FIELDS.filter((k) => f.confirm.includes(k)) : [];
  if (!fields.length) return null;
  const cash = fields.includes("cashAvailable");
  const profile = fields.filter((k) => k !== "cashAvailable").map((k) => CONFIRM_WORDS[k]);
  const what = [profile.length ? `your ${listAnd(profile)} in your member profile` : "", cash ? "the cash you can spend on this trip" : ""]
    .filter(Boolean)
    .join(" and ");
  // Saving the profile checks the claim again (PATCH /api/members/:id), as
  // does saving the cash under the claim, in either order (round 5b).
  const how = cash
    ? `Your claim stores no cash figure (it was made before the cash was asked for), and a blank is never counted as zero or as enough: enter the cash under your claim and choose Save cash and check my figures${
        profile.length ? ", and save the rest in your member profile" : ""
      }`
    : "A blank is never counted as zero or as enough: save them in your member profile and your claim is checked again at once";
  return {
    claim: c,
    ref: `confirm:${c.id}:${fields.join(",")}`,
    reason: cash && !profile.length ? "cash-unknown" : "profile-unknown",
    confirm: fields,
    // The badge names only what is still missing (never "and cash" once the
    // cash is stored).
    label: `Confirm your ${listAnd(fields.map((k) => CONFIRM_LABELS[k]))}`,
    message: `${TERMS.stop} yet: confirm ${what}. ${how}. Every other check on your figures for ${plural(c.units, "unit")} passed on the latest evidence (${humanTime(f.checkedAt)})`,
  };
}

/**
 * Claim holders the bounty's promotion price is no longer for (round 4,
 * N2): their standing is declined (promotionStanding: they bought at a
 * first-order price at this retailer, said they already used such an
 * offer, or said they do not qualify) while their claim is live. Map member
 * id -> { claim, ref, message }. Their trip stays stopped: the figures their
 * claim rests on use a price that is not available to them.
 */
function declinedHolders(db, bounty, now) {
  const out = new Map();
  if (bounty.sample || !promotionOf(bounty)?.needsMemberConfirmation) return out;
  const rows = db
    .prepare("SELECT id, member_id, units FROM claims WHERE bounty_id = ? AND status = 'active' AND expires_at > ? ORDER BY created, id")
    .all(bounty.id, iso(clock(now)))
    .map(plain);
  for (const c of rows) {
    const member = getMember(db, c.member_id);
    const standing = member ? promotionStanding(db, bounty, member) : null;
    if (!standing?.declined) continue;
    const why = standing.usedBy === "purchase"
      ? `you have already used the first-order offer at ${standing.retailer}, so this price is not available to you (you marked a claim at a first-order price there as bought on ${humanDate(standing.usedOn)}): release this claim`
      : standing.usedHere
        ? `you said you have already used a first-order offer at ${standing.retailer}, so this price is not available to you: release this claim, or choose "I answered by mistake" if that was wrong`
        : `you said you do not qualify for this price ("${standing.condition}"), so it is not available to you: release this claim, or choose "I answered by mistake" if that was wrong`;
    out.set(c.member_id, {
      claim: c,
      // One notice per claim and reason.
      ref: `declined:${c.id}:${standing.usedBy ?? standing.answer ?? "declined"}`,
      message: `${TERMS.stop}: ${why}`,
    });
  }
  return out;
}

const SAMPLE_BLOCKER = "Sample bounty: illustrative figures only, so there is nothing to claim, buy or alert";

// ------------------------------------------- the member's own fit (round 5)

/** The units a bounty's figures are for, or null when it has none. */
function figureUnits(bounty) {
  const snapshot = json(bounty.estimate, null);
  const units = snapshot?.economics?.units ?? snapshot?.units?.figures;
  return Number.isSafeInteger(units) && units >= 1 ? units : null;
}

/**
 * Whether a bounty's trip fits a member's stored profile for `units`
 * (round 5, finding 4): one unit and every unit within their load limit
 * and the units within their storage. The cash they can spend is asked
 * with each claim, so it is not checked here. Returns the suitability.mjs
 * result plus { units, complete, partial, figures }: complete is false while
 * a profile value is not known; partial is true when fewer units fit than
 * asked but at least one does. room is homeStock: units they already have
 * at home from bounties and units in their other live claims, which take up
 * storage room (round 5b).
 */
export function bountyFit(bounty, member, units, room = {}) {
  const o = json(bounty.opportunity, null) ?? {};
  const n = Number.isSafeInteger(units) && units >= 1 ? units : 1;
  const fit = tripSuitability({ units: n, unitKg: o.weightKg ?? null, profile: memberTripProfile(member, null, room), cash: false });
  const most = fit.maxUnits.all;
  return {
    ...fit,
    units: n,
    complete: fit.missing.length === 0,
    partial: !fit.ok && Number.isSafeInteger(most) && most >= 1 && most < n,
    figures: figureUnits(bounty),
  };
}

/**
 * The units a member would take on a bounty, for their fit: their live
 * claim's units, otherwise the units the figures are for, no more than
 * their trial allowance (at least 1).
 */
function offeredUnits(db, bounty, member, now) {
  const active = db
    .prepare("SELECT units FROM claims WHERE bounty_id = ? AND member_id = ? AND status = 'active' AND expires_at > ? ORDER BY id DESC LIMIT 1")
    .get(bounty.id, member.id, iso(clock(now)));
  if (active && Number.isSafeInteger(active.units)) return { units: active.units, holding: true };
  const figures = figureUnits(bounty) ?? 1;
  const allowance = bounty.sample ? figures : trialAllowance(db, bounty, member, now).allowance;
  return { units: Math.max(1, Math.min(figures, allowance > 0 ? allowance : figures)), holding: false };
}

/**
 * A member's fit as a trip state, or null when the trip fits them: state
 * "confirm-profile" while their profile is not complete (never go), or
 * "does-not-fit" (go false) with what does not fit and, when fewer units
 * would, how many.
 */
function fitTripState(db, bounty, memberId, now) {
  const member = getMember(db, memberId);
  if (!member || bounty.sample) return null;
  const { units, holding } = offeredUnits(db, bounty, member, now);
  const fit = bountyFit(bounty, member, units, roomFor(db, bounty, member.id, now));
  if (fit.ok) return null;
  if (!fit.complete)
    return {
      state: "confirm-profile",
      go: false,
      // Names only what is still missing (round 5b).
      label: `Confirm your ${listAnd(MEMBER_PROFILE_FIELDS.filter((k) => fit.missing.includes(k)).map((k) => CONFIRM_LABELS[k]))}`,
      headline: `${TERMS.stop} yet: ${lowerFirst(profileNeeded(fit.missing))}`,
      reason: "profile-unknown",
      fit,
    };
  const most = fit.maxUnits.all;
  return {
    state: "does-not-fit",
    go: false,
    // A partial fit names how many of the units fit (round 5b).
    label: fit.partial ? `${most} of the ${units} units fit you` : "Does not fit your transport or storage",
    headline: fit.partial
      ? `${TERMS.stop} for ${plural(units, "unit")}: ${fit.reasons.join("; ")}. ${
          holding ? `Release your claim and claim ${most} instead, if your own figures pass for ${most}` : `Check your own figures for ${plural(most, "unit")} before you claim`
        }`
      : `${TERMS.stop}: ${fit.reasons.join("; ")}`,
    reason: "does-not-fit",
    fit,
  };
}

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
 * complete, or with fewer passed items than AUDIT_RULES.minPassedToSignOff
 * (default 1), does not count. warning is the one line every card and
 * alert shows: after a sign-off that stands, its result with no caution
 * wording (signedOff.summary, else audit.mjs signOffLine, for example
 * "Pilot audit in Camden signed off on 31 Oct 2026: 12 of 30 items
 * passed."); otherwise the caution. caution says which of the two it is.
 */
export function validationFrom(locality, found) {
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  const target = count(found?.target) ?? AUDIT_TARGET;
  const audited = count(found?.audited) ?? 0;
  const evidenced = count(found?.evidenced) ?? 0;
  const passed = count(found?.passed) ?? 0;
  const complete = found?.complete === true && evidenced >= target;
  const rules = isObject(auditModule.AUDIT_RULES) ? auditModule.AUDIT_RULES : {};
  const minPassed = Number.isSafeInteger(rules.minPassedToSignOff) && rules.minPassedToSignOff >= 0 ? rules.minPassedToSignOff : 1;
  const given = complete && isObject(found?.signedOff) ? found.signedOff : null;
  const signedPassed = count(given?.passed) ?? passed;
  const signedOff = given && signedPassed >= minPassed ? given : null;
  const lapsedReason =
    !signedOff && isObject(found?.signOffLapsed) && typeof found.signOffLapsed.reason === "string" ? found.signOffLapsed.reason : null;
  const signedAt = typeof signedOff?.at === "string" ? signedOff.at : typeof signedOff?.signedAt === "string" ? signedOff.signedAt : null;
  let line = null;
  if (signedOff) {
    if (typeof signedOff.summary === "string" && signedOff.summary.trim()) line = signedOff.summary.trim();
    else if (typeof auditModule.signOffLine === "function") {
      try {
        line = auditModule.signOffLine(
          { ...signedOff, at: signedAt, passed: signedPassed, evidenced: count(signedOff.evidenced) ?? evidenced },
          locality,
        );
      } catch {
        line = null;
      }
    }
    if (typeof line !== "string" || !line.trim() || /undefined|null|NaN/.test(line))
      line = `Pilot audit in ${locality} signed off${signedAt ? ` on ${humanDate(signedAt)}` : ""}: ${signedPassed} of ${count(signedOff.evidenced) ?? evidenced} items passed.`;
  }
  const caution = complete
    ? `Pilot audit in ${locality}: ${passed} of ${evidenced} items passed, not yet signed off. Treat these figures with care.`
    : `Pilot not validated in ${locality}: ${Math.min(evidenced, target)} of ${target} items checked against stored evidence`;
  const lapse = lapsedReason ? ` ${lapsedReason.replace(/\.?$/, ".")}` : "";
  return {
    locality,
    complete,
    signedOff: Boolean(signedOff),
    signedOffAt: signedAt,
    audited,
    evidenced,
    passed,
    target,
    // Always one line: the sign-off result, or the caution (with why an
    // earlier sign-off no longer stands).
    warning: signedOff ? line : caution + (lapse && !caution.endsWith(".") ? "." : "") + lapse,
    caution: !signedOff,
    // Why an earlier sign-off no longer stands (audit.mjs signOffLapsed), or null.
    signOffLapsed: lapsedReason,
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
  // An empty-shelf report pauses the trip until a branch check after it.
  const shelf = shelfNow(db, bounty, live);
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
  if (oos !== undefined) {
    // A check made from a member's report the operator verified says so (R2Q9).
    const byReport = Boolean(oos && reportBehind(db, bounty, oos));
    add(
      "out-of-stock",
      "empty:" + (oos ?? snapshot.checkedAt),
      byReport
        ? `The operator confirmed a member's stock report of none on the shelf at ${humanTime(oos)}${none ? "" : newer}`
        : `The latest branch check (${humanTime(oos)}) found none on the shelf${none ? "" : newer}`,
      emptyCheckHeadline(db, bounty, oos) + (none ? "" : newer),
    );
    if (byReport) list[list.length - 1].label = "Out of stock at the last stock report";
  }
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
  // The competing-listings count behind the cap has lapsed (R3M6, R3Q3).
  if (bounty.alert_eligible === 1 && live.competition?.lapsed)
    add(
      "competition-lapsed",
      "competition:" + (live.competition.until ?? live.competition.checkedAt ?? snapshot.checkedAt),
      live.competition.text,
      live.competition.headline,
    );
  // Sales that aged out of the window no longer support the units the
  // figures are for.
  const demand = bounty.alert_eligible === 1 && !live.competition?.lapsed ? demandNow(bounty, live) : null;
  const figureUnits = Number.isSafeInteger(snapshot.economics?.units) ? snapshot.economics.units : snapshot.units?.figures;
  if (demand && (demand.units === null || (Number.isSafeInteger(figureUnits) && demand.units < figureUnits)))
    add(
      "demand-aged",
      `demand:${demand.recentSales ?? "unknown"}:${snapshot.checkedAt}`,
      demand.units === null
        ? `Some of the ${plural(demand.total, "confirmed sale")} behind the figures are now more than ${ALERT_RULES.maxSaleAgeDays} days old and their dates are not on record, so the sales rate now is not known: the sales evidence must be checked again before anyone travels`
        : `Only ${demand.recentSales} of the ${plural(demand.total, "confirmed sale")} behind the figures ${demand.recentSales === 1 ? "is" : "are"} still from the last ${ALERT_RULES.maxSaleAgeDays} days, so sales now support about ${plural(demand.units, "unit")} within ${plural(demand.weeks, "week")}, fewer than the ${plural(figureUnits, "unit")} the figures are for`,
      demand.units === null
        ? `the sales rate behind the figures is no longer known: some sales are now more than ${ALERT_RULES.maxSaleAgeDays} days old`
        : `sales from the last ${ALERT_RULES.maxSaleAgeDays} days now support about ${plural(demand.units, "unit")}, fewer than the ${plural(figureUnits, "unit")} the figures are for`,
    );
  if (bounty.alert_eligible === 1 && !displayStatus(db, bounty).permitted)
    add("display", "display", "The source no longer permits display of this offer");
  if (bounty.alert_eligible !== 1)
    add(
      "ineligible",
      "ineligible:" + (bounty.checked_at ?? snapshot.checkedAt),
      (shelfLimitNote(db, bounty, snapshot, live) || "The buy-alert checks do not pass: ") + json(bounty.alert_reasons, []).join("; "),
    );
  return list;
}

/**
 * Why a re-check lowered the units below what the operator asked for, when
 * the shelf did it (R3Q2): "The latest branch check (time) saw 1 unit, so
 * at most 1 can be claimed. At 1 unit the buy-alert checks do not pass: "
 * (to lead their reasons), or "" when the shelf is not why.
 */
function shelfLimitNote(db, bounty, snapshot, live) {
  const asked = storedRequest(bounty)?.units;
  const figures = Number.isSafeInteger(snapshot.units?.figures) ? snapshot.units.figures : snapshot.economics?.units;
  if (!(Number.isSafeInteger(asked) && Number.isSafeInteger(figures) && figures < asked)) return "";
  // The shelf is why when the units one member can claim are the units left
  // on it (the newest count less units bought since, round 4 N1).
  const claimable = snapshot.units?.claimable;
  if (Number.isSafeInteger(claimable) && claimable !== figures) return "";
  const shelf = shelfUnitsNow(db, bounty, snapshot, json(bounty.cap_basis, null), latestReport(db, bounty.id), live);
  if (!shelf.at || shelf.units !== figures) return "";
  const seen = shelf.units + (shelf.boughtSince ?? 0);
  const bought = shelf.boughtSince ? `, and members have bought ${plural(shelf.boughtSince, "unit")} since` : "";
  return `The latest ${checkWord(shelf.source)} (${humanTime(shelf.at)}) saw ${plural(seen, "unit")}${bought}, so at most ${figures} can be claimed. At ${plural(figures, "unit")} the buy-alert checks do not pass: `;
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
 * Re-evaluates a live open bounty at `now` against the evidence read again
 * and tells members. The cap is worked out again first (capNow: a newer
 * shelf count, aged sales, a lapsed competition count) and put on `bounty`
 * in memory, so the rest of the read uses it. Then:
 * - when a trip blocker has appeared, everyone alerted or holding a claim
 *   who has no current "Don't make the trip" notice gets one;
 * - otherwise, claim holders beyond the units on the shelf (claimSeats:
 *   the earliest claims keep theirs), holders whose own figures now fail
 *   (ownFigureFailures) and holders the promotion price is no longer for
 *   (declinedHolders, round 4 N2) get a stop notice that says why, members holding a
 *   stop notice are told the trip reopened, and while more is claimed than
 *   the shelf holds the holders who keep their units are told so.
 * Everything is worked out without a transaction; BEGIN IMMEDIATE is taken
 * only to store a changed cap or to add or supersede a notice (R3B2). On a
 * read (options.read, the default) a locked database is waited on briefly
 * and then left: the read returns with the blockers worked out (deferred
 * true) and the notices go out on the next read or re-check. Callers that
 * write anyway pass read: false. Returns { bountyId, stopped, reasons,
 * noticesSent, reopened, deferred, over, headline, room, active, earlier }
 * (earlier: capNow's units from earlier bounties for the item, round 5).
 */
export function syncTrip(db, bounty, now, live = null, { read = true } = {}) {
  const out = {
    bountyId: bounty.id, stopped: false, reasons: [], noticesSent: 0, reopened: 0, deferred: false,
    over: false, headline: null, room: null, active: null, earlier: null,
  };
  if (bounty.sample || bountyStatus(bounty, now) !== "open") return out;
  const evidence = live ?? liveEvidence(db, bounty, now);
  const at = iso(clock(now));
  const cap = capNow(db, bounty, now, evidence);
  applyCap(bounty, cap);
  // Units earlier bounties for the item still have against its demand (round 5).
  out.earlier = cap.earlier;
  const writes = [];
  if (cap.changed)
    writes.push(() =>
      db
        .prepare("UPDATE bounties SET cap = ?, cap_basis = ?, available_units = ?, competing_listings = ? WHERE id = ?")
        .run(bounty.cap, bounty.cap_basis, bounty.available_units, bounty.competing_listings, bounty.id),
    );
  const list = blockerList(db, bounty, now, evidence);
  const sent = (memberId, ref) =>
    db.prepare("SELECT superseded_at FROM notices WHERE bounty_id = ? AND member_id = ? AND ref = ?").get(bounty.id, memberId, ref);
  if (list.length) {
    const first = list[0];
    out.stopped = true;
    out.reasons = list.map((b) => b.text);
    const warned = warnedMembers(db, bounty.id);
    if (noticeTargets(db, bounty.id, at).some((m) => !warned.has(m)))
      writes.push(() => {
        out.noticesSent += notifyStop(db, bounty, {
          reason: first.id,
          ref: first.ref,
          message: `${first.headline}. Claims and alerts for this bounty are paused until it passes every check again.`,
          now,
          onlyUnwarned: true,
        });
      });
  } else {
    const seats = claimSeats(db, bounty, now, evidence, cap);
    const own = ownFigureFailures(db, bounty, now);
    const declined = declinedHolders(db, bounty, now);
    Object.assign(out, { over: seats.over, headline: seats.headline, room: seats.room, active: seats.active });
    // Members who stay stopped, and why: a price that is not for them
    // first, then their own figures, then claims beyond the units left.
    const stops = new Map();
    for (const [memberId, o] of declined) stops.set(memberId, { reason: "promotion-declined", ref: o.ref, message: o.message });
    for (const [memberId, o] of own)
      if (!stops.has(memberId)) stops.set(memberId, { reason: o.reason ?? "own-figures", ref: o.ref, message: o.message });
    for (const [memberId, o] of seats.beyond)
      if (!stops.has(memberId)) stops.set(memberId, { reason: "over-claimed", ref: o.ref, message: o.message });
    for (const [memberId, stop] of stops) {
      const row = sent(memberId, stop.ref);
      if (row && !row.superseded_at) continue;
      writes.push(() => {
        out.noticesSent += addNotice(db, { bountyId: bounty.id, memberId, kind: "stop", ...stop, at, resurface: true });
      });
    }
    const keptText = new Map();
    if (seats.over) for (const [memberId, k] of seats.kept) keptText.set(memberId, { ref: k.ref, text: k.message });
    const warned = warnedMembers(db, bounty.id);
    if ([...warned].some((m) => !stops.has(m)))
      writes.push(() => {
        out.reopened += reopenNotices(db, bounty, now, {
          exclude: new Set(stops.keys()),
          extra: keptText,
          full: seats.room - seats.active <= 0,
        });
      });
    // Holders who keep their units while more is claimed than the shelf
    // holds, and have no stop notice to reopen, are told their claim stands.
    for (const [memberId, k] of keptText) {
      if (warned.has(memberId) || stops.has(memberId) || sent(memberId, k.ref)) continue;
      writes.push(() => {
        addNotice(db, { bountyId: bounty.id, memberId, kind: "reopen", reason: "claim-stands", ref: k.ref, message: k.text, at });
      });
    }
  }
  if (!writes.length) return out;
  const run = () =>
    transaction(db, () => {
      for (const write of writes) write();
    });
  if (!read || db.isTransaction) {
    run();
    return out;
  }
  // Soon after a read found the database locked, later reads (the rest of a
  // list) do not wait again.
  const busy = lockedAt.get(db);
  if (busy !== undefined && Date.now() - busy < READ_RETRY_MS) return Object.assign(out, { deferred: true, noticesSent: 0, reopened: 0 });
  try {
    withShortWait(db, run);
    lockedAt.delete(db);
  } catch (error) {
    if (!isBusy(error)) throw error;
    // Another connection holds the write lock: the read still returns.
    lockedAt.set(db, Date.now());
    Object.assign(out, { deferred: true, noticesSent: 0, reopened: 0 });
  }
  return out;
}

// How long a read waits for another connection's write lock before it
// leaves its notices for the next read, and how long after that reads do
// not try again (milliseconds).
const READ_WAIT_MS = 100;
const READ_RETRY_MS = 500;
const lockedAt = new WeakMap();

/** SQLITE_BUSY or SQLITE_LOCKED from node:sqlite. */
const isBusy = (error) =>
  error?.errcode === 5 || error?.errcode === 6 || /database is locked|SQLITE_BUSY|database table is locked/i.test(String(error?.message ?? ""));

/** Runs fn with a short busy timeout, then puts the connection's own back. */
function withShortWait(db, fn) {
  let before = null;
  try {
    const row = db.prepare("PRAGMA busy_timeout").get();
    before = Number.isSafeInteger(row?.timeout) ? row.timeout : Number(Object.values(row ?? {})[0]);
  } catch {
    before = null;
  }
  db.exec(`PRAGMA busy_timeout = ${READ_WAIT_MS}`);
  try {
    return fn();
  } finally {
    db.exec(`PRAGMA busy_timeout = ${Number.isSafeInteger(before) && before >= 0 ? before : 5000}`);
  }
}

/**
 * The open live bounties for a barcode (any barcode spelling; all of them
 * when none is given), optionally only at one retailer, by id.
 */
function openBountyRows(db, { barcode = null, retailer = null, now } = {}) {
  const at = iso(clock(now));
  const given = barcode !== null && barcode !== undefined && barcode !== "";
  const gtin = given ? normaliseBarcode(barcode) : null;
  if (given && !gtin) return [];
  const shop = typeof retailer === "string" && retailer.trim() ? normaliseLocality(retailer) : null;
  return db
    .prepare(
      `SELECT * FROM bounties WHERE sample = 0 AND status = 'open' AND expires_at > ?${gtin ? " AND barcode = ?" : ""} ORDER BY id`,
    )
    .all(...(gtin ? [at, gtin] : [at]))
    .map(plain)
    .filter((b) => !shop || normaliseLocality(b.retailer) === shop);
}

/** The ids of the open live bounties openBountyRows finds (refreshOpenBounties). */
export const openBountyIds = (db, options = {}) => openBountyRows(db, options).map((b) => b.id);

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
  const out = { checked: 0, bountyIds: [], stopped: [], reopened: [] };
  const rows = openBountyRows(db, { barcode, retailer, now });
  for (const bounty of rows) {
    out.checked++;
    out.bountyIds.push(bounty.id);
    const result = syncTrip(db, bounty, now, null, { read: false });
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

/**
 * True for a new-customer, first-order or welcome offer: usable once per
 * shopper at a retailer ("New customers only", "20% off your first order",
 * "first purchase", "first shop", "Welcome offer", "1st order").
 */
export const isFirstOrderOffer = (condition) =>
  typeof condition === "string" &&
  /\b(new[- ]customers?|new[- ](member|account)s? only|first[- ](ever[- ])?(online[- ])?(order|purchase|shop|shopping|time|delivery|buy)|1st[- ](order|purchase|shop)|welcome[- ](offer|discount|voucher|code|deal)|introductory)\b/i.test(
    condition,
  );

export const ELIGIBILITY_ANSWERS = Object.freeze(["qualifies", "not", "used"]);
// "undo" removes an answer given by mistake, so the question is asked again.
export const ELIGIBILITY_UNDO = "undo";

/**
 * How a member used a first-order offer at a retailer (normalised name):
 * { purchase, at } when they marked a claim at a first-order price there as
 * bought (purchase true, at the time it was marked) or said they had used
 * one (purchase false), or null.
 */
function firstOrderUse(db, memberId, retailer) {
  const row = db
    .prepare(
      `SELECT p.claim_id, p.created, c.ended_at FROM promotion_answers p LEFT JOIN claims c ON c.id = p.claim_id
 WHERE p.member_id = ? AND p.retailer = ? AND p.first_order = 1 AND p.answer = 'used'
 ORDER BY (p.claim_id IS NULL), p.created DESC LIMIT 1`,
    )
    .get(memberId, retailer);
  if (!row) return null;
  return row.claim_id === null ? { purchase: false, at: row.created } : { purchase: true, at: row.ended_at ?? row.created };
}

/**
 * Where a member stands on a bounty's promotion price, or null when the
 * bounty's figures do not depend on one (no promotion, or costed at the
 * known regular price): { condition, firstOrder, retailer, answer,
 * usedHere, usedBy, usedOn, confirmed, declined, canUndo, notForYou,
 * refusal, question }. answer is the member's answer for this bounty
 * ("qualifies", "not", "used") or null; usedHere is true when they used a
 * first-order offer at this retailer (on any bounty): usedBy "purchase"
 * when they marked a claim at such a price as bought (usedOn is when),
 * "answer" when they said so. confirmed is true only when they said they
 * qualify and have not used such an offer here. declined is true when the
 * bounty is not for them (they said "not" or "used", or used the offer
 * here); notForYou says so in plain words, refusal is the claim refusal,
 * and canUndo is false only for a use recorded by a purchase.
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
  const use = firstOrder && member ? firstOrderUse(db, member.id, retailer) : null;
  const usedHere = Boolean(use);
  const declined = usedHere || answer === "not" || answer === "used";
  const shop = bounty.retailer;
  const notForYou = !declined
    ? null
    : use?.purchase
      ? `You bought at the first-order price at ${shop} on ${humanDate(use.at)}, so this offer is not for you`
      : usedHere
        ? `You said you have already used a first-order offer at ${shop}, so this bounty is not for you`
        : `You said you do not qualify for this price ("${promotion.condition}"), so this bounty is not for you`;
  const undo = 'If that was a mistake, choose "I answered by mistake" on the bounty first.';
  const refusal = !declined
    ? null
    : use?.purchase
      ? `You have already used the first-order offer at ${shop}, so this price is not available to you. You marked a claim at this price as bought on ${humanDate(use.at)}.`
      : usedHere
        ? `You have already used the first-order offer at ${shop}, so this price is not available to you. You said you already used a first-order offer at ${shop}. ${undo}`
        : `You said you do not qualify for this price ("${promotion.condition}"), so it is not available to you. ${undo}`;
  return {
    condition: promotion.condition,
    firstOrder,
    retailer: shop,
    answer,
    usedHere,
    usedBy: use ? (use.purchase ? "purchase" : "answer") : null,
    usedOn: use?.purchase ? use.at : null,
    confirmed: answer === "qualifies" && !usedHere,
    declined,
    canUndo: declined && !use?.purchase,
    notForYou,
    refusal,
    question: firstOrder
      ? `This price is a first-order or new-customer offer at ${shop}: "${promotion.condition}". Do you qualify, that is, have you never used such an offer at ${shop}?`
      : `This price depends on a promotion: "${promotion.condition}". Do you qualify for it yourself?`,
  };
}

/**
 * Records a member's answer to a bounty's promotion question: "qualifies",
 * "not" (not alerted for this bounty) or "used" (already used a first-order
 * offer at this retailer, so first-order offers there are never alerted to
 * them again), or "undo" (the answer was given by mistake: it is removed,
 * with any "used" they said at this retailer, so the question is asked
 * again). Saying "qualifies" withdraws an earlier "used" they said at this
 * retailer. A use recorded by a purchase (completeClaim) is never withdrawn:
 * "qualifies" and "undo" are then refused with 409. Returns
 * promotionStanding after the answer.
 */
export function answerPromotion(db, { bountyId, memberId, answer, now }) {
  const at = iso(clock(now));
  const choice = oneOf(answer, "answer", [...ELIGIBILITY_ANSWERS, ELIGIBILITY_UNDO]);
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
    const use = firstOrder ? firstOrderUse(db, member.id, retailer) : null;
    if (use?.purchase && (choice === "qualifies" || choice === ELIGIBILITY_UNDO))
      fail(
        `You have already used the first-order offer at ${bounty.retailer}, so this price is not available to you. You marked a claim at this price as bought on ${humanDate(use.at)}.`,
        409,
      );
    if (choice === "qualifies" || (choice === ELIGIBILITY_UNDO && firstOrder))
      db.prepare(
        "DELETE FROM promotion_answers WHERE member_id = ? AND retailer = ? AND first_order = 1 AND answer = 'used' AND claim_id IS NULL",
      ).run(member.id, retailer);
    if (choice === ELIGIBILITY_UNDO) {
      db.prepare("DELETE FROM promotion_answers WHERE member_id = ? AND bounty_id = ? AND claim_id IS NULL").run(member.id, bounty.id);
      return promotionStanding(db, bounty, member);
    }
    // A use recorded by a purchase stays as it is.
    db.prepare(
      `INSERT INTO promotion_answers(member_id, bounty_id, retailer, condition, first_order, answer, created)
 VALUES(?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(member_id, bounty_id) DO UPDATE SET answer = excluded.answer, created = excluded.created,
 retailer = excluded.retailer, condition = excluded.condition, first_order = excluded.first_order
 WHERE promotion_answers.claim_id IS NULL`,
    ).run(member.id, bounty.id, retailer, promotion.condition, firstOrder ? 1 : 0, choice, at);
    return promotionStanding(db, bounty, member);
  });
}

/**
 * Records that a member used a bounty's first-order offer by buying at its
 * price: called by completeClaim inside its transaction. Only a claim at a
 * first-order or new-customer price the member confirmed (or the figures
 * depended on) counts. Returns true when it recorded the use.
 */
function recordFirstOrderUse(db, bounty, claimRow, at) {
  const promotion = promotionOf(bounty);
  const condition = claimRow.promotion ?? promotion?.condition ?? null;
  if (!isFirstOrderOffer(condition)) return false;
  if (!(claimRow.promotion_confirmed === 1 || promotion?.needsMemberConfirmation)) return false;
  db.prepare(
    `INSERT INTO promotion_answers(member_id, bounty_id, retailer, condition, first_order, answer, created, claim_id)
 VALUES(?, ?, ?, ?, 1, 'used', ?, ?)
 ON CONFLICT(member_id, bounty_id) DO UPDATE SET answer = 'used', first_order = 1, created = excluded.created,
 retailer = excluded.retailer, condition = excluded.condition, claim_id = excluded.claim_id`,
  ).run(claimRow.member_id, bounty.id, normaliseLocality(bounty.retailer), condition, at, claimRow.id);
  return true;
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

/**
 * The cash a member can spend on this trip before any payout, in pence,
 * from a claim or claim check (round 5): required, and a blank is never
 * zero or enough.
 */
export function cashInput(input) {
  const v = isObject(input) ? input.cashAvailable : undefined;
  if (v === undefined || v === null || v === "")
    fail(
      "Enter the cash you can spend on this trip (pence), before any payout: the stock, packaging, postage and your journey are paid before you are. A blank is never counted as zero or as enough",
    );
  return int(v, "cashAvailable", 0, 10_000_000);
}

/**
 * A member's own hourly floor and cash date for a claim, both optional:
 * { hourlyFloor, cashNeededBy }. hourlyFloor is pence an active hour and
 * cashNeededBy a calendar date (YYYY-MM-DD), today or later in the UK. A
 * blank is "not given": the operator's floor still applies, and with no
 * date of their own no cash date is checked (never the operator's).
 */
export function memberTermsInput(input, { now = null } = {}) {
  const source = isObject(input) ? input : {};
  const given = (v) => !(v === undefined || v === null || v === "");
  const hourlyFloor = given(source.hourlyFloor) ? int(source.hourlyFloor, "hourlyFloor", 0, 100000) : null;
  const cashNeededBy = isoDate(source.cashNeededBy, "cashNeededBy", { optional: true });
  if (cashNeededBy && now && cashNeededBy < claimToday(now))
    fail("The date you need the cash back must be today or later");
  return { hourlyFloor, cashNeededBy };
}

/** The stricter of several sets of threshold overrides, as overrides. */
function stricterRules(...sets) {
  let rules = OPPORTUNITY_RULES;
  for (const set of sets) if (isObject(set)) rules = effectiveRules(set, rules);
  return Object.fromEntries(MEMBER_RULE_KEYS.filter((k) => rules[k] !== OPPORTUNITY_RULES[k]).map((k) => [k, rules[k]]));
}

const floorOf = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

/**
 * The hourly floor and cash date a member's own check uses: { hourlyFloor,
 * cashNeededBy, floor: { used, mine, operator } }. The floor is the
 * stricter (higher) of the operator's (the bounty's estimate request) and
 * the member's; the cash date is the member's own or none.
 */
export function claimTerms(bounty, terms = null) {
  const operator = floorOf(storedRequest(bounty)?.hourlyFloor);
  const mine = floorOf(terms?.hourlyFloor);
  const used = operator === null ? mine : mine === null ? operator : Math.max(operator, mine);
  return {
    hourlyFloor: mine,
    cashNeededBy: typeof terms?.cashNeededBy === "string" && terms.cashNeededBy ? terms.cashNeededBy : null,
    // The cash the member said they can spend on the trip (round 5), or
    // null when a claim stored none.
    cashAvailable: Number.isSafeInteger(terms?.cashAvailable) && terms.cashAvailable >= 0 ? terms.cashAvailable : null,
    floor: { used, mine, operator },
  };
}

/**
 * The estimate request for one member's own trip on a bounty: the stored
 * request at the units they claim, with their own journey, the stricter of
 * the operator's and the member's thresholds and hourly floors, their own
 * cash date or none (the operator's is dropped), and their own promotion
 * answer (never the operator's).
 */
export function memberRequest(bounty, member, { units, journey, qualifies = false, terms = null }) {
  const request = storedRequest(bounty);
  if (!isObject(request)) return null;
  // The operator's cash date and any profile in the stored request are not
  // the member's: their own profile is checked by memberTripCheck.
  const { cashNeededBy: _operatorDate, cashNeededDays: _operatorDays, profile: _profile, carryKg: _carry, ...rest } = request;
  const own = claimTerms(bounty, terms);
  return {
    ...rest,
    units,
    costs: { ...(isObject(request.costs) ? request.costs : {}), journeyCost: journey.cost, journeyMinutes: journey.minutes },
    rules: stricterRules(request.rules, memberRules(member)),
    promotionEligible: qualifies === true,
    ...(own.floor.used === null ? {} : { hourlyFloor: own.floor.used }),
    ...(own.cashNeededBy ? { cashNeededBy: own.cashNeededBy } : {}),
  };
}

/**
 * The units already heading to the resale market from a bounty, for a
 * member's own check: { committed, mine, sellWindowWeeks,
 * salesPerWeekLimit, now, bestBefore, food }. committed is every unit
 * claimed (live) or bought on the bounty and mine the member's share of
 * it. The sell window is the operator's, never longer than the buy-alert
 * gate's (OPPORTUNITY_RULES.sellWindowWeeks); salesPerWeekLimit is the
 * operator's own sales estimate, which can only lower the evidenced rate.
 *
 * Round 5: earlier is the units earlier bounties for the item still have
 * against its demand (earlierAllocation: bought and not recorded as sold
 * or returned, or held in a live claim) and earlierNote says so in words.
 * They are ahead of the member's units for the same buyers. owners
 * (listingOwners, round 5b) lets the competing listings that are members'
 * own units count once.
 */
export function sharedDemand(db, bounty, member, now) {
  const held = claimedUnits(db, bounty.id, now);
  const earlier = earlierAllocation(db, bounty, now);
  const mine = member
    ? db
        .prepare(
          `SELECT COALESCE(SUM(units), 0) AS n FROM claims WHERE bounty_id = ? AND member_id = ?
 AND (status = 'completed' OR (status = 'active' AND expires_at > ?))`,
        )
        .get(bounty.id, member.id, iso(clock(now))).n
    : 0;
  const entered = enteredOf(bounty) ?? {};
  const gate = OPPORTUNITY_RULES.sellWindowWeeks;
  const request = storedRequest(bounty);
  return {
    committed: held.committed,
    mine,
    earlier: earlier.units,
    earlierNote: earlierNote(earlier),
    // Members holding units bought through bounties for the item, so their
    // own listings count once (round 5b, ownListings).
    owners: listingOwners(db, bounty, now),
    sellWindowWeeks: isPositive(entered.sellWindowWeeks) ? Math.min(entered.sellWindowWeeks, gate) : gate,
    salesPerWeekLimit: isPositive(entered.salesPerWeek) ? entered.salesPerWeek : null,
    now,
    bestBefore: typeof request?.bestBefore === "string" ? request.bestBefore : null,
    food: json(bounty.estimate, null)?.category?.applied === CATEGORY_RULES.food.name,
  };
}

/** "about 2 sales a week", "about 1 sale a fortnight", "about 3 sales a month". */
function rateWords(perWeek) {
  if (!isPositive(perWeek)) return "an unknown sales rate";
  if (perWeek >= 0.95) return `about ${plural(Math.round(perWeek), "sale")} a week`;
  if (perWeek * 2 >= 0.95) return `about ${plural(Math.round(perWeek * 2), "sale")} a fortnight`;
  const month = (perWeek * 30) / 7;
  return month >= 0.95 ? `about ${plural(Math.round(month), "sale")} a month` : "fewer than 1 sale a month";
}
/** "within a day", "in about 9 days", "in about 10 weeks". */
const soonWords = (days) =>
  days <= 0 ? "within a day" : days < 14 ? `in about ${plural(days, "day")}` : `in about ${plural(Math.round(days / 7), "week")}`;
const weeksWords = (weeks) => `${weeks.toLocaleString("en-GB")} week${weeks === 1 ? "" : "s"}`;
const upperFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Competing listings from an estimate result: its demand's count (null when
 * unknown), or for an older result its competition (no listings counts only
 * with an asking-price lookup on record).
 */
function competingOf(result) {
  if (isObject(result?.demand)) return isCount(result.demand.competingListings) ? result.demand.competingListings : null;
  const c = result?.competition;
  if (isCount(c?.competingListings)) return c.competingListings;
  if (isCount(c?.activeListings) && (c.activeListings > 0 || lookupOf(result, null))) return c.activeListings;
  return null;
}

/**
 * The member's trip beside the units already claimed or bought on the
 * bounty (sharedDemand): those units compete for the same buyers, so they
 * count as competing listings for demand, and the member's units sell after
 * them. Returns { info, reasons }: info { committed, mine, others,
 * earlier, salesPerWeek, sellWindowWeeks, competingListings, demand,
 * demandLeft, sellDays, payoutDate, cashNeededBy, note } and the failures
 * (demand left for their units, payout after their own cash date, food
 * shelf life). Round 5: the units earlier bounties for the item still have
 * against its demand (shared.earlier) are ahead of theirs too.
 */
function sharedTrip(result, { units, shared, cashNeededBy }) {
  const committed = isCount(shared?.committed) ? shared.committed : 0;
  const mine = Math.min(committed, isCount(shared?.mine) ? shared.mine : 0);
  const others = committed - mine;
  const earlier = isCount(shared?.earlier) ? shared.earlier : 0;
  const ahead = committed + earlier;
  const weeks = isPositive(shared?.sellWindowWeeks) ? shared.sellWindowWeeks : OPPORTUNITY_RULES.sellWindowWeeks;
  const count = result?.sample?.count;
  const evidenced = isCount(count) && count > 0 ? (count * 7) / BOUNTY_RULES.saleWindowDays : null;
  const rate =
    evidenced === null ? null : isPositive(shared?.salesPerWeekLimit) ? Math.min(evidenced, shared.salesPerWeekLimit) : evidenced;
  const listings = competingOf(result);
  // Members' own listings of units already ahead of theirs count once
  // (round 5b); a result without listings per seller leaves every one counted.
  const own = ownListings(result?.competition?.bySeller, Array.isArray(shared?.owners) ? shared.owners : [], listings);
  const demand = claimDemandUnits({ salesPerWeek: rate, competingListings: listings === null ? null : listings - own.units }, weeks);
  const left = demand === null ? null : Math.max(0, demand - ahead);
  const median = result?.sample?.daysToSell;
  const sellDays = Number.isFinite(median) ? claimSellDays({ units: ahead + units, daysToSell: median, salesPerWeek: rate }) : null;
  const goals = result?.payout?.goals;
  const payout =
    sellDays === null || !isObject(goals)
      ? null
      : claimPayoutDate({
          start: claimToday(shared.now),
          daysToSell: sellDays,
          dispatchDays: goals.dispatchDays,
          deliveryDays: goals.deliveryDays,
          payoutDelayDays: goals.payoutDelayDays,
        }).date;
  const onThis =
    others > 0
      ? `Other members have already claimed ${plural(others, "unit")}${mine > 0 ? ` and you have claimed or bought ${mine}` : ""}.`
      : mine > 0
        ? `You have already claimed or bought ${plural(mine, "unit")} on this bounty.`
        : "";
  const fromEarlier =
    earlier > 0
      ? typeof shared?.earlierNote === "string" && shared.earlierNote
        ? `${upperFirst(shared.earlierNote)}.`
        : `${plural(earlier, "unit")} from earlier bounties for this item still count against the demand for it.`
      : "";
  const who = [onThis, fromEarlier].filter(Boolean).join(" ");
  const yours = units === 1 ? "your unit is" : `the last of your ${units} units is`;
  const sell = sellDays === null || rate === null ? null : `At ${rateWords(rate)}, ${yours} likely to sell ${soonWords(sellDays)}`;
  const lead = who ? who + " " : "";
  const reasons = [];
  const gateDemandFailed = Array.isArray(result?.alert?.checks) && result.alert.checks.some((c) => c?.id === "demand" && c.ok !== true);
  if (left !== null && units > left && (ahead > 0 || !gateDemandFailed))
    reasons.push(
      `${lead}${sell ? sell + ", but s" : "S"}ales support about ${plural(demand, "unit")} within ${weeksWords(weeks)} after competing listings${
        ahead > 0
          ? left === 0
            ? earlier > 0
              ? ", and the units above already take all of them"
              : ", and those are already claimed"
            : `, so only ${plural(left, "more unit")} can be claimed`
          : ""
      }`,
    );
  if (cashNeededBy && ahead > 0) {
    if (payout === null)
      reasons.push(
        `${lead}The payout date for your ${units === 1 ? "unit" : "units"} cannot be worked out, so it cannot be checked against ${humanDate(cashNeededBy)}, when you need the cash`,
      );
    else if (payout > cashNeededBy)
      reasons.push(`${lead}${upperFirst(yours)} likely to be paid out on ${humanDate(payout)}, after ${humanDate(cashNeededBy)}, when you need the cash`);
  }
  if (shared?.food && shared.bestBefore && sellDays !== null && ahead > 0) {
    const need = CATEGORY_RULES.food.minShelfLifeDays;
    const daysLeft = Math.floor((Date.parse(shared.bestBefore) - clock(shared.now)) / DAY);
    if (Number.isFinite(daysLeft) && daysLeft - sellDays < need)
      reasons.push(
        `${lead}Less than ${need} days would be left on the best-before date (${humanDate(shared.bestBefore)}) when ${yours} likely to sell`,
      );
  }
  return {
    info: {
      committed,
      mine,
      others,
      earlier,
      salesPerWeek: rate === null ? null : round2(rate),
      sellWindowWeeks: weeks,
      competingListings: listings,
      ownListings: own.units,
      demand,
      demandLeft: left,
      sellDays,
      payoutDate: payout,
      cashNeededBy: cashNeededBy ?? null,
      note: [who, sell ? sell + "." : ""].filter(Boolean).join(" ") || null,
    },
    reasons,
  };
}

const HOURLY_FLOOR_REASON = "Below the hourly floor or working time unknown";

/** Whether a suitability check fails only because the member left a value blank. */
function memberBlank(id, missing) {
  const has = (k) => Array.isArray(missing) && missing.includes(k);
  if (id === "cash-available") return has("cashAvailable");
  if (id === "one-unit-load" || id === "total-load") return has("transport") || has("carryKg");
  if (id === "storage-space") return has("storageUnits");
  return false;
}

/**
 * Whether a member's own trip fits them (round 5, finding 4), from the
 * estimate re-run for them: suitability.mjs at their units, the unit
 * weight, the cash the trip needs before payout (unknown while a money
 * input is blank) and their profile ({ transport, carryKg, cashAvailable,
 * storageUnits }, memberTripProfile). A missing profile fails every check.
 */
export function memberFit(result, { units, journey = null, profile = null } = {}) {
  const r = isObject(result) && !result.error ? result : null;
  const e = isObject(r?.economics) ? r.economics : null;
  const weight = r?.opportunity?.weightKg ?? r?.inputs?.weightKg ?? null;
  const fromEstimate = isObject(r?.suitability) && Object.hasOwn(r.suitability, "cashRequired");
  const blanks = Array.isArray(r?.missingInputs) && r.missingInputs.length > 0;
  const cashRequired = fromEstimate ? r.suitability.cashRequired : blanks ? null : (e?.cashRequired ?? null);
  const travel = Number.isSafeInteger(e?.costs?.travel) ? e.costs.travel : Number.isSafeInteger(journey?.cost) ? journey.cost : 0;
  return tripSuitability({ units, unitKg: weight, cashRequired, cashFixed: travel, profile });
}

/**
 * Whether a member's own trip passes, from the estimate re-run for them
 * (memberRequest): { ok, units, journey, figures, reasons, shared, floor,
 * cashNeededBy }. Every buy-alert check must pass at their units with their
 * journey, thresholds, hourly floor and cash date, and the figures must be
 * for exactly those units and that journey cost. With `shared`
 * (sharedDemand) the units already claimed or bought on the bounty count as
 * competing units for demand and the payout is scheduled after them
 * (sharedTrip). terms is claimTerms(bounty, the member's own terms).
 * Unknown figures fail closed.
 */
export function memberTripCheck(result, { units, journey, shared = null, terms = null, profile = null }) {
  const reasons = [];
  const e = isObject(result) && !result.error ? result.economics : null;
  const o = isObject(result?.opportunity) ? result.opportunity : {};
  const floor = terms?.floor ?? null;
  if (!isObject(result) || result.error)
    reasons.push("Your figures could not be worked out" + (result?.error ? ": " + result.error : ""));
  else if (!isObject(e)) reasons.push("No completed-sale price for this item, so your profit cannot be worked out");
  else {
    if (e.units !== units) reasons.push(`The figures were worked out for ${plural(e.units, "unit")}, not your ${units}`);
    if (isObject(e.costs) && e.costs.travel !== journey.cost) reasons.push("The figures do not use your journey cost");
    const thresholds = o.meetsThresholds === true ? [] : Array.isArray(o.reasons) ? o.reasons.map(String) : [];
    const checks = result.alert?.eligible === true ? [] : Array.isArray(result.alert?.reasons) ? result.alert.reasons.map(String) : ["The buy-alert checks did not run"];
    for (const raw of [...thresholds, ...checks]) {
      // Say which floor the trip falls below, when it is known.
      const r =
        raw === HOURLY_FLOOR_REASON && floor?.used !== null && floor?.used !== undefined && Number.isFinite(e.hourly) && e.hourly < floor.used
          ? `Below the hourly floor: about ${pounds(e.hourly)} an active hour, under ${floor.mine !== null && floor.mine >= (floor.operator ?? 0) ? "your" : "the operator's"} floor of ${pounds(floor.used)}`
          : raw;
      if (!reasons.includes(r)) reasons.push(r);
    }
  }
  const together = shared ? sharedTrip(result, { units, shared, cashNeededBy: terms?.cashNeededBy ?? null }) : null;
  if (e && together) for (const r of together.reasons) if (!reasons.includes(r)) reasons.push(r);
  // The trip must fit the member: their load limit, cash and storage
  // (round 5). Unknown fails, so a member with no profile is never told go.
  const fit = memberFit(result, { units, journey, profile });
  for (const r of fit.reasons) if (!reasons.includes(r)) reasons.push(r);
  const unitProfit = Number.isSafeInteger(o.unitProfit) ? o.unitProfit : e && e.units ? Math.floor(e.contribution / e.units) : null;
  // When the only failures are values the member has not given (the cash
  // they can spend, their transport, carry limit or storage), the trip is
  // waiting for them to confirm those, not failing on the evidence: confirm
  // lists the fields (round 5b). Any other failure leaves it null.
  const blanks = new Set(fit.checks.filter((c) => !c.ok && !c.known && memberBlank(c.id, fit.missing)).map((c) => c.detail));
  const confirm = reasons.length > 0 && reasons.every((r) => blanks.has(r)) ? fit.missing.slice() : null;
  return {
    ok: reasons.length === 0,
    confirm,
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
          sellDays: together?.info.sellDays ?? null,
          payoutDate: together?.info.payoutDate ?? null,
        }
      : null,
    reasons,
    shared: together?.info ?? null,
    floor,
    cashNeededBy: terms?.cashNeededBy ?? null,
    // Load, cash and storage for this member (suitability.mjs).
    fit: { ok: fit.ok, known: fit.known, checks: fit.checks, maxUnits: fit.maxUnits, loadLimitKg: fit.loadLimitKg, missing: fit.missing },
  };
}

/**
 * A member's trip check on a bounty that cannot send anyone on a trip now
 * (trip blockers, or nothing left under the cap): never ok, led by the
 * "Don't make the trip" line, with the member's own result kept as ownOk
 * and ownReasons.
 */
export function blockedTripCheck(check, { blockers, headline }) {
  const list = Array.isArray(blockers) ? blockers.filter(Boolean).map(String) : [];
  if (!list.length && !headline) return check;
  return {
    ...check,
    ok: false,
    blocked: true,
    stop: headline || `${TERMS.stop}: ${list[0]}`,
    blockers: list,
    ownOk: check.ok,
    ownReasons: check.reasons,
    reasons: [...list, ...check.reasons.filter((r) => !list.includes(r))],
  };
}

const withStop = (text) => text.replace(/[.\s]+$/, "") + ".";

/** Plain words for a member's trip check, for messages and the claim form. */
export function memberTripText(check) {
  const where = `${plural(check.units, "unit")} with your journey (${pounds(check.journey.cost)}, ${plural(check.journey.minutes, "minute")})`;
  if (check.blocked)
    return `${withStop(check.stop)} ${
      check.ownOk ? "Your own figures would otherwise pass." : `At ${where} your own figures also fail: ${check.ownReasons.join("; ")}.`
    }`;
  if (!check.ok) return `At ${where} this trip fails: ${check.reasons.join("; ")}.`;
  const f = check.figures;
  const floor = check.floor;
  const terms =
    floor?.mine !== null && floor?.mine !== undefined
      ? `Checked against an hourly floor of ${pounds(floor.used)}${floor.used > floor.mine ? " (the operator's, stricter than yours)" : ""}${check.cashNeededBy ? ` and your cash date of ${humanDate(check.cashNeededBy)}` : ""}.`
      : check.cashNeededBy
        ? `Checked against your cash date of ${humanDate(check.cashNeededBy)}.`
        : "";
  const extra = [check.shared?.note, terms].filter(Boolean).join(" ");
  return `At ${where}: profit per unit ${pounds(f.unitProfit)}${f.returnOnCost === null ? "" : `, return ${percentDown(f.returnOnCost)}`}${f.hourly === null ? "" : `, ${pounds(f.hourly)} an hour`}, cash needed before payout ${pounds(f.cashRequired)}.${extra ? " " + extra : ""} Every check passes.`;
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
 * journey (memberRequest, with terms): the claim is refused with the
 * failing reasons unless every check passes on their own figures, with the
 * units already claimed or bought on the bounty counted against demand and
 * ahead of theirs for the payout (sharedDemand, worked out inside the
 * transaction). terms { hourlyFloor, cashNeededBy } are the member's own
 * (memberTermsInput), both optional.
 *
 * A member who said they do not qualify for the price, or who used a
 * first-order offer at this retailer (said so, or bought at such a price),
 * is refused whatever qualifiesForPromotion says (standing.refusal).
 *
 * Round 5: the units must fit the member (memberFit): one unit and every
 * unit within their load limit (their stored transport and carry limit),
 * the cash the trip needs before payout within cashAvailable (the cash they
 * said they can spend on this trip, required) and the units within their
 * storage at home. A member with no stored profile is refused with a
 * request to confirm it. cashAvailable is stored with the claim's terms so
 * a re-check uses it again.
 */
export function claim(db, { bountyId, memberId, units, journey, check, qualifiesForPromotion = false, terms = null, cashAvailable = null, now }) {
  const at = clock(now);
  return transaction(db, () => {
    expireClaims(db, now);
    const bounty = requireBounty(db, bountyId);
    const max = trialBatch(bounty);
    if (!Number.isSafeInteger(units) || units < 1 || units > max)
      fail(`units must be a whole number from 1 to ${max}: a claim is at most a trial batch until a verified trade exists`);
    const count = units;
    // The cash they can spend on this trip: required, never zero (round 5).
    const cash = cashInput({ cashAvailable });
    const member = requireMember(db, memberId);
    // The evidence read again, as the card reads it: the cap worked out now
    // (capNow) and the units left on the shelf after the claims ahead
    // (claimSeats), so a claim never goes beyond what the card offers.
    const live = liveEvidence(db, bounty, now);
    const blockers = tripBlockers(db, bounty, now, live);
    if (blockers.length) fail(blockers.join(". ") + ".", 409);
    const liveCap = capNow(db, bounty, now, live);
    applyCap(bounty, liveCap);
    const seats = claimSeats(db, bounty, now, live, liveCap);
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
    const standing = promotionStanding(db, bounty, member);
    if (standing?.declined) fail(standing.refusal, 409);
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
    const qualifies = qualifiesForPromotion === true || standing?.confirmed === true;
    if (promotion?.needsMemberConfirmation && !qualifies)
      fail(
        // No profit figure: the member has not said they qualify.
        `This price depends on a promotion: "${promotion.condition}". Confirm that you qualify before claiming. ${promotionRisk(promotion)}`,
        409,
      );
    const held = claimedUnits(db, bounty.id, now);
    const underCap = Math.max(0, bounty.cap - held.committed);
    // Never more than the units left on the shelf after the claims ahead
    // (R3M5), the same rule as bountyView's remaining.
    const onShelf = Math.max(0, seats.room - held.active);
    const remaining = Math.min(underCap, onShelf);
    if (count > remaining)
      fail(
        onShelf < underCap
          ? remaining === 0
            ? `Nothing is left to claim: ${seats.phrase}, and members have already claimed ${plural(held.active, "unit")}.`
            : `Only ${plural(remaining, "unit")} can be claimed: ${seats.phrase}, and members have already claimed ${plural(held.active, "unit")}.`
          : remaining === 0
            ? capFullMessage(bounty, liveCap.earlier) +
                " A claim reserves attention, not retailer stock, so the cap limits how many people are sent."
            : `Only ${remaining} unit${remaining === 1 ? " remains" : "s remain"} under this bounty's distribution cap.` +
              // Units earlier bounties for the item still have against its
              // demand, when they are why (round 5).
              (liveCap.earlier?.binding ? ` ${upperFirst(earlierNote(liveCap.earlier))}.` : ""),
        409,
      );
    const own = memberTripCheck(check, {
      units: count,
      journey: trip,
      shared: sharedDemand(db, bounty, member, now),
      terms: claimTerms(bounty, terms),
      profile: memberTripProfile(member, cash, homeStock(db, member.id, { bountyId: bounty.id, now })),
    });
    if (!own.ok) fail(memberTripText(own), 409);
    if (promotion?.needsMemberConfirmation && qualifiesForPromotion === true && standing?.answer !== "qualifies")
      answerPromotion(db, { bountyId: bounty.id, memberId: member.id, answer: "qualifies", now });
    const result = db
      .prepare(
        `INSERT INTO claims(bounty_id, member_id, units, status, created, expires_at, promotion, promotion_confirmed,
 journey_cost, journey_minutes, figures, terms)
 VALUES(?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        bounty.id, member.id, count, iso(at), iso(at + BOUNTY_RULES.claimHours * HOUR), promotion?.condition ?? null,
        promotion && qualifies ? 1 : 0, trip.cost, trip.minutes, JSON.stringify(own.figures),
        JSON.stringify({ hourlyFloor: terms?.hourlyFloor ?? null, cashNeededBy: terms?.cashNeededBy ?? null, cashAvailable: cash }),
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

/**
 * Stores the cash the member who holds an active claim can spend on this
 * trip (round 5b): a claim made before the cash was asked for stores none,
 * so its re-check asks for it. cashAvailable is pence, required (cashInput:
 * a blank is never zero). Only the claim's member, only while it is active.
 * The caller re-checks the bounty, so the claim's figures use it at once.
 */
export function setClaimCash(db, { claimId, memberId, cashAvailable, now }) {
  return transaction(db, () => {
    const found = activeClaimFor(db, claimId, memberId, now);
    const cash = cashInput({ cashAvailable });
    const terms = json(found.terms, null);
    const next = { ...(isObject(terms) ? terms : { hourlyFloor: null, cashNeededBy: null }), cashAvailable: cash };
    db.prepare("UPDATE claims SET terms = ? WHERE id = ?").run(JSON.stringify(next), found.id);
    return getClaim(db, found.id);
  });
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
 * Buying at a first-order or new-customer price records, in the same
 * transaction, that the member used that offer at this retailer, so its
 * price is never offered to them again (promotionUsed is then true on the
 * returned claim).
 */
export function completeClaim(db, { claimId, memberId, unitsBought, now }) {
  const at = iso(clock(now));
  return transaction(db, () => {
    const found = activeClaimFor(db, claimId, memberId, now);
    const bounty = requireBounty(db, found.bounty_id);
    if (bounty.sample)
      fail("Sample bounty: illustrative figures only, so there is nothing to mark as bought. Release this claim.", 409);
    const units = unitsBought === undefined || unitsBought === null ? found.units : int(unitsBought, "units", 1, found.units);
    db.prepare("UPDATE claims SET status = 'completed', units = ?, ended_at = ? WHERE id = ?").run(units, at, found.id);
    const promotionUsed = recordFirstOrderUse(db, bounty, found, at);
    return { ...getClaim(db, found.id), promotionUsed };
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
  // A report older than a branch check on record stops nobody (shelfNow).
  const shelf = shelfNow(db, bounty, { check: newerCheck(db, bounty, now) });
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
 * The shelf as the latest stock report describes it (shelfStatus), with
 * an empty-shelf pause lifted once a branch check made after that report
 * is on record (round 4, R3P7): the evidence's own stock check after a
 * re-check, or a newer branch check (live.check). The newest word on the
 * shelf then decides, as shelfCount and the estimate's branchShelf read it:
 * a check that found stock lifts the pause, and one that found none stops
 * the trip as "out of stock" instead. liftedBy is { at, inStock } for the
 * check that lifted it, else null.
 */
function shelfNow(db, bounty, live = null) {
  const shelf = shelfStatus(db, bounty.id);
  if (!shelf.paused || bounty.sample) return { ...shelf, liftedBy: null };
  const reportAt = Date.parse(shelf.at);
  const stock = json(bounty.estimate, null)?.stock;
  const checks = [];
  if (stock?.checkedAt) checks.push({ at: stock.checkedAt, inStock: stock.availability === "in_stock" });
  if (live?.check?.checked_at) checks.push({ at: live.check.checked_at, inStock: live.check.in_stock === 1 });
  const newer = checks.filter((c) => Date.parse(c.at) > reportAt).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  return newer ? { ...shelf, paused: false, liftedBy: newer } : { ...shelf, liftedBy: null };
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
 * Round 5: each member's own profile decides (bountyFit, for the units the
 * figures are for, no more than their trial allowance). A member with no
 * stored transport, carry limit or storage gets a kind "profile" entry
 * asking them to confirm it (no figures, not counted in exposure), listed
 * in confirm; completing the profile and calling again for them turns it
 * into the alert. A member whose profile the trip does not fit (a unit
 * heavier than their load limit, more units than it or their storage
 * allows) is not alerted, with the reason. The cash they can spend is
 * checked when they claim.
 *
 * Returns { bountyId, sent, asked, confirm, notAlerted, blockers,
 * exposure, nextReleaseAt, promotion, warning }.
 */
export function dispatchAlerts(db, bountyId, now, { memberId = null } = {}) {
  const at = clock(now);
  return transaction(db, () => {
    expireClaims(db, now);
    const bounty = requireBounty(db, bountyId);
    // The evidence read again before anyone is alerted (R3Q3): the cap
    // worked out now (capNow) is put on `bounty` and stored, and stop
    // notices go out, the same as on a read. An eligibility answer that
    // turns a question into an alert goes through this too.
    const live = liveEvidence(db, bounty, now);
    const synced = syncTrip(db, bounty, now, live, { read: false });
    const held = claimedUnits(db, bounty.id, now);
    const remaining = Math.max(
      0,
      Math.min(bounty.cap - held.committed, synced.room === null ? Infinity : synced.room - held.active),
    );
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
    const blockers = [...tripBlockers(db, bounty, now, live)];
    if (!blockers.length && synced.over && synced.headline) blockers.push(synced.headline);
    if (remaining <= 0) blockers.push(capFullMessage(bounty, synced.earlier));
    const promotion = promotionOf(bounty);
    const validation = bounty.sample ? null : validationStatus(db, bounty.locality);
    const result = {
      bountyId: bounty.id,
      sent: [],
      asked: [],
      // Members asked to confirm their transport, carry limit and storage
      // first (round 5): an inbox entry with no figures, never a go alert.
      confirm: [],
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
      due.push({
        member,
        release,
        ask: Boolean(standing && !standing.confirmed),
        asked: earlier.get(member.id) === "question",
        before: earlier.get(member.id) ?? null,
      });
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
    // An earlier entry (a question or a request to confirm the profile)
    // becomes this one, so a member has one entry per bounty.
    const setKind = db.prepare(
      `UPDATE alerts SET kind = ?, tier = ?, via = ?, release_at = ?, reputation = ?, promotion = ?, warning = ?, created = ?
 WHERE bounty_id = ? AND member_id = ?`,
    );
    let used = 0;
    for (const { member, release, ask, asked, before } of due) {
      const who = { memberId: member.id, name: member.name };
      if (ask) {
        if (asked) {
          result.notAlerted.push({ ...who, reason: "Asked whether they qualify for the promotion price: waiting for their answer" });
          continue;
        }
        if (before)
          setKind.run(
            "question", release.tier.id, release.via, release.releaseAt, release.points, promotion?.condition ?? null,
            result.warning, iso(at), bounty.id, member.id,
          );
        else
          insert.run(
            bounty.id, member.id, release.tier.id, release.via, release.releaseAt, release.points,
            promotion?.condition ?? null, result.warning, "question", iso(at),
          );
        result.asked.push({ ...who, condition: promotion?.condition ?? null });
        continue;
      }
      // The member's own transport, carry limit and storage (round 5). With
      // no stored profile they are asked to confirm it (no figures, not
      // counted in exposure); a profile the trip does not fit gets nothing.
      // The cash they can spend is asked when they claim.
      const fit = bountyFit(bounty, member, offeredUnits(db, bounty, member, now).units, roomFor(db, bounty, member.id, now));
      if (!fit.complete) {
        if (before === "profile") {
          result.notAlerted.push({ ...who, reason: "Asked to confirm their transport, carry limit and storage: waiting for them" });
          continue;
        }
        if (before)
          setKind.run(
            "profile", release.tier.id, release.via, release.releaseAt, release.points, promotion?.condition ?? null,
            result.warning, iso(at), bounty.id, member.id,
          );
        else
          insert.run(
            bounty.id, member.id, release.tier.id, release.via, release.releaseAt, release.points,
            promotion?.condition ?? null, result.warning, "profile", iso(at),
          );
        result.confirm.push({ ...who, missing: fit.missing });
        continue;
      }
      if (!fit.ok) {
        result.notAlerted.push({
          ...who,
          reason: `Does not fit the member's own transport, carrying limit or storage for ${plural(fit.units, "unit")}. Their check reads: ${fit.reasons.join("; ")}`,
        });
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
      if (before)
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
 * "blocked" (any other blocker, such as a price rise, sales that aged out,
 * a lapsed competition count, more claimed than the shelf holds, the
 * viewer's own figures failing, or a promotion price that is no longer
 * theirs), "sample", "expired" or "withdrawn". headline is the "Don't make
 * the trip" line and reason the first blocker's id (blockerList),
 * "over-claimed", "own-figures", "cash-unknown" or "profile-unknown"
 * (round 5b: a holder whose re-check failed only on values they have not
 * given, state "confirm-cash" or "confirm-profile", told to confirm them
 * through Check my figures, never that their figures failed), or
 * "promotion-declined" (round 4, N2: a
 * holder who bought at a first-order price at the retailer, or answered
 * "not" or "used", label "This price is not available to you").
 * options.memberId: the viewer, so a holder who keeps their units while
 * more is claimed than the shelf holds sees "Your claim stands" (go), and
 * a holder beyond them or whose own figures now fail sees why not. With
 * no member, more claimed than the shelf holds is never go (R3M5).
 */
export function tripState(db, bounty, now, list = blockerList(db, bounty, now), { memberId = null, live = null, seats = null } = {}) {
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
    return { state, go: false, label: first.label ?? label, headline: first.headline, reason: first.id };
  }
  // A holder the promotion price is no longer for (round 4, N2).
  const declined = memberId === null ? null : declinedHolders(db, bounty, now).get(memberId);
  if (declined)
    return { state: "blocked", go: false, label: "This price is not available to you", headline: declined.message, reason: "promotion-declined" };
  const own = memberId === null ? null : ownFigureFailures(db, bounty, now).get(memberId);
  if (own?.reason === "cash-unknown")
    return { state: "confirm-cash", go: false, label: "Confirm the cash you can spend", headline: own.message, reason: own.reason };
  if (own?.reason === "profile-unknown")
    return { state: "confirm-profile", go: false, label: own.label, headline: own.message, reason: own.reason, confirm: own.confirm };
  if (own) return { state: "blocked", go: false, label: "Your figures no longer pass", headline: own.message, reason: "own-figures" };
  // The member's own transport, carry limit and storage (round 5): a member
  // with no stored profile, or whom the trip does not fit, is never told go.
  const unfit = memberId === null ? null : fitTripState(db, bounty, memberId, now);
  if (unfit) return unfit;
  const s = seats ?? claimSeats(db, bounty, now, live ?? liveEvidence(db, bounty, now));
  if (s.over) {
    const kept = memberId === null ? null : s.kept.get(memberId);
    if (kept) return { state: "full", go: true, label: "Your claim stands", headline: null, reason: null, note: kept.message };
    const beyond = memberId === null ? null : s.beyond.get(memberId);
    return {
      state: "blocked",
      go: false,
      label: "More claimed than on the shelf",
      headline: beyond?.message ?? s.headline,
      reason: "over-claimed",
    };
  }
  // Members already holding a claim may go; nobody new can claim.
  if (bounty.cap - claimedUnits(db, bounty.id, now).committed <= 0 || s.room - s.active <= 0)
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
  "competition-lapsed": ["blocked", "Competition check out of date"],
  "demand-aged": ["blocked", "Sales evidence out of date"],
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
 * and the units on the shelf now. With a member whose carry limit is
 * stored (round 5) their own limit is used; otherwise a hand-carried load
 * (HAND_CARRY_KG) is assumed.
 */
function accessFor(bounty, shelfUnits, member = null) {
  if (bounty.sample) return [];
  const o = json(bounty.opportunity, null) ?? {};
  const own = memberTripProfile(member).carryKg;
  return accessNeeds(
    { weight: o.weightKg, stock: shelfUnits?.units ?? null, stockChecked: shelfUnits?.at ?? null, storageNeeds: null },
    { carry: own ?? HAND_CARRY_KG },
  ).map((n) =>
    n.id === "vehicle-required" && own === null
      ? { ...n, detail: `One unit weighs ${o.weightKg} kg, more than one person can carry by hand` }
      : n,
  );
}

// Blockers that are a change in the evidence since the figures were worked out.
const LIVE_BLOCKERS = new Set([
  "shelf-empty", "out-of-stock", "stock-lapsed", "offer-gone", "price-rose", "offer-stale", "sales-aged",
  "competition-lapsed", "demand-aged",
]);

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

/**
 * When the price and the stock were last checked, for the card (UK time).
 * price is when the price the figures use was last seen; priceLabel says
 * when the offer was last observed in the evidence now (R3Q8), with the
 * new price when it has risen. The stock line uses the newest shelf count
 * (shelfUnitsNow with the live evidence), named for what it came from.
 */
function checkedLabels(bounty, snapshot, live, shelfUnits) {
  if (bounty.sample) return { price: null, priceLabel: null, stock: null, stockLabel: null };
  const price = offerObserved(bounty, live);
  const o = live?.offer;
  const seen = o && !o.gone && o.observed && Date.parse(o.observed) > Date.parse(price ?? "") ? o.observed : price;
  const stock = shelfUnits?.at ?? snapshot?.stock?.checkedAt ?? null;
  const by = shelfUnits?.source === "stock report" ? "stock report" : "branch check";
  return {
    price,
    priceLabel: seen
      ? `Price seen ${whenSeen(seen)}${o?.rose ? ` at ${pounds(o.price)} (the figures use ${pounds(o.was)})` : ""}`
      : "Price observation date unknown",
    stock,
    stockLabel: stock ? `Stock last checked ${humanTime(stock)} (${by})` : "Branch stock never checked",
  };
}

/**
 * The opportunity tier now (R3P4, R2Q8). The tier is set at a re-check,
 * when sourcing pressure is not known (nobody is heading to the shelf yet),
 * so a stored Priority 1 or 2 is classified again here with what is known
 * now, keeping every other rule from classifyOpportunity (opportunity.mjs):
 * the stored Priority 2 reasons other than competition and pressure still
 * hold; a stock blocker adds "Branch stock not confirmed"; fewer than
 * OPPORTUNITY_RULES.strongIndependentSales recent sellers adds that reason;
 * resale weeks of supply (competing listings over the sales rate the cap
 * uses, 0 for a current lookup that found none, as the estimate counts it)
 * and sourcing pressure must be within the Priority 1 limits. Other tiers
 * keep their reasons. Returns { tier, reasons, tierAtRecheck }.
 */
function tierNow(stored, { resale, sourcing, live = null, list = [] }) {
  const reasons = Array.isArray(stored?.reasons) ? stored.reasons.map(String) : [];
  const tier = stored?.tier ?? null;
  if (tier !== "Priority 1" && tier !== "Priority 2") return { tier, reasons, tierAtRecheck: tier };
  const R = OPPORTUNITY_RULES;
  const maxWeeks = R.maxResaleWeeksOfSupplyPriority1;
  const maxPressure = R.maxSourcingPressurePriority1;
  const atMost = (v, max) => typeof v === "number" && Number.isFinite(v) && v <= max;
  const STOCK = "Branch stock not confirmed";
  const FEWER = `Fewer than ${R.strongIndependentSales} independent recent sales`;
  const kept = reasons.filter((r) => !/^(Resale competition|Sourcing pressure|Strong sold evidence)/.test(r));
  const out = [];
  if (kept.includes(STOCK) || list.some((b) => ["shelf-empty", "out-of-stock", "stock-lapsed"].includes(b.id))) out.push(STOCK);
  const recent = live?.sales?.recent;
  if (kept.includes(FEWER) || (Number.isSafeInteger(recent) && recent < R.strongIndependentSales)) out.push(FEWER);
  out.push(...kept.filter((r) => r !== STOCK && r !== FEWER));
  const weeks =
    resale.weeksOfSupply !== null && resale.weeksOfSupply !== undefined
      ? resale.weeksOfSupply
      : resale.competingListings === 0 && live?.competition?.known && isPositive(resale.salesPerWeek)
        ? 0
        : null;
  if (!atMost(weeks, maxWeeks))
    out.push(
      weeks !== null
        ? `Resale competition high: about ${weeks} weeks of supply listed (Priority 1 allows ${maxWeeks})`
        : live?.competition?.lapsed
          ? "Resale competition unknown: the competing-listings count is out of date"
          : "Resale competition unknown: competing listings have not been counted",
    );
  if (!atMost(sourcing.ratio, maxPressure))
    out.push(
      sourcing.ratio !== null && sourcing.ratio !== undefined
        ? `Sourcing pressure high: ${sourcing.ratio} (Priority 1 allows ${maxPressure})`
        : sourcing.availableUnits === 0
          ? "Sourcing pressure not worked out: none on the shelf now"
          : "Sourcing pressure unknown: the units on the shelf have not been counted",
    );
  if (out.length) return { tier: "Priority 2", reasons: out, tierAtRecheck: tier };
  return {
    tier: "Priority 1",
    reasons: [
      `Strong sold evidence, confirmed stock and low pressure now: about ${weeks} weeks of resale supply listed and sourcing pressure ${sourcing.ratio}`,
    ],
    tierAtRecheck: tier,
  };
}

/**
 * The main uncertainty for a viewer who may not see the figures: the
 * estimate's own (uncertaintyNow) only with showFigures; otherwise a change
 * in the evidence since the figures were worked out, or, for a promotion
 * price they have not said they qualify for, that question. Never the sale
 * estimate.
 */
function uncertaintyFor(bounty, snapshot, list, { showFigures, condition = null }) {
  if (showFigures || bounty.sample) return uncertaintyNow(bounty, snapshot, list);
  const change = list.find((b) => LIVE_BLOCKERS.has(b.id));
  if (change) return change.text;
  return condition ? `Whether you qualify for the promotion price ("${condition}"): the figures depend on it` : null;
}

/**
 * An inbox entry for a bounty that is not for the member (their promotion
 * answer, promotionStanding.declined): the answer in plain words and
 * whether it can be undone, with no figures and no offer details. A
 * first-order offer keeps its title only when the member holds or held a
 * claim on it, so the inbox never lists the offer itself again.
 */
function declinedAlert(db, a, bounty, member, { display, standing, list, live = null, now }) {
  const claimed = Boolean(
    db
      .prepare("SELECT 1 FROM claims WHERE bounty_id = ? AND member_id = ? AND status IN ('active', 'completed') LIMIT 1")
      .get(bounty.id, member.id),
  );
  const named = display.permitted && (!standing.firstOrder || claimed);
  return {
    id: a.id,
    bountyId: a.bounty_id,
    kind: "declined",
    title: named ? bounty.title : display.permitted ? `First-order offer at ${bounty.retailer}` : HIDDEN_TITLE,
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
    // A holder the price is no longer for sees why (round 4, N2).
    trip: tripState(db, bounty, now, list, { memberId: member.id, live }),
    shelf: shelfNow(db, bounty, live),
    promotion: null,
    eligibility: display.permitted ? standing : null,
    questionNote: display.permitted ? `${standing.notForYou}.` : "This bounty is not for you.",
    figures: null,
    checked: null,
    mainUncertainty: null,
    warning: null,
    category: null,
    attributes: [],
    accessNeeds: [],
    notices: memberNotices(db, member.id, { bountyId: bounty.id }),
  };
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
 * permit display, the title, retailer and figures are hidden. Items also
 * carry checked { priceLabel, stockLabel } (when the price and the stock
 * were last checked) and mainUncertainty, which never gives the sale
 * estimate to a member who has not said they qualify.
 *
 * kind "declined": the member said they do not qualify for the price, or
 * used a first-order offer at this retailer (said so, or bought at such a
 * price), so the bounty is not for them (declinedAlert): no figures, no
 * offer details, and for a first-order offer no title unless they hold or
 * held a claim on it.
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
  // Each bounty as syncTrip left it (the cap worked out now applied).
  const synced = new Map();
  for (const bountyId of ids) {
    const bounty = getBounty(db, bountyId);
    if (bounty) {
      syncTrip(db, bounty, now);
      synced.set(bountyId, bounty);
    }
  }
  return rows.map((a) => {
    const bounty = synced.get(a.bounty_id) ?? getBounty(db, a.bounty_id);
    const display = displayStatus(db, bounty);
    const snapshot = json(bounty.estimate, null);
    const live = liveEvidence(db, bounty, now);
    const list = blockerList(db, bounty, now, live);
    const promotion = promotionOf(bounty);
    const standing = promotionStanding(db, bounty, member);
    const condition = a.promotion ?? promotion?.condition ?? null;
    const shelfUnits = shelfUnitsNow(db, bounty, snapshot, json(bounty.cap_basis, null), latestReport(db, bounty.id), live);
    // The entry follows the member's answer: a price they said they do not
    // qualify for, or a first-order offer they used here, is not for them.
    if (standing?.declined) return declinedAlert(db, a, bounty, member, { display, standing, list, live, now });
    // kind "profile" (round 5): the member was asked to confirm their
    // transport, carry limit and storage first, so no figures are shown.
    const kind = a.kind === "question" ? "question" : a.kind === "profile" ? "profile" : "alert";
    const showFigures = display.permitted && kind === "alert" && (!standing || standing.confirmed);
    const trip = tripState(db, bounty, now, list, { memberId: member.id, live });
    const profileView = kind === "profile" ? memberProfileView(member, homeStock(db, member.id, { now })) : null;
    const opportunity = json(bounty.opportunity, null);
    const checked = checkedLabels(bounty, snapshot, live, shelfUnits);
    return {
      id: a.id,
      // When the price and the stock were last checked, and the main
      // uncertainty (never the sale estimate before they say they qualify).
      checked: display.permitted && !bounty.sample ? { priceLabel: checked.priceLabel, stockLabel: checked.stockLabel } : null,
      mainUncertainty: display.permitted
        ? uncertaintyFor(bounty, snapshot, list, { showFigures, condition: standing && !standing.confirmed ? condition : null })
        : null,
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
      trip,
      shelf: shelfNow(db, bounty, live),
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
          : kind === "profile"
            ? profileView.complete
              ? trip.state === "does-not-fit"
                ? "Your profile is complete, but this trip does not fit it as planned, so no alert with figures follows for it."
                : "Your profile is complete. The full alert with the figures follows if the trip fits it and there is room under the cap."
              : // The trip line already asks for the profile: say it once.
                trip.state === "confirm-profile"
                ? null
                : `${profileNeeded(profileView.missing)}.`
            : null,
      // What the member's profile still needs (kind "profile" only).
      profile: profileView,
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
      accessNeeds: accessFor(bounty, shelfUnits, member),
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
      "No active listings recorded and no current asking-price lookup for this barcode, so competition is not known: run an asking-price lookup.";
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
 * Units on the shelf now, from evidence only: the newest of the stock check
 * behind the estimate, a newer branch check (live.check, R3B1) and the
 * latest stock report that was not marked inaccurate (shelfCount), less
 * units members marked as bought after that count through any bounty (not
 * a sample) for the item at the same retailer and locality (boughtAtBranch,
 * as the estimate's branchShelf counts them). A sample uses its
 * hand-entered figure. units is null when no count exists. source is
 * "stock check" (a branch check) or "stock report".
 */
function shelfUnitsNow(db, bounty, snapshot, basis, latestReport, live = null) {
  if (bounty.sample)
    return { units: basis?.used?.availableUnits ?? bounty.available_units, source: "sample", at: null, boughtSince: 0 };
  const count = shelfCount(db, bounty, live, latestReport ?? null);
  if (!count) return { units: null, source: null, at: null, boughtSince: 0 };
  if (count.units === null) return { units: null, source: count.source, at: count.at, boughtSince: 0 };
  const boughtSince = boughtAtBranch(db, bounty, count.at);
  return { units: Math.max(0, count.units - boughtSince), source: count.source, at: count.at, boughtSince };
}

/**
 * Units members marked as bought after `at` through any bounty (not a
 * sample) for the same item (canonical barcode) at the same retailer and
 * locality, so a bounty opened after purchases on an earlier one for the
 * item counts them off the shelf as the estimate does (estimate.mjs
 * branchShelf, R3Q6, round 4 N1).
 */
function boughtAtBranch(db, bounty, at) {
  const shop = normaliseLocality(bounty.retailer);
  const place = normaliseLocality(bounty.locality);
  // A live bounty stores the canonical GTIN (createBounty), as openBountyRows reads it.
  const gtin = normaliseBarcode(bounty.barcode);
  const ids = gtin
    ? db
        .prepare("SELECT id, retailer, locality FROM bounties WHERE sample = 0 AND barcode = ?")
        .all(gtin)
        .filter((b) => normaliseLocality(b.retailer) === shop && normaliseLocality(b.locality) === place)
        .map((b) => b.id)
    : [];
  if (!ids.includes(bounty.id)) ids.push(bounty.id);
  return db
    .prepare(
      `SELECT COALESCE(SUM(units), 0) AS n FROM claims WHERE bounty_id IN (${ids.map(() => "?").join(", ")})
 AND status = 'completed' AND ended_at > ?`,
    )
    .get(...ids, at).n;
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
function liveChecks(stored, { shelf, lapse, live, offerStale, display, promotion, viewer, confirmed, attributes, list = [], shelfUnits = null, units = null, earlier = null }) {
  const none = live?.check && live.check.in_stock !== 1 ? live.check : null;
  return stored.map((c) => {
    // Demand and the shelf count as they stand now (R3Q3, R3B1).
    if (c.id === "demand") {
      if (list.some((b) => b.id === "competition-lapsed"))
        return { ...c, ok: false, detail: "Competing listings are not known now, so demand for these units is not shown" };
      const aged = list.find((b) => b.id === "demand-aged");
      if (aged) return { ...c, ok: false, detail: aged.text };
      // Units earlier bounties for the item still have against its demand
      // (round 5): the check's own figure does not count them.
      const owed = earlierNote(earlier);
      if (owed) return { ...c, detail: `${c.detail ? withStop(c.detail) + " " : ""}${upperFirst(owed)}` };
    }
    if (c.id === "shelf-units" && Number.isSafeInteger(shelfUnits?.units) && Number.isSafeInteger(units) && shelfUnits.units < units)
      return { ...c, ok: false, detail: `Only about ${shelfUnits.units} likely left on the shelf, fewer than the ${units} planned` };
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
 * Units earlier bounties for the item still have against its demand, for
 * the card (round 5): { units, outstanding, held, bought, released, note,
 * release, binding, claims } from capNow's earlier, or null when there are
 * none. claims are the completed claims with units outstanding: every one
 * for the operator (with the member's name), only their own for a member,
 * none for a visitor.
 */
function earlierView(db, e, { isOperator = false, me = null } = {}) {
  if (!isObject(e) || !(e.units > 0)) return null;
  const name = db.prepare("SELECT name FROM members WHERE id = ?");
  return {
    units: e.units,
    outstanding: e.outstanding,
    held: e.held,
    bought: e.bought,
    released: e.released,
    bounties: e.bounties,
    note: earlierNote(e),
    release: earlierRelease(e),
    binding: e.binding === true,
    capWithout: Number.isSafeInteger(e.capWithout) ? e.capWithout : null,
    claims: (e.claims ?? [])
      .filter((c) => isOperator || c.memberId === me)
      .map((c) => ({
        ...c,
        mine: c.memberId === me,
        memberName: isOperator || c.memberId === me ? (name.get(c.memberId)?.name ?? null) : null,
      })),
  };
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
  // Puts the cap worked out now on `bounty` (syncTrip, capNow).
  const synced = syncTrip(db, bounty, now, live);
  const held = claimedUnits(db, bounty.id, now);
  // Never more than the units left on the shelf after the claims ahead (R3M5).
  const remaining = Math.max(
    0,
    Math.min(bounty.cap - held.committed, synced.room === null ? Infinity : synced.room - held.active),
  );
  const basis = json(bounty.cap_basis, null);
  const snapshot = json(bounty.estimate, null);
  // The latest stock report, its pause lifted by a branch check after it.
  const shelf = shelfNow(db, bounty, live);
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
    live,
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
  const trip = tripState(db, bounty, now, list, { memberId: viewer.kind === "member" ? viewer.member.id : null, live });
  const claimRows = db
    .prepare(
      `SELECT c.*, m.name AS member_name FROM claims c JOIN members m ON m.id = c.member_id
 WHERE c.bounty_id = ? ORDER BY c.created DESC, c.id DESC`,
    )
    .all(bounty.id)
    .map(plain)
    .filter((c) => isOperator || c.member_id === me);
  // Units bought through each completed claim that are released (recorded
  // as sold, returned or reconciled) and still outstanding (round 5).
  const releasedHere = releasedOn(db, claimRows.filter((c) => c.status === "completed").map((c) => c.id));
  const claims = claimRows
    .map((c) => {
      const active = c.status === "active" && Date.parse(c.expires_at) > at;
      const r = c.status === "completed" ? (releasedHere.get(c.id) ?? noReleases()) : null;
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
        // The cash the member said they can spend on this trip (their own
        // claims only), and whether a live claim stores none: a claim made
        // before the cash was asked for (round 5b) asks for it under the claim.
        cashAvailable: c.member_id === me ? claimCash(c) : null,
        needsCash: active && claimCash(c) === null,
        // Round 5: for units bought, what is recorded as sold, returned or
        // reconciled, and what still counts against the demand for the item.
        released: r ? { sold: r.sold, returned: r.returned, reconciled: r.reconciled } : null,
        outstanding: r ? Math.max(0, c.units - Math.min(c.units, r.total)) : null,
        releases: r && r.total > 0 ? releasesOf(db, c.id) : [],
      };
    });
  const alertBlockers = [...blockers];
  if (!blockers.length && synced.over && synced.headline) alertBlockers.push(synced.headline);
  if (remaining <= 0) alertBlockers.push(capFullMessage(bounty, synced.earlier));
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
  // A count that lapsed since the re-check says so, never "nobody looked".
  if (live.competition?.lapsed && live.competition.text) resale.note = `${live.competition.text}.`;
  if (resale.competingListings === null && !resale.note && snapshot?.competition?.note) resale.note = snapshot.competition.note;
  const opportunity = stored
    ? {
        ...stored,
        ...tierNow(stored, { resale, sourcing, live, list }),
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
      // "You said you have already used a first-order offer at Argos, so
      // this bounty is not for you" (or do not qualify, or bought at it).
      if (standing?.declined && !active) own.push(standing.notForYou);
    }
    // The member's own transport, carry limit and storage (round 5): for
    // their live claim's units, otherwise the units the figures are for.
    // With no stored profile, or when not even one unit fits, they cannot
    // claim; when fewer units fit, the claim is limited to those.
    const fitUnits = bounty.sample ? null : offeredUnits(db, bounty, viewer.member, now);
    const fit = fitUnits
      ? bountyFit(bounty, viewer.member, fitUnits.units, roomFor(db, bounty, viewer.member.id, now))
      : null;
    if (fit && !blockers.length && !active) {
      if (!fit.complete) own.push(profileNeeded(fit.missing));
      else if (!(fit.maxUnits.all >= 1)) own.push(...fit.reasons);
    }
    const fitMost = fit && fit.complete && Number.isSafeInteger(fit.maxUnits.all) ? fit.maxUnits.all : fit ? 0 : null;
    // What sets the most they can claim now, in words (round 5b): the
    // smallest of their trial batch, what is left under the cap and what
    // fits their load limit and room at home.
    const fitWords =
      fit && fit.complete && fitMost !== null
        ? fit.maxUnits.load === fitMost && fit.maxUnits.storage === fitMost
          ? "what fits your load limit and your room at home"
          : fit.maxUnits.storage === fitMost
            ? "what fits your room at home"
            : "what fits your load limit"
        : null;
    let claimLimit = { units: trial.allowance, words: "your trial batch" };
    if (remaining < claimLimit.units) claimLimit = { units: remaining, words: "what is left under the cap" };
    if (fitWords && fitMost < claimLimit.units) claimLimit = { units: fitMost, words: fitWords };
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
      maxClaimUnits: Math.max(0, Math.min(trial.allowance, remaining, fitMost ?? Infinity)),
      claimLimit: claimLimit.words,
      // The member's stored trip profile and whether this trip fits it
      // (load and storage; the cash they can spend is checked when they
      // claim). checks are suitability.mjs checks in plain words.
      profile: memberProfileView(viewer.member, homeStock(db, viewer.member.id, { now })),
      fit: fit
        ? {
            ok: fit.ok,
            complete: fit.complete,
            units: fit.units,
            figures: fit.figures,
            partial: fit.partial,
            maxUnits: fit.complete ? fit.maxUnits.all : null,
            missing: fit.missing,
            loadLimitKg: fit.loadLimitKg,
            checks: fit.checks,
            note: !fit.complete
              ? profileNeeded(fit.missing)
              : fit.partial
                ? `At most ${plural(fit.maxUnits.all, "unit")} ${fit.maxUnits.all === 1 ? "fits" : "fit"} your profile${
                    fit.figures !== null && fit.figures > fit.maxUnits.all ? `, and the figures on this card are for ${fit.figures}: check your own figures for ${plural(fit.maxUnits.all, "unit")} before you claim` : ""
                  }`
                : null,
            // A holder's cash is the figure stored with their claim (round 5b).
            cash:
              active && claimCash(claimRows.find((c) => c.id === active.id)) !== null
                ? `The cash you can spend on this trip is the ${pounds(claimCash(claimRows.find((c) => c.id === active.id)))} stored with your claim, checked with your figures, not here: change it under your claim if it is wrong`
                : active
                  ? "Your claim stores no cash you can spend on this trip yet: enter it under your claim, and it is checked with your figures"
                  : "The cash you can spend on this trip is asked when you claim and checked against the cash the trip needs before any payout",
          }
        : null,
      promotion:
        promotion?.needsMemberConfirmation && !hidden
          ? {
              condition: promotion.condition,
              // Never confirmed once the price is not for them (round 4, N2).
              confirmed: !standing?.declined && (Boolean(active?.promotionConfirmed) || Boolean(standing?.confirmed)),
              risk: promotionRisk(promotion, figuresHidden ? null : stored?.unitProfit),
            }
          : null,
      // The promotion question and this member's answer (null when the
      // figures do not depend on a promotion).
      eligibility: hidden ? null : standing,
      stop: trip.go ? null : trip.headline,
      notices: memberNotices(db, viewer.member.id, { bountyId: bounty.id }),
      // Units they bought through bounties for this item and have not
      // recorded as sold or returned, with no seller name on their profile,
      // while competing listings are counted: any they list count twice
      // (round 5b).
      sellerNote: viewerSellerNote(db, bounty, viewer.member, basis, now),
    };
  }
  const attributes = bounty.sample || hidden ? [] : attributeNotes(snapshot?.offer);
  const sharedChecks = liveChecks(Array.isArray(snapshot?.alert?.checks) ? snapshot.alert.checks : [], {
    shelf,
    lapse,
    live,
    offerStale,
    display,
    promotion,
    viewer,
    confirmed: !standing?.declined && (Boolean(viewerInfo?.activeClaim?.promotionConfirmed) || Boolean(standing?.confirmed)),
    attributes,
    list,
    shelfUnits,
    units: Number.isSafeInteger(snapshot?.economics?.units) ? snapshot.economics.units : (snapshot?.units?.figures ?? null),
    earlier: synced.earlier,
  });
  // For a member, the shared "checked for each member" line is their own
  // load and storage checks (round 5); the cash is checked when they claim.
  const memberFitChecks = viewerInfo?.fit
    ? viewerInfo.fit.complete
      ? viewerInfo.fit.checks
      : [{ id: "member-fit", ok: false, detail: profileNeeded(viewerInfo.fit.missing) }]
    : null;
  const checks = memberFitChecks
    ? [...sharedChecks.filter((c) => c.id !== "member-fit"), ...memberFitChecks]
    : sharedChecks;
  const economics = figuresHidden ? null : (snapshot?.economics ?? null);
  const validation = bounty.sample ? null : validationStatus(db, bounty.locality, cache);
  const checked = checkedLabels(bounty, snapshot, live, shelfUnits);
  // A member the bounty is not for (standing.declined) reads that instead.
  const figuresNote =
    figuresHidden && !standing?.declined
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
    // Round 5: units earlier bounties for the item still have against its
    // demand, and how they stop counting (null when there are none).
    earlier: earlierView(db, synced.earlier, { isOperator, me }),
    // For the operator only (round 5b): members holding units bought through
    // bounties for this item, with the seller name each gave and whether it
    // is confirmed. Their listings count once only after the operator checks
    // the name against their marketplace profile or a listing and confirms it.
    sellerNames: isOperator && !bounty.sample ? sellerNamesView(db, bounty, now) : null,
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
    // Never the sale estimate while the figures are hidden (R3Q9).
    mainUncertainty: hidden
      ? null
      : uncertaintyFor(bounty, snapshot, list, { showFigures: !figuresHidden, condition: standing?.declined ? null : promotion?.condition }),
    accessNeeds: accessFor(bounty, shelfUnits, viewer.kind === "member" ? viewer.member : null),
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
            // While the figures are hidden, no sale estimate or asking price.
            sample: figuresHidden && snapshot.sample ? { ...snapshot.sample, lowerMedian: null } : snapshot.sample,
            competition:
              figuresHidden && snapshot.competition ? { ...snapshot.competition, lowestAsking: null } : snapshot.competition,
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
 * Whether a bounty is listed to a viewer. A first-order or new-customer
 * price is for people who genuinely qualify, so it is never listed to a
 * visitor, nor to a member who said they do not qualify or who used such an
 * offer at the retailer (said so or bought at such a price), unless they
 * hold or held a claim on it. The operator sees every bounty.
 */
export function listedFor(db, bounty, viewer) {
  if (viewer?.kind === "operator" || bounty.sample) return true;
  const promotion = promotionOf(bounty);
  if (!promotion?.needsMemberConfirmation || !isFirstOrderOffer(promotion.condition)) return true;
  if (viewer?.kind !== "member") return false;
  if (!promotionStanding(db, bounty, viewer.member)?.declined) return true;
  return Boolean(
    db
      .prepare("SELECT 1 FROM claims WHERE bounty_id = ? AND member_id = ? AND status IN ('active', 'completed') LIMIT 1")
      .get(bounty.id, viewer.member.id),
  );
}

/**
 * Bounties for a viewer (listedFor): open ones first, then newest. Each is
 * re-evaluated against the evidence now before it is shown (bountyView),
 * and the pilot validation status is read once per locality.
 */
export function listBounties(db, { viewer, now }) {
  const at = iso(clock(now));
  const cache = new Map();
  return db
    .prepare(
      `SELECT * FROM bounties ORDER BY (status = 'open' AND expires_at > ?) DESC, created DESC, id DESC LIMIT 200`,
    )
    .all(at)
    .map(plain)
    .filter((b) => listedFor(db, b, viewer))
    .map((b) => bountyView(db, b, { viewer, now, cache }));
}
