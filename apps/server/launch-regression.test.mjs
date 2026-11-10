import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.mjs';
import { accounts } from './accounts.mjs';
import { memoryAccountsStore, serve } from './test-support.mjs';
import { recordPurchase, listTrips, getTrip } from './ledger.mjs';
import { createMember, memberForAccount } from './bounties.mjs';
import { poundsText as mobilePounds } from '../mobile/src/lib/format.ts';
import { poundsText as webPounds, todayUk } from '../web/src/money-input.ts';

const invite = 'synthetic-only';
const password = 'synthetic password only';
const purchase = { requestId: 'synthetic_purchase_0001', item: 'Synthetic receipt', shop: 'Test shop', units: 2,
  unitPrice: 450, occurred: '2026-01-01', sourceSample: true, actualConfirmed: true };
async function fixture(t) {
  const db = openDb(':memory:');
  const store = memoryAccountsStore();
  const members = accounts(store, { inviteCode: invite });
  const member = await members.signUp({ email: 'member@example.test', password, invite });
  const operator = await members.signUp({ email: 'operator@example.test', password, invite });
  await store.setVerified((await store.userByEmail('operator@example.test')).id, true);
  const api = await serve(db, undefined, { members, operators: ['operator@example.test'] });
  t.after(async () => { await api.close(); db.close(); });
  return { db, store, members, api, cookie: { Cookie: member.cookie }, operator: { Cookie: operator.cookie } };
}

test('launch: private operator reads refuse visitors and ordinary members', async (t) => {
  const { api, cookie, operator } = await fixture(t);
  for (const path of ['/api/permissions', '/api/evidence', '/api/research/checks', '/api/audit', '/api/audit/progress', '/api/sources']) {
    assert.equal((await api.call('GET', path)).status, 401, path);
    assert.equal((await api.call('GET', path, undefined, cookie)).status, 403, path);
    const authorised = await api.call('GET', path, undefined, operator);
    assert.ok([200, 400].includes(authorised.status), `${path}: ${authorised.status}`);
  }
});

test('launch: password and email changes invalidate outstanding reset and verification links', async () => {
  for (const change of ['password', 'email']) {
    const store = memoryAccountsStore();
    const members = accounts(store, { inviteCode: invite });
    await members.signUp({ email: 'member@example.test', password, invite });
    const user = await store.userByEmail('member@example.test');
    const { link } = await members.resetLink(user.email, 'https://example.test');
    if (change === 'password') await members.changePassword(user, { current: password, password: 'new synthetic password' });
    else await members.changeEmail(user, { password, email: 'new@example.test' }, 'https://example.test');
    await assert.rejects(members.reset({ token: link.split('#reset=')[1], password: 'stolen reset attempt' }), /expired|already used/);
  }
});

test('launch: reset budgets and password budgets are shared across instances', async () => {
  const store = memoryAccountsStore();
  let delivered = 0;
  const options = { inviteCode: invite, mail: { on: true, send: async () => { delivered++; return true; } } };
  const a = accounts(store, options), b = accounts(store, options);
  await a.signUp({ email: 'member@example.test', password, invite });
  for (let i = 0; i < 6; i++) await [a, b][i % 2].forgot({ email: 'member@example.test' }, 'https://example.test');
  assert.equal(delivered, 3);
  for (let i = 0; i < 8; i++) await assert.rejects([a, b][i % 2].signIn({ email: 'member@example.test', password: 'wrong' }), { status: 401 });
  await assert.rejects(b.signIn({ email: 'member@example.test', password }), { status: 429 });
});

test('launch: currency accepts British grouping but refuses decimal commas, exponent notation and extra precision', () => {
  for (const parse of [mobilePounds, webPounds]) {
    for (const bad of ['4,50', '1,00', '1e3', '-1', '4.501', '££4', '4 50', 'Infinity', '9007199254740991']) assert.equal(parse(bad), null, bad);
    for (const [input, pence] of [['4.50', 450], ['£4.5', 450], ['1,234.56', 123456], [' 0.01 ', 1]]) assert.equal(parse(input), pence);
  }
  assert.equal(todayUk(new Date('2026-06-30T23:30:00Z')), '2026-07-01');
  assert.equal(todayUk(new Date('2026-12-31T23:30:00Z')), '2026-12-31');
});

test('launch: an invalid receipt rolls back its new trip; unconfirmed samples create nothing', () => {
  const db = openDb(':memory:');
  try {
    assert.throws(() => recordPurchase(db, { ...purchase, units: 10000, unitPrice: 1e9 }), /amount/);
    assert.throws(() => recordPurchase(db, { ...purchase, actualConfirmed: false }), /real purchase/);
    assert.deepEqual(listTrips(db), []);
    assert.equal(db.prepare('SELECT count(*) AS n FROM ledger_purchase_requests').get().n, 0);
  } finally { db.close(); }
});

test('launch: simultaneous purchase retries record one receipt; changed payload is refused', async (t) => {
  const { api, cookie, db } = await fixture(t);
  const responses = await Promise.all([api.call('POST', '/api/ledger/purchases', purchase, cookie), api.call('POST', '/api/ledger/purchases', purchase, cookie)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 201]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM ledger_entries').get().n, 1);
  assert.equal((await api.call('POST', '/api/ledger/purchases', { ...purchase, units: 3 }, cookie)).status, 409);
});

test('launch: a purchase retry after a process database reopen is still deduplicated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bounty-purchase-synthetic-'));
  let db = openDb(join(dir, 'desk.sqlite'));
  try {
    const first = recordPurchase(db, purchase);
    db.close(); db = openDb(join(dir, 'desk.sqlite'));
    const again = recordPurchase(db, purchase);
    assert.equal(again.id, first.id); assert.equal(again.created, false);
    assert.equal(getTrip(db, first.id).entries.length, 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('launch: choosing a lower plan trims the linked alert areas', async (t) => {
  const { api, cookie, db } = await fixture(t);
  createMember(db, { name: 'Synthetic', locality: 'London', alertLocalities: ['London', 'Manchester', 'Bristol'], alertsOptIn: true }, { now: new Date().toISOString(), accountEmail: 'member@example.test' });
  assert.equal((await api.call('POST', '/api/plans/choose', { plan: 'starter' }, cookie)).status, 200);
  assert.deepEqual(JSON.parse(memberForAccount(db, 'member@example.test').alert_localities), ['London']);
  await api.call('POST', '/api/plans/choose', { plan: null }, cookie);
  assert.deepEqual(JSON.parse(memberForAccount(db, 'member@example.test').alert_localities), []);
});

test('launch mining: query parameters cannot impersonate an operator or another scout', async (t) => {
  const { api, cookie, operator, db } = await fixture(t);
  const other = createMember(db, { name: 'Other scout', sellerName: 'private-seller', alertLocalities: ['Private area'] }, { now: new Date().toISOString(), accountEmail: 'other@example.test' });
  assert.equal((await api.call('GET', '/api/bounties?viewer=operator')).status, 401);
  assert.equal((await api.call('GET', '/api/bounties?viewer=operator', undefined, cookie)).status, 403);
  assert.equal((await api.call('GET', `/api/bounties?viewer=${other.id}`, undefined, cookie)).status, 403);
  assert.equal((await api.call('GET', `/api/members/${other.id}/alerts`)).status, 401);
  assert.equal((await api.call('GET', `/api/members/${other.id}/alerts`, undefined, cookie)).status, 403);
  assert.equal((await api.call('GET', '/api/bounties?viewer=operator', undefined, operator)).status, 200);
  const publicMember = (await api.call('GET', '/api/members')).body.members.find(m => m.id === other.id);
  for (const field of ['sellerName', 'alertLocalities', 'profile', 'rules', 'paid']) assert.equal(publicMember[field], undefined, field);
  const operatorMember = (await api.call('GET', '/api/members', undefined, operator)).body.members.find(m => m.id === other.id);
  assert.equal(operatorMember.sellerName, 'private-seller');
});

test('launch mining: an account without a plan cannot add unlimited alert areas', async (t) => {
  const { api, cookie } = await fixture(t);
  assert.equal((await api.call('POST', '/api/members', { name: 'Synthetic', alertLocalities: ['London', 'Bristol'] }, cookie)).status, 400);
});

test('launch: legacy shared records remain available only to operators without reassignment', async (t) => {
  const { api, cookie, operator, db } = await fixture(t);
  const saved = recordPurchase(db, purchase);
  assert.equal((await api.call('GET', '/api/account/legacy-export')).status, 401);
  assert.equal((await api.call('GET', '/api/account/legacy-export', undefined, cookie)).status, 403);
  const exported = await api.call('GET', '/api/account/legacy-export', undefined, operator);
  assert.equal(exported.status, 200); assert.equal(exported.body.migrationApplied, false);
  assert.equal(exported.body.stock.trips[0].trip.id, saved.id);
  assert.equal(exported.body.stock.trips[0].entries[0].amount, 900);
  assert.equal(listTrips(db).length, 1);
});

test('launch mining: knowing an operator email and invite code is not proof of mailbox ownership', async (t) => {
  const { api, store, members, operator } = await fixture(t);
  const user = await store.userByEmail('operator@example.test');
  await store.setVerified(user.id, false);
  assert.equal((await api.call('GET', '/api/sources', undefined, operator)).status, 403);
  assert.equal((await api.call('GET', '/api/auth/me', undefined, operator)).body.operator, false);
  // A legitimate mailbox proof restores only the configured operator's role.
  await store.setVerified(user.id, true);
  assert.equal((await api.call('GET', '/api/sources', undefined, operator)).status, 200);
  const moved = await members.changeEmail(user, { password, email: 'different@example.test' }, 'https://example.test');
  assert.equal(moved.user.verified, false);
  assert.equal((await api.call('GET', '/api/sources', undefined, operator)).status, 403);
});
