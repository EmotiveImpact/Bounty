import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  awin,
  claimedPence,
  sold,
  lookup,
  lookupRequest,
  keepa,
  hobnight,
  ebayBrowse,
  openPrices,
  status,
  gtin,
  pence,
  redact,
  SourceError,
  clean,
  feedModel,
  structuredPack,
} from "./sources.mjs";
import { KIND, LICENCE } from "./contract.mjs";

const fixture = (name) => new URL("./fixtures/sources/" + name, import.meta.url);

test("quoted Awin fields and GBP isolation", () => {
  const rows = awin(
    'aw_product_id,product_name,currency,search_price\n1,"Shirt, blue",GBP,4.95\n2,Shirt,USD,2',
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].price, 495);
  assert.equal(rows[0].title, "Shirt, blue");
});

test("Awin rejects a feed without the required columns, even with no rows", () => {
  assert.throws(() => awin("aw_product_id,product_name,currency\n"), /missing search_price/);
  assert.deepEqual(awin("aw_product_id,product_name,currency,search_price\n"), []);
});

test("Awin maps contract attributes and never establishes branch stock", () => {
  const rows = awin(readFileSync(fixture("awin-sample.csv"), "utf8"));
  assert.equal(rows.length, 3, "the EUR row is dropped");
  const [jumper, kettle, mug] = rows;
  assert.deepEqual(
    {
      source_id: jumper.source_id,
      kind: jumper.kind,
      barcode: jumper.barcode,
      variant: jumper.variant,
      size: jumper.size,
      model: jumper.model,
      condition: jumper.condition,
      price: jumper.price,
      shipping: jumper.shipping,
      observed: jumper.observed,
      retailer: jumper.retailer,
      location: jumper.location,
      availability: jumper.availability,
      url: jumper.url,
      licence: jumper.licence,
    },
    {
      source_id: "1001",
      kind: KIND.RETAIL,
      barcode: "5012345678900",
      variant: "Navy",
      size: "m",
      model: "cj-200",
      condition: "new",
      price: 1200,
      shipping: 399,
      observed: "2026-10-30T14:05:00.000Z",
      retailer: "Example Outfitters",
      location: null,
      availability: "in_stock",
      url: "https://merchant.example/jumper",
      licence: LICENCE.FEED,
    },
  );
  // product_GTIN is used when ean is blank; mpn when model_number is blank.
  assert.equal(kettle.barcode, "4006381333931");
  assert.equal(kettle.model, "kx-1");
  // in_stock says yes but stock_quantity is 0: the cautious reading wins.
  assert.equal(kettle.availability, "out_of_stock");
  assert.equal(kettle.shipping, 0);
  assert.equal(kettle.url, "https://www.awin1.com/pclick.php?p=2002");
  // A bad check digit is not a barcode; unknown attributes stay null.
  assert.equal(mug.barcode, null);
  assert.equal(mug.size, null);
  assert.equal(mug.condition, null);
  assert.equal(mug.availability, null);
  assert.equal(mug.promotion, "2 for £10 with loyalty card");
  for (const row of rows) assert.equal(row.location, null, "a feed is not a branch");
});

test("GTIN check digits and decimal pence", () => {
  assert.equal(gtin("5012345678900"), "5012345678900");
  assert.equal(gtin("5012345678901"), null);
  assert.equal(gtin("12345670"), "12345670");
  assert.equal(gtin("abc"), null);
  assert.equal(pence("4.95"), 495);
  assert.equal(pence("1.005"), 101);
  assert.equal(pence(0.49), 49);
  assert.ok(Number.isNaN(pence("-1")));
  assert.ok(Number.isNaN(pence("£4")));
});

const sale = {
  reference: "s1",
  title: "Honey",
  barcode: "12345670",
  variant: "340g glass jar",
  condition: "New",
  currency: "GBP",
  totalPence: 1000,
  soldDate: "2026-09-01",
};
const NOW = { now: new Date("2026-10-31T12:00:00Z") };

test("manual sales require a date, variant, barcode, total and reference", () => {
  assert.equal(sold([sale], NOW)[0].kind, "Reported completed sale");
  assert.throws(() => sold([{ ...sale, soldDate: "2026-02-31" }], NOW));
  assert.throws(() => sold([{ ...sale, variant: "" }], NOW));
  assert.throws(() => sold([{ ...sale, reference: " " }], NOW));
  assert.throws(() => sold([{ ...sale, totalPence: 9.5 }], NOW));
  assert.throws(() => sold([{ ...sale, currency: "USD" }], NOW));
  assert.throws(() => sold([{ ...sale, soldDate: "2026-11-01" }], NOW), /future/);
});

test("manual sales capture condition, listing dates, seller and postage", () => {
  const [row] = sold(
    [
      {
        ...sale,
        size: " 340G ",
        pack: "Single",
        model: "H-1",
        listedDate: "2026-08-20",
        seller: "honeyhouse",
        postagePence: 285,
      },
    ],
    NOW,
  );
  assert.deepEqual(
    [row.condition, row.size, row.pack, row.model, row.listed, row.observed, row.seller, row.shipping, row.price, row.licence],
    ["new", "340g", "single", "h-1", "2026-08-20", "2026-09-01", "honeyhouse", 285, 1000, LICENCE.SELF],
  );
  assert.equal(sold([{ ...sale, listingId: "1234" }], NOW)[0].seller, "listing:1234");
  assert.equal(sold([sale], NOW)[0].seller, null, "independence unknown without a seller");
});

test("manual sales reject the whole file and name the record index", () => {
  const cases = [
    [{ ...sale, condition: undefined }, /index 1: condition is required/],
    [{ ...sale, listedDate: "2026-09-02" }, /index 1: listedDate is after soldDate/],
    [{ ...sale, listedDate: "2026-13-01" }, /index 1: listedDate must be a calendar date/],
    [{ ...sale, postagePence: 1001 }, /index 1: postagePence/],
    [{ ...sale, postagePence: -1 }, /index 1: postagePence/],
    [{ ...sale, postagePence: 2.5 }, /index 1: postagePence/],
    [{ ...sale, barcode: "12345678" }, /index 1: barcode/],
    [{ ...sale, size: 42 }, /index 1: size must be text/],
    [{ ...sale, reference: "s0" }, /index 1: reference s0 appears twice/],
    // A total of 0 would be skipped by the importer, so it is refused here
    // and the whole file is rejected naming the record.
    [{ ...sale, totalPence: 0 }, /index 1: totalPence must be a positive whole number/],
    [{ ...sale, totalPence: -100 }, /index 1: totalPence must be a positive whole number/],
    [{ ...sale, totalPence: "1000" }, /index 1: totalPence must be a positive whole number/],
  ];
  for (const [bad, message] of cases)
    assert.throws(() => sold([{ ...sale, reference: "s0" }, bad], NOW), message);
  assert.throws(() => sold({}, NOW), /JSON array/);
});

test("Hobnight sends gtin for barcodes, q otherwise, with the UK region", () => {
  const env = { HOBNIGHT_API_KEY: "hob-secret-123" };
  const byGtin = lookupRequest("hobnight", "5000112637922", env);
  assert.equal(byGtin.url.origin + byGtin.url.pathname, "https://api.hobnight.com/api/products");
  assert.equal(byGtin.url.searchParams.get("gtin"), "5000112637922");
  assert.equal(byGtin.url.searchParams.get("q"), null);
  assert.equal(byGtin.url.searchParams.get("region"), "uk");
  assert.equal(byGtin.url.searchParams.get("per_page"), "100");
  assert.equal(byGtin.headers.Authorization, "Bearer hob-secret-123");
  const byText = lookupRequest("hobnight", "baby sleepsuit", env);
  assert.equal(byText.url.searchParams.get("q"), "baby sleepsuit");
  assert.equal(byText.url.searchParams.get("gtin"), null);
  // Nine digits is not a GTIN length, so it is a text search.
  assert.equal(lookupRequest("hobnight", "123456789", env).url.searchParams.get("q"), "123456789");
});

test("Hobnight products map to retail offers with an unknown branch", async () => {
  const body = JSON.parse(readFileSync(fixture("hobnight-products.json"), "utf8"));
  const rows = await lookup("hobnight", "milk", { HOBNIGHT_API_KEY: "k-123456" }, async () =>
    Response.json(body),
  );
  assert.equal(rows.length, 2, "the IE-region and EUR products are dropped");
  assert.deepEqual(
    [rows[0].source_id, rows[0].barcode, rows[0].size, rows[0].price, rows[0].availability, rows[0].retailer, rows[0].location, rows[0].url, rows[0].observed, rows[0].kind, rows[0].licence],
    ["101", "5000112637922", "2 pints", 175, "in_stock", "Tesco", null, "https://www.tesco.com/groceries/en-GB/products/101", "2026-10-30T08:00:00.000Z", KIND.RETAIL, LICENCE.PROVIDER],
  );
  assert.equal(rows[1].availability, null, "unknown availability is null");
});

test("Hobnight 401 surfaces the upstream message without the key", async () => {
  await assert.rejects(
    lookup("hobnight", "milk", { HOBNIGHT_API_KEY: "hob-secret-123" }, async () =>
      Response.json({ message: "Unauthenticated." }, { status: 401 }),
    ),
    (error) =>
      error instanceof SourceError &&
      /Hobnight request failed \(HTTP 401\): Unauthenticated\./.test(error.message) &&
      !error.message.includes("hob-secret-123") &&
      error.transient === false,
  );
});

test("Browse requests GB and retains asking price classification", async () => {
  const rows = await lookup(
    "ebay",
    "shirt",
    { EBAY_ACCESS_TOKEN: "test" },
    async (url, options) => {
      assert.equal(options.headers["X-EBAY-C-MARKETPLACE-ID"], "EBAY_GB");
      assert.equal(url.searchParams.get("q"), "shirt");
      return Response.json({
        itemSummaries: [
          {
            itemId: "abc",
            title: "Shirt",
            price: { currency: "GBP", value: "15.30" },
          },
        ],
      });
    },
  );
  assert.equal(rows[0].price, 1530);
  assert.equal(rows[0].kind, "Active asking price");
});

test("eBay GTIN search uses gtin without q, a GB location filter and 200 results", async () => {
  const body = JSON.parse(readFileSync(fixture("ebay-browse.json"), "utf8"));
  let seen;
  const rows = await lookup("ebay", "5000112637922", { EBAY_ACCESS_TOKEN: "ebay-token-xyz" }, async (url, options) => {
    seen = { url, options };
    return Response.json(body);
  });
  assert.equal(seen.url.origin + seen.url.pathname, "https://api.ebay.com/buy/browse/v1/item_summary/search");
  assert.equal(seen.url.searchParams.get("gtin"), "5000112637922");
  assert.equal(seen.url.searchParams.get("q"), null, "eBay forbids combining gtin and q");
  assert.equal(seen.url.searchParams.get("limit"), "200");
  assert.equal(seen.url.searchParams.get("filter"), "itemLocationCountry:GB");
  assert.equal(seen.options.headers.Authorization, "Bearer ebay-token-xyz");
  assert.equal(seen.options.headers["X-EBAY-C-MARKETPLACE-ID"], "EBAY_GB");
  assert.equal(rows.length, 3, "the auction-only and USD listings are dropped");
  const [cheapPost, noPost, calculated] = rows;
  assert.deepEqual(
    [cheapPost.source_id, cheapPost.kind, cheapPost.condition, cheapPost.seller, cheapPost.shipping, cheapPost.price, cheapPost.observed, cheapPost.url, cheapPost.barcode, cheapPost.licence, cheapPost.location],
    ["v1|111|0", KIND.ASKING, "new", "jumper_seller", 155, 1299, "2026-10-20T09:15:00.000Z", "https://www.ebay.co.uk/itm/111", "5000112637922", LICENCE.PROVIDER, null],
  );
  assert.equal(noPost.shipping, null, "no stated shipping cost is unknown, not free");
  assert.equal(noPost.condition, "used");
  assert.equal(calculated.shipping, 0);
  for (const row of rows) assert.notEqual(row.kind, KIND.SOLD, "asking prices are never sales");
});

test("eBay invalid token error is reported with its message", async () => {
  await assert.rejects(
    lookup("ebay", "shirt", { EBAY_ACCESS_TOKEN: "dummy-token" }, async () =>
      Response.json(
        { errors: [{ errorId: 1001, message: "Invalid access token", longMessage: "Invalid access token. Check the value of the Authorization HTTP request header." }] },
        { status: 401 },
      ),
    ),
    /eBay Browse request failed \(HTTP 401\): Invalid access token\. Check the value/,
  );
});

test("Keepa retains time-specific offer records and excludes unavailable prices", () => {
  const rows = keepa({
    products: [{ asin: "A", title: "Test", csv: [[1, 200, 2, -1, 3, 150]] }],
  });
  assert.deepEqual(
    rows.map((r) => r.price),
    [200, 150],
  );
  // Rows now use the contract name source_id (formerly id).
  assert.notEqual(rows[0].source_id, rows[1].source_id);
  assert.equal(rows[0].source_id, "A@1");
  assert.equal(rows[0].kind, KIND.AMAZON);
  assert.equal(rows[0].observed, "2011-01-01T00:01:00.000Z");
});

test("Keepa sends domain 2 and surfaces its error body", async () => {
  const req = lookupRequest("keepa", "B000000000", { KEEPA_API_KEY: "k".repeat(64) });
  assert.equal(req.url.searchParams.get("domain"), "2");
  assert.equal(req.url.searchParams.get("asin"), "B000000000");
  assert.throws(() => lookupRequest("keepa", "milk", { KEEPA_API_KEY: "x" }), /ASIN/);
  const errorBody = {
    error: { message: "Operation unauthorized. No active API plan found.", type: "unauthorized" },
    tokensLeft: 0,
  };
  await assert.rejects(
    lookup("keepa", "B000000000", { KEEPA_API_KEY: "k".repeat(64) }, async () =>
      Response.json(errorBody, { status: 402 }),
    ),
    (error) =>
      /Keepa request failed \(HTTP 402\): Operation unauthorized\. No active API plan found\. \(unauthorized\)/.test(error.message) &&
      !error.message.includes("k".repeat(64)),
  );
  // An error body with HTTP 200 still fails instead of importing nothing.
  assert.throws(() => keepa(errorBody), /Keepa error: Operation unauthorized/);
});

test("Open Prices normaliser keeps GB GBP rows, skips duplicates and maps discounts", () => {
  const body = JSON.parse(readFileSync(fixture("openprices-page.json"), "utf8"));
  const rows = openPrices(body);
  assert.deepEqual(
    rows.map((r) => r.id),
    [1, 2, 5],
    "skips the FR location, the duplicate, the zero price and the EUR row",
  );
  const [plain, promo, category] = rows;
  assert.equal(plain.unit, null, "absent price_per is null, not UNKNOWN");
  assert.equal(plain.quantity, "120 g");
  assert.equal(plain.city, "Preston");
  assert.equal(plain.place, "PR1 2AR");
  assert.equal(plain.osm_id, "way/236244835");
  assert.equal(plain.barcode, "5060006200021");
  assert.equal(plain.proof_id, "142494");
  assert.equal(plain.discounted, 0);
  assert.equal(plain.licence, LICENCE.ODBL);
  assert.deepEqual(
    [promo.price, promo.discounted, promo.regular_price, promo.discount_type, promo.quantity],
    [450, 1, 535, "LOYALTY_PROGRAM", "8 x 150 ml"],
  );
  assert.equal(category.unit, "KILOGRAM");
  assert.equal(category.barcode, null);
  assert.equal(category.quantity, "500 g", "product_quantity and unit when quantity is absent");
  assert.throws(() => openPrices({}), /Unexpected Open Prices response/);
});

test("credentialed sources fail explicitly; readiness hides token values", async () => {
  await assert.rejects(
    lookup("hobnight", "milk", {}, () => {
      throw Error("network");
    }),
    /Missing HOBNIGHT_API_KEY/,
  );
  assert.ok(
    !JSON.stringify(status({ KEEPA_API_KEY: "private-value" })).includes(
      "private-value",
    ),
  );
});

test("network failures are transient and redacted", async () => {
  const env = { KEEPA_API_KEY: "secret-keepa-key-0001" };
  await assert.rejects(
    lookup("keepa", "B000000000", env, async (url) => {
      throw Error("connect failed for " + url.href);
    }),
    (error) => error.transient === true && !error.message.includes("secret-keepa-key-0001"),
  );
  assert.equal(
    redact("GET https://x.test/?key=abc&domain=2 Authorization: Bearer tok123", {}),
    "GET https://x.test/?key=[redacted]&domain=2 Authorization: Bearer [redacted]",
  );
});

test("eBay normaliser accepts an empty result and rejects an unexpected shape", () => {
  assert.deepEqual(ebayBrowse({ total: 0 }), []);
  assert.throws(() => ebayBrowse({}), /Unexpected eBay Browse response/);
  assert.throws(() => hobnight({}), /Unexpected Hobnight response/);
});

test("credential values are redacted wherever they appear, not only after key=", () => {
  const env = {
    KEEPA_API_KEY: "kp-live-0123456789",
    HOBNIGHT_API_KEY: "hob-live-abcdef",
    EBAY_ACCESS_TOKEN: "v^1.1#i^1#token-value",
  };
  // An upstream that echoes the token in its message body, with no key= or
  // Bearer prefix for the pattern rules to catch.
  const echoed = redact(
    "Invalid key kp-live-0123456789 for domain 2; hob-live-abcdef rejected; token v^1.1#i^1#token-value expired",
    env,
  );
  for (const value of Object.values(env)) assert.ok(!echoed.includes(value), value);
  assert.equal(echoed.split("[redacted]").length - 1, 3);
  // Short values are not redacted by value (too likely to hit ordinary
  // text), but the pattern rules still apply.
  assert.equal(redact("abc ok", { KEEPA_API_KEY: "abc" }), "abc ok");
  assert.equal(redact("?token=abc", { KEEPA_API_KEY: "abc" }), "?token=[redacted]");
  assert.equal(redact({ toString: 1 }, env), "");
  assert.equal(redact(null, env), "");
});

test("adapters store a pack or model only where the source gives one as data", () => {
  // Awin has no pack column: the jumper's pack stays unknown even though
  // the sale side might say 1, and a pack in the product name is never read.
  const feed = awin(
    "aw_product_id,product_name,currency,search_price,ean,model_number,mpn\n" +
      '1,"Lager, 12 x 330ml",GBP,9.00,5012345678900,N/A,LGR-12\n' +
      "2,Plain mug,GBP,4.00,5012345678900,none,\n",
  );
  assert.deepEqual(feed.map((r) => r.pack), [null, null]);
  assert.equal(feed[0].model, "lgr-12", "a placeholder model number falls back to the mpn");
  assert.equal(feed[1].model, null, "a feed's 'none' is a placeholder, not a confirmed no-model");
  for (const row of awin(readFileSync(fixture("awin-sample.csv"), "utf8"))) assert.equal(row.pack, null);
  // Hobnight gives a size and no pack or model.
  const hob = hobnight(JSON.parse(readFileSync(fixture("hobnight-products.json"), "utf8")));
  for (const row of hob) assert.deepEqual([row.pack, row.model], [null, null]);
  // Keepa's packageQuantity is a structured count; 0 and -1 mean not given.
  const product = (extra) => ({ asin: "B000000001", title: "Kettle", model: "KX-1", csv: [[1, 2000]], ...extra });
  const [four] = keepa({ products: [product({ packageQuantity: 4 })] });
  assert.deepEqual([four.pack, four.model], ["4", "kx-1"]);
  for (const missing of [0, -1, null, undefined, "4", 2.5])
    assert.equal(keepa({ products: [product({ packageQuantity: missing })] })[0].pack, null, String(missing));
  assert.equal(keepa({ products: [product({ model: "N/A" })] })[0].model, null);
  assert.equal(structuredPack(10001), null);
  assert.equal(feedModel("Model: SX-500"), "model: sx-500");
  // eBay Browse summaries carry no pack, size or model.
  const ebay = ebayBrowse(JSON.parse(readFileSync(fixture("ebay-browse.json"), "utf8")));
  for (const row of ebay) assert.deepEqual([row.pack, row.size, row.model], [null, null, null]);
});

test("adapters never throw on values that are not text", () => {
  const hostile = { toString: 1 };
  assert.equal(gtin(hostile), null);
  assert.equal(gtin(["5012345678900"]), null);
  assert.equal(clean(hostile), null);
  assert.equal(clean(true), null);
  assert.equal(clean(42), "42");
  const rows = hobnight({
    data: [{ id: hostile, gtin: hostile, name: hostile, size: hostile, price: hostile, currency: "GBP", url: hostile }],
  });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].source_id, rows[0].barcode, rows[0].title, rows[0].size], [null, null, null, null]);
  assert.ok(Number.isNaN(rows[0].price));
  assert.deepEqual(
    openPrices({
      items: [
        {
          id: 9,
          price: hostile,
          currency: "GBP",
          location: { osm_address_country_code: "GB", osm_id: hostile },
          product: { product_quantity: hostile },
          proof_id: hostile,
        },
      ],
    }),
    [],
    "a price that is not a number is skipped",
  );
  const [op] = openPrices({
    items: [
      {
        id: 10,
        price: 1.5,
        currency: "GBP",
        date: "2026-10-30",
        location: { osm_type: "NODE", osm_address_country_code: "GB", osm_id: hostile },
        product: { product_quantity: hostile, product_quantity_unit: hostile },
        proof_id: hostile,
      },
    ],
  });
  assert.deepEqual([op.osm_id, op.quantity, op.proof_id, op.price], [null, null, null, 150]);
  assert.doesNotThrow(() => keepa({ products: [{ asin: "B000000002", title: hostile, size: hostile, model: hostile, eanList: [hostile], csv: [[1, 100]] }] }));
  assert.doesNotThrow(() => ebayBrowse({ itemSummaries: [{ itemId: hostile, title: hostile, price: { currency: "GBP", value: hostile }, seller: { username: hostile } }] }));
});

test("Awin keeps the claimed previous price and RRP from structured columns only", () => {
  const csv = [
    "aw_product_id,product_name,currency,search_price,product_price_old,rrp_price,promotional_text",
    "1,Jumper was £30,GBP,20.00,30.00,35.5,Was £40 now £20",
    "2,Kettle,GBP,15.00,,0.00,",
    "3,Mug,GBP,4.00,abc,-1,",
  ].join("\n");
  const [jumper, kettle, mug] = awin(csv);
  assert.equal(jumper.was_price, 3000);
  assert.equal(jumper.rrp_price, 3550);
  // A price in the title or promotion text is never read.
  for (const row of [kettle, mug]) {
    assert.equal(row.was_price, null, row.title);
    assert.equal(row.rrp_price, null, row.title);
  }
  assert.equal(claimedPence({ toString: () => "5" }), null);
});
