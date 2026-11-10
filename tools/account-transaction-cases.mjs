// Real PostgreSQL sessions and synthetic HTTP requests, invoked by the isolated lab.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountTransactions } from '../apps/server/account-transaction.mjs';
import { postgresStore, accounts } from '../apps/server/accounts.mjs';
import { postgresKeepStore, keepForGood } from '../apps/server/keep.mjs';
import { createApi } from '../apps/server/app.mjs';
import { openDb } from '../apps/server/db.mjs';
import { personalStores, memberDir } from '../apps/server/personal.mjs';

export async function accountCases(t, { connect, query }) {
  const deliveries = [];
  let fault = null;
  const coordinator = accountTransactions({ query, connect: async () => {
    const client = await connect();
    const original = client.query.bind(client);
    client.query = async (...args) => {
      const result = await original(...args);
      if (args[0] === 'COMMIT' && fault === 'commit-ack') { fault = null; throw Error('synthetic lost COMMIT acknowledgement'); }
      return result;
    };
    return client;
  }, log: () => {} });
  const users = postgresStore(coordinator.query, coordinator);
  await users.ready();
  const members = accounts(users, { inviteCode: 'synthetic-invite', mail: coordinator.mail({ on: true, send: async (message) => { deliveries.push(message); return true; } }) });
  const store = await postgresKeepStore(coordinator.query);
  await store.ready();
  const commit = store.commit;
  store.commit = async (...args) => { if (fault === 'snapshot') throw Error('synthetic snapshot outage'); return commit(...args); };
  async function instance() {
    const dir = mkdtempSync(join(tmpdir(), 'bounty-account-synthetic-'));
    const keeper = keepForGood({ dir, store, transaction: coordinator.transaction, log: () => {}, build() {
      const db = openDb(join(dir, 'desk.sqlite'));
      const own = personalStores(dir);
      return {
        handle: createApi(db, { members, personal: own.personal, forget: own.forget }),
        checkpoint() { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); own.checkpoint(); },
        close() { own.close(); db.close(); },
      };
    } });
    const server = createServer(keeper.handle);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await keeper.close(); rmSync(dir, { recursive: true, force: true }); });
    return { keeper, dir, async call(method, path, body, cookie) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
      });
      return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
    } };
  }
  const a = await instance();
  const password = 'synthetic password only';
  const signup = await a.call('POST', '/api/auth/signup', { email: 'synthetic@example.test', password, invite: 'synthetic-invite' });
  assert.equal(signup.status, 200); assert.equal(deliveries.length, 1);
  const cookie = signup.cookie;
  const user = await users.userByEmail('synthetic@example.test');
  assert.equal((await a.call('POST', '/api/goals/targets', { name: 'Keep synthetic savings', amount: 50000, start: '2026-01-01' }, cookie)).status, 201);
  // Synthetic receipt bytes must survive refused deletion and a new instance.
  await a.keeper.change(() => {
    const folder = join(memberDir(a.dir, user), 'proofs');
    mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'synthetic-receipt.txt'), 'synthetic receipt');
  });
  assert.equal((await a.call('POST', '/api/members', { name: 'Synthetic scout' }, cookie)).status, 201);
  const before = await store.snapshot();
  for (const [path, body] of [
    ['/api/account/email', { password, email: 'new@example.test' }],
    ['/api/plans/choose', { plan: 'fulltime' }],
    ['/api/account/delete', { password }],
  ]) {
    fault = 'snapshot';
    const result = await a.call('POST', path, body, cookie);
    fault = null;
    assert.equal(result.status, 503, path);
    assert.ok(await users.userByEmail('synthetic@example.test'));
    assert.equal(await users.userByEmail('new@example.test'), null);
    assert.deepEqual(await store.snapshot(), before);
    assert.equal((await users.plan(user.id)).plan, null);
    assert.equal(deliveries.length, 1, 'rolled-back email must not be sent');
  }
  const b = await instance();
  assert.equal((await b.call('GET', '/api/goals/targets', undefined, cookie)).body.targets[0].name, 'Keep synthetic savings');
  const changed = await b.call('POST', '/api/account/email', { password, email: 'new@example.test' }, cookie);
  assert.equal(changed.status, 200); assert.equal(changed.body.queued, true); assert.equal(deliveries.length, 2);
  assert.ok(await users.userByEmail('new@example.test'));
  const purchase = { requestId: 'synthetic_lost_ack_0001', item: 'Synthetic', units: 1, unitPrice: 450, occurred: '2026-01-01', actualConfirmed: true };
  fault = 'commit-ack';
  assert.equal((await b.call('POST', '/api/ledger/purchases', purchase, cookie)).status, 503);
  const c = await instance();
  const retry = await c.call('POST', '/api/ledger/purchases', purchase, cookie);
  assert.equal(retry.status, 200); assert.equal(retry.body.created, false);
  assert.equal((await c.call('GET', '/api/ledger/trips', undefined, cookie)).body.trips.length, 1);
  await query(`CREATE FUNCTION refuse_synthetic_token() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic token storage failure'; END $$;
    CREATE TRIGGER refuse_token BEFORE INSERT ON bounty_tokens FOR EACH ROW EXECUTE FUNCTION refuse_synthetic_token();`, []);
  const refused = await c.call('POST', '/api/auth/signup', { email: 'refused@example.test', password, invite: 'synthetic-invite' });
  assert.equal(refused.status, 503, 'caught SQL failure cannot turn PostgreSQL ROLLBACK into HTTP success');
  assert.equal(await users.userByEmail('refused@example.test'), null);
  await query('DROP TRIGGER refuse_token ON bounty_tokens', []);
  const resetLink = await members.resetLink('new@example.test', 'https://example.test');
  const changedPassword = await c.call('POST', '/api/account/password', { current: password, password: 'new synthetic password' }, cookie);
  assert.equal(changedPassword.status, 200);
  assert.equal((await c.call('POST', '/api/auth/reset', { token: resetLink.link.split('#reset=')[1], password: 'stale attempt password' })).status, 400);
  const second = accounts(postgresStore(coordinator.query, coordinator));
  for (let i = 0; i < 8; i++) await assert.rejects([members, second][i % 2].signIn({ email: 'new@example.test', password: 'wrong' }), { status: 401 });
  await assert.rejects(second.signIn({ email: 'new@example.test', password: 'new synthetic password' }), { status: 429 });
  await query('DELETE FROM bounty_rate_limits', []);
  const deleted = await c.call('POST', '/api/account/delete', { password: 'new synthetic password' }, changedPassword.cookie);
  assert.equal(deleted.status, 200);
  assert.equal(await users.userByEmail('new@example.test'), null);
  assert.ok(Object.keys((await store.snapshot()).files).every(path => !path.startsWith('members/')));
}
