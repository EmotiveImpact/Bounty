import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.mjs";
import { recordRun } from "./evidence.mjs";
import { freshPrices, importDue, IMPORT_EVERY } from "./demo.mjs";

const NOW = new Date("2026-11-01T12:00:00Z");
const run = (db, finished, ok = true) =>
  recordRun(db, { provider: "openprices", mode: "scheduled", started: finished, finished, ok, rows: 1, error: ok ? null : "x" });

test("an import is due with no run, after six hours, or when only failures are recent", () => {
  const db = openDb();
  assert.equal(importDue(db, NOW), true);
  run(db, new Date(NOW - IMPORT_EVERY + 60000));
  assert.equal(importDue(db, NOW), false);
  assert.equal(importDue(db, new Date(NOW.getTime() + 60000)), true);
  run(db, NOW, false);
  assert.equal(importDue(db, new Date(NOW.getTime() + 60000)), true, "a failed run does not count");
});

test("one import runs at a time, then bounties are re-checked, and failures never block requests", async () => {
  const db = openDb();
  const calls = [];
  let finish;
  const before = freshPrices(db, {
    run: (d, options) => {
      calls.push(options.mode);
      return new Promise((resolve) => (finish = resolve)).then(() => run(d, new Date()));
    },
    refresh: () => calls.push("refresh"),
    wait: 10,
    log: () => {},
  });
  await before();
  await before();
  assert.deepEqual(calls, ["scheduled"], "the second request does not start another import");
  finish();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls, ["scheduled", "refresh"]);
  await before();
  assert.equal(calls.length, 2, "fresh data starts nothing");

  const logged = [];
  const failing = freshPrices(openDb(), {
    run: () => Promise.reject(Error("offline")),
    refresh: () => assert.fail("no refresh after a failed import"),
    log: (m) => logged.push(m),
  });
  await failing();
  assert.deepEqual(logged, ["Open Prices import failed: offline"]);
});
