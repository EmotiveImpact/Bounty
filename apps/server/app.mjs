// Local HTTP API. Route modules export routes(db) returning
// [method, pattern, handler, options?] tuples. Patterns use :name segments.
// Handlers receive { req, url, params, body } and return a JSON value or
// reply(status, value). Options: limit (body bytes) and read (a POST that
// changes nothing, open to signed-out visitors when accounts are on). Throw HttpError (or call fail) for client errors.
import { HttpError, isReply, readJson } from "./http.mjs";
import { authorised } from "./access.mjs";
import * as evidenceRoutes from "./routes-evidence.mjs";
import * as researchRoutes from "./routes-research.mjs";
import * as planRoutes from "./routes-plan.mjs";
import * as dealRoutes from "./routes-deals.mjs";
import * as bountyRoutes from "./routes-bounties.mjs";
import * as ledgerRoutes from "./routes-ledger.mjs";
import * as helpRoutes from "./help.mjs";
import * as plans from "./plans.mjs";
import { getGoals, goalTargets } from "./goals.mjs";
import { getTrip, listTrips } from "./ledger.mjs";

export const routeModules = [
  evidenceRoutes,
  researchRoutes,
  planRoutes,
  dealRoutes,
  bountyRoutes,
  ledgerRoutes,
  helpRoutes,
];

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
// The Host header as sent, without its port and without URL normalisation,
// so lookalikes such as 0x7f.1 or 2130706433 are not treated as local.
const hostHeader = (value) => {
  const match = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::\d{1,5})?$/.exec(String(value).trim().toLowerCase());
  return match ? match[1] : "";
};
// The host of an Origin header (scheme://host[:port], nothing else), parsed
// the same strict way, so "null" and lookalikes are never local.
const originHost = (value) => {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(\[[0-9a-f:.]+\]|[^:/[\]]+)(?::\d{1,5})?$/.exec(
    String(value).trim().toLowerCase(),
  );
  return match ? match[1] : "";
};

// publicHosts and password come from accessConfig() in access.mjs. Without
// them the API answers only requests addressed to this machine. members is
// accounts() from accounts.mjs: when given, anyone may read, every change
// needs a signed-in member, and the shared password is not used.
//
// operators lists the emails allowed to use routes marked { operator: true }
// (the Admin tools). With member accounts on, only a signed-in operator may
// call them. Without accounts the API is either on this machine or behind
// the shared password, and whoever is there is the operator.
// The Admin tools: setting up and checking tips, verifying shelf reports,
// sending alerts, recording branch checks, sources, display permissions and
// the audit. Only an operator may use them (see operators below). A route can
// also mark itself with { operator: true }.
export const OPERATOR_ROUTES = new Set([
  "POST /api/members/:id/seller-confirmation",
  "POST /api/bounties",
  "POST /api/bounties/:id/recheck",
  "POST /api/bounties/:id/withdraw",
  "POST /api/claims/:id/reconcile",
  "POST /api/reports/:id/verify",
  "POST /api/bounties/:id/alerts",
  "POST /api/research/checks",
  "POST /api/audit",
  "POST /api/audit/signoff",
  "GET /api/sources",
  "POST /api/permissions",
]);

// Each member's own records: Stock (the ledger) and Money (goals). With
// member accounts and a personal(user) store, these routes run on that
// member's own database, so members never see each other's trips or money.
export const PERSONAL_MODULES = [planRoutes, ledgerRoutes];

const toTable = (tuples) =>
  tuples.map(([method, pattern, handler, options = {}]) => ({
    method,
    parts: pattern.split("/").filter(Boolean),
    handler,
    options: OPERATOR_ROUTES.has(`${method} ${pattern}`) ? { ...options, operator: true } : options,
  }));

// personal(user) returns { db, proofDir } for a signed-in member, or for
// user null a database that is never written (signed-out visitors may read
// and work things out, but every change needs a sign-in).
export function createApi(
  db,
  {
    modules = routeModules,
    publicHosts = [],
    password = null,
    members = null,
    operators = [],
    personal = null,
    forget = null,
  } = {},
) {
  const allowedHosts = new Set([...LOCAL_HOSTS, ...publicHosts]);
  const operatorEmails = new Set(operators.map((e) => String(e).trim().toLowerCase()));
  const isOperator = (user) => !members || Boolean(user && operatorEmails.has(String(user.email).toLowerCase()));
  const own = Boolean(members && personal);
  const shared = own ? modules.filter((m) => !PERSONAL_MODULES.includes(m)) : modules;
  const table = toTable([...shared.flatMap((m) => m.routes(db)), ...plans.routes(db, members)]);
  const personalTables = new Map();
  const personalKey = (user) => (user ? String(user.id ?? user.email).toLowerCase() : "");
  function personalSpace(user) {
    const key = personalKey(user);
    if (!personalTables.has(key)) {
      const { db: mine, proofDir } = personal(user);
      personalTables.set(key, {
        db: mine,
        table: toTable(
          PERSONAL_MODULES.filter((m) => modules.includes(m)).flatMap((m) =>
            m === ledgerRoutes ? m.routes(mine, { proofDir }) : m.routes(mine),
          ),
        ),
      });
    }
    return personalTables.get(key);
  }
  const personalTable = (user) => personalSpace(user).table;
  function find(method, path, user, first = true) {
    const parts = path.split("/").filter(Boolean);
    let allowed = false;
    for (const route of first ? table : personalTable(user)) {
      if (route.parts.length !== parts.length) continue;
      const params = {};
      const ok = route.parts.every((part, i) => {
        if (part.startsWith(":")) {
          try {
            params[part.slice(1)] = decodeURIComponent(parts[i]);
          } catch {
            return false;
          }
          return true;
        }
        return part === parts[i];
      });
      if (!ok) continue;
      if (route.method === method) return { route, params };
      allowed = true;
    }
    if (first && own) {
      const mine = find(method, path, user, false);
      return mine.route ? mine : { allowed: allowed || mine.allowed };
    }
    return { allowed };
  }
  return async function handle(req, res) {
    const send = (status, value) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(value === undefined ? "" : JSON.stringify(value));
    };
    // The site's own address, for links in emails. The host was checked
    // against the allowed hosts before any account route runs.
    const origin = (secure) => `${secure ? "https" : "http"}://${String(req.headers.host || "").trim()}`;
    // Password reset, email check and account settings. Returns
    // { status, body } when the path is one of these, else null.
    async function accountRoute(path, method, secure) {
      const post = method === "POST";
      if (post && path === "/api/auth/forgot")
        return { status: 200, body: await members.forgot(await readJson(req), origin(secure)) };
      if (post && path === "/api/auth/reset") {
        const result = await members.reset(await readJson(req), secure);
        res.setHeader("Set-Cookie", result.cookie);
        return { status: 200, body: { user: result.user } };
      }
      if (post && path === "/api/auth/verify") return { status: 200, body: await members.verify(await readJson(req)) };
      if (!path.startsWith("/api/account")) return null;
      const user = await members.user(req);
      if (!user) return { status: 401, body: { signIn: true, error: "Sign in first" } };
      if (method === "GET" && path === "/api/account")
        return { status: 200, body: { ...(await members.account(user)), operator: isOperator(user) } };
      if (method === "GET" && path === "/api/account/export") {
        const mine = own ? personalSpace(user).db : db;
        const trips = listTrips(mine).map((t) => getTrip(mine, t.id));
        let scoutProfile = null;
        try {
          scoutProfile =
            db.prepare("SELECT * FROM members WHERE account_email = ?").get(String(user.email).toLowerCase()) ?? null;
        } catch {
          /* no scout profiles on this server */
        }
        return {
          status: 200,
          body: {
            exported: new Date().toISOString(),
            account: await members.account(user),
            scoutProfile,
            money: { goals: getGoals(mine), targets: goalTargets(mine) },
            stock: { trips },
          },
        };
      }
      if (post && path === "/api/account/verify/send") {
        const sent = await members.sendVerify(user, origin(secure)).catch(() => false);
        return { status: 200, body: { sent, mailOn: Boolean(members.mailOn) } };
      }
      if (post && path === "/api/account/password") {
        const result = await members.changePassword(user, await readJson(req), secure);
        res.setHeader("Set-Cookie", result.cookie);
        return { status: 200, body: { ok: true } };
      }
      if (post && path === "/api/account/email") {
        const result = await members.changeEmail(user, await readJson(req), origin(secure));
        // The scout profile follows the account to its new email.
        try {
          db.prepare("UPDATE members SET account_email = ? WHERE account_email = ?").run(result.user.email, result.from);
        } catch {
          /* no scout profiles on this server */
        }
        return { status: 200, body: { user: result.user, sent: result.sent, mailOn: Boolean(members.mailOn) } };
      }
      if (post && path === "/api/account/delete") {
        await members.deleteAccount(user, await readJson(req));
        // The scout profile stays for tip history, with nothing that names them.
        try {
          db.prepare(
            "UPDATE members SET account_email = NULL, name = 'Deleted member', locality = NULL, seller_name = NULL, seller_key = NULL, alerts_opt_in = 0, alert_localities = '[]' WHERE account_email = ?",
          ).run(String(user.email).toLowerCase());
        } catch {
          /* no scout profiles on this server */
        }
        if (own) {
          const key = personalKey(user);
          personalTables.delete(key);
          forget?.(user);
        }
        res.setHeader("Set-Cookie", await members.signOut(req, secure));
        return { status: 200, body: { deleted: true } };
      }
      if (post && path === "/api/account/reset-link") {
        if (!isOperator(user)) return { status: 403, body: { error: "Only an operator can do this" } };
        const body = await readJson(req);
        return { status: 200, body: await members.resetLink(body?.email, origin(secure)) };
      }
      return { status: 404, body: { error: "Unknown route" } };
    }
    try {
      // DNS-rebinding guard: only answer requests addressed to this machine.
      if (!allowedHosts.has(hostHeader(req.headers.host || "")))
        return send(403, { error: "Local access only" });
      // Without member accounts, a hosted pilot asks for the shared password
      // before anything else.
      if (!members && password !== null && !authorised(req, password)) {
        res.setHeader("WWW-Authenticate", 'Basic realm="Bounty", charset="UTF-8"');
        return send(401, { error: "Enter the Bounty password" });
      }
      const url = new URL(req.url, "http://127.0.0.1");
      const method = req.method || "GET";
      if (method !== "GET" && method !== "HEAD") {
        const origin = req.headers.origin;
        if (origin && !allowedHosts.has(originHost(origin)))
          return send(403, { error: "Local access only" });
        // Browsers mark requests from another site; refuse those writes even
        // when an Origin header is missing.
        if (req.headers["sec-fetch-site"] === "cross-site")
          return send(403, { error: "Local access only" });
        // Forms and other simple cross-site requests cannot send JSON without
        // a preflight. Only the media type itself counts, so a parameter
        // such as "text/plain; x=application/json" is refused.
        const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        if (type !== "application/json")
          return send(415, { error: "Send JSON with Content-Type: application/json" });
      }
      if (url.pathname === "/api/auth/me" && method === "GET") {
        if (!members) return send(200, { required: false, user: null, operator: true });
        const user = await members.user(req);
        return send(200, {
          required: true,
          user: user ? members.publicUser(user) : null,
          inviteOpen: members.inviteOpen,
          operator: isOperator(user),
          mailOn: Boolean(members.mailOn),
        });
      }
      if (members) {
        // Cookies marked Secure are dropped over plain http, which only
        // happens when the API is reached on this machine.
        const secure = !LOCAL_HOSTS.has(hostHeader(req.headers.host || ""));
        const signing = { "/api/auth/signin": "signIn", "/api/auth/signup": "signUp" }[url.pathname];
        if (signing && method === "POST") {
          const result = await members[signing](await readJson(req), secure);
          res.setHeader("Set-Cookie", result.cookie);
          // A new member gets the confirm email (when email is switched on).
          if (result.created && members.sendVerify)
            await members.sendVerify(result.created, origin(secure)).catch(() => false);
          return send(200, { user: result.user });
        }
        if (url.pathname === "/api/auth/signout" && method === "POST") {
          res.setHeader("Set-Cookie", await members.signOut(req, secure));
          return send(200, { ok: true });
        }
        const done = await accountRoute(url.pathname, method, secure);
        if (done) return send(done.status, done.body);
      }
      // The signed-in member, or null (always null without accounts).
      const user = members ? await members.user(req) : null;
      const found = find(method, url.pathname, user);
      if (!found.route)
        return found.allowed
          ? send(405, { error: "Method not allowed" })
          : send(404, { error: "Unknown route" });
      // With member accounts anyone may look around: reads, and POST
      // routes marked { read: true } that only work something out, are open.
      // Saving or changing anything needs a signed-in member.
      const reading = method === "GET" || method === "HEAD" || found.route.options.read === true;
      if (members && (!reading || found.route.options.operator)) {
        if (!user) return send(401, { signIn: true, error: "Sign in to save changes" });
        // Admin tools: operators only, reads included.
        if (found.route.options.operator && !isOperator(user))
          return send(403, { error: "Only an operator can do this" });
      }
      const body =
        method === "GET" || method === "HEAD"
          ? undefined
          : await readJson(req, found.route.options.limit);
      const value = await found.route.handler({
        req,
        url,
        params: found.params,
        body,
        user,
        operator: isOperator(user),
        // The signed-in member's plan row { plan, since } or null.
        plan: user && members?.plan ? () => members.plan(user.id) : async () => null,
      });
      if (isReply(value)) return send(value.status, value.body);
      return send(200, value);
    } catch (error) {
      if (error instanceof HttpError)
        return send(error.status, { error: error.message });
      console.error(error);
      return send(500, { error: "Internal error. Check the API log." });
    }
  };
}
