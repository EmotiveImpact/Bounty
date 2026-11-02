import { test } from "node:test";
import assert from "node:assert/strict";
import { KIND } from "./contract.mjs";
import {
  attributes,
  compare,
  competition,
  ASKING_MAX_AGE_DAYS,
  isStoreBarcode,
  normaliseBarcode,
  normaliseCondition,
  normaliseModel,
  normalisePack,
  normaliseSize,
  offerFreshness,
  similarTitles,
  soldSample,
  clean,
  sellerName,
  NO_MODEL,
  INDEPENDENCE_RULE,
} from "./matching.mjs";

// Appends a GS1 check digit to the data digits of a code.
function withCheckDigit(data) {
  const padded = data.padStart(13, "0");
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(padded[i]) * (i % 2 === 0 ? 3 : 1);
  return data + ((10 - (sum % 10)) % 10);
}

test("barcodes canonicalise to GTIN-14 and need a correct check digit", () => {
  // UPC-A, its EAN-13 and GTIN-14 spellings compare equal.
  assert.equal(normaliseBarcode("036000291452"), "00036000291452");
  assert.equal(normaliseBarcode("0036000291452"), "00036000291452");
  assert.equal(normaliseBarcode("00036000291452"), "00036000291452");
  assert.equal(normaliseBarcode("4006381333931"), "04006381333931");
  assert.equal(normaliseBarcode("96385074"), "00000096385074"); // EAN-8
  assert.equal(normaliseBarcode(" 4006-3813-33931 "), "04006381333931");
  assert.equal(normaliseBarcode(5449000000996), "05449000000996");
  // Wrong check digit, wrong length, letters, all zeros and empty values.
  assert.equal(normaliseBarcode("4006381333932"), null);
  assert.equal(normaliseBarcode("40063813339"), null);
  assert.equal(normaliseBarcode("400638133393X"), null);
  assert.equal(normaliseBarcode("ASIN B00TEST12"), null);
  assert.equal(normaliseBarcode("00000000"), null);
  assert.equal(normaliseBarcode(""), null);
  assert.equal(normaliseBarcode(null), null);
  assert.equal(normaliseBarcode(1.5), null);
  for (const data of ["501234567890", "12345678901", "1234567"])
    assert.ok(normaliseBarcode(withCheckDigit(data)), data);
});

test("store-assigned barcodes are recognised", () => {
  assert.equal(isStoreBarcode(normaliseBarcode(withCheckDigit("201234567890"))), true);
  assert.equal(isStoreBarcode(normaliseBarcode(withCheckDigit("021234567890"))), true);
  assert.equal(isStoreBarcode(normaliseBarcode("5449000000996")), false);
});

test("sizes normalise across spellings", () => {
  for (const [a, b] of [
    ["32 cm", "32cm"],
    ["320mm", "32 CM"],
    ["0-3 months", "0–3 m"],
    ["0 to 3 months", "0-3 mths"],
    ["m", "Medium"],
    ["Size 10", "10"],
    ["1.5 L", "1500ml"],
    ["0.5kg", "500 g"],
    ["2-3 yrs", "2 to 3 years"],
    ["UK 7", "uk7"],
  ])
    assert.equal(normaliseSize(a), normaliseSize(b), a + " vs " + b);
  assert.notEqual(normaliseSize("0-3 months"), normaliseSize("3-6 months"));
  assert.notEqual(normaliseSize("m"), normaliseSize("l"));
  assert.notEqual(normaliseSize("3m"), normaliseSize("3 months")); // metres
  assert.equal(normaliseSize(""), null);
  assert.equal(normaliseSize("  "), null);
});

test("pack counts are numbers and a single item needs saying", () => {
  for (const form of ["3-pack", "pack of 3", "3 pack", "x3", "3", "3 x", "3pk", 3])
    assert.equal(normalisePack(form), 3, String(form));
  assert.equal(normalisePack("single"), 1);
  assert.equal(normalisePack("pack of 1"), 1);
  assert.equal(normalisePack("twin pack"), 2);
  assert.equal(normalisePack(null), null);
  assert.equal(normalisePack(""), null);
  assert.equal(normalisePack("assorted"), null);
  assert.equal(normalisePack(0), null);
});

test("models drop separators and conditions use a fixed vocabulary", () => {
  assert.equal(normaliseModel("SX-500"), normaliseModel("sx 500"));
  assert.equal(normaliseModel("Model: SX500"), "sx500");
  assert.notEqual(normaliseModel("v1.2"), normaliseModel("v12"));
  assert.equal(normaliseCondition("New (other)"), "new other");
  assert.equal(normaliseCondition("NWT"), "new with tags");
  assert.equal(normaliseCondition("Brand new"), "new");
  assert.equal(normaliseCondition("Pre-owned"), "used");
  assert.equal(normaliseCondition("Seller refurbished"), "refurbished");
  assert.equal(normaliseCondition("like new"), null);
  assert.notEqual(normaliseCondition("new"), normaliseCondition("new with tags"));
});

test("retail offers default to new; sales and listings never infer condition", () => {
  assert.equal(attributes({ kind: KIND.RETAIL, condition: null }).condition, "new");
  assert.equal(attributes({ provider: "openprices", condition: "" }).condition, "new");
  assert.equal(attributes({ kind: KIND.RETAIL, condition: "Refurbished" }).condition, "refurbished");
  assert.equal(attributes({ kind: KIND.RETAIL, condition: "mint" }).condition, null);
  assert.equal(attributes({ kind: KIND.SOLD, condition: null }).condition, null);
  assert.equal(attributes({ kind: KIND.ASKING }).condition, null);
  assert.equal(attributes({ kind: KIND.AMAZON }).condition, null);
});

const BARCODE = "5012345678900";
const offer = {
  provider: "awin",
  source_id: "o1",
  kind: KIND.RETAIL,
  title: "Tefal Ingenio frying pan 28cm",
  barcode: BARCODE,
  size: "28 cm",
  pack: "1",
  model: "L15006",
  condition: null,
  price: 1500,
  observed: "2026-10-30",
};
const sale = (id, extra = {}) => ({
  provider: "manual",
  source_id: id,
  kind: KIND.SOLD,
  title: "Tefal Ingenio pan 28 cm",
  barcode: "05012345678900",
  size: "28cm",
  pack: "single",
  model: "l15-006",
  condition: "New",
  price: 2600,
  observed: "2026-10-20",
  listed: "2026-10-14",
  seller: "seller-" + id,
  ...extra,
});

test("compare is exact only with every attribute stated and equal", () => {
  assert.equal(normaliseBarcode(BARCODE) !== null, true);
  const exact = compare(offer, sale("s1"));
  assert.equal(exact.status, "exact");

  const missing = compare(offer, sale("s2", { size: null, condition: null }));
  assert.equal(missing.status, "research");
  assert.ok(missing.reasons.some((r) => /Size not stated for the sale/.test(r)));
  assert.ok(missing.reasons.some((r) => /Condition not stated for the sale/.test(r)));

  const differs = compare(offer, sale("s3", { pack: "2 pack", condition: "Used" }));
  assert.equal(differs.status, "research");
  assert.ok(differs.reasons.some((r) => /Pack differs: offer 1, sale 2/.test(r)));
  assert.ok(differs.reasons.some((r) => /Condition differs/.test(r)));

  const unrecognised = compare(offer, sale("s4", { condition: "mint" }));
  assert.equal(unrecognised.status, "research");
  assert.ok(unrecognised.reasons.some((r) => /not recognised/.test(r)));

  const offerMissingModel = compare({ ...offer, model: null }, sale("s5"));
  assert.equal(offerMissingModel.status, "research");
  assert.ok(offerMissingModel.reasons.some((r) => /Model not stated for the offer/.test(r)));
});

test("a similar product goes to research and an unrelated one to none", () => {
  const similar = compare(offer, sale("s6", { barcode: "4006381333931" }));
  assert.equal(similar.status, "research");
  assert.ok(similar.reasons.includes("Different barcode"));
  assert.ok(similar.reasons.some((r) => /Similar product/.test(r)));

  const noBarcode = compare(offer, sale("s7", { barcode: null }));
  assert.equal(noBarcode.status, "research");
  assert.ok(noBarcode.reasons.some((r) => /Barcode missing or invalid on the sale/.test(r)));

  const unrelated = compare(offer, sale("s8", { barcode: null, title: "Lego Star Wars X-wing" }));
  assert.equal(unrelated.status, "none");

  const badOfferBarcode = compare({ ...offer, barcode: "123" }, sale("s9"));
  assert.notEqual(badOfferBarcode.status, "exact");
  assert.ok(badOfferBarcode.reasons.includes("Offer barcode missing or invalid"));

  assert.equal(similarTitles("Tefal frying pan 28cm", "Tefal frying pan 24cm"), true);
  assert.equal(similarTitles("Tefal frying pan", "Baby sleepsuit"), false);
});

test("a store-assigned barcode never matches exactly", () => {
  const store = withCheckDigit("201234567890");
  const result = compare({ ...offer, barcode: store }, sale("s1", { barcode: store }));
  assert.equal(result.status, "research");
  assert.ok(result.reasons.some((r) => /Store-assigned barcode/.test(r)));
});

const now = "2026-10-31T12:00:00Z";

test("the sold sample uses only confirmed, recent, exact completed sales", () => {
  const rows = [
    sale("good1"),
    sale("good2", { price: 2400, seller: "seller-x" }),
    sale("good3", { price: 3000, seller: "seller-x" }),
    sale("unconfirmed"),
    sale("stale", { observed: "2026-07-01" }),
    sale("future", { observed: "2026-11-05" }),
    sale("undated", { observed: null }),
    sale("variant", { size: "24cm" }),
    sale("nototal", { price: 0 }),
    { ...sale("ask"), kind: KIND.ASKING, price: 1900 },
    { ...sale("shelf"), kind: KIND.RETAIL, price: 1200 },
    { ...sale("amazon"), kind: KIND.AMAZON, price: 1300 },
  ];
  const confirmed = new Set(
    ["good1", "good2", "good3", "stale", "future", "undated", "variant", "nototal", "ask", "shelf", "amazon"].map(
      (id) => "manual|" + id,
    ),
  );
  const s = soldSample(offer, rows, { now, confirmed });
  assert.deepEqual(
    s.used.map((r) => r.source_id),
    ["good1", "good2", "good3"],
  );
  assert.equal(s.count, 3);
  const reason = (id) => s.excluded.find((e) => e.row.source_id === id)?.reason;
  assert.equal(reason("ask"), "Active listing: resale competition, not a sale");
  assert.equal(reason("shelf"), "Not a completed sale");
  assert.equal(reason("amazon"), "Not a completed sale");
  assert.match(reason("stale"), /more than 90 days/);
  assert.match(reason("future"), /future/);
  assert.match(reason("undated"), /date unknown/);
  assert.match(reason("variant"), /^Not an exact match: Size differs/);
  assert.match(reason("unconfirmed"), /Not confirmed by the operator/);
  assert.match(reason("nototal"), /realised total/);
  // Two of the three used sales share a seller.
  assert.equal(s.independent, 2);
  // Lower median of 2400, 2600, 3000.
  assert.equal(s.lowerMedian, 2600);
  assert.equal(s.newest, "2026-10-20");
  assert.equal(s.oldest, "2026-10-20");
});

test("independence ignores null sellers and the maximum age is configurable", () => {
  const rows = [
    sale("a", { seller: null }),
    sale("b", { seller: "  " }),
    sale("c", { seller: "Shop One" }),
    sale("d", { seller: "shop one" }),
    sale("e", { observed: "2026-09-01", seller: "other" }),
  ];
  const confirmed = rows.map((r) => "manual|" + r.source_id);
  const s = soldSample(offer, rows, { now, confirmed });
  assert.equal(s.count, 5);
  assert.equal(s.independent, 2);
  const short = soldSample(offer, rows, { now, confirmed, maxSaleAgeDays: 30 });
  assert.equal(short.count, 4);
  assert.equal(short.independent, 1);
});

test("days to sell is the cautious median over sales with both dates", () => {
  const rows = [
    sale("a", { listed: "2026-10-18" }), // 2 days
    sale("b", { listed: "2026-10-12" }), // 8 days
    sale("c", { listed: "2026-10-16" }), // 4 days
    sale("d", { listed: "2026-10-10" }), // 10 days
    sale("e", { listed: null }),
    sale("f", { listed: "2026-10-25" }), // listed after the sale: ignored
  ];
  const confirmed = rows.map((r) => "manual|" + r.source_id);
  const s = soldSample(offer, rows, { now, confirmed });
  assert.equal(s.count, 6);
  // Valid durations 2, 4, 8, 10: the upper middle value leans slow.
  assert.equal(s.daysToSell, 8);
  const none = soldSample(offer, [sale("x", { listed: null })], { now, confirmed: ["manual|x"] });
  assert.equal(none.daysToSell, null);
  const empty = soldSample(offer, [], { now, confirmed: [] });
  assert.equal(empty.count, 0);
  assert.equal(empty.lowerMedian, null);
  assert.equal(empty.newest, null);
});

test("competition counts same-barcode asking prices and never touches the sample", () => {
  const ask = (id, extra) => ({ ...sale(id), kind: KIND.ASKING, observed: "2026-10-29", ...extra });
  const rows = [
    sale("sold1"),
    ask("ask1", { price: 1800, shipping: 300, seller: "a" }),
    ask("ask2", { price: 1950, shipping: null, seller: "b" }),
    ask("ask3", { price: 2500, shipping: 0, seller: "a" }),
    ask("ask4", { price: 2200, seller: null }),
    ask("ask5", { price: 900, barcode: "4006381333931" }),
  ];
  const c = competition(offer, rows, { now });
  assert.equal(c.activeListings, 4);
  // a, b and one listing with no seller id, counted as another seller.
  assert.equal(c.sellers, 3);
  // 1950 (shipping unknown) is below 1800 + 300.
  assert.equal(c.lowestAsking, 1950);
  assert.equal(c.lowestAskingIncludesShipping, false);
  assert.equal(c.olderListings, 0);
  assert.equal(c.note, null);
  assert.equal(c.maxAgeDays, ASKING_MAX_AGE_DAYS);

  const confirmed = rows.map((r) => "manual|" + r.source_id);
  const withListings = soldSample(offer, rows, { now, confirmed });
  const withoutListings = soldSample(offer, [sale("sold1")], { now, confirmed });
  assert.equal(withListings.lowerMedian, withoutListings.lowerMedian);
  assert.equal(withListings.count, 1);

  assert.deepEqual(competition({ ...offer, barcode: null }, rows, { now }), {
    activeListings: 0,
    sellers: 0,
    // Listings per stated seller (round 5b): none here.
    bySeller: [],
    lowestAsking: null,
    lowestAskingIncludesShipping: null,
    olderListings: 0,
    checkedAt: null,
    maxAgeDays: ASKING_MAX_AGE_DAYS,
    note: null,
  });
});

test("only listings seen within the window count; older ones make competition unknown", () => {
  assert.equal(ASKING_MAX_AGE_DAYS, 7);
  const ask = (id, observed, extra = {}) => ({ ...sale(id), kind: KIND.ASKING, price: 2500, seller: id, observed, ...extra });
  // The review scenario: one listing seen 180 days ago and no lookup since.
  const stale = competition(offer, [ask("old", "2026-05-04")], { now });
  assert.equal(stale.activeListings, null, "an old count is not today's competition");
  assert.equal(stale.sellers, null);
  assert.equal(stale.lowestAsking, null);
  assert.equal(stale.olderListings, 1);
  assert.equal(stale.checkedAt, "2026-05-04T00:00:00.000Z");
  assert.equal(stale.note, "Competing listings last checked 4 May 2026: run an asking-price lookup before sharing");
  // Current means seen within 7 x 24 hours by elapsed time (R3M9): exactly
  // seven days still counts, a millisecond more does not, and 7.5 or 7.99
  // days is never rounded down to seven.
  assert.equal(competition(offer, [ask("d7", "2026-10-24T12:00:00Z")], { now }).activeListings, 1);
  assert.equal(competition(offer, [ask("d7+", "2026-10-24T11:59:59.999Z")], { now }).activeListings, null);
  assert.equal(competition(offer, [ask("d6.9", "2026-10-24T14:24:00Z")], { now }).activeListings, 1);
  assert.equal(competition(offer, [ask("d7.5", "2026-10-24")], { now }).activeListings, null);
  assert.equal(competition(offer, [ask("d7.99", "2026-10-23T12:14:24Z")], { now }).activeListings, null);
  assert.equal(competition(offer, [ask("d8", "2026-10-23")], { now }).activeListings, null);
  // A lookup follows the same rule.
  assert.equal(competition(offer, [], { now, lookup: { fetched: "2026-10-24T12:00:00Z" } }).activeListings, 0);
  assert.equal(competition(offer, [], { now, lookup: { fetched: "2026-10-24T11:00:00Z" } }).activeListings, null);
  // A listing dated after now, or with no date, is never current.
  assert.equal(competition(offer, [ask("future", "2026-11-03")], { now }).activeListings, null);
  const undated = competition(offer, [ask("undated", null)], { now });
  assert.equal(undated.activeListings, null);
  assert.match(undated.note, /no date they were seen/);
  // A mix counts the current ones and says how many older ones were left out.
  const mixed = competition(offer, [ask("new1", "2026-10-30"), ask("old1", "2026-09-01"), ask("old2", "2026-08-01")], { now });
  assert.equal(mixed.activeListings, 1);
  assert.equal(mixed.olderListings, 2);
  assert.equal(mixed.checkedAt, "2026-10-30T00:00:00.000Z");
  assert.equal(mixed.note, "2 older listings seen more than 7 days ago not counted");
  // A recent lookup that found nothing current makes the count 0; an old
  // lookup with no listings is unknown and dated by the lookup.
  const looked = competition(offer, [ask("old", "2026-05-04")], { now, lookup: { provider: "ebay", fetched: "2026-10-31T09:00:00Z" } });
  assert.equal(looked.activeListings, 0);
  assert.equal(looked.checkedAt, "2026-10-31T09:00:00.000Z");
  const oldLookup = competition(offer, [], { now, lookup: { fetched: "2026-10-01T09:00:00Z" } });
  assert.equal(oldLookup.activeListings, null);
  assert.equal(oldLookup.note, "Competing listings last checked 1 Oct 2026: run an asking-price lookup before sharing");
  // No listings and no lookup stays 0: callers treat it as unknown until a
  // lookup is on record.
  assert.equal(competition(offer, [], { now }).activeListings, 0);
  // The window can be set, and now can be a Date.
  assert.equal(competition(offer, [ask("d3", "2026-10-28")], { now: new Date(now), maxAgeDays: 2 }).activeListings, null);
  assert.equal(competition(offer, [ask("d3", "2026-10-28T12:00:00Z")], { now: new Date(now), maxAgeDays: 3 }).activeListings, 1);
  assert.equal(competition(offer, [ask("d3.5", "2026-10-28")], { now: new Date(now), maxAgeDays: 3 }).activeListings, null);
  // Two arguments still work and judge age against the current time.
  const recent = new Date(Date.now() - 3600000).toISOString();
  assert.equal(competition(offer, [ask("r", recent)]).activeListings, 1);
  assert.equal(competition(offer, [ask("o", "2020-01-01")]).activeListings, null);
});

test("offer freshness follows the seven-day rule and fails closed", () => {
  assert.equal(offerFreshness("2026-10-30", now).expired, false);
  assert.equal(offerFreshness("2026-10-24", now).freshness, "fresh");
  assert.equal(offerFreshness("2026-10-23", now).freshness, "expired");
  assert.equal(offerFreshness(null, now).freshness, "unknown");
  assert.equal(offerFreshness(null, now).expired, true);
  assert.equal(offerFreshness("2026-11-02", now).freshness, "future");
});

test("independent sellers are distinct named sellers, never listing ids", () => {
  const now = "2026-10-31T12:00:00Z";
  // One seller's three listings recorded by listing id only (the importer
  // stores them as "listing:<id>") show no independence at all.
  const byListing = [
    sale("l1", { seller: "listing:110011" }),
    sale("l2", { seller: "listing:110012" }),
    sale("l3", { seller: "listing:110013" }),
  ];
  const keys = (rows) => rows.map((r) => "manual|" + r.source_id);
  const s = soldSample(offer, byListing, { now, confirmed: keys(byListing) });
  assert.equal(s.count, 3);
  assert.equal(s.independent, 0, "listing ids are not sellers");
  assert.equal(s.withoutSeller, 3);
  assert.equal(s.independenceRule, INDEPENDENCE_RULE);
  // The same seller named on one row and by listing id on another counts once.
  const mixed = [
    sale("m1", { seller: "Jumper Shop" }),
    sale("m2", { seller: "listing:110012" }),
    sale("m3", { seller: null }),
    sale("m4", { seller: "jumper shop " }),
    sale("m5", { seller: "other_seller" }),
  ];
  const m = soldSample(offer, mixed, { now, confirmed: keys(mixed) });
  assert.equal(m.count, 5);
  assert.equal(m.independent, 2);
  assert.equal(m.withoutSeller, 2, "the unnamed and listing-only sales are left out, not counted once");
  assert.equal(sellerName("listing:1"), null);
  assert.equal(sellerName("  Shop  One "), "shop one");
  assert.equal(sellerName({ toString: 1 }), null);
});

test("competition treats a listing id as an unnamed seller", () => {
  const rows = [
    { ...sale("a1"), kind: KIND.ASKING, price: 1800, seller: "listing:1", observed: "2026-10-30" },
    { ...sale("a2"), kind: KIND.ASKING, price: 1900, seller: "listing:1", observed: "2026-10-30" },
    { ...sale("a3"), kind: KIND.ASKING, price: 2000, seller: "named", observed: "2026-10-30" },
  ];
  // Unknown sellers are assumed different for competition: the cautious side.
  assert.equal(competition(offer, rows, { now }).sellers, 3);
});

test("non-text input never throws and is never a value", () => {
  const hostile = [{ toString: 1 }, { valueOf: 1, toString: 1 }, [], ["5012345678900"], {}, true, Symbol("x"), () => 1, NaN, Infinity];
  for (const value of hostile) {
    const label = typeof value === "symbol" ? "symbol" : typeof value;
    assert.equal(normaliseBarcode(value), null, label);
    assert.equal(clean(value), null, label);
    assert.equal(normaliseSize(value), null, label);
    assert.equal(normaliseModel(value), null, label);
    assert.equal(normaliseCondition(value), null, label);
    assert.doesNotThrow(() => normalisePack(value), label);
    assert.doesNotThrow(() => attributes({ barcode: value, size: value, pack: value, model: value, condition: value }), label);
    assert.doesNotThrow(() => compare({ barcode: value, title: value }, { barcode: value, title: value }), label);
  }
  assert.equal(clean(12), "12");
  assert.equal(normaliseBarcode(5449000000996), "05449000000996");
  assert.equal(normaliseBarcode(-5449000000996), null);
});

test("placeholders are not stated; an explicit no-model is never inferred from them", () => {
  for (const placeholder of ["n/a", "N/A", "-", "unknown", "TBC", "Model: n/a"])
    assert.equal(normaliseModel(placeholder), null, placeholder);
  for (const none of ["None", "No model", "no model number", "Not applicable", "Model: none"])
    assert.equal(normaliseModel(none), NO_MODEL, none);
  assert.equal(normaliseSize("n/a"), null);
  assert.equal(normaliseSize("one size"), "one size");
  const honey = { ...offer, size: "340g", model: "none" };
  const sold = sale("h1", { size: "340 g", model: "No model" });
  assert.equal(compare(honey, sold).status, "exact");
  // A placeholder on both sides never makes a match.
  const vague = compare({ ...offer, model: "n/a" }, sale("h2", { model: "N/A" }));
  assert.equal(vague.status, "research");
  assert.ok(vague.reasons.some((r) => r.startsWith("Model")), vague.reasons.join("; "));
});

test("an operator-confirmed no-model on the offer covers a sale that states no model", () => {
  const honey = { ...offer, size: "340g", model: "none" };
  // The sale states no model: with the offer confirmed as having none, it matches.
  for (const model of [null, "", "n/a", "No model"]) {
    const result = compare(honey, sale("h", { size: "340g", model }));
    assert.equal(result.status, "exact", String(model));
  }
  const covered = compare(honey, sale("h3", { size: "340g", model: null }));
  assert.ok(covered.reasons.some((r) => r.startsWith("No model number: confirmed")), covered.reasons.join("; "));
  // A model on the sale against a confirmed no-model differs.
  const modelled = compare(honey, sale("h4", { size: "340g", model: "HX-340" }));
  assert.equal(modelled.status, "research");
  assert.ok(modelled.reasons.includes("Model differs: offer none, sale hx340"), modelled.reasons.join("; "));
  // A model on the offer against a sale that states none still fails.
  const offerModel = compare({ ...honey, model: "HX-340" }, sale("h5", { size: "340g", model: "none" }));
  assert.equal(offerModel.status, "research");
  // No model stated on the offer: a sale saying "none" does not cover it.
  const unstated = compare({ ...honey, model: null }, sale("h6", { size: "340g", model: "none" }));
  assert.equal(unstated.status, "research");
  assert.ok(unstated.reasons.includes("Model not stated for the offer"), unstated.reasons.join("; "));
  // The other attributes are still required.
  assert.equal(compare(honey, sale("h7", { size: null, model: null })).status, "research");
});
