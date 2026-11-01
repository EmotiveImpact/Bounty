// Round 5b, after the finding 4 verifiers: the suitability checks at
// exactly their limits (load, cash, storage) and with a journey cost in the
// cash figure, in Research and on the claim route; storage counts the units
// a member already has at home from bounties; a partial fit names how many
// units fit and what sets the most they can claim; and the alert inbox says
// what the member's profile still needs once, and stops asking once it is
// complete.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.mjs";
import { serve } from "./test-support.mjs";
import { londonDate } from "./http.mjs";
import { KIND, LICENCE } from "./contract.mjs";
import { storeLookup, upsertObservations, upsertResearch } from "./evidence.mjs";
import * as researchRoutes from "./routes-research.mjs";
import * as bountyRoutes from "./routes-bounties.mjs";
import { suitability } from "./suitability.mjs";

const DAY = 86400000;
const GTIN = "5012345678115";
const ukDay = (days) => londonDate(new Date(Date.now() - days * DAY));
const ITEM = { title: "Mini Bluetooth speaker black", barcode: GTIN, size: "one size", pack: "1", model: "BTS-20", condition: "new" };
const SALES = Array.from({ length: 26 }, (_, i) => {
  const sold = 1 + Math.floor((i * 80) / 26);
  return { source_id: "s" + i, seller: "seller" + i, observed: ukDay(sold), listed: ukDay(sold + 4) };
});

function evidence() {
  const now = new Date().toISOString();
  const db = openDb(":memory:");
  upsertObservations(
    db,
    [{ id: 900001, title: ITEM.title, store: "Home Bargains", place: "PR1 2AR", city: "Preston", osm_id: "node/111", price: 1200, barcode: GTIN, day: ukDay(0) }],
    { now },
  );
  upsertResearch(
    db,
    "sales",
    SALES.map((s) => ({ ...ITEM, ...s, kind: KIND.SOLD, price: 2800, retailer: "eBay UK", licence: LICENCE.SELF })),
    { now },
  );
  storeLookup(db, "ebay", GTIN, [], { now });
  return db;
}

const CAR = { transport: "Car", carryKg: 5, cashAvailable: 10000, storageUnits: 10 };
// Three 0.9 kg units: 2.7 kg in all (3 x 0.9 is 2.7000000000000006 in
// floating point, so the limit must allow for that). With no journey cost the
// trip needs £47.40 before any payout; with a £5.00 journey, £52.40.
const request = (over = {}) => ({
  offer: { provider: "openprices", sourceId: "900001" },
  sales: SALES.map((s) => ({ provider: "sales", sourceId: s.source_id })),
  units: 3,
  weightKg: 0.9,
  costs: { postage: 300, packaging: 30, handlingMinutes: 5, journeyCost: 0, journeyMinutes: 15 },
  hourlyFloor: 800,
  locality: "Camden",
  offerAttributes: { pack: "1", model: "BTS-20", condition: "new", size: "one size" },
  category: "general",
  categoryReason: "A loudspeaker, not food",
  profile: CAR,
  ...over,
});

async function app(db) {
  const api = await serve(db, [
    { routes: researchRoutes.routes },
    { routes: (x) => bountyRoutes.routes(x, { clock: () => new Date().toISOString(), photoDir: "/nonexistent-photos" }) },
  ]);
  const call = (method, path, body) => api.call(method, path, body, { Origin: api.base });
  const check = await call("POST", "/api/research/checks", {
    barcode: GTIN,
    retailer: "Home Bargains",
    locality: "Camden",
    method: "in_store",
    inStock: true,
    unitsSeen: 6,
    branch: "Home Bargains, Camden High Street NW1 7JE",
    pricePence: 1250,
  });
  assert.equal(check.status, 201);
  const estimate = async (over) => {
    const res = await call("POST", "/api/research/estimate", request(over));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };
  const bounty = async (over = {}) => {
    const res = await call("POST", "/api/bounties", {
      title: "Mini speaker",
      locality: "Camden",
      retailer: "Home Bargains",
      salesPerWeek: 10,
      sellWindowWeeks: 2,
      expiresAt: new Date(Date.now() + 5 * DAY).toISOString(),
      sponsored: false,
      estimate: request(over),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.bounty;
  };
  const member = async (name, profile = {}, extra = {}) => {
    const res = await call("POST", "/api/members", {
      name,
      alertsOptIn: true,
      alertLocalities: ["Camden"],
      paidTier: "diamond",
      paidUntil: new Date(Date.now() + 200 * DAY).toISOString().slice(0, 10),
      ...profile,
      ...extra,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.member;
  };
  const claim = (bountyId, memberId, units, over = {}) =>
    call("POST", `/api/bounties/${bountyId}/claims`, { memberId, units, journeyCost: 0, journeyMinutes: 15, cashAvailable: 10000, ...over });
  const claimCheck = (bountyId, memberId, units, over = {}) =>
    call("POST", `/api/bounties/${bountyId}/claim-check`, { memberId, units, journeyCost: 0, journeyMinutes: 15, cashAvailable: 10000, ...over });
  const card = async (bountyId, viewer) => (await call("GET", `/api/bounties/${bountyId}?viewer=${viewer}`)).body.bounty;
  return { api, call, estimate, bounty, member, claim, claimCheck, card, close: () => api.close() };
}

const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));
const failing = (est) => est.alert.checks.filter((c) => !c.ok).map((c) => c.id);
const fitFailing = (check) => check.fit.checks.filter((c) => !c.ok).map((c) => c.id);

test("the pure check passes at exactly each limit and fails just past it", () => {
  const at = (profile, over = {}) =>
    suitability({ units: 3, unitKg: 0.9, cashRequired: 4740, profile: { transport: "Walk", carryKg: 2.7, cashAvailable: 4740, storageUnits: 3, ...profile }, ...over });
  const exact = at({});
  assert.equal(exact.ok, true, exact.reasons.join("; "));
  assert.equal(byId(exact.checks)["total-load"].detail, "All 3 units (2.7 kg) are within your 2.7 kg load limit on foot");
  assert.equal(byId(exact.checks)["cash-available"].detail, "£47.40 cash needed before any payout, within the £47.40 you can spend");
  assert.equal(byId(exact.checks)["storage-space"].detail, "3 units fit the room you have at home for 3 more now");
  assert.deepEqual(at({ carryKg: 2.69 }).checks.filter((c) => !c.ok).map((c) => c.id), ["total-load"]);
  assert.deepEqual(at({ cashAvailable: 4739 }).checks.filter((c) => !c.ok).map((c) => c.id), ["cash-available"]);
  assert.deepEqual(at({ storageUnits: 2 }).checks.filter((c) => !c.ok).map((c) => c.id), ["storage-space"]);
  // Units already at home take up the room.
  const held = at({ storageUnits: 5, heldUnits: 2 });
  assert.equal(held.ok, true);
  assert.equal(
    byId(held.checks)["storage-space"].detail,
    "3 units fit the room you have at home for 3 more now (room for 5 in all, less 2 units bought through bounties and not yet recorded as sold or returned)",
  );
  const full = at({ storageUnits: 5, heldUnits: 5 });
  assert.equal(
    byId(full.checks)["storage-space"].detail,
    "You have no room at home for more units now (room for 5 in all, less 5 units bought through bounties and not yet recorded as sold or returned)",
  );
  assert.equal(full.maxUnits.storage, 0);
});

test("Research: exactly at the load, cash and storage limits passes, just past fails, and the journey is in the cash figure", async () => {
  const a = await app(evidence());
  try {
    const walk = await a.estimate({ profile: { transport: "Walk", carryKg: 2.7, cashAvailable: 4740, storageUnits: 3 } });
    assert.equal(walk.suitability.ok, true, walk.suitability.reasons.join("; "));
    assert.equal(walk.suitability.cashRequired, 4740);
    assert.deepEqual(failing(walk), []);
    const bus = await a.estimate({ profile: { transport: "Public transport", carryKg: 2.7, cashAvailable: 4740, storageUnits: 3 } });
    assert.equal(bus.suitability.ok, true, bus.suitability.reasons.join("; "));
    assert.deepEqual(failing(await a.estimate({ profile: { transport: "Walk", carryKg: 2.69, cashAvailable: 4740, storageUnits: 3 } })), ["total-load"]);
    assert.deepEqual(failing(await a.estimate({ profile: { transport: "Walk", carryKg: 2.7, cashAvailable: 4739, storageUnits: 3 } })), ["cash-available"]);
    assert.deepEqual(failing(await a.estimate({ profile: { transport: "Walk", carryKg: 2.7, cashAvailable: 4740, storageUnits: 2 } })), ["storage-space"]);

    // A £5.00 journey is cash spent before any payout too.
    const costs = { postage: 300, packaging: 30, handlingMinutes: 5, journeyCost: 500, journeyMinutes: 15 };
    const trip = await a.estimate({ costs, profile: { ...CAR, cashAvailable: 5240 } });
    assert.equal(trip.suitability.cashRequired, 5240);
    assert.equal(byId(trip.alert.checks)["cash-available"].ok, true);
    const short = await a.estimate({ costs, profile: { ...CAR, cashAvailable: 5239 } });
    assert.equal(byId(short.alert.checks)["cash-available"].ok, false);
    assert.match(byId(short.alert.checks)["cash-available"].detail, /^The trip needs £52\.40 in cash before any payout, more than the £52\.39 you can spend/);
  } finally {
    await a.close();
  }
});

test("claim route: exactly at the load, cash and storage limits passes, just past fails, and the journey is in the cash figure", async () => {
  const a = await app(evidence());
  try {
    const b = await a.bounty();
    const edge = await a.member("Edge", { transport: "Walk", carryKg: 2.7, storageUnits: 3 });
    const exact = await a.claimCheck(b.id, edge.id, 3, { cashAvailable: 4740 });
    assert.equal(exact.status, 200, JSON.stringify(exact.body));
    assert.equal(exact.body.check.fit.ok, true, exact.body.check.reasons.join("; "));
    assert.equal(exact.body.check.ok, true, exact.body.check.reasons.join("; "));
    assert.deepEqual(fitFailing((await a.claimCheck(b.id, edge.id, 3, { cashAvailable: 4739 })).body.check), ["cash-available"]);
    const bus = await a.member("Bus", { transport: "Public transport", carryKg: 2.7, storageUnits: 3 });
    assert.equal((await a.claimCheck(b.id, bus.id, 3, { cashAvailable: 4740 })).body.check.ok, true);
    const light = await a.member("Light", { transport: "Walk", carryKg: 2.69, storageUnits: 3 });
    assert.deepEqual(fitFailing((await a.claimCheck(b.id, light.id, 3, { cashAvailable: 4740 })).body.check), ["total-load"]);
    const small = await a.member("Small", { transport: "Walk", carryKg: 2.7, storageUnits: 2 });
    assert.deepEqual(fitFailing((await a.claimCheck(b.id, small.id, 3, { cashAvailable: 4740 })).body.check), ["storage-space"]);

    // A £5.00 journey: £52.40 passes, £52.39 does not.
    const driver = await a.member("Driver", { transport: "Car", carryKg: 5, storageUnits: 10 });
    const fare = { journeyCost: 500, cashAvailable: 5240 };
    const paid = await a.claimCheck(b.id, driver.id, 3, fare);
    assert.equal(byId(paid.body.check.fit.checks)["cash-available"].ok, true, JSON.stringify(paid.body.check.fit.checks));
    assert.equal(paid.body.check.figures.cashRequired, 5240);
    const under = await a.claimCheck(b.id, driver.id, 3, { ...fare, cashAvailable: 5239 });
    assert.deepEqual(fitFailing(under.body.check), ["cash-available"]);

    // The claim itself at every limit at once.
    const made = await a.claim(b.id, edge.id, 3, { cashAvailable: 4740 });
    assert.equal(made.status, 201, JSON.stringify(made.body));
  } finally {
    await a.close();
  }
});

test("storage counts the units a member already has at home from bounties until they record them as sold or returned", async () => {
  const a = await app(evidence());
  try {
    const b = await a.bounty();
    const eve = await a.member("Eve", { transport: "Car", carryKg: 5, storageUnits: 2 });
    const first = await a.claim(b.id, eve.id, 2);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal((await a.call("POST", `/api/claims/${first.body.claim.id}/complete`, { memberId: eve.id })).status, 200);

    // Her room for 2 is full: another unit does not fit.
    const full = await a.claimCheck(b.id, eve.id, 1);
    assert.deepEqual(fitFailing(full.body.check), ["storage-space"]);
    assert.equal(
      byId(full.body.check.fit.checks)["storage-space"].detail,
      "You have no room at home for more units now (room for 2 in all, less 2 units bought through bounties and not yet recorded as sold or returned)",
    );
    const refused = await a.claim(b.id, eve.id, 1);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /You have no room at home for more units now/);
    const card = await a.card(b.id, eve.id);
    assert.equal(card.viewer.fit.ok, false);
    assert.equal(card.viewer.canClaim, false);

    // She records 1 as sold: room for 1 again.
    const sold = await a.call("POST", `/api/claims/${first.body.claim.id}/resale`, { memberId: eve.id, sold: 1 });
    assert.equal(sold.status, 200, JSON.stringify(sold.body));
    const one = await a.claimCheck(b.id, eve.id, 1);
    assert.equal(one.body.check.fit.ok, true, JSON.stringify(one.body.check.fit.checks));
    assert.equal(
      byId(one.body.check.fit.checks)["storage-space"].detail,
      "1 unit fits the room you have at home for 1 more now (room for 2 in all, less 1 unit bought through bounties and not yet recorded as sold or returned)",
    );
    assert.deepEqual(fitFailing((await a.claimCheck(b.id, eve.id, 2)).body.check), ["storage-space"]);
  } finally {
    await a.close();
  }
});

test("a partial fit names how many units fit and what sets the most a member can claim", async () => {
  const a = await app(evidence());
  try {
    const b = await a.bounty();
    const dee = await a.member("Dee", { transport: "Car", carryKg: 5, storageUnits: 2 });
    const card = await a.card(b.id, dee.id);
    assert.equal(card.trip.state, "does-not-fit");
    assert.equal(card.trip.label, "2 of the 3 units fit you");
    assert.equal(card.viewer.fit.partial, true);
    assert.equal(card.viewer.maxClaimUnits, 2);
    assert.equal(card.viewer.claimLimit, "what fits your room at home");
    const kilo = await a.member("Kilo", { transport: "Walk", carryKg: 1, storageUnits: 10 });
    const k = await a.card(b.id, kilo.id);
    assert.equal(k.trip.label, "1 of the 3 units fit you");
    assert.equal(k.viewer.claimLimit, "what fits your load limit");
    const fine = await a.member("Fine", { transport: "Car", carryKg: 5, storageUnits: 10 });
    const f = await a.card(b.id, fine.id);
    assert.equal(f.viewer.claimLimit, "your trial batch");
    assert.equal(f.viewer.maxClaimUnits, 3);
  } finally {
    await a.close();
  }
});

test("the alert inbox asks for the profile once, names storage, and stops asking once the profile is complete", async () => {
  const a = await app(evidence());
  try {
    const ann = await a.member("Ann");
    const gus = await a.member("Gus");
    const b = await a.bounty();
    const sent = await a.call("POST", `/api/bounties/${b.id}/alerts`, {});
    assert.ok([200, 201].includes(sent.status), JSON.stringify(sent.body));
    const inbox = async (m) => (await a.call("GET", `/api/members/${m.id}/alerts`)).body.alerts.find((x) => x.bountyId === b.id);
    const asked = await inbox(ann);
    assert.equal(asked.kind, "profile");
    assert.equal(asked.trip.state, "confirm-profile");
    assert.equal(asked.trip.label, "Confirm your transport, carrying limit and storage");
    assert.equal(asked.profile.complete, false);
    // The trip line asks for the profile, so the note does not say it again.
    assert.match(asked.trip.headline, /how many units you have room for at home in all/);
    assert.equal(asked.questionNote, null);

    // Gus completes his profile on foot: the trip does not fit it.
    assert.equal((await a.call("PATCH", `/api/members/${gus.id}`, { transport: "Walk", carryKg: 0.1, storageUnits: 10 })).status, 200);
    const unfit = await inbox(gus);
    assert.equal(unfit.kind, "profile");
    assert.equal(unfit.profile.complete, true, "so the card shows no 'Confirm your profile first' badge");
    assert.equal(unfit.trip.state, "does-not-fit");
    assert.equal(unfit.questionNote, "Your profile is complete, but this trip does not fit it as planned, so no alert with figures follows for it.");
  } finally {
    await a.close();
  }
});
