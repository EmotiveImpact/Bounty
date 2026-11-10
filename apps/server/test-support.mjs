// Helpers for tests. Build a database with only the schemas a test needs, so
// a module's tests do not depend on unrelated modules.
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { createApi } from "./app.mjs";

export function memoryDb(...schemas) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON;");
  for (const schema of schemas) schema(db);
  return db;
}

// Starts the API for the given route modules on an ephemeral port.
// Returns { call(method, path, body?), close() }; call resolves to
// { status, body } with the parsed JSON body.
export async function serve(db, modules, options = {}) {
  const server = createServer(createApi(db, { modules, ...options }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  return {
    base,
    async call(method, path, body, headers = {}) {
      const res = await fetch(base + path, {
        method,
        headers:
          body === undefined
            ? headers
            : { "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// The same shape as postgresStore, kept in memory.
export function memoryAccountsStore() {
  const users = [];
  let nextUserId = 1;
  const sessions = new Map();
  return {
    users,
    sessions,
    limits: new Map(),
    async consumeLimit(key, now, window, maximum) {
      const old = this.limits.get(key);
      const entry = !old || old.started <= now - window ? { started: now, count: 0 } : old;
      if (entry.count >= maximum) return false;
      entry.count++;
      this.limits.set(key, entry);
      return true;
    },
    async clearLimit(key) { this.limits.delete(key); },
    async userByEmail(email) {
      return users.find((u) => u.email === email) || null;
    },
    async createUser({ email, name, passwordHash }) {
      if (users.some((u) => u.email === email)) return null;
      const user = { id: nextUserId++, email, name, password_hash: passwordHash };
      users.push(user);
      return { id: user.id, email, name };
    },
    async createSession({ hash, userId, expires }) {
      sessions.set(hash, { userId, expires });
    },
    async sessionUser(hash) {
      const s = sessions.get(hash);
      if (!s || s.expires.getTime() <= Date.now()) return null;
      const u = users.find((x) => x.id === s.userId);
      return u ? { id: u.id, email: u.email, name: u.name, verified: Boolean(u.verified) } : null;
    },
    async deleteSession(hash) {
      sessions.delete(hash);
    },
    tokens: new Map(),
    async userById(id) {
      const u = users.find((x) => x.id === id);
      return u ? { ...u, verified: Boolean(u.verified), plan: null, planSince: null, created: null } : null;
    },
    async createToken({ hash, userId, kind, expires }) {
      for (const [h, t] of this.tokens) if (t.userId === userId && t.kind === kind) this.tokens.delete(h);
      this.tokens.set(hash, { userId, kind, expires });
    },
    async takeToken(hash, kind) {
      const t = this.tokens.get(hash);
      if (!t || t.kind !== kind) return null;
      this.tokens.delete(hash);
      if (t.expires.getTime() <= Date.now()) return null;
      const u = users.find((x) => x.id === t.userId);
      return u ? { id: u.id, email: u.email, name: u.name } : null;
    },
    async setPassword(userId, passwordHash) {
      users.find((x) => x.id === userId).password_hash = passwordHash;
      for (const [hash, token] of this.tokens) if (token.userId === userId) this.tokens.delete(hash);
      await this.deleteSessions(userId);
    },
    async deleteSessions(userId) {
      for (const [h, s] of sessions) if (s.userId === userId) sessions.delete(h);
    },
    async setVerified(userId, verified) {
      users.find((x) => x.id === userId).verified = verified;
    },
    async setEmail(userId, email) {
      if (users.some((u) => u.email === email)) return false;
      const u = users.find((x) => x.id === userId);
      u.email = email;
      u.verified = false;
      for (const [hash, token] of this.tokens) if (token.userId === userId) this.tokens.delete(hash);
      return true;
    },
    async deleteUser(userId) {
      const i = users.findIndex((x) => x.id === userId);
      if (i >= 0) users.splice(i, 1);
      for (const [h, s] of sessions) if (s.userId === userId) sessions.delete(h);
    },
    plans: new Map(),
    async plan(userId) {
      return this.plans.get(userId) ?? null;
    },
    async setPlan(userId, plan, since) {
      const row = plan ? { plan, since } : null;
      this.plans.set(userId, row);
      return row;
    },
  };
}

