import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { transaction, londonDate, isCalendarDate } from "./http.mjs";

test("a failed transaction rolls back every write and rethrows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (v INTEGER)");
  assert.throws(
    () =>
      transaction(db, () => {
        db.prepare("INSERT INTO t (v) VALUES (1)").run();
        throw new Error("stop");
      }),
    /stop/,
  );
  assert.equal(db.isTransaction, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM t").get().n, 0);
  assert.equal(transaction(db, () => db.prepare("INSERT INTO t (v) VALUES (2)").run().changes), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM t").get().n, 1);
});

test("a nested transaction joins the open one", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (v INTEGER)");
  assert.throws(() =>
    transaction(db, () => {
      transaction(db, () => db.prepare("INSERT INTO t (v) VALUES (1)").run());
      throw new Error("outer fails");
    }),
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM t").get().n, 0);
});

test("a transaction takes the write lock at once, so another writer waits", () => {
  // With a deferred BEGIN two processes could both read, then both try to
  // write, and one claim would be lost or fail. BEGIN IMMEDIATE holds the
  // write lock from the start.
  const dir = mkdtempSync(join(tmpdir(), "bounty-tx-"));
  try {
    const file = join(dir, "t.sqlite");
    const a = new DatabaseSync(file);
    a.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v INTEGER)");
    const b = new DatabaseSync(file, { timeout: 0 });
    transaction(a, () => {
      a.prepare("SELECT COUNT(*) FROM t").get();
      assert.throws(() => b.exec("BEGIN IMMEDIATE"), /locked|busy/i);
    });
    b.exec("BEGIN IMMEDIATE");
    b.exec("ROLLBACK");
    a.close();
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("calendar dates are real dates and London dates follow UK time", () => {
  assert.equal(isCalendarDate("2026-02-29"), false);
  assert.equal(isCalendarDate("2028-02-29"), true);
  assert.equal(isCalendarDate("2026-10-31T00:00:00Z"), false);
  assert.equal(londonDate(new Date("2026-03-29T00:30:00Z")), "2026-03-29");
  assert.equal(londonDate(new Date("2026-10-24T23:30:00Z")), "2026-10-25");
  assert.equal(londonDate(new Date("2026-10-25T23:30:00Z")), "2026-10-25");
});
