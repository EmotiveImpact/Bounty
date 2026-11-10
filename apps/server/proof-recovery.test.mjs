import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareProof, writeProof } from './proofs.mjs';

test('a truncated existing receipt is never acknowledged as a complete proof or overwritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bounty-proof-recovery-'));
  try {
    const proof = prepareProof(Buffer.from('%PDF-1.4\n%synthetic full receipt\n%%EOF\n'), 'application/pdf');
    const file = join(dir, proof.sha256);
    writeFileSync(file, proof.content.subarray(0, 8)); // Interrupted earlier write.
    assert.throws(() => writeProof(dir, proof), /could not be verified/);
    assert.deepEqual(readFileSync(file), proof.content.subarray(0, 8), 'existing bytes retained for recovery');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an existing receipt path cannot follow a symlink or change its target permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bounty-proof-link-'));
  try {
    const proof = prepareProof(Buffer.from('%PDF-1.4\n%synthetic target\n%%EOF\n'), 'application/pdf');
    const outside = join(dir, 'outside.pdf'), inside = join(dir, 'proofs'); mkdirSync(inside);
    writeFileSync(outside, proof.content, { mode: 0o644 });
    const mode = statSync(outside).mode;
    symlinkSync(outside, join(inside, proof.sha256));
    assert.throws(() => writeProof(inside, proof), /could not be verified/);
    assert.equal(statSync(outside).mode, mode);
    assert.deepEqual(readFileSync(outside), proof.content);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
