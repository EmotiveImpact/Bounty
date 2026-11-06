// Each member's own database for Stock (the ledger) and Money (goals), in
// <data dir>/members/<key>/, with their receipts in a proofs folder beside
// it. The key comes from the account id, so changing email keeps the data.
// Used with createApi's personal option (app.mjs) when accounts are on.
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.mjs";
import * as goals from "./goals.mjs";
import * as ledger from "./ledger.mjs";

export const PERSONAL_SCHEMAS = [goals, ledger];

/** The folder name for a member: a hash, so the email is not on disk. */
export const memberKey = (user) =>
  createHash("sha256")
    .update("bounty-member:" + String(user.id ?? user.email).toLowerCase())
    .digest("hex")
    .slice(0, 24);

export const memberDir = (root, user) => join(root, "members", memberKey(user));

export function personalStores(root) {
  const opened = [];
  let visitor = null;
  function personal(user) {
    if (!user) {
      visitor ||= openDb(":memory:", PERSONAL_SCHEMAS);
      return { db: visitor, proofDir: join(root, "visitor-proofs") };
    }
    const dir = memberDir(root, user);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const db = openDb(join(dir, "desk.sqlite"), PERSONAL_SCHEMAS);
    opened.push(db);
    return { db, proofDir: join(dir, "proofs") };
  }
  return {
    personal,
    /** Removes a member's own database and receipts (account deleted). */
    forget(user) {
      const dir = memberDir(root, user);
      const file = join(dir, "desk.sqlite");
      for (const db of opened) if (db.isOpen && db.location?.() === file) db.close();
      rmSync(dir, { recursive: true, force: true });
    },
    /** Writes every member database's pending changes into its file. */
    checkpoint() {
      for (const db of opened) if (db.isOpen) db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    },
    close() {
      for (const db of [...opened, visitor]) if (db?.isOpen) db.close();
    },
  };
}
