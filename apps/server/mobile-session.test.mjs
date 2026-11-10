import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../mobile/src/lib/session.ts';

const alice = { id: '1', email: 'alice@example.test', name: 'Alice' };
const bob = { id: '2', email: 'bob@example.test', name: 'Bob' };
const me = user => ({ required: true, user });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('late initial lookup cannot undo a completed mobile sign-in', async () => {
  const old = deferred();
  const s = createSession(async route => route === 'auth/me' ? old.promise : { user: bob });
  const check = s.refresh();
  await s.signIn(bob.email, 'synthetic');
  old.resolve(me(alice)); await check;
  assert.equal(s.getSnapshot().me.user.id, bob.id);
});

test('late initial lookup cannot resurrect a signed-out mobile account', async () => {
  const old = deferred();
  const s = createSession(async route => route === 'auth/me' ? old.promise : {});
  const check = s.refresh();
  await s.signOut();
  old.resolve(me(alice)); await check;
  assert.equal(s.getSnapshot().me.user, null);
});

test('failed foreground session check removes private identity and recovers on retry', async () => {
  let fail = false;
  const s = createSession(async () => { if (fail) throw Error('offline'); return me(alice); });
  await s.refresh(); assert.equal(s.getSnapshot().me.user.id, alice.id);
  fail = true; await s.refresh();
  assert.equal(s.getSnapshot().me.user, null); assert.ok(s.getSnapshot().error);
  fail = false; await s.refresh();
  assert.equal(s.getSnapshot().me.user.id, alice.id); assert.equal(s.getSnapshot().error, '');
});

test('failed sign-out rejects and does not falsely claim the account is signed out', async () => {
  const s = createSession(async route => { if (route === 'auth/me') return me(alice); throw Error('offline'); });
  await s.refresh();
  await assert.rejects(s.signOut(), /offline/);
  assert.equal(s.getSnapshot().me.user.id, alice.id);
});

test('newest session lookup wins and immutable IDs distinguish reused emails', async () => {
  const first = deferred(), second = deferred(); let calls = 0;
  const s = createSession(async () => ++calls === 1 ? first.promise : second.promise);
  const a = s.refresh(), b = s.refresh();
  second.resolve(me({ ...bob, email: alice.email })); await b;
  first.resolve(me(alice)); await a;
  assert.equal(s.getSnapshot().me.user.id, bob.id);
});

test('foreground reads and overlapping account writes cannot race session cookie changes', async () => {
  const pending = deferred(); let reads = 0;
  const s = createSession(async route => { if (route === 'auth/me') { reads++; return me(alice); } return pending.promise; });
  await s.refresh();
  const signing = s.signIn(bob.email, 'synthetic');
  await s.refresh();
  await assert.rejects(s.signOut(), /in progress/);
  assert.equal(reads, 1);
  pending.resolve({ user: bob }); await signing;
  assert.equal(s.getSnapshot().me.user.id, bob.id);
});

test('initial lookup failure and malformed member identity block access without disabling retries', async () => {
  let response = { required: true, user: { email: alice.email } };
  const s = createSession(async () => response);
  await s.refresh();
  assert.equal(s.getSnapshot().checking, false); assert.ok(s.getSnapshot().error);
  response = me(null); await s.refresh();
  assert.equal(s.getSnapshot().error, ''); assert.equal(s.getSnapshot().me.user, null);
});
