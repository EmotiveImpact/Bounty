import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dbModule = fileURLToPath(new URL("./db.mjs", import.meta.url));

const run = (code, env = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (status) => resolve({ status, err }));
  });

test("several processes opening a new database at once all succeed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bounty-db-"));
  try {
    const file = join(dir, "desk.sqlite");
    const code = `const m = await import(${JSON.stringify(dbModule)}); m.openDb(${JSON.stringify(file)});`;
    const results = await Promise.all(Array.from({ length: 4 }, () => run(code)));
    for (const r of results) assert.equal(r.status, 0, r.err);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the data folder and database are readable by their owner only", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "bounty-perm-")), ".data");
  try {
    const code = `const m = await import(${JSON.stringify(dbModule)}); m.database().exec("CREATE TABLE IF NOT EXISTS t (x)");`;
    const r = await run(code, { BOUNTY_DATA_DIR: dir });
    assert.equal(r.status, 0, r.err);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "desk.sqlite")).mode & 0o777, 0o600);
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});
