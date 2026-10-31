import { db } from "./db.mjs";
const url =
  "https://prices.openfoodfacts.org/api/v1/prices?currency=GBP&size=100&order_by=-date";
const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
if (!res.ok) throw Error("Open Prices returned " + res.status);
const { items } = await res.json();
if (!Array.isArray(items)) throw Error("Invalid source response");
const insert = db.prepare(
  "INSERT OR REPLACE INTO observations VALUES(?,?,?,?,?,?,?)",
);
db.exec("BEGIN");
try {
  let count = 0;
  for (const row of items) {
    if (
      row.currency !== "GBP" ||
      row.location?.osm_address_country_code !== "GB" ||
      row.duplicate_of ||
      !(Number(row.price) > 0)
    )
      continue;
    insert.run(
      row.id,
      row.product_name ||
        row.product?.product_name ||
        row.category_tag ||
        row.product_code ||
        "Unlabelled item",
      row.location.osm_name || "Retailer unknown",
      row.location.osm_address_postcode || "",
      Math.round(row.price * 100),
      row.date,
      row.price_per || "UNKNOWN",
    );
    count++;
  }
  db.exec("COMMIT");
  console.log("Imported " + count + " UK observations from one source page.");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
