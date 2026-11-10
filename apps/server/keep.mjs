// Durable snapshots for the hosted pilot. A successful response is released
// only after its SQLite databases and files have committed together in Neon.
// See docs/DURABLE-WRITES.md for the protocol and the deployment gate.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const READS = new Set(["GET", "HEAD", "OPTIONS"]);
const SKIP = /-(wal|shm|journal)$/;
const digest = (buf) => createHash("sha256").update(buf).digest("hex");
class SnapshotConflict extends Error {}

function validPath(path) {
  return typeof path === "string" && path.length > 0 && !/[\\:\0]/.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== "..");
}

// The API emits a single JSON response through these three methods. This is
// deliberately not a ServerResponse proxy: no socket or flush method is exposed
// that could publish success or cookies before the durable commit.
function bufferedResponse(limit) {
  const headers = new Map();
  return {
    statusCode: 200,
    body: null,
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    writeHead(status, values = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(values)) this.setHeader(name, value);
      return this;
    },
    end(value = "") {
      if (this.body !== null) throw Error("Response already ended");
      this.body = Buffer.from(value);
      if (this.body.length > limit) throw Error("Buffered response is too large");
    },
    publish(res) {
      if (this.body === null) throw Error("API did not finish its response");
      if (res.destroyed) return;
      res.writeHead(this.statusCode, Object.fromEntries(headers));
      res.end(this.body);
    },
  };
}

/**
 * build() opens dir and returns { handle(req, res), checkpoint(), close() }.
 * All work using those handles must finish before handle resolves. Reads,
 * imports and writes share one queue, so none can see or save an uncommitted
 * mutation. External work must use change(fn), never mutate then notify.
 * store.snapshot() reads a consistent { version, files } object;
 * store.commit(version, puts, drops) atomically returns the next version or null.
 */
export function keepForGood({ store, dir, build, log = console.error, checkEvery = 5000, now = Date.now,
  maxResponseBytes = 16 * 1024 * 1024 }) {
  let current = null;
  let version = 0;
  let checked = 0;
  let known = new Map();
  let queue = Promise.resolve();

  function serial(fn) {
    const run = queue.then(fn);
    queue = run.catch(() => undefined);
    return run;
  }

  function localFiles() {
    const out = [];
    const walk = (folder) => {
      if (!existsSync(folder)) return;
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const full = join(folder, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && !SKIP.test(entry.name)) out.push(relative(dir, full).split(sep).join("/"));
      }
    };
    walk(dir);
    return out;
  }
  const place = (root, path) => join(root, ...path.split("/"));

  function invalidate() {
    const old = current;
    current = null;
    checked = 0;
    // The cache is unusable until a complete remote restore succeeds. Keep its
    // files until then; an outage must not destroy the last local copy.
    old?.close();
  }

  async function restore() {
    const snapshot = await store.snapshot();
    const hashes = new Map();
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
    const stage = mkdtempSync(join(dirname(dir), ".bounty-restore-"));
    const backup = stage + "-previous";
    let moved = false;
    try {
      for (const [path, data] of Object.entries(snapshot.files)) {
        if (!validPath(path) || SKIP.test(path)) throw Error("Invalid snapshot path");
        const buf = gunzipSync(Buffer.from(data, "base64"));
        mkdirSync(dirname(place(stage, path)), { recursive: true, mode: 0o700 });
        writeFileSync(place(stage, path), buf, { mode: 0o600 });
        hashes.set(path, digest(buf));
      }
      // No open request or importer can still own these handles. Decode the
      // entire snapshot before closing or replacing the previous cache.
      invalidate();
      if (existsSync(dir)) { renameSync(dir, backup); moved = true; }
      try {
        renameSync(stage, dir);
        current = build();
      } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        if (moved) { renameSync(backup, dir); moved = false; }
        throw error;
      }
      known = hashes;
      version = snapshot.version;
      checked = now();
      if (moved) rmSync(backup, { recursive: true, force: true });
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }

  async function readyInsideQueue() {
    // A rejected restore is never memoised; the next request can retry.
    if (!current) await restore();
  }

  async function freshen(force) {
    if (!force && now() - checked < checkEvery) return;
    const latest = await store.version();
    if (latest !== version) await restore();
    checked = now();
  }

  async function save() {
    current.checkpoint();
    const hashes = new Map();
    const puts = [];
    for (const path of localFiles()) {
      const buf = readFileSync(place(dir, path));
      const hash = digest(buf);
      hashes.set(path, hash);
      if (known.get(path) !== hash) puts.push({ path, data: gzipSync(buf).toString("base64") });
    }
    const drops = [...known.keys()].filter((path) => !hashes.has(path));
    if (!puts.length && !drops.length) return;
    // The store performs the compare-and-swap AND all file changes in one
    // transaction. A losing writer changes neither files nor version.
    const next = await store.commit(version, puts, drops);
    if (next === null) throw new SnapshotConflict("Snapshot changed on another instance");
    version = next;
    known = hashes;
  }

  function discard() {
    try { invalidate(); } catch (error) { log("Bounty keep: close failed: " + error.message); }
  }

  function handle(req, res) {
    return serial(async () => {
      try {
        await readyInsideQueue();
        await freshen(!READS.has(req.method));
        // These operations change accounts in independent Postgres tables AND
        // snapshot files. Until a common transaction exists, refuse them before
        // either store is changed. Never leave an account deleted but its
        // receipts restored, or its profile linked to the previous email.
        const path = new URL(req.url, "http://localhost").pathname;
        if (req.method === "POST" && ["/api/account/email", "/api/account/delete"].includes(path)) {
          res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ code: "account_change_unavailable", error: "Email changes and account deletion are temporarily unavailable. Your account and records have not been changed." }));
          return;
        }
        const response = bufferedResponse(maxResponseBytes);
        await current.handle(req, response);
        if (response.body === null) throw Error("API did not finish its response");
        if (response.statusCode < 400) await save();
        else discard(); // A refused handler may have made partial local edits.
        response.publish(res);
      } catch (error) {
        discard();
        log("Bounty keep: request not confirmed: " + error.message);
        if (res.headersSent || res.destroyed) return;
        const conflict = error instanceof SnapshotConflict;
        res.writeHead(conflict ? 409 : 503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({
          code: conflict ? "snapshot_conflict" : "save_not_confirmed",
          error: conflict
            ? "Your records changed during this request. Reload them before trying again."
            : "We could not confirm this request completed. Check your records before trying again.",
        }));
      }
    });
  }

  function change(fn) {
    return serial(async () => {
      try {
        await readyInsideQueue();
        await freshen(true);
        await fn(current);
        await save();
      } catch (error) {
        discard();
        throw error;
      }
    });
  }

  return { handle, change, ready: () => serial(readyInsideQueue), close: () => serial(invalidate) };
}

/** In-memory atomic store for synthetic tests. No production credentials. */
export function memoryStore() {
  let version = 0;
  let files = {};
  return {
    async version() { return version; },
    async snapshot() { return { version, files: { ...files } }; },
    async commit(from, puts, drops) {
      if (version !== from) return null;
      const next = Object.assign(Object.create(null), files);
      for (const { path, data } of puts) next[path] = data;
      for (const path of drops) delete next[path];
      files = next;
      return ++version;
    },
  };
}

/** query(text, params) executes one PostgreSQL statement and returns rows. */
export async function postgresKeepStore(query) {
  let initialising = null;
  function ready() {
    return initialising ||= (async () => {
      await query("CREATE TABLE IF NOT EXISTS bounty_keep (id text PRIMARY KEY, version bigint NOT NULL, saved_at timestamptz NOT NULL DEFAULT now())", []);
      await query("CREATE TABLE IF NOT EXISTS bounty_keep_files (path text PRIMARY KEY, data text NOT NULL, saved_at timestamptz NOT NULL DEFAULT now())", []);
      // Non-destructive adoption of the existing format, including version 0.
      await query("INSERT INTO bounty_keep (id, version) VALUES ('main', 0) ON CONFLICT (id) DO NOTHING", []);
    })().catch((error) => { initialising = null; throw error; });
  }
  const asVersion = (value) => {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) throw Error("Invalid snapshot version");
    return n;
  };
  return {
    async version() {
      await ready();
      const rows = await query("SELECT version FROM bounty_keep WHERE id = 'main'", []);
      if (!rows.length) throw Error("Snapshot version is missing");
      return asVersion(rows[0].version);
    },
    async snapshot() {
      await ready();
      // One MVCC statement snapshot for the manifest and every file. Separate
      // version/list/file calls can assemble files from different commits.
      const rows = await query(`SELECT version,
        COALESCE((SELECT jsonb_object_agg(path, data) FROM bounty_keep_files), '{}'::jsonb) AS files
        FROM bounty_keep WHERE id = 'main'`, []);
      if (!rows.length) throw Error("Snapshot version is missing");
      return { version: asVersion(rows[0].version), files: rows[0].files };
    },
    async commit(from, puts, drops) {
      await ready();
      // All DML is gated by the version UPDATE's returned row, in one implicit
      // transaction. PostgreSQL rechecks the predicate after a concurrent
      // updater commits. No row means no file writes or deletions can occur.
      const rows = await query(`WITH advanced AS (
          UPDATE bounty_keep SET version = version + 1, saved_at = now()
          WHERE id = 'main' AND version = $1 RETURNING version
        ), uploaded AS (
          INSERT INTO bounty_keep_files (path, data)
          SELECT incoming.path, incoming.data FROM jsonb_to_recordset($2::jsonb) AS incoming(path text, data text)
          CROSS JOIN advanced
          ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, saved_at = now()
          RETURNING path
        ), removed AS (
          DELETE FROM bounty_keep_files USING advanced
          WHERE path = ANY($3::text[]) RETURNING path
        ) SELECT version FROM advanced`, [from, JSON.stringify(puts), drops]);
      return rows.length ? asVersion(rows[0].version) : null;
    },
  };
}

export async function neonKeepStore(url) {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);
  return postgresKeepStore((text, params) => sql.query(text, params));
}
