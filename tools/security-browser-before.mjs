// Reproduce the three browser security failures on the reviewed parent. Never
// runs against the live site. Temporary checkout, fake accounts, synthetic DB.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const parent = '5e33fd0e79ff5c313415ec8976d340a28720d4c7';
const before = mkdtempSync(join(tmpdir(), 'bounty-security-before-'));
try {
  const archive = join(before, 'synthetic-parent.tar');
  execFileSync('git', ['archive', '--output=' + archive, parent]);
  const unpack = spawnSync('tar', ['-xf', archive, '-C', before]);
  rmSync(archive);
  assert.equal(unpack.status, 0, unpack.stderr?.toString());
  symlinkSync(resolve('node_modules'), join(before, 'node_modules'), 'dir');
  for (const name of ['session-security.e2e.mjs', 'harness.mjs'])
    copyFileSync(resolve('e2e', name), join(before, 'e2e', name));
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=failed sign-out|account change discards|unavailable session lookup', 'e2e/session-security.e2e.mjs'], {
    cwd: before, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, DATABASE_URL: '', BOUNTY_KEEP_DATA: 'off' },
  });
  process.stdout.write(run.stdout || '');
  process.stderr.write(run.stderr || '');
  assert.equal(run.status, 1, 'the unfixed parent must fail the regression tests');
  for (const name of [
    'failed sign-out stays signed in',
    'account change discards previous screen state',
    'unavailable session lookup does not mount private screens',
  ]) assert.match(run.stdout, new RegExp('not ok \\d+ - security: ' + name));
  assert.match(run.stdout, /# fail 3\b/);
  assert.match(run.stdout, /# skipped 0\b/);
  console.log('Confirmed all three browser regressions on the pinned parent; no production access.');
} finally { rmSync(before, { recursive: true, force: true }); }
