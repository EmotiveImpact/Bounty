// Optional native PostgreSQL lab. It always creates its own disposable cluster
// on loopback; it does not read DATABASE_URL or accept an external connection.
// Setup/run instructions and the pinned package version: docs/DURABLE-WRITES.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { postgresKeepStore } from '../apps/server/keep.mjs';

const { default: EmbeddedPostgres } = await import(process.env.BOUNTY_PG_LAB_MODULE || 'embedded-postgres');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
};
const file = (path, data) => ({ path, data });

test('isolated native PostgreSQL durability lab', { timeout: 60000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bounty-native-pg-synthetic-'));
  const pg = new EmbeddedPostgres({
    databaseDir: join(root, 'cluster'), user: 'synthetic', password: 'synthetic-local-only',
    port: await freePort(), persistent: true, autoRehydrateSymlinks: true,
    postgresFlags: ['-h', '127.0.0.1', '-k', ''], onLog: (message) => { if (process.env.BOUNTY_PG_LAB_VERBOSE) console.error(message); }, onError: (error) => { if (process.env.BOUNTY_PG_LAB_VERBOSE) console.error(error); },
  });
  t.after(async () => {
    // The helper otherwise waits forever when PostgreSQL failed before start.
    if (pg.process && (pg.process.exitCode !== null || pg.process.signalCode)) pg.process = undefined;
    await pg.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await pg.initialise();
  await pg.start();
  const clients = new Set();
  const connect = async (schema) => {
    const client = pg.getPgClient('postgres', '127.0.0.1');
    client.on('error', () => {}); // A deliberately terminated backend is tested below.
    await client.connect();
    clients.add(client);
    await client.query(`SET search_path TO ${schema}`); // Fixed synthetic schema names only.
    return client;
  };
  t.after(async () => { for (const client of clients) await client.end().catch(() => {}); });
  const admin = await connect('public');
  console.log((await admin.query('SELECT version()')).rows[0].version);
  const query = (client) => async (sql, params) => (await client.query(sql, params)).rows;
  const waitFor = async (predicate) => {
    const until = Date.now() + 5000;
    while (!(await predicate())) {
      if (Date.now() > until) throw Error('Synthetic barrier timed out');
      await sleep(10);
    }
  };

  await t.test('legacy code reproduces a stale overwrite and an interrupted mixed snapshot', async () => {
    const source = execFileSync('git', ['show', 'f88a857c0f236af956215b22cfcaa4c699b14053:apps/server/keep.mjs'], { encoding: 'utf8' });
    const legacyPath = join(root, 'legacy-keep.mjs');
    writeFileSync(legacyPath, source);
    const { postgresKeepStore: legacyStore } = await import(pathToFileURL(legacyPath));
    await admin.query('CREATE SCHEMA synthetic_legacy');
    const client = await connect('synthetic_legacy');
    const store = await legacyStore(query(client));
    await store.putFile('db', 'original db');
    await store.putFile('receipt', 'original receipt');
    assert.equal(await store.bump(0), 1);
    await store.putFile('db', 'winner db');
    assert.equal(await store.bump(1), 2);
    await store.putFile('db', 'loser db');
    assert.equal(await store.bump(1), null);
    assert.equal(await store.getFile('db'), 'loser db', 'legacy losing writer already overwrote the winner');
    await store.putFile('db', 'interrupted new db'); // Interruption before the remaining files and version.
    assert.equal(await store.version(), 2);
    assert.equal(await store.getFile('receipt'), 'original receipt');
    assert.equal(await store.getFile('db'), 'interrupted new db');
  });

  await t.test('two server sessions recheck the version after a row-lock wait', async () => {
    await admin.query('CREATE SCHEMA synthetic_race');
    const a = await connect('synthetic_race');
    const b = await connect('synthetic_race');
    const reader = await connect('synthetic_race');
    const sa = await postgresKeepStore(query(a));
    const sb = await postgresKeepStore(query(b));
    const sr = await postgresKeepStore(query(reader));
    await sa.commit(0, [file('db', 'original'), file('receipt', 'keep me')], []);
    await sb.snapshot(); await sr.snapshot();
    await a.query('BEGIN');
    assert.equal(await sa.commit(1, [file('db', 'winner'), file('new receipt', 'winner receipt')], []), 2);
    const losing = sb.commit(1, [file('db', 'loser'), file('loser only', 'bad')], ['receipt', 'new receipt']);
    await waitFor(async () => (await admin.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [b.processID])).rows[0]?.wait_event_type === 'Lock');
    assert.deepEqual(await sr.snapshot(), { version: 1, files: { db: 'original', receipt: 'keep me' } });
    await a.query('COMMIT');
    assert.equal(await losing, null);
    assert.deepEqual(await sr.snapshot(), { version: 2, files: { db: 'winner', receipt: 'keep me', 'new receipt': 'winner receipt' } });
    assert.equal(await sb.commit(2, [file('retry', 'successful retry')], []), 3);
  });

  await t.test('terminating a backend during a save rolls back every file and the version', async () => {
    await admin.query('CREATE SCHEMA synthetic_interruption');
    const a = await connect('synthetic_interruption');
    const reader = await connect('synthetic_interruption');
    const sa = await postgresKeepStore(query(a));
    const sr = await postgresKeepStore(query(reader));
    await sa.commit(0, [file('db', 'original'), file('receipt', 'original receipt')], []);
    const original = await sr.snapshot();
    await a.query(`CREATE FUNCTION pause_synthetic_upload() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.path = 'pause' THEN PERFORM pg_sleep(20); END IF; RETURN NEW; END $$;
      CREATE TRIGGER pause_synthetic BEFORE INSERT OR UPDATE ON bounty_keep_files
      FOR EACH ROW EXECUTE FUNCTION pause_synthetic_upload();`);
    const saving = sa.commit(1, [file('db', 'partial'), file('pause', 'interrupt')], ['receipt']);
    const rejected = assert.rejects(saving);
    await waitFor(async () => (await admin.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1', [a.processID])).rows[0]?.wait_event === 'PgSleep');
    await admin.query('SELECT pg_terminate_backend($1)', [a.processID]);
    await rejected;
    assert.deepEqual(await sr.snapshot(), original);
    await reader.query('DROP TRIGGER pause_synthetic ON bounty_keep_files');
    assert.equal(await sr.commit(1, [file('db', 'retry')], []), 2);
  });

  await t.test('a full database process restart preserves only committed snapshots', async () => {
    for (const client of clients) await client.end().catch(() => {});
    clients.clear();
    await pg.stop();
    await pg.start();
    const client = await connect('synthetic_interruption');
    const store = await postgresKeepStore(query(client));
    assert.deepEqual(await store.snapshot(), { version: 2, files: { db: 'retry', receipt: 'original receipt' } });
  });
});
