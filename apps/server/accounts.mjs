// Member accounts for a hosted pilot: email and password sign-in, a session
// cookie that lasts 30 days, sign-up only with the invite code, an email
// check, password reset links, and settings (change password or email,
// delete the account). Accounts
// and sessions live in Postgres (Neon) so they survive while the rest of the
// demo data, which stays in SQLite, may reset.
//
//   DATABASE_URL         Postgres connection string; turns accounts on
//   BOUNTY_INVITE_CODE   code a new member must enter to sign up; without it
//                        sign-up is closed and only existing members get in
//
// Passwords are kept only as scrypt hashes, and session tokens only as
// SHA-256 hashes, so a copy of the database cannot be used to sign in.
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { neonTransactions } from "./account-transaction.mjs";
import { HttpError } from "./http.mjs";

const scrypt = promisify(scryptCallback);
export const COOKIE = "bounty_session";
export const SESSION_DAYS = 30;
export const MIN_MEMBER_PASSWORD = 10;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
// Repeated wrong passwords for one email are refused for a while.
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;

const sha256 = (value) => createHash("sha256").update(value).digest();
const tokenHash = (token) => sha256(token).toString("hex");
const sameText = (a, b) => timingSafeEqual(sha256(String(a)), sha256(String(b)));

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function checkPassword(password, stored) {
  const [kind, N, r, p, salt, key] = String(stored).split("$");
  if (kind !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}

// A hash to check against when the email is unknown, so a wrong email takes
// as long as a wrong password and does not reveal who is a member.
let decoy;
const decoyHash = () => (decoy ||= hashPassword(randomBytes(12).toString("hex")));

export function readCookie(req, name = COOKIE) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Postgres store over a query function (text, params) => rows. Tables are
 * created on first use, so a new Neon database needs no set-up step.
 */
export function postgresStore(query, { transaction = (fn) => fn(), outside = query } = {}) {
  let ready;
  const init = () =>
    (ready ||= (async () => {
      await query(`CREATE TABLE IF NOT EXISTS bounty_users (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        email text NOT NULL UNIQUE,
        name text,
        password_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
      await query(`CREATE TABLE IF NOT EXISTS bounty_sessions (
        token_hash text PRIMARY KEY,
        user_id bigint NOT NULL REFERENCES bounty_users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      )`);
      await query(`CREATE TABLE IF NOT EXISTS bounty_rate_limits (
        key text PRIMARY KEY, started bigint NOT NULL, count integer NOT NULL
      )`);
      // The membership plan (plans.mjs) belongs to the account.
      await query("ALTER TABLE bounty_users ADD COLUMN IF NOT EXISTS plan text", []);
      await query("ALTER TABLE bounty_users ADD COLUMN IF NOT EXISTS plan_since timestamptz", []);
      // Email check, password reset links and account settings (6 Nov 2026).
      await query("ALTER TABLE bounty_users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz", []);
      await query(`CREATE TABLE IF NOT EXISTS bounty_tokens (
        token_hash text PRIMARY KEY,
        user_id bigint NOT NULL REFERENCES bounty_users(id) ON DELETE CASCADE,
        kind text NOT NULL,
        expires_at timestamptz NOT NULL
      )`);
    })().catch((error) => {
      ready = undefined;
      throw error;
    }));
  const run = async (text, params) => (await init(), query(text, params));
  return {
    ready: init,
    transaction: async (fn) => { await init(); return transaction(fn); },
    async consumeLimit(key, now, window, maximum) {
      await init();
      const rows = await outside(`INSERT INTO bounty_rate_limits(key, started, count) VALUES ($1, $2, 1)
        ON CONFLICT (key) DO UPDATE SET
          started = CASE WHEN bounty_rate_limits.started <= $2 - $3 THEN $2 ELSE bounty_rate_limits.started END,
          count = CASE WHEN bounty_rate_limits.started <= $2 - $3 THEN 1 ELSE bounty_rate_limits.count + 1 END
        WHERE bounty_rate_limits.started <= $2 - $3 OR bounty_rate_limits.count < $4
        RETURNING count`, [key, now, window, maximum]);
      return rows.length > 0;
    },
    async clearLimit(key) { await outside("DELETE FROM bounty_rate_limits WHERE key = $1", [key]); },
    async userByEmail(email) {
      const rows = await run("SELECT id, email, name, password_hash FROM bounty_users WHERE email = $1", [email]);
      return rows[0] || null;
    },
    async userById(id) {
      const rows = await run(
        "SELECT id, email, name, password_hash, email_verified_at, plan, plan_since, created_at FROM bounty_users WHERE id = $1",
        [id],
      );
      return rows[0] ? userRow(rows[0]) : null;
    },
    async createToken({ hash, userId, kind, expires }) {
      await run("DELETE FROM bounty_tokens WHERE expires_at < now()", []);
      await run("DELETE FROM bounty_tokens WHERE user_id = $1 AND kind = $2", [userId, kind]);
      await run("INSERT INTO bounty_tokens (token_hash, user_id, kind, expires_at) VALUES ($1, $2, $3, $4)", [
        hash,
        userId,
        kind,
        expires.toISOString(),
      ]);
    },
    // A token works once: it is deleted as it is used.
    async takeToken(hash, kind) {
      const rows = await run(
        "DELETE FROM bounty_tokens WHERE token_hash = $1 AND kind = $2 RETURNING user_id, expires_at",
        [hash, kind],
      );
      if (!rows[0] || new Date(rows[0].expires_at).getTime() <= Date.now()) return null;
      const users = await run("SELECT id, email, name FROM bounty_users WHERE id = $1", [rows[0].user_id]);
      return users[0] || null;
    },
    async setPassword(userId, passwordHash) {
      await run(`WITH changed AS (
        UPDATE bounty_users SET password_hash = $2 WHERE id = $1 RETURNING id
      ), tokens AS (
        DELETE FROM bounty_tokens USING changed WHERE user_id = changed.id
      ) DELETE FROM bounty_sessions USING changed WHERE user_id = changed.id`, [userId, passwordHash]);
    },
    async deleteSessions(userId) {
      await run("DELETE FROM bounty_sessions WHERE user_id = $1", [userId]);
    },
    async setVerified(userId, verified) {
      await run("UPDATE bounty_users SET email_verified_at = $2 WHERE id = $1", [
        userId,
        verified ? new Date().toISOString() : null,
      ]);
    },
    async setEmail(userId, email) {
      const rows = await run(
        "UPDATE bounty_users SET email = $2, email_verified_at = NULL WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM bounty_users WHERE email = $2) RETURNING id",
        [userId, email],
      );
      if (rows.length) await run("DELETE FROM bounty_tokens WHERE user_id = $1", [userId]);
      return rows.length > 0;
    },
    async deleteUser(userId) {
      await run("DELETE FROM bounty_users WHERE id = $1", [userId]);
    },
    async createUser({ email, name, passwordHash }) {
      const rows = await run(
        "INSERT INTO bounty_users (email, name, password_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING id, email, name",
        [email, name, passwordHash],
      );
      return rows[0] || null;
    },
    async createSession({ hash, userId, expires }) {
      await run("DELETE FROM bounty_sessions WHERE expires_at < now()", []);
      await run("INSERT INTO bounty_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)", [
        hash,
        userId,
        expires.toISOString(),
      ]);
    },
    async sessionUser(hash) {
      const rows = await run(
        `SELECT u.id, u.email, u.name, u.email_verified_at FROM bounty_sessions s JOIN bounty_users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [hash],
      );
      if (!rows[0]) return null;
      const { email_verified_at, ...user } = rows[0];
      return { ...user, verified: Boolean(email_verified_at) };
    },
    async deleteSession(hash) {
      await run("DELETE FROM bounty_sessions WHERE token_hash = $1", [hash]);
    },
    async plan(userId) {
      const rows = await run("SELECT plan, plan_since FROM bounty_users WHERE id = $1", [userId]);
      return rows[0] ? planRow(rows[0]) : null;
    },
    async setPlan(userId, plan, since) {
      const rows = await run(
        "UPDATE bounty_users SET plan = $2, plan_since = $3 WHERE id = $1 RETURNING plan, plan_since",
        [userId, plan, since],
      );
      return rows[0] ? planRow(rows[0]) : null;
    },
  };
}

const userRow = (row) => ({
  id: row.id,
  email: row.email,
  name: row.name || null,
  password_hash: row.password_hash,
  verified: Boolean(row.email_verified_at),
  plan: row.plan || null,
  planSince: row.plan_since ? new Date(row.plan_since).toISOString() : null,
  created: row.created_at ? new Date(row.created_at).toISOString() : null,
});

const planRow = (row) => ({
  plan: row.plan || null,
  since: row.plan_since ? new Date(row.plan_since).toISOString() : null,
});

/** Postgres store for a Neon connection string, over Neon's HTTP driver. */
export async function neonStore(url) {
  const coordinator = await neonTransactions(url);
  return postgresStore(coordinator.query, coordinator);
}

/**
 * Sign-in, sign-up and session checks. secure marks the cookie for HTTPS
 * only; it is false only when the API is reached on this machine.
 */
// How long the links in emails work.
export const RESET_HOURS = 1;
export const VERIFY_DAYS = 7;
// A reset link an operator makes by hand (Admin) lasts a day.
export const OPERATOR_RESET_HOURS = 24;
const MAX_RESET_EMAILS = 3;

const noMail = { on: false, send: async () => false };

export function accounts(store, { inviteCode = null, now = () => Date.now(), mail = noMail } = {}) {
  const limitKey = (kind, email) => tokenHash(`${kind}:${email}`);
  const cookie = (token, maxAge, secure) =>
    [
      `${COOKIE}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAge}`,
      ...(secure ? ["Secure"] : []),
    ].join("; ");

  function credentials(body) {
    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password || "");
    if (!EMAIL.test(email)) throw new HttpError(400, "Enter a valid email address");
    if (!password) throw new HttpError(400, "Enter your password");
    return { email, password };
  }

  async function limited(email) {
    return !(await store.consumeLimit(limitKey("password", email), now(), FAILURE_WINDOW_MS, MAX_FAILURES));
  }
  const clearFailures = (email) => store.clearLimit(limitKey("password", email));

  async function startSession(user, secure) {
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(now() + SESSION_DAYS * 86400 * 1000);
    await store.createSession({ hash: tokenHash(token), userId: user.id, expires });
    return cookie(token, SESSION_DAYS * 86400, secure);
  }

  const publicUser = (user) => ({
    id: String(user.id),
    email: user.email,
    name: user.name || null,
    ...(user.verified === undefined ? {} : { verified: Boolean(user.verified) }),
  });

  async function makeToken(user, kind, ms) {
    const token = randomBytes(32).toString("base64url");
    await store.createToken({ hash: tokenHash(token), userId: user.id, kind, expires: new Date(now() + ms) });
    return token;
  }
  const readToken = (body) => {
    const token = String(body?.token || "");
    if (!token || token.length > 200) throw new HttpError(400, "That link is not complete. Open it from the email again.");
    return token;
  };
  const newPassword = (body) => {
    const password = String(body?.password || "");
    if (password.length < MIN_MEMBER_PASSWORD)
      throw new HttpError(400, `Use a password of at least ${MIN_MEMBER_PASSWORD} characters`);
    return password;
  };
  // Settings changes ask for the current password again.
  async function confirm(user, password) {
    if (await limited(user.email)) throw new HttpError(429, "Too many wrong passwords. Try again in 15 minutes.");
    const full = await store.userById(user.id);
    if (!full || !(await checkPassword(String(password || ""), full.password_hash))) {
      throw new HttpError(401, "That password is not right");
    }
    await clearFailures(user.email);
    return full;
  }

  async function sendVerify(user, origin) {
    if (!mail.on) return false;
    if (!(await store.consumeLimit(limitKey("verify-email", user.email), now(), 3600000, 3)))
      throw new HttpError(429, "Too many confirmation emails. Try again in an hour.");
    const token = await makeToken(user, "verify", VERIFY_DAYS * 86400000);
    const link = `${origin}/#verify=${token}`;
    return mail.send({
      to: user.email,
      subject: "Confirm your email for Bounty",
      text:
        `Hello${user.name ? " " + user.name : ""},\n\n` +
        `Confirm this is your email by opening this link:\n${link}\n\n` +
        `The link works for ${VERIFY_DAYS} days. If you did not sign up to Bounty, you can ignore this email.\n\nBounty`,
    });
  }

  const service = {
    inviteOpen: Boolean(inviteCode),

    /** The signed-in member for this request, or null. */
    async user(req) {
      const token = readCookie(req);
      if (!token || token.length > 200) return null;
      return store.sessionUser(tokenHash(token));
    },

    async signIn(body, secure) {
      const { email, password } = credentials(body);
      if (await limited(email)) throw new HttpError(429, "Too many wrong passwords. Try again in 15 minutes.");
      const user = await store.userByEmail(email);
      const ok = await checkPassword(password, user ? user.password_hash : await decoyHash());
      if (!user || !ok) {
        throw new HttpError(401, "That email and password do not match");
      }
      await clearFailures(email);
      return { user: publicUser(user), cookie: await startSession(user, secure) };
    },

    async signUp(body, secure) {
      if (!inviteCode) throw new HttpError(403, "Sign-up is closed. Ask Edem for an account.");
      const { email, password } = credentials(body);
      if (!sameText(String(body?.invite || "").trim(), inviteCode))
        throw new HttpError(403, "That invite code is not right");
      if (password.length < MIN_MEMBER_PASSWORD)
        throw new HttpError(400, `Use a password of at least ${MIN_MEMBER_PASSWORD} characters`);
      const name = String(body?.name || "").trim().slice(0, 80) || null;
      const user = await store.createUser({ email, name, passwordHash: await hashPassword(password) });
      if (!user) throw new HttpError(409, "That email already has an account. Sign in instead.");
      return {
        user: publicUser({ ...user, verified: false }),
        cookie: await startSession(user, secure),
        // The app sends the confirm email after answering (see sendVerify).
        created: user,
      };
    },

    mailOn: Boolean(mail.on),
    mailQueued: Boolean(mail.queued),
    sendVerify,

    /** Emails a reset link when the email has an account. Says the same either way. */
    async forgot(body, origin) {
      const email = String(body?.email || "").trim().toLowerCase();
      if (!EMAIL.test(email)) throw new HttpError(400, "Enter a valid email address");
      if (!mail.on) return { sent: false, mailOn: false };
      if (!(await store.consumeLimit(limitKey("reset-email", email), now(), 3600000, MAX_RESET_EMAILS)))
        return { sent: !mail.queued, mailOn: true, ...(mail.queued ? { queued: true } : {}) };
      const user = await store.userByEmail(email);
      if (user) {
        const token = await makeToken(user, "reset", RESET_HOURS * 3600000);
        await mail.send({
          to: user.email,
          subject: "Reset your Bounty password",
          text:
            `Someone asked to reset the password for this Bounty account.\n\n` +
            `Choose a new password here:\n${origin}/#reset=${token}\n\n` +
            `The link works once, for ${RESET_HOURS} hour. If it was not you, ignore this email and your password stays the same.\n\nBounty`,
        });
      }
      return { sent: !mail.queued, mailOn: true, ...(mail.queued ? { queued: true } : {}) };
    },

    /** For operators: a reset link to pass on by hand while email is off. */
    async resetLink(email, origin) {
      const user = await store.userByEmail(String(email || "").trim().toLowerCase());
      if (!user) throw new HttpError(404, "No account has that email");
      const token = await makeToken(user, "reset", OPERATOR_RESET_HOURS * 3600000);
      return { link: `${origin}/#reset=${token}`, hours: OPERATOR_RESET_HOURS };
    },

    /** Sets a new password from a reset link, signs out everywhere else, and signs in here. */
    async reset(body, secure) {
      const token = readToken(body);
      const password = newPassword(body);
      const user = await store.takeToken(tokenHash(token), "reset");
      if (!user) throw new HttpError(400, "That reset link has expired or was already used. Ask for a new one.");
      await store.setPassword(user.id, await hashPassword(password));
      await store.deleteSessions(user.id);
      // Opening the link proves the email is theirs.
      await store.setVerified(user.id, true);
      await clearFailures(user.email);
      return { user: publicUser({ ...user, verified: true }), cookie: await startSession(user, secure) };
    },

    async verify(body) {
      const user = await store.takeToken(tokenHash(readToken(body)), "verify");
      if (!user) throw new HttpError(400, "That link has expired or was already used. Send a new one from Settings.");
      await store.setVerified(user.id, true);
      return { email: user.email, verified: true };
    },

    /** The account as Settings shows it, and for the data download. */
    async account(user) {
      const full = await store.userById(user.id);
      if (!full) throw new HttpError(404, "Account not found");
      const { password_hash, id, ...shown } = full;
      return shown;
    },

    async changePassword(user, body, secure) {
      await confirm(user, body?.current);
      const password = newPassword(body);
      await store.setPassword(user.id, await hashPassword(password));
      await store.deleteSessions(user.id);
      return { cookie: await startSession(user, secure) };
    },

    async changeEmail(user, body, origin) {
      await confirm(user, body?.password);
      const email = String(body?.email || "").trim().toLowerCase();
      if (!EMAIL.test(email)) throw new HttpError(400, "Enter a valid email address");
      if (email === user.email) throw new HttpError(400, "That is already your email");
      if (!(await store.setEmail(user.id, email))) throw new HttpError(409, "That email already has an account");
      const changed = { ...user, email, verified: false };
      const sent = await sendVerify(changed, origin).catch(() => false);
      return { user: publicUser(changed), sent, from: user.email };
    },

    async deleteAccount(user, body) {
      await confirm(user, body?.password);
      await store.deleteUser(user.id);
      return { deleted: true };
    },

    async signOut(req, secure) {
      const token = readCookie(req);
      if (token && token.length <= 200) await store.deleteSession(tokenHash(token));
      return cookie("", 0, secure);
    },

    publicUser,

    /** The member's plan row { plan, since }, or null. */
    plan: (userId) => (store.plan ? store.plan(userId) : null),
    setPlan(userId, plan, since) {
      if (!store.setPlan) throw new HttpError(503, "Plans cannot be saved on this server");
      return store.setPlan(userId, plan, since);
    },
  };
  if (store.transaction) {
    for (const name of ["signIn", "signUp", "signOut", "forgot", "resetLink", "reset", "verify",
      "sendVerify", "changePassword", "changeEmail", "deleteAccount", "setPlan"]) {
      const call = service[name];
      service[name] = (...args) => store.transaction(() => call(...args));
    }
  }
  return service;
}
