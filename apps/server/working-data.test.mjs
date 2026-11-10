import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from './keep.mjs';
import { withWorkingData } from './working-data.mjs';

test('CLI import: independent caches persist completed imports and discard thrown mutations', async () => {
  const store = memoryStore();
  await withWorkingData(db => { db.exec("CREATE TABLE synthetic_import (value TEXT); INSERT INTO synthetic_import VALUES ('saved')"); }, { store });
  const before = await store.snapshot();
  await assert.rejects(withWorkingData(db => { db.exec("INSERT INTO synthetic_import VALUES ('refused')"); throw Error('interrupted import'); }, { store }), /interrupted import/);
  assert.deepEqual(await store.snapshot(), before);
  const rows = await withWorkingData(db => db.prepare('SELECT * FROM synthetic_import').all(), { store });
  assert.deepEqual(rows.map(r => r.value), ['saved']);
});
