// Claims, promotion answers and the member's own trip check (round three:
// R3B3, R3M1, R3M4, R3P6, R3P7, R3B5, R3Q9 and the R3B6 mutants BU1, BJ6,
// BJ9, BP1, BP3, BP4, RB1). Fixtures are copied from bounties.test.mjs so
// the two files never depend on each other.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryDb, serve } from "./test-support.mjs";
import {
  answerPromotion,
  blockedTripCheck,
  bountyView,
  claim as rawClaim,
  claimTerms,
  claimableUnits,
  completeClaim,
  createBounty,
  createMember,
  dispatchAlerts,
  isFirstOrderOffer,
  listBounties,
  memberAlerts,
  memberRequest,
  memberTermsInput,
  memberTripCheck,
  memberTripText,
  promotionStanding,
  schema,
  sharedDemand,
} from "./bounties.mjs";
import { routes } from "./routes-bounties.mjs";

const T0 = "2026-11-02T09:00:00.000Z"; // a Monday
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60000).toISOString();
const GTIN = "05012345678900";
const GTIN2 = "05012345678917";
const FIRST_ORDER = "New customers only: 20% off your first order";
// Monday to Friday dispatch, 2 days' delivery, payout 2 days after delivery.
const GOALS = { dispatchDays: [1, 2, 3, 4, 5], deliveryDays: 2, payoutDelayDays: 2 };

/**
 * A stand-in for estimateFromEvidence that follows the request: the units,
 * the journey, the member's stricter rules (minUnitProfit) and the hourly
 * floor. £10 contribution a unit before the journey; 26 confirmed sales in
 * 90 days (about 2.02 a week), one competing listing, 5 days to sell.
 */
function estimateFor(request = {}, over = {}) {
  const units = Number.isSafeInteger(request.units) ? request.units : 2;
  const travel = Number.isSafeInteger(request.costs?.journeyCost) ? request.costs.journeyCost : 500;
  const minutes = Number.isSafeInteger(request.costs?.journeyMinutes) ? request.costs.journeyMinutes : 30;
  const contribution = units * 1000 - travel;
  const activeMinutes = minutes + 10 + units * 10;
  const hourly = Math.round((contribution * 60) / activeMinutes);
  const unitProfit = Math.floor(contribution / units);
  const count = over.sampleCount ?? 26;
  const listings = over.listings ?? 1;
  const rate = (count * 7) / 90;
  const demandUnits = Math.max(0, Math.floor(rate * 2 + 1e-9) - listings);
  const minProfit = request.rules?.minUnitProfit ?? 500;
  const meets = unitProfit >= minProfit;
  const floorFails = Number.isSafeInteger(request.hourlyFloor) && hourly < request.hourlyFloor;
  const reasons = [];
  if (!meets) reasons.push("Not a Priority 1 or 2 opportunity under the buying thresholds");
  if (floorFails) reasons.push("Below the hourly floor or working time unknown");
  if (units > demandUnits) reasons.push(`Sales support about ${demandUnits} units within 2 weeks after competing listings, fewer than the ${units} planned`);
  return {
    offer: {
      provider: "awin",
      sourceId: "A1",
      title: "Travel kettle 0.5 l",
      price: 1500,
      regularPrice: over.regularPrice ?? null,
      observed: "2026-11-01",
      retailer: "Argos",
      gtin: over.gtin ?? GTIN,
      variant: "white",
      promotion: over.promotion ?? null,
    },
    sample: { count, independent: 6, lowerMedian: 3200, daysToSell: 5 },
    competition: {
      activeListings: listings,
      sellers: listings,
      lowestAsking: 3500,
      lowestAskingIncludesShipping: true,
      lookup: { provider: "ebay", fetched: "2026-11-02T08:30:00.000Z" },
    },
    demand: { units: demandUnits, salesPerWeek: Math.round(rate * 100) / 100, competingListings: listings, sellWindowWeeks: 2 },
    payout: { goals: { ...GOALS, daysToSell: 5 } },
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
      hourly,
      activeMinutes,
      unsoldLoss: -3200,
      breakEvenSale: 2400,
    },
    inputs: { units },
    opportunity: {
      tier: meets ? "Priority 2" : "Watch",
      reasons: meets ? ["Sourcing pressure high or unknown"] : [`Profit per unit below £${minProfit / 100}`],
      unitProfit,
      returnOnCost: Math.round((unitProfit / 1500) * 1000) / 1000,
      targetPrice: null,
      meetsThresholds: meets,
      trialUnits: 3,
      unitPrice: 1500,
      weightKg: 0.9,
    },
    alert: {
      eligible: reasons.length === 0,
      reasons,
      checks: [
        { id: "live-evidence", ok: true, detail: "Imported evidence" },
        { id: "demand", ok: units <= demandUnits, detail: "Sales rate supports these units within 2 weeks" },
      ],
    },
    stock: {
      confirmed: true,
      availability: "in_stock",
      check: { in_stock: 1, units_seen: over.unitsSeen ?? 10, checked_at: "2026-11-02T08:00:00.000Z" },
    },
    permission: over.permission ?? { permitted: true, basis: "Permitted for awin (Argos) by a display permission recorded in Sources" },
    warnings: [],
  };
}

const JOURNEY = { cost: 300, minutes: 30 };
const TRIP = { journeyCost: JOURNEY.cost, journeyMinutes: JOURNEY.minutes };
const bountyInput = (over = {}) => ({
  title: "Travel kettle",
  locality: "Camden",
  retailer: "Argos",
  salesPerWeek: 3,
  sellWindowWeeks: 2,
  expiresAt: at(3 * 24 * 60),
  sponsored: false,
  ...over,
});
const REQUEST = { offer: { provider: "awin", sourceId: "A1" }, units: 2, costs: { journeyCost: 500, journeyMinutes: 30 } };
// A live bounty whose operator ticked that they qualify for its promotion.
const liveBounty = (db, { input = {}, estimate = {}, request = {} } = {}, now = T0) =>
  createBounty(db, bountyInput(input), {
    estimate: estimateFor({ units: 2 }, estimate),
    request: { ...REQUEST, promotionEligible: Boolean(estimate.promotion), ...request },
    now,
  });
const firstOrderBounty = (db, over = {}) => liveBounty(db, { ...over, estimate: { promotion: FIRST_ORDER, ...over.estimate } });

const memberRow = (db, id) => ({ ...db.prepare("SELECT * FROM members WHERE id = ?").get(id) });
const member = (db, name, over = {}) =>
  createMember(
    db,
    { name, alertsOptIn: true, alertLocalities: ["Camden"], paidTier: "diamond", paidUntil: "2026-12-31", ...over },
    { now: T0 },
  );
const viewAs = (db, b, m, now = T0) => bountyView(db, b, { viewer: { kind: "member", member: memberRow(db, m.id) }, now });
// claim() with the member's own figures worked out at the units they claim.
const claim = (db, args) =>
  rawClaim(db, { journey: JOURNEY, check: estimateFor({ units: args.units, costs: { journeyCost: 300, journeyMinutes: 30 } }), ...args });
const status = (fn) => {
  try {
    fn();
  } catch (error) {
    return { status: error.status, message: error.message };
  }
  return { status: 0 };
};

const tempDirs = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

async function setup(over = {}) {
  const db = memoryDb(schema);
  const root = mkdtempSync(join(tmpdir(), "bounty-claims-"));
  tempDirs.push(root);
  const seen = [];
  const state = { now: T0, base: {} };
  const options = {
    clock: () => state.now,
    photoDir: join(root, "photos"),
    estimate: (_db, request) => {
      seen.push(request);
      return estimateFor(request, state.base);
    },
    recordCheck: () => ({ id: 1 }),
    askingLookup: () => null,
    ...over,
  };
  const api = await serve(db, [{ routes: (d) => routes(d, options) }]);
  const makeMember = async (name, extra = {}) =>
    (
      await api.call("POST", "/api/members", {
        name,
        alertsOptIn: true,
        alertLocalities: ["Camden"],
        paidTier: "diamond",
        paidUntil: "2026-12-31",
        ...extra,
      })
    ).body.member;
  return { db, api, state, seen, makeMember };
}

// ------------------------------------------------------------------ BU1, BP3

test("unknown units give nothing to claim (BU1)", () => {
  assert.equal(claimableUnits({ estimateUnits: 2, cap: 3, trialUnits: 3 }), 2);
  assert.equal(claimableUnits({ estimateUnits: 5, cap: 3, trialUnits: 1 }), 1);
  for (const unknown of [null, undefined, Number.NaN, 2.5, -1, "3"]) {
    assert.equal(claimableUnits({ estimateUnits: unknown, cap: 3, trialUnits: 3 }), 0, String(unknown));
    assert.equal(claimableUnits({ estimateUnits: 3, cap: unknown, trialUnits: 3 }), 0, String(unknown));
    assert.equal(claimableUnits({ estimateUnits: 3, cap: 3, trialUnits: unknown }), 0, String(unknown));
  }
});

test("first-order wording is recognised beyond 'new customer' (BP3)", () => {
  for (const yes of [
    "Welcome offer: 20% off your first purchase",
    "New customers only",
    "new customer discount",
    "20% off your first order",
    "£5 off your first shop",
    "10% off your 1st order",
    "Welcome discount for new members",
    "First-time buyers save 15%",
  ])
    assert.equal(isFirstOrderOffer(yes), true, yes);
  for (const no of ["Clubcard price", "Members' price", "Buy one get one free", "Nectar price", "3 for 2", null, 7])
    assert.equal(isFirstOrderOffer(no), false, String(no));
});

// --------------------------------------------------------------- promotions

test("a 'used' answer at the retailer turns a confirmed member back to not confirmed (BP1)", () => {
  const db = memoryDb(schema);
  const a = firstOrderBounty(db);
  const b = firstOrderBounty(db, { estimate: { gtin: GTIN2 } });
  const ann = member(db, "Ann");
  assert.equal(answerPromotion(db, { bountyId: a.id, memberId: ann.id, answer: "qualifies", now: T0 }).confirmed, true);
  answerPromotion(db, { bountyId: b.id, memberId: ann.id, answer: "used", now: at(1) });
  const standing = promotionStanding(db, a, memberRow(db, ann.id));
  assert.equal(standing.answer, "qualifies");
  assert.equal(standing.usedHere, true);
  assert.equal(standing.confirmed, false);
  assert.equal(standing.declined, true);
  assert.equal(standing.usedBy, "answer");
  assert.equal(viewAs(db, a, ann).estimate.economics, null);
  assert.equal(viewAs(db, a, ann).viewer.canClaim, false);
});

test("buying at a first-order price records it as used, and a later claim at that price is refused (R3B3)", async () => {
  const { api, db, state, makeMember } = await setup();
  try {
    state.base = { promotion: FIRST_ORDER };
    const created = await api.call("POST", "/api/bounties", { ...bountyInput(), estimate: { ...REQUEST, promotionEligible: true } });
    assert.equal(created.status, 201);
    const b = created.body.bounty;
    assert.equal(b.promotion.condition, FIRST_ORDER);
    const ann = await makeMember("Ann");
    const yes = await api.call("POST", `/api/bounties/${b.id}/eligibility`, { memberId: ann.id, answer: "qualifies" });
    assert.equal(yes.body.eligibility.confirmed, true);
    const first = await api.call("POST", `/api/bounties/${b.id}/claims`, { memberId: ann.id, units: 1, ...TRIP });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const bought = await api.call("POST", `/api/claims/${first.body.claim.id}/complete`, { memberId: ann.id, units: 1 });
    assert.equal(bought.status, 200);
    assert.equal(bought.body.claim.promotionUsed, true);
    assert.match(bought.body.message, /first-order offer at Argos is now recorded as used/);
    const row = db.prepare("SELECT answer, first_order, claim_id FROM promotion_answers WHERE member_id = ? AND bounty_id = ?").get(ann.id, b.id);
    assert.deepEqual({ ...row }, { answer: "used", first_order: 1, claim_id: first.body.claim.id });
    const view = (await api.call("GET", `/api/bounties/${b.id}?viewer=${ann.id}`)).body.bounty;
    assert.equal(view.viewer.eligibility.usedBy, "purchase");
    assert.equal(view.viewer.eligibility.confirmed, false);
    assert.equal(view.viewer.eligibility.canUndo, false);
    assert.match(view.viewer.eligibility.notForYou, /^You bought at the first-order price at Argos on 2 Nov 2026, so this offer is not for you$/);
    // Claim again at the same price (the trial batch still has room): refused.
    const again = await api.call("POST", `/api/bounties/${b.id}/claims`, { memberId: ann.id, units: 1, ...TRIP, qualifiesForPromotion: true });
    assert.equal(again.status, 409);
    assert.match(again.body.error, /^You have already used the first-order offer at Argos, so this price is not available to you\./);
    // A purchase is never an answer given by mistake.
    for (const answer of ["qualifies", "undo"]) {
      const undo = await api.call("POST", `/api/bounties/${b.id}/eligibility`, { memberId: ann.id, answer });
      assert.equal(undo.status, 409, answer);
      assert.match(undo.body.error, /already used the first-order offer at Argos/);
    }
    // "not" leaves the purchase record as it is.
    await api.call("POST", `/api/bounties/${b.id}/eligibility`, { memberId: ann.id, answer: "not" });
    assert.equal(db.prepare("SELECT answer FROM promotion_answers WHERE member_id = ? AND bounty_id = ?").get(ann.id, b.id).answer, "used");
    // Ann still sees the bounty she bought from, but no other first-order offer at Argos.
    await api.call("POST", `/api/bounties/${b.id}/withdraw`, {});
    const other = firstOrderBounty(db, { estimate: { gtin: GTIN2 } });
    const listed = (await api.call("GET", `/api/bounties?viewer=${ann.id}`)).body.bounties.map((x) => x.id);
    assert.ok(listed.includes(b.id));
    assert.ok(!listed.includes(other.id));
    assert.match(dispatchAlerts(db, other.id, at(5)).notAlerted.find((x) => x.name === "Ann").reason, /already used a first-order offer at Argos/);
  } finally {
    await api.close();
  }
});

test("completing a claim on an ordinary price records nothing", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db);
  const bob = member(db, "Bob");
  const made = claim(db, { bountyId: b.id, memberId: bob.id, units: 1, now: T0 });
  assert.equal(completeClaim(db, { claimId: made.id, memberId: bob.id, now: at(5) }).promotionUsed, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM promotion_answers").get().n, 0);
});

test("first-order bounties are not listed to visitors or members who said not or used, and their claims are refused (R3M4)", async () => {
  const { api, db, makeMember } = await setup();
  try {
    const plain = liveBounty(db, { estimate: { gtin: GTIN2 } });
    const first = firstOrderBounty(db);
    const loyalty = liveBounty(db, { estimate: { gtin: "05012345678924", promotion: "Clubcard price" } });
    const eve = await makeMember("Eve");
    const cat = await makeMember("Cat");
    const dan = await makeMember("Dan");
    const ids = async (viewer) =>
      (await api.call("GET", "/api/bounties" + (viewer ? `?viewer=${viewer}` : ""))).body.bounties.map((x) => x.id).sort();
    // Visitors never see the first-order bounty; an unanswered member does.
    assert.deepEqual(await ids(null), [plain.id, loyalty.id].sort());
    assert.ok((await ids(eve.id)).includes(first.id));
    assert.deepEqual(await ids("operator"), [plain.id, first.id, loyalty.id].sort());
    // Eve is not a new customer, Cat already used one, Dan used one and then
    // claims with qualifiesForPromotion: true anyway.
    await api.call("POST", `/api/bounties/${first.id}/eligibility`, { memberId: eve.id, answer: "not" });
    await api.call("POST", `/api/bounties/${first.id}/eligibility`, { memberId: cat.id, answer: "used" });
    const usedMsg = await api.call("POST", `/api/bounties/${first.id}/eligibility`, { memberId: dan.id, answer: "used" });
    assert.match(usedMsg.body.message, /will not be sent to you again, and this bounty is no longer listed for you\.$/);
    for (const who of [eve, cat, dan]) assert.ok(!(await ids(who.id)).includes(first.id), who.name);
    const refused = await api.call("POST", `/api/bounties/${first.id}/claims`, { memberId: dan.id, units: 1, ...TRIP, qualifiesForPromotion: true });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /^You have already used the first-order offer at Argos, so this price is not available to you\./);
    // The stored answer stays: the claim did not overwrite it.
    assert.equal(promotionStanding(db, first, memberRow(db, dan.id)).answer, "used");
    const notRefused = await api.call("POST", `/api/bounties/${first.id}/claims`, { memberId: eve.id, units: 1, ...TRIP, qualifiesForPromotion: true });
    assert.equal(notRefused.status, 409);
    assert.match(notRefused.body.error, /^You said you do not qualify for this price \("New customers only: 20% off your first order"\), so it is not available to you\./);
    // claim-check is refused the same way.
    const checkRefused = await api.call("POST", `/api/bounties/${first.id}/claim-check`, { memberId: cat.id, units: 1, ...TRIP });
    assert.equal(checkRefused.status, 409);
    assert.match(checkRefused.body.error, /not available to you/);
    // A loyalty price answered "not" stays listed, saying it is not for them.
    await api.call("POST", `/api/bounties/${loyalty.id}/eligibility`, { memberId: eve.id, answer: "not" });
    const card = (await api.call("GET", `/api/bounties?viewer=${eve.id}`)).body.bounties.find((x) => x.id === loyalty.id);
    assert.equal(card.viewer.eligibility.declined, true);
    assert.match(card.viewer.blockers.join(" "), /You said you do not qualify for this price \("Clubcard price"\), so this bounty is not for you/);
    assert.equal(card.figures.note, null);
    // Unit level: claim() refuses whatever qualifiesForPromotion says.
    const unit = status(() => claim(db, { bountyId: first.id, memberId: cat.id, units: 1, qualifiesForPromotion: true, now: T0 }));
    assert.equal(unit.status, 409);
    assert.match(unit.message, /already used the first-order offer at Argos/);
    // "I answered by mistake" asks the question again and lists the bounty.
    const undo = await api.call("POST", `/api/bounties/${first.id}/eligibility`, { memberId: cat.id, answer: "undo" });
    assert.equal(undo.status, 200);
    assert.equal(undo.body.eligibility.answer, null);
    assert.equal(undo.body.eligibility.declined, false);
    assert.match(undo.body.message, /^Your answer was removed/);
    assert.ok((await ids(cat.id)).includes(first.id));
  } finally {
    await api.close();
  }
});

test("the inbox follows the answer and never gives the sale estimate before a member qualifies (R3Q9, BP4, R3P7)", () => {
  const db = memoryDb(schema);
  const b = createBounty(db, bountyInput(), {
    estimate: estimateFor({ units: 2 }, { promotion: FIRST_ORDER, regularPrice: 1875 }),
    request: { ...REQUEST, promotionEligible: true },
    now: T0,
  });
  const plain = liveBounty(db, { estimate: { gtin: GTIN2 } });
  const ann = member(db, "Ann");
  const erin = member(db, "Erin");
  const sent = dispatchAlerts(db, b.id, T0);
  assert.deepEqual(sent.asked.map((x) => x.name).sort(), ["Ann", "Erin"]);
  dispatchAlerts(db, plain.id, T0);
  // An unanswered question: no figures, no sale estimate.
  const question = memberAlerts(db, erin.id, { now: T0 }).find((x) => x.bountyId === b.id);
  assert.equal(question.kind, "question");
  assert.equal(question.figures, null);
  assert.doesNotMatch(question.promotion.note, /leaves about/);
  assert.equal(question.mainUncertainty, `Whether you qualify for the promotion price ("${FIRST_ORDER}"): the figures depend on it`);
  assert.match(question.checked.priceLabel, /^Price seen /);
  assert.match(question.checked.stockLabel, /^Stock last checked /);
  // An ordinary alert carries when things were checked and the main uncertainty.
  const alert = memberAlerts(db, erin.id, { now: T0 }).find((x) => x.bountyId === plain.id);
  assert.equal(alert.kind, "alert");
  assert.match(alert.mainUncertainty, /Whether buyers still pay about £32\.00/);
  assert.match(alert.checked.priceLabel, /^Price seen /);
  // Cards for members who have not said they qualify, and for visitors.
  for (const view of [viewAs(db, b, erin), bountyView(db, b, { now: T0 })]) {
    assert.doesNotMatch(view.mainUncertainty ?? "", /buyers still pay|£32/);
    assert.equal(view.estimate.sample.lowerMedian, null);
    assert.equal(view.estimate.competition.lowestAsking, null);
    assert.equal(view.estimate.economics, null);
  }
  // Ann qualifies: the alert has figures and the risk at the regular price.
  answerPromotion(db, { bountyId: b.id, memberId: ann.id, answer: "qualifies", now: at(1) });
  dispatchAlerts(db, b.id, at(1), { memberId: ann.id });
  const confirmed = memberAlerts(db, ann.id, { now: at(1) }).find((x) => x.bountyId === b.id);
  assert.equal(confirmed.kind, "alert");
  assert.ok(confirmed.figures);
  assert.match(confirmed.promotion.note, /which leaves about £/);
  assert.match(viewAs(db, b, ann, at(1)).mainUncertainty, /buyers still pay about £32\.00/);
  // She takes the answer back: the same alert row shows no figures (BP4).
  answerPromotion(db, { bountyId: b.id, memberId: ann.id, answer: "undo", now: at(2) });
  const undone = memberAlerts(db, ann.id, { now: at(2) }).find((x) => x.bountyId === b.id);
  assert.equal(undone.kind, "alert");
  assert.equal(undone.figures, null);
  assert.doesNotMatch(undone.promotion.note, /leaves about/);
  assert.doesNotMatch(undone.mainUncertainty, /buyers still pay/);
  // Erin says she already used one: the entry follows the answer.
  answerPromotion(db, { bountyId: b.id, memberId: erin.id, answer: "used", now: at(3) });
  const declined = memberAlerts(db, erin.id, { now: at(3) }).find((x) => x.bountyId === b.id);
  assert.equal(declined.kind, "declined");
  assert.equal(declined.title, "First-order offer at Argos");
  assert.equal(declined.questionNote, "You said you have already used a first-order offer at Argos, so this bounty is not for you.");
  assert.equal(declined.figures, null);
  assert.equal(declined.promotion, null);
  assert.equal(declined.mainUncertainty, null);
  assert.equal(declined.eligibility.canUndo, true);
  const card = viewAs(db, b, erin, at(3));
  assert.equal(card.viewer.eligibility.declined, true);
  assert.equal(card.figures.note, null);
  assert.match(card.viewer.blockers[0], /so this bounty is not for you$/);
});

// ------------------------------------------------------- shared demand (R3M1)

test("other members' units count against demand and come before the member's payout (R3M1)", () => {
  // 8 confirmed sales in 90 days (about 0.62 a week), no competing listings.
  const slow = estimateFor({ units: 1, costs: { journeyCost: 300, journeyMinutes: 30 } }, { sampleCount: 8, listings: 0 });
  const shared = (committed, extra = {}) => ({ committed, mine: 0, sellWindowWeeks: 2, salesPerWeekLimit: null, now: T0, ...extra });
  // Nobody else yet: the one unit two weeks of sales support passes, and the member hears when it is likely to sell.
  const alone = memberTripCheck(slow, { units: 1, journey: JOURNEY, shared: shared(0) });
  assert.equal(alone.ok, true, alone.reasons.join("; "));
  assert.equal(alone.shared.note, "At about 1 sale a fortnight, your unit is likely to sell in about 5 days.");
  assert.match(memberTripText(alone), /At about 1 sale a fortnight, your unit is likely to sell in about 5 days\. Every check passes\.$/);
  // Five units already claimed: the sixth member is told why not.
  const sixth = memberTripCheck(slow, { units: 1, journey: JOURNEY, shared: shared(5) });
  assert.equal(sixth.ok, false);
  assert.deepEqual(sixth.reasons, [
    "Other members have already claimed 5 units. At about 1 sale a fortnight, your unit is likely to sell in about 10 weeks, but sales support about 1 unit within 2 weeks after competing listings, and those are already claimed",
  ]);
  assert.equal(sixth.shared.sellDays, 68);
  assert.equal(sixth.shared.demandLeft, 0);
  // A faster item with room: passes and says so.
  const fast = estimateFor({ units: 1, costs: { journeyCost: 300, journeyMinutes: 30 } });
  const third = memberTripCheck(fast, { units: 1, journey: JOURNEY, shared: shared(2) });
  assert.equal(third.ok, true, third.reasons.join("; "));
  assert.equal(third.shared.note, "Other members have already claimed 2 units. At about 2 sales a week, your unit is likely to sell in about 11 days.");
  // The payout is scheduled after the others' units: sold 13 Nov, posted
  // the same Friday, delivered 15 Nov, paid out 17 Nov.
  assert.equal(third.shared.payoutDate, "2026-11-17");
  assert.equal(third.figures.payoutDate, "2026-11-17");
  const late = memberTripCheck(fast, { units: 1, journey: JOURNEY, shared: shared(2), terms: { cashNeededBy: "2026-11-14", floor: null } });
  assert.equal(late.ok, false);
  assert.deepEqual(late.reasons, [
    "Other members have already claimed 2 units. Your unit is likely to be paid out on 17 Nov 2026, after 14 Nov 2026, when you need the cash",
  ]);
  assert.equal(memberTripCheck(fast, { units: 1, journey: JOURNEY, shared: shared(2), terms: { cashNeededBy: "2026-11-17", floor: null } }).ok, true);
  // The member's own bought units are named as theirs.
  const mine = memberTripCheck(fast, { units: 1, journey: JOURNEY, shared: shared(2, { mine: 1 }) });
  assert.match(mine.shared.note, /^Other members have already claimed 1 unit and you have claimed or bought 1\./);
  // A shorter operator window is stricter: one week supports 1 unit after the listing.
  const week = memberTripCheck(fast, { units: 1, journey: JOURNEY, shared: shared(1, { sellWindowWeeks: 1 }) });
  assert.equal(week.ok, false);
  assert.match(week.reasons[0], /sales support about 1 unit within 1 week after competing listings, and those are already claimed$/);
  // Without `shared` nothing changes (older callers).
  assert.equal(memberTripCheck(fast, { units: 1, journey: JOURNEY }).shared, null);
});

test("sharedDemand counts live and bought units and caps the operator's window at the gate's", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db, { input: { sellWindowWeeks: 12 } });
  const ann = member(db, "Ann");
  const bob = member(db, "Bob");
  const made = claim(db, { bountyId: b.id, memberId: ann.id, units: 1, now: T0 });
  completeClaim(db, { claimId: made.id, memberId: ann.id, now: at(1) });
  claim(db, { bountyId: b.id, memberId: bob.id, units: 1, now: at(2) });
  const seenByAnn = sharedDemand(db, b, memberRow(db, ann.id), at(3));
  assert.equal(seenByAnn.committed, 2);
  assert.equal(seenByAnn.mine, 1);
  assert.equal(seenByAnn.sellWindowWeeks, 2);
  assert.equal(seenByAnn.salesPerWeekLimit, 3);
  // Bob's claim lapses after 3 hours.
  assert.equal(sharedDemand(db, b, memberRow(db, ann.id), at(4 * 60)).committed, 1);
  const db2 = memoryDb(schema);
  const shortWindow = liveBounty(db2, { input: { sellWindowWeeks: 1 } });
  assert.equal(sharedDemand(db2, shortWindow, null, T0).sellWindowWeeks, 1);
});

test("routes: the claim check and the claim count units other members claimed (R3M1)", async () => {
  const { api, makeMember } = await setup();
  try {
    const b = (await api.call("POST", "/api/bounties", { ...bountyInput(), estimate: REQUEST })).body.bounty;
    assert.equal(b.cap, 3);
    const ann = await makeMember("Ann");
    const bob = await makeMember("Bob");
    const cal = await makeMember("Cal");
    assert.equal((await api.call("POST", `/api/bounties/${b.id}/claims`, { memberId: ann.id, units: 2, ...TRIP })).status, 201);
    const preview = await api.call("POST", `/api/bounties/${b.id}/claim-check`, { memberId: bob.id, units: 1, ...TRIP });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.check.ok, true);
    assert.equal(preview.body.check.shared.committed, 2);
    assert.match(preview.body.message, /Other members have already claimed 2 units\. At about 2 sales a week, your unit is likely to sell in about 11 days\. Every check passes\.$/);
    const made = await api.call("POST", `/api/bounties/${b.id}/claims`, { memberId: bob.id, units: 1, ...TRIP });
    assert.equal(made.status, 201);
    assert.match(made.body.message, /Other members have already claimed 2 units/);
    // Nothing is left: Cal's check is not ok and says so first.
    const full = await api.call("POST", `/api/bounties/${b.id}/claim-check`, { memberId: cal.id, units: 1, ...TRIP });
    assert.equal(full.body.check.ok, false);
    assert.match(full.body.message, /^Nothing is left to claim: the distribution cap for this bounty is fully claimed\./);
  } finally {
    await api.close();
  }
});

// ----------------------------------------------------- the member's own terms

test("a member's own hourly floor and cash date are used, never the operator's date (R3P6)", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db, {
    request: { hourlyFloor: 1200, cashNeededBy: "2026-11-10", cashNeededDays: 8, rules: { minUnitProfit: 600, minReturn: 0.4 } },
  });
  const ann = member(db, "Ann", { rules: { minUnitProfit: 700 } });
  const row = memberRow(db, ann.id);
  const base = { units: 1, journey: JOURNEY };
  const stricter = memberRequest(b, row, { ...base, terms: { hourlyFloor: 2000, cashNeededBy: "2026-11-30" } });
  assert.equal(stricter.hourlyFloor, 2000);
  assert.equal(stricter.cashNeededBy, "2026-11-30");
  assert.equal("cashNeededDays" in stricter, false);
  // The stricter of both rule sets, every key kept (BJ6, BJ9).
  assert.deepEqual(stricter.rules, { minUnitProfit: 700, minReturn: 0.4 });
  const looser = memberRequest(b, row, { ...base, terms: { hourlyFloor: 800 } });
  assert.equal(looser.hourlyFloor, 1200);
  assert.equal("cashNeededBy" in looser, false);
  const none = memberRequest(b, row, base);
  assert.equal(none.hourlyFloor, 1200);
  assert.equal("cashNeededBy" in none, false);
  assert.equal("cashNeededDays" in none, false);
  assert.deepEqual(claimTerms(b, { hourlyFloor: 800 }).floor, { used: 1200, mine: 800, operator: 1200 });
  assert.deepEqual(claimTerms(b, null).floor, { used: 1200, mine: null, operator: 1200 });
  // Input: both optional; a blank is "not given".
  assert.deepEqual(memberTermsInput({}, { now: T0 }), { hourlyFloor: null, cashNeededBy: null });
  assert.deepEqual(memberTermsInput({ hourlyFloor: "", cashNeededBy: "" }, { now: T0 }), { hourlyFloor: null, cashNeededBy: null });
  assert.deepEqual(memberTermsInput({ hourlyFloor: 1500, cashNeededBy: "2026-11-02" }, { now: T0 }), { hourlyFloor: 1500, cashNeededBy: "2026-11-02" });
  for (const bad of [{ hourlyFloor: 12.5 }, { hourlyFloor: "12" }, { hourlyFloor: -1 }, { cashNeededBy: "2026-11-01" }, { cashNeededBy: "next week" }])
    assert.equal(status(() => memberTermsInput(bad, { now: T0 })).status, 400, JSON.stringify(bad));
});

test("routes: the claim check uses the stricter hourly floor and says whose (R3P6)", async () => {
  const { api, seen, makeMember } = await setup();
  try {
    const b = (await api.call("POST", "/api/bounties", { ...bountyInput(), estimate: { ...REQUEST, hourlyFloor: 1200, cashNeededBy: "2026-11-05" } })).body.bounty;
    const ann = await makeMember("Ann");
    // 1 unit, no fare, 10 minutes: £10.00 over 30 active minutes, £20.00 an hour.
    const walk = { journeyCost: 0, journeyMinutes: 10 };
    const high = await api.call("POST", `/api/bounties/${b.id}/claim-check`, { memberId: ann.id, units: 1, ...walk, hourlyFloor: 2500 });
    assert.equal(high.status, 200);
    assert.equal(high.body.check.ok, false);
    assert.deepEqual(high.body.check.reasons, ["Below the hourly floor: about £20.00 an active hour, under your floor of £25.00"]);
    assert.equal(seen.at(-1).hourlyFloor, 2500);
    assert.equal(seen.at(-1).cashNeededBy, undefined);
    const low = await api.call("POST", `/api/bounties/${b.id}/claim-check`, { memberId: ann.id, units: 1, ...walk, hourlyFloor: 800, cashNeededBy: "2026-11-30" });
    assert.equal(low.body.check.ok, true, JSON.stringify(low.body.check.reasons));
    assert.equal(seen.at(-1).hourlyFloor, 1200);
    assert.equal(seen.at(-1).cashNeededBy, "2026-11-30");
    assert.match(low.body.message, /Checked against an hourly floor of £12\.00 \(the operator's, stricter than yours\) and your cash date of 30 Nov 2026\. Every check passes\.$/);
    const bad = await api.call("POST", `/api/bounties/${b.id}/claim-check`, { memberId: ann.id, units: 1, ...walk, cashNeededBy: "2026-10-01" });
    assert.equal(bad.status, 400);
    const claimed = await api.call("POST", `/api/bounties/${b.id}/claims`, { memberId: ann.id, units: 1, ...walk, hourlyFloor: 2500 });
    assert.equal(claimed.status, 409);
    assert.match(claimed.body.error, /under your floor of £25\.00/);
  } finally {
    await api.close();
  }
});

test("routes: a member's higher minimum profit fails their own check and claim (BJ6, BJ9)", async () => {
  const { api, makeMember } = await setup();
  try {
    // The operator's figures: £7.50 profit a unit (2 units, £5.00 journey).
    const b = (await api.call("POST", "/api/bounties", { ...bountyInput(), estimate: REQUEST })).body.bounty;
    assert.equal(b.opportunity.unitProfit, 750);
    const pat = await makeMember("Pat", { rules: { minUnitProfit: 700 } });
    // Pat's own trip: 1 unit, £4.00 journey, £6.00 profit, under her £7.00.
    const own = { units: 1, journeyCost: 400, journeyMinutes: 30 };
    const preview = await api.call("POST", `/api/bounties/${b.id}/claim-check`, { memberId: pat.id, ...own });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.check.ok, false);
    assert.match(preview.body.check.reasons.join("; "), /Profit per unit below £7/);
    const refused = await api.call("POST", `/api/bounties/${b.id}/claims`, { memberId: pat.id, ...own });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /this trip fails: Profit per unit below £7/);
    // The agreed threshold alone would pass.
    const ann = await makeMember("Ann");
    assert.equal((await api.call("POST", `/api/bounties/${b.id}/claim-check`, { memberId: ann.id, ...own })).body.check.ok, true);
  } finally {
    await api.close();
  }
});

// --------------------------------------------- blocked trips and hidden offers

test("routes: the claim check on a paused trip is not ok and leads with the blocker (R3B5)", async () => {
  const { api, makeMember } = await setup();
  try {
    const b = (await api.call("POST", "/api/bounties", { ...bountyInput(), estimate: REQUEST })).body.bounty;
    const ann = await makeMember("Ann");
    const bob = await makeMember("Bob");
    assert.equal((await api.call("POST", `/api/bounties/${b.id}/reports`, { memberId: bob.id, unitsSeen: 0 })).status, 201);
    const res = await api.call("POST", `/api/bounties/${b.id}/claim-check`, { memberId: ann.id, units: 1, ...TRIP });
    assert.equal(res.status, 200);
    assert.equal(res.body.check.ok, false);
    assert.equal(res.body.check.blocked, true);
    assert.equal(res.body.check.ownOk, true);
    assert.ok(res.body.check.blockers.length >= 1);
    assert.deepEqual(res.body.check.blockers, res.body.blockers);
    assert.match(res.body.message, /^Don't make the trip: /);
    assert.match(res.body.message, /\. Your own figures would otherwise pass\.$/);
    assert.doesNotMatch(res.body.message, /Every check passes/);
    // When their own figures fail too, both are said.
    const costly = await api.call("POST", `/api/bounties/${b.id}/claim-check`, { memberId: ann.id, units: 1, journeyCost: 900, journeyMinutes: 30, hourlyFloor: 5000 });
    assert.equal(costly.body.check.ok, false);
    assert.match(costly.body.message, /^Don't make the trip: .*At 1 unit with your journey \(£9\.00, 30 minutes\) your own figures also fail: .*Below the hourly floor: about £[\d.]+ an active hour, under your floor of £50\.00\.$/);
  } finally {
    await api.close();
  }
});

test("blockedTripCheck keeps the member's own result and leaves an unblocked check alone", () => {
  const ok = memberTripCheck(estimateFor({ units: 1, costs: { journeyCost: 300, journeyMinutes: 30 } }), { units: 1, journey: JOURNEY });
  assert.equal(blockedTripCheck(ok, { blockers: [], headline: null }), ok);
  const blocked = blockedTripCheck(ok, { blockers: ["The offer price is not from the last 7 days"], headline: null });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.stop, "Don't make the trip: The offer price is not from the last 7 days");
  assert.deepEqual(blocked.reasons, ["The offer price is not from the last 7 days"]);
  assert.equal(memberTripText(blocked), "Don't make the trip: The offer price is not from the last 7 days. Your own figures would otherwise pass.");
});

test("routes: the claim check on an offer whose source does not permit display is refused (RB1)", async () => {
  const { api, state, makeMember } = await setup();
  try {
    state.base = { permission: { permitted: false, basis: "No display permission was recorded with the evidence" } };
    const b = (await api.call("POST", "/api/bounties", { ...bountyInput(), estimate: REQUEST })).body.bounty;
    const ann = await makeMember("Ann");
    const res = await api.call("POST", `/api/bounties/${b.id}/claim-check`, { memberId: ann.id, units: 1, ...TRIP });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /does not permit showing this offer's figures/);
    assert.equal(res.body.check, undefined);
  } finally {
    await api.close();
  }
});

test("a claim stores the member's own hourly floor and cash date, so a re-check uses them again (R3P6)", () => {
  const db = memoryDb(schema);
  const b = liveBounty(db);
  const ann = member(db, "Ann");
  const bob = member(db, "Bob");
  const withTerms = claim(db, { bountyId: b.id, memberId: ann.id, units: 1, terms: { hourlyFloor: 500, cashNeededBy: "2026-11-20" }, now: T0 });
  assert.deepEqual(JSON.parse(withTerms.terms), { hourlyFloor: 500, cashNeededBy: "2026-11-20" });
  const without = claim(db, { bountyId: b.id, memberId: bob.id, units: 1, now: T0 });
  assert.deepEqual(JSON.parse(without.terms), { hourlyFloor: null, cashNeededBy: null });
});
