import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryDb, serve } from "./test-support.mjs";
import {
  BOUNTY_RULES,
  REPUTATION_RULES,
  addReport,
  bountyView,
  claim,
  completeClaim,
  createBounty,
  createMember,
  dispatchAlerts,
  distributionCap,
  memberView,
  preparePhoto,
  refreshBounty,
  releaseClaim,
  reputation,
  resolveViewer,
  schema,
  shelfStatus,
  updateMember,
  verifyReport,
  withdrawBounty,
} from "./bounties.mjs";
import { routes } from "./routes-bounties.mjs";

const T0 = "2026-11-02T09:00:00.000Z";
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60000).toISOString();
const GTIN = "05012345678900";

// A stand-in for an estimateFromEvidence result, so these tests never depend
// on the estimate module. 26 confirmed sales in 90 days is about 2.02 a week.
function fakeEstimate(over = {}) {
  return {
    offer: {
      provider: "awin",
      sourceId: "A1",
      title: "Travel kettle 0.5 l",
      price: 1500,
      observed: "2026-11-01",
      retailer: "Argos",
      gtin: GTIN,
      variant: "white",
      ...over.offer,
    },
    sample: { count: 26, independent: 6, lowerMedian: 3200, daysToSell: 5, ...over.sample },
    competition: { activeListings: 1, sellers: 1, lowestAsking: 3500, lowestAskingIncludesShipping: true, ...over.competition },
    match: "exact",
    unitCost: 1500,
    economics: {
      units: 2,
      unitCost: 1500,
      salePrice: 3200,
      contribution: 1500,
      unitContribution: 750,
      cashRequired: 3700,
      hourly: 1500,
      activeMinutes: 60,
      unsoldLoss: -3200,
      breakEvenSale: 2400,
    },
    opportunity: {
      tier: "Priority 2",
      reasons: ["Sourcing pressure high or unknown"],
      unitProfit: 750,
      returnOnCost: 0.5,
      targetPrice: null,
      meetsThresholds: true,
      trialUnits: 3,
      ...over.opportunity,
    },
    alert: { eligible: true, reasons: [], checks: [{ id: "live-evidence", ok: true, detail: "Imported evidence" }], ...over.alert },
    stock: {
      confirmed: true,
      availability: "in_stock",
      check: { in_stock: 1, units_seen: 10, checked_at: "2026-11-02T08:00:00.000Z" },
      ...over.stock,
    },
    warnings: [],
  };
}
const ineligible = (reason = "Branch stock not confirmed") =>
  fakeEstimate({ alert: { eligible: false, reasons: [reason], checks: [] } });

const bountyInput = (over = {}) => ({
  title: "Travel kettle",
  locality: "Camden",
  retailer: "Argos",
  availableUnits: 6,
  salesPerWeek: 3,
  sellWindowWeeks: 2,
  expiresAt: at(3 * 24 * 60),
  sponsored: false,
  ...over,
});
// Default fake: floor(2.02 * 2) = 4 sales in the window, less 1 listing = 3.
const liveBounty = (db, over = {}, estimate = fakeEstimate(), now = T0) =>
  createBounty(db, bountyInput(over), { estimate, request: { offer: { provider: "awin", sourceId: "A1" } }, now });
const sampleBounty = (db, over = {}) =>
  createBounty(db, bountyInput({ sample: true, competingListings: 2, competingSellers: 2, ...over }), { now: T0 });

const member = (db, name, over = {}) =>
  createMember(db, { name, alertsOptIn: true, alertLocalities: ["Camden"], ...over }, { now: T0 });
const diamond = (db, name, over = {}) => member(db, name, { paidTier: "diamond", paidUntil: "2026-12-31", ...over });
const grant = (db, memberId, points) =>
  db
    .prepare("INSERT INTO reputation_events(member_id, report_id, points, reason, created) VALUES(?, NULL, ?, 'test', ?)")
    .run(memberId, points, T0);

const status = (fn) => {
  try {
    fn();
  } catch (error) {
    return { status: error.status, message: error.message };
  }
  return { status: 0 };
};

test("distribution cap: units, resale demand less competing listings, fail closed", () => {
  assert.equal(distributionCap({ availableUnits: 10, salesPerWeek: 3, sellWindowWeeks: 2, competingListings: 2 }), 4);
  assert.equal(distributionCap({ availableUnits: 3, salesPerWeek: 3, sellWindowWeeks: 2, competingListings: 0 }), 3);
  assert.equal(distributionCap({ availableUnits: 10, salesPerWeek: 1, sellWindowWeeks: 2, competingListings: 5 }), 0);
  assert.equal(distributionCap({ availableUnits: 10, salesPerWeek: 0.29, sellWindowWeeks: 100, competingListings: 0 }), 10);
  assert.equal(distributionCap({ availableUnits: 50, salesPerWeek: 0.29, sellWindowWeeks: 100, competingListings: 0 }), 29);
  for (const bad of [
    { salesPerWeek: 3, sellWindowWeeks: 2, competingListings: 0 },
    { availableUnits: 5, salesPerWeek: null, sellWindowWeeks: 2, competingListings: 0 },
    { availableUnits: 5, salesPerWeek: 3, sellWindowWeeks: 0, competingListings: 0 },
    { availableUnits: 5, salesPerWeek: 3, sellWindowWeeks: 2, competingListings: null },
    { availableUnits: 5, salesPerWeek: 3, sellWindowWeeks: 2, competingListings: -1 },
    { availableUnits: 2.5, salesPerWeek: 3, sellWindowWeeks: 2, competingListings: 0 },
    { availableUnits: 5, salesPerWeek: Number.NaN, sellWindowWeeks: 2, competingListings: 0 },
  ])
    assert.equal(distributionCap(bad), 0);
  assert.equal(distributionCap(), 0);
});

test("a live bounty takes competition and eligibility from the estimate and caps on evidence", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db);
  assert.equal(b.barcode, GTIN);
  assert.equal(b.competing_listings, 1);
  assert.equal(b.competing_sellers, 1);
  assert.equal(b.cap, 3);
  assert.equal(b.alert_eligible, 1);
  assert.equal(b.opportunity_tier, "Priority 2");
  const basis = JSON.parse(b.cap_basis);
  assert.equal(basis.used.salesPerWeek, 2.02);
  assert.match(basis.notes.join(" "), /Sales a week lowered to 2.02: 26 confirmed sales/);
  const snapshot = JSON.parse(b.estimate);
  assert.deepEqual(snapshot.request, { offer: { provider: "awin", sourceId: "A1" } });
  assert.equal(snapshot.opportunity.tier, "Priority 2");

  // A stock check that saw two units lowers the available units.
  const db2 = memoryDb(schema);
  const few = liveBounty(db2, {}, fakeEstimate({ stock: { check: { in_stock: 1, units_seen: 2 } } }));
  assert.equal(few.cap, 2);
  // A check that found nothing, or no confirmed sales count, fails closed.
  const db3 = memoryDb(schema);
  assert.equal(liveBounty(db3, {}, fakeEstimate({ stock: { confirmed: false, check: { in_stock: 0, units_seen: 0 } } })).cap, 0);
  const db4 = memoryDb(schema);
  assert.equal(liveBounty(db4, {}, fakeEstimate({ sample: { count: undefined } })).cap, 0);
  const db5 = memoryDb(schema);
  assert.equal(liveBounty(db5, {}, fakeEstimate({ competition: { activeListings: undefined } })).cap, 0);

  // An estimate without an opportunity tier is recorded as Review.
  const db6 = memoryDb(schema);
  const est = fakeEstimate();
  delete est.opportunity;
  assert.equal(liveBounty(db6, {}, est).opportunity_tier, "Review");
});

test("bounty validation: expiry window, sponsor disclosure, estimate, retailer and one per barcode", () => {
  const db = memoryDb(schema);
  assert.equal(status(() => liveBounty(db, { expiresAt: at(-1) })).status, 400);
  assert.match(status(() => liveBounty(db, { expiresAt: at(15 * 24 * 60) })).message, /at most 14 days/);
  assert.match(status(() => liveBounty(db, { sponsored: true })).message, /sponsor is required/);
  assert.match(status(() => liveBounty(db, { sponsor: "Acme" })).message, /mark the bounty as sponsored/);
  assert.equal(status(() => liveBounty(db, { availableUnits: 0 })).status, 400);
  assert.equal(status(() => liveBounty(db, { salesPerWeek: 0 })).status, 400);
  assert.equal(status(() => liveBounty(db, { sellWindowWeeks: 0 })).status, 400);
  assert.equal(status(() => liveBounty(db, { title: "" })).status, 400);
  assert.match(status(() => createBounty(db, bountyInput(), { now: T0 })).message, /estimate is required/);
  assert.match(status(() => liveBounty(db, { retailer: "Tesco" })).message, /match the offer's retailer/);
  assert.match(
    status(() => liveBounty(db, {}, fakeEstimate({ offer: { gtin: null } }))).message,
    /no valid barcode/,
  );
  const first = liveBounty(db, { sponsored: true, sponsor: "Acme Kettles" });
  assert.equal(first.sponsored, 1);
  assert.equal(first.sponsor, "Acme Kettles");
  const clash = status(() => liveBounty(db));
  assert.equal(clash.status, 409);
  assert.match(clash.message, /already open for this barcode/);
  withdrawBounty(db, first.id, { now: T0 });
  assert.ok(liveBounty(db).id > first.id);
});

test("sample bounties are labelled and can never alert or earn points", () => {
  const db = memoryDb(schema);
  const b = sampleBounty(db);
  assert.equal(b.sample, 1);
  assert.equal(b.alert_eligible, 0);
  assert.equal(b.cap, 4); // min(6, 3 * 2 - 2)
  const a = diamond(db, "Ada");
  const result = dispatchAlerts(db, b.id, T0);
  assert.equal(result.sent.length, 0);
  assert.match(result.blockers.join(" "), /Sample bounty/);
  const view = bountyView(db, b, { now: T0 });
  assert.equal(view.sample, true);
  assert.equal(view.alert.canSend, false);
  // Claims and reports work for demonstration, but reports earn nothing.
  claim(db, { bountyId: b.id, memberId: a.id, units: 1, now: T0 });
  const r = addReport(db, { bountyId: b.id, memberId: a.id, unitsSeen: 3 }, { now: T0 });
  const v = verifyReport(db, r.id, true, { now: T0 });
  assert.equal(v.points, 0);
  assert.match(v.reason, /Sample bounty/);
  assert.equal(reputation(db, a.id), 0);
  assert.match(status(() => createBounty(db, bountyInput({ sample: true }), { now: T0 })).message, /competingListings/);
});

test("claims never exceed the cap, one active claim per member, expiry frees units", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db); // cap 3
  const [a, c, d] = ["Ada", "Cy", "Di"].map((n) => diamond(db, n));
  const first = claim(db, { bountyId: b.id, memberId: a.id, units: 2, now: T0 });
  assert.equal(first.status, "active");
  assert.equal(first.expires_at, at(BOUNTY_RULES.claimHours * 60));
  const again = status(() => claim(db, { bountyId: b.id, memberId: a.id, units: 1, now: T0 }));
  assert.equal(again.status, 409);
  assert.match(again.message, /already have an active claim/);
  const over = status(() => claim(db, { bountyId: b.id, memberId: c.id, units: 2, now: T0 }));
  assert.equal(over.status, 409);
  assert.match(over.message, /Only 1 unit remains/);
  claim(db, { bountyId: b.id, memberId: c.id, units: 1, now: T0 });
  const full = status(() => claim(db, { bountyId: b.id, memberId: d.id, units: 1, now: T0 }));
  assert.match(full.message, /fully claimed.*attention, not retailer stock/);
  assert.equal(status(() => claim(db, { bountyId: b.id, memberId: d.id, units: 4, now: T0 })).status, 400);

  // Claims last three hours: once Ada's and Cy's lapse their units are free.
  const later = at(BOUNTY_RULES.claimHours * 60 + 1);
  const dClaim = claim(db, { bountyId: b.id, memberId: d.id, units: 2, now: later });
  assert.equal(db.prepare("SELECT status FROM claims WHERE id = ?").get(first.id).status, "expired");
  // Completed claims stay held against the cap; released ones free units.
  completeClaim(db, { claimId: dClaim.id, memberId: d.id, now: later });
  assert.match(status(() => claim(db, { bountyId: b.id, memberId: a.id, units: 2, now: later })).message, /Only 1 unit remains/);
  const cyClaim = db.prepare("SELECT id FROM claims WHERE member_id = ?").get(c.id);
  assert.match(status(() => releaseClaim(db, { claimId: cyClaim.id, memberId: c.id, now: later })).message, /already expired/);
  const view = bountyView(db, b, { viewer: { kind: "operator" }, now: later });
  assert.equal(view.completedUnits, 2);
  assert.equal(view.remaining, 1);
  const aClaim = claim(db, { bountyId: b.id, memberId: a.id, units: 1, now: later });
  assert.equal(status(() => releaseClaim(db, { claimId: aClaim.id, memberId: d.id, now: later })).status, 403);
  releaseClaim(db, { claimId: aClaim.id, memberId: a.id, now: later });
  assert.equal(bountyView(db, b, { now: later }).remaining, 1);
});

test("expired, withdrawn, ineligible, stale or paused bounties cannot be claimed", () => {
  const db = memoryDb(schema);
  const a = diamond(db, "Ada");
  const b = liveBounty(db, { expiresAt: at(60) });
  assert.match(status(() => claim(db, { bountyId: b.id, memberId: a.id, units: 1, now: at(61) })).message, /expired/);

  const db2 = memoryDb(schema);
  const a2 = diamond(db2, "Ada");
  const weak = liveBounty(db2, {}, ineligible("Branch stock not confirmed"));
  const blocked = status(() => claim(db2, { bountyId: weak.id, memberId: a2.id, units: 1, now: T0 }));
  assert.equal(blocked.status, 409);
  assert.match(blocked.message, /buy-alert checks do not pass: Branch stock not confirmed/);
  withdrawBounty(db2, weak.id, { now: T0 });
  assert.match(status(() => claim(db2, { bountyId: weak.id, memberId: a2.id, units: 1, now: T0 })).message, /withdrawn/);

  // The offer was observed on 1 November: by 9 November it has expired.
  const db3 = memoryDb(schema);
  const a3 = diamond(db3, "Ada");
  const old = liveBounty(db3, { expiresAt: at(10 * 24 * 60) });
  assert.match(
    status(() => claim(db3, { bountyId: old.id, memberId: a3.id, units: 1, now: at(7 * 24 * 60) })).message,
    /offer price is not from the last 7 days/,
  );

  const db4 = memoryDb(schema);
  const a4 = diamond(db4, "Ada");
  const shelf = liveBounty(db4);
  addReport(db4, { bountyId: shelf.id, memberId: a4.id, unitsSeen: 0 }, { now: T0 });
  assert.match(status(() => claim(db4, { bountyId: shelf.id, memberId: a4.id, units: 1, now: T0 })).message, /none on the shelf/);
});

test("a tightened trial batch in the estimate limits claim size", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db, {}, fakeEstimate({ opportunity: { trialUnits: 1 } }));
  const a = diamond(db, "Ada");
  assert.match(status(() => claim(db, { bountyId: b.id, memberId: a.id, units: 2, now: T0 })).message, /from 1 to 1/);
  assert.equal(claim(db, { bountyId: b.id, memberId: a.id, units: 1, now: T0 }).units, 1);
  assert.equal(bountyView(db, b, { now: T0 }).maxClaimUnits, 1);
});

test("claims open in release order: a later tier waits for its window", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db);
  const fresh = member(db, "New");
  const early = status(() => claim(db, { bountyId: b.id, memberId: fresh.id, units: 1, now: at(60) }));
  assert.equal(early.status, 409);
  assert.match(early.message, /opens at 2026-11-02T16:30:00.000Z \(New member, via earned reputation\)/);
  assert.equal(claim(db, { bountyId: b.id, memberId: fresh.id, units: 1, now: at(450) }).status, "active");
});

test("concurrent claims serialise: two members racing for the last unit, only one succeeds", () => {
  const dir = mkdtempSync(join(tmpdir(), "bounty-race-"));
  try {
    const file = join(dir, "race.sqlite");
    const a = new DatabaseSync(file);
    a.exec("PRAGMA foreign_keys=ON");
    schema(a);
    const b = new DatabaseSync(file);
    const bounty = liveBounty(a, {}, fakeEstimate({ stock: { check: { in_stock: 1, units_seen: 1 } } }));
    assert.equal(bounty.cap, 1);
    const [ada, cy] = ["Ada", "Cy"].map((n) => diamond(a, n));
    // Ada's claim holds the write lock while it checks the cap and inserts.
    a.exec("BEGIN IMMEDIATE");
    a.prepare("INSERT INTO claims(bounty_id, member_id, units, status, created, expires_at) VALUES(?, ?, 1, 'active', ?, ?)").run(
      bounty.id,
      ada.id,
      T0,
      at(180),
    );
    // Cy's claim on the second connection cannot read and write in between.
    assert.throws(() => claim(b, { bountyId: bounty.id, memberId: cy.id, units: 1, now: T0 }), /locked|busy/i);
    a.exec("COMMIT");
    const retry = status(() => claim(b, { bountyId: bounty.id, memberId: cy.id, units: 1, now: T0 }));
    assert.equal(retry.status, 409);
    const held = a.prepare("SELECT COALESCE(SUM(units), 0) AS n FROM claims WHERE status = 'active'").get().n;
    assert.equal(held, 1);
    a.close();
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a negative stock report pauses alerts until stock is reported again", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db);
  const a = diamond(db, "Ada");
  const c = diamond(db, "Cy");
  const neg = addReport(db, { bountyId: b.id, memberId: a.id, unitsSeen: 0 }, { now: T0 });
  assert.deepEqual(shelfStatus(db, b.id).state, "none");
  const paused = dispatchAlerts(db, b.id, T0);
  assert.equal(paused.sent.length, 0);
  assert.match(paused.blockers.join(" "), /none on the shelf/);
  // A later positive report resumes; marking it inaccurate pauses again.
  const pos = addReport(db, { bountyId: b.id, memberId: c.id, unitsSeen: 4, observedAt: at(5) }, { now: at(5) });
  assert.equal(shelfStatus(db, b.id).state, "seen");
  verifyReport(db, pos.id, false, { now: at(6) });
  assert.equal(shelfStatus(db, b.id).state, "none");
  // An inaccurate negative report stops pausing.
  verifyReport(db, neg.id, false, { now: at(7) });
  assert.equal(shelfStatus(db, b.id).state, "unknown");
  assert.equal(dispatchAlerts(db, b.id, at(8)).sent.length, 2);
});

test("accurate negative and positive reports earn equal points, inaccurate none, tier never changes it", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db);
  const a = member(db, "Ada");
  const c = member(db, "Cy", { paidTier: "diamond", paidUntil: "2026-12-31" });
  const d = member(db, "Di");
  const checks = [];
  const recordCheck = (_db, check) => {
    checks.push(check);
    return { id: checks.length };
  };
  const negative = addReport(db, { bountyId: b.id, memberId: a.id, unitsSeen: 0, note: "Gap on the shelf" }, { now: T0 });
  const positive = addReport(db, { bountyId: b.id, memberId: c.id, unitsSeen: 5 }, { now: T0 });
  const wrong = addReport(db, { bountyId: b.id, memberId: d.id, unitsSeen: 9 }, { now: T0 });
  const n = verifyReport(db, negative.id, true, { now: at(10), recordCheck });
  const p = verifyReport(db, positive.id, true, { now: at(10), recordCheck });
  const w = verifyReport(db, wrong.id, false, { now: at(10), recordCheck });
  assert.equal(n.points, REPUTATION_RULES.accurateReport);
  assert.equal(p.points, n.points);
  assert.equal(w.points, 0);
  assert.equal(reputation(db, a.id), reputation(db, c.id));
  assert.equal(reputation(db, d.id), 0);
  assert.equal(status(() => verifyReport(db, negative.id, true, { now: at(11) })).status, 409);
  // Verified accurate reports become dated in-store availability checks.
  assert.equal(checks.length, 2);
  assert.deepEqual(
    checks.map((x) => [x.inStock, x.unitsSeen, x.method, x.barcode, x.retailer, x.locality]),
    [
      [false, 0, "in_store", GTIN, "Argos", "Camden"],
      [true, 5, "in_store", GTIN, "Argos", "Camden"],
    ],
  );
  assert.equal(checks[0].checkedAt, negative.observed_at);
  // A paid tier never adds points; changing it leaves reputation alone.
  const before = reputation(db, a.id);
  updateMember(db, a.id, { paidTier: "diamond", paidUntil: "2026-12-31" }, { now: T0 });
  assert.equal(reputation(db, a.id), before);
  const view = memberView(db, db.prepare("SELECT * FROM members WHERE id = ?").get(a.id), { now: T0 });
  assert.equal(view.paid.tier.id, "diamond");
  assert.equal(view.earned.points, before);
  assert.equal(view.earned.tier.id, "new");
  assert.equal(view.release.via, "paid");
  // Repeating a report of the same shelf the same day earns nothing more.
  const repeat = addReport(db, { bountyId: b.id, memberId: a.id, unitsSeen: 0 }, { now: at(20) });
  const r = verifyReport(db, repeat.id, true, { now: at(21) });
  assert.equal(r.points, 0);
  assert.match(r.reason, /already earned points that day/);
});

test("stock report validation: timing, units and closed bounties", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db, { expiresAt: at(120) });
  const a = member(db, "Ada");
  assert.equal(status(() => addReport(db, { bountyId: b.id, memberId: a.id, unitsSeen: -1 }, { now: T0 })).status, 400);
  assert.match(
    status(() => addReport(db, { bountyId: b.id, memberId: a.id, unitsSeen: 1, observedAt: at(30) }, { now: T0 })).message,
    /future/,
  );
  assert.match(
    status(() => addReport(db, { bountyId: b.id, memberId: a.id, unitsSeen: 1, observedAt: at(-49 * 60) }, { now: T0 })).message,
    /48 hours/,
  );
  assert.equal(status(() => addReport(db, { bountyId: b.id, memberId: 99, unitsSeen: 1 }, { now: T0 })).status, 404);
  assert.equal(status(() => addReport(db, { bountyId: b.id, memberId: a.id, unitsSeen: 1 }, { now: at(121) })).status, 409);
});

test("alerts go only to opted-in members in the locality, never for blocked bounties", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db);
  const yes = diamond(db, "Yes");
  diamond(db, "Out", { alertsOptIn: false });
  diamond(db, "Elsewhere", { alertLocalities: ["Leeds"] });
  diamond(db, "Case", { alertLocalities: ["  camden "] });
  const result = dispatchAlerts(db, b.id, T0);
  assert.deepEqual(result.sent.map((s) => s.name).sort(), ["Case", "Yes"]);
  const why = Object.fromEntries(result.notAlerted.map((n) => [n.name, n.reason]));
  assert.equal(why.Out, "Not opted in to alerts");
  assert.match(why.Elsewhere, /do not include Camden/);
  // At most one alert per member per bounty.
  const again = dispatchAlerts(db, b.id, at(1));
  assert.equal(again.sent.length, 0);
  assert.equal(again.notAlerted.find((n) => n.memberId === yes.id).reason, "Already alerted for this bounty");

  for (const [label, make, when] of [
    ["ineligible", (d) => liveBounty(d, {}, ineligible()), T0],
    ["expired", (d) => liveBounty(d, { expiresAt: at(30) }), at(31)],
    ["withdrawn", (d) => withdrawBounty(d, liveBounty(d).id, { now: T0 }), T0],
    ["sample", (d) => sampleBounty(d), T0],
    ["full", (d) => liveBounty(d, {}, fakeEstimate({ competition: { activeListings: 9 } })), T0],
  ]) {
    const d = memoryDb(schema);
    diamond(d, "Yes");
    const out = dispatchAlerts(d, make(d).id, when);
    assert.equal(out.sent.length, 0, label);
    assert.ok(out.blockers.length > 0, label);
  }
});

test("release windows: tiers are alerted from bounty.created plus their offset, by reputation within a window", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db); // cap 3, so up to 6 alerts
  const paidDiamond = member(db, "PaidDiamond", { paidTier: "diamond", paidUntil: "2026-12-31" });
  const paidRuby = member(db, "PaidRuby", { paidTier: "ruby", paidUntil: "2026-12-31" });
  const earnedRuby = member(db, "EarnedRuby");
  grant(db, earnedRuby.id, 300);
  const lapsed = member(db, "Lapsed", { paidTier: "diamond", paidUntil: "2026-10-01" });
  const fresh = member(db, "Fresh");

  const first = dispatchAlerts(db, b.id, T0);
  assert.deepEqual(first.sent.map((s) => s.name), ["PaidDiamond"]);
  assert.equal(first.sent[0].via, "paid");
  assert.equal(first.sent[0].label, "Paid early access");
  assert.equal(first.nextReleaseAt, at(90));
  const waiting = Object.fromEntries(first.notAlerted.map((n) => [n.name, n.releaseAt]));
  assert.equal(waiting.PaidRuby, at(90));
  assert.equal(waiting.EarnedRuby, at(90));
  assert.equal(waiting.Lapsed, at(450)); // lapsed paid access falls back to earned
  assert.equal(waiting.Fresh, at(450));

  assert.equal(dispatchAlerts(db, b.id, at(89)).sent.length, 0);
  const second = dispatchAlerts(db, b.id, at(90));
  assert.deepEqual(second.sent.map((s) => s.name), ["EarnedRuby", "PaidRuby"]);
  assert.deepEqual(second.sent.map((s) => s.via), ["earned", "paid"]);
  const third = dispatchAlerts(db, b.id, at(450));
  assert.deepEqual(third.sent.map((s) => s.name), ["Lapsed", "Fresh"]);
  assert.equal(third.nextReleaseAt, null);
  const rows = db.prepare("SELECT member_id, tier, via FROM alerts ORDER BY id").all().map((r) => ({ ...r }));
  assert.deepEqual(rows.map((r) => r.member_id), [paidDiamond.id, earnedRuby.id, paidRuby.id, lapsed.id, fresh.id]);
});

test("exposure limit: with little stock the later tiers receive nothing", () => {
  const db = memoryDb(schema);
  // floor(2.02 * 2) = 4 sales less 3 listings leaves a cap of 1: at most 2 alerts.
  const b = liveBounty(db, {}, fakeEstimate({ competition: { activeListings: 3 } }));
  assert.equal(b.cap, 1);
  member(db, "PaidDiamond", { paidTier: "diamond", paidUntil: "2026-12-31" });
  const high = member(db, "RubyHigh", { paidTier: "ruby", paidUntil: "2026-12-31" });
  grant(db, high.id, 200);
  member(db, "RubyLow", { paidTier: "ruby", paidUntil: "2026-12-31" });
  member(db, "Fresh");
  assert.equal(dispatchAlerts(db, b.id, T0).exposure.limit, 2);
  const second = dispatchAlerts(db, b.id, at(90));
  assert.deepEqual(second.sent.map((s) => s.name), ["RubyHigh"]);
  assert.match(second.notAlerted.find((n) => n.name === "RubyLow").reason, /Exposure limit reached/);
  const third = dispatchAlerts(db, b.id, at(450));
  assert.equal(third.sent.length, 0);
  assert.match(third.notAlerted.find((n) => n.name === "Fresh").reason, /Exposure limit reached/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alerts").get().n, 2);
});

test("a failed or weaker re-check makes a bounty ineligible", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db);
  diamond(db, "Ada");
  refreshBounty(db, b.id, { error: "Offer not found" }, at(5));
  const blocked = dispatchAlerts(db, b.id, at(5));
  assert.equal(blocked.sent.length, 0);
  assert.match(blocked.blockers.join(" "), /Evidence could not be re-checked: Offer not found/);
  const back = refreshBounty(db, b.id, fakeEstimate({ competition: { activeListings: 3 } }), at(6));
  assert.equal(back.alert_eligible, 1);
  assert.equal(back.cap, 1);
  assert.equal(dispatchAlerts(db, b.id, at(6)).sent.length, 1);
});

test("views: sponsored placement, pressure figures and private notes by viewer", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db, { sponsored: true, sponsor: "Acme Kettles" });
  const author = diamond(db, "Author");
  const other = diamond(db, "Other");
  claim(db, { bountyId: b.id, memberId: other.id, units: 1, now: T0 });
  addReport(db, { bountyId: b.id, memberId: author.id, unitsSeen: 2, note: "Back of aisle 4" }, { now: T0 });
  const views = {
    public: bountyView(db, b, { viewer: resolveViewer(db, null), now: T0 }),
    other: bountyView(db, b, { viewer: resolveViewer(db, String(other.id)), now: T0 }),
    author: bountyView(db, b, { viewer: resolveViewer(db, String(author.id)), now: T0 }),
    operator: bountyView(db, b, { viewer: resolveViewer(db, "operator"), now: T0 }),
  };
  for (const v of Object.values(views)) {
    assert.equal(v.sponsored, true);
    assert.equal(v.sponsor, "Acme Kettles");
    assert.equal(v.placement, "Sponsored by Acme Kettles");
    assert.equal(v.reports.total, 1);
    assert.equal(v.reports.positive, 1);
    assert.match(v.terms.buyAndResell, /never pays a reward/);
  }
  assert.equal(views.public.reports.items[0].note, undefined);
  assert.equal(views.public.reports.items[0].memberId, undefined);
  assert.equal(views.other.reports.items[0].note, undefined);
  assert.equal(views.author.reports.items[0].note, "Back of aisle 4");
  assert.equal(views.operator.reports.items[0].note, "Back of aisle 4");
  assert.equal(views.public.claims.length, 0);
  assert.equal(views.other.claims.length, 1);
  assert.equal(views.author.claims.length, 0);
  assert.equal(views.operator.claims.length, 1);
  // Sourcing pressure and resale competition are separate figures.
  const { sourcing, resale } = views.public.pressure;
  assert.deepEqual(sourcing, { activeClaimedUnits: 1, recentPositiveReports: 1, availableUnits: 6, ratio: 0.33 });
  assert.equal(resale.competingListings, 1);
  assert.equal(resale.salesPerWeek, 2.02);
  assert.equal(resale.weeksOfSupply, 0.5);
  assert.equal(views.public.opportunity.tier, "Priority 2");
  assert.equal(views.other.viewer.activeClaim.units, 1);
  assert.equal(status(() => resolveViewer(db, "someone")).status, 400);
  assert.equal(status(() => resolveViewer(db, "999")).status, 404);
});

// A JPEG with an Exif GPS segment and a comment, like a phone photo.
const segment = (marker, payload) => {
  const body = Buffer.from(payload);
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
};
const jpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  segment(0xe0, "JFIF\0\x01\x01"),
  segment(0xe1, "Exif\0\0GPSLatitude51.5390"),
  segment(0xfe, "Camden High Street"),
  segment(0xdb, "\0quant"),
  segment(0xda, "\x01\x01\0"),
  Buffer.from([1, 2, 3, 0xff, 0xd9]),
]);

test("shelf photos: type checked by magic bytes, size limited, metadata stripped", () => {
  const ok = preparePhoto({ mediaType: "image/jpeg", data: jpeg.toString("base64") });
  assert.ok(!ok.buffer.includes("GPSLatitude"));
  assert.ok(!ok.buffer.includes("Camden"));
  assert.equal(ok.bytes, ok.buffer.length);
  assert.match(ok.sha256, /^[0-9a-f]{64}$/);
  assert.match(status(() => preparePhoto({ mediaType: "image/png", data: jpeg.toString("base64") })).message, /not a PNG/);
  assert.match(
    status(() => preparePhoto({ mediaType: "image/jpeg", data: Buffer.from("GIF89a....").toString("base64") })).message,
    /not a JPEG/,
  );
  assert.equal(status(() => preparePhoto({ mediaType: "image/gif", data: "R0lGODlh" })).status, 400);
  assert.equal(status(() => preparePhoto({ mediaType: "image/jpeg", data: "not base64!" })).status, 400);
  const big = Buffer.alloc(5 * 1024 * 1024 + 1);
  jpeg.copy(big);
  assert.match(status(() => preparePhoto({ mediaType: "image/jpeg", data: big.toString("base64") })).message, /5 MB/);
});

test("schema is idempotent and migrates an older bounties table in place", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE bounties (id INTEGER PRIMARY KEY, title TEXT NOT NULL, retailer TEXT NOT NULL,
 locality TEXT NOT NULL, available_units INTEGER NOT NULL, sales_per_week REAL NOT NULL,
 sell_window_weeks REAL NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created TEXT);
INSERT INTO bounties(title, retailer, locality, available_units, sales_per_week, sell_window_weeks, expires_at, created)
 VALUES('Old', 'Argos', 'Camden', 3, 1, 2, '2026-11-05T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
CREATE TABLE members (id INTEGER PRIMARY KEY, name TEXT NOT NULL, locality TEXT);
INSERT INTO members(name) VALUES('Old member');`);
  schema(db);
  schema(db);
  const columns = db.prepare("PRAGMA table_info(bounties)").all().map((c) => c.name);
  for (const c of ["cap", "sponsored", "sponsor", "sample", "alert_eligible", "opportunity_tier", "estimate", "cap_basis"])
    assert.ok(columns.includes(c), c);
  const old = db.prepare("SELECT * FROM bounties").get();
  assert.equal(old.title, "Old");
  assert.equal(old.cap, 0);
  assert.equal(old.alert_eligible, 0);
  const m = db.prepare("SELECT * FROM members").get();
  assert.equal(m.alerts_opt_in, 0);
  assert.equal(m.alert_localities, "[]");
  assert.equal(dispatchAlerts(db, old.id, T0).sent.length, 0);
});

// ------------------------------------------------------------------ routes

const tempDirs = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

async function setup(over = {}) {
  const db = memoryDb(schema);
  const root = mkdtempSync(join(tmpdir(), "bounty-photos-"));
  tempDirs.push(root);
  const photoDir = join(root, "report-photos");
  const calls = [];
  const checks = [];
  const state = { now: T0, estimate: fakeEstimate() };
  const options = {
    clock: () => state.now,
    photoDir,
    estimate: (_db, request, opts) => {
      calls.push({ request, opts });
      if (state.estimate instanceof Error) throw state.estimate;
      return state.estimate;
    },
    recordCheck: (_db, check) => {
      checks.push(check);
      return { id: checks.length };
    },
    ...over,
  };
  const api = await serve(db, [{ routes: (d) => routes(d, options) }]);
  return { db, api, calls, checks, state, photoDir };
}
const request = { offer: { provider: "awin", sourceId: "A1" }, units: 2, now: "2020-01-01T00:00:00Z" };

test("routes: members show paid and earned status separately and validate input", async () => {
  const { api } = await setup();
  try {
    const created = await api.call("POST", "/api/members", { name: "Ada", alertsOptIn: true, alertLocalities: ["Camden", "camden"] });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.member.alertLocalities, ["Camden"]);
    assert.equal(created.body.member.paid.tier, null);
    assert.equal(created.body.member.earned.points, 0);
    assert.match(created.body.notice, /not authenticated/);
    const id = created.body.member.id;
    assert.equal((await api.call("POST", "/api/members", { name: "" })).status, 400);
    assert.equal((await api.call("POST", "/api/members", { name: "Bo", paidTier: "gold" })).status, 400);
    assert.equal((await api.call("POST", "/api/members", { name: "Bo", paidTier: "new" })).status, 400);
    assert.equal((await api.call("POST", "/api/members", { name: "Bo", paidUntil: "2026-12-01" })).status, 400);
    assert.equal((await api.call("PATCH", `/api/members/${id}`, { alertsOptIn: "yes" })).status, 400);
    const patched = await api.call("PATCH", `/api/members/${id}`, { paidTier: "ruby", paidUntil: "2026-12-01" });
    assert.equal(patched.status, 200);
    const m = patched.body.member;
    assert.equal(m.paid.label, "Paid early access");
    assert.equal(m.paid.tier.id, "ruby");
    assert.equal(m.paid.current, true);
    assert.equal(m.earned.label, "Earned reputation");
    assert.equal(m.earned.tier.id, "new");
    assert.equal(m.earned.next.pointsNeeded, 25);
    assert.equal(m.release.via, "paid");
    assert.equal(m.release.offsetMinutes, 90);
    assert.equal((await api.call("PATCH", "/api/members/77", { name: "X" })).status, 404);
    const list = await api.call("GET", "/api/members");
    assert.equal(list.body.members.length, 1);
    assert.ok(list.body.tiers.some((t) => t.id === "diamond" && t.offsetMinutes === 0));
  } finally {
    await api.close();
  }
});

test("routes: a bounty is created from a server-run estimate and validated", async () => {
  const { api, calls } = await setup();
  try {
    const bad = await api.call("POST", "/api/bounties", { ...bountyInput(), estimate: request, expiresAt: at(20 * 24 * 60) });
    assert.equal(bad.status, 400);
    assert.equal((await api.call("POST", "/api/bounties", bountyInput())).status, 400);
    assert.equal(
      (await api.call("POST", "/api/bounties", { ...bountyInput(), estimate: { ...request, locality: "Leeds" } })).status,
      400,
    );
    assert.equal((await api.call("POST", "/api/bounties", { ...bountyInput({ sample: true }), estimate: request })).status, 400);
    const res = await api.call("POST", "/api/bounties", { ...bountyInput(), estimate: request });
    assert.equal(res.status, 201);
    const last = calls[calls.length - 1];
    assert.equal(last.request.now, undefined); // the server clock decides freshness
    assert.equal(last.request.locality, "Camden");
    assert.equal(last.opts.now, T0);
    const b = res.body.bounty;
    assert.equal(b.cap, 3);
    assert.equal(b.alert.eligible, true);
    assert.equal(b.opportunity.tier, "Priority 2");
    assert.equal(b.sponsored, false);
    assert.match(res.body.message, /you buy and own the stock and carry the risk/);
    const dup = await api.call("POST", "/api/bounties", { ...bountyInput(), estimate: request });
    assert.equal(dup.status, 409);
    const sample = await api.call("POST", "/api/bounties", bountyInput({ sample: true, competingListings: 1, competingSellers: 1 }));
    assert.equal(sample.status, 201);
    assert.equal(sample.body.bounty.sample, true);
    assert.match(sample.body.message, /can never send an alert/);
    const list = await api.call("GET", "/api/bounties");
    assert.equal(list.body.bounties.length, 2);
    assert.equal((await api.call("GET", "/api/bounties?viewer=nobody")).status, 400);
    assert.equal((await api.call("GET", "/api/bounties/abc")).status, 404);
    const one = await api.call("GET", `/api/bounties/${b.id}?viewer=operator`);
    assert.equal(one.body.bounty.id, b.id);
  } finally {
    await api.close();
  }
});

test("routes: claims re-check the evidence and race for the last unit", async () => {
  const { api, state } = await setup();
  try {
    state.estimate = fakeEstimate({ stock: { check: { in_stock: 1, units_seen: 1 } } });
    const b = (await api.call("POST", "/api/bounties", { ...bountyInput(), estimate: request })).body.bounty;
    assert.equal(b.cap, 1);
    const ids = [];
    for (const name of ["Ada", "Cy"])
      ids.push((await api.call("POST", "/api/members", { name, paidTier: "diamond", paidUntil: "2026-12-31" })).body.member.id);
    const results = await Promise.all(ids.map((memberId) => api.call("POST", `/api/bounties/${b.id}/claims`, { memberId, units: 1 })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    const won = results.find((r) => r.status === 201);
    assert.match(won.body.message, /reserves your attention on this bounty, not stock at the retailer/);
    assert.equal(won.body.bounty.remaining, 0);
    const winner = won.body.claim;
    const release = await api.call("POST", `/api/claims/${winner.id}/release`, { memberId: winner.member_id });
    assert.equal(release.status, 200);
    // The re-check now fails: claims stop.
    state.estimate = ineligible("Offer observation has expired (8 days old)");
    const blocked = await api.call("POST", `/api/bounties/${b.id}/claims`, { memberId: ids[0], units: 1 });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /Offer observation has expired/);
    state.estimate = fakeEstimate({ stock: { check: { in_stock: 1, units_seen: 1 } } });
    const made = await api.call("POST", `/api/bounties/${b.id}/claims`, { memberId: ids[0], units: 1 });
    assert.equal(made.status, 201);
    const done = await api.call("POST", `/api/claims/${made.body.claim.id}/complete`, { memberId: ids[0] });
    assert.equal(done.status, 200);
    assert.match(done.body.message, /purchase receipt and the payout record/);
    assert.equal((await api.call("POST", `/api/bounties/${b.id}/claims`, { memberId: 999, units: 1 })).status, 404);
  } finally {
    await api.close();
  }
});

test("routes: alerts dispatch after a server re-check and land in each member's list", async () => {
  const { api, state, calls } = await setup();
  try {
    const b = (await api.call("POST", "/api/bounties", { ...bountyInput(), estimate: request })).body.bounty;
    const paid = (await api.call("POST", "/api/members", { name: "Paid", alertsOptIn: true, alertLocalities: ["Camden"], paidTier: "diamond", paidUntil: "2026-12-31" })).body.member;
    const fresh = (await api.call("POST", "/api/members", { name: "Fresh", alertsOptIn: true, alertLocalities: ["Camden"] })).body.member;
    const before = calls.length;
    const first = await api.call("POST", `/api/bounties/${b.id}/alerts`, {});
    assert.equal(first.status, 200);
    assert.equal(calls.length, before + 1);
    assert.deepEqual(first.body.sent.map((s) => s.name), ["Paid"]);
    assert.equal(first.body.nextReleaseAt, at(450));
    state.now = at(450);
    const second = await api.call("POST", `/api/bounties/${b.id}/alerts`, {});
    assert.deepEqual(second.body.sent.map((s) => s.name), ["Fresh"]);
    const inbox = await api.call("GET", `/api/members/${paid.id}/alerts`);
    assert.equal(inbox.body.alerts.length, 1);
    assert.equal(inbox.body.alerts[0].label, "Paid early access");
    const freshInbox = await api.call("GET", `/api/members/${fresh.id}/alerts`);
    assert.equal(freshInbox.body.alerts[0].label, "Earned release");
    // A failing re-check stops alerts (fail closed).
    state.estimate = new Error("Offer not found");
    await api.call("POST", "/api/members", { name: "Late", alertsOptIn: true, alertLocalities: ["Camden"], paidTier: "diamond", paidUntil: "2026-12-31" });
    const stopped = await api.call("POST", `/api/bounties/${b.id}/alerts`, {});
    assert.equal(stopped.body.sent.length, 0);
    assert.match(stopped.body.blockers.join(" "), /could not be re-checked: Offer not found/);
  } finally {
    await api.close();
  }
});

test("routes: stock reports with a private shelf photo, and operator verification", async () => {
  const { api, db, checks, photoDir } = await setup();
  try {
    const b = (await api.call("POST", "/api/bounties", { ...bountyInput(), estimate: request })).body.bounty;
    const author = (await api.call("POST", "/api/members", { name: "Author" })).body.member;
    const other = (await api.call("POST", "/api/members", { name: "Other" })).body.member;
    const data = jpeg.toString("base64");
    const wrongType = await api.call("POST", `/api/bounties/${b.id}/reports`, {
      memberId: author.id,
      unitsSeen: 3,
      photo: { mediaType: "image/png", data },
    });
    assert.equal(wrongType.status, 400);
    assert.ok(!existsSync(photoDir) || readdirSync(photoDir).length === 0);
    const res = await api.call("POST", `/api/bounties/${b.id}/reports`, {
      memberId: author.id,
      unitsSeen: 3,
      note: "Two on the end cap",
      photo: { mediaType: "image/jpeg", data },
    });
    assert.equal(res.status, 201);
    assert.match(res.body.message, /never proof of a purchase or of profit/);
    const raw = JSON.stringify(res.body);
    assert.ok(!raw.includes(data.slice(0, 40)), "the response never carries the image");
    const row = db.prepare("SELECT * FROM stock_reports WHERE id = ?").get(res.body.reportId);
    assert.match(row.photo_sha256, /^[0-9a-f]{64}$/);
    assert.equal(row.photo_media_type, "image/jpeg");
    const file = join(photoDir, row.photo_sha256);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(photoDir).mode & 0o777, 0o700);
    const stored = readFileSync(file);
    assert.equal(stored.length, row.photo_bytes);
    assert.ok(!stored.includes("GPSLatitude"));
    assert.ok(!stored.includes("Camden High Street"));

    const mine = (await api.call("GET", `/api/bounties/${b.id}?viewer=${author.id}`)).body.bounty.reports.items[0];
    assert.equal(mine.note, "Two on the end cap");
    assert.equal(mine.photo.label, "Shelf photo (stock report, not proof of profit)");
    assert.equal(mine.photo.sha256, row.photo_sha256);
    const theirs = (await api.call("GET", `/api/bounties/${b.id}?viewer=${other.id}`)).body.bounty.reports.items[0];
    assert.deepEqual(Object.keys(theirs).sort(), ["id", "mine", "observedAt", "unitsSeen", "verified"]);

    const verify = await api.call("POST", `/api/reports/${res.body.reportId}/verify`, { accurate: true });
    assert.equal(verify.status, 200);
    assert.equal(verify.body.points, REPUTATION_RULES.accurateReport);
    assert.equal(verify.body.stockCheckId, 1);
    assert.equal(checks[0].inStock, true);
    assert.equal((await api.call("POST", `/api/reports/${res.body.reportId}/verify`, { accurate: false })).status, 409);
    assert.equal((await api.call("POST", `/api/reports/${res.body.reportId}/verify`, {})).status, 400);
    const neg = await api.call("POST", `/api/bounties/${b.id}/reports`, { memberId: other.id, unitsSeen: 0 });
    assert.match(neg.body.message, /pause/);
    assert.equal(neg.body.bounty.shelf.state, "none");
    const members = (await api.call("GET", "/api/members")).body.members;
    assert.equal(members.find((m) => m.id === author.id).earned.points, REPUTATION_RULES.accurateReport);
    const withdrawn = await api.call("POST", `/api/bounties/${b.id}/withdraw`, {});
    assert.equal(withdrawn.body.bounty.status, "withdrawn");
    assert.equal((await api.call("POST", `/api/bounties/${b.id}/withdraw`, {})).status, 409);
  } finally {
    await api.close();
  }
});
