import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
const dir = process.env.BOUNTY_DATA_DIR || ".data";
mkdirSync(dir, { recursive: true });
export const db = new DatabaseSync(dir + "/desk.sqlite");
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS outcomes(id INTEGER PRIMARY KEY,sku TEXT, received INTEGER, costs INTEGER, minutes INTEGER, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY,title TEXT, store TEXT, place TEXT, price INTEGER,day TEXT,unit TEXT);
`);
db.exec(`CREATE TABLE IF NOT EXISTS research (
 provider TEXT NOT NULL, source_id TEXT NOT NULL, kind TEXT NOT NULL,
 title TEXT NOT NULL, barcode TEXT, variant TEXT, price INTEGER NOT NULL, observed TEXT,
 retailer TEXT, imported TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(provider,source_id)
);`);

const observationColumns = new Set(
  db
    .prepare("PRAGMA table_info(observations)")
    .all()
    .map((row) => row.name),
);
for (const column of ["barcode", "proof_id"]) {
  if (!observationColumns.has(column))
    db.exec("ALTER TABLE observations ADD COLUMN " + column + " TEXT");
}
