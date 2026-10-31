// SQLite storage. Each domain module owns its tables through schema(db),
// which must be idempotent and migrate older local databases in place.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as evidence from "./evidence.mjs";
import * as audit from "./audit.mjs";
import * as goals from "./goals.mjs";
import * as bounties from "./bounties.mjs";
import * as ledger from "./ledger.mjs";

export const schemaModules = [evidence, audit, goals, bounties, ledger];

export function openDb(file = ":memory:", modules = schemaModules) {
  const db = new DatabaseSync(file);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
  );
  for (const m of modules) m.schema(db);
  return db;
}

export const dataDir = () => process.env.BOUNTY_DATA_DIR || ".data";

let shared;
// The process-wide database in the data directory, opened on first use so that
// importing a module never creates files.
export function database() {
  if (!shared) {
    mkdirSync(dataDir(), { recursive: true });
    shared = openDb(join(dataDir(), "desk.sqlite"));
  }
  return shared;
}
