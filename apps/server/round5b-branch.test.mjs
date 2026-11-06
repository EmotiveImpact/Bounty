// Round 5, branch identity (the verifier's report on fc02d8a, finding 1).
//
// 1. A check whose locality is Camden but whose branch names the Preston
//    shop (node/111, an openstreetmap.org link to it, or "Home Bargains PR1
//    2AR") used to make the Preston Open Prices price count as the same
//    shop, so the Camden bounty alerted and took a claim. A shop now counts
//    as the branch only when Open Prices places it in the check's locality,
//    and recording such a check returns a plain warning (branchWarning).
// 2. One shop named two ways (by postcode, then by OpenStreetMap id; or
//    "Street" against "St") was not seen as the same branch, so an earlier
//    shelf price stopped applying. An id now resolves to its postcode
//    through Open Prices, and street abbreviations read the same.
//
// The cases named A1, A1b, A1c, A2 and A2c are the verifier's
// (/tmp/claude-0/review/round5/verify/f1-attacks.mjs) exactly.
//
// Second pass (the verifier's report on the first pass):
// 3. Within London, a borough check that named a shop in another borough
//    (CR0 or E8 on a Camden check, NW1 on a Croydon one) still counted, as
//    Open Prices gives the city as London across Greater London. A shop's
//    postcode district must now have addresses in the borough.
// 4. A genuine same-shop price was refused when Open Prices gives the long
//    name of the town ("Newcastle upon Tyne" for a Newcastle check).
// 5. branchPlace says why a named shop does not count (for the estimate's
//    reason), and a typed postcode that differs from the id's resolved one
//    never matches the typed postcode.
//
// Third pass (the verifier's report on the second pass):
// 6. A locality of the form "<place>, London" ("Romford, London",
//    "Stratford, London") was read as all of London, so a shop in another
//    borough counted again. London after an outer post town is now that
//    post town, and after any other place it has no boundary to check.
// 7. A London shop whose Open Prices city is a district name (the real
//    Acton Morrisons, the Wood Green Sainsbury's) was refused for its own
//    borough and for London. Such a city now says nothing, so the postcode
//    decides.
// 8. Shops outside Greater London in districts that cross the boundary
//    (the real Epsom Lidl and Tesco Express, the Dartford Kent Curry)
//    counted for the next borough and for London. The boundary is now
//    placed by sector, and on a boundary sector by postcode, from the
//    postcode directory.
// 9. The post town table dropped the first of two post towns in a
//    district (CR8 is Purley and Kenley), so a Croydon check naming a
//    Purley shop was refused.
// 10. The rule that a city naming another borough contradicts a borough
//    check was untested (the verifier's mutant M21).
//
// Fourth pass (the verifier's report on the third pass, and the brief):
// 11. The estimate's reason said a price seen at the shop the check names
//    was "not at the branch checked": it now says it was seen at that shop,
//    and why Open Prices does not place it in the locality (branchPlace).
// 12. A correct town check was told the shop is elsewhere when Open Prices
//    records it under a suburb name (Birmingham, B29 6HH, city
//    "Stirchley"). Such a city now leaves the shop unknown, with a reason
//    that says so; real contradictions still say "elsewhere".
// 13. "Romford London" with no comma was a town of that name, so a Romford
//    shop was refused; it is now the post town Romford.
// 14. The rule that mixed Open Prices rows for one shop (some place it in
//    the locality, the rest do not place it) give no warning was untested
//    (the verifier's mutant M26).
//
// The tests run the Research routes and the bounty routes on the server
// clock, as the app does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.mjs";
import { serve } from "./test-support.mjs";
import { londonDate } from "./http.mjs";
import { KIND, LICENCE } from "./contract.mjs";
import { storeLookup, upsertObservations, upsertResearch } from "./evidence.mjs";
// The whole module, so that each test fails on its own assertion on a tree
// without these changes (shopInLocality is new).
import * as audit from "./audit.mjs";
import * as researchRoutes from "./routes-research.mjs";
import * as bountyRoutes from "./routes-bounties.mjs";

const DAY = 86400000;
const GTIN = "5012345678115";
const TITLE = "Mini Bluetooth speaker black";
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const ukDay = (days) => londonDate(new Date(Date.now() - days * DAY));

// Open Prices: £12.00 at Home Bargains in Preston (node/111), today, and
// £12.00 at Home Bargains in Camden (node/222, NW1 8QP, London), yesterday.
const PRESTON = { id: 700001, title: TITLE, store: "Home Bargains", place: "PR1 2AR", city: "Preston", osm_id: "node/111", price: 1200, barcode: GTIN };
const CAMDEN_OP = { id: 700002, title: TITLE, store: "Home Bargains", place: "NW1 8QP", city: "London", osm_id: "node/222", price: 1200, barcode: GTIN };
const ITEM = { title: TITLE, barcode: GTIN, size: "one size", pack: "1", model: "BTS-20", condition: "new" };
// 26 independent completed sales at £28 over 80 days.
const SALES = Array.from({ length: 26 }, (_, i) => {
  const sold = 1 + Math.floor((i * 80) / 26);
  return { source_id: "s" + i, seller: "seller" + i, observed: ukDay(sold), listed: ukDay(sold + 4) };
});

function evidence(observations = [{ ...PRESTON, day: ukDay(0) }]) {
  const now = new Date().toISOString();
  const db = openDb(":memory:");
  if (observations.length) upsertObservations(db, observations, { now });
  upsertResearch(
    db,
    "sales",
    SALES.map((s) => ({ ...ITEM, ...s, kind: KIND.SOLD, price: 2800, retailer: "eBay UK", licence: LICENCE.SELF })),
    { now },
  );
  storeLookup(db, "ebay", GTIN, [], { now });
  return db;
}
const withCamden = () => evidence([{ ...PRESTON, day: ukDay(0) }, { ...CAMDEN_OP, day: ukDay(1) }]);

// The estimate request the Research page sends for one unit.
const request = (over = {}) => ({
  offer: { provider: "openprices", sourceId: "700001" },
  sales: SALES.map((s) => ({ provider: "sales", sourceId: s.source_id })),
  units: 1,
  weightKg: 0.4,
  costs: { postage: 300, packaging: 30, handlingMinutes: 5, journeyCost: 0, journeyMinutes: 15 },
  hourlyFloor: 800,
  locality: "Camden",
  offerAttributes: { pack: "1", model: "BTS-20", condition: "new", size: "one size" },
  category: "general",
  categoryReason: "A loudspeaker, not food: Open Prices suggests Food for every observation",
  // The operator's own transport, carrying limit, cash and storage (round
  // 5, suitability).
  profile: { transport: "Walk", carryKg: 5, cashAvailable: 100000, storageUnits: 20 },
  ...over,
});

async function app(db) {
  const api = await serve(db, [
    { routes: researchRoutes.routes },
    { routes: (x) => bountyRoutes.routes(x, { clock: () => new Date().toISOString(), photoDir: "/nonexistent-photos" }) },
  ]);
  const call = (method, path, body) => api.call(method, path, body, { Origin: api.base });
  const check = (fields) =>
    call("POST", "/api/research/checks", {
      barcode: GTIN,
      retailer: "Home Bargains",
      locality: "Camden",
      method: "in_store",
      inStock: true,
      unitsSeen: 6,
      ...fields,
    });
  const estimate = async (over) => {
    const r = await call("POST", "/api/research/estimate", request(over));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  return { api, call, check, estimate, close: () => api.close() };
}

const priceCheck = (estimate) => estimate.alert.checks.find((c) => c.id === "price-at-branch");
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The reason a price seen at a shop the check names is not confirmed
// (estimate.mjs priceAtBranch, with branchPlace's clause since the fourth
// pass): "The £12.00 price was seen at <shop>, the shop the branch check
// names, but <why>: record the shelf price on a branch check there". The
// earlier wording, "not at the branch checked in Camden (node/111)", was
// false: the price was seen at the shop the check names. anchored false
// matches it inside a longer message.
const notConfirmedHere = (seenAt, why, anchored = true) => {
  const body = esc(`The £12.00 price was seen at ${seenAt}, the shop the branch check names, but ${why}: record the shelf price on a branch check there`);
  return new RegExp(anchored ? `^${body}$` : body);
};
// branchPlace's clause for a shop Open Prices places outside the locality.
const outside = (locality, detail = null) => `Open Prices places it outside ${locality}${detail ? ` (${detail})` : ""}`;
const PRESTON_SHOP = "Home Bargains, PR1 2AR, Preston";
const prestonReason = (anchored = true) => notConfirmedHere(PRESTON_SHOP, outside("Camden"), anchored);
const placedElsewhere = (branch, tail) =>
  `Open Prices places the branch named (${branch}) at PR1 2AR, Preston, which does not match the locality Camden, so prices seen there do not count for this check. Check the branch and the locality. ${tail}`;
const RECORD_PRICE = "To cost a trip from this check, record the shelf price on it.";
const PRICE_APPLIES = "The shelf price recorded on this check still applies.";

test("A1, A1b and A1c: a Camden check that names the Preston shop leaves the Preston price unconfirmed and warns when saved", async () => {
  const db = evidence();
  const a = await app(db);
  try {
    for (const branch of ["node/111", "Home Bargains PR1 2AR", "https://www.openstreetmap.org/node/111"]) {
      db.prepare("DELETE FROM availability_checks").run();
      const saved = await a.check({ branch });
      assert.equal(saved.status, 201, JSON.stringify(saved.body));
      assert.equal(saved.body.branch, branch);
      assert.equal(saved.body.branchWarning, placedElsewhere(branch, RECORD_PRICE), branch);

      const est = await a.estimate();
      assert.equal(est.stock.confirmed, true, "the check still confirms Camden stock");
      assert.equal(est.priceAtBranch.confirmed, false, branch);
      assert.equal(est.priceAtBranch.basis, null, branch);
      assert.equal(priceCheck(est).ok, false, branch);
      assert.match(priceCheck(est).detail, prestonReason());
      assert.equal(est.alert.eligible, false, branch);
      assert.equal(est.opportunity.tier, "Review", "an unconfirmed price is an evidence gap");
      assert.equal(est.offer.price, 1200, "the offer is shown as it was seen");
    }
    // The id resolves to the Preston postcode (sameBranch uses it), which
    // never makes the Preston shop a Camden branch.
    assert.equal(db.prepare("SELECT branch_postcode FROM availability_checks").get().branch_postcode, "PR1 2AR");
  } finally {
    await a.close();
  }
});

test("A1 through a bounty: the Camden bounty sends no alert and takes no claim at the Preston price", async () => {
  const db = evidence();
  const a = await app(db);
  try {
    const saved = await a.check({ branch: "node/111", method: "phone" });
    assert.equal(saved.body.branchWarning, placedElsewhere("node/111", RECORD_PRICE));
    const created = await a.call("POST", "/api/bounties", {
      title: "Speaker",
      locality: "Camden",
      retailer: "Home Bargains",
      salesPerWeek: 10,
      sellWindowWeeks: 2,
      expiresAt: new Date(Date.now() + 5 * DAY).toISOString(),
      sponsored: false,
      estimate: request(),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.bounty.id;
    assert.match(created.body.message, /cannot send alerts or take claims/);
    const stored = db.prepare("SELECT alert_eligible, alert_reasons FROM bounties WHERE id = ?").get(id);
    assert.equal(stored.alert_eligible, 0);
    assert.ok(JSON.parse(stored.alert_reasons).some((r) => prestonReason().test(r)), stored.alert_reasons);

    const ann = (
      await a.call("POST", "/api/members", {
        name: "Ann",
        alertsOptIn: true,
        alertLocalities: ["Camden"],
        paidTier: "diamond",
        paidUntil: new Date(Date.now() + 200 * DAY).toISOString().slice(0, 10),
        transport: "Car",
        carryKg: 25,
        storageUnits: 50,
      })
    ).body.member;
    const sent = await a.call("POST", `/api/bounties/${id}/alerts`, {});
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body.sent, []);
    const claimed = await a.call("POST", `/api/bounties/${id}/claims`, {
      memberId: ann.id,
      units: 1,
      journeyCost: 0,
      journeyMinutes: 15,
      cashAvailable: 100000,
    });
    assert.equal(claimed.status, 409);
    assert.match(claimed.body.error, prestonReason(false));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM claims").get().n, 0);
  } finally {
    await a.close();
  }
});

test("a shelf price recorded on that Camden check still costs the trip, and the warning says it applies", async () => {
  const db = evidence();
  const a = await app(db);
  try {
    const saved = await a.check({ branch: "node/111", pricePence: 1250 });
    assert.equal(saved.body.branchWarning, placedElsewhere("node/111", PRICE_APPLIES));
    const est = await a.estimate();
    assert.equal(est.priceAtBranch.confirmed, true);
    assert.equal(est.priceAtBranch.basis, "check");
    assert.equal(est.priceAtBranch.price, 1250);
    assert.equal(est.offer.price, 1250, "costed at the shelf price on the check, not the £12.00 seen in Preston");
    assert.equal(priceCheck(est).detail, "Shelf price recorded on the branch check");
  } finally {
    await a.close();
  }
});

test("A2: the same shop named by postcode and then by OpenStreetMap id keeps the earlier shelf price once Open Prices gives the id's postcode", async () => {
  const checks = [
    { branch: "Home Bargains, Camden High Street NW1 8QP", pricePence: 1200, checkedAt: ago(3) },
    { branch: "node/222", checkedAt: ago(0.1) },
  ];
  // Exactly as the verifier ran it: Open Prices knows only the Preston
  // shop, so node/222 cannot be resolved and nothing shows the two checks
  // are one shop. That still fails closed.
  {
    const db = evidence();
    const a = await app(db);
    try {
      for (const c of checks) {
        const saved = await a.check(c);
        assert.equal(saved.status, 201);
        assert.equal(saved.body.branch_postcode, null);
        assert.equal(saved.body.branchWarning, null, "Open Prices does not know node/222, so there is nothing to warn about");
      }
      const est = await a.estimate();
      assert.equal(est.priceAtBranch.confirmed, false);
      assert.equal(
        priceCheck(est).detail,
        "The £12.00 price was seen at Home Bargains, PR1 2AR, Preston, not at the branch checked in Camden (node/222): record the shelf price on a branch check there",
        "a shop the check does not name is not the branch",
      );
    } finally {
      await a.close();
    }
  }
  // With Open Prices placing node/222 at NW1 8QP, London: the same branch.
  {
    const db = withCamden();
    const a = await app(db);
    try {
      const priced = await a.check(checks[0]);
      const byId = await a.check(checks[1]);
      assert.equal(byId.body.branch_postcode, "NW1 8QP", "the id resolves to the shop's postcode when the check is recorded");
      assert.equal(byId.body.branchWarning, null, "a Camden check naming a London shop gets no warning");
      const est = await a.estimate();
      assert.equal(est.stock.check.id, byId.body.id, "the newer check decides stock");
      assert.equal(est.priceAtBranch.confirmed, true, est.priceAtBranch.reason);
      assert.equal(est.priceAtBranch.basis, "check");
      assert.equal(est.priceAtBranch.check.id, priced.body.id);
      assert.equal(est.offer.price, 1200);
      assert.equal(priceCheck(est).detail, "Shelf price recorded on the branch check");
      // Another id at the same postcode is still another shop.
      const other = await a.check({ branch: "node/333", checkedAt: ago(0.05) });
      assert.equal(other.body.branch_postcode, null);
      assert.equal((await a.estimate()).priceAtBranch.confirmed, false);
    } finally {
      await a.close();
    }
  }
});

test("A2c: Street and St name the same branch; another street or another postcode never does", async () => {
  const db = evidence();
  const a = await app(db);
  const run = async (older, newer) => {
    db.prepare("DELETE FROM availability_checks").run();
    await a.check({ branch: older, pricePence: 1200, checkedAt: ago(3) });
    await a.check({ branch: newer, checkedAt: ago(0.1) });
    return a.estimate();
  };
  try {
    // The verifier's A2c, exactly.
    const est = await run("Home Bargains, Camden High Street", "Home Bargains, Camden High St");
    assert.equal(est.priceAtBranch.confirmed, true, est.priceAtBranch.reason);
    assert.equal(est.priceAtBranch.basis, "check");
    assert.equal(priceCheck(est).detail, "Shelf price recorded on the branch check");
    // Punctuation, "Rd" and the retailer's name written or left out.
    assert.equal((await run("Home Bargains, 12 Parkway Rd.", "12 parkway road")).priceAtBranch.confirmed, true);
    // Different words, or different postcodes, are different shops.
    for (const [older, newer] of [
      ["Home Bargains, Camden High Street", "Home Bargains, Kentish Town Rd"],
      ["Home Bargains, Camden High Street", "Home Bargains, Camden Rd"],
      ["Home Bargains NW1 8QP", "Home Bargains NW5 2AA"],
      ["Home Bargains, Camden High Street", "Home Bargains Camden High Street NW1 8QP"],
    ]) {
      const r = await run(older, newer);
      assert.equal(r.priceAtBranch.confirmed, false, `${older} | ${newer}`);
    }
    assert.equal(audit.sameBranch("St Pancras", "Saint Pancras"), false, "Saint is never read as Street");
    assert.equal(audit.sameBranch({ branch: "node/1", branch_postcode: "NW1 8QP" }, { branch: "node/2", branch_postcode: "NW1 8QP" }), false);
    assert.equal(
      audit.sameBranch({ branch: "node/1 NW5 2AA", branch_postcode: "NW1 8QP" }, { branch: "Home Bargains NW1 8QP" }),
      false,
      "a typed postcode that differs from the id's leaves the branch unidentified",
    );
  } finally {
    await a.close();
  }
});

test("a same-shop Open Prices price in the right locality still confirms the price, with no warning", async () => {
  const db = withCamden();
  const a = await app(db);
  const run = async (fields, over, warning = null) => {
    db.prepare("DELETE FROM availability_checks").run();
    const saved = await a.check(fields);
    assert.equal(saved.status, 201);
    assert.equal(saved.body.branchWarning, warning, JSON.stringify(fields));
    return a.estimate(over);
  };
  try {
    // The Preston shop for a Preston check.
    for (const branch of ["node/111", "Home Bargains, Fishergate PR1 2AR"]) {
      const est = await run({ locality: "Preston", branch }, { locality: "Preston" });
      assert.equal(est.priceAtBranch.confirmed, true, branch + ": " + est.priceAtBranch.reason);
      assert.equal(est.priceAtBranch.basis, "same-shop");
      assert.equal(priceCheck(est).detail, "Price seen at the same shop the branch check covers");
      assert.equal(est.offer.price, 1200);
    }
    // The Camden shop (city London, postcode NW1) for a check in Camden, or
    // in the London borough written in full.
    const camden = { offer: { provider: "openprices", sourceId: "700002" } };
    for (const [locality, branch] of [
      ["Camden", "node/222"],
      ["Camden", "https://www.openstreetmap.org/node/222"],
      ["Camden", "Home Bargains NW1 8QP"],
      ["London Borough of Camden", "node/222"],
      ["London", "node/222"],
    ]) {
      const est = await run({ locality, branch }, { ...camden, locality });
      assert.equal(est.priceAtBranch.confirmed, true, `${locality} ${branch}: ${est.priceAtBranch.reason}`);
      assert.equal(est.priceAtBranch.basis, "same-shop");
    }
    // The Camden shop is not in Preston.
    const est = await run(
      { locality: "Preston", branch: "node/222" },
      { ...camden, locality: "Preston" },
      `Open Prices places the branch named (node/222) at NW1 8QP, London, which does not match the locality Preston, so prices seen there do not count for this check. Check the branch and the locality. For a shop in London, enter London or the London borough as the locality. ${RECORD_PRICE}`,
    );
    assert.equal(est.priceAtBranch.confirmed, false);
    // A district rather than the borough is not known to be in London, so
    // it fails closed, and the warning says what to enter.
    const district = await run(
      { locality: "Camden Town", branch: "node/222" },
      { ...camden, locality: "Camden Town" },
      `Open Prices places the branch named (node/222) at NW1 8QP, London, which does not match the locality Camden Town, so prices seen there do not count for this check. Check the branch and the locality. For a shop in London, enter London or the London borough as the locality. ${RECORD_PRICE}`,
    );
    assert.equal(district.priceAtBranch.confirmed, false);
  } finally {
    await a.close();
  }
});

test("a genuine priced Camden check still confirms the price, with no warning", async () => {
  const db = withCamden();
  const a = await app(db);
  try {
    const saved = await a.check({ branch: "Home Bargains, Camden High Street NW1 7JE", pricePence: 1250 });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.branchWarning, null);
    assert.equal(saved.body.branch_postcode, null, "a branch named by postcode needs no id lookup");
    const est = await a.estimate();
    assert.equal(est.priceAtBranch.confirmed, true);
    assert.equal(est.priceAtBranch.basis, "check");
    assert.equal(est.priceAtBranch.price, 1250);
    assert.equal(est.offer.price, 1250);
    assert.equal(est.offer.location, "Home Bargains, Camden High Street NW1 7JE, Camden");
    assert.equal(priceCheck(est).detail, "Shelf price recorded on the branch check");
  } finally {
    await a.close();
  }
});

test("a shop Open Prices does not place fails closed, and the check says why", async () => {
  const db = evidence([
    { id: 700003, title: TITLE, store: "Home Bargains", place: null, city: null, osm_id: "node/333", price: 1200, barcode: GTIN, day: ukDay(0) },
    { id: 700004, title: TITLE, store: "Home Bargains", place: "PR1 2AR", city: null, osm_id: "node/444", price: 1200, barcode: GTIN, day: ukDay(0) },
  ]);
  const a = await app(db);
  try {
    const saved = await a.check({ branch: "node/333" });
    assert.equal(
      saved.body.branchWarning,
      `Open Prices does not say which town the branch named (node/333) is in, so prices seen there do not count for this check in Camden. ${RECORD_PRICE}`,
    );
    const est = await a.estimate({ offer: { provider: "openprices", sourceId: "700003" } });
    assert.equal(est.priceAtBranch.confirmed, false, "naming the shop does not show it is in Camden");
    assert.equal(est.alert.eligible, false);
    assert.match(priceCheck(est).detail, notConfirmedHere("Home Bargains", "Open Prices does not say which town it is in"));

    // A postcode outside London with no town does not place the shop.
    db.prepare("DELETE FROM availability_checks").run();
    const preston = await a.check({ locality: "Preston", branch: "node/444" });
    assert.equal(
      preston.body.branchWarning,
      `Open Prices does not say which town the branch named (node/444) is in (it gives only PR1 2AR), so prices seen there do not count for this check in Preston. ${RECORD_PRICE}`,
    );
    const p = await a.estimate({ offer: { provider: "openprices", sourceId: "700004" }, locality: "Preston" });
    assert.equal(p.priceAtBranch.confirmed, false);
    assert.match(priceCheck(p).detail, notConfirmedHere("Home Bargains, PR1 2AR", "Open Prices gives only PR1 2AR, not which town it is in"));

    // A shelf price on the check still costs the trip.
    await a.check({ branch: "node/333", pricePence: 1300 });
    const priced = await a.estimate({ offer: { provider: "openprices", sourceId: "700003" } });
    assert.equal(priced.priceAtBranch.basis, "check");
    assert.equal(priced.offer.price, 1300);
  } finally {
    await a.close();
  }
});

test("a shop agrees with a locality by its town, or by London borough and London city or postcode", () => {
  const { shopInLocality, shopIsBranch } = audit;
  assert.equal(typeof shopInLocality, "function");
  const cases = [
    // [city, place, locality, verdict]
    ["Preston", "PR1 2AR", "Preston", "agrees"],
    ["Preston", "PR1 2AR", "Preston, Lancashire", "agrees"],
    ["Preston", "PR1 2AR", "preston", "agrees"],
    ["Preston", "PR1 2AR", "Camden", "disagrees"],
    // A city that does not name the town is not shown to be elsewhere: it
    // may be a part of the town (fourth pass; this row was "disagrees").
    ["Preston", "PR1 2AR", "Preston Park", "unknown"],
    ["Stoke-on-Trent", "ST1 1AA", "Stoke on Trent", "agrees"],
    ["London", "NW1 8QP", "Camden", "agrees"],
    ["London", "SE10 9NN", "Royal Borough of Greenwich", "agrees"],
    ["London", "SW6 1AA", "Hammersmith & Fulham", "agrees"],
    ["London", "EC2V 7HH", "City of London", "agrees"],
    ["London", "E8 1HE", "London", "agrees"],
    ["London", "BR1 1AA", "Bromley", "agrees"],
    [null, "NW1 8QP", "Camden", "agrees"],
    [null, "WC2N 5DU", "Westminster", "agrees"],
    ["Croydon", "CR0 1AB", "Croydon", "agrees"],
    ["Croydon", "CR0 1AB", "London", "agrees"],
    // A borough city is not in another borough.
    ["Croydon", "CR0 1AB", "Camden", "disagrees"],
    ["City of Westminster", "W1D 1AA", "Camden", "disagrees"],
    // A London shop is not in a town outside London, and a London postcode
    // contradicts a city elsewhere.
    ["London", "NW1 8QP", "Preston", "disagrees"],
    [null, "NW1 8QP", "Preston", "disagrees"],
    ["Preston", "NW1 8QP", "Preston", "disagrees"],
    // Kingston is not a borough (only Kingston upon Thames is), but it is
    // the post town of KT1, so a KT1 shop is in it; a shop recorded as
    // Kingston upon Hull is not shown to be in it (fourth pass: "unknown",
    // was "disagrees", since only the city speaks against it).
    ["London", "KT1 1AA", "Kingston", "agrees"],
    ["Kingston upon Hull", "HU1 3AA", "Kingston", "unknown"],
    ["London", "NW1 8QP", "Camden Town", "disagrees"],
    // Nothing that places the shop.
    [null, "PR1 2AR", "Preston", "unknown"],
    [null, null, "Camden", "unknown"],
    ["", "  ", "Camden", "unknown"],
  ];
  for (const [city, place, locality, verdict] of cases)
    assert.equal(shopInLocality({ city, place }, locality).verdict, verdict, `${city} | ${place} | ${locality}`);
  assert.equal(shopInLocality({ city: "Preston", place: "PR1 2AR" }, "Camden").where, "PR1 2AR, Preston");
  assert.equal(shopInLocality({ city: null, place: null }, "Camden").where, null);
  assert.equal(shopInLocality({ city: "London", place: "NW1 8QP" }, "Camden Town").inLondon, true);
  assert.equal(shopInLocality({ city: null, place: "SE1 9SG" }, "Preston").inLondon, true);
  assert.equal(shopInLocality({ city: "Preston", place: "PR1 2AR" }, "Camden").inLondon, false);

  const preston = { osm_id: "node/111", store: "Home Bargains", place: "PR1 2AR", city: "Preston" };
  const at = (locality, branch) => ({ retailer: "Home Bargains", locality, branch });
  assert.equal(shopIsBranch(preston, at("Preston", "node/111")), true);
  assert.equal(shopIsBranch(preston, at("Camden", "node/111")), false);
  assert.equal(shopIsBranch(preston, at("Camden", "Home Bargains PR1 2AR")), false);
  assert.equal(shopIsBranch(preston, at("Camden", "https://www.openstreetmap.org/node/111")), false);
  assert.equal(shopIsBranch({ ...preston, city: null, place: null }, at("Preston", "node/111")), false, "unknown location fails closed");
  assert.equal(shopIsBranch(preston, at("Preston", "node/112")), false);
  assert.equal(shopIsBranch(preston, { retailer: "Home Bargains", branch: "node/111" }), false, "no locality never agrees");
});

test("branch_postcode: older tables gain it, and a check recorded before Open Prices knew its shop is matched once it does", async () => {
  const old = new DatabaseSync(":memory:");
  old.exec(`CREATE TABLE availability_checks (id INTEGER PRIMARY KEY, barcode TEXT NOT NULL,
 retailer TEXT NOT NULL, locality TEXT NOT NULL, checked_at TEXT NOT NULL, method TEXT NOT NULL,
 in_stock INTEGER NOT NULL, branch TEXT, price_pence INTEGER)`);
  old.exec("INSERT INTO availability_checks(barcode, retailer, locality, checked_at, method, in_stock, branch) VALUES('5012345678115', 'Home Bargains', 'Camden', '2026-11-01T10:00:00.000Z', 'phone', 1, 'node/222')");
  audit.schema(old);
  audit.schema(old);
  const columns = old.prepare("PRAGMA table_info(availability_checks)").all().map((c) => c.name);
  assert.ok(columns.includes("branch_postcode"));
  assert.equal(old.prepare("SELECT branch_postcode FROM availability_checks").get().branch_postcode, null);

  // Checks recorded while Open Prices knew only the Preston shop.
  const db = evidence();
  const a = await app(db);
  try {
    await a.check({ branch: "Home Bargains, Camden High Street NW1 8QP", pricePence: 1200, checkedAt: ago(3) });
    const byId = await a.check({ branch: "node/222", checkedAt: ago(0.1) });
    assert.equal(byId.body.branch_postcode, null);
    assert.equal((await a.estimate()).priceAtBranch.confirmed, false);
    // Open Prices now records node/222 at NW1 8QP: the stored check is read
    // with that postcode (nothing is written) and is the same branch.
    upsertObservations(db, [{ ...CAMDEN_OP, day: ukDay(1) }], { now: new Date().toISOString() });
    const est = await a.estimate();
    assert.equal(est.priceAtBranch.confirmed, true, est.priceAtBranch.reason);
    assert.equal(est.priceAtBranch.basis, "check");
    assert.equal(db.prepare("SELECT branch_postcode FROM availability_checks WHERE id = ?").get(byId.body.id).branch_postcode, null);
    // Open Prices giving two postcodes for one id resolves to neither.
    upsertObservations(db, [{ ...CAMDEN_OP, id: 700009, place: "NW1 7JE", day: ukDay(0) }], { now: new Date().toISOString() });
    assert.equal((await a.estimate()).priceAtBranch.confirmed, false);
  } finally {
    await a.close();
  }
  // The other way round (third pass): the older priced check names the id,
  // the newer stock check the postcode, so the priced row is read from the
  // shelf (shelfChecks), which fills its postcode the same way.
  const db2 = evidence();
  const b = await app(db2);
  try {
    const byId = await b.check({ branch: "node/222", pricePence: 1200, checkedAt: ago(3) });
    assert.equal(byId.body.branch_postcode, null);
    await b.check({ branch: "Home Bargains, Camden High Street NW1 8QP", checkedAt: ago(0.1) });
    assert.equal((await b.estimate()).priceAtBranch.confirmed, false);
    upsertObservations(db2, [{ ...CAMDEN_OP, day: ukDay(1) }], { now: new Date().toISOString() });
    const est = await b.estimate();
    assert.equal(est.priceAtBranch.confirmed, true, est.priceAtBranch.reason);
    assert.equal(est.priceAtBranch.basis, "check");
    assert.equal(est.priceAtBranch.check.id, byId.body.id);
  } finally {
    await b.close();
  }
});

// ---------------------------------------------------------------------------
// Second pass.

// Open Prices rows for one shop each, £12.00 today.
const shop = (id, osm, place, city) => ({ id, title: TITLE, store: "Home Bargains", place, city, osm_id: osm, price: 1200, barcode: GTIN, day: ukDay(0) });
const CROYDON_OP = shop(700010, "node/333", "CR0 1AB", "London");
const HACKNEY_OP = shop(700011, "node/444", "E8 1HE", "London");
const BROMLEY_OP = shop(700012, "node/555", "BR1 1AA", "London");
const offerOf = (row) => ({ offer: { provider: "openprices", sourceId: String(row.id) } });
const placedAt = (branch, where, locality, detail, tail = RECORD_PRICE) =>
  `Open Prices places the branch named (${branch}) at ${where}, which does not match the locality ${locality}${detail ? ` (${detail})` : ""}, so prices seen there do not count for this check. Check the branch and the locality. ${tail}`;
// The warning when only a city that does not name the town speaks against
// it (fourth pass).
const recordedUnder = (branch, city, locality, tail = RECORD_PRICE) =>
  `Open Prices records the branch named (${branch}) under ${city}, which does not show it is in ${locality}, so prices seen there do not count for this check. ${tail}`;

// A bounty for the estimate in a locality, a member there opted in, the
// alerts and a claim for one unit.
async function bountyTrip(a, db, locality, over, retailer = "Home Bargains") {
  const created = await a.call("POST", "/api/bounties", {
    title: "Speaker",
    locality,
    retailer,
    salesPerWeek: 10,
    sellWindowWeeks: 2,
    expiresAt: new Date(Date.now() + 5 * DAY).toISOString(),
    sponsored: false,
    estimate: request({ locality, ...over }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.bounty.id;
  const member = (
    await a.call("POST", "/api/members", {
      name: "Ann " + locality,
      alertsOptIn: true,
      alertLocalities: [locality],
      paidTier: "diamond",
      paidUntil: new Date(Date.now() + 200 * DAY).toISOString().slice(0, 10),
      transport: "Car",
      carryKg: 25,
      storageUnits: 50,
    })
  ).body.member;
  const sent = await a.call("POST", `/api/bounties/${id}/alerts`, {});
  assert.equal(sent.status, 200);
  const claimed = await a.call("POST", `/api/bounties/${id}/claims`, {
    memberId: member.id,
    units: 1,
    journeyCost: 0,
    journeyMinutes: 15,
    cashAvailable: 100000,
  });
  return { created, sent: sent.body.sent, claimed, claims: db.prepare("SELECT COUNT(*) AS n FROM claims WHERE bounty_id = ?").get(id).n };
}

test("London: a borough check that names a shop in another borough leaves the price unconfirmed, sends no alert and takes no claim", async () => {
  const db = evidence([CROYDON_OP, HACKNEY_OP, BROMLEY_OP, { ...CAMDEN_OP, day: ukDay(1) }]);
  const a = await app(db);
  // detail: why the postcode is not in the borough, in the warning and the
  // estimate's reason alike.
  const run = async (locality, branch, row, detail) => {
    db.prepare("DELETE FROM availability_checks").run();
    const saved = await a.check({ locality, branch });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal(saved.body.branchWarning, placedAt(branch, `${row.place}, ${row.city}`, locality, detail), `${locality} | ${branch}`);
    const est = await a.estimate({ ...offerOf(row), locality });
    assert.equal(est.stock.confirmed, true, "the check still confirms the stock it saw");
    assert.equal(est.priceAtBranch.confirmed, false, `${locality} | ${branch}`);
    assert.equal(est.priceAtBranch.basis, null);
    assert.equal(est.alert.eligible, false);
    assert.equal(est.opportunity.tier, "Review");
    assert.match(priceCheck(est).detail, notConfirmedHere(`Home Bargains, ${row.place}, ${row.city}`, outside(locality, detail)));
    return est;
  };
  try {
    // The verifier's L1, L2 and L3: Open Prices gives the city as London,
    // but the postcode district is not in the check's borough.
    await run("Camden", "node/333", CROYDON_OP, "the CR0 postcode district is in Croydon, Merton or Sutton");
    await run("Camden", "node/444", HACKNEY_OP, "the E8 postcode district is in Hackney, Islington or Tower Hamlets");
    await run("Croydon", "node/222", { ...CAMDEN_OP, id: 700002 }, "the NW1 postcode district is in Camden or Westminster");
    await run("Hillingdon", "node/555", BROMLEY_OP, "the BR1 postcode district is in Bromley or Lewisham");
    // Named by retailer and postcode instead of id.
    await run("Camden", "Home Bargains CR0 1AB", CROYDON_OP, "the CR0 postcode district is in Croydon, Merton or Sutton");

    // L1 through a bounty: no alert, and the claim is refused.
    db.prepare("DELETE FROM availability_checks").run();
    await a.check({ branch: "node/333", method: "phone" });
    const trip = await bountyTrip(a, db, "Camden", offerOf(CROYDON_OP));
    assert.match(trip.created.body.message, /cannot send alerts or take claims/);
    assert.deepEqual(trip.sent, []);
    assert.equal(trip.claimed.status, 409);
    assert.match(
      trip.claimed.body.error,
      notConfirmedHere("Home Bargains, CR0 1AB, London", outside("Camden", "the CR0 postcode district is in Croydon, Merton or Sutton"), false),
    );
    assert.equal(trip.claims, 0);

    // A shelf price recorded on that Camden check still costs the trip.
    db.prepare("DELETE FROM availability_checks").run();
    const priced = await a.check({ branch: "node/333", pricePence: 1250 });
    assert.equal(
      priced.body.branchWarning,
      placedAt("node/333", "CR0 1AB, London", "Camden", "the CR0 postcode district is in Croydon, Merton or Sutton", PRICE_APPLIES),
    );
    const est = await a.estimate(offerOf(CROYDON_OP));
    assert.equal(est.priceAtBranch.basis, "check");
    assert.equal(est.offer.price, 1250);
  } finally {
    await a.close();
  }
});

test("London: a shop placed only in London, or a locality with no fixed boundary, fails closed with a reason", async () => {
  const LONDON_ONLY = shop(700013, "node/777", null, "London");
  const CROYDON_CITY = shop(700014, "node/666", "CR0 1AB", "Croydon");
  const db = evidence([LONDON_ONLY, CROYDON_CITY, { ...CAMDEN_OP, day: ukDay(1) }]);
  const a = await app(db);
  const run = async (locality, branch, row, warning) => {
    db.prepare("DELETE FROM availability_checks").run();
    const saved = await a.check({ locality, branch });
    assert.equal(saved.body.branchWarning, warning, `${locality} | ${branch}`);
    const est = await a.estimate({ ...offerOf(row), locality });
    assert.equal(est.priceAtBranch.confirmed, false, `${locality} | ${branch}`);
    assert.equal(est.alert.eligible, false);
    return est;
  };
  try {
    // City London and no postcode: in London, but not shown to be in Camden.
    const londonOnly = await run(
      "Camden",
      "node/777",
      LONDON_ONLY,
      `Open Prices places the branch named (node/777) at London, which does not show it is in Camden, so prices seen there do not count for this check. ${RECORD_PRICE}`,
    );
    assert.match(
      priceCheck(londonOnly).detail,
      notConfirmedHere("Home Bargains, London", "Open Prices places it at London, which does not show it is in Camden"),
    );
    // "North London" has no boundary to check a shop against, so neither the
    // Croydon shop nor the Camden one is shown to be in it.
    for (const [branch, row, where] of [
      ["node/666", CROYDON_CITY, "CR0 1AB, Croydon"],
      ["node/222", { ...CAMDEN_OP, id: 700002 }, "NW1 8QP, London"],
    ]) {
      const est = await run(
        "North London",
        branch,
        row,
        `Open Prices places the branch named (${branch}) at ${where}, but North London is not a London borough, so that does not show the branch is there, and prices seen there do not count for this check. Enter the London borough, or London, as the locality. ${RECORD_PRICE}`,
      );
      assert.match(
        priceCheck(est).detail,
        notConfirmedHere(`Home Bargains, ${where}`, "North London is not a London borough, so Open Prices does not show the shop is there"),
      );
    }
    // London as a whole takes any London shop with a London postcode or city.
    db.prepare("DELETE FROM availability_checks").run();
    await a.check({ locality: "London", branch: "node/777" });
    const london = await a.estimate({ ...offerOf(LONDON_ONLY), locality: "London" });
    assert.equal(london.priceAtBranch.confirmed, true, london.priceAtBranch.reason);
    assert.equal(london.priceAtBranch.basis, "same-shop");
  } finally {
    await a.close();
  }
});

test("London: a shop in the check's own borough, or in London for a London check, still confirms, sends an alert and takes a claim", async () => {
  const LEWISHAM_BR1 = shop(700015, "node/888", "BR1 5AA", "Bromley");
  const KINGSTON_KT5 = shop(700016, "node/999", "KT5 8AA", "London");
  const db = evidence([CROYDON_OP, LEWISHAM_BR1, KINGSTON_KT5, { ...CAMDEN_OP, day: ukDay(1) }]);
  const a = await app(db);
  const run = async (locality, branch, row) => {
    db.prepare("DELETE FROM availability_checks").run();
    const saved = await a.check({ locality, branch });
    assert.equal(saved.body.branchWarning, null, `${locality} | ${branch}`);
    const est = await a.estimate({ ...offerOf(row), locality });
    assert.equal(est.priceAtBranch.confirmed, true, `${locality} | ${branch}: ${est.priceAtBranch.reason}`);
    assert.equal(est.priceAtBranch.basis, "same-shop");
    assert.equal(priceCheck(est).detail, "Price seen at the same shop the branch check covers");
    assert.equal(est.alert.eligible, true, JSON.stringify(est.alert.reasons));
  };
  try {
    await run("Croydon", "node/333", CROYDON_OP);
    await run("London Borough of Croydon", "Home Bargains CR0 1AB", CROYDON_OP);
    await run("London", "node/333", CROYDON_OP);
    await run("Camden", "node/222", { ...CAMDEN_OP, id: 700002 });
    await run("Camden, London", "node/222", { ...CAMDEN_OP, id: 700002 });
    // BR1 has addresses in Lewisham, and Bromley is the post town there.
    await run("Lewisham", "node/888", LEWISHAM_BR1);
    // KT5 (Surbiton) is in the Royal Borough of Kingston upon Thames.
    await run("Royal Borough of Kingston upon Thames", "node/999", KINGSTON_KT5);

    db.prepare("DELETE FROM availability_checks").run();
    await a.check({ locality: "Croydon", branch: "node/333", method: "phone" });
    const trip = await bountyTrip(a, db, "Croydon", offerOf(CROYDON_OP));
    assert.doesNotMatch(trip.created.body.message, /cannot send alerts/);
    assert.equal(trip.sent.length, 1);
    assert.equal(trip.claimed.status, 201, JSON.stringify(trip.claimed.body));
    assert.equal(trip.claims, 1);
  } finally {
    await a.close();
  }
});

test("towns Open Prices records by their long names: a Newcastle check naming a Newcastle upon Tyne shop confirms the price, sends an alert and takes a claim", async () => {
  const towns = [
    ["Newcastle", shop(700501, "node/501", "NE1 7RU", "Newcastle upon Tyne")],
    ["Hull", shop(700502, "node/502", "HU1 3AA", "Kingston upon Hull")],
    ["Brighton", shop(700503, "node/503", "BN1 1AA", "Brighton and Hove")],
    ["Hove", shop(700507, "node/507", "BN3 1AA", "Brighton and Hove")],
    ["Southend", shop(700504, "node/504", "SS1 1AA", "Southend-on-Sea")],
    ["Stoke", shop(700505, "node/505", "ST1 1AA", "Stoke-on-Trent")],
    ["Edinburgh", shop(700506, "node/506", "EH1 1AA", "City of Edinburgh")],
  ];
  const UNDER_LYME = shop(700508, "node/508", "ST5 1AA", "Newcastle-under-Lyme");
  const db = evidence([...towns.map(([, row]) => row), UNDER_LYME]);
  const a = await app(db);
  try {
    for (const [locality, row] of towns) {
      db.prepare("DELETE FROM availability_checks").run();
      const saved = await a.check({ locality, branch: row.osm_id });
      assert.equal(saved.body.branchWarning, null, locality);
      const est = await a.estimate({ ...offerOf(row), locality });
      assert.equal(est.priceAtBranch.confirmed, true, `${locality}: ${est.priceAtBranch.reason}`);
      assert.equal(est.priceAtBranch.basis, "same-shop");
      assert.equal(est.alert.eligible, true, locality);
    }
    // The verifier's L4 through a bounty.
    db.prepare("DELETE FROM availability_checks").run();
    await a.check({ locality: "Newcastle", branch: "node/501", method: "phone" });
    const trip = await bountyTrip(a, db, "Newcastle", offerOf(towns[0][1]));
    assert.equal(trip.sent.length, 1);
    assert.equal(trip.claimed.status, 201, JSON.stringify(trip.claimed.body));

    // A short name stands for one town only: Newcastle is not
    // Newcastle-under-Lyme, and Kingston is not Kingston upon Hull. Only the
    // city speaks against them, so since the fourth pass the warning says
    // it does not show the shop is there, not that it is elsewhere.
    for (const [locality, row] of [
      ["Newcastle", UNDER_LYME],
      ["Kingston", towns[1][1]],
    ]) {
      db.prepare("DELETE FROM availability_checks").run();
      const saved = await a.check({ locality, branch: row.osm_id });
      assert.equal(saved.body.branchWarning, recordedUnder(row.osm_id, row.city, locality), locality);
      const est = await a.estimate({ ...offerOf(row), locality });
      assert.equal(est.priceAtBranch.confirmed, false, locality);
      assert.match(
        priceCheck(est).detail,
        notConfirmedHere(`Home Bargains, ${row.place}, ${row.city}`, `Open Prices records it under ${row.city}, which does not show it is in ${locality}`),
      );
    }
  } finally {
    await a.close();
  }
});

test("outer London post towns: a Havering check naming a Romford shop, and a Romford check naming an RM1 shop recorded as London, confirm; another post town does not", async () => {
  const ROMFORD_CITY = shop(700601, "node/601", "RM1 3AA", "Romford");
  const ROMFORD_LONDON = shop(700602, "node/602", "RM1 3AB", "London");
  const DAGENHAM = shop(700603, "node/603", "RM8 1AA", "London");
  const db = evidence([ROMFORD_CITY, ROMFORD_LONDON, DAGENHAM, HACKNEY_OP]);
  const a = await app(db);
  const run = async (locality, row) => {
    db.prepare("DELETE FROM availability_checks").run();
    const saved = await a.check({ locality, branch: row.osm_id });
    const est = await a.estimate({ ...offerOf(row), locality });
    return { warning: saved.body.branchWarning, confirmed: est.priceAtBranch.confirmed, basis: est.priceAtBranch.basis };
  };
  try {
    assert.deepEqual(await run("Havering", ROMFORD_CITY), { warning: null, confirmed: true, basis: "same-shop" });
    assert.deepEqual(await run("Romford", ROMFORD_LONDON), { warning: null, confirmed: true, basis: "same-shop" });
    assert.deepEqual(await run("Romford", ROMFORD_CITY), { warning: null, confirmed: true, basis: "same-shop" });
    assert.deepEqual(await run("Romford", DAGENHAM), {
      warning: placedAt("node/603", "RM8 1AA, London", "Romford", "the RM8 postcode district is in Dagenham"),
      confirmed: false,
      basis: null,
    });
    assert.deepEqual(await run("Romford", HACKNEY_OP), {
      warning: placedAt("node/444", "E8 1HE, London", "Romford", "E8 1HE is not in Romford"),
      confirmed: false,
      basis: null,
    });
  } finally {
    await a.close();
  }
});

test("a typed postcode that differs from the id's resolved postcode never matches the typed postcode (the verifier's S2)", async () => {
  // Both readings: the row's own postcode is unknown, so it matches only by id.
  assert.equal(audit.sameBranch({ branch: "node/1 NW5 2AA", branch_postcode: "NW1 8QP" }, { branch: "Home Bargains NW5 2AA" }), false);
  assert.equal(audit.sameBranch({ branch: "Home Bargains NW5 2AA" }, { branch: "node/1 NW5 2AA", branch_postcode: "NW1 8QP" }), false);
  assert.equal(audit.sameBranch({ branch: "node/1 NW5 2AA", branch_postcode: "NW1 8QP" }, { branch: "node/1" }), true, "the id still matches");
  assert.equal(audit.sameBranch({ branch: "node/1 NW1 8QP", branch_postcode: "NW1 8QP" }, { branch: "Home Bargains NW1 8QP" }), true);

  const db = withCamden();
  const a = await app(db);
  try {
    await a.check({ branch: "Home Bargains NW5 2AA", pricePence: 1150, checkedAt: ago(3) });
    const newer = await a.check({ branch: "node/222 NW5 2AA", checkedAt: ago(0.1) });
    assert.equal(newer.body.branch_postcode, "NW1 8QP");
    const est = await a.estimate();
    assert.equal(est.stock.check.id, newer.body.id);
    assert.equal(est.priceAtBranch.confirmed, false, "the newer check names two shops, so the older shelf price is not shown to be its branch's");
    assert.equal(est.priceAtBranch.basis, null);
    assert.equal(est.alert.eligible, false);
  } finally {
    await a.close();
  }
});

test("shopInLocality and branchPlace: London boroughs by postcode district, long town names, and why a named shop does not count", () => {
  const { shopInLocality, branchPlace } = audit;
  assert.equal(typeof branchPlace, "function");
  const cases = [
    // [city, place, locality, verdict]
    ["London", "CR0 1AB", "Camden", "disagrees"],
    ["London", "E8 1HE", "Camden", "disagrees"],
    ["London", "N16 0AA", "Camden", "disagrees"],
    ["London", "N1 9AA", "Camden", "agrees"],
    ["London", "NW1 8QP", "Croydon", "disagrees"],
    ["London", "BR1 1AA", "Hillingdon", "disagrees"],
    ["Camden", "CR0 1AB", "Camden", "disagrees"],
    ["Bromley", "BR1 5AA", "Lewisham", "agrees"],
    ["Croydon", "CR0 1AB", "Croydon", "agrees"],
    ["London", null, "Camden", "unknown"],
    ["London", null, "London", "agrees"],
    ["London", "PR1 2AR", "London", "disagrees"],
    ["Croydon", "CR0 1AB", "North London", "unknown"],
    ["London", "NW1 8QP", "Central London", "unknown"],
    ["Preston", "PR1 2AR", "North London", "disagrees"],
    ["Romford", "RM1 3AA", "Havering", "agrees"],
    ["Romford", null, "Havering", "unknown"],
    ["London", "RM1 3AA", "Romford", "agrees"],
    ["London", "RM8 1AA", "Romford", "disagrees"],
    // DA1 1 is Dartford itself, outside Greater London, though DA1 has
    // Bexley addresses (DA1 4 is Crayford). Round 3 changed this row from
    // "agrees": that was the verifier's defect.
    ["Dartford", "DA1 1AA", "Bexley", "disagrees"],
    ["Crayford", "DA1 4HS", "Bexley", "agrees"],
    ["Dartford", "DA2 6AA", "London", "disagrees"],
    ["Dartford", "DA2 6AA", "Dartford", "agrees"],
    ["Newcastle upon Tyne", "NE1 7RU", "Newcastle", "agrees"],
    ["Newcastle upon Tyne", "NE1 7RU", "Newcastle upon Tyne", "agrees"],
    // Fourth pass: "unknown", was "disagrees" (only the city speaks against it).
    ["Newcastle-under-Lyme", "ST5 1AA", "Newcastle", "unknown"],
    ["Kingston upon Hull", "HU1 3AA", "Hull", "agrees"],
    ["Brighton and Hove", "BN1 1AA", "Brighton", "agrees"],
    ["Brighton", "BN1 1AA", "Brighton and Hove", "agrees"],
    ["Southend-on-Sea", "SS1 1AA", "Southend", "agrees"],
    ["Stoke-on-Trent", "ST1 1AA", "Stoke", "agrees"],
    // A short city does not stand for the long name: this Stoke is in
    // Plymouth. Fourth pass: "unknown", was "disagrees".
    ["Stoke", "PL3 4AA", "Stoke-on-Trent", "unknown"],
    ["City of Edinburgh", "EH1 1AA", "Edinburgh", "agrees"],
    ["Glasgow City", "G1 1AA", "Glasgow", "agrees"],
  ];
  for (const [city, place, locality, verdict] of cases)
    assert.equal(shopInLocality({ city, place }, locality).verdict, verdict, `${city} | ${place} | ${locality}`);
  assert.deepEqual(shopInLocality({ city: "London", place: "CR0 1AB" }, "Camden"), {
    verdict: "disagrees",
    where: "CR0 1AB, London",
    inLondon: true,
    locality: "borough",
    cause: "elsewhere",
    detail: "the CR0 postcode district is in Croydon, Merton or Sutton",
  });
  assert.equal(shopInLocality({ city: "Preston", place: "PR1 2AR" }, "Camden").detail, null, "the city shows where it is");

  const at = (locality, branch) => ({ retailer: "Home Bargains", locality, branch });
  const preston = { osm_id: "node/111", store: "Home Bargains", place: "PR1 2AR", city: "Preston" };
  const text = (row, locality) => branchPlace(row, at(locality, row.osm_id))?.text;
  assert.equal(branchPlace(preston, at("Camden", "node/112")), null, "a shop the check does not name");
  assert.equal(branchPlace(preston, at("Preston", "node/111")).verdict, "agrees");
  assert.equal(text(preston, "Preston"), null);
  assert.equal(text(preston, "Camden"), "Open Prices places it outside Camden");
  assert.equal(
    text({ ...preston, place: "CR0 1AB", city: "London" }, "Camden"),
    "Open Prices places it outside Camden (the CR0 postcode district is in Croydon, Merton or Sutton)",
  );
  assert.equal(text({ ...preston, place: null, city: null }, "Camden"), "Open Prices does not say which town it is in");
  assert.equal(text({ ...preston, city: null }, "Preston"), "Open Prices gives only PR1 2AR, not which town it is in");
  assert.equal(text({ ...preston, place: null, city: "London" }, "Camden"), "Open Prices places it at London, which does not show it is in Camden");
  assert.equal(
    text({ ...preston, place: "NW1 8QP", city: "London" }, "North London"),
    "North London is not a London borough, so Open Prices does not show the shop is there",
  );
});

// ---------------------------------------------------------------------------
// Third pass.

const shopAt = (id, osm, place, city, store) => ({ ...shop(id, osm, place, city), store });
// Real Open Prices locations (prices.openfoodfacts.org, fetched 2026-11-01).
const ACTON_MORRISONS = shopAt(700801, "way/26295319", "W3 9LA", "Acton", "Morrisons"); // Ealing
const WOOD_GREEN_SAINSBURYS = shopAt(700802, "way/191473149", "N22 6BX", "Wood Green", "Sainsbury's"); // Haringey
const EPSOM_LIDL = shopAt(700811, "node/9665642559", "KT17 4ER", "Epsom", "Lidl"); // Epsom and Ewell, Surrey
const EPSOM_TESCO = shopAt(700812, "node/6186419999", "KT19 8EU", "Epsom", "Tesco Express"); // Epsom and Ewell
const DARTFORD_CURRY = shopAt(700813, "way/833065595", "DA1 1BX", "Dartford", "Kent Curry"); // Dartford, Kent

// A check in a locality naming a shop, then the estimate for that shop.
async function checkAndEstimate(a, db, { locality, row, branch = row.osm_id, warning }) {
  db.prepare("DELETE FROM availability_checks").run();
  const saved = await a.check({ locality, branch, retailer: row.store });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  if (warning !== undefined) assert.equal(saved.body.branchWarning, warning, `${locality} | ${branch}`);
  return a.estimate({ ...offerOf(row), locality });
}
const confirmedSameShop = (est, what) => {
  assert.equal(est.priceAtBranch.confirmed, true, `${what}: ${est.priceAtBranch.reason}`);
  assert.equal(est.priceAtBranch.basis, "same-shop", what);
  assert.equal(priceCheck(est).detail, "Price seen at the same shop the branch check covers");
  assert.equal(est.alert.eligible, true, `${what}: ${JSON.stringify(est.alert.reasons)}`);
};
// why: branchPlace's clause, as the estimate's reason gives it.
const notConfirmed = (est, row, why) => {
  assert.equal(est.stock.confirmed, true, "the check still confirms the stock it saw");
  assert.equal(est.priceAtBranch.confirmed, false, why);
  assert.equal(est.priceAtBranch.basis, null);
  assert.equal(est.alert.eligible, false);
  assert.equal(est.opportunity.tier, "Review");
  assert.match(priceCheck(est).detail, notConfirmedHere(`${row.store}, ${row.place}, ${row.city}`, why));
};
const vagueClause = (locality) => `${locality} is not a London borough, so Open Prices does not show the shop is there`;
// A bounty trip on its own database (one bounty per barcode is open at a
// time), after a phone check in the locality naming the shop.
async function freshTrip(observations, locality, row, branch = row.osm_id) {
  const db = evidence(observations);
  const a = await app(db);
  try {
    const saved = await a.check({ locality, branch, retailer: row.store, method: "phone" });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    return await bountyTrip(a, db, locality, offerOf(row), row.store);
  } finally {
    await a.close();
  }
}
const vagueWarning = (branch, where, locality) =>
  `Open Prices places the branch named (${branch}) at ${where}, but ${locality} is not a London borough, so that does not show the branch is there, and prices seen there do not count for this check. Enter the London borough, or London, as the locality. ${RECORD_PRICE}`;

test("'<place>, London': Romford, Stratford, Camden Town or Acton followed by London is not all of London, so the Croydon shop is not their branch; Romford, London takes a Romford shop", async () => {
  const ROMFORD_RM1 = shop(700701, "node/701", "RM1 3AA", "London");
  const db = evidence([CROYDON_OP, ROMFORD_RM1]);
  const a = await app(db);
  try {
    // The verifier's cases: each was read as all of London, so the CR0 shop
    // counted, the Romford bounty alerted and Ann's claim was accepted.
    const CR0 = "the CR0 postcode district is in Croydon";
    for (const [locality, warning, why] of [
      ["Romford, London", placedAt("node/333", "CR0 1AB, London", "Romford, London", CR0), outside("Romford, London", CR0)],
      ["Stratford, London", vagueWarning("node/333", "CR0 1AB, London", "Stratford, London"), vagueClause("Stratford, London")],
      ["Camden Town, London", vagueWarning("node/333", "CR0 1AB, London", "Camden Town, London"), vagueClause("Camden Town, London")],
      ["Acton, London", vagueWarning("node/333", "CR0 1AB, London", "Acton, London"), vagueClause("Acton, London")],
      ["Romford, Greater London", placedAt("node/333", "CR0 1AB, London", "Romford, Greater London", CR0), outside("Romford, Greater London", CR0)],
    ])
      notConfirmed(await checkAndEstimate(a, db, { locality, row: CROYDON_OP, warning }), CROYDON_OP, why);

    // London on its own (or with the country), a borough followed by London,
    // and an outer post town followed by London or its county still confirm.
    for (const [locality, row] of [
      ["London, UK", CROYDON_OP],
      ["Greater London", CROYDON_OP],
      ["Croydon, London", CROYDON_OP],
      ["Romford, London", ROMFORD_RM1],
      ["Romford, Essex", ROMFORD_RM1],
    ])
      confirmedSameShop(await checkAndEstimate(a, db, { locality, row, warning: null }), locality);
  } finally {
    await a.close();
  }
  // Through bounties: no alert and no claim for the Croydon shop; the Romford one does both.
  for (const locality of ["Romford, London", "Stratford, London"]) {
    const trip = await freshTrip([CROYDON_OP], locality, CROYDON_OP);
    assert.match(trip.created.body.message, /cannot send alerts or take claims/, locality);
    assert.deepEqual(trip.sent, [], locality);
    assert.equal(trip.claimed.status, 409, locality);
    assert.equal(trip.claims, 0);
  }
  const romford = await freshTrip([ROMFORD_RM1], "Romford, London", ROMFORD_RM1);
  assert.equal(romford.sent.length, 1);
  assert.equal(romford.claimed.status, 201, JSON.stringify(romford.claimed.body));
  assert.equal(romford.claims, 1);
});

test("a London shop Open Prices records under a district name (the real Acton Morrisons and Wood Green Sainsbury's) confirms for its borough and for London, sends an alert and takes a claim", async () => {
  const WALTHAMSTOW = shop(700803, "node/803", "E17 7JR", "Walthamstow");
  const CRAYFORD = shop(700804, "node/804", "DA1 4HS", "Crayford");
  const ACTON_ONLY = shop(700805, "node/805", null, "Acton");
  const db = evidence([ACTON_MORRISONS, WOOD_GREEN_SAINSBURYS, WALTHAMSTOW, CRAYFORD, ACTON_ONLY]);
  const a = await app(db);
  try {
    for (const [locality, row, branch] of [
      ["Ealing", ACTON_MORRISONS],
      ["London", ACTON_MORRISONS],
      ["Haringey", WOOD_GREEN_SAINSBURYS],
      ["Haringey", WOOD_GREEN_SAINSBURYS, "Sainsbury's N22 6BX"],
      ["London", WOOD_GREEN_SAINSBURYS],
      ["Waltham Forest", WALTHAMSTOW],
      // DA1 4 is Crayford, in Bexley, though most of DA1 is Dartford.
      ["Bexley", CRAYFORD],
    ])
      confirmedSameShop(await checkAndEstimate(a, db, { locality, row, branch, warning: null }), `${locality} | ${row.osm_id}`);

    // The postcode still decides: W3 is not in Camden. Without a postcode a
    // district name does not show the shop is in the borough.
    const W3 = "the W3 postcode district is in Ealing, Hammersmith and Fulham or Hounslow";
    notConfirmed(
      await checkAndEstimate(a, db, { locality: "Camden", row: ACTON_MORRISONS, warning: placedAt("way/26295319", "W3 9LA, Acton", "Camden", W3) }),
      ACTON_MORRISONS,
      outside("Camden", W3),
    );
    const noPostcode = await checkAndEstimate(a, db, {
      locality: "Ealing",
      row: ACTON_ONLY,
      warning: `Open Prices places the branch named (node/805) at Acton, which does not show it is in Ealing, so prices seen there do not count for this check. ${RECORD_PRICE}`,
    });
    assert.equal(noPostcode.priceAtBranch.confirmed, false);
    assert.equal(noPostcode.alert.eligible, false);
  } finally {
    await a.close();
  }
  for (const [locality, row] of [
    ["Ealing", ACTON_MORRISONS],
    ["Haringey", WOOD_GREEN_SAINSBURYS],
  ]) {
    const trip = await freshTrip([row], locality, row);
    assert.doesNotMatch(trip.created.body.message, /cannot send alerts/, locality);
    assert.equal(trip.sent.length, 1, locality);
    assert.equal(trip.claimed.status, 201, JSON.stringify(trip.claimed.body));
    assert.equal(trip.claims, 1);
  }
});

test("shops outside Greater London in districts that cross the boundary (the real Epsom Lidl and Tesco Express, the Dartford Kent Curry) are not the branch of a borough or London check; the London side of the same district still is", async () => {
  const BRENTWOOD = shop(700821, "node/821", "CM14 4AA", "Brentwood");
  const LEATHERHEAD = shop(700822, "node/822", "KT22 7AA", "Leatherhead");
  const WALTHAM_CROSS = shop(700823, "node/823", "EN8 7AA", "Waltham Cross");
  const SEVENOAKS = shop(700824, "node/824", "TN14 5AA", "Sevenoaks");
  const SUTTON_SIDE = shop(700825, "node/825", "KT17 2DF", "Epsom"); // KT17 2DF is in Sutton
  const SM2_SUTTON = shop(700826, "node/826", "SM2 5AA", "Sutton");
  const SM2_BANSTEAD = shop(700827, "node/827", "SM2 5PA", "Sutton"); // Reigate and Banstead
  const KT4_UNLISTED = shop(700828, "node/828", "KT4 0AA", "London"); // no KT4 0 sector in the directory
  const rows = [EPSOM_LIDL, EPSOM_TESCO, DARTFORD_CURRY, BRENTWOOD, LEATHERHEAD, WALTHAM_CROSS, SEVENOAKS, SUTTON_SIDE, SM2_SUTTON, SM2_BANSTEAD, KT4_UNLISTED];
  const db = evidence(rows);
  const a = await app(db);
  try {
    for (const [locality, row] of [
      ["Sutton", EPSOM_LIDL],
      ["London", EPSOM_LIDL],
      ["Kingston upon Thames", EPSOM_TESCO],
      ["London", EPSOM_TESCO],
      ["Bexley", DARTFORD_CURRY],
      ["London", DARTFORD_CURRY],
      ["Havering", BRENTWOOD],
      ["Kingston upon Thames", LEATHERHEAD],
      ["Enfield", WALTHAM_CROSS],
      ["Bromley", SEVENOAKS],
      ["Sutton", SM2_BANSTEAD],
    ]) {
      const where = `${row.place}, ${row.city}`;
      const detail = `${row.place} is outside Greater London`;
      const warning = placedAt(row.osm_id, where, locality, detail);
      notConfirmed(await checkAndEstimate(a, db, { locality, row, warning }), row, outside(locality, detail));
    }
    // A sector the postcode directory does not have, in a district on the
    // boundary, does not place the shop either way.
    const unlisted = await checkAndEstimate(a, db, {
      locality: "Sutton",
      row: KT4_UNLISTED,
      warning: `Open Prices places the branch named (node/828) at KT4 0AA, London, which does not show it is in Sutton (the KT4 postcode district crosses the Greater London boundary), so prices seen there do not count for this check. ${RECORD_PRICE}`,
    });
    assert.equal(unlisted.priceAtBranch.confirmed, false);
    assert.equal(unlisted.alert.eligible, false);
    // Their own towns, and the London side of the same districts.
    for (const [locality, row] of [
      ["Epsom", EPSOM_LIDL],
      ["Dartford", DARTFORD_CURRY],
      ["Sutton", SUTTON_SIDE],
      ["London", SUTTON_SIDE],
      ["Sutton", SM2_SUTTON],
    ])
      confirmedSameShop(await checkAndEstimate(a, db, { locality, row, warning: null }), `${locality} | ${row.place}`);
  } finally {
    await a.close();
  }
  // The verifier's bounty: no alert, and Ann's claim is refused.
  for (const [locality, row] of [
    ["Sutton", EPSOM_LIDL],
    ["London", EPSOM_LIDL],
    ["Bexley", DARTFORD_CURRY],
  ]) {
    const trip = await freshTrip([row], locality, row);
    assert.deepEqual(trip.sent, [], locality);
    assert.equal(trip.claimed.status, 409, locality);
    assert.equal(trip.claims, 0);
  }
  const sutton = await freshTrip([SM2_SUTTON], "Sutton", SM2_SUTTON);
  assert.equal(sutton.sent.length, 1);
  assert.equal(sutton.claimed.status, 201, JSON.stringify(sutton.claimed.body));
});

test("post towns listed twice for a district: a Croydon check naming a Purley shop (CR8) confirms, sends an alert and takes a claim; Purley, Kenley, Greenford, Southall and West Drayton checks take their districts", async () => {
  const PURLEY = shop(700901, "node/901", "CR8 2AA", "Purley");
  const CR8_LONDON = shop(700902, "node/902", "CR8 2AB", "London");
  const UB5_GREENFORD = shop(700903, "node/903", "UB5 5AA", "Greenford");
  const UB5_LONDON = shop(700906, "node/906", "UB5 5AB", "London");
  const UB3_LONDON = shop(700904, "node/904", "UB3 1AA", "London");
  const UB8_LONDON = shop(700905, "node/905", "UB8 1AA", "London");
  const db = evidence([PURLEY, CR8_LONDON, UB5_GREENFORD, UB5_LONDON, UB3_LONDON, UB8_LONDON]);
  const a = await app(db);
  try {
    for (const [locality, row] of [
      ["Croydon", PURLEY],
      ["Purley", PURLEY],
      ["Purley", CR8_LONDON],
      ["Kenley", CR8_LONDON],
      ["Greenford", UB5_GREENFORD],
      ["Northolt", UB5_LONDON],
      ["Southall", UB3_LONDON],
      ["Hayes", UB3_LONDON],
      ["West Drayton", UB8_LONDON],
      ["Uxbridge", UB8_LONDON],
    ])
      confirmedSameShop(await checkAndEstimate(a, db, { locality, row, warning: null }), `${locality} | ${row.place}`);
    // Another post town's district still contradicts.
    const CR8 = "the CR8 postcode district is in Kenley or Purley";
    notConfirmed(
      await checkAndEstimate(a, db, { locality: "Romford", row: CR8_LONDON, warning: placedAt("node/902", "CR8 2AB, London", "Romford", CR8) }),
      CR8_LONDON,
      outside("Romford", CR8),
    );
  } finally {
    await a.close();
  }
  const trip = await freshTrip([PURLEY], "Croydon", PURLEY);
  assert.equal(trip.sent.length, 1);
  assert.equal(trip.claimed.status, 201, JSON.stringify(trip.claimed.body));
  assert.equal(trip.claims, 1);
});

test("a city that names another borough contradicts a borough check: a Camden check naming an NW1 shop Open Prices records as Westminster stays unconfirmed, with a warning (the verifier's M21)", async () => {
  const NW1_WESTMINSTER = shop(700951, "node/951", "NW1 5AA", "Westminster");
  const NW1_CITY_OF_WESTMINSTER = shop(700952, "node/952", "NW1 5AB", "City of Westminster");
  const NW1_CAMDEN = shop(700953, "node/953", "NW1 5AD", "Camden");
  const db = evidence([NW1_WESTMINSTER, NW1_CITY_OF_WESTMINSTER, NW1_CAMDEN, { ...CAMDEN_OP, day: ukDay(1) }]);
  const a = await app(db);
  try {
    // NW1 has addresses in Camden and in Westminster, so the postcode alone
    // would agree; the city says which.
    for (const row of [NW1_WESTMINSTER, NW1_CITY_OF_WESTMINSTER])
      notConfirmed(
        await checkAndEstimate(a, db, { locality: "Camden", row, warning: placedAt(row.osm_id, `${row.place}, ${row.city}`, "Camden", null) }),
        row,
        outside("Camden"),
      );
    for (const [locality, row] of [
      ["Westminster", NW1_WESTMINSTER],
      ["City of Westminster", NW1_CITY_OF_WESTMINSTER],
      ["London", NW1_WESTMINSTER],
      ["Camden", NW1_CAMDEN],
      ["Camden", { ...CAMDEN_OP, id: 700002 }],
    ])
      confirmedSameShop(await checkAndEstimate(a, db, { locality, row, warning: null }), `${locality} | ${row.city}`);
  } finally {
    await a.close();
  }
  const trip = await freshTrip([NW1_WESTMINSTER], "Camden", NW1_WESTMINSTER);
  assert.deepEqual(trip.sent, []);
  assert.equal(trip.claimed.status, 409);
  assert.equal(trip.claims, 0);
});

test("shopInLocality and branchPlace: the Greater London boundary by sector and postcode, '<place>, London', district names, and post towns listed twice", () => {
  const { shopInLocality, branchPlace } = audit;
  const cases = [
    // [city, place, locality, verdict]
    // "<place>, London".
    ["London", "CR0 1AB", "Romford, London", "disagrees"],
    ["London", "CR0 1AB", "Stratford, London", "unknown"],
    ["London", "CR0 1AB", "Camden Town, London", "unknown"],
    ["London", "CR0 1AB", "London, Stratford", "unknown"],
    ["London", "RM1 3AA", "Romford, London", "agrees"],
    ["London", "RM1 3AA", "Romford, Essex, London", "agrees"],
    // London after Romford is not a name the shop's city can match.
    ["London", null, "Romford, London", "unknown"],
    ["London", "KT1 1AA", "Kingston, London", "agrees"],
    ["London", "TW9 1AA", "Richmond, London", "agrees"],
    ["London", "CR0 1AB", "London, UK", "agrees"],
    ["London", "CR0 1AB", "Greater London, England", "agrees"],
    ["London", "CR0 1AB", "Croydon, London", "agrees"],
    ["London", "CR0 1AB", "North London, London", "unknown"],
    ["Preston", "PR1 2AR", "Stratford, London", "disagrees"],
    // A district name as the city: the postcode decides.
    ["Acton", "W3 9LA", "Ealing", "agrees"],
    ["Acton", "W3 9LA", "London", "agrees"],
    ["Acton", "W3 9LA", "Camden", "disagrees"],
    ["Acton", null, "Ealing", "unknown"],
    ["Acton", null, "London", "unknown"],
    ["Wood Green", "N22 6BX", "Haringey", "agrees"],
    ["Walthamstow", "E17 7JR", "Waltham Forest", "agrees"],
    ["Preston", null, "Camden", "unknown"],
    // The boundary, by sector and on a boundary sector by postcode.
    ["Epsom", "KT17 4ER", "Sutton", "disagrees"],
    ["Epsom", "KT17 4ER", "London", "disagrees"],
    ["Epsom", "KT17 4ER", "Epsom", "agrees"],
    ["Epsom", "KT17 2DF", "Sutton", "agrees"],
    ["Epsom", "KT19 8EU", "Kingston upon Thames", "disagrees"],
    ["Dartford", "DA1 1BX", "Bexley", "disagrees"],
    ["Dartford", "DA1 1BX", "Dartford", "agrees"],
    ["Crayford", "DA1 4HS", "Bexley", "agrees"],
    ["Crayford", "DA1 4HS", "London", "agrees"],
    ["Sutton", "SM2 5AA", "Sutton", "agrees"],
    ["Sutton", "SM2 5PA", "Sutton", "disagrees"],
    ["London", "E4 7RA", "Waltham Forest", "disagrees"],
    ["London", "E4 6AA", "Waltham Forest", "agrees"],
    ["Sunbury-on-Thames", "TW16 5AA", "Hounslow", "disagrees"],
    ["Brentwood", "CM14 4AA", "London", "disagrees"],
    [null, "EN8 7AA", "Enfield", "disagrees"],
    // A sector the postcode directory does not have, in a boundary district.
    ["London", "KT4 0AA", "Sutton", "unknown"],
    ["Sutton", "KT4 0AA", "Sutton", "agrees"],
    // Post towns listed twice for a district.
    ["Purley", "CR8 2AA", "Croydon", "agrees"],
    ["London", "CR8 2AA", "Purley", "agrees"],
    ["London", "CR8 2AA", "Kenley", "agrees"],
    ["London", "UB5 5AA", "Greenford", "agrees"],
    ["London", "UB3 1AA", "Southall", "agrees"],
    ["London", "UB8 1AA", "West Drayton", "agrees"],
    ["London", "BR2 9AA", "Keston", "agrees"],
    ["London", "BR2 9AA", "Bromley", "agrees"],
    ["London", "CR8 2AA", "Romford", "disagrees"],
    // A city naming another borough (M21), or an outer post town that does
    // not serve the borough.
    ["Westminster", "NW1 5AA", "Camden", "disagrees"],
    ["City of Westminster", "NW1 5AA", "Camden", "disagrees"],
    ["Camden", "NW1 5AA", "Camden", "agrees"],
    ["Westminster", "NW1 5AA", "Westminster", "agrees"],
    ["City of London", "E1 8AA", "Tower Hamlets", "disagrees"],
    ["Romford", "NW1 5AA", "Camden", "disagrees"],
  ];
  for (const [city, place, locality, verdict] of cases)
    assert.equal(shopInLocality({ city, place }, locality).verdict, verdict, `${city} | ${place} | ${locality}`);
  assert.deepEqual(shopInLocality({ city: "Epsom", place: "KT17 4ER" }, "Sutton"), {
    verdict: "disagrees",
    where: "KT17 4ER, Epsom",
    inLondon: false,
    locality: "borough",
    cause: "elsewhere",
    detail: "KT17 4ER is outside Greater London",
  });
  assert.deepEqual(shopInLocality({ city: "London", place: "KT4 0AA" }, "Sutton"), {
    verdict: "unknown",
    where: "KT4 0AA, London",
    inLondon: false,
    locality: "borough",
    cause: "not-shown",
    detail: "the KT4 postcode district crosses the Greater London boundary",
  });
  assert.equal(shopInLocality({ city: "London", place: "CR0 1AB" }, "Romford, London").locality, "post town");
  assert.equal(shopInLocality({ city: "London", place: "CR0 1AB" }, "Stratford, London").cause, "vague");
  assert.equal(shopInLocality({ city: "Acton", place: null }, "Ealing").cause, "not-shown");
  assert.equal(shopInLocality({ city: "Preston", place: "PR1 2AR" }, "London").detail, null, "the city shows where it is");

  const at = (locality, branch) => ({ retailer: "Home Bargains", locality, branch });
  const text = (row, locality) => branchPlace({ store: "Home Bargains", osm_id: "node/1", ...row }, at(locality, "node/1"))?.text;
  assert.equal(text({ city: "Epsom", place: "KT17 4ER" }, "Sutton"), "Open Prices places it outside Sutton (KT17 4ER is outside Greater London)");
  assert.equal(text({ city: "Acton", place: null }, "Ealing"), "Open Prices places it at Acton, which does not show it is in Ealing");
  assert.equal(
    text({ city: "London", place: "KT4 0AA" }, "Sutton"),
    "Open Prices places it at KT4 0AA, London, which does not show it is in Sutton (the KT4 postcode district crosses the Greater London boundary)",
  );
  assert.equal(
    text({ city: "London", place: "CR0 1AB" }, "Stratford, London"),
    "Stratford, London is not a London borough, so Open Prices does not show the shop is there",
  );
  assert.equal(text({ city: "Acton", place: "W3 9LA" }, "Ealing"), null);
});

// Every real UK Open Prices location with a postcode (prices.openfoodfacts.org
// /api/v1/locations, fetched 2026-11-01), as "postcode|city|borough" for the
// 83 in Greater London (the borough postcodes.io gives) and "postcode|city"
// for the 208 outside it.
const REAL_LONDON = [
  "CR4 2AD|London|Merton;E1 8AA|City of London|Tower Hamlets;E1 8AL|London|City of London;",
  "E14 4QT|Greater London|Tower Hamlets;E14 7DL|Greater London|Tower Hamlets;",
  "E15 1XE|Greater London|Newham;E15 1XE|London Borough of Newham|Newham;E15 1XQ|London|Newham;",
  "E1W 1YY|Greater London|Tower Hamlets;E2 0EL|Greater London|Tower Hamlets;",
  "E20 1EE|Greater London|Newham;E6 5YA|Greater London|Newham;E6 7ER|London|Newham;",
  "E8 3RL|London|Hackney;E9 6JA|Greater London|Hackney;EN1 1RT|Enfield|Enfield;EN2 9HT|London|Enfield;",
  "EN3 7FL|Greater London|Enfield;HA8 8LJ|Greater London|Barnet;KT3 4PJ|Greater London|Merton;",
  "KT6 4NS|Greater London|Kingston upon Thames;KT6 4QR|Greater London|Kingston upon Thames;",
  "KT9 2RT|Greater London|Kingston upon Thames;N10 3RU|Greater London|Haringey;",
  "N11 1QJ|Greater London|Enfield;N11 2DL|London|Haringey;N12 0SH|Greater London|Barnet;",
  "N13 4YD|London|Enfield;N15 4QD|Greater London|Haringey;N19 3TD|Greater London|Islington;",
  "N1C 4BZ|Greater London|Camden;N1C 4QL|Greater London|Camden;N1C 4QP|Greater London|Camden;",
  "N22 6BX|Wood Green|Haringey;N22 6DR|London|Haringey;N22 6HE|London|Haringey;",
  "N22 6JA|Greater London|Haringey;N22 6SU|London|Haringey;N22 6TL|London|Haringey;",
  "N22 8JT|London|Haringey;N4 4AP|Greater London|Islington;N4 4DS|London|Haringey;",
  "N9 0AL|Greater London|Enfield;N9 0AL|London|Enfield;N9 0TZ|London|Enfield;",
  "NW1 2EF|Greater London|Camden;NW1 2HS|London|Camden;NW1 2PX|Greater London|Camden;",
  "NW1 2ST|Greater London|Camden;NW10 7FW|Greater London|Brent;NW10 7LW|Greater London|Ealing;",
  "SE1 4AG|Greater London|Southwark;SE1 6BH|Greater London|Southwark;SE1 6TJ|Greater London|Southwark;",
  "SE1 9AL|Greater London|Southwark;SE13 5PB|Greater London|Lewisham;SE14 5UQ|Greater London|Lewisham;",
  "SE5 0EZ|Greater London|Southwark;SM6 7DS|Greater London|Sutton;SW18 4TF|London|Wandsworth;",
  "SW1V 1JR|London|Westminster;SW7 4EJ|London|Kensington and Chelsea;SW9 6BD|Greater London|Lambeth;",
  "TW3 3LZ|Hounslow|Hounslow;TW8 0JG|Brentford|Hounslow;UB11 1AS|Greater London|Hillingdon;",
  "UB3 4AZ|Greater London|Hillingdon;UB6 8DW|London|Ealing;UB7 7FP|Greater London|Hillingdon;",
  "UB8 1LH|Uxbridge|Hillingdon;UB8 2AG|Uxbridge|Hillingdon;W13 0NL|London|Ealing;",
  "W13 0SU|Greater London|Ealing;W1D 2LE|City of Westminster|Westminster;W1T 7NE|Greater London|Camden;",
  "W2 4AL|City of Westminster|Westminster;W3 6QX|Acton|Ealing;W3 9LA|Acton|Ealing;",
  "W4 5UT|London|Hounslow;W7 3SU|Greater London|Ealing;WC2E 8AA|City of Westminster|Westminster;",
  "WC2E 9EQ|London|Westminster;WC2H 7BE|City of Westminster|Westminster",
].join("").split(";").map((row) => row.split("|"));
const REAL_OUTSIDE = [
  "AB10 7AY|Aberdeen City;AB11 5PF|Aberdeen City;AB21 9NE|Aberdeen City;AB45 1GF|Banff;",
  "AL1 3NF|St Albans;B18 7QY|Birmingham;B29 6HH|Stirchley;B3 2BJ|Park Central;B31 5AA|Turves Green;",
  "B38 8SD|Hawkesley;B45 9RQ|Rednal;B5 4BS|Birmingham;B66 4AX|Warley Wigorn;B90 4EN|Monkspath;",
  "BA12 6AQ|Warminster;BA2 4QL|Bath;BD10 8EG|Bradford;BD7 1RF|Bradford;BH23 2BN|Christchurch;",
  "BN1 4GU|Brighton;BN11 3FH|Worthing;BN14 7LG|Worthing;BS10 5NE|Bristol;BS15 8JD|Bristol;",
  "BT36 6UN|Newtownabbey;CA1 2SB|Carlisle;CB22 5LZ|Great Shelford;CB23 8EL|Bar Hill;CF10 2BJ|Cardiff;",
  "CF10 2HQ|Cardiff;CF10 2XG|Cardiff;CF10 5BZ|Cardiff;CF14 1DG|Cardiff;CF14 1DH|Cardiff;",
  "CF14 2FB|Cardiff;CF14 2FE|Cardiff;CF14 3AT|Cardiff;CF14 4HH|Cardiff;CF14 5EN|Cardiff;",
  "CF14 6PD|Cardiff;CF14 7BQ|Cardiff;CF14 9BB|Cardiff;CF36 3AH|Porthcawl;CF37 1HF|Pontypridd;",
  "CF37 4DA|Pontypridd;CF37 4SL|Pontypridd;CF37 4TD|Pontypridd;CF37 4UY|Pontypridd;CF37 5SN|Rhydyfelin;",
  "CF40 2JQ|Tonypandy;CF44 8DL|Aberdare;CH42 8PG|Birkenhead;CO15 3TH|Tendring;CO9 1HJ|Halstead;",
  "DA1 1BX|Dartford;DE23 6UQ|Derby;DE3 9NH|Derby;DH7 8HE|Langley Moor;DL15 8ND|Crook;DN31 1UF|Grimsby;",
  "DN31 1UU|Grimsby;DN31 2BB|Grimsby;DN32 9SW|Grimsby;EH12 9JS|City of Edinburgh;",
  "EH15 3RD|City of Edinburgh;EH54 6XG|Livingston;EX31 1HX|Barnstaple;FK5 4XR|Stenhousemuir;",
  "FY2 0HF|Bispham;G11 6DQ|Glasgow;G32 9AD|Glasgow;G42 7SA|Glasgow;G46 6AA|Giffnock;G46 6XN|Glasgow;",
  "G53 7RH|Glasgow;G62 6NB|Glasgow;G77 6GR|Newton Mearns;GL4 4FF|Gloucester;GL50 4AH|Cheltenham;",
  "GL51 8JQ|Cheltenham;GL51 9FJ|Swindon;GU14 6FE|Farnborough;HG1 1HD|Harrogate;HR1 2BQ|Hereford;",
  "HR8 1DS|Ledbury;HU7 4EE|Hull;IP11 2BU|Felixstowe;IP22 2AB|Bressingham;IP33 3SP|Bury St Edmunds;",
  "KA11 4JT|Irvine;KT17 4ER|Epsom;KT19 8EU|Epsom;KT24 5RX|East Horsley;KW14 8ER|Thurso;",
  "KY16 9PB|St Andrews;KY2 6QA|Kirkcaldy;KY7 4DU|Glenrothes;L13 5SG|Liverpool;L21 6PD|Litherland;",
  "L26 0AB|Knowsley;L3 8JN|Liverpool;LD3 7JP|Brecon;LE3 0AD|Leicester;LE65 1TE|Lount;LL18 2TJ|Rhuddlan;",
  "LL29 8DG|Colwyn Bay;LL49 9NZ|Porthmadog;LN12 1FN|Mablethorpe;LN8 3QE|Market Rasen;LS25 2EB|Garforth;",
  "M14 7LA|Manchester;M16 7RN|Manchester;M18 8HE|Manchester;M19 1TF|Manchester;M21 0SD|Manchester;",
  "M4 1EY|Manchester;M40 2JF|Manchester;MK5 6JU|Milton Keynes;ML6 0DT|Airdrie;ML6 6DD|Airdrie;",
  "ML6 8RA|Airdrie;NE21 5BT|Blaydon on Tyne;NE25 8UG|Whitley Bay;NE29 9QS|North Shields;",
  "NE30 3JY|North Shields;NE34 0AS|South Shields;NE5 2NF|Newcastle upon Tyne;NG10 1NY|Long Eaton;",
  "NG17 2AH|Sutton in Ashfield;NG2 5LN|West Bridgford;NG34 7JP|Sleaford;NG7 1FL|City of Nottingham;",
  "NN1 1HB|Northampton;NN10 0HD|Rushden;NN8 4LL|Wellingborough;NP7 5TR|Abergavenny;",
  "NR28 0NB|North Walsham;NR4 7TJ|Norwich;OX2 0HH|Oxford;OX3 9EB|Oxford;PE13 1PE|Wisbech;",
  "PO3 5NP|Portsmouth;PO4 8BU|Portsmouth;PO4 8SL|Portsmouth;PO9 1TR|Havant;PR1 2AR|Preston;",
  "PR2 9RX|Preston;RG30 1PR|Reading;RG30 2HB|Reading;RG30 6WR|Reading;RG31 5AL|Reading;RG4 8XU|Reading;",
  "RG41 2AR|Wokingham;RG41 5AR|Sindlesham;RG6 5TT|Reading;RH4 1AY|Dorking;RH6 0PJ|Crawley;",
  "S10 1BP|Sheffield;S11 8PN|Sheffield;S40 2DB|Chesterfield;S6 2GY|Sheffield;S66 2TW|Bramley;",
  "S9 4WU|Sheffield;SL1 1XW|Chalvey;SL1 5AL|Chalvey;SL1 9LA|Chalvey;SL2 2BF|Slough;SN10 1DW|Devizes;",
  "SO15 0SD|Southampton;SO15 2XD|Southampton;SO16 4NZ|Southampton;SO16 4QE|Southampton;SO40 7AA|Ashurst;",
  "SO40 8XT|Netley Marsh;SO40 9LX|Hounsdown;SO53 3YJ|Chandler's Ford;SP1 2NY|Salisbury;",
  "SP3 4AD|Barford St. Martin;SR5 2EX|Sunderland;SS14 3HZ|Crays Hill;SS2 6AH|Southend-on-Sea;",
  "ST20 0EZ|Gnosall;TN12 6EX|Whetsted;TN24 0SE|South Willesborough;TN24 0YE|Sevington;",
  "TN35 5DG|St Leonards;TN37 6RA|St Leonards;TR1 2TN|Truro;TR15 1FH|Redruth;TS24 0XR|Hartlepool;",
  "TS24 7HL|Hartlepool;TS24 7SA|Hartlepool;TS24 8BZ|Hartlepool;TS24 8PJ|Hartlepool;TS24 8QH|Hartlepool;",
  "TS24 9AG|Hartlepool;TS25 1FA|Hartlepool;TS25 1SD|Hartlepool;TS25 1XJ|Hartlepool;",
  "TS3 8AL|Middlesbrough;WA14 2UW|Altrincham;WA2 7NE|Warrington;WA7 2PY|Runcorn;WA9 1JJ|St Helens;",
  "WF17 5RY|Batley;WN7 3PT|Lowton Common;WR9 8LB|Droitwich Spa;WV4 4DF|Goldthorn Hill",
].join("").split(";").map((row) => row.split("|"));

const ALL_BOROUGHS = [
  "Barking and Dagenham", "Barnet", "Bexley", "Brent", "Bromley", "Camden", "Croydon", "Ealing", "Enfield", "Greenwich",
  "Hackney", "Hammersmith and Fulham", "Haringey", "Harrow", "Havering", "Hillingdon", "Hounslow", "Islington",
  "Kensington and Chelsea", "Kingston upon Thames", "Lambeth", "Lewisham", "Merton", "Newham", "Redbridge",
  "Richmond upon Thames", "Southwark", "Sutton", "Tower Hamlets", "Waltham Forest", "Wandsworth", "Westminster", "City of London",
];

test("every real Open Prices location in Greater London agrees with London and its own borough, and none outside agrees with any London locality", () => {
  assert.equal(REAL_LONDON.length, 83);
  assert.equal(REAL_OUTSIDE.length, 208);
  const refused = [];
  for (const [place, city, borough] of REAL_LONDON) {
    assert.equal(audit.shopInLocality({ place, city }, "London").verdict, "agrees", `${place} | ${city} | London`);
    if (audit.shopInLocality({ place, city }, borough).verdict !== "agrees") refused.push(`${place} | ${city} | ${borough}`);
  }
  // The one London shop refused for its borough: Open Prices records it as
  // the City of London, another borough, though the postcode is in Tower
  // Hamlets. A Tower Hamlets check naming it fails closed; a City of London
  // or London check confirms it.
  assert.deepEqual(refused, ["E1 8AA | City of London | Tower Hamlets"]);
  for (const [place, city] of REAL_OUTSIDE)
    for (const locality of [...ALL_BOROUGHS, "London", "Greater London"])
      assert.notEqual(audit.shopInLocality({ place, city }, locality).verdict, "agrees", `${place} | ${city} | ${locality}`);
});

// ---------------------------------------------------------------------------
// Fourth pass.

test("the estimate's reason says a price was seen at the shop the check names when Open Prices places that shop elsewhere: the namers path (the verifier's R4) and a stale shelf price", async () => {
  const db = evidence();
  const a = await app(db);
  const why = "the shop the branch check names, but Open Prices places it outside Camden";
  const reason = `The £12.00 price was seen at ${PRESTON_SHOP}, ${why}: record the shelf price on a branch check there`;
  try {
    // The verifier's R4: the newest Camden check names no branch, and an
    // earlier one names node/111, which Open Prices places in Preston.
    await a.check({ branch: "node/111", checkedAt: ago(2) });
    await a.check({ checkedAt: ago(0.1) });
    const est = await a.estimate();
    assert.equal(est.priceAtBranch.confirmed, false);
    assert.equal(priceCheck(est).detail, reason);
    const trip = await bountyTrip(a, db, "Camden", {});
    assert.match(trip.created.body.message, /cannot send alerts or take claims/);
    assert.deepEqual(trip.sent, []);
    assert.equal(trip.claimed.status, 409);
    assert.match(trip.claimed.body.error, new RegExp(esc(reason)));
    assert.equal(trip.claims, 0);

    // A shelf price on a Camden check naming that shop, more than 7 days old.
    db.prepare("DELETE FROM availability_checks").run();
    await a.check({ branch: "node/111", pricePence: 1150, checkedAt: ago(10) });
    await a.check({ branch: "node/111", checkedAt: ago(0.1) });
    const stale = await a.estimate();
    assert.equal(stale.priceAtBranch.confirmed, false);
    assert.match(
      priceCheck(stale).detail,
      new RegExp(
        `^The shelf price on the branch check in Camden \\(£11\\.50, .+\\) is more than 7 days old, and ${esc(`the £12.00 price was seen at ${PRESTON_SHOP}, ${why}`)}: record the shelf price on a branch check there$`,
      ),
    );
  } finally {
    await a.close();
  }
});

test("a town check naming a shop Open Prices records under a suburb name (the real Stirchley and Chalvey shops) stays unconfirmed, and says Open Prices does not show it is in the town, not that it is elsewhere (the verifier's R1 and R1b)", async () => {
  const STIRCHLEY = shop(800001, "node/501", "B29 6HH", "Stirchley");
  const CHALVEY = shop(800002, "node/502", "SL1 1XW", "Chalvey");
  const CAMDEN_SHOP = shop(800003, "node/222", "NW1 8QP", "London");
  const CHADWELL_HEATH = shop(800004, "node/604", "RM6 4AA", "Chadwell Heath");
  const db = evidence([STIRCHLEY, CHALVEY, CAMDEN_SHOP, CHADWELL_HEATH]);
  const a = await app(db);
  try {
    for (const [locality, row] of [
      ["Birmingham", STIRCHLEY],
      ["Slough", CHALVEY],
    ])
      notConfirmed(
        await checkAndEstimate(a, db, { locality, row, warning: recordedUnder(row.osm_id, row.city, locality) }),
        row,
        `Open Prices records it under ${row.city}, which does not show it is in ${locality}`,
      );
    // A shelf price recorded on the Birmingham check still costs the trip.
    db.prepare("DELETE FROM availability_checks").run();
    const priced = await a.check({ locality: "Birmingham", branch: "node/501", pricePence: 1250 });
    assert.equal(priced.body.branchWarning, recordedUnder("node/501", "Stirchley", "Birmingham", PRICE_APPLIES));
    const est = await a.estimate({ ...offerOf(STIRCHLEY), locality: "Birmingham" });
    assert.equal(est.priceAtBranch.basis, "check");
    assert.equal(est.offer.price, 1250);

    // A real contradiction still says the shop is elsewhere: a London
    // shop on a Preston check.
    notConfirmed(
      await checkAndEstimate(a, db, {
        locality: "Preston",
        row: CAMDEN_SHOP,
        warning: placedAt("node/222", "NW1 8QP, London", "Preston", null, `For a shop in London, enter London or the London borough as the locality. ${RECORD_PRICE}`),
      }),
      CAMDEN_SHOP,
      outside("Preston"),
    );
    // A suburb name with a postcode in the post town is in it: RM6 is in
    // the Romford post town. The third pass refused it on the city.
    confirmedSameShop(await checkAndEstimate(a, db, { locality: "Romford", row: CHADWELL_HEATH, warning: null }), "Romford | RM6 4AA");
  } finally {
    await a.close();
  }
  // R1 through a bounty: no alert, and Ann's claim is refused with the reason.
  const trip = await freshTrip([STIRCHLEY], "Birmingham", STIRCHLEY);
  assert.match(trip.created.body.message, /cannot send alerts or take claims/);
  assert.deepEqual(trip.sent, []);
  assert.equal(trip.claimed.status, 409);
  assert.match(
    trip.claimed.body.error,
    notConfirmedHere("Home Bargains, B29 6HH, Stirchley", "Open Prices records it under Stirchley, which does not show it is in Birmingham", false),
  );
  assert.equal(trip.claims, 0);
});

test("'Romford London' with no comma is the post town Romford, as 'Romford, London' is: a Romford shop confirms, sends an alert and takes a claim; the Croydon shop does not (the verifier's R2 and R2b)", async () => {
  const ROMFORD = shop(800011, "node/503", "RM1 3ER", "Romford");
  const KINGSTON_KT1 = shop(800012, "node/505", "KT1 1AA", "London");
  const db = evidence([ROMFORD, KINGSTON_KT1, CROYDON_OP]);
  const a = await app(db);
  try {
    for (const [locality, row] of [
      ["Romford London", ROMFORD],
      ["Romford, London", ROMFORD],
      ["romford london", ROMFORD],
      ["Kingston London", KINGSTON_KT1],
      ["Croydon London", CROYDON_OP],
    ])
      confirmedSameShop(await checkAndEstimate(a, db, { locality, row, warning: null }), `${locality} | ${row.place}`);
    const CR0 = "the CR0 postcode district is in Croydon";
    notConfirmed(
      await checkAndEstimate(a, db, { locality: "Romford London", row: CROYDON_OP, warning: placedAt("node/333", "CR0 1AB, London", "Romford London", CR0) }),
      CROYDON_OP,
      outside("Romford London", CR0),
    );
  } finally {
    await a.close();
  }
  // R2 through a bounty: the alert goes out and Ann's claim is accepted;
  // the Croydon shop sends none and takes none.
  const trip = await freshTrip([ROMFORD], "Romford London", ROMFORD);
  assert.doesNotMatch(trip.created.body.message, /cannot send alerts/);
  assert.equal(trip.sent.length, 1);
  assert.equal(trip.claimed.status, 201, JSON.stringify(trip.claimed.body));
  assert.equal(trip.claims, 1);
  const croydon = await freshTrip([CROYDON_OP], "Romford London", CROYDON_OP);
  assert.deepEqual(croydon.sent, []);
  assert.equal(croydon.claimed.status, 409);
  assert.equal(croydon.claims, 0);
});

test("recordCheck: no warning when some Open Prices rows for the shop a check names place it in the locality and the rest do not place it; a row placing it elsewhere still warns (the verifier's M26)", async () => {
  const PLACED = shop(800021, "node/222", "NW1 8QP", "London");
  const UNPLACED = shop(800022, "node/222", null, null);
  const LONDON_ONLY = shop(800023, "node/222", null, "London");
  const ELSEWHERE = shop(800024, "node/222", "CR0 1AB", "London");
  const input = { barcode: GTIN, retailer: "Home Bargains", locality: "Camden", method: "in_store", inStock: true, unitsSeen: 6, branch: "node/222" };
  const recorded = (rows) => {
    const db = openDb(":memory:");
    upsertObservations(db, rows, { now: new Date().toISOString() });
    return audit.recordCheck(db, input);
  };
  for (const rows of [
    [PLACED, UNPLACED],
    [UNPLACED, PLACED],
    [PLACED, LONDON_ONLY],
    [LONDON_ONLY, UNPLACED, PLACED],
  ])
    assert.equal(recorded(rows).branchWarning, null, rows.map((r) => `${r.place}, ${r.city}`).join(" | "));
  // With nothing placing it in Camden, the same rows warn.
  assert.equal(
    recorded([UNPLACED, LONDON_ONLY]).branchWarning,
    `Open Prices places the branch named (node/222) at London, which does not show it is in Camden, so prices seen there do not count for this check. ${RECORD_PRICE}`,
  );
  // A row placing it elsewhere warns whatever the others say.
  assert.equal(
    recorded([PLACED, ELSEWHERE]).branchWarning,
    placedAt("node/222", "CR0 1AB, London", "Camden", "the CR0 postcode district is in Croydon, Merton or Sutton"),
  );

  // Through the route and the estimate: the placed row's price confirms,
  // and the unplaced row's stays unconfirmed with its reason. The newest
  // row at a shop is the price the estimate uses.
  for (const [rows, priced] of [
    [[{ ...UNPLACED, day: ukDay(1) }, PLACED], PLACED],
    [[{ ...PLACED, day: ukDay(1) }, UNPLACED], UNPLACED],
  ]) {
    const db = evidence(rows);
    const a = await app(db);
    try {
      const saved = await a.check({ branch: "node/222" });
      assert.equal(saved.status, 201, JSON.stringify(saved.body));
      assert.equal(saved.body.branchWarning, null);
      assert.equal(saved.body.branch_postcode, "NW1 8QP");
      const est = await a.estimate(offerOf(priced));
      if (priced === PLACED) confirmedSameShop(est, "the placed row");
      else {
        assert.equal(est.priceAtBranch.confirmed, false);
        assert.equal(est.alert.eligible, false);
        assert.match(priceCheck(est).detail, notConfirmedHere("Home Bargains", "Open Prices does not say which town it is in"));
      }
    } finally {
      await a.close();
    }
  }
});

test("shopInLocality and branchPlace, fourth pass: a city that does not name a town leaves the shop unknown, real contradictions stay, and '<post town> London' is the post town", () => {
  const { shopInLocality, branchPlace } = audit;
  const cases = [
    // [city, place, locality, verdict]
    // Another name as the city, and a postcode that says nothing.
    ["Stirchley", "B29 6HH", "Birmingham", "unknown"],
    ["Stirchley", null, "Birmingham", "unknown"],
    ["Chalvey", "SL1 1XW", "Slough", "unknown"],
    ["Preston", "PR1 2AR", "Birmingham", "unknown"],
    ["Birmingham", "B29 6HH", "Birmingham", "agrees"],
    // With a postcode in the post town, the postcode decides.
    ["Chadwell Heath", "RM6 4AA", "Romford", "agrees"],
    ["Chadwell Heath", null, "Romford", "unknown"],
    ["Crayford", "DA1 4HS", "Dartford", "agrees"],
    // Real contradictions: a London city, borough or postcode for a town
    // elsewhere, another outer post town for an outer post town, or a
    // postcode in another post town.
    ["London", null, "Preston", "disagrees"],
    ["Greater London", null, "Preston", "disagrees"],
    ["Camden", null, "Preston", "disagrees"],
    ["Stirchley", "NW1 8QP", "Birmingham", "disagrees"],
    ["Ilford", null, "Romford", "disagrees"],
    ["Croydon", null, "Romford", "disagrees"],
    ["Chadwell Heath", "RM8 1AA", "Romford", "disagrees"],
    ["Kenley", "CR8 2AA", "Purley", "disagrees"],
    // "<post town> London" with no comma.
    ["Romford", "RM1 3ER", "Romford London", "agrees"],
    ["London", "RM1 3ER", "Romford London", "agrees"],
    ["London", "RM1 3ER", "Romford London, UK", "agrees"],
    ["London", "CR0 1AB", "Romford London", "disagrees"],
    ["London", "KT1 1AA", "Kingston London", "agrees"],
    ["London", "CR0 1AB", "Croydon London", "agrees"],
    ["London", "NW1 8QP", "Camden London", "agrees"],
    // Only an outer post town is read so: any other place followed by
    // London with no comma is a town of that name.
    ["London", "E15 1XQ", "Stratford London", "disagrees"],
    ["London", "CR0 1AB", "Greater London", "agrees"],
    ["London", "NW1 8QP", "North London", "unknown"],
  ];
  for (const [city, place, locality, verdict] of cases)
    assert.equal(shopInLocality({ city, place }, locality).verdict, verdict, `${city} | ${place} | ${locality}`);
  assert.deepEqual(shopInLocality({ city: "Stirchley", place: "B29 6HH" }, "Birmingham"), {
    verdict: "unknown",
    where: "B29 6HH, Stirchley",
    inLondon: false,
    locality: "town",
    cause: "town-not-shown",
    detail: null,
  });
  assert.equal(shopInLocality({ city: "Romford", place: "RM1 3ER" }, "Romford London").locality, "post town");
  assert.equal(shopInLocality({ city: "London", place: null }, "Preston").cause, "elsewhere");

  const at = (locality) => ({ retailer: "Home Bargains", locality, branch: "node/1" });
  const text = (row, locality) => branchPlace({ store: "Home Bargains", osm_id: "node/1", ...row }, at(locality))?.text;
  assert.equal(text({ city: "Stirchley", place: "B29 6HH" }, "Birmingham"), "Open Prices records it under Stirchley, which does not show it is in Birmingham");
  assert.equal(text({ city: " Chadwell Heath ", place: null }, "Romford"), "Open Prices records it under Chadwell Heath, which does not show it is in Romford");
  assert.equal(text({ city: "London", place: "CR0 1AB" }, "Romford London"), "Open Prices places it outside Romford London (the CR0 postcode district is in Croydon)");
  assert.equal(text({ city: "Romford", place: "RM1 3ER" }, "Romford London"), null);
});

// The 117 real Open Prices locations outside London (as above) that the
// third pass placed outside their own local authority, as
// "postcode|city|local authority" (postcodes.io admin_district, from the
// verifier's run on the third pass): a person there would enter that
// authority, or the town, as the locality.
const REAL_OWN_AUTHORITY = [
  "AB45 1GF|Banff|Aberdeenshire;B29 6HH|Stirchley|Birmingham;B3 2BJ|Park Central|Birmingham;",
  "B31 5AA|Turves Green|Birmingham;B38 8SD|Hawkesley|Birmingham;B45 9RQ|Rednal|Birmingham;",
  "B66 4AX|Warley Wigorn|Sandwell;B90 4EN|Monkspath|Solihull;BA12 6AQ|Warminster|Wiltshire;",
  "BA2 4QL|Bath|Bath and North East Somerset;BH23 2BN|Christchurch|Bournemouth, Christchurch and Poole;",
  "BS15 8JD|Bristol|South Gloucestershire;BT36 6UN|Newtownabbey|Antrim and Newtownabbey;",
  "CA1 2SB|Carlisle|Cumberland;CB22 5LZ|Great Shelford|South Cambridgeshire;",
  "CB23 8EL|Bar Hill|South Cambridgeshire;CF36 3AH|Porthcawl|Bridgend;CF37 1HF|Pontypridd|Rhondda Cynon Taf;",
  "CF37 4DA|Pontypridd|Rhondda Cynon Taf;CF37 4SL|Pontypridd|Rhondda Cynon Taf;",
  "CF37 4TD|Pontypridd|Rhondda Cynon Taf;CF37 4UY|Pontypridd|Rhondda Cynon Taf;",
  "CF37 5SN|Rhydyfelin|Rhondda Cynon Taf;CF40 2JQ|Tonypandy|Rhondda Cynon Taf;",
  "CF44 8DL|Aberdare|Rhondda Cynon Taf;CH42 8PG|Birkenhead|Wirral;CO9 1HJ|Halstead|Braintree;",
  "DH7 8HE|Langley Moor|County Durham;DL15 8ND|Crook|County Durham;DN31 1UF|Grimsby|North East Lincolnshire;",
  "DN31 1UU|Grimsby|North East Lincolnshire;DN31 2BB|Grimsby|North East Lincolnshire;",
  "DN32 9SW|Grimsby|North East Lincolnshire;EH54 6XG|Livingston|West Lothian;EX31 1HX|Barnstaple|North Devon;",
  "FK5 4XR|Stenhousemuir|Falkirk;FY2 0HF|Bispham|Blackpool;G46 6AA|Giffnock|East Renfrewshire;",
  "G46 6XN|Glasgow|East Renfrewshire;G62 6NB|Glasgow|East Dunbartonshire;G77 6GR|Newton Mearns|East Renfrewshire;",
  "GL51 9FJ|Swindon|Cheltenham;GU14 6FE|Farnborough|Rushmoor;HG1 1HD|Harrogate|North Yorkshire;",
  "HR1 2BQ|Hereford|Herefordshire, County of;HR8 1DS|Ledbury|Herefordshire, County of;",
  "HU7 4EE|Hull|Kingston upon Hull, City of;IP11 2BU|Felixstowe|East Suffolk;IP22 2AB|Bressingham|South Norfolk;",
  "IP33 3SP|Bury St Edmunds|West Suffolk;KA11 4JT|Irvine|North Ayrshire;KT17 4ER|Epsom|Epsom and Ewell;",
  "KT19 8EU|Epsom|Epsom and Ewell;KT24 5RX|East Horsley|Guildford;KW14 8ER|Thurso|Highland;",
  "KY16 9PB|St Andrews|Fife;KY2 6QA|Kirkcaldy|Fife;KY7 4DU|Glenrothes|Fife;L21 6PD|Litherland|Sefton;",
  "LD3 7JP|Brecon|Powys;LE65 1TE|Lount|North West Leicestershire;LL18 2TJ|Rhuddlan|Denbighshire;",
  "LL29 8DG|Colwyn Bay|Conwy;LL49 9NZ|Porthmadog|Gwynedd;LN12 1FN|Mablethorpe|East Lindsey;",
  "LN8 3QE|Market Rasen|West Lindsey;LS25 2EB|Garforth|Leeds;M16 7RN|Manchester|Trafford;",
  "M19 1TF|Manchester|Stockport;ML6 0DT|Airdrie|North Lanarkshire;ML6 6DD|Airdrie|North Lanarkshire;",
  "ML6 8RA|Airdrie|North Lanarkshire;NE21 5BT|Blaydon on Tyne|Gateshead;NE25 8UG|Whitley Bay|North Tyneside;",
  "NE29 9QS|North Shields|North Tyneside;NE30 3JY|North Shields|North Tyneside;",
  "NE34 0AS|South Shields|South Tyneside;NG10 1NY|Long Eaton|Erewash;NG17 2AH|Sutton in Ashfield|Ashfield;",
  "NG2 5LN|West Bridgford|Rushcliffe;NG34 7JP|Sleaford|North Kesteven;NN1 1HB|Northampton|West Northamptonshire;",
  "NN10 0HD|Rushden|North Northamptonshire;NN8 4LL|Wellingborough|North Northamptonshire;",
  "NP7 5TR|Abergavenny|Monmouthshire;NR28 0NB|North Walsham|North Norfolk;PE13 1PE|Wisbech|Fenland;",
  "RG30 2HB|Reading|West Berkshire;RG41 5AR|Sindlesham|Wokingham;RG6 5TT|Reading|Wokingham;",
  "RH4 1AY|Dorking|Mole Valley;S66 2TW|Bramley|Rotherham;SL1 1XW|Chalvey|Slough;SL1 5AL|Chalvey|Slough;",
  "SL1 9LA|Chalvey|Slough;SN10 1DW|Devizes|Wiltshire;SO40 7AA|Ashurst|New Forest;",
  "SO40 8XT|Netley Marsh|New Forest;SO40 9LX|Hounsdown|New Forest;SO53 3YJ|Chandler's Ford|Eastleigh;",
  "SP1 2NY|Salisbury|Wiltshire;SP3 4AD|Barford St. Martin|Wiltshire;SS14 3HZ|Crays Hill|Basildon;",
  "ST20 0EZ|Gnosall|Stafford;TN12 6EX|Whetsted|Tunbridge Wells;TN24 0SE|South Willesborough|Ashford;",
  "TN24 0YE|Sevington|Ashford;TN35 5DG|St Leonards|Hastings;TN37 6RA|St Leonards|Hastings;TR1 2TN|Truro|Cornwall;",
  "TR15 1FH|Redruth|Cornwall;WA14 2UW|Altrincham|Trafford;WA7 2PY|Runcorn|Halton;WF17 5RY|Batley|Kirklees;",
  "WN7 3PT|Lowton Common|Wigan;WR9 8LB|Droitwich Spa|Wychavon;WV4 4DF|Goldthorn Hill|Wolverhampton",
].join("").split(";").map((row) => row.split("|"));

test("no real Open Prices location outside London is placed outside its own local authority: the 117 the third pass placed there are unknown, with a reason that names the city Open Prices gives", () => {
  assert.equal(REAL_OWN_AUTHORITY.length, 117);
  for (const [place, city, locality] of REAL_OWN_AUTHORITY) {
    const judged = audit.shopInLocality({ place, city }, locality);
    assert.equal(`${judged.verdict} ${judged.cause}`, "unknown town-not-shown", `${place} | ${city} | ${locality}`);
    assert.equal(
      audit.branchPlace({ store: "Home Bargains", osm_id: "node/1", place, city }, { retailer: "Home Bargains", locality, branch: "node/1" }).text,
      `Open Prices records it under ${city}, which does not show it is in ${locality}`,
    );
  }
});
