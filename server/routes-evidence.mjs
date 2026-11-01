// Evidence routes: source readiness and import history, Open Prices
// observations, research evidence and display permissions. Read-only except
// for permissions. Nothing here calls a paid provider: credentialed lookups
// run from the research CLI only, so tokens never reach the browser.
import { KINDS } from "./contract.mjs";
import { fail, int, text, bool, oneOf } from "./http.mjs";
import { PROVIDERS } from "./sources.mjs";
import {
  listEvidence,
  listObservations,
  listPermissions,
  readiness,
  recentRuns,
  setPermission,
} from "./evidence.mjs";

export const MAX_LIMIT = 500;

/** A whole-number query parameter, or the fallback when absent or blank. */
function queryInt(url, name, fallback, min, max) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) fail(`${name} must be a whole number between ${min} and ${max}`);
  return int(Number(raw.trim()), name, min, max);
}

/** An optional text query parameter, trimmed, or null. */
function queryText(url, name, max = 200) {
  const raw = url.searchParams.get(name);
  return raw === null || raw.trim() === "" ? null : text(raw, name, max);
}

/** Barcodes are digit strings; anything else could never match. */
function queryBarcode(url) {
  const value = queryText(url, "barcode", 40);
  if (value !== null && !/^\d{1,40}$/.test(value)) fail("barcode must contain digits only");
  return value;
}

export function routes(db) {
  return [
    [
      "GET",
      "/api/sources",
      () => ({ sources: readiness(db), runs: recentRuns(db, 20) }),
    ],
    [
      "GET",
      "/api/observations",
      ({ url }) =>
        listObservations(db, {
          barcode: queryBarcode(url),
          limit: queryInt(url, "limit", 100, 1, MAX_LIMIT),
          offset: queryInt(url, "offset", 0, 0, 1e9),
        }),
    ],
    [
      "GET",
      "/api/evidence",
      ({ url }) => {
        const kind = queryText(url, "kind", 60);
        const provider = queryText(url, "provider", 40);
        return listEvidence(db, {
          kind: kind === null ? null : oneOf(kind, "kind", KINDS),
          provider: provider === null ? null : oneOf(provider, "provider", PROVIDERS),
          barcode: queryBarcode(url),
          q: queryText(url, "q", 200),
          limit: queryInt(url, "limit", 100, 1, MAX_LIMIT),
          offset: queryInt(url, "offset", 0, 0, 1e9),
        });
      },
    ],
    ["GET", "/api/permissions", () => ({ permissions: listPermissions(db) })],
    [
      "POST",
      "/api/permissions",
      ({ body }) => {
        if (!body || typeof body !== "object" || Array.isArray(body)) fail("Send a JSON object");
        const provider = oneOf(body.provider, "provider", PROVIDERS);
        const programme =
          body.programme === undefined || body.programme === null || body.programme === ""
            ? ""
            : text(body.programme, "programme", 200);
        const display = bool(body.display, "display");
        const note = text(body.note, "note", 500, { optional: true });
        return setPermission(db, { provider, programme, display, note });
      },
    ],
  ];
}
