// Research import CLI. Files (Awin feed, manual sales) and credentialed
// lookups (Hobnight, Keepa, eBay Browse) are saved to the research table and
// every attempt is recorded in import_runs.
//
//   npm run research -- awin FILE.csv
//   npm run research -- sales FILE.json
//   npm run research -- hobnight|keepa|ebay QUERY [--refresh]
//
// A repeat lookup of the same provider and query inside its cache window
// (Keepa 24 hours, Hobnight and eBay 6 hours) reuses the stored rows and
// makes no network call, unless --refresh is passed. Tokens are read from the
// server environment and never printed.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { awin, lookup, sold, sourceFor, LOOKUP_PROVIDERS } from "./sources.mjs";
import { cachedLookup, recordRun, storeLookup, upsertResearch, validResearchRow } from "./evidence.mjs";
import { sellerName } from "./matching.mjs";

export const FILE_PROVIDERS = Object.freeze(["awin", "sales"]);
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** Test fixtures are examples; importing one would pass them off as live evidence. */
export function isFixture(path) {
  return (resolve(path) + sep).startsWith(FIXTURES) || resolve(path).startsWith(FIXTURES);
}

// File text compared without a byte-order mark, line-ending style or
// trailing spaces, so a copy saved by another editor still matches.
const normalisedText = (text) =>
  String(text)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
export const contentHash = (text) => createHash("sha256").update(normalisedText(text)).digest("hex");
const rowKey = (row) => `${row.source_id ?? ""}|${String(row.title ?? "").trim().toLowerCase()}`;

let fixtureIndex = null;
/**
 * The repository's sample files: { hashes: Map(hash -> name), rows:
 * { awin, sales: Map(rowKey -> name) } }. A copied fixture is refused by its
 * content, wherever it is, and so is a file holding any of its rows.
 */
export function sampleFixtures() {
  if (fixtureIndex) return fixtureIndex;
  const index = { hashes: new Map(), rows: { awin: new Map(), sales: new Map() } };
  let names = [];
  try {
    names = readdirSync(FIXTURES, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
  } catch {
    names = [];
  }
  for (const path of names) {
    const name = relative(FIXTURES, path);
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    index.hashes.set(contentHash(text), name);
    const parsers = { awin: () => awin(text), sales: () => sold(JSON.parse(text)) };
    for (const [provider, parse] of Object.entries(parsers)) {
      let rows = [];
      try {
        rows = parse();
      } catch {
        rows = [];
      }
      for (const row of rows) if (row?.source_id && row?.title) index.rows[provider].set(rowKey(row), name);
    }
  }
  fixtureIndex = index;
  return index;
}

// Refuses text that is, or contains rows of, one of the sample fixtures.
function refuseSample(provider, text, rows = null) {
  const { hashes, rows: known } = sampleFixtures();
  const same = hashes.get(contentHash(text));
  if (same)
    throw Error(
      `This file is a copy of the repository's sample file ${same}. Sample data is never imported as evidence: import a real ${provider === "awin" ? "Awin feed" : "sales file"}.`,
    );
  if (!rows) return;
  const found = rows.filter((row) => known[provider]?.has(rowKey(row)));
  if (found.length)
    throw Error(
      `This file holds ${found.length} row${found.length === 1 ? "" : "s"} from the repository's sample file ${known[provider].get(rowKey(found[0]))} (for example "${found[0].title}"). Sample data is never imported as evidence, so nothing was imported.`,
    );
}
const USAGE =
  "Usage: npm run research -- awin FILE.csv | sales FILE.json | hobnight|keepa|ebay QUERY [--refresh]";

/**
 * Imports an Awin CSV or a manual sales JSON file already read into text.
 * Records the run whether it succeeds or fails. Returns { saved, parsed,
 * skipped, withoutSeller }: skipped is Awin rows not saved (missing id or
 * title, or no positive price); withoutSeller is manual sales with no seller
 * name, which do not count as independent sales.
 *
 * A manual sales file is all or nothing: if any sale could not be stored,
 * the whole file is refused naming the record, so a sale is never dropped
 * without saying so.
 *
 * A file whose content is one of the repository's sample fixtures (compared
 * by a hash of its text, wherever it was copied to), or that holds any of
 * their rows, is refused: sample data never becomes evidence.
 */
export function importFile(db, provider, text, { now = () => new Date(), env = process.env, name = null } = {}) {
  if (!FILE_PROVIDERS.includes(provider)) throw Error(USAGE);
  const started = now();
  try {
    refuseSample(provider, text);
    let rows;
    if (provider === "awin") rows = awin(text);
    else {
      let input;
      try {
        input = JSON.parse(text);
      } catch {
        throw Error("The sales file is not valid JSON");
      }
      rows = sold(input, { now: started });
      const unsaveable = rows.findIndex((row) => !validResearchRow(row));
      if (unsaveable >= 0)
        throw Error(
          `Invalid manual sale at index ${unsaveable}: it cannot be stored (it needs a reference, a title and a positive total in pence). Nothing was imported.`,
        );
    }
    refuseSample(provider, text, rows);
    const saved = upsertResearch(db, provider, rows, { now: now() });
    recordRun(db, { provider, mode: "manual", query: name, started, finished: now(), ok: true, rows: saved }, { env });
    return {
      saved,
      parsed: rows.length,
      skipped: rows.length - saved,
      withoutSeller: provider === "sales" ? rows.filter((r) => sellerName(r.seller) === null).length : 0,
    };
  } catch (error) {
    recordRun(db, { provider, mode: "manual", query: name, started, finished: now(), ok: false, error: error.message }, { env });
    throw error;
  }
}

/**
 * Runs a credentialed lookup through the cache. A hit inside the time to live
 * returns the stored rows without calling `request` and without touching
 * their imported time. refresh: true always fetches. Returns
 * { cached, saved, rows, fetched, expires }.
 */
export async function importLookup(
  db,
  provider,
  query,
  { env = process.env, request = fetch, refresh = false, now = () => new Date() } = {},
) {
  if (!LOOKUP_PROVIDERS.includes(provider)) throw Error(USAGE);
  const started = now();
  const term = typeof query === "string" ? query.trim() : "";
  if (!refresh) {
    const hit = cachedLookup(db, provider, term, { now: started });
    if (hit) {
      recordRun(
        db,
        { provider, mode: "lookup", query: term, started, finished: now(), ok: true, rows: hit.rows.length, cached: true },
        { env },
      );
      return { cached: true, saved: 0, rows: hit.rows, fetched: hit.fetched, expires: hit.expires };
    }
  }
  try {
    const rows = await lookup(provider, term, env, request, { clock: now });
    const fetchedAt = now();
    const saved = upsertResearch(db, provider, rows, { now: fetchedAt });
    storeLookup(db, provider, term, rows.map((r) => r.source_id).filter(Boolean), { now: fetchedAt });
    recordRun(db, { provider, mode: "lookup", query: term, started, finished: now(), ok: true, rows: saved }, { env });
    const ttl = sourceFor(provider).ttlHours;
    return {
      cached: false,
      saved,
      rows,
      fetched: fetchedAt.toISOString(),
      expires: new Date(fetchedAt.getTime() + ttl * 3600000).toISOString(),
    };
  } catch (error) {
    recordRun(db, { provider, mode: "lookup", query: term, started, finished: now(), ok: false, error: error.message }, { env });
    throw error;
  }
}

export function parseArgs(argv) {
  const refresh = argv.includes("--refresh");
  const rest = argv.filter((a) => a !== "--refresh");
  const [provider, input, extra] = rest;
  if (!provider || !input || extra !== undefined) throw Error(USAGE);
  if (!FILE_PROVIDERS.includes(provider) && !LOOKUP_PROVIDERS.includes(provider)) throw Error(USAGE);
  if (refresh && FILE_PROVIDERS.includes(provider)) throw Error("--refresh applies to lookups only. " + USAGE);
  return { provider, input, refresh };
}

// After new evidence lands, open bounties for the same items are re-checked
// at once, so a price rise or a removed offer stops the trip for members who
// were alerted or hold a claim, even if none of them opens the app.
// The estimate, cap, demand and every claim holder's own figures are worked
// out again for each open bounty (refreshOpenBounties), not only the
// blockers; a bounty that cannot be worked out again fails closed.
async function recheckBounties(db) {
  let out;
  try {
    const { refreshOpenBounties } = await import("./routes-bounties.mjs");
    out = await refreshOpenBounties(db, { now: new Date().toISOString() });
  } catch (error) {
    // The evidence is saved; say plainly that open bounties were not re-checked.
    console.error(`The evidence was saved, but open bounties could not be re-checked: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (out.stopped.length)
    console.log(
      `${out.stopped.length} open ${out.stopped.length === 1 ? "bounty was" : "bounties were"} stopped by the new evidence, and members were told not to make the trip.`,
    );
  if (out.reopened.length)
    console.log(`${out.reopened.length} paused ${out.reopened.length === 1 ? "bounty is" : "bounties are"} open for trips again.`);
  if (out.heldBack.length)
    console.log(
      `${out.heldBack.length} open ${out.heldBack.length === 1 ? "bounty has" : "bounties have"} claim holders who were told not to make the trip.`,
    );
  if (out.failed.length)
    console.log(`${out.failed.length} open ${out.failed.length === 1 ? "bounty" : "bounties"} could not be worked out again.`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  const { withWorkingData } = await import("./working-data.mjs");
  return withWorkingData(async (db) => {
    const { provider, input, refresh } = args;
    try {
      if (FILE_PROVIDERS.includes(provider)) {
        if (isFixture(input)) throw Error("Refusing to import a test fixture as live evidence: " + input);
        const { saved, parsed, skipped, withoutSeller } = importFile(db, provider, await readFile(input, "utf8"), { name: input });
        console.log(
          `Saved ${saved} ${provider} research rows` +
            (provider === "awin"
              ? ` from ${parsed} GBP feed rows` + (skipped ? ` (${skipped} skipped: missing id or title, or no positive price)` : "")
              : "") +
            ". Reload Research and Sources to see them.",
        );
        if (provider === "awin")
          console.log(
            "Feed rows are online offers. They never confirm branch stock, and the feed gives no pack count, so pack stays unknown until you confirm it.",
          );
        if (withoutSeller)
          console.log(
            `${withoutSeller} of ${saved} sales have no seller name (a listing id is not a seller), so they do not count as independent sales.`,
          );
        await recheckBounties(db);
        return;
      }
      const result = await importLookup(db, provider, input, { refresh });
      const name = sourceFor(provider).name;
      if (result.cached)
        console.log(
          `Reused ${result.rows.length} ${name} rows from the lookup at ${result.fetched}. ` +
            `No network call was made; the cache lasts until ${result.expires}. Pass --refresh to fetch again.`,
        );
      else
        console.log(
          `Saved ${result.saved} ${name} rows from a live lookup at ${result.fetched}. ` +
            `Repeats of this query reuse them until ${result.expires} unless you pass --refresh.`,
        );
      if (provider === "ebay")
        console.log("These are active asking prices. They are competition evidence, never sales.");
      if (!result.cached) await recheckBounties(db);
    } catch (error) {
      console.error(provider + " import failed: " + error.message);
      process.exitCode = 1;
    }
  });
}

if (import.meta.main ?? import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
