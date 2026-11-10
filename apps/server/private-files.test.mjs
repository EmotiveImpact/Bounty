import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

test('security: Vite refuses proof files in a custom private store inside its root', async (t) => {
  const dir = mkdtempSync(resolve('apps/web/synthetic-private-'));
  const file = join(dir, 'synthetic-receipt');
  writeFileSync(file, 'SYNTHETIC PRIVATE RECEIPT ONLY');
  const previous = process.env.BOUNTY_DATA_DIR;
  process.env.BOUNTY_DATA_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.BOUNTY_DATA_DIR; else process.env.BOUNTY_DATA_DIR = previous; rmSync(dir, { recursive: true, force: true }); });
  const { default: config } = await import(pathToFileURL(process.env.BOUNTY_VITE_TEST_CONFIG || resolve('apps/web/vite.config.js')));
  const server = await createServer({ ...config, configFile: false, root: resolve('apps/web'), logLevel: 'silent',
    server: { ...config.server, port: 0, proxy: {}, watch: null } });
  t.after(() => server.close());
  await server.listen();
  const base = 'http://127.0.0.1:' + server.httpServer.address().port;
  for (const suffix of ['', '?raw', '?import']) {
    const res = await fetch(base + '/@fs/' + file + suffix);
    const body = await res.text();
    assert.equal(res.status, 403, suffix);
    assert.ok(!body.includes('SYNTHETIC PRIVATE RECEIPT ONLY'));
  }
  assert.equal((await fetch(base + '/')).status, 200);
});
