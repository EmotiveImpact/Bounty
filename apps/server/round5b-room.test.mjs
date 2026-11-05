// Round 5b, second verification: a member's room at home is their room in
// all, less the units they bought through bounties and have not recorded as
// sold or returned, and less the units in their other live claims, so two
// claims can never each count the same free room. Their live claims are
// checked again at once when their transport, carry limit or room changes,
// and when another of their claims is marked as bought or released. A claim
// made before round 5 (no profile and no cash) is never stuck: saving the
// cash and saving the profile each check it again, in either order, and its
// label names only what is still missing.
//
// Also the survivors M27 (alert dispatch ignores units held) and M29 (claim
// re-checks ignore units held), through the routes.
//
// Two items, so that units bought of one never count against the demand for
// the other: each has 26 confirmed sales over about 80 days (about 4 units
// within the 2-week sell window) and 10 units on the shelf.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.mjs";
import { serve } from "./test-support.mjs";
import { londonDate } from "./http.mjs";
import { KIND, LICENCE } from "./contract.mjs";
import { storeLookup, upsertObservations, upsertResearch } from "./evidence.mjs";
import { routes as bountyRoutes } from "./routes-bounties.mjs";
import { recordCheck } from "./audit.mjs";

const DAY = 86400000;
const MIN = 60000;
const ukDay = (days) => londonDate(new Date(Date.now() - days * DAY));
const ITEMS = {
  speaker: { gtin: "5012345678115", offer: 700002, prefix: "s", title: "Mini Bluetooth speaker black", model: "BTS-20", osm: "node/222" },
  torch: { gtin: "5012345678122", offer: 700003, prefix: "t", title: "LED head torch", model: "HT-3", osm: "node/223" },
};
const sales = (item) =>
  Array.from({ length: 26 }, (_, i) => {
    const sold = 1 + Math.floor((i * 80) / 26);
    return { source_id: item.prefix + i, seller: item.prefix + "seller" + i, observed: ukDay(sold), listed: ukDay(sold + 4) };
  });
const attrs = (item) => ({ title: item.title, barcode: item.gtin, size: "one size", pack: "1", model: item.model, condition: "new" });
const CAR = (storageUnits) => ({ transport: "Car", carryKg: 5, storageUnits });
const TRIP = { journeyCost: 0, journeyMinutes: 15, cashAvailable: 100000 };

async function world() {
  const clock = { now: new Date().toISOString() };
  const step = (minutes) => (clock.now = new Date(Date.parse(clock.now) + minutes * MIN).toISOString());
  const db = openDb(":memory:");
  for (const item of Object.values(ITEMS)) {
    upsertObservations(
      db,
      [{ id: item.offer, title: item.title, store: "Home Bargains", place: "NW1 8QP", city: "London", osm_id: item.osm, price: 1200, barcode: item.gtin, day: ukDay(0) }],
      { now: clock.now },
    );
    upsertResearch(
      db,
      "sales",
      sales(item).map((s) => ({ ...attrs(item), ...s, kind: KIND.SOLD, price: 2800, retailer: "eBay UK", licence: LICENCE.SELF })),
      { now: clock.now },
    );
    storeLookup(db, "ebay", item.gtin, [], { now: clock.now });
    recordCheck(
      db,
      { barcode: item.gtin, retailer: "Home Bargains", locality: "Camden", branch: item.osm, checkedAt: clock.now, method: "in_store", inStock: true, unitsSeen: 10, pricePence: 1200 },
      { now: clock.now },
    );
  }
  const api = await serve(db, [{ routes: (x) => bountyRoutes(x, { clock: () => clock.now, photoDir: "/nonexistent-photos" }) }]);
  const call = (m, p, body) => api.call(m, p, body, { Origin: api.base });
  const bounty = async (key) => {
    const item = ITEMS[key];
    const r = await call("POST", "/api/bounties", {
      title: item.title,
      locality: "Camden",
      retailer: "Home Bargains",
      salesPerWeek: 10,
      sellWindowWeeks: 2,
      expiresAt: new Date(Date.parse(clock.now) + 3 * DAY).toISOString(),
      sponsored: false,
      estimate: {
        offer: { provider: "openprices", sourceId: String(item.offer) },
        sales: sales(item).map((s) => ({ provider: "sales", sourceId: s.source_id })),
        units: 3,
        weightKg: 0.4,
        costs: { postage: 300, packaging: 30, handlingMinutes: 5, journeyCost: 0, journeyMinutes: 15 },
        hourlyFloor: 800,
        locality: "Camden",
        offerAttributes: { pack: "1", model: item.model, condition: "new", size: "one size" },
        category: "general",
        categoryReason: "Not food or a regulated item",
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.bounty;
  };
  const join = async (name, profile) => {
    const r = await call("POST", "/api/members", {
      name,
      alertsOptIn: true,
      alertLocalities: ["Camden"],
      paidTier: "diamond",
      paidUntil: new Date(Date.now() + 200 * DAY).toISOString().slice(0, 10),
      ...profile,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.member;
  };
  const claim = (who, bountyId, units, over = {}) => call("POST", `/api/bounties/${bountyId}/claims`, { memberId: who.id, units, ...TRIP, ...over });
  const check = (who, bountyId, units) => call("POST", `/api/bounties/${bountyId}/claim-check`, { memberId: who.id, units, ...TRIP });
  const card = async (bountyId, viewer = "operator") => (await call("GET", `/api/bounties/${bountyId}?viewer=${viewer}`)).body.bounty;
  const stops = async (bountyId, who) => (await card(bountyId, who.id)).viewer.notices.filter((n) => n.kind === "stop");
  const storage = (c) => c.fit.checks.find((x) => x.id === "storage-space");
  return { db, api, call, clock, step, bounty, join, claim, check, card, stops, storage };
}

test("storage counts the units in the member's other live claims, so two claims never share the same room", async () => {
  const w = await world();
  try {
    const a = await w.bounty("speaker");
    const b = await w.bounty("torch");
    const gil = await w.join("Gil", CAR(3));
    const first = await w.claim(gil, a.id, 3);
    assert.equal(first.status, 201, JSON.stringify(first.body));

    // His room for 3 is taken by the 3 units claimed on the speaker bounty.
    const checked = await w.check(gil, b.id, 3);
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(w.storage(checked.body.check).ok, false);
    assert.equal(
      w.storage(checked.body.check).detail,
      "You have no room at home for more units now (room for 3 in all, less 3 units in your other live claims)",
    );
    const refused = await w.claim(gil, b.id, 1);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /You have no room at home for more units now \(room for 3 in all, less 3 units in your other live claims\)/);
    const torch = await w.card(b.id, gil.id);
    assert.equal(torch.trip.state, "does-not-fit");
    assert.equal(torch.viewer.canClaim, false);
    // The summary shows the room now, as the card does.
    const view = (await w.call("GET", "/api/members")).body.members.find((m) => m.id === gil.id);
    assert.equal(view.profile.storageUnits, 3);
    assert.equal(view.profile.claimedUnits, 3);
    assert.equal(view.profile.roomNow, 0);
    assert.match(view.profile.note, /room at home for 0 more units now, after 3 units in your live claims\./);

    // Releasing the speaker claim frees the room for the torch.
    assert.equal((await w.call("POST", `/api/claims/${first.body.claim.id}/release`, { memberId: gil.id })).status, 200);
    assert.equal(w.storage((await w.check(gil, b.id, 3)).body.check).ok, true);
    assert.equal((await w.claim(gil, b.id, 3)).status, 201);
  } finally {
    await w.api.close();
  }
});

test("M27: alerts are not sent to a member whose room at home is taken by units they hold", async () => {
  const w = await world();
  try {
    const a = await w.bounty("speaker");
    const hal = await w.join("Hal", CAR(3));
    const ivy = await w.join("Ivy", CAR(10));
    const c = await w.claim(hal, a.id, 3);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal((await w.call("POST", `/api/claims/${c.body.claim.id}/complete`, { memberId: hal.id })).status, 200);
    w.step(5);
    const b = await w.bounty("torch");
    const sent = await w.call("POST", `/api/bounties/${b.id}/alerts`, {});
    assert.ok([200, 201].includes(sent.status), JSON.stringify(sent.body));
    assert.deepEqual(sent.body.sent.map((s) => s.name), ["Ivy"]);
    const out = sent.body.notAlerted.find((n) => n.memberId === hal.id);
    assert.ok(out, JSON.stringify(sent.body.notAlerted));
    assert.match(out.reason, /You have no room at home for more units now \(room for 3 in all, less 3 units bought through bounties/);
    assert.equal(ivy.id > 0, true);
  } finally {
    await w.api.close();
  }
});

test("M29: a member's live claims are checked again when their room changes and when another claim is bought, counting units held", async () => {
  const w = await world();
  try {
    const a = await w.bounty("speaker");
    const b = await w.bounty("torch");
    const jo = await w.join("Jo", CAR(4));
    const speaker = await w.claim(jo, a.id, 3);
    assert.equal(speaker.status, 201, JSON.stringify(speaker.body));
    const torch = await w.claim(jo, b.id, 1);
    assert.equal(torch.status, 201, JSON.stringify(torch.body));
    assert.equal((await w.card(b.id, jo.id)).trip.go, true);

    // Jo's room shrinks to 3: both claims are checked again at once, and the
    // later one no longer fits beside the earlier one.
    w.step(5);
    const smaller = await w.call("PATCH", `/api/members/${jo.id}`, { storageUnits: 3 });
    assert.equal(smaller.status, 200, JSON.stringify(smaller.body));
    assert.deepEqual([...smaller.body.bounties.rechecked].sort(), [a.id, b.id].sort());
    assert.equal(smaller.body.message, "Saved. Your 2 live claims were checked again against your profile now.");
    assert.equal((await w.card(a.id, jo.id)).trip.go, true, "the earlier claim still fits");
    let card = await w.card(b.id, jo.id);
    assert.equal(card.trip.go, false);
    assert.equal(card.trip.label, "Your figures no longer pass");
    assert.match(card.trip.headline, /You have no room at home for more units now \(room for 3 in all, less 3 units in your other live claims\)/);
    assert.equal((await w.stops(b.id, jo)).length, 1, "told at once, not at the next re-check");

    // She buys only 2 of the 3 speakers: marking it bought checks the torch
    // claim again at once, and 1 unit of room is free for it.
    w.step(5);
    const bought = await w.call("POST", `/api/claims/${speaker.body.claim.id}/complete`, { memberId: jo.id, units: 2 });
    assert.equal(bought.status, 200, JSON.stringify(bought.body));
    assert.ok(bought.body.bounties.rechecked.includes(b.id), JSON.stringify(bought.body.bounties));
    card = await w.card(b.id, jo.id);
    assert.equal(card.trip.go, true, card.trip.headline);
    assert.ok(card.viewer.notices.some((n) => n.kind === "reopen"), JSON.stringify(card.viewer.notices));

    // The 2 speakers at home count in every later re-check: with room for 2
    // in all, the torch claim fails again (M29: never 2 - 0 = 2).
    w.step(5);
    assert.equal((await w.call("PATCH", `/api/members/${jo.id}`, { storageUnits: 2 })).status, 200);
    card = await w.card(b.id, jo.id);
    assert.equal(card.trip.go, false);
    assert.match(card.trip.headline, /You have no room at home for more units now \(room for 2 in all, less 2 units bought through bounties and not yet recorded as sold or returned\)/);
    assert.equal((await w.stops(b.id, jo)).length, 2);

    // Recording 1 as sold frees a unit of room, and the torch claim is
    // checked again at once.
    w.step(5);
    const sold = await w.call("POST", `/api/claims/${speaker.body.claim.id}/resale`, { memberId: jo.id, sold: 1 });
    assert.equal(sold.status, 200, JSON.stringify(sold.body));
    assert.ok(sold.body.bounties.rechecked.includes(b.id), JSON.stringify(sold.body.bounties));
    assert.equal((await w.card(b.id, jo.id)).trip.go, true);
  } finally {
    await w.api.close();
  }
});

test("a claim made before round 5 (no profile, no cash) is never stuck: saving the cash or the profile checks it again, in either order", async () => {
  const w = await world();
  try {
    const a = await w.bounty("speaker");
    const fay = await w.join("Fay", CAR(10));
    const eli = await w.join("Eli", CAR(10));
    const made = { fay: await w.claim(fay, a.id, 1), eli: await w.claim(eli, a.id, 1) };
    for (const r of Object.values(made)) assert.equal(r.status, 201, JSON.stringify(r.body));
    // As claims and members from before round 5 were stored: no cash with the
    // claim and no transport, carry limit or room on the profile.
    for (const [who, r] of [[fay, made.fay], [eli, made.eli]]) {
      w.db.prepare("UPDATE claims SET terms = json_remove(terms, '$.cashAvailable') WHERE id = ?").run(r.body.claim.id);
      w.db.prepare("UPDATE members SET transport = NULL, carry_kg = NULL, storage_units = NULL WHERE id = ?").run(who.id);
    }
    w.step(5);
    assert.equal((await w.call("POST", `/api/bounties/${a.id}/recheck`, {})).status, 200);
    let card = await w.card(a.id, fay.id);
    assert.equal(card.trip.state, "confirm-profile");
    assert.equal(card.trip.label, "Confirm your transport, carrying limit, storage and cash");
    assert.match(card.trip.headline, /^Don't make the trip yet: confirm your transport, carrying limit and storage at home in your member profile and the cash you can spend on this trip\./);
    assert.match(card.trip.headline, /enter the cash under your claim and choose Save cash and check my figures, and save the rest in your member profile/);
    assert.match(card.viewer.fit.cash, /^Your claim stores no cash you can spend on this trip yet/);

    // Fay gives the cash first: the label stops asking for cash.
    w.step(5);
    const cash = await w.call("POST", `/api/claims/${made.fay.body.claim.id}/cash`, { memberId: fay.id, cashAvailable: 100000 });
    assert.equal(cash.status, 200, JSON.stringify(cash.body));
    assert.match(cash.body.message, /^Saved: £1000\.00 you can spend on this trip\. Your figures were checked again\. Don't make the trip yet: confirm your transport, carrying limit and storage at home in your member profile\./);
    assert.match(cash.body.message, /save them in your member profile and your claim is checked again at once/);
    card = await w.card(a.id, fay.id);
    assert.equal(card.trip.state, "confirm-profile");
    assert.equal(card.trip.label, "Confirm your transport, carrying limit and storage");
    assert.doesNotMatch(card.trip.label + card.trip.headline, /cash/);
    assert.match(card.viewer.fit.cash, /^The cash you can spend on this trip is the £1000\.00 stored with your claim/);
    assert.equal(card.claims.find((c) => c.id === made.fay.body.claim.id).cashAvailable, 100000, "shown under her claim to correct");

    // She saves transport and carry limit: checked again at once, and only
    // storage is still asked for.
    w.step(5);
    const part = await w.call("PATCH", `/api/members/${fay.id}`, { transport: "Car", carryKg: 5 });
    assert.equal(part.status, 200, JSON.stringify(part.body));
    assert.ok(part.body.bounties.rechecked.includes(a.id));
    assert.equal(part.body.message, "Saved. Your live claim was checked again against your profile now.");
    card = await w.card(a.id, fay.id);
    assert.equal(card.trip.label, "Confirm your storage");
    assert.match(card.trip.headline, /^Don't make the trip yet: confirm your storage at home in your member profile\./);
    // Then her room: the trip reopens with no operator re-check.
    w.step(5);
    assert.equal((await w.call("PATCH", `/api/members/${fay.id}`, { storageUnits: 10 })).status, 200);
    card = await w.card(a.id, fay.id);
    assert.equal(card.trip.go, true, card.trip.headline);

    // Eli saves his profile first: only the cash is asked for, then it reopens.
    w.step(5);
    assert.equal((await w.call("PATCH", `/api/members/${eli.id}`, CAR(10))).status, 200);
    card = await w.card(a.id, eli.id);
    assert.equal(card.trip.state, "confirm-cash");
    assert.equal(card.trip.label, "Confirm the cash you can spend");
    w.step(5);
    assert.equal((await w.call("POST", `/api/claims/${made.eli.body.claim.id}/cash`, { memberId: eli.id, cashAvailable: 100000 })).status, 200);
    assert.equal((await w.card(a.id, eli.id)).trip.go, true);
  } finally {
    await w.api.close();
  }
});

test("a member's profile summary gives the room in all and the room now after units held", async () => {
  const w = await world();
  try {
    const a = await w.bounty("speaker");
    const eve = await w.join("Eve", CAR(5));
    let eveView = (await w.call("GET", "/api/members")).body.members.find((m) => m.id === eve.id);
    assert.equal(eveView.profile.roomNow, 5);
    assert.equal(eveView.profile.note, "Load limit 25 kg; room at home for 5 more units now. The cash you can spend is asked when you claim.");
    const c = await w.claim(eve, a.id, 3);
    assert.equal((await w.call("POST", `/api/claims/${c.body.claim.id}/complete`, { memberId: eve.id })).status, 200);
    eveView = (await w.call("GET", "/api/members")).body.members.find((m) => m.id === eve.id);
    assert.equal(eveView.profile.storageUnits, 5, "the total she gave");
    assert.equal(eveView.profile.heldUnits, 3);
    assert.equal(eveView.profile.roomNow, 2, "as the card says");
    assert.equal(
      eveView.profile.note,
      "Load limit 25 kg; room at home for 2 more units now, after 3 units bought through bounties and not yet recorded as sold or returned. The cash you can spend is asked when you claim.",
    );
    const b = await w.bounty("torch");
    const fit = (await w.card(b.id, eve.id)).viewer.fit;
    assert.equal(fit.checks.find((x) => x.id === "storage-space").detail, "3 units, more than the room you have at home for 2 more now (room for 5 in all, less 3 units bought through bounties and not yet recorded as sold or returned): at most 2 units fit your storage");
  } finally {
    await w.api.close();
  }
});

test("units held and units in other live claims both come off the room, in one plain line", async () => {
  const w = await world();
  try {
    const a = await w.bounty("speaker");
    const b = await w.bounty("torch");
    const kay = await w.join("Kay", CAR(5));
    const c = await w.claim(kay, a.id, 2);
    assert.equal((await w.call("POST", `/api/claims/${c.body.claim.id}/complete`, { memberId: kay.id })).status, 200);
    w.step(5);
    const a2 = await w.claim(kay, a.id, 1);
    assert.equal(a2.status, 201, JSON.stringify(a2.body));
    const checked = await w.check(kay, b.id, 3);
    assert.equal(
      w.storage(checked.body.check).detail,
      "3 units, more than the room you have at home for 2 more now (room for 5 in all, less 2 units bought through bounties and not yet recorded as sold or returned, and 1 unit in your other live claims): at most 2 units fit your storage",
    );
    assert.equal((await w.claim(kay, b.id, 2)).status, 201, "2 fit");
  } finally {
    await w.api.close();
  }
});
