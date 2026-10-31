import { test } from "node:test";
import assert from "node:assert/strict";
import { awin, sold, lookup, keepa, status } from "./sources.mjs";
test("quoted Awin fields and GBP isolation", () => {
  const rows = awin(
    'aw_product_id,product_name,currency,search_price\n1,"Shirt, blue",GBP,4.95\n2,Shirt,USD,2',
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].price, 495);
  assert.equal(rows[0].title, "Shirt, blue");
});
test("manual sales require a date, variant, barcode, total and reference", () => {
  const sale = {
    reference: "s1",
    title: "Honey",
    barcode: "12345678",
    variant: "340g glass jar",
    currency: "GBP",
    totalPence: 1000,
    soldDate: "2026-09-01",
  };
  assert.equal(sold([sale])[0].kind, "Reported completed sale");
  assert.throws(() => sold([{ ...sale, soldDate: "2026-02-31" }]));
  assert.throws(() => sold([{ ...sale, variant: "" }]));
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
test("Keepa retains time-specific offer records and excludes unavailable prices", () => {
  const rows = keepa({
    products: [{ asin: "A", title: "Test", csv: [[1, 200, 2, -1, 3, 150]] }],
  });
  assert.deepEqual(
    rows.map((r) => r.price),
    [200, 150],
  );
  assert.notEqual(rows[0].id, rows[1].id);
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
