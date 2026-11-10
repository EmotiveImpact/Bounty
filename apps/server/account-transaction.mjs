// A request owns one interactive PostgreSQL transaction. Account rows and
// snapshots use the same connection, including when an account method nests.
import { AsyncLocalStorage } from 'node:async_hooks';

export function accountTransactions({ connect, query, log = console.error }) {
  const scope = new AsyncLocalStorage();
  return {
    query: async (text, params = []) => {
      const active = scope.getStore();
      return active ? (await active.client.query(text, params)).rows : query(text, params);
    },
    // Rate budgets must survive a refused request's rollback.
    outside: query,
    async transaction(fn) {
      if (scope.getStore()) return fn();
      const client = await connect();
      const after = [];
      let committed = false;
      try {
        await client.query('BEGIN');
        // Account operations also use this lock outside the snapshot wrapper.
        // It prevents a password confirmation racing a reset or email change.
        await client.query('SELECT pg_advisory_xact_lock(176903, 1)');
        const result = await scope.run({ client, after }, fn);
        const completion = await client.query('COMMIT');
        // PostgreSQL answers ROLLBACK when an earlier SQL error was caught by
        // application code. A resolved COMMIT call alone is not confirmation.
        if (completion.command !== 'COMMIT') throw Error('PostgreSQL did not commit the request');
        committed = true;
        for (const send of after) {
          try { await send(); } catch (error) { log('Bounty account email not delivered: ' + error.message); }
        }
        return result;
      } catch (error) {
        if (!committed) try { await client.query('ROLLBACK'); } catch { /* connection may already be gone */ }
        throw error;
      } finally {
        try { await client.end(); } catch (error) { log('Bounty connection close failed: ' + error.message); }
      }
    },
    mail(mail) {
      return {
        on: mail.on, queued: true,
        async send(message) {
          if (!mail.on) return false;
          const active = scope.getStore();
          if (!active) return mail.send(message);
          // An email must never announce an uncommitted password/reset token.
          // No raw token is stored in an outbox. If this process stops after
          // commit, the member can request a fresh link. UI says requested.
          active.after.push(() => mail.send(message));
          return true;
        },
      };
    },
  };
}

export async function neonTransactions(url) {
  const { neon, Client } = await import('@neondatabase/serverless');
  const sql = neon(url);
  return accountTransactions({
    query: (text, params = []) => sql.query(text, params),
    connect: async () => {
      const client = new Client({ connectionString: url, connectionTimeoutMillis: 10000 });
      try { await client.connect(); return client; }
      catch (error) { try { await client.end(); } catch {} throw error; }
    },
  });
}
