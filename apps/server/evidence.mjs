// Evidence storage: licensed and provider research rows, Open Prices
// observations, display permissions, import runs and the lookup cache.
// Every function takes db as a parameter; nothing here opens a database.
import {
  KINDS,
  LICENCE,
  RESEARCH_TABLE,
  RESEARCH_COLUMNS,
  RESEARCH_TYPES,
  OBSERVATIONS_TABLE,
  OBSERVATION_COLUMNS,
  OBSERVATION_TYPES,
  PERMISSIONS_TABLE,
  addMissingColumns,
} from "./contract.mjs";
import { SOURCES, redact, sourceFor } from "./sources.mjs";
import { transaction } from "./http.mjs";

export const RUN_MODES = Object.freeze(["scheduled", "manual", "lookup"]);
// A public scheduled source with no successful import for this long is stale.
export const STALE_HOURS = 24;

const IMPORT_RUNS_TABLE = `CREATE TABLE IF NOT EXISTS import_runs (
 id INTEGER PRIMARY KEY,
 provider TEXT NOT NULL,
 mode TEXT NOT NULL,
 query TEXT,
 started TEXT NOT NULL,
 finished TEXT,
 ok INTEGER NOT NULL DEFAULT 0,
 rows INTEGER NOT NULL DEFAULT 0,
 error TEXT,
 cached INTEGER NOT NULL DEFAULT 0
)`;
const IMPORT_RUN_COLUMNS = [
  "id", "provider", "mode", "query", "started", "finished", "ok", "rows",
  "error", "cached",
];
const IMPORT_RUN_TYPES = {
  ok: "INTEGER NOT NULL DEFAULT 0",
  rows: "INTEGER NOT NULL DEFAULT 0",
  cached: "INTEGER NOT NULL DEFAULT 0",
};

// One row per credentialed lookup (provider + normalised query). source_ids
// is a JSON array of the research rows that lookup saved, so a repeat inside
// the time to live can reuse them without a paid network call.
const LOOKUP_CACHE_TABLE = `CREATE TABLE IF NOT EXISTS lookup_cache (
 provider TEXT NOT NULL,
 query TEXT NOT NULL,
 fetched TEXT NOT NULL,
 source_ids TEXT NOT NULL DEFAULT '[]',
 PRIMARY KEY(provider, query)
)`;

// Licence for research rows saved before the licence column existed.
const LEGACY_LICENCE = `CASE provider
 WHEN 'awin' THEN '${LICENCE.FEED}'
 WHEN 'sales' THEN '${LICENCE.SELF}'
 ELSE '${LICENCE.PROVIDER}' END`;

// SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC) to ISO 8601, so that
// dates compare and parse consistently with rows written by this module.
const isoFix = (table, column) =>
  `UPDATE ${table} SET ${column} = replace(${column}, ' ', 'T') || 'Z'
 WHERE ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]';`;

/**
 * Creates the evidence tables and migrates an older local database in place.
 * Idempotent. Older databases (d456f87) had research without match
 * attributes and observations without import times; columns are added and
 * backfilled, and no row is removed.
 */
export function schema(db) {
  db.exec(RESEARCH_TABLE);
  addMissingColumns(db, "research", RESEARCH_COLUMNS, RESEARCH_TYPES);
  db.exec(OBSERVATIONS_TABLE);
  addMissingColumns(db, "observations", OBSERVATION_COLUMNS, OBSERVATION_TYPES);
  db.exec(`UPDATE research SET imported = COALESCE(imported, CURRENT_TIMESTAMP) WHERE imported IS NULL;
UPDATE research SET first_imported = imported WHERE first_imported IS NULL;
UPDATE research SET licence = ${LEGACY_LICENCE} WHERE licence IS NULL;
UPDATE observations SET imported = COALESCE(imported, CURRENT_TIMESTAMP) WHERE imported IS NULL;
UPDATE observations SET first_imported = imported WHERE first_imported IS NULL;
UPDATE observations SET unit = NULL WHERE unit = 'UNKNOWN' OR unit = '';
UPDATE observations SET place = NULL WHERE place = '';
${isoFix("research", "imported")}
${isoFix("research", "first_imported")}
${isoFix("observations", "imported")}
${isoFix("observations", "first_imported")}`);
  db.exec(PERMISSIONS_TABLE);
  db.exec(IMPORT_RUNS_TABLE);
  addMissingColumns(db, "import_runs", IMPORT_RUN_COLUMNS, IMPORT_RUN_TYPES);
  db.exec(LOOKUP_CACHE_TABLE);
  db.exec(`CREATE INDEX IF NOT EXISTS research_kind_barcode_idx ON research(kind, barcode);
CREATE INDEX IF NOT EXISTS research_barcode_idx ON research(barcode);
CREATE INDEX IF NOT EXISTS observations_barcode_idx ON observations(barcode);
CREATE INDEX IF NOT EXISTS import_runs_provider_idx ON import_runs(provider, id);`);
}

const stamp = (now) => new Date(now ?? Date.now()).toISOString();
// Joins a caller's open transaction instead of failing to nest one.
const atomically = (db, fn) => (db.isTransaction ? fn() : transaction(db, fn));
const textOrNull = (value, max = 2000) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const pennies = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * Whether a research row can be saved: a source id, a title, a known
 * evidence class and a positive whole-pence price. Anything else is skipped.
 */
export function validResearchRow(row) {
  const id = row?.source_id ?? row?.id;
  return Boolean(
    row &&
      (typeof id === "string" ? id.trim() : Number.isSafeInteger(id)) &&
      textOrNull(row.title) &&
      KINDS.includes(row.kind) &&
      Number.isSafeInteger(row.price) &&
      row.price > 0,
  );
}

const RESEARCH_FIELDS = [
  "kind", "title", "barcode", "variant", "size", "pack", "model", "condition",
  "price", "shipping", "observed", "listed", "retailer", "location",
  "availability", "promotion", "seller", "url", "licence", "was_price",
  "rrp_price",
];

/**
 * Upserts research rows for one provider and returns how many were saved.
 * A repeat of the same (provider, source_id) refreshes every field and the
 * imported time but keeps first_imported, so a retry never duplicates a row
 * and the first sighting stays visible. Invalid rows are skipped.
 */
export function upsertResearch(db, provider, rows, { now } = {}) {
  const key = textOrNull(provider, 40);
  if (!key) throw Error("A provider is required");
  if (!Array.isArray(rows)) throw Error("Expected an array of research rows");
  const at = stamp(now);
  const insert = db.prepare(`INSERT INTO research(provider, source_id, ${RESEARCH_FIELDS.join(", ")}, imported, first_imported)
VALUES (${Array(RESEARCH_FIELDS.length + 4).fill("?").join(", ")})
ON CONFLICT(provider, source_id) DO UPDATE SET
${RESEARCH_FIELDS.map((f) => `${f} = excluded.${f}`).join(",\n")},
imported = excluded.imported,
first_imported = COALESCE(research.first_imported, excluded.first_imported)`);
  return atomically(db, () => {
    let saved = 0;
    for (const row of rows) {
      if (!validResearchRow(row)) continue;
      const values = RESEARCH_FIELDS.map((f) => {
        if (f === "price") return row.price;
        if (f === "shipping" || f === "was_price" || f === "rrp_price") return pennies(row[f]);
        if (f === "title") return textOrNull(row.title, 500);
        return textOrNull(row[f]);
      });
      insert.run(key, String(row.source_id ?? row.id).trim(), ...values, at, at);
      saved++;
    }
    return saved;
  });
}

const OBSERVATION_FIELDS = [
  "title", "store", "place", "city", "osm_id", "price", "regular_price",
  "discounted", "discount_type", "day", "unit", "quantity", "barcode",
  "proof_id", "licence",
];

/** Whether an Open Prices row can be saved: integer id, dated, positive price. */
export function validObservation(row) {
  return Boolean(
    row &&
      Number.isSafeInteger(row.id) &&
      row.id > 0 &&
      Number.isSafeInteger(row.price) &&
      row.price > 0 &&
      typeof row.day === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(row.day),
  );
}

/**
 * Upserts Open Prices observations by price id and returns the saved count.
 * Same rules as upsertResearch: a retry refreshes fields and imported, keeps
 * first_imported, and skips invalid rows. Licence is always ODbL.
 */
export function upsertObservations(db, rows, { now } = {}) {
  if (!Array.isArray(rows)) throw Error("Expected an array of observations");
  const at = stamp(now);
  const insert = db.prepare(`INSERT INTO observations(id, ${OBSERVATION_FIELDS.join(", ")}, imported, first_imported)
VALUES (${Array(OBSERVATION_FIELDS.length + 3).fill("?").join(", ")})
ON CONFLICT(id) DO UPDATE SET
${OBSERVATION_FIELDS.map((f) => `${f} = excluded.${f}`).join(",\n")},
imported = excluded.imported,
first_imported = COALESCE(observations.first_imported, excluded.first_imported)`);
  return atomically(db, () => {
    let saved = 0;
    for (const row of rows) {
      if (!validObservation(row)) continue;
      const values = OBSERVATION_FIELDS.map((f) => {
        if (f === "price") return row.price;
        if (f === "regular_price") return pennies(row.regular_price);
        if (f === "discounted") return row.discounted ? 1 : 0;
        if (f === "licence") return LICENCE.ODBL;
        return textOrNull(row[f] === undefined || row[f] === null ? null : String(row[f]), 500);
      });
      insert.run(row.id, ...values, at, at);
      saved++;
    }
    return saved;
  });
}

/**
 * Records one import attempt. Errors and queries pass through redact() so a
 * credential value can never be stored, even if an upstream echoed it.
 * Returns the run id.
 */
export function recordRun(db, run, { env = process.env } = {}) {
  if (!RUN_MODES.includes(run.mode)) throw Error("Unknown run mode " + run.mode);
  const provider = textOrNull(run.provider, 40);
  if (!provider) throw Error("A provider is required");
  const started = stamp(run.started);
  const result = db
    .prepare(
      `INSERT INTO import_runs(provider, mode, query, started, finished, ok, rows, error, cached)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      provider,
      run.mode,
      run.query ? redact(String(run.query), env).slice(0, 200) : null,
      started,
      run.finished ? stamp(run.finished) : started,
      run.ok ? 1 : 0,
      Number.isSafeInteger(run.rows) && run.rows > 0 ? run.rows : 0,
      run.error ? redact(String(run.error?.message ?? run.error), env).slice(0, 500) : null,
      run.cached ? 1 : 0,
    );
  return Number(result.lastInsertRowid);
}

const runShape = (r) =>
  r && {
    id: r.id,
    provider: r.provider,
    mode: r.mode,
    query: r.query,
    started: r.started,
    finished: r.finished,
    ok: r.ok === 1,
    rows: r.rows,
    error: r.error,
    cached: r.cached === 1,
  };

/** The most recent import runs, newest first. */
export function recentRuns(db, limit = 20) {
  const n = Math.min(Math.max(1, Math.floor(Number(limit) || 20)), 200);
  return db
    .prepare("SELECT * FROM import_runs ORDER BY started DESC, id DESC LIMIT ?")
    .all(n)
    .map(runShape);
}

/**
 * Readiness of every registered source: configuration, licence, last run,
 * last real fetch, last error, stored rows and staleness. Only credential
 * names appear, never their values. A cached lookup is not a fresh fetch.
 */
export function readiness(db, env = process.env, { now } = {}) {
  const at = Date.parse(stamp(now));
  const last = db.prepare(
    "SELECT * FROM import_runs WHERE provider = ? ORDER BY started DESC, id DESC LIMIT 1",
  );
  const lastOk = db.prepare(
    "SELECT finished FROM import_runs WHERE provider = ? AND ok = 1 AND cached = 0 ORDER BY finished DESC, id DESC LIMIT 1",
  );
  const lastFail = db.prepare(
    "SELECT started, error FROM import_runs WHERE provider = ? AND ok = 0 ORDER BY started DESC, id DESC LIMIT 1",
  );
  const researchCount = db.prepare("SELECT COUNT(*) AS n FROM research WHERE provider = ?");
  const observationCount = db.prepare("SELECT COUNT(*) AS n FROM observations");
  return SOURCES.map((s) => {
    const hasCredential =
      s.mode === "credential" &&
      typeof env[s.credential] === "string" &&
      env[s.credential].trim() !== "";
    const lastSuccess = lastOk.get(s.provider)?.finished ?? null;
    const failure = lastFail.get(s.provider);
    const successAge = lastSuccess ? at - Date.parse(lastSuccess) : Infinity;
    return {
      provider: s.provider,
      name: s.name,
      kind: s.kind,
      licence: s.licence,
      mode: s.mode,
      credential: s.credential ?? null,
      status:
        s.mode === "credential"
          ? hasCredential
            ? "Credential configured"
            : "Needs " + s.credential
          : s.mode === "file"
            ? "Local import"
            : "Public API",
      command: s.command,
      upstream: s.upstream,
      cacheHours: s.ttlHours ?? null,
      lastRun: runShape(last.get(s.provider)) ?? null,
      lastSuccess,
      lastError: failure?.error ?? null,
      lastErrorAt: failure?.started ?? null,
      rows: (s.provider === "openprices" ? observationCount.get() : researchCount.get(s.provider)).n,
      stale: Boolean(s.scheduled) && !(successAge <= STALE_HOURS * 3600000),
    };
  });
}

const likeTerm = (value) => "%" + value.toLowerCase().replace(/[\\%_]/g, (c) => "\\" + c) + "%";
const clampLimit = (limit, fallback = 100) =>
  Math.min(500, Math.max(1, Number.isSafeInteger(limit) ? limit : fallback));
const clampOffset = (offset) => (Number.isSafeInteger(offset) && offset > 0 ? offset : 0);

/**
 * Research evidence with filters and a total, so callers can see when more
 * rows exist than one page holds (sold records are never silently cut off).
 * Newest source date first; rows without a source date last.
 */
export function listEvidence(db, { kind, barcode, q, provider, limit, offset } = {}) {
  const where = [];
  const params = [];
  for (const [column, value] of [["kind", kind], ["barcode", barcode], ["provider", provider]]) {
    if (!value) continue;
    where.push(column + " = ?");
    params.push(value);
  }
  if (q) {
    where.push(
      "(lower(title) LIKE ? ESCAPE '\\' OR COALESCE(barcode, '') LIKE ? ESCAPE '\\' OR lower(COALESCE(variant, '')) LIKE ? ESCAPE '\\')",
    );
    const term = likeTerm(q);
    params.push(term, term, term);
  }
  const clause = where.length ? " WHERE " + where.join(" AND ") : "";
  const total = db.prepare("SELECT COUNT(*) AS n FROM research" + clause).get(...params).n;
  const rows = db
    .prepare(
      `SELECT * FROM research${clause}
ORDER BY observed IS NULL, observed DESC, imported DESC, provider, source_id
LIMIT ? OFFSET ?`,
    )
    .all(...params, clampLimit(limit), clampOffset(offset));
  return { rows, total };
}

/** Open Prices observations, newest observation date first, with a total. */
export function listObservations(db, { barcode, limit, offset } = {}) {
  const clause = barcode ? " WHERE barcode = ?" : "";
  const params = barcode ? [barcode] : [];
  const total = db.prepare("SELECT COUNT(*) AS n FROM observations" + clause).get(...params).n;
  const rows = db
    .prepare(`SELECT * FROM observations${clause} ORDER BY day DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, clampLimit(limit), clampOffset(offset))
    .map((r) => ({ ...r, discounted: r.discounted === 1 }));
  return { rows, total };
}

// ---------------------------------------------------------------------------
// Display permissions. Absence means display is not permitted.

const permissionShape = (r) => ({
  provider: r.provider,
  programme: r.programme,
  display: r.display === 1,
  note: r.note,
  updated: r.updated,
});

/**
 * Records whether a provider (programme '') or one programme of it, such as
 * an Awin advertiser, permits showing its offers. Programme names compare
 * without regard to case, so "Argos" and "argos" are one programme.
 */
export function setPermission(db, { provider, programme = "", display, note = null }, { now } = {}) {
  const key = textOrNull(provider, 40)?.toLowerCase();
  if (!key) throw Error("A provider is required");
  if (typeof display !== "boolean") throw Error("display must be true or false");
  const name = textOrNull(programme ?? "", 200) ?? "";
  return atomically(db, () => {
    db.prepare(
      "DELETE FROM permissions WHERE provider = ? AND programme = ? COLLATE NOCASE AND programme <> ?",
    ).run(key, name, name);
    db.prepare(
      `INSERT INTO permissions(provider, programme, display, note, updated) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(provider, programme) DO UPDATE SET display = excluded.display, note = excluded.note, updated = excluded.updated`,
    ).run(key, name, display ? 1 : 0, textOrNull(note, 500), stamp(now));
    return permissionShape(
      db.prepare("SELECT * FROM permissions WHERE provider = ? AND programme = ?").get(key, name),
    );
  });
}

/**
 * Whether offers from provider (and programme, when given) may be shown.
 * A programme-specific row wins, then the provider-wide '' row; with
 * neither, display is not permitted, except for Open Prices (ODbL).
 */
export function displayPermitted(db, provider, programme = "") {
  const key = textOrNull(provider, 40)?.toLowerCase();
  if (!key) return false;
  const name = textOrNull(programme ?? "", 200);
  const find = db.prepare(
    "SELECT display FROM permissions WHERE provider = ? AND programme = ? COLLATE NOCASE",
  );
  const specific = name ? find.get(key, name) : undefined;
  if (specific) return specific.display === 1;
  const wide = find.get(key, "");
  if (wide) return wide.display === 1;
  // Open Prices is published under the ODbL, which permits display with
  // attribution (shown wherever observations appear). An explicit
  // permissions row for openprices still overrides this default.
  return key === "openprices";
}

export function listPermissions(db) {
  return db
    .prepare("SELECT * FROM permissions ORDER BY provider, programme")
    .all()
    .map(permissionShape);
}

// ---------------------------------------------------------------------------
// Lookup cache for credentialed providers.

/** Cache key: provider plus the trimmed, single-spaced, lower-case query. */
export const cacheQuery = (query) => String(query ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The cached result of a lookup still inside its time to live, or null.
 * Returns { fetched, expires, rows } where rows are the stored research rows
 * that lookup saved (their imported time is the original fetch, not now).
 */
export function cachedLookup(db, provider, query, { now, ttlHours } = {}) {
  const hours = ttlHours ?? sourceFor(provider)?.ttlHours;
  if (!hours) return null;
  const hit = db
    .prepare("SELECT * FROM lookup_cache WHERE provider = ? AND query = ?")
    .get(provider, cacheQuery(query));
  if (!hit) return null;
  const expires = Date.parse(hit.fetched) + hours * 3600000;
  const at = Date.parse(stamp(now));
  if (!(at < expires) || at < Date.parse(hit.fetched)) return null;
  const rows = db
    .prepare(
      `SELECT r.* FROM research r JOIN json_each(?) j ON r.source_id = j.value
WHERE r.provider = ? ORDER BY r.observed IS NULL, r.observed DESC, r.source_id`,
    )
    .all(hit.source_ids, provider);
  return { fetched: hit.fetched, expires: new Date(expires).toISOString(), rows };
}

/** Stores the source ids a successful lookup saved. */
export function storeLookup(db, provider, query, sourceIds, { now } = {}) {
  db.prepare(
    `INSERT INTO lookup_cache(provider, query, fetched, source_ids) VALUES (?, ?, ?, ?)
ON CONFLICT(provider, query) DO UPDATE SET fetched = excluded.fetched, source_ids = excluded.source_ids`,
  ).run(provider, cacheQuery(query), stamp(now), JSON.stringify([...new Set(sourceIds.map(String))]));
}
