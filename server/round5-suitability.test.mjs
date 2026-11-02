// Round 5, finding 4: carrying limits produced labels but never blocked an
// otherwise eligible trip. Three 0.9 kg units with a 0.1 kg carry limit on
// foot gave alert.eligible true, and the bounty took a claim for all three.
// A trip must now fit the person making it: one unit and every unit within
// their load limit (the Planner's rule), the cash it needs within the cash
// they can spend and the units within their storage. A blank is unknown,
// never zero, and fails with "Confirm ...".
//
// Research takes the operator's profile with each estimate; a bounty's own
// estimate leaves the profile to each member, whose stored transport,
// carrying limit and storage decide alerts, and whose cash for the trip is
// asked with each claim and claim-check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.mjs";
import { serve } from "./test-support.mjs";
import { londonDate } from "./http.mjs";
import { KIND, LICENCE } from "./contract.mjs";
import { storeLookup, upsertObservations, upsertResearch } from "./evidence.mjs";
import { evaluateAlert } from "./alerts.mjs";
import { CAR_BOOT_KG, HAND_CARRY_KG, loadLimit } from "./catalog.mjs";
import { PROFILE_NEEDED, schema as bountiesSchema } from "./bounties.mjs";
import { SUITABILITY_CHECKS, profileLoadLimit, readTripProfile, suitability } from "./suitability.mjs";
import * as researchRoutes from "./routes-research.mjs";
import * as bountyRoutes from "./routes-bounties.mjs";

const DAY = 86400000;
const GTIN = "5012345678115";
const ukDay = (days) => londonDate(new Date(Date.now() - days * DAY));
const ITEM = { title: "Mini Bluetooth speaker black", barcode: GTIN, size: "one size", pack: "1", model: "BTS-20", condition: "new" };
// 26 independent completed sales at £28 over 80 days.
const SALES = Array.from({ length: 26 }, (_, i) => {
  const sold = 1 + Math.floor((i * 80) / 26);
  return { source_id: "s" + i, seller: "seller" + i, observed: ukDay(sold), listed: ukDay(sold + 4) };
});

// The reviewer's case: an Open Prices offer with a Camden branch check that
// records the £12.50 shelf price, three 0.9 kg units, no journey cost.
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

const WALK_TENTH = { transport: "Walk", carryKg: 0.1, cashAvailable: 10000, storageUnits: 10 };
const CAR = { transport: "Car", carryKg: 5, cashAvailable: 10000, storageUnits: 10 };
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
  return { api, call, estimate, bounty, member, claim, claimCheck, close: () => api.close() };
}

const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));
const failing = (est) => est.alert.checks.filter((c) => !c.ok).map((c) => c.id);
const claims = (db) => db.prepare("SELECT COUNT(*) AS n FROM claims").get().n;

// ------------------------------------------------------------- the pure check

test("suitability checks one unit, every unit, cash and storage, and says how many would fit", () => {
  // The reviewer's case on foot: not even one unit fits.
  const walk = suitability({ units: 3, unitKg: 0.9, cashRequired: 4740, profile: WALK_TENTH });
  assert.deepEqual(walk.checks.map((c) => c.id), SUITABILITY_CHECKS);
  assert.equal(walk.ok, false);
  assert.equal(walk.known, true);
  const w = byId(walk.checks);
  assert.equal(w["one-unit-load"].ok, false);
  assert.equal(w["one-unit-load"].detail, "One unit weighs 0.9 kg, more than your 0.1 kg load limit on foot: it needs a car or van");
  assert.equal(w["total-load"].detail, "3 units weigh 2.7 kg in all, more than your 0.1 kg load limit on foot: not one unit fits it");
  assert.equal(w["cash-available"].ok, true);
  assert.equal(w["storage-space"].ok, true);
  assert.equal(walk.maxUnits.load, 0);
  assert.equal(walk.maxUnits.all, 0);

  // A batch over the limit: one unit fits, three do not.
  const batch = byId(suitability({ units: 3, unitKg: 0.9, cashRequired: 4740, profile: { ...WALK_TENTH, carryKg: 1 } }).checks);
  assert.equal(batch["one-unit-load"].ok, true);
  assert.equal(batch["total-load"].ok, false);
  assert.equal(batch["total-load"].detail, "3 units weigh 2.7 kg in all, more than your 1 kg load limit on foot: at most 1 unit fits your 1 kg load limit");
  assert.equal(batch["total-load"].maxUnits, 1);

  // The Planner's load limit: a car or van takes the boot, public transport
  // at most two shopping bags, on foot or by bicycle the carry limit.
  for (const [transport, carry] of [["Car", 0.1], ["Van", 40], ["Public transport", 20], ["Public transport", 4], ["Walk", 7], ["Bicycle", 3]])
    assert.equal(profileLoadLimit({ transport, carryKg: carry }), loadLimit(transport, carry), transport + " " + carry);
  assert.equal(loadLimit("Car", 0.1), CAR_BOOT_KG);
  assert.equal(loadLimit("Public transport", 20), HAND_CARRY_KG);
  const car = suitability({ units: 3, unitKg: 0.9, cashRequired: 4740, profile: { ...CAR, carryKg: 0.1 } });
  assert.equal(car.ok, true, car.reasons.join("; "));
  assert.equal(
    byId(car.checks)["one-unit-load"].detail,
    "One unit (0.9 kg) is within your 25 kg load limit by car (a vehicle takes 25 kg, more than your 0.1 kg carry limit)",
  );
  assert.equal(byId(car.checks)["total-load"].detail, "All 3 units (2.7 kg) are within your 25 kg load limit by car");
  const bus = byId(suitability({ units: 12, unitKg: 0.9, cashRequired: 0, profile: { ...CAR, transport: "Public transport", carryKg: 20, storageUnits: 20 } }).checks);
  assert.equal(bus["total-load"].ok, false);
  assert.match(bus["total-load"].detail, /^12 units weigh 10\.8 kg in all, more than your 10 kg load limit by public transport \(at most 10 kg, about two full shopping bags, less than your 20 kg carry limit\): at most 11 units fit your 10 kg load limit$/);

  // Cash: the journey is paid once, the rest grows with the units.
  const cash = byId(suitability({ units: 3, unitKg: 0.9, cashRequired: 4740, cashFixed: 0, profile: { ...CAR, cashAvailable: 2000 } }).checks);
  assert.equal(cash["cash-available"].ok, false);
  assert.equal(cash["cash-available"].detail, "The trip needs £47.40 in cash before any payout, more than the £20.00 you can spend: at most 1 unit fits your cash");
  const withFare = byId(suitability({ units: 3, unitKg: 0.9, cashRequired: 4740 + 600, cashFixed: 600, profile: { ...CAR, cashAvailable: 4000 } }).checks);
  assert.equal(withFare["cash-available"].maxUnits, 2, "(4000 - 600) / 1580 = 2 units");

  // Storage.
  const store = byId(suitability({ units: 3, unitKg: 0.9, cashRequired: 4740, profile: { ...CAR, storageUnits: 2 } }).checks);
  assert.equal(store["storage-space"].detail, "3 units, more than the room you have at home for 2 more now: at most 2 units fit your storage");
  const none = byId(suitability({ units: 1, unitKg: 0.9, cashRequired: 1580, profile: { ...CAR, storageUnits: 0 } }).checks);
  assert.equal(none["storage-space"].ok, false);
  assert.match(none["storage-space"].detail, /You have no room at home for more units now/);
});

test("a blank profile value is unknown, never zero, and every check that needs it asks for it", () => {
  const blank = suitability({ units: 3, unitKg: 0.9, cashRequired: 4740, profile: null });
  assert.equal(blank.ok, false);
  assert.equal(blank.known, false);
  assert.deepEqual(blank.checks.filter((c) => c.ok).map((c) => c.id), []);
  for (const c of blank.checks) assert.match(c.detail, /^(Confirm|The load for 3 units \(2\.7 kg\) cannot be checked until you confirm)/, c.id);
  assert.deepEqual(blank.missing, ["transport", "carryKg", "cashAvailable", "storageUnits"]);
  assert.equal(blank.maxUnits.all, null);

  // Each field on its own: a blank fails; a typed 0 is a real figure.
  const only = (field) => suitability({ units: 3, unitKg: 0.9, cashRequired: 4740, profile: { ...CAR, [field]: null } });
  assert.deepEqual(only("transport").checks.filter((c) => !c.ok).map((c) => c.id), ["one-unit-load", "total-load"]);
  assert.deepEqual(only("carryKg").checks.filter((c) => !c.ok).map((c) => c.id), ["one-unit-load", "total-load"]);
  assert.deepEqual(only("cashAvailable").checks.filter((c) => !c.ok).map((c) => c.id), ["cash-available"]);
  assert.equal(byId(only("cashAvailable").checks)["cash-available"].detail, "Confirm the cash you can spend on this trip: a blank is never counted as zero or as enough");
  assert.deepEqual(only("storageUnits").checks.filter((c) => !c.ok).map((c) => c.id), ["storage-space"]);
  const zeroCash = byId(suitability({ units: 3, unitKg: 0.9, cashRequired: 4740, profile: { ...CAR, cashAvailable: 0 } }).checks);
  assert.equal(zeroCash["cash-available"].known, true);
  assert.match(zeroCash["cash-available"].detail, /more than the £0\.00 you can spend/);

  // An unknown weight or cash figure fails too.
  const noWeight = byId(suitability({ units: 3, unitKg: null, cashRequired: 4740, profile: CAR }).checks);
  assert.equal(noWeight["one-unit-load"].ok, false);
  assert.match(noWeight["one-unit-load"].detail, /Unit weight not entered/);
  assert.equal(byId(suitability({ units: 3, unitKg: 0.9, cashRequired: null, profile: CAR }).checks)["cash-available"].ok, false);

  // From a request: blank is null; a value given must be valid.
  assert.equal(readTripProfile(undefined), null);
  assert.deepEqual(readTripProfile({ transport: "", carryKg: null, cashAvailable: "", storageUnits: undefined }), {
    transport: null,
    carryKg: null,
    cashAvailable: null,
    storageUnits: null,
  });
  assert.throws(() => readTripProfile({ transport: "Rocket" }), /profile\.transport/);
  assert.throws(() => readTripProfile({ carryKg: -1 }), /profile\.carryKg/);
  assert.throws(() => readTripProfile({ cashAvailable: 12.5 }), /profile\.cashAvailable/);
  assert.throws(() => readTripProfile({ storageUnits: 1.5 }), /profile\.storageUnits/);
});

test("the buy-alert gate fails closed on the suitability checks, and on a live trip nobody checked", () => {
  const base = {
    evidenceClass: "live",
    match: "exact",
    contribution: 900,
    hourly: 1500,
    hourlyFloor: 1200,
    journeyKnown: true,
    missingInputs: [],
    demandUnits: 4,
    offerObserved: "2026-10-30",
    now: "2026-10-31T12:00:00Z",
    localStockConfirmed: true,
    availability: "in_stock",
    priceAtBranch: true,
    promotion: null,
    shippingKnown: true,
    recentIndependentSales: 3,
    daysToSell: 6,
    cashNeededDays: 14,
    payoutDays: 11,
    displayPermitted: true,
    meetsThresholds: true,
    units: 3,
  };
  const fits = suitability({ units: 3, unitKg: 0.9, cashRequired: 4740, profile: CAR }).checks;
  assert.equal(evaluateAlert({ ...base, suitability: fits }).eligible, true);
  const walk = evaluateAlert({ ...base, suitability: suitability({ units: 3, unitKg: 0.9, cashRequired: 4740, profile: WALK_TENTH }).checks });
  assert.equal(walk.eligible, false);
  assert.deepEqual(walk.checks.filter((c) => !c.ok).map((c) => c.id), ["one-unit-load", "total-load"]);
  // A check list missing a check fails that check.
  const partial = evaluateAlert({ ...base, suitability: fits.filter((c) => c.id !== "storage-space") });
  assert.deepEqual(partial.checks.filter((c) => !c.ok).map((c) => c.id), ["storage-space"]);
  // No suitability at all on live evidence: not checked, so not eligible.
  const unchecked = evaluateAlert(base);
  assert.equal(unchecked.eligible, false);
  assert.deepEqual(unchecked.checks.filter((c) => !c.ok).map((c) => c.id), ["member-fit"]);
  // A bounty's own estimate leaves it to each member.
  assert.equal(evaluateAlert({ ...base, suitability: "per-member" }).eligible, true);
});

// ------------------------------------------------------------------- Research

test("Research: the reviewer's case is refused, a single overweight item and a batch over the limit fail, a car passes", async () => {
  const a = await app(evidence());
  try {
    const walker = await a.estimate({ profile: WALK_TENTH });
    assert.equal(walker.alert.eligible, false);
    assert.deepEqual(failing(walker), ["one-unit-load", "total-load"]);
    assert.equal(byId(walker.alert.checks)["one-unit-load"].detail, "One unit weighs 0.9 kg, more than your 0.1 kg load limit on foot: it needs a car or van");
    assert.equal(walker.suitability.basis, "profile");
    assert.equal(walker.suitability.ok, false);
    assert.equal(walker.suitability.maxUnits.all, 0);
    assert.equal(walker.access.carryKg, 0.1);
    assert.equal(walker.access.carrySource, "profile");

    // One unit heavier than a 0.5 kg carry limit on foot.
    const single = await a.estimate({ units: 1, profile: { ...WALK_TENTH, carryKg: 0.5 } });
    assert.equal(single.alert.eligible, false);
    assert.deepEqual(failing(single), ["one-unit-load", "total-load"]);
    assert.match(byId(single.alert.checks)["one-unit-load"].detail, /more than your 0\.5 kg load limit on foot: it needs a car or van/);

    // Every unit fits alone, the batch does not.
    const batch = await a.estimate({ profile: { ...WALK_TENTH, carryKg: 1 } });
    assert.equal(batch.alert.eligible, false);
    assert.deepEqual(failing(batch), ["total-load"]);
    assert.equal(
      byId(batch.alert.checks)["total-load"].detail,
      "3 units weigh 2.7 kg in all, more than your 1 kg load limit on foot: at most 1 unit fits your 1 kg load limit",
    );
    assert.equal(batch.suitability.maxUnits.load, 1);

    // The same trip by car passes every check, with the checks in plain words.
    const car = await a.estimate({ profile: CAR });
    assert.equal(car.alert.eligible, true, car.alert.reasons.join("; "));
    for (const id of SUITABILITY_CHECKS) assert.equal(byId(car.alert.checks)[id].ok, true, id);
    assert.match(byId(car.alert.checks)["one-unit-load"].detail, /^One unit \(0\.9 kg\) is within your 25 kg load limit by car/);
    assert.equal(car.suitability.ok, true);
    assert.equal(car.suitability.cashRequired, 4740);
  } finally {
    await a.close();
  }
});

test("Research: cash and storage short fail with how many units would fit", async () => {
  const a = await app(evidence());
  try {
    const cash = await a.estimate({ profile: { ...CAR, cashAvailable: 2000 } });
    assert.equal(cash.alert.eligible, false);
    assert.deepEqual(failing(cash), ["cash-available"]);
    assert.equal(
      byId(cash.alert.checks)["cash-available"].detail,
      "The trip needs £47.40 in cash before any payout, more than the £20.00 you can spend: at most 1 unit fits your cash",
    );
    assert.equal(cash.suitability.maxUnits.cash, 1);

    const store = await a.estimate({ profile: { ...CAR, storageUnits: 2 } });
    assert.equal(store.alert.eligible, false);
    assert.deepEqual(failing(store), ["storage-space"]);
    assert.equal(byId(store.alert.checks)["storage-space"].detail, "3 units, more than the room you have at home for 2 more now: at most 2 units fit your storage");
  } finally {
    await a.close();
  }
});

test("Research: an unknown profile is refused as unknown, never filled in, and a bad value is a 400", async () => {
  const a = await app(evidence());
  try {
    // No profile at all: every check that needs it fails and asks for it,
    // and no default carry limit stands in.
    const none = await a.estimate({ profile: undefined, carryKg: undefined });
    assert.equal(none.alert.eligible, false);
    assert.deepEqual(failing(none), ["one-unit-load", "total-load", "cash-available", "storage-space"]);
    assert.equal(none.suitability.known, false);
    assert.equal(none.access.carryKg, null);
    assert.equal(none.access.carrySource, "unknown");
    for (const c of none.alert.checks.filter((x) => !x.ok)) assert.match(c.detail, /confirm/i, c.id);

    // One blank field at a time.
    for (const [field, ids] of [
      ["transport", ["one-unit-load", "total-load"]],
      ["carryKg", ["one-unit-load", "total-load"]],
      ["cashAvailable", ["cash-available"]],
      ["storageUnits", ["storage-space"]],
    ]) {
      const est = await a.estimate({ profile: { ...CAR, [field]: "" } });
      assert.equal(est.alert.eligible, false, field);
      assert.deepEqual(failing(est), ids, field);
      assert.deepEqual(est.suitability.missing, [field]);
    }

    for (const [profile, field] of [
      [{ ...CAR, transport: "Rocket" }, "profile.transport"],
      [{ ...CAR, carryKg: -1 }, "profile.carryKg"],
      [{ ...CAR, cashAvailable: 99.5 }, "profile.cashAvailable"],
      [{ ...CAR, storageUnits: -2 }, "profile.storageUnits"],
      ["Car", "profile"],
    ]) {
      const res = await a.call("POST", "/api/research/estimate", request({ profile }));
      assert.equal(res.status, 400, field);
      assert.match(res.body.error, new RegExp(field.replace(".", "\\.")), field);
    }
  } finally {
    await a.close();
  }
});

// ------------------------------------------------------------------- bounties

test("members store a validated profile through POST and PATCH; blank is unknown and clears", async () => {
  const db = evidence();
  const a = await app(db);
  try {
    const ann = await a.member("Ann", { transport: "Public transport", carryKg: 12.5, storageUnits: 4 });
    assert.deepEqual(
      { transport: ann.profile.transport, carryKg: ann.profile.carryKg, storageUnits: ann.profile.storageUnits, complete: ann.profile.complete },
      { transport: "Public transport", carryKg: 12.5, storageUnits: 4, complete: true },
    );
    assert.equal(ann.profile.loadLimitKg, 10);
    const stored = db.prepare("SELECT transport, carry_kg, storage_units FROM members WHERE id = ?").get(ann.id);
    assert.deepEqual({ ...stored }, { transport: "Public transport", carry_kg: 12.5, storage_units: 4 });

    const bob = await a.member("Bob");
    assert.equal(bob.profile.complete, false);
    assert.deepEqual(bob.profile.missing, ["transport", "carryKg", "storageUnits"]);
    assert.equal(bob.profile.note, PROFILE_NEEDED);
    assert.equal(db.prepare("SELECT carry_kg FROM members WHERE id = ?").get(bob.id).carry_kg, null, "blank is never 0");

    for (const [body, field] of [
      [{ transport: "Rocket" }, "transport"],
      [{ carryKg: -1 }, "carryKg"],
      [{ carryKg: 1001 }, "carryKg"],
      [{ storageUnits: 2.5 }, "storageUnits"],
      [{ storageUnits: "lots" }, "storageUnits"],
    ]) {
      const res = await a.call("PATCH", `/api/members/${ann.id}`, body);
      assert.equal(res.status, 400, field);
      assert.match(res.body.error, new RegExp(field), field);
      const post = await a.call("POST", "/api/members", { name: "Cat", ...body });
      assert.equal(post.status, 400, field);
    }
    // A PATCH changes only the fields it names; a blank clears one.
    const patched = await a.call("PATCH", `/api/members/${ann.id}`, { carryKg: "" });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.member.profile.carryKg, null);
    assert.equal(patched.body.member.profile.transport, "Public transport");
    assert.equal(patched.body.member.profile.complete, false);
    const listed = (await a.call("GET", "/api/members")).body.members.find((m) => m.id === ann.id);
    assert.deepEqual(listed.profile.missing, ["carryKg"]);
  } finally {
    await a.close();
  }
});

test("an older members table gains the profile columns in place, with every member's profile unknown", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE members (
 id INTEGER PRIMARY KEY,
 name TEXT NOT NULL,
 locality TEXT,
 paid_tier TEXT,
 paid_until TEXT,
 alerts_opt_in INTEGER NOT NULL DEFAULT 0,
 alert_localities TEXT NOT NULL DEFAULT '[]',
 rules TEXT NOT NULL DEFAULT '{}',
 created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
  db.prepare("INSERT INTO members(name) VALUES('Old member')").run();
  bountiesSchema(db);
  const cols = db.prepare("PRAGMA table_info(members)").all().map((c) => c.name);
  for (const c of ["transport", "carry_kg", "storage_units"]) assert.ok(cols.includes(c), c);
  assert.deepEqual({ ...db.prepare("SELECT transport, carry_kg, storage_units FROM members").get() }, {
    transport: null,
    carry_kg: null,
    storage_units: null,
  });
  db.close();
});

test("a bounty's estimate leaves the fit to each member: the reviewer's claim is refused, a car is allowed", async () => {
  const db = evidence();
  const a = await app(db);
  try {
    // The operator's own profile never decides a bounty.
    const b = await a.bounty({ profile: WALK_TENTH });
    const stored = db.prepare("SELECT alert_eligible, estimate FROM bounties WHERE id = ?").get(b.id);
    assert.equal(stored.alert_eligible, 1);
    const est = JSON.parse(stored.estimate);
    const ids = est.alert.checks.map((c) => c.id);
    assert.equal(est.alert.checks.find((c) => c.id === "member-fit").ok, true);
    for (const id of SUITABILITY_CHECKS) assert.ok(!ids.includes(id), id);
    assert.equal(est.request.profile, undefined, "no one person's profile is kept with the bounty");
    assert.equal(est.request.carryKg, undefined);

    const walker = await a.member("Walker", { transport: "Walk", carryKg: 0.1, storageUnits: 10 });
    const refused = await a.claim(b.id, walker.id, 3);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /One unit weighs 0\.9 kg, more than your 0\.1 kg load limit on foot: it needs a car or van/);
    assert.equal(claims(db), 0);

    const driver = await a.member("Driver", { transport: "Car", carryKg: 5, storageUnits: 10 });
    const allowed = await a.claim(b.id, driver.id, 3);
    assert.equal(allowed.status, 201, allowed.body.error);
    assert.equal(claims(db), 1);
    assert.equal(JSON.parse(db.prepare("SELECT terms FROM claims").get().terms).cashAvailable, 10000);
  } finally {
    await a.close();
  }
});

test("a claim that does not fit is refused with the reason and how many would fit", async () => {
  const db = evidence();
  const a = await app(db);
  try {
    const b = await a.bounty();
    // A single overweight item.
    const light = await a.member("Light", { transport: "Walk", carryKg: 0.5, storageUnits: 10 });
    const single = await a.claim(b.id, light.id, 1);
    assert.equal(single.status, 409);
    assert.match(single.body.error, /One unit weighs 0\.9 kg, more than your 0\.5 kg load limit on foot: it needs a car or van/);

    // A batch over the limit: three are refused, saying one fits.
    const kilo = await a.member("Kilo", { transport: "Walk", carryKg: 1, storageUnits: 10 });
    const batch = await a.claim(b.id, kilo.id, 3);
    assert.equal(batch.status, 409);
    assert.match(batch.body.error, /3 units weigh 2\.7 kg in all, more than your 1 kg load limit on foot: at most 1 unit fits your 1 kg load limit/);
    // The card says so too, and limits the claim to what fits.
    const card = (await a.call("GET", `/api/bounties?viewer=${kilo.id}`)).body.bounties.find((x) => x.id === b.id);
    assert.equal(card.viewer.fit.ok, false);
    assert.equal(card.viewer.fit.partial, true);
    assert.equal(card.viewer.fit.maxUnits, 1);
    assert.equal(card.viewer.maxClaimUnits, 1);
    assert.equal(card.trip.state, "does-not-fit");
    assert.equal(card.trip.go, false);

    // Cash short.
    const short = await a.member("Short", { transport: "Car", carryKg: 5, storageUnits: 10 });
    const cash = await a.claim(b.id, short.id, 3, { cashAvailable: 2000 });
    assert.equal(cash.status, 409);
    assert.match(cash.body.error, /more than the £20\.00 you can spend: at most 1 unit fits your cash/);

    // Storage short.
    const small = await a.member("Small", { transport: "Car", carryKg: 5, storageUnits: 2 });
    const store = await a.claim(b.id, small.id, 3);
    assert.equal(store.status, 409);
    assert.match(store.body.error, /3 units, more than the room you have at home for 2 more now: at most 2 units fit your storage/);

    // No profile: refused, asked to confirm it.
    const nobody = await a.member("Nobody");
    const unknown = await a.claim(b.id, nobody.id, 1);
    assert.equal(unknown.status, 409);
    assert.match(unknown.body.error, /Confirm how you will travel and how much you can carry \(kg\)/);
    assert.match(unknown.body.error, /Confirm how many units you have room for at home/);

    // A blank cash figure is a 400, never zero.
    for (const cashAvailable of [undefined, null, ""]) {
      const blank = await a.claim(b.id, short.id, 3, { cashAvailable });
      assert.equal(blank.status, 400, String(cashAvailable));
      assert.match(blank.body.error, /Enter the cash you can spend on this trip/);
    }
    assert.equal(claims(db), 0, "nothing was claimed");

    // A passing case: a car with room and cash.
    const fine = await a.member("Fine", { transport: "Car", carryKg: 5, storageUnits: 10 });
    const ok = await a.claim(b.id, fine.id, 3);
    assert.equal(ok.status, 201, ok.body.error);
    assert.equal(claims(db), 1);
  } finally {
    await a.close();
  }
});

test("the claim-check takes the member's cash and profile and says what does not fit", async () => {
  const db = evidence();
  const a = await app(db);
  try {
    const b = await a.bounty();
    const walker = await a.member("Walker", { transport: "Walk", carryKg: 0.1, storageUnits: 10 });
    const res = await a.claimCheck(b.id, walker.id, 3);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.check.ok, false);
    assert.equal(res.body.check.fit.ok, false);
    assert.deepEqual(res.body.check.fit.checks.filter((c) => !c.ok).map((c) => c.id), ["one-unit-load", "total-load"]);
    assert.ok(res.body.check.reasons.some((r) => /it needs a car or van/.test(r)));

    const blank = await a.claimCheck(b.id, walker.id, 3, { cashAvailable: undefined });
    assert.equal(blank.status, 400);
    assert.match(blank.body.error, /Enter the cash you can spend on this trip/);

    const driver = await a.member("Driver", { transport: "Car", carryKg: 5, storageUnits: 10 });
    const short = await a.claimCheck(b.id, driver.id, 3, { cashAvailable: 2000 });
    assert.equal(short.body.check.ok, false);
    assert.deepEqual(short.body.check.fit.checks.filter((c) => !c.ok).map((c) => c.id), ["cash-available"]);
    const fine = await a.claimCheck(b.id, driver.id, 3);
    assert.equal(fine.body.check.ok, true, fine.body.check.reasons.join("; "));
    assert.equal(fine.body.check.fit.ok, true);
  } finally {
    await a.close();
  }
});

test("alerts never tell a member go when the trip does not fit, and ask a member with no profile to confirm it", async () => {
  const db = evidence();
  const a = await app(db);
  try {
    const b = await a.bounty();
    const walker = await a.member("Walker", { transport: "Walk", carryKg: 0.1, storageUnits: 10 });
    const nobody = await a.member("Nobody");
    const driver = await a.member("Driver", { transport: "Car", carryKg: 5, storageUnits: 10 });

    const sent = (await a.call("POST", `/api/bounties/${b.id}/alerts`, {})).body;
    assert.deepEqual(sent.sent.map((s) => s.name), ["Driver"]);
    assert.deepEqual(sent.confirm.map((s) => s.name), ["Nobody"]);
    assert.deepEqual(sent.confirm[0].missing, ["transport", "carryKg", "storageUnits"]);
    const why = sent.notAlerted.find((n) => n.memberId === walker.id);
    assert.match(why.reason, /^Does not fit the member's own transport, carrying limit or storage for 3 units\. Their check reads: One unit weighs 0\.9 kg/);
    assert.equal(sent.exposure.alreadySent, 1, "a request to confirm the profile is not an alert");

    // The walker has nothing in their inbox; the card says the trip is not for them.
    assert.deepEqual((await a.call("GET", `/api/members/${walker.id}/alerts`)).body.alerts, []);
    const walkerCard = (await a.call("GET", `/api/bounties?viewer=${walker.id}`)).body.bounties.find((x) => x.id === b.id);
    assert.equal(walkerCard.trip.go, false);
    assert.equal(walkerCard.trip.state, "does-not-fit");
    assert.equal(walkerCard.viewer.canClaim, false);
    assert.ok(walkerCard.viewer.blockers.some((r) => /it needs a car or van/.test(r)));

    // The member with no profile is asked to confirm it, with no figures.
    const inbox = (await a.call("GET", `/api/members/${nobody.id}/alerts`)).body.alerts;
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].kind, "profile");
    assert.equal(inbox[0].figures, null);
    assert.equal(inbox[0].trip.go, false);
    assert.equal(inbox[0].trip.state, "confirm-profile");
    // Asked once: the trip line carries the request, so the note is empty
    // (round 5b: it used to repeat the same sentence).
    assert.ok(inbox[0].trip.headline.endsWith(PROFILE_NEEDED.charAt(0).toLowerCase() + PROFILE_NEEDED.slice(1)), inbox[0].trip.headline);
    assert.equal(inbox[0].questionNote, null);
    const nobodyCard = (await a.call("GET", `/api/bounties?viewer=${nobody.id}`)).body.bounties.find((x) => x.id === b.id);
    assert.equal(nobodyCard.viewer.canClaim, false);
    assert.ok(nobodyCard.viewer.blockers.includes(PROFILE_NEEDED));
    assert.equal(nobodyCard.viewer.fit.complete, false);
    // Sending again does not repeat the request.
    const again = (await a.call("POST", `/api/bounties/${b.id}/alerts`, {})).body;
    assert.deepEqual(again.confirm, []);
    assert.match(again.notAlerted.find((n) => n.memberId === nobody.id).reason, /Asked to confirm their transport, carry limit and storage: waiting for them/);

    // A profile the trip does not fit leaves the request as it is.
    const walking = await a.call("PATCH", `/api/members/${nobody.id}`, { transport: "Walk", carryKg: 0.2, storageUnits: 10 });
    assert.equal(walking.body.alerted, 0);
    assert.equal((await a.call("GET", `/api/members/${nobody.id}/alerts`)).body.alerts[0].kind, "profile");

    // Completing it with a car turns the request into the alert, with figures.
    const done = await a.call("PATCH", `/api/members/${nobody.id}`, { transport: "Car", carryKg: 5, storageUnits: 10 });
    assert.equal(done.status, 200);
    assert.equal(done.body.alerted, 1);
    const now = (await a.call("GET", `/api/members/${nobody.id}/alerts`)).body.alerts;
    assert.equal(now.length, 1);
    assert.equal(now[0].kind, "alert");
    assert.notEqual(now[0].figures, null);
    assert.equal(now[0].trip.go, true);
  } finally {
    await a.close();
  }
});
