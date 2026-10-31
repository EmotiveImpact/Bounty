import { readFile } from "node:fs/promises";
import { db } from "./db.mjs";
import { awin, lookup, sold } from "./sources.mjs";
const [provider, input] = process.argv.slice(2);
if (
  !["awin", "sales", "hobnight", "keepa", "ebay"].includes(provider) ||
  !input
)
  throw Error(
    "Usage: npm run research -- awin|sales FILE or hobnight|keepa|ebay QUERY",
  );
const rows =
  provider === "awin"
    ? awin(await readFile(input, "utf8"))
    : provider === "sales"
      ? sold(JSON.parse(await readFile(input, "utf8")))
      : await lookup(provider, input);
const put = db.prepare(
  "INSERT OR REPLACE INTO research(provider,source_id,kind,title,barcode,variant,price,observed,retailer) VALUES(?,?,?,?,?,?,?,?,?)",
);
let count = 0;
db.exec("BEGIN");
try {
  for (const r of rows) {
    if (!r.id || !r.title || !Number.isSafeInteger(r.price) || r.price <= 0)
      continue;
    put.run(
      provider,
      String(r.id),
      r.kind,
      r.title,
      r.barcode || null,
      r.variant || null,
      r.price,
      r.date || null,
      r.shop || null,
    );
    count++;
  }
  db.exec("COMMIT");
  console.log("Saved " + count + " " + provider + " research rows");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
