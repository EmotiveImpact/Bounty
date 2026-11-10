// Real PostgreSQL SQL execution via embedded PGlite, with no connection string
// or network. PGlite is single-session: independent server-session locking is
// a separate deployment gate, not claimed by these tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { postgresKeepStore } from "./keep.mjs";

async function database(t) {
  const db = new PGlite();
  t.after(() => db.close());
  const query = async (text, params) => (await db.query(text, params)).rows;
  const store = await postgresKeepStore(query);
  return { db, query, store };
}
const file = (path, data) => ({ path, data });

test("Postgres: existing version and every legacy file survive initialisation", async (t) => {
  const { db, query } = await database(t);
  await db.exec(`CREATE TABLE bounty_keep (id text PRIMARY KEY, version bigint NOT NULL, saved_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE bounty_keep_files (path text PRIMARY KEY, data text NOT NULL, saved_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO bounty_keep VALUES ('main', 41, now());
    INSERT INTO bounty_keep_files VALUES ('members/synthetic/desk.sqlite', 'synthetic db', now()), ('proofs/synthetic.jpg', 'synthetic receipt', now());`);
  const store = await postgresKeepStore(query);
  assert.deepEqual(await store.snapshot(), { version: 41, files: {
    'members/synthetic/desk.sqlite': 'synthetic db', 'proofs/synthetic.jpg': 'synthetic receipt',
  } });
  assert.equal(await store.commit(41, [file('new', 'new value')], []), 42);
  assert.equal(Object.keys((await store.snapshot()).files).length, 3);
});

test("Postgres: first-use version zero adopts existing files without clearing them", async (t) => {
  const { db, store } = await database(t);
  await db.exec(`CREATE TABLE bounty_keep_files (path text PRIMARY KEY, data text NOT NULL, saved_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO bounty_keep_files VALUES ('synthetic-receipt', 'kept', now());`);
  assert.deepEqual(await store.snapshot(), { version: 0, files: { 'synthetic-receipt': 'kept' } });
  assert.equal(await store.commit(0, [file('synthetic-db', 'db')], []), 1);
  assert.equal((await store.snapshot()).files['synthetic-receipt'], 'kept');
});

test("Postgres: a stale snapshot cannot upload, overwrite or delete files", async (t) => {
  const { store } = await database(t);
  assert.equal(await store.commit(0, [file('db', 'original'), file('receipt', 'original receipt')], []), 1);
  assert.equal(await store.commit(1, [file('db', 'winner'), file('new receipt', 'winner receipt')], []), 2);
  const winner = await store.snapshot();
  assert.equal(await store.commit(1, [file('db', 'loser'), file('loser only', 'discard')], ['receipt', 'new receipt']), null);
  assert.deepEqual(await store.snapshot(), winner);
});

test("Postgres: an interrupted statement rolls back version, uploads and deletes together", async (t) => {
  const { db, store } = await database(t);
  await store.commit(0, [file('db', 'original'), file('receipt', 'keep me')], []);
  const original = await store.snapshot();
  await db.exec(`CREATE FUNCTION fail_synthetic_upload() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.path = 'fail-here' THEN RAISE EXCEPTION 'synthetic interrupted save'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER synthetic_upload_failure BEFORE INSERT OR UPDATE ON bounty_keep_files
    FOR EACH ROW EXECUTE FUNCTION fail_synthetic_upload();`);
  await assert.rejects(store.commit(1, [file('db', 'changed'), file('new file', 'partial'), file('fail-here', 'interrupt')], ['receipt']), /synthetic interrupted save/);
  assert.deepEqual(await store.snapshot(), original);
  await db.exec('DROP TRIGGER synthetic_upload_failure ON bounty_keep_files');
  assert.equal(await store.commit(1, [file('db', 'retry')], []), 2);
  assert.deepEqual((await store.snapshot()).files, { db: 'retry', receipt: 'keep me' });
});

test("Postgres: a failed initial setup can be retried on the same store", async (t) => {
  const { query } = await database(t);
  let offline = true;
  const store = await postgresKeepStore(async (...args) => {
    if (offline) throw Error('synthetic unavailable Neon');
    return query(...args);
  });
  await assert.rejects(store.snapshot(), /unavailable Neon/);
  offline = false;
  assert.deepEqual(await store.snapshot(), { version: 0, files: {} });
  assert.equal(await store.commit(0, [file('db', 'retry')], []), 1);
});

test("Postgres: restore uses one statement snapshot for version and files", async (t) => {
  const { query } = await database(t);
  const sent = [];
  const store = await postgresKeepStore(async (text, params) => { sent.push(text); return query(text, params); });
  await store.commit(0, [file('db', 'first')], []);
  sent.length = 0;
  assert.deepEqual(await store.snapshot(), { version: 1, files: { db: 'first' } });
  assert.equal(sent.length, 1);
});
