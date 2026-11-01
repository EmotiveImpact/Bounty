// Round 5, finding 2: the resale demand for an item belongs to the item, not
// to one bounty. With 26 confirmed sales over 90 days and no competing
// listings, sales support about 4 units within two weeks. A member buys 3 on
// one bounty, a fresh shelf count is recorded, and the bounty is withdrawn
// (or expires) and replaced: the replacement must leave room for at most 1
// more, until the earlier units are released on evidence (recorded as sold
// or returned by the member who bought them, or reconciled by the operator
// with a reason), and a release can never exceed what is outstanding.
// Everything runs through the routes, with a stand-in estimate injected so
// the tests depend only on the bounty modules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb, serve } from "./test-support.mjs";
import { distributionCap, schema } from "./bounties.mjs";
import { routes as bountyRoutes } from "./routes-bounties.mjs";
import { schema as auditSchema } from "./audit.mjs";

// Round 5: a member's trip profile (a car, so the units fit); a claim also
// takes the cash they can spend on the trip.
const FIT = { transport: "Car", carryKg: 25, storageUnits: 50 };
const T0 = "2026-11-02T09:00:00.000Z";
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60000).toISOString();
const GTIN = "05012345678900";

// A stand-in for an estimateFromEvidence result. 26 confirmed sales in 90
// days is about 2.02 a week, so about 4 units within the 2-week sell window;
// no competing listings, with an asking-price lookup that found none.
function fakeEstimate({ units = 3, journeyCost = 0, journeyMinutes = 15, shelf, lookup }) {
  const contribution = units * 1000 - journeyCost;
  const activeMinutes = journeyMinutes + 10 + units * 10;
  const unitProfit = Math.floor(contribution / units);
  return {
    offer: { provider: "awin", sourceId: "A1", title: "Travel kettle 0.5 l", price: 1500, observed: "2026-11-02", retailer: "Argos", gtin: GTIN },
    sample: { count: 26, independent: 6, lowerMedian: 3200, daysToSell: 5 },
    competition: { activeListings: 0, sellers: 0, lowestAsking: null, lookup },
    match: "exact",
    unitCost: 1500,
    economics: {
      units,
      unitCost: 1500,
      salePrice: 3200,
      costs: { travel: journeyCost },
      contribution,
      unitContribution: unitProfit,
      cashRequired: units * 1600 + journeyCost,
      hourly: Math.round((contribution * 60) / activeMinutes),
      activeMinutes,
      unsoldLoss: -3200,
      breakEvenSale: 2400,
    },
    inputs: { units },
    opportunity: {
      tier: "Priority 2",
      reasons: [],
      unitProfit,
      returnOnCost: Math.round((unitProfit / 1500) * 1000) / 1000,
      meetsThresholds: true,
      trialUnits: 3,
      unitPrice: 1500,
      weightKg: 0.9,
    },
    alert: { eligible: true, reasons: [], checks: [{ id: "demand", ok: true, detail: "Sales support about 4 units within 2 weeks" }] },
    stock: { confirmed: true, availability: "in_stock", check: { in_stock: 1, ...shelf } },
    permission: { permitted: true, basis: "Permitted for awin (Argos) by a display permission recorded in Sources" },
    warnings: [],
  };
}

/** The bounty routes on a test server with a controllable clock and shelf count. */
async function world() {
  const clock = { now: T0 };
  // The latest branch check the estimate reads: 10 units seen at T0.
  const state = { shelf: { units_seen: 10, checked_at: T0 } };
  const lookup = () => ({ provider: "ebay", fetched: clock.now });
  const db = memoryDb(schema, auditSchema);
  const estimate = (_db, request) =>
    fakeEstimate({
      units: Number.isSafeInteger(request?.units) ? request.units : 3,
      journeyCost: Number.isSafeInteger(request?.costs?.journeyCost) ? request.costs.journeyCost : 0,
      journeyMinutes: Number.isSafeInteger(request?.costs?.journeyMinutes) ? request.costs.journeyMinutes : 15,
      shelf: state.shelf,
      lookup: lookup(),
    });
  const api = await serve(db, [
    { routes: (x) => bountyRoutes(x, { clock: () => clock.now, estimate, askingLookup: async () => lookup(), photoDir: "/nonexistent-photos" }) },
  ]);
  const call = (m, p, body) => api.call(m, p, body, { Origin: api.base });
  const bounty = (minutes = 3 * 24 * 60) =>
    call("POST", "/api/bounties", {
      title: "Travel kettle",
      locality: "Camden",
      retailer: "Argos",
      salesPerWeek: 10,
      sellWindowWeeks: 2,
      expiresAt: new Date(Date.parse(clock.now) + minutes * 60000).toISOString(),
      sponsored: false,
      estimate: { offer: { provider: "awin", sourceId: "A1" }, units: 3, costs: { journeyCost: 0, journeyMinutes: 15 } },
    });
  const join = async (name) =>
    (await call("POST", "/api/members", { name, alertsOptIn: true, alertLocalities: ["Camden"], paidTier: "diamond", paidUntil: "2027-06-01", ...FIT })).body
      .member;
  const TRIP = { journeyCost: 0, journeyMinutes: 15, cashAvailable: 100000 };
  const claim = (bountyId, member, units) => call("POST", `/api/bounties/${bountyId}/claims`, { memberId: member.id, units, ...TRIP });
  const view = async (id, viewer = "operator") => (await call("GET", `/api/bounties/${id}?viewer=${viewer}`)).body.bounty;
  return { db, api, call, clock, state, bounty, join, claim, view, TRIP };
}

const NOTE_3 =
  "3 units bought through an earlier bounty for this item have not been recorded as sold or returned, so they still count against the demand for it";

/**
 * Ann buys 3 units on bounty 1 (cap 4), a fresh shelf count of 7 is
 * recorded, and bounty 1 is closed by `close` ("withdraw" or "expire").
 * Returns the world, the members and Ann's completed claim.
 */
async function boughtThenClosed(close, { hold = false } = {}) {
  const w = await world();
  const first = await w.bounty(close === "expire" ? 90 : 3 * 24 * 60);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.match(first.body.message, /with a cap of 4 units/);
  w.clock.now = at(10);
  const ann = await w.join("Ann");
  const bob = await w.join("Bob");
  const cat = await w.join("Cat");
  const dan = await w.join("Dan");
  const a = await w.claim(1, ann, 3);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  w.clock.now = at(20);
  assert.equal((await w.call("POST", `/api/claims/${a.body.claim.id}/complete`, { memberId: ann.id })).status, 200);
  if (hold) {
    // Dan holds the last unit under bounty 1's cap when it closes.
    w.clock.now = at(25);
    const d = await w.claim(1, dan, 1);
    assert.equal(d.status, 201, JSON.stringify(d.body));
  }
  // A fresh shelf count: 7 units seen.
  w.clock.now = at(30);
  w.state.shelf = { units_seen: 7, checked_at: at(30) };
  if (close === "withdraw") assert.equal((await w.call("POST", "/api/bounties/1/withdraw", {})).status, 200);
  else w.clock.now = at(100); // bounty 1 expired at 90 minutes
  return { w, ann, bob, cat, dan, annClaim: a.body.claim };
}

for (const close of ["withdraw", "expire"]) {
  test(`a bounty that replaces one ${close === "withdraw" ? "withdrawn" : "expired"} after purchases leaves room for at most 1 more unit (round 5, finding 2)`, async () => {
    const { w, bob, cat } = await boughtThenClosed(close);
    try {
      const next = await w.bounty();
      assert.equal(next.status, 201, JSON.stringify(next.body));
      assert.match(next.body.message, /^Bounty created \(Priority \d\) with a cap of 1 unit\./);
      const card = next.body.bounty;
      assert.equal(card.cap, 1);
      assert.equal(card.remaining, 1);
      assert.equal(card.figures.units, 1, "the figures are worked out for the 1 unit left");
      assert.equal(card.earlier.units, 3);
      assert.equal(card.earlier.outstanding, 3);
      assert.equal(card.earlier.note, NOTE_3);
      assert.match(card.earlier.release, /records them as sold or returned, or the operator records a reconciliation with a reason/);
      assert.ok(card.capBasis.notes.includes(NOTE_3), card.capBasis.notes.join(" | "));
      // The demand check on the card names them too.
      assert.match(card.estimate.checks.find((c) => c.id === "demand").detail, /3 units bought through an earlier bounty/);

      // Bob's own check counts them ahead of his unit.
      const preview = await w.call("POST", `/api/bounties/${card.id}/claim-check`, { memberId: bob.id, units: 1, ...w.TRIP });
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      assert.equal(preview.body.check.shared.earlier, 3);
      assert.equal(preview.body.check.shared.demandLeft, 1);
      assert.match(preview.body.message, /3 units bought through an earlier bounty for this item have not been recorded as sold or returned/);

      // Alerts: two per unit left, one unit left.
      const sent = await w.call("POST", `/api/bounties/${card.id}/alerts`, {});
      assert.equal(sent.status, 200);
      assert.equal(sent.body.exposure.cap, 1);
      assert.equal(sent.body.exposure.limit, 2);

      // Bob cannot claim 3: 6 units against demand for 4.
      const three = await w.claim(card.id, bob, 3);
      assert.equal(three.status, 409);
      assert.equal(three.body.error, `Only 1 unit remains under this bounty's distribution cap. ${NOTE_3}.`);
      const one = await w.claim(card.id, bob, 1);
      assert.equal(one.status, 201, JSON.stringify(one.body));
      const more = await w.claim(card.id, cat, 1);
      assert.equal(more.status, 409);
      assert.match(more.body.error, /^The distribution cap for this bounty is fully claimed\. 3 units bought through an earlier bounty/);
    } finally {
      await w.api.close();
    }
  });
}

test("a live claim on an expired bounty counts against the demand until it lapses (round 5)", async () => {
  const { w, bob } = await boughtThenClosed("expire", { hold: true });
  try {
    const next = await w.bounty();
    assert.equal(next.status, 201);
    const card = next.body.bounty;
    // 3 bought and 1 held on the expired bounty take all 4.
    assert.equal(card.cap, 0);
    assert.equal(card.earlier.units, 4);
    assert.equal(card.earlier.held, 1);
    assert.match(card.earlier.note, /1 unit is held in a claim on an earlier bounty for this item, so it counts against the demand for it until the claim lapses or is released/);
    const refused = await w.claim(card.id, bob, 1);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /^The distribution cap is 0: 3 units bought through an earlier bounty/);
    const alerts = await w.call("POST", `/api/bounties/${card.id}/alerts`, {});
    assert.ok(alerts.body.blockers.some((b) => b.startsWith("The distribution cap is 0: 3 units bought")), alerts.body.blockers.join(" | "));
    // Dan's claim lapses 3 hours after it was made (25 minutes in).
    w.clock.now = at(25 + 3 * 60 + 1);
    const after = await w.view(card.id);
    assert.equal(after.earlier.held, 0);
    assert.equal(after.cap, 1);
    assert.equal((await w.claim(card.id, bob, 1)).status, 201);
  } finally {
    await w.api.close();
  }
});

test("units recorded as sold or returned by the member who bought them stop counting, and the cap rises (round 5)", async () => {
  const { w, ann, bob, cat, annClaim } = await boughtThenClosed("withdraw");
  try {
    const next = (await w.bounty()).body.bounty;
    assert.equal(next.cap, 1);
    // Ann sees her own earlier purchase on the replacement card; Bob does not.
    const annCard = await w.view(next.id, ann.id);
    assert.deepEqual(
      annCard.earlier.claims.map((c) => ({ id: c.id, mine: c.mine, units: c.units, outstanding: c.outstanding })),
      [{ id: annClaim.id, mine: true, units: 3, outstanding: 3 }],
    );
    assert.deepEqual((await w.view(next.id, bob.id)).earlier.claims, []);
    assert.equal((await w.call("GET", `/api/bounties/${next.id}`)).body.bounty.earlier.units, 3);

    w.clock.now = at(40);
    const sold = await w.call("POST", `/api/claims/${annClaim.id}/resale`, { memberId: ann.id, sold: 2 });
    assert.equal(sold.status, 200, JSON.stringify(sold.body));
    assert.equal(sold.body.outstanding, 1);
    assert.deepEqual(sold.body.released, { sold: 2, returned: 0, reconciled: 0 });
    assert.equal(sold.body.message, "Recorded: 2 units sold. 1 unit bought through this claim still counts against the demand for the item until recorded as sold or returned.");
    // The open bounty for the item was worked out again at once.
    assert.deepEqual(sold.body.bounties.rechecked, [next.id]);
    const row = w.db.prepare("SELECT kind, units, recorded_by, member_id, created FROM claim_releases").get();
    assert.deepEqual({ ...row }, { kind: "sold", units: 2, recorded_by: "member", member_id: ann.id, created: at(40) });

    let card = await w.view(next.id);
    assert.equal(card.cap, 3);
    assert.equal(card.earlier.outstanding, 1);
    assert.match(card.earlier.note, /^1 unit bought through an earlier bounty for this item has not been recorded as sold or returned, so it still counts/);
    // The figures follow the cap up again: 3 units, the trial batch.
    assert.equal(card.figures.units, 3);
    assert.equal((await w.claim(next.id, bob, 3)).status, 201);
    assert.equal((await w.claim(next.id, cat, 1)).status, 409);

    // The last unit is returned to the shop: nothing from bounty 1 counts now.
    w.clock.now = at(50);
    const back = await w.call("POST", `/api/claims/${annClaim.id}/resale`, { memberId: ann.id, returned: 1 });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.outstanding, 0);
    assert.match(back.body.message, /^Recorded: 1 unit returned to the shop\. None of the units bought through this claim count/);
    card = await w.view(next.id);
    assert.equal(card.earlier, null);
    assert.equal(card.cap, 4);
    assert.ok(!card.capBasis.notes.some((n) => /earlier bount/.test(n)), card.capBasis.notes.join(" | "));
    // The claim on bounty 1 shows what was recorded.
    const old = (await w.view(1, ann.id)).claims.find((c) => c.id === annClaim.id);
    assert.deepEqual(old.released, { sold: 2, returned: 1, reconciled: 0 });
    assert.equal(old.outstanding, 0);
    assert.deepEqual(old.releases.map((r) => [r.kind, r.units, r.recordedBy]), [["sold", 2, "member"], ["returned", 1, "member"]]);
  } finally {
    await w.api.close();
  }
});

test("the operator's reconciliation releases units with a reason, stored with the time and who (round 5)", async () => {
  const { w, ann, annClaim } = await boughtThenClosed("withdraw");
  try {
    const next = (await w.bounty()).body.bounty;
    const card = await w.view(next.id);
    assert.deepEqual(
      card.earlier.claims.map((c) => ({ id: c.id, memberName: c.memberName, bountyId: c.bountyId, outstanding: c.outstanding })),
      [{ id: annClaim.id, memberName: "Ann", bountyId: 1, outstanding: 3 }],
    );
    // Only the operator, and only with a reason.
    const asMember = await w.call("POST", `/api/claims/${annClaim.id}/reconcile`, { memberId: ann.id, units: 1, reason: "Sold on eBay" });
    assert.equal(asMember.status, 403);
    assert.match(asMember.body.error, /^Only the operator can record a reconciliation/);
    const noReason = await w.call("POST", `/api/claims/${annClaim.id}/reconcile`, { viewer: "operator", units: 1 });
    assert.equal(noReason.status, 400);
    assert.match(noReason.body.error, /^reason is required/);
    w.clock.now = at(45);
    const ok = await w.call("POST", `/api/claims/${annClaim.id}/reconcile`, {
      viewer: "operator",
      units: 2,
      reason: "Ann sent the eBay order numbers for 2 sales",
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.outstanding, 1);
    assert.equal(
      ok.body.message,
      "Reconciliation recorded: 2 units released, with the reason given. 1 unit bought through this claim still counts against the demand for the item until recorded as sold or returned.",
    );
    const row = w.db.prepare("SELECT kind, units, reason, recorded_by, member_id, created FROM claim_releases").get();
    assert.deepEqual(
      { ...row },
      { kind: "reconciled", units: 2, reason: "Ann sent the eBay order numbers for 2 sales", recorded_by: "operator", member_id: null, created: at(45) },
    );
    const after = await w.view(next.id);
    assert.equal(after.cap, 3);
    assert.equal(after.earlier.outstanding, 1);
    assert.deepEqual(after.earlier.released, { sold: 0, returned: 0, reconciled: 2 });
  } finally {
    await w.api.close();
  }
});

test("a release never exceeds what is outstanding, and only a purchase can be released (round 5)", async () => {
  const { w, ann, bob, annClaim } = await boughtThenClosed("withdraw");
  try {
    const next = (await w.bounty()).body.bounty;
    // More than the 3 bought.
    const tooMany = await w.call("POST", `/api/claims/${annClaim.id}/resale`, { memberId: ann.id, sold: 2, returned: 2 });
    assert.equal(tooMany.status, 409);
    assert.equal(tooMany.body.error, "Only 3 units bought through this claim are not yet recorded as sold, returned or reconciled, so 4 units cannot be recorded");
    assert.equal((await w.call("POST", `/api/claims/${annClaim.id}/reconcile`, { viewer: "operator", units: 4, reason: "Count" })).status, 409);
    // Someone else's claim, nothing entered, a blank that is not a count.
    assert.equal((await w.call("POST", `/api/claims/${annClaim.id}/resale`, { memberId: bob.id, sold: 1 })).status, 403);
    assert.equal((await w.call("POST", `/api/claims/${annClaim.id}/resale`, { memberId: ann.id })).status, 400);
    assert.equal((await w.call("POST", `/api/claims/${annClaim.id}/resale`, { memberId: ann.id, sold: -1 })).status, 400);
    assert.equal((await w.call("POST", `/api/claims/${annClaim.id}/resale`, { memberId: ann.id, sold: 1.5 })).status, 400);
    assert.equal((await w.call("POST", "/api/claims/999/resale", { memberId: ann.id, sold: 1 })).status, 404);
    // An active claim has bought nothing yet.
    const held = await w.claim(next.id, bob, 1);
    assert.equal(held.status, 201);
    const active = await w.call("POST", `/api/claims/${held.body.claim.id}/resale`, { memberId: bob.id, sold: 1 });
    assert.equal(active.status, 409);
    assert.match(active.body.error, /has not been marked as bought/);
    assert.equal((await w.call("POST", `/api/claims/${held.body.claim.id}/reconcile`, { viewer: "operator", units: 1, reason: "x" })).status, 409);
    // Nothing above was stored.
    assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM claim_releases").get().n, 0);
    // 2 reconciled, then 1 sold, then nothing is left to release.
    assert.equal((await w.call("POST", `/api/claims/${annClaim.id}/reconcile`, { viewer: "operator", units: 2, reason: "Order numbers" })).status, 200);
    const over = await w.call("POST", `/api/claims/${annClaim.id}/resale`, { memberId: ann.id, sold: 2 });
    assert.equal(over.status, 409);
    assert.match(over.body.error, /^Only 1 unit bought through this claim is not yet recorded/);
    assert.equal((await w.call("POST", `/api/claims/${annClaim.id}/resale`, { memberId: ann.id, sold: 1 })).status, 200);
    const done = await w.call("POST", `/api/claims/${annClaim.id}/reconcile`, { viewer: "operator", units: 1, reason: "Count" });
    assert.equal(done.status, 409);
    assert.equal(done.body.error, "Every unit bought through this claim is already recorded as sold, returned or reconciled");
    assert.equal(w.db.prepare("SELECT COALESCE(SUM(units), 0) AS n FROM claim_releases").get().n, 3);
  } finally {
    await w.api.close();
  }
});

test("units bought through a bounty still count on that bounty once sold, and a sample bounty never counts (round 5)", async () => {
  const w = await world();
  try {
    const first = (await w.bounty()).body.bounty;
    w.clock.now = at(10);
    const ann = await w.join("Ann");
    const bob = await w.join("Bob");
    const a = await w.claim(first.id, ann, 3);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    w.clock.now = at(20);
    assert.equal((await w.call("POST", `/api/claims/${a.body.claim.id}/complete`, { memberId: ann.id })).status, 200);
    assert.equal((await w.call("POST", `/api/claims/${a.body.claim.id}/resale`, { memberId: ann.id, sold: 3 })).status, 200);
    // The bounty's own cap still counts every unit bought through it once
    // (round 4): selling them frees demand for a later bounty, not more of
    // this one's share.
    const card = await w.view(first.id);
    assert.equal(card.earlier, null);
    assert.equal(card.remaining, 1);
    assert.equal((await w.claim(first.id, bob, 2)).status, 409);
    // A sample bounty with the same barcode takes nothing from the demand.
    assert.equal(
      (
        await w.call("POST", "/api/bounties", {
          title: "Sample kettle", locality: "Camden", retailer: "Argos", availableUnits: 5, salesPerWeek: 3, sellWindowWeeks: 2,
          competingListings: 0, competingSellers: 0, barcode: GTIN, expiresAt: at(60 * 24), sponsored: false, sample: true,
        })
      ).status,
      201,
    );
    assert.equal((await w.view(first.id)).remaining, 1);
  } finally {
    await w.api.close();
  }
});

test("distributionCap takes earlier units off the demand, and an earlier count that is not known gives 0", () => {
  const used = { availableUnits: 7, salesPerWeek: 2.02, sellWindowWeeks: 2, competingListings: 0 };
  assert.equal(distributionCap(used), 4);
  assert.equal(distributionCap({ ...used, earlierUnits: 3 }), 1);
  assert.equal(distributionCap({ ...used, earlierUnits: 5 }), 0);
  assert.equal(distributionCap({ ...used, earlierUnits: null }), 0);
  assert.equal(distributionCap({ ...used, earlierUnits: -1 }), 0);
});
