// Who may reach the API. On your own computer it answers only requests
// addressed to this machine, with no password. A hosted pilot (the app on
// Vercel, the API on a small server) also names its public host names and
// sets one shared password, because Bounty has no accounts yet and the
// database holds private notes, ledger amounts and member details.
//
//   BOUNTY_LISTEN_HOST   address to listen on (default 127.0.0.1)
//   BOUNTY_PUBLIC_HOSTS  comma-separated host names the API may be reached as,
//                        for example bounty.vercel.app,bounty-api.up.railway.app
//   BOUNTY_PASSWORD      shared password, at least 16 characters; required
//                        whenever the API listens beyond this machine
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
  const password = env.BOUNTY_PASSWORD ? String(env.BOUNTY_PASSWORD) : null;
  if (password !== null && password.length < MIN_PASSWORD_LENGTH)
    throw Error(`BOUNTY_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  if ((!LOOPBACK.has(listenHost) || hosts.length) && !password)
    throw Error(
      "Set BOUNTY_PASSWORD before listening beyond this machine or naming public hosts: " +
        "Bounty has no accounts, so the password is the only thing keeping the data private",
    );
  return { listenHost, publicHosts: hosts, password };
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
