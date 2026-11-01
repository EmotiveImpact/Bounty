// Member accounts for a hosted pilot: email and password sign-in, a session
// cookie that lasts 30 days, and sign-up only with the invite code. Accounts
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
export function postgresStore(query) {
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
    })().catch((error) => {
      ready = undefined;
      throw error;
    }));
  const run = async (text, params) => (await init(), query(text, params));
  return {
    async userByEmail(email) {
      const rows = await run("SELECT id, email, name, password_hash FROM bounty_users WHERE email = $1", [email]);
      return rows[0] || null;
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
        `SELECT u.id, u.email, u.name FROM bounty_sessions s JOIN bounty_users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [hash],
      );
      return rows[0] || null;
    },
    async deleteSession(hash) {
      await run("DELETE FROM bounty_sessions WHERE token_hash = $1", [hash]);
    },
  };
}

/** Postgres store for a Neon connection string, over Neon's HTTP driver. */
export async function neonStore(url) {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);
  return postgresStore((text, params) => sql.query(text, params));
}

/**
 * Sign-in, sign-up and session checks. secure marks the cookie for HTTPS
 * only; it is false only when the API is reached on this machine.
 */
export function accounts(store, { inviteCode = null, now = () => Date.now() } = {}) {
  const failures = new Map();
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

  function limited(email) {
    const entry = failures.get(email);
    if (!entry || now() - entry.first > FAILURE_WINDOW_MS) return false;
    return entry.count >= MAX_FAILURES;
  }
  function failed(email) {
    const entry = failures.get(email);
    if (!entry || now() - entry.first > FAILURE_WINDOW_MS) failures.set(email, { first: now(), count: 1 });
    else entry.count += 1;
  }

  async function startSession(user, secure) {
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(now() + SESSION_DAYS * 86400 * 1000);
    await store.createSession({ hash: tokenHash(token), userId: user.id, expires });
    return cookie(token, SESSION_DAYS * 86400, secure);
  }

  const publicUser = (user) => ({ email: user.email, name: user.name || null });

  return {
    inviteOpen: Boolean(inviteCode),

    /** The signed-in member for this request, or null. */
    async user(req) {
      const token = readCookie(req);
      if (!token || token.length > 200) return null;
      return store.sessionUser(tokenHash(token));
    },

    async signIn(body, secure) {
      const { email, password } = credentials(body);
      if (limited(email)) throw new HttpError(429, "Too many wrong passwords. Try again in 15 minutes.");
      const user = await store.userByEmail(email);
      const ok = await checkPassword(password, user ? user.password_hash : await decoyHash());
      if (!user || !ok) {
        failed(email);
        throw new HttpError(401, "That email and password do not match");
      }
      failures.delete(email);
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
      return { user: publicUser(user), cookie: await startSession(user, secure) };
    },

    async signOut(req, secure) {
      const token = readCookie(req);
      if (token && token.length <= 200) await store.deleteSession(tokenHash(token));
      return cookie("", 0, secure);
    },

    publicUser,
  };
}
