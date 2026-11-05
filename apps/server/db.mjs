// SQLite storage. Each domain module owns its tables through schema(db),
// which must be idempotent and migrate older local databases in place.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { transaction } from "./http.mjs";
import * as evidence from "./evidence.mjs";
import * as audit from "./audit.mjs";
import * as goals from "./goals.mjs";
import * as bounties from "./bounties.mjs";
import * as ledger from "./ledger.mjs";

export const schemaModules = [evidence, audit, goals, bounties, ledger];

// The API, the import worker and the loop may open the same file at the same
// moment. The busy timeout is set before anything that takes a lock, and the
// schema migrations run in one BEGIN IMMEDIATE transaction, so a second
// process waits for the first instead of failing with "database is locked"
// or adding a column twice.
export function openDb(file = ":memory:", modules = schemaModules) {
  const db = new DatabaseSync(file, { timeout: 5000 });
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  transaction(db, () => {
    for (const m of modules) m.schema(db);
  });
  return db;
}

export const dataDir = () => process.env.BOUNTY_DATA_DIR || ".data";

let shared;
// The process-wide database in the data directory, opened on first use so that
// importing a module never creates files.
// The folder and the database hold private notes, ledger amounts and member
// details, so only the owner may read them (folder 0700, files 0600).
export function database() {
  if (!shared) {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const file = join(dir, "desk.sqlite");
    // Create the file with owner-only access before SQLite opens it; SQLite
    // gives its -wal and -shm files the same permissions.
    if (!existsSync(file)) closeSync(openSync(file, "a", 0o600));
    chmodSync(file, 0o600);
    shared = openDb(file);
    for (const extra of ["-wal", "-shm"])
      if (existsSync(file + extra)) chmodSync(file + extra, 0o600);
  }
  return shared;
}
