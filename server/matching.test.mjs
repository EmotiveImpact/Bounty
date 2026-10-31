import { test } from "node:test";
import assert from "node:assert/strict";
import { KIND } from "./contract.mjs";
import {
  attributes,
  compare,
  competition,
  isStoreBarcode,
  normaliseBarcode,
  normaliseCondition,
  normaliseModel,
  normalisePack,
  normaliseSize,
  offerFreshness,
  similarTitles,
  soldSample,
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
  const rows = [
    sale("sold1"),
    { ...sale("ask1"), kind: KIND.ASKING, price: 1800, shipping: 300, seller: "a" },
    { ...sale("ask2"), kind: KIND.ASKING, price: 1950, shipping: null, seller: "b" },
    { ...sale("ask3"), kind: KIND.ASKING, price: 2500, shipping: 0, seller: "a" },
    { ...sale("ask4"), kind: KIND.ASKING, price: 2200, seller: null },
    { ...sale("ask5"), kind: KIND.ASKING, price: 900, barcode: "4006381333931" },
  ];
  const c = competition(offer, rows);
  assert.equal(c.activeListings, 4);
  // a, b and one listing with no seller id, counted as another seller.
  assert.equal(c.sellers, 3);
  // 1950 (shipping unknown) is below 1800 + 300.
  assert.equal(c.lowestAsking, 1950);
  assert.equal(c.lowestAskingIncludesShipping, false);

  const confirmed = rows.map((r) => "manual|" + r.source_id);
  const withListings = soldSample(offer, rows, { now, confirmed });
  const withoutListings = soldSample(offer, [sale("sold1")], { now, confirmed });
  assert.equal(withListings.lowerMedian, withoutListings.lowerMedian);
  assert.equal(withListings.count, 1);

  assert.deepEqual(competition({ ...offer, barcode: null }, rows), {
    activeListings: 0,
    sellers: 0,
    lowestAsking: null,
    lowestAskingIncludesShipping: null,
  });
});

test("offer freshness follows the seven-day rule and fails closed", () => {
  assert.equal(offerFreshness("2026-10-30", now).expired, false);
  assert.equal(offerFreshness("2026-10-24", now).freshness, "fresh");
  assert.equal(offerFreshness("2026-10-23", now).freshness, "expired");
  assert.equal(offerFreshness(null, now).freshness, "unknown");
  assert.equal(offerFreshness(null, now).expired, true);
  assert.equal(offerFreshness("2026-11-02", now).freshness, "future");
});
