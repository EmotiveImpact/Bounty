// Round 5b, after the verifier's D4: a member who bought units through a
// bounty and lists them on eBay has them counted twice against the demand
// for the item, once as competing listings and once as units bought. With
// 26 confirmed sales over 90 days and no other listings, sales support about
// 4 units within two weeks: Ann buys 3 through bounty 1 and lists them, and
// bounty 2 must leave room for 1 more, not 0. A member's marketplace seller
// name (on their profile), once the operator confirms it, lets their own
// listings count once: only listings with a listing time after their
// purchase, matched to the units they held when each listing was seen.
// Listings by anyone else, with no seller name or no listing time, count in
// full, and a member who gave no seller name, or one not yet confirmed, is
// still counted twice (fail closed), with a note saying how to stop it.
//
// Also: the holder of a claim made before the cash for the trip was asked
// (no stored cash) is asked to confirm it through "Check my figures" on the
// next re-check, and is never told their figures failed.
//
// Everything runs through the routes on the real estimate, with the eBay
// listings stored as asking-price evidence and an asking-price lookup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.mjs";
import { serve } from "./test-support.mjs";
import { londonDate } from "./http.mjs";
import { KIND, LICENCE } from "./contract.mjs";
import { storeLookup, upsertObservations, upsertResearch } from "./evidence.mjs";
import { routes as bountyRoutes } from "./routes-bounties.mjs";
import { recordCheck } from "./audit.mjs";
import { schema } from "./bounties.mjs";

const DAY = 86400000;
const MIN = 60000;
const GTIN = "5012345678115";
const ITEM = { title: "Mini Bluetooth speaker black", barcode: GTIN, size: "one size", pack: "1", model: "BTS-20", condition: "new" };
const ukDay = (days) => londonDate(new Date(Date.now() - days * DAY));
// 26 confirmed sales over about 80 days: about 2.02 a week, so about 4 units
// within the 2-week sell window.
const SALES = Array.from({ length: 26 }, (_, i) => {
  const sold = 1 + Math.floor((i * 80) / 26);
  return { source_id: "s" + i, seller: "seller" + i, observed: ukDay(sold), listed: ukDay(sold + 4) };
});
const CAR = { transport: "Car", carryKg: 5, storageUnits: 10 };
const TRIP = { journeyCost: 0, journeyMinutes: 15, cashAvailable: 100000 };

async function world() {
  const clock = { now: new Date().toISOString() };
  const step = (minutes) => (clock.now = new Date(Date.parse(clock.now) + minutes * MIN).toISOString());
  const db = openDb(":memory:");
  upsertObservations(
    db,
    [{ id: 700002, title: ITEM.title, store: "Home Bargains", place: "NW1 8QP", city: "London", osm_id: "node/222", price: 1200, barcode: GTIN, day: ukDay(0) }],
    { now: clock.now },
  );
  upsertResearch(
    db,
    "sales",
    SALES.map((s) => ({ ...ITEM, ...s, kind: KIND.SOLD, price: 2800, retailer: "eBay UK", licence: LICENCE.SELF })),
    { now: clock.now },
  );
  // An asking-price lookup that found no competing listings.
  storeLookup(db, "ebay", GTIN, [], { now: clock.now });
  const api = await serve(db, [{ routes: (x) => bountyRoutes(x, { clock: () => clock.now, photoDir: "/nonexistent-photos" }) }]);
  const call = (m, p, body) => api.call(m, p, body, { Origin: api.base });
  const shelf = (unitsSeen) =>
    recordCheck(
      db,
      { barcode: GTIN, retailer: "Home Bargains", locality: "Camden", branch: "node/222", checkedAt: clock.now, method: "in_store", inStock: true, unitsSeen, pricePence: 1200 },
      { now: clock.now },
    );
  const bounty = async () => {
    const r = await call("POST", "/api/bounties", {
      title: "Mini speaker",
      locality: "Camden",
      retailer: "Home Bargains",
      salesPerWeek: 10,
      sellWindowWeeks: 2,
      expiresAt: new Date(Date.parse(clock.now) + 3 * DAY).toISOString(),
      sponsored: false,
      estimate: {
        offer: { provider: "openprices", sourceId: "700002" },
        sales: SALES.map((s) => ({ provider: "sales", sourceId: s.source_id })),
        units: 3,
        weightKg: 0.4,
        costs: { postage: 300, packaging: 30, handlingMinutes: 5, journeyCost: 0, journeyMinutes: 15 },
        hourlyFloor: 800,
        locality: "Camden",
        offerAttributes: { pack: "1", model: "BTS-20", condition: "new", size: "one size" },
        category: "general",
        categoryReason: "A loudspeaker",
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.bounty;
  };
  const join = async (name, extra = {}) => {
    const r = await call("POST", "/api/members", {
      name,
      alertsOptIn: true,
      alertLocalities: ["Camden"],
      paidTier: "diamond",
      paidUntil: new Date(Date.now() + 200 * DAY).toISOString().slice(0, 10),
      ...CAR,
      ...extra,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.member;
  };
  const claim = (who, bountyId, units) => call("POST", `/api/bounties/${bountyId}/claims`, { memberId: who.id, units, ...TRIP });
  const card = async (bountyId, viewer = "operator") => (await call("GET", `/api/bounties/${bountyId}?viewer=${viewer}`)).body.bounty;
  // eBay listings seen now by one lookup: [{ id, seller, listed? }].
  const listings = (rows) => {
    upsertResearch(
      db,
      "ebay",
      rows.map((l) => ({
        ...ITEM,
        source_id: l.id,
        seller: l.seller ?? null,
        kind: KIND.ASKING,
        price: 2900,
        observed: clock.now,
        listed: l.listed ?? null,
        retailer: "eBay UK",
        licence: LICENCE.SELF,
      })),
      { now: clock.now },
    );
    storeLookup(db, "ebay", GTIN, rows.map((l) => l.id), { now: clock.now });
  };
  // A member's own listings, listed now (after anything bought before now).
  const own = (seller, n, from = 1) => Array.from({ length: n }, (_, i) => ({ id: `${seller}-${from + i}`, seller, listed: clock.now }));
  // The operator confirms a member's seller name (round 5b).
  const confirm = (who, sellerName, extra = {}) =>
    call("POST", `/api/members/${who.id}/seller-confirmation`, { viewer: "operator", sellerName, ...extra });
  return { db, api, call, clock, step, shelf, bounty, join, claim, card, listings, own, confirm };
}

/**
 * Ann buys `buys` units through bounty 1, which is then withdrawn; her
 * seller name is confirmed by the operator (unless confirmed is false); her
 * listings (listed after her purchase) and any others (listed, or a
 * function of the world giving them) are seen by a lookup; a fresh shelf count of 7
 * is recorded and bounty 2 is created. Returns the world, Ann, Bob, Ann's
 * claim and bounty 2.
 */
async function annBoughtAndListed({ annSeller = "ann_resells", buys = 3, listed = null, confirmed = true } = {}) {
  const w = await world();
  try {
    w.shelf(10);
    const one = await w.bounty();
    w.step(5);
    const ann = await w.join("Ann", annSeller ? { sellerName: annSeller } : {});
    if (annSeller && confirmed) assert.equal((await w.confirm(ann, annSeller)).status, 200);
    const bob = await w.join("Bob");
    const a = await w.claim(ann, one.id, buys);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    w.step(5);
    assert.equal((await w.call("POST", `/api/claims/${a.body.claim.id}/complete`, { memberId: ann.id })).status, 200);
    assert.equal((await w.call("POST", `/api/bounties/${one.id}/withdraw`, {})).status, 200);
    w.step(60);
    w.listings((typeof listed === "function" ? listed(w) : listed) ?? w.own("ann_resells", buys));
    w.shelf(7);
    const two = await w.bounty();
    return { w, ann, bob, annClaim: a.body.claim, two };
  } catch (error) {
    // A failed set-up still closes the server, so the run ends.
    await w.api.close();
    throw error;
  }
}

const used = (card) => card.capBasis?.used ?? {};

test("D4: the buyer's own eBay listings count once with her seller name, so 1 more unit can be claimed", async () => {
  const { w, bob, two } = await annBoughtAndListed();
  try {
    const card = await w.card(two.id);
    // About 4 units of demand, less Ann's 3: 1 unit, not 0.
    assert.equal(card.cap, 1, JSON.stringify(card.capBasis));
    assert.equal(card.remaining, 1);
    assert.equal(used(card).competingListings, 3);
    assert.equal(used(card).earlierUnits, 3);
    assert.equal(used(card).ownListings, 3, "Ann's 3 listings are her own units, counted once");
    assert.ok(
      card.capBasis.notes.includes(
        "3 of the 3 competing listings are members' own units bought through bounties for this item (matched by the seller name on their profile, confirmed by the operator), so they are counted once, not again as competing listings",
      ),
      JSON.stringify(card.capBasis.notes),
    );
    // Bob's own figures count the demand the same way (sharedTrip).
    const check = await w.call("POST", `/api/bounties/${two.id}/claim-check`, { memberId: bob.id, units: 1, ...TRIP });
    assert.equal(check.status, 200, JSON.stringify(check.body));
    assert.equal(check.body.check.ok, true, JSON.stringify(check.body.check.reasons));
    const made = await w.claim(bob, two.id, 1);
    assert.equal(made.status, 201, JSON.stringify(made.body));
  } finally {
    await w.api.close();
  }
});

test("D4 without a seller name: counted twice (fail closed) with a note, until she adds it", async () => {
  const { w, ann, bob, two } = await annBoughtAndListed({ annSeller: null });
  try {
    let card = await w.card(two.id);
    assert.equal(used(card).competingListings, 3);
    assert.equal(used(card).ownListings, 0);
    assert.equal(card.cap, 0);
    assert.ok(
      card.capBasis.notes.includes(
        "1 member holding units bought through bounties for this item has given no marketplace seller name, so any of those units listed for sale count twice: as competing listings and as units bought. Adding the seller name (for example the eBay user name) to the member profile, once the operator confirms it, stops their own listings counting twice",
      ),
      JSON.stringify(card.capBasis.notes),
    );
    const refused = await w.claim(bob, two.id, 1);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /The distribution cap is 0/);
    // Ann is told on the card, in plain words, how to stop it.
    const annCard = await w.card(two.id, ann.id);
    assert.match(annCard.viewer.sellerNote, /^You have 3 units of this item bought through bounties/);
    assert.match(annCard.viewer.sellerNote, /Add your seller name \(for example your eBay user name\) to your member profile and ask the operator to confirm it to stop that$/);
    assert.equal((await w.card(two.id, bob.id)).viewer.sellerNote, null, "Bob holds none, so he gets no such note");

    // Ann adds her seller name: the open bounty for the item is worked out
    // again, but her listings still count in full until the operator
    // confirms the name is hers (round 5b, second verification).
    const saved = await w.call("PATCH", `/api/members/${ann.id}`, { sellerName: "ann_resells" });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.member.sellerName, "ann_resells");
    assert.equal(saved.body.member.sellerConfirmedAt, null);
    assert.ok(saved.body.bounties.rechecked.includes(two.id), JSON.stringify(saved.body.bounties));
    card = await w.card(two.id);
    assert.equal(used(card).ownListings, 0);
    assert.equal(card.cap, 0);
    assert.ok(
      card.capBasis.notes.includes(
        "1 member holding units bought through bounties for this item has a seller name the operator has not yet confirmed, so any of those units listed for sale still count twice until the operator checks the name against the member's marketplace profile or a listing and confirms it",
      ),
      JSON.stringify(card.capBasis.notes),
    );
    assert.match((await w.card(two.id, ann.id)).viewer.sellerNote, /the operator has not yet confirmed your seller name "ann_resells"/);
    assert.deepEqual(
      card.sellerNames.map((n) => [n.name, n.sellerName, n.confirmed, n.outstanding]),
      [["Ann", "ann_resells", false, 3]],
      "the operator sees whose name waits for a check",
    );
    assert.equal((await w.card(two.id, bob.id)).sellerNames, null, "members never see the list");
    assert.equal((await w.claim(bob, two.id, 1)).status, 409);
    // The operator checks the name against her eBay profile and confirms it.
    const confirmed = await w.confirm(ann, "ann_resells");
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.ok(confirmed.body.member.sellerConfirmedAt);
    assert.ok(confirmed.body.bounties.rechecked.includes(two.id), JSON.stringify(confirmed.body.bounties));
    card = await w.card(two.id);
    assert.equal(used(card).ownListings, 3);
    assert.equal(card.cap, 1);
    assert.equal(card.sellerNames[0].confirmed, true);
    assert.equal((await w.card(two.id, ann.id)).viewer.sellerNote, null);
    const made = await w.claim(bob, two.id, 1);
    assert.equal(made.status, 201, JSON.stringify(made.body));
  } finally {
    await w.api.close();
  }
});

test("listings by an unrelated seller, or with no seller name, still count in full", async () => {
  // Ann buys 2 and lists 2; another seller lists 1 and one listing names no seller.
  const { w, two } = await annBoughtAndListed({
    buys: 2,
    listed: (w) => [...w.own("ann_resells", 2), { id: "other-1", seller: "speaker_world" }, { id: "anon-1" }],
  });
  try {
    const card = await w.card(two.id);
    assert.equal(used(card).competingListings, 4);
    assert.equal(used(card).earlierUnits, 2);
    assert.equal(used(card).ownListings, 2, "only Ann's two listings are left out");
    // About 4 units of demand, less 2 independent listings and Ann's 2 units.
    assert.equal(card.cap, 0);
    assert.deepEqual(
      card.capBasis.evidence.listingsBySeller.map((s) => [s.seller, s.listings]),
      [["ann_resells", 2], ["speaker_world", 1]],
    );
  } finally {
    await w.api.close();
  }
});

test("a member with more listings than outstanding units has only the outstanding ones left out", async () => {
  // Ann bought 2 through bounty 1 but lists 3 (one is other stock).
  const { w, two } = await annBoughtAndListed({ buys: 2, listed: (w) => w.own("ann_resells", 3) });
  try {
    const card = await w.card(two.id);
    assert.equal(used(card).competingListings, 3);
    assert.equal(used(card).ownListings, 2);
    // 4 - (3 - 2) - 2 = 1, never 4 - 0 - 2 = 2.
    assert.equal(card.cap, 1);
    assert.ok(card.capBasis.notes.some((n) => n.startsWith("2 of the 3 competing listings are members' own units")));
  } finally {
    await w.api.close();
  }
});

test("a listing created before the member bought through a bounty is other stock and counts in full", async () => {
  const before = new Date(Date.now() - 2 * DAY).toISOString();
  const { w, two } = await annBoughtAndListed({ listed: [1, 2, 3].map((i) => ({ id: "old-" + i, seller: "ann_resells", listed: before })) });
  try {
    const card = await w.card(two.id);
    assert.equal(used(card).competingListings, 3);
    assert.equal(used(card).ownListings, 0);
    assert.equal(card.cap, 0);
  } finally {
    await w.api.close();
  }
});

test("release path: once Ann records her 3 as sold, neither count includes them", async () => {
  const { w, ann, annClaim, two } = await annBoughtAndListed();
  try {
    assert.equal((await w.card(two.id)).cap, 1);
    w.step(30);
    const sold = await w.call("POST", `/api/claims/${annClaim.id}/resale`, { memberId: ann.id, sold: 3 });
    assert.equal(sold.status, 200, JSON.stringify(sold.body));
    assert.ok(sold.body.bounties.rechecked.includes(two.id));
    const card = await w.card(two.id);
    assert.equal(used(card).earlierUnits, 0, "no units bought are outstanding");
    // Her listings were seen while she held those units, so they are hers
    // and stay out of the competing count after the sale too.
    assert.equal(used(card).competingListings, 3);
    assert.equal(used(card).ownListings, 3);
    // The whole demand of about 4 units is free again (7 on the shelf).
    assert.equal(card.cap, 4);
  } finally {
    await w.api.close();
  }
});

test("a purchase on the same bounty is counted once too, and never below the independent listings", async () => {
  const { w, bob, two } = await annBoughtAndListed();
  try {
    assert.equal((await w.call("PATCH", `/api/members/${bob.id}`, { sellerName: "bob_sells" })).status, 200);
    assert.equal((await w.confirm(bob, "bob_sells")).status, 200);
    const b = await w.claim(bob, two.id, 1);
    assert.equal(b.status, 201, JSON.stringify(b.body));
    w.step(5);
    assert.equal((await w.call("POST", `/api/claims/${b.body.claim.id}/complete`, { memberId: bob.id })).status, 200);
    w.step(30);
    // Bob lists the unit he bought through bounty 2; Ann's 3 are still listed.
    w.listings([...w.own("ann_resells", 3), { id: "bob-1", seller: "bob_sells", listed: w.clock.now }]);
    assert.equal((await w.call("POST", `/api/bounties/${two.id}/recheck`, {})).status, 200);
    let card = await w.card(two.id);
    assert.equal(used(card).competingListings, 4);
    assert.equal(used(card).ownListings, 4, "Ann's 3 and Bob's 1");
    // 4 - (4 - 4) - 3 = 1, the unit Bob bought: his listing is not a second unit against it.
    assert.equal(card.cap, 1);
    assert.equal(card.completedUnits, 1);
    // Without Bob's seller name his listing counts in full as well.
    assert.equal((await w.call("PATCH", `/api/members/${bob.id}`, { sellerName: "" })).status, 200);
    card = await w.card(two.id);
    assert.equal(used(card).ownListings, 3);
    assert.equal(card.cap, 0);
    // Giving the name again needs the operator to confirm it again: clearing
    // it cleared the confirmation.
    const back = await w.call("PATCH", `/api/members/${bob.id}`, { sellerName: "bob_sells" });
    assert.equal(back.status, 200);
    assert.equal(back.body.member.sellerConfirmedAt, null);
    assert.equal(used(await w.card(two.id)).ownListings, 3);
    // An independent seller's listing always counts: with Bob's name
    // confirmed again, 5 listings of which 4 are members' own leave 1 competing.
    assert.equal((await w.confirm(bob, "bob_sells")).status, 200);
    w.step(5);
    w.listings([...w.own("ann_resells", 3), { id: "bob-1", seller: "bob_sells", listed: w.clock.now }, { id: "ind-1", seller: "speaker_world" }]);
    assert.equal((await w.call("POST", `/api/bounties/${two.id}/recheck`, {})).status, 200);
    card = await w.card(two.id);
    assert.equal(used(card).competingListings, 5);
    assert.equal(used(card).ownListings, 4);
    assert.equal(card.cap, 0);
  } finally {
    await w.api.close();
  }
});

test("the seller name is optional, validated, unique across members and kept on the profile", async () => {
  const w = await world();
  try {
    const add = (body) => w.call("POST", "/api/members", { name: "M", ...CAR, ...body });
    assert.equal((await add({})).body.member.sellerName, null, "blank is not given");
    assert.equal((await add({ sellerName: "   " })).body.member.sellerName, null);
    for (const bad of [42, "x".repeat(65), "listing:12345", "tab\there"]) {
      const r = await add({ sellerName: bad });
      assert.equal(r.status, 400, `${JSON.stringify(bad)}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "Your marketplace seller name must be the name your listings show, such as your eBay user name, in 64 characters or fewer.");
    }
    const ann = await add({ name: "Ann", sellerName: "  ann_resells " });
    assert.equal(ann.status, 201);
    assert.equal(ann.body.member.sellerName, "ann_resells");
    const twin = await add({ name: "Ann2", sellerName: "ANN_RESELLS" });
    assert.equal(twin.status, 409);
    assert.equal(twin.body.error, "Another member already gave this seller name. Each member's listings are matched by their own seller name, so check the spelling.");
    const bob = (await add({ name: "Bob" })).body.member;
    assert.equal((await w.call("PATCH", `/api/members/${bob.id}`, { sellerName: "ann_resells" })).status, 409);
    // Ann can save her own name again, and clear it.
    assert.equal((await w.call("PATCH", `/api/members/${ann.body.member.id}`, { sellerName: "ann_resells" })).status, 200);
    const cleared = await w.call("PATCH", `/api/members/${ann.body.member.id}`, { sellerName: "" });
    assert.equal(cleared.body.member.sellerName, null);
    // A change that leaves out sellerName keeps it.
    await w.call("PATCH", `/api/members/${bob.id}`, { sellerName: "bob_sells" });
    const kept = await w.call("PATCH", `/api/members/${bob.id}`, { locality: "Camden" });
    assert.equal(kept.body.member.sellerName, "bob_sells");
    assert.equal(kept.body.bounties, undefined, "no seller name change, so nothing is worked out again");
  } finally {
    await w.api.close();
  }
});

test("an older members table gains seller_name in place, blank for existing members", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE members (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, locality TEXT, paid_tier TEXT, paid_until TEXT,
 alerts_opt_in INTEGER NOT NULL DEFAULT 0, alert_localities TEXT NOT NULL DEFAULT '[]', rules TEXT NOT NULL DEFAULT '{}',
 created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, transport TEXT, carry_kg REAL, storage_units INTEGER)`);
  db.prepare("INSERT INTO members (name) VALUES (?)").run("Old member");
  schema(db);
  const columns = db.prepare("PRAGMA table_info(members)").all().map((c) => c.name);
  assert.ok(columns.includes("seller_name"), columns.join(", "));
  assert.equal(db.prepare("SELECT seller_name FROM members WHERE name = 'Old member'").get().seller_name, null);
});

test("a claim made before the cash was asked is asked for it through Check my figures, never told its figures failed", async () => {
  const w = await world();
  try {
    w.shelf(10);
    const b = await w.bounty();
    w.step(5);
    const cat = await w.join("Cat");
    const dan = await w.join("Dan");
    const c = await w.claim(cat, b.id, 1);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const claimId = c.body.claim.id;
    // As a claim made before round 5 stored it: no cashAvailable in its terms.
    w.db.prepare("UPDATE claims SET terms = json_remove(terms, '$.cashAvailable') WHERE id = ?").run(claimId);
    w.step(10);
    assert.equal((await w.call("POST", `/api/bounties/${b.id}/recheck`, {})).status, 200);
    let card = await w.card(b.id, cat.id);
    assert.equal(card.trip.state, "confirm-cash");
    assert.equal(card.trip.go, false);
    assert.equal(card.trip.label, "Confirm the cash you can spend");
    assert.equal(card.trip.reason, "cash-unknown");
    assert.match(card.trip.headline, /^Don't make the trip yet: confirm the cash you can spend on this trip\./);
    assert.match(card.trip.headline, /it was made before the cash was asked for/);
    assert.match(card.trip.headline, /enter the cash under your claim and choose Save cash and check my figures/);
    assert.match(card.trip.headline, /Every other check on your figures for 1 unit passed/);
    assert.doesNotMatch(card.trip.headline, /now fail|no longer pass|withdrawn|expired|shelf/);
    const stops = card.viewer.notices.filter((n) => n.kind === "stop");
    assert.equal(stops.length, 1);
    assert.equal(stops[0].reason, "cash-unknown");
    assert.equal(stops[0].message, card.trip.headline);
    const mine = card.claims.find((x) => x.id === claimId);
    assert.equal(mine.needsCash, true);
    assert.equal(mine.cashAvailable, null);
    // A second re-check on the same evidence sends no second notice.
    w.step(5);
    await w.call("POST", `/api/bounties/${b.id}/recheck`, {});
    assert.equal((await w.card(b.id, cat.id)).viewer.notices.filter((n) => n.kind === "stop").length, 1);

    // Only Cat, only a number.
    assert.equal((await w.call("POST", `/api/claims/${claimId}/cash`, { memberId: cat.id })).status, 400);
    assert.equal((await w.call("POST", `/api/claims/${claimId}/cash`, { memberId: cat.id, cashAvailable: "" })).status, 400);
    assert.equal((await w.call("POST", `/api/claims/${claimId}/cash`, { memberId: dan.id, cashAvailable: 100000 })).status, 403);

    // Too little cash is a real failure, and is said so.
    w.step(5);
    const low = await w.call("POST", `/api/claims/${claimId}/cash`, { memberId: cat.id, cashAvailable: 500 });
    assert.equal(low.status, 200, JSON.stringify(low.body));
    assert.match(low.body.message, /^Saved: £5\.00 you can spend on this trip\. Your figures for 1 unit were checked again on the latest evidence and now fail: The trip needs £\d+\.\d\d in cash before any payout, more than the £5\.00 you can spend/);
    card = await w.card(b.id, cat.id);
    assert.equal(card.trip.state, "blocked");
    assert.equal(card.trip.label, "Your figures no longer pass");

    // Enough cash: every check passes and the trip reopens for her.
    w.step(5);
    const ok = await w.call("POST", `/api/claims/${claimId}/cash`, { memberId: cat.id, cashAvailable: 100000 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.message, "Saved: £1000.00 you can spend on this trip. Your figures for 1 unit were checked again on the latest evidence and every check passes.");
    card = await w.card(b.id, cat.id);
    assert.equal(card.trip.go, true, JSON.stringify(card.trip));
    const after = card.claims.find((x) => x.id === claimId);
    assert.equal(after.needsCash, false);
    assert.equal(after.cashAvailable, 100000);
    assert.equal((await w.card(b.id)).claims.find((x) => x.id === claimId).cashAvailable, null, "the operator sees whether cash is stored, not the figure");
    // A released claim cannot take cash.
    assert.equal((await w.call("POST", `/api/claims/${claimId}/release`, { memberId: cat.id })).status, 200);
    assert.equal((await w.call("POST", `/api/claims/${claimId}/cash`, { memberId: cat.id, cashAvailable: 100000 })).status, 409);
  } finally {
    await w.api.close();
  }
});

// ---------------------------------------------------------------------------
// Round 5b, second verification: a seller name fails open unless the
// operator confirms it, the listing has a known listing time after the
// purchase and the name was not already selling the item; one normalised key
// for uniqueness; listings matched per sighting; and the mutants that
// survived (M6 and M26) caught through the routes.

test("only the operator confirms a seller name, it must be the name the member gives now, and any change clears it", async () => {
  const w = await world();
  try {
    const ann = await w.join("Ann", { sellerName: "ann_resells" });
    const bob = await w.join("Bob");
    assert.equal(ann.sellerConfirmedAt, null, "a new name starts unconfirmed");
    const path = `/api/members/${ann.id}/seller-confirmation`;
    for (const viewer of [undefined, "public", ann.id, String(ann.id)]) {
      const r = await w.call("POST", path, { viewer, sellerName: "ann_resells" });
      assert.equal(r.status, 403, `viewer ${viewer}: ${JSON.stringify(r.body)}`);
    }
    assert.equal((await w.call("POST", path, { viewer: "operator" })).status, 400, "the name checked is required");
    const other = await w.confirm(ann, "bigshop_uk");
    assert.equal(other.status, 409);
    assert.match(other.body.error, /^The member's seller name is now "ann_resells", not the name you checked/);
    assert.equal((await w.confirm(bob, "bob")).status, 409, "Bob gave no seller name to confirm");
    // The same name in another case or with fullwidth letters is the same key.
    const ok = await w.confirm(ann, "ＡＮＮ_Resells");
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(Date.parse(ok.body.member.sellerConfirmedAt) > 0);
    assert.match(ok.body.message, /^Confirmed: "ann_resells" is Ann's seller name\./);
    // Saving the same name again keeps the confirmation; another name clears it.
    let saved = await w.call("PATCH", `/api/members/${ann.id}`, { sellerName: "Ann_Resells" });
    assert.ok(saved.body.member.sellerConfirmedAt, "same key, still confirmed");
    saved = await w.call("PATCH", `/api/members/${ann.id}`, { sellerName: "ann_sells_more" });
    assert.equal(saved.body.member.sellerConfirmedAt, null);
    assert.equal((await w.confirm(ann, "ann_sells_more")).status, 200);
    saved = await w.call("PATCH", `/api/members/${ann.id}`, { sellerName: "" });
    assert.equal(saved.body.member.sellerConfirmedAt, null);
    assert.equal(w.db.prepare("SELECT seller_confirmed_at FROM members WHERE id = ?").get(ann.id).seller_confirmed_at, null);
    // Withdrawing a confirmation clears it too.
    await w.call("PATCH", `/api/members/${ann.id}`, { sellerName: "ann_resells" });
    assert.equal((await w.confirm(ann, "ann_resells")).status, 200);
    const off = await w.confirm(ann, "ann_resells", { withdraw: true });
    assert.equal(off.status, 200);
    assert.equal(off.body.member.sellerConfirmedAt, null);
  } finally {
    await w.api.close();
  }
});

test("S1: a competitor's seller name never opens the cap: unconfirmed, no listing time, or already selling the item", async () => {
  // Ann holds 3 unlisted units from bounty 1; an independent seller lists 1.
  const { w, ann, bob, two } = await annBoughtAndListed({ annSeller: null, listed: [{ id: "big-1", seller: "bigshop_uk" }] });
  try {
    let card = await w.card(two.id);
    assert.equal(used(card).competingListings, 1);
    assert.equal(card.cap, 0, "4 - 1 listing - 3 units held");
    // Ann gives the competitor's name: nothing changes until the operator confirms it.
    assert.equal((await w.call("PATCH", `/api/members/${ann.id}`, { sellerName: "BigShop_UK" })).status, 200);
    card = await w.card(two.id);
    assert.equal(used(card).ownListings, 0);
    assert.equal(card.cap, 0);
    assert.equal((await w.claim(bob, two.id, 1)).status, 409);
    // Even confirmed by mistake, a listing with no listing time counts in full.
    assert.equal((await w.confirm(ann, "BigShop_UK")).status, 200);
    card = await w.card(two.id);
    assert.equal(used(card).ownListings, 0, "no listing time: counted in full");
    assert.equal(card.cap, 0);
    assert.equal((await w.claim(bob, two.id, 1)).status, 409);
  } finally {
    await w.api.close();
  }
});

test("a seller name already seen selling the item before the member bought it is ignored for the item, and the card says why", async () => {
  // "seller3" sold the item in the sales evidence weeks before Ann bought.
  const { w, ann, bob, two } = await annBoughtAndListed({ annSeller: "seller3", listed: (w) => w.own("seller3", 3) });
  try {
    const card = await w.card(two.id);
    assert.equal(used(card).competingListings, 3);
    assert.equal(used(card).ownListings, 0, "the name was selling before her purchase");
    assert.equal(card.cap, 0);
    assert.ok(card.capBasis.notes.some((n) => /already selling this item before/.test(n)), JSON.stringify(card.capBasis.notes));
    assert.equal(card.sellerNames[0].prior, true);
    assert.match(card.sellerNames[0].status, /already selling the item before they bought it/);
    assert.match((await w.card(two.id, ann.id)).viewer.sellerNote, /Your seller name "seller3" was already selling this item before you bought it through a bounty/);
    assert.equal((await w.claim(bob, two.id, 1)).status, 409);
  } finally {
    await w.api.close();
  }
});

test("M26: listings with no listing time, or seen before the purchase, count in full", async () => {
  // No listing time: Ann's confirmed name does not make them hers.
  const a = await annBoughtAndListed({ listed: [1, 2, 3].map((i) => ({ id: "x" + i, seller: "ann_resells" })) });
  try {
    const card = await a.w.card(a.two.id);
    assert.equal(used(card).competingListings, 3);
    assert.equal(used(card).ownListings, 0);
    assert.equal(card.cap, 0);
  } finally {
    await a.w.api.close();
  }
  // Seen (and listed) before she bought: other stock, whatever she holds now.
  const w = await world();
  try {
    w.shelf(10);
    const one = await w.bounty();
    const ann = await w.join("Ann", { sellerName: "ann_resells" });
    assert.equal((await w.confirm(ann, "ann_resells")).status, 200);
    w.listings(w.own("ann_resells", 2));
    w.step(5);
    // The 2 listings leave room for 2 on bounty 1.
    const c = await w.claim(ann, one.id, 2);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    w.step(5);
    assert.equal((await w.call("POST", `/api/claims/${c.body.claim.id}/complete`, { memberId: ann.id })).status, 200);
    assert.equal((await w.call("POST", `/api/bounties/${one.id}/withdraw`, {})).status, 200);
    w.step(5);
    w.shelf(7);
    const two = await w.bounty();
    const card = await w.card(two.id);
    assert.equal(used(card).competingListings, 2);
    assert.equal(used(card).earlierUnits, 2);
    assert.equal(used(card).ownListings, 0, "seen before the purchase");
    assert.equal(card.cap, 0, "4 - 2 - 2, never 4 - 0 - 2 = 2");
  } finally {
    await w.api.close();
  }
});

test("M6: a listing first seen after every unit was recorded as sold is other stock and counts in full", async () => {
  const { w, ann, annClaim, two } = await annBoughtAndListed({ listed: [] });
  try {
    w.step(30);
    const sold = await w.call("POST", `/api/claims/${annClaim.id}/resale`, { memberId: ann.id, sold: 3 });
    assert.equal(sold.status, 200, JSON.stringify(sold.body));
    w.step(30);
    // New listings of other stock under her name, first seen after the sale.
    w.listings(w.own("ann_resells", 3));
    assert.equal((await w.call("POST", `/api/bounties/${two.id}/recheck`, {})).status, 200);
    const card = await w.card(two.id);
    assert.equal(used(card).earlierUnits, 0);
    assert.equal(used(card).competingListings, 3);
    assert.equal(used(card).ownListings, 0, "she held none when they were seen");
    assert.equal(card.cap, 1, "4 - 3 listings, never 4 - 0 = 4");
  } finally {
    await w.api.close();
  }
});

test("S12b: listings are matched to the units held at each sighting, each listing once", async () => {
  // Ann holds 3; a lookup sees 1 of her listings.
  const { w, ann, annClaim, two } = await annBoughtAndListed({ listed: (w) => w.own("ann_resells", 1) });
  try {
    assert.equal(used(await w.card(two.id)).ownListings, 1);
    // She records 2 sold, so she holds 1.
    w.step(30);
    assert.equal((await w.call("POST", `/api/claims/${annClaim.id}/resale`, { memberId: ann.id, sold: 2 })).status, 200);
    // A later lookup no longer sees that listing (it is still current for the
    // competition count) but sees 3 new ones by her: her last unit and 2 of
    // other stock.
    w.step(60);
    w.listings(w.own("ann_resells", 3, 10));
    assert.equal((await w.call("POST", `/api/bounties/${two.id}/recheck`, {})).status, 200);
    const card = await w.card(two.id);
    assert.equal(used(card).competingListings, 4);
    assert.equal(used(card).earlierUnits, 1);
    // 1 at the first sighting (3 held) and 1 at the second (1 held), never 3.
    assert.equal(used(card).ownListings, 2);
    assert.equal(card.cap, 1, "4 - (4 - 2) - 1, never 4 - (4 - 3) - 1 = 2");
  } finally {
    await w.api.close();
  }
});

test("seller names are unique by one normalised key: fullwidth, accented-case and spaced copies are refused", async () => {
  const w = await world();
  try {
    const add = (name, sellerName) => w.call("POST", "/api/members", { name, ...CAR, sellerName });
    for (const [first, copy] of [
      ["ann_resells", "ＡＮＮ_resells"],
      ["ann_resells", "ａｎｎ_RESELLS"],
      ["Änn_shop", "änn_shop"],
      ["ann resells", "Ann   Resells"],
    ]) {
      const w2 = await world();
      try {
        const a = await w2.call("POST", "/api/members", { name: "First", ...CAR, sellerName: first });
        assert.equal(a.status, 201, JSON.stringify(a.body));
        const b = await w2.call("POST", "/api/members", { name: "Copy", ...CAR, sellerName: copy });
        assert.equal(b.status, 409, `${first} / ${copy}: ${JSON.stringify(b.body)}`);
        assert.equal(b.body.error, "Another member already gave this seller name. Each member's listings are matched by their own seller name, so check the spelling.");
        const c = (await w2.call("POST", "/api/members", { name: "Other", ...CAR })).body.member;
        assert.equal((await w2.call("PATCH", `/api/members/${c.id}`, { sellerName: copy })).status, 409);
      } finally {
        await w2.api.close();
      }
    }
    // The key is stored with a unique index, so a direct write cannot share it either.
    assert.equal((await add("Ann", "ann_resells")).status, 201);
    assert.throws(
      () => w.db.prepare("INSERT INTO members(name, seller_name, seller_key) VALUES ('Sneak', 'x', 'ann_resells')").run(),
      /UNIQUE constraint failed: members\.seller_key/,
    );
    assert.equal(w.db.prepare("SELECT seller_key FROM members WHERE name = 'Ann'").get().seller_key, "ann_resells");
  } finally {
    await w.api.close();
  }
});

test("an older members table gains the seller key and confirmation; a later copy of a name gets no key and no confirmation", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE members (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, locality TEXT, paid_tier TEXT, paid_until TEXT,
 alerts_opt_in INTEGER NOT NULL DEFAULT 0, alert_localities TEXT NOT NULL DEFAULT '[]', rules TEXT NOT NULL DEFAULT '{}',
 created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, transport TEXT, carry_kg REAL, storage_units INTEGER, seller_name TEXT)`);
  db.prepare("INSERT INTO members (name, seller_name) VALUES (?, ?)").run("Ann", "ann resells");
  db.prepare("INSERT INTO members (name, seller_name) VALUES (?, ?)").run("Cat", "ＡＮＮ  Resells");
  db.prepare("INSERT INTO members (name, seller_name) VALUES (?, ?)").run("Dan", "dan_sells");
  schema(db);
  const columns = db.prepare("PRAGMA table_info(members)").all().map((c) => c.name);
  assert.ok(columns.includes("seller_key") && columns.includes("seller_confirmed_at"), columns.join(", "));
  const keys = Object.fromEntries(db.prepare("SELECT name, seller_key, seller_confirmed_at FROM members").all().map((r) => [r.name, [r.seller_key, r.seller_confirmed_at]]));
  assert.deepEqual(keys, { Ann: ["ann resells", null], Cat: [null, null], Dan: ["dan_sells", null] });
});

test("a listing is matched only to a unit bought before it was listed: one listed before a later purchase stays other stock", async () => {
  const w = await world();
  try {
    w.shelf(10);
    const one = await w.bounty();
    w.step(5);
    const ann = await w.join("Ann", { sellerName: "ann_resells" });
    assert.equal((await w.confirm(ann, "ann_resells")).status, 200);
    // T0: Ann buys 1 unit.
    const first = await w.claim(ann, one.id, 1);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    w.step(5);
    assert.equal((await w.call("POST", `/api/claims/${first.body.claim.id}/complete`, { memberId: ann.id })).status, 200);
    // T1: she lists something, then records that first unit as sold.
    w.step(30);
    const listedAt = w.clock.now;
    w.step(30);
    assert.equal((await w.call("POST", `/api/claims/${first.body.claim.id}/resale`, { memberId: ann.id, sold: 1 })).status, 200);
    // T2: she buys 2 more.
    w.step(30);
    const second = await w.claim(ann, one.id, 2);
    assert.equal(second.status, 201, JSON.stringify(second.body));
    w.step(5);
    assert.equal((await w.call("POST", `/api/claims/${second.body.claim.id}/complete`, { memberId: ann.id })).status, 200);
    assert.equal((await w.call("POST", `/api/bounties/${one.id}/withdraw`, {})).status, 200);
    // T3: the listing from T1 is still up.
    w.step(30);
    w.listings([{ id: "early-1", seller: "ann_resells", listed: listedAt }]);
    w.shelf(7);
    const two = await w.bounty();
    const card = await w.card(two.id);
    assert.equal(used(card).competingListings, 1);
    assert.equal(used(card).earlierUnits, 2);
    assert.equal(used(card).ownListings, 0, "listed before the 2 units she holds were bought");
    assert.equal(card.cap, 1, "4 - 1 - 2, never 4 - 0 - 2 = 2");
  } finally {
    await w.api.close();
  }
});
