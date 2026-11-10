// CLI imports use their own cache. Sharing the API's cache directory would
// race its restore/rename and could silently lose a worker's SQLite writes.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { database, openDb } from './db.mjs';
import { keepForGood, neonKeepStore } from './keep.mjs';

export async function withWorkingData(fn, { url = process.env.DATABASE_URL, store = null } = {}) {
  if (!url && !store) {
    const db = database();
    try { return await fn(db); } finally { db.close(); }
  }
  const dir = mkdtempSync(join(tmpdir(), 'bounty-import-cache-'));
  const keeper = keepForGood({ dir, store: store || await neonKeepStore(url), build() {
    const db = openDb(join(dir, 'desk.sqlite'));
    return { db, handle() { throw Error('Import cache has no HTTP handler'); },
      checkpoint() { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }, close() { db.close(); } };
  } });
  try {
    let result;
    await keeper.change(async ({ db }) => { result = await fn(db); });
    return result;
  } finally {
    await keeper.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
