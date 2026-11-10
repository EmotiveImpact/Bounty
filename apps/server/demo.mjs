// The free demo on Vercel. The API runs as a Vercel Function with its SQLite
// database in the function's temporary storage, so the data lasts only as
// long as the function instance: Vercel may start a fresh, empty one at any
// time. In place of the six-hourly import loop, the first request to an
// instance, and the first after the data is six hours old, imports Open Prices.
import { setTimeout as delay } from "node:timers/promises";
import { importOpenPrices } from "./worker.mjs";
import { refreshOpenBounties } from "./routes-bounties.mjs";

export const IMPORT_EVERY = 6 * 3600000;
// A request waits this long for an import before it is answered anyway.
export const IMPORT_WAIT = 20000;

/** True when Open Prices has no successful run in the last six hours. */
export function importDue(db, now = new Date()) {
  const last = db
    .prepare(
      "SELECT finished FROM import_runs WHERE provider = 'openprices' AND ok = 1 AND cached = 0 ORDER BY finished DESC, id DESC LIMIT 1",
    )
    .get();
  return !last || now.getTime() - Date.parse(last.finished) >= IMPORT_EVERY;
}

/**
 * Returns a function to call before each request. It starts an import when
 * one is due and none is running, then waits for it up to `wait` ms. A failed
 * import is logged and recorded as a failed run (the Sources tab shows it);
 * the request is answered either way.
 */
export function freshPrices(db, { run = importOpenPrices, refresh = refreshOpenBounties, wait = IMPORT_WAIT, log = console.error } = {}) {
  let running = null;
  return async function beforeRequest(now = new Date()) {
    if (!running && importDue(db, now))
      running = run(db, { mode: "scheduled", log })
        .then(() => refresh(db, { now: new Date().toISOString() }))
        .catch((error) => log("Open Prices import failed: " + error.message))
        .finally(() => {
          running = null;
        });
    // A durable snapshot owner must keep the request lock until all database
    // work finishes. A timed-out import must never mutate a replaced cache.
    if (running) {
      if (wait === null) await running;
      else await Promise.race([running, delay(wait, undefined, { ref: false })]);
    }
  };
}
