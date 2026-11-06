// Keeps members' records for good on the hosted site.
//
// On Vercel the API's data folder (the shared SQLite database, each member's
// own database, receipts and shelf photos) lives in the function's temporary
// storage, which is emptied whenever Vercel starts a fresh instance. This
// module copies changed files to Postgres (Neon) after every change, and
// copies them all back when an instance starts. Sign-in already lives in
// Neon (accounts.mjs).
//
// How it stays consistent between instances:
// - Postgres holds one version number for the whole folder.
// - Changes (anything but GET, HEAD, OPTIONS) run one at a time per instance.
//   Before a change the instance checks the version and reloads if another
//   instance saved since. After a successful change it uploads the files that
//   changed, then moves the version on only if it is still the one it loaded.
//   If that fails (two instances saved in the same moment) it logs it and
//   reloads on the next request.
// - Reads check the version at most every few seconds.
// Databases are small (a few hundred KB, tens of KB gzipped), so copying a
// changed file whole is quick. This suits a pilot; Postgres tables are the
// long-term route (docs/STALE.md).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const READS = new Set(["GET", "HEAD", "OPTIONS"]);
// SQLite's side files are folded into the database by a checkpoint first.
const SKIP = /-(wal|shm|journal)$/;

const digest = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * Wraps the API so the data folder survives restarts.
 * store: see memoryStore / postgresKeepStore. dir: the data folder.
 * build() opens the data in dir and returns { handle(req, res), checkpoint(), close() }.
 * Returns { handle, changed } (changed() saves after work done outside a
 * request, such as the Open Prices import).
 */
export function keepForGood({ store, dir, build, log = console.error, checkEvery = 5000, now = Date.now }) {
  let current = null;
  let version = 0;
  let checked = 0;
  let known = new Map();
  let starting = null;
  let queue = Promise.resolve();

  // One at a time: changes, reloads and saves never overlap on one instance.
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

  const place = (path) => join(dir, ...path.split("/"));

  async function restore() {
    const latest = await store.version();
    const old = current;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    known = new Map();
    for (const path of await store.files()) {
      if (path.split("/").includes("..")) continue;
      const buf = gunzipSync(Buffer.from(await store.getFile(path), "base64"));
      mkdirSync(dirname(place(path)), { recursive: true, mode: 0o700 });
      writeFileSync(place(path), buf, { mode: 0o600 });
      known.set(path, digest(buf));
    }
    version = latest;
    current = build();
    checked = now();
    // A read that started on the old data may still be running; close it a
    // little later. Its files are already unlinked, so nothing mixes.
    if (old) setTimeout(() => quietly(() => old.close()), 30000).unref?.();
  }

  async function freshen(force) {
    if (!force && now() - checked < checkEvery) return;
    const latest = await store.version();
    checked = now();
    if (latest !== version) await restore();
  }

  async function save() {
    current.checkpoint();
    const here = new Map(localFiles().map((path) => [path, readFileSync(place(path))]));
    let changes = 0;
    for (const [path, buf] of here) {
      const hash = digest(buf);
      if (known.get(path) === hash) continue;
      await store.putFile(path, gzipSync(buf).toString("base64"));
      known.set(path, hash);
      changes += 1;
    }
    for (const path of [...known.keys()])
      if (!here.has(path)) {
        await store.dropFile(path);
        known.delete(path);
        changes += 1;
      }
    if (!changes) return true;
    const next = await store.bump(version);
    if (next == null) {
      log("Bounty keep: another instance saved at the same moment; reloading on the next request");
      checked = 0;
      version = -1;
      return false;
    }
    version = next;
    return true;
  }

  const saveQuietly = () => save().catch((error) => log("Bounty keep: save failed: " + error.message));

  async function ready() {
    if (!current) await (starting ||= serial(restore));
  }

  async function handle(req, res) {
    await ready();
    if (READS.has(req.method)) {
      if (now() - checked >= checkEvery) await serial(() => freshen(false)).catch(log);
      return current.handle(req, res);
    }
    return serial(async () => {
      await freshen(true).catch(log);
      await new Promise((resolve) => {
        res.once("finish", resolve);
        res.once("close", resolve);
        Promise.resolve()
          .then(() => current.handle(req, res))
          .catch((error) => {
            log("Bounty keep: request failed: " + error.message);
            resolve();
          });
      });
      if (res.statusCode < 400) await saveQuietly();
    });
  }

  /** Save now, for changes made outside a request. */
  function changed() {
    return serial(async () => {
      if (current) await saveQuietly();
    });
  }

  return { handle, changed, ready };
}

function quietly(fn) {
  try {
    fn();
  } catch {
    /* already closed */
  }
}

/** A store held in memory, for tests. */
export function memoryStore() {
  let version = 0;
  const files = new Map();
  return {
    async version() {
      return version;
    },
    async bump(from) {
      if (version !== from) return null;
      version += 1;
      return version;
    },
    async files() {
      return [...files.keys()].sort();
    },
    async getFile(path) {
      return files.get(path);
    },
    async putFile(path, data) {
      files.set(path, data);
    },
    async dropFile(path) {
      files.delete(path);
    },
  };
}

/** The same store in Postgres. query(text, params) returns rows. */
export async function postgresKeepStore(query) {
  await query(
    "CREATE TABLE IF NOT EXISTS bounty_keep (id text PRIMARY KEY, version bigint NOT NULL, saved_at timestamptz NOT NULL DEFAULT now())",
    [],
  );
  await query(
    "CREATE TABLE IF NOT EXISTS bounty_keep_files (path text PRIMARY KEY, data text NOT NULL, saved_at timestamptz NOT NULL DEFAULT now())",
    [],
  );
  return {
    async version() {
      const rows = await query("SELECT version FROM bounty_keep WHERE id = 'main'", []);
      return rows.length ? Number(rows[0].version) : 0;
    },
    async bump(from) {
      const rows =
        from === 0
          ? await query(
              "INSERT INTO bounty_keep (id, version) VALUES ('main', 1) ON CONFLICT (id) DO NOTHING RETURNING version",
              [],
            )
          : await query(
              "UPDATE bounty_keep SET version = version + 1, saved_at = now() WHERE id = 'main' AND version = $1 RETURNING version",
              [from],
            );
      return rows.length ? Number(rows[0].version) : null;
    },
    async files() {
      return (await query("SELECT path FROM bounty_keep_files ORDER BY path", [])).map((r) => r.path);
    },
    async getFile(path) {
      return (await query("SELECT data FROM bounty_keep_files WHERE path = $1", [path]))[0]?.data;
    },
    async putFile(path, data) {
      await query(
        "INSERT INTO bounty_keep_files (path, data) VALUES ($1, $2) ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, saved_at = now()",
        [path, data],
      );
    },
    async dropFile(path) {
      await query("DELETE FROM bounty_keep_files WHERE path = $1", [path]);
    },
  };
}

/** The Postgres store for a Neon connection string. */
export async function neonKeepStore(url) {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);
  return postgresKeepStore((text, params) => sql.query(text, params));
}
