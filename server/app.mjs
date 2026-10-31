// Local HTTP API. Route modules export routes(db) returning
// [method, pattern, handler, options?] tuples. Patterns use :name segments.
// Handlers receive { req, url, params, body } and return a JSON value or
// reply(status, value). Throw HttpError (or call fail) for client errors.
import { HttpError, isReply, readJson } from "./http.mjs";
import * as evidenceRoutes from "./routes-evidence.mjs";
import * as researchRoutes from "./routes-research.mjs";
import * as planRoutes from "./routes-plan.mjs";
import * as bountyRoutes from "./routes-bounties.mjs";
import * as ledgerRoutes from "./routes-ledger.mjs";

export const routeModules = [
  evidenceRoutes,
  researchRoutes,
  planRoutes,
  bountyRoutes,
  ledgerRoutes,
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

export function createApi(db, { modules = routeModules } = {}) {
  const table = modules
    .flatMap((m) => m.routes(db))
    .map(([method, pattern, handler, options = {}]) => ({
      method,
      parts: pattern.split("/").filter(Boolean),
      handler,
      options,
    }));
  function find(method, path) {
    const parts = path.split("/").filter(Boolean);
    let allowed = false;
    for (const route of table) {
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
    try {
      // DNS-rebinding guard: only answer requests addressed to this machine.
      if (!LOCAL_HOSTS.has(hostHeader(req.headers.host || "")))
        return send(403, { error: "Local access only" });
      const url = new URL(req.url, "http://127.0.0.1");
      const method = req.method || "GET";
      if (method !== "GET" && method !== "HEAD") {
        const origin = req.headers.origin;
        if (origin && !LOCAL_HOSTS.has(originHost(origin)))
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
      const found = find(method, url.pathname);
      if (!found.route)
        return found.allowed
          ? send(405, { error: "Method not allowed" })
          : send(404, { error: "Unknown route" });
      const body =
        method === "GET" || method === "HEAD"
          ? undefined
          : await readJson(req, found.route.options.limit);
      const value = await found.route.handler({
        req,
        url,
        params: found.params,
        body,
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
