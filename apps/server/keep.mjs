// Keeps members' records for good on the hosted site.
//
// On Vercel the API's SQLite database lives in the function's temporary
// storage, which is emptied whenever Vercel starts a fresh instance. This
// module copies the database, and the receipt and shelf photos beside it, to
// Postgres (Neon) after every change, and copies them back when an instance
// starts. Sign-in already lives in Neon (accounts.mjs).
//
// How it stays consistent between instances:
// - The copy in Postgres carries a version number.
// - Changes (anything but GET, HEAD, OPTIONS) run one at a time per instance.
//   Before a change the instance checks the version and reloads if another
//   instance saved since; after a successful change it saves with
//   "only if the version is still mine". If that fails (two instances saved
//   in the same moment) it logs it and reloads on the next request.
// - Reads check the version at most every few seconds.
// The database is small (a few hundred KB, a few tens of KB gzipped), so
// copying it whole is quick. This suits a pilot; a move to Postgres tables
// is the long-term route (docs/STALE.md).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const READS = new Set(["GET", "HEAD", "OPTIONS"]);
// Folders beside the database whose files are copied too.
export const KEPT_FOLDERS = ["proofs", "report-photos"];

/**
 * Wraps the API so the data directory survives restarts.
 * store: see memoryStore / postgresKeepStore. dir: the data directory.
 * build(file): opens the database at file and returns { db, handle(req, res) }.
 * Returns handle(req, res) plus changed() to save after work done outside a
 * request (the Open Prices import).
 */
export function keepForGood({ store, dir, build, log = console.error, checkEvery = 5000, now = Date.now }) {
  const file = join(dir, "desk.sqlite");
  let current = null;
  let version = 0;
  let checked = 0;
  let known = new Set();
  let starting = null;
  let queue = Promise.resolve();

  // One at a time: changes, reloads and saves never overlap on one instance.
  function serial(fn) {
    const run = queue.then(fn);
    queue = run.catch(() => undefined);
    return run;
  }

  async function restore() {
    const snap = await store.load();
    const old = current;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of [file, file + "-wal", file + "-shm"]) rmSync(f, { force: true });
    for (const folder of KEPT_FOLDERS) rmSync(join(dir, folder), { recursive: true, force: true });
    if (snap) writeFileSync(file, gunzipSync(Buffer.from(snap.data, "base64")), { mode: 0o600 });
    known = new Set();
    for (const path of await store.files()) {
      const target = join(dir, ...path.split("/"));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, Buffer.from(await store.getFile(path), "base64"), { mode: 0o600 });
      known.add(path);
    }
    version = snap ? snap.version : 0;
    current = build(file);
    checked = now();
    // A read that started on the old database may still be running; close it
    // a little later. The old file is already unlinked, so nothing mixes.
    if (old) setTimeout(() => closeQuietly(old.db), 30000).unref?.();
  }

  async function freshen(force) {
    if (!force && now() - checked < checkEvery) return;
    const latest = await store.version();
    checked = now();
    if (latest !== version) await restore();
  }

  function localFiles() {
    const out = [];
    const walk = (folder) => {
      if (!existsSync(folder)) return;
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const full = join(folder, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) out.push(relative(dir, full).split(sep).join("/"));
      }
    };
    for (const folder of KEPT_FOLDERS) walk(join(dir, folder));
    return out;
  }

  async function save() {
    current.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const data = gzipSync(readFileSync(file)).toString("base64");
    const next = await store.save(data, version);
    if (next == null) {
      log("Bounty keep: another instance saved at the same moment; reloading on the next request");
      checked = 0;
      version = -1;
      return false;
    }
    version = next;
    const here = new Set(localFiles());
    for (const path of here)
      if (!known.has(path)) {
        await store.putFile(path, readFileSync(join(dir, ...path.split("/"))).toString("base64"));
        known.add(path);
      }
    for (const path of [...known])
      if (!here.has(path)) {
        await store.dropFile(path);
        known.delete(path);
      }
    return true;
  }

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
      if (res.statusCode < 400) await save().catch((error) => log("Bounty keep: save failed: " + error.message));
    });
  }

  /** Save now, for changes made outside a request. */
  function changed() {
    return serial(async () => {
      if (current) await save().catch((error) => log("Bounty keep: save failed: " + error.message));
    });
  }

  return { handle, changed, ready, get db() { return current?.db; } };
}

function closeQuietly(db) {
  try {
    db.close();
  } catch {
    /* already closed */
  }
}

/** A store held in memory, for tests and for trying the module out. */
export function memoryStore() {
  let snap = null;
  const files = new Map();
  return {
    async version() {
      return snap ? snap.version : 0;
    },
    async load() {
      return snap && { ...snap };
    },
    async save(data, from) {
      if ((snap ? snap.version : 0) !== from) return null;
      snap = { version: from + 1, data };
      return snap.version;
    },
    async files() {
      return [...files.keys()];
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
    "CREATE TABLE IF NOT EXISTS bounty_keep (id text PRIMARY KEY, version bigint NOT NULL, data text NOT NULL, saved_at timestamptz NOT NULL DEFAULT now())",
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
    async load() {
      const rows = await query("SELECT version, data FROM bounty_keep WHERE id = 'main'", []);
      return rows.length ? { version: Number(rows[0].version), data: rows[0].data } : null;
    },
    async save(data, from) {
      const rows =
        from === 0
          ? await query(
              "INSERT INTO bounty_keep (id, version, data) VALUES ('main', 1, $1) ON CONFLICT (id) DO NOTHING RETURNING version",
              [data],
            )
          : await query(
              "UPDATE bounty_keep SET data = $1, version = version + 1, saved_at = now() WHERE id = 'main' AND version = $2 RETURNING version",
              [data, from],
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
