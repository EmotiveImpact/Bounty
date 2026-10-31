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
  MEMBERSHIP_TIERS,
  OPPORTUNITY_RULES,
  PAID_TIER_IDS,
  accessTier,
  membershipTier,
} from "./opportunity.mjs";
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
 created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
    columns: ["id", "name", "locality", "paid_tier", "paid_until", "alerts_opt_in", "alert_localities", "created"],
    types: {
      alerts_opt_in: "INTEGER NOT NULL DEFAULT 0",
      alert_localities: "TEXT NOT NULL DEFAULT '[]'",
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
 ended_at TEXT
)`,
    columns: ["id", "bounty_id", "member_id", "units", "status", "created", "expires_at", "ended_at"],
    types: {
      bounty_id: "INTEGER",
      member_id: "INTEGER",
      units: "INTEGER NOT NULL DEFAULT 0",
      status: "TEXT NOT NULL DEFAULT 'active'",
      expires_at: "TEXT NOT NULL DEFAULT ''",
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
    name: "alerts",
    sql: `CREATE TABLE IF NOT EXISTS alerts (
 id INTEGER PRIMARY KEY,
 bounty_id INTEGER NOT NULL REFERENCES bounties(id),
 member_id INTEGER NOT NULL REFERENCES members(id),
 tier TEXT NOT NULL,
 via TEXT NOT NULL,
 release_at TEXT NOT NULL,
 reputation INTEGER NOT NULL DEFAULT 0,
 created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(bounty_id, member_id)
)`,
    columns: ["id", "bounty_id", "member_id", "tier", "via", "release_at", "reputation", "created"],
    types: {
      bounty_id: "INTEGER",
      member_id: "INTEGER",
      tier: "TEXT NOT NULL DEFAULT 'new'",
      via: "TEXT NOT NULL DEFAULT 'earned'",
      release_at: "TEXT NOT NULL DEFAULT ''",
      reputation: "INTEGER NOT NULL DEFAULT 0",
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
CREATE INDEX IF NOT EXISTS bounties_barcode ON bounties(barcode, status);`);
}

// --------------------------------------------------------------- helpers

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const iso = (ms) => new Date(ms).toISOString();
const plain = (row) => (row ? { ...row } : null);
const round2 = (v) => Math.round(v * 100) / 100;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isPositive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

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

/** Localities compare without case or repeated spaces. */
export const normaliseLocality = (value) =>
  String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();

const id = (value, name) => int(value, name, 1, Number.MAX_SAFE_INTEGER);

// ------------------------------------------------------------ membership

/** Paid access runs to the end of the paid-until date (UTC). */
const paidUntilInstant = (date) => (date ? iso(Date.parse(date + "T00:00:00Z") + DAY) : null);

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

function memberFields(body, current) {
  if (!isObject(body)) fail("Send a member as a JSON object");
  const has = (k) => Object.hasOwn(body, k);
  const next = current
    ? { ...current, alert_localities: json(current.alert_localities, []) }
    : { name: null, locality: null, paid_tier: null, paid_until: null, alerts_opt_in: 0, alert_localities: [] };
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
    created: member.created,
    paid: {
      label: "Paid early access",
      tier: tierSummary(membershipTier(member.paid_tier)),
      until: member.paid_until,
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
      `INSERT INTO members(name, locality, paid_tier, paid_until, alerts_opt_in, alert_localities, created)
 VALUES(?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(m.name, m.locality, m.paid_tier, m.paid_until, m.alerts_opt_in, JSON.stringify(m.alert_localities), now);
  return getMember(db, Number(result.lastInsertRowid));
}

/** Updates name, locality, alert opt-in and localities, or the paid tier. */
export function updateMember(db, memberId, body, { now }) {
  clock(now);
  const current = requireMember(db, memberId);
  const m = memberFields(body, current);
  db.prepare(
    `UPDATE members SET name = ?, locality = ?, paid_tier = ?, paid_until = ?, alerts_opt_in = ?, alert_localities = ?
 WHERE id = ?`,
  ).run(m.name, m.locality, m.paid_tier, m.paid_until, m.alerts_opt_in, JSON.stringify(m.alert_localities), current.id);
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
 * The figures behind a live bounty's cap. The operator's entries can only be
 * lowered by the evidence: available units by the latest stock check's count,
 * and sales a week by the confirmed sales rate. Competing listings come from
 * the estimate's resale competition. Unknown evidence fails closed.
 */
function capBasis(entered, estimate) {
  const units = evidencedUnits(estimate.stock);
  const rate = evidencedSalesPerWeek(estimate.sample?.count);
  const listings = estimate.competition?.activeListings;
  const sellers = estimate.competition?.sellers;
  const used = {
    availableUnits: units === null ? entered.availableUnits : Math.min(entered.availableUnits, units),
    salesPerWeek: rate === null ? null : Math.min(entered.salesPerWeek, rate),
    sellWindowWeeks: entered.sellWindowWeeks,
    competingListings: isCount(listings) ? listings : null,
  };
  const notes = [];
  if (units !== null && units < entered.availableUnits)
    notes.push(`Available units lowered to ${units}, the count on the latest stock check`);
  if (rate === null) notes.push("No confirmed sales count, so the cap is 0");
  else if (rate < entered.salesPerWeek)
    notes.push(
      `Sales a week lowered to ${round2(rate)}: ${estimate.sample.count} confirmed sales over ${BOUNTY_RULES.saleWindowDays} days`,
    );
  if (used.competingListings === null) notes.push("Competing listings unknown, so the cap is 0");
  return {
    entered,
    evidence: {
      unitsSeen: units,
      salesPerWeek: rate === null ? null : round2(rate),
      confirmedSales: isCount(estimate.sample?.count) ? estimate.sample.count : null,
      competingListings: used.competingListings,
      competingSellers: isCount(sellers) ? sellers : null,
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
    "unitPrice", "weightKg", "salesPerWeek", "resaleWeeksOfSupply",
  ]);
}

/**
 * What a bounty keeps from an estimate: the request (so the server can
 * re-check the evidence later) and the key results. No credentials are ever
 * part of an estimate.
 */
function estimateSnapshot(estimate, request, at) {
  const e = estimate.economics;
  return {
    request: request ?? null,
    checkedAt: iso(at),
    offer: pick(estimate.offer, [
      "provider", "sourceId", "title", "price", "observed", "retailer", "location", "gtin", "variant",
      "source", "stockNote", "sample", "expired", "ageDays", "promotion",
    ]),
    unitCost: estimate.unitCost ?? null,
    match: estimate.match ?? null,
    sample: pick(estimate.sample, ["count", "independent", "lowerMedian", "daysToSell", "newest", "oldest"]),
    competition: pick(estimate.competition, ["activeListings", "sellers", "lowestAsking", "lowestAskingIncludesShipping"]),
    economics: e
      ? pick(e, [
          "units", "unitCost", "salePrice", "proceeds", "costs", "totalCosts", "contribution",
          "unitContribution", "cashRequired", "journeyPerUnit", "activeMinutes", "activeHours", "hourly",
          "unsoldLoss", "breakEvenSale",
        ])
      : null,
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
    warnings: Array.isArray(estimate.warnings) ? estimate.warnings.map(String) : [],
  };
}

/** Alert eligibility from estimate.alert (evaluateAlert, fail closed). */
function alertFrom(estimate) {
  const eligible = estimate?.alert?.eligible === true;
  const reasons = Array.isArray(estimate?.alert?.reasons) ? estimate.alert.reasons.map(String) : [];
  if (!eligible && !reasons.length) reasons.push("Buy-alert checks are missing or did not pass");
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
    availableUnits: int(input.availableUnits, "availableUnits", 1, BOUNTY_RULES.maxAvailableUnits),
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
 *   can be re-checked before claims and alerts.
 *
 * A sample bounty has no estimate, is labelled Sample everywhere and can
 * never alert. Only one live bounty may be open per barcode, because the cap
 * shares out the resale demand for the item and two bounties would double it.
 */
export function createBounty(db, input, { estimate = null, request = null, now } = {}) {
  const at = clock(now);
  if (!isObject(input)) fail("Send a bounty as a JSON object");
  const sample = input.sample === undefined ? false : bool(input.sample, "sample");
  const f = bountyFields(input, at);
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
    const basis = capBasis(entered, estimate);
    const alert = alertFrom(estimate);
    row = {
      ...f,
      barcode: gtin,
      variant: offer.variant ?? null,
      competingListings: basis.evidence.competingListings,
      competingSellers: basis.evidence.competingSellers,
      cap: basis.cap,
      capBasis: basis,
      alertEligible: alert.eligible,
      alertReasons: alert.reasons,
      opportunity: opportunitySnapshot(estimate),
      snapshot: estimateSnapshot(estimate, request, at),
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
export function refreshBounty(db, bountyId, estimate, now) {
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
    return getBounty(db, bounty.id);
  }
  const entered = json(bounty.cap_basis, {})?.entered ?? {
    availableUnits: bounty.available_units,
    salesPerWeek: bounty.sales_per_week,
    sellWindowWeeks: bounty.sell_window_weeks,
  };
  const basis = capBasis(entered, estimate);
  const alert = alertFrom(estimate);
  const gtin = estimate.offer?.gtin;
  if (gtin !== bounty.barcode) {
    alert.eligible = false;
    alert.reasons = ["The re-checked offer no longer has this bounty's barcode"];
  }
  const opportunity = opportunitySnapshot(estimate);
  const snapshot = estimateSnapshot(estimate, old.request ?? null, at);
  db.prepare(
    `UPDATE bounties SET competing_listings = ?, competing_sellers = ?, cap = ?, cap_basis = ?, alert_eligible = ?,
 alert_reasons = ?, opportunity_tier = ?, opportunity = ?, estimate = ?, checked_at = ? WHERE id = ?`,
  ).run(
    basis.evidence.competingListings, basis.evidence.competingSellers, basis.cap, JSON.stringify(basis),
    alert.eligible ? 1 : 0, JSON.stringify(alert.reasons), opportunity.tier, JSON.stringify(opportunity),
    JSON.stringify(snapshot), iso(at), bounty.id,
  );
  return getBounty(db, bounty.id);
}

/** Withdraws a bounty and releases its active claims. */
export function withdrawBounty(db, bountyId, { now }) {
  const at = iso(clock(now));
  return transaction(db, () => {
    const bounty = requireBounty(db, bountyId);
    if (bounty.status === "withdrawn") fail("This bounty is already withdrawn", 409);
    db.prepare("UPDATE bounties SET status = 'withdrawn', withdrawn_at = ? WHERE id = ?").run(at, bounty.id);
    db.prepare("UPDATE claims SET status = 'released', ended_at = ? WHERE bounty_id = ? AND status = 'active'").run(
      at,
      bounty.id,
    );
    return getBounty(db, bounty.id);
  });
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

/** The offer age in days from a live bounty's latest evidence, or null. */
function offerAge(bounty, now) {
  const observed = json(bounty.estimate, null)?.offer?.observed;
  return observed ? ageDays(observed, now) : null;
}

/**
 * Why a bounty cannot send members on a trip right now (claims and alerts),
 * in order. Empty when it can.
 */
export function tripBlockers(db, bounty, now) {
  const blockers = [];
  const status = bountyStatus(bounty, now);
  if (status === "withdrawn") blockers.push("This bounty has been withdrawn");
  if (status === "expired") blockers.push("This bounty has expired");
  if (!bounty.sample) {
    if (bounty.alert_eligible !== 1)
      blockers.push("The buy-alert checks do not pass: " + json(bounty.alert_reasons, []).join("; "));
    const age = offerAge(bounty, now);
    if (age === null || age < 0 || age > ALERT_RULES.maxOfferAgeDays)
      blockers.push(`The offer price is not from the last ${ALERT_RULES.maxOfferAgeDays} days`);
  }
  if (shelfStatus(db, bounty.id).paused)
    blockers.push("The latest stock report found none on the shelf: paused until someone reports stock again");
  return blockers;
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
 * Claims units on a bounty inside BEGIN IMMEDIATE, so concurrent claims
 * serialise and the cap cannot be oversubscribed. Stale claims expire first.
 * The bounty must be open and unexpired, pass its buy-alert checks (or be a
 * labelled sample), not be paused by a negative report, and be inside the
 * member's release window. One active claim per member per bounty; at most a
 * trial batch of units; the units held plus the new units must fit the cap.
 * A claim reserves attention, not retailer stock.
 */
export function claim(db, { bountyId, memberId, units, now }) {
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
    const release = releaseFor(db, bounty, member, now);
    if (!release.open)
      fail(
        `Your release window for this bounty opens at ${release.releaseAt} (${release.tier.name}, via ${release.via === "paid" ? "paid early access" : "earned reputation"}).`,
        409,
      );
    const existing = db
      .prepare("SELECT id FROM claims WHERE bounty_id = ? AND member_id = ? AND status = 'active'")
      .get(bounty.id, member.id);
    if (existing) fail("You already have an active claim on this bounty. Release it before claiming again.", 409);
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
    const result = db
      .prepare("INSERT INTO claims(bounty_id, member_id, units, status, created, expires_at) VALUES(?, ?, ?, 'active', ?, ?)")
      .run(bounty.id, member.id, count, iso(at), iso(at + BOUNTY_RULES.claimHours * HOUR));
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
 * receipt and the payout record in the Ledger.
 */
export function completeClaim(db, { claimId, memberId, unitsBought, now }) {
  const at = iso(clock(now));
  return transaction(db, () => {
    const found = activeClaimFor(db, claimId, memberId, now);
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
 * shelf), which pauses claims and alerts until a later positive report.
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
      return getReport(db, Number(result.lastInsertRowid));
    } catch (error) {
      if (saved?.created) unlinkSync(saved.path);
      throw error;
    }
  });
}

const getReport = (db, reportId) => plain(db.prepare("SELECT * FROM stock_reports WHERE id = ?").get(reportId));

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
  if (!latest) return { state: "unknown", paused: false, at: null, unitsSeen: null, verified: null };
  const none = latest.units_seen === 0;
  return {
    state: none ? "none" : "seen",
    paused: none,
    at: latest.observed_at,
    unitsSeen: latest.units_seen,
    verified: latest.verified,
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
 * check, so the estimate's branch stock check can use it.
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
 * its buy-alert checks, has a fresh offer, is not paused by a negative stock
 * report and has room under its cap. Then only members who opted in and list
 * the bounty's locality are considered, each at most once. A member becomes
 * due when now is at least bounty.created plus their tier's offsetMinutes
 * (paid tier while current, or earned tier, whichever is earlier), so calling
 * again later releases further tiers. Due members are ordered by window, then
 * by earned reputation. The exposure limit allows at most 2 x remaining cap
 * alerts in total per bounty, so with little stock later tiers receive
 * nothing.
 *
 * Returns { bountyId, sent, notAlerted, blockers, exposure, nextReleaseAt }.
 */
export function dispatchAlerts(db, bountyId, now) {
  const at = clock(now);
  return transaction(db, () => {
    expireClaims(db, now);
    const bounty = requireBounty(db, bountyId);
    const held = claimedUnits(db, bounty.id, now);
    const remaining = Math.max(0, bounty.cap - held.committed);
    const alreadySent = db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE bounty_id = ?").get(bounty.id).n;
    const limit = BOUNTY_RULES.exposurePerUnit * remaining;
    const exposure = {
      cap: bounty.cap,
      committed: held.committed,
      remaining,
      limit,
      alreadySent,
      budget: Math.max(0, limit - alreadySent),
    };
    const blockers = [];
    if (bounty.sample) blockers.push("Sample bounty: illustrative figures never send an alert");
    blockers.push(...tripBlockers(db, bounty, now));
    if (remaining <= 0) blockers.push(capFullMessage(bounty));
    const result = { bountyId: bounty.id, sent: [], notAlerted: [], blockers, exposure, nextReleaseAt: null };
    if (blockers.length) return result;

    const locality = normaliseLocality(bounty.locality);
    const alerted = new Set(
      db.prepare("SELECT member_id FROM alerts WHERE bounty_id = ?").all(bounty.id).map((r) => r.member_id),
    );
    const claimed = new Set(
      db
        .prepare("SELECT member_id FROM claims WHERE bounty_id = ? AND status IN ('active', 'completed')")
        .all(bounty.id)
        .map((r) => r.member_id),
    );
    const due = [];
    let next = null;
    for (const member of listMembers(db)) {
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
      if (alerted.has(member.id)) {
        result.notAlerted.push({ ...who, reason: "Already alerted for this bounty" });
        continue;
      }
      if (claimed.has(member.id)) {
        result.notAlerted.push({ ...who, reason: "Already claimed this bounty" });
        continue;
      }
      const release = releaseFor(db, bounty, member, now);
      if (!release.open) {
        result.notAlerted.push({
          ...who,
          reason: `Release window opens at ${release.releaseAt} (${release.tier.name}, via ${release.via === "paid" ? "paid early access" : "earned reputation"})`,
          releaseAt: release.releaseAt,
        });
        if (!next || release.releaseAt < next) next = release.releaseAt;
        continue;
      }
      due.push({ member, release });
    }
    // Earlier window first; within a window, more earned reputation first.
    due.sort(
      (a, b) =>
        a.release.tier.offsetMinutes - b.release.tier.offsetMinutes ||
        b.release.points - a.release.points ||
        a.member.id - b.member.id,
    );
    const insert = db.prepare(
      "INSERT INTO alerts(bounty_id, member_id, tier, via, release_at, reputation, created) VALUES(?, ?, ?, ?, ?, ?, ?)",
    );
    due.forEach(({ member, release }, index) => {
      const who = { memberId: member.id, name: member.name };
      if (index >= exposure.budget) {
        result.notAlerted.push({
          ...who,
          reason: `Exposure limit reached: at most ${BOUNTY_RULES.exposurePerUnit} alerts per unit left under the cap`,
        });
        return;
      }
      insert.run(bounty.id, member.id, release.tier.id, release.via, release.releaseAt, release.points, iso(at));
      result.sent.push({
        ...who,
        tier: release.tier,
        via: release.via,
        label: release.via === "paid" ? "Paid early access" : "Earned release",
        reputation: release.points,
        releaseAt: release.releaseAt,
      });
    });
    result.exposure.alreadySent = alreadySent + result.sent.length;
    result.exposure.budget = Math.max(0, limit - result.exposure.alreadySent);
    result.nextReleaseAt = result.exposure.budget > 0 ? next : null;
    return result;
  });
}

/** A member's alerts, newest first, with the bounty they point to. */
export function memberAlerts(db, memberId, { now }) {
  const member = requireMember(db, memberId);
  return db
    .prepare(
      `SELECT a.*, b.title, b.retailer, b.locality, b.sponsored, b.sponsor, b.sample, b.expires_at, b.status
 FROM alerts a JOIN bounties b ON b.id = a.bounty_id WHERE a.member_id = ? ORDER BY a.created DESC, a.id DESC`,
    )
    .all(member.id)
    .map((a) => ({
      id: a.id,
      bountyId: a.bounty_id,
      title: a.title,
      retailer: a.retailer,
      locality: a.locality,
      sponsored: a.sponsored === 1,
      sponsor: a.sponsor,
      created: a.created,
      releaseAt: a.release_at,
      tier: tierSummary(membershipTier(a.tier)),
      via: a.via,
      label: a.via === "paid" ? "Paid early access" : "Earned release",
      bountyStatus: bountyStatus({ status: a.status, expires_at: a.expires_at }, now),
    }));
}

// ------------------------------------------------------------------- views

/**
 * Sourcing pressure: people heading to the shelf relative to the units
 * there. Each active claimed unit and each positive stock report in the last
 * 24 hours counts once. Null ratio when available units are unknown.
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
 * of supply already on the market. Null when either figure is unknown.
 */
export function resaleCompetition({ competingListings, competingSellers = null, salesPerWeek }) {
  const weeksOfSupply =
    isCount(competingListings) && isPositive(salesPerWeek) ? round2(competingListings / salesPerWeek) : null;
  const note =
    competingListings === 0
      ? "No active listings recorded. That can mean nobody has looked, so it is not proof of low competition."
      : null;
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

/** A bounty as the API shows it to a viewer. */
export function bountyView(db, bounty, { viewer = { kind: "public" }, now }) {
  const at = clock(now);
  const status = bountyStatus(bounty, now);
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
  const usedUnits = basis?.used?.availableUnits ?? bounty.available_units;
  const usedRate = basis?.used ? basis.used.salesPerWeek : bounty.sales_per_week;
  const isOperator = viewer.kind === "operator";
  const me = viewer.kind === "member" ? viewer.member.id : null;
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
  const claims = db
    .prepare(
      `SELECT c.*, m.name AS member_name FROM claims c JOIN members m ON m.id = c.member_id
 WHERE c.bounty_id = ? ORDER BY c.created DESC, c.id DESC`,
    )
    .all(bounty.id)
    .map(plain)
    .filter((c) => isOperator || c.member_id === me)
    .map((c) => ({
      id: c.id,
      memberId: c.member_id,
      memberName: c.member_name,
      units: c.units,
      status: c.status === "active" && Date.parse(c.expires_at) <= at ? "expired" : c.status,
      created: c.created,
      expiresAt: c.expires_at,
      endedAt: c.ended_at,
    }));
  const blockers = tripBlockers(db, bounty, now);
  const alertBlockers = [...blockers];
  if (bounty.sample) alertBlockers.unshift("Sample bounty: illustrative figures never send an alert");
  if (remaining <= 0) alertBlockers.push(capFullMessage(bounty));
  const alertsSent = db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE bounty_id = ?").get(bounty.id).n;
  let viewerInfo = null;
  if (viewer.kind === "member") {
    const release = releaseFor(db, bounty, viewer.member, now);
    const alert = db
      .prepare("SELECT created FROM alerts WHERE bounty_id = ? AND member_id = ?")
      .get(bounty.id, viewer.member.id);
    viewerInfo = {
      memberId: viewer.member.id,
      release,
      alertedAt: alert?.created ?? null,
      activeClaim: claims.find((c) => c.status === "active") ?? null,
      canClaim: !blockers.length && release.open && remaining > 0 && !claims.some((c) => c.status === "active"),
    };
  }
  const economics = snapshot?.economics ?? null;
  return {
    id: bounty.id,
    title: bounty.title,
    barcode: bounty.barcode,
    variant: bounty.variant,
    retailer: bounty.retailer,
    locality: bounty.locality,
    sample: bounty.sample === 1,
    sponsored: bounty.sponsored === 1,
    sponsor: bounty.sponsor,
    placement: bounty.sponsored === 1 ? `Sponsored by ${bounty.sponsor}` : null,
    status,
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
      sent: alertsSent,
      exposureLimit: BOUNTY_RULES.exposurePerUnit * remaining,
    },
    claimBlockers: blockers,
    maxClaimUnits: trialBatch(bounty),
    opportunity: json(bounty.opportunity, null),
    pressure: {
      sourcing: sourcingPressure({
        activeClaimedUnits: held.active,
        recentPositiveReports: recentPositive,
        availableUnits: usedUnits,
      }),
      resale: resaleCompetition({
        competingListings: bounty.competing_listings,
        competingSellers: bounty.competing_sellers,
        salesPerWeek: usedRate,
      }),
    },
    shelf,
    reports: {
      total: reports.length,
      positive: reports.filter((r) => r.units_seen > 0).length,
      negative: reports.filter((r) => r.units_seen === 0).length,
      latestAt: reports[0]?.observed_at ?? null,
      items: reports.map(reportView),
    },
    claims,
    estimate: snapshot
      ? {
          checkedAt: snapshot.checkedAt,
          offer: snapshot.offer,
          unitCost: snapshot.unitCost,
          match: snapshot.match,
          sample: snapshot.sample,
          competition: snapshot.competition,
          economics,
          stock: snapshot.stock,
          checks: snapshot.alert?.checks ?? [],
          warnings: snapshot.warnings ?? [],
        }
      : null,
    viewer: viewerInfo,
    terms: TERMS,
  };
}

/** Bounties for a viewer: open ones first, then newest. */
export function listBounties(db, { viewer, now }) {
  const at = iso(clock(now));
  return db
    .prepare(
      `SELECT * FROM bounties ORDER BY (status = 'open' AND expires_at > ?) DESC, created DESC, id DESC LIMIT 200`,
    )
    .all(at)
    .map((b) => bountyView(db, plain(b), { viewer, now }));
}
