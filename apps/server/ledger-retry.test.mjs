import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryDb, serve } from './test-support.mjs';
import { schema, createTrip, addEntry, deleteEntry, closeTrip } from './ledger.mjs';
import * as routes from './routes-ledger.mjs';

const trip = { label: 'Synthetic trip', source: 'manual', kind: 'resale', requestId: 'trip_synthetic_0001' };
const entry = { type: 'receipt', amount: 1250, units: 1, occurred: '2026-01-01', requestId: 'entry_synthetic_0001' };

test('lost trip and receipt acknowledgements can be retried after an instance restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bounty-retry-'));
  let db;
  try {
    db = new DatabaseSync(join(dir, 'synthetic.sqlite')); schema(db);
    const id = createTrip(db, trip);
    const entryId = addEntry(db, id, entry); // Pretend these response bytes were lost.
    db.close();
    db = new DatabaseSync(join(dir, 'synthetic.sqlite')); schema(db);
    assert.equal(createTrip(db, trip), id);
    assert.equal(addEntry(db, id, entry), entryId);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger_trips').get().n, 1);
    assert.equal(db.prepare('SELECT SUM(amount) n FROM ledger_entries').get().n, 1250);
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('request identifiers reject changed payloads and retain deletion tombstones', () => {
  const db = memoryDb(schema);
  try {
    const id = createTrip(db, trip);
    assert.throws(() => createTrip(db, { ...trip, label: 'Different' }), { status: 409 });
    const eid = addEntry(db, id, entry);
    assert.throws(() => addEntry(db, id, { ...entry, amount: 2500 }), { status: 409 });
    deleteEntry(db, id, eid);
    assert.throws(() => addEntry(db, id, entry), { status: 409 });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger_entries').get().n, 0);
  } finally { db.close(); }
});

test('retries work after trip closure, reordered JSON and validation failures', () => {
  const db = memoryDb(schema);
  try {
    const id = createTrip(db, trip);
    assert.throws(() => addEntry(db, id, { ...entry, amount: -1 }));
    const eid = addEntry(db, id, entry);
    closeTrip(db, id);
    assert.equal(addEntry(db, id, Object.fromEntries(Object.entries(entry).reverse())), eid);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger_entries').get().n, 1);
  } finally { db.close(); }
});

test('simultaneous HTTP retries create one trip and one payout; a new intent remains distinct', async () => {
  const db = memoryDb(schema);
  const server = await serve(db, [routes]);
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => server.call('POST', '/api/ledger/trips', trip)));
    assert.ok(results.every(r => r.status === 201));
    assert.equal(new Set(results.map(r => r.body.id)).size, 1);
    const id = results[0].body.id;
    const payout = { ...entry, type: 'payout' };
    const payouts = await Promise.all(Array.from({ length: 8 }, () => server.call('POST', `/api/ledger/trips/${id}/entries`, payout)));
    assert.equal(new Set(payouts.map(r => r.body.id)).size, 1);
    const next = await server.call('POST', `/api/ledger/trips/${id}/entries`, { ...payout, requestId: 'entry_synthetic_0002' });
    assert.equal(next.status, 201);
    assert.equal(db.prepare('SELECT SUM(amount) n FROM ledger_entries').get().n, 2500);
  } finally { await server.close(); db.close(); }
});
