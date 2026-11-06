// Vercel Function: every /api/... request reaches the same API as on your own
// computer. With DATABASE_URL set, members' records are kept in Neon between
// instances (apps/server/keep.mjs); without it the data lasts only as long as
// the instance (apps/server/demo.mjs). Set-up: docs/DEPLOY.md.
process.env.BOUNTY_DATA_DIR ||= "/tmp/bounty-data";

const { createApi } = await import("../apps/server/app.mjs");
const { database, openDb, dataDir } = await import("../apps/server/db.mjs");
const { keepForGood, neonKeepStore } = await import("../apps/server/keep.mjs");
const { personalStores } = await import("../apps/server/personal.mjs");
const { join } = await import("node:path");
const { refreshOpenBounties } = await import("../apps/server/routes-bounties.mjs");
const { accessConfig } = await import("../apps/server/access.mjs");
const { freshPrices } = await import("../apps/server/demo.mjs");
const { seedSampleTips } = await import("../apps/server/sample-tips.mjs");
const { accounts, neonStore } = await import("../apps/server/accounts.mjs");

let handler;
try {
  if (!process.env.DATABASE_URL && !process.env.BOUNTY_PASSWORD)
    throw Error(
      "add DATABASE_URL (a Neon connection string, for member sign-in) or BOUNTY_PASSWORD (16 or more characters) " +
        "in the Vercel project's environment variables, then redeploy",
    );
  const { publicHosts, password, databaseUrl, inviteCode, operators } = accessConfig();
  const members = databaseUrl ? accounts(await neonStore(databaseUrl), { inviteCode }) : null;
  // One API on one data folder: the shared database (deals, tips, sources),
  // each member's own Stock and Money (personal.mjs), sample tips, and the
  // Open Prices check that runs before each request.
  const build = (db, { personal = null, onImported = () => undefined } = {}) => {
    const api = createApi(db, { publicHosts, password, members, operators, personal });
    seedSampleTips(db);
    const beforeRequest = freshPrices(db, {
      // Not awaited: the import may finish during a change that is waiting
      // on it, and saving waits for that change to end.
      refresh: async (d, o) => {
        await refreshOpenBounties(d, o);
        onImported();
      },
    });
    return async (req, res) => {
      await beforeRequest();
      return api(req, res);
    };
  };
  if (databaseUrl && process.env.BOUNTY_KEEP_DATA !== "off") {
    // Everything in the data folder is copied to Neon after every change and
    // back when Vercel starts a fresh instance (apps/server/keep.mjs).
    const dir = dataDir();
    const keeper = keepForGood({
      store: await neonKeepStore(databaseUrl),
      dir,
      build: () => {
        const db = openDb(join(dir, "desk.sqlite"));
        const own = personalStores(dir);
        return {
          handle: build(db, { personal: own.personal, onImported: () => void keeper.changed() }),
          checkpoint() {
            db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
            own.checkpoint();
          },
          close() {
            own.close();
            db.close();
          },
        };
      },
    });
    handler = keeper.handle;
  } else {
    const db = database();
    handler = build(db, { personal: databaseUrl ? personalStores(dataDir()).personal : null });
  }
} catch (error) {
  console.error("Bounty API not started: " + error.message);
  handler = (req, res) => {
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "Bounty is not set up yet: " + error.message }));
  };
}

export default (req, res) => handler(req, res);
