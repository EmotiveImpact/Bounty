import { after, mock, test } from "node:test";
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
  claim as rawClaim,
  completeClaim,
  createBounty,
  createMember,
  dispatchAlerts,
  distributionCap,
  humanTime,
  memberAlerts,
  memberNotices,
  memberView,
  preparePhoto,
  refreshBounty,
  releaseClaim,
  reputation,
  resolveViewer,
  schema,
  shelfStatus,
  answerPromotion,
  validationFrom,
  attributeNotes,
  blockerList,
  journeyInput,
  memberRuleFailures,
  memberTripCheck,
  recheckOpenBounties,
  stockLapse,
  tripState,
  updateMember,
  verifyReport,
  withdrawBounty,
} from "./bounties.mjs";
import { routes } from "./routes-bounties.mjs";
import { CHECK_VALID_DAYS, recordCheck, schema as auditSchema } from "./audit.mjs";
import { PERMISSIONS_TABLE, RESEARCH_TABLE } from "./contract.mjs";

const T0 = "2026-11-02T09:00:00.000Z";
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60000).toISOString();
const GTIN = "05012345678900";

// A stand-in for an estimateFromEvidence result, so these tests never depend
// on the estimate module. 26 confirmed sales in 90 days is about 2.02 a week.
// The economics follow the units and the journey: £10 contribution a unit
// before a £5 journey by default, so 2 units give £15 (£7.50 a unit) and 1
// unit gives £5.
function fakeEstimate(over = {}) {
  const units = over.units ?? 2;
  const travel = over.journeyCost ?? 500;
  const minutes = over.journeyMinutes ?? 30;
  const contribution = units * 1000 - travel;
  const activeMinutes = minutes + 10 + units * 10;
  const unitProfit = Math.floor(contribution / units);
  const result = {
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
      units,
      unitCost: 1500,
      salePrice: 3200,
      costs: { travel },
      contribution,
      unitContribution: unitProfit,
      cashRequired: units * 1600 + travel,
      hourly: Math.round((contribution * 60) / activeMinutes),
      activeMinutes,
      unsoldLoss: -3200,
      breakEvenSale: 2400,
      ...over.economics,
    },
    inputs: { units },
    opportunity: {
      tier: "Priority 2",
      reasons: ["Sourcing pressure high or unknown"],
      unitProfit,
      returnOnCost: Math.round((unitProfit / 1500) * 1000) / 1000,
      targetPrice: null,
      meetsThresholds: true,
      trialUnits: 3,
      unitPrice: 1500,
      weightKg: 0.9,
      ...over.opportunity,
    },
    alert: { eligible: true, reasons: [], checks: [{ id: "live-evidence", ok: true, detail: "Imported evidence" }], ...over.alert },
    stock: {
      confirmed: true,
      availability: "in_stock",
      ...over.stock,
      check:
        over.stock?.check === null
          ? null
          : { in_stock: 1, units_seen: 10, checked_at: "2026-11-02T08:00:00.000Z", ...over.stock?.check },
    },
    permission: { permitted: true, basis: "Permitted for awin (Argos) by a display permission recorded in Sources" },
    warnings: [],
    ...over.extra,
  };
  // Lets the fake route estimate re-run these figures at other units.
  Object.defineProperty(result, "remake", {
    value: (request) =>
      fakeEstimate({
        ...over,
        units: Number.isSafeInteger(request?.units) ? request.units : units,
        journeyCost: Number.isSafeInteger(request?.costs?.journeyCost) ? request.costs.journeyCost : travel,
        journeyMinutes: Number.isSafeInteger(request?.costs?.journeyMinutes) ? request.costs.journeyMinutes : minutes,
      }),
  });
  return result;
}

// A member's own journey for claims, and claim() with a passing check of
// their own figures at the units they claim (the route re-runs the
// estimate; these unit tests pass the result in).
const JOURNEY = { cost: 300, minutes: 30 };
const TRIP = { journeyCost: JOURNEY.cost, journeyMinutes: JOURNEY.minutes };
const ownCheck = (units, journey = JOURNEY) =>
  fakeEstimate({ units, journeyCost: journey.cost, journeyMinutes: journey.minutes });
const claim = (db, args) => rawClaim(db, { journey: JOURNEY, check: ownCheck(args.units), ...args });
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
  assert.equal(view.trip.state, "sample");
  assert.match(view.terms.sample, /illustrative.*Nothing here can be claimed or bought/);
  // Nothing on a sample can be claimed or marked as bought.
  const refused = status(() => claim(db, { bountyId: b.id, memberId: a.id, units: 1, now: T0 }));
  assert.equal(refused.status, 409);
  assert.match(refused.message, /Sample bounty: illustrative figures only, so there is nothing to claim/);
  const memberView = bountyView(db, b, { viewer: { kind: "member", member: a }, now: T0 });
  assert.equal(memberView.viewer.canClaim, false);
  // A claim left over from an older database cannot be marked as bought.
  const old = db
    .prepare("INSERT INTO claims(bounty_id, member_id, units, status, created, expires_at) VALUES(?, ?, 1, 'active', ?, ?)")
    .run(b.id, a.id, T0, at(180));
  const bought = status(() => completeClaim(db, { claimId: Number(old.lastInsertRowid), memberId: a.id, now: T0 }));
  assert.equal(bought.status, 409);
  assert.match(bought.message, /nothing to mark as bought/);
  // Reports work for practice, but earn nothing.
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
  // Figures for 2 units when one member can claim 1 must be worked out again.
  const two = liveBounty(memoryDb(schema), {}, fakeEstimate({ opportunity: { trialUnits: 1 } }));
  assert.equal(two.alert_eligible, 0);
  assert.match(two.alert_reasons, /The figures are for 2 units, but one member can claim at most 1 unit/);
  const b = liveBounty(db, {}, fakeEstimate({ units: 1, opportunity: { trialUnits: 1 } }));
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
  assert.match(early.message, /opens at 2 Nov 2026, 16:30 \(New member, via earned reputation\)/);
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
  const b = liveBounty(db, {}, fakeEstimate({ units: 1, competition: { activeListings: 3 } }));
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
  const back = refreshBounty(db, b.id, fakeEstimate({ units: 1, competition: { activeListings: 3 } }), at(6));
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
  // Sourcing pressure and resale competition are separate figures. Units on
  // the shelf follow the newest evidence: the report of 2 units at 09:00 is
  // newer than the stock check's 10 units at 08:00.
  const { sourcing, resale } = views.public.pressure;
  assert.deepEqual(
    { ...sourcing },
    {
      activeClaimedUnits: 1,
      recentPositiveReports: 1,
      availableUnits: 2,
      ratio: 1,
      unitsSource: "stock report",
      unitsAt: T0,
      boughtSince: 0,
    },
  );
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

const memberRow = (db, id) => ({ ...db.prepare("SELECT * FROM members WHERE id = ?").get(id) });
const viewAs = (db, b, m, now = T0) => bountyView(db, b, { viewer: { kind: "member", member: memberRow(db, m.id) }, now });
const check = (view, id) => view.estimate.checks.find((c) => c.id === id);
const stockChecks = [
  { id: "local-stock", ok: true, detail: "Branch stock confirmed" },
  { id: "availability", ok: true, detail: "Latest branch check found stock" },
  { id: "offer-fresh", ok: true, detail: "Offer price observed within 7 days" },
];

test("people's times are UK time: 31 Oct 2026, 14:05", () => {
  assert.equal(humanTime("2026-10-31T14:05:00.000Z"), "31 Oct 2026, 14:05");
  assert.equal(humanTime("2026-07-01T14:05:00.000Z"), "1 Jul 2026, 15:05"); // British Summer Time
  assert.equal(humanTime("not a date"), "an unknown time");
});

test("an empty-shelf report tells everyone alerted or holding a claim not to make the trip", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db, {}, fakeEstimate({ alert: { checks: stockChecks } })); // cap 3
  const ann = diamond(db, "Ann");
  const zed = diamond(db, "Zed");
  const bo = diamond(db, "Bo", { alertsOptIn: false }); // claims without an alert
  assert.deepEqual(dispatchAlerts(db, b.id, T0).sent.map((x) => x.name).sort(), ["Ann", "Zed"]);
  claim(db, { bountyId: b.id, memberId: ann.id, units: 2, now: at(10) });
  claim(db, { bountyId: b.id, memberId: bo.id, units: 1, now: at(10) });
  assert.equal(viewAs(db, b, ann, at(15)).trip.state, "full"); // claims hold the whole cap; holders may go
  assert.equal(viewAs(db, b, ann, at(15)).trip.go, true);

  const empty = addReport(db, { bountyId: b.id, memberId: zed.id, unitsSeen: 0 }, { now: at(20) });
  // Ann (alerted, claimed) and Bo (claimed) are told; Zed made the report.
  assert.equal(memberNotices(db, ann.id).length, 1);
  assert.equal(memberNotices(db, bo.id).length, 1);
  assert.equal(memberNotices(db, zed.id).length, 0);
  assert.match(memberNotices(db, bo.id)[0].message, /^Don't make the trip: a member reported none on the shelf at 2 Nov 2026, 09:20/);

  const inbox = memberAlerts(db, ann.id, { now: at(25) });
  assert.equal(inbox[0].trip.state, "paused");
  assert.equal(inbox[0].trip.go, false);
  assert.match(inbox[0].trip.headline, /^Don't make the trip: none on the shelf at 2 Nov 2026, 09:20/);
  assert.equal(inbox[0].shelf.state, "none");
  assert.equal(inbox[0].notices.length, 1);

  const view = viewAs(db, b, ann, at(25));
  assert.equal(view.trip.state, "paused");
  assert.match(view.viewer.stop, /Don't make the trip/);
  assert.equal(view.viewer.activeClaim.paused, true);
  assert.equal(view.viewer.canClaim, false);
  assert.equal(view.alert.canSend, false);
  // The card never ticks branch stock after an empty-shelf report.
  assert.equal(check(view, "local-stock").ok, false);
  assert.doesNotMatch(check(view, "local-stock").detail, /Branch stock confirmed/);
  assert.equal(check(view, "availability").ok, false);
  // Units on the shelf follow the report: none, so no pressure ratio.
  assert.equal(view.shelfUnits.units, 0);
  assert.equal(view.pressure.sourcing.availableUnits, 0);
  assert.equal(view.pressure.sourcing.ratio, null);

  // The operator confirming it reaches anyone not told yet, never twice.
  verifyReport(db, empty.id, true, { now: at(30) });
  assert.equal(memberNotices(db, ann.id).length, 1);
  // A newer sighting reopens the trip: the next read tells Ann, and the
  // stop notice is marked as replaced.
  addReport(db, { bountyId: b.id, memberId: zed.id, unitsSeen: 2 }, { now: at(40) });
  assert.equal(viewAs(db, b, ann, at(41)).trip.go, true);
  const reopened = memberNotices(db, ann.id);
  assert.deepEqual(reopened.map((n) => [n.kind, n.superseded]), [["reopen", false], ["stop", true]]);
  assert.match(reopened[0].message, /^Open for trips again at 2 Nov 2026, 09:41: every check passes now.*saw 2 units at 2 Nov 2026, 09:40/);
  // An older empty report behind the newer sighting stops nobody (BN2).
  addReport(db, { bountyId: b.id, memberId: zed.id, unitsSeen: 0, observedAt: at(35) }, { now: at(42) });
  assert.equal(viewAs(db, b, ann, at(43)).trip.go, true);
  memberAlerts(db, ann.id, { now: at(43) });
  assert.equal(memberNotices(db, ann.id).length, 2);
  assert.equal(memberNotices(db, bo.id).length, 2);
  // Withdrawing tells them too.
  withdrawBounty(db, b.id, { now: at(50) });
  const last = memberNotices(db, bo.id)[0];
  assert.equal(last.reason, "withdrawn");
  assert.match(last.message, /^Don't make the trip: the operator withdrew this bounty at 2 Nov 2026, 09:50/);
  assert.equal(memberAlerts(db, ann.id, { now: at(51) })[0].trip.state, "withdrawn");
});

test("a re-check whose branch check found none stops members already alerted", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db);
  const ann = diamond(db, "Ann");
  dispatchAlerts(db, b.id, T0);
  const none = fakeEstimate({
    alert: { eligible: false, reasons: ["Latest branch check found none on the shelf"], checks: [] },
    opportunity: { tier: "Review", reasons: ["Latest check found none on the shelf"], meetsThresholds: false },
    stock: { confirmed: false, availability: "out_of_stock", check: { in_stock: 0, units_seen: 0, checked_at: at(30) } },
  });
  const after = refreshBounty(db, b.id, none, at(31));
  assert.equal(after.alert_eligible, 0);
  assert.equal(after.opportunity_tier, "Review");
  assert.equal(after.cap, 0);
  const notices = memberNotices(db, ann.id);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].reason, "out-of-stock");
  assert.equal(memberAlerts(db, ann.id, { now: at(32) })[0].trip.state, "out-of-stock");
  // The same check on the next re-check does not repeat the notice.
  refreshBounty(db, b.id, none, at(33));
  assert.equal(memberNotices(db, ann.id).length, 1);
});

test("no asking-price data is unknown competition: the cap is 0 until a lookup is on record", () => {
  const db = memoryDb(schema);
  const none = fakeEstimate({ competition: { activeListings: 0, sellers: 0 } });
  const b = liveBounty(db, {}, none);
  assert.equal(b.cap, 0);
  assert.equal(b.competing_listings, null);
  assert.match(JSON.parse(b.cap_basis).notes.join(" "), /no asking-price lookup.*unknown \(not zero\)/);
  const view = bountyView(db, b, { now: T0 });
  assert.equal(view.pressure.resale.competingListings, null);
  assert.equal(view.pressure.resale.weeksOfSupply, null); // "not known", never "0 weeks of supply"
  assert.match(view.pressure.resale.note, /competition is not known/);
  withdrawBounty(db, b.id, { now: T0 });
  // A recorded lookup that found none is a real zero.
  const lookup = { provider: "ebay", fetched: at(-60) };
  const looked = createBounty(db, bountyInput(), { estimate: none, request: {}, lookup, now: T0 });
  assert.equal(looked.cap, 4); // floor(2.02 * 2) - 0
  assert.equal(looked.competing_listings, 0);
  const lv = bountyView(db, looked, { now: T0 });
  assert.equal(lv.pressure.resale.weeksOfSupply, null);
  assert.match(lv.pressure.resale.note, /lookup \(ebay, 2 Nov 2026, 08:00\) found no competing listings/);
});

test("units on the shelf come from the stock check, never a form figure", () => {
  const db = memoryDb(schema);
  const noCount = liveBounty(db, {}, fakeEstimate({ stock: { check: { units_seen: null } } }));
  assert.equal(noCount.cap, 0);
  assert.match(JSON.parse(noCount.cap_basis).notes.join(" "), /recorded no unit count/);
  assert.equal(bountyView(db, noCount, { now: T0 }).pressure.sourcing.availableUnits, null);
  withdrawBounty(db, noCount.id, { now: T0 });
  // Without a typed limit the count on the check is used.
  const b = liveBounty(db, { availableUnits: undefined }, fakeEstimate({ stock: { check: { units_seen: 2 } } }));
  assert.equal(JSON.parse(b.cap_basis).used.availableUnits, 2);
  assert.equal(b.cap, 2);
  const ann = diamond(db, "Ann");
  const made = claim(db, { bountyId: b.id, memberId: ann.id, units: 1, now: T0 });
  completeClaim(db, { claimId: made.id, memberId: ann.id, now: at(5) });
  const view = bountyView(db, b, { now: at(6) });
  assert.equal(view.shelfUnits.source, "stock check");
  assert.equal(view.shelfUnits.boughtSince, 1);
  assert.equal(view.pressure.sourcing.availableUnits, 1);
  // A sample still needs its hand-entered figure.
  assert.match(status(() => sampleBounty(db, { availableUnits: undefined })).message, /availableUnits is required/);
});

test("a lapsed stock check stops the card saying every check passes and stops claims", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db, { expiresAt: at(10 * 24 * 60) }, fakeEstimate({ alert: { checks: stockChecks } }));
  const ann = diamond(db, "Ann");
  const fresh = viewAs(db, b, ann, at(60));
  assert.equal(fresh.alert.canSend, true);
  assert.equal(fresh.viewer.canClaim, true);
  // The check was at 08:00 on 2 November; it counts for 2 days.
  const later = at(3 * 24 * 60);
  const view = viewAs(db, b, ann, later);
  assert.equal(view.alert.canSend, false);
  assert.match(view.alert.blockers.join(" "), /branch stock check from 2 Nov 2026, 08:00 has lapsed/);
  assert.equal(view.viewer.canClaim, false);
  assert.equal(view.trip.state, "stock-unconfirmed");
  assert.equal(check(view, "local-stock").ok, false);
  assert.equal(check(view, "availability").ok, false);
  assert.match(status(() => claim(db, { bountyId: b.id, memberId: ann.id, units: 1, now: later })).message, /lapsed/);
  assert.equal(dispatchAlerts(db, b.id, later).sent.length, 0);
  // A future-dated offer also blocks the trip.
  const db2 = memoryDb(schema);
  const ahead = liveBounty(db2, {}, fakeEstimate({ offer: { observed: "2026-11-05" } }));
  assert.match(bountyView(db2, ahead, { now: T0 }).claimBlockers.join(" "), /offer price is not from the last 7 days/);
});

test("a promotion price needs each member's own confirmation; alerts say the condition", () => {
  const db = memoryDb(schema);
  const promo = fakeEstimate({
    offer: { promotion: "Clubcard price: members only", price: 1500, regularPrice: null },
    alert: { checks: [{ id: "promotion", ok: true, detail: "Promotion eligibility confirmed" }] },
  });
  // The operator ticked that they qualify; that covers only the operator.
  const b = createBounty(db, bountyInput(), { estimate: promo, request: { promotionEligible: true }, now: T0 });
  const pat = diamond(db, "Pat");
  const sam = diamond(db, "Sam");
  const sent = dispatchAlerts(db, b.id, T0);
  assert.equal(sent.promotion.condition, "Clubcard price: members only");
  // Nobody said they qualify yet: each gets a question, no alert with figures (P2).
  assert.deepEqual(sent.sent, []);
  assert.deepEqual(sent.asked.map((x) => x.name).sort(), ["Pat", "Sam"]);
  assert.equal(db.prepare("SELECT promotion FROM alerts WHERE member_id = ?").get(pat.id).promotion, "Clubcard price: members only");
  const inbox = memberAlerts(db, pat.id, { now: T0 })[0];
  assert.equal(inbox.kind, "question");
  assert.equal(inbox.figures, null);
  assert.match(inbox.eligibility.question, /Do you qualify for it yourself/);
  assert.match(inbox.promotion.note, /Promotion price: Clubcard price: members only\. Confirm that you qualify/);
  assert.match(inbox.promotion.note, /regular price is not known/);
  assert.equal(viewAs(db, b, pat).estimate.economics, null);
  assert.match(viewAs(db, b, pat).figures.note, /shown once you say you qualify/);
  assert.equal(bountyView(db, b, { now: T0 }).estimate.economics, null);
  assert.ok(bountyView(db, b, { viewer: { kind: "operator" }, now: T0 }).estimate.economics);
  // Asking again does not repeat the question or send an alert.
  assert.match(dispatchAlerts(db, b.id, at(1)).notAlerted.find((x) => x.name === "Pat").reason, /waiting for their answer/);
  const before = viewAs(db, b, pat);
  assert.equal(before.viewer.promotion.confirmed, false);
  assert.match(before.viewer.promotion.risk, /you pay more/);
  assert.equal(check(before, "promotion").ok, false);
  assert.match(before.promotion.note, /each member confirms for themselves/);
  const refused = status(() => claim(db, { bountyId: b.id, memberId: pat.id, units: 1, now: T0 }));
  assert.equal(refused.status, 409);
  assert.match(refused.message, /Confirm that you qualify before claiming/);
  const made = claim(db, { bountyId: b.id, memberId: pat.id, units: 1, qualifiesForPromotion: true, now: T0 });
  assert.equal(made.promotion_confirmed, 1);
  assert.equal(check(viewAs(db, b, pat), "promotion").ok, true);
  assert.equal(check(viewAs(db, b, sam), "promotion").ok, false);
  assert.match(check(bountyView(db, b, { viewer: { kind: "operator" }, now: T0 }), "promotion").detail, /covers only you/);
  // With a known regular price the member sees what not qualifying costs.
  const db2 = memoryDb(schema);
  const known = fakeEstimate({ offer: { promotion: "New customers only", price: 1500, regularPrice: 1750 } });
  const b2 = createBounty(db2, bountyInput(), { estimate: known, request: { promotionEligible: true }, now: T0 });
  const ada = diamond(db2, "Ada");
  // No figures until she says she qualifies (P2).
  assert.equal(
    viewAs(db2, b2, ada).viewer.promotion.risk,
    "If you do not qualify you pay the regular price of £17.50, £2.50 more per unit.",
  );
  answerPromotion(db2, { bountyId: b2.id, memberId: ada.id, answer: "qualifies", now: T0 });
  assert.equal(
    viewAs(db2, b2, ada).viewer.promotion.risk,
    "If you do not qualify you pay the regular price of £17.50, £2.50 more per unit, which leaves about £5.00 profit per unit.",
  );
});

test("a member's stricter thresholds apply to their own alerts and claims", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db); // profit per unit £7.50, return 50%, trial batch 3
  const bob = diamond(db, "Bob", { rules: { minUnitProfit: 800 } });
  const ann = diamond(db, "Ann", { rules: { minReturn: 0.4, trialUnits: 1 } });
  assert.deepEqual(memberView(db, memberRow(db, bob.id), { now: T0 }).rules, { minUnitProfit: 800 });
  assert.equal(memberView(db, memberRow(db, bob.id), { now: T0 }).effectiveRules.minUnitProfit, 800);
  // Tighten only: looser values are refused; values equal to the agreed ones are not stored.
  assert.match(status(() => diamond(db, "Loose", { rules: { minUnitProfit: 300 } })).message, /never loosen/);
  assert.match(status(() => diamond(db, "Wide", { rules: { maxWeightKg: 5 } })).message, /never loosen/);
  assert.equal(status(() => diamond(db, "Odd", { rules: { colour: 1 } })).status, 400);
  assert.deepEqual(memberView(db, diamond(db, "Same", { rules: { minUnitProfit: 500 } }), { now: T0 }).rules, {});
  const sent = dispatchAlerts(db, b.id, T0);
  assert.ok(!sent.sent.some((x) => x.name === "Bob"));
  assert.match(sent.notAlerted.find((x) => x.name === "Bob").reason, /stricter thresholds: Profit per unit £7.50 is below your £8.00/);
  assert.ok(sent.sent.some((x) => x.name === "Ann"));
  const refused = status(() => claim(db, { bountyId: b.id, memberId: bob.id, units: 1, now: T0 }));
  assert.equal(refused.status, 409);
  assert.match(refused.message, /fails your stricter thresholds: Profit per unit £7.50 is below your £8.00/);
  const bobView = viewAs(db, b, bob);
  assert.equal(bobView.viewer.canClaim, false);
  assert.match(bobView.viewer.blockers.join(" "), /below your £8.00/);
  // Ann's own trial batch of 1 limits her claim.
  assert.equal(viewAs(db, b, ann).maxClaimUnits, 1);
  assert.equal(status(() => claim(db, { bountyId: b.id, memberId: ann.id, units: 2, now: T0 })).status, 409);
  assert.equal(claim(db, { bountyId: b.id, memberId: ann.id, units: 1, now: T0 }).units, 1);
  // A tightened return fails with the reason.
  updateMember(db, ann.id, { rules: { minReturn: 0.6 } }, { now: T0 });
  assert.deepEqual(
    viewAs(db, b, ann).viewer.ruleFailures,
    ["Return on purchase price 50% is below your 60%"],
  );
});

test("one member's units of an unproven item stay within one trial batch", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db, {}, fakeEstimate({ competition: { activeListings: 0 } }), T0);
  // No lookup: cap 0. Use a bounty with room instead.
  withdrawBounty(db, b.id, { now: T0 });
  const roomy = createBounty(
    db,
    bountyInput({ salesPerWeek: 10, sellWindowWeeks: 6 }),
    { estimate: fakeEstimate({ sample: { count: 90 } }), request: {}, now: T0 },
  );
  assert.ok(roomy.cap >= 6, String(roomy.cap));
  const m = diamond(db, "M");
  const first = claim(db, { bountyId: roomy.id, memberId: m.id, units: 3, now: T0 });
  completeClaim(db, { claimId: first.id, memberId: m.id, now: at(10) });
  const again = status(() => claim(db, { bountyId: roomy.id, memberId: m.id, units: 3, now: at(20) }));
  assert.equal(again.status, 409);
  assert.match(again.message, /already hold or have bought 3 units of this item/);
  assert.equal(viewAs(db, roomy, m, at(20)).viewer.canClaim, false);
  // Releasing frees nothing that was bought; a new bounty for the barcode is no way round it.
  withdrawBounty(db, roomy.id, { now: at(30) });
  const next = createBounty(
    db,
    bountyInput({ salesPerWeek: 10, sellWindowWeeks: 6 }),
    { estimate: fakeEstimate({ sample: { count: 90 } }), request: {}, now: at(30) },
  );
  assert.match(status(() => claim(db, { bountyId: next.id, memberId: m.id, units: 1, now: at(31) })).message, /trial batch of 3 units/);
  assert.match(
    dispatchAlerts(db, next.id, at(31)).notAlerted.find((x) => x.name === "M").reason,
    /Already holds or bought a trial batch/,
  );
  // Partial: 2 bought leaves 1.
  const n = diamond(db, "N");
  const part = claim(db, { bountyId: next.id, memberId: n.id, units: 2, now: at(32) });
  completeClaim(db, { claimId: part.id, memberId: n.id, now: at(33) });
  assert.match(status(() => claim(db, { bountyId: next.id, memberId: n.id, units: 2, now: at(34) })).message, /at most 1 more unit/);
  assert.equal(claim(db, { bountyId: next.id, memberId: n.id, units: 1, now: at(34) }).units, 1);
});

test("before the locality's 30-item validation is complete, cards and alerts say so", () => {
  const db = memoryDb(schema, auditSchema);
  const b = liveBounty(db);
  const ann = diamond(db, "Ann");
  const view = bountyView(db, b, { now: T0 });
  assert.equal(view.validation.complete, false);
  assert.equal(view.validation.warning, "Pilot not validated in Camden: 0 of 30 items checked against stored evidence");
  const sent = dispatchAlerts(db, b.id, T0);
  assert.match(sent.warning, /Pilot not validated in Camden/);
  assert.match(memberAlerts(db, ann.id, { now: T0 })[0].warning, /Pilot not validated in Camden/);
  // Items without a recorded offer and evidence do not count (R2B2).
  const insert = db.prepare("INSERT INTO validation_items(locality, barcode, title, retailer) VALUES('Camden', ?, 'Item', 'Argos')");
  for (let i = 0; i < 30; i++) insert.run(String(10000000 + i));
  const undone = bountyView(db, b, { now: T0 });
  assert.equal(undone.validation.complete, false);
  assert.match(undone.validation.warning, /0 of 30 items checked against stored evidence/);
  // The warning follows the audit contract: complete but not signed off
  // still warns; only a sign-off clears it; anything missing is not signed off.
  const progress = { target: 30, audited: 30, evidenced: 30, passed: 27, complete: true, signedOff: null };
  assert.equal(
    validationFrom("Camden", progress).warning,
    "Pilot audit in Camden: 27 of 30 items passed, not yet signed off. Treat these figures with care.",
  );
  const signed = validationFrom("Camden", { ...progress, signedOff: { at: at(-60), passed: 27, evidenced: 30 } });
  assert.equal(signed.warning, null);
  assert.equal(signed.signedOffAt, at(-60));
  assert.match(validationFrom("Camden", { ...progress, signedOff: undefined }).warning, /not yet signed off/);
  assert.match(validationFrom("Camden", { audited: 30, passed: 30, complete: true, signedOff: { at: T0 } }).warning, /^Pilot not validated in Camden: 0 of 30/);
  assert.match(validationFrom("Camden", null).warning, /^Pilot not validated in Camden: 0 of 30/);
  assert.match(
    validationFrom("Camden", { ...progress, evidenced: 12, complete: false, signedOff: { at: T0 } }).warning,
    /^Pilot not validated in Camden: 12 of 30/,
  );
  // Without the audit tables nothing is validated.
  const bare = memoryDb(schema);
  assert.equal(bountyView(bare, liveBounty(bare), { now: T0 }).validation.complete, false);
});

test("a source that does not permit display hides the offer from members and visitors", () => {
  const db = memoryDb(schema);
  const refused = fakeEstimate({ extra: { permission: { permitted: false, basis: "Not permitted for awin (Argos)" } } });
  refused.alert = { eligible: false, reasons: ["No recorded permission to display this source"], checks: [] };
  const b = liveBounty(db, {}, refused);
  const ann = diamond(db, "Ann");
  for (const view of [bountyView(db, b, { now: T0 }), viewAs(db, b, ann)]) {
    assert.equal(view.title, "Details not shown");
    assert.equal(view.retailer, null);
    assert.equal(view.barcode, null);
    assert.equal(view.estimate.offer, null);
    assert.equal(view.estimate.economics, null);
    assert.equal(view.estimate.unitCost, null);
    assert.equal(view.opportunity.unitProfit, undefined);
    assert.equal(view.display.hidden, true);
    const raw = JSON.stringify(view);
    for (const secret of ["Travel kettle", "Argos", "3200", GTIN]) assert.ok(!raw.includes(secret), secret);
  }
  const op = bountyView(db, b, { viewer: { kind: "operator" }, now: T0 });
  assert.equal(op.title, "Travel kettle");
  assert.equal(op.estimate.offer.price, 1500);
  assert.match(op.display.label, /^Not shown to members or visitors: Not permitted/);

  // A recorded refusal takes effect at once, even after an eligible estimate.
  const db2 = memoryDb(schema);
  db2.exec(PERMISSIONS_TABLE);
  db2.prepare("INSERT INTO permissions(provider, programme, display, note) VALUES('awin', 'Argos', 1, 'Agreed')").run();
  const live = liveBounty(db2);
  const bo = diamond(db2, "Bo");
  assert.equal(dispatchAlerts(db2, live.id, T0).sent.length, 1);
  assert.equal(viewAs(db2, live, bo).title, "Travel kettle");
  db2.prepare("UPDATE permissions SET display = 0, note = 'Terms forbid prices' WHERE provider = 'awin'").run();
  const after = viewAs(db2, live, bo);
  assert.equal(after.title, "Details not shown");
  assert.equal(after.viewer.canClaim, false);
  assert.match(after.claimBlockers.join(" "), /no longer permits display/);
  const inbox = memberAlerts(db2, bo.id, { now: T0 })[0];
  assert.equal(inbox.title, "Details not shown");
  assert.equal(inbox.retailer, null);
});

test("guards: completing more than claimed, another barcode on refresh, claimed members, the 24-hour window", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db);
  const ann = diamond(db, "Ann");
  const one = claim(db, { bountyId: b.id, memberId: ann.id, units: 1, now: T0 });
  const over = status(() => completeClaim(db, { claimId: one.id, memberId: ann.id, unitsBought: 3, now: T0 }));
  assert.equal(over.status, 400);
  assert.equal(db.prepare("SELECT status, units FROM claims WHERE id = ?").get(one.id).units, 1);
  // A member holding a claim gets no alert.
  const sent = dispatchAlerts(db, b.id, T0);
  assert.equal(sent.notAlerted.find((x) => x.name === "Ann").reason, "Already claimed this bounty");
  // An offer for another barcode never replaces this bounty's evidence.
  const other = refreshBounty(db, b.id, fakeEstimate({ offer: { gtin: "05000000000001", title: "Other thing" } }), at(5));
  assert.equal(other.alert_eligible, 0);
  assert.match(other.alert_reasons, /no longer has this bounty's barcode/);
  assert.equal(JSON.parse(other.estimate).offer.title, "Travel kettle 0.5 l");
  // A sighting older than 24 hours is not recent sourcing pressure.
  const bo = diamond(db, "Bo");
  addReport(db, { bountyId: b.id, memberId: bo.id, unitsSeen: 4, observedAt: at(-25 * 60) }, { now: T0 });
  assert.equal(bountyView(db, b, { now: T0 }).pressure.sourcing.recentPositiveReports, 0);
  addReport(db, { bountyId: b.id, memberId: bo.id, unitsSeen: 4, observedAt: at(-23 * 60) }, { now: T0 });
  assert.equal(bountyView(db, b, { now: T0 }).pressure.sourcing.recentPositiveReports, 1);
});

// ------------------------------------------------------------------ routes

const tempDirs = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

async function setup({ db: given = null, ...over } = {}) {
  const db = given ?? memoryDb(schema);
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
      return typeof state.estimate?.remake === "function" ? state.estimate.remake(request) : state.estimate;
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
    const results = await Promise.all(ids.map((memberId) => api.call("POST", `/api/bounties/${b.id}/claims`, { memberId, units: 1, ...TRIP })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    const won = results.find((r) => r.status === 201);
    assert.match(won.body.message, /reserves your attention on this bounty, not stock at the retailer/);
    assert.equal(won.body.bounty.remaining, 0);
    const winner = won.body.claim;
    const release = await api.call("POST", `/api/claims/${winner.id}/release`, { memberId: winner.member_id });
    assert.equal(release.status, 200);
    // The re-check now fails: claims stop.
    state.estimate = ineligible("Offer observation has expired (8 days old)");
    const blocked = await api.call("POST", `/api/bounties/${b.id}/claims`, { memberId: ids[0], units: 1, ...TRIP });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /Offer observation has expired/);
    state.estimate = fakeEstimate({ stock: { check: { in_stock: 1, units_seen: 1 } } });
    const made = await api.call("POST", `/api/bounties/${b.id}/claims`, { memberId: ids[0], units: 1, ...TRIP });
    assert.equal(made.status, 201);
    const done = await api.call("POST", `/api/claims/${made.body.claim.id}/complete`, { memberId: ids[0] });
    assert.equal(done.status, 200);
    assert.match(done.body.message, /purchase receipt and the payout record/);
    assert.equal((await api.call("POST", `/api/bounties/${b.id}/claims`, { memberId: 999, units: 1, ...TRIP })).status, 404);
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

test("routes: honest creation messages, asking-price lookups, re-checks and member thresholds", async () => {
  const lookups = [];
  const box = { lookup: null };
  const { api, state, calls } = await setup({
    askingLookup: (_db, barcode, opts) => {
      lookups.push({ barcode, now: opts.now });
      return box.lookup;
    },
  });
  try {
    // A Review estimate (for example out of stock or category rules) is created but cannot alert.
    state.estimate = fakeEstimate({
      opportunity: { tier: "Review", reasons: ["Category rules were not checked"], meetsThresholds: false },
      alert: { eligible: false, reasons: ["Not a Priority 1 or 2 opportunity under the buying thresholds"], checks: [] },
    });
    const review = await api.call("POST", "/api/bounties", { ...bountyInput(), estimate: request });
    assert.equal(review.status, 201);
    assert.match(review.body.message, /^Bounty created as Review, but it cannot send alerts or take claims: The buy-alert checks do not pass: Not a Priority 1/);
    assert.equal(review.body.bounty.alert.canSend, false);
    await api.call("POST", `/api/bounties/${review.body.bounty.id}/withdraw`, {});

    // No listings and no lookup on record: cap 0. With a lookup: a real zero.
    state.estimate = fakeEstimate({ competition: { activeListings: 0, sellers: 0 } });
    const unknown = await api.call("POST", "/api/bounties", { ...bountyInput(), estimate: request });
    assert.equal(unknown.body.bounty.cap, 0);
    assert.match(unknown.body.message, /distribution cap is 0/);
    assert.deepEqual(lookups.at(-1), { barcode: GTIN, now: T0 });
    box.lookup = { provider: "ebay", fetched: at(-30) };
    const before = calls.length;
    const rechecked = await api.call("POST", `/api/bounties/${unknown.body.bounty.id}/recheck`, {});
    assert.equal(rechecked.status, 200);
    assert.equal(calls.length, before + 1);
    assert.equal(rechecked.body.bounty.cap, 4);
    assert.match(rechecked.body.message, /^Evidence re-checked \(Priority 2\) with a cap of 4 units/);
    const b = rechecked.body.bounty;

    // Member thresholds: tighten only.
    const loose = await api.call("POST", "/api/members", { name: "Lo", rules: { minUnitProfit: 100 } });
    assert.equal(loose.status, 400);
    const strict = await api.call("POST", "/api/members", {
      name: "Hi", paidTier: "diamond", paidUntil: "2026-12-31", rules: { minUnitProfit: 800 },
    });
    assert.deepEqual(strict.body.member.rules, { minUnitProfit: 800 });
    const refused = await api.call("POST", `/api/bounties/${b.id}/claims`, { memberId: strict.body.member.id, units: 1, ...TRIP });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /below your £8.00/);
    const eased = await api.call("PATCH", `/api/members/${strict.body.member.id}`, { rules: { minUnitProfit: 700 } });
    assert.equal(eased.status, 200);

    // Claim messages use people's times; the promotion flag must be true or false.
    const ann = (await api.call("POST", "/api/members", { name: "Ann", paidTier: "diamond", paidUntil: "2026-12-31", alertsOptIn: true, alertLocalities: ["Camden"] })).body.member;
    assert.equal((await api.call("POST", `/api/bounties/${b.id}/claims`, { memberId: ann.id, units: 1, qualifiesForPromotion: "yes", ...TRIP })).status, 400);
    const made = await api.call("POST", `/api/bounties/${b.id}/claims`, { memberId: ann.id, units: 1, ...TRIP });
    assert.equal(made.status, 201);
    assert.match(made.body.message, /^Claim recorded for 1 unit until 2 Nov 2026, 12:00\./);

    // An empty-shelf report lands in Ann's inbox as a stop notice.
    const zed = (await api.call("POST", "/api/members", { name: "Zed" })).body.member;
    const neg = await api.call("POST", `/api/bounties/${b.id}/reports`, { memberId: zed.id, unitsSeen: 0 });
    assert.match(neg.body.message, /told not to make the trip/);
    const inbox = await api.call("GET", `/api/members/${ann.id}/alerts`);
    assert.equal(inbox.body.stopNotices.length, 1);
    assert.match(inbox.body.stopNotices[0].message, /^Don't make the trip/);
    const mine = (await api.call("GET", `/api/bounties/${b.id}?viewer=${ann.id}`)).body.bounty;
    assert.equal(mine.trip.state, "paused");
    assert.equal(mine.viewer.activeClaim.paused, true);
    // Verifying it re-checks the evidence with the new branch check.
    const n = calls.length;
    const verified = await api.call("POST", `/api/reports/${neg.body.reportId}/verify`, { accurate: true });
    assert.equal(verified.status, 200);
    assert.equal(calls.length, n + 1);

    // A sample bounty's report never promises points.
    const sample = (await api.call("POST", "/api/bounties", bountyInput({ sample: true, competingListings: 1, competingSellers: 1 }))).body.bounty;
    const practice = await api.call("POST", `/api/bounties/${sample.id}/reports`, { memberId: zed.id, unitsSeen: 2 });
    assert.match(practice.body.message, /practice and earns no reputation points/);
    assert.doesNotMatch(practice.body.message, /earns reputation points once/);
    assert.equal((await api.call("POST", `/api/bounties/${sample.id}/claims`, { memberId: ann.id, units: 1, ...TRIP })).status, 409);
  } finally {
    await api.close();
  }
});

// ------------------------------------------------------------ round two

test("every read re-checks the evidence: a branch check that found none stops the trip and tells members (R2B1)", async () => {
  const db = memoryDb(schema, auditSchema);
  const { api } = await setup({ db });
  try {
    const b = liveBounty(db, {}, fakeEstimate({ alert: { checks: stockChecks } }));
    const ann = diamond(db, "Ann"); // alerted
    const bo = diamond(db, "Bo", { alertsOptIn: false }); // holds a claim, never alerted
    assert.deepEqual(dispatchAlerts(db, b.id, T0).sent.map((x) => x.name), ["Ann"]);
    claim(db, { bountyId: b.id, memberId: bo.id, units: 1, now: T0 });
    // A helper records a branch check that found none. Nothing else runs.
    recordCheck(
      db,
      { barcode: GTIN, retailer: "Argos", locality: "Camden", checkedAt: at(-10), method: "in_store", inStock: false, unitsSeen: 0 },
      { now: T0 },
    );
    const inbox = (await api.call("GET", `/api/members/${ann.id}/alerts`)).body;
    assert.equal(inbox.alerts[0].trip.state, "out-of-stock");
    assert.equal(inbox.alerts[0].trip.go, false);
    assert.match(inbox.alerts[0].trip.headline, /^Don't make the trip: the latest branch check \(2 Nov 2026, 08:50\) found none on the shelf/);
    assert.equal(inbox.stopNotices.length, 1);
    assert.match(inbox.stopNotices[0].message, /^Don't make the trip: the latest branch check \(2 Nov 2026, 08:50\) found none/);
    // Bo, who claimed without an alert, was told in the same read.
    assert.equal(memberNotices(db, bo.id).length, 1);
    const card = (await api.call("GET", `/api/bounties/${b.id}?viewer=${bo.id}`)).body.bounty;
    assert.equal(card.trip.state, "out-of-stock");
    assert.equal(card.viewer.activeClaim.paused, true);
    assert.equal(check(card, "availability").ok, false);
    assert.match(check(card, "local-stock").detail, /newer branch check \(2 Nov 2026, 08:50\) found none/);
    assert.equal((await api.call("GET", "/api/bounties")).body.bounties[0].trip.state, "out-of-stock");
    // Reads never repeat the notice.
    assert.equal(memberNotices(db, ann.id).length, 1);
    assert.equal(memberNotices(db, bo.id).length, 1);
    // recheckOpenBounties (for the lead after a branch check) reports it,
    // for any spelling of the barcode, and only at that retailer.
    const again = recheckOpenBounties(db, { barcode: "5012345678900", retailer: "argos", now: T0 });
    assert.equal(again.checked, 1);
    assert.equal(again.stopped[0].bountyId, b.id);
    assert.match(again.stopped[0].reasons[0], /found none on the shelf/);
    assert.equal(again.stopped[0].noticesSent, 0);
    assert.equal(recheckOpenBounties(db, { barcode: GTIN, retailer: "Tesco", now: T0 }).checked, 0);
    assert.equal(recheckOpenBounties(db, { barcode: "not a barcode", now: T0 }).checked, 0);
  } finally {
    await api.close();
  }
});

test("recheckOpenBounties sends the notice itself when nobody has read the bounty", () => {
  const db = memoryDb(schema, auditSchema);
  const b = liveBounty(db);
  const ann = diamond(db, "Ann");
  dispatchAlerts(db, b.id, T0);
  recordCheck(db, { barcode: GTIN, retailer: "Argos", locality: "Camden", checkedAt: at(-5), method: "phone", inStock: false, unitsSeen: 0 }, { now: T0 });
  const out = recheckOpenBounties(db, { barcode: GTIN, now: T0 });
  assert.deepEqual(out.stopped.map((x) => [x.bountyId, x.noticesSent]), [[b.id, 1]]);
  assert.equal(memberNotices(db, ann.id).length, 1);
  // A check in another locality does not count.
  const db2 = memoryDb(schema, auditSchema);
  const b2 = liveBounty(db2);
  recordCheck(db2, { barcode: GTIN, retailer: "Argos", locality: "Leeds", checkedAt: at(-5), method: "phone", inStock: false, unitsSeen: 0 }, { now: T0 });
  assert.equal(tripState(db2, b2, T0).go, true);
});

test("a price rise or a removed offer in the evidence stops the trip on the next read, and a fall back reopens it", () => {
  const db = memoryDb(schema);
  db.exec(RESEARCH_TABLE);
  const row = db.prepare(
    "INSERT INTO research(provider, source_id, kind, title, price, observed) VALUES('awin', 'A1', 'Retail offer', 'Travel kettle 0.5 l', 1500, '2026-11-01')",
  );
  row.run();
  const b = liveBounty(db, {}, fakeEstimate({ alert: { checks: stockChecks } }));
  const ann = diamond(db, "Ann");
  dispatchAlerts(db, b.id, T0);
  assert.equal(viewAs(db, b, ann).trip.go, true);
  db.prepare("UPDATE research SET price = 3400, observed = '2026-11-02' WHERE source_id = 'A1'").run();
  const risen = viewAs(db, b, ann, at(5));
  assert.equal(risen.trip.state, "blocked");
  assert.equal(risen.trip.label, "Price has risen");
  assert.match(risen.trip.headline, /^Don't make the trip: the offer price has risen from £15.00 to £34.00/);
  assert.equal(check(risen, "offer-fresh").ok, false);
  assert.equal(risen.checked.price, "2026-11-01"); // a higher price never freshens the old one
  assert.match(risen.mainUncertainty, /price has risen/);
  assert.match(memberNotices(db, ann.id)[0].message, /^Don't make the trip: the offer price has risen from £15.00 to £34.00/);
  // Back to the old price, seen again today: open again, and Ann is told.
  db.prepare("UPDATE research SET price = 1500 WHERE source_id = 'A1'").run();
  const back = viewAs(db, b, ann, at(10));
  assert.equal(back.trip.go, true);
  assert.equal(back.checked.priceLabel, "Price seen 2 Nov 2026");
  assert.deepEqual(memberNotices(db, ann.id).map((n) => n.kind), ["reopen", "stop"]);
  // The offer leaving the evidence stops it again.
  db.prepare("DELETE FROM research").run();
  const gone = viewAs(db, b, ann, at(15));
  assert.equal(gone.trip.label, "Offer no longer listed");
  assert.equal(memberNotices(db, ann.id).filter((n) => n.kind === "stop" && !n.superseded).length, 1);
});

test("independent sales that age out of the 90-day window stop the trip", () => {
  const db = memoryDb(schema);
  const used = ["Ann's Attic", "Bob Sells", "Cy Store"].map((seller) => ({ seller, observed: "2026-08-03T12:00:00.000Z", price: 3200 }));
  const b = liveBounty(db, {}, fakeEstimate({ sample: { used } }));
  assert.equal(JSON.parse(b.estimate).sample.sellers.length, 3);
  assert.equal(tripState(db, b, T0).go, true);
  const later = at(24 * 60);
  const list = blockerList(db, b, later);
  assert.deepEqual(list.map((x) => x.id), ["sales-aged"]);
  assert.match(list[0].text, /Only 0 of the 3 independent sales behind the figures are still from the last 90 days: fewer than 3/);
  assert.equal(tripState(db, b, later).label, "Sales evidence out of date");
});

test("stock checks: a check one hour past its window blocks, an undated one blocks (BT5, BT7)", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db, { expiresAt: at(10 * 24 * 60) });
  const checked = Date.parse("2026-11-02T08:00:00.000Z");
  const hour = 3600000;
  const day = 24 * hour;
  assert.equal(stockLapse(b, new Date(checked + CHECK_VALID_DAYS * day - hour).toISOString()).lapsed, false);
  const late = new Date(checked + CHECK_VALID_DAYS * day + hour).toISOString();
  assert.equal(stockLapse(b, late).lapsed, true);
  assert.equal(tripState(db, b, late).state, "stock-unconfirmed");
  const db2 = memoryDb(schema);
  const undated = liveBounty(db2, {}, fakeEstimate({ stock: { check: { checked_at: null } } }));
  assert.equal(JSON.parse(undated.estimate).stock.checkedAt, null);
  assert.equal(stockLapse(undated, T0).lapsed, true);
  assert.match(blockerList(db2, undated, T0)[0].text, /No dated branch stock check is recorded/);
  assert.equal(tripState(db2, undated, T0).go, false);
});

test("an older empty report behind a newer one that paused sends no second notice (BN2)", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db);
  const ann = diamond(db, "Ann");
  const zed = diamond(db, "Zed");
  dispatchAlerts(db, b.id, T0);
  addReport(db, { bountyId: b.id, memberId: zed.id, unitsSeen: 0, observedAt: at(50) }, { now: at(50) });
  assert.equal(memberNotices(db, ann.id).length, 1);
  addReport(db, { bountyId: b.id, memberId: zed.id, unitsSeen: 0, observedAt: at(45) }, { now: at(51) });
  viewAs(db, b, ann, at(52));
  memberAlerts(db, ann.id, { now: at(52) });
  assert.equal(memberNotices(db, ann.id).length, 1);
});

test("member thresholds fail closed: unknown profit, and a weight exactly at the limit (BM2, BM3)", () => {
  const db = memoryDb(schema);
  const unknown = liveBounty(db, {}, fakeEstimate({ opportunity: { unitProfit: null } }));
  const strict = diamond(db, "Strict", { rules: { minUnitProfit: 600 } });
  assert.deepEqual(memberRuleFailures(unknown, memberRow(db, strict.id)), ["Profit per unit unknown, so your thresholds cannot be checked"]);
  assert.match(dispatchAlerts(db, unknown.id, T0).notAlerted.find((x) => x.name === "Strict").reason, /Profit per unit unknown/);
  // Without rules of their own the member is not judged on them.
  assert.deepEqual(memberRuleFailures(unknown, memberRow(db, diamond(db, "Easy").id)), []);
  const db2 = memoryDb(schema);
  const b = liveBounty(db2); // 0.9 kg a unit
  const at09 = diamond(db2, "Limit", { rules: { maxWeightKg: 0.9 } });
  assert.deepEqual(memberRuleFailures(b, memberRow(db2, at09.id)), ["Unit weighs 0.9 kg, not under your limit of 0.9 kg"]);
  const roomy = diamond(db2, "Roomy", { rules: { maxWeightKg: 1 } });
  assert.deepEqual(memberRuleFailures(b, memberRow(db2, roomy.id)), []);
});

test("member rules with names from Object.prototype are refused, not a crash (R2B3)", () => {
  const db = memoryDb(schema);
  for (const key of ["toString", "valueOf", "constructor", "__proto__"]) {
    const rules = JSON.parse(`{"${key}": 1}`);
    const made = status(() => createMember(db, { name: "Odd " + key, rules }, { now: T0 }));
    assert.equal(made.status, 400, key);
    assert.match(made.message, /rules/, key);
    const ok = createMember(db, { name: "Fine " + key }, { now: T0 });
    assert.equal(status(() => updateMember(db, ok.id, { rules }, { now: T0 })).status, 400, key);
  }
});

test("routes: a locality that is not text is refused with 400 (R2B4)", async () => {
  const { api } = await setup();
  try {
    for (const locality of [{ toString: 1 }, [["Camden"]], 7])
      assert.equal((await api.call("POST", "/api/bounties", { ...bountyInput(), estimate: { ...request, locality } })).status, 400);
    assert.equal((await api.call("POST", "/api/bounties", { ...bountyInput({ locality: { toString: 1 } }), estimate: request })).status, 400);
    assert.equal((await api.call("POST", "/api/bounties", { ...bountyInput(), estimate: { ...request, locality: "camden" } })).status, 201);
  } finally {
    await api.close();
  }
});

test("a claim takes the member's own journey and is checked at the units claimed (R2M1, R2P1)", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db);
  const ann = diamond(db, "Ann");
  // Both journey figures are required; a blank is never zero.
  for (const journey of [undefined, { cost: 300 }, { minutes: 30 }, { cost: "", minutes: 30 }, { cost: null, minutes: 0 }])
    assert.match(
      status(() => rawClaim(db, { bountyId: b.id, memberId: ann.id, units: 1, journey, check: ownCheck(1), now: T0 })).message,
      /A blank is never counted as zero/,
    );
  assert.equal(status(() => journeyInput({ journeyCost: -1, journeyMinutes: 10 })).status, 400);
  assert.deepEqual(journeyInput({ journeyCost: 0, journeyMinutes: 0 }), { cost: 0, minutes: 0 });
  // Figures for other units, or another journey, are refused.
  const wrongUnits = status(() => rawClaim(db, { bountyId: b.id, memberId: ann.id, units: 1, journey: JOURNEY, check: ownCheck(2), now: T0 }));
  assert.equal(wrongUnits.status, 409);
  assert.match(wrongUnits.message, /worked out for 2 units, not your 1/);
  const wrongTrip = status(() =>
    rawClaim(db, { bountyId: b.id, memberId: ann.id, units: 1, journey: JOURNEY, check: ownCheck(1, { cost: 900, minutes: 30 }), now: T0 }),
  );
  assert.match(wrongTrip.message, /do not use your journey cost/);
  // Failing on the member's own figures: 409 with the reasons.
  const failing = fakeEstimate({
    units: 1,
    journeyCost: 300,
    alert: { eligible: false, reasons: ["Below the hourly floor or working time unknown"], checks: [] },
    opportunity: { meetsThresholds: false, reasons: ["Profit per unit below £5"] },
  });
  const refused = status(() => rawClaim(db, { bountyId: b.id, memberId: ann.id, units: 1, journey: JOURNEY, check: failing, now: T0 }));
  assert.equal(refused.status, 409);
  assert.equal(
    refused.message,
    "At 1 unit with your journey (£3.00, 30 minutes) this trip fails: Profit per unit below £5; Below the hourly floor or working time unknown.",
  );
  assert.equal(memberTripCheck({ error: "Offer not found" }, { units: 1, journey: JOURNEY }).ok, false);
  // Passing: the claim keeps the journey and the figures it was checked on.
  const made = rawClaim(db, { bountyId: b.id, memberId: ann.id, units: 1, journey: JOURNEY, check: ownCheck(1), now: T0 });
  assert.equal(made.journey_cost, 300);
  assert.equal(made.journey_minutes, 30);
  assert.equal(JSON.parse(made.figures).units, 1);
  assert.equal(JSON.parse(made.figures).unitProfit, 700);
  const mine = viewAs(db, b, ann).claims[0];
  assert.equal(mine.journeyCost, 300);
  assert.equal(mine.figures.contribution, 700);
});

test("bounty figures say how many units and whose journey; category, attributes, checks and access needs are shown", () => {
  const db = memoryDb(schema);
  const est = fakeEstimate({
    offer: { pack: "1", attributeSource: { pack: "operator", condition: "assumed" }, operatorConfirmed: ["pack"] },
    alert: { checks: [{ id: "exact-match", ok: true, detail: "Barcode, size, pack, model and condition match" }, ...stockChecks] },
    extra: {
      category: { chosen: "general", suggested: "clothing", applied: "clothing", reason: null, warning: "The title suggests clothing. You chose General, so the clothing rules still apply" },
      mainUncertainty: "Whether buyers still pay about £32.00: the estimate rests on 26 confirmed sales",
    },
  });
  const b = createBounty(db, bountyInput(), {
    estimate: est,
    request: { offer: { provider: "awin", sourceId: "A1" }, units: 2, costs: { journeyCost: 500, journeyMinutes: 30 } },
    now: T0,
  });
  const ann = diamond(db, "Ann");
  dispatchAlerts(db, b.id, T0);
  const view = viewAs(db, b, ann);
  assert.equal(
    view.figures.label,
    "Figures for 2 units, the most one member can claim, using the operator's return journey (£5.00, 30 minutes). Your own journey cost and time are used when you claim.",
  );
  assert.equal(view.figures.units, 2);
  assert.equal(view.category.applied, "Clothing");
  assert.equal(view.category.suggested, "Clothing");
  assert.match(view.category.warning, /clothing rules still apply/);
  assert.deepEqual(view.attributes.map((a) => a.text), [
    "Pack 1: confirmed by the operator, not stated by the source",
    "Condition new: assumed for a shop's offer, not stated by the source",
  ]);
  assert.match(check(view, "exact-match").detail, /Pack 1: confirmed by the operator, not stated by the source/);
  assert.equal(view.checked.priceLabel, "Price seen 1 Nov 2026");
  assert.equal(view.checked.stockLabel, "Stock last checked 2 Nov 2026, 08:00 (branch check)");
  assert.match(view.mainUncertainty, /^Whether buyers still pay about £32.00/);
  assert.deepEqual(view.accessNeeds.map((n) => n.label), ["Widely accessible"]);
  const inbox = memberAlerts(db, ann.id, { now: T0 })[0];
  assert.equal(inbox.kind, "alert");
  assert.equal(inbox.category.applied, "Clothing");
  assert.equal(inbox.attributes[0].text, "Pack 1: confirmed by the operator, not stated by the source");
  assert.deepEqual(inbox.accessNeeds.map((n) => n.id), ["widely-accessible"]);
  assert.match(inbox.figures.label, /^Figures for 2 units/);
  assert.deepEqual(attributeNotes({ pack: null }), []);
  // Few units on the shelf: limited local stock.
  const db2 = memoryDb(schema);
  const few = liveBounty(db2, {}, fakeEstimate({ stock: { check: { units_seen: 3 } } }));
  assert.deepEqual(bountyView(db2, few, { now: T0 }).accessNeeds.map((n) => n.label), ["Limited local stock"]);
  // The older category shape still reads.
  const db3 = memoryDb(schema);
  const old = liveBounty(db3, {}, fakeEstimate({ extra: { category: { id: "food", name: "Food", chosen: "suggested" } } }));
  assert.equal(bountyView(db3, old, { now: T0 }).category.applied, "Food");
});

test("tier reasons follow the card's current pressure and competition (R2Q8)", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db, {}, fakeEstimate({ opportunity: { reasons: ["Resale competition high or unknown", "Sourcing pressure high or unknown"] } }));
  const view = bountyView(db, b, { now: T0 });
  assert.equal(view.pressure.sourcing.ratio, 0);
  assert.match(view.opportunity.reasons[1], /^Sourcing pressure is 0 now, within the 0.5 Priority 1 allows/);
  assert.doesNotMatch(view.opportunity.reasons.join(" "), /high or unknown/);
});

test("promotion answers: a first-order offer already used at a retailer is never alerted there again (P2)", async () => {
  const { api, db, state } = await setup();
  try {
    state.estimate = fakeEstimate({ offer: { promotion: "New customers only: 20% off your first order", price: 1500, regularPrice: null } });
    const b = (await api.call("POST", "/api/bounties", { ...bountyInput(), estimate: request })).body.bounty;
    const make = async (name) =>
      (await api.call("POST", "/api/members", { name, alertsOptIn: true, alertLocalities: ["Camden"], paidTier: "diamond", paidUntil: "2026-12-31" })).body.member;
    const pat = await make("Pat");
    const sam = await make("Sam");
    const sent = (await api.call("POST", `/api/bounties/${b.id}/alerts`, {})).body;
    assert.deepEqual(sent.sent, []);
    assert.equal(sent.asked.length, 2);
    const question = (await api.call("GET", `/api/members/${pat.id}/alerts`)).body.alerts[0];
    assert.equal(question.kind, "question");
    assert.equal(question.figures, null);
    assert.match(question.eligibility.question, /first-order or new-customer offer at Argos/);
    // A claim-check before answering is refused; the figures depend on it.
    assert.equal((await api.call("POST", `/api/bounties/${b.id}/claim-check`, { memberId: pat.id, units: 1, ...TRIP })).status, 409);
    // Pat qualifies: the question becomes the alert, with figures.
    const yes = await api.call("POST", `/api/bounties/${b.id}/eligibility`, { memberId: pat.id, answer: "qualifies" });
    assert.equal(yes.status, 200);
    assert.equal(yes.body.alerted, true);
    assert.ok(yes.body.bounty.estimate.economics);
    const alert = (await api.call("GET", `/api/members/${pat.id}/alerts`)).body.alerts[0];
    assert.equal(alert.kind, "alert");
    assert.ok(alert.figures);
    const preview = await api.call("POST", `/api/bounties/${b.id}/claim-check`, { memberId: pat.id, units: 1, ...TRIP });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.check.ok, true);
    assert.match(preview.body.message, /^At 1 unit with your journey \(£3.00, 30 minutes\): profit per unit £7.00/);
    // Sam already used a first-order offer at Argos.
    const used = await api.call("POST", `/api/bounties/${b.id}/eligibility`, { memberId: sam.id, answer: "used" });
    assert.match(used.body.message, /first-order offers at Argos will not be sent to you again/);
    const samView = (await api.call("GET", `/api/bounties/${b.id}?viewer=${sam.id}`)).body.bounty;
    assert.match(samView.viewer.blockers.join(" "), /already used a first-order offer at Argos/);
    assert.equal(samView.viewer.canClaim, false);
    assert.equal(samView.estimate.economics, null);
    const refused = await api.call("POST", `/api/bounties/${b.id}/claims`, { memberId: sam.id, units: 1, ...TRIP });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /already used a first-order offer at Argos/);
    // A later first-order bounty at Argos is not sent to Sam.
    await api.call("POST", `/api/bounties/${b.id}/withdraw`, {});
    const next = (await api.call("POST", "/api/bounties", { ...bountyInput(), estimate: request })).body.bounty;
    const later = (await api.call("POST", `/api/bounties/${next.id}/alerts`, {})).body;
    assert.match(later.notAlerted.find((x) => x.name === "Sam").reason, /already used a first-order offer at Argos/);
    // Bad answers.
    assert.equal((await api.call("POST", `/api/bounties/${next.id}/eligibility`, { memberId: pat.id, answer: "maybe" })).status, 400);
    const plain = memoryDb(schema);
    const none = liveBounty(plain);
    const who = diamond(plain, "Who");
    assert.equal(status(() => answerPromotion(plain, { bountyId: none.id, memberId: who.id, answer: "qualifies", now: T0 })).status, 409);
    db.prepare("SELECT 1").get();
  } finally {
    await api.close();
  }
});

test("a loyalty price can be answered qualifies or not, never used", () => {
  const db = memoryDb(schema);
  const b = createBounty(db, bountyInput(), {
    estimate: fakeEstimate({ offer: { promotion: "Clubcard price", price: 1500, regularPrice: null } }),
    request: {},
    now: T0,
  });
  const pat = diamond(db, "Pat");
  assert.equal(status(() => answerPromotion(db, { bountyId: b.id, memberId: pat.id, answer: "used", now: T0 })).status, 400);
  const no = answerPromotion(db, { bountyId: b.id, memberId: pat.id, answer: "not", now: T0 });
  assert.equal(no.confirmed, false);
  assert.match(dispatchAlerts(db, b.id, T0).notAlerted.find((x) => x.name === "Pat").reason, /do not qualify/);
});

test("routes: claims need the member's journey and re-run the figures at their units", async () => {
  const seen = [];
  const { api, state } = await setup({
    estimate: (_db, req) => {
      seen.push(req);
      // A long, costly journey makes one unit fail the hourly floor.
      if (req.costs?.journeyCost > 900)
        return fakeEstimate({
          units: req.units,
          journeyCost: req.costs.journeyCost,
          alert: { eligible: false, reasons: ["Below the hourly floor or working time unknown"], checks: [] },
        });
      return state.estimate.remake(req);
    },
  });
  try {
    state.estimate = fakeEstimate({ stock: { check: { in_stock: 1, units_seen: 1 } } });
    const created = await api.call("POST", "/api/bounties", { ...bountyInput(), estimate: request });
    const b = created.body.bounty;
    // Cap 1: the estimate was worked out again for 1 unit before the bounty was made.
    assert.equal(b.cap, 1);
    assert.deepEqual(seen.map((r) => r.units), [2, 1]);
    assert.equal(b.figures.units, 1);
    assert.equal(b.alert.eligible, true);
    assert.match(b.figures.label, /^Figures for 1 unit, the most one member can claim, using the operator's return journey/);
    const ann = (await api.call("POST", "/api/members", { name: "Ann", paidTier: "diamond", paidUntil: "2026-12-31" })).body.member;
    const blank = await api.call("POST", `/api/bounties/${b.id}/claims`, { memberId: ann.id, units: 1, journeyCost: 300 });
    assert.equal(blank.status, 400);
    assert.match(blank.body.error, /A blank is never counted as zero/);
    const costly = await api.call("POST", `/api/bounties/${b.id}/claims`, { memberId: ann.id, units: 1, journeyCost: 1200, journeyMinutes: 90 });
    assert.equal(costly.status, 409);
    assert.match(costly.body.error, /^At 1 unit with your journey \(£12.00, 90 minutes\) this trip fails: Below the hourly floor/);
    const own = seen.at(-1);
    assert.equal(own.units, 1);
    assert.equal(own.costs.journeyCost, 1200);
    assert.equal(own.costs.journeyMinutes, 90);
    assert.equal(own.promotionEligible, false);
    const made = await api.call("POST", `/api/bounties/${b.id}/claims`, { memberId: ann.id, units: 1, journeyCost: 0, journeyMinutes: 20 });
    assert.equal(made.status, 201);
    assert.equal(made.body.check.ok, true);
    assert.match(made.body.message, /At 1 unit with your journey \(£0.00, 20 minutes\): profit per unit £10.00/);
  } finally {
    await api.close();
  }
});

test("routes: a report of stock while an earlier empty shelf holds the bounty says it waits for verification (R2Q9)", async () => {
  const { api, state } = await setup();
  try {
    const b = (await api.call("POST", "/api/bounties", { ...bountyInput(), estimate: request })).body.bounty;
    const bob = (await api.call("POST", "/api/members", { name: "Bob" })).body.member;
    const alice = (await api.call("POST", "/api/members", { name: "Alice" })).body.member;
    const empty = await api.call("POST", `/api/bounties/${b.id}/reports`, { memberId: bob.id, unitsSeen: 0 });
    // The operator verifies it; the re-check's branch check is that report.
    state.estimate = fakeEstimate({
      alert: { eligible: false, reasons: ["Latest branch check found none on the shelf"], checks: [] },
      stock: { confirmed: false, availability: "out_of_stock", check: { in_stock: 0, units_seen: 0, checked_at: T0 } },
    });
    await api.call("POST", `/api/reports/${empty.body.reportId}/verify`, { accurate: true });
    state.now = at(1);
    const seen = await api.call("POST", `/api/bounties/${b.id}/reports`, { memberId: alice.id, unitsSeen: 3 });
    assert.equal(seen.status, 201);
    assert.match(
      seen.body.message,
      /^Thanks: your report of 3 units is waiting for the operator to verify it\. Until then the bounty stays paused after the earlier empty-shelf report\./,
    );
    assert.doesNotMatch(seen.body.message, /found none/);
    assert.match(seen.body.bounty.trip.headline, /the operator confirmed a report of none on the shelf at 2 Nov 2026, 09:00\. A newer report of 3 units at 2 Nov 2026, 09:01 is waiting/);
  } finally {
    await api.close();
  }
});

test("paid access lasts to the end of the UK day and is shown as a UK date (Q15)", () => {
  const db = memoryDb(schema);
  const m = member(db, "Summer", { paidTier: "ruby", paidUntil: "2026-07-01" });
  const row = memberRow(db, m.id);
  const view = memberView(db, row, { now: "2026-07-01T22:30:00.000Z" });
  assert.equal(view.paid.untilLabel, "1 Jul 2026");
  assert.equal(view.paid.endsAt, "2026-07-01T23:00:00.000Z");
  assert.equal(view.paid.current, true);
  assert.equal(memberView(db, row, { now: "2026-07-01T23:30:00.000Z" }).paid.current, false);
  const winter = memberRow(db, member(db, "Winter", { paidTier: "ruby", paidUntil: "2026-12-31" }).id);
  assert.equal(memberView(db, winter, { now: T0 }).paid.endsAt, "2027-01-01T00:00:00.000Z");
});

test("a competing-listings count the evidence calls stale keeps the cap at 0 and says why (R2M5)", () => {
  const db = memoryDb(schema);
  const note = "Competing listings last checked 20 Oct 2026: run an asking-price lookup before sharing";
  const stale = fakeEstimate({ competition: { activeListings: null, sellers: null, lowestAsking: null, note } });
  const b = createBounty(db, bountyInput(), { estimate: stale, request: {}, lookup: { provider: "ebay", fetched: at(-60) }, now: T0 });
  assert.equal(b.cap, 0);
  assert.equal(b.competing_listings, null);
  assert.match(JSON.parse(b.cap_basis).notes.join(" "), /Competing listings last checked 20 Oct 2026: run an asking-price lookup before sharing\. Competing listings unknown, so the cap is 0/);
  const view = bountyView(db, b, { now: T0 });
  assert.equal(view.pressure.resale.competingListings, null);
  assert.equal(view.pressure.resale.note, note);
  assert.equal(view.alert.canSend, false);
});

test("recording an empty-shelf check through the research route stops the bounty at once", async () => {
  const { routes: researchRoutes } = await import("./routes-research.mjs");
  const db = memoryDb(schema, auditSchema);
  const b = liveBounty(db);
  const ann = diamond(db, "Ann");
  dispatchAlerts(db, b.id, T0);
  assert.equal(memberNotices(db, ann.id).length, 0);
  const api = await serve(db, [{ routes: researchRoutes }]);
  // The route reads the server clock; hold it at the fixtures' time.
  mock.timers.enable({ apis: ["Date"], now: Date.parse(T0) });
  try {
    const res = await api.call("POST", "/api/research/checks", {
      barcode: GTIN,
      retailer: "Argos",
      locality: "Camden",
      method: "phone",
      inStock: false,
      unitsSeen: 0,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.bounties.checked, 1);
    assert.deepEqual(res.body.bounties.stopped.map((x) => x.bountyId), [b.id]);
    const notices = memberNotices(db, ann.id);
    assert.equal(notices.length, 1);
    assert.match(JSON.stringify(notices[0]), /none on the shelf/);
  } finally {
    mock.timers.reset();
    await api.close();
  }
});
