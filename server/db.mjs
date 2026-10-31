import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
const dir = process.env.BOUNTY_DATA_DIR || ".data";
mkdirSync(dir, { recursive: true });
export const db = new DatabaseSync(dir + "/desk.sqlite");
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS outcomes(id INTEGER PRIMARY KEY,sku TEXT, received INTEGER, costs INTEGER, minutes INTEGER, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY,title TEXT, store TEXT, place TEXT, price INTEGER,day TEXT,unit TEXT);
`);
