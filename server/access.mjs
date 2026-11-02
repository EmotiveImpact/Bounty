// Who may reach the API. On your own computer it answers only requests
// addressed to this machine, with no password. A hosted pilot (the app on
// Vercel, the API on a small server) also names its public host names and
// either turns on member accounts or sets one shared password, because the
// database holds private notes, ledger amounts and member details.
//
//   BOUNTY_LISTEN_HOST   address to listen on (default 127.0.0.1)
//   BOUNTY_PUBLIC_HOSTS  comma-separated host names the API may be reached as,
//                        for example bounty.vercel.app,bounty-api.up.railway.app
//   BOUNTY_PASSWORD      shared password, at least 16 characters; needed
//                        whenever the API listens beyond this machine,
//                        unless DATABASE_URL turns on member accounts
//   DATABASE_URL         Postgres (Neon) connection string for member
//                        accounts; see accounts.mjs
//   BOUNTY_INVITE_CODE   code new members enter to sign up
//
// On Vercel (VERCEL is set) the deployment's own host names, which Vercel
// provides, are added to the public hosts, so only the password is needed.
import { createHash, timingSafeEqual } from "node:crypto";

export const MIN_PASSWORD_LENGTH = 16;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
// A plain host name: letters, digits, hyphens and dots, no port or scheme.
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function publicHosts(value) {
  const hosts = String(value || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const host of hosts)
    if (!HOST_NAME.test(host))
      throw Error(`BOUNTY_PUBLIC_HOSTS: "${host}" is not a plain host name (no scheme, port or path)`);
  return hosts;
}

/** Reads and checks the access settings; throws with a plain reason. */
export function accessConfig(env = process.env) {
  const listenHost = String(env.BOUNTY_LISTEN_HOST || "127.0.0.1").trim();
  const hosts = publicHosts(env.BOUNTY_PUBLIC_HOSTS);
  if (env.VERCEL)
    for (const name of ["VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL"])
      for (const host of publicHosts(env[name])) if (!hosts.includes(host)) hosts.push(host);
  const password = env.BOUNTY_PASSWORD ? String(env.BOUNTY_PASSWORD) : null;
  if (password !== null && password.length < MIN_PASSWORD_LENGTH)
    throw Error(`BOUNTY_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  // DATABASE_URL turns on member accounts (accounts.mjs), which replace the
  // shared password.
  const databaseUrl = env.DATABASE_URL ? String(env.DATABASE_URL).trim() : null;
  const inviteCode = env.BOUNTY_INVITE_CODE ? String(env.BOUNTY_INVITE_CODE).trim() : null;
  if (inviteCode !== null && inviteCode.length < 8)
    throw Error("BOUNTY_INVITE_CODE must be at least 8 characters");
  if ((!LOOPBACK.has(listenHost) || hosts.length) && !password && !databaseUrl)
    throw Error(
      "Set DATABASE_URL (member accounts) or BOUNTY_PASSWORD before listening beyond this machine " +
        "or naming public hosts: one of them is what keeps the data private",
    );
  return { listenHost, publicHosts: hosts, password: databaseUrl ? null : password, databaseUrl, inviteCode };
}

const digest = (value) => createHash("sha256").update(value).digest();

/**
 * True when the request carries HTTP Basic credentials whose password matches.
 * The user name is ignored. Both sides are hashed first so the comparison
 * takes the same time whatever the length of the guess.
 */
export function authorised(req, password) {
  const header = String(req.headers.authorization || "");
  const match = /^basic\s+([a-z0-9+/=]+)$/i.exec(header.trim());
  if (!match) return false;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  return timingSafeEqual(digest(decoded.slice(colon + 1)), digest(password));
}
