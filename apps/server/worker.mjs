// Open Prices import worker. Fetches recent GBP price observations, keeps
// the GB rows, upserts them by price id and records the run. Transient
// failures (network errors, HTTP 429 and 5xx) are retried with backoff.
//
//   npm run worker                 one page (100 prices), recorded as manual
//   npm run worker -- --pages 3    up to 5 pages
//   node server/worker.mjs --scheduled   used by worker:loop
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { openPrices, requestError, SourceError } from "./sources.mjs";
import { recordRun, upsertObservations } from "./evidence.mjs";

export const OPEN_PRICES_URL = "https://prices.openfoodfacts.org/api/v1/prices";
export const MAX_PAGES = 5;
export const ATTEMPTS = 3;
// Open Food Facts asks API clients to identify themselves.
const USER_AGENT = "Bounty/0.1 (local resale research workbench)";

export function pageUrl(page) {
  const url = new URL(OPEN_PRICES_URL);
  url.search = new URLSearchParams({
    currency: "GBP",
    size: "100",
    order_by: "-date",
    page: String(page),
  }).toString();
  return url;
}

/** Wait before retry n (1-based): Retry-After when given (capped), else 2s, 8s. */
function backoff(attempt, retryAfter) {
  if (typeof retryAfter === "string" && /^\d+$/.test(retryAfter.trim()))
    return Math.min(Number(retryAfter.trim()), 60) * 1000;
  return 2000 * 4 ** (attempt - 1);
}

/**
 * GETs JSON, retrying transient failures up to `attempts` times. Any other
 * HTTP error fails at once, since repeating it would not help.
 */
export async function fetchJson(url, { request = fetch, sleep = delay, attempts = ATTEMPTS, log = () => {} } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let retryAfter = null;
    try {
      const res = await request(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(30000),
        // A redirect to another address is refused, never followed.
        redirect: "error",
      });
      if (res.ok) {
        try {
          return await res.json();
        } catch {
          throw new SourceError("Open Prices returned a response that is not JSON", res.status);
        }
      }
      retryAfter = res.headers.get("retry-after");
      await res.body?.cancel().catch(() => {});
      throw new SourceError("Open Prices returned HTTP " + res.status, res.status);
    } catch (error) {
      lastError = error instanceof SourceError ? error : requestError("Open Prices", error);
      if (!lastError.transient || attempt === attempts) break;
      const wait = backoff(attempt, retryAfter);
      log(`${lastError.message}; retrying in ${Math.round(wait / 1000)} s (attempt ${attempt + 1} of ${attempts})`);
      await sleep(wait);
    }
  }
  throw lastError;
}

/**
 * Imports up to `pages` pages and records one import run. Pages fetched
 * before a failure are still saved, but the run is recorded as failed so
 * the source shows as needing attention. Returns { saved, fetched }.
 */
export async function importOpenPrices(
  db,
  { pages = 1, mode = "manual", request = fetch, sleep = delay, now = () => new Date(), log = () => {} } = {},
) {
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > MAX_PAGES)
    throw Error("pages must be a whole number from 1 to " + MAX_PAGES);
  const started = now();
  const rows = [];
  let failure = null;
  let fetched = 0;
  for (let page = 1; page <= pages; page++) {
    try {
      const body = await fetchJson(pageUrl(page), { request, sleep, log });
      fetched += Array.isArray(body?.items) ? body.items.length : 0;
      rows.push(...openPrices(body));
      if (Number.isSafeInteger(body.pages) && page >= body.pages) break;
    } catch (error) {
      failure = pages > 1 ? Error("Page " + page + ": " + error.message) : error;
      break;
    }
  }
  let saved = 0;
  try {
    saved = rows.length ? upsertObservations(db, rows, { now: now() }) : 0;
  } catch (error) {
    failure = failure || error;
  }
  recordRun(db, {
    provider: "openprices",
    mode,
    query: pages > 1 ? pages + " pages" : null,
    started,
    finished: now(),
    ok: !failure,
    rows: saved,
    error: failure?.message ?? null,
  });
  if (failure) {
    failure.saved = saved;
    throw failure;
  }
  return { saved, fetched };
}

/** Parses --pages N and --scheduled. Throws a usage error otherwise. */
export function parseArgs(argv) {
  const options = { pages: 1, mode: "manual" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--scheduled") options.mode = "scheduled";
    else if (argv[i] === "--pages" && /^\d+$/.test(argv[i + 1] ?? "")) options.pages = Number(argv[++i]);
    else throw Error("Usage: npm run worker -- [--pages 1-" + MAX_PAGES + "] [--scheduled]");
  }
  if (options.pages < 1 || options.pages > MAX_PAGES)
    throw Error("--pages must be from 1 to " + MAX_PAGES);
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  const { withWorkingData } = await import("./working-data.mjs");
  return withWorkingData(async (db) => {
    try {
      const { saved, fetched } = await importOpenPrices(db, { ...options, log: console.error });
      console.log(
        `Imported ${saved} UK observations from ${fetched} GBP Open Prices records ` +
          `(${options.pages} page${options.pages === 1 ? "" : "s"}). Data: Open Prices, ODbL.`,
      );
      // New prices reach open bounties at once (see research.mjs).
      // The estimate is worked out again for each, not only the blockers.
      const { refreshOpenBounties } = await import("./routes-bounties.mjs");
      let out;
      try {
        out = await refreshOpenBounties(db, { now: new Date().toISOString() });
      } catch (error) {
        console.error(`Imported, but open bounties could not be re-checked: ${error.message}`);
        process.exitCode = 1;
        return;
      }
      if (out.stopped.length || out.reopened.length || out.heldBack.length || out.failed.length)
        console.log(
          `Re-checked open bounties: ${out.stopped.length} stopped, ${out.reopened.length} open again, ` +
            `${out.heldBack.length} with claim holders told to stop, ${out.failed.length} not worked out again.`,
        );
    } catch (error) {
      console.error("Open Prices import failed: " + error.message + (error.saved ? ` (${error.saved} rows saved before the failure)` : ""));
      process.exitCode = 1;
    }
  });
}

if (import.meta.main ?? import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
