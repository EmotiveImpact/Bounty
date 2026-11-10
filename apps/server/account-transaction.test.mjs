import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountTransactions } from './account-transaction.mjs';

function rig(commit = 'COMMIT') {
  const events = [];
  const tx = accountTransactions({
    query: async () => [], log: () => {},
    connect: async () => ({
      async query(sql) { events.push(sql); return { rows: [], command: sql === 'COMMIT' ? commit : sql }; },
      async end() { events.push('end'); },
    }),
  });
  return { tx, events };
}

test('account transaction: nested actions share one commit and mail follows it', async () => {
  const { tx, events } = rig();
  const mail = tx.mail({ on: true, send: async () => { events.push('mail'); return true; } });
  const result = await tx.transaction(async () => {
    await tx.query('synthetic account');
    await tx.transaction(() => tx.query('synthetic snapshot'));
    assert.equal(await mail.send({}), true);
    assert.ok(!events.includes('mail'));
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(events.filter(e => e === 'BEGIN').length, 1);
  assert.ok(events.indexOf('mail') > events.indexOf('COMMIT'));
});

test('account transaction: caught SQL failure returning a ROLLBACK tag is not success', async () => {
  const { tx, events } = rig('ROLLBACK');
  const mail = tx.mail({ on: true, send: async () => { events.push('mail'); return true; } });
  await assert.rejects(tx.transaction(async () => { await mail.send({}); }), /did not commit/);
  assert.ok(!events.includes('mail'));
  assert.equal(events.at(-1), 'end');
});

test('account transaction: refused action rolls back and never delivers its email', async () => {
  const { tx, events } = rig();
  const mail = tx.mail({ on: true, send: async () => { events.push('mail'); return true; } });
  await assert.rejects(tx.transaction(async () => { await mail.send({}); throw Error('refused'); }), /refused/);
  assert.ok(events.includes('ROLLBACK'));
  assert.ok(!events.includes('COMMIT')); assert.ok(!events.includes('mail'));
});
